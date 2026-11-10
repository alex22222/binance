// Offline research runner for docs/2026-10-26-monthly-dual-momentum-sgov.md.
// Reuses the 2026-10-23 raw Yahoo files (checked against that run's manifest),
// runs CURRENT and the SGOV benchmarks on the frozen weekly engine and the four
// frozen monthly rules on the parity-tested engine, and reconciles every run.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseYahooAdjustedDailyChart } from "../src/us-etf-rotation-backtest.mjs";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { runWeeklySgovBacktest, reconcileWeeklySgov } from "./weekly-sgov-study.mjs";
import { MONTHLY_RULES, runMonthlyBacktest } from "./monthly-sgov-study.mjs";

const root = resolve(import.meta.dirname, "..");
const frozenRun = resolve(root, process.argv[2] || "artifacts/weekly-sgov-comparison-2026-10-23-VhcHex");
const sha = value => createHash("sha256").update(value).digest("hex");
const specification = {
  schemaVersion: 1, frozenOn: "2026-10-26", cutoff: "2026-10-22", initialCapitalUsd: 435.32,
  tickers: ["QQQ", "SPY", "SGOV"], dataSource: relative(root, frozenRun),
  rules: { weeklyEngine: ["CURRENT", "SGOV_HOLD", "SGOV_FULL"], monthlyEngine: MONTHLY_RULES },
  buyDelaySessions: [0, 1, 2, 3], observedDelay: { "2026-10-19": 3 },
  proportionRoundTripCostsPct: [0.35, 0.8, 1], primaryRoundTripCostPct: 0.8, gasPerSideUsd: 0.05,
  monthlySignal: "First NYSE session of each month; momentum = prior close / close lookback+1 sessions earlier - 1; excess = stock - SGOV; enter best stock if excess > band; keep held stock while excess > -band; switch stocks only if the other leads by > band; else SGOV if SGOV momentum > 0, else CASH; no RSI",
  periods: {
    common2021: ["2021-07-01", "2026-10-22"], year2022: ["2022-01-03", "2022-12-30"],
    since2023: ["2023-01-03", "2026-10-22"], lastYear: ["2025-10-27", "2026-10-22"],
    year2026: ["2026-01-05", "2026-10-22"], livePhase: ["2026-09-21", "2026-10-22"],
    recentSelloff: ["2026-10-12", "2026-10-22"]
  },
  evidenceLevel: "HISTORICAL_ADJUSTED_OHLC_PROXY", automaticTradingEligible: false,
  limitations: [
    "2021-2026 has been examined before; the grid uses classic 6/12-month windows and one fixed band chosen before results, not independent out-of-sample discovery.",
    "Underlying ETF adjusted OHLC with modeled dividend reinvestment; not historical token quotes, fills or verified token dividends.",
    "No taxes, depeg, token NAV basis, historical RFQ liquidity or weekend token market reconstruction.",
    "Monthly rules make at most one or two decisions in the short periods; conclusions rest on the long periods."
  ]
};

// Freeze before computing anything: specification, every code dependency, and the raw data hashes.
const frozenManifest = JSON.parse(await readFile(join(frozenRun, "manifest.json"), "utf8"));
const output = await mkdtemp(join(root, "artifacts/monthly-sgov-comparison-2026-10-26-"));
await mkdir(join(output, "runs"));
const save = (file, value) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
await save("specification.json", specification);
const codeHashes = {};
const pending = ["scripts/run-monthly-sgov-study.mjs"];
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
  const result = JSON.parse(raw).chart?.result?.[0];
  if (result?.meta?.symbol !== ticker) throw new Error(`Wrong Yahoo chart: ${ticker}`);
  const bars = parseYahooAdjustedDailyChart(result).filter(row => row.date <= specification.cutoff);
  const expected = researchTradingDates(bars[0].date, specification.cutoff);
  if (JSON.stringify(expected) !== JSON.stringify(bars.map(row => row.date))) throw new Error(`Missing historical sessions: ${ticker}`);
  return { ticker, bars, manifest: { ticker, sha256: recorded.sha256, firstDate: bars[0].date, lastDate: bars.at(-1).date, rows: bars.length } };
}));
await save("manifest.json", { specificationHash: sha(JSON.stringify(specification)), codeHashes, data: data.map(d => d.manifest),
  frozenSourceManifestHash: sha(JSON.stringify(frozenManifest)), generatedAt: new Date().toISOString() });
console.log("FROZEN " + output);

const maps = Object.fromEntries(data.map(d => [d.ticker, new Map(d.bars.map(row => [row.date, row]))]));
const rows = data.find(d => d.ticker === "QQQ").bars.map(bar => ({ date: bar.date,
  prices: Object.fromEntries(specification.tickers.filter(ticker => maps[ticker].has(bar.date)).map(ticker => [ticker, maps[ticker].get(bar.date)])) }));
const timings = [...specification.buyDelaySessions.map(lag => ({ timing: "fixed", buyDelaySessions: lag, buyDelayByWeek: {} })),
  { timing: "observedWeekOnly", buyDelaySessions: 0, buyDelayByWeek: specification.observedDelay }];
const allRules = [...specification.rules.weeklyEngine, ...Object.keys(MONTHLY_RULES)];
const matrix = [];
for (const [period, [startDate, endDate]] of Object.entries(specification.periods)) {
  for (const roundTripCostPct of specification.proportionRoundTripCostsPct) {
    for (const { timing, buyDelaySessions, buyDelayByWeek } of timings) for (const rule of allRules) {
      const options = { rows, rule, startDate, endDate, roundTripCostPct, buyDelaySessions, buyDelayByWeek,
        initialCapitalUsd: specification.initialCapitalUsd, gasPerSideUsd: specification.gasPerSideUsd };
      const result = MONTHLY_RULES[rule] ? runMonthlyBacktest(options) : runWeeklySgovBacktest(options);
      reconcileWeeklySgov(result, rows);
      const id = `${period}-${rule}-cost${roundTripCostPct}-${timing === "fixed" ? `lag${buyDelaySessions}` : "observedWeekOnly"}`;
      await save(`runs/${id}.json`, result);
      matrix.push({ id, period, rule, timing, roundTripCostPct, buyDelaySessions, ...result.metrics,
        decisions: result.decisions.length, reconciled: true });
    }
  }
  console.log(`Completed ${period}`);
}
const comparisons = matrix.filter(row => row.rule !== "SGOV_HOLD").map(row => {
  const sgov = matrix.find(other => other.rule === "SGOV_HOLD" && other.period === row.period && other.roundTripCostPct === row.roundTripCostPct
    && other.timing === row.timing && other.buyDelaySessions === row.buyDelaySessions);
  return { id: row.id, period: row.period, rule: row.rule, timing: row.timing, roundTripCostPct: row.roundTripCostPct, buyDelaySessions: row.buyDelaySessions,
    minusSgovHoldUsd: row.netPnlUsd - sgov.netPnlUsd, minusSgovHoldDrawdownPct: row.maxDrawdownPct - sgov.maxDrawdownPct };
});
await save("summary.json", { specification, matrix, comparisons });
const columns = ["period", "rule", "timing", "roundTripCostPct", "buyDelaySessions", "startDate", "endDate", "netPnlUsd", "totalReturnPct", "cagrPct", "maxDrawdownPct", "totalCostUsd", "switches", "stops", "decisions", "stockDays"];
await writeFile(join(output, "matrix.csv"), columns.join(",") + "\n" + matrix.map(row => columns.map(key => row[key] ?? "").join(",")).join("\n") + "\n", { flag: "wx" });
console.log(JSON.stringify({ output, runs: matrix.length }));
