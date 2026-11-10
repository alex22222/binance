import assert from "node:assert/strict";
import test from "node:test";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { weeklyPaperWeek } from "../src/weekly-etf-rotation-paper.mjs";
import { weeklySgovSignal, runWeeklySgovBacktest, reconcileWeeklySgov } from "../scripts/weekly-sgov-study.mjs";
import { MONTHLY_RULES, monthlyDue, monthlyDualMomentumSignal, runRotationBacktest, runMonthlyBacktest } from "../scripts/monthly-sgov-study.mjs";

// Oscillating stocks force switches, stops and loss-limit paths; SGOV drifts up.
function history(first = "2024-01-02", last = "2026-10-22") {
  return researchTradingDates(first, last).map((date, i) => {
    const qqq = 100 * (1 + 0.0004 * i) * (1 + 0.14 * Math.sin(i / 17));
    const spy = 100 * (1 + 0.0003 * i) * (1 + 0.1 * Math.sin(i / 23 + 1));
    const sgov = 100 * (1 + 0.00016 * i);
    const bar = (close, gap) => ({ open: close * (1 + gap), close });
    return { date, prices: { QQQ: bar(qqq, 0.003 * Math.sin(i)), SPY: bar(spy, 0.002 * Math.cos(i)), SGOV: bar(sgov, 0) } };
  });
}

const weeklyDue = (rows, index) => weeklyPaperWeek(rows[index].date) !== weeklyPaperWeek(rows[index - 1].date);
const strip = ({ rule, metrics: { stockDays, ...metrics }, ...rest }) => ({ ...rest, metrics });

test("the injected engine replays the frozen weekly engine exactly", () => {
  const rows = history();
  for (const [roundTripCostPct, buyDelaySessions, buyDelayByWeek] of [[0.8, 0, {}], [0.35, 2, {}], [1, 0, { "2026-10-19": 3 }], [0.8, 3, {}]]) {
    const options = { rows, startDate: "2024-03-01", endDate: "2026-10-22", roundTripCostPct, buyDelaySessions, buyDelayByWeek };
    const frozen = runWeeklySgovBacktest({ ...options, rule: "CURRENT" });
    const injected = runRotationBacktest({ ...options, rule: "CURRENT", warmup: 20, isDue: weeklyDue,
      decide: (r, i) => weeklySgovSignal(r, i, "CURRENT") });
    assert.ok(frozen.trades.length > 20, "fixture exercises switching");
    assert.deepEqual(strip(injected), strip(frozen));
  }
});

function momentumRows({ qqq, spy, sgov }, lookback = 10) {
  // Only the closes at index-lookback-1 and index-1 enter the signal.
  const rows = researchTradingDates("2026-01-02", "2026-03-31").slice(0, lookback + 3).map(date => ({ date,
    prices: Object.fromEntries(["QQQ", "SPY", "SGOV"].map(t => [t, { open: 100, close: 100 }])) }));
  const index = lookback + 2;
  for (const [ticker, m] of Object.entries({ QQQ: qqq, SPY: spy, SGOV: sgov })) rows[index - 1].prices[ticker] = { open: 100, close: 100 * (1 + m) };
  return { rows, index };
}
const decide = (momenta, held, band = 0.02) => {
  const { rows, index } = momentumRows(momenta);
  return monthlyDualMomentumSignal(rows, index, { lookback: 10, band }, held).target;
};

