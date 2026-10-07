import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { btcRadarAlertReasons, btcRadarAlertText, loadBtcRadarSettings, loadBtcRadarView, runBtcRadar, saveBtcRadarSettings } from "../src/btc-radar.mjs";

const NOW = Date.parse("2026-10-01T13:00:00Z");
const ladderMarket = (kind, level, yes) => ({
  question: `Will Bitcoin ${kind} $${level.toLocaleString("en-US")} September 28-October 4?`,
  outcomes: '["Yes","No"]',
  outcomePrices: JSON.stringify([String(yes), String(1 - yes)])
});
const fedMarket = (label, yes) => ({ groupItemTitle: label, question: label, outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(yes), String(1 - yes)]) });
const treasuryCsv = ['Date,"2 Yr","10 Yr"', ...Array.from({ length: 11 }, (_, index) => {
  const day = String(30 - index).padStart(2, "0");
  return `09/${day}/2026,4.8,${(5.3 - index * 0.03).toFixed(2)}`;
})].join("\n");

function responses(overrides = {}) {
  const body = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => value });
  const routes = [
    ["bar=1Dutc", { code: "0", data: Array.from({ length: 40 }, (_, index) => [
      String(Date.parse("2026-10-01T00:00:00Z") - (index - 1) * 86_400_000), "0", "0", "0", String(84000 - index * 50), "0", "0", "0", index === 0 ? "0" : "1"
    ]) }],
    ["api.alternative.me/fng", { data: [{ value: "72", value_classification: "Greed", timestamp: String(Date.parse("2026-10-02T00:00:00Z") / 1000) }] }],
    ["/market/ticker", { code: "0", data: [{ last: "84000" }] }],
    ["instId=BTC-USDT&bar=1D", { code: "0", data: Array.from({ length: 60 }, (_, index) => ["0", "0", "0", "0", String(84000 - index * 40)]) }],
    ["instId=XAUT-USDT", { code: "0", data: Array.from({ length: 15 }, (_, index) => ["0", "0", "0", "0", String(4100 + index * 8)]) }],
    ["funding-rate-history", { code: "0", data: Array.from({ length: 9 }, () => ({ fundingRate: "0.0001" })) }],
    ["open-interest-history", { code: "0", data: Array.from({ length: 8 }, (_, index) => ["0", "0", String(30000 - index * 100), "0"]) }],
    ["tag_slug=bitcoin", [{
      title: "What price will Bitcoin hit September 28-October 4?",
      endDate: "2026-10-05T04:00:00Z",
      markets: [ladderMarket("dip to", 80000, 0.2), ladderMarket("dip to", 76000, 0.05), ladderMarket("reach", 88000, 0.1), ladderMarket("reach", 92000, 0.02)]
    }]],
    ["slug=what-price-will-bitcoin-hit-in-october-2026", [{
      title: "What price will Bitcoin hit in October?",
      markets: [ladderMarket("dip to", 75000, 0.3), ladderMarket("dip to", 70000, 0.1), ladderMarket("reach", 90000, 0.4), ladderMarket("reach", 95000, 0.2)]
    }]],
    ["tag_slug=fed-rates", [
      { title: "Fed Decision in October?", endDate: "2026-10-29T03:59:00Z", markets: [fedMarket("25 bps increase", 0.6), fedMarket("25 bps decrease", 0.01)] },
      { title: "Another Fed rate hike in 2026?", markets: [fedMarket("Another Fed rate hike in 2026?", 0.85)] }
    ]],
    ["daily-treasury-rates.csv", treasuryCsv],
    ["dca/ongoing-list", { code: "0", data: [{
      algoId: "bot-1", instId: "BTC-USDT-SWAP", direction: "long", state: "running", cTime: "1", ctVal: "0.01", lever: "20",
      maxSafetyOrds: "10", pxSteps: "0.004", pxStepsMult: "1", totalPnl: "-10",
      triggerParams: [{ triggerAction: "stop", triggerPx: "79000" }]
    }] }],
    ["dca/position-details", { code: "0", data: [{ avgPx: "83000", fillSafetyOrds: "2", initPx: "84000", liqPx: "75000", sz: "5", tpPx: "86000" }] }],
    ["dca/history-list", { code: "0", data: [{ algoId: "bot-1", state: "stopped" }] }],
    ["currency-sentiment-query", { code: "0", data: [{ details: [{ ccy: "BTC", sentiment: { bullishRatio: "0.5", bearishRatio: "0.2" } }] }] }]
  ];
  return async (url) => {
    const href = String(url);
    for (const [pattern, value] of Object.entries(overrides)) {
      if (href.includes(pattern)) return value === "FAIL" ? { ok: false, status: 404, json: async () => ({}), text: async () => "" } : body(value);
    }
    const route = routes.find(([pattern]) => href.includes(pattern));
    if (!route) throw new Error(`Unexpected request ${href}`);
    return body(route[1]);
  };
}

