import assert from "node:assert/strict";
import test from "node:test";
import {
  backtestStrategyLibrary,
  performanceMetrics,
  strategyValidationDefinitions
} from "../src/strategy-backtest.mjs";

function candle(openTime, open, high, low, close) {
  return { openTime, open, high, low, close, closeTime: openTime + 59_999 };
}

test("reports every strategy with an explicit evidence level", () => {
  const definitions = strategyValidationDefinitions();
  assert.deepEqual(definitions.map(({ id }) => id), [
    "adaptive-momentum",
    "executable-basis-reversion",
    "residual-reversal",
    "session-momentum"
  ]);
  assert.equal(
    definitions.find(({ id }) => id === "executable-basis-reversion").evidenceLevel,
    "historical-proxy"
  );
});

test("calculates fixed-notional return, win rate, profit factor, and drawdown", () => {
  const metrics = performanceMetrics([
    { pnlUsdt: 5, returnPct: 10 },
    { pnlUsdt: -2, returnPct: -4 },
    { pnlUsdt: 1, returnPct: 2 }
  ], 50);
  assert.deepEqual({
    ...metrics,
    winRatePct: Number(metrics.winRatePct.toFixed(8)),
    returnOnTurnoverPct: Number(metrics.returnOnTurnoverPct.toFixed(8))
  }, {
    trades: 3,
    wins: 2,
    losses: 1,
    winRatePct: 66.66666667,
    pnlUsdt: 4,
    returnPct: 8,
    returnOnTurnoverPct: 2.66666667,
    profitFactor: 3,
    maxDrawdownUsdt: 2,
    maxDrawdownPct: 4
  });
});

test("backtest output never omits an untriggered strategy", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const candles = Array.from({ length: 40 }, (_, index) => (
    candle(start + index * 60_000, 100, 100.1, 99.9, 100)
  ));
  const dataset = {
    NVDA: { multiplier: 1, tokenCandles: candles, underlyingCandles: candles },
    SPY: { multiplier: 1, tokenCandles: candles, underlyingCandles: candles },
    QQQ: { multiplier: 1, tokenCandles: candles, underlyingCandles: candles }
  };
  const result = backtestStrategyLibrary(dataset, {
    maxTradeUsdt: 50,
    roundTripCostPct: 1,
    maxOpenPositions: 3,
    atrStopMultiplier: 1.5,
    minInitialStopPct: 1,
    maxInitialStopPct: 3.5,
    profitProtectionR: 1,
    trailingAtrMultiplier: 1,
    finalTakeProfitR: 2,
    signalReviewHours: 4,
    signalReviewMinR: 0.5,
    minNetEdgePct: 0.1,
    disasterStopLossPct: 8
  });
  assert.equal(result.strategies.length, 4);
  assert.ok(result.strategies.every(({ performance }) => performance.trades === 0));
  assert.equal(result.dataCoverage.symbols, 3);
  assert.equal(result.assumptions.maxOpenPositions, 3);
  assert.equal(result.assumptions.onePositionAtATime, false);
  assert.equal(result.assumptions.exitParameters.profitProtectionR, 1);
  assert.equal(result.assumptions.exitParameters.ordinaryExitsRequireNonNegativeNetReturn, true);
  assert.equal(result.assumptions.costModel, "roundTripCostPct deducted from every completed trade");
});
