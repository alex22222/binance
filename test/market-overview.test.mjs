import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASSETS, collectMarketOverview, loadMarketOverview, runMarketOverview } from "../src/market-overview.mjs";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const DAY = 86_400_000;
function chart(asset, { closes, adjusted, intraday = false } = {}) {
  const crypto = asset.symbol === "BTC-USD", vix = asset.symbol === "^VIX";
  const stamps = [];
  let date = Date.parse(crypto ? "2026-11-08T00:00:00Z" : intraday ? "2026-11-09T14:30:00Z" : "2026-11-06T14:30:00Z");
  while (stamps.length < 260) {
    if (crypto || ![0, 6].includes(new Date(date).getUTCDay())) stamps.unshift(date / 1000);
    date -= DAY;
  }
  const values = closes || stamps.map((_, index) => 100 + index);
  const periodStart = stamps.at(-1), periodEnd = periodStart + (crypto ? DAY - 60_000 : 6.5 * 3_600_000) / 1000;
  return { chart: { result: [{ meta: { symbol: asset.symbol, currency: "USD", instrumentType: crypto ? "CRYPTOCURRENCY" : vix ? "INDEX" : "ETF",
    exchangeTimezoneName: crypto ? "UTC" : vix ? "America/Chicago" : "America/New_York", regularMarketPrice: values.at(-1),
    regularMarketTime: crypto ? NOW / 1000 : intraday ? periodStart + 3_600 : periodEnd,
    currentTradingPeriod: { regular: { start: periodStart, end: periodEnd } } }, timestamp: stamps,
    indicators: { quote: [{ close: values }], adjclose: [{ adjclose: adjusted || values }] } }], error: null } };
}
function responses(overrides = {}) {
  let active = 0, maximum = 0;
  const fetchImpl = async (href, options) => {
    assert.equal(options.method, "GET");
    assert.equal(new URL(href).origin, "https://query1.finance.yahoo.com");
    const symbol = decodeURIComponent(new URL(href).pathname.split("/").at(-1));
    const asset = ASSETS.find(row => row.symbol === symbol);
    assert.ok(asset, "only the fixed universe is queried");
    assert.equal(new URL(href).searchParams.get("interval"), "1d");
    active += 1; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
    if (overrides[symbol] === "FAIL") throw new Error("offline");
    const payload = typeof overrides[symbol] === "function" ? overrides[symbol](chart(asset), asset) : overrides[symbol] || chart(asset);
    return new Response(JSON.stringify(payload));
  };
  fetchImpl.maximum = () => maximum;
  return fetchImpl;
}

test("collects every fixed asset with explicit source times, adjusted returns and bounded concurrency", async () => {
  const fetchImpl = responses();
  const report = await collectMarketOverview({ fetchImpl, now: NOW });
  assert.equal(report.status, "OK");
  assert.equal(report.assets.length, 17);
  assert.equal(report.signals.length, 3);
  assert.ok(fetchImpl.maximum() <= 3);
  const spy = report.assets.find(row => row.symbol === "SPY");
  assert.equal(spy.price, 359);
  assert.equal(spy.asOf, "2026-11-06T21:00:00.000Z");
  assert.equal(spy.fetchedAt, new Date(NOW).toISOString());
  assert.equal(spy.returnBasis, "adjusted_total_return");
  assert.equal(spy.sessionState, "CLOSED");
  assert.ok(Math.abs(spy.change5d - (359 / 354 - 1) * 100) < 1e-9);
  assert.equal(report.assets.find(row => row.id === "btc").intraday, true);
  assert.equal(report.assets.find(row => row.id === "btc").returnBasis, "price_return");
});

test("a split or dividend never appears as an artificial loss in ETF strength", async () => {
  const split = await collectMarketOverview({ now: NOW, fetchImpl: responses({ SPY: (body) => {
    const row = body.chart.result[0];
    row.indicators.quote[0].close = row.timestamp.map((_, index) => index < 259 ? 100 : 50);
    row.indicators.adjclose[0].adjclose = row.timestamp.map(() => 50);
    row.meta.regularMarketPrice = 50;
    return body;
  }, QQQ: body => {
    const row = body.chart.result[0];
    row.indicators.quote[0].close = row.timestamp.map((_, index) => index < 259 ? 100 : 99);
    row.indicators.adjclose[0].adjclose = row.timestamp.map(() => 99);
    row.meta.regularMarketPrice = 99;
    return body;
  } }) });
  for (const symbol of ["SPY", "QQQ"]) assert.equal(split.assets.find(row => row.symbol === symbol).change1d, 0);
});

