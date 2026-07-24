import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCandles,
  auditDecision,
  calculateAtrPct,
  costCoverageDecision,
  dailyLossReached,
  dynamicExitDecision,
  initialRiskDecision,
  pendingOrderAction,
  rankCandidates,
  roundTripCostPct,
  simulateRoundTrip,
  uniqueSymbols,
  validateConfig
} from "../src/strategy.mjs";

const config = {
  mode: "shadow",
  symbols: ["NVDA"],
  maxTradeUsdt: 50,
  dailyLossLimitUsdt: 10,
  maxOpenPositions: 1,
  disasterStopLossPct: 8,
  atrPeriod: 14,
  atrStopMultiplier: 1.5,
  minInitialStopPct: 1,
  maxInitialStopPct: 3.5,
  initialStopCostBufferPct: 0.5,
  profitProtectionR: 1,
  trailingAtrMultiplier: 1,
  finalTakeProfitR: 2,
  signalReviewHours: 4,
  signalReviewMinR: 0.5,
  minTrend15mPct: 0.8,
  minDirectionalMinutes: 10,
  maxRoundTripCostPct: 0.7,
  slippagePct: 0.5,
  slippageReservePct: 1,
  estimatedRoundTripGasUsdt: 0.1,
  minNetEdgePct: 0.3,
  quoteMaxAgeSeconds: 10,
  maxQuoteDriftPct: 0.3,
  allowUnsupportedAuditForOfficialRwa: true,
  traceFile: "state/action-trace.jsonl",
  emergencyStopFile: "state/EMERGENCY_STOP",
  emergencyStopHistoryDirectory: "state/emergency-stop-history",
  processLockFile: "state/bot.lock",
  settingsCheckIntervalMinutes: 60,
  sessionWarningHours: 24
};

test("deduplicates the configured universe", () => {
  assert.deepEqual(uniqueSymbols(["nvda", " NVDA ", "aapl"]), ["NVDA", "AAPL"]);
});

test("rejects limits above the user-approved risk envelope", () => {
  assert.throws(() => validateConfig({ ...config, maxTradeUsdt: 51 }), /maxTradeUsdt/);
  assert.throws(() => validateConfig({ ...config, dailyLossLimitUsdt: 11 }), /dailyLossLimitUsdt/);
});

test("rejects stale-quote settings that exceed the execution slippage envelope", () => {
  assert.throws(() => validateConfig({ ...config, quoteMaxAgeSeconds: 31 }), /quoteMaxAgeSeconds/);
  assert.throws(() => validateConfig({ ...config, maxQuoteDriftPct: 0.6 }), /maxQuoteDriftPct/);
});

test("rejects incomplete or unsafe cost-coverage settings", () => {
  assert.throws(() => validateConfig({ ...config, slippageReservePct: -0.1 }), /slippageReservePct/);
  assert.throws(() => validateConfig({ ...config, slippageReservePct: 0.9 }), /slippageReservePct/);
  assert.throws(() => validateConfig({ ...config, estimatedRoundTripGasUsdt: -0.01 }), /estimatedRoundTripGasUsdt/);
  assert.throws(() => validateConfig({ ...config, minNetEdgePct: 0 }), /minNetEdgePct/);
});

test("rejects invalid ATR and R-multiple exit settings", () => {
  assert.throws(() => validateConfig({ ...config, atrPeriod: 1 }), /atrPeriod/);
  assert.throws(() => validateConfig({ ...config, minInitialStopPct: 4 }), /initial stop range/);
  assert.throws(() => validateConfig({ ...config, profitProtectionR: 0 }), /profitProtectionR/);
  assert.throws(() => validateConfig({ ...config, finalTakeProfitR: 0.5 }), /finalTakeProfitR/);
  assert.throws(() => validateConfig({ ...config, signalReviewHours: 0 }), /signalReviewHours/);
});

test("blocks new entries at the daily loss limit", () => {
  assert.equal(dailyLossReached(-9.99, 10), false);
  assert.equal(dailyLossReached(-10, 10), true);
});

