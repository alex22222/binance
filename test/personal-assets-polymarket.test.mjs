import test from "node:test";
import assert from "node:assert/strict";
import { fetchPolymarketAssets } from "../src/personal-assets-polymarket.mjs";

const time = new Date("2026-10-24T13:00:00.000Z");
const address = `0x${"a1".repeat(20)}`;
const contract = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const now = () => time;
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const raw = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
function position(id = "101", overrides = {}) {
  return { proxy_wallet: address, token_id: id, condition_id: `0x${"b2".repeat(32)}`, current_size: 20,
    current_price: 0.5, current_value: 10, status: "OPEN", redeemable: false, title: "Synthetic prediction", outcome: "Yes", ...overrides };
}
function fixture(options = {}) {
  const calls = [];
  let cashReads = 0;
  const positions = options.positions ?? [position()];
  const totalValue = Object.hasOwn(options, "value") ? options.value : positions.reduce((sum, row) => sum + row.current_value, 0);
  const index = options.index ?? { computed_at: time.toISOString(), age_seconds: 1,
    serving: { lag_seconds: 2 }, ingestion: { chain_id: 137, network: "polygon" } };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const overridden = await options.response?.(url, init);
    if (overridden) return overridden;
    let body;
    if (url.hostname === "api.kraken.com") {
      body = { error: [], result: { USDCUSD: [[Object.hasOwn(options, "price") ? options.price : "0.998", "1", options.priceTime ?? time.getTime() / 1000, "b", "m", ""]], last: "1" } };
    } else if (url.hostname === "data-api.polymarket.com") {
      if (url.pathname === "/v2/status") body = { data: index };
      else if (url.pathname === "/v2/value") body = { data: { proxy_wallet: options.valueWallet ?? address, value: totalValue } };
      else if (url.pathname === "/v2/positions") {
        if (options.pages) body = options.pages(url.searchParams.get("cursor"));
        else body = { data: positions, pagination: { has_more: false, next_cursor: null } };
      } else if (url.pathname === "/v2/positions/combos") body = { data: options.combos ?? [], pagination: { has_more: false, next_cursor: null } };
      else assert.fail("Unexpected API route");
    } else {
      assert.ok(["polygon.drpc.org", "polygon.publicnode.com"].includes(url.hostname));
      assert.equal(init.method, "POST");
      const requests = JSON.parse(init.body);
      body = requests.map((row) => {
        let result;
        if (row.method === "eth_chainId") result = options.chain ?? "0x89";
        else if (row.method === "eth_blockNumber") result = "0x100";
        else if (row.method === "eth_call") {
          cashReads++;
          assert.equal(row.params[0].to, contract);
          assert.equal(row.params[0].data, `0x70a08231${address.slice(2).padStart(64, "0")}`);
          assert.equal(row.params[1], "0x100");
          result = options.cashResponse ?? raw(options.changingCash && cashReads > 1 ? 12_345_679 : options.cash ?? 12_345_678);
        } else if (row.method === "eth_getBlockByNumber") {
          assert.deepEqual(row.params, ["0x100", false]);
          result = { number: "0x100", timestamp: hex(options.blockTime ?? time.getTime() / 1000) };
        } else assert.fail("Unexpected RPC method");
        return { jsonrpc: "2.0", id: row.id, result };
      });
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("Polymarket adds exact six-decimal pUSD cash and positions once, converts both with the same actual USDC quote", async () => {
  const { fetchImpl, calls } = fixture();
  const result = await fetchPolymarketAssets({ address: address.toUpperCase().replace("0X", "0x"), fetchImpl, now });
  assert.equal(result.provider, "polymarket");
  assert.equal(result.currency, "USD");
  assert.equal(result.externalAccountId, address);
  assert.equal(result.asOf, "2026-10-24");
  assert.equal(result.observedAt, null);
  assert.equal(result.timeBasis, "retrieved");
  assert.equal(result.breakdownComplete, true);
  assert.equal(result.holdings[0].quantity, 12.345678);
  assert.equal(result.holdings[0].amount, 12.345678 * 0.998);
  assert.equal(result.holdings[1].amount, 10 * 0.998);
  assert.equal(result.total, result.holdings.reduce((sum, row) => sum + row.amount, 0));
  assert.equal(result.valuation.sourceAmount, 22.345678);
  assert.equal(result.valuation.usdPrice, 0.998);
  assert.equal(result.valuation.cashRawBalance, "12345678");
  assert.equal(result.valuation.cashObservedAt, time.toISOString());
  assert.equal(result.valuation.quoteObservedAt, time.toISOString());
  assert.ok(result.warnings.some((row) => row.includes("不默认固定 1 美元")));
  assert.ok(result.warnings.some((row) => row.includes("只能计入一次")));
  for (const { url, init } of calls) {
    assert.equal(init.redirect, "error");
    assert.equal(init.signal instanceof AbortSignal, true);
    assert.ok(["data-api.polymarket.com", "api.kraken.com", "polygon.drpc.org", "polygon.publicnode.com"].includes(url.hostname));
    if (["data-api.polymarket.com", "api.kraken.com"].includes(url.hostname)) {
      assert.equal(init.method, "GET"); assert.equal("body" in init, false);
    }
    assert.equal(Object.keys(init.headers).some((key) => /authorization|api.key|signature/i.test(key)), false);
  }
});

test("Polymarket walks the full cursor chain, preserves filters and includes redeemable positions without adding them twice", async () => {
  const rows = [position("101"), position("102", { current_value: 20, current_price: 1, status: "REDEEMABLE", redeemable: true })];
  const cursor = "opaque/https://attacker.invalid/?value=1";
  const { fetchImpl, calls } = fixture({ value: 30, pages: (key) => key === null
    ? { data: [rows[0]], pagination: { has_more: true, next_cursor: cursor } }
    : { data: [rows[1]], pagination: { has_more: false, next_cursor: null } } });
  const result = await fetchPolymarketAssets({ address, fetchImpl, now });
  assert.equal(result.holdings.length, 3);
  assert.equal(result.valuation.sourceAmount, 42.345678);
  const positionCalls = calls.filter((row) => row.url.pathname === "/v2/positions");
  assert.equal(positionCalls.length, 2);
  for (const { url } of positionCalls) {
    assert.equal(url.origin, "https://data-api.polymarket.com");
    assert.equal(url.searchParams.get("user"), address);
    assert.equal(url.searchParams.get("status"), "OPEN");
    assert.equal(url.searchParams.get("filter_amount"), "0");
    assert.equal(url.searchParams.get("include_archived"), "true");
    assert.equal(url.searchParams.has("offset"), false);
  }
  assert.equal(positionCalls[1].url.searchParams.get("cursor"), cursor);
});

test("Polymarket accepts verified empty holdings and zero cash as a genuine zero account", async () => {
  const { fetchImpl } = fixture({ positions: [], cash: 0 });
  const result = await fetchPolymarketAssets({ address, fetchImpl, now });
  assert.equal(result.total, 0); assert.deepEqual(result.holdings, []); assert.equal(result.breakdownComplete, true);
});

test("Polymarket retains fractional positions when the official value endpoint omits sub-one-share holdings", async () => {
  const { fetchImpl } = fixture({ positions: [position(), position("102", { current_size: 0.5, current_price: 1, current_value: 0.5 })], value: 10 });
  const result = await fetchPolymarketAssets({ address, fetchImpl, now });
  assert.equal(result.holdings.length, 3);
  assert.equal(result.valuation.sourceAmount, 22.845678);
  assert.equal(result.total, (12.345678 * 0.998) + (10 * 0.998) + (0.5 * 0.998));
  assert.ok(result.warnings.some((row) => row.includes("不足 1 份") && row.includes("保留")));
  assert.equal(result.breakdownComplete, true);
});

test("Polymarket never interprets failed or malformed cash, RPC identity, or foreign wallet data as zero", async () => {
  for (const options of [
    { chain: "0x1" }, { cashResponse: "0x0" }, { cashResponse: "0x" }, { cash: Number.MAX_SAFE_INTEGER + 1 },
    { positions: [position("101", { proxy_wallet: `0x${"22".repeat(20)}` })] },
    { valueWallet: `0x${"22".repeat(20)}` }, { valueWallet: 123 }, { combos: [{ proxy_wallet: 123, current_size: 0 }] },
    { response: (url) => url.hostname.startsWith("polygon.") ? new Response("private upstream", { status: 503 }) : null },
  ]) {
    const { fetchImpl } = fixture(options);
    await assert.rejects(fetchPolymarketAssets({ address, fetchImpl, now }), /不完整|对齐|读取|失败/);
  }
});

test("Polymarket rejects incomplete pagination, repeated cursors, duplicate positions, and mismatched official position total", async () => {
  for (const options of [
    { pages: () => ({ data: [position()], pagination: { has_more: true, next_cursor: "same" } }) },
    { pages: () => ({ data: [], pagination: { has_more: true, next_cursor: "next" } }) },
    { pages: () => ({ data: [position()], pagination: { has_more: false, next_cursor: "next" } }) },
    { positions: [position(), position()] }, { value: 11 }, { value: null },
    { positions: [position(), position("102", { current_size: 0.5, current_price: 1, current_value: 0.5 })], value: 10.1 },
  ]) {
    const { fetchImpl } = fixture(options);
    await assert.rejects(fetchPolymarketAssets({ address, fetchImpl, now }), /不完整|重复|对齐/);
  }
});

test("Polymarket refuses held combo positions instead of presenting entry cost as latest market value", async () => {
  const { fetchImpl } = fixture({ combos: [{ proxy_wallet: address, current_size: 2, entry_cost_usdc: 1 }] });
  await assert.rejects(fetchPolymarketAssets({ address, fetchImpl, now }), (error) => error.statusCode === 422 && error.message.includes("组合仓位"));
});

test("Polymarket rejects stale and future index, chain block, or USDC market timestamps", async () => {
  const base = { computed_at: time.toISOString(), age_seconds: 0, serving: { lag_seconds: 0 }, ingestion: { chain_id: 137, network: "polygon" } };
  for (const options of [
    { blockTime: time.getTime() / 1000 - 121 }, { blockTime: time.getTime() / 1000 + 11 },
    { priceTime: time.getTime() / 1000 - 901 }, { priceTime: time.getTime() / 1000 + 11 },
    { index: { ...base, age_seconds: 121 } },
    { index: { ...base, computed_at: new Date(time.getTime() - 121_000).toISOString() } },
    { index: { ...base, computed_at: new Date(time.getTime() + 11_000).toISOString() } },
    { index: { ...base, serving: { lag_seconds: 121 } } },
    { index: { ...base, computed_at: new Date(time.getTime() - 110_000).toISOString(), age_seconds: 110, serving: { lag_seconds: 110 } } },
  ]) {
    const { fetchImpl } = fixture(options);
    await assert.rejects(fetchPolymarketAssets({ address, fetchImpl, now }), /延迟|过期|时点/);
  }
});

test("Polymarket refuses changing cash and long reads rather than mixing before and after snapshots", async () => {
  const changing = fixture({ changingCash: true });
  await assert.rejects(fetchPolymarketAssets({ address, fetchImpl: changing.fetchImpl, now }), /发生变化/);
  let reads = 0;
  const delayed = fixture();
  await assert.rejects(fetchPolymarketAssets({ address, fetchImpl: delayed.fetchImpl, now: () => new Date(time.getTime() + (reads++ ? 46_000 : 0)) }), /过久/);
});

test("Polymarket validates amounts, current share counts and values without treating missing numbers as zero", async () => {
  for (const change of [
    { current_size: null }, { current_size: -1 }, { current_size: "20" }, { current_value: undefined }, { current_value: -1 },
    { current_price: 2 }, { current_value: 1 }, { current_size: 0, current_value: 1 },
    { token_id: "https://attacker.invalid" }, { token_id: String(2n ** 256n) }, { condition_id: "missing" }, { outcome: "" },
  ]) {
    const { fetchImpl } = fixture({ positions: [position("101", change)] });
    await assert.rejects(fetchPolymarketAssets({ address, fetchImpl, now }), /不完整/);
  }
  for (const price of ["0", "NaN", "Infinity", "-1", "1e0", null]) {
    const { fetchImpl } = fixture({ price });
    await assert.rejects(fetchPolymarketAssets({ address, fetchImpl, now }), /不完整/);
  }
});

test("Polymarket validates wallet addresses locally without resolving user-controlled URLs or requesting credentials", async () => {
  for (const input of [undefined, "", "https://attacker.invalid", `${address}?host=attacker.invalid`, `0x${"0".repeat(40)}`, contract]) {
    let called = false;
    await assert.rejects(fetchPolymarketAssets({ address: input, now, fetchImpl: async () => { called = true; } }), (error) => error.statusCode === 400);
    assert.equal(called, false);
  }
});

test("Polymarket bounds response sizes and sanitizes errors from every upstream service", async () => {
  for (const response of [
    () => new Response("sensitive response", { status: 500 }),
    () => new Response("sensitive response", { status: 302, headers: { location: "https://attacker.invalid" } }),
    () => new Response("sensitive response"),
    () => new Response("{}", { headers: { "content-length": "1000001" } }),
    () => new Response(" ".repeat(1_000_001)),
    () => { throw new Error("sensitive response"); },
  ]) {
    await assert.rejects(fetchPolymarketAssets({ address, now, fetchImpl: async () => response() }), (error) => {
      assert.equal(error.statusCode, 502); assert.equal(error.message.includes("sensitive"), false); return true;
    });
  }
  await assert.rejects(fetchPolymarketAssets({ address, now, fetchImpl: async () => new Response("private", { status: 429 }) }), (error) => error.statusCode === 429);
});

test("Polymarket uses the second fixed public RPC when the first is unavailable", async () => {
  const { fetchImpl, calls } = fixture({ response: (url) => url.hostname === "polygon.drpc.org" ? new Response("offline", { status: 503 }) : null });
  const result = await fetchPolymarketAssets({ address, fetchImpl, now });
  assert.equal(result.breakdownComplete, true);
  assert.ok(calls.some((row) => row.url.hostname === "polygon.publicnode.com"));
});
