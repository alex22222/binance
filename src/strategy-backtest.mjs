import {
  entrySymbolPolicyDecision,
  initialStopPolicyUpdate,
  nyseSessionPlan,
  shadowDowntrendVetoDecision,
  shadowMarketRegimeDecision,
  shadowTrendPullbackDecision,
  shadowTrendQualityDecision
} from "./strategy.mjs";

const DEFAULT_NOTIONAL_USDT = 50;
const DEFAULT_ROUND_TRIP_COST_PCT = 1;

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

export function performanceMetrics(trades, notionalUsdt = DEFAULT_NOTIONAL_USDT) {
  const pnl = trades.map(({ pnlUsdt }) => Number(pnlUsdt)).filter(Number.isFinite);
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsdt = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  const pnlUsdt = pnl.reduce((sum, value) => sum + value, 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    trades: pnl.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: pnl.length ? wins.length / pnl.length * 100 : null,
    pnlUsdt,
    returnPct: pnlUsdt / notionalUsdt * 100,
    returnOnTurnoverPct: pnl.length ? pnlUsdt / (notionalUsdt * pnl.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : null,
    maxDrawdownUsdt,
    maxDrawdownPct: maxDrawdownUsdt / notionalUsdt * 100
  };
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
  const closed = candles.filter(({ closeTime }) => closeTime < timestamp).slice(-(period + 1));
  if (closed.length < period + 1) return null;
  const ranges = closed.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - closed[index].close),
    Math.abs(candle.low - closed[index].close)
  ));
  const price = closed.at(-1).close;
  return ranges.reduce((sum, value) => sum + value, 0) / period / price * 100;
}