const readJson = async (directory, name) => JSON.parse(await readFile(join(directory, `${name}.json`), "utf8"));
const OKX = { OKX_API_KEY: "key", OKX_API_SECRET: "secret", OKX_API_PASSPHRASE: "phrase" };
const HOUR = 3_600_000;

// OKX UTC daily candles, newest first: completed closes through 09-30, then
// 10-01 still in progress.
function dailyCandles(closes) {
  const rows = closes.map((close, index) => [Date.parse("2026-09-30T00:00:00Z") - (closes.length - 1 - index) * 24 * HOUR, close, "1"]);
  rows.push([Date.parse("2026-10-01T00:00:00Z"), closes.at(-1), "0"]);
  return { code: "0", data: rows.reverse().map(([ts, close, confirm]) => [String(ts), "0", "0", "0", String(close), "0", "0", "0", confirm]) };
}

test("evaluates public data without OKX credentials and keeps a deduplicated history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-radar-"));
  const first = await runBtcRadar({ directory, environment: {}, fetchImpl: responses(), nowMs: NOW });
  assert.equal(first.snapshot.ts, "2026-10-01T21:00:00+08:00");
  assert.equal(first.snapshot.price, 84000);
  assert.equal(first.snapshot.position, null);
  assert.deepEqual(first.snapshot.data_status, { okxConfigured: false, algoId: null, staleSources: [] });
  assert.deepEqual(first.snapshot.factors.find(({ key }) => key === "deriv").metrics[2], ["舆情多 / 空", "未接入"]);
  assert.deepEqual(first.alert, { status: "NONE", reasons: [] });
  assert.deepEqual(first.snapshot.ladders.week.dips, { 76000: 0.05, 80000: 0.2 });
  assert.deepEqual(first.snapshot.indicators, {
    rsi14: { closed: 100, intraday: 100, date: "2026-10-01" },
    fearGreed: { value: 72, label: "贪婪", date: "2026-10-02" }
  });
  assert.equal(first.snapshot.trend, null, "40 daily closes cannot form a 200-day average");
  await runBtcRadar({ directory, environment: {}, fetchImpl: responses(), nowMs: NOW });
  await runBtcRadar({ directory, environment: {}, fetchImpl: responses(), nowMs: NOW + 4 * 3_600_000 });
  const history = await readJson(directory, "history");
  assert.deepEqual(history.map(({ ts }) => ts), ["2026-10-01T21:00:00+08:00", "2026-10-02T01:00:00+08:00"]);
  assert.deepEqual(Object.keys(history[0].f), ["poly", "fed", "ust", "gold", "tech", "deriv"]);
  assert.equal((await readJson(directory, "latest")).ts, "2026-10-02T01:00:00+08:00");
});

test("reuses the last good value of a failed source and fails without one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-radar-stale-"));
  await runBtcRadar({ directory, environment: {}, fetchImpl: responses(), nowMs: NOW });
  const later = NOW + 4 * 3_600_000;
  const { snapshot } = await runBtcRadar({
    directory, environment: {}, fetchImpl: responses({ "daily-treasury-rates.csv": "FAIL" }), nowMs: later
  });
  assert.deepEqual(snapshot.data_status.staleSources, [{ key: "treasury", label: "美债收益率", since: new Date(NOW).toISOString() }]);
  assert.deepEqual(snapshot.factors.find(({ key }) => key === "ust").metrics.at(-1), ["数据日期", "2026-09-30"]);
  const empty = await mkdtemp(join(tmpdir(), "btc-radar-empty-"));
  await assert.rejects(
    runBtcRadar({ directory: empty, environment: {}, fetchImpl: responses({ "funding-rate-history": "FAIL" }), nowMs: NOW }),
    /资金费率获取失败且没有可沿用的旧值/
  );
  await assert.rejects(readFile(join(empty, "latest.json")), { code: "ENOENT" });
});

