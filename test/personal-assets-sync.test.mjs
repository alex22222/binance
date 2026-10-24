import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyPortfolio, summarize } from "../src/personal-assets-core.mjs";
import { readPersonalAssets, savePersonalAssets } from "../src/personal-assets.mjs";
import { performAssetSyncAction, completeFutuAuthorization, readAssetSyncStatus, runAssetSyncCycle } from "../src/personal-assets-sync.mjs";

process.env.PERSONAL_ASSETS_FX_DISABLED = "1";

const at = new Date("2026-10-24T12:00:00Z");
const later = new Date("2026-10-24T13:00:00Z");
const credentials = { apiKey: "synthetic-key", secret: "synthetic-secret", passphrase: "synthetic-passphrase", region: "global" };
const synthetic = (overrides = {}) => ({ provider: "okx", currency: "USD", total: 100, asOf: "2026-10-24", fetchedAt: at.toISOString(), accountLabel: "Synthetic OKX", externalAccountId: "12345", breakdownComplete: true,
  holdings: [{ externalId: "one", name: "Synthetic asset", category: "加密资产", currency: "USD", amount: 100, quantity: "0.01" }], coverage: ["Synthetic scope"], warnings: [], ...overrides });
const api = { fetchOkxAssets: async () => synthetic() };
const privateFile = (stateDir) => join(stateDir, "personal-assets-sync.json");

async function fixture(context) {
  const stateDir = await mkdtemp(join(tmpdir(), "asset-readonly-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const portfolio = emptyPortfolio();
  portfolio.accounts.push({ id: "okx-exchange", platform: "OKX", name: "Existing canonical exchange", basis: "total" });
  portfolio.accounts.push({ id: "other", platform: "OKX", name: "Web3 stays separate", basis: "total" });
  portfolio.entries.push({ id: "other-total", accountId: "other", kind: "total", name: "Synthetic existing", currency: "CNY", category: "现金", amount: 7, source: "manual", asOf: "2026-10-24" });
  await savePersonalAssets({ stateDir, portfolio, revision: 0 });
  return stateDir;
}
const action = (stateDir, provider, name, body = {}, options = {}) => performAssetSyncAction({ stateDir, provider, action: name, body, api, now: at, ...options });
async function connected(stateDir, options = {}) {
  const result = await action(stateDir, "okx", "connect", { ...credentials, targetAccountId: "okx-exchange" }, options);
  return result.providers.okx.preview;
}
async function enabled(stateDir) {
  const preview = await connected(stateDir);
  return action(stateDir, "okx", "apply", { previewId: preview.id, revision: preview.revision });
}

test("automatic collectors skip intra-slot requests and refresh at the next Beijing calendar slot", async context => {
  const stateDir = await fixture(context);
  await enabled(stateDir);
  let calls = 0;
  const source = { fetchOkxAssets: async () => { calls++; return synthetic({ fetchedAt: later.toISOString() }); } };
  assert.deepEqual(await runAssetSyncCycle({ stateDir, now: new Date("2026-10-24T12:16:00Z"), api: source }), { attempted: 0, applied: 0, failed: 0 });
  assert.equal(calls, 0);
  assert.deepEqual(await runAssetSyncCycle({ stateDir, now: later, api: source }), { attempted: 1, applied: 1, failed: 0 });
  assert.deepEqual(await runAssetSyncCycle({ stateDir, now: new Date("2026-10-24T13:16:00Z"), api: source }), { attempted: 0, applied: 0, failed: 0 });
  const status = await readAssetSyncStatus({ stateDir, now: later });
  assert.equal(status.providers.okx.dueAt, "2026-10-25T01:00:00.000Z");
  assert.equal(status.intervalMinutes, 720);
  assert.equal(calls, 1);
});

test("explicit account binding replaces the existing same exchange instead of duplicating its balance", async (context) => {
  const stateDir = await fixture(context);
  const current = await readPersonalAssets({ stateDir });
  current.portfolio.accounts.push({ id: "existing-exchange", platform: "OKX", name: "Existing exchange", basis: "total" });
  current.portfolio.entries.push({ id: "existing-total", accountId: "existing-exchange", kind: "total", name: "Synthetic existing exchange", category: "组合资产", currency: "USD", amount: 100, asOf: "2026-10-24", source: "manual" });
  current.portfolio.rates.USD = { value: 7, date: "2026-10-24" };
  await savePersonalAssets({ stateDir, portfolio: current.portfolio, revision: current.revision });
  const preview = (await action(stateDir, "okx", "connect", { ...credentials, targetAccountId: "existing-exchange" })).providers.okx.preview;
  assert.equal(preview.targetAccountId, "existing-exchange");
  const result = await action(stateDir, "okx", "apply", { previewId: preview.id, revision: preview.revision });
  assert.equal(summarize(result.assets.portfolio).total, 707);
  assert.equal(result.assets.portfolio.entries.some((row) => row.accountId === "okx-exchange"), false);
  assert.equal(result.assets.portfolio.entries.find((row) => row.accountId === "existing-exchange").source, "api");
  assert.equal(result.sync.providers.okx.targetAccountId, "existing-exchange");
  const cycle = await runAssetSyncCycle({ stateDir, now: later, api: { fetchOkxAssets: async () => synthetic({ total: 120, holdings: [], fetchedAt: later.toISOString() }) } });
  assert.deepEqual(cycle, { attempted: 1, applied: 1, failed: 0 });
  const latest = await readPersonalAssets({ stateDir });
  assert.equal(latest.portfolio.entries.find((row) => row.accountId === "existing-exchange").amount, 120);
  assert.equal(latest.portfolio.entries.some((row) => row.accountId === "okx-exchange"), false);
  assert.equal(latest.portfolio.entries.find((row) => row.id === "other-total").amount, 7);
});

test("implicit new bindings and invalid target platforms fail before importing duplicate assets", async (context) => {
  const stateDir = await fixture(context);
  const current = await readPersonalAssets({ stateDir });
  current.portfolio.accounts = current.portfolio.accounts.filter((account) => account.id !== "okx-exchange");
  await savePersonalAssets({ stateDir, portfolio: current.portfolio, revision: current.revision });
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  await assert.rejects(action(stateDir, "okx", "connect", credentials), { statusCode: 409 });
  for (const targetAccountId of ["account-1", "nonexistent", "", 1]) {
    await assert.rejects(action(stateDir, "okx", "connect", { ...credentials, targetAccountId }), /目标|平台/);
  }
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  await assert.rejects(readFile(privateFile(stateDir)), { code: "ENOENT" });
});

test("an empty canonical account cannot silently receive a duplicate of another existing account", async (context) => {
  const stateDir = await fixture(context);
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  await assert.rejects(action(stateDir, "okx", "connect", credentials), /明确选择/);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
});

test("an OKX Web3 account cannot become the default exchange target", async (context) => {
  const stateDir = await fixture(context);
  const current = await readPersonalAssets({ stateDir });
  current.portfolio.accounts.find((account) => account.id === "okx-exchange").name = "OKX Web3 钱包";
  await savePersonalAssets({ stateDir, portfolio: current.portfolio, revision: current.revision });
  await assert.rejects(action(stateDir, "okx", "connect", credentials), /Web3/);
});

test("explicit OKX exchange requests cannot overwrite a Web3 wallet target", async (context) => {
  const stateDir = await fixture(context);
  let calls = 0;
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  await assert.rejects(action(stateDir, "okx", "connect", { ...credentials, targetAccountId: "other" }, { api: { fetchOkxAssets: async () => { calls += 1; return synthetic(); } } }), /Web3|钱包/);
  await writeFile(privateFile(stateDir), JSON.stringify({ schemaVersion: 1, providers: { okxweb3: { targetAccountId: "account-5", wallets: [{ chainIndex: "1", address: `0x${"ab".repeat(20)}` }] } } }), { mode: 0o600 });
  await assert.rejects(action(stateDir, "okx", "connect", { ...credentials, targetAccountId: "account-5" }, { api: { fetchOkxAssets: async () => { calls += 1; return synthetic(); } } }), /Web3|钱包/);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
});

test("applied account bindings cannot be moved silently and unexpected external IDs pause collection", async (context) => {
  const stateDir = await fixture(context);
  await enabled(stateDir);
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  await assert.rejects(action(stateDir, "okx", "preview", { targetAccountId: "account-5" }), /绑定/);
  await assert.rejects(action(stateDir, "okx", "connect", credentials, { api: { fetchOkxAssets: async () => synthetic({ externalAccountId: "different" }) } }), /真实账户/);
  const cycle = await runAssetSyncCycle({ stateDir, now: later, api: { fetchOkxAssets: async () => synthetic({ externalAccountId: "different", fetchedAt: later.toISOString() }) } });
  assert.deepEqual(cycle, { attempted: 1, applied: 0, failed: 1 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  const status = await readAssetSyncStatus({ stateDir, now: later });
  assert.equal(status.providers.okx.enabled, false);
  assert.equal(status.providers.okx.lastAttemptAt, later.toISOString());
});

test("source observation time and overdue status distinguish current reads from frozen asset dates", async (context) => {
  const stateDir = await fixture(context);
  const observedAt = new Date(at.getTime() - 60_000).toISOString();
  const preview = await connected(stateDir, { api: { fetchOkxAssets: async () => synthetic({ observedAt, timeBasis: "source" }) } });
  const result = await action(stateDir, "okx", "apply", { previewId: preview.id, revision: preview.revision });
  const row = result.assets.portfolio.entries.find((entry) => entry.id === "sync-okx-total");
  assert.equal(row.asOfBasis, "statement");
  assert.match(row.note, new RegExp(observedAt.replaceAll(".", "\\.")));
  const status = (await readAssetSyncStatus({ stateDir, now: new Date(at.getTime() + 13 * 60 * 60_000 + 60_000) })).providers.okx;
  assert.equal(status.observedAt, observedAt);
  assert.equal(status.timeBasis, "source");
  assert.equal(status.lastAttemptAt, at.toISOString());
  assert.equal(status.dueAt, "2026-10-24T13:00:00.000Z");
  assert.equal(status.overdue, true);
});

const publicAddress = `0x${"ab".repeat(20)}`;
const polygonWallet = [{ chainIndex: "137", address: publicAddress }];
const walletId = (wallets) => `wallets:${createHash("sha256").update(wallets.map((wallet) => `${wallet.chainIndex}:${wallet.chainIndex === "501" ? wallet.address : wallet.address.toLowerCase()}`).sort().join("|")).digest("hex")}`;
const walletApi = (overrides = {}, inspect = () => {}) => ({ fetchWalletAssets: async (options) => {
  inspect(options);
  return synthetic({ provider: options.provider, externalAccountId: walletId(options.wallets), valuationComplete: true, unpricedAssets: [],
    holdings: [{ externalId: "wallet-native", name: "POL（Polygon）", symbol: "POL", category: "加密资产", currency: "USD", amount: 100, quantity: "1.000000000000000001", rawQuantity: "1.000000000000000001" }], ...overrides });
} });
const unpriced = { chainIndex: "137", contract: `0x${"cd".repeat(20)}`, symbol: "UNKNOWN", name: "Synthetic unknown token", quantity: "123.000000000000000001", reason: "缺少已核实报价", secret: "must-not-escape" };
async function tokenPocketTarget(stateDir) { return (await readPersonalAssets({ stateDir })).portfolio.accounts.find((account) => account.platform === "TokenPocket").id; }

test("wallet public binding makes no external request and never treats an address as authorization", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = await tokenPocketTarget(stateDir);
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  let calls = 0;
  const options = { api: walletApi({}, () => { calls += 1; }) };
  const bound = await action(stateDir, "tokenpocket", "bind", { wallets: [{ chainIndex: "137", address: publicAddress.toUpperCase().replace("0X", "0x") }], targetAccountId }, options);
  assert.equal(calls, 0);
  assert.equal(bound.providers.tokenpocket.connected, false);
  assert.equal(bound.providers.tokenpocket.enabled, false);
  assert.deepEqual(bound.providers.tokenpocket.wallets, polygonWallet);
  assert.equal(bound.providers.tokenpocket.targetAccountId, targetAccountId);
  await assert.rejects(action(stateDir, "tokenpocket", "bind", { wallets: polygonWallet, targetAccountId, apiKey: "forbidden-on-bind" }, options), /凭据|密钥/);
  await assert.rejects(action(stateDir, "tokenpocket", "preview", {}, options), /Developer|开发者/);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  assert.doesNotMatch(await readFile(privateFile(stateDir), "utf8"), /forbidden-on-bind/);
});

test("wallet connect requires an explicit proper target and preserves partial valuation with exact quantities", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = await tokenPocketTarget(stateDir);
  let calls = 0;
  const options = { api: walletApi({ valuationComplete: false, unpricedAssets: [unpriced], coverage: ["Native and token scope"], warnings: ["NFT and protocols excluded"] }, (request) => {
    calls += 1;
    assert.deepEqual(request.credentials, { apiKey: credentials.apiKey, secret: credentials.secret, passphrase: credentials.passphrase });
    assert.deepEqual(request.wallets, polygonWallet);
  }) };
  await assert.rejects(action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet }, options), /明确选择/);
  await assert.rejects(action(stateDir, "okxweb3", "connect", { ...credentials, wallets: polygonWallet, targetAccountId: "okx-exchange" }, options), /交易所|Web3|钱包/);
  assert.equal(calls, 0);
  const state = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, options);
  const preview = state.providers.tokenpocket.preview;
  assert.equal(preview.valuationComplete, false);
  assert.equal(preview.countedBasis, "holdings");
  assert.equal(preview.unpricedAssets[0].quantity, unpriced.quantity);
  assert.equal(preview.unpricedAssets[0].secret, undefined);
  assert.equal(preview.holdings[0].rawQuantity, "1.000000000000000001");
  assert.doesNotMatch(JSON.stringify(state), /synthetic-key|synthetic-secret|synthetic-passphrase|must-not-escape/);
  const applied = await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision }, options);
  const account = applied.assets.portfolio.accounts.find((account) => account.id === targetAccountId);
  assert.equal(account.basis, "holdings");
  assert.match(account.note, /仅已定价部分.*1项未估值.*NFT/);
  const holding = applied.assets.portfolio.entries.find((row) => row.accountId === targetAccountId && row.kind === "holding");
  assert.match(holding.note, /1\.000000000000000001.*POL/);
  const reference = applied.assets.portfolio.entries.find((row) => row.accountId === targetAccountId && row.kind === "total");
  assert.equal(reference.name, "只读 API · 已定价资产小计");
  assert.match(reference.note, /未估值资产及未核实协议未加入/);
  assert.doesNotMatch(reference.note, /平台净资产口径/);
  assert.equal(applied.assets.portfolio.entries.some((row) => row.name === unpriced.name), false);
  assert.equal(applied.sync.providers.tokenpocket.lastValuationComplete, false);
  assert.equal(applied.sync.providers.tokenpocket.lastUnpricedAssets[0].quantity, unpriced.quantity);
  assert.deepEqual(applied.sync.providers.tokenpocket.lastCoverage, ["Native and token scope"]);
  const file = await readFile(privateFile(stateDir), "utf8");
  assert.match(file, /synthetic-key/);
  assert.equal((await stat(privateFile(stateDir))).mode & 0o777, 0o600);
  const beforeFailure = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const failure = await runAssetSyncCycle({ stateDir, now: later, api: { fetchWalletAssets: async () => { throw new Error("private upstream credential"); } } });
  assert.deepEqual(failure, { attempted: 1, applied: 0, failed: 1 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), beforeFailure);
  assert.doesNotMatch(JSON.stringify(await readAssetSyncStatus({ stateDir })), /private upstream credential/);
  const cycle = await runAssetSyncCycle({ stateDir, now: later, api: walletApi({ fetchedAt: later.toISOString() }) });
  assert.deepEqual(cycle, { attempted: 1, applied: 1, failed: 0 });
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.tokenpocket.lastValuationComplete, true);
});

