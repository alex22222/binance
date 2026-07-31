import {
  entrySymbolPolicyDecision,
  initialStopPolicyUpdate,
  nyseSessionPlan,
  shadowDowntrendVetoDecision,
  shadowMarketRegimeDecision,
  shadowTrendPullbackDecision,
  shadowTrendQualityDecision
} from "./strategy.mjs";
import {
  analyzeCandles,
  calculateAtrPct
} from "./strategy-signals.mjs";
import { dynamicExitDecision } from "./strategy-exit.mjs";
import {
  createReplayFrames,
  createReplayRecorder
} from "./replay-engine.mjs";
import { executeReplayOrder } from "./replay-execution.mjs";
import {
  executionMetrics,
  performanceMetrics as calculatePerformanceMetrics
} from "./performance-report.mjs";

export { executionMetrics } from "./performance-report.mjs";

const DEFAULT_NOTIONAL_USDT = 50;
const DEFAULT_ROUND_TRIP_COST_PCT = 1;

export function performanceMetrics(trades, notionalUsdt = DEFAULT_NOTIONAL_USDT) {
  return calculatePerformanceMetrics(trades, notionalUsdt);
}

const definitions = [
  {
    id: "adaptive-momentum",
    name: "自适应动量",
    evidenceLevel: "historical-reference",
    rule: "15分钟涨幅≥0.75×ATR15、至少9/15根上涨，且信号幅度覆盖成本"
  },
  {
    id: "adaptive-momentum-market-filtered",
    baseStrategyId: "adaptive-momentum",
    name: "自适应动量＋市场过滤",
    evidenceLevel: "historical-shadow",
    marketFilter: true,
    rule: "自适应动量信号，仅排除SPY/QQQ共同弱势且至少一个持续下跌的时点"
  },
  {
    id: "adaptive-momentum-three-controls",
    baseStrategyId: "adaptive-momentum",
    name: "自适应动量＋三规则",
    evidenceLevel: "historical-counterfactual",
    researchControls: {
      minPlannedNetPayoffRatio: 0.8,
      profitProtectionNetR: 0.5,
      earlyFailureMinutes: 30,
      earlyFailureLossR: 0.25
    },
    rule: "计划净盈亏比≥0.8；净收益达到0.5R后移动保护；30分钟无净盈利且信号失效时提前止损"
  },
  {
    id: "trend-pullback-confirmation",
    name: "趋势回撤再确认",
    evidenceLevel: "historical-shadow",
    rule: "60分钟≥0.75×ATR15、从近期高点回撤0.3–0.8×ATR15、最后1分钟突破此前3分钟收盘高点"
  },
  {
    id: "trend-pullback-market-filtered",
    baseStrategyId: "trend-pullback-confirmation",
    name: "趋势回撤＋市场过滤",
    evidenceLevel: "historical-shadow",
    marketFilter: true,
    rule: "趋势回撤再确认信号，仅排除SPY/QQQ共同弱势且至少一个持续下跌的时点"
  },
  {
    id: "executable-basis-reversion",
    name: "可执行折价回归",
    evidenceLevel: "historical-proxy",
    rule: "代币价格相对底层价格×当前multiplier的折价覆盖成本，回归至-0.1%退出"
  },
  {
    id: "residual-reversal",
    name: "市场残差反转",
    evidenceLevel: "research-rule",
    rule: "个股相对SPY/QQQ的15分钟残差z≤-2，回归零轴退出"
  },
  {
    id: "session-momentum",
    name: "开收盘时段动量",
    evidenceLevel: "research-rule",
    rule: "SPY/QQQ开盘30分钟上涨超过0.2%，10:00进入并在15:50退出"
  }
];

export function strategyValidationDefinitions() {
  return definitions.map((definition) => ({ ...definition }));
}

function performanceBySymbol(trades, notionalUsdt) {
  const symbols = [...new Set(trades.map(({ ticker }) => ticker).filter(Boolean))].sort();
  return Object.fromEntries(symbols.map((ticker) => [
    ticker,
    performanceMetrics(trades.filter((trade) => trade.ticker === ticker), notionalUsdt)
  ]));
}

function newYorkParts(timestamp) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
}

function aggregate15MinuteCandles(candles) {
  const buckets = new Map();
  for (const candle of candles) {
    const bucket = Math.floor(candle.openTime / 900_000) * 900_000;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { ...candle, openTime: bucket, closeTime: bucket + 899_999 });
    } else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume || 0;
    }
  }
  return [...buckets.values()].sort((left, right) => left.openTime - right.openTime);
}

function atrPct(candles, timestamp, period = 14) {
  return calculateAtrPct(candles, period, timestamp)?.atrPct ?? null;
}