test("shows reference indicators without scoring them and survives their outage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-radar-reference-"));
  const unavailable = { "api.alternative.me/fng": "FAIL", "bar=1Dutc": "FAIL" };
  const missing = await runBtcRadar({ directory, environment: {}, fetchImpl: responses(unavailable), nowMs: NOW });
  assert.deepEqual(missing.snapshot.indicators, { rsi14: null, fearGreed: null });
  assert.deepEqual(missing.snapshot.data_status.staleSources, []);
  const available = await runBtcRadar({ directory, environment: {}, fetchImpl: responses(), nowMs: NOW + 60_000 });
  assert.equal(available.snapshot.score, missing.snapshot.score);
  assert.deepEqual(available.snapshot.factors, missing.snapshot.factors);
  const stale = await runBtcRadar({ directory, environment: {}, fetchImpl: responses(unavailable), nowMs: NOW + 120_000 });
  assert.equal(stale.snapshot.indicators.fearGreed.value, 72);
  assert.deepEqual(stale.snapshot.data_status.staleSources.map(({ key }) => key).sort(), ["fearGreed", "rsi"]);
});

test("tracks the contract DCA bot with read-only credentials and alerts when it ends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-radar-okx-"));
  const sent = [];
  const send = async (...args) => { sent.push(args); };
  const environment = { ...OKX, FEISHU_WEBHOOK_URL: "https://open.feishu.cn/hook/test", DASHBOARD_PUBLIC_ORIGIN: "https://stocks.example.com" };
  const first = await runBtcRadar({ directory, environment, fetchImpl: responses(), nowMs: NOW, send });
  assert.equal(first.snapshot.position.avg, 83000);
  assert.equal(first.snapshot.position.sl, 79000);
  assert.equal(first.snapshot.data_status.algoId, "bot-1");
  assert.deepEqual(first.snapshot.factors.find(({ key }) => key === "deriv").metrics[2], ["舆情多 / 空", "50% / 20%"]);
  assert.equal((await readJson(directory, "state")).trackedAlgoId, "bot-1");

  const ended = await runBtcRadar({
    directory, environment, fetchImpl: responses({ "dca/ongoing-list": { code: "0", data: [] } }), nowMs: NOW + 4 * 3_600_000, send
  });
  assert.equal(ended.snapshot.position, null);
  assert.equal(ended.alert.status, "SENT");
  assert.ok(ended.alert.reasons.includes("合约马丁格尔 bot-1 已结束（stopped）"));
  const [text, uuid, sentEnvironment, , reportUrl] = sent.at(-1);
  assert.match(text, /^\[BTC 风控雷达\] ⚠️ 需要关注：/);
  assert.match(text, /看板：https:\/\/stocks\.example\.com\/btc-radar/);
  assert.match(uuid, /^[a-f0-9]{40}$/);
  assert.equal(sentEnvironment, environment);
  assert.equal(reportUrl, null);
  assert.equal((await readJson(directory, "state")).lastAlert.status, "SENT");
});

test("records an undeliverable alert without losing the evaluation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-radar-alert-"));
  const { snapshot } = await runBtcRadar({ directory, environment: {}, fetchImpl: responses(), nowMs: NOW });
  await writeFile(join(directory, "latest.json"), JSON.stringify({ ...snapshot, level: "green", level_name: "偏多 / 低风险" }));
  const skipped = await runBtcRadar({ directory, environment: {}, fetchImpl: responses(), nowMs: NOW + 60_000 });
  assert.equal(skipped.alert.status, "SKIPPED_NO_FEISHU");
  await writeFile(join(directory, "latest.json"), JSON.stringify({ ...snapshot, level: "green" }));
  const failed = await runBtcRadar({
    directory, environment: { FEISHU_WEBHOOK_URL: "https://open.feishu.cn/hook/test" }, fetchImpl: responses(), nowMs: NOW + 120_000,
    send: async () => { throw new Error("Feishu rejected request: HTTP 500"); }
  });
  assert.equal(failed.alert.status, "FAILED");
  assert.equal(failed.alert.error, "Feishu rejected request: HTTP 500");
  assert.equal((await readJson(directory, "latest")).ts, failed.snapshot.ts);
  assert.equal((await readJson(directory, "state")).lastAlert.status, "FAILED");
});

