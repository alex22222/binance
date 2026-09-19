import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { nyseSessionPlan } from "../src/strategy.mjs";
import { newYorkSessionBounds } from "../src/strategy-data.mjs";
import {
  WEEKLY_ETF_ROTATION_UNIVERSE,
  WEEKLY_ETF_ROTATION_STRATEGY_ID,
  WEEKLY_ETF_DEFENSIVE_STRATEGY_ID,
  weeklyEtfDefensiveSignal,
  advanceWeeklyEtfRotationPaper,
  initialWeeklyEtfRotationPaperState,
  weeklyEtfRotationAssets,
  weeklyEtfValuationAssets,
  weeklyEtfRotationSignal,
  weeklyPaperWeek
} from "../src/weekly-etf-rotation-paper.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const defensiveProfile = process.argv.includes("--dual-momentum-defense");
const strategyId = defensiveProfile ? WEEKLY_ETF_DEFENSIVE_STRATEGY_ID : WEEKLY_ETF_ROTATION_STRATEGY_ID;
const stateDirectory = defensiveProfile ? "state/weekly-etf-dual-momentum-paper" : "state/weekly-etf-rotation-paper";
const config = JSON.parse(await readFile(resolve(projectRoot, process.env.BOT_CONFIG || "config.json"), "utf8"));
const statePath = resolve(projectRoot, process.env.WEEKLY_ETF_PAPER_STATE || `${stateDirectory}/latest.json`);
const eventsPath = resolve(projectRoot, process.env.WEEKLY_ETF_PAPER_EVENTS || `${stateDirectory}/events.jsonl`);
const screeningPath = resolve(dirname(statePath), "screening.json");
const screenOnly = process.argv.includes("--screen-only");
const nowMs = process.env.WEEKLY_ETF_PAPER_NOW ? Date.parse(process.env.WEEKLY_ETF_PAPER_NOW) : Date.now();
if (!Number.isFinite(nowMs)) throw new Error("Invalid WEEKLY_ETF_PAPER_NOW");
const now = new Date(nowMs).toISOString();
const plan = nyseSessionPlan(nowMs);
const sessionDate = plan.date;
const week = weeklyPaperWeek(sessionDate);
const initialCapitalUsdt = Number(config.maxTradeUsdt);
const roundTripCostPct = Number(config.maxRoundTripCostPct) + Number(config.executionBufferPct)
  + Number(config.estimatedRoundTripGasUsdt) / initialCapitalUsdt * 100;
const execFileAsync = promisify(execFile);
const binanceHeaders = {
  "Accept-Encoding": "identity",
  "User-Agent": "binance-web3/1.1 (Weekly ETF Paper)"
};

function shiftDate(date, days) {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function isNyseTradingDate(date) {
  const dayPlan = nyseSessionPlan(Date.parse(`${date}T17:00:00.000Z`));
  return dayPlan.calendarSupported && ["regular-day", "early-close"].includes(dayPlan.calendarDayType);
}

function isFirstNyseTradingDateOfWeek(date) {
  let cursor = weeklyPaperWeek(date);
  while (cursor < date) {
    if (isNyseTradingDate(cursor)) return false;
    cursor = shiftDate(cursor, 1);
  }
  return isNyseTradingDate(date);
}

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function appendEvents(events) {
  if (!events.length) return;
  await mkdir(dirname(eventsPath), { recursive: true });
  await appendFile(eventsPath, events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
}

async function loadState() {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.strategyId !== strategyId) throw new Error("Paper strategy/state mismatch");
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { ...initialWeeklyEtfRotationPaperState(now, initialCapitalUsdt), strategyId };
  }
}

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("curl", [
        "-fsSL",
        "--max-time", "30",
        "-H", `Accept-Encoding: ${binanceHeaders["Accept-Encoding"]}`,
        "-A", binanceHeaders["User-Agent"],
        String(url)
      ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
    }
  }
  throw lastError;
}

