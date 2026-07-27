import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backtestStrategyLibrary } from "../src/strategy-backtest.mjs";
import {
  latestCompletedTradingDate,
  newYorkDate,
  parseBinanceCandles,
  parseYahooChart,
  splitRegularSession,
  tradingDates
} from "../src/strategy-data.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(await readFile(resolve(projectRoot, process.env.BOT_CONFIG || "config.json"), "utf8"));
const stateDirectory = resolve(
  projectRoot,
  process.env.STRATEGY_VALIDATION_DIR || "state/strategy-validation"
);
const dataDirectory = join(stateDirectory, "data");
const reportDirectory = join(stateDirectory, "reports");
const validationStatePath = join(stateDirectory, "state.json");
const historyDays = Number(process.env.STRATEGY_HISTORY_DAYS || 28);
const binanceHeaders = {
  "Accept-Encoding": "identity",
  "User-Agent": "binance-web3/1.1 (Skill)"
};

function isoDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function fetchJson(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 750));
      }
    }
  }
  throw lastError;
}

async function loadAssets() {
  const url = new URL(
    "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai"
  );
  url.searchParams.set("type", "1");
  const payload = await fetchJson(url, { headers: binanceHeaders });
  if (payload.code !== "000000" || !Array.isArray(payload.data)) {
    throw new Error(`Binance asset list failed: ${payload.code || "unknown"}`);
  }
  const bsc = payload.data.filter(({ chainId }) => chainId === "56");
  return config.symbols.map((ticker) => {
    const asset = bsc.find((candidate) => candidate.ticker === ticker);
    if (!asset) throw new Error(`BSC tokenized stock unavailable: ${ticker}`);
    return asset;
  });
}

async function downloadTokenDay(asset, date) {
  const candles = [];
  for (const chunk of splitRegularSession(date)) {
    const urlFor = (boundary, value) => {
      const url = new URL(
        "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/kline/ai"
      );
      url.searchParams.set("chainId", asset.chainId);
      url.searchParams.set("contractAddress", asset.contractAddress);
      url.searchParams.set("interval", "1m");
      url.searchParams.set("limit", "300");
      url.searchParams.set(boundary, String(value));
      return url;
    };
    let payload = await fetchJson(urlFor("startTime", chunk.startTime), { headers: binanceHeaders });
    if (payload.code !== "000000") {
      payload = await fetchJson(urlFor("endTime", chunk.endTime), { headers: binanceHeaders });
    }
    if (payload.code !== "000000") {
      throw new Error(`Binance K-line ${asset.ticker} ${date} failed: ${payload.code}`);
    }
    candles.push(...parseBinanceCandles(payload.data?.klineInfos)
      .filter(({ openTime }) => openTime >= chunk.startTime && openTime <= chunk.endTime));
  }
  return [...new Map(candles.map((candle) => [candle.openTime, candle])).values()]
    .sort((left, right) => left.openTime - right.openTime);
}

async function downloadUnderlying(asset, dates) {
  const candlesByDate = new Map(dates.map((date) => [date, []]));
  for (const date of dates) {
    const start = Date.parse(`${date}T00:00:00.000Z`);
    const end = start + 24 * 60 * 60_000;
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.ticker)}`);
    url.searchParams.set("period1", String(Math.floor(start / 1000)));
    url.searchParams.set("period2", String(Math.floor(end / 1000)));
    url.searchParams.set("interval", "1m");
    url.searchParams.set("includePrePost", "false");
    url.searchParams.set("events", "div,splits");
    const payload = await fetchJson(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const result = payload.chart?.result?.[0];
    if (!result) throw new Error(`Underlying K-line ${asset.ticker} failed`);
    for (const candle of parseYahooChart(result)) {
      const candleDate = newYorkDate(candle.openTime);
      if (candlesByDate.has(candleDate)) candlesByDate.get(candleDate).push(candle);
    }
  }
  return candlesByDate;
}

async function fileExists(path) {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function collectAsset(asset, dates) {
  const tickerDirectory = join(dataDirectory, asset.ticker);
  const missingDates = [];
  for (const date of dates) {
    if (!(await fileExists(join(tickerDirectory, `${date}.json`)))) missingDates.push(date);
  }
  if (!missingDates.length) return { ticker: asset.ticker, downloaded: 0 };
  const underlying = await downloadUnderlying(asset, missingDates);
  let downloaded = 0;
  for (const date of missingDates) {
    const tokenCandles = await downloadTokenDay(asset, date);
    const underlyingCandles = underlying.get(date) || [];
    if (tokenCandles.length < 300 || underlyingCandles.length < 300) {
      console.warn(JSON.stringify({
        event: "incomplete_day",
        ticker: asset.ticker,
        date,
        tokenCandles: tokenCandles.length,
        underlyingCandles: underlyingCandles.length
      }));
    }
    await atomicJson(join(tickerDirectory, `${date}.json`), {
      schemaVersion: 1,
      date,
      ticker: asset.ticker,
      chainId: asset.chainId,
      contractAddress: asset.contractAddress,
      multiplier: Number(asset.multiplier),
      downloadedAt: new Date().toISOString(),
      tokenSource: "Binance Web3 token K-line",
      underlyingSource: "Yahoo Finance chart",
      tokenCandles,
      underlyingCandles
    });
    downloaded += 1;
  }
  return { ticker: asset.ticker, downloaded };
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function loadDataset() {
  const dataset = {};
  for (const ticker of config.symbols) {
    const tickerDirectory = join(dataDirectory, ticker);
    let files = [];
    try {
      files = (await readdir(tickerDirectory)).filter((file) => file.endsWith(".json")).sort();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const records = await Promise.all(files.map(async (file) => (
      JSON.parse(await readFile(join(tickerDirectory, file), "utf8"))
    )));
    dataset[ticker] = {
      multiplier: records.at(-1)?.multiplier || 1,
      tokenCandles: records.flatMap(({ tokenCandles }) => tokenCandles),
      underlyingCandles: records.flatMap(({ underlyingCandles }) => underlyingCandles)
    };
  }
  return dataset;
}

function filterDataset(dataset, predicate) {
  return Object.fromEntries(Object.entries(dataset).map(([ticker, item]) => [ticker, {
    ...item,
    tokenCandles: item.tokenCandles.filter((candle) => predicate(candle.openTime)),
    underlyingCandles: item.underlyingCandles.filter((candle) => predicate(candle.openTime))
  }]));
}

async function loadValidationState() {
  try {
    return JSON.parse(await readFile(validationStatePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const startedAt = new Date().toISOString();
    const targetAt = new Date(Date.parse(startedAt) + 30 * 86_400_000).toISOString();
    return { schemaVersion: 1, startedAt, targetAt };
  }
}

function stateMarkdown(state, downloadSummary, report) {
  const rows = report.forward.strategies.map(({ name, performance }) => (
    `| ${name} | ${performance.trades} | ${performance.returnPct.toFixed(2)}% | ${performance.maxDrawdownPct.toFixed(2)}% |`
  ));
  return `# Strategy Validation Loop