test("agentic wallets reuse only the saved developer credential reference and retain independent account sources", async context => {
  for (const [provider, platform, chainIndex] of [["binanceagentic", "币安Agentic Wallet", "56"], ["okxagentic", "OKX Agentic Wallet", "196"]]) {
    const stateDir = await fixture(context); const current = await readPersonalAssets({ stateDir });
    const targetAccountId = current.portfolio.accounts.find(row=>row.platform===platform).id;
    const wallets = [{ chainIndex, address: publicAddress }]; let calls = 0;
    const options = { api: walletApi({}, request=>{calls++;assert.equal(request.credentials.apiKey,credentials.apiKey);}) };
    await assert.rejects(action(stateDir,provider,"connect",{wallets,targetAccountId,useExistingCredentials:true},options),/Developer|开发者|凭据/);assert.equal(calls,0);
    await action(stateDir,"okxweb3","connect",{...credentials,wallets:[{chainIndex:"1",address:publicAddress}],targetAccountId:"other"},{api:walletApi()});
    assert.equal((await readAssetSyncStatus({stateDir})).developerCredentialsAvailable,true);
    for (const extra of [{useExistingCredentials:"true"},{useExistingCredentials:true,apiKey:"unexpected-secret"}]) await assert.rejects(action(stateDir,provider,"connect",{wallets,targetAccountId,...extra},options));
    const connected=await action(stateDir,provider,"connect",{wallets,targetAccountId,useExistingCredentials:true},options);const preview=connected.providers[provider].preview;
    assert.equal(connected.providers[provider].usesExistingCredentials,true);assert.equal(connected.providers[provider].connected,true);assert.equal(calls,1);
    assert.doesNotMatch(JSON.stringify(connected),/synthetic-key|synthetic-secret|synthetic-passphrase|unexpected-secret/);
    const stored=JSON.parse(await readFile(privateFile(stateDir),"utf8"));assert.equal(stored.providers[provider].credentialRef,"okxweb3");assert.equal(stored.providers[provider].credentials,undefined);
    const applied=await action(stateDir,provider,"apply",{previewId:preview.id,revision:preview.revision});assert.equal(applied.sync.providers[provider].enabled,true);
    assert.equal(applied.assets.portfolio.accounts.find(row=>row.id===targetAccountId).platform,platform);
    assert.equal(applied.assets.portfolio.entries.find(row=>row.id==="other-total").amount,7);
    const cycle=await runAssetSyncCycle({stateDir,now:later,api:walletApi({fetchedAt:later.toISOString()},request=>assert.equal(request.credentials.secret,credentials.secret))});assert.deepEqual(cycle,{attempted:1,applied:1,failed:0});
    await action(stateDir,"okxweb3","disconnect");assert.equal((await readAssetSyncStatus({stateDir})).providers[provider].connected,false);
    const before=await readFile(join(stateDir,"personal-assets.json"),"utf8");const failed=await runAssetSyncCycle({stateDir,now:new Date("2026-10-25T01:00:00Z"),api:walletApi()});assert.deepEqual(failed,{attempted:1,applied:0,failed:1});assert.equal(await readFile(join(stateDir,"personal-assets.json"),"utf8"),before);
    await action(stateDir,provider,"disconnect");const disconnected=JSON.parse(await readFile(privateFile(stateDir),"utf8"));assert.equal(disconnected.providers[provider].credentialRef,undefined);
  }
});

