import assert from "node:assert/strict";
import test from "node:test";
import { OBSERVED_RULES, observationRows, ruleEvents, updateObservations } from "../src/btc-observe.mjs";

const DAY = 86_400_000;
const date = (index) => new Date(Date.parse("2026-01-01T00:00:00Z") + index * DAY).toISOString().slice(0, 10);
const rule = (id) => OBSERVED_RULES.find((candidate) => candidate.id === id);
// A quiet day on which no rule fires.
const row = (index, overrides = {}) => ({
  date: date(index), close: 100, ma: { 20: 100, 50: 100, 100: 100, 200: 100 },
  trend: 0, r28: 0, funding7: 0.05, fng: 50, macro: 0, ...overrides
});

test("each candidate rule needs every one of its conditions", () => {
  const bullish = { trend: 1, r28: 0.05, funding7: 0.1, fng: 60, macro: 1 };
  assert.equal(rule("A_LONG").test([row(0, bullish)], 0), true);
  for (const [key, value] of [["trend", 0.5], ["r28", -0.01], ["funding7", 0.3], ["fng", 80], ["macro", -0.5], ["macro", Number.NaN]]) {
    assert.equal(rule("A_LONG").test([row(0, { ...bullish, [key]: value })], 0), false, `${key}=${value}`);
  }
  const bearish = { trend: -1, r28: -0.05, funding7: 0.01, fng: 30, macro: -1 };
  assert.equal(rule("A_SHORT").test([row(0, bearish)], 0), true);
  assert.equal(rule("A_SHORT").test([row(0, { ...bearish, fng: 20 })], 0), false);
  assert.equal(rule("A_SHORT").test([row(0, { ...bearish, funding7: 0 })], 0), false);

  const capitulation = [row(0, { fng: 15, close: 95 }), row(1, { fng: 30, close: 97 }), row(2, { fng: 35, close: 101, funding7: -0.02 })];
  assert.equal(rule("B_LONG").test(capitulation, 2), true);
  assert.equal(rule("B_LONG").test(capitulation.map((r, i) => (i === 2 ? { ...r, funding7: 0.01 } : r)), 2), false);
  assert.equal(rule("B_LONG").test(capitulation.map((r, i) => (i < 2 ? { ...r, close: 102 } : r)), 2), false, "was already above its average");
  const euphoria = [row(0, { fng: 85, close: 105 }), row(1, { fng: 70, close: 103 }), row(2, { fng: 65, close: 99, funding7: 0.31 })];
  assert.equal(rule("B_SHORT").test(euphoria, 2), true);
  assert.equal(rule("B_SHORT").test(euphoria.map((r) => ({ ...r, fng: 79 })), 2), false);

  const turning = Array.from({ length: 30 }, (_, i) => row(i, { funding7: i < 20 ? 0.01 : -0.03 }));
  assert.equal(rule("FUNDING_NEGATIVE").test(turning, 29), true);
  assert.equal(rule("FUNDING_NEGATIVE").test(turning, 25), false);
  assert.equal(rule("FUNDING_HOT").test([row(0, { funding7: 0.3 })], 0), true);
  assert.equal(rule("FUNDING_HOT").test([row(0, { funding7: 0.29 })], 0), false);
});

test("a trigger is the first day a rule turns on, at least its cooldown after the last", () => {
  const hot = new Set([3, 4, 10, 20, 21, 40]);
  const rows = Array.from({ length: 45 }, (_, i) => row(i, { funding7: hot.has(i) ? 0.35 : 0.05 }));
  assert.deepEqual(ruleEvents(rows, rule("FUNDING_HOT")), [3, 20, 40]);
  assert.deepEqual(ruleEvents(rows, rule("FUNDING_HOT"), { from: 5, last: 3 }), [20, 40]);
});

test("builds daily rows with the study's definitions", () => {
  const closes = Array.from({ length: 230 }, (_, i) => ({ date: date(i), close: 100 + i }));
  const end = Date.parse(`${date(229)}T00:00:00Z`) + DAY;
  const funding = [
    ...Array.from({ length: 21 }, (_, k) => ({ ts: end - k * 8 * 3_600_000, rate: 0.0001 })),
    { ts: end - 7 * DAY, rate: 0.5 },
    { ts: end + 1, rate: 0.5 }
  ];
  const falling = (base) => Array.from({ length: 230 }, (_, i) => ({ date: date(i), value: base - i * 0.01 }));
  const rows = observationRows({ closes, fearGreed: [{ date: date(229), value: 72 }], funding, dollar: falling(120), realYield: falling(2) });
  const last = rows.at(-1);
  assert.equal(last.ma[200], 229.5);
  assert.equal(last.trend, 1);
  assert.equal(last.r28, 329 / 301 - 1);
  assert.ok(Math.abs(last.funding7 - 0.0001 * 3 * 365) < 1e-12, "only rates settled within the 7 days ending at the next midnight");
  assert.equal(last.fng, 72);
  assert.equal(last.macro, 1);
  assert.ok(Number.isNaN(rows[228].fng));
  assert.ok(Number.isNaN(rows[150].ma[200]));
  assert.ok(Number.isNaN(rows[0].macro), "FRED values before the window are unknown");
});