## Goal

Compare all four strategies over the 30-day forward window ending ${state.targetAt}.

## Current

- Started: ${state.startedAt}
- Target: ${state.targetAt}
- Last run: ${report.generatedAt}
- Downloaded this run: ${downloadSummary.reduce((sum, item) => sum + item.downloaded, 0)} symbol-days
- Production trading configuration changed: no

| Strategy | Forward trades | Forward return | Max drawdown |
|---|---:|---:|---:|
${rows.join("\n")}

## Stop condition

The target time has passed, every strategy has a result row, and data coverage plus limitations are recorded.
`;
}

const now = Date.now();
const endDate = latestCompletedTradingDate(now);
const startDate = isoDate(Date.parse(`${endDate}T00:00:00.000Z`) - (historyDays - 1) * 86_400_000);
const dates = tradingDates(startDate, endDate);
const assets = await loadAssets();
console.log(JSON.stringify({ event: "collection_started", startDate, endDate, tradingDays: dates.length }));
const downloadSummary = await mapWithConcurrency(assets, 2, (asset) => collectAsset(asset, dates));
const validationState = await loadValidationState();
await atomicJson(validationStatePath, validationState);
const dataset = await loadDataset();
const assumptions = {
  maxTradeUsdt: config.maxTradeUsdt,
  roundTripCostPct: config.maxRoundTripCostPct +
    config.executionBufferPct +
    config.estimatedRoundTripGasUsdt / config.maxTradeUsdt * 100
};
const forwardStartMs = Date.parse(validationState.startedAt);
const historical = backtestStrategyLibrary(filterDataset(dataset, (timestamp) => timestamp < forwardStartMs), assumptions);
const forward = backtestStrategyLibrary(filterDataset(dataset, (timestamp) => timestamp >= forwardStartMs), assumptions);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  validation: validationState,
  sources: {
    token: "Binance Web3 token K-line",
    underlying: "Yahoo Finance chart",
    executableQuoteHistoryAvailable: false
  },
  limitations: [
    "Historical basis results use reference prices and the current shares multiplier, not archived amount-specific executable quotes.",
    "All historical strategies use a conservative fixed round-trip cost assumption.",
    "Research strategies are validation-only and are not enabled in production."
  ],
  historical,
  forward
};
await atomicJson(join(stateDirectory, "latest.json"), report);
await atomicJson(join(reportDirectory, `${isoDate(now)}.json`), report);
await writeFile(join(stateDirectory, "LOOP_STATE.md"), stateMarkdown(validationState, downloadSummary, report), { mode: 0o600 });
console.log(JSON.stringify({
  event: "validation_finished",
  report: join(stateDirectory, "latest.json"),
  targetAt: validationState.targetAt,
  downloadSummary,
  historical: historical.strategies.map(({ id, performance }) => ({ id, ...performance })),
  forward: forward.strategies.map(({ id, performance }) => ({ id, ...performance }))
}, null, 2));
