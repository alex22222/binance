import test from "node:test";
import assert from "node:assert/strict";
import {
  registerFutuClient,
  createFutuAuthorization,
  exchangeFutuCode,
  refreshFutuToken,
  fetchFutuAccounts,
  fetchFutuAssets,
} from "../src/personal-assets-futu.mjs";

const redirectUri = "https://assets.example.test/api/assets/sync/futu/callback";
const now = () => new Date("2026-10-24T12:00:00.000Z");
const account = { account_id: "123456", security_firm: "FUTUSECURITIES", acc_type: "margin", account_card_number: "1234567890123456" };
const token = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 7200, scope: "trade:read accid:123456" };

function mockFetch(values) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("Futu OAuth client registration and authorization explicitly request read access with PKCE", async () => {
  const mock = mockFetch([{ client_id: "synthetic-client", registration_access_token: "do-not-return", token_endpoint_auth_method: "none", scope: "trade:read trade:write" }]);
  assert.deepEqual(await registerFutuClient({ redirectUri, ...mock }), { clientId: "synthetic-client" });
  assert.equal(mock.calls[0].url, "https://webapi.futunn.com/oauth2/register");
  const body = JSON.parse(mock.calls[0].options.body);
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.equal(body.scope, "trade:read");
  assert.deepEqual(body.redirect_uris, [redirectUri]);
  const url = new URL(createFutuAuthorization({ clientId: "synthetic-client", redirectUri, state: "a".repeat(32), codeChallenge: "b".repeat(43) }));
  assert.equal(url.origin + url.pathname, "https://webapi.futunn.com/oauth2/authorize/confirm");
  assert.equal(url.searchParams.get("scope"), "trade:read");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "a".repeat(32));
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.throws(() => createFutuAuthorization({ clientId: "client", redirectUri: "http://remote.example/callback", state: "a".repeat(32), codeChallenge: "b".repeat(43) }), /HTTPS/);
  assert.throws(() => createFutuAuthorization({ clientId: "client", redirectUri, state: "short", codeChallenge: "b".repeat(43) }), /校验值/);
});

test("Futu token exchange validates read scopes and refresh retains its non-rotating refresh token", async () => {
  const mock = mockFetch([token, { ...token, access_token: "new-access", refresh_token: undefined }]);
  const result = await exchangeFutuCode({ clientId: "synthetic-client", redirectUri, code: "synthetic-code", codeVerifier: "v".repeat(43), now, ...mock });
  assert.deepEqual(result, { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: "2026-10-24T14:00:00.000Z", scope: token.scope });
  assert.equal(mock.calls[0].url, "https://webapi.futunn.com/oauth2/token");
  assert.equal(mock.calls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(new URLSearchParams(mock.calls[0].options.body).get("code_verifier"), "v".repeat(43));
  const refreshed = await refreshFutuToken({ clientId: "synthetic-client", refreshToken: result.refreshToken, now, ...mock });
  assert.equal(refreshed.refreshToken, "synthetic-refresh");
  assert.equal(refreshed.accessToken, "new-access");
  assert.equal(new URLSearchParams(mock.calls[1].options.body).get("grant_type"), "refresh_token");
});

test("Futu rejects missing, write, wildcard permission and unexpected token scopes", async () => {
  for (const scope of [undefined, "quote:read", "trade:*", "trade:read trade:write", "trade:read quote:write", "trade:read *", "trade:read admin:read"]) {
    const mock = mockFetch([{ ...token, scope }]);
    await assert.rejects(() => exchangeFutuCode({ clientId: "client", redirectUri, code: "code", codeVerifier: "v".repeat(43), ...mock }), /授权范围|读取权限/);
  }
  for (const scope of ["trade:read", "quote:read trade:read accid:*", "trade:read accid:123456 accid:654321"]) {
    const mock = mockFetch([{ ...token, scope }]);
    assert.equal((await refreshFutuToken({ clientId: "client", refreshToken: "refresh", ...mock })).scope, scope);
  }
});

test("Futu account selection uses actual authorized endpoint, masks cards and excludes simulated accounts", async () => {
  const mock = mockFetch([{ s: "ok", d: { accounts: [account, { ...account, account_id: "654321", trd_env: "SIMULATE" }] } }]);
  const result = await fetchFutuAccounts({ accessToken: "token", ...mock });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { id: "123456", label: "富途 FUTUSECURITIES 保证金账户 · 尾号 3456", securityFirm: "FUTUSECURITIES", accountType: "margin", environment: "REAL" });
  assert.equal(JSON.stringify(result).includes(account.account_card_number), false);
  assert.equal(mock.calls[0].url, "https://webapi.futunn.com/api/v1.0/accounts/authorized_trd_accs");
  assert.equal(mock.calls[0].options.method, "GET");
  assert.equal(mock.calls[0].options.redirect, "error");
  const unsafe = mockFetch([]);
  await assert.rejects(() => fetchFutuAssets({ accessToken: "token", accountId: 9007199254740992, ...unsafe }), /精度/);
  assert.equal(unsafe.calls.length, 0);
});