test("logs the first window as before the start, then only new days, with returns from the next close", () => {
  const rising = (count, hotDays) => Array.from({ length: count }, (_, i) => row(i, { funding7: hotDays.includes(i) ? 0.35 : 0.05, close: 100 + i }));
  const first = updateObservations(null, rising(40, [10]));
  assert.equal(first.record.startedAt, date(39));
  const [early] = first.record.events.filter((event) => event.rule === "FUNDING_HOT");
  assert.equal(early.date, date(10));
  assert.equal(early.beforeStart, true);
  assert.equal(early.entryClose, 111);
  assert.equal(early.returns[7], Number((118 / 111 - 1).toFixed(5)));
  assert.equal(early.returns[30], undefined);
  const hotSummary = first.summary.rules.find(({ id }) => id === "FUNDING_HOT");
  assert.deepEqual([hotSummary.events, hotSummary.lastEvent, hotSummary.today], [0, { date: date(10), beforeStart: true }, false]);

  const second = updateObservations(JSON.parse(JSON.stringify(first.record)), rising(70, [10, 50]));
  const hot = second.record.events.filter((event) => event.rule === "FUNDING_HOT");
  assert.deepEqual(hot.map(({ date: day, beforeStart }) => [day, beforeStart]), [[date(10), true], [date(50), false]]);
  assert.equal(hot[0].returns[30], Number((141 / 111 - 1).toFixed(5)));
  assert.equal(second.record.evaluated.FUNDING_HOT, date(69));
  assert.deepEqual(second.record.closes.map(([day]) => day), Array.from({ length: 31 }, (_, i) => date(39 + i)));
  const summary = second.summary.rules.find(({ id }) => id === "FUNDING_HOT");
  assert.deepEqual([summary.events, summary.matured, summary.p], [1, 0, null]);
});

test("rechecks a day whose inputs were missing instead of skipping it", () => {
  const ready = { trend: 1, r28: 0.05, funding7: 0.1, fng: 60, macro: 1 };
  const rows = (macro) => Array.from({ length: 40 }, (_, i) => row(i, i === 39 ? { ...ready, macro } : {}));
  const first = updateObservations(null, rows(Number.NaN));
  assert.equal(first.summary.rules.find(({ id }) => id === "A_LONG").today, null);
  assert.equal(first.record.evaluated.A_LONG, date(38));
  assert.equal(first.record.evaluated.FUNDING_HOT, date(39));
  const second = updateObservations(first.record, rows(1));
  assert.deepEqual(second.record.events.filter((event) => event.rule === "A_LONG").map(({ date: day, beforeStart }) => [day, beforeStart]), [[date(39), false]]);
  assert.equal(second.summary.rules.find(({ id }) => id === "A_LONG").today, true);
});

test("compares matured triggers with random days and reports p only after ten", () => {
  const rows = Array.from({ length: 300 }, (_, i) => row(i, { funding7: i % 20 === 5 ? 0.35 : 0.05, close: 100 + 10 * Math.sin(i / 3) }));
  const start = updateObservations(null, rows.slice(0, 2));
  const { summary } = updateObservations(start.record, rows);
  const hot = summary.rules.find(({ id }) => id === "FUNDING_HOT");
  assert.equal(hot.events, 15);
  assert.equal(hot.matured, 14);
  assert.ok(hot.p >= 0 && hot.p <= 1);
  assert.equal(typeof hot.crashRate, "number");
  assert.equal(typeof hot.baseCrashRate, "number");
  assert.equal(updateObservations(start.record, rows).summary.rules.find(({ id }) => id === "FUNDING_HOT").p, hot.p, "same data, same p");
  const quiet = summary.rules.find(({ id }) => id === "A_LONG");
  assert.deepEqual([quiet.events, quiet.matured, quiet.p, quiet.hit], [0, 0, null, null]);
  assert.equal(quiet.crashRate, undefined);
});
