import { parseYahooChart, newYorkDate } from "./strategy-data.mjs";

const BENCHMARK_SYMBOLS = ["SPY", "QQQ", "IWM"];
const NEWS_RISK_PATTERN = /\b(federal reserve|fomc|inflation|cpi|payroll|jobs report|tariff|sanction|war|earnings warning|guidance cut|default|bank failure)\b/i;

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function newYorkMinutes(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function returnsByMinute(candles, startMs, endMs) {
  const ordered = [...(candles || [])]
    .filter(({ openTime, close }) => (
      Number.isFinite(Number(openTime)) &&
      Number(close) > 0 &&
      Number(openTime) >= startMs - 60_000 &&
      Number(openTime) <= endMs
    ))
    .sort((left, right) => left.openTime - right.openTime);
  const returns = new Map();
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = Number(ordered[index - 1].close);
    const current = Number(ordered[index].close);
    if (previous > 0 && ordered[index].openTime >= startMs) {
      returns.set(Math.floor(ordered[index].openTime / 60_000), current / previous - 1);
    }
  }
  return returns;
}

function intervalReturn(candles, startMs, endMs) {
  const values = [...(candles || [])]
    .filter(({ openTime, close }) => (
      Number(openTime) >= startMs &&
      Number(openTime) <= endMs &&
      Number(close) > 0
    ))
    .sort((left, right) => left.openTime - right.openTime);
  if (values.length < 2) return null;
  return Number(values.at(-1).close) / Number(values[0].close) - 1;
}

function regression(stockReturns, benchmarkReturns) {
  if (stockReturns.length < 20 || stockReturns.length !== benchmarkReturns.length) {
    return { correlation: null, beta: null };
  }
  const stockMean = stockReturns.reduce((sum, value) => sum + value, 0) / stockReturns.length;
  const benchmarkMean = benchmarkReturns.reduce((sum, value) => sum + value, 0) / benchmarkReturns.length;
  let covariance = 0;
  let stockVariance = 0;
  let benchmarkVariance = 0;
  for (let index = 0; index < stockReturns.length; index += 1) {
    const stockDelta = stockReturns[index] - stockMean;
    const benchmarkDelta = benchmarkReturns[index] - benchmarkMean;
    covariance += stockDelta * benchmarkDelta;
    stockVariance += stockDelta ** 2;
    benchmarkVariance += benchmarkDelta ** 2;
  }
  if (!(stockVariance > 0) || !(benchmarkVariance > 0)) {
    return { correlation: null, beta: null };
  }
  return {
    correlation: covariance / Math.sqrt(stockVariance * benchmarkVariance),
    beta: covariance / benchmarkVariance
  };
}

function tradeAttribution(trade, candlesBySymbol) {
  const startMs = Date.parse(trade.openedAt);
  const endMs = Date.parse(trade.completedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { symbol: trade.symbol, status: "INSUFFICIENT_DATA", samples: 0 };
  }
  const stock = returnsByMinute(candlesBySymbol[trade.symbol], startMs, endMs);
  const spy = returnsByMinute(candlesBySymbol.SPY, startMs, endMs);
  const qqq = returnsByMinute(candlesBySymbol.QQQ, startMs, endMs);
  const stockReturns = [];
  const benchmarkReturns = [];
  for (const [minute, stockReturn] of stock) {
    if (!spy.has(minute) || !qqq.has(minute)) continue;
    stockReturns.push(stockReturn);
    benchmarkReturns.push((spy.get(minute) + qqq.get(minute)) / 2);
  }
  const underlyingReturn = intervalReturn(candlesBySymbol[trade.symbol], startMs, endMs);
  const spyReturn = intervalReturn(candlesBySymbol.SPY, startMs, endMs);
  const qqqReturn = intervalReturn(candlesBySymbol.QQQ, startMs, endMs);
  const benchmarkReturn = spyReturn == null || qqqReturn == null
    ? null
    : (spyReturn + qqqReturn) / 2;
  const { correlation, beta } = regression(stockReturns, benchmarkReturns);
  const longOnlyBeta = beta == null ? null : Math.max(0, beta);
  const marketAttributedReturn = beta == null || benchmarkReturn == null
    ? null
    : longOnlyBeta * benchmarkReturn;
  return {
    symbol: trade.symbol,
    status: stockReturns.length >= 20 && beta != null && benchmarkReturn != null && underlyingReturn != null
      ? "AVAILABLE"
      : "INSUFFICIENT_DATA",
    samples: stockReturns.length,
    correlation: round(correlation),
    beta: round(beta),
    attributionBeta: round(longOnlyBeta),
    underlyingReturnPct: round(underlyingReturn == null ? null : underlyingReturn * 100),
    benchmarkReturnPct: round(benchmarkReturn == null ? null : benchmarkReturn * 100),
    marketAttributedReturnPct: round(marketAttributedReturn == null ? null : marketAttributedReturn * 100),
    residualReturnPct: round(
      underlyingReturn == null || marketAttributedReturn == null
        ? null
        : (underlyingReturn - marketAttributedReturn) * 100
    ),
    realizedReturnPct: trade.amountUsdt > 0
      ? round(finiteNumber(trade.realizedPnlUsdt, 0) / trade.amountUsdt * 100)
      : null
  };
}