test("agentic bindings cannot reuse another platform's counted wallet or implicit targets", async context => {
  const stateDir=await fixture(context);const current=await readPersonalAssets({stateDir});const targetAccountId=current.portfolio.accounts.find(row=>row.platform==="OKX Agentic Wallet").id;
  await action(stateDir,"okxweb3","connect",{...credentials,wallets:polygonWallet,targetAccountId:"other"},{api:walletApi()});
  await assert.rejects(action(stateDir,"okxagentic","bind",{wallets:polygonWallet,targetAccountId}),{statusCode:409});
  await assert.rejects(action(stateDir,"okxagentic","bind",{wallets:[{chainIndex:"196",address:publicAddress}]}),/明确选择/);
  await assert.rejects(action(stateDir,"okxagentic","bind",{wallets:[{chainIndex:"196",address:publicAddress}],targetAccountId:"okx-exchange"}),/平台/);
});

test("all unpriced wallets create no false zero valuation while verified empty wallets can record zero", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = await tokenPocketTarget(stateDir);
  for (const valuationComplete of [false, true]) {
    const state = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, { api: walletApi({ total: 0, holdings: [], valuationComplete, unpricedAssets: valuationComplete ? [] : [unpriced] }) });
    const preview = state.providers.tokenpocket.preview;
    const applied = await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
    const rows = applied.assets.portfolio.entries.filter((row) => row.accountId === targetAccountId);
    assert.equal(rows.length, valuationComplete ? 1 : 0);
    assert.equal(applied.assets.portfolio.accounts.find((account) => account.id === targetAccountId).basis, valuationComplete ? "total" : "holdings");
    assert.equal(applied.sync.providers.tokenpocket.lastValuationComplete, valuationComplete);
    if (valuationComplete) assert.equal(rows[0].amount, 0);
  }
});

test("disconnect removes wallet credentials but preserves applied missing valuations and their provenance", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = await tokenPocketTarget(stateDir);
  const connected = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, { api: walletApi({ total: 0, holdings: [], valuationComplete: false, unpricedAssets: [unpriced], coverage: ["Retained scope"], warnings: ["Retained missing price"] }) });
  const preview = connected.providers.tokenpocket.preview;
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const disconnected = (await action(stateDir, "tokenpocket", "disconnect")).providers.tokenpocket;
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.enabled, false);
  assert.equal(disconnected.preview, undefined);
  assert.equal(disconnected.lastAppliedAt, at.toISOString());
  assert.equal(disconnected.lastValuationComplete, false);
  assert.equal(disconnected.lastUnpricedAssets[0].quantity, unpriced.quantity);
  assert.deepEqual(disconnected.lastCoverage, ["Retained scope"]);
  assert.deepEqual(disconnected.lastWarnings, ["Retained missing price"]);
  assert.deepEqual(disconnected.wallets, polygonWallet);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  assert.doesNotMatch(await readFile(privateFile(stateDir), "utf8"), /synthetic-key|synthetic-secret|synthetic-passphrase/);
});

test("wallet chains and source identity are validated before queries and cannot duplicate across providers", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = await tokenPocketTarget(stateDir);
  for (const wallets of [[], [{ chainIndex: "9999", address: publicAddress }], [{ chainIndex: "137", address: "bad" }], [{ chainIndex: "501", address: "0".repeat(44) }], [polygonWallet[0], { ...polygonWallet[0], address: publicAddress.toUpperCase().replace("0X", "0x") }]]) {
    await assert.rejects(action(stateDir, "tokenpocket", "bind", { wallets, targetAccountId }), /地址|链|重复|钱包/);
  }
  const connected = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, { api: walletApi() });
  await assert.rejects(action(stateDir, "okxweb3", "bind", { wallets: polygonWallet, targetAccountId: "other" }), { statusCode: 409 });
  const preview = connected.providers.tokenpocket.preview;
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  await action(stateDir, "tokenpocket", "disconnect");
  await assert.rejects(action(stateDir, "okxweb3", "bind", { wallets: polygonWallet, targetAccountId: "other" }), { statusCode: 409 });
  const differentChain = await action(stateDir, "okxweb3", "bind", { wallets: [{ chainIndex: "1", address: publicAddress }], targetAccountId: "other" });
  assert.equal(differentChain.providers.okxweb3.connected, false);
});

test("overlapping wallet subsets are rejected even when their overall source hashes differ", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = await tokenPocketTarget(stateDir);
  const wallets = [{ chainIndex: "1", address: publicAddress }, ...polygonWallet, { chainIndex: "501", address: "11111111111111111111111111111112" }];
  assert.notEqual(walletId(wallets), walletId(polygonWallet));
  const connected = await action(stateDir, "okxweb3", "connect", { ...credentials, wallets, targetAccountId: "other" }, { api: walletApi() });
  await assert.rejects(action(stateDir, "tokenpocket", "bind", { wallets: polygonWallet, targetAccountId }), { statusCode: 409 });
  const preview = connected.providers.okxweb3.preview;
  await action(stateDir, "okxweb3", "apply", { previewId: preview.id, revision: preview.revision });
  await action(stateDir, "okxweb3", "disconnect");
  await assert.rejects(action(stateDir, "tokenpocket", "bind", { wallets: polygonWallet, targetAccountId }), { statusCode: 409 });
});

test("wallet preview reads only saved bindings and changing addresses pauses until explicit apply", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = await tokenPocketTarget(stateDir);
  const first = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, { api: walletApi() });
  let preview = first.providers.tokenpocket.preview;
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const changedWallets = [{ chainIndex: "137", address: `0x${"ef".repeat(20)}` }];
  let queried;
  const saved = await action(stateDir, "tokenpocket", "preview", { wallets: changedWallets }, { api: walletApi({}, (request) => { queried = request.wallets; }) });
  assert.deepEqual(queried, polygonWallet);
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const bound = await action(stateDir, "tokenpocket", "bind", { wallets: changedWallets, targetAccountId });
  assert.equal(bound.providers.tokenpocket.enabled, false);
  assert.equal(bound.providers.tokenpocket.preview, undefined);
  await assert.rejects(action(stateDir, "tokenpocket", "apply", { previewId: saved.providers.tokenpocket.preview.id, revision: saved.providers.tokenpocket.preview.revision }), { statusCode: 409 });
  assert.deepEqual(await runAssetSyncCycle({ stateDir, now: later, api: walletApi() }), { attempted: 0, applied: 0, failed: 0 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  const next = await action(stateDir, "tokenpocket", "preview", {}, { api: walletApi() });
  preview = next.providers.tokenpocket.preview;
  assert.equal(preview.externalAccountId, walletId(changedWallets));
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.tokenpocket.enabled, true);
});

test("invalid partial wallet valuations or substituted sources never reach the ledger", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = await tokenPocketTarget(stateDir);
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  for (const invalid of [{ valuationComplete: "false" }, { unpricedAssets: [{ ...unpriced, quantity: "NaN" }] }, { valuationComplete: true, unpricedAssets: [unpriced] }, { holdings: [], total: 100 }, { externalAccountId: "wallets:wrong" }, { holdings: [{ externalId: "bad", name: "ETH", category: "加密资产", currency: "USD", amount: 100, rawQuantity: "Infinity" }] }]) {
    await assert.rejects(action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, { api: walletApi(invalid) }), { statusCode: 502 });
  }
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
});

test("wallet source freshness clock advances across the network call", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = await tokenPocketTarget(stateDir);
  let elapsed;
  await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, { api: { fetchWalletAssets: async (options) => {
    const first = options.now().getTime();
    await new Promise((resolve) => setTimeout(resolve, 20));
    elapsed = options.now().getTime() - first;
    return walletApi().fetchWalletAssets(options);
  } } });
  assert.ok(elapsed >= 10, `source clock advanced ${elapsed}ms`);
});

