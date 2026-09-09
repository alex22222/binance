import { nyseSessionPlan } from "./strategy.mjs";

const NEW_YORK = "America/New_York";

function zonedParts(timestamp, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
}

function zonedDateTimeMs(date, hour, minute, timeZone = NEW_YORK) {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate, timeZone);
    const displayed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    candidate += target - displayed;
  }
  return candidate;
}

export function newYorkSessionBounds(date) {
  return {
    openMs: zonedDateTimeMs(date, 9, 30),
    closeMs: zonedDateTimeMs(date, 16, 0)
  };
}

export function newYorkDate(timestamp) {
  const parts = zonedParts(timestamp, NEW_YORK);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function tradingDates(startDate, endDate) {
  const dates = [];
  for (
    let timestamp = Date.parse(`${startDate}T00:00:00.000Z`);
    timestamp <= Date.parse(`${endDate}T00:00:00.000Z`);
    timestamp += 86_400_000
  ) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const { openMs } = newYorkSessionBounds(date);
    const plan = nyseSessionPlan(openMs + 60 * 60_000);
    if (plan.calendarDayType === "regular-day" || plan.calendarDayType === "early-close") {
      dates.push(date);
    }
  }
  return dates;
}

export function latestCompletedTradingDate(nowMs = Date.now()) {
  let date = newYorkDate(nowMs);
  if (
    tradingDates(date, date).length &&
    nowMs >= newYorkSessionBounds(date).closeMs
  ) {
    return date;
  }
  for (let offset = 1; offset <= 10; offset += 1) {
    const candidate = new Date(Date.parse(`${date}T00:00:00.000Z`) - offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (tradingDates(candidate, candidate).length) return candidate;
  }
  throw new Error("Unable to resolve the latest completed NYSE trading date");
}

export function splitRegularSession(date, maximumCandles = 300) {
  const { openMs, closeMs } = newYorkSessionBounds(date);
  const chunks = [];
  for (let startTime = openMs; startTime < closeMs; startTime += maximumCandles * 60_000) {
    chunks.push({
      startTime,
      endTime: Math.min(closeMs, startTime + maximumCandles * 60_000) - 1
    });
  }
  return chunks;
}

export function parseBinanceCandles(klineInfos) {
  return (klineInfos || []).map((candle) => ({
    openTime: Number(candle[0]),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5]),
    closeTime: Number(candle[6])
  })).filter((candle) => (
    Number.isFinite(candle.openTime) &&
    [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
  ));
}

export function parseYahooChart(chart, intervalMs = 60_000) {
  const timestamps = chart?.timestamp || [];
  const quote = chart?.indicators?.quote?.[0] || {};
  return timestamps.map((timestamp, index) => ({
    openTime: Number(timestamp) * 1000,
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
    volume: Number(quote.volume?.[index] || 0),
    closeTime: Number(timestamp) * 1000 + intervalMs - 1
  })).filter((candle) => (
    Number.isFinite(candle.openTime) &&
    [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
  ));
}
