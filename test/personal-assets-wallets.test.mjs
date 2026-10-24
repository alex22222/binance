import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { fetchWalletAssets } from "../src/personal-assets-wallets.mjs";

const time = new Date("2026-10-24T12:30:00.000Z");
const now = () => time;
const credentials = { apiKey: "synthetic-wallet-key", secret: "synthetic-wallet-secret", passphrase: "synthetic-wallet-passphrase" };
const evm = `0x${"a1".repeat(20)}`;
const otherEvm = `0x${"b2".repeat(20)}`;
const solana = "11111111111111111111111111111112";
const usdtEth = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const usdtSol = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const unknownEth = `0x${"c3".repeat(20)}`;
const balancePath = "/api/v6/dex/balance/all-token-balances-by-address";
const defiPath = "/api/v6/defi/user/asset/platform/list";
const wallets = [{ chainIndex: "1", address: evm }, { chainIndex: "501", address: solana }];
const token = (wallet, contract, symbol, balance, tokenPrice, extra = {}) => ({ address: wallet.address, chainIndex: wallet.chainIndex,
  tokenContractAddress: contract, symbol, balance, tokenPrice, rawBalance: "", isRiskToken: false, ...extra });
function fixture() {
  return {
    balances: {
      "1": [token(wallets[0], "", "ETH", "0.25", "2000"), token(wallets[0], usdtEth, "USDT", "100.125", "1")],
      "501": [token(wallets[1], "", "SOL", "2", "100"), token(wallets[1], usdtSol, "USDT", "3.5", "1")],
    },
    defi: { assetStatus: 1, updateAt: time.getTime(), walletIdPlatformList: [] },
    quote: { error: [], result: { USDTZUSD: [["0.998", "2", time.getTime() / 1000, "b", "m", ""]], last: "1" } },
  };
}
function fakeFetch(data = fixture(), intercept) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input); calls.push({ url: input, init });
    const response = intercept?.(url, init);
    if (response) return response;
    if (url.hostname === "api.kraken.com") return Response.json(data.quote);
    assert.equal(url.origin, "https://web3.okx.com");
    if (url.pathname === balancePath) return Response.json({ code: "0", data: [{ tokenAssets: data.balances[url.searchParams.get("chains")] }] });
    if (url.pathname === defiPath) return Response.json({ code: 0, data: data.defi });
    throw new Error("Unexpected synthetic endpoint");
  };
  return { fetchImpl, calls };
}
const run = (options = {}) => fetchWalletAssets({ provider: "okxweb3", credentials, wallets, now, ...options });

test("wallet sync signs only fixed read queries, prices verified contracts, and keeps retrieval time honest", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await run({ fetchImpl });
  assert.equal(result.provider, "okxweb3");
  assert.equal(result.currency, "USD");
  assert.ok(Math.abs(result.total - (500 + 200 + (100.125 + 3.5) * 0.998)) < 1e-9);
  assert.equal(result.holdings.length, 4);
  assert.equal(result.holdings[1].category, "稳定币");
  assert.equal(result.holdings[1].rawQuantity, "100.125");
  assert.deepEqual(result.unpricedAssets, []);
  assert.equal(result.valuationComplete, true);
  assert.equal(result.breakdownComplete, true);
  assert.equal(result.observedAt, null);
  assert.equal(result.timeBasis, "retrieved");
  assert.equal(result.fetchedAt, time.toISOString());
  assert.equal(result.asOf, "2026-10-24");
  assert.equal(result.coverage.some((line) => line.includes("NFT") && line.includes("不含")), true);
  for (const call of calls) {
    const url = new URL(call.url); const init = call.init;
    assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal);
    if (url.hostname === "api.kraken.com") {
      assert.equal(url.pathname, "/0/public/Trades"); assert.equal(url.searchParams.get("pair"), "USDTUSD");
      assert.equal(init.headers["OK-ACCESS-KEY"], undefined); continue;
    }
    assert.ok([balancePath, defiPath].includes(url.pathname));
    assert.equal(init.headers["OK-ACCESS-KEY"], credentials.apiKey);
    const signed = `${time.toISOString()}${init.method}${url.pathname}${url.search}${init.body || ""}`;
    assert.equal(init.headers["OK-ACCESS-SIGN"], createHmac("sha256", credentials.secret).update(signed).digest("base64"));
    if (init.method === "GET") {
      assert.equal(url.searchParams.get("excludeRiskToken"), "1"); assert.equal(url.searchParams.get("filter"), "1");
    } else {
      const body = JSON.parse(init.body);
      assert.equal(body.walletAddressList.length, 1);
      assert.ok(wallets.some((w) => w.address === body.walletAddressList[0].walletAddress && w.chainIndex === body.walletAddressList[0].chainIndex));
    }
  }
  for (const secret of Object.values(credentials)) assert.equal(JSON.stringify(result).includes(secret), false);
});