test("the band gates entry, keeps a held stock, and limits stock-to-stock switches", () => {
  assert.equal(decide({ qqq: 0.06, spy: 0.04, sgov: 0.02 }, "CASH"), "QQQ", "enters when excess exceeds the band");
  assert.equal(decide({ qqq: 0.035, spy: 0.03, sgov: 0.02 }, "SGOV"), "SGOV", "excess inside the band stays defensive");
  assert.equal(decide({ qqq: 0.03, spy: 0.0, sgov: -0.001 }, "CASH"), "QQQ", "excess beyond the band over a falling SGOV enters");
  assert.equal(decide({ qqq: 0.01, spy: 0.0, sgov: -0.001 }, "CASH"), "CASH", "excess inside the band with a falling SGOV holds cash");
  assert.equal(decide({ qqq: -0.02, spy: -0.03, sgov: -0.001 }, "CASH"), "CASH", "falling SGOV defends with cash");
  assert.equal(decide({ qqq: 0.01, spy: 0.0, sgov: 0.02 }, "QQQ"), "QQQ", "held stock survives a dip within the band");
  assert.equal(decide({ qqq: -0.01, spy: -0.02, sgov: 0.02 }, "QQQ"), "SGOV", "held stock exits once it falls band below SGOV");
  assert.equal(decide({ qqq: 0.05, spy: 0.06, sgov: 0.02 }, "QQQ"), "QQQ", "small lead does not switch stocks");
  assert.equal(decide({ qqq: 0.05, spy: 0.08, sgov: 0.02 }, "QQQ"), "SPY", "a lead beyond the band switches stocks");
  assert.equal(decide({ qqq: 0.05, spy: 0.05, sgov: 0.02 }, "CASH"), "QQQ", "ties rank alphabetically");
});

test("a zero band is strict dual momentum on both sides", () => {
  assert.equal(decide({ qqq: 0.02, spy: 0.01, sgov: 0.02 }, "CASH", 0), "SGOV", "equal to SGOV is not an entry");
  assert.equal(decide({ qqq: 0.021, spy: 0.01, sgov: 0.02 }, "CASH", 0), "QQQ");
  assert.equal(decide({ qqq: 0.02, spy: 0.01, sgov: 0.02 }, "QQQ", 0), "SGOV", "equal to SGOV exits a held stock");
  assert.equal(decide({ qqq: 0.03, spy: 0.031, sgov: 0.02 }, "QQQ", 0), "SPY", "any lead switches with no band");
});

test("monthly runs decide only on each month's first session and reconcile independently", () => {
  const rows = history("2024-01-02");
  for (const rule of Object.keys(MONTHLY_RULES)) {
    const result = runMonthlyBacktest({ rows, rule, startDate: "2025-03-03", endDate: "2026-10-22" });
    const months = new Set(result.equityCurve.map(day => day.date.slice(0, 7)));
    const decisionMonths = result.decisions.map(d => d.date.slice(0, 7));
    assert.equal(new Set(decisionMonths).size, decisionMonths.length, rule);
    for (const decision of result.decisions) {
      const index = rows.findIndex(row => row.date === decision.date);
      assert.ok(monthlyDue(rows, index), decision.date);
      assert.equal(decision.signalDate, rows[index - 1].date);
    }
    assert.ok(decisionMonths.length >= months.size - 1, rule);
    assert.ok(reconcileWeeklySgov(result, rows), rule);
  }
});

test("future prices never change earlier monthly decisions or equity", () => {
  const left = history(), right = history();
  for (const row of right.filter(r => r.date >= "2026-06-01")) row.prices.QQQ = { open: 900, close: 900 };
  const options = { rule: "M6_B2", startDate: "2025-03-03", endDate: "2026-10-22" };
  const a = runMonthlyBacktest({ ...options, rows: left }), b = runMonthlyBacktest({ ...options, rows: right });
  const before = (result) => result.equityCurve.filter(day => day.date < "2026-06-01");
  assert.deepEqual(before(b), before(a));
  assert.deepEqual(b.decisions.filter(d => d.date < "2026-06-01"), a.decisions.filter(d => d.date < "2026-06-01"));
});

test("long lookbacks refuse to start before real SGOV history covers the window", () => {
  const rows = history("2024-01-02");
  assert.throws(() => runMonthlyBacktest({ rows, rule: "M12_B0", startDate: "2024-11-01" }), /warmup/);
  assert.doesNotThrow(() => runMonthlyBacktest({ rows, rule: "M12_B0", startDate: "2025-02-03" }));
  assert.throws(() => runMonthlyBacktest({ rows, rule: "M3_B9", startDate: "2025-02-03" }), /Unknown monthly rule/);
});