const tokenExternalId = `token:${createHash("sha256").update(`137:${publicAddress}:${unpriced.contract}`).digest("hex")}`;
const quotedHolding = { externalId: tokenExternalId, name: "ZERO", symbol: "ZERO", category: "加密资产", currency: "USD", amount: 0.07,
  rawQuantity: "309.248658", quoteSource: "Jupiter Price V3", quoteObservedAt: "2026-10-24T11:59:00.000Z" };

test("wallet quote metadata survives preview and apply without claiming a balance observation time", async context => {
  const stateDir = await fixture(context); const targetAccountId = await tokenPocketTarget(stateDir);
  const options = { api: walletApi({ total: 0.07, holdings: [quotedHolding] }) };
  const connected = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, options);
  const preview = connected.providers.tokenpocket.preview;
  assert.equal(preview.holdings[0].quoteSource, quotedHolding.quoteSource);
  assert.equal(preview.holdings[0].quoteObservedAt, quotedHolding.quoteObservedAt);
  assert.equal(preview.observedAt, null); assert.equal(preview.timeBasis, "retrieved");
  const applied = await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const row = applied.assets.portfolio.entries.find(item => item.accountId === targetAccountId && item.kind === "holding");
  assert.equal(row.asOfBasis, "imported");
  assert.match(row.note, /源未提供精确资产时点/);
  assert.match(row.note, /价格来源 Jupiter Price V3.*价格时点 2026-10-24T11:59:00.000Z.*不代表余额时点/);
  assert.equal(applied.sync.providers.tokenpocket.observedAt, null);
});

test("wallet quote metadata validates the pair and age against the completed fetch clock", async context => {
  const stateDir = await fixture(context); const targetAccountId = await tokenPocketTarget(stateDir);
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  for (const metadata of [{ quoteSource: undefined }, { quoteObservedAt: undefined }, { quoteSource: "" }, { quoteSource: "bad\nsource" },
    { quoteObservedAt: "invalid" }, { quoteObservedAt: "2026-10-24" }, { quoteObservedAt: "2026-10-24T11:54:59.999Z" }, { quoteObservedAt: "2026-10-24T12:00:10.001Z" }]) {
    await assert.rejects(action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId },
      { api: walletApi({ total: 0.07, holdings: [{ ...quotedHolding, ...metadata }] }) }), { statusCode: 502 });
  }
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  const fresh = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId },
    { api: walletApi({ total: 0.07, fetchedAt: "2026-10-24T12:00:30.000Z", holdings: [{ ...quotedHolding, quoteObservedAt: "2026-10-24T12:00:25.000Z" }] }) });
  assert.equal(fresh.providers.tokenpocket.preview.holdings[0].quoteObservedAt, "2026-10-24T12:00:25.000Z");
});

test("a formerly priced wallet token becoming unpriced retains the entire last valid ledger and source success time", async context => {
  const stateDir = await fixture(context); const targetAccountId = await tokenPocketTarget(stateDir);
  const native = (await walletApi().fetchWalletAssets({ provider: "tokenpocket", wallets: polygonWallet })).holdings[0];
  // Index one deliberately exercises IDs already written before unpriced identity metadata existed.
  const connected = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId },
    { api: walletApi({ total: 100.07, holdings: [native, quotedHolding] }) });
  const preview = connected.providers.tokenpocket.preview;
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const lastGood = (await readAssetSyncStatus({ stateDir })).providers.tokenpocket;
  const missing = { ...unpriced, externalId: tokenExternalId };
  const options = { api: walletApi({ fetchedAt: later.toISOString(), valuationComplete: false, unpricedAssets: [missing] }), now: later };
  assert.deepEqual(await runAssetSyncCycle({ stateDir, ...options }), { attempted: 1, applied: 0, failed: 1 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  const status = (await readAssetSyncStatus({ stateDir })).providers.tokenpocket;
  assert.equal(status.lastFetchedAt, lastGood.lastFetchedAt); assert.equal(status.lastAppliedAt, lastGood.lastAppliedAt);
  assert.equal(status.lastAttemptAt, later.toISOString()); assert.equal(status.enabled, true); assert.ok(status.lastError);
  await assert.rejects(action(stateDir, "tokenpocket", "preview", {}, options), /保留上次有效估值/);
  await assert.rejects(action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, options), /保留上次有效估值/);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
});

test("unpriced token identity is bounded and does not confuse new holdings or sold-out tokens with quote loss", async context => {
  const stateDir = await fixture(context); const targetAccountId = await tokenPocketTarget(stateDir);
  for (const externalId of ["token:bad", `token:${"a".repeat(65)}`, 123, null]) await assert.rejects(action(stateDir, "tokenpocket", "connect",
    { ...credentials, wallets: polygonWallet, targetAccountId }, { api: walletApi({ valuationComplete: false, unpricedAssets: [{ ...unpriced, externalId }] }) }), { statusCode: 502 });
  const options = { api: walletApi({ total: 0.07, holdings: [quotedHolding] }) };
  const connected = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, options);
  const preview = connected.providers.tokenpocket.preview;
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const newIdentity = `token:${"b".repeat(64)}`;
  const updated = await action(stateDir, "tokenpocket", "preview", {}, { api: walletApi({ fetchedAt: later.toISOString(), total: 0, holdings: [], valuationComplete: false,
    unpricedAssets: [{ ...unpriced, symbol: "ZERO", externalId: newIdentity }] }), now: later });
  assert.equal(updated.providers.tokenpocket.preview.unpricedAssets[0].externalId, newIdentity);
  const empty = await action(stateDir, "tokenpocket", "preview", {}, { api: walletApi({ fetchedAt: later.toISOString(), total: 0, holdings: [], unpricedAssets: [], valuationComplete: true }), now: later });
  const next = empty.providers.tokenpocket.preview;
  const applied = await action(stateDir, "tokenpocket", "apply", { previewId: next.id, revision: next.revision }, { now: later });
  assert.equal(applied.assets.portfolio.entries.filter(row => row.accountId === targetAccountId).length, 1);
  assert.equal(applied.assets.portfolio.entries.find(row => row.accountId === targetAccountId).amount, 0);
});

test("wallet apply rechecks unpriced identities before creating any backup or snapshot", async context => {
  const stateDir = await fixture(context); const targetAccountId = await tokenPocketTarget(stateDir);
  const connected = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId },
    { api: walletApi({ total: 0.07, holdings: [quotedHolding] }) });
  const preview = connected.providers.tokenpocket.preview;
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const next = await action(stateDir, "tokenpocket", "preview", {}, { api: walletApi({ total: 0, holdings: [], valuationComplete: false, unpricedAssets: [unpriced] }) });
  const stored = JSON.parse(await readFile(privateFile(stateDir), "utf8"));
  stored.providers.tokenpocket.preview.unpricedAssets[0].externalId = tokenExternalId;
  await writeFile(privateFile(stateDir), JSON.stringify(stored), { mode: 0o600 });
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const backup = await readFile(join(stateDir, "personal-assets-sync-tokenpocket-previous.json"), "utf8");
  const current = next.providers.tokenpocket.preview;
  await assert.rejects(action(stateDir, "tokenpocket", "apply", { previewId: current.id, revision: current.revision }), /保留上次有效估值/);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  assert.equal(await readFile(join(stateDir, "personal-assets-sync-tokenpocket-previous.json"), "utf8"), backup);
});

function predictionApi(overrides = {}) {
  return { ...api, fetchPolymarketAssets: async ({ address }) => synthetic({ provider: "polymarket", externalAccountId: address, observedAt: null, timeBasis: "retrieved", ...overrides }) };
}

test("Polymarket binds an explicitly selected existing account, normalizes address case and retains dates honestly", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = (await readPersonalAssets({ stateDir })).portfolio.accounts.find((account) => account.platform === "Polymarket").id;
  await assert.rejects(action(stateDir, "polymarket", "connect", { address: publicAddress }), /明确选择/);
  const first = await action(stateDir, "polymarket", "connect", { address: `0x${"AB".repeat(20)}`, targetAccountId }, { api: predictionApi() });
  const repeated = await action(stateDir, "polymarket", "connect", { address: publicAddress, targetAccountId }, { api: predictionApi() });
  assert.equal(first.providers.polymarket.connected, true);
  assert.equal(repeated.providers.polymarket.preview.targetAccountId, targetAccountId);
  const preview = repeated.providers.polymarket.preview;
  assert.equal(preview.externalAccountId, publicAddress);
  const result = await action(stateDir, "polymarket", "apply", { previewId: preview.id, revision: preview.revision }, { api: predictionApi() });
  assert.equal(result.sync.providers.polymarket.enabled, true);
  assert.equal(result.assets.portfolio.entries.find((entry) => entry.accountId === targetAccountId).asOfBasis, "imported");
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const failed = await runAssetSyncCycle({ stateDir, now: later, api: { fetchPolymarketAssets: async () => { throw new Error("SENSITIVE UPSTREAM"); } } });
  assert.deepEqual(failed, { attempted: 1, applied: 0, failed: 1 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  assert.doesNotMatch(JSON.stringify(await readAssetSyncStatus({ stateDir })), /SENSITIVE/);
  const succeeded = await runAssetSyncCycle({ stateDir, now: later, api: predictionApi({ total: 120, holdings: [], fetchedAt: later.toISOString() }) });
  assert.deepEqual(succeeded, { attempted: 1, applied: 1, failed: 0 });
  assert.equal((await readPersonalAssets({ stateDir })).portfolio.entries.find((entry) => entry.accountId === targetAccountId).amount, 120);
  await action(stateDir, "polymarket", "disconnect");
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.polymarket.connected, false);
});