test("calculates a 15-minute signal from closed one-minute candles", () => {
  const now = 2_000_000;
  const candles = Array.from({ length: 16 }, (_, index) => {
    const openTime = index * 60_000;
    const close = 100 + index * 0.1;
    return [openTime, String(close), String(close), String(close), String(close), "0", openTime + 59_999];
  });
  const result = analyzeCandles(candles, now);
  assert.ok(result.trend15mPct > 1.4);
  assert.equal(result.upMinutes, 15);
});

test("calculates ATR(14) percent from closed 15-minute candles only", () => {
  const intervalMs = 15 * 60_000;
  const closed = Array.from({ length: 15 }, (_, index) => [
    index * intervalMs,
    "100",
    "101",
    "99",
    "100",
    "0",
    (index + 1) * intervalMs - 1
  ]);
  const stillOpen = [
    15 * intervalMs,
    "100",
    "150",
    "50",
    "100",
    "0",
    16 * intervalMs - 1
  ];

  const result = calculateAtrPct([...closed, stillOpen], 14, 15 * intervalMs);
  assert.ok(Math.abs(result.atrPct - 2) < 1e-9);
  assert.equal(result.closedCandles, 15);
  assert.equal(result.lastCandleTime, 14 * intervalMs);
});

test("derives initial R from ATR and all-in cost and rejects a stop wider than 3.5%", () => {
  assert.deepEqual(initialRiskDecision({
    atr15Pct: 1,
    allInCostPct: 0.7,
    atrStopMultiplier: 1.5,
    costBufferPct: 0.5,
    minStopPct: 1,
    maxStopPct: 3.5
  }), {
    allowed: true,
    reason: "INITIAL_RISK_ALLOWED",
    atrRiskPct: 1.5,
    costRiskPct: 1.2,
    requiredRiskPct: 1.5,
    initialRiskPct: 1.5
  });

  const tooWide = initialRiskDecision({
    atr15Pct: 3,
    allInCostPct: 1,
    atrStopMultiplier: 1.5,
    costBufferPct: 0.5,
    minStopPct: 1,
    maxStopPct: 3.5
  });
  assert.equal(tooWide.allowed, false);
  assert.equal(tooWide.reason, "INITIAL_RISK_EXCEEDS_MAX");
  assert.equal(tooWide.requiredRiskPct, 4.5);
});

test("uses initial R, disaster stop and 2R final take profit", () => {
  const base = {
    initialRiskPct: 2,
    atr15Pct: 1,
    peakReturnPct: 0,
    profitProtectionActive: false,
    openedAtMs: 1_000_000,
    nowMs: 1_060_000,
    signalValid: true,
    disasterStopLossPct: 8,
    profitProtectionR: 1,
    trailingAtrMultiplier: 1,
    finalTakeProfitR: 2,
    signalReviewHours: 4,
    signalReviewMinR: 0.5,
    profitFloorPct: 0.3
  };

  assert.equal(dynamicExitDecision({ ...base, returnPct: -2 }).type, "INITIAL_STOP");
  assert.equal(dynamicExitDecision({ ...base, returnPct: -8.1 }).type, "DISASTER_STOP");
  assert.equal(dynamicExitDecision({ ...base, returnPct: 4 }).type, "TAKE_PROFIT_2R");
});

test("activates profit protection at 1R and exits on a one-ATR peak retracement", () => {
  const base = {
    initialRiskPct: 2,
    atr15Pct: 1,
    profitProtectionActive: false,
    openedAtMs: 1_000_000,
    nowMs: 1_060_000,
    signalValid: true,
    disasterStopLossPct: 8,
    profitProtectionR: 1,
    trailingAtrMultiplier: 1,
    finalTakeProfitR: 2,
    signalReviewHours: 4,
    signalReviewMinR: 0.5,
    profitFloorPct: 0.3
  };
  const activated = dynamicExitDecision({ ...base, returnPct: 2, peakReturnPct: 0 });
  assert.equal(activated.type, null);
  assert.equal(activated.profitProtectionActive, true);
  assert.equal(activated.peakReturnPct, 2);
  assert.equal(activated.trailingStopPct, 1);

  const retraced = dynamicExitDecision({
    ...base,
    returnPct: 0.9,
    peakReturnPct: activated.peakReturnPct,
    profitProtectionActive: activated.profitProtectionActive
  });
  assert.equal(retraced.type, "TRAILING_STOP");
  assert.equal(retraced.trailingStopPct, 1);
});

