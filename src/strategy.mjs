export function uniqueSymbols(symbols) {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
}

export function validateConfig(config) {
  const errors = [];
  if (!["shadow", "live"].includes(config.mode)) errors.push("mode must be shadow or live");
  if (!Array.isArray(config.symbols) || config.symbols.length === 0) errors.push("symbols must not be empty");
  if (!(config.maxTradeUsdt > 0 && config.maxTradeUsdt <= 50)) errors.push("maxTradeUsdt must be between 0 and 50");
  if (!(config.dailyLossLimitUsdt > 0 && config.dailyLossLimitUsdt <= 10)) errors.push("dailyLossLimitUsdt must be between 0 and 10");
  if (config.maxOpenPositions !== 1) errors.push("maxOpenPositions must be 1");
  if (!(Number.isInteger(config.atrPeriod) && config.atrPeriod >= 2 && config.atrPeriod <= 100)) {
    errors.push("atrPeriod must be an integer between 2 and 100");
  }
  if (!(config.atrStopMultiplier > 0)) errors.push("atrStopMultiplier must be positive");
  if (!(
    config.minInitialStopPct > 0 &&
    config.maxInitialStopPct >= config.minInitialStopPct &&
    config.maxInitialStopPct < config.disasterStopLossPct
  )) {
    errors.push("initial stop range must be positive, ordered, and below disasterStopLossPct");
  }
  if (!(config.initialStopCostBufferPct >= 0)) errors.push("initialStopCostBufferPct must not be negative");
  if (!(config.profitProtectionR > 0)) errors.push("profitProtectionR must be positive");
  if (!(config.trailingAtrMultiplier > 0)) errors.push("trailingAtrMultiplier must be positive");
  if (!(config.finalTakeProfitR > config.profitProtectionR)) {
    errors.push("finalTakeProfitR must be greater than profitProtectionR");
  }
  if (!(config.signalReviewHours > 0)) errors.push("signalReviewHours must be positive");
  if (!(config.signalReviewMinR >= 0 && config.signalReviewMinR < config.profitProtectionR)) {
    errors.push("signalReviewMinR must be between 0 and profitProtectionR");
  }
  if (typeof config.allowUnsupportedAuditForOfficialRwa !== "boolean") {
    errors.push("allowUnsupportedAuditForOfficialRwa must be boolean");
  }
  if (typeof config.traceFile !== "string" || !config.traceFile.trim()) {
    errors.push("traceFile must not be empty");
  }
  if (!(config.quoteMaxAgeSeconds > 0 && config.quoteMaxAgeSeconds <= 30)) {
    errors.push("quoteMaxAgeSeconds must be between 0 and 30");
  }
  if (!(config.maxQuoteDriftPct > 0 && config.maxQuoteDriftPct <= config.slippagePct)) {
    errors.push("maxQuoteDriftPct must be positive and no greater than slippagePct");
  }
  if (!(config.slippageReservePct >= config.slippagePct * 2 && config.slippageReservePct <= 5)) {
    errors.push("slippageReservePct must cover both swap legs and be no greater than 5");
  }
  if (!(config.estimatedRoundTripGasUsdt >= 0 && config.estimatedRoundTripGasUsdt <= config.maxTradeUsdt)) {
    errors.push("estimatedRoundTripGasUsdt must be between 0 and maxTradeUsdt");
  }
  if (!(config.minNetEdgePct > 0)) {
    errors.push("minNetEdgePct must be positive");
  }
  if (typeof config.emergencyStopFile !== "string" || !config.emergencyStopFile.trim()) {
    errors.push("emergencyStopFile must not be empty");
  }
  if (typeof config.emergencyStopHistoryDirectory !== "string" || !config.emergencyStopHistoryDirectory.trim()) {
    errors.push("emergencyStopHistoryDirectory must not be empty");
  }
  if (typeof config.processLockFile !== "string" || !config.processLockFile.trim()) {
    errors.push("processLockFile must not be empty");
  }
  if (config.requireTradeApproval !== true) {
    errors.push("requireTradeApproval must be true");
  }
  if (!(Number.isInteger(config.approvalTtlSeconds) && config.approvalTtlSeconds >= 30 && config.approvalTtlSeconds <= 900)) {
    errors.push("approvalTtlSeconds must be an integer between 30 and 900");
  }
  if (typeof config.approvalDecisionDirectory !== "string" || !config.approvalDecisionDirectory.trim()) {
    errors.push("approvalDecisionDirectory must not be empty");
  }
  if (!(config.settingsCheckIntervalMinutes >= 15)) {
    errors.push("settingsCheckIntervalMinutes must be at least 15");
  }
  if (!(config.sessionWarningHours > 0)) {
    errors.push("sessionWarningHours must be positive");
  }
  if (errors.length) throw new Error(errors.join("; "));
}

