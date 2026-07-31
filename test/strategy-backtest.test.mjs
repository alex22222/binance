import assert from "node:assert/strict";
import test from "node:test";
import {
  backtestStrategyLibrary,
  executionMetrics,
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
    "adaptive-momentum-three-controls",
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
    {
      pnlUsdt: 5,
      returnPct: 10,
      entryValueUsdt: 50,
      exitValueUsdt: 55,
      gasCostUsdt: 0.1,
      totalCostUsdt: 0.5,
      maePct: -1,
      mfePct: 11,
      realizedR: 2
    },
    {
      pnlUsdt: -2,
      returnPct: -4,
      entryValueUsdt: 50,
      exitValueUsdt: 48,
      gasCostUsdt: 0.1,
      totalCostUsdt: 0.6,
      maePct: -5,
      mfePct: 1,
      realizedR: -0.4
    },
    {
      pnlUsdt: 1,
      returnPct: 2,
      entryValueUsdt: 50,
      exitValueUsdt: 51,
      gasCostUsdt: 0.1,
      totalCostUsdt: 0.7,
      maePct: -0.5,
      mfePct: 3,
      realizedR: 0.2
    }
  ], 50);
  assert.deepEqual({
    ...metrics,
    winRatePct: Number(metrics.winRatePct.toFixed(8)),
    returnOnTurnoverPct: Number(metrics.returnOnTurnoverPct.toFixed(8)),
    returnOnExecutedTurnoverPct: Number(metrics.returnOnExecutedTurnoverPct.toFixed(8)),
    averageTradeUsdt: Number(metrics.averageTradeUsdt.toFixed(8)),
    averageReturnPct: Number(metrics.averageReturnPct.toFixed(8)),
    averageMaePct: Number(metrics.averageMaePct.toFixed(8)),
    averageRealizedR: Number(metrics.averageRealizedR.toFixed(8))
  }, {
    trades: 3,
    wins: 2,
    losses: 1,
    winRatePct: 66.66666667,
    pnlUsdt: 4,
    returnPct: 8,
    returnOnTurnoverPct: 2.66666667,
    turnoverUsdt: 304,
    returnOnExecutedTurnoverPct: 1.31578947,
    profitFactor: 3,
    grossProfitUsdt: 6,
    grossLossUsdt: 2,
    averageWinUsdt: 3,
    averageLossUsdt: -2,
    payoffRatio: 1.5,
    averageTradeUsdt: 1.33333333,
    averageReturnPct: 2.66666667,
    gasCostUsdt: 0.3,
    totalCostUsdt: 1.8,
    maxDrawdownUsdt: 2,
    maxDrawdownPct: 4,
    averageMaePct: -2.16666667,
    worstMaePct: -5,
    averageMfePct: 5,
    bestMfePct: 11,
    averageRealizedR: 0.6,
    worstRealizedR: -0.4,
    bestRealizedR: 2
  });
});