export function buildExternalMarketAttribution({ trades, candlesBySymbol, errors = [] }) {
  const attributions = trades.map((trade) => tradeAttribution(trade, candlesBySymbol));
  const observed = attributions.filter(({ status }) => status === "AVAILABLE");
  const losingTrades = trades.flatMap((trade, index) => (
    finiteNumber(trade.realizedPnlUsdt, 0) < 0 && observed.includes(attributions[index])
      ? [{ trade, attribution: attributions[index] }]
      : []
  ));
  const underlyingLoss = losingTrades.reduce((sum, { attribution }) => (
    sum + Math.max(0, -finiteNumber(attribution.underlyingReturnPct, 0))
  ), 0);
  const attributedMarketLoss = losingTrades.reduce((sum, { attribution }) => (
    sum + (
      finiteNumber(attribution.benchmarkReturnPct, 0) < 0
        ? Math.max(0, -finiteNumber(attribution.marketAttributedReturnPct, 0))
        : 0
    )
  ), 0);
  const alignedLosses = losingTrades.filter(
    ({ attribution }) => finiteNumber(attribution.benchmarkReturnPct, 0) < 0
  ).length;
  return {
    status: observed.length ? "AVAILABLE" : "INSUFFICIENT_DATA",
    method: "OLS beta on aligned 1-minute underlying returns versus equal-weight SPY/QQQ; negative beta is floored at zero for long-only loss attribution",
    observedTrades: observed.length,
    totalTrades: trades.length,
    averageCorrelation: observed.length
      ? round(observed.reduce((sum, item) => sum + item.correlation, 0) / observed.length)
      : null,
    marketAttributedLossSharePct: underlyingLoss > 0
      ? round(Math.min(100, attributedMarketLoss / underlyingLoss * 100), 2)
      : null,
    lossDirectionAlignmentPct: losingTrades.length
      ? round(alignedLosses / losingTrades.length * 100, 2)
      : null,
    trades: attributions,
    errors,
    limitations: [
      "Attribution uses underlying-stock and ETF minute closes, not token executable quotes.",
      "Beta attribution is descriptive, not proof that the market caused the trade result.",
      "Gas, spread and token basis remain outside the underlying-return regression."
    ]
  };
}