test("Futu preserves distinct uint64 account IDs from raw JSON and uses the exact selected ID in requests", async () => {
  const ids = ["18446744073709551614", "18446744073709551615"];
  const response = () => new Response(JSON.stringify({ s: "ok", d: { accounts: ids.map(id => ({ ...account, account_id: `raw-${id}` })) } }).replace(/"raw-(\d+)"/g, "$1"));
  const list = mockFetch([response()]);
  assert.deepEqual((await fetchFutuAccounts({ accessToken: "token", ...list })).map(row => row.id), ids);
  const mock = mockFetch([response(), { s: "ok", d: { total_assets: 1234.56, currency: "HKD" } }, { s: "ok", d: [] }]);
  const result = await fetchFutuAssets({ accessToken: "token", accountId: ids[1], now, ...mock });
  assert.equal(result.externalAccountId, ids[1]);
  assert.equal(result.total, 1234.56);
  assert.equal(mock.calls[1].url, `https://webapi.futunn.com/api/v1.0/accounts/${ids[1]}/funds?currency=HKD`);
  assert.equal(mock.calls[2].url, `https://webapi.futunn.com/api/v1.0/accounts/${ids[1]}/positions`);
});

test("Futu preserves uint64 position IDs without collapsing two positions into one identity", async () => {
  const ids = ["18446744073709551614", "18446744073709551615"];
  const positions = ids.map(id => ({ position_id: `raw-${id}`, code: "US.SYNTH", stock_name: "Synthetic Fund", security_type: "ETF", qty: "2", currency: "USD", market_val: "20" }));
  const raw = new Response(JSON.stringify({ s: "ok", d: positions }).replace(/"raw-(\d+)"/g, "$1"));
  const mock = mockFetch([{ s: "ok", d: { accounts: [account] } }, { s: "ok", d: { total_assets: "40", currency: "USD" } }, raw]);
  const result = await fetchFutuAssets({ accessToken: "token", accountId: "123456", now, ...mock });
  assert.deepEqual(result.holdings.map(row => row.externalId), ids.map(id => `position:US.SYNTH:${id}`));
});

test("Futu rejects unsafe ID number spellings and values outside uint64 rather than guessing digits", async () => {
  for (const id of ["18446744073709551616", "1e18", "9007199254740993.1", "-9007199254740993"]) {
    const raw = new Response(JSON.stringify({ s: "ok", d: { accounts: [{ ...account, account_id: "raw-id" }] } }).replace('"raw-id"', id));
    await assert.rejects(fetchFutuAccounts({ accessToken: "token", ...mockFetch([raw]) }), /编号|格式/);
  }
});