function momentumFeature(market, ticker, timestamp) {
  const item = market[ticker];
  const index = item?.index.get(timestamp);
  if (index == null || index < 15) return null;
  const recent = item.candles.slice(index - 15, index + 1);
  if (recent.at(-1).openTime - recent[0].openTime !== 15 * 60_000) return null;
  const signal = analyzeCandles(recent, timestamp + 60_000);
  if (!signal) return null;
  const currentAtrPct = atrPct(item.fifteenMinute, timestamp);
  if (!Number.isFinite(currentAtrPct)) return null;
  return {
    trend15mPct: signal.trend15mPct,
    upMinutes: signal.upMinutes,
    atr15Pct: currentAtrPct,
    price: signal.lastPrice
  };
}

function alignedPrice(item, timestamp, type = "candles") {
  const collection = type === "underlying" ? item.underlying : item.candles;
  const index = type === "underlying" ? item.underlyingIndex : item.index;
  const location = index.get(timestamp);
  return location == null ? null : collection[location].close;
}

function residualFeature(market, ticker, timestamp) {
  const item = market[ticker];
  const spy = market.SPY;
  const qqq = market.QQQ;
  if (!item || !spy || !qqq) return null;
  const bars = item.fifteenMinute.filter(({ closeTime }) => closeTime < timestamp);
  const residuals = [];
  for (const bar of bars.slice(-62)) {
    const previousTime = bar.openTime - 900_000;
    const itemPrevious = item.fifteenIndex.get(previousTime);
    const spyCurrent = spy.fifteenIndex.get(bar.openTime);
    const spyPrevious = spy.fifteenIndex.get(previousTime);
    const qqqCurrent = qqq.fifteenIndex.get(bar.openTime);
    const qqqPrevious = qqq.fifteenIndex.get(previousTime);
    if ([itemPrevious, spyCurrent, spyPrevious, qqqCurrent, qqqPrevious].some((value) => value == null)) continue;
    const stockReturn = (bar.close / item.fifteenMinute[itemPrevious].close - 1) * 100;
    const factorReturn = (
      (spy.fifteenMinute[spyCurrent].close / spy.fifteenMinute[spyPrevious].close - 1) +
      (qqq.fifteenMinute[qqqCurrent].close / qqq.fifteenMinute[qqqPrevious].close - 1)
    ) * 50;
    residuals.push(stockReturn - factorReturn);
  }
  if (residuals.length < 61) return null;
  const current = residuals.at(-1);
  const history = residuals.slice(0, -1);
  const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
  const variance = history.reduce((sum, value) => sum + (value - mean) ** 2, 0) / history.length;
  const deviation = Math.sqrt(variance);
  if (!(deviation > 0)) return null;
  return { residualPct: current, zScore: (current - mean) / deviation };
}

function marketView(dataset) {
  return Object.fromEntries(Object.entries(dataset).map(([ticker, item]) => {
    const candles = [...(item.tokenCandles || [])].sort((left, right) => left.openTime - right.openTime);
    const underlying = [...(item.underlyingCandles || [])].sort((left, right) => left.openTime - right.openTime);
    const executionQuotes = [...(item.executionQuotes || [])];
    const fifteenMinute = aggregate15MinuteCandles(candles);
    return [ticker, {
      multiplier: Number(item.multiplier || 1),
      candles,
      underlying,
      executionQuoteIndex: new Map(executionQuotes.map((quote) => [
        `${quote.side}:${Number(quote.executionTime)}`,
        quote
      ])),
      index: new Map(candles.map((candle, index) => [candle.openTime, index])),
      underlyingIndex: new Map(underlying.map((candle, index) => [candle.openTime, index])),
      fifteenMinute,
      fifteenIndex: new Map(fifteenMinute.map((candle, index) => [candle.openTime, index]))
    }];
  }));
}

function cadence(timestamp) {
  const parts = newYorkParts(timestamp);
  return Number(parts.minute) % 15 === 0;
}