test("Polymarket only creates its canonical target when no same-platform account exists and the target is explicit", async (context) => {
  const stateDir = await fixture(context);
  const current = await readPersonalAssets({ stateDir });
  current.portfolio.accounts = current.portfolio.accounts.filter((account) => account.platform !== "Polymarket");
  await savePersonalAssets({ stateDir, portfolio: current.portfolio, revision: current.revision });
  await assert.rejects(action(stateDir, "polymarket", "connect", { address: publicAddress }, { api: predictionApi() }), /明确选择/);
  const state = await action(stateDir, "polymarket", "connect", { address: publicAddress, targetAccountId: "polymarket-main" }, { api: predictionApi() });
  assert.equal(state.providers.polymarket.preview.targetAccountId, "polymarket-main");
  const preview = state.providers.polymarket.preview;
  const result = await action(stateDir, "polymarket", "apply", { previewId: preview.id, revision: preview.revision }, { api: predictionApi() });
  assert.equal(result.assets.portfolio.accounts.find((account) => account.id === "polymarket-main").platform, "Polymarket");
});

test("Future reuses the verified Polygon reader with explicit targets and excludes pending Solana deposits", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = (await readPersonalAssets({ stateDir })).portfolio.accounts.find((account) => account.platform === "Future").id;
  const result = await action(stateDir, "future", "connect", { address: publicAddress, targetAccountId }, { api: predictionApi() });
  const preview = result.providers.future.preview;
  assert.equal(preview.provider, "future");
  assert.match(preview.accountLabel, /Future.*Polygon/);
  assert.match(preview.coverage.join(" "), /Polymarket/);
  assert.match(preview.warnings.join(" "), /未到账.*Solana|Solana.*未到账/);
  const applied = await action(stateDir, "future", "apply", { previewId: preview.id, revision: preview.revision }, { api: predictionApi() });
  assert.equal(applied.assets.portfolio.accounts.find((account) => account.id === targetAccountId).platform, "Future");
  const cycle = await runAssetSyncCycle({ stateDir, now: later, api: predictionApi({ fetchedAt: later.toISOString() }) });
  assert.deepEqual(cycle, { attempted: 1, applied: 1, failed: 0 });
});

test("one Polygon source cannot be counted through both Polymarket and Future even after disconnect", async (context) => {
  const stateDir = await fixture(context);
  const current = await readPersonalAssets({ stateDir });
  const pmTarget = current.portfolio.accounts.find((account) => account.platform === "Polymarket").id;
  const futureTarget = current.portfolio.accounts.find((account) => account.platform === "Future").id;
  const connected = await action(stateDir, "polymarket", "connect", { address: publicAddress, targetAccountId: pmTarget }, { api: predictionApi() });
  await assert.rejects(action(stateDir, "future", "connect", { address: `0x${"AB".repeat(20)}`, targetAccountId: futureTarget }, { api: predictionApi() }), { statusCode: 409 });
  const preview = connected.providers.polymarket.preview;
  await action(stateDir, "polymarket", "apply", { previewId: preview.id, revision: preview.revision }, { api: predictionApi() });
  await action(stateDir, "polymarket", "disconnect");
  await assert.rejects(action(stateDir, "future", "connect", { address: publicAddress, targetAccountId: futureTarget }, { api: predictionApi() }), { statusCode: 409 });
});

test("applied prediction valuations retain bounded original amounts, quote evidence and coverage", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = (await readPersonalAssets({ stateDir })).portfolio.accounts.find((account) => account.platform === "Polymarket").id;
  const valuation = { sourceCurrency: "USDC", sourceAmount: 100, usdPrice: 0.99, quoteObservedAt: at.toISOString(), cashRawBalance: "100000000", cashBlockNumber: "0x123", cashObservedAt: at.toISOString(), indexComputedAt: at.toISOString(), indexLagSeconds: 1, secret: "do-not-copy" };
  const source = predictionApi({ total: 99, holdings: [{ externalId: "cash", name: "Synthetic pUSD", category: "稳定币", currency: "USD", amount: 99, quantity: 100, sourceCurrency: "USDC", sourceAmount: 100 }], valuation, coverage: ["Exact synthetic coverage"], warnings: ["Synthetic fractional positions retained"] });
  const connected = await action(stateDir, "polymarket", "connect", { address: publicAddress, targetAccountId }, { api: source });
  const preview = connected.providers.polymarket.preview;
  assert.equal(preview.holdings[0].sourceAmount, 100);
  assert.equal(preview.valuation.usdPrice, 0.99);
  const result = await action(stateDir, "polymarket", "apply", { previewId: preview.id, revision: preview.revision }, { api: source });
  const details = result.sync.providers.polymarket;
  assert.equal(details.preview, undefined);
  assert.deepEqual(details.lastCoverage, ["Exact synthetic coverage"]);
  assert.deepEqual(details.lastWarnings, ["Synthetic fractional positions retained"]);
  assert.equal(details.lastValuation.sourceAmount, 100);
  assert.equal(details.lastValuation.secret, undefined);
  const row = result.assets.portfolio.entries.find((entry) => entry.kind === "holding" && entry.accountId === targetAccountId);
  assert.match(row.note, /100 USDC/);
  assert.match(row.note, /0\.99/);
  assert.match(row.note, /报价时点/);
  assert.doesNotMatch(JSON.stringify(details), /do-not-copy/);
});

test("changing the real Futu account requires a new preview and confirmation on the same local binding", async (context) => {
  const stateDir = await fixture(context);
  await writeFile(privateFile(stateDir), JSON.stringify({ schemaVersion: 1, futuClient: { clientId: "synthetic-client" }, providers: { futu: {
    tokens: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: new Date(at.getTime() + 24 * 3600_000).toISOString() },
    accounts: [{ id: "123", label: "First synthetic real account" }, { id: "456", label: "Second synthetic real account" }],
  } } }), { mode: 0o600 });
  const selected = [];
  const futu = { fetchFutuAssets: async ({ accountId }) => {
    selected.push(accountId);
    return synthetic({ provider: "futu", externalAccountId: accountId, currency: "HKD", total: accountId === "123" ? 100 : 200, holdings: [], observedAt: null, timeBasis: "retrieved" });
  } };
  const first = await action(stateDir, "futu", "preview", { accountId: "123", targetAccountId: "account-3" }, { api: futu });
  let preview = first.providers.futu.preview;
  await action(stateDir, "futu", "apply", { previewId: preview.id, revision: preview.revision }, { api: futu });
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const second = await action(stateDir, "futu", "preview", { accountId: "456", targetAccountId: "account-3" }, { api: futu });
  assert.equal(second.providers.futu.enabled, false);
  assert.equal(second.providers.futu.preview.externalAccountId, "456");
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  preview = second.providers.futu.preview;
  const changed = await action(stateDir, "futu", "apply", { previewId: preview.id, revision: preview.revision }, { api: futu });
  assert.equal(changed.sync.providers.futu.selectedAccountId, "456");
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.futu.selectedAccountId, "456");
  assert.equal(changed.assets.portfolio.entries.find((row) => row.accountId === "account-3").amount, 200);
  assert.equal(changed.assets.portfolio.entries.find((row) => row.accountId === "account-3").asOfBasis, "imported");
  await runAssetSyncCycle({ stateDir, now: later, api: futu });
  assert.deepEqual(selected, ["123", "456", "456"]);
});

test("invalid source observation metadata never enters the private preview or asset ledger", async (context) => {
  const stateDir = await fixture(context);
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  for (const changed of [{ observedAt: 1 }, { observedAt: "invalid" }, { observedAt: new Date(at.getTime() + 3600_000).toISOString() }, { timeBasis: "invented" }]) {
    await assert.rejects(connected(stateDir, { api: { fetchOkxAssets: async () => synthetic(changed) } }), /不完整/);
  }
  await assert.rejects(readFile(privateFile(stateDir)), { code: "ENOENT" });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
});

test("unconfigured status and collector do not create credential state", async (context) => {
  const stateDir = await fixture(context);
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.okx.connected, false);
  assert.deepEqual(await runAssetSyncCycle({ stateDir }), { attempted: 0, applied: 0, failed: 0 });
  await assert.rejects(readFile(privateFile(stateDir)), { code: "ENOENT" });
});

