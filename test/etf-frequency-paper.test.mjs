import assert from "node:assert/strict";
import test from "node:test";
import { advanceFrequencyPaper, frequencyPaperDecisions, initialFrequencyPaper, FREQUENCY_PAPER_SPEC } from "../src/etf-frequency-paper.mjs";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { studySignal } from "../scripts/etf-pool-study.mjs";

const start = "2026-10-09T14:00:00Z";
const initial = () => initialFrequencyPaper(start);
const snapshot = (date, targets = {}, prices = { QQQ: 100, SPY: 100, SGOV: 100 }) => ({
  at: `${date}T14:00:00Z`, sessionDate: date, regularOpen: true, targets, prices,
  observedAt: `${date}T13:59:59Z`, sourceHash: "a".repeat(64)
});

test("fixed matrix has eight rules and matched SPY benchmark at each cost level", () => {
  const state = initial();
  assert.equal(state.experiments.length, 27);
  assert.deepEqual([...new Set(state.experiments.filter(e => e.frequency === "M").map(e => e.momentumDays))], [20, 63, 126, 252]);
  assert.equal(FREQUENCY_PAPER_SPEC.automaticTradingEligible, false);
  assert.equal(state.experiments.find(e => e.frequency === "M").eligibleFrom, "2026-11-02");
  assert.equal(state.experiments.find(e => e.frequency === "W").eligibleFrom, "2026-10-12");
});

test("no backfill, no repeat turnover and flat-price immediate exit includes both sides and fixed gas", () => {
  const targets = { "W-20": "QQQ", "M-20": "QQQ" };
  const early = advanceFrequencyPaper(initial(), snapshot("2026-10-09", targets));
  assert.ok(early.experiments.every(e => !e.position));
  const opened = advanceFrequencyPaper(early, snapshot("2026-10-12", targets));
  const ledger = opened.experiments.find(e => e.id === "W-20-base");
  assert.equal(ledger.trades.length, 1);
  assert.ok(Math.abs(ledger.liquidationEquityUsdt - 49.825118125) < 1e-8);
  assert.equal(opened.experiments.find(e => e.id === "M-20-base").position, null);
  const repeated = advanceFrequencyPaper(opened, snapshot("2026-10-12", targets));
  assert.equal(repeated.experiments.find(e => e.id === ledger.id).totalCostUsdt, ledger.totalCostUsdt);
  assert.equal(repeated.experiments.find(e => e.id === ledger.id).trades.length, 1);
  assert.equal(JSON.stringify(repeated).includes("LIVE_TERMINAL"), false);
});

test("8% proxy stop exits and does not reopen in the same period", () => {
  const opened = advanceFrequencyPaper(initial(), snapshot("2026-10-12", { "W-20": "QQQ" }));
  const stopped = advanceFrequencyPaper(opened, snapshot("2026-10-13", { "W-20": "QQQ" }, { QQQ: 90, SPY: 100, SGOV: 100 }));
  const ledger = stopped.experiments.find(e => e.id === "W-20-base");
  assert.equal(ledger.position, null);
  assert.equal(ledger.trades.at(-1).reason, "DISASTER_STOP_PROXY");
  assert.equal(ledger.closedTrades, 1);
  assert.ok(ledger.realizedPnlUsdt < -5);
  assert.equal(advanceFrequencyPaper(stopped, snapshot("2026-10-13", { "W-20": "QQQ" })).experiments.find(e => e.id === ledger.id).position, null);
});

test("monthly calendar catches a holiday start but never trades an ordinary day", () => {
  let state = initial();
  state = advanceFrequencyPaper(state, snapshot("2026-11-02", { "M-252": "QQQ" }));
  assert.equal(state.experiments.find(e => e.id === "M-252-base").position.symbol, "QQQ");
  state = advanceFrequencyPaper(state, snapshot("2026-11-03", { "M-252": "SPY" }));
  assert.equal(state.experiments.find(e => e.id === "M-252-base").position.symbol, "QQQ");
});

test("changed specification and stale proxy marks fail closed before any ledger mutation", () => {
  const state = initial();
  assert.throws(() => advanceFrequencyPaper({ ...state, specificationHash: "invalid" }, snapshot("2026-10-12")), /specification/);
  assert.throws(() => advanceFrequencyPaper(state, { ...snapshot("2026-10-12"), observedAt: "2026-10-09T19:59:00Z" }), /Stale/);
  assert.ok(state.experiments.every(e => !e.position));
  const tampered = structuredClone(state); tampered.experiments[0].ruleId = "W-252";
  assert.throws(() => advanceFrequencyPaper(tampered, snapshot("2026-10-12", { "W-252": "QQQ" })), /specification/);
});

test("missed first-week session does not backfill either rules or the matched benchmark", () => {
  const state = advanceFrequencyPaper(initial(), snapshot("2026-10-13", { "W-20": "QQQ" }));
  assert.ok(state.experiments.every(ledger => !ledger.position));
});

test("all lookbacks use completed aligned trading dates; missing, duplicate and partial input cannot produce a target", () => {
  const dates = researchTradingDates("2025-01-01", "2026-10-09");
  const series = Object.fromEntries(["QQQ", "SPY", "SGOV"].map(t => [t, dates.map((date, i) => ({ date, close: 100 + i }))]));
  const decisions = frequencyPaperDecisions(series, "2026-10-12");
  assert.equal(decisions["M-252"].signalDate, "2026-10-09");
  assert.equal(decisions["W-63"].target, decisions["M-63"].target);
  const aligned = dates.map((date, i) => ({ date, prices: Object.fromEntries(["QQQ", "SPY", "SGOV"].map(t => [t, { close: series[t][i].close }])) }));
  aligned.push({ date: "2026-10-12", prices: {} });
  for (const days of [20, 63, 126, 252]) {
    const historical = studySignal(aligned, aligned.length - 1, ["QQQ", "SPY"], days);
    assert.equal(decisions[`M-${days}`].target, historical.target);
    assert.ok(Math.abs(decisions[`M-${days}`].allRiskAssets[0].rsi - historical.allRiskAssets[0].rsi) < 1e-9);
  }
  const missing = structuredClone(series); missing.QQQ.splice(-10, 1);
  assert.throws(() => frequencyPaperDecisions(missing, "2026-10-12"), /coverage/);
  const duplicate = structuredClone(series); duplicate.SPY.push(duplicate.SPY.at(-1));
  assert.throws(() => frequencyPaperDecisions(duplicate, "2026-10-12"), /coverage/);
  const partial = structuredClone(series); partial.SGOV.push({ date: "2026-10-12", close: 9999 });
  assert.throws(() => frequencyPaperDecisions(partial, "2026-10-12"), /completed/);
});
