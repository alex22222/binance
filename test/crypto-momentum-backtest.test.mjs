import assert from "node:assert/strict";
import test from "node:test";
import { backtestCryptoMomentum, prepareCryptoFeatures, CURRENT_MOMENTUM_CONFIG } from "../src/crypto-momentum-backtest.mjs";
import { calculateAtrPct } from "../src/strategy-signals.mjs";

const MINUTE = 60_000;
function bars(prices) {
  return prices.map((close, index) => ({ openTime: index * MINUTE, closeTime: (index + 1) * MINUTE - 1,
    open: close, high: close + 0.1, low: close - 0.1, close }));
}
function simulate(candles, overrides = {}) {
  return backtestCryptoMomentum({ symbol: "TEST", candles, startMs: 0, endMs: candles.at(-1).openTime + MINUTE,
    config: { ...CURRENT_MOMENTUM_CONFIG, entryIntervalMinutes: 1 },
    features: { trend: candles.map(() => 1), atr: candles.map(() => 0.2), up: candles.map(() => 15) }, ...overrides });
}

test("crypto features consume only completed minutes and completed 15-minute ATR bars", () => {
  const candles = bars(Array.from({ length: 300 }, (_, index) => 100 + index * 0.01));
  const original = prepareCryptoFeatures(candles);
  assert.ok(Number.isNaN(original.atr[224]));
  const aggregated = Array.from({ length: 15 }, (_, index) => ({
    openTime: index * 15 * MINUTE, closeTime: (index + 1) * 15 * MINUTE - 1,
    open: candles[index * 15].open, high: candles[index * 15 + 14].high,
    low: candles[index * 15].low, close: candles[index * 15 + 14].close
  }));
  assert.equal(original.atr[225], calculateAtrPct(aggregated, 14, 225 * MINUTE).atrPct);
  assert.equal(original.atr[239], original.atr[225]);
  const altered = candles.map((candle, index) => index < 250 ? candle : {
    ...candle, open: 1, high: 1000, low: 0.1, close: 500
  });
  const changed = prepareCryptoFeatures(altered);
  assert.deepEqual(changed.trend.slice(0, 251), original.trend.slice(0, 251));
  assert.deepEqual(changed.atr.slice(0, 251), original.atr.slice(0, 251));
  assert.deepEqual(changed.up.slice(0, 251), original.up.slice(0, 251));
});

test("round trip charges both sides and terminal liquidation reconciles equity", () => {
  const result = simulate(bars([100, 100, 100]));
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, "END_OF_TEST");
  const expected = 50 * ((1 - 0.001) * (1 - 0.0002) / ((1 + 0.001) * (1 + 0.0002)) - 1);
  assert.ok(Math.abs(result.summary.netPnlUsdt - expected) < 1e-10);
  assert.ok(Math.abs(result.trades[0].pnlUsdt + result.trades[0].totalCostUsdt) < 1e-10);
  assert.ok(Math.abs(result.summary.maxDrawdownUsdt + expected) < 1e-10);
  assert.equal(result.dailyEquity.at(-1).equityUsdt, result.summary.endingEquityUsdt);
});

test("full dynamic exits take profit at net 2R without overlapping positions", () => {
  const result = simulate(bars([100, 101.5, 102.5]));
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, "TAKE_PROFIT_2R");
  assert.equal(result.trades[0].openedAt, new Date(0).toISOString());
  assert.equal(result.trades[0].closedAt, new Date(2 * MINUTE).toISOString());
  assert.ok(result.trades[0].returnPct > 2);
});

test("trailing protection activates at 1R and uses the current ATR", () => {
  const result = simulate(bars([100, 101.6, 101.2]));
  assert.equal(result.trades[0].reason, "TRAILING_STOP");
  assert.ok(result.trades[0].returnPct > 0.5);
});

test("no-loss guard blocks losing timeout but never blocks an initial stop", () => {
  const candles = bars(Array.from({ length: 245 }, (_, index) => index < 240 ? 100 : index === 240 ? 99.5 : 98.5));
  const result = simulate(candles, { features: { trend: candles.map((_, i) => i ? 0 : 1), atr: candles.map(() => 0.2), up: candles.map(() => 15) } });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, "INITIAL_STOP");
  assert.equal(result.trades[0].closedAt, new Date(241 * MINUTE).toISOString());
  assert.equal(result.summary.noLossBlockedMinutes, 1);
});

test("same-day stop and five UTC-day quarantine prevent re-entry", () => {
  const dates = [0, 1, 2, 1440, 1441, 1442, 2880, 8640, 10080];
  const candles = bars([100, 98, 100, 100, 98, 100, 100, 100, 100]).map((candle, index) => ({
    ...candle, openTime: dates[index] * MINUTE, closeTime: (dates[index] + 1) * MINUTE - 1
  }));
  const result = simulate(candles);
  assert.equal(result.trades.length, 3);
  assert.deepEqual(result.trades.map((trade) => trade.openedAt), [0, 1440, 10080].map((minute) => new Date(minute * MINUTE).toISOString()));
});

test("daily loss cap is independent of the symbol stop quarantine", () => {
  const candles = bars([100, 90, 100, 103]);
  const result = simulate(candles, { config: { ...CURRENT_MOMENTUM_CONFIG, entryIntervalMinutes: 1, dailyLossLimitUsdt: 2 } });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, "DISASTER_STOP");
});

test("cost gate blocks a positive momentum signal whose edge does not cover costs", () => {
  const candles = bars([100, 101, 102]);
  const result = simulate(candles, { features: { trend: [0.3, 0.3, 0.3], atr: [0.2, 0.2, 0.2], up: [15, 15, 15] } });
  assert.equal(result.trades.length, 0);
  assert.equal(result.summary.costBlocked, 3);
});