test("validated OKX credentials are private and preview never mutates asset ledger", async (context) => {
  const stateDir = await fixture(context);
  const original = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const preview = await connected(stateDir);
  assert.equal(preview.total, 100);
  assert.equal(preview.countedBasis, "holdings");
  assert.equal((await stat(privateFile(stateDir))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), original);
  const status = JSON.stringify(await readAssetSyncStatus({ stateDir }));
  assert.doesNotMatch(status, /synthetic-key|synthetic-secret|synthetic-passphrase|credentials/);
  await action(stateDir, "okx", "disconnect");
  assert.doesNotMatch(await readFile(privateFile(stateDir), "utf8"), /synthetic-key|synthetic-secret|synthetic-passphrase/);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), original);
});

test("invalid permissions or provider failures never save a key or replace ledger", async (context) => {
  const stateDir = await fixture(context);
  const denied = { fetchOkxAssets: async () => { throw Object.assign(new Error("Read only required"), { statusCode: 403 }); } };
  await assert.rejects(connected(stateDir, { api: denied }), /Read only/);
  await assert.rejects(readFile(privateFile(stateDir)), { code: "ENOENT" });
  assert.equal((await readPersonalAssets({ stateDir })).revision, 1);
});

test("apply preserves other accounts, snapshots prior revision and never double counts", async (context) => {
  const stateDir = await fixture(context);
  const original = (await readPersonalAssets({ stateDir })).portfolio.entries[0];
  const result = await enabled(stateDir);
  assert.equal(result.assets.revision, 2);
  assert.equal(result.assets.snapshots.length, 1);
  assert.equal(result.assets.snapshots[0].revision, 1);
  assert.deepEqual(result.assets.portfolio.entries.find((row) => row.id === "other-total"), original);
  assert.equal(result.assets.portfolio.accounts.find((row) => row.id === "okx-exchange").basis, "holdings");
  assert.equal(result.assets.portfolio.entries.filter((row) => row.accountId === "okx-exchange").length, 2);
  assert.equal(result.sync.providers.okx.enabled, true);
  const history = await readFile(join(stateDir, "personal-assets-snapshots", result.assets.snapshots[0].id + ".json"), "utf8");
  await action(stateDir, "okx", "disconnect");
  assert.equal((await readPersonalAssets({ stateDir })).revision, 2);
  assert.equal(await readFile(join(stateDir, "personal-assets-snapshots", result.assets.snapshots[0].id + ".json"), "utf8"), history);
});

test("breakdown must be explicitly complete, not merely equal to net total", async (context) => {
  const stateDir = await fixture(context);
  const preview = await connected(stateDir, { api: { fetchOkxAssets: async () => synthetic({ breakdownComplete: false }) } });
  assert.equal(preview.countedBasis, "total");
});

test("CAS, expiry and replay prevent applying stale previews", async (context) => {
  const stateDir = await fixture(context);
  const preview = await connected(stateDir);
  await assert.rejects(action(stateDir, "okx", "apply", { previewId: preview.id, revision: 0 }), { statusCode: 409 });
  await assert.rejects(action(stateDir, "okx", "apply", { previewId: preview.id, revision: preview.revision }, { now: new Date(at.getTime() + 21 * 60_000) }), { statusCode: 409 });
  await action(stateDir, "okx", "apply", { previewId: preview.id, revision: preview.revision });
  await assert.rejects(action(stateDir, "okx", "apply", { previewId: preview.id, revision: preview.revision }), { statusCode: 409 });
});

test("automatic collector keeps last good data on upstream failure and preserves immutable history", async (context) => {
  const stateDir = await fixture(context);
  await enabled(stateDir);
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const result = await runAssetSyncCycle({ stateDir, now: later, api: { fetchOkxAssets: async () => { throw new Error("SENSITIVE NETWORK BODY"); } } });
  assert.deepEqual(result, { attempted: 1, applied: 0, failed: 1 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  const status = await readAssetSyncStatus({ stateDir });
  assert.match(status.providers.okx.lastError, /未完成/);
  assert.doesNotMatch(JSON.stringify(status), /SENSITIVE/);
  assert.deepEqual(await runAssetSyncCycle({ stateDir, now: later, api: { fetchOkxAssets: async () => synthetic({ total: 120, holdings: [], fetchedAt: later.toISOString() }) } }), { attempted: 1, applied: 1, failed: 0 });
  const state = await readPersonalAssets({ stateDir });
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.portfolio.entries.find((row) => row.id === "sync-okx-total").amount, 120);
});

test("saving an equivalent empty account note does not pause automatic collection", async (context) => {
  const stateDir = await fixture(context);
  await enabled(stateDir);
  const current = await readPersonalAssets({ stateDir });
  assert.equal(current.portfolio.accounts.find((row) => row.id === "okx-exchange").note, undefined);
  current.portfolio.accounts.find((row) => row.id === "okx-exchange").note = "";
  await savePersonalAssets({ stateDir, portfolio: current.portfolio, revision: current.revision });
  const cycle = await runAssetSyncCycle({ stateDir, now: later, api: { fetchOkxAssets: async () => synthetic({ fetchedAt: later.toISOString() }) } });
  assert.deepEqual(cycle, { attempted: 1, applied: 1, failed: 0 });
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.okx.enabled, true);
});

test("real account notes and changes to amount, currency, category or counted basis still pause collection", async (context) => {
  for (const change of [
    (portfolio) => { portfolio.accounts.find((row) => row.id === "okx-exchange").note = "Do not overwrite my allocation"; },
    (portfolio) => { portfolio.accounts.find((row) => row.id === "okx-exchange").basis = "total"; },
    (portfolio) => { portfolio.entries.find((row) => row.kind === "holding").amount = 90; },
    (portfolio) => { portfolio.entries.find((row) => row.kind === "holding").currency = "CNY"; },
    (portfolio) => { portfolio.entries.find((row) => row.kind === "holding").category = "基金"; },
  ]) {
    const stateDir = await fixture(context);
    await enabled(stateDir);
    const current = await readPersonalAssets({ stateDir });
    change(current.portfolio);
    await savePersonalAssets({ stateDir, portfolio: current.portfolio, revision: current.revision });
    const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
    let calls = 0;
    const cycle = await runAssetSyncCycle({ stateDir, now: later, api: { fetchOkxAssets: async () => { calls += 1; return synthetic(); } } });
    assert.deepEqual(cycle, { attempted: 1, applied: 0, failed: 1 });
    assert.equal(calls, 0);
    assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
    assert.equal((await readAssetSyncStatus({ stateDir })).providers.okx.enabled, false);
  }
});

test("manual changes during in-flight auto fetch pause sync instead of being overwritten", async (context) => {
  const stateDir = await fixture(context);
  await enabled(stateDir);
  let started;
  const ready = new Promise((done) => { started = done; });
  let finish;
  const waiting = new Promise((done) => { finish = done; });
  const cycle = runAssetSyncCycle({ stateDir, now: later, api: { fetchOkxAssets: async () => { started(); await waiting; return synthetic({ fetchedAt: later.toISOString() }); } } });
  await ready;
  const latest = await readPersonalAssets({ stateDir });
  latest.portfolio.entries.find((row) => row.id === "sync-okx-total").amount = 42;
  await savePersonalAssets({ stateDir, portfolio: latest.portfolio, revision: latest.revision });
  finish();
  assert.deepEqual(await cycle, { attempted: 1, applied: 0, failed: 1 });
  assert.equal((await readPersonalAssets({ stateDir })).portfolio.entries.find((row) => row.id === "sync-okx-total").amount, 42);
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.okx.enabled, false);
});

test("deleting the bound account during automatic fetch pauses the binding without recreating it", async (context) => {
  const stateDir = await fixture(context);
  await enabled(stateDir);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const cycle = runAssetSyncCycle({ stateDir, now: later, api: { fetchOkxAssets: async () => { started(); await waiting; return synthetic({ fetchedAt: later.toISOString() }); } } });
  await ready;
  const current = await readPersonalAssets({ stateDir });
  current.portfolio.accounts = current.portfolio.accounts.filter((row) => row.id !== "okx-exchange");
  current.portfolio.entries = current.portfolio.entries.filter((row) => row.accountId !== "okx-exchange");
  await savePersonalAssets({ stateDir, portfolio: current.portfolio, revision: current.revision });
  finish();
  assert.deepEqual(await cycle, { attempted: 1, applied: 0, failed: 1 });
  assert.equal((await readPersonalAssets({ stateDir })).portfolio.accounts.some((row) => row.id === "okx-exchange"), false);
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.okx.enabled, false);
});

