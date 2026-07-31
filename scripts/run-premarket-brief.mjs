import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPremarketBrief,
  fetchGdeltHeadlines,
  fetchYahooSeries,
  premarketSnapshot
} from "../src/market-context.mjs";
import {
  newYorkDate,
  newYorkSessionBounds,
  tradingDates
} from "../src/strategy-data.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(await readFile(
  resolve(projectRoot, process.env.BOT_CONFIG || "config.json"),
  "utf8"
));
const outputDirectory = resolve(
  projectRoot,
  process.env.TRADE_REVIEW_DIR || "state/trade-reviews"
);
const nowMs = Date.now();
const tradingDate = newYorkDate(nowMs);
const { openMs } = newYorkSessionBounds(tradingDate);
if (
  !tradingDates(tradingDate, tradingDate).length ||
  nowMs < openMs - 90 * 60_000 ||
  nowMs >= openMs
) {
  console.log(JSON.stringify({
    event: "premarket_brief_skipped",
    reason: "OUTSIDE_PREMARKET_COLLECTION_WINDOW",
    tradingDate
  }));
  process.exit(0);
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

const symbols = [...new Set(["SPY", "QQQ", "IWM", "^VIX", "ES=F", "NQ=F", ...config.symbols])];
const snapshots = [];
const errors = [];
for (let index = 0; index < symbols.length; index += 3) {
  const batch = symbols.slice(index, index + 3);
  const results = await Promise.allSettled(batch.map(async (symbol) => (
    premarketSnapshot(await fetchYahooSeries(symbol), tradingDate)
  )));
  results.forEach((result, resultIndex) => {
    if (result.status === "fulfilled") snapshots.push(result.value);
    else errors.push(`${batch[resultIndex]}: ${result.reason.message}`);
  });
}
let headlines = [];
try {
  headlines = await fetchGdeltHeadlines();
} catch (error) {
  errors.push(error.message);
}
const brief = buildPremarketBrief({
  tradingDate,
  generatedAt: new Date(nowMs).toISOString(),
  snapshots,
  stockSymbols: config.symbols,
  headlines,
  errors
});
await atomicJson(resolve(outputDirectory, "premarket", `${tradingDate}.json`), brief);
await atomicJson(resolve(outputDirectory, "premarket-latest.json"), brief);
console.log(JSON.stringify({
  event: "premarket_brief_finished",
  tradingDate,
  level: brief.advice.level,
  snapshots: snapshots.length,
  headlines: headlines.length,
  errors: errors.length
}));
