import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyPortfolio, readPersonalAssets, savePersonalAssets } from "../src/personal-assets.mjs";
import { performAssetSyncAction, readAssetSyncStatus, runAssetSyncCycle } from "../src/personal-assets-sync.mjs";
import { fetchOkxAssets } from "../src/personal-assets-okx.mjs";
import { configureAssetFund, fetchAssetHoldingQuote, readAssetFundStatus, runAssetFundCycle } from "../src/personal-assets-funds.mjs";

process.env.PERSONAL_ASSETS_FX_DISABLED = "1";
const at = new Date("2026-10-24T12:00:00Z"), slot = new Date("2026-10-24T13:00:00Z");
const credentials = { apiKey: "synthetic-key", secret: "synthetic-secret", passphrase: "synthetic-passphrase", region: "global" };
const owner = `0x${"a1".repeat(20)}`, wallets = [{ chainIndex: "137", address: owner }];
const digest = value => createHash("sha256").update(value).digest("hex");
function time(value = at) {
  let valueMs = value.getTime();
  return { read: () => new Date(valueMs), tick: ms => { valueMs += ms; }, set: date => { valueMs = date.getTime(); } };
}
async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "assets-clock-")); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const portfolio = emptyPortfolio(); portfolio.accounts[0].basis = "holdings";
  portfolio.accounts.push({ id: "exchange", platform: "OKX", name: "Synthetic exchange", basis: "total" }, { id: "wallet", platform: "TokenPocket", name: "Synthetic wallet", basis: "holdings" });
  portfolio.entries.push(...["one", "two"].map(id => ({ id: `fund-${id}`, accountId: "account-1", kind: "holding", name: `Synthetic ${id}`, category: "货币基金", currency: "USD", amount: 1, asOf: "2026-10-24", source: "manual" })));
  await savePersonalAssets({ stateDir, portfolio, revision: 0 }); return stateDir;
}
function assets(provider, now) {
  const wallet = provider === "tokenpocket";
  return { provider, currency: "USD", total: 100, asOf: "2026-10-24", fetchedAt: now().toISOString(), observedAt: null, timeBasis: "retrieved",
    externalAccountId: wallet ? `wallets:${digest(`137:${owner}`)}` : "10001", accountLabel: "Synthetic", breakdownComplete: true,
    holdings: [{ externalId: wallet ? `token:${digest(`137:${owner}:native`)}` : "one", name: "Synthetic asset", category: "加密资产", currency: "USD", amount: 100, quantity: "10" }],
    unpricedAssets: [], valuationComplete: false, derivedWallets: [], coverage: [], warnings: [] };
}
const api = { fetchOkxAssets: async ({ now }) => assets("okx", now), fetchWalletAssets: async ({ now }) => assets("tokenpocket", now) };
async function enable(stateDir, provider, clock) {
  const body = provider === "okx" ? { ...credentials, targetAccountId: "exchange" } : { ...credentials, wallets, targetAccountId: "wallet" };
  const connected = await performAssetSyncAction({ stateDir, provider, action: "connect", body, api, now: clock.read(), clock: clock.read });
  const p = connected.providers[provider].preview;
  return performAssetSyncAction({ stateDir, provider, action: "apply", body: { previewId: p.id, revision: p.revision }, api, now: clock.read(), clock: clock.read });
}

