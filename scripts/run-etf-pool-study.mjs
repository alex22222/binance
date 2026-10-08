import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { alignDailySeries, backtestEtfRotation, parseYahooAdjustedDailyChart } from "../src/us-etf-rotation-backtest.mjs";
import { runStudy, spliceDefensive } from "./etf-pool-study.mjs";

const root = resolve(import.meta.dirname, "..");
const inputDirectory = process.argv[2];
if (!inputDirectory) throw new Error("Usage: node scripts/run-etf-pool-study.mjs <original-scratchpad-directory>");
const source = resolve(inputDirectory);
const sha = value => createHash("sha256").update(value).digest("hex");
const tickers = ["QQQ", "VTI", "VTV", "SPY", "SGOV", "BIL"];
const specification = {
  schemaVersion: 1, dataCutoff: "2026-09-30", evidenceLevel: "HISTORICAL_PROXY", automaticTradingEligible: false,
  pools: { current: ["QQQ", "VTI", "VTV", "SPY"], reduced: ["QQQ", "SPY"], spy: ["SPY"] },
  rules: [{ frequency: "W", momentumDays: 20 }, ...[63, 126, 252].map(momentumDays => ({ frequency: "M", momentumDays }))],
  costs: [
    { id: "zero", roundTripCostPct: 0, gasPerSideUsd: 0 },
    { id: "allIn035", roundTripCostPct: 0.35, gasPerSideUsd: 0 },
    { id: "allIn045", roundTripCostPct: 0.45, gasPerSideUsd: 0 },
    { id: "allIn100", roundTripCostPct: 1, gasPerSideUsd: 0 },
    { id: "spread015_fixedGas005", roundTripCostPct: 0.15, gasPerSideUsd: 0.05 }
  ],
  initialCapitalUsd: 50, sizing: "reinvest-all; separate fixed 50 USD ticket-cap diagnostic",
  stop: "All held assets: cost-adjusted closing liquidation proxy <= -8%; exit at NEXT open; block reentry for that decision period",
  timing: "Prior completed daily close; first observed session of calendar week/month; no partial-day signal",
  defensiveLookback: "same as risk lookback for each research variant; current weekly remains 20",
  warmup: "Real BIL returns only before SGOV; no synthetic pre-inception history; shared 252-session warmup",
  terminal: "Marked open position; no forced end-date liquidation; benchmarks use same convention",
  fixedPeriods: ["common", "since2020", "year2022", "since2023"],
  selection: "No winner selected; all matrix cells retained, already-seen history is not independent forward evidence"
};
await mkdir(join(root, "artifacts"), { recursive: true });
const output = await mkdtemp(join(root, "artifacts/etf-pool-audit-2026-10-04-"));
await mkdir(join(output, "data"));
await mkdir(join(output, "original"));
await mkdir(join(output, "runs"));
const save = (path, value) => writeFile(join(output, path), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
// Freeze the research specification before evaluating any matrix results.
await save("specification.json", specification);
console.log("OUTPUT=" + output);
const provenance = [], series = {};
for (const ticker of tickers) {
  const file = join(source, "yh", ticker + ".json");
  const raw = await readFile(file);
  await writeFile(join(output, "data", ticker + ".json"), raw, { flag: "wx" });
  const parsed = JSON.parse(raw).chart?.result?.[0];
  const bars = parseYahooAdjustedDailyChart(parsed).filter(row => row.date <= specification.dataCutoff);
  assert.ok(bars.length > 252, "Insufficient cached daily data: " + ticker);
  assert.equal(new Set(bars.map(row => row.date)).size, bars.length, "Duplicate sessions");
  assert.equal(bars.at(-1).date, specification.dataCutoff, "Missing frozen cutoff");
  series[ticker] = bars;
  provenance.push({ ticker, sha256: sha(raw), source: "Recovered Yahoo chart JSON, not a new download",
    sourceMtime: (await stat(file)).mtime.toISOString(), recoveredAt: new Date().toISOString(),
    collectionTimeVerified: false, firstDate: bars[0].date, lastDate: bars.at(-1).date, rows: bars.length });
}
for (const name of ["bt.py", "runall.py"]) {
  const raw = await readFile(join(source, name));
  await writeFile(join(output, "original", name), raw, { flag: "wx" });
  provenance.push({ file: name, sha256: sha(raw), role: "Original research retained unchanged" });
}
const codeHashes = {};
for (const name of ["scripts/etf-pool-study.mjs", "scripts/run-etf-pool-study.mjs", "src/us-etf-rotation-backtest.mjs", "src/weekly-etf-rotation-paper.mjs"]) {
  codeHashes[name] = sha(await readFile(join(root, name)));
}
await save("manifest.json", { specificationHash: sha(JSON.stringify(specification)), codeHashes, provenance });

// Reproduce the repository's old baseline on its ORIGINAL snapshot, not revised Yahoo data.
const oldDirectory = join(root, "artifacts/us-etf-rotation-binance-2026-09-18");
const oldSeries = {}, oldHashes = {};
for (const ticker of tickers.filter(ticker => ticker !== "BIL")) {
  const raw = await readFile(join(oldDirectory, "data", ticker + ".json"));
  oldHashes[ticker] = sha(raw);
  oldSeries[ticker] = parseYahooAdjustedDailyChart(JSON.parse(raw).chart.result[0]);
}
const oldRows = alignDailySeries(oldSeries, tickers.filter(ticker => ticker !== "BIL"));
const oldResult = backtestEtfRotation({ rows: oldRows, riskTickers: specification.pools.current, defensiveTicker: "SGOV" });
const oldSummary = JSON.parse(await readFile(join(oldDirectory, "summary.json")));
for (const key of ["cagrPct", "maxDrawdownPct", "sharpeZeroRf", "actualSwitches"]) {
  assert.ok(Math.abs(oldResult.metrics[key] - oldSummary.scenarios.base5BpsPerSide[key]) < 1e-10, "Old baseline mismatch: " + key);
}
await save("old-baseline-reproduction.json", { metrics: oldResult.metrics, sourceHashes: oldHashes, matched: true,
  limitation: "This RSI-only baseline is not the current defensive Live strategy" });

// Execute only the inspected original research functions; use frozen JSON, no pickle and no network.
const python = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location("original_bt",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.D=sys.argv[2]
out=[]
for name,risk in [("current",["QQQ","VTI","VTV","SPY"]),("reduced",["QQQ","SPY"]),("spy",["SPY"])]:
 for freq,lookback in [("W",20),("M",63),("M",126),("M",252)]:
  eq,info=m.run(risk=risk,start="2007-07-02",end="2026-09-30",freq=freq,lookback=lookback)
  out.append(dict(pool=name,frequency=freq,momentumDays=lookback,metrics=m.stats(eq),info=info))
print(json.dumps(out,allow_nan=False))`;
console.log("Reproducing original matrix on frozen data...");
const { stdout } = await promisify(execFile)("python3", ["-c", python, join(output, "original/bt.py"), join(output, "data")],
  { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 2 * 1024 * 1024, timeout: 240000 });
await save("original-matrix.json", JSON.parse(stdout));

const spliced = { ...series, SGOV: spliceDefensive(series.SGOV, series.BIL) };
const rows = alignDailySeries(spliced, tickers.filter(ticker => ticker !== "BIL"));
const firstCommon = rows.find((row, index) => index > 252 && row.date.slice(0, 7) !== rows[index - 1].date.slice(0, 7)).date;
const ranges = { common: [firstCommon, specification.dataCutoff], since2020: ["2020-07-01", specification.dataCutoff],
  year2022: ["2022-01-01", "2022-12-31"], since2023: ["2023-01-01", specification.dataCutoff] };
// Independent cash/quantity replay over each day's ledger, including idle cash and all fees.
function reconcile(result, cost) {
  let cash = 50, units = 0, ticker = null, count = 0;
  const market = new Map(rows.map(row => [row.date, row.prices]));
  for (const day of result.equityCurve) {
    for (const trade of result.trades.filter(trade => trade.date === day.date)) {
      assert.equal(trade.price, market.get(day.date)[trade.ticker].open);
      assert.ok(Math.abs(trade.costUsd - trade.notionalUsd * cost.roundTripCostPct / 200 - cost.gasPerSideUsd) < 1e-8);
      assert.ok(Math.abs(trade.quantity * trade.price - (trade.notionalUsd - (trade.side === "BUY" ? trade.costUsd : 0))) < 1e-8);
      if (trade.side === "BUY") { assert.equal(ticker, null); cash -= trade.notionalUsd; units = trade.quantity; ticker = trade.ticker; }
      else { assert.equal(ticker, trade.ticker); assert.equal(units, trade.quantity); cash += trade.notionalUsd - trade.costUsd; units = 0; ticker = null; }
      assert.ok(Math.abs(cash - trade.cashAfterUsd) < 1e-8); count++;
    }
    assert.equal(day.markPrice, ticker ? market.get(day.date)[ticker].close : 0);
    assert.equal(day.holding, ticker || "CASH");
    assert.equal(day.units, units);
    assert.ok(Math.abs(cash + units * day.markPrice - day.equityUsd) < 1e-8);
  }
  assert.equal(count, result.trades.length);
}
const matrix = [];
for (const [periodName, [startDate, endDate]] of Object.entries(ranges)) {
  for (const [pool, risk] of Object.entries(specification.pools)) {
    for (const rule of specification.rules) for (const cost of specification.costs) {
      const id = [periodName, pool, rule.frequency, rule.momentumDays, cost.id].join("-");
      const result = runStudy({ rows, risk, ...rule, ...cost, startDate, endDate });
      reconcile(result, cost);
      await save("runs/" + id + ".json", result);
      matrix.push({ id, period: periodName, pool, ...rule, cost: cost.id, ...result.metrics, ledgerReconciled: true });
    }
  }
}
const benchmarks = [], capped = [];
for (const [periodName, [startDate, endDate]] of Object.entries(ranges)) {
  for (const ticker of ["QQQ", "SPY", "SGOV"]) {
    const result = runStudy({ rows, risk: specification.pools.current, buyHold: ticker, startDate, endDate });
    reconcile(result, specification.costs[1]);
    await save("runs/benchmark-" + periodName + "-" + ticker + ".json", result);
    benchmarks.push({ period: periodName, ticker, roundTripCostPct: 0.35, gasPerSideUsd: 0, ...result.metrics });
  }
  for (const [pool, risk] of Object.entries(specification.pools)) {
    const cost = specification.costs.at(-1);
    const result = runStudy({ rows, risk, ...cost, maxTicketUsd: 50, startDate, endDate });
    reconcile(result, cost);
    await save("runs/capped-" + periodName + "-" + pool + ".json", result);
    capped.push({ period: periodName, pool, ...result.metrics });
  }
}
await save("report.json", { generatedAt: new Date().toISOString(), specification, ranges, matrix, benchmarks, capped,
  originalBaselineReproduced: true, allLedgersReconciled: true,
  livePromotion: "WITHHOLD", independentForwardDecisions: 0,
  limitations: ["Original table contains timing and metric errors; fixed results are a different clearly specified proxy",
    "Daily close/next-open stop cannot replicate Live minute-level executable quotes",
    "No RFQ failure, quote gating, approval, exchange-calendar missing-session validation or intraday liquidity simulation",
    "Proxy BIL before real SGOV; no synthetic history; long-lookback common window does not start in July 2007",
    "Already-seen historical regimes are not independent OOS; no selected winner or automatic Paper/Live promotion",
    "Recovered cached data has hashes but original collection time is unverified",
    "Monthly stop cooldown lasts the decision month: registered research assumption, not existing Live behavior"] });
console.log(JSON.stringify({ output, runs: matrix.length, benchmarks: benchmarks.length, capped: capped.length, ranges,
  baselineMatched: true, allLedgersReconciled: true, livePromotion: "WITHHOLD" }, null, 2));
