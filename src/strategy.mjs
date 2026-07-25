export function uniqueSymbols(symbols) {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
}

// Published U.S. cash-equity schedules:
// https://www.nyse.com/markets/hours-calendars (2026-2028)
// https://www.nasdaq.com/market-activity/stock-market-holiday-schedule (2026 cross-check)
const NYSE_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25"
]);

const NYSE_EARLY_CLOSES = new Set([
  "2026-11-27", "2026-12-24",
  "2027-11-26",
  "2028-07-03", "2028-11-24"
]);

function newYorkTimeParts(nowMs) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(nowMs)).map(({ type, value }) => [type, value])
  );
}

export function nyseSessionPlan(nowMs = Date.now()) {
  const parts = newYorkTimeParts(nowMs);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const year = Number(parts.year);
  if (year < 2026 || year > 2028) {
    return {
      calendarSupported: false,
      date,
      calendarDayType: "unsupported",
      regularOpen: false,
      openTime: null,
      closeTime: null
    };
  }
  if (["Sat", "Sun"].includes(parts.weekday)) {
    return {
      calendarSupported: true,
      date,
      calendarDayType: "weekend",
      regularOpen: false,
      openTime: null,
      closeTime: null
    };
  }
  if (NYSE_HOLIDAYS.has(date)) {
    return {
      calendarSupported: true,
      date,
      calendarDayType: "holiday",
      regularOpen: false,
      openTime: null,
      closeTime: null
    };
  }
  const earlyClose = NYSE_EARLY_CLOSES.has(date);
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  const closeMinute = earlyClose ? 13 * 60 : 16 * 60;
  return {
    calendarSupported: true,
    date,
    calendarDayType: earlyClose ? "early-close" : "regular-day",
    regularOpen: minuteOfDay >= 9 * 60 + 30 && minuteOfDay < closeMinute,
    openTime: "09:30",
    closeTime: earlyClose ? "13:00" : "16:00"
  };
}

export function entryMarketAllowed(status, regularOnlyEntries = true, nowMs = Date.now()) {
  const tradable = status?.openState === true && status?.reasonCode === "TRADING";
  if (!tradable) return false;
  return !regularOnlyEntries || (
    status?.marketStatus?.toLowerCase() === "regular" &&
    nyseSessionPlan(nowMs).regularOpen
  );
}

export function entrySessionDecision(entries, regularOnlyEntries = true, nowMs = Date.now()) {
  const symbols = entries
    .filter(({ status }) => entryMarketAllowed(status, regularOnlyEntries, nowMs))
    .map(({ symbol }) => symbol);
  return {
    shouldScan: symbols.length > 0,
    reason: symbols.length > 0 ? "REGULAR_SESSION" : "NON_REGULAR_SESSION",
    symbols
  };
}

export function expectedUsRegularWindow(nowMs = Date.now()) {
  return nyseSessionPlan(nowMs).regularOpen;
}

export function entryStatusCheckDecision({
  nowMs,
  lastMarketStatusCheckAt = 0,
  lastEntryDecisionAt = 0,
  lastMarketSession = null,
  entryIntervalMinutes,
  pollSeconds
}) {
  const awaitingRegularOpen = expectedUsRegularWindow(nowMs) && lastMarketSession !== "regular";
  const intervalMs = awaitingRegularOpen
    ? pollSeconds * 1000
    : entryIntervalMinutes * 60_000;
  const referenceMs = awaitingRegularOpen
    ? Number(lastMarketStatusCheckAt || 0)
    : lastMarketSession === "regular"
      ? Number(lastEntryDecisionAt || 0)
      : Number(lastMarketStatusCheckAt || 0);
  return {
    due: referenceMs === 0 || nowMs - referenceMs >= intervalMs,
    intervalMs,
    reason: awaitingRegularOpen ? "REGULAR_OPEN_TRANSITION" : "STANDARD_ENTRY_CADENCE"
  };
}

