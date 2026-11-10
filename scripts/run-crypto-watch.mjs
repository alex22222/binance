import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCryptoWatch } from "../src/crypto-watch.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = resolve(projectRoot, process.env.CRYPTO_WATCH_DIR || "state/crypto");
try {
  const report = await runCryptoWatch({ directory });
  console.log(JSON.stringify({ date: report.date, generatedAt: report.generatedAt, status: report.status, instruments: report.tokens.length,
    failed: report.tokens.filter(row => row.status === "FAILED").map(row => row.instId), newsStatus: report.news.status,
    newsSources: report.news.sources.map(({ id, status, error }) => ({ id, status, error })), errors: [...report.errors, ...report.news.errors] }));
  if (report.status !== "OK" || report.news.status !== "OK") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: "FAILED", error: error.message }));
  process.exitCode = 1;
}