export function auditDecision({
  hasResult,
  isSupported,
  riskLevel,
  riskLevelEnum,
  hits = [],
  buyTax = 0,
  sellTax = 0,
  isOfficialRwa = false,
  allowUnsupportedOfficialRwa = false
}) {
  if (!hasResult || !isSupported) {
    if (isOfficialRwa && allowUnsupportedOfficialRwa) {
      return {
        allowed: true,
        status: "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED"
      };
    }
    throw new Error("Token audit data is unavailable");
  }
  if (riskLevel > 1 || hits.length || buyTax > 5 || sellTax > 5) {
    throw new Error(`Token audit blocked trade: risk=${riskLevelEnum}, hits=${hits.length}, buyTax=${buyTax}, sellTax=${sellTax}`);
  }
  return {
    allowed: true,
    status: "SUPPORTED_LOW_RISK",
    riskLevel: riskLevelEnum,
    buyTax,
    sellTax
  };
}

export function dailyLossReached(realizedPnlUsdt, limitUsdt) {
  return realizedPnlUsdt <= -Math.abs(limitUsdt);
}

export function analyzeCandles(candles, nowMs = Date.now()) {
  const closed = candles.filter((candle) => Number(candle[6]) < nowMs);
  const recent = closed.slice(-16);
  if (recent.length < 16) return null;

  const closes = recent.map((candle) => Number(candle[4]));
  const changes = closes.slice(1).map((value, index) => value - closes[index]);
  const upMinutes = changes.filter((change) => change > 0).length;
  const downMinutes = changes.filter((change) => change < 0).length;
  const trend15mPct = ((closes.at(-1) / closes[0]) - 1) * 100;

  return {
    trend15mPct,
    upMinutes,
    downMinutes,
    lastPrice: closes.at(-1),
    lastCandleTime: Number(recent.at(-1)[0])
  };
}

export function calculateAtrPct(candles, period = 14, nowMs = Date.now()) {
  const closed = candles.filter((candle) => Number(candle[6]) < nowMs);
  const recent = closed.slice(-(period + 1));
  if (recent.length < period + 1) return null;

  const trueRanges = recent.slice(1).map((candle, index) => {
    const high = Number(candle[2]);
    const low = Number(candle[3]);
    const previousClose = Number(recent[index][4]);
    if (![high, low, previousClose].every(Number.isFinite)) return NaN;
    return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  });
  const lastPrice = Number(recent.at(-1)[4]);
  if (!(lastPrice > 0) || trueRanges.some((value) => !Number.isFinite(value))) return null;

  const atr = trueRanges.reduce((sum, value) => sum + value, 0) / period;
  return {
    atr,
    atrPct: (atr / lastPrice) * 100,
    period,
    closedCandles: closed.length,
    lastPrice,
    lastCandleTime: Number(recent.at(-1)[0])
  };
}

export function roundTripCostPct(spendUsdt, quotedProceedsUsdt) {
  return (1 - (quotedProceedsUsdt / spendUsdt)) * 100;
}