export function validateConfig(config) {
  const errors = [];
  if (!["adaptive-momentum", "executable-basis-reversion"].includes(config.defaultStrategyId)) {
    errors.push("defaultStrategyId must be a switchable strategy");
  }
  if (typeof config.strategyControlFile !== "string" || !config.strategyControlFile.trim()) {
    errors.push("strategyControlFile must not be empty");
  }
  if (!(config.basisExitPct <= 0 && config.basisExitPct >= -1)) {
    errors.push("basisExitPct must be between -1 and 0");
  }
  if (!["shadow", "live"].includes(config.mode)) errors.push("mode must be shadow or live");
  if (!Array.isArray(config.symbols) || config.symbols.length === 0) errors.push("symbols must not be empty");
  if (!(config.maxTradeUsdt > 0 && config.maxTradeUsdt <= 50)) errors.push("maxTradeUsdt must be between 0 and 50");
  if (!(config.dailyLossLimitUsdt > 0 && config.dailyLossLimitUsdt <= 10)) errors.push("dailyLossLimitUsdt must be between 0 and 10");
  if (config.maxOpenPositions !== 1) errors.push("maxOpenPositions must be 1");
  if (!(Number.isInteger(config.pollSeconds) && config.pollSeconds > 0 && config.pollSeconds <= 60)) {
    errors.push("pollSeconds must be an integer between 1 and 60");
  }
  if (!(Number.isInteger(config.atrPeriod) && config.atrPeriod >= 2 && config.atrPeriod <= 100)) {
    errors.push("atrPeriod must be an integer between 2 and 100");
  }
  if (!(config.atrStopMultiplier > 0)) errors.push("atrStopMultiplier must be positive");
  if (!(config.entryAtrMultiplier > 0)) errors.push("entryAtrMultiplier must be positive");
  if (!(
    config.minInitialStopPct > 0 &&
    config.maxInitialStopPct >= config.minInitialStopPct &&
    config.maxInitialStopPct < config.disasterStopLossPct
  )) {
    errors.push("initial stop range must be positive, ordered, and below disasterStopLossPct");
  }
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
  if (typeof config.marketDataDirectory !== "string" || !config.marketDataDirectory.trim()) {
    errors.push("marketDataDirectory must not be empty");
  }
  if (!(config.quoteMaxAgeSeconds > 0 && config.quoteMaxAgeSeconds <= 30)) {
    errors.push("quoteMaxAgeSeconds must be between 0 and 30");
  }
  if (!(config.maxQuoteDriftPct > 0 && config.maxQuoteDriftPct <= config.slippagePct)) {
    errors.push("maxQuoteDriftPct must be positive and no greater than slippagePct");
  }
  if (!(config.executionBufferPct >= 0 && config.executionBufferPct <= config.slippagePct)) {
    errors.push("executionBufferPct must be between 0 and slippagePct");
  }
  if (!(config.estimatedRoundTripGasUsdt >= 0 && config.estimatedRoundTripGasUsdt <= config.maxTradeUsdt)) {
    errors.push("estimatedRoundTripGasUsdt must be between 0 and maxTradeUsdt");
  }
  if (!(config.minNetEdgePct > 0)) {
    errors.push("minNetEdgePct must be positive");
  }
  if (config.regularOnlyEntries !== true) {
    errors.push("regularOnlyEntries must be true");
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
  executionBufferPct,
  estimatedRoundTripGasUsdt
}) {
  const inputs = [tradeUsdt, quotedRoundTripCostPct, executionBufferPct, estimatedRoundTripGasUsdt];
  if (!(tradeUsdt > 0) || inputs.some((value) => !Number.isFinite(value))) return null;
  const gasCostPct = (Math.max(0, estimatedRoundTripGasUsdt) / tradeUsdt) * 100;
  const quoteCostPct = Math.max(0, quotedRoundTripCostPct);
  return {
    quoteCostPct,
    executionBufferPct: Math.max(0, executionBufferPct),
    gasCostPct,
    allInCostPct: quoteCostPct + Math.max(0, executionBufferPct) + gasCostPct
  };
}

export function initialRiskDecision({
  atr15Pct,
  atrStopMultiplier,
  minStopPct,
  maxStopPct
}) {
  const inputs = [atr15Pct, atrStopMultiplier, minStopPct, maxStopPct];
  if (inputs.some((value) => !Number.isFinite(value))) {
    return { allowed: false, reason: "INVALID_INITIAL_RISK_INPUT" };
  }

  const atrRiskPct = Math.max(0, atr15Pct) * atrStopMultiplier;
  const requiredRiskPct = atrRiskPct;
  const initialRiskPct = Math.min(maxStopPct, Math.max(minStopPct, requiredRiskPct));
  return {
    allowed: true,
    reason: "INITIAL_RISK_ALLOWED",
    atrRiskPct,
    requiredRiskPct,
    initialRiskPct
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
  executionBufferPct,
  estimatedRoundTripGasUsdt,
  minNetEdgePct
}) {
  const inputs = [
    tradeUsdt,
    grossEdgeProxyPct,
    takeProfitPct,
    quotedRoundTripCostPct,
    executionBufferPct,
    estimatedRoundTripGasUsdt,
    minNetEdgePct
  ];
  if (!(tradeUsdt > 0) || inputs.some((value) => !Number.isFinite(value))) {
    return { allowed: false, reason: "INVALID_COST_ESTIMATE" };
  }

  const estimate = executionCostEstimate({
    tradeUsdt,
    quotedRoundTripCostPct,
    executionBufferPct,
    estimatedRoundTripGasUsdt
  });
  const { quoteCostPct, gasCostPct, allInCostPct } = estimate;
  const netEdgeProxyPct = grossEdgeProxyPct - allInCostPct;
  const netTargetProfitPct = takeProfitPct - allInCostPct;
  const details = {
    quoteCostPct,
    executionBufferPct: Math.max(0, executionBufferPct),
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
    .filter((candidate) => candidate.trend15mPct + 1e-9 >= candidate.atr15Pct * config.entryAtrMultiplier)
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
        executionBufferPct: config.executionBufferPct,
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
