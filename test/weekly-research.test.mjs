import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backtestResearchRule, evaluateCandidate, evidenceGates, hashResearch, RESEARCH_AXES, researchProposalSpec, validateDailyHistory, validateWeeklyAnalysis } from "../src/weekly-research.mjs";
import { collectWeeklyResearch, filterPredictionMarkets, parseFredCsv, parseResearchFeed } from "../src/weekly-research-data.mjs";
import { finalizeWeeklyReport, loadWeeklyBundle, saveWeeklyBundle, weeklyAnalysisTemplate, weeklyReportStatus, weeklyRunId } from "../src/weekly-research-store.mjs";
import { weeklyResearchHtml } from "../src/weekly-research-html.mjs";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";

const now = Date.parse("2026-09-13T02:00:00Z");
const bars = Array.from({ length: 900 }, (_, i) => ({ date: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: 100 + i / 5 + 8 * Math.sin(i / 11), close: 100 + i / 5 + 8 * Math.sin(i / 11) }));
const dates = bars.map((bar) => bar.date);

test("research calendar covers historical years and exchange-specific exceptions", () => {
  assert.equal(researchTradingDates("2020-01-01", "2020-12-31").length, 253);
  assert.equal(researchTradingDates("2021-01-01", "2021-12-31").length, 252);
  assert.equal(researchTradingDates("2025-01-09", "2025-01-09").length, 0);
  assert.equal(researchTradingDates("2021-12-31", "2021-12-31").length, 1);
  assert.equal(researchTradingDates("2022-06-20", "2022-06-20").length, 0);
  assert.throws(() => researchTradingDates("2019-01-01", "2020-01-01"), /Unsupported/);
});

test("weekly history rejects null, duplicate, missing, stale and future observations", () => {
  assert.equal(validateDailyHistory(bars, dates).passed, true);
  assert.equal(validateDailyHistory(bars.map((bar, i) => i === 100 ? { ...bar, close: null } : bar), dates).passed, false);
  assert.equal(validateDailyHistory([...bars, bars.at(-1)], dates).passed, false);
  assert.equal(validateDailyHistory(bars.slice(40), dates).passed, false);
  assert.equal(validateDailyHistory(bars.slice(0, -1), dates).passed, false);
  assert.equal(validateDailyHistory(bars, dates.slice(0, -1)).passed, false);
});

test("daily research uses prior closes, charges both sides and labels terminal liquidation", () => {
  const rising = bars.slice(0, 200).map((bar, i) => ({ ...bar, open: 100 + i, close: 100 + i }));
  const result = backtestResearchRule(rising, { rule: "daily-momentum-20-60", costBpsPerSide: 50 });
  assert.ok(Math.abs(result.returnPct - ((0.995 ** 2 * 299 / 160 - 1) * 100)) < 1e-9);
  assert.equal(result.trades[0].entryDate, rising[60].date);
  assert.equal(result.trades[0].reason, "TERMINAL_LIQUIDATION");
  assert.equal(result.closedTrades, 0);
  assert.equal(result.profitFactor, null);
  const changed = rising.map((bar, i) => i > 150 ? { ...bar, open: 1, close: 1 } : bar);
  assert.deepEqual(backtestResearchRule(changed, { rule: "daily-momentum-20-60" }).equity.slice(0, 90), result.equity.slice(0, 90));
  assert.throws(() => backtestResearchRule([...rising].reverse(), { rule: "daily-momentum-20-60" }), /Invalid/);
});

test("profit factor is the ratio of net currency gains to losses, not percentage-return sums", () => {
  let seed = 12345, price = 100;
  const noisy = bars.map((bar) => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    price *= Math.exp((seed / 4294967296 - 0.48) * .15);
    return { ...bar, open: price, close: price };
  });
  const result = backtestResearchRule(noisy, { rule: "daily-momentum-20-60" });
  let capital = 1, gains = 0, losses = 0;
  for (const trade of result.trades) {
    const pnl = capital * trade.returnPct / 100;
    gains += Math.max(pnl, 0); losses += Math.max(-pnl, 0); capital += pnl;
  }
  assert.ok(Math.abs(result.profitFactor - gains / losses) < 1e-9);
});

test("candidate evaluation retains failed samples, temporal split and cost stress", () => {
  const candidate = evaluateCandidate(bars, "daily-momentum-20-60", validateDailyHistory(bars, dates));
  assert.ok(candidate.training.endDate < candidate.oos.startDate);
  assert.equal(candidate.slices.length, 3);
  assert.ok(candidate.stress.returnPct < candidate.oos.returnPct);
  assert.equal(candidate.passed, false);
  assert.ok(candidate.failures.includes("INSUFFICIENT_CLOSED_TRADES"));
  assert.match(candidate.validationType, /NOT_PUBLISH_FORWARD/);
});

test("Polymarket rejects stale, expired, thin and duplicate markets without renaming prices as certainty", () => {
  const market = { id: "1", question: "Fed interest rate cut?", active: true, closed: false, archived: false,
    endDate: "2026-10-01T00:00:00Z", updatedAt: "2026-09-13T01:00:00Z", liquidityNum: 30000, volume24hr: 5000,
    bestBid: .4, bestAsk: .42, description: "Resolves Yes under the official release.", outcomes: '["Yes","No"]', outcomePrices: '["0.41","0.59"]', events: [{ id: "e1", slug: "fed" }] };
  assert.equal(filterPredictionMarkets([market, { ...market, id: "2" }], now).markets.length, 1);
  for (const override of [{ liquidityNum: 1 }, { bestBid: null }, { updatedAt: "2020-01-01" }, { endDate: "2026-09-01" }, { closed: true }, { description: "" }]) assert.equal(filterPredictionMarkets([{ ...market, ...override }], now).markets.length, 0);
});