test("model averages use closed adjusted observations and expose a capped hypothetical volatility budget", async () => {
  const closes = Array.from({ length: 260 }, (_, index) => 100 * Math.exp(index * 0.001 + (index % 2 ? 0.01 : 0)));
  closes[259] *= 0.90;
  const report = await collectMarketOverview({ now: NOW, fetchImpl: responses({ SPY: chart(ASSETS[0], { closes }) }) });
  const signal = report.signals.find(row => row.symbol === "SPY");
  assert.equal(signal.modelOnly, true);
  assert.equal(signal.targetVolPct, 10);
  assert.ok(signal.RV20Pct > signal.RV20PreviousPct);
  assert.ok(signal.targetExposurePct < signal.previousExposurePct);
  assert.ok(signal.targetExposurePct >= 0 && signal.targetExposurePct <= 100);
  assert.ok(Math.abs(signal.RV20ChangePp - (signal.RV20Pct - signal.RV20PreviousPct)) < 1e-9);
  assert.ok(Math.abs(signal.ma20 - closes.slice(-20).reduce((sum, value) => sum + value, 0) / 20) < 1e-9);
  assert.equal(signal.direction20, "DOWN");
  const flat = await collectMarketOverview({ now: NOW, fetchImpl: responses({ SPY: chart(ASSETS[0], { closes: Array(260).fill(100) }) }) });
  assert.equal(flat.signals[0].targetExposurePct, null, "zero measured risk cannot imply a meaningful risk budget");
});

test("an unfinished session may update strength but cannot enter the closed-day model", async () => {
  const monday = Date.parse("2026-11-09T16:00:00Z");
  const report = await collectMarketOverview({ now: monday, fetchImpl: responses(Object.fromEntries(ASSETS.filter(row => row.symbol !== "BTC-USD").map(asset => [asset.symbol, () => {
    const body = chart(asset, { intraday: true });
    body.chart.result[0].meta.regularMarketTime = monday / 1000;
    body.chart.result[0].indicators.quote[0].close[259] = 1000;
    body.chart.result[0].indicators.adjclose[0].adjclose[259] = 1000;
    return body;
  }]))) });
  const spy = report.assets.find(row => row.symbol === "SPY"), signal = report.signals[0];
  assert.equal(spy.intraday, true);
  assert.equal(spy.sessionState, "REGULAR");
  assert.equal(signal.asOf, spy.history.at(-2).time);
  assert.ok(signal.ma20 < 400, "the 1000 unfinished quote is excluded");
});

test("a new quote cannot relabel previous-session daily returns as current strength", async () => {
  const monday = Date.parse("2026-11-09T16:00:00Z");
  const report = await collectMarketOverview({ now: monday, fetchImpl: responses({ SPY: body => {
    const row = body.chart.result[0];
    row.meta.regularMarketPrice = 1000;
    row.meta.regularMarketTime = monday / 1000;
    row.meta.currentTradingPeriod.regular = { start: Date.parse("2026-11-09T14:30:00Z") / 1000, end: Date.parse("2026-11-09T21:00:00Z") / 1000 };
    return body;
  } }) });
  const spy = report.assets[0], signal = report.signals[0];
  assert.equal(spy.price, 1000);
  assert.equal(spy.asOf, new Date(monday).toISOString());
  assert.equal(spy.returnsAsOf, "2026-11-06T14:30:00.000Z");
  assert.equal(spy.status, "PARTIAL");
  assert.match(spy.error, /报价.*日线.*不同步/);
  for (const key of ["change1d", "change5d", "change20d"]) assert.equal(spy[key], null);
  assert.equal(spy.history.at(-1).close, 359);
  assert.equal(signal.asOf, spy.returnsAsOf);
  assert.ok(signal.ma20 < 400, "the historical model remains bound to Friday's confirmed close");
});

test("identity, future, duplicate, reversed and missing-adjustment data fail visibly", async () => {
  const invalid = [body => { body.chart.result[0].meta.symbol = "OTHER"; return body; }, body => { body.chart.result[0].meta.regularMarketTime = NOW / 1000 + 301; return body; }, body => { body.chart.result[0].timestamp[2] = body.chart.result[0].timestamp[1]; return body; }, body => { body.chart.result[0].timestamp.reverse(); return body; }, body => { delete body.chart.result[0].indicators.adjclose; return body; }, body => { body.chart.result[0].indicators.quote[0].close[10] = -1; return body; }];
  for (const corrupt of invalid) {
    const report = await collectMarketOverview({ now: NOW, fetchImpl: responses({ SPY: corrupt }) });
    const row = report.assets[0];
    assert.equal(row.status, "FAILED");
    assert.equal(row.price, null);
    assert.equal(row.history.length, 0);
    assert.equal(report.status, "PARTIAL");
  }
});

