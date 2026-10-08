import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { emptyTradeLedger, ingestTraceLine } from "../src/trade-ledger.mjs";
import { tradeReviewHtml } from "../src/trade-review-html.mjs";
import { buildReviewOverview } from "../src/trade-review-overview.mjs";

class Element {
  innerHTML = "";
  text = "";
  attributes = {};
  listeners = {};
  constructor(dataset = {}) { this.dataset = dataset; }
  set textContent(value) { this.text = String(value); this.innerHTML = ""; }
  get textContent() { return this.text; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}

async function render(payload, { status = 200, search = "" } = {}) {
  const html = tradeReviewHtml({ nonce: "test-nonce" });
  const script = html.match(/<script nonce="test-nonce">([\s\S]*)<\/script>/)[1];
  const elements = new Map();
  const get = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const buttons = ["7d", "30d", "all"].map((period) => new Element({ period }));
  const requests = [];
  const navigation = { assigned: null, replaced: null };
  const context = createContext({
    document: { getElementById: get, querySelectorAll: () => buttons },
    location: { search, assign: (url) => { navigation.assigned = url; } },
    history: { replaceState: (_state, _title, url) => { navigation.replaced = url; } },
    URLSearchParams,
    AbortSignal,
    fetch: async (url) => { requests.push(url); return { status, ok: status === 200, json: async () => payload }; }
  });
  runInContext(script, context);
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  return { html, get, buttons, requests, navigation };
}

let sequence = 0;
const ledger = emptyTradeLedger(1);
for (const [timestamp, event, status, details] of [
  ["2026-08-20T16:38:21Z", "buy_submission", "submitted", { symbol: "<img src=x>", strategyId: "adaptive-momentum", amountUsdt: 50, orderId: "B1" }],
  ["2026-08-20T16:38:22Z", "pending_order", "finished", { orderId: "B1", side: "BUY", symbol: "<img src=x>", txHash: "0x1", gasUsdt: 0.02 }],
  ["2026-08-20T17:59:13Z", "sell_submission", "submitted", { symbol: "<img src=x>", strategyId: "adaptive-momentum", reason: "TRAILING_STOP", orderId: "S1" }],
  ["2026-08-20T18:00:20Z", "pending_order", "finished", { orderId: "S1", side: "SELL", symbol: "<img src=x>", strategyId: "adaptive-momentum", proceedsUsdt: 50.6, grossPnlUsdt: 0.6, gasCostUsdt: 0.04, realizedPnlUsdt: 0.56, entryTxHash: "0x1" }],
  ["2026-08-22T01:00:00Z", "order_submission", "ambiguous", { symbol: "META", side: "SELL", error: "<script>alert(1)</script>" }]
]) ingestTraceLine(ledger, JSON.stringify({ timestamp, runId: "r", sequence: sequence += 1, event, status, details }));
const payload = buildReviewOverview({
  ledger,
  botState: {
    positions: [{ symbol: "QQQ", strategyId: "weekly-etf-dual-momentum-defense", costBasisUsdt: 50, lastQuoteProceedsUsdt: 51.57, lastQuoteAt: "2026-10-08T15:59:04Z", openedAt: "2026-09-21T13:32:31Z", peakReturnPct: 4.53, worstReturnPct: -0.18 }],
    walletBalance: { totalUsd: 445.71, availableUsdt: 388.86, checkedAt: "2026-10-09T00:00:00Z" },
    weeklyEtfLive: { strategyId: "weekly-etf-dual-momentum-defense", week: "2026-10-05", evaluatedAt: "2026-10-05T13:31:20Z", decision: { signalDate: "2026-10-02", target: "QQQ", allRiskAssets: [{ ticker: "QQQ", momentumPct: 4.56, rsi: 65.6, eligible: true }, { ticker: "SPY", momentumPct: -0.21, rsi: 55.4, eligible: false }], defensiveAsset: { ticker: "SGOV", momentumPct: 0.31, eligible: true } } }
  },
  walletHistory: [{ date: "2026-08-01", totalUsd: 449 }, { date: "2026-09-01", totalUsd: 444 }, { date: "2026-10-01", totalUsd: 445 }],
  premarket: { status: "AVAILABLE", tradingDate: "2026-10-08", advice: { level: "SELECTIVE_LONG", summary: "选择性做多" }, market: { benchmarkAveragePct: -0.48, breadthPositivePct: 39.1, vixChangePct: 3.85 }, errors: [] },
  disasterStopLossPct: 8,
  nowMs: Date.parse("2026-10-09T03:00:00Z"),
  period: "all"
});

test("renders every section of the review from the API and escapes saved strings", async () => {
  const { html, get, requests } = await render(payload, { search: "?period=all" });
  assert.match(html, /<a href="\/reviews" aria-current="page">复盘<\/a>/);
  assert.deepEqual(requests, ["/api/review?period=all"]);
  assert.match(get("stamp").textContent, /^全部 · 交易日志 2026-08-20 起/);
  assert.equal(get("findings").innerHTML.match(/<li>/g).length, payload.findings.length);
  assert.match(get("accountKpis").innerHTML, /445\.71 U/);
  assert.match(get("equityChart").innerHTML, /<svg viewBox="0 0 720 220"/);
  assert.match(get("equityChart").innerHTML, /<title>2026-08-20 卖出 &lt;img src=x&gt; \+0\.56 U<\/title>/);
  assert.match(get("positions").innerHTML, /<b>QQQ<\/b><span class="badge brand">周频 ETF 双动量防守轮动<\/span><span class="badge good">\+3\.14%<\/span>/);
  assert.match(get("positions").innerHTML, /跌幅超过 8% 时灾难止损/);
  assert.match(get("decision").innerHTML, /<tr class="picked"><td class="">QQQ<\/td>/);
  assert.match(get("decision").innerHTML, /SGOV（防守）/);
  assert.match(get("decision").innerHTML, /下次约在 2026-10-12/);
  assert.match(get("strategySummary").innerHTML, /自适应动量/);
  assert.match(get("trades").innerHTML, /全部完成的交易（1 笔）/);
  assert.match(get("trades").innerHTML, /&lt;img src=x&gt;<\/td>.*移动止损/);
  assert.doesNotMatch(get("trades").innerHTML + get("execution").innerHTML, /<img|<script/);
  assert.match(get("execution").innerHTML, /下单结果不明<\/b> · META<br>&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(get("premarket").innerHTML, /<span class="badge brand">选择性做多<\/span>/);
});

test("switches periods in place and sends an expired login to the form", async () => {
  const view = await render(payload);
  assert.deepEqual(view.requests, ["/api/review?period=30d"]);
  assert.equal(view.buttons[1].attributes["aria-pressed"], "true");
  view.buttons[0].listeners.click();
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(view.navigation.replaced, "/reviews?period=7d");
  assert.deepEqual(view.requests, ["/api/review?period=30d", "/api/review?period=7d"]);
  assert.equal(view.buttons[0].attributes["aria-pressed"], "true");

  const expired = await render(payload, { status: 401 });
  assert.equal(expired.navigation.assigned, "/login");
  const failed = await render(payload, { status: 500 });
  assert.match(failed.get("stamp").textContent, /复盘数据读取失败（HTTP 500）/);
});