export function executionCostEstimate({
  tradeUsdt,
  quotedRoundTripCostPct,
  slippageReservePct,
  estimatedRoundTripGasUsdt
}) {
  const inputs = [tradeUsdt, quotedRoundTripCostPct, slippageReservePct, estimatedRoundTripGasUsdt];
  if (!(tradeUsdt > 0) || inputs.some((value) => !Number.isFinite(value))) return null;
  const gasCostPct = (Math.max(0, estimatedRoundTripGasUsdt) / tradeUsdt) * 100;
  const quoteCostPct = Math.max(0, quotedRoundTripCostPct);
  return {
    quoteCostPct,
    slippageReservePct: Math.max(0, slippageReservePct),
    gasCostPct,
    allInCostPct: quoteCostPct + Math.max(0, slippageReservePct) + gasCostPct
  };
}

export function initialRiskDecision({
  atr15Pct,
  allInCostPct,
  atrStopMultiplier,
  costBufferPct,
  minStopPct,
  maxStopPct
}) {
  const inputs = [atr15Pct, allInCostPct, atrStopMultiplier, costBufferPct, minStopPct, maxStopPct];
  if (inputs.some((value) => !Number.isFinite(value))) {
    return { allowed: false, reason: "INVALID_INITIAL_RISK_INPUT" };
  }

  const atrRiskPct = Math.max(0, atr15Pct) * atrStopMultiplier;
  const costRiskPct = Math.max(0, allInCostPct) + Math.max(0, costBufferPct);
  const requiredRiskPct = Math.max(minStopPct, atrRiskPct, costRiskPct);
  if (requiredRiskPct > maxStopPct + 1e-9) {
    return {
      allowed: false,
      reason: "INITIAL_RISK_EXCEEDS_MAX",
      atrRiskPct,
      costRiskPct,
      requiredRiskPct,
      initialRiskPct: null
    };
  }
  return {
    allowed: true,
    reason: "INITIAL_RISK_ALLOWED",
    atrRiskPct,
    costRiskPct,
    requiredRiskPct,
    initialRiskPct: requiredRiskPct
  };
}

export function dynamicExitDecision({
  returnPct,
  initialRiskPct,
  atr15Pct,
  peakReturnPct = 0,
  profitProtectionActive = false,
  openedAtMs,
  nowMs = Date.now(),
  signalValid,
  disasterStopLossPct,
  profitProtectionR,
  trailingAtrMultiplier,
  finalTakeProfitR,
  signalReviewHours,
  signalReviewMinR,
  profitFloorPct = 0
}) {
  const updatedPeakReturnPct = Math.max(Number.isFinite(peakReturnPct) ? peakReturnPct : 0, returnPct);
  const protectionThresholdPct = initialRiskPct * profitProtectionR;
  const protectionActive = profitProtectionActive || updatedPeakReturnPct >= protectionThresholdPct;
  const trailingStopPct = protectionActive
    ? Math.max(profitFloorPct, updatedPeakReturnPct - atr15Pct * trailingAtrMultiplier)
    : null;
  const common = {
    returnPct,
    peakReturnPct: updatedPeakReturnPct,
    profitProtectionActive: protectionActive,
    trailingStopPct,
    protectionThresholdPct,
    finalTakeProfitPct: initialRiskPct * finalTakeProfitR
  };
  const epsilon = 1e-9;

  if (returnPct <= -Math.abs(disasterStopLossPct) + epsilon) {
    return { type: "DISASTER_STOP", ...common };
  }
  if (returnPct <= -Math.abs(initialRiskPct) + epsilon) {
    return { type: "INITIAL_STOP", ...common };
  }
  if (returnPct >= common.finalTakeProfitPct - epsilon) {
    return { type: "TAKE_PROFIT_2R", ...common };
  }
  if (protectionActive && returnPct <= trailingStopPct + epsilon) {
    return { type: "TRAILING_STOP", ...common };
  }

  const heldMs = Math.max(0, nowMs - openedAtMs);
  const reviewAfterMs = signalReviewHours * 60 * 60_000;
  const minimumProgressPct = initialRiskPct * signalReviewMinR;
  if (heldMs >= reviewAfterMs && signalValid === false && returnPct < minimumProgressPct) {
    return {
      type: "SIGNAL_TIMEOUT",
      ...common,
      heldMs,
      minimumProgressPct
    };
  }
  return {
    type: null,
    ...common,
    heldMs,
    minimumProgressPct
  };
}

