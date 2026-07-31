function candleValue(candle, property, index) {
  return Number(Array.isArray(candle) ? candle[index] : candle?.[property]);
}

function closedCandles(candles, nowMs) {
  return candles.filter((candle) => candleValue(candle, "closeTime", 6) < nowMs);
}

export function analyzeCandles(candles, nowMs = Date.now()) {
  const closed = closedCandles(candles, nowMs);
  const recent = closed.slice(-16);
  if (recent.length < 16) return null;

  const closes = recent.map((candle) => candleValue(candle, "close", 4));
  const changes = closes.slice(1).map((value, index) => value - closes[index]);
  const upMinutes = changes.filter((change) => change > 0).length;
  const downMinutes = changes.filter((change) => change < 0).length;
  const trend15mPct = ((closes.at(-1) / closes[0]) - 1) * 100;

  return {
    trend15mPct,
    upMinutes,
    downMinutes,
    lastPrice: closes.at(-1),
    lastCandleTime: candleValue(recent.at(-1), "openTime", 0)
  };
}

export function calculateAtrPct(candles, period = 14, nowMs = Date.now()) {
  const closed = closedCandles(candles, nowMs);
  const recent = closed.slice(-(period + 1));
  if (recent.length < period + 1) return null;

  const trueRanges = recent.slice(1).map((candle, index) => {
    const high = candleValue(candle, "high", 2);
    const low = candleValue(candle, "low", 3);
    const previousClose = candleValue(recent[index], "close", 4);
    if (![high, low, previousClose].every(Number.isFinite)) return NaN;
    return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  });
  const lastPrice = candleValue(recent.at(-1), "close", 4);
  if (!(lastPrice > 0) || trueRanges.some((value) => !Number.isFinite(value))) return null;

  const atr = trueRanges.reduce((sum, value) => sum + value, 0) / period;
  return {
    atr,
    atrPct: (atr / lastPrice) * 100,
    period,
    closedCandles: closed.length,
    lastPrice,
    lastCandleTime: candleValue(recent.at(-1), "openTime", 0)
  };
}
