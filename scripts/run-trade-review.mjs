import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { latestCompletedTradingDate, newYorkDate, tradingDates } from "../src/strategy-data.mjs";
import {
  buildTradingReview,
  shouldGenerateTradingReview,
  writeTradingReviewArchive
} from "../src/trade-review.mjs";
import {
  buildExternalMarketAttribution,
  fetchYahooSeries
} from "../src/market-context.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(await readFile(
  resolve(projectRoot, process.env.BOT_CONFIG || "config.json"),
  "utf8"
));
const statePath = resolve(projectRoot, config.stateFile);
const tracePath = resolve(projectRoot, config.traceFile);
const outputDirectory = resolve(
  projectRoot,
  process.env.TRADE_REVIEW_DIR || "state/trade-reviews"
);
const nowMs = Date.now();
const tradingDate = latestCompletedTradingDate(nowMs);
const archiveExists = await readFile(
  resolve(outputDirectory, "daily", `${tradingDate}.json`),
  "utf8"
).then(() => true).catch((error) => error.code === "ENOENT" ? false : Promise.reject(error));
if (!shouldGenerateTradingReview({
  currentNewYorkDate: newYorkDate(nowMs),
  tradingDate,
  archiveExists
})) {
  console.log(JSON.stringify({
    event: "trade_review_skipped",
    reason: "NO_NEW_COMPLETED_TRADING_DAY",
    tradingDate
  }));
  process.exit(0);
}
const sessionStart = new Date(
  Date.parse(`${tradingDate}T00:00:00.000Z`) - 60 * 86_400_000
).toISOString().slice(0, 10);
const [stateText, traceText] = await Promise.all([
  readFile(statePath, "utf8").catch((error) => error.code === "ENOENT" ? "{}" : Promise.reject(error)),
  readFile(tracePath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error))
]);
const malformed = [];
const records = traceText.split("\n").filter(Boolean).flatMap((line, index) => {
  try {
    return [JSON.parse(line)];
  } catch {
    malformed.push(index + 1);
    return [];
  }
});
const baseReport = buildTradingReview({
  records,
  state: JSON.parse(stateText),
  tradingDate,
  generatedAt: new Date(nowMs).toISOString(),
  sessionDates: tradingDates(sessionStart, tradingDate)
});
const marketSymbols = [...new Set([
  "SPY",
  "QQQ",
  ...baseReport.trades.map(({ symbol }) => symbol)
])];
const candlesBySymbol = {};
const marketErrors = [];
for (let index = 0; index < marketSymbols.length; index += 3) {
  const batch = marketSymbols.slice(index, index + 3);
  const results = await Promise.allSettled(batch.map((symbol) => (
    fetchYahooSeries(symbol, {
      range: "5d",
      interval: "1m",
      includePrePost: false
    })
  )));
  results.forEach((result, resultIndex) => {
    const symbol = batch[resultIndex];
    if (result.status === "fulfilled") candlesBySymbol[symbol] = result.value.candles;
    else marketErrors.push(`${symbol}: ${result.reason.message}`);
  });
}
const externalMarket = buildExternalMarketAttribution({
  trades: baseReport.trades,
  candlesBySymbol,
  errors: marketErrors
});
const premarketBrief = await readFile(
  resolve(outputDirectory, "premarket", `${tradingDate}.json`),
  "utf8"
).then(JSON.parse).catch((error) => (
  error.code === "ENOENT" ? null : Promise.reject(error)
));
const report = buildTradingReview({
  records,
  state: JSON.parse(stateText),
  tradingDate,
  generatedAt: new Date(nowMs).toISOString(),
  sessionDates: tradingDates(sessionStart, tradingDate),
  externalMarket,
  premarketBrief
});
await writeTradingReviewArchive(outputDirectory, report);
console.log(JSON.stringify({
  event: "trade_review_finished",
  tradingDate,
  report: resolve(outputDirectory, "latest.json"),
  trades: report.daily.trades,
  realizedPnlUsdt: report.daily.realizedPnlUsdt,
  openPositions: report.openPositions.length,
  marketAttributionStatus: report.externalMarket.status,
  marketAttributedLossSharePct: report.externalMarket.marketAttributedLossSharePct,
  malformedTraceLines: malformed.length,
  stateDirectory: dirname(statePath)
}));