test("OAuth state binds the login session, expires, and is consumed once without leaking tokens", async (context) => {
  const stateDir = await fixture(context);
  const futu = { registerFutuClient: async () => ({ clientId: "synthetic-client" }), createFutuAuthorization: ({ state, codeChallenge }) => `https://webapi.futunn.com/oauth2/authorize/confirm?state=${state}&code_challenge=${codeChallenge}`,
    exchangeFutuCode: async () => ({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", scope: "trade:read", expiresAt: new Date(at.getTime() + 3600_000).toISOString() }),
    fetchFutuAccounts: async () => [{ id: "123", label: "Synthetic real account" }] };
  const auth = await action(stateDir, "futu", "authorize", {}, { api: futu, sessionBinding: "synthetic-session" });
  const query = { state: new URL(auth.authorizationUrl).searchParams.get("state"), code: "synthetic-code" };
  await assert.rejects(completeFutuAuthorization({ stateDir, query, sessionBinding: "other-session", api: futu, now: at }), { statusCode: 403 });
  const value = await completeFutuAuthorization({ stateDir, query, sessionBinding: "synthetic-session", api: futu, now: at });
  assert.equal(value.providers.futu.connected, true);
  assert.doesNotMatch(JSON.stringify(value), /synthetic-access|synthetic-refresh|codeVerifier|synthetic-session/);
  await assert.rejects(completeFutuAuthorization({ stateDir, query, sessionBinding: "synthetic-session", api: futu, now: at }), { statusCode: 403 });
});

test("rotated Futu refresh token is saved even when later account fetch fails", async (context) => {
  const stateDir = await fixture(context);
  await writeFile(privateFile(stateDir), JSON.stringify({ schemaVersion: 1, futuClient: { clientId: "synthetic-client" }, providers: { futu: { tokens: { accessToken: "expired-access", refreshToken: "old-refresh", expiresAt: at.toISOString() }, accounts: [{ id: "123", label: "Synthetic" }] } } }), { mode: 0o600 });
  const futu = { refreshFutuToken: async () => ({ accessToken: "rotated-access", refreshToken: "rotated-refresh", scope: "trade:read", expiresAt: later.toISOString() }),
    fetchFutuAssets: async () => { throw new Error("synthetic upstream failure"); } };
  await assert.rejects(action(stateDir, "futu", "preview", { accountId: "123" }, { api: futu }), /upstream failure/);
  const stored = JSON.parse(await readFile(privateFile(stateDir), "utf8"));
  assert.equal(stored.providers.futu.tokens.refreshToken, "rotated-refresh");
  assert.doesNotMatch(JSON.stringify(await readAssetSyncStatus({ stateDir })), /rotated-refresh|rotated-access/);
});

test("prediction source freshness clock advances during a real network read", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = (await readPersonalAssets({ stateDir })).portfolio.accounts.find((account) => account.platform === "Polymarket").id;
  const clocked = { fetchPolymarketAssets: async ({ address, now }) => {
    const started = now().getTime();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(now().getTime() - started >= 15, "source freshness checks must use elapsed time");
    return synthetic({ provider: "polymarket", externalAccountId: address });
  } };
  await action(stateDir, "polymarket", "connect", { address: publicAddress, targetAccountId }, { api: clocked });
});

test("prediction asset identifiers survive preview and applied ledger notes without truncation", async (context) => {
  const stateDir = await fixture(context);
  const targetAccountId = (await readPersonalAssets({ stateDir })).portfolio.accounts.find((account) => account.platform === "Polymarket").id;
  const tokenId = "7".repeat(77);
  const source = predictionApi({ holdings: [{ externalId: `position:${tokenId}`, symbol: tokenId, name: "Synthetic prediction", category: "组合资产", currency: "USD", amount: 100 }] });
  const connected = await action(stateDir, "polymarket", "connect", { address: publicAddress, targetAccountId }, { api: source });
  const preview = connected.providers.polymarket.preview;
  assert.equal(preview.holdings[0].symbol, tokenId);
  const result = await action(stateDir, "polymarket", "apply", { previewId: preview.id, revision: preview.revision }, { api: source });
  assert.ok(result.assets.portfolio.entries.find((row) => row.kind === "holding" && row.accountId === targetAccountId).note.includes(tokenId));
});

const safeAddress = `0x${"ef".repeat(20)}`;
const safePusd = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const safeClaim = { protocol: "polymarket-safe-pusd", chainIndex: "137", owner: publicAddress, address: safeAddress,
  cashRawBalance: "10200000", cashBlockNumber: "0x12345", cashObservedAt: at.toISOString() };
const safeCash = { externalId: `token:${createHash("sha256").update(`137:${safeAddress}:${safePusd}`).digest("hex")}`,
  name: "pUSD · USDC抵押权益参考", category: "稳定币", currency: "USD", amount: 10.2 * 0.998, symbol: "pUSD", quantity: "10.2", rawQuantity: "10.2",
  balanceAddress: safeAddress, cashRawBalance: "10200000", cashBlockNumber: "0x12345", cashObservedAt: at.toISOString(),
  quoteSource: "Kraken USDC/USD · pUSD抵押权益参考", quoteObservedAt: at.toISOString() };
const safeApi = (overrides = {}) => walletApi({ total: safeCash.amount, holdings: [safeCash], valuationComplete: false, derivedWallets: [safeClaim], ...overrides });
async function safeConnected(stateDir, overrides = {}) {
  const targetAccountId = await tokenPocketTarget(stateDir);
  return (await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, polymarketSafeOwner: publicAddress, targetAccountId }, { api: safeApi(overrides) })).providers.tokenpocket.preview;
}

test("Safe claims and row-level cash evidence survive apply separately from the original EOA source identity", async context => {
  const stateDir = await fixture(context), preview = await safeConnected(stateDir);
  assert.equal(preview.externalAccountId, walletId(polygonWallet)); assert.deepEqual(preview.derivedWallets, [safeClaim]);
  assert.equal(preview.holdings[0].balanceAddress, safeAddress); assert.equal(preview.holdings[0].cashRawBalance, "10200000");
  const result = await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const entry = result.assets.portfolio.entries.find(row => row.kind === "holding" && row.accountId === preview.targetAccountId);
  assert.match(entry.note, /Safe现金/); assert.match(entry.note, /10200000.*0x12345/); assert.match(entry.note, /USDC抵押权益参考/);
  assert.equal(entry.note.includes(safeAddress), false);
  assert.equal(result.sync.providers.tokenpocket.observedAt, null);
  assert.deepEqual(result.sync.providers.tokenpocket.wallets, polygonWallet);
  assert.deepEqual(result.sync.providers.tokenpocket.lastProtocolBalances, [{ protocol: safeClaim.protocol, cashRawBalance: safeClaim.cashRawBalance, cashBlockNumber: safeClaim.cashBlockNumber, cashObservedAt: safeClaim.cashObservedAt }]);
  const stored = JSON.parse(await readFile(privateFile(stateDir), "utf8"));
  assert.deepEqual(stored.providers.tokenpocket.appliedDerivedWallets, [safeClaim]);
  assert.deepEqual(stored.walletBindings.find(row => row.targetAccountId === preview.targetAccountId).derivedWallets, [safeClaim]);
});

test("a pending or applied Safe cash source cannot be counted again through wallet, Polymarket or Future after disconnect", async context => {
  const stateDir = await fixture(context), preview = await safeConnected(stateDir);
  const current = await readPersonalAssets({ stateDir });
  const rejectDuplicates = async () => {
    for (const provider of ["polymarket", "future"]) {
      const targetAccountId = current.portfolio.accounts.find(row => row.platform === (provider === "future" ? "Future" : "Polymarket")).id;
      await assert.rejects(action(stateDir, provider, "connect", { address: safeAddress, targetAccountId }, { api: predictionApi() }), { statusCode: 409 });
    }
    await assert.rejects(action(stateDir, "okxweb3", "bind", { wallets: [{ chainIndex: "137", address: safeAddress }], targetAccountId: "other" }), { statusCode: 409 });
  };
  await rejectDuplicates();
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  await action(stateDir, "tokenpocket", "disconnect");
  await rejectDuplicates();
});

test("prediction claims also block new direct or derived wallet sources, including retained disconnected holdings", async context => {
  const stateDir = await fixture(context), current = await readPersonalAssets({ stateDir });
  const targetAccountId = current.portfolio.accounts.find(row => row.platform === "Polymarket").id;
  const first = await action(stateDir, "polymarket", "connect", { address: safeAddress, targetAccountId }, { api: predictionApi() });
  for (const disconnected of [false, true]) {
    if (disconnected) {
      const preview = first.providers.polymarket.preview;
      await action(stateDir, "polymarket", "apply", { previewId: preview.id, revision: preview.revision });
      await action(stateDir, "polymarket", "disconnect");
    }
    await assert.rejects(action(stateDir, "okxweb3", "bind", { wallets: [{ chainIndex: "137", address: safeAddress }], targetAccountId: "other" }), { statusCode: 409 });
    await assert.rejects(safeConnected(stateDir), { statusCode: 409 });
  }
});