test("context sources retain release and observation semantics and reject future or stale facts", () => {
  assert.equal(parseFredCsv("DATE,VALUE\n2026-09-11,4.2", "2026-09-11", 7).status, "AVAILABLE");
  assert.equal(parseFredCsv("DATE,VALUE\n2026-01-01,4.2\n2026-09-14,4.3", "2026-09-11", 7).status, "STALE_OR_EMPTY");
  const rss = '<rss><item><title>Policy</title><link>https://www.federalreserve.gov/test</link><pubDate>Sat, 12 Sep 2026 12:00:00 GMT</pubDate><description>Public release</description></item></rss>';
  assert.equal(parseResearchFeed(rss, now).entries.length, 1);
  assert.equal(parseResearchFeed(rss, now - 3 * 86400000).entries.length, 0);
});

test("manager cannot invent citations, promote failed candidates or authorize live trading", () => {
  const bundle = { collectedAt: new Date(now).toISOString(), universeSource: "PRODUCTION_CONFIG_READ_ONLY", universe: ["SPY"], quality: { SPY: { passed: true } }, sources: RESEARCH_AXES.map((axis) => ({ id: axis, axis, status: "AVAILABLE", contentHash: "hash", retrievedAt: new Date(now).toISOString() })), candidates: [{ id: "SPY:rule", symbol: "SPY", passed: false }] };
  const analysis = { ...weeklyAnalysisTemplate(bundle), summary: "本周没有符合全部门槛的策略，不提出调整。", claims: RESEARCH_AXES.map((axis) => ({ axis, statement: "证据必须限定在当期已知信息范围内。", transmission: "需要通过利率、估值和风险偏好评估传导。", evidenceIds: [axis] })) };
  assert.equal(validateWeeklyAnalysis(bundle, analysis, now).liveAuthorized, false);
  assert.throws(() => validateWeeklyAnalysis(bundle, { ...analysis, decision: "LIVE" }, now), /Only research/);
  assert.throws(() => validateWeeklyAnalysis(bundle, { ...analysis, decision: "PAPER_RESEARCH_PROPOSAL", candidateId: "SPY:rule" }, now), /not passed/);
  const bad = structuredClone(analysis); bad.claims[0].evidenceIds = ["invented"];
  assert.throws(() => validateWeeklyAnalysis(bundle, bad, now), /Invalid evidence/);
  assert.ok(evidenceGates(bundle, now + 4 * 86400000).includes("BUNDLE_STALE_OR_INVALID"));
  assert.ok(evidenceGates(bundle, now).includes("MISSING_REQUIRED_SOURCE:fred-CPIAUCSL"));
  const passedBundle = structuredClone(bundle); passedBundle.candidates[0].passed = true;
  const proposal = { ...analysis, bundleHash: hashResearch(passedBundle), decision: "PAPER_RESEARCH_PROPOSAL", candidateId: "SPY:rule",
    entry: "一分钟突破后加杠杆，是另一条没有测过的策略。", exit: "亏损百分之五十才退出，覆盖原有风险规则。", sizing: "全额买入池外资产BTC并且加十倍杠杆。" };
  assert.throws(() => validateWeeklyAnalysis(passedBundle, proposal, now), /exactly match/);
  assert.equal(researchProposalSpec({ symbol: "SPY", rule: "daily-momentum-20-60" }).leverage, 1);
});

test("failed collection freezes gaps, reproduces, finalizes idempotently, and never hides a newer failed report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weekly-research-"));
  const result = await collectWeeklyResearch({ universe: ["SPY"], universeSource: "PRODUCTION_CONFIG_READ_ONLY", nowMs: now, fetchText: async () => { throw new Error("Provider unavailable"); } });
  const id = weeklyRunId(now);
  await saveWeeklyBundle(directory, id, result);
  assert.deepEqual(await loadWeeklyBundle(directory, id), result.bundle);
  const analysis = { ...weeklyAnalysisTemplate(result.bundle), claims: RESEARCH_AXES.map((axis) => ({ axis, statement: "当前来源采集失败，不能生成方向性结论。", transmission: "缺少当期证据，不能推断对标的的影响方向。", evidenceIds: [], gap: "需恢复公开数据源并重新核实下一期证据。" })) };
  const report = await finalizeWeeklyReport(directory, id, analysis, now);
  assert.equal(report.validation.status, "WITHHOLD");
  assert.deepEqual(await finalizeWeeklyReport(directory, id, analysis, now), report);
  await assert.rejects(finalizeWeeklyReport(directory, id, { ...analysis, summary: "变更结论且尝试覆盖原有正式版本的内容。" }, now), /immutable/);
  const status = await weeklyReportStatus(directory, null, now + 8 * 86400000);
  assert.equal(status.stale, true); assert.equal(status.lastCompleteId, null);
  const html = weeklyResearchHtml(status);
  assert.match(html, /历史报告/); assert.match(html, /不提出策略调整/);
  const poisoned = structuredClone(status); poisoned.report.analysis.summary = "<script>oops</script>";
  assert.doesNotMatch(weeklyResearchHtml(poisoned), /<script>/);
  await writeFile(join(directory, id, "history.json"), '{"SPY":[]}');
  await assert.rejects(loadWeeklyBundle(directory, id), /integrity/);
});

test("week IDs use Beijing calendar and empty pages do not invent a report", async () => {
  assert.equal(weeklyRunId(Date.parse("2026-09-13T16:01:00Z")), "2026-09-14");
  const directory = await mkdtemp(join(tmpdir(), "weekly-empty-"));
  assert.match(weeklyResearchHtml(await weeklyReportStatus(directory)), /周报尚未生成/);
  await assert.rejects(weeklyReportStatus(directory, "../../etc"), /Monday/);
});