test("one cycle clock advances across providers and through each actual source read", async t => {
  const stateDir = await fixture(t), clock = time();
  await enable(stateDir, "okx", clock); await enable(stateDir, "tokenpocket", clock); clock.set(slot);
  const starts = [];
  const source = {
    fetchOkxAssets: async ({ now }) => { starts.push(now().toISOString()); clock.tick(2000); return assets("okx", now); },
    fetchWalletAssets: async ({ now }) => { starts.push(now().toISOString()); clock.tick(3000); return assets("tokenpocket", now); },
  };
  assert.deepEqual(await runAssetSyncCycle({ stateDir, api: source, now: slot, clock: clock.read }), { attempted: 2, applied: 2, failed: 0 });
  assert.deepEqual(starts, [slot.toISOString(), "2026-10-24T13:00:02.000Z"]);
  const status = await readAssetSyncStatus({ stateDir, now: clock.read() });
  assert.equal(status.providers.okx.lastAttemptAt, slot.toISOString());
  assert.equal(status.providers.okx.lastFetchedAt, "2026-10-24T13:00:02.000Z");
  assert.equal(status.providers.okx.lastAppliedAt, "2026-10-24T13:00:02.000Z");
  assert.equal(status.providers.tokenpocket.lastAttemptAt, "2026-10-24T13:00:02.000Z");
  assert.equal(status.providers.tokenpocket.lastFetchedAt, "2026-10-24T13:00:05.000Z");
  assert.equal(status.providers.tokenpocket.lastAppliedAt, "2026-10-24T13:00:05.000Z");
  assert.equal(status.providers.tokenpocket.dueAt, "2026-10-25T01:00:00.000Z");
  const ledger = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  clock.tick(60000);
  assert.deepEqual(await runAssetSyncCycle({ stateDir, api: source, now: clock.read(), clock: clock.read }), { attempted: 0, applied: 0, failed: 0 });
  assert.equal(starts.length, 2); assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), ledger);
});

test("manual apply samples the clock after the financial version has actually been saved", async t => {
  const stateDir = await fixture(t), clock = time();
  const c = await performAssetSyncAction({ stateDir, provider: "okx", action: "connect", body: { ...credentials, targetAccountId: "exchange" }, api, now: at, clock: clock.read });
  const p = c.providers.okx.preview;
  const afterSaveClock = () => new Date(at.getTime() + (JSON.parse(readFileSync(join(stateDir, "personal-assets.json"), "utf8")).revision > p.revision ? 7000 : 0));
  const applied = await performAssetSyncAction({ stateDir, provider: "okx", action: "apply", body: { previewId: p.id, revision: p.revision }, api, now: at, clock: afterSaveClock });
  assert.equal(applied.sync.providers.okx.lastAppliedAt, "2026-10-24T12:00:07.000Z");
  const saved = applied.sync.providers.okx.lastAppliedAt;
  await assert.rejects(performAssetSyncAction({ stateDir, provider: "okx", action: "apply", body: { previewId: "missing", revision: p.revision }, now: slot, clock: () => slot }));
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.okx.lastAppliedAt, saved);
});

function okxHttp(clock, valuationOffset = 0) {
  const calls = [];
  return { calls, fetchImpl: async url => {
    const path = new URL(url).pathname; calls.push(path);
    const data = path.endsWith("config") ? [{ uid: "10001", perm: "read_only" }]
      : path.endsWith("balance") ? [{ totalEq: "100", details: [{ ccy: "USDT", eq: "100", eqUsd: "100" }] }]
      : [{ totalBal: "100", ts: String(at.getTime() + valuationOffset), details: { trading: "100", funding: "0", earn: "0", classic: "0" } }];
    if (path.endsWith("balance")) clock.tick(20000);
    return Response.json({ code: "0", data });
  } };
}
test("OKX captures retrieval time only after its HTTP responses complete", async () => {
  const clock = time(), source = okxHttp(clock);
  const result = await fetchOkxAssets({ credentials, fetchImpl: source.fetchImpl, now: clock.read });
  assert.equal(result.fetchedAt, "2026-10-24T12:00:20.000Z"); assert.equal(result.observedAt, at.toISOString()); assert.equal(source.calls.length, 3);
});
test("OKX rejects a valuation that crosses its fifteen-minute age bound during retrieval", async () => {
  const clock = time(), source = okxHttp(clock, -890000);
  await assert.rejects(fetchOkxAssets({ credentials, fetchImpl: source.fetchImpl, now: clock.read }), /超过 15 分钟/);
  assert.equal(source.calls.length, 3);
});