export function buildPremarketBrief({
  tradingDate,
  generatedAt = new Date().toISOString(),
  snapshots,
  stockSymbols,
  headlines,
  errors = []
}) {
  const snapshotBySymbol = new Map((snapshots || []).map((item) => [item.symbol, item]));
  const benchmarks = BENCHMARK_SYMBOLS
    .map((symbol) => snapshotBySymbol.get(symbol))
    .filter((item) => Number.isFinite(Number(item?.changePct)));
  const stocks = (stockSymbols || [])
    .map((symbol) => snapshotBySymbol.get(symbol))
    .filter((item) => Number.isFinite(Number(item?.changePct)));
  const benchmarkAveragePct = benchmarks.length
    ? benchmarks.reduce((sum, item) => sum + Number(item.changePct), 0) / benchmarks.length
    : null;
  const breadthPositivePct = stocks.length
    ? stocks.filter(({ changePct }) => Number(changePct) > 0).length / stocks.length * 100
    : null;
  const vixChangePct = finiteNumber(snapshotBySymbol.get("^VIX")?.changePct);
  const riskHeadlines = (headlines || []).filter(({ title }) => NEWS_RISK_PATTERN.test(title || ""));
  const sufficient = benchmarks.length >= 2;
  let level = "DATA_INSUFFICIENT";
  let summary = "盘前数据不足；保持现有策略与风控，不据此扩大仓位。";
  if (sufficient) {
    const defensive = benchmarkAveragePct <= -0.6 ||
      (breadthPositivePct != null && breadthPositivePct <= 30) ||
      (vixChangePct != null && vixChangePct >= 5) ||
      riskHeadlines.length >= 3;
    const selective = benchmarkAveragePct < 0 ||
      (breadthPositivePct != null && breadthPositivePct < 50) ||
      (vixChangePct != null && vixChangePct >= 2) ||
      riskHeadlines.length > 0;
    if (defensive) {
      level = "DEFENSIVE";
      summary = "防守观察：避免开盘追涨，只考虑充分回撤再确认的候选，并维持原有仓位上限。";
    } else if (selective) {
      level = "SELECTIVE_LONG";
      summary = "选择性做多：只接受市场与个股方向一致、成本后余量充分的候选，避免弱广度追涨。";
    } else {
      level = "NORMAL_LONG";
      summary = "常规做多：外部环境未显示明显逆风，仍按既有成本、趋势和风控门槛执行。";
    }
  }
  return {
    schemaVersion: 1,
    generatedAt,
    tradingDate,
    status: sufficient ? "AVAILABLE" : "INSUFFICIENT_DATA",
    advice: {
      level,
      summary,
      executionEffect: "NONE"
    },
    market: {
      benchmarkAveragePct: round(benchmarkAveragePct, 3),
      breadthPositivePct: round(breadthPositivePct, 1),
      vixChangePct: round(vixChangePct, 3),
      snapshots: snapshots || []
    },
    news: {
      headlineCount: (headlines || []).length,
      riskHeadlineCount: riskHeadlines.length,
      headlines: (headlines || []).slice(0, 12)
    },
    errors,
    limitations: [
      "This is a non-executing research brief and does not change strategy, sizing or approvals.",
      "Premarket prices can be thin and may differ from executable token quotes.",
      "Headline keyword risk is a screening signal, not sentiment or causal analysis."
    ]
  };
}

export async function fetchYahooSeries(symbol, {
  range = "5d",
  interval = "5m",
  includePrePost = true
} = {}) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", String(includePrePost));
  url.searchParams.set("events", "div,splits");
  const response = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Yahoo ${symbol}: HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol}: chart unavailable`);
  return {
    symbol,
    candles: parseYahooChart(result),
    previousClose: finiteNumber(result.meta?.chartPreviousClose ?? result.meta?.previousClose)
  };
}

export function premarketSnapshot(series, tradingDate) {
  const current = series.candles.filter(({ openTime }) => (
    newYorkDate(openTime) === tradingDate &&
    newYorkMinutes(openTime) >= 4 * 60 &&
    newYorkMinutes(openTime) < 9 * 60 + 30
  ));
  const priorRegular = series.candles.filter(({ openTime }) => (
    newYorkDate(openTime) < tradingDate &&
    newYorkMinutes(openTime) >= 9 * 60 + 30 &&
    newYorkMinutes(openTime) < 16 * 60
  ));
  const latest = current.at(-1);
  const reference = priorRegular.at(-1)?.close ?? series.previousClose;
  if (!(Number(latest?.close) > 0) || !(Number(reference) > 0)) {
    throw new Error(`${series.symbol}: premarket snapshot unavailable`);
  }
  return {
    symbol: series.symbol,
    price: round(Number(latest.close), 6),
    previousClose: round(Number(reference), 6),
    changePct: round((Number(latest.close) / Number(reference) - 1) * 100, 3),
    quotedAt: new Date(latest.openTime).toISOString(),
    source: "Yahoo Finance chart"
  };
}

export async function fetchGdeltHeadlines() {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", '("stock market" OR "Federal Reserve" OR inflation OR tariff OR earnings) sourcelang:english');
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "20");
  url.searchParams.set("timespan", "12h");
  url.searchParams.set("sort", "datedesc");
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`GDELT: HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.articles || []).map((article) => ({
    title: article.title,
    source: article.domain || article.sourcecountry || "unknown",
    publishedAt: article.seendate || null,
    url: article.url || null
  }));
}