test("reports execution rate and explicit fill-evidence coverage", () => {
  assert.deepEqual(executionMetrics({
    eventCounts: {
      ORDER_INTENT: 5,
      ORDER_FILLED: 3,
      ORDER_REJECTED: 1,
      ORDER_FAILED: 1
    }
  }, [
    { executionEvidenceLevel: "QUOTE_REPLAY" },
    { executionEvidenceLevel: "CANDLE_PROXY" },
    { executionEvidenceLevel: "MIXED" },
    {}
  ]), {
    orderIntents: 5,
    orderFills: 3,
    orderRejections: 1,
    orderFailures: 1,
    executionRatePct: 60,
    completedTrades: 4,
    labeledTrades: 3,
    evidenceCoveragePct: 75,
    evidenceCounts: {
      CANDLE_PROXY: 1,
      MIXED: 1,
      QUOTE_REPLAY: 1,
      UNLABELED: 1
    }
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
  assert.equal(result.strategies.length, 8);
  assert.ok(result.strategies.every(({ performance }) => performance.trades === 0));
  assert.equal(result.dataCoverage.symbols, 3);
  assert.equal(result.assumptions.maxOpenPositions, 3);
  assert.equal(result.assumptions.onePositionAtATime, false);
  assert.equal(result.assumptions.exitParameters.profitProtectionR, 1);
  assert.equal(result.assumptions.exitParameters.ordinaryExitsRequireNonNegativeNetReturn, true);
  assert.equal(result.assumptions.costModel, "roundTripCostPct deducted from every completed trade");
  assert.equal(result.validationWindow, "UNSPECIFIED");
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

test("adaptive replay preserves deterministic entry and shared-exit timing", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const nvda = trendingCandles(start, 390, 0.08);
  const flat = trendingCandles(start, 390, 0);
  const result = backtestStrategyLibrary({
    NVDA: { multiplier: 1, tokenCandles: nvda, underlyingCandles: nvda },
    SPY: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat },
    QQQ: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat }
  }, {
    maxTradeUsdt: 50,
    roundTripCostPct: 0.1,
    maxOpenPositions: 1,
    minNetEdgePct: 0,
    entryCutoffMinutes: 45,
    includeReplayEvents: true
  });
  const adaptive = result.strategies.find(({ id }) => id === "adaptive-momentum");
  const trades = adaptive.trades;

  assert.deepEqual(trades.map(({ entryTime, exitTime, reason }) => ({
    entryTime,
    exitTime,
    reason
  })), [
    {
      entryTime: "2026-07-27T17:16:00.000Z",
      exitTime: "2026-07-27T18:04:00.000Z",
      reason: "TAKE_PROFIT"
    },
    {
      entryTime: "2026-07-27T18:16:00.000Z",
      exitTime: "2026-07-27T19:04:00.000Z",
      reason: "TAKE_PROFIT"
    }
  ]);
  assert.deepEqual(adaptive.replay.eventCounts, {
    SIGNAL: 2,
    ORDER_INTENT: 4,
    ORDER_FILLED: 4,
    POSITION_OPENED: 2,
    EXIT_SIGNAL: 2,
    POSITION_CLOSED: 2
  });
  assert.ok(adaptive.replay.events.every(({ sequence }, index) => sequence === index + 1));
  const intents = adaptive.replay.events.filter(({ type }) => type === "ORDER_INTENT");
  const fills = adaptive.replay.events.filter(({ type }) => type === "ORDER_FILLED");
  assert.ok(intents.every(({ orderId }) => fills.some((fill) => fill.orderId === orderId)));
  assert.ok(adaptive.replay.events.every(({ marketTime, frontierTime }) => frontierTime >= marketTime));
  assert.deepEqual(result.assumptions.timeFrontier, {
    intervalMs: 60_000,
    marketDataAvailableAt: "minute candle close",
    monotonic: true
  });
});

test("future candles cannot change replay events before the time frontier", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const cutoff = start + 300 * 60_000;
  const original = trendingCandles(start, 390, 0.08);
  const changedFuture = original.map((item) => (
    item.openTime >= cutoff
      ? { ...item, open: 1, high: 10_000, low: 0.5, close: 9_000 }
      : item
  ));
  const flat = trendingCandles(start, 390, 0);
  const options = {
    maxTradeUsdt: 50,
    roundTripCostPct: 0.1,
    maxOpenPositions: 1,
    minNetEdgePct: 0,
    entryCutoffMinutes: 45,
    includeReplayEvents: true
  };
  const run = (nvda) => backtestStrategyLibrary({
    NVDA: { multiplier: 1, tokenCandles: nvda, underlyingCandles: nvda },
    SPY: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat },
    QQQ: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat }
  }, options).strategies
    .find(({ id }) => id === "adaptive-momentum")
    .replay.events
    .filter(({ frontierTime }) => frontierTime <= cutoff);

  assert.deepEqual(run(changedFuture), run(original));
});

