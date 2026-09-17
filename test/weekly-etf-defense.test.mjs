import assert from "node:assert/strict";
import test from "node:test";
import { WEEKLY_ETF_DEFENSIVE_STRATEGY_ID, weeklyEtfDefensiveSignal, weeklyEtfRotationSignal,
  initialWeeklyEtfRotationPaperState, advanceWeeklyEtfRotationPaper } from "../src/weekly-etf-rotation-paper.mjs";

const rows = (slope) => Array.from({ length: 30 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), close: 100 + slope * i
}));
const series = (risk, bond) => Object.fromEntries(["QQQ", "IWM", "DGRW", "SPY", "SGOV"]
  .map((ticker) => [ticker, rows(ticker === "SGOV" ? bond : risk)]));
const snapshot = (target, week = "2026-09-21") => ({
  at: `${week}T14:00:00Z`, sessionDate: week, week, regularOpen: true,
  decision: { target, signalDate: "2026-09-18" }, prices: { QQQ: 100 }
});
const initial = () => ({ ...initialWeeklyEtfRotationPaperState(), strategyId: WEEKLY_ETF_DEFENSIVE_STRATEGY_ID });

test("zero momentum passes original RSI but enhanced strategy holds cash", () => {
  assert.notEqual(weeklyEtfRotationSignal(series(0, 0)).target, "SGOV");
  assert.equal(weeklyEtfDefensiveSignal(series(0, 0)).target, "CASH");
});
test("positive risk momentum wins; positive bonds defend only when risk fails", () => {
  assert.notEqual(weeklyEtfDefensiveSignal(series(1, -1)).target, "CASH");
  assert.equal(weeklyEtfDefensiveSignal(series(-1, 1)).target, "SGOV");
  assert.equal(weeklyEtfDefensiveSignal(series(-1, -1)).target, "CASH");
});
test("missing or misaligned SGOV fails closed", () => {
  const data = series(-1, 1);
  delete data.SGOV;
  assert.throws(() => weeklyEtfDefensiveSignal(data), /SGOV/);
  data.SGOV = rows(1).slice(0, -1);
  assert.throws(() => weeklyEtfDefensiveSignal(data), /align/);
});
test("cash has no entry costs and weekly repeat cannot trade", () => {
  const result = advanceWeeklyEtfRotationPaper(initial(), snapshot("CASH"));
  assert.equal(result.state.equityUsdt, 50);
  assert.equal(result.state.totalCostUsdt, 0);
  const repeated = advanceWeeklyEtfRotationPaper(result.state, snapshot("QQQ"));
  assert.equal(repeated.state.position, null);
});
test("stock to cash charges sell only, reconciles equity, and can reenter", () => {
  const opened = advanceWeeklyEtfRotationPaper(initial(), snapshot("QQQ")).state;
  const cash = advanceWeeklyEtfRotationPaper(opened, snapshot("CASH", "2026-09-28")).state;
  assert.ok(Math.abs(cash.equityUsdt - 49.50125) < 1e-8);
  assert.ok(Math.abs(cash.totalCostUsdt - 0.49875) < 1e-8);
  assert.equal(cash.position, null);
  assert.equal(cash.trades.length, 1);
  const reentered = advanceWeeklyEtfRotationPaper(cash, snapshot("QQQ", "2026-10-05")).state;
  assert.equal(reentered.position.symbol, "QQQ");
  assert.equal(reentered.cashUsdt, 0);
});
test("baseline cannot select cash; closed market or absent decision cannot open", () => {
  assert.throws(() => advanceWeeklyEtfRotationPaper(initialWeeklyEtfRotationPaperState(), snapshot("CASH")), /Invalid/);
  assert.equal(advanceWeeklyEtfRotationPaper(initial(), { ...snapshot("QQQ"), regularOpen: false }).state.position, null);
  assert.equal(advanceWeeklyEtfRotationPaper(initial(), { ...snapshot("QQQ"), decision: null }).state.position, null);
});
