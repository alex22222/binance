export {
  analyzeCandles,
  calculateAtrPct
} from "./strategy-signals.mjs";
export { dynamicExitDecision } from "./strategy-exit.mjs";

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

const FOMC_ENTRY_BLACKOUT_START_MINUTE = 13 * 60 + 50;
const FOMC_ENTRY_BLACKOUT_END_MINUTE = 15 * 60 + 15;

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

export function entryMarketAllowed(
  status,
  regularOnlyEntries = true,
  nowMs = Date.now(),
  entryCutoffMinutes = 0
) {
  const tradable = status?.openState === true && status?.reasonCode === "TRADING";
  if (!tradable) return false;
  if (!regularOnlyEntries) return true;
  const plan = nyseSessionPlan(nowMs);
  if (status?.marketStatus?.toLowerCase() !== "regular" || !plan.regularOpen) return false;
  const parts = newYorkTimeParts(nowMs);
  const closeHour = Number(plan.closeTime?.slice(0, 2));
  const closeMinute = Number(plan.closeTime?.slice(3, 5));
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  return minuteOfDay < closeHour * 60 + closeMinute - entryCutoffMinutes;
}

export function entrySessionDecision(
  entries,
  regularOnlyEntries = true,
  nowMs = Date.now(),
  entryCutoffMinutes = 0
) {
  const symbols = entries
    .filter(({ status }) => entryMarketAllowed(
      status,
      regularOnlyEntries,
      nowMs,
      entryCutoffMinutes
    ))
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

export function fomcEntryBlackoutDecision({
  nowMs = Date.now(),
  dates = []
}) {
  const parts = newYorkTimeParts(nowMs);
  const nyseDate = `${parts.year}-${parts.month}-${parts.day}`;
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  const blocked = (
    dates.includes(nyseDate) &&
    minuteOfDay >= FOMC_ENTRY_BLACKOUT_START_MINUTE &&
    minuteOfDay < FOMC_ENTRY_BLACKOUT_END_MINUTE
  );
  return {
    allowed: !blocked,
    reason: blocked ? "FOMC_ENTRY_BLACKOUT" : "OUTSIDE_FOMC_ENTRY_BLACKOUT",
    nyseDate,
    startTime: "13:50",
    endTime: "15:15"
  };
}

function shiftDate(date, days) {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function isNyseTradingDate(date) {
  if (NYSE_HOLIDAYS.has(date)) return false;
  const day = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function recentNyseTradingDates(date, count) {
  const dates = [];
  let cursor = date;
  while (dates.length < count) {
    if (isNyseTradingDate(cursor)) dates.push(cursor);
    cursor = shiftDate(cursor, -1);
  }
  return dates;
}

function nyseTradingDateAfter(date, count) {
  let cursor = date;
  let remaining = count;
  while (remaining > 0) {
    cursor = shiftDate(cursor, 1);
    if (isNyseTradingDate(cursor)) remaining -= 1;
  }
  return cursor;
}

export function initialStopPolicyUpdate({
  symbol,
  initialStopHistory = [],
  quarantineUntilBySymbol = {},
  nowMs = Date.now()
}) {
  const nyseDate = nyseSessionPlan(nowMs).date;
  const recentDates = new Set(recentNyseTradingDates(nyseDate, 5));
  const previousRecentStops = initialStopHistory.filter(
    (entry) => entry.symbol === symbol && recentDates.has(entry.nyseDate)
  );
  const nextHistory = [
    ...initialStopHistory,
    {
      symbol,
      nyseDate,
      timestamp: new Date(nowMs).toISOString()
    }
  ].slice(-100);
  const nextQuarantine = { ...quarantineUntilBySymbol };
  if (previousRecentStops.length >= 1) {
    nextQuarantine[symbol] = nyseTradingDateAfter(nyseDate, 5);
  }
  return {
    initialStopHistory: nextHistory,
    quarantineUntilBySymbol: nextQuarantine
  };
}

export function entrySymbolPolicyDecision({
  symbol,
  blockedSymbols = [],
  initialStopHistory = [],
  quarantineUntilBySymbol = {},
  nowMs = Date.now()
}) {
  if (blockedSymbols.includes(symbol)) {
    return { allowed: false, reason: "CONFIGURED_SYMBOL_BLOCK" };
  }
  const nyseDate = nyseSessionPlan(nowMs).date;
  if (initialStopHistory.some(
    (entry) => entry.symbol === symbol && entry.nyseDate === nyseDate
  )) {
    return { allowed: false, reason: "INITIAL_STOP_SAME_SESSION" };
  }
  const quarantineUntil = quarantineUntilBySymbol[symbol];
  if (quarantineUntil && nyseDate <= quarantineUntil) {
    return { allowed: false, reason: "INITIAL_STOP_QUARANTINE" };
  }
  return { allowed: true, reason: "SYMBOL_POLICY_ALLOWED" };
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

export function positionSignalRefreshDecision({
  nowMs,
  lastSignalRefreshAt = 0,
  entryIntervalMinutes
}) {
  const intervalMs = entryIntervalMinutes * 60_000;
  const previousRefreshMs = Number(lastSignalRefreshAt || 0);
  return {
    due: previousRefreshMs === 0 || nowMs - previousRefreshMs >= intervalMs,
    intervalMs
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
  if (!(Number.isInteger(config.maxOpenPositions) && config.maxOpenPositions >= 1 && config.maxOpenPositions <= 3)) {
    errors.push("maxOpenPositions must be an integer between 1 and 3");
  }
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
  if (!(
    Number.isInteger(config.entryCutoffMinutes) &&
    config.entryCutoffMinutes >= 1 &&
    config.entryCutoffMinutes <= 120
  )) {
    errors.push("entryCutoffMinutes must be an integer between 1 and 120");
  }
  if (
    !Array.isArray(config.entryBlockedSymbols) ||
    config.entryBlockedSymbols.some((symbol) => typeof symbol !== "string" || symbol !== symbol.trim().toUpperCase())
  ) {
    errors.push("entryBlockedSymbols must be an array of uppercase symbols");
  }
  if (
    !Array.isArray(config.fomcEntryBlackoutDates) ||
    config.fomcEntryBlackoutDates.some((date) => (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ))
  ) {
    errors.push("fomcEntryBlackoutDates must be an array of YYYY-MM-DD dates");
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

export function shadowDowntrendVetoDecision(candles, atr15Pct, nowMs = Date.now()) {
  const base = {
    id: "shadow-downtrend-veto",
    mode: "SHADOW",
    enforced: false,
    source: "TOKEN_15M_CLOSED_CANDLES",
    thresholds: {
      return60mAtr: -1,
      return120mAtr: -1.5,
      emaPeriod: 8,
      emaSlopeLookbackBars: 4
    }
  };
  if (!(Number.isFinite(atr15Pct) && atr15Pct > 0)) {
    return { ...base, decision: "INSUFFICIENT_DATA", reason: "INVALID_ATR" };
  }

  const closed = candles.filter((candle) => Number(candle[6]) < nowMs);
  if (closed.length < 13) {
    return {
      ...base,
      decision: "INSUFFICIENT_DATA",
      reason: "INSUFFICIENT_CLOSED_CANDLES",
      closedCandles: closed.length
    };
  }

  const recent = closed.slice(-13).map((candle) => Number(candle[4]));
  if (recent.some((close) => !Number.isFinite(close) || close <= 0)) {
    return {
      ...base,
      decision: "INSUFFICIENT_DATA",
      reason: "INVALID_CANDLE",
      closedCandles: closed.length
    };
  }
  const lastPrice = recent.at(-1);
  const return60mPct = ((lastPrice / recent.at(-5)) - 1) * 100;
  const return120mPct = ((lastPrice / recent.at(-9)) - 1) * 100;
  const alpha = 2 / (base.thresholds.emaPeriod + 1);
  const emaValues = recent.reduce((values, close) => {
    const previous = values.at(-1);
    values.push(previous == null ? close : close * alpha + previous * (1 - alpha));
    return values;
  }, []);
  const ema8 = emaValues.at(-1);
  const ema8Prior = emaValues.at(-(base.thresholds.emaSlopeLookbackBars + 1));
  const conditions = {
    return60m: return60mPct <= base.thresholds.return60mAtr * atr15Pct,
    return120m: return120mPct <= base.thresholds.return120mAtr * atr15Pct,
    belowFallingEma8: lastPrice < ema8 && ema8 < ema8Prior
  };
  const wouldBlock = Object.values(conditions).every(Boolean);

  return {
    ...base,
    decision: wouldBlock ? "WOULD_BLOCK" : "WOULD_ALLOW",
    reason: wouldBlock ? "PERSISTENT_DOWNTREND" : "NO_PERSISTENT_DOWNTREND",
    closedCandles: closed.length,
    lastPrice,
    return60mPct,
    return120mPct,
    ema8,
    ema8SlopePct: ((ema8 / ema8Prior) - 1) * 100,
    atr15Pct,
    conditions
  };
}

export function shadowTrendPullbackDecision({
  minuteCandles,
  atrCandles,
  atr15Pct,
  nowMs = Date.now()
}) {
  const base = {
    id: "shadow-trend-pullback-confirmation",
    mode: "SHADOW",
    enforced: false,
    source: "TOKEN_1M_AND_15M_CLOSED_CANDLES",
    thresholds: {
      minTrend60mAtr: 0.75,
      minPullbackAtr: 0.3,
      maxPullbackAtr: 0.8,
      recaptureLookbackMinutes: 3
    }
  };
  if (!(Number.isFinite(atr15Pct) && atr15Pct > 0)) {
    return { ...base, decision: "INSUFFICIENT_DATA", reason: "INVALID_ATR" };
  }

  const fifteenMinuteCloses = atrCandles
    .filter((candle) => Number(candle[6]) < nowMs)
    .slice(-5)
    .map((candle) => Number(candle[4]));
  const minuteCloses = minuteCandles
    .filter((candle) => Number(candle[6]) < nowMs)
    .slice(-(base.thresholds.recaptureLookbackMinutes + 1))
    .map((candle) => Number(candle[4]));
  if (
    fifteenMinuteCloses.length < 5 ||
    minuteCloses.length < base.thresholds.recaptureLookbackMinutes + 1 ||
    [...fifteenMinuteCloses, ...minuteCloses].some((close) => !Number.isFinite(close) || close <= 0)
  ) {
    return {
      ...base,
      decision: "INSUFFICIENT_DATA",
      reason: "INSUFFICIENT_CLOSED_CANDLES",
      fifteenMinuteCandles: fifteenMinuteCloses.length,
      minuteCandles: minuteCloses.length
    };
  }

  const lastPrice = fifteenMinuteCloses.at(-1);
  const recentHigh = Math.max(...fifteenMinuteCloses);
  const return60mPct = ((lastPrice / fifteenMinuteCloses[0]) - 1) * 100;
  const pullbackDepthPct = ((recentHigh - lastPrice) / recentHigh) * 100;
  const pullbackDepthAtr = pullbackDepthPct / atr15Pct;
  const priorMinuteHigh = Math.max(...minuteCloses.slice(0, -1));
  const conditions = {
    establishedTrend: return60mPct >= base.thresholds.minTrend60mAtr * atr15Pct,
    controlledPullback: (
      pullbackDepthAtr >= base.thresholds.minPullbackAtr &&
      pullbackDepthAtr <= base.thresholds.maxPullbackAtr
    ),
    minuteRecapture: minuteCloses.at(-1) > priorMinuteHigh
  };
  let decision = "WOULD_ENTER";
  let reason = "PULLBACK_RECONFIRMED";
  if (!conditions.establishedTrend) {
    decision = "WOULD_SKIP";
    reason = "NO_ESTABLISHED_UPTREND";
  } else if (pullbackDepthAtr > base.thresholds.maxPullbackAtr) {
    decision = "WOULD_SKIP";
    reason = "PULLBACK_TOO_DEEP";
  } else if (!conditions.controlledPullback) {
    decision = "WOULD_WAIT";
    reason = "WAITING_FOR_CONTROLLED_PULLBACK";
  } else if (!conditions.minuteRecapture) {
    decision = "WOULD_WAIT";
    reason = "WAITING_FOR_MINUTE_RECAPTURE";
  }

  return {
    ...base,
    decision,
    reason,
    lastPrice,
    recentHigh,
    return60mPct,
    pullbackDepthPct,
    pullbackDepthAtr,
    priorMinuteHigh,
    atr15Pct,
    conditions
  };
}

export function shadowMarketRegimeDecision(candidates) {
  const base = {
    id: "shadow-market-regime-filter",
    mode: "SHADOW",
    enforced: false,
    source: "SPY_QQQ_TOKEN_15M_CLOSED_CANDLES",
    benchmarks: ["SPY", "QQQ"]
  };
  const benchmarkStates = base.benchmarks.map((symbol) => {
    const candidate = candidates.find((entry) => entry.symbol === symbol);
    return candidate ? {
      symbol,
      return60mPct: candidate.shadowDowntrendVeto?.return60mPct,
      return120mPct: candidate.shadowDowntrendVeto?.return120mPct,
      downtrendDecision: candidate.shadowDowntrendVeto?.decision,
      highVolatility: candidate.shadowTrendQuality?.highVolatility === true
    } : null;
  }).filter(Boolean);
  if (
    benchmarkStates.length < base.benchmarks.length ||
    benchmarkStates.some(({ return60mPct }) => !Number.isFinite(return60mPct))
  ) {
    return {
      ...base,
      decision: "INSUFFICIENT_DATA",
      reason: "BENCHMARK_DATA_UNAVAILABLE",
      benchmarkStates
    };
  }

  const conditions = {
    broadNegative60m: benchmarkStates.every(({ return60mPct }) => return60mPct < 0),
    persistentBenchmarkDowntrend: benchmarkStates.some(
      ({ downtrendDecision }) => downtrendDecision === "WOULD_BLOCK"
    )
  };
  const wouldBlock = Object.values(conditions).every(Boolean);
  return {
    ...base,
    decision: wouldBlock ? "WOULD_BLOCK" : "WOULD_ALLOW",
    reason: wouldBlock
      ? "BROAD_PERSISTENT_MARKET_DOWNTREND"
      : "NO_BROAD_PERSISTENT_MARKET_DOWNTREND",
    conditions,
    benchmarkStates
  };
}

export function shadowTrendQualityDecision(candles, atr15Pct, nowMs = Date.now()) {
  const base = {
    id: "shadow-trend-quality",
    mode: "SHADOW",
    enforced: false,
    source: "TOKEN_15M_CLOSED_CANDLES",
    thresholds: {
      highVolatilityAtrPct: 1.5,
      efficiencyLookbackBars: 8,
      minTrendEfficiency: 0.35
    }
  };
  if (!(Number.isFinite(atr15Pct) && atr15Pct > 0)) {
    return { ...base, decision: "INSUFFICIENT_DATA", reason: "INVALID_ATR" };
  }

  const recent = candles
    .filter((candle) => Number(candle[6]) < nowMs)
    .slice(-(base.thresholds.efficiencyLookbackBars + 1))
    .map((candle) => Number(candle[4]));
  if (
    recent.length < base.thresholds.efficiencyLookbackBars + 1 ||
    recent.some((close) => !Number.isFinite(close) || close <= 0)
  ) {
    return {
      ...base,
      decision: "INSUFFICIENT_DATA",
      reason: "INSUFFICIENT_CLOSED_CANDLES",
      closedCandles: recent.length
    };
  }

  const pathLength = recent.slice(1).reduce(
    (sum, close, index) => sum + Math.abs(close - recent[index]),
    0
  );
  const netMove = Math.abs(recent.at(-1) - recent[0]);
  const trendEfficiency = pathLength > 0 ? netMove / pathLength : 0;
  const highVolatility = atr15Pct >= base.thresholds.highVolatilityAtrPct;
  const lowEfficiency = trendEfficiency < base.thresholds.minTrendEfficiency;
  const wouldBlock = highVolatility && lowEfficiency;
  return {
    ...base,
    decision: wouldBlock ? "WOULD_BLOCK" : "WOULD_ALLOW",
    reason: wouldBlock ? "HIGH_VOLATILITY_CHOP" : "TREND_QUALITY_ACCEPTABLE",
    atr15Pct,
    trendEfficiency,
    highVolatility,
    lowEfficiency
  };
}

export function shadowEntryFailureDecision({
  heldMs,
  signalValid,
  peakReturnPct,
  returnPct,
  initialRiskPct
}) {
  const base = {
    id: "shadow-entry-failure-stop",
    mode: "SHADOW",
    enforced: false,
    thresholds: {
      minHeldMinutes: 15,
      maxHeldMinutes: 30,
      maxMfeR: 0.2,
      stopR: -0.5
    }
  };
  if (
    ![heldMs, peakReturnPct, returnPct, initialRiskPct].every(Number.isFinite) ||
    !(initialRiskPct > 0)
  ) {
    return { ...base, decision: "INSUFFICIENT_DATA", reason: "INVALID_INPUT" };
  }
  const heldMinutes = heldMs / 60_000;
  const mfeR = peakReturnPct / initialRiskPct;
  const returnR = returnPct / initialRiskPct;
  if (heldMinutes < base.thresholds.minHeldMinutes) {
    return {
      ...base,
      decision: "PENDING_WINDOW",
      reason: "ENTRY_FAILURE_WINDOW_NOT_OPEN",
      heldMinutes,
      mfeR,
      returnR
    };
  }
  if (heldMinutes > base.thresholds.maxHeldMinutes) {
    return {
      ...base,
      decision: "WINDOW_CLOSED",
      reason: "ENTRY_FAILURE_WINDOW_CLOSED",
      heldMinutes,
      mfeR,
      returnR
    };
  }
  const conditions = {
    signalInvalid: signalValid === false,
    noMeaningfulMfe: mfeR <= base.thresholds.maxMfeR,
    lossReached: returnR <= base.thresholds.stopR
  };
  const wouldExit = Object.values(conditions).every(Boolean);
  return {
    ...base,
    decision: wouldExit ? "WOULD_EXIT" : "WOULD_HOLD",
    reason: wouldExit ? "EARLY_BREAKOUT_FAILED" : "ENTRY_FAILURE_NOT_CONFIRMED",
    heldMinutes,
    mfeR,
    returnR,
    conditions
  };
}

export function shadowConcentrationDecision({
  symbol,
  completedEntriesToday,
  maxEntriesPerSymbolPerDay = 1
}) {
  const wouldLimit = completedEntriesToday >= maxEntriesPerSymbolPerDay;
  return {
    id: "shadow-symbol-concentration",
    mode: "SHADOW",
    enforced: false,
    decision: wouldLimit ? "WOULD_LIMIT" : "WOULD_ALLOW",
    reason: wouldLimit ? "DAILY_SYMBOL_ENTRY_LIMIT" : "WITHIN_DAILY_SYMBOL_ENTRY_LIMIT",
    symbol,
    completedEntriesToday,
    maxEntriesPerSymbolPerDay
  };
}

export function shadowAtrPositionSizeDecision({
  maxTradeUsdt,
  initialRiskPct,
  targetRiskPct
}) {
  const base = {
    id: "shadow-atr-position-size",
    mode: "SHADOW",
    enforced: false,
    liveTradeUsdt: maxTradeUsdt
  };
  if (
    ![maxTradeUsdt, initialRiskPct, targetRiskPct].every(Number.isFinite) ||
    !(maxTradeUsdt > 0 && initialRiskPct > 0 && targetRiskPct > 0)
  ) {
    return { ...base, decision: "INSUFFICIENT_DATA", reason: "INVALID_RISK_INPUT" };
  }

  const targetLossUsdt = maxTradeUsdt * targetRiskPct / 100;
  const suggestedTradeUsdt = Math.min(
    maxTradeUsdt,
    targetLossUsdt / (initialRiskPct / 100)
  );
  const wouldReduce = suggestedTradeUsdt + 1e-9 < maxTradeUsdt;
  return {
    ...base,
    decision: wouldReduce ? "WOULD_REDUCE" : "WOULD_KEEP",
    reason: wouldReduce ? "ATR_RISK_SCALED" : "AT_OR_BELOW_TARGET_RISK",
    initialRiskPct,
    targetRiskPct,
    targetLossUsdt,
    suggestedTradeUsdt
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

export function isStopLossExit(type) {
  return type === "INITIAL_STOP" || type === "DISASTER_STOP";
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