test("adopts the first trend state silently and pushes each later switch once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-radar-trend-"));
  const environment = { FEISHU_WEBHOOK_URL: "https://open.feishu.cn/hook/test", DASHBOARD_PUBLIC_ORIGIN: "https://spaceflag.site,https://173-199-122-23.sslip.io" };
  const sent = [];
  const attempts = [];
  const deliver = async (...args) => { sent.push(args); };
  const run = (closes, nowMs, send = deliver, env = environment, dir = directory) =>
    runBtcRadar({ directory: dir, environment: env, fetchImpl: responses({ "bar=1Dutc": dailyCandles(closes) }), nowMs, send });
  const rising = Array.from({ length: 299 }, (_, index) => 60000 + index * 100);
  const crash = [...rising.slice(0, -1), 70000];

  const first = await run(rising, NOW);
  assert.deepEqual(first.snapshot.trend, {
    date: "2026-09-30", close: 89800, average: 79850, distance: 0.12461, band: 0.03, state: "LONG", since: null, previous: null
  });
  assert.equal(first.trendAlert.status, "NONE");
  assert.equal((await readJson(directory, "state")).trend.notified, "LONG");

  const failed = await run(crash, NOW + 4 * HOUR, async (...args) => { attempts.push(args); throw new Error("Feishu rejected request: HTTP 500"); });
  assert.deepEqual(failed.trendAlert, { status: "FAILED", state: "AVOID", error: "Feishu rejected request: HTTP 500" });
  assert.equal((await readJson(directory, "state")).trend.notified, "LONG");

  const switched = await run(crash, NOW + 8 * HOUR);
  assert.deepEqual(switched.trendAlert, { status: "SENT", state: "AVOID" });
  assert.equal(sent.length, 1);
  const [text, uuid] = sent[0];
  assert.equal(uuid, attempts[0][1], "the retry reuses the message id so Feishu can drop a duplicate");
  assert.deepEqual(text.split("\n"), [
    "[BTC 趋势状态] 切换为回避环境",
    "2026-09-30 日收盘 70,000，低于 200 日均线 79,751 约 12.2%（切换线 ±3%）",
    "此前：多头环境",
    `参考（回测中没有稳定预测力）：雷达 ${Math.round(switched.snapshot.score)} 分（${switched.snapshot.level_name}） · 恐惧贪婪 72（贪婪） · 日线 RSI ${switched.snapshot.indicators.rsi14.closed} · 资金费率均值 0.0100%`,
    "规则：日收盘高于 200 日均线 3% 以上为多头环境，低于 3% 以下为回避环境。回避只表示不持有多头，不是做空信号。",
    "看板：https://spaceflag.site/btc-radar"
  ]);

  const again = await run(crash, NOW + 12 * HOUR);
  assert.equal(again.trendAlert.status, "NONE");
  assert.equal(sent.length, 1);
  assert.deepEqual((await readJson(directory, "state")).trend, {
    notified: "AVOID", lastAlert: { ts: switched.snapshot.ts, status: "SENT", state: "AVOID" }
  });

  const quiet = await mkdtemp(join(tmpdir(), "btc-radar-trend-quiet-"));
  await run(rising, NOW, deliver, {}, quiet);
  const skipped = await run(crash, NOW + 4 * HOUR, deliver, {}, quiet);
  assert.deepEqual(skipped.trendAlert, { status: "SKIPPED_NO_FEISHU", state: "AVOID" });
  assert.equal((await readJson(quiet, "state")).trend.notified, "AVOID");
  assert.equal(sent.length, 1);
});