test("never trails below the all-in cost plus required net edge floor", () => {
  const result = dynamicExitDecision({
    returnPct: 1.6,
    initialRiskPct: 2,
    atr15Pct: 1,
    peakReturnPct: 2,
    profitProtectionActive: true,
    openedAtMs: 1_000_000,
    nowMs: 1_060_000,
    signalValid: true,
    disasterStopLossPct: 8,
    profitProtectionR: 1,
    trailingAtrMultiplier: 1,
    finalTakeProfitR: 2,
    signalReviewHours: 4,
    signalReviewMinR: 0.5,
    profitFloorPct: 1.7
  });

  assert.equal(result.trailingStopPct, 1.7);
  assert.equal(result.type, "TRAILING_STOP");
});

test("after four hours exits only when the signal is invalid and progress is below 0.5R", () => {
  const base = {
    initialRiskPct: 2,
    atr15Pct: 1,
    peakReturnPct: 0.8,
    profitProtectionActive: false,
    openedAtMs: 1_000_000,
    signalValid: false,
    returnPct: 0.8,
    disasterStopLossPct: 8,
    profitProtectionR: 1,
    trailingAtrMultiplier: 1,
    finalTakeProfitR: 2,
    signalReviewHours: 4,
    signalReviewMinR: 0.5,
    profitFloorPct: 0.3
  };

  assert.equal(dynamicExitDecision({ ...base, nowMs: base.openedAtMs + 4 * 60 * 60_000 - 1 }).type, null);
  assert.equal(dynamicExitDecision({ ...base, nowMs: base.openedAtMs + 4 * 60 * 60_000 }).type, "SIGNAL_TIMEOUT");
  assert.equal(dynamicExitDecision({
    ...base,
    nowMs: base.openedAtMs + 4 * 60 * 60_000,
    signalValid: true
  }).type, null);
  assert.equal(dynamicExitDecision({
    ...base,
    nowMs: base.openedAtMs + 4 * 60 * 60_000,
    returnPct: 1.1
  }).type, null);
});

test("ranks only candidates that clear trend, consistency, status and cost gates", () => {
  const ranked = rankCandidates([
    { symbol: "A", openState: true, reasonCode: "TRADING", trend15mPct: 2.3, upMinutes: 12, roundTripCostPct: 0.6 },
    { symbol: "B", openState: true, reasonCode: "TRADING", trend15mPct: 2.5, upMinutes: 11, roundTripCostPct: 0.5 },
    { symbol: "C", openState: true, reasonCode: "TRADING", trend15mPct: 0.5, upMinutes: 14, roundTripCostPct: 0.2 }
  ], config);
  assert.deepEqual(ranked.map((candidate) => candidate.symbol), ["B", "A"]);
});

test("rejects a candidate that clears the raw cost cap but not the all-in coverage gate", () => {
  const ranked = rankCandidates([
    { symbol: "A", openState: true, reasonCode: "TRADING", trend15mPct: 0.9, upMinutes: 12, roundTripCostPct: 0.4 }
  ], config);
  assert.deepEqual(ranked, []);
});

test("calculates quote-based round-trip cost", () => {
  assert.ok(Math.abs(roundTripCostPct(20, 19.88) - 0.6) < 1e-9);
});

