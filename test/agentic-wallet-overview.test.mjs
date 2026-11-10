import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAgenticWallets, readWalletPreferences, saveWalletPreference } from "../src/agentic-wallet-overview.mjs";
import { agenticWalletHtml } from "../src/agentic-wallet-html.mjs";

const now = new Date("2026-11-11T04:00:00Z");
function fixture() {
  return { updatedAt: now.toISOString(), portfolio: { accounts: [
    { id: "binance-private", platform: "币安Agentic Wallet", name: "Binance BSC", basis: "holdings", reviewStatus: "confirmed" },
    { id: "okx-private", platform: "OKX Agentic Wallet", name: "OKX X Layer", basis: "holdings", reviewStatus: "confirmed" },
    { id: "exchange", platform: "OKX", name: "交易所", basis: "total", reviewStatus: "confirmed" }
  ], entries: [
    { accountId: "binance-private", name: "SPYon", kind: "holding", currency: "USD", amount: 123, asOf: "2026-11-10", asOfBasis: "imported", source: "api", note: "private-secret" },
    { accountId: "binance-private", name: "汇总", kind: "total", currency: "USD", amount: 123, asOf: "2026-11-10" },
    { accountId: "okx-private", name: "USDT0", kind: "holding", currency: "USD", amount: 25, asOf: "2026-11-08", asOfBasis: "imported", source: "api" },
    { accountId: "exchange", name: "不应展示的交易所资产", kind: "total", currency: "USD", amount: 900 }
  ] } };
}

test("wallet scope is exact; totals, detail and other platforms never mix", () => {
  const view = projectAgenticWallets({ assets: fixture(), now });
  assert.deepEqual(view.wallets.map(row => row.id), ["binance", "okx"]);
  assert.equal(view.wallets[0].accounts[0].rows.length, 2);
  assert.equal(view.wallets[0].accounts[0].subtotals[0].amount, 123);
  assert.equal(view.wallets[1].accounts[0].subtotals[0].amount, 25);
  assert.equal(view.wallets[1].accounts[0].rows[0].historical, true);
  assert.equal(view.wallets[0].accounts[0].rows[0].timeBasis, "imported");
  for (const secret of ["binance-private", "okx-private", "private-secret", "不应展示的交易所资产"]) assert.ok(!JSON.stringify(view).includes(secret));
});

test("missing, failed, pending, mixed-currency and unpriced assets cannot become a current zero balance", () => {
  const missing = projectAgenticWallets({ now });
  assert.equal(missing.wallets[0].assetsStatus, "MISSING");
  const failed = projectAgenticWallets({ assets: { status: "ERROR", error: "secret" }, now });
  assert.equal(failed.wallets[1].assetsStatus, "ERROR");
  const assets = fixture();
  assets.portfolio.entries.push({ accountId: "okx-private", name: "HKD", kind: "holding", currency: "HKD", amount: 10, asOf: "2026-11-11" });
  const mixed = projectAgenticWallets({ assets, now }).wallets[1].accounts[0];
  assert.deepEqual(mixed.subtotals.map(row => row.currency).sort(), ["HKD", "USD"]);
  assets.portfolio.accounts[1].reviewStatus = "pending";
  assert.deepEqual(projectAgenticWallets({ assets, now }).wallets[1].accounts[0].subtotals, []);
});

test("only applied unpriced records bind to their exact wallet account; previews and fetch time do not relabel saved assets", () => {
  const sync = { providers: { okxagentic: { targetAccountId: "okx-private", lastFetchedAt: now.toISOString(), lastAppliedAt: "2026-11-08T01:00:00Z", lastError: "private-error", connected: true,
    preview: { holdings: [{ name: "UNAPPLIED", amount: 888 }] }, wallets: [{ address: "private-address" }],
    lastUnpricedAssets: [{ symbol: "ABC", name: "ABC", chainIndex: "196", quantity: "0.123456789123456789", contract: "0x1111111111111111111111111111111111111111", reason: "身份未核实" }] } } };
  const view = projectAgenticWallets({ assets: fixture(), sync, now });
  const okx = view.wallets[1];
  assert.equal(okx.sync.appliedAt, "2026-11-08T01:00:00Z");
  assert.equal(okx.sync.failed, true);
  assert.equal(okx.accounts[0].unpriced[0].quantity, "0.123456789123456789");
  assert.equal(okx.accounts[0].rows[0].asOf, "2026-11-08");
  for (const secret of ["private-address", "private-error", "UNAPPLIED", "targetAccountId"]) assert.ok(!JSON.stringify(view).includes(secret));
  sync.providers.okxagentic.targetAccountId = "binance-private";
  assert.equal(projectAgenticWallets({ assets: fixture(), sync, now }).wallets[1].accounts[0].unpriced.length, 0);
});

