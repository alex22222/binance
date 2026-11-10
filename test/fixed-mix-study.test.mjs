import assert from "node:assert/strict";
import test from "node:test";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { FIXED_MIX_RULES, runFixedMixBacktest, reconcileFixedMix } from "../scripts/fixed-mix-study.mjs";

// SPY trends up with swings; SGOV drifts up slowly. `spy(i)` can be overridden per test.
function history({ spy = i => 100 * (1 + 0.001 * i) * (1 + 0.12 * Math.sin(i / 30)), first = "2025-01-02", last = "2026-10-22" } = {}) {
  return researchTradingDates(first, last).map((date, i) => ({ date, prices: {
    SPY: { open: spy(i) * (1 + 0.002 * Math.sin(i)), close: spy(i) }, SGOV: { open: 100 * (1 + 0.00016 * i), close: 100 * (1 + 0.00016 * i) } } }));
}
const run = (rule, rows = history(), extra = {}) => runFixedMixBacktest({ rows, rule, startDate: "2025-02-03", endDate: "2026-10-22", ...extra });

test("the grid is the frozen 14 rules", () => {
  assert.deepEqual(Object.keys(FIXED_MIX_RULES).sort(), ["MIX0", "MIX100", ...[20, 40, 60, 80].flatMap(w => [`MIX${w}_B10`, `MIX${w}_B5`, `MIX${w}_HOLD`])].sort());
});

test("the first session buys both assets at the target split and leaves no idle cash", () => {
  const result = run("MIX40_B5");
  const first = result.trades.filter(t => t.reason === "INITIAL");
  assert.deepEqual(first.map(t => t.ticker), ["SPY", "SGOV"]);
  const investable = 435.32 - 2 * 0.05;
  assert.ok(Math.abs(first[0].notionalUsd - 0.4 * investable) < 1e-9);
  assert.ok(Math.abs(first[1].notionalUsd - 0.6 * investable) < 1e-9);
  assert.ok(Math.abs(first[1].cashAfterUsd) < 1e-9);
  assert.deepEqual(run("MIX0").trades.filter(t => t.reason === "INITIAL").map(t => t.ticker), ["SGOV"]);
  assert.deepEqual(run("MIX100").trades.filter(t => t.reason === "INITIAL").map(t => t.ticker), ["SPY"]);
});

test("rebalancing happens only beyond the band, on a month's first session, and lands near target", () => {
  // SPY doubles over the window, so a 60% target drifts well above any band.
  const rows = history({ spy: i => 100 * (1 + 0.0025 * i) });
  for (const [rule, band] of [["MIX60_B5", 5], ["MIX60_B10", 10]]) {
    const result = run(rule, rows);
    const rebalanceDates = [...new Set(result.trades.filter(t => t.reason === "REBALANCE").map(t => t.date))];
    assert.ok(rebalanceDates.length >= 1, rule);
    for (const check of result.checks) {
      const traded = rebalanceDates.includes(check.date);
      if (Math.abs(check.driftPct) <= band) assert.equal(traded, false, `${rule} ${check.date} inside band`);
    }
    for (const date of rebalanceDates) {
      const index = rows.findIndex(r => r.date === date);
      assert.notEqual(rows[index].date.slice(0, 7), rows[index - 1].date.slice(0, 7), "first session of month");
      const day = result.equityCurve.find(d => d.date === date);
      const spyValue = day.units.SPY * rows[index].prices.SPY.close;
      assert.ok(Math.abs(spyValue / day.equityUsd * 100 - 60) < 1.5, `${rule} back near target on ${date}`);
    }
  }
  assert.ok(run("MIX60_B5", rows).metrics.rebalances >= run("MIX60_B10", rows).metrics.rebalances);
  assert.equal(run("MIX60_HOLD", rows).metrics.rebalances, 0);
  assert.ok(run("MIX60_HOLD", rows).metrics.endingSpyWeightPct > 70, "without rebalancing the weight drifts");
});

test("a drift that reverses by the open is not traded, and 0%/100% never rebalance", () => {
  const rows = history({ spy: i => 100 * (1 + 0.0025 * i) });
  const breach = run("MIX60_B5", rows).trades.find(t => t.reason === "REBALANCE");
  const index = rows.findIndex(r => r.date === breach.date);
  rows[index].prices.SPY = { ...rows[index].prices.SPY, open: rows[index].prices.SPY.open * 0.6 };
  assert.equal(run("MIX60_B5", rows).trades.filter(t => t.date === breach.date).length, 0);
  for (const rule of ["MIX0", "MIX100"]) assert.equal(run(rule).metrics.rebalances, 0, rule);
});

test("future prices never change earlier equity, and every rule reconciles independently", () => {
  const left = history(), right = history();
  for (const row of right.filter(r => r.date >= "2026-03-02")) row.prices.SPY = { open: 400, close: 400 };
  const before = r => r.equityCurve.filter(d => d.date < "2026-03-02");
  assert.deepEqual(before(run("MIX40_B5", right)), before(run("MIX40_B5", left)));
  for (const cost of [0.35, 0.8, 1]) for (const rule of Object.keys(FIXED_MIX_RULES)) {
    assert.ok(reconcileFixedMix(run(rule, left, { roundTripCostPct: cost }), left), `${rule} ${cost}`);
  }
});

test("invalid rules and ranges are refused", () => {
  assert.throws(() => run("MIX50"), /Unknown fixed-mix rule/);
  assert.throws(() => runFixedMixBacktest({ rows: history(), rule: "MIX40_B5", startDate: "2025-01-02" }), /Insufficient range/);
});