test("Futu uses net assets once and keeps native position values informational", async () => {
  const mock = mockFetch([
    { s: "ok", d: { accounts: [account] } },
    { s: "ok", d: { total_assets: "1234.56", currency: "HKD", securities_assets: "1300", funds_assets: "100", cash: "-65.44", power: "9000", max_withdrawal: "500", hk_cash: "-10", us_cash: "2.5" } },
    { s: "ok", d: [
      { code: "US.SYNTH", stock_name: "Synthetic Fund", security_type: "ETF", qty: "2", currency: "USD", market_val: "20", position_side: "LONG" },
      { code: "HK.00001", stock_name: "Synthetic Company", security_type: "STOCK", qty: "10", currency: "HKD", market_val: "50", position_side: "LONG" },
      { code: "US.SHORT", stock_name: "Synthetic Short", qty: "-1", currency: "USD", market_val: "-5", position_side: "SHORT" },
    ] },
  ]);
  const result = await fetchFutuAssets({ accessToken: "token", accountId: "123456", now, ...mock });
  assert.equal(result.total, 1234.56);
  assert.equal(result.breakdownComplete, false);
  assert.equal(result.currency, "HKD");
  assert.equal(result.asOf, "2026-10-24");
  assert.equal(result.fetchedAt, "2026-10-24T12:00:00.000Z");
  assert.deepEqual(result.holdings.map((row) => [row.symbol ?? row.externalId, row.category, row.currency, row.amount]), [["US.SYNTH", "股票ETF", "USD", 20], ["HK.00001", "股票", "HKD", 50], ["cash:USD", "现金", "USD", 2.5]]);
  assert.ok(result.warnings.some((row) => row.includes("空头")));
  assert.ok(result.warnings.some((row) => row.includes("现金为负")));
  assert.equal(mock.calls[1].url, "https://webapi.futunn.com/api/v1.0/accounts/123456/funds?currency=HKD");
  assert.equal(mock.calls[2].url, "https://webapi.futunn.com/api/v1.0/accounts/123456/positions");
  assert.ok(mock.calls.every((call) => call.options.method === "GET" && call.options.headers.Authorization === "Bearer token"));
});

test("Futu rejects unselected accounts and missing balances without importing zero", async () => {
  const unknown = mockFetch([{ s: "ok", d: { accounts: [account] } }]);
  await assert.rejects(() => fetchFutuAssets({ accessToken: "token", accountId: "654321", ...unknown }), /未获授权/);
  assert.equal(unknown.calls.length, 1);
  for (const total_assets of [undefined, "", "NaN", "-1"]) {
    const mock = mockFetch([{ s: "ok", d: { accounts: [account] } }, { s: "ok", d: { total_assets, currency: "HKD" } }, { s: "ok", d: [] }]);
    await assert.rejects(() => fetchFutuAssets({ accessToken: "token", accountId: "123456", ...mock }), /净资产/);
  }
  const actualCurrency = mockFetch([{ s: "ok", d: { accounts: [account] } }, { s: "ok", d: { total_assets: "0", currency: "USD" } }, { s: "ok", d: [] }]);
  assert.equal((await fetchFutuAssets({ accessToken: "token", accountId: "123456", ...actualCurrency })).currency, "USD");
});

test("Futu upstream errors, malformed and oversized payloads never disclose credentials", async () => {
  for (const response of [
    new Error("synthetic-token synthetic-secret upstream-url"),
    new Response("synthetic-token synthetic-secret", { status: 500 }),
    new Response("synthetic-token synthetic-secret"),
    { s: "error", errmsg: "synthetic-token synthetic-secret" },
    { s: "ok", d: null },
    { s: "ok", d: { accounts: [null] } },
    new Response("{}", { headers: { "content-length": "2000001" } }),
  ]) {
    const mock = mockFetch([response]);
    await assert.rejects(() => fetchFutuAccounts({ accessToken: "synthetic-token", ...mock }), (error) => !/synthetic-token|synthetic-secret|upstream-url/.test(error.message));
  }
  const invalid = mockFetch([]);
  await assert.rejects(() => fetchFutuAssets({ accessToken: "token", accountId: "../orders", ...invalid }), /编号无效/);
  assert.equal(invalid.calls.length, 0);
});