test("strategy catalogs remain wallet-scoped and cannot grant execution", () => {
  const view = projectAgenticWallets({ assets: fixture(), now });
  assert.ok(view.wallets[0].strategies.some(row => row.id === "weekly-etf-dual-momentum-defense"));
  assert.ok(view.wallets[1].strategies.some(row => row.id === "okx-pullback-second-wave"));
  assert.ok(!view.wallets[1].strategies.some(row => row.id === "weekly-etf-dual-momentum-defense"));
  for (const wallet of view.wallets) {
    assert.equal(wallet.selectionMode, "DRAFT_ONLY");
    assert.ok(wallet.strategies.every(row => row.canExecute === false));
  }
});

test("new overview keeps controls off the switcher, uses nonce CSP and retains explicit Binance execution access", () => {
  const html = agenticWalletHtml({ nonce: "test-nonce" });
  assert.match(html, /交易总览/);
  assert.match(html, /Binance Agentic Wallet/);
  assert.match(html, /OKX Agentic Wallet/);
  assert.match(html, /手机、电脑查看同一方案/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.doesNotMatch(html, /id="autoApprovalToggle"|id="stopButton"|\/api\/strategy["']|\/api\/wallet-login/);
});

test("drafts persist per wallet, reject cross-wallet strategies and stale revisions, and never touch execution files", async t => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-drafts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["strategy-control.json", "authorization.json", "config.json", "state.json"]) await writeFile(join(dir, name), "unchanged");
  assert.deepEqual(await readWalletPreferences(dir), { schemaVersion: 1, revision: 0, drafts: {} });
  let saved = await saveWalletPreference(dir, { walletId: "binance", strategyId: "weekly-etf-dual-momentum-defense", revision: 0 }, now);
  assert.equal(saved.revision, 1);
  saved = await saveWalletPreference(dir, { walletId: "okx", strategyId: "okx-pullback-second-wave", revision: 1 }, now);
  assert.equal(saved.drafts.binance.strategyId, "weekly-etf-dual-momentum-defense");
  assert.equal(saved.drafts.okx.strategyId, "okx-pullback-second-wave");
  assert.deepEqual(await readWalletPreferences(dir), saved);
  await assert.rejects(saveWalletPreference(dir, { walletId: "okx", strategyId: "observe-only", revision: 1 }), error => error.statusCode === 409);
  for (const input of [{ walletId: "okx", strategyId: "weekly-etf-dual-momentum-defense", revision: 2 },
    { walletId: "binance", strategyId: "observe-only", revision: 2, execute: true }, { walletId: "../../state", strategyId: "observe-only", revision: 2 }]) {
    await assert.rejects(saveWalletPreference(dir, input), error => error.statusCode === 400);
  }
  for (const name of ["strategy-control.json", "authorization.json", "config.json", "state.json"]) assert.equal(await readFile(join(dir, name), "utf8"), "unchanged");
  assert.equal((await stat(join(dir, "agentic-wallet-preferences.json"))).mode & 0o777, 0o600);
  assert.equal((await readdir(dir)).length, 5);
});

test("corrupt or symlinked drafts are not silently overwritten, and concurrent tabs cannot lose an update", async t => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-drafts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const body = { walletId: "binance", strategyId: "observe-only", revision: 0 };
  const concurrent = await Promise.allSettled([saveWalletPreference(dir, body, now), saveWalletPreference(dir, body, now)]);
  assert.equal(concurrent.filter(row => row.status === "fulfilled").length, 1);
  const path = join(dir, "agentic-wallet-preferences.json");
  await writeFile(path, "corrupt");
  await assert.rejects(saveWalletPreference(dir, { ...body, revision: 1 }), error => error.statusCode === 500);
  assert.equal(await readFile(path, "utf8"), "corrupt");
  await rm(path); await symlink(join(dir, "strategy-control.json"), path);
  await writeFile(join(dir, "strategy-control.json"), "protected");
  await assert.rejects(saveWalletPreference(dir, body));
  assert.equal(await readFile(join(dir, "strategy-control.json"), "utf8"), "protected");
});