async function fetchYahooDaily(ticker) {
  const period2 = Date.parse(`${sessionDate}T00:00:00.000Z`) + 86_400_000;
  const period1 = period2 - 180 * 86_400_000;
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  url.searchParams.set("period1", String(Math.floor(period1 / 1000)));
  url.searchParams.set("period2", String(Math.floor(period2 / 1000)));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits");
  const { stdout } = await execFileAsync("curl", [
    "-fsSL",
    "--compressed",
    "--max-time", "30",
    "-A", "Mozilla/5.0",
    url.toString()
  ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const payload = JSON.parse(stdout);
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo daily data unavailable: ${ticker}`);
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
  const rows = (result.timestamp || []).map((timestamp, index) => ({
    date: new Date(Number(timestamp) * 1000).toISOString().slice(0, 10),
    close: Number(adjusted[index])
  })).filter(({ date, close }) => date < sessionDate && Number.isFinite(close) && close > 0);
  await atomicJson(resolve(dirname(statePath), "daily", `${ticker}.json`), {
    ticker,
    collectedAt: now,
    sessionDate,
    source: "Yahoo Finance adjusted daily chart",
    rows
  });
  return rows;
}

async function loadSignal() {
  const tickers = [
    ...WEEKLY_ETF_ROTATION_UNIVERSE.riskTickers,
    ...(defensiveProfile ? [WEEKLY_ETF_ROTATION_UNIVERSE.defensiveTicker] : [])
  ];
  const entries = await Promise.all(tickers.map(async (ticker) => [
    ticker,
    await fetchYahooDaily(ticker)
  ]));
  const series = Object.fromEntries(entries);
  const signal = defensiveProfile ? weeklyEtfDefensiveSignal(series) : weeklyEtfRotationSignal(series);
  if (defensiveProfile) {
    let expectedDate = shiftDate(sessionDate, -1);
    while (!isNyseTradingDate(expectedDate)) expectedDate = shiftDate(expectedDate, -1);
    if (signal.signalDate !== expectedDate) throw new Error("Stale weekly ETF signal date");
  }
  return signal;
}

async function loadOfficialAssets(heldTicker = null) {
  const url = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1";
  const payload = await fetchJson(url);
  if (payload.code !== "000000" || !Array.isArray(payload.data)) {
    throw new Error(`Binance asset list failed: ${payload.code || "unknown"}`);
  }
  return {
    universeAssets: weeklyEtfRotationAssets(payload.data),
    valuationAssets: weeklyEtfValuationAssets(payload.data, heldTicker)
  };
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
    item.openTime >= sessionPlan.openMs && item.openTime < sessionPlan.closeMs
    && item.closeTime < nowMs && item.close > 0
  )).sort((left, right) => left.openTime - right.openTime).at(-1);
  if (!candle) throw new Error(`No completed regular-session token minute: ${asset.ticker}`);
  return { price: candle.close, observedAt: new Date(candle.closeTime).toISOString() };
}

const state = await loadState();
const firstTradingDate = isFirstNyseTradingDateOfWeek(sessionDate);
if (screenOnly) {
  const [{ universeAssets }, signal] = await Promise.all([loadOfficialAssets(), loadSignal()]);
  const screening = {
    at: now,
    sessionDate,
    week,
    firstTradingDate,
    strategyId: state.strategyId,
    mode: "paper",
    evidenceLevel: state.evidenceLevel,
    roundTripCostPct,
    signal,
    universe: universeAssets.map(({ ticker, symbol, chainId, contractAddress, multiplier }) => ({
      ticker, symbol, chainId, contractAddress, multiplier
    }))
  };
  await atomicJson(screeningPath, screening);
  console.log(JSON.stringify(screening));
  process.exit(0);
}

if (!plan.regularOpen) {
  const result = advanceWeeklyEtfRotationPaper(state, {
    at: now,
    sessionDate,
    week,
    regularOpen: false,
    decision: null,
    prices: {}
  }, { roundTripCostPct });
  await atomicJson(statePath, result.state);
  await appendEvents(result.events);
  console.log(JSON.stringify({ event: "weekly_etf_paper_skipped", reason: "market_closed", ...result.state.lastObservation }));
  process.exit(0);
}

const bounds = newYorkSessionBounds(sessionDate);
const sessionPlan = {
  openMs: bounds.openMs,
  closeMs: plan.closeTime === "13:00" ? bounds.openMs + 3.5 * 60 * 60_000 : bounds.closeMs
};
if (nowMs < sessionPlan.openMs + 60_000) {
  console.log(JSON.stringify({ event: "weekly_etf_paper_skipped", reason: "first_minute_incomplete", sessionDate }));
  process.exit(0);
}

const { universeAssets, valuationAssets } = await loadOfficialAssets(state.position?.symbol);
const assetsByTicker = new Map(valuationAssets.map((asset) => [asset.ticker, asset]));
const decisionDue = firstTradingDate && state.lastDecisionWeek !== week;
const decision = decisionDue ? await loadSignal() : null;
const priceTickers = [...new Set([
  ...(state.position ? [state.position.symbol] : []),
  ...(decision && decision.target !== "CASH" ? [decision.target] : [])
])];
const tokenPrices = await Promise.all(priceTickers.map(async (ticker) => [
  ticker,
  await latestTokenPrice(assetsByTicker.get(ticker), sessionPlan)
]));
const prices = Object.fromEntries(tokenPrices.map(([ticker, observation]) => [ticker, observation.price]));
const result = advanceWeeklyEtfRotationPaper(state, {
  at: now,
  sessionDate,
  week,
  regularOpen: true,
  decision,
  prices
}, { roundTripCostPct });
result.state.universe = {
  id: "binance-weekly-etf-rotation-v1",
  symbols: universeAssets.map(({ ticker }) => ticker),
  observedAt: now
};
await atomicJson(statePath, result.state);
await appendEvents(result.events);
await atomicJson(screeningPath, {
  at: now,
  sessionDate,
  week,
  firstTradingDate,
  decisionDue,
  strategyId: result.state.strategyId,
  mode: "paper",
  evidenceLevel: result.state.evidenceLevel,
  roundTripCostPct,
  decision: decision || result.state.lastDecision,
  tokenPrices: Object.fromEntries(tokenPrices),
  universe: universeAssets.map(({ ticker, symbol, chainId, contractAddress, multiplier }) => ({
    ticker, symbol, chainId, contractAddress, multiplier
  }))
});
console.log(JSON.stringify({
  event: "weekly_etf_paper_updated",
  sessionDate,
  week,
  firstTradingDate,
  decisionDue,
  target: decision?.target || result.state.position?.symbol || null,
  events: result.events,
  equityUsdt: result.state.equityUsdt,
  totalReturnPct: result.state.totalReturnPct,
  position: result.state.position
}));
