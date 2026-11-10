import assert from "node:assert/strict";
import test from "node:test";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { weeklyEtfDefensiveSignal, WEEKLY_ETF_ROTATION_UNIVERSE } from "../src/weekly-etf-rotation-paper.mjs";
import { weeklySgovSignal, runWeeklySgovBacktest, reconcileWeeklySgov } from "../scripts/weekly-sgov-study.mjs";

function history() {
  return researchTradingDates("2026-07-01", "2026-10-22").map((date, i) => ({ date,
    prices: Object.fromEntries(["QQQ", "SPY", "SGOV"].map((ticker, j) => [ticker,
      { open: 100 + i * [0.03, 0.02, 0.1][j], close: 100 + i * [0.03, 0.02, 0.1][j] }])) }));
}
const input = () => ({ rows: history(), startDate: "2026-09-21", endDate: "2026-10-22",
  rule: "CURRENT", initialCapitalUsd: 100, roundTripCostPct: 0, gasPerSideUsd: 0, buyDelaySessions: 0 });

test("current signal exactly matches the production QQQ/SPY defensive universe", () => {
  const rows = history(), index = rows.findIndex(r => r.date === "2026-09-21");
  const series = Object.fromEntries(["QQQ", "SPY", "SGOV"].map(ticker => [ticker,
    rows.slice(0, index).map(r => ({ date: r.date, close: r.prices[ticker].close }))]));
  const actual = weeklySgovSignal(rows, index, "CURRENT");
  const expected = weeklyEtfDefensiveSignal(series, {}, WEEKLY_ETF_ROTATION_UNIVERSE);
  assert.equal(actual.target, expected.target);
  for (const asset of expected.allRiskAssets) {
    const measured = actual.allRiskAssets.find(x => x.ticker === asset.ticker);
    assert.ok(Math.abs(measured.momentum * 100 - asset.momentumPct) < 1e-10);
    assert.ok(Math.abs(measured.rsi - asset.rsi) < 1e-10);
  }
});

test("strict risk-versus-SGOV gate rejects weaker and equal positive momentum", () => {
  const rows = history(), index = rows.findIndex(r => r.date === "2026-09-21");
  assert.equal(weeklySgovSignal(rows, index, "CURRENT").target, "QQQ");
  assert.equal(weeklySgovSignal(rows, index, "BEAT_SGOV").target, "SGOV");
  for (const row of rows) row.prices.QQQ = { ...row.prices.SGOV };
  assert.equal(weeklySgovSignal(rows, index, "BEAT_SGOV").target, "SGOV");
});

test("future prices do not alter frozen signals or earlier equity", () => {
  const left = input(), right = input();
  for (const row of right.rows.filter(r => r.date >= "2026-10-05")) row.prices.QQQ = { open: 500, close: 500 };
  const a = runWeeklySgovBacktest(left), b = runWeeklySgovBacktest(right);
  assert.deepEqual(a.decisions.filter(d => d.date <= "2026-10-05"), b.decisions.filter(d => d.date <= "2026-10-05"));
  assert.deepEqual(a.equityCurve.filter(d => d.date < "2026-10-05"), b.equityCurve.filter(d => d.date < "2026-10-05"));
});

test("three-session lag waits in cash until Thursday and never uses Thursday for Monday's signal", () => {
  const result = runWeeklySgovBacktest({ ...input(), buyDelaySessions: 3 });
  const first = result.trades[0];
  assert.equal(first.date, "2026-09-24");
  assert.equal(first.signalDate, "2026-09-18");
  assert.equal(first.ticker, "QQQ");
  assert.ok(result.equityCurve.slice(0, 3).every(r => r.holding === "CASH" && r.equityUsd === 100));
});

test("holiday weeks count actual sessions instead of calendar days", () => {
  const result = runWeeklySgovBacktest({ ...input(), startDate: "2026-09-08", buyDelaySessions: 3 });
  assert.equal(result.decisions[0].date, "2026-09-08");
  assert.equal(result.trades[0].date, "2026-09-11");
});