function momentumFeature(market, ticker, timestamp) {
  const item = market[ticker];
  const index = item?.index.get(timestamp);
  if (index == null || index < 15) return null;
  const recent = item.candles.slice(index - 15, index + 1);
  if (recent.at(-1).openTime - recent[0].openTime !== 15 * 60_000) return null;
  const changes = recent.slice(1).map((candle, offset) => candle.close - recent[offset].close);
  const trend15mPct = (recent.at(-1).close / recent[0].close - 1) * 100;
  const currentAtrPct = atrPct(item.fifteenMinute, timestamp);
  if (!Number.isFinite(currentAtrPct)) return null;
  return {
    trend15mPct,
    upMinutes: changes.filter((value) => value > 0).length,
    atr15Pct: currentAtrPct,
    price: recent.at(-1).close
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
    const fifteenMinute = aggregate15MinuteCandles(candles);
    return [ticker, {
      multiplier: Number(item.multiplier || 1),
      candles,
      underlying,
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
  const signal = strategyId === "adaptive-momentum"
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
  return { signal, marketBlocked: false, marketRegime };
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

function simulateStrategy(definition, market, timestamps, options) {
  const strategyId = definition.id;
  const baseStrategyId = definition.baseStrategyId || strategyId;
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
    entryBlockedSymbols
  } = options;
  const trades = [];
  const entryDiagnostics = {
    cadenceChecks: 0,
    signals: 0,
    marketBlocked: 0,
    cutoffBlocked: 0,
    symbolPolicyBlocked: 0
  };
  let initialStopHistory = [];
  let quarantineUntilBySymbol = {};
  let positions = [];
  let pending = null;
  for (const timestamp of timestamps) {
    if (pending && positions.length < maxOpenPositions) {
      const candle = market[pending.ticker]?.candles[market[pending.ticker].index.get(timestamp)];
      if (candle && !positions.some(({ ticker }) => ticker === pending.ticker)) {
        const feature = momentumFeature(market, pending.ticker, timestamp);
        const currentAtrPct = feature?.atr15Pct || pending.feature.atr15Pct || 1;
        positions.push({
          ticker: pending.ticker,
          entryTime: timestamp,
          entryPrice: candle.open,
          initialRiskPct: Math.min(maxInitialStopPct, Math.max(minInitialStopPct, currentAtrPct * atrStopMultiplier)),
          peakGrossReturnPct: 0,
          peakNetReturnPct: -roundTripCostPct,
          worstNetReturnPct: -roundTripCostPct
        });
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
      const returnPct = grossReturnPct - roundTripCostPct;
      position.peakGrossReturnPct = Math.max(position.peakGrossReturnPct, grossReturnPct);
      position.peakNetReturnPct = Math.max(position.peakNetReturnPct, returnPct);
      position.worstNetReturnPct = Math.min(position.worstNetReturnPct, returnPct);
      const feature = momentumFeature(market, position.ticker, timestamp);
      const currentAtrPct = feature?.atr15Pct || position.initialRiskPct / atrStopMultiplier;
      const protectedStop = position.peakGrossReturnPct >= position.initialRiskPct * profitProtectionR
        ? Math.max(
            roundTripCostPct + minNetEdgePct,
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
      const rawReason = grossReturnPct <= -disasterStopLossPct ? "DISASTER_STOP"
        : grossReturnPct <= -position.initialRiskPct ? "INITIAL_STOP"
          : grossReturnPct >= position.initialRiskPct * finalTakeProfitR ? "TAKE_PROFIT"
            : protectedStop != null && grossReturnPct <= protectedStop ? "TRAILING_STOP"
            : heldMs >= signalReviewHours * 60 * 60_000 &&
              !valid &&
              grossReturnPct < position.initialRiskPct * signalReviewMinR ? "SIGNAL_REVIEW"
              : basisNormalized ? "BASIS_NORMALIZED"
                : residualNormalized ? "RESIDUAL_NORMALIZED"
                  : sessionClose ? "SESSION_CLOSE"
                    : null;
      const reason = rawReason && (
        ["INITIAL_STOP", "DISASTER_STOP"].includes(rawReason) || returnPct >= 0
      ) ? rawReason : null;
      if (reason) {
        trades.push({
          strategyId,
          ticker: position.ticker,
          entryTime: new Date(position.entryTime).toISOString(),
          exitTime: new Date(timestamp).toISOString(),
          entryPrice: position.entryPrice,
          exitPrice: candle.close,
          returnPct,
          pnlUsdt: notionalUsdt * returnPct / 100,
          riskUsdt: notionalUsdt * position.initialRiskPct / 100,
          maePct: position.worstNetReturnPct,
          mfePct: position.peakNetReturnPct,
          maeR: position.worstNetReturnPct / position.initialRiskPct,
          mfeR: position.peakNetReturnPct / position.initialRiskPct,
          realizedR: returnPct / position.initialRiskPct,
          reason
        });
        if (reason === "INITIAL_STOP") {
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
      if (result.signal) {
        entryDiagnostics.signals += 1;
        if (!positions.some(({ ticker }) => ticker === result.signal.ticker)) {
          pending = result.signal;
        }
      }
    }
  }
  return { trades, entryDiagnostics };
}

export function backtestStrategyLibrary(dataset, options = {}) {
  const notionalUsdt = Number(options.maxTradeUsdt || DEFAULT_NOTIONAL_USDT);
  const roundTripCostPct = Number(options.roundTripCostPct || DEFAULT_ROUND_TRIP_COST_PCT);
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
      : []
  };
  const market = marketView(dataset);
  const timestamps = [...new Set(Object.values(market).flatMap(({ candles }) => (
    candles.map(({ openTime }) => openTime)
  )))].sort((left, right) => left - right);
  const strategies = definitions.map((definition) => {
    const { trades, entryDiagnostics } = simulateStrategy(
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
      trades
    };
  });
  const coverage = Object.values(market).flatMap(({ candles }) => candles.map(({ openTime }) => openTime));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    assumptions: {
      notionalUsdt,
      roundTripCostPct,
      costModel: "roundTripCostPct deducted from every completed trade",
      maxOpenPositions: simulationOptions.maxOpenPositions,
      onePositionAtATime: simulationOptions.maxOpenPositions === 1,
      signalExecutionDelayMinutes: 1,
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
