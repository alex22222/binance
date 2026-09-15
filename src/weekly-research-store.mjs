import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { evidenceGates, evaluateCandidate, hashResearch, RESEARCH_AXES, validateDailyHistory, validateWeeklyAnalysis } from "./weekly-research.mjs";
import { researchTradingDates } from "./weekly-research-calendar.mjs";

export function weeklyRunId(nowMs = Date.now()) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
  const timestamp = Date.parse(day);
  return new Date(timestamp - ((new Date(timestamp).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
}

export function assertWeeklyRunId(id) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id) || !Number.isFinite(Date.parse(id)) || new Date(`${id}T00:00:00Z`).toISOString().slice(0, 10) !== id || new Date(id).getUTCDay() !== 1) throw new Error("Expected Monday week ID YYYY-MM-DD");
}

export async function saveWeeklyBundle(directory, id, result) {
  assertWeeklyRunId(id);
  const run = join(directory, id);
  await mkdir(run, { recursive: true, mode: 0o700 });
  // Bundle is the commit marker: incomplete collection can be retried; committed evidence is never replaced.
  try { await readFile(join(run, "bundle.json")); throw new Error("Weekly evidence already frozen"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(join(run, "history.json"), JSON.stringify(result.history), { mode: 0o600 });
  await writeFile(join(run, "raw.json"), JSON.stringify(result.raw), { mode: 0o600 });
  await writeFile(join(run, "bundle.json"), JSON.stringify(result.bundle, null, 2), { flag: "wx", mode: 0o600 });
  return { id, bundleHash: hashResearch(result.bundle), blockers: evidenceGates(result.bundle) };
}

export async function loadWeeklyBundle(directory, id) {
  assertWeeklyRunId(id);
  const run = join(directory, id);
  const bundle = JSON.parse(await readFile(join(run, "bundle.json"), "utf8"));
  const history = JSON.parse(await readFile(join(run, "history.json"), "utf8"));
  const raw = JSON.parse(await readFile(join(run, "raw.json"), "utf8"));
  if (hashResearch(history) !== bundle.historyHash) throw new Error("History integrity check failed");
  for (const source of bundle.sources) if (source.contentHash && hashResearch(raw[source.id]) !== source.contentHash) throw new Error("Source integrity check failed");
  for (const [file, hash] of Object.entries(bundle.codeHashes)) {
    if (!/^[a-z-]+\.mjs$/.test(file) || hashResearch(await readFile(new URL(file, import.meta.url), "utf8")) !== hash) throw new Error("Code changed since evidence freeze; do not relabel the old run");
  }
  // Recompute numerical gates independently of any model-supplied PASS field.
  const expected = researchTradingDates(bundle.start, bundle.cutoff);
  const candidates = bundle.candidates.map(({ symbol, rule, id: candidateId }) => ({ id: candidateId, symbol,
    ...evaluateCandidate(history[symbol] || [], rule, validateDailyHistory(history[symbol] || [], expected)) }));
  if (hashResearch(candidates) !== hashResearch(bundle.candidates)) throw new Error("Backtest reproducibility check failed");
  return bundle;
}

export function compactWeeklyReport(bundle, analysis, validation, id, nowMs) {
  const compact = (result) => result ? Object.fromEntries(Object.entries(result).filter(([key]) => !["trades", "equity"].includes(key))) : null;
  return { id, generatedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 7 * 86400000).toISOString(),
    cutoff: bundle.cutoff, universe: bundle.universe, universeSource: bundle.universeSource,
    bundleHash: hashResearch(bundle), policy: bundle.policy, validation, analysis,
    sources: bundle.sources, limitations: bundle.limitations,
    candidates: bundle.candidates.map((candidate) => ({ id: candidate.id, symbol: candidate.symbol, rule: candidate.rule,
      passed: candidate.passed, failures: candidate.failures, quality: candidate.quality,
      training: compact(candidate.training), oos: compact(candidate.oos), stress: compact(candidate.stress), slices: candidate.slices?.map(compact) || [] })) };
}

export async function finalizeWeeklyReport(directory, id, analysis, nowMs = Date.now()) {
  const bundle = await loadWeeklyBundle(directory, id);
  const validation = validateWeeklyAnalysis(bundle, analysis, nowMs);
  const report = compactWeeklyReport(bundle, analysis, validation, id, nowMs);
  const reportPath = join(directory, id, "report.json");
  try {
    const prior = JSON.parse(await readFile(reportPath, "utf8"));
    if (hashResearch(prior.analysis) !== hashResearch(analysis)) throw new Error("Published weekly report is immutable");
    return prior;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  return report;
}

export async function weeklyReportStatus(directory, id = null, nowMs = Date.now()) {
  if (id) assertWeeklyRunId(id);
  const entries = await readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const history = [];
  for (const entry of entries.filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().reverse()) {
    const report = await readFile(join(directory, entry, "report.json"), "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (report) history.push({ id: entry, generatedAt: report.generatedAt, status: report.validation.status, complete: !report.validation.blockers.length });
  }
  const selected = id || history[0]?.id;
  const report = selected ? await readFile(join(directory, selected, "report.json"), "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error)) : null;
  const currentId = weeklyRunId(nowMs);
  return { available: Boolean(report), report, history, lastCompleteId: history.find((entry) => entry.complete)?.id || null,
    currentWeek: currentId, currentWeekMissing: !history.some((entry) => entry.id === currentId),
    stale: report ? nowMs > Date.parse(report.expiresAt) : true };
}

export function weeklyAnalysisTemplate(bundle) {
  return { bundleHash: hashResearch(bundle), decision: "WITHHOLD", candidateId: null,
    summary: "待基金经理根据冻结证据撰写，不代表已完成报告。", counterargument: "待撰写主要反证及其依据。", invalidation: "待写明可检验的失效条件和下一步验证。",
    claims: RESEARCH_AXES.map((axis) => ({ axis, statement: "", transmission: "", evidenceIds: [], gap: "" })),
    author: "codex-fund-manager", independentReview: { reviewer: "", verdict: "NOT_REVIEWED", limitations: "" },
    entry: "", exit: "", sizing: "" };
}
