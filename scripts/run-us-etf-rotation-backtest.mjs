import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  US_ETF_ROTATION_CONFIG,
  US_ETF_ROTATION_UNIVERSE,
  alignDailySeries,
  backtestBuyAndHold,
  backtestEtfRotation,
  parseYahooAdjustedDailyChart
} from "../src/us-etf-rotation-backtest.mjs";

const asOfDate = process.env.US_ETF_BACKTEST_AS_OF || new Date().toISOString().slice(0, 10);
const execFileAsync = promisify(execFile);
const profiles = {
  original: {
    universe: US_ETF_ROTATION_UNIVERSE,
    descriptions: {
      QQQ: "Nasdaq-100 large growth",
      IWO: "Russell 2000 Growth small-cap growth",
      VYM: "US high dividend",
      SPY: "S&P 500 broad large-cap",
      IEI: "3-7 year US Treasury defensive asset"
    },
    earlyPeriodId: "early2007To2016",
    earlyPeriodEnd: "2016-12-31",
    latePeriodId: "late2017ToPresent",
    latePeriodStart: "2017-01-01",
    outputName: `us-etf-rotation-${asOfDate}`
  },
  binance: {
    universe: {
      riskTickers: ["QQQ", "IWM", "DGRW", "SPY"],
      defensiveTicker: "IEI"
    },
    descriptions: {
      QQQ: "Nasdaq-100 large growth; Binance Wallet QQQon underlying",
      IWM: "Russell 2000 small-cap; Binance-available proxy for IWO",
      DGRW: "US dividend growth; Binance-available proxy for VYM",
      SPY: "S&P 500 broad large-cap; Binance Wallet SPYon underlying",
      IEI: "3-7 year US Treasury defensive asset; Binance Wallet IEIon underlying"
    },
    earlyPeriodId: "early2013To2019",
    earlyPeriodEnd: "2019-12-31",
    latePeriodId: "late2020ToPresent",
    latePeriodStart: "2020-01-01",
    outputName: `us-etf-rotation-binance-${asOfDate}`
  }
};
const profileId = process.env.US_ETF_ROTATION_PROFILE || "original";
const profile = profiles[profileId];
if (!profile) throw new Error(`Unknown US_ETF_ROTATION_PROFILE: ${profileId}`);
const universe = profile.universe;
const outputDir = path.resolve(`artifacts/${profile.outputName}`);
const dataDir = path.join(outputDir, "data");
const tickers = [...universe.riskTickers, universe.defensiveTicker];
await fs.mkdir(dataDir, { recursive: true });

