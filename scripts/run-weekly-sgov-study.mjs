import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parseYahooAdjustedDailyChart } from "../src/us-etf-rotation-backtest.mjs";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { WEEKLY_SGOV_RULES, runWeeklySgovBacktest, reconcileWeeklySgov } from "./weekly-sgov-study.mjs";

const root = resolve(import.meta.dirname, "..");
const cachedData = process.argv[2] ? resolve(process.argv[2]) : null;
const sha = value => createHash("sha256").update(value).digest("hex");
const specification = {
  schemaVersion: 1, cutoff: "2026-10-22", initialCapitalUsd: 435.32,
  tickers: ["QQQ", "SPY", "SGOV"], rules: WEEKLY_SGOV_RULES, buyDelaySessions: [0, 1, 2, 3],
  observedDelay: { timing: "observedWeekOnly", buyDelayByWeek: { "2026-10-19": 3 }, allOtherWeeks: 0 },
  proportionRoundTripCostsPct: [0.35, 0.8, 1], primaryRoundTripCostPct: 0.8, gasPerSideUsd: 0.05,
  allocation: "Production 50% target, 50% unremunerated cash, <=250U ticket, 20U single-loss budget using 9.3% reserve; SGOV_FULL explicitly invests all capital",
  signal: "QQQ/SPY 20-session momentum >0, Wilder RSI14 >=40, risk ranking; BEAT_SGOV adds strict risk momentum > SGOV momentum; SGOV>0 else CASH",
  signalWindow: "180-calendar-day rolling production fetch window; preserve risk history before SGOV inception for RSI, never synthesize SGOV",
  execution: "Prior completed close; first actual weekly NYSE session sells old holding at open; delay only new BUY by 0-3 actual sessions",
  lossLimit: "Realized daily loss >=2U blocks BUY that session; new week replaces old pending BUY; unchanged target never tops up",
  stop: "8% cost-adjusted daily-close proxy triggers next-open sell and blocks that week; never assumes intraday stop fill",
  terminal: "All holdings liquidated at final daily close, same proportional cost plus fixed Gas",
  periods: {
    common: ["2020-07-06", "2026-10-22"], year2022: ["2022-01-03", "2022-12-30"],
    since2023: ["2023-01-03", "2026-10-22"], lastYear: ["2025-10-27", "2026-10-22"],
    year2026: ["2026-01-05", "2026-10-22"], livePhase: ["2026-09-21", "2026-10-22"],
    recentSelloff: ["2026-10-12", "2026-10-22"]
  },
  evidenceLevel: "HISTORICAL_ADJUSTED_OHLC_PROXY", automaticTradingEligible: false,
  limitations: [
    "Underlying ETF adjusted OHLC includes modeled dividend reinvestment; not historical token quotes/fills or verified token dividend delivery.",
    "No taxes, depeg, token NAV basis, historical RFQ liquidity or holiday/weekend token market reconstruction.",
    "Daily-close stops fill next open and can gap beyond 8%; daily maximum drawdown excludes intraday drawdowns.",
    "Fixed buy delays are sensitivity scenarios, not a claim every historical week suffered the October 19-22 authorization delay.",
    "No intraday FOMC blackout, audits, manual approvals or quote cost/quality gates can be reconstructed from daily bars.",
    "The 2020-2026 history has already been examined; the added gate is motivated by observed losses, not independent out-of-sample discovery.",
    "The recent live-phase panels start flat with equal capital, not the actual 50U legacy QQQ position plus October 9 top-up."
  ]
};
await mkdir(join(root, "artifacts"), { recursive: true });
const output = await mkdtemp(join(root, "artifacts/weekly-sgov-comparison-2026-10-23-"));
await mkdir(join(output, "data")); await mkdir(join(output, "runs"));
const save = (file, value) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
await save("specification.json", specification);
console.log("OUTPUT=" + output);
const codeHashes = {};
const pendingModules = ["scripts/run-weekly-sgov-study.mjs"];
while (pendingModules.length) {
  const file = pendingModules.pop();
  if (codeHashes[file]) continue;
  if (file.startsWith("..")) throw new Error("Research dependency escaped repository");
  const source = await readFile(join(root, file), "utf8");
  codeHashes[file] = sha(source);
  await mkdir(dirname(join(output, "code", file)), { recursive: true });
  await writeFile(join(output, "code", file), source, { flag: "wx" });
  for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
    pendingModules.push(relative(root, resolve(root, dirname(file), match[1])));
  }
}
const downloads = await Promise.all(specification.tickers.map(async ticker => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=1577836800&period2=1792713600&interval=1d&includePrePost=false&events=div%2Csplits`;
  const raw = cachedData ? await readFile(join(cachedData, `${ticker}.json`), "utf8")
    : (await promisify(execFile)("curl", ["-fsSL", "--compressed", "--max-time", "40", "-A", "Mozilla/5.0", url],
      { encoding: "utf8", maxBuffer: 3 * 1024 * 1024 })).stdout;
  const result = JSON.parse(raw).chart?.result?.[0];
  if (!result || result.meta?.symbol !== ticker) throw new Error(`Wrong or missing Yahoo chart: ${ticker}`);
  const bars = parseYahooAdjustedDailyChart(result).filter(row => row.date <= specification.cutoff);
  if (bars.at(-1)?.date !== specification.cutoff || new Set(bars.map(row => row.date)).size !== bars.length) throw new Error(`Incomplete/duplicate history: ${ticker}`);
  const expected = researchTradingDates(bars[0].date, specification.cutoff);
  if (JSON.stringify(expected) !== JSON.stringify(bars.map(row => row.date))) throw new Error(`Missing historical sessions: ${ticker}`);
  await writeFile(join(output, "data", `${ticker}.json`), raw, { flag: "wx" });
  return { ticker, bars, manifest: { ticker, url, collectedAt: new Date().toISOString(), cachedSource: cachedData,
    sha256: sha(raw), firstDate: bars[0].date, lastDate: bars.at(-1).date, rows: bars.length } };
}));
const maps = Object.fromEntries(downloads.map(d => [d.ticker, new Map(d.bars.map(row => [row.date, row]))]));
const rows = downloads.find(d => d.ticker === "QQQ").bars.map(bar => ({ date: bar.date,
  prices: Object.fromEntries(specification.tickers.filter(ticker => maps[ticker].has(bar.date)).map(ticker => [ticker, maps[ticker].get(bar.date)])) }));
await save("manifest.json", { specificationHash: sha(JSON.stringify(specification)), codeHashes,
  data: downloads.map(d => d.manifest), generatedAt: new Date().toISOString() });
const matrix = [];
const timings = [...specification.buyDelaySessions.map(buyDelaySessions => ({ timing: "fixed", buyDelaySessions, buyDelayByWeek: {} })),
  { timing: "observedWeekOnly", buyDelaySessions: 0, buyDelayByWeek: specification.observedDelay.buyDelayByWeek }];
for (const [period, [startDate, endDate]] of Object.entries(specification.periods)) {
  for (const roundTripCostPct of specification.proportionRoundTripCostsPct) {
    for (const { timing, buyDelaySessions, buyDelayByWeek } of timings) for (const rule of specification.rules) {
      const result = runWeeklySgovBacktest({ rows, rule, startDate, endDate, roundTripCostPct, buyDelaySessions,
        buyDelayByWeek, initialCapitalUsd: specification.initialCapitalUsd, gasPerSideUsd: specification.gasPerSideUsd });
      reconcileWeeklySgov(result, rows);
      const id = `${period}-${rule}-cost${roundTripCostPct}-${timing === "fixed" ? `lag${buyDelaySessions}` : "observedWeekOnly"}`;
      await save(`runs/${id}.json`, result);
      matrix.push({ id, period, rule, timing, roundTripCostPct, buyDelaySessions, ...result.metrics, reconciled: true });
    }
  }
  console.log(`Completed ${period}`);
}
const comparisons = [];
for (const current of matrix.filter(row => row.rule === "CURRENT")) {
  const match = rule => matrix.find(row => row.period === current.period && row.roundTripCostPct === current.roundTripCostPct
    && row.timing === current.timing && row.buyDelaySessions === current.buyDelaySessions && row.rule === rule);
  const filtered = match("BEAT_SGOV"), defensive = match("SGOV_HOLD"), full = match("SGOV_FULL");
  comparisons.push({ period: current.period, timing: current.timing, roundTripCostPct: current.roundTripCostPct, buyDelaySessions: current.buyDelaySessions,
    currentMinusSgovUsd: current.netPnlUsd - defensive.netPnlUsd,
    filteredMinusSgovUsd: filtered.netPnlUsd - defensive.netPnlUsd,
    filteredMinusCurrentUsd: filtered.netPnlUsd - current.netPnlUsd,
    bestReturnRule: [current, filtered, defensive, full].sort((a, b) => b.totalReturnPct - a.totalReturnPct)[0].rule,
    lowestDrawdownRule: [current, filtered, defensive, full].sort((a, b) => a.maxDrawdownPct - b.maxDrawdownPct)[0].rule });
}
const primary = matrix.filter(row => row.roundTripCostPct === specification.primaryRoundTripCostPct);
await save("summary.json", { specification, matrix, comparisons });
const columns = ["period", "rule", "timing", "roundTripCostPct", "buyDelaySessions", "startDate", "endDate", "netPnlUsd", "totalReturnPct", "cagrPct", "maxDrawdownPct", "totalCostUsd", "switches", "stops", "lossCapBlocks"];
await writeFile(join(output, "matrix.csv"), columns.join(",") + "\n" + matrix.map(row => columns.map(key => row[key]).join(",")).join("\n") + "\n", { flag: "wx" });
const n = value => Number.isFinite(value) ? value.toFixed(3) : "—";
const report = ["# 周频ETF与SGOV比较", "", `截止 ${specification.cutoff}，初始资金 ${specification.initialCapitalUsd} USDT；比例往返成本0.8%加每边0.05 USDT Gas。`, "",
  "| 区间 | 规则 | 买入延迟交易日 | 净盈亏 USDT | 总收益% | 年化% | 最大回撤% | 成本 USDT | 换仓 | 止损 |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...primary.map(row => `| ${row.period} | ${row.rule} | ${row.timing === "fixed" ? row.buyDelaySessions : "仅10/19周3日"} | ${n(row.netPnlUsd)} | ${n(row.totalReturnPct)} | ${row.tradingDays >= 200 ? n(row.cagrPct) : "短期不展示"} | ${n(row.maxDrawdownPct)} | ${n(row.totalCostUsd)} | ${row.switches} | ${row.stops} |`),
  "", "## 限制", "", ...specification.limitations.map(text => "- " + text), "", "全部成本敏感性、逐笔账目、曲线与来源SHA256见同目录文件。"];
await writeFile(join(output, "report.md"), report.join("\n") + "\n", { flag: "wx" });
console.log(JSON.stringify({ output, runs: matrix.length, summary: join(output, "summary.json"), report: join(output, "report.md") }, null, 2));
