import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMarketOverview } from "../src/market-overview.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = resolve(projectRoot, process.env.MARKET_OVERVIEW_DIR || "state/market-overview");
try {
  const report = await runMarketOverview({ directory });
  console.log(JSON.stringify({ generatedAt: report.generatedAt, status: report.status,
    assets: report.assets.map(({ symbol, status, asOf, fetchedAt, error }) => ({ symbol, status, asOf, fetchedAt, error })), errors: report.errors }));
  if (report.status !== "OK") process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ status: "FAILED", error: error.message })); process.exitCode = 1; }
