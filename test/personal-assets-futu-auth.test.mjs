import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyPortfolio } from "../src/personal-assets-core.mjs";
import { savePersonalAssets } from "../src/personal-assets.mjs";
import { completeFutuAuthorization, performAssetSyncAction, readAssetSyncStatus } from "../src/personal-assets-sync.mjs";
import { exchangeFutuCode } from "../src/personal-assets-futu.mjs";

process.env.PERSONAL_ASSETS_FX_DISABLED = "1";
const now = new Date("2026-10-25T03:00:00Z");
const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", scope: "trade:read accid:123", expiresAt: "2026-10-25T05:00:00Z" };
const accounts = [{ id: "123", label: "Synthetic real account" }];
const file = dir => join(dir, "personal-assets-sync.json");
const read = async dir => JSON.parse(await readFile(file(dir), "utf8"));
const action = (stateDir, action, api = {}, body = {}) => performAssetSyncAction({ stateDir, provider: "futu", action, api, body, now, clock: () => now, sessionBinding: "synthetic-session" });
const api = { registerFutuClient: async () => ({ clientId: "synthetic-client" }),
  createFutuAuthorization: ({ state }) => `https://webapi.futunn.com/oauth2/authorize/confirm?state=${state}`,
  exchangeFutuCode: async () => tokens, fetchFutuAccounts: async () => accounts };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "futu-auth-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await savePersonalAssets({ stateDir: dir, portfolio: emptyPortfolio(), revision: 0 }); return dir;
}
async function query(dir) {
  const result = await action(dir, "authorize", api);
  return { state: new URL(result.authorizationUrl).searchParams.get("state"), code: "synthetic-one-use-code" };
}
const complete = (dir, query, api) => completeFutuAuthorization({ stateDir: dir, query, api, sessionBinding: "synthetic-session", now, clock: () => now });

test("verified Futu tokens survive account-list failure and retry needs no new OAuth or financial write", async t => {
  const dir = await fixture(t), q = await query(dir), ledger = await readFile(join(dir, "personal-assets.json"), "utf8");
  let exchanged = 0, lists = 0;
  const source = { ...api, exchangeFutuCode: async () => { exchanged++; return tokens; }, fetchFutuAccounts: async ({ accessToken }) => {
    assert.equal(accessToken, tokens.accessToken); assert.deepEqual((await read(dir)).providers.futu.tokens, tokens);
    lists++; if (lists === 1) throw Error("synthetic-private-upstream-error"); return accounts;
  } };
  await assert.rejects(complete(dir, q, source));
  const failed = (await readAssetSyncStatus({ stateDir: dir, now })).providers.futu;
  assert.equal(failed.connected, true); assert.equal(failed.enabled, false); assert.deepEqual(failed.accounts, []);
  assert.match(failed.lastError, /账户列表读取/); assert.doesNotMatch(JSON.stringify(failed), /synthetic-access|synthetic-refresh|synthetic-private/);
  const recovered = await action(dir, "accounts", source);
  assert.deepEqual(recovered.providers.futu.accounts, accounts); assert.equal(recovered.providers.futu.lastError, null);
  assert.equal(recovered.providers.futu.enabled, false); assert.equal(recovered.providers.futu.preview, undefined);
  assert.equal(exchanged, 1); assert.equal(lists, 2);
  assert.equal(await readFile(join(dir, "personal-assets.json"), "utf8"), ledger);
  await assert.rejects(complete(dir, q, source), { statusCode: 403 }); assert.equal(exchanged, 1);
});

test("non-read token scopes remain rejected and safe authorization failure is visible without losing old data", async t => {
  const dir = await fixture(t), q = await query(dir), ledger = await readFile(join(dir, "personal-assets.json"), "utf8");
  let lists = 0;
  const source = { ...api, exchangeFutuCode: options => exchangeFutuCode({ ...options, fetchImpl: async () => Response.json({ access_token: "synthetic-private-access", refresh_token: "synthetic-private-refresh", token_type: "Bearer", expires_in: 7200, scope: "trade:read trade:write" }) }), fetchFutuAccounts: async () => { lists++; return accounts; } };
  await assert.rejects(complete(dir, q, source), /读取权限/);
  const status = (await readAssetSyncStatus({ stateDir: dir, now })).providers.futu;
  assert.equal(status.connected, false); assert.match(status.lastError, /授权验证.*读取权限/);
  assert.doesNotMatch(JSON.stringify(await read(dir)), /synthetic-private-access|synthetic-private-refresh/);
  assert.equal(lists, 0); assert.equal(await readFile(join(dir, "personal-assets.json"), "utf8"), ledger);
});

