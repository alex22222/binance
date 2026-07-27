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

function adaptiveEntry(market, timestamp, costPct) {
  return Object.keys(market).map((ticker) => {
    const feature = momentumFeature(market, ticker, timestamp);
    return feature ? { ticker, feature } : null;
  }).filter(Boolean).filter(({ feature }) => (
    feature &&
    feature.trend15mPct + 1e-9 >= feature.atr15Pct * 0.75 &&
    feature.upMinutes >= 9 &&
    feature.trend15mPct >= costPct + 0.3
  )).sort((left, right) => right.feature.trend15mPct - left.feature.trend15mPct)[0] || null;
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

function basisEntry(market, timestamp, costPct) {
  return Object.keys(market).map((ticker) => {
    const feature = basisFeature(market, ticker, timestamp);
    return feature ? { ticker, feature } : null;
  }).filter(Boolean).filter(({ feature }) => -feature.basisPct >= costPct + 0.3)
    .sort((left, right) => left.feature.basisPct - right.feature.basisPct)[0] || null;
}

function residualEntry(market, timestamp, costPct) {
  return Object.keys(market).filter((ticker) => !["SPY", "QQQ"].includes(ticker)).map((ticker) => {
    const feature = residualFeature(market, ticker, timestamp);
    const momentum = momentumFeature(market, ticker, timestamp);
    return feature && momentum ? { ticker, feature: { ...feature, ...momentum } } : null;
  }).filter(Boolean).filter(({ feature }) => (
    feature.zScore <= -2 && -feature.residualPct >= costPct + 0.3
  )).sort((left, right) => left.feature.zScore - right.feature.zScore)[0] || null;
}

function sessionEntry(market, timestamp) {
  if (sessionMinute(timestamp) !== 10 * 60) return null;
  return ["SPY", "QQQ"].map((ticker) => {
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

function strategySignal(strategyId, market, timestamp, costPct) {
  if (strategyId === "adaptive-momentum") return adaptiveEntry(market, timestamp, costPct);
  if (strategyId === "executable-basis-reversion") return basisEntry(market, timestamp, costPct);
  if (strategyId === "residual-reversal") return residualEntry(market, timestamp, costPct);
  return sessionEntry(market, timestamp);
}

function signalStillValid(strategyId, market, position, timestamp, costPct) {
  if (strategyId === "adaptive-momentum") {
    return adaptiveEntry(market, timestamp, costPct)?.ticker === position.ticker;
  }
  if (strategyId === "executable-basis-reversion") {
    return (basisFeature(market, position.ticker, timestamp)?.basisPct ?? 0) < -0.1;
  }
  if (strategyId === "residual-reversal") {
    return (residualFeature(market, position.ticker, timestamp)?.zScore ?? 0) < 0;
  }
  return sessionMinute(timestamp) < 15 * 60 + 50;
}

function simulateStrategy(strategyId, market, timestamps, { notionalUsdt, roundTripCostPct }) {
  const trades = [];
  let position = null;
  let pending = null;
  for (const timestamp of timestamps) {
    if (pending && !position) {
      const candle = market[pending.ticker]?.candles[market[pending.ticker].index.get(timestamp)];
      if (candle) {
        const feature = momentumFeature(market, pending.ticker, timestamp);
        const currentAtrPct = feature?.atr15Pct || pending.feature.atr15Pct || 1;
        position = {
          ticker: pending.ticker,
          entryTime: timestamp,
          entryPrice: candle.open,
          initialRiskPct: Math.min(3.5, Math.max(1, currentAtrPct * 1.5)),
          peakReturnPct: -roundTripCostPct
        };
      }
      pending = null;
    }
    if (position) {
      const candle = market[position.ticker].candles[market[position.ticker].index.get(timestamp)];
      if (!candle) continue;
      const returnPct = (candle.close / position.entryPrice - 1) * 100 - roundTripCostPct;
      position.peakReturnPct = Math.max(position.peakReturnPct, returnPct);
      const feature = momentumFeature(market, position.ticker, timestamp);
      const currentAtrPct = feature?.atr15Pct || position.initialRiskPct / 1.5;
      const protectedStop = position.peakReturnPct >= position.initialRiskPct
        ? Math.max(roundTripCostPct + 0.3, position.peakReturnPct - currentAtrPct)
        : null;
      const valid = signalStillValid(strategyId, market, position, timestamp, roundTripCostPct);
      const basisNormalized = strategyId === "executable-basis-reversion" &&
        (basisFeature(market, position.ticker, timestamp)?.basisPct ?? -Infinity) >= -0.1;
      const residualNormalized = strategyId === "residual-reversal" &&
        (residualFeature(market, position.ticker, timestamp)?.zScore ?? -Infinity) >= 0;
      const sessionClose = strategyId === "session-momentum" && sessionMinute(timestamp) >= 15 * 60 + 50;
      const heldMs = timestamp - position.entryTime;
      const reason = returnPct <= -position.initialRiskPct ? "INITIAL_STOP"
        : returnPct >= position.initialRiskPct * 2 ? "TAKE_PROFIT"
          : protectedStop != null && returnPct <= protectedStop ? "TRAILING_STOP"
            : heldMs >= 4 * 60 * 60_000 && !valid && returnPct < position.initialRiskPct * 0.5 ? "SIGNAL_REVIEW"
              : basisNormalized ? "BASIS_NORMALIZED"
                : residualNormalized ? "RESIDUAL_NORMALIZED"
                  : sessionClose ? "SESSION_CLOSE"
                    : null;
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
          reason
        });
        position = null;
      }
      continue;
    }
    if (cadence(timestamp)) pending = strategySignal(strategyId, market, timestamp, roundTripCostPct);
  }
  return trades;
}

export function backtestStrategyLibrary(dataset, options = {}) {
  const notionalUsdt = Number(options.maxTradeUsdt || DEFAULT_NOTIONAL_USDT);
  const roundTripCostPct = Number(options.roundTripCostPct || DEFAULT_ROUND_TRIP_COST_PCT);
  const market = marketView(dataset);
  const timestamps = [...new Set(Object.values(market).flatMap(({ candles }) => (
    candles.map(({ openTime }) => openTime)
  )))].sort((left, right) => left - right);
  const strategies = definitions.map((definition) => {
    const trades = simulateStrategy(definition.id, market, timestamps, {
      notionalUsdt,
      roundTripCostPct
    });
    return {
      ...definition,
      performance: performanceMetrics(trades, notionalUsdt),
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
      onePositionAtATime: true,
      signalExecutionDelayMinutes: 1,
      basisUsesCurrentMultiplier: true
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
