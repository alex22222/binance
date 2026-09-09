import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { nyseSessionPlan } from "../src/strategy.mjs";
import { newYorkSessionBounds } from "../src/strategy-data.mjs";
import {
  advanceTurtlePaper,
  initialTurtlePaperState,
  turtleDailyFeature
} from "../src/turtle-paper.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(projectRoot, process.env.BOT_CONFIG || "config.json"), "utf8"));
const statePath = resolve(projectRoot, process.env.TURTLE_PAPER_STATE || "state/turtle-paper/latest.json");
const eventsPath = resolve(projectRoot, process.env.TURTLE_PAPER_EVENTS || "state/turtle-paper/events.jsonl");
const nowMs = process.env.TURTLE_PAPER_NOW ? Date.parse(process.env.TURTLE_PAPER_NOW) : Date.now();
const now = new Date(nowMs).toISOString();
const roundTripCostPct = config.maxRoundTripCostPct + config.executionBufferPct +
  config.estimatedRoundTripGasUsdt / config.maxTradeUsdt * 100;
const headers = {
  "Accept-Encoding": "identity",
  "User-Agent": "binance-web3/1.1 (Turtle Paper)"
};

function newYorkDate(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = initialTurtlePaperState(now);
    await atomicJson(statePath, state);
    return state;
  }
}

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
    }
  }
  throw lastError;
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]);
    }
  }));
  return results;
}

async function dailyCandles(symbol, sessionDate) {
  const endMs = Date.parse(`${sessionDate}T00:00:00Z`) + 2 * 86_400_000;
  const startMs = endMs - 450 * 86_400_000;
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("period1", String(Math.floor(startMs / 1000)));
  url.searchParams.set("period2", String(Math.floor(endMs / 1000)));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits");
  const result = (await fetchJson(url)).chart?.result?.[0];
  if (!result) throw new Error(`Yahoo daily data unavailable: ${symbol}`);
  const quote = result.indicators?.quote?.[0] || {};
  return (result.timestamp || []).map((timestamp, index) => ({
    openTime: Number(timestamp) * 1000,
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index])
  })).filter((candle) => (
    newYorkDate(candle.openTime) < sessionDate &&
    [candle.high, candle.low, candle.close].every(Number.isFinite)
  ));
}

async function assetsByTicker() {
  const url = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1";
  const payload = await fetchJson(url);
  if (payload.code !== "000000" || !Array.isArray(payload.data)) {
    throw new Error(`Binance asset list failed: ${payload.code || "unknown"}`);
  }
  return new Map(payload.data.filter(({ chainId }) => chainId === "56")
    .map((asset) => [asset.ticker, asset]));
}

async function latestTokenPrice(asset, sessionPlan) {
  const url = new URL("https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/kline/ai");
  url.searchParams.set("chainId", asset.chainId);
  url.searchParams.set("contractAddress", asset.contractAddress);
  url.searchParams.set("interval", "1m");
  url.searchParams.set("limit", "5");
  url.searchParams.set("endTime", String(nowMs));
  const payload = await fetchJson(url);
  if (payload.code !== "000000") throw new Error(`Binance token K-line failed: ${asset.ticker}`);
  const candle = (payload.data?.klineInfos || []).map((row) => ({
    openTime: Number(row[0]),
    close: Number(row[4]),
    closeTime: Number(row[6])
  })).filter((item) => (
    item.openTime >= sessionPlan.openMs && item.openTime < sessionPlan.closeMs &&
    item.closeTime < nowMs && item.close > 0
  )).sort((left, right) => left.openTime - right.openTime).at(-1);
  if (!candle) throw new Error(`No completed regular-session token minute: ${asset.ticker}`);
  return { price: candle.close, observedAt: new Date(candle.closeTime).toISOString() };
}

const state = await loadState();
const sessionDate = newYorkDate(nowMs);
const plan = nyseSessionPlan(nowMs);
const bounds = newYorkSessionBounds(sessionDate);
const sessionPlan = {
  ...plan,
  openMs: bounds.openMs,
  closeMs: plan.closeTime === "13:00" ? bounds.openMs + 3.5 * 60 * 60_000 : bounds.closeMs
};
if (!plan.regularOpen || nowMs < sessionPlan.openMs + 60_000) {
  const result = advanceTurtlePaper(state, {
    at: now,
    sessionDate,
    regularOpen: false,
    candidates: [],
    positionObservation: null
  }, { notionalUsdt: config.maxTradeUsdt, roundTripCostPct });
  await atomicJson(statePath, result.state);
  await mkdir(dirname(eventsPath), { recursive: true });
  await appendFile(eventsPath, result.events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
  console.log(JSON.stringify({ event: "turtle_paper_skipped", reason: "market_closed_or_first_minute", ...result.state.lastObservation }));
  process.exit(0);
}

const blockedSymbols = config.entryBlockedSymbols || [];
const eligibleSymbols = config.symbols.filter((symbol) => !blockedSymbols.includes(symbol));
const daily = new Map(await mapWithConcurrency(eligibleSymbols, 4, async (symbol) => [
  symbol,
  turtleDailyFeature(await dailyCandles(symbol, sessionDate))
]));
const assets = await assetsByTicker();
let positionObservation = null;
if (state.position) {
  const asset = assets.get(state.position.symbol);
  if (!asset) throw new Error(`BSC tokenized stock unavailable: ${state.position.symbol}`);
  const token = await latestTokenPrice(asset, sessionPlan);
  positionObservation = {
    symbol: state.position.symbol,
    price: token.price,
    observedAt: token.observedAt,
    exitBreakout: daily.get(state.position.symbol)?.exitBreakout === true
  };
}
const breakoutFeatures = [...daily.entries()].filter(([, feature]) => feature?.entryBreakout);
const candidates = state.position || state.lastEntryEvaluationDate === sessionDate
  ? []
  : await mapWithConcurrency(breakoutFeatures, 3, async ([symbol, feature]) => {
      const asset = assets.get(symbol);
      if (!asset) throw new Error(`BSC tokenized stock unavailable: ${symbol}`);
      const token = await latestTokenPrice(asset, sessionPlan);
      return { symbol, price: token.price, observedAt: token.observedAt, ...feature };
    });
const result = advanceTurtlePaper(state, {
  at: now,
  sessionDate,
  regularOpen: true,
  candidates,
  positionObservation
}, { notionalUsdt: config.maxTradeUsdt, roundTripCostPct });
await atomicJson(statePath, result.state);
await mkdir(dirname(eventsPath), { recursive: true });
await appendFile(eventsPath, result.events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
console.log(JSON.stringify({
  event: "turtle_paper_updated",
  sessionDate,
  eligibleSymbols: eligibleSymbols.length,
  breakoutSignals: breakoutFeatures.map(([symbol]) => symbol),
  events: result.events,
  realizedPnlUsdt: result.state.realizedPnlUsdt,
  position: result.state.position
}));