test("wallet external identity is stable across EVM case, provider and input order", async () => {
  const a = await run(fakeFetch());
  const reordered = [{ ...wallets[1] }, { ...wallets[0], address: `0x${evm.slice(2).toUpperCase()}` }];
  const b = await run({ ...fakeFetch(), provider: "tokenpocket", wallets: reordered });
  const canonical = [`1:${evm}`, `501:${solana}`].sort().join("|");
  assert.equal(a.externalAccountId, `wallets:${createHash("sha256").update(canonical).digest("hex")}`);
  assert.equal(a.externalAccountId, b.externalAccountId); assert.ok(a.externalAccountId.length <= 200);
  assert.equal(b.provider, "tokenpocket");
});

test("Solana wallet identity preserves case instead of applying EVM address normalization", async () => {
  const ids = [];
  for (const suffix of ["a", "A"]) {
    const wallet = { chainIndex: "501", address: "1".repeat(31) + suffix };
    const data = fixture(); data.balances["501"] = [token(wallet, "", "SOL", "1", "100")];
    ids.push((await run({ ...fakeFetch(data), wallets: [wallet] })).externalAccountId);
  }
  assert.notEqual(ids[0], ids[1]);
});

test("all positive unknown and unpriced tokens retain exact quantities without synthetic zero amounts", async () => {
  const data = fixture();
  data.balances["1"].push(token(wallets[0], unknownEth, "USDT", "12345678901234567890.123456789012345678", "500", { isRiskToken: true }));
  data.balances["501"].push(token(wallets[1], "11111111111111111111111111111113", "ZERO", "1.000000001", "99"));
  data.balances["1"][0].tokenPrice = "";
  const result = await run(fakeFetch(data));
  assert.equal(result.valuationComplete, false); assert.equal(result.unpricedAssets.length, 3);
  assert.equal(result.unpricedAssets.find((r) => r.contract === unknownEth).quantity, "12345678901234567890.123456789012345678");
  assert.ok(result.unpricedAssets.every((r) => !Object.hasOwn(r, "amount") && r.reason));
  assert.equal(result.holdings.some((r) => r.symbol === "ZERO"), false);
  assert.equal(result.total, result.holdings.reduce((sum, row) => sum + row.amount, 0));
});

test("missing or stale actual USDT quotes leave USDT unpriced and never assume a fixed dollar peg", async () => {
  for (const quote of [{ error: ["untrusted upstream secret"] }, { error: [], result: {} },
    { error: [], result: { USDTZUSD: [["1", "2", time.getTime() / 1000 - 3600]] } }]) {
    const data = fixture(); data.quote = quote;
    const result = await run(fakeFetch(data));
    assert.equal(result.valuationComplete, false); assert.equal(result.total, 700);
    assert.equal(result.unpricedAssets.length, 2);
    assert.ok(result.unpricedAssets.every((r) => r.symbol === "USDT"));
    assert.equal(JSON.stringify(result).includes("untrusted upstream secret"), false);
  }
});

test("DeFi rows, missing scope, stale data and updating aggregates stay unverified without adding their value", async () => {
  for (const defi of [{ assetStatus: 1, updateAt: time.getTime() },
    { assetStatus: 2, updateAt: time.getTime(), walletIdPlatformList: [] },
    { assetStatus: 1, updateAt: time.getTime() - 3600_000, walletIdPlatformList: [] },
    { assetStatus: 1, updateAt: time.getTime(), walletIdPlatformList: [{ platformList: [{ platformName: "Polymarket", analysisPlatformId: 1, currencyAmount: "99999" }] }] }]) {
    const data = fixture(); data.defi = defi;
    const result = await run(fakeFetch(data));
    assert.equal(result.valuationComplete, false);
    assert.ok(Math.abs(result.total - (700 + 103.625 * 0.998)) < 1e-9);
    assert.ok(result.warnings.some((w) => w.includes("DeFi") && w.includes("核实")));
    assert.equal(result.holdings.some((h) => h.amount === 99999), false);
  }
});

test("wallet sync validates credentials, provider, address formats and duplicate bindings before networking", async () => {
  for (const options of [{ credentials: null }, { credentials: { ...credentials, secret: "\nsecret" } },
    { provider: "constructor" }, { wallets: [] }, { wallets: [{ chainIndex: "56", address: evm }] }, { wallets: [{ chainIndex: 1, address: evm }] },
    { wallets: [{ chainIndex: "1", address: solana }] }, { wallets: [{ chainIndex: "501", address: evm }] },
    { wallets: [{ chainIndex: "501", address: "2".repeat(44) + "0" }] }, { wallets: [wallets[0], wallets[0]] }]) {
    let called = false;
    await assert.rejects(run({ ...options, fetchImpl: async () => { called = true; } }), (e) => e.statusCode === 400);
    assert.equal(called, false);
  }
});

