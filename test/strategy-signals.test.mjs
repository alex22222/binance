import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCandles,
  calculateAtrPct
} from "../src/strategy-signals.mjs";

function rawCandle(openTime, open, high, low, close) {
  return [openTime, open, high, low, close, 0, openTime + 59_999];
}

function normalizedCandle(openTime, open, high, low, close) {
  return { openTime, open, high, low, close, volume: 0, closeTime: openTime + 59_999 };
}

test("shared momentum analysis is identical for raw and normalized closed candles", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const raw = Array.from({ length: 17 }, (_, index) => (
    rawCandle(start + index * 60_000, 100 + index, 101 + index, 99 + index, 100.5 + index)
  ));
  const normalized = raw.map((candle) => normalizedCandle(
    candle[0],
    candle[1],
    candle[2],
    candle[3],
    candle[4]
  ));
  const frontier = start + 16 * 60_000;

  assert.deepEqual(
    analyzeCandles(normalized, frontier),
    analyzeCandles(raw, frontier)
  );
  assert.equal(analyzeCandles(raw, frontier).lastCandleTime, start + 15 * 60_000);
});

test("shared ATR analysis is identical for raw and normalized closed candles", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const raw = Array.from({ length: 16 }, (_, index) => (
    rawCandle(
      start + index * 15 * 60_000,
      100 + index,
      102 + index,
      99 + index,
      101 + index
    )
  ));
  const normalized = raw.map((candle) => normalizedCandle(
    candle[0],
    candle[1],
    candle[2],
    candle[3],
    candle[4]
  ));
  const frontier = start + 16 * 15 * 60_000;

  assert.deepEqual(
    calculateAtrPct(normalized, 14, frontier),
    calculateAtrPct(raw, 14, frontier)
  );
});

test("shared signal functions do not consume a candle at the current frontier", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const candles = Array.from({ length: 17 }, (_, index) => (
    normalizedCandle(start + index * 60_000, 100, 101, 99, 100 + index)
  ));
  const frontier = start + 16 * 60_000;
  const baseline = analyzeCandles(candles, frontier);
  const changedFuture = candles.map((candle, index) => (
    index === 16 ? { ...candle, close: 10_000 } : candle
  ));

  assert.deepEqual(analyzeCandles(changedFuture, frontier), baseline);
});