test("unknown token-exchange errors never expose raw messages, codes or credentials in sync status", async t => {
  const dir = await fixture(t), q = await query(dir);
  await assert.rejects(complete(dir, q, { ...api, exchangeFutuCode: async () => { throw Error("synthetic-secret synthetic-one-use-code"); } }));
  const status = (await readAssetSyncStatus({ stateDir: dir, now })).providers.futu;
  assert.match(status.lastError, /授权验证/); assert.equal(status.connected, false);
  assert.doesNotMatch(JSON.stringify(await read(dir)), /synthetic-secret|synthetic-one-use-code/);
});

test("invalid callback sessions and expired state cannot overwrite existing authorization diagnostics", async t => {
  const dir = await fixture(t), q = await query(dir), config = await read(dir);
  config.providers.futu = { lastError: "Existing safe failure" }; await writeFile(file(dir), JSON.stringify(config), { mode: 0o600 });
  const before = await readFile(file(dir), "utf8"); let calls = 0;
  for (const options of [{ query: { ...q, state: "wrong" } }, { sessionBinding: "another-session" }, { now: new Date("2026-10-25T04:00:00Z"), clock: () => new Date("2026-10-25T04:00:00Z") }]) {
    await assert.rejects(completeFutuAuthorization({ stateDir: dir, query: q, api: { ...api, exchangeFutuCode: async () => { calls++; return tokens; } }, sessionBinding: "synthetic-session", now, clock: () => now, ...options }), { statusCode: 403 });
    assert.equal(await readFile(file(dir), "utf8"), before);
  }
  assert.equal(calls, 0);
});

test("Futu account-list retry requires a grant and persists refreshed credentials before a later read failure", async t => {
  const dir = await fixture(t); let calls = 0;
  await assert.rejects(action(dir, "accounts", { fetchFutuAccounts: async () => { calls++; return accounts; } }), /授权/);
  assert.equal(calls, 0);
  await writeFile(file(dir), JSON.stringify({ schemaVersion: 1, futuClient: { clientId: "client" }, providers: { futu: { tokens: { ...tokens, expiresAt: now.toISOString() }, accounts, enabled: false } } }), { mode: 0o600 });
  const refreshed = { ...tokens, accessToken: "synthetic-refreshed-access" };
  await assert.rejects(action(dir, "accounts", { refreshFutuToken: async () => refreshed, fetchFutuAccounts: async () => { assert.equal((await read(dir)).providers.futu.tokens.accessToken, refreshed.accessToken); throw Error("private failed list"); } }));
  const saved = await read(dir); assert.deepEqual(saved.providers.futu.tokens, refreshed); assert.deepEqual(saved.providers.futu.accounts, accounts);
  assert.doesNotMatch(saved.providers.futu.lastError, /private failed list/);
  const status = await action(dir, "accounts", { fetchFutuAccounts: async () => accounts }); assert.equal(status.providers.futu.lastError, null);
  await assert.rejects(performAssetSyncAction({ stateDir: dir, provider: "okx", action: "accounts", api: {}, now }), { statusCode: 404 });
});

test("a new verified grant pauses the previous binding and removes stale accounts and previews before reading", async t => {
  const dir = await fixture(t), q = await query(dir), config = await read(dir), ledger = await readFile(join(dir, "personal-assets.json"), "utf8");
  config.providers.futu = { tokens: { ...tokens, accessToken: "old-access" }, accounts, enabled: true, externalAccountId: "123", targetAccountId: "account-3", lastAppliedAt: "2026-10-24T12:00:00Z", preview: { id: "stale-preview" } };
  await writeFile(file(dir), JSON.stringify(config), { mode: 0o600 });
  await assert.rejects(complete(dir, q, { ...api, fetchFutuAccounts: async () => { const value = (await read(dir)).providers.futu; assert.equal(value.enabled, false); assert.deepEqual(value.accounts, []); assert.equal(value.preview, undefined); throw Error("private failure"); } }));
  const value = (await read(dir)).providers.futu;
  assert.deepEqual(value.tokens, tokens); assert.equal(value.lastAppliedAt, config.providers.futu.lastAppliedAt); assert.equal(value.externalAccountId, "123");
  assert.equal(await readFile(join(dir, "personal-assets.json"), "utf8"), ledger);
});

test("a refreshed account list invalidates a preview and binding whose source is no longer authorized", async t => {
  const dir = await fixture(t), ledger = await readFile(join(dir, "personal-assets.json"), "utf8");
  await writeFile(file(dir), JSON.stringify({ schemaVersion: 1, providers: { futu: { tokens, accounts, enabled: true, externalAccountId: "123", preview: { id: "old-preview", externalAccountId: "123" } } } }), { mode: 0o600 });
  const status = await action(dir, "accounts", { fetchFutuAccounts: async () => [{ id: "456", label: "Another authorized account" }] });
  assert.equal(status.providers.futu.enabled, false); assert.equal(status.providers.futu.preview, undefined);
  assert.equal(status.providers.futu.selectedAccountId, "123");
  assert.equal(await readFile(join(dir, "personal-assets.json"), "utf8"), ledger);
});
