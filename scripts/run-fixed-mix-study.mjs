// Offline research runner for docs/2026-10-26-fixed-mix-spy-sgov.md. Reuses the
// 2026-10-23 raw Yahoo files (checked against that run's manifest), freezes the
// specification and code before computing, and reconciles every run.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseYahooAdjustedDailyChart } from "../src/us-etf-rotation-backtest.mjs";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { FIXED_MIX_RULES, runFixedMixBacktest, reconcileFixedMix } from "./fixed-mix-study.mjs";

const root = resolve(import.meta.dirname, "..");
const frozenRun = resolve(root, process.argv[2] || "artifacts/weekly-sgov-comparison-2026-10-23-VhcHex");
const sha = value => createHash("sha256").update(value).digest("hex");
const specification = {
  schemaVersion: 1, frozenOn: "2026-10-26", cutoff: "2026-10-22", initialCapitalUsd: 435.32,
  tickers: ["SPY", "SGOV"], dataSource: relative(root, frozenRun), rules: FIXED_MIX_RULES,
  proportionRoundTripCostsPct: [0.35, 0.8, 1], primaryRoundTripCostPct: 0.8, gasPerSideUsd: 0.05,
  sizing: "Fully invested at the target split from the first session's open; budget per asset = weight x (capital - orders x Gas)",
  rebalance: "First NYSE session of each month: SPY weight on the prior close; if drift exceeds the band, sell the overweight excess at the open, then buy the underweight asset with all cash; no trade if the open no longer shows an excess",
  stop: "None; drawdowns are reported", delay: "None; only the first entry would be affected",
  periods: {
    common2021: ["2021-07-01", "2026-10-22"], year2022: ["2022-01-03", "2022-12-30"],
    since2023: ["2023-01-03", "2026-10-22"], lastYear: ["2025-10-27", "2026-10-22"],
    year2026: ["2026-01-05", "2026-10-22"], livePhase: ["2026-09-21", "2026-10-22"],
    recentSelloff: ["2026-10-12", "2026-10-22"]
  },
  evidenceLevel: "HISTORICAL_ADJUSTED_OHLC_PROXY", automaticTradingEligible: false
};

const frozenManifest = JSON.parse(await readFile(join(frozenRun, "manifest.json"), "utf8"));
const output = await mkdtemp(join(root, "artifacts/fixed-mix-comparison-2026-10-26-"));
await mkdir(join(output, "runs"));
const save = (file, value) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
await save("specification.json", specification);
const codeHashes = {};
const pending = ["scripts/run-fixed-mix-study.mjs"];
while (pending.length) {
  const file = pending.pop();
  if (codeHashes[file]) continue;
  if (file.startsWith("..")) throw new Error("Research dependency escaped repository");
  const source = await readFile(join(root, file), "utf8");
  codeHashes[file] = sha(source);
  await mkdir(dirname(join(output, "code", file)), { recursive: true });
  await writeFile(join(output, "code", file), source, { flag: "wx" });
  for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) pending.push(relative(root, resolve(root, dirname(file), match[1])));
}
const data = await Promise.all(specification.tickers.map(async ticker => {
  const raw = await readFile(join(frozenRun, "data", `${ticker}.json`), "utf8");
  const recorded = frozenManifest.data.find(row => row.ticker === ticker);
  if (!recorded || recorded.sha256 !== sha(raw)) throw new Error(`Raw data differs from the frozen 2026-10-23 manifest: ${ticker}`);
  const bars = parseYahooAdjustedDailyChart(JSON.parse(raw).chart.result[0]).filter(row => row.date <= specification.cutoff);
  if (JSON.stringify(researchTradingDates(bars[0].date, specification.cutoff)) !== JSON.stringify(bars.map(row => row.date))) throw new Error(`Missing sessions: ${ticker}`);
  return { ticker, bars, manifest: { ticker, sha256: recorded.sha256, firstDate: bars[0].date, lastDate: bars.at(-1).date, rows: bars.length } };
}));
await save("manifest.json", { specificationHash: sha(JSON.stringify(specification)), codeHashes, data: data.map(d => d.manifest), generatedAt: new Date().toISOString() });
console.log("FROZEN " + output);

const sgov = new Map(data.find(d => d.ticker === "SGOV").bars.map(row => [row.date, row]));
const rows = data.find(d => d.ticker === "SPY").bars.filter(bar => sgov.has(bar.date))
  .map(bar => ({ date: bar.date, prices: { SPY: bar, SGOV: sgov.get(bar.date) } }));
const matrix = [];
for (const [period, [startDate, endDate]] of Object.entries(specification.periods)) {
  for (const roundTripCostPct of specification.proportionRoundTripCostsPct) for (const rule of Object.keys(FIXED_MIX_RULES)) {
    const result = runFixedMixBacktest({ rows, rule, startDate, endDate, roundTripCostPct,
      initialCapitalUsd: specification.initialCapitalUsd, gasPerSideUsd: specification.gasPerSideUsd });
    reconcileFixedMix(result, rows);
    const id = `${period}-${rule}-cost${roundTripCostPct}`;
    await save(`runs/${id}.json`, result);
    matrix.push({ id, period, rule, roundTripCostPct, spyPct: result.spyPct, bandPct: result.bandPct, ...result.metrics, reconciled: true });
  }
  console.log(`Completed ${period}`);
}
await save("summary.json", { specification, matrix });
const columns = ["period", "rule", "roundTripCostPct", "spyPct", "bandPct", "startDate", "endDate", "netPnlUsd", "totalReturnPct", "cagrPct", "maxDrawdownPct", "annualVolatilityPct", "sharpeZeroRf", "totalCostUsd", "rebalances", "endingSpyWeightPct"];
await writeFile(join(output, "matrix.csv"), columns.join(",") + "\n" + matrix.map(row => columns.map(key => row[key] ?? "").join(",")).join("\n") + "\n", { flag: "wx" });
console.log(JSON.stringify({ output, runs: matrix.length }));