test("applies the routine's important-change rules", () => {
  const position = (overrides = {}) => ({ level: "green", sl: 79000, safety_filled: 2, safety_max: 10, ...overrides });
  const snapshot = (overrides = {}) => ({ level: "yellow", level_name: "中性", price: 84000, position: position(), ...overrides });
  assert.deepEqual(btcRadarAlertReasons(snapshot(), snapshot()), []);
  assert.deepEqual(btcRadarAlertReasons(null, snapshot()), []);
  assert.deepEqual(btcRadarAlertReasons(snapshot(), snapshot({ level: "orange", level_name: "警戒" })), ["综合等级升至警戒"]);
  assert.deepEqual(btcRadarAlertReasons(snapshot({ level: "red" }), snapshot({ level: "orange" })), []);
  assert.deepEqual(btcRadarAlertReasons(snapshot(), snapshot({ position: position({ level: "red" }) })), ["持仓距止损不到 3%"]);
  assert.deepEqual(btcRadarAlertReasons(snapshot(), snapshot({ position: position({ level: "orange" }) })), ["持仓离止损不到 5%"]);
  assert.deepEqual(btcRadarAlertReasons(snapshot(), snapshot({ position: position({ safety_filled: 3 }) })), ["自动补仓增加到 3/10"]);
  assert.deepEqual(btcRadarAlertReasons(snapshot(), snapshot({ position: position({ sl: 0 }) })), ["持仓没有止损"]);
  assert.deepEqual(btcRadarAlertReasons(snapshot(), snapshot({ price: 87500 })), ["BTC 较上次评估变动 +4.2%"]);
  assert.deepEqual(
    btcRadarAlertReasons(snapshot(), snapshot(), [{ type: "STRATEGY_SWITCHED", algoId: "bot-2" }]),
    ["改为跟踪新的合约马丁格尔 bot-2"]
  );
  const text = btcRadarAlertText({
    score: 63.4, level_name: "警戒", price: 83555.9,
    factors: [{ name: "A", score: 90, weight: 20 }, { name: "B", score: 80, weight: 20 }, { name: "C", score: 99, weight: 10 }],
    position: { d_sl: -4.61, d_liq: -12.51, d_tp: 1.13, total_pnl: -12.35, safety_filled: 6, safety_max: 10 }
  }, ["综合等级升至警戒"], { DASHBOARD_PUBLIC_ORIGIN: "http://127.0.0.1:4173" });
  assert.equal(text, [
    "[BTC 风控雷达] ⚠️ 需要关注：综合等级升至警戒",
    "综合 63 分（警戒），主要压力：A、B",
    "现价 83,556；距止损 -4.61%，距强平 -12.51%，距止盈 +1.13%",
    "策略总收益 -12.35 USDT · 补仓 6/10"
  ].join("\n"));
  assert.match(
    btcRadarAlertText({ score: 63.4, level_name: "警戒", price: 83555.9, factors: [], position: null }, ["综合等级升至警戒"], {
      DASHBOARD_PUBLIC_ORIGIN: "https://stocks.example.com, https://www.stocks.example.com"
    }),
    /\n看板：https:\/\/stocks\.example\.com\/btc-radar$/
  );
});

test("serves saved radar data with an explicit availability status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-radar-view-"));
  assert.deepEqual(await loadBtcRadarView(directory), { status: "MISSING", latest: null, history: [], settings: {} });
  await writeFile(join(directory, "latest.json"), JSON.stringify({ ts: "2026-10-01T21:00:00+08:00", score: 60 }));
  await writeFile(join(directory, "history.json"), JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ ts: String(index) }))));
  const view = await loadBtcRadarView(directory);
  assert.equal(view.status, "AVAILABLE");
  assert.equal(view.latest.score, 60);
  assert.equal(view.history.length, 180);
  assert.equal(view.history[0].ts, "20");
  await writeFile(join(directory, "latest.json"), "{");
  assert.deepEqual(await loadBtcRadarView(directory), { status: "ERROR", latest: null, history: [], settings: {} });
});

test("stores the total capital used for the page's loss share and rejects bad input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-radar-settings-"));
  assert.deepEqual(await loadBtcRadarSettings(directory), {});
  assert.deepEqual(await saveBtcRadarSettings(directory, { capitalUsdt: "5000.456" }, NOW), { capitalUsdt: 5000.46, updatedAt: new Date(NOW).toISOString() });
  assert.equal((await loadBtcRadarView(directory)).settings.capitalUsdt, 5000.46);
  for (const capitalUsdt of [0, -1, "abc", 2e9, true]) {
    await assert.rejects(saveBtcRadarSettings(directory, { capitalUsdt }), (error) => error.statusCode === 400);
  }
  assert.equal((await loadBtcRadarSettings(directory)).capitalUsdt, 5000.46);
  assert.deepEqual(await saveBtcRadarSettings(directory, { capitalUsdt: null }), {});
  assert.deepEqual(await loadBtcRadarSettings(directory), {});
});
