// Offline diagnostic: reuse the frozen 2026-09-30 data, never a production runner.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FREQUENCY_PAPER_SPEC, frequencyHash } from "../src/etf-frequency-paper.mjs";
import { alignDailySeries, parseYahooAdjustedDailyChart } from "../src/us-etf-rotation-backtest.mjs";
import { runStudy, spliceDefensive } from "./etf-pool-study.mjs";

export function liquidationStudyMetrics(result, cost) {
  const curve = result.equityCurve.map(day => ({ date: day.date, equityUsdt: day.equityUsd - (day.holding === "CASH" ? 0 : day.units * day.markPrice * cost.roundTripSpreadPct / 200 + cost.gasPerSideUsdt) }));
  let peak = 50, drawdown = 0;
  for (const day of curve) { peak = Math.max(peak, day.equityUsdt); drawdown = Math.max(drawdown, (1 - day.equityUsdt / peak) * 100); }
  const years = (Date.parse(curve.at(-1).date) - Date.parse(curve[0].date)) / (365.2425 * 86400000);
  return { ...result.metrics, liquidationEndingEquityUsdt: curve.at(-1).equityUsdt,
    liquidationCagrPct: ((curve.at(-1).equityUsdt / 50) ** (1 / years) - 1) * 100,
    liquidationMaxDrawdownPct: drawdown, valuationBasis: FREQUENCY_PAPER_SPEC.valuationBasis };
}

export async function runFrequencyStudy({ inputDirectory = resolve(import.meta.dirname, "../artifacts/etf-pool-audit-2026-10-04-kp3E4t/data"), outputRoot = resolve(import.meta.dirname, "../artifacts") } = {}) {
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(join(outputRoot, "etf-frequency-2026-10-09-"));
  const save = (file, value) => writeFile(join(directory, file), JSON.stringify(value) + "\n", { flag: "wx" });
  const specification = { ...FREQUENCY_PAPER_SPEC, cutoff: "2026-09-30", evidenceLevel: "HISTORICAL_PROXY",
    signalTiming: "previous completed daily close / next first-period session open",
    stopTiming: "net closing-liquidation -8%; next open exit; rest of decision period in cash",
    selection: "All cells retained, no winner selected, not independent forward or Live qualification" };
  await save("specification.json", specification);
  const series = {}, sources = [];
  for (const ticker of ["QQQ", "SPY", "SGOV", "BIL"]) {
    const raw = await readFile(join(inputDirectory, ticker + ".json"));
    series[ticker] = parseYahooAdjustedDailyChart(JSON.parse(raw).chart.result[0]).filter(row => row.date <= specification.cutoff);
    assert.equal(series[ticker].at(-1).date, specification.cutoff);
    sources.push({ ticker, path: join(inputDirectory, ticker + ".json"), hash: frequencyHash(raw.toString()), collectionTimeVerified: false });
  }
  const rows = alignDailySeries({ ...series, SGOV: spliceDefensive(series.SGOV, series.BIL) }, ["QQQ", "SPY", "SGOV"]);
  const first = rows.find((row, i) => i > 252 && row.date.slice(0, 7) !== rows[i - 1].date.slice(0, 7)).date;
  const ranges = { common: [first, specification.cutoff], since2020: ["2020-07-01", specification.cutoff], year2022: ["2022-01-01", "2022-12-31"], since2023: ["2023-01-01", specification.cutoff] };
  const codeHashes = Object.fromEntries(await Promise.all(["scripts/run-etf-frequency-study.mjs", "scripts/etf-pool-study.mjs", "src/etf-frequency-paper.mjs", "src/us-etf-rotation-backtest.mjs"].map(async file => [file, frequencyHash((await readFile(resolve(import.meta.dirname, "..", file))).toString())])));
  await save("manifest.json", { frozenAt: new Date().toISOString(), specificationHash: frequencyHash(specification), sources, codeHashes });
  await mkdir(join(directory, "runs"));
  const matrix = [];
  for (const [range, [startDate, endDate]] of Object.entries(ranges)) {
    for (const cost of specification.costs) {
      for (const frequency of ["W", "M", "H"]) {
        for (const momentumDays of frequency === "H" ? [20] : specification.momentumDays) {
          const id = `${range}-${frequency}-${momentumDays}-${cost.id}`;
          const result = runStudy({ rows, risk: ["QQQ", "SPY"], startDate, endDate, frequency: frequency === "H" ? "W" : frequency,
            momentumDays, roundTripCostPct: cost.roundTripSpreadPct, gasPerSideUsd: cost.gasPerSideUsdt, buyHold: frequency === "H" ? "SPY" : null });
          // Fee and daily balance identities are independently checked, not assumed.
          for (const trade of result.trades) assert.ok(Math.abs(trade.costUsd - trade.notionalUsd * cost.roundTripSpreadPct / 200 - cost.gasPerSideUsdt) < 1e-9);
          for (const day of result.equityCurve) assert.ok(Math.abs(day.cashUsd + day.units * day.markPrice - day.equityUsd) < 1e-9);
          await save(`runs/${id}.json`, result);
          matrix.push({ id, range, frequency, momentumDays: frequency === "H" ? null : momentumDays, cost: cost.id, ...liquidationStudyMetrics(result, cost) });
        }
      }
    }
  }
  const report = { generatedAt: new Date().toISOString(), status: "HISTORICAL_DIAGNOSTIC_ONLY", specification, ranges, matrix,
    automaticTradingEligible: false, independentForwardMonths: 0,
    limitations: ["Already-seen history, not independent OOS", "BIL before SGOV inception", "Original collection time unverified",
      "Daily next-open stop proxy differs from 15-minute Paper and 60-second Live checks", "No executable quote, liquidity, RFQ failure or company-action veto replay", "No selected winner"] };
  await save("report.json", report);
  return { directory, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { directory, report } = await runFrequencyStudy();
  console.log(JSON.stringify({ directory, cells: report.matrix.length, automaticTradingEligible: false }));
}
