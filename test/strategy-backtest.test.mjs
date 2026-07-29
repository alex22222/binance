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
    "adaptive-momentum-market-filtered",
    "trend-pullback-confirmation",
    "trend-pullback-market-filtered",
    "executable-basis-reversion",
    "residual-reversal",
    "session-momentum"
  ]);
  assert.equal(
    definitions.find(({ id }) => id === "trend-pullback-confirmation").evidenceLevel,
    "historical-shadow"
  );
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
  assert.equal(result.strategies.length, 7);
  assert.ok(result.strategies.every(({ performance }) => performance.trades === 0));
  assert.equal(result.dataCoverage.symbols, 3);
  assert.equal(result.assumptions.maxOpenPositions, 3);
  assert.equal(result.assumptions.onePositionAtATime, false);
  assert.equal(result.assumptions.exitParameters.profitProtectionR, 1);
  assert.equal(result.assumptions.exitParameters.ordinaryExitsRequireNonNegativeNetReturn, true);
  assert.equal(result.assumptions.costModel, "roundTripCostPct deducted from every completed trade");
  assert.deepEqual(result.assumptions.entryPolicy, {
    entryCutoffMinutes: 45,
    entryBlockedSymbols: [],
    sameSessionInitialStopReentryBlocked: true,
    secondInitialStopQuarantineTradingDays: 5
  });
  assert.ok(result.strategies.every(({ entryDiagnostics }) => entryDiagnostics != null));
});

function trendingCandles(start, count, step) {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index * step;
    const close = open + step;
    return candle(start + index * 60_000, open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close);
  });
}

test("historical simulator applies the configured symbol block", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const nvda = trendingCandles(start, 390, 0.08);
  const flat = trendingCandles(start, 390, 0);
  const dataset = {
    NVDA: { multiplier: 1, tokenCandles: nvda, underlyingCandles: nvda },
    SPY: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat },
    QQQ: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat }
  };
  const common = {
    maxTradeUsdt: 50,
    roundTripCostPct: 0.1,
    maxOpenPositions: 3,
    minNetEdgePct: 0,
    entryCutoffMinutes: 45
  };
  const unblocked = backtestStrategyLibrary(dataset, common);
  const blocked = backtestStrategyLibrary(dataset, {
    ...common,
    entryBlockedSymbols: ["NVDA"]
  });

  assert.ok(
    unblocked.strategies.find(({ id }) => id === "adaptive-momentum").performance.trades > 0
  );
  assert.equal(
    blocked.strategies.find(({ id }) => id === "adaptive-momentum").performance.trades,
    0
  );
  assert.ok(
    blocked.strategies.find(({ id }) => id === "adaptive-momentum")
      .entryDiagnostics.symbolPolicyBlocked > 0
  );
});

test("market-filtered momentum excludes broad persistent benchmark declines", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const nvda = trendingCandles(start, 390, 0.08);
  const falling = trendingCandles(start, 390, -0.08);
  const dataset = {
    NVDA: { multiplier: 1, tokenCandles: nvda, underlyingCandles: nvda },
    SPY: { multiplier: 1, tokenCandles: falling, underlyingCandles: falling },
    QQQ: { multiplier: 1, tokenCandles: falling, underlyingCandles: falling }
  };
  const result = backtestStrategyLibrary(dataset, {
    maxTradeUsdt: 50,
    roundTripCostPct: 0.1,
    maxOpenPositions: 3,
    minNetEdgePct: 0,
    entryCutoffMinutes: 45
  });
  const adaptive = result.strategies.find(({ id }) => id === "adaptive-momentum");
  const filtered = result.strategies.find(
    ({ id }) => id === "adaptive-momentum-market-filtered"
  );

  assert.ok(adaptive.performance.trades > 0);
  assert.equal(filtered.performance.trades, 0);
  assert.ok(filtered.entryDiagnostics.marketBlocked > 0);
});

test("historical simulator blocks same-session reentry after an initial stop", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  let price = 100;
  const nvda = Array.from({ length: 390 }, (_, index) => {
    const step = index < 240 ? 0.02 : index < 244 ? -0.5 : 0.03;
    const open = price;
    price += step;
    return candle(
      start + index * 60_000,
      open,
      Math.max(open, price) + 0.03,
      Math.min(open, price) - 0.03,
      price
    );
  });
  const flat = trendingCandles(start, 390, 0);
  const result = backtestStrategyLibrary({
    NVDA: { multiplier: 1, tokenCandles: nvda, underlyingCandles: nvda },
    SPY: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat },
    QQQ: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat }
  }, {
    maxTradeUsdt: 50,
    roundTripCostPct: 0.1,
    maxOpenPositions: 3,
    minNetEdgePct: 0,
    entryCutoffMinutes: 45
  });
  const adaptive = result.strategies.find(({ id }) => id === "adaptive-momentum");

  assert.ok(adaptive.trades.some(({ reason }) => reason === "INITIAL_STOP"));
  assert.ok(adaptive.entryDiagnostics.symbolPolicyBlocked > 0);
});