test("foreign-wallet, wrong-chain, duplicate and malformed balance rows cannot become a valid snapshot", async () => {
  for (const change of [
    (d) => { d.balances["1"][0].address = otherEvm; },
    (d) => { d.balances["501"][0].address = "1111111111111111111111111111111A"; },
    (d) => { d.balances["1"][0].chainIndex = "137"; },
    (d) => { d.balances["1"][0].symbol = "USDT"; },
    (d) => { d.balances["1"].push({ ...d.balances["1"][1], tokenContractAddress: `0x${usdtEth.slice(2).toUpperCase()}` }); },
    (d) => { d.balances["1"][0].balance = "NaN"; },
    (d) => { d.balances["1"][0].balance = "-1"; },
    (d) => { d.balances["1"][0].balance = "1e3"; },
    (d) => { d.balances["1"][1].tokenContractAddress = "https://attacker.invalid"; },
  ]) {
    const data = fixture(); change(data);
    await assert.rejects(run(fakeFetch(data)), /响应|数据|资产|余额/);
  }
});

test("verified empty token scope returns zero, while unknown-only positive holdings remain partially unvalued", async () => {
  const data = fixture(); data.balances["1"] = []; data.balances["501"] = [];
  let result = await run(fakeFetch(data));
  assert.equal(result.total, 0); assert.equal(result.valuationComplete, true); assert.deepEqual(result.holdings, []);
  data.balances["1"] = [token(wallets[0], unknownEth, "UNKNOWN", "4", "")];
  result = await run(fakeFetch(data));
  assert.equal(result.total, 0); assert.equal(result.valuationComplete, false);
  assert.deepEqual(result.holdings, []); assert.equal(result.unpricedAssets[0].quantity, "4");
});

test("wallet sync caps aggregate valuation and inventory rather than truncating valid-looking responses", async () => {
  for (const change of [
    (d) => { d.balances["1"][0].balance = "1000000000000"; },
    (d) => { d.balances["1"][0].balance = "1".repeat(121); },
    (d) => { d.balances["1"] = Array.from({ length: 1000 }, () => d.balances["1"][0]); },
  ]) {
    const data = fixture(); change(data);
    await assert.rejects(run(fakeFetch(data)), /资产|响应/);
  }
});

test("rate limits and DeFi request failures never become successful complete valuations", async () => {
  for (const response of [new Response("private upstream text", { status: 429 }), Response.json({ code: "50011", msg: credentials.secret })]) {
    await assert.rejects(run(fakeFetch(fixture(), (url) => url.pathname === balancePath ? response : undefined)), (e) => e.statusCode === 429 && !e.message.includes(credentials.secret));
  }
  const result = await run(fakeFetch(fixture(), (url) => url.pathname === defiPath ? new Response(credentials.secret, { status: 403 }) : undefined));
  assert.equal(result.valuationComplete, false); assert.ok(result.total > 0);
  assert.equal(JSON.stringify(result).includes(credentials.secret), false);
});

test("Developer auth and IP rejection is actionable without masquerading as expired dashboard login", async () => {
  for (const response of [new Response(credentials.secret, { status: 401 }), new Response(credentials.apiKey, { status: 403 }),
    Response.json({ code: "50103", msg: credentials.secret }), Response.json({ code: "50114", msg: credentials.passphrase })]) {
    await assert.rejects(run(fakeFetch(fixture(), (url) => url.pathname === balancePath ? response : undefined)), (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /OnchainOS.*开发者凭据.*权限.*IP.*核对/);
      assert.equal(Object.values(credentials).some((secret) => error.message.includes(secret)), false);
      return true;
    });
  }
});

test("upstream failures, redirects, invalid JSON and size limits fail safely without exposing secrets or bodies", async () => {
  for (const response of [new Response("secret " + credentials.secret, { status: 401 }),
    new Response("secret", { status: 302, headers: { location: "https://attacker.invalid" } }),
    new Response("{not-json"), new Response("{}", { headers: { "content-length": "1000001" } }),
    Response.json({ code: "50114", msg: credentials.passphrase }),
    Response.json({ code: "0", data: [{ tokenAssets: [], has_more: true }] }),
    new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1_000_001)); c.close(); } }))]) {
    const { fetchImpl } = fakeFetch(fixture(), (url) => url.pathname === balancePath ? response : undefined);
    await assert.rejects(run({ fetchImpl }), (error) => {
      assert.equal(Object.values(credentials).some((s) => String(error).includes(s)), false);
      return error.statusCode >= 400;
    });
  }
  await assert.rejects(run({ fetchImpl: async () => { throw new Error(credentials.secret); } }), (e) => !e.message.includes(credentials.secret));
});