test("fixed gas and percentage fees reconcile both sides and terminal liquidation", () => {
  const result = runWeeklySgovBacktest({ ...input(), rule: "SGOV_HOLD", roundTripCostPct: 0.8, gasPerSideUsd: 0.05 });
  assert.equal(result.trades.length, 2);
  for (const trade of result.trades) {
    assert.ok(Math.abs(trade.costUsd - trade.notionalUsd * 0.004 - 0.05) < 1e-10);
  }
  assert.equal(result.trades.at(-1).reason, "TERMINAL_LIQUIDATION");
  assert.equal(result.equityCurve.at(-1).holding, "CASH");
  assert.equal(reconcileWeeklySgov(result, input().rows), true);
  const broken = structuredClone(result); broken.equityCurve[3].equityUsd += 1;
  assert.throws(() => reconcileWeeklySgov(broken, input().rows), /equity/i);
});

test("the risk-matched SGOV benchmark preserves cash; full-SGOV is separately labeled", () => {
  const half = runWeeklySgovBacktest({ ...input(), rule: "SGOV_HOLD" });
  const full = runWeeklySgovBacktest({ ...input(), rule: "SGOV_FULL" });
  assert.equal(half.trades[0].notionalUsd, 50);
  assert.equal(full.trades[0].notionalUsd, 100);
  assert.ok(half.equityCurve.slice(0, -1).every(r => r.cashUsd === 50));
  assert.ok(full.metrics.netPnlUsd > half.metrics.netPnlUsd);
});

test("daily loss cap defers a losing weekly rotation's buy to the next session", () => {
  const config = input();
  for (const row of config.rows) row.prices.SPY = { open: 100, close: 100 };
  for (const row of config.rows.filter(r => r.date >= "2026-09-28")) row.prices.QQQ = { open: 95, close: 95 };
  const result = runWeeklySgovBacktest(config);
  const sell = result.trades.find(t => t.side === "SELL" && t.reason === "REBALANCE");
  const buy = result.trades.find(t => t.side === "BUY" && t.ticker === "SGOV");
  assert.ok(sell.realizedPnlUsd < -2);
  assert.equal(buy.date, "2026-10-06");
  assert.equal(sell.date, "2026-10-05");
});

test("close stop waits for next open, permits gaps, and blocks same-week reentry", () => {
  const config = input();
  config.rows.find(r => r.date === "2026-09-22").prices.QQQ.close = 85;
  config.rows.find(r => r.date === "2026-09-23").prices.QQQ = { open: 80, close: 80 };
  const result = runWeeklySgovBacktest(config);
  const sell = result.trades.find(t => t.reason === "CLOSE_TRIGGER_NEXT_OPEN_STOP_PROXY");
  assert.equal(sell.date, "2026-09-23");
  assert.equal(sell.price, 80);
  assert.ok(!result.trades.some(t => t.side === "BUY" && t.date > sell.date && t.date < "2026-09-28"));
});

test("last-day pending buy creates no out-of-range trade; missing sessions fail closed", () => {
  const result = runWeeklySgovBacktest({ ...input(), endDate: "2026-09-22", buyDelaySessions: 3 });
  assert.equal(result.trades.length, 0);
  const config = input(); config.rows = config.rows.filter(r => r.date !== "2026-09-22");
  assert.throws(() => runWeeklySgovBacktest(config), /session/i);
});

test("observed-week-only lag preserves every preceding signal and fill", () => {
  const config = input();
  for (const row of config.rows) row.prices.SPY = { open: 100, close: 100 };
  for (const row of config.rows.filter(r => r.date >= "2026-10-12")) row.prices.QQQ = { open: 101, close: 101 };
  const normal = runWeeklySgovBacktest(config);
  const observed = runWeeklySgovBacktest({ ...config, buyDelayByWeek: { "2026-10-19": 3 } });
  assert.deepEqual(normal.trades.filter(t => t.date < "2026-10-19"), observed.trades.filter(t => t.date < "2026-10-19"));
  const sell = observed.trades.find(t => t.side === "SELL" && t.reason === "REBALANCE");
  const buy = observed.trades.find(t => t.side === "BUY" && t.ticker === "SGOV");
  assert.equal(sell.date, "2026-10-19");
  assert.equal(buy.date, "2026-10-22");
});