test("blocks a trade whose signal cannot cover quote cost, slippage reserve and gas", () => {
  const result = costCoverageDecision({
    tradeUsdt: 50,
    grossEdgeProxyPct: 0.8,
    takeProfitPct: 2,
    quotedRoundTripCostPct: 0.35,
    slippageReservePct: 1,
    estimatedRoundTripGasUsdt: 0.1,
    minNetEdgePct: 0.3
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "INSUFFICIENT_NET_EDGE");
  assert.ok(Math.abs(result.gasCostPct - 0.2) < 1e-9);
  assert.ok(Math.abs(result.allInCostPct - 1.55) < 1e-9);
  assert.ok(result.netEdgeProxyPct < 0);
});

test("allows only a target and signal that retain a positive margin after all costs", () => {
  const result = costCoverageDecision({
    tradeUsdt: 50,
    grossEdgeProxyPct: 2.2,
    takeProfitPct: 3,
    quotedRoundTripCostPct: 0.35,
    slippageReservePct: 1,
    estimatedRoundTripGasUsdt: 0.1,
    minNetEdgePct: 0.3
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "COSTS_COVERED");
  assert.ok(Math.abs(result.netEdgeProxyPct - 0.65) < 1e-9);
  assert.ok(Math.abs(result.netTargetProfitPct - 1.45) < 1e-9);
});

test("keeps pending orders unresolved until the CLI reports a terminal status", () => {
  assert.equal(pendingOrderAction(null), "WAIT");
  assert.equal(pendingOrderAction("PENDING"), "WAIT");
  assert.equal(pendingOrderAction("UNKNOWN"), "WAIT");
});

test("distinguishes finished and failed orders", () => {
  assert.equal(pendingOrderAction("FINISHED"), "FINISH");
  assert.equal(pendingOrderAction("FAILED"), "FAIL");
});

test("allows an unavailable audit only for an acknowledged official RWA contract", () => {
  const result = auditDecision({
    hasResult: false,
    isSupported: false,
    isOfficialRwa: true,
    allowUnsupportedOfficialRwa: true
  });
  assert.deepEqual(result, {
    allowed: true,
    status: "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED"
  });
});

test("fails closed when an unavailable audit is not covered by the narrow RWA exception", () => {
  assert.throws(() => auditDecision({
    hasResult: false,
    isSupported: false,
    isOfficialRwa: false,
    allowUnsupportedOfficialRwa: true
  }), /unavailable/);
  assert.throws(() => auditDecision({
    hasResult: false,
    isSupported: false,
    isOfficialRwa: true,
    allowUnsupportedOfficialRwa: false
  }), /unavailable/);
});

test("enforces risk hits and taxes when Binance supports the token audit", () => {
  assert.deepEqual(auditDecision({
    hasResult: true,
    isSupported: true,
    riskLevel: 1,
    riskLevelEnum: "LOW",
    hits: [],
    buyTax: 0,
    sellTax: 0,
    isOfficialRwa: true,
    allowUnsupportedOfficialRwa: true
  }), {
    allowed: true,
    status: "SUPPORTED_LOW_RISK",
    riskLevel: "LOW",
    buyTax: 0,
    sellTax: 0
  });
  assert.throws(() => auditDecision({
    hasResult: true,
    isSupported: true,
    riskLevel: 2,
    riskLevelEnum: "HIGH",
    hits: [],
    buyTax: 0,
    sellTax: 0
  }), /blocked trade/);
  assert.throws(() => auditDecision({
    hasResult: true,
    isSupported: true,
    riskLevel: 1,
    riskLevelEnum: "LOW",
    hits: [{}],
    buyTax: 0,
    sellTax: 0
  }), /blocked trade/);
  assert.throws(() => auditDecision({
    hasResult: true,
    isSupported: true,
    riskLevel: 1,
    riskLevelEnum: "LOW",
    hits: [],
    buyTax: 6,
    sellTax: 0
  }), /blocked trade/);
});

test("simulates a complete buy and take-profit sell without touching the wallet", () => {
  assert.deepEqual(simulateRoundTrip({
    amountUsdt: 50,
    buyPrice: 100,
    sellPrice: 110
  }), {
    quantity: 0.5,
    proceedsUsdt: 55,
    realizedPnlUsdt: 5,
    returnPct: 10
  });
});
