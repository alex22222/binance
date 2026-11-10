import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { agenticWalletClient } from "../src/agentic-wallet-client.mjs";
import { projectAgenticWallets } from "../src/agentic-wallet-overview.mjs";

const settle = () => new Promise(done => setImmediate(done));
function browser() {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", innerHTML: "", value: "", disabled: false, events: {}, attributes: {}, classList: { toggle() {} },
      addEventListener(event, fn) { this.events[event] = fn; }, setAttribute(key, value) { this.attributes[key] = value; }, replaceChildren() { this.innerHTML = ""; this.textContent = ""; } });
    return nodes.get(id);
  };
  const at = new Date().toISOString(), today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const data = { ...projectAgenticWallets({ assets: { portfolio: {
    accounts: [ { id: "b", platform: "币安Agentic Wallet", name: "Binance", basis: "holdings", reviewStatus: "confirmed" }, { id: "o", platform: "OKX Agentic Wallet", name: "OKX", basis: "holdings", reviewStatus: "confirmed" } ],
    entries: [ { accountId: "b", name: "SPYon", kind: "holding", currency: "USD", amount: 200, asOf: today }, { accountId: "o", name: '<img src=x onerror="bad">', kind: "holding", currency: "USD", amount: 25, asOf: "2026-01-01" } ]
  } } }), okxStatus: { status: "MISSING", snapshot: null }, preferences: { schemaVersion: 1, revision: 0, drafts: {} } };
  const calls = [];
  let fail = false, timer;
  const snapshot = { health: { status: "RUNNING", updatedAt: at }, strategy: { activeStrategyId: "weekly-etf-dual-momentum-defense" }, walletBalance: { totalUsd: 400, checkedAt: at, availableUsdt: 200, availableUsdtCheckedAt: at }, positions: [{ symbol: "SPY", quantity: 0.3 }] };
  runInNewContext(`(${agenticWalletClient.toString()})();`, {
    document: { getElementById: element, hidden: false }, location: { href: "http://localhost/dashboard", assign() {} }, history: { replaceState() {} }, URL, Date, Intl, AbortSignal,
    setInterval(fn) { timer = fn; },
    async fetch(url, options = {}) {
      calls.push({ url, options });
      if (fail) return { status: 500, ok: false };
      if (url.endsWith("/preferences")) {
        const body = JSON.parse(options.body);
        data.preferences = { schemaVersion: 1, revision: data.preferences.revision + 1, drafts: { ...data.preferences.drafts, [body.walletId]: { strategyId: body.strategyId, savedAt: at } } };
        return { status: 200, ok: true, json: async () => structuredClone(data.preferences) };
      }
      return { status: 200, ok: true, json: async () => structuredClone(url === "/api/snapshot" ? snapshot : data) };
    }
  });
  return { element, calls, snapshot, data, fail() { fail = true; }, refresh: () => timer() };
}

test("wallet switch changes assets, choices and detail links, escapes asset names, and never calls execution APIs", async () => {
  const ui = browser(); await settle();
  assert.match(ui.element("walletAssets").innerHTML, /SPYon/);
  assert.match(ui.element("walletMetrics").innerHTML, /400\.00/);
  await ui.element("wallet-okx").events.click(); await settle();
  assert.doesNotMatch(ui.element("walletAssets").innerHTML, /SPYon|<img/);
  assert.match(ui.element("walletAssets").innerHTML, /&lt;img|历史记录/);
  assert.doesNotMatch(ui.element("walletMetrics").innerHTML, /400\.00|可用 USDT/);
  assert.doesNotMatch(ui.element("strategyChoice").innerHTML, /weekly-etf/);
  assert.equal(ui.element("runtimeLink").href, "/agentic-wallet/okx");
  assert.equal(ui.element("wallet-okx").attributes["aria-pressed"], "true");
  assert.ok(ui.calls.every(call => !call.options.method || call.options.method === "GET"));
});

test("saving a choice preserves the current strategy, scopes drafts by wallet, and survives refresh", async () => {
  const ui = browser(); await settle();
  const actual = ui.element("actualStrategy").textContent;
  ui.element("strategyChoice").events.change({ target: { value: "trend-pullback-confirmation" } });
  assert.equal(ui.element("saveStrategy").disabled, false);
  await ui.element("saveStrategy").events.click();
  assert.equal(ui.element("actualStrategy").textContent, actual);
  assert.match(ui.element("saveStatus").textContent, /已保存待启用/);
  await ui.refresh(); await settle();
  assert.equal(ui.element("strategyChoice").value, "trend-pullback-confirmation");
  await ui.element("wallet-okx").events.click(); await settle();
  assert.equal(ui.element("strategyChoice").value, "");
  ui.element("strategyChoice").events.change({ target: { value: "okx-pullback-second-wave" } });
  await ui.element("saveStrategy").events.click();
  assert.equal(ui.data.preferences.drafts.binance.strategyId, "trend-pullback-confirmation");
  assert.equal(ui.data.preferences.drafts.okx.strategyId, "okx-pullback-second-wave");
  const writes = ui.calls.filter(call => call.options.method === "POST");
  assert.deepEqual(writes.map(row => row.url), ["/api/agentic-wallets/preferences", "/api/agentic-wallets/preferences"]);
  assert.ok(writes.every(row => !row.options.body.includes("execute")));
});

test("expired heartbeat and failed refresh cannot retain current balance or claim an empty wallet", async () => {
  const ui = browser(); await settle();
  ui.snapshot.health.updatedAt = "2026-01-01T00:00:00Z";
  ui.snapshot.walletBalance.checkedAt = ui.snapshot.walletBalance.availableUsdtCheckedAt = "2026-01-01T00:00:00Z";
  await ui.refresh(); await settle();
  assert.doesNotMatch(ui.element("walletMetrics").innerHTML, /400\.00|运行中/);
  assert.match(ui.element("walletPositions").innerHTML, /时点未核实/);
  ui.fail(); await ui.refresh(); await settle();
  assert.match(ui.element("walletAssets").innerHTML, /读取失败/);
  assert.equal(ui.element("walletMetrics").innerHTML, "");
  assert.equal(ui.element("saveStrategy").disabled, true);
  await ui.element("wallet-okx").events.click(); await settle();
  assert.equal(ui.element("selectedWalletName").textContent, "OKX Agentic Wallet");
  assert.equal(ui.element("runtimeLink").href, "/agentic-wallet/okx");
});