async function fetchYahooChart(ticker) {
  const period1 = Math.floor(Date.parse("2006-01-01T00:00:00Z") / 1000);
  const period2 = Math.floor((Date.parse(`${asOfDate}T00:00:00Z`) + 86_400_000) / 1000);
  let lastError;
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  for (let attempt = 0; attempt < hosts.length; attempt += 1) {
    const host = hosts[attempt];
    const url = new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}`);
    url.searchParams.set("period1", String(period1));
    url.searchParams.set("period2", String(period2));
    url.searchParams.set("interval", "1d");
    url.searchParams.set("includePrePost", "false");
    url.searchParams.set("events", "div,splits");
    try {
      const { stdout } = await execFileAsync("curl", [
        "-fsSL",
        "--compressed",
        "--max-time", "30",
        "-A", "Mozilla/5.0",
        url.toString()
      ], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
      const payload = JSON.parse(stdout);
      const result = payload.chart?.result?.[0];
      if (!result) throw new Error(payload.chart?.error?.description || "chart unavailable");
      return { url: url.toString(), payload, result };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`Yahoo ${ticker}: ${lastError?.message || "download failed"}`);
}

const downloads = [];
for (const ticker of tickers) {
  const downloaded = await fetchYahooChart(ticker);
  const raw = `${JSON.stringify(downloaded.payload)}\n`;
  await fs.writeFile(path.join(dataDir, `${ticker}.json`), raw);
  const bars = parseYahooAdjustedDailyChart(downloaded.result);
  downloads.push({
    ticker,
    bars,
    manifest: {
      ticker,
      source: "Yahoo Finance chart API",
      url: downloaded.url,
      rows: bars.length,
      firstDate: bars[0]?.date,
      lastDate: bars.at(-1)?.date,
      sha256: crypto.createHash("sha256").update(raw).digest("hex")
    }
  });
}
const seriesByTicker = Object.fromEntries(downloads.map(({ ticker, bars }) => [ticker, bars]));
const rows = alignDailySeries(seriesByTicker, tickers);
if (rows.length < 252) throw new Error(`Insufficient common history: ${rows.length} rows`);

const firstSignalDate = rows[Math.max(US_ETF_ROTATION_CONFIG.momentumDays, US_ETF_ROTATION_CONFIG.rsiPeriod) + 1].date;
const lastDate = rows.at(-1).date;
const runRotation = (overrides = {}) => backtestEtfRotation({
  rows,
  riskTickers: universe.riskTickers,
  defensiveTicker: universe.defensiveTicker,
  ...overrides
});
const scenarios = Object.fromEntries([
  ["zeroCost", 0],
  ["base5BpsPerSide", 5],
  ["stress10BpsPerSide", 10]
].map(([name, costBpsPerSide]) => [name, runRotation({ costBpsPerSide })]));
scenarios.momentumOnly5BpsPerSide = runRotation({ rsiThreshold: 0 });
const periodRanges = {
  [profile.earlyPeriodId]: { startDate: firstSignalDate, endDate: profile.earlyPeriodEnd },
  [profile.latePeriodId]: { startDate: profile.latePeriodStart, endDate: lastDate }
};
const periods = {
  [profile.earlyPeriodId]: runRotation(periodRanges[profile.earlyPeriodId]),
  [profile.latePeriodId]: runRotation(periodRanges[profile.latePeriodId])
};
const benchmarks = Object.fromEntries(tickers.map((ticker) => [ticker, backtestBuyAndHold({
  rows,
  weights: { [ticker]: 1 },
  startDate: firstSignalDate,
  endDate: lastDate
})]));
Object.assign(benchmarks, {
  equalWeightRisk: backtestBuyAndHold({
    rows,
    weights: Object.fromEntries(universe.riskTickers.map((ticker) => [ticker, 1 / universe.riskTickers.length])),
    startDate: firstSignalDate,
    endDate: lastDate
  }),
  spy60Iei40: backtestBuyAndHold({ rows, weights: { SPY: 0.6, IEI: 0.4 }, startDate: firstSignalDate, endDate: lastDate })
});
const periodBenchmarks = Object.fromEntries(Object.entries(periodRanges).map(([period, range]) => [period, {
  QQQ: backtestBuyAndHold({ rows, weights: { QQQ: 1 }, ...range }).metrics,
  SPY: backtestBuyAndHold({ rows, weights: { SPY: 1 }, ...range }).metrics,
  spy60Iei40: backtestBuyAndHold({ rows, weights: { SPY: 0.6, IEI: 0.4 }, ...range }).metrics
}]));

const sensitivity = [];
const sensitivityStartDate = rows[61].date;
for (const momentumDays of [10, 20, 40, 60]) {
  for (const rsiPeriod of [10, 14, 20]) {
    for (const rsiThreshold of [35, 40, 45]) {
      const result = runRotation({ startDate: sensitivityStartDate, momentumDays, rsiPeriod, rsiThreshold });
      sensitivity.push({ momentumDays, rsiPeriod, rsiThreshold, ...result.metrics });
    }
  }
}
const sourceFiles = [
  "src/us-etf-rotation-backtest.mjs",
  "scripts/run-us-etf-rotation-backtest.mjs"
];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [
  file,
  crypto.createHash("sha256").update(await fs.readFile(path.resolve(file))).digest("hex")
])));
const compact = (result) => result.metrics;
const summary = {
  generatedAt: new Date().toISOString(),
  asOfDate,
  profile: profileId,
  evidenceLevel: "HISTORICAL_ADJUSTED_OHLC_PROXY",
  executionRule: "Prior trading day adjusted close signal; first trading day of next week adjusted open execution",
  dividends: "Yahoo adjusted OHLC total-return proxy; ETF expenses embedded; taxes excluded",
  universe: profile.descriptions,
  sourceHashes,
  dataManifest: downloads.map(({ manifest }) => manifest),
  commonCoverage: { rows: rows.length, firstDate: rows[0].date, firstSignalDate, lastDate },
  scenarios: Object.fromEntries(Object.entries(scenarios).map(([name, result]) => [name, compact(result)])),
  periods: Object.fromEntries(Object.entries(periods).map(([name, result]) => [name, compact(result)])),
  benchmarks: Object.fromEntries(Object.entries(benchmarks).map(([name, result]) => [name, compact(result)])),
  periodBenchmarks,
  sensitivityStartDate,
  sensitivity
};
await Promise.all([
  fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
  fs.writeFile(path.join(outputDir, "base-trades.json"), `${JSON.stringify(scenarios.base5BpsPerSide.trades, null, 2)}\n`),
  fs.writeFile(path.join(outputDir, "base-equity.json"), `${JSON.stringify(scenarios.base5BpsPerSide.equityCurve, null, 2)}\n`)
]);
console.log(JSON.stringify(summary, null, 2));
console.error(`Completed: ${path.join(outputDir, "summary.json")}`);
