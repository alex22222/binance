import assert from "node:assert/strict";
import test from "node:test";
import {
  latestCompletedTradingDate,
  newYorkSessionBounds,
  parseYahooChart,
  tradingDates
} from "../src/strategy-data.mjs";

test("preserves Yahoo volume and closes daily bars after their signal date", () => {
  const timestamp = Date.parse("2026-07-24T13:30:00.000Z") / 1000;
  const [daily] = parseYahooChart({
    timestamp: [timestamp],
    indicators: {
      quote: [{
        open: [100],
        high: [103],
        low: [99],
        close: [101],
        volume: [123456]
      }]
    }
  }, 86_400_000);

  assert.equal(daily.volume, 123456);
  assert.equal(daily.closeTime, Date.parse("2026-07-25T13:29:59.999Z"));
});

test("converts New York regular sessions across daylight saving time", () => {
  assert.deepEqual(newYorkSessionBounds("2026-07-27"), {
    openMs: Date.parse("2026-07-27T13:30:00.000Z"),
    closeMs: Date.parse("2026-07-27T20:00:00.000Z")
  });
  assert.deepEqual(newYorkSessionBounds("2026-01-26"), {
    openMs: Date.parse("2026-01-26T14:30:00.000Z"),
    closeMs: Date.parse("2026-01-26T21:00:00.000Z")
  });
});

test("excludes weekends and published NYSE holidays", () => {
  assert.deepEqual(tradingDates("2026-07-02", "2026-07-06"), [
    "2026-07-02",
    "2026-07-06"
  ]);
});

test("uses the current New York date only after its regular session completes", () => {
  assert.equal(
    latestCompletedTradingDate(Date.parse("2026-07-27T19:00:00.000Z")),
    "2026-07-24"
  );
  assert.equal(
    latestCompletedTradingDate(Date.parse("2026-07-27T20:30:00.000Z")),
    "2026-07-27"
  );
});