export function costCoverageDecision({
  tradeUsdt,
  grossEdgeProxyPct,
  takeProfitPct,
  quotedRoundTripCostPct,
  slippageReservePct,
  estimatedRoundTripGasUsdt,
  minNetEdgePct
}) {
  const inputs = [
    tradeUsdt,
    grossEdgeProxyPct,
    takeProfitPct,
    quotedRoundTripCostPct,
    slippageReservePct,
    estimatedRoundTripGasUsdt,
    minNetEdgePct
  ];
  if (!(tradeUsdt > 0) || inputs.some((value) => !Number.isFinite(value))) {
    return { allowed: false, reason: "INVALID_COST_ESTIMATE" };
  }

  const estimate = executionCostEstimate({
    tradeUsdt,
    quotedRoundTripCostPct,
    slippageReservePct,
    estimatedRoundTripGasUsdt
  });
  const { quoteCostPct, gasCostPct, allInCostPct } = estimate;
  const netEdgeProxyPct = grossEdgeProxyPct - allInCostPct;
  const netTargetProfitPct = takeProfitPct - allInCostPct;
  const details = {
    quoteCostPct,
    slippageReservePct: Math.max(0, slippageReservePct),
    gasCostPct,
    allInCostPct,
    netEdgeProxyPct,
    netTargetProfitPct,
    minNetEdgePct
  };

  if (netTargetProfitPct < minNetEdgePct) {
    return { allowed: false, reason: "TARGET_DOES_NOT_COVER_COSTS", ...details };
  }
  if (netEdgeProxyPct < minNetEdgePct) {
    return { allowed: false, reason: "INSUFFICIENT_NET_EDGE", ...details };
  }
  return { allowed: true, reason: "COSTS_COVERED", ...details };
}

export function simulateRoundTrip({ amountUsdt, buyPrice, sellPrice }) {
  const quantity = amountUsdt / buyPrice;
  const proceedsUsdt = quantity * sellPrice;
  const realizedPnlUsdt = proceedsUsdt - amountUsdt;
  return {
    quantity,
    proceedsUsdt,
    realizedPnlUsdt,
    returnPct: (realizedPnlUsdt / amountUsdt) * 100
  };
}

export function pendingOrderAction(status) {
  if (!status || status === "PENDING") return "WAIT";
  if (status === "FAILED") return "FAIL";
  if (status === "FINISHED") return "FINISH";
  return "WAIT";
}

export function rankCandidates(candidates, config) {
  return candidates
    .filter((candidate) => candidate.openState && candidate.reasonCode === "TRADING")
    .filter((candidate) => candidate.trend15mPct >= config.minTrend15mPct)
    .filter((candidate) => candidate.upMinutes >= config.minDirectionalMinutes)
    .filter((candidate) => candidate.roundTripCostPct <= config.maxRoundTripCostPct)
    .filter((candidate) => candidate.initialRisk?.allowed !== false)
    .map((candidate) => ({
      ...candidate,
      costCoverage: candidate.costCoverage || costCoverageDecision({
        tradeUsdt: config.maxTradeUsdt,
        grossEdgeProxyPct: candidate.trend15mPct,
        takeProfitPct: (candidate.initialRiskPct || config.maxInitialStopPct) * config.finalTakeProfitR,
        quotedRoundTripCostPct: candidate.roundTripCostPct,
        slippageReservePct: config.slippageReservePct,
        estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt,
        minNetEdgePct: config.minNetEdgePct
      })
    }))
    .filter((candidate) => candidate.costCoverage.allowed)
    .sort((left, right) => {
      const leftScore = left.costCoverage.netEdgeProxyPct;
      const rightScore = right.costCoverage.netEdgeProxyPct;
      return rightScore - leftScore;
    });
}