function sessionMinute(timestamp) {
  const parts = newYorkParts(timestamp);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function rawCandle(candle) {
  return [
    candle.openTime,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume || 0,
    candle.closeTime
  ];
}

function entryCutoffAllows(timestamp, entryCutoffMinutes) {
  const closeTime = nyseSessionPlan(timestamp).closeTime;
  if (!closeTime) return false;
  const [hour, minute] = closeTime.split(":").map(Number);
  return sessionMinute(timestamp) < hour * 60 + minute - entryCutoffMinutes;
}

function adaptiveEntry(market, timestamp, costPct, minNetEdgePct, eligible = () => true) {
  return Object.keys(market).filter(eligible).map((ticker) => {
    const feature = momentumFeature(market, ticker, timestamp);
    return feature ? { ticker, feature } : null;
  }).filter(Boolean).filter(({ feature }) => (
    feature &&
    feature.trend15mPct + 1e-9 >= feature.atr15Pct * 0.75 &&
    feature.upMinutes >= 9 &&
    feature.trend15mPct >= costPct + minNetEdgePct
  )).sort((left, right) => right.feature.trend15mPct - left.feature.trend15mPct)[0] || null;
}

function trendPullbackFeature(market, ticker, timestamp) {
  const item = market[ticker];
  if (!item) return null;
  const currentAtrPct = atrPct(item.fifteenMinute, timestamp);
  if (!Number.isFinite(currentAtrPct)) return null;
  const decision = shadowTrendPullbackDecision({
    minuteCandles: item.candles
      .filter(({ closeTime }) => closeTime < timestamp)
      .slice(-4)
      .map(rawCandle),
    atrCandles: item.fifteenMinute
      .filter(({ closeTime }) => closeTime < timestamp)
      .slice(-5)
      .map(rawCandle),
    atr15Pct: currentAtrPct,
    nowMs: timestamp
  });
  return {
    ...decision,
    atr15Pct: currentAtrPct,
    price: item.candles.filter(({ closeTime }) => closeTime < timestamp).at(-1)?.close
  };
}

function trendPullbackEntry(
  market,
  timestamp,
  costPct,
  minNetEdgePct,
  options,
  eligible = () => true
) {
  return Object.keys(market).filter(eligible).map((ticker) => {
    const feature = trendPullbackFeature(market, ticker, timestamp);
    return feature ? { ticker, feature } : null;
  }).filter(Boolean).filter(({ feature }) => {
    const initialRiskPct = Math.min(
      options.maxInitialStopPct,
      Math.max(options.minInitialStopPct, feature.atr15Pct * options.atrStopMultiplier)
    );
    return (
      feature.decision === "WOULD_ENTER" &&
      initialRiskPct * options.finalTakeProfitR >= costPct + minNetEdgePct
    );
  }).sort((left, right) => (
    right.feature.return60mPct - left.feature.return60mPct ||
    left.feature.pullbackDepthAtr - right.feature.pullbackDepthAtr
  ))[0] || null;
}

function marketRegimeFeature(market, timestamp) {
  const candidates = ["SPY", "QQQ"].map((ticker) => {
    const item = market[ticker];
    const currentAtrPct = item ? atrPct(item.fifteenMinute, timestamp) : null;
    if (!item || !Number.isFinite(currentAtrPct)) return null;
    const candles = item.fifteenMinute
      .filter(({ closeTime }) => closeTime < timestamp)
      .slice(-13)
      .map(rawCandle);
    return {
      symbol: ticker,
      shadowDowntrendVeto: shadowDowntrendVetoDecision(candles, currentAtrPct, timestamp),
      shadowTrendQuality: shadowTrendQualityDecision(candles, currentAtrPct, timestamp)
    };
  }).filter(Boolean);
  return shadowMarketRegimeDecision(candidates);
}

function basisFeature(market, ticker, timestamp) {
  const item = market[ticker];
  const tokenPrice = alignedPrice(item, timestamp);
  const underlyingPrice = alignedPrice(item, timestamp, "underlying");
  if (!(tokenPrice > 0) || !(underlyingPrice > 0) || !(item.multiplier > 0)) return null;
  return {
    basisPct: (tokenPrice / (underlyingPrice * item.multiplier) - 1) * 100,
    price: tokenPrice
  };
}

function basisEntry(market, timestamp, costPct, minNetEdgePct, eligible = () => true) {
  return Object.keys(market).filter(eligible).map((ticker) => {
    const feature = basisFeature(market, ticker, timestamp);
    return feature ? { ticker, feature } : null;
  }).filter(Boolean).filter(({ feature }) => -feature.basisPct >= costPct + minNetEdgePct)
    .sort((left, right) => left.feature.basisPct - right.feature.basisPct)[0] || null;
}

function residualEntry(market, timestamp, costPct, minNetEdgePct, eligible = () => true) {
  return Object.keys(market).filter((ticker) => (
    !["SPY", "QQQ"].includes(ticker) && eligible(ticker)
  )).map((ticker) => {
    const feature = residualFeature(market, ticker, timestamp);
    const momentum = momentumFeature(market, ticker, timestamp);
    return feature && momentum ? { ticker, feature: { ...feature, ...momentum } } : null;
  }).filter(Boolean).filter(({ feature }) => (
    feature.zScore <= -2 && -feature.residualPct >= costPct + minNetEdgePct
  )).sort((left, right) => left.feature.zScore - right.feature.zScore)[0] || null;
}

function sessionEntry(market, timestamp, eligible = () => true) {
  if (sessionMinute(timestamp) !== 10 * 60) return null;
  return ["SPY", "QQQ"].filter(eligible).map((ticker) => {
    const item = market[ticker];
    const index = item?.index.get(timestamp);
    if (index == null || index < 30) return null;
    const open = item.candles[index - 30]?.open;
    const price = item.candles[index]?.close;
    const openingReturnPct = open > 0 ? (price / open - 1) * 100 : null;
    const currentAtrPct = atrPct(item.fifteenMinute, timestamp);
    return Number.isFinite(openingReturnPct) && Number.isFinite(currentAtrPct)
      ? { ticker, feature: { openingReturnPct, atr15Pct: currentAtrPct, price } }
      : null;
  }).filter(Boolean).filter(({ feature }) => feature.openingReturnPct >= 0.2)
    .sort((left, right) => right.feature.openingReturnPct - left.feature.openingReturnPct)[0] || null;
}

function strategySignal(definition, market, timestamp, options, eligible) {
  const strategyId = definition.baseStrategyId || definition.id;
  const marketRegime = definition.marketFilter
    ? marketRegimeFeature(market, timestamp)
    : null;
  if (marketRegime?.decision === "WOULD_BLOCK") {
    return { signal: null, marketBlocked: true, marketRegime };
  }
  const { roundTripCostPct, minNetEdgePct } = options;
  let signal = strategyId === "adaptive-momentum"
    ? adaptiveEntry(market, timestamp, roundTripCostPct, minNetEdgePct, eligible)
    : strategyId === "trend-pullback-confirmation"
      ? trendPullbackEntry(
          market,
          timestamp,
          roundTripCostPct,
          minNetEdgePct,
          options,
          eligible
        )
      : strategyId === "executable-basis-reversion"
        ? basisEntry(market, timestamp, roundTripCostPct, minNetEdgePct, eligible)
        : strategyId === "residual-reversal"
          ? residualEntry(market, timestamp, roundTripCostPct, minNetEdgePct, eligible)
          : sessionEntry(market, timestamp, eligible);
  let payoffBlocked = false;
  let plannedNetPayoffRatio = null;
  if (signal && definition.researchControls) {
    const initialRiskPct = Math.min(
      options.maxInitialStopPct,
      Math.max(
        options.minInitialStopPct,
        signal.feature.atr15Pct * options.atrStopMultiplier
      )
    );
    plannedNetPayoffRatio = (
      initialRiskPct * options.finalTakeProfitR - options.roundTripCostPct
    ) / (initialRiskPct + options.roundTripCostPct);
    if (
      plannedNetPayoffRatio <
      definition.researchControls.minPlannedNetPayoffRatio
    ) {
      signal = null;
      payoffBlocked = true;
    }
  }
  return {
    signal,
    marketBlocked: false,
    marketRegime,
    payoffBlocked,
    plannedNetPayoffRatio
  };
}

function signalStillValid(strategyId, market, position, timestamp, costPct, minNetEdgePct) {
  const baseStrategyId = definitions.find(({ id }) => id === strategyId)?.baseStrategyId || strategyId;
  if (baseStrategyId === "adaptive-momentum") {
    return adaptiveEntry(market, timestamp, costPct, minNetEdgePct)?.ticker === position.ticker;
  }
  if (baseStrategyId === "trend-pullback-confirmation") {
    return trendPullbackFeature(market, position.ticker, timestamp)?.conditions?.establishedTrend === true;
  }
  if (baseStrategyId === "executable-basis-reversion") {
    return (basisFeature(market, position.ticker, timestamp)?.basisPct ?? 0) < -0.1;
  }
  if (baseStrategyId === "residual-reversal") {
    return (residualFeature(market, position.ticker, timestamp)?.zScore ?? 0) < 0;
  }
  return sessionMinute(timestamp) < 15 * 60 + 50;
}

function replayExitReason(type) {
  if (type === "TAKE_PROFIT_2R") return "TAKE_PROFIT";
  if (type === "SIGNAL_TIMEOUT") return "SIGNAL_REVIEW";
  return type;
}

function replayQuote(market, ticker, side, executionTime) {
  return market[ticker]?.executionQuoteIndex.get(`${side}:${executionTime}`) || null;
}

function simulateStrategy(definition, market, timestamps, options) {
  const strategyId = definition.id;
  const baseStrategyId = definition.baseStrategyId || strategyId;
  const researchControls = definition.researchControls || null;
  const {
    notionalUsdt,
    roundTripCostPct,
    maxOpenPositions,
    atrStopMultiplier,
    minInitialStopPct,
    maxInitialStopPct,
    profitProtectionR,
    trailingAtrMultiplier,
    finalTakeProfitR,
    signalReviewHours,
    signalReviewMinR,
    minNetEdgePct,
    disasterStopLossPct,
    entryCutoffMinutes,
    entryBlockedSymbols,
    includeReplayEvents,
    executionModel,
    maxQuoteAgeMs,
    maxQuoteDriftPct
  } = options;
  const replayCostPct = executionModel === "QUOTE_REPLAY" ? 0 : roundTripCostPct;
  const recorder = createReplayRecorder({ includeEvents: includeReplayEvents });
  const trades = [];
  const entryDiagnostics = {
    cadenceChecks: 0,
    signals: 0,
    marketBlocked: 0,
    cutoffBlocked: 0,
    symbolPolicyBlocked: 0,
    payoffBlocked: 0,
    earlyFailureExits: 0
  };
  let initialStopHistory = [];
  let quarantineUntilBySymbol = {};
  let positions = [];
  let pending = null;
  for (const frame of createReplayFrames(timestamps)) {
    const timestamp = frame.marketTime;
    const executionFrame = {
      marketTime: timestamp,
      frontierTime: timestamp
    };
    if (pending && positions.length < maxOpenPositions) {
      const candle = market[pending.ticker]?.candles[market[pending.ticker].index.get(timestamp)];
      if (candle && !positions.some(({ ticker }) => ticker === pending.ticker)) {
        const feature = momentumFeature(market, pending.ticker, timestamp);
        const currentAtrPct = feature?.atr15Pct || pending.feature.atr15Pct || 1;
        const quote = replayQuote(market, pending.ticker, "BUY", timestamp);
        const execution = executeReplayOrder({
          model: executionModel,
          orderId: pending.orderId,
          side: "BUY",
          executedAtMs: timestamp,
          candlePrice: candle.open,
          notionalUsdt,
          quote,
          expectedOutputAmount: quote?.expectedOutputAmount,
          maxQuoteAgeMs,
          maxQuoteDriftPct,
          gasUsdt: quote?.gasUsdt
        });
        if (execution.status === "FILLED") {
          recorder.record("ORDER_FILLED", executionFrame, {
            orderId: pending.orderId,
            side: "BUY",
            ticker: pending.ticker,
            price: execution.fillPrice,
            evidenceLevel: execution.evidenceLevel,
            gasUsdt: execution.gasUsdt,
            quoteAgeMs: execution.quoteAgeMs,
            quoteDriftPct: execution.quoteDriftPct
          });
          positions.push({
            ticker: pending.ticker,
            entryTime: timestamp,
            entryPrice: execution.fillPrice,
            quantity: execution.fillQuantity,
            entryValueUsdt: execution.inputAmount,
            entryGasUsdt: execution.gasUsdt,
            entryExecutionEvidenceLevel: execution.evidenceLevel,
            initialRiskPct: Math.min(maxInitialStopPct, Math.max(minInitialStopPct, currentAtrPct * atrStopMultiplier)),
            peakGrossReturnPct: 0,
            peakNetReturnPct: -replayCostPct,
            worstNetReturnPct: -replayCostPct
          });
          recorder.record("POSITION_OPENED", executionFrame, {
            orderId: pending.orderId,
            ticker: pending.ticker,
            price: execution.fillPrice
          });
        } else {
          recorder.record(
            execution.status === "FAILED" ? "ORDER_FAILED" : "ORDER_REJECTED",
            executionFrame,
            {
              orderId: pending.orderId,
              side: "BUY",
              ticker: pending.ticker,
              reason: execution.reason,
              evidenceLevel: execution.evidenceLevel,
              gasUsdt: execution.gasUsdt,
              quoteAgeMs: execution.quoteAgeMs,
              quoteDriftPct: execution.quoteDriftPct
            }
          );
        }
      }
      pending = null;
    }
    const retained = [];
    for (const position of positions) {
      const candle = market[position.ticker].candles[market[position.ticker].index.get(timestamp)];
      if (!candle) {
        retained.push(position);
        continue;
      }
      const grossReturnPct = (candle.close / position.entryPrice - 1) * 100;
      const returnPct = grossReturnPct - replayCostPct;
      position.peakGrossReturnPct = Math.max(position.peakGrossReturnPct, grossReturnPct);
      position.peakNetReturnPct = Math.max(position.peakNetReturnPct, returnPct);
      position.worstNetReturnPct = Math.min(position.worstNetReturnPct, returnPct);
      const feature = momentumFeature(market, position.ticker, timestamp);
      const currentAtrPct = feature?.atr15Pct || position.initialRiskPct / atrStopMultiplier;
      const protectionActivationPct = researchControls
        ? replayCostPct + position.initialRiskPct * researchControls.profitProtectionNetR
        : position.initialRiskPct * profitProtectionR;
      const protectedStop = position.peakGrossReturnPct >= protectionActivationPct
        ? Math.max(
            replayCostPct + minNetEdgePct,
            position.peakGrossReturnPct - currentAtrPct * trailingAtrMultiplier
          )
        : null;
      const valid = signalStillValid(
        strategyId,
        market,
        position,
        timestamp,
        roundTripCostPct,
        minNetEdgePct
      );
      const basisNormalized = baseStrategyId === "executable-basis-reversion" &&
        (basisFeature(market, position.ticker, timestamp)?.basisPct ?? -Infinity) >= -0.1;
      const residualNormalized = baseStrategyId === "residual-reversal" &&
        (residualFeature(market, position.ticker, timestamp)?.zScore ?? -Infinity) >= 0;
      const sessionClose = baseStrategyId === "session-momentum" &&
        sessionMinute(timestamp) >= 15 * 60 + 50;
      const heldMs = timestamp - position.entryTime;
      const earlyFailure = researchControls &&
        heldMs >= researchControls.earlyFailureMinutes * 60_000 &&
        !valid &&
        position.peakNetReturnPct <= 0 &&
        grossReturnPct <= -position.initialRiskPct * researchControls.earlyFailureLossR;
      const sharedExit = researchControls ? null : dynamicExitDecision({
        returnPct: grossReturnPct,
        initialRiskPct: position.initialRiskPct,
        atr15Pct: currentAtrPct,
        peakReturnPct: position.peakGrossReturnPct,
        openedAtMs: position.entryTime,
        nowMs: timestamp,
        signalValid: valid,
        disasterStopLossPct,
        profitProtectionR,
        trailingAtrMultiplier,
        finalTakeProfitR,
        signalReviewHours,
        signalReviewMinR,
        profitFloorPct: replayCostPct + minNetEdgePct
      });
      const rawReason = researchControls
        ? grossReturnPct <= -disasterStopLossPct ? "DISASTER_STOP"
          : grossReturnPct <= -position.initialRiskPct ? "INITIAL_STOP"
            : grossReturnPct >= position.initialRiskPct * finalTakeProfitR ? "TAKE_PROFIT"
              : protectedStop != null && grossReturnPct <= protectedStop ? "TRAILING_STOP"
                : earlyFailure ? "EARLY_FAILURE_STOP"
                  : heldMs >= signalReviewHours * 60 * 60_000 &&
                    !valid &&
                    grossReturnPct < position.initialRiskPct * signalReviewMinR ? "SIGNAL_REVIEW"
                    : null
        : replayExitReason(sharedExit.type) ||
          (basisNormalized ? "BASIS_NORMALIZED"
            : residualNormalized ? "RESIDUAL_NORMALIZED"
              : sessionClose ? "SESSION_CLOSE"
                : null);
      const reason = rawReason && (
        ["INITIAL_STOP", "DISASTER_STOP", "EARLY_FAILURE_STOP"].includes(rawReason) ||
        returnPct >= 0
      ) ? rawReason : null;
      if (reason) {
        const orderId = `${strategyId}:${position.ticker}:SELL:${frame.frontierTime}`;
        recorder.record("EXIT_SIGNAL", frame, {
          orderId,
          ticker: position.ticker,
          reason
        });
        recorder.record("ORDER_INTENT", frame, {
          orderId,
          side: "SELL",
          ticker: position.ticker
        });
        const quote = replayQuote(market, position.ticker, "SELL", frame.frontierTime);
        const execution = executeReplayOrder({
          model: executionModel,
          orderId,
          side: "SELL",
          executedAtMs: frame.frontierTime,
          candlePrice: candle.close,
          quantity: position.quantity,
          quote,
          expectedOutputAmount: quote?.expectedOutputAmount,
          maxQuoteAgeMs,
          maxQuoteDriftPct,
          gasUsdt: quote?.gasUsdt
        });
        if (execution.status !== "FILLED") {
          recorder.record(
            execution.status === "FAILED" ? "ORDER_FAILED" : "ORDER_REJECTED",
            frame,
            {
              orderId,
              side: "SELL",
              ticker: position.ticker,
              reason: execution.reason,
              evidenceLevel: execution.evidenceLevel,
              gasUsdt: execution.gasUsdt,
              quoteAgeMs: execution.quoteAgeMs,
              quoteDriftPct: execution.quoteDriftPct
            }
          );
          retained.push(position);
          continue;
        }
        recorder.record("ORDER_FILLED", frame, {
          orderId,
          side: "SELL",
          ticker: position.ticker,
          price: execution.fillPrice,
          evidenceLevel: execution.evidenceLevel,
          gasUsdt: execution.gasUsdt,
          quoteAgeMs: execution.quoteAgeMs,
          quoteDriftPct: execution.quoteDriftPct
        });
        const gasCostUsdt = position.entryGasUsdt + execution.gasUsdt;
        const realizedGrossReturnPct = (execution.fillPrice / position.entryPrice - 1) * 100;
        const realizedReturnPct = realizedGrossReturnPct - replayCostPct -
          gasCostUsdt / notionalUsdt * 100;
        const fixedCostUsdt = notionalUsdt * replayCostPct / 100;
        const totalCostUsdt = fixedCostUsdt + gasCostUsdt;
        const executionEvidenceLevel =
          position.entryExecutionEvidenceLevel === execution.evidenceLevel
            ? execution.evidenceLevel
            : "MIXED";
        trades.push({
          strategyId,
          ticker: position.ticker,
          entryTime: new Date(position.entryTime).toISOString(),
          exitTime: new Date(timestamp).toISOString(),
          entryPrice: position.entryPrice,
          exitPrice: execution.fillPrice,
          entryValueUsdt: position.entryValueUsdt,
          exitValueUsdt: execution.outputAmount,
          returnPct: realizedReturnPct,
          pnlUsdt: notionalUsdt * realizedReturnPct / 100,
          grossPnlUsdt: notionalUsdt * realizedGrossReturnPct / 100,
          fixedCostUsdt,
          gasCostUsdt,
          totalCostUsdt,
          executionEvidenceLevel,
          entryExecutionEvidenceLevel: position.entryExecutionEvidenceLevel,
          exitExecutionEvidenceLevel: execution.evidenceLevel,
          riskUsdt: notionalUsdt * position.initialRiskPct / 100,
          maePct: position.worstNetReturnPct,
          mfePct: position.peakNetReturnPct,
          maeR: position.worstNetReturnPct / position.initialRiskPct,
          mfeR: position.peakNetReturnPct / position.initialRiskPct,
          realizedR: realizedReturnPct / position.initialRiskPct,
          reason
        });
        recorder.record("POSITION_CLOSED", frame, {
          orderId,
          ticker: position.ticker,
          price: execution.fillPrice,
          reason
        });
        if (reason === "EARLY_FAILURE_STOP") {
          entryDiagnostics.earlyFailureExits += 1;
        }
        if (["INITIAL_STOP", "EARLY_FAILURE_STOP"].includes(reason)) {
          const updated = initialStopPolicyUpdate({
            symbol: position.ticker,
            initialStopHistory,
            quarantineUntilBySymbol,
            nowMs: timestamp
          });
          initialStopHistory = updated.initialStopHistory;
          quarantineUntilBySymbol = updated.quarantineUntilBySymbol;
        }
      } else {
        retained.push(position);
      }
    }
    positions = retained;
    if (cadence(timestamp) && positions.length < maxOpenPositions && !pending) {
      entryDiagnostics.cadenceChecks += 1;
      if (!entryCutoffAllows(timestamp, entryCutoffMinutes)) {
        entryDiagnostics.cutoffBlocked += 1;
        continue;
      }
      const eligible = (ticker) => {
        const decision = entrySymbolPolicyDecision({
          symbol: ticker,
          blockedSymbols: entryBlockedSymbols,
          initialStopHistory,
          quarantineUntilBySymbol,
          nowMs: timestamp
        });
        if (!decision.allowed) entryDiagnostics.symbolPolicyBlocked += 1;
        return decision.allowed;
      };
      const result = strategySignal(definition, market, timestamp, options, eligible);
      if (result.marketBlocked) entryDiagnostics.marketBlocked += 1;
      if (result.payoffBlocked) entryDiagnostics.payoffBlocked += 1;
      if (result.signal) {
        entryDiagnostics.signals += 1;
        if (!positions.some(({ ticker }) => ticker === result.signal.ticker)) {
          const orderId = `${strategyId}:${result.signal.ticker}:BUY:${frame.frontierTime}`;
          recorder.record("SIGNAL", frame, {
            orderId,
            ticker: result.signal.ticker
          });
          recorder.record("ORDER_INTENT", frame, {
            orderId,
            side: "BUY",
            ticker: result.signal.ticker
          });
          pending = {
            ...result.signal,
            orderId
          };
        }
      }
    }
  }
  return {
    trades,
    entryDiagnostics,
    replay: recorder.snapshot()
  };
}

export function backtestStrategyLibrary(dataset, options = {}) {
  const notionalUsdt = Number(options.maxTradeUsdt || DEFAULT_NOTIONAL_USDT);
  const roundTripCostPct = Number(options.roundTripCostPct || DEFAULT_ROUND_TRIP_COST_PCT);
  const executionModel = options.executionModel || "CANDLE_PROXY";
  if (!["CANDLE_PROXY", "QUOTE_REPLAY"].includes(executionModel)) {
    throw new Error(`Unsupported replay execution model: ${executionModel}`);
  }
  const simulationOptions = {
    notionalUsdt,
    roundTripCostPct,
    maxOpenPositions: Number(options.maxOpenPositions || 1),
    atrStopMultiplier: Number(options.atrStopMultiplier || 1.5),
    minInitialStopPct: Number(options.minInitialStopPct || 1),
    maxInitialStopPct: Number(options.maxInitialStopPct || 3.5),
    profitProtectionR: Number(options.profitProtectionR || 1),
    trailingAtrMultiplier: Number(options.trailingAtrMultiplier || 1),
    finalTakeProfitR: Number(options.finalTakeProfitR || 2),
    signalReviewHours: Number(options.signalReviewHours || 4),
    signalReviewMinR: Number(options.signalReviewMinR || 0.5),
    minNetEdgePct: Number(options.minNetEdgePct ?? 0.1),
    disasterStopLossPct: Number(options.disasterStopLossPct || 8),
    entryCutoffMinutes: Number(options.entryCutoffMinutes ?? 45),
    entryBlockedSymbols: Array.isArray(options.entryBlockedSymbols)
      ? [...options.entryBlockedSymbols]
      : [],
    includeReplayEvents: options.includeReplayEvents === true,
    executionModel,
    maxQuoteAgeMs: Number(options.maxQuoteAgeMs ?? 10_000),
    maxQuoteDriftPct: Number(options.maxQuoteDriftPct ?? 0.3)
  };
  const market = marketView(dataset);
  const timestamps = [...new Set(Object.values(market).flatMap(({ candles }) => (
    candles.map(({ openTime }) => openTime)
  )))].sort((left, right) => left - right);
  const strategies = definitions.map((definition) => {
    const { trades, entryDiagnostics, replay } = simulateStrategy(
      definition,
      market,
      timestamps,
      simulationOptions
    );
    return {
      ...definition,
      performance: performanceMetrics(trades, notionalUsdt),
      performanceBySymbol: performanceBySymbol(trades, notionalUsdt),
      entryDiagnostics,
      replay,
      executionPerformance: executionMetrics(replay, trades),
      trades
    };
  });
  const coverage = Object.values(market).flatMap(({ candles }) => candles.map(({ openTime }) => openTime));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    validationWindow: options.validationWindow || "UNSPECIFIED",
    assumptions: {
      notionalUsdt,
      roundTripCostPct,
      costModel: executionModel === "QUOTE_REPLAY"
        ? "amount-specific quote fills and gas; no additional fixed round-trip deduction"
        : "roundTripCostPct deducted from every completed trade",
      execution: {
        model: executionModel,
        strictQuoteReplay: executionModel === "QUOTE_REPLAY",
        maxQuoteAgeMs: simulationOptions.maxQuoteAgeMs,
        maxQuoteDriftPct: simulationOptions.maxQuoteDriftPct,
        quoteDriftRequiresExpectedOutput: true,
        candleProxyRoundTripCostPct: roundTripCostPct,
        quoteReplayAdditionalRoundTripCostPct: 0
      },
      reporting: {
        returnPct: "net PnL divided by fixed entry notional",
        returnOnTurnoverPct: "net PnL divided by fixed entry notional per completed trade",
        returnOnExecutedTurnoverPct: "net PnL divided by summed entry and exit executed values",
        maeMfe: "minute-close mark-to-market after fixed model cost and before gas",
        realizedPnl: "completed fills only, after fixed model cost and recorded gas"
      },
      maxOpenPositions: simulationOptions.maxOpenPositions,
      onePositionAtATime: simulationOptions.maxOpenPositions === 1,
      signalExecutionDelayMinutes: 1,
      timeFrontier: {
        intervalMs: 60_000,
        marketDataAvailableAt: "minute candle close",
        monotonic: true
      },
      basisUsesCurrentMultiplier: true,
      entryPolicy: {
        entryCutoffMinutes: simulationOptions.entryCutoffMinutes,
        entryBlockedSymbols: simulationOptions.entryBlockedSymbols,
        sameSessionInitialStopReentryBlocked: true,
        secondInitialStopQuarantineTradingDays: 5
      },
      exitParameters: {
        atrStopMultiplier: simulationOptions.atrStopMultiplier,
        minInitialStopPct: simulationOptions.minInitialStopPct,
        maxInitialStopPct: simulationOptions.maxInitialStopPct,
        profitProtectionR: simulationOptions.profitProtectionR,
        trailingAtrMultiplier: simulationOptions.trailingAtrMultiplier,
        finalTakeProfitR: simulationOptions.finalTakeProfitR,
        signalReviewHours: simulationOptions.signalReviewHours,
        signalReviewMinR: simulationOptions.signalReviewMinR,
        disasterStopLossPct: simulationOptions.disasterStopLossPct,
        ordinaryExitsRequireNonNegativeNetReturn: true
      }
    },
    dataCoverage: {
      symbols: Object.keys(market).length,
      candles: coverage.length,
      from: coverage.length ? new Date(Math.min(...coverage)).toISOString() : null,
      to: coverage.length ? new Date(Math.max(...coverage)).toISOString() : null
    },
    strategies
  };
}
