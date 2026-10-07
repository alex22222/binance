import assert from "node:assert/strict";
import test from "node:test";
import { btcTrendHistory, btcTrendSummary } from "../src/btc-trend.mjs";

const series = (values) => values.map((close, index) => ({
  date: new Date(Date.parse("2026-01-01T00:00:00Z") + index * 86_400_000).toISOString().slice(0, 10),
  close
}));
const flat = (count) => Array(count).fill(100);

test("keeps the previous state inside the ±3% band around the 200-day average", () => {
  const rows = btcTrendHistory(series([...flat(250), 104, 101, 99, 96, 98, 102, 104]));
  assert.equal(rows.length, 58);
  assert.ok(rows.slice(0, 51).every(({ state }) => state === null));
  assert.deepEqual(rows.slice(-7).map(({ state }) => state), ["LONG", "LONG", "LONG", "AVOID", "AVOID", "AVOID", "LONG"]);
  assert.equal(rows.at(-1).average, (193 * 100 + 104 + 101 + 99 + 96 + 98 + 102 + 104) / 200);
});

test("reports when the current state began and which state it replaced", () => {
  const closes = series([...flat(250), 104, 101, 96, 98, 104, 105]);
  const summary = btcTrendSummary(closes);
  assert.deepEqual(summary, {
    date: closes.at(-1).date,
    close: 105,
    average: 100.04,
    distance: Number((105 / 100.04 - 1).toFixed(5)),
    band: 0.03,
    state: "LONG",
    since: closes[254].date,
    previous: "AVOID"
  });
});

test("leaves the start unknown without a visible switch and needs 200 closes", () => {
  const first = btcTrendSummary(series([...flat(250), 104, 105]));
  assert.equal(first.state, "LONG");
  assert.equal(first.since, null);
  assert.equal(first.previous, null);
  assert.equal(btcTrendSummary(series(flat(250))).state, null);
  assert.equal(btcTrendSummary(series(flat(199))), null);
});
