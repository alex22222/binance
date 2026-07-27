import assert from "node:assert/strict";
import test from "node:test";
import {
  latestCompletedTradingDate,
  newYorkSessionBounds,
  tradingDates
} from "../src/strategy-data.mjs";

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
