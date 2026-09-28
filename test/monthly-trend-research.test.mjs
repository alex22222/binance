import assert from "node:assert/strict";
import test from "node:test";
import {
  MONTHLY_RESEARCH_SPEC,
  monthlyTrendDecision,
  backtestResearchStrategy,
  buildMonthlyResearchReport
} from "../src/monthly-trend-research.mjs";

function history() {
  const rows = [];
  for (let time = Date.parse("2020-01-01"); time <= Date.parse("2022-12-30"); time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    if ([0, 6].includes(new Date(time).getUTCDay())) continue;
    const price = 100 + rows.length / 10;
    rows.push({ date, prices: Object.fromEntries(["VTI", "SGOV", "QQQ", "SPY", "VTV"].map((ticker) => [
      ticker, { open: ticker === "SGOV" ? 100 : price, close: ticker === "SGOV" ? 100 : price }
    ])) });
  }
  return rows;
}

test("A1 uses ten completed month ends and cannot observe execution-day prices", () => {
  const rows = history();
  const index = rows.findIndex(({ date }) => date === "2021-02-01");
  const signal = monthlyTrendDecision(rows, index, "A1");
  assert.equal(signal.signalDate, "2021-01-29");
  assert.equal(signal.executionDate, "2021-02-01");
  assert.equal(signal.target, "VTI");
  assert.equal(signal.inputs.length, 10);
  rows[index].prices.VTI = { open: 1, close: 1 };
  assert.deepEqual(monthlyTrendDecision(rows, index, "A1"), signal);
  assert.equal(monthlyTrendDecision(rows, index + 1, "A1"), null);
});

test("A1 equality is defensive; A2 needs thirteen aligned month ends without synthetic SGOV", () => {
  const rows = history();
  for (const row of rows) row.prices.VTI = { open: 100, close: 100 };
  const index = rows.findIndex(({ date }) => date === "2021-03-01");
  assert.equal(monthlyTrendDecision(rows, index, "A1").target, "SGOV");
  assert.equal(monthlyTrendDecision(rows, index, "A2").target, "SGOV");
  delete rows.find(({ date }) => date === "2020-07-31").prices.SGOV;
  assert.equal(monthlyTrendDecision(rows, index, "A2").target, null);
  assert.ok(monthlyTrendDecision(rows, index, "A2").reasons.includes("MISSING_MONTH_END_PRICE"));
});

test("missing months and partial first month cannot shorten warmup", () => {
  const rows = history().filter(({ date }) => !date.startsWith("2020-08"));
  const index = rows.findIndex(({ date }) => date === "2021-02-01");
  assert.equal(monthlyTrendDecision(rows, index, "A1").target, null);
  assert.ok(monthlyTrendDecision(rows, index, "A1").reasons.includes("NON_CONSECUTIVE_MONTHS"));
  const partial = history().filter(({ date }) => date >= "2020-01-20");
  assert.equal(monthlyTrendDecision(partial, partial.findIndex(({ date }) => date === "2020-11-02"), "A1").target, null);
});

test("a missing last or first session cannot shift a month-end decision to a convenient date", () => {
  const missingClose = history().filter(({ date }) => date !== "2021-01-29");
  const closeDecision = monthlyTrendDecision(missingClose, missingClose.findIndex(({ date }) => date === "2021-02-01"), "A1");
  assert.equal(closeDecision.target, null);
  assert.ok(closeDecision.reasons.includes("MISSING_MONTH_END_SESSION"));
  const missingOpen = history().filter(({ date }) => date !== "2021-02-01");
  const openDecision = monthlyTrendDecision(missingOpen, missingOpen.findIndex(({ date }) => date === "2021-02-02"), "A1");
  assert.equal(openDecision.target, null);
  assert.ok(openDecision.reasons.includes("EXECUTION_NOT_FIRST_SESSION"));
});

test("proxy fills use next open, charge entry and terminal exit, unchanged targets cost nothing", () => {
  const rows = history();
  for (const row of rows) row.prices.SGOV = { open: 100, close: 100 };
  const result = backtestResearchStrategy({ rows, strategy: "SGOV_BUY_HOLD", startDate: "2021-02-01", roundTripCostPct: 1 });
  assert.ok(Math.abs(result.metrics.endingEquityUsd - 50 * 0.995 ** 2) < 1e-10);
  assert.equal(result.metrics.orders, 2);
  assert.equal(result.metrics.switches, 0);
  assert.equal(result.metrics.closedTrades, 0);
  assert.equal(result.metrics.terminalLiquidations, 1);
  assert.equal(result.evidenceLevel, "HISTORICAL_PROXY");
  assert.equal(result.automaticTradingEligible, false);
  const index = rows.findIndex(({ date }) => date === "2021-02-01");
  rows[index].prices.VTI = { open: 200, close: 100 };
  const trend = backtestResearchStrategy({ rows, strategy: "A1", startDate: "2021-02-01", roundTripCostPct: 0 });
  assert.equal(trend.decisions[0].target, "VTI");
  assert.equal(trend.trades[0].price, 200);
  assert.equal(trend.equityCurve[0].equityUsd, 25);
});

test("missing execution prices and malformed costs fail closed", () => {
  const rows = history();
  delete rows.find(({ date }) => date === "2021-02-01").prices.VTI;
  assert.throws(() => backtestResearchStrategy({ rows, strategy: "A1", startDate: "2021-02-01" }), /Missing daily price/);
  assert.throws(() => backtestResearchStrategy({ rows: history(), strategy: "A1", roundTripCostPct: NaN }), /cost/);
  assert.throws(() => backtestResearchStrategy({ rows: history().reverse(), strategy: "A1" }), /ordered/);
});

test("reports compare all strategies on the same dates and cannot confer Live eligibility", () => {
  const report = buildMonthlyResearchReport({ rows: history(), roundTripCosts: [0.45] });
  const scenario = report.periods.common.scenarios[0];
  const ranges = Object.values(scenario.results).map(({ metrics }) => `${metrics.startDate}/${metrics.endDate}`);
  assert.equal(new Set(ranges).size, 1);
  assert.equal(report.automaticTradingEligible, false);
  assert.equal(report.forwardEvidence.monthEndDecisions, 0);
  assert.equal(report.specificationHash.length, 64);
  assert.equal(MONTHLY_RESEARCH_SPEC.primary, "A1");
  assert.ok(scenario.results.WEEKLY_DEFENSE_PROXY.limitations.length);
  assert.throws(() => buildMonthlyResearchReport({ rows: history(), roundTripCosts: [] }), /cost scenarios/);
  const anotherCost = buildMonthlyResearchReport({ rows: history(), roundTripCosts: [1] });
  assert.notEqual(report.specificationHash, anotherCost.specificationHash);
});

test("short or absent fixed regimes cannot receive an overall historical pass", () => {
  const report = buildMonthlyResearchReport({ rows: history().filter(({ date }) => date <= "2021-03-03") });
  assert.equal(report.verdicts.A1, "INSUFFICIENT_HISTORICAL_COVERAGE");
  assert.equal(report.verdicts.A2, "INSUFFICIENT_HISTORICAL_COVERAGE");
  assert.ok(report.coverageBlockers.includes("MISSING_REQUIRED_PERIOD:year2022"));
  assert.ok(report.coverageBlockers.includes("COMMON_PERIOD_TOO_SHORT"));
});
