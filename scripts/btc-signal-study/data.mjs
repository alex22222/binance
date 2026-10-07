// Pre-registered BTC strong-signal study. Rules are fixed before looking at results;
// every decision uses data available at the end of the signal day, and trades
// execute one day later (conservative) unless noted.
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), "utf8");
export const DAY = 86_400_000;
export const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const ms = (date) => Date.parse(`${date}T00:00:00Z`);
export const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
export const median = (values) => { const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
export const clamp = (value) => Math.max(0, Math.min(100, value));
export const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
export const pct = (value, digits = 1) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;

// ---- Daily BTC close (CoinMetrics reference rate at 00:00 UTC ending the day) and MVRV.
export const days = [];
export const price = [];
export const mvrv = [];
for (const row of JSON.parse(read("coinmetrics.json"))) {
  if (row.PriceUSD == null) continue;
  days.push(row.time.slice(0, 10));
  price.push(Number(row.PriceUSD));
  mvrv.push(row.CapMVRVCur == null ? Number.NaN : Number(row.CapMVRVCur));
}
for (let index = 1; index < days.length; index += 1) {
  if (ms(days[index]) - ms(days[index - 1]) !== DAY) throw new Error(`gap before ${days[index]}`);
}
export const dayIndex = new Map(days.map((day, index) => [day, index]));

// ---- Funding: BitMEX XBTUSD (2016-) then OKX BTC-USDT-SWAP after BitMEX's last print.
const bitmex = JSON.parse(read("bitmex-funding.json")).map(({ timestamp, fundingRate }) => ({ ts: Date.parse(timestamp), rate: fundingRate }));
const lastBitmex = bitmex.at(-1).ts;
const okxFunding = JSON.parse(read("okx-funding.json")).filter(({ ts }) => ts > lastBitmex);
export const funding = [...bitmex, ...okxFunding].sort((left, right) => left.ts - right.ts);
export function fundingWindow(endMs, windowMs) {
  // Events in (end - window, end].
  let low = 0; let high = funding.length;
  while (low < high) { const mid = (low + high) >> 1; if (funding[mid].ts <= endMs - windowMs) low = mid + 1; else high = mid; }
  const rates = [];
  for (let index = low; index < funding.length && funding[index].ts <= endMs; index += 1) rates.push(funding[index].rate);
  return rates;
}

// ---- Fear & Greed (published at 00:00 UTC of its date).
export const fng = new Map(JSON.parse(read("fng.json")).map(({ value, timestamp }) => [iso(Number(timestamp) * 1000), Number(value)]));

// ---- FRED series (observation date = US business day; used with a one-day lag).
function fred(id) {
  return read(`${id}.csv`).trim().split("\n").slice(1)
    .map((line) => line.split(","))
    .filter(([, value]) => value && value !== ".")
    .map(([date, value]) => ({ t: ms(date), value: Number(value) }));
}
const dollar = fred("DTWEXBGS");
const realYield = fred("DFII10");
const nominal10 = fred("DGS10");
export function asOfIndex(series, t) {
  let low = 0; let high = series.length - 1; let found = -1;
  while (low <= high) { const mid = (low + high) >> 1; if (series[mid].t <= t) { found = mid; low = mid + 1; } else high = mid - 1; }
  return found;
}

// ---- Gold (XAUT daily close, OKX) for the radar's gold factor.
const gold = new Map(JSON.parse(read("xaut.json")).filter(({ confirm }) => confirm === "1").map(({ ts, close }) => [iso(ts), close]));

// ---- Indicators per day.
export const sma = (index, length) => (index + 1 < length ? Number.NaN : mean(price.slice(index - length + 1, index + 1)));
export const rows = days.map((day, index) => {
  const t = ms(day);
  const P = price[index];
  const ma = Object.fromEntries([20, 50, 100, 200].map((length) => [length, sma(index, length)]));
  const votes = [20, 50, 100, 200].map((length) => sign(P - ma[length]));
  const rates7 = fundingWindow(t + DAY, 7 * DAY);
  const rates1 = fundingWindow(t + DAY, DAY);
  const g = fng.get(day);
  const lag = t - DAY; // FRED: last observation on or before the previous day
  const d0 = asOfIndex(dollar, lag); const d3 = asOfIndex(dollar, lag - 91 * DAY);
  const r0 = asOfIndex(realYield, lag); const r3 = asOfIndex(realYield, lag - 91 * DAY);
  const dollarChange = d0 >= 0 && d3 >= 0 ? dollar[d0].value / dollar[d3].value - 1 : Number.NaN;
  const realChange = r0 >= 0 && r3 >= 0 ? realYield[r0].value - realYield[r3].value : Number.NaN;
  const y0 = asOfIndex(nominal10, lag);
  return {
    day, index, P, date: day, close: P,
    ma, trend: votes.some(Number.isNaN) ? Number.NaN : mean(votes),
    r28: index >= 28 ? P / price[index - 28] - 1 : Number.NaN,
    move7: index >= 7 ? P / price[index - 7] - 1 : Number.NaN,
    funding7: rates7.length >= 15 ? mean(rates7) * 3 * 365 : Number.NaN, // annualized, 8h funding
    funding1bps: rates1.length ? mean(rates1) * 10_000 : Number.NaN,
    fundingDay: rates1.reduce((sum, rate) => sum + rate, 0),
    fng: g ?? Number.NaN,
    macro: Number.isNaN(dollarChange) || Number.isNaN(realChange) ? Number.NaN : (sign(-dollarChange) + sign(-realChange)) / 2,
    dollarChange, realChange,
    y10: y0 >= 0 ? nominal10[y0].value : Number.NaN,
    y10change: y0 >= 10 ? (nominal10[y0].value - nominal10[y0 - 10].value) * 100 : Number.NaN,
    gold10: gold.has(day) && gold.has(iso(t - 10 * DAY)) ? (gold.get(day) / gold.get(iso(t - 10 * DAY)) - 1) * 100 : Number.NaN,
    mvrv: mvrv[index]
  };
});

export const at = (index) => rows[index];
export const recent = (index, length, pick) => rows.slice(Math.max(0, index - length + 1), index + 1).map(pick);