function navHttp(clock, nav = "12.1") {
  return async url => {
    clock.tick(1000);
    if (url.includes("gaotengasset")) return new Response(`<script>window.__REACT_QUERY_STATE__ = ${JSON.stringify({ queries: [{ queryKey: ["indexNewsCenter"], state: { data: [[{ fundId: "10008", fundName: "高騰微基金-高騰微財貨幣基金", fundClassInfo: [{ isinCode: "HK0000478872", fundClassId: "10008003", fundClassName: "A(港元)-累積", currency: "港元", fundNav: nav, navDate: "2026-10-23" }] }]] } }] })};</script>`);
    if (url.endsWith("transacTional")) return Response.json({ code: 0, data: { fundId: 134, isinCode: "HK0000857299（A類 – 美元）" } });
    return Response.json({ code: 0, data: [{ fundCode: "20220530", classType: "ausdacc", className: "A類-美元-累積", currencyCode: "美元", netAssets: nav, date: "2026-10-23" }] });
  };
}
test("fund clocks span configure and sequential valuations without rewriting unchanged NAV history", async t => {
  const stateDir = await fixture(t), clock = time();
  for (const [entryId, isin] of [["fund-one", "HK0000857299"], ["fund-two", "HK0000478872"]]) {
    const current = await readPersonalAssets({ stateDir });
    await configureAssetFund({ stateDir, entryId, isin, quantity: "2.5", confirmedOn: "2026-10-24", revision: current.revision, fetchImpl: navHttp(clock), now: clock.read(), clock: clock.read });
  }
  let status = await readAssetFundStatus({ stateDir });
  assert.equal(status.bindings[0].lastFetchedAt, "2026-10-24T12:00:02.000Z");
  assert.equal(status.bindings[1].lastFetchedAt, "2026-10-24T12:00:03.000Z");
  clock.set(slot);
  assert.deepEqual(await runAssetFundCycle({ stateDir, now: slot, clock: clock.read, fetchImpl: navHttp(clock, "12.2") }), { attempted: 2, applied: 2, failed: 0 });
  status = await readAssetFundStatus({ stateDir });
  assert.equal(status.bindings[0].lastAttemptAt, slot.toISOString()); assert.equal(status.bindings[0].lastFetchedAt, "2026-10-24T13:00:02.000Z");
  assert.equal(status.bindings[1].lastAttemptAt, "2026-10-24T13:00:02.000Z"); assert.equal(status.bindings[1].lastFetchedAt, "2026-10-24T13:00:03.000Z");
  const applied = status.bindings.map(row => row.lastAppliedAt), ledger = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  clock.set(new Date("2026-10-25T01:00:00Z"));
  assert.deepEqual(await runAssetFundCycle({ stateDir, now: clock.read(), clock: clock.read, fetchImpl: navHttp(clock, "12.2") }), { attempted: 2, applied: 0, failed: 0 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), ledger);
  status = await readAssetFundStatus({ stateDir }); assert.deepEqual(status.bindings.map(row => row.lastAppliedAt), applied);
  assert.equal(status.bindings[0].lastFetchedAt, "2026-10-25T01:00:02.000Z");
  const fetched = status.bindings.map(row => row.lastFetchedAt);
  clock.set(new Date("2026-10-25T13:00:00Z"));
  assert.deepEqual(await runAssetFundCycle({ stateDir, now: clock.read(), clock: clock.read, fetchImpl: async () => { clock.tick(1000); throw Error("private source error"); } }), { attempted: 2, applied: 0, failed: 2 });
  status = await readAssetFundStatus({ stateDir }); assert.deepEqual(status.bindings.map(row => row.lastAppliedAt), applied); assert.deepEqual(status.bindings.map(row => row.lastFetchedAt), fetched);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), ledger);
});

test("direct stock quote retrieval records completion rather than its input start Date", async () => {
  const clock = time(), fields = Array(73).fill("");
  Object.assign(fields, { 0: "200", 1: "SpaceX", 2: "SPCX.OQ", 3: "147.49", 30: "2026-10-23 16:00:01", 35: "USD", 46: "Space Exploration Technologies Corp.", 56: "GP" });
  const quote = await fetchAssetHoldingQuote({ symbol: "usSPCX", now: at, clock: clock.read, fetchImpl: async () => { clock.tick(4000); return new Response(`v_usSPCX="${fields.join("~")}";`); } });
  assert.equal(quote.fetchedAt, "2026-10-24T12:00:04.000Z"); assert.equal(quote.sourceTime, "2026-10-23 16:00:01"); assert.equal(quote.observedAt, null);
});