test("strict quote replay uses amount-specific fills and keeps gas in trade accounting", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const nvda = trendingCandles(start, 390, 0.08);
  const flat = trendingCandles(start, 390, 0);
  const quote = (side, executionTime, inputAmount, outputAmount, gasUsdt = 0.02) => ({
    side,
    executionTime,
    quotedAt: new Date(executionTime - 2_000).toISOString(),
    inputAmount,
    outputAmount,
    gasUsdt
  });
  const firstQuantity = 50 / 118.08;
  const secondQuantity = 50 / 122.88;
  const executionQuotes = [
    quote("BUY", Date.parse("2026-07-27T17:16:00.000Z"), 50, firstQuantity),
    quote("SELL", Date.parse("2026-07-27T18:05:00.000Z"), firstQuantity, firstQuantity * 122),
    quote("BUY", Date.parse("2026-07-27T18:16:00.000Z"), 50, secondQuantity),
    quote("SELL", Date.parse("2026-07-27T19:05:00.000Z"), secondQuantity, secondQuantity * 126.8)
  ];
  const result = backtestStrategyLibrary({
    NVDA: {
      multiplier: 1,
      tokenCandles: nvda,
      underlyingCandles: nvda,
      executionQuotes
    },
    SPY: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat },
    QQQ: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat }
  }, {
    maxTradeUsdt: 50,
    roundTripCostPct: 0.1,
    maxOpenPositions: 1,
    minNetEdgePct: 0,
    entryCutoffMinutes: 45,
    executionModel: "QUOTE_REPLAY",
    maxQuoteAgeMs: 10_000,
    validationWindow: "FORWARD",
    includeReplayEvents: true
  });
  const adaptive = result.strategies.find(({ id }) => id === "adaptive-momentum");

  assert.equal(adaptive.performance.trades, 2);
  assert.equal(result.validationWindow, "FORWARD");
  assert.ok(adaptive.trades.every(({ executionEvidenceLevel }) => executionEvidenceLevel === "QUOTE_REPLAY"));
  assert.ok(adaptive.trades.every(({ gasCostUsdt }) => gasCostUsdt === 0.04));
  assert.ok(adaptive.replay.events
    .filter(({ type }) => type === "ORDER_FILLED")
    .every(({ evidenceLevel }) => evidenceLevel === "QUOTE_REPLAY"));
  assert.deepEqual(adaptive.executionPerformance, {
    orderIntents: 4,
    orderFills: 4,
    orderRejections: 0,
    orderFailures: 0,
    executionRatePct: 100,
    completedTrades: 2,
    labeledTrades: 2,
    evidenceCoveragePct: 100,
    evidenceCounts: {
      QUOTE_REPLAY: 2
    }
  });
  assert.deepEqual(result.assumptions.execution, {
    model: "QUOTE_REPLAY",
    strictQuoteReplay: true,
    maxQuoteAgeMs: 10_000,
    maxQuoteDriftPct: 0.3,
    quoteDriftRequiresExpectedOutput: true,
    candleProxyRoundTripCostPct: 0.1,
    quoteReplayAdditionalRoundTripCostPct: 0
  });
});

test("strict quote replay rejects a missing quote instead of falling back to candles", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const nvda = trendingCandles(start, 390, 0.08);
  const flat = trendingCandles(start, 390, 0);
  const result = backtestStrategyLibrary({
    NVDA: { multiplier: 1, tokenCandles: nvda, underlyingCandles: nvda },
    SPY: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat },
    QQQ: { multiplier: 1, tokenCandles: flat, underlyingCandles: flat }
  }, {
    maxTradeUsdt: 50,
    roundTripCostPct: 0.1,
    maxOpenPositions: 1,
    minNetEdgePct: 0,
    entryCutoffMinutes: 45,
    executionModel: "QUOTE_REPLAY",
    includeReplayEvents: true
  });
  const adaptive = result.strategies.find(({ id }) => id === "adaptive-momentum");

  assert.equal(adaptive.performance.trades, 0);
  assert.equal(adaptive.replay.eventCounts.ORDER_FILLED || 0, 0);
  assert.ok(adaptive.replay.eventCounts.ORDER_REJECTED > 0);
  assert.ok(adaptive.replay.events
    .filter(({ type }) => type === "ORDER_REJECTED")
    .every(({ reason }) => reason === "MISSING_QUOTE"));
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

test("three-control momentum blocks entries whose planned net payoff ratio is below 0.8", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  let price = 100;
  const nvda = Array.from({ length: 390 }, (_, index) => {
    const step = index > 225 && index <= 240 ? 0.08 : 0;
    const open = price;
    price += step;
    return candle(
      start + index * 60_000,
      open,
      Math.max(open, price) + 0.01,
      Math.min(open, price) - 0.01,
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
    roundTripCostPct: 1,
    maxOpenPositions: 3,
    minNetEdgePct: 0,
    entryCutoffMinutes: 45
  });
  const baseline = result.strategies.find(({ id }) => id === "adaptive-momentum");
  const controlled = result.strategies.find(
    ({ id }) => id === "adaptive-momentum-three-controls"
  );

  assert.ok(baseline.entryDiagnostics.signals > 0);
  assert.equal(controlled.performance.trades, 0);
  assert.ok(controlled.entryDiagnostics.payoffBlocked > 0);
});

test("three-control momentum exits a failed entry after 30 minutes before the full stop", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  let price = 100;
  const nvda = Array.from({ length: 390 }, (_, index) => {
    const step = index <= 225 ? 0.02 : -0.02;
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
  const controlled = result.strategies.find(
    ({ id }) => id === "adaptive-momentum-three-controls"
  );
  const earlyFailure = controlled.trades.find(({ reason }) => reason === "EARLY_FAILURE_STOP");

  assert.ok(earlyFailure);
  assert.ok(earlyFailure.returnPct > -1.1);
  assert.ok(controlled.entryDiagnostics.earlyFailureExits > 0);
});
