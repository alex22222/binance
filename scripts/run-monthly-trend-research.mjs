import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { collectMonthlyResearchData } from "../src/monthly-research-data.mjs";
import { buildMonthlyResearchReport, researchHash } from "../src/monthly-trend-research.mjs";

const codeFiles = ["src/monthly-trend-research.mjs", "src/monthly-research-data.mjs", "scripts/run-monthly-trend-research.mjs",
  "src/us-etf-rotation-backtest.mjs", "src/weekly-etf-rotation-paper.mjs", "src/weekly-research-calendar.mjs",
  "src/weekly-research-data.mjs", "src/strategy-data.mjs", "src/strategy.mjs"];
async function readCodeHashes() {
  return Object.fromEntries(await Promise.all(codeFiles.map(async (file) => [file,
    researchHash(await readFile(resolve(import.meta.dirname, "..", file), "utf8"))
  ])));
}
const loadedCodeHashes = await readCodeHashes();

function number(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "未知";
}

export function monthlyResearchMarkdown(report) {
  const lines = ["# 月度 VTI／SGOV 趋势研究", "", `生成：${report.generatedAt}。证据：HISTORICAL_PROXY；实盘授权：否。`, "",
    "A1 为预先固定的主规则，A2 是对照；不会按回测结果自动择优或替换现有实盘。", ""];
  if (!report.periods) {
    lines.push(`结论：证据不足，${report.status}；未生成收益。`, "");
    for (const source of report.dataSources || []) lines.push(`- ${source.ticker}：${source.status}；缺失交易日 ${source.quality?.missingDates?.length ?? "未知"}。`);
    return `${lines.join("\n")}\n`;
  }
  if (report.coverageBlockers.length) lines.push(`历史覆盖不足：${report.coverageBlockers.join("、")}。`, "");
  lines.push(`结论：A1 ${report.verdicts.A1}；A2 ${report.verdicts.A2}。`, "",
    "往返成本为全包百分比假设（0.35%、0.45%、1%），不是实测报价。每边扣一半，期末计入假设平仓成本；净值以 50 USD 起算。", "",
    "| 区间 | 往返成本 | 策略 | 年化净收益 | 最大回撤 | 最差日 | 换仓 | 成本 USD |", "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [periodId, period] of Object.entries(report.periods)) {
    for (const scenario of period.scenarios) {
      for (const [strategy, result] of Object.entries(scenario.results)) {
        const m = result.metrics;
        lines.push(`| ${periodId} ${m.startDate}～${m.endDate} | ${scenario.roundTripCostPct}% | ${strategy} | ${number(m.cagrPct)}% | ${number(m.maxDrawdownPct)}% | ${number(m.worstDayPct)}% | ${m.switches} | ${number(m.totalCostUsd)} |`);
      }
    }
  }
  lines.push("", "## 数据与证据边界", "");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push("", "前向独立月末样本：0；本报告未取得代币成交或报价证据。回测通过仅表示可进一步研究，不自动开启 Paper 或 Live。", "",
    `规则 SHA-256：${report.specificationHash}`, `输入 SHA-256：${report.inputHash}`, "",
    "原始数据、来源清单、代码哈希、逐笔代理交易与拒绝记录随此运行归档。已有失败运行不会被后续成功覆盖。");
  return `${lines.join("\n")}\n`;
}

export async function runMonthlyTrendResearch({
  directory = resolve(import.meta.dirname, "../state/research/monthly-trend"),
  ...options
} = {}) {
  if (researchHash(await readCodeHashes()) !== researchHash(loadedCodeHashes)) throw new Error("CODE_CHANGED_SINCE_MODULE_LOAD; restart research process");
  const data = await collectMonthlyResearchData(options);
  const endingCodeHashes = await readCodeHashes();
  const codeChanged = researchHash(endingCodeHashes) !== researchHash(loadedCodeHashes);
  const runId = `${data.collectedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(directory, runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(runDirectory, "raw"), { mode: 0o700 });
  const codeHashes = loadedCodeHashes;
  for (const [ticker, text] of Object.entries(data.raw)) {
    await writeFile(join(runDirectory, "raw", `${ticker}.json`), text, { flag: "wx", mode: 0o600 });
  }
  const { raw, ...bundle } = data;
  await writeFile(join(runDirectory, "data.json"), `${JSON.stringify({ ...bundle, codeHashes }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  let report;
  try {
    report = codeChanged
      ? { generatedAt: data.collectedAt, status: "CODE_CHANGED_DURING_RUN", endingCodeHashes, automaticTradingEligible: false }
      : data.status === "AVAILABLE"
      ? buildMonthlyResearchReport({ rows: data.rows, generatedAt: data.collectedAt })
      : { generatedAt: data.collectedAt, status: "DATA_QUALITY_BLOCKED", automaticTradingEligible: false };
  } catch (error) {
    report = { generatedAt: data.collectedAt, status: "RESEARCH_BLOCKED", reason: error.message, automaticTradingEligible: false };
  }
  report = { ...report, runId, cutoff: data.cutoff, codeHashes, dataSources: data.sources };
  await writeFile(join(runDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(join(runDirectory, "report.md"), monthlyResearchMarkdown(report), { flag: "wx", mode: 0o600 });
  return { runDirectory, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node scripts/run-monthly-trend-research.mjs [--input-dir raw-directory] [--as-of YYYY-MM-DD]\nIndependent one-shot historical research only. No wallet, scheduling or Live changes.");
  } else {
    const allowed = new Set(["--input-dir", "--as-of"]);
    for (let index = 0; index < args.length; index += 2) {
      if (!allowed.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Unknown or incomplete research argument");
    }
    const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const result = await runMonthlyTrendResearch({ inputDirectory: arg("--input-dir"), cutoff: arg("--as-of") });
    console.log(JSON.stringify({ directory: result.runDirectory, status: result.report.status || result.report.verdicts, liveAuthorized: false }, null, 2));
    if (!result.report.periods) process.exitCode = 1;
  }
}