test("old missing points are retained without a permanent warning, while an affected current window is partial", async () => {
  const old = await collectMarketOverview({ now: NOW, fetchImpl: responses({ "^VIX": body => { body.chart.result[0].indicators.quote[0].close[0] = null; return body; } }) });
  const row = old.assets.find(row => row.symbol === "^VIX");
  assert.equal(row.history[0].close, null);
  assert.equal(row.missingHistoryCount, 1);
  assert.equal(row.status, "OK");
  const current = await collectMarketOverview({ now: NOW, fetchImpl: responses({ SPY: body => { body.chart.result[0].indicators.adjclose[0].adjclose[258] = null; return body; } }) });
  assert.equal(current.assets[0].status, "PARTIAL");
  assert.equal(current.assets[0].change1d, null);
  assert.equal(current.signals[0].ma200, null, "a missing model observation is never silently dropped");
});

test("failed sources retain exact previous times and never replace a good asset with a fabricated zero", async () => {
  const first = await collectMarketOverview({ now: NOW, fetchImpl: responses() });
  const second = await collectMarketOverview({ now: NOW + 900_000, previous: first, fetchImpl: responses({ SPY: "FAIL" }) });
  assert.equal(second.assets[0].status, "CACHED");
  assert.equal(second.assets[0].asOf, first.assets[0].asOf);
  assert.equal(second.assets[0].fetchedAt, first.assets[0].fetchedAt);
  assert.equal(second.assets[0].lastAttemptAt, new Date(NOW + 900_000).toISOString());
  assert.equal(second.signals[0].status, "CACHED");
  const bad = structuredClone(first);
  bad.assets[0].symbol = "OTHER";
  const rejected = await collectMarketOverview({ now: NOW, previous: bad, fetchImpl: responses({ SPY: "FAIL" }) });
  assert.equal(rejected.assets[0].status, "FAILED");
  assert.equal(rejected.assets[0].price, null);
});

test("stale observations and oversized responses cannot look current", async () => {
  const stale = await collectMarketOverview({ now: NOW + 10 * DAY, fetchImpl: responses() });
  assert.equal(stale.status, "FAILED");
  assert.ok(stale.assets.every(row => row.status === "FAILED"));
  const tooLarge = await collectMarketOverview({ now: NOW, fetchImpl: async () => new Response("x".repeat(2_000_001)) });
  assert.equal(tooLarge.status, "FAILED");
});

test("persistence preserves latest on total failure, reports the failed attempt and detects missing/corrupt state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-overview-"));
  assert.equal((await loadMarketOverview(directory, { now: NOW })).status, "MISSING");
  const first = await runMarketOverview({ directory, now: NOW, fetchImpl: responses() });
  const saved = await readFile(join(directory, "latest.json"), "utf8");
  assert.equal((await loadMarketOverview(directory, { now: NOW })).assets.length, 17);
  const allFailures = Object.fromEntries(ASSETS.map(row => [row.symbol, "FAIL"]));
  await runMarketOverview({ directory, now: NOW + 900_000, fetchImpl: responses(allFailures) });
  assert.equal(await readFile(join(directory, "latest.json"), "utf8"), saved);
  const view = await loadMarketOverview(directory, { now: NOW + 900_000 });
  assert.equal(view.status, "FAILED");
  assert.equal(view.generatedAt, first.generatedAt);
  assert.equal(view.lastAttempt.status, "FAILED");
  assert.equal(view.assets[0].status, "CACHED");
  assert.equal(view.assets[0].fetchedAt, first.assets[0].fetchedAt);
  assert.equal((await loadMarketOverview(directory, { now: NOW + 3_600_000 })).stale, true);
  await writeFile(join(directory, "latest.json"), "{");
  assert.equal((await loadMarketOverview(directory, { now: NOW })).status, "ERROR");
});

test("the whole collector is locked before issuing any network requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-overview-lock-"));
  await writeFile(join(directory, "collector.lock"), JSON.stringify({ pid: process.pid, owner: "another-run" }));
  let calls = 0;
  await assert.rejects(runMarketOverview({ directory, now: NOW, fetchImpl: async () => { calls += 1; } }), /already running/);
  assert.equal(calls, 0);
});