test("Safe source loss or changed ownership never removes previously counted cash in connect, preview, apply or automatic cycles", async context => {
  const stateDir = await fixture(context), preview = await safeConnected(stateDir);
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8"), statusBefore = await readAssetSyncStatus({ stateDir });
  const missing = { total: 0, holdings: [], derivedWallets: [], fetchedAt: later.toISOString() };
  await assert.rejects(safeConnected(stateDir, missing), /Safe|派生.*来源|保留/);
  await assert.rejects(action(stateDir, "tokenpocket", "preview", {}, { api: safeApi(missing), now: later }), /Safe|派生.*来源|保留/);
  assert.deepEqual(await runAssetSyncCycle({ stateDir, api: safeApi(missing), now: later }), { attempted: 1, applied: 0, failed: 1 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  assert.equal((await readAssetSyncStatus({ stateDir })).providers.tokenpocket.lastFetchedAt, statusBefore.providers.tokenpocket.lastFetchedAt);
  const next = await action(stateDir, "tokenpocket", "preview", {}, { api: safeApi() });
  const data = JSON.parse(await readFile(privateFile(stateDir), "utf8")); data.providers.tokenpocket.preview.derivedWallets = [];
  await writeFile(privateFile(stateDir), JSON.stringify(data));
  await assert.rejects(action(stateDir, "tokenpocket", "apply", { previewId: next.providers.tokenpocket.preview.id, revision: next.providers.tokenpocket.preview.revision }), /Safe|派生.*来源|保留/);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
});

test("only a verified zero cash proof can remove Safe cash while the source claim remains persistent", async context => {
  const stateDir = await fixture(context), preview = await safeConnected(stateDir);
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const zero = { ...safeClaim, cashRawBalance: "0", cashObservedAt: later.toISOString() };
  const next = await action(stateDir, "tokenpocket", "preview", {}, { api: safeApi({ total: 0, holdings: [], derivedWallets: [zero], fetchedAt: later.toISOString() }), now: later });
  const p = next.providers.tokenpocket.preview;
  const applied = await action(stateDir, "tokenpocket", "apply", { previewId: p.id, revision: p.revision }, { now: later });
  assert.equal(applied.assets.portfolio.entries.some(row => row.accountId === p.targetAccountId && row.kind === "holding"), false);
  assert.equal(applied.sync.providers.tokenpocket.lastProtocolBalances[0].cashRawBalance, "0");
});

test("derived cash proofs are narrow, fresh and owner-linked rather than arbitrary claims or copied metadata", async context => {
  const stateDir = await fixture(context);
  for (const overrides of [{ derivedWallets: [{ ...safeClaim, owner: safeAddress }] }, { derivedWallets: [{ ...safeClaim, chainIndex: "1" }] },
    { derivedWallets: [{ ...safeClaim, protocol: "unknown-protocol" }] }, { derivedWallets: [safeClaim, safeClaim] },
    { derivedWallets: [{ ...safeClaim, cashObservedAt: "2026-10-24T11:50:00.000Z" }] }, { derivedWallets: [{ ...safeClaim, cashRawBalance: "10200001" }] },
    { holdings: [{ ...safeCash, balanceAddress: publicAddress }] }, { holdings: [{ ...safeCash, cashRawBalance: "10200001" }] },
    { derivedWallets: [], holdings: [safeCash] }]) {
    await assert.rejects(safeConnected(stateDir, overrides), { statusCode: 502 });
  }
});

test("a pre-ledger Safe reservation survives post-ledger persistence failure then disconnect or rebind", async context => {
  for (const nextAction of ["disconnect", "bind"]) {
    const stateDir = await fixture(context), targetAccountId = await tokenPocketTarget(stateDir);
    const original = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, { api: walletApi() });
    const old = original.providers.tokenpocket.preview;
    await action(stateDir, "tokenpocket", "apply", { previewId: old.id, revision: old.revision });
    const preview = await safeConnected(stateDir);
    const snapshots = join(stateDir, "personal-assets-snapshots");
    await rename(snapshots, snapshots + ".saved"); await writeFile(snapshots, "synthetic snapshot obstruction");
    await assert.rejects(action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision }));
    const beforeLedger = JSON.parse(await readFile(privateFile(stateDir), "utf8"));
    assert.ok(beforeLedger.walletBindings.some(row => row.derivedWallets?.some(claim => claim.address === safeAddress)));
    await rm(snapshots); await rename(snapshots + ".saved", snapshots);
    await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
    // Restore the actual durable pre-ledger config, as if final provider persistence failed.
    await writeFile(privateFile(stateDir), JSON.stringify(beforeLedger));
    await assert.rejects(action(stateDir, "tokenpocket", "bind", { wallets: polygonWallet, targetAccountId: preview.targetAccountId, polymarketSafeOwner: null }), /Safe.*保留/);
    await action(stateDir, "tokenpocket", nextAction, nextAction === "bind" ? { wallets: polygonWallet, targetAccountId: preview.targetAccountId, polymarketSafeOwner: publicAddress } : {});
    const current = await readPersonalAssets({ stateDir }), target = current.portfolio.accounts.find(row => row.platform === "Polymarket").id;
    await assert.rejects(action(stateDir, "polymarket", "connect", { address: safeAddress, targetAccountId: target }, { api: predictionApi() }), { statusCode: 409 });
    assert.equal(current.portfolio.entries.filter(row => row.accountId === preview.targetAccountId && row.kind === "holding").length, 1);
  }
});

test("changing explicit Safe scope requires a fresh preview and cannot release an applied counted source", async context => {
  const stateDir = await fixture(context), targetAccountId = await tokenPocketTarget(stateDir);
  for (const owner of [safeAddress, "invalid", [publicAddress]]) await assert.rejects(action(stateDir, "tokenpocket", "bind", { wallets: polygonWallet, targetAccountId, polymarketSafeOwner: owner }));
  const preview = await safeConnected(stateDir);
  const data = JSON.parse(await readFile(privateFile(stateDir), "utf8")); data.providers.tokenpocket.polymarketSafeOwner = null;
  await writeFile(privateFile(stateDir), JSON.stringify(data));
  await assert.rejects(action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision }), { statusCode: 409 });
  data.providers.tokenpocket.polymarketSafeOwner = publicAddress; await writeFile(privateFile(stateDir), JSON.stringify(data));
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  await assert.rejects(action(stateDir, "tokenpocket", "bind", { wallets: polygonWallet, targetAccountId, polymarketSafeOwner: null }), /Safe.*保留/);
});

test("Safe price loss retains its prior ledger and successful timestamps across all refresh paths", async context => {
  const stateDir = await fixture(context), preview = await safeConnected(stateDir);
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8"), initial = (await readAssetSyncStatus({ stateDir })).providers.tokenpocket;
  const missing = { externalId: safeCash.externalId, chainIndex: "137", contract: safePusd, symbol: "pUSD", name: "pUSD", quantity: "10.2", reason: "缺少新鲜参考报价" };
  const overrides = { fetchedAt: later.toISOString(), total: 0, holdings: [], unpricedAssets: [missing], derivedWallets: [{ ...safeClaim, cashObservedAt: later.toISOString() }] };
  await assert.rejects(safeConnected(stateDir, overrides), /保留上次有效估值/);
  await assert.rejects(action(stateDir, "tokenpocket", "preview", {}, { api: safeApi(overrides), now: later }), /保留上次有效估值/);
  assert.deepEqual(await runAssetSyncCycle({ stateDir, api: safeApi(overrides), now: later }), { attempted: 1, applied: 0, failed: 1 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
  const final = (await readAssetSyncStatus({ stateDir })).providers.tokenpocket;
  assert.equal(final.lastFetchedAt, initial.lastFetchedAt); assert.equal(final.lastAppliedAt, initial.lastAppliedAt);
});

test("a full source reservation history fails closed without persisting an over-limit configuration", async context => {
  const stateDir = await fixture(context), targetAccountId = await tokenPocketTarget(stateDir);
  const connected = await action(stateDir, "tokenpocket", "connect", { ...credentials, wallets: polygonWallet, targetAccountId }, { api: walletApi() });
  const preview = connected.providers.tokenpocket.preview;
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const data = JSON.parse(await readFile(privateFile(stateDir), "utf8")); data.providers.tokenpocket.polymarketSafeOwner = publicAddress;
  data.walletBindings = Array.from({ length: 100 }, (_, index) => ({ provider: "tokenpocket", targetAccountId: `old-source-${index}`, wallets: [{ chainIndex: "137", address: `0x${(index + 1).toString(16).padStart(40, "0")}` }] }));
  await writeFile(privateFile(stateDir), JSON.stringify(data));
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const next = safeApi({ fetchedAt: later.toISOString(), derivedWallets: [{ ...safeClaim, cashObservedAt: later.toISOString() }], holdings: [{ ...safeCash, cashObservedAt: later.toISOString(), quoteObservedAt: later.toISOString() }] });
  assert.deepEqual(await runAssetSyncCycle({ stateDir, api: next, now: later }), { attempted: 1, applied: 0, failed: 1 });
  assert.equal(JSON.parse(await readFile(privateFile(stateDir), "utf8")).walletBindings.length, 100);
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
});

test("reserving a Safe leaves unrelated legacy wallet binding records unchanged", async context => {
  const stateDir = await fixture(context);
  const legacy = { provider: "okxweb3", targetAccountId: "other", wallets: [{ chainIndex: "1", address: publicAddress }] };
  await writeFile(privateFile(stateDir), JSON.stringify({ schemaVersion: 1, providers: {}, walletBindings: [legacy] }), { mode: 0o600 });
  const preview = await safeConnected(stateDir);
  await action(stateDir, "tokenpocket", "apply", { previewId: preview.id, revision: preview.revision });
  const config = JSON.parse(await readFile(privateFile(stateDir), "utf8"));
  assert.deepEqual(config.walletBindings.find(row => row.targetAccountId === "other"), legacy);
});
