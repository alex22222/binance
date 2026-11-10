import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beijingDate, buildStrategyDaily, readStrategyDaily, saveStrategyDaily } from "../src/strategy-daily.mjs";
import { loadStrategyResearch } from "../src/strategy-research.mjs";

// Reads saved evidence only. No network, wallet, Paper runner or trading calls.
export async function recordStrategyDaily({ projectRoot = resolve(import.meta.dirname, ".."),
  configPath = resolve(projectRoot, process.env.BOT_CONFIG || "config.json"), nowMs = Date.now() } = {}) {
  const directory = resolve(projectRoot, "state/strategy-daily");
  const date = beijingDate(new Date(nowMs).toISOString());
  // An existing damaged day is an error, not permission to overwrite history.
  try {
    await readFile(resolve(directory, date + ".json"), "utf8");
    const existing = await readStrategyDaily(directory, { limit: 1 });
    if (existing.errors.length) throw new Error("Daily journal integrity check failed");
    if (existing.records.some(row => row.date === date)) return { created: false, date };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const history = await readStrategyDaily(directory, { limit: 2 });
  if (history.errors.length) throw new Error("Daily baseline integrity check failed");
  const report = await loadStrategyResearch({ projectRoot, configPath, nowMs,
    ledgerPath: resolve(directory, "trade-ledger.json") });
  const snapshot = buildStrategyDaily(report, history.records[0]);
  return { ...await saveStrategyDaily(directory, snapshot), strategies: snapshot.strategies.length,
    scoredSources: snapshot.strategies.reduce((sum, row) => sum + Object.values(row.sources).filter(s => s.score.total !== null).length, 0),
    automaticTradingEligible: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const projectRoot = resolve(import.meta.dirname, "..");
  if (process.argv.includes("--status")) {
    const result = await readStrategyDaily(resolve(projectRoot, "state/strategy-daily"));
    console.log(JSON.stringify({ status: result.status, days: result.records.length, latestDate: result.records[0]?.date || null, errors: result.errors }));
    process.exitCode = result.status === "ERROR" ? 1 : 0;
  } else console.log(JSON.stringify(await recordStrategyDaily({ projectRoot })));
}
