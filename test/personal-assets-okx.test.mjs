import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fetchOkxAssets } from "../src/personal-assets-okx.mjs";

const time = new Date("2026-10-24T12:30:00.000Z");
const credentials = { apiKey: "synthetic-api-key", secret: "synthetic-secret", passphrase: "synthetic-passphrase", region: "global" };
const now = () => time;
function fixture(overrides = {}) {
  return {
    "/api/v5/account/config": [{ uid: "1000001", perm: "read_only", label: "Not exposed" }],
    "/api/v5/account/balance": [{ totalEq: "160", details: [
      { ccy: "USDT", eq: "99.9", eqUsd: "100", cashBal: "200", availBal: "50" },
      { ccy: "BTC", eq: "0.001", eqUsd: "40" }, { ccy: "OKSOL", eq: "0.2", eqUsd: "20" },
    ] }],
    "/api/v5/asset/asset-valuation?ccy=USD": [{ totalBal: "180", ts: String(time.getTime()), details: { trading: "160", funding: "15", earn: "5", classic: "0" } }],
    ...overrides,
  };
}
function fakeFetch(data = fixture(), options = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: input, init });
    if (options.check) options.check(input, init);
    const url = new URL(input);
    const body = data[url.pathname + url.search];
    assert.ok(body, `Unexpected request ${url.pathname}${url.search}`);
    return new Response(JSON.stringify({ code: "0", data: body }), { headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("OKX sync signs only allowed GET endpoints and imports one net total without double counting", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await fetchOkxAssets({ credentials, fetchImpl, now });
  assert.equal(result.total, 180);
  assert.equal(result.currency, "USD");
  assert.equal(result.asOf, "2026-10-24");
  assert.equal(result.fetchedAt, time.toISOString());
  assert.equal(result.observedAt, time.toISOString());
  assert.equal(result.timeBasis, "source");
  assert.equal(result.externalAccountId, "1000001");
  assert.equal(result.breakdownComplete, true);
  assert.deepEqual(result.holdings.map((row) => row.amount), [100, 40, 20, 15, 5]);
  assert.deepEqual(result.holdings.map((row) => row.category), ["稳定币", "加密资产", "加密资产", "组合资产", "组合资产"]);
  assert.equal(result.holdings[0].quantity, 99.9);
  assert.equal(result.holdings[0].currency, "USD");
  assert.equal(result.holdings[2].symbol, "OKSOL");
  assert.equal(result.warnings.some((warning) => warning.includes("OKSOL") && warning.includes("不转换成 SOL")), true);
  assert.equal(result.coverage.includes("赚币账户 USD 汇总估值"), true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://openapi.okx.com/api/v5/account/config");
  for (const { url, init } of calls) {
    const target = new URL(url);
    assert.equal(target.origin, "https://openapi.okx.com");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal("body" in init, false);
    assert.equal(init.signal instanceof AbortSignal, true);
    assert.equal(init.headers["OK-ACCESS-KEY"], credentials.apiKey);
    assert.equal(init.headers["OK-ACCESS-PASSPHRASE"], credentials.passphrase);
    assert.equal(init.headers["OK-ACCESS-SIGN"], createHmac("sha256", credentials.secret).update(`${time.toISOString()}GET${target.pathname}${target.search}`).digest("base64"));
  }
  const serialized = JSON.stringify(result);
  for (const secret of Object.values(credentials)) if (secret !== "global") assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("Not exposed"), false);
});

test("OKX region chooses fixed account-entity host without custom URLs or fallback", async () => {
  for (const [region, host] of [["global", "openapi.okx.com"], ["us", "us.okx.com"], ["eea", "eea.okx.com"]]) {
    const { fetchImpl, calls } = fakeFetch();
    await fetchOkxAssets({ credentials: { ...credentials, region }, fetchImpl, now });
    assert.equal(calls.every((call) => new URL(call.url).hostname === host), true);
  }
  for (const region of ["https://attacker.invalid", "__proto__", "constructor", "tr", undefined]) {
    let called = false;
    await assert.rejects(fetchOkxAssets({ credentials: { ...credentials, region }, now, fetchImpl: async () => { called = true; } }), (error) => error.statusCode === 400);
    assert.equal(called, false);
  }
});

test("OKX refuses trade, withdrawal, unknown or unverifiable permissions before fetching assets", async () => {
  for (const perm of ["read_only,trade", "read_only,withdraw", "read_only,transfer", "read_only,unknown", "trade", "", undefined, ["read_only"], "read_only,read_only"]) {
    const { fetchImpl, calls } = fakeFetch(fixture({ "/api/v5/account/config": [{ uid: "1000001", perm }] }));
    await assert.rejects(fetchOkxAssets({ credentials, fetchImpl, now }), (error) => error.statusCode === 403 && error.message.includes("Read"));
    assert.equal(calls.length, 1);
  }
});

test("OKX rejects malformed local credentials without any network access", async () => {
  for (const changed of [{ apiKey: "" }, { secret: "\nsecret" }, { passphrase: null }, { apiKey: "a".repeat(501) }]) {
    let called = false;
    await assert.rejects(fetchOkxAssets({ credentials: { ...credentials, ...changed }, now, fetchImpl: async () => { called = true; } }), (error) => error.statusCode === 400);
    assert.equal(called, false);
  }
});

test("OKX never substitutes blank or missing estimates with zero and reports incomplete breakdown", async () => {
  const { fetchImpl } = fakeFetch(fixture({
    "/api/v5/account/balance": [{ totalEq: "160", details: [{ ccy: "BTC", eq: "0.001", eqUsd: "" }, { ccy: "USDT", eqUsd: "100" }] }],
    "/api/v5/asset/asset-valuation?ccy=USD": [{ totalBal: "180", ts: String(time.getTime()), details: { funding: "15" } }],
  }));
  const result = await fetchOkxAssets({ credentials, fetchImpl, now });
  assert.equal(result.total, 180);
  assert.equal(result.breakdownComplete, false);
  assert.deepEqual(result.holdings.map((row) => row.externalId), ["trading:USDT", "funding:summary"]);
  assert.equal("quantity" in result.holdings[0], false);
  assert.equal(result.warnings.some((warning) => warning.includes("BTC 未返回 USD")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("赚币账户未返回")), true);
  assert.equal(result.holdings.some((row) => row.name.includes("差额")), false);
});

test("OKX keeps negative currency equity in official net total and omits unsupported negative detail", async () => {
  const { fetchImpl } = fakeFetch(fixture({
    "/api/v5/account/balance": [{ totalEq: "160", details: [{ ccy: "BTC", eq: "1", eqUsd: "200" }, { ccy: "USDT", eq: "-40", eqUsd: "-40" }] }],
  }));
  const result = await fetchOkxAssets({ credentials, fetchImpl, now });
  assert.equal(result.total, 180);
  assert.equal(result.breakdownComplete, false);
  assert.equal(result.holdings.some((row) => row.symbol === "USDT"), false);
  assert.equal(result.holdings.every((row) => row.amount >= 0), true);
  assert.equal(result.warnings.some((warning) => warning.includes("负币种权益")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("不会用差额补造资产")), true);
});

test("OKX rejects missing, malformed, negative and nonfinite total instead of overwriting assets", async () => {
  for (const totalBal of [undefined, "", "NaN", "Infinity", "1e400", "-1", null, 180]) {
    const { fetchImpl } = fakeFetch(fixture({ "/api/v5/asset/asset-valuation?ccy=USD": [{ totalBal, ts: String(time.getTime()), details: {} }] }));
    await assert.rejects(fetchOkxAssets({ credentials, fetchImpl, now }), /资产|估值/);
  }
  const { fetchImpl } = fakeFetch(fixture({ "/api/v5/account/balance": [] }));
  await assert.rejects(fetchOkxAssets({ credentials, fetchImpl, now }), /有效估值/);
});

test("OKX rejects malformed or duplicate token identifiers and never imports derivative nominal amounts", async () => {
  for (const details of [[{ ccy: "BTC<script>", eqUsd: "10" }], [{ ccy: "BTC", eqUsd: "10" }, { ccy: "BTC", eqUsd: "10" }], [{ ccy: "BTC", eqUsd: "not-a-number" }]]) {
    const { fetchImpl } = fakeFetch(fixture({ "/api/v5/account/balance": [{ totalEq: "160", details }] }));
    await assert.rejects(fetchOkxAssets({ credentials, fetchImpl, now }), /有效估值/);
  }
  const { fetchImpl } = fakeFetch(fixture({ "/api/v5/account/balance": [{ totalEq: "160", notionalUsd: "500000", details: [] }] }));
  const result = await fetchOkxAssets({ credentials, fetchImpl, now });
  assert.equal(result.total, 180);
  assert.equal(JSON.stringify(result).includes("500000"), false);
});

test("OKX honors Beijing valuation date and refuses stale data", async () => {
  const ts = String(time.getTime() - 3600_000);
  const { fetchImpl } = fakeFetch(fixture({ "/api/v5/asset/asset-valuation?ccy=USD": [{ totalBal: "180", ts, details: {} }] }));
  await assert.rejects(fetchOkxAssets({ credentials, fetchImpl, now }), /超过 15 分钟/);
  const evening = new Date("2026-10-24T18:00:00.000Z");
  const eveningFixture = fakeFetch(fixture({ "/api/v5/asset/asset-valuation?ccy=USD": [{ totalBal: "180", ts: String(evening.getTime()), details: {} }] }));
  const result = await fetchOkxAssets({ credentials, fetchImpl: eveningFixture.fetchImpl, now: () => evening });
  assert.equal(result.asOf, "2026-10-25");
  for (const ts of [undefined, "NaN", String(time.getTime() + 3600_000)]) {
    const { fetchImpl } = fakeFetch(fixture({ "/api/v5/asset/asset-valuation?ccy=USD": [{ totalBal: "180", ts, details: {} }] }));
    await assert.rejects(fetchOkxAssets({ credentials, fetchImpl, now }), /估值|时间/);
  }
});

test("OKX never declares a breakdown complete when omitted positive and negative amounts offset", async () => {
  const { fetchImpl } = fakeFetch(fixture({
    "/api/v5/account/balance": [{ totalEq: "160", details: [
      { ccy: "BTC", eq: "1", eqUsd: "160" }, { ccy: "USDT", eq: "-40", eqUsd: "-40" }, { ccy: "ETH", eq: "1", eqUsd: "" },
    ] }],
  }));
  const result = await fetchOkxAssets({ credentials, fetchImpl, now });
  assert.equal(result.holdings.reduce((sum, row) => sum + row.amount, 0), result.total);
  assert.equal(result.breakdownComplete, false);
});

test("OKX completeness requires actual quantities and each account valuation to reconcile", async () => {
  for (const data of [
    fixture({ "/api/v5/account/balance": [{ totalEq: "160", details: [{ ccy: "BTC", eqUsd: "160" }] }] }),
    fixture({ "/api/v5/asset/asset-valuation?ccy=USD": [{ totalBal: "180", ts: String(time.getTime()), details: { funding: "15", earn: "5" } }] }),
    fixture({ "/api/v5/asset/asset-valuation?ccy=USD": [{ totalBal: "180", ts: String(time.getTime()), details: { trading: "159.99", funding: "15", earn: "5" } }] }),
    fixture({ "/api/v5/asset/asset-valuation?ccy=USD": [{ totalBal: "180.01", ts: String(time.getTime()), details: { trading: "160", funding: "15", earn: "5" } }] }),
  ]) {
    const { fetchImpl } = fakeFetch(data);
    const result = await fetchOkxAssets({ credentials, fetchImpl, now });
    assert.equal(result.breakdownComplete, false);
  }
});

test("OKX sanitizes upstream errors, malformed JSON, redirects and transport failures", async () => {
  const sensitive = `${credentials.apiKey} ${credentials.secret} ${credentials.passphrase}`;
  for (const fetchImpl of [
    async () => new Response(JSON.stringify({ code: "50113", msg: sensitive, data: [] })),
    async () => new Response(sensitive, { status: 401 }),
    async () => new Response(sensitive, { status: 302, headers: { location: "https://attacker.invalid" } }),
    async () => new Response(sensitive),
    async () => { throw new Error(sensitive); },
    async () => { throw new DOMException(sensitive, "TimeoutError"); },
  ]) {
    await assert.rejects(fetchOkxAssets({ credentials, fetchImpl, now }), (error) => {
      assert.equal(error.statusCode, 502);
      for (const secret of [credentials.apiKey, credentials.secret, credentials.passphrase]) assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test("OKX maps HTTP and application throttling without leaking response messages", async () => {
  for (const fetchImpl of [async () => new Response("private", { status: 429 }), async () => new Response(JSON.stringify({ code: "50011", msg: "private", data: [] }))]) {
    await assert.rejects(fetchOkxAssets({ credentials, fetchImpl, now }), (error) => error.statusCode === 429 && !error.message.includes("private"));
  }
});

test("OKX bounds declared and streaming response size", async () => {
  for (const fetchImpl of [
    async () => new Response("{}", { headers: { "content-length": "1000001" } }),
    async () => new Response(" ".repeat(1_000_001)),
  ]) {
    await assert.rejects(fetchOkxAssets({ credentials, fetchImpl, now }), /有效估值/);
  }
});
