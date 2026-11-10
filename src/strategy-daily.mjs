import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";

const DAY = 86400000;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const numeric = value => value !== null && value !== undefined && !(typeof value === "string" && !value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
export const STRATEGY_DAILY_SCORE_VERSION = "evidence-tracking-v1";
export const beijingDate = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10);

function source({ kind, status = "MISSING", asOf = null, sourceHash = null, seriesKey = null,
  samples = 0, costs = 0, metrics = {}, warnings = [] }, nowMs) {
  const age = (nowMs - Date.parse(asOf)) / 3600000;
  if (status === "AVAILABLE") {
    if (!Number.isFinite(age)) status = "UNDATED";
    else if (age < 0) status = "FUTURE_DATA";
    else if (age > 72) status = "STALE";
  }
  const valid = status === "AVAILABLE" && (samples > 0 || numeric(metrics.cumulativeNetPnlUsdt) !== null);
  const components = {
    freshness: { label: "数据时效", maximum: 30, points: Number.isFinite(age) && age >= 0 ? age <= 24 ? 30 : age <= 72 ? 20 : 0 : 0 },
    samples: { label: "样本积累", maximum: 25, points: Math.min(25, Math.floor(Math.max(0, samples) / 20 * 25)) },
    costs: { label: "成本完整度", maximum: 20, points: costs },
    provenance: { label: "内容可追溯", maximum: 25, points: /^[a-f0-9]{64}$/.test(sourceHash || "") ? 25 : 0 }
  };
  const total = valid ? Object.values(components).reduce((sum, item) => sum + item.points, 0) : null;
  return { kind, status: status === "AVAILABLE" && !valid ? "NO_SAMPLES" : status, asOf, sourceHash, seriesKey,
    metrics: { cumulativeNetPnlUsdt: null, realizedPnlUsdt: null, equityUsdt: null, ...metrics, samples }, warnings,
    score: { version: STRATEGY_DAILY_SCORE_VERSION, total, components },
    daily: { netPnlUsdt: null, returnPct: null, reason: "NO_CONSECUTIVE_BASELINE" } };
}

function paperSource(report, nowMs, id) {
  const p = report || {};
  const started = p.observations != null ? p.observations > 0
    : p.position || p.closedTrades > 0 || p.lastObservation?.regularOpen === true;
  const realized = numeric(p.realizedPnlUsdt);
  const equity = numeric(p.liquidationEquityUsdt);
  const initial = numeric(p.initialCapitalUsdt);
  const floating = p.position ? numeric(p.hypotheticalExitNetPnlUsdt) : 0;
  const net = equity !== null && initial > 0 ? equity - initial
    : realized !== null && floating !== null ? realized + floating : null;
  return source({ kind: "PAPER", status: p.collectionStatus === "DATA_QUALITY_BLOCKED" ? "ERROR" : p.status === "AVAILABLE" && !started ? "NOT_STARTED" : p.status,
    // Runner updatedAt may advance when collection is blocked or the market is shut.
    asOf: p.position ? p.position.markedAt : p.lastObservation?.observedAt || p.lastObservation?.at || p.updatedAt,
    sourceHash: p.sourceHash,
    // The valuation helper's costModel is null while flat; opening/closing is
    // normal account activity, not a reset of the observation series.
    seriesKey: p.accountingSeriesHash || hash([id, p.startedAt, initial, p.roundTripCostPct, p.specificationHash, p.cost, p.producerIdentityHash]),
    samples: numeric(p.closedTrades) || 0,
    costs: numeric(p.totalCostUsdt) !== null && numeric(p.totalCostUsdt) >= 0 &&
      numeric(p.estimatedExitCostUsdt) !== null && numeric(p.estimatedExitCostUsdt) >= 0 && net !== null &&
      (!p.position || (p.costModel && p.costModel !== "UNKNOWN")) ? 20 : 0,
    metrics: { cumulativeNetPnlUsdt: started ? net : null, realizedPnlUsdt: started ? realized : null, equityUsdt: started ? equity : null,
      returnPct: started ? numeric(p.liquidationReturnPct) : null, symbol: p.position?.symbol || null },
    warnings: ["PAPER_CANDLE_PROXY：模型成本后估值，不是实盘成交", ...(p.producerIdentityHash ? [] : ["未绑定生产者规则身份；仅用于同账本观察"]) ]
  }, nowMs);
}

function strategySources(strategy, research, nowMs) {
  const perf = strategy.performance || {}, positions = strategy.openPositions || [];
  const allMarked = positions.every(p => {
    const age = nowMs - Date.parse(p.markedAt);
    return numeric(p.unrealizedPnlUsdt) !== null && Number.isFinite(age) && age >= 0 && age <= 72 * 3600000;
  });
  const incomplete = perf.excludedRecords > 0 || perf.conflictingOrders > 0 || research.positionsStatus !== "AVAILABLE" || !allMarked;
  const live = source({ kind: "LIVE", status: research.trace.status === "AVAILABLE" && incomplete ? "INCOMPLETE" : research.trace.status,
    asOf: positions.length ? positions.map(p => p.markedAt).sort()[0] : perf.period?.to,
    sourceHash: research.trace.sourceHash,
    seriesKey: hash([strategy.id, "LIVE_REALIZED_ONLY", strategy.governance?.identity?.identityHash]),
    samples: perf.trades || 0, costs: perf.trades > 0 ? 10 : 0,
    metrics: { cumulativeNetPnlUsdt: perf.trades > 0 ? numeric(perf.realizedPnlUsdt) : positions.length ? 0 : null,
      realizedPnlUsdt: perf.trades > 0 ? numeric(perf.realizedPnlUsdt) : null,
      unrealizedPnlUsdt: positions.length && allMarked ? positions.reduce((sum, p) => sum + p.unrealizedPnlUsdt, 0) : null,
      openPositions: positions.length },
    warnings: ["仅确认卖出成交的已实现损益；浮盈另列，缺完整净值曲线，不计算日收益率", "原始成交成本未重新审计，不代表执行成本已全部核实"]
  }, nowMs);
  const windows = [research.validation.historical, research.validation.forward];
  const window = [...windows].reverse().find(w => w?.strategies?.some(s => s.id === strategy.id));
  const result = window?.strategies.find(s => s.id === strategy.id)?.performance;
  const history = source({ kind: "HISTORY", status: research.validation.status === "AVAILABLE" && !result ? "MISSING" : research.validation.status,
    asOf: window?.dataCoverage?.to, sourceHash: research.validation.sourceHash,
    samples: result?.trades || 0, costs: window?.assumptions?.roundTripCostPct != null ? 10 : 0,
    metrics: { returnPct: numeric(result?.returnPct), maxDrawdownPct: numeric(result?.maxDrawdownPct) },
    warnings: ["历史 / 报告内前向回放；不能记作当日收益或新增独立前向样本"]
  }, nowMs);
  const horizons = (research.shadow.horizons || []).map(h => ({ minutes: h.horizonMinutes, ...h.strategyCohorts?.[strategy.id] })).filter(h => h.samples > 0);
  const shadow = source({ kind: "SHADOW", status: research.shadow.status,
    asOf: research.shadow.strategyDataCutoffs?.[strategy.id] || research.shadow.dataCutoff, sourceHash: research.shadow.sourceHash,
    samples: Math.max(0, ...horizons.map(h => h.samples)),
    metrics: { horizons }, warnings: ["反事实窗口不可相加；未完整计入卖出成本，不是可执行收益"]
  }, nowMs);
  return { live, paper: paperSource(research.paper[strategy.id], nowMs, strategy.id), history, shadow };
}

export function buildStrategyDaily(research, previous = null) {
  const nowMs = Date.parse(research.generatedAt), date = beijingDate(research.generatedAt);
  const consecutive = previous && Date.parse(date) - Date.parse(previous.date) === DAY;
  const strategies = research.strategies.map(strategy => ({
    strategyId: strategy.id, name: strategy.name, stage: strategy.status, active: strategy.active,
    observedIdentityHash: strategy.governance?.identity?.identityHash || null,
    primarySource: strategy.active || strategy.performance?.trades > 0 ? "live"
      : research.paper[strategy.id]?.status && research.paper[strategy.id].status !== "MISSING" ? "paper"
        : strategy.status === "SHADOW" ? "shadow" : "history",
    sources: strategySources(strategy, research, nowMs)
  }));
  for (const experiment of research.frequencyPaper?.experiments || []) {
    const id = `weekly-etf-dual-momentum-defense::${experiment.id}`;
    strategies.push({ strategyId: id, parentStrategyId: "weekly-etf-dual-momentum-defense", name: experiment.id,
      stage: "PAPER", active: false, primarySource: "paper", sources: { paper: paperSource({
        ...research.frequencyPaper, ...experiment, status: research.frequencyPaper.status,
        initialCapitalUsdt: 50, costModel: "FREQUENCY_MODEL_WITH_EXIT_COST",
        estimatedExitCostUsdt: experiment.position?.estimatedExitCostUsdt ?? (experiment.position ? null : 0)
      }, nowMs, id) } });
  }
  for (const strategy of strategies) for (const [kind, current] of Object.entries(strategy.sources)) {
    if (!["live", "paper"].includes(kind) || !consecutive) continue;
    const prior = previous.strategies.find(s => s.strategyId === strategy.strategyId)?.sources[kind];
    if (!prior) continue;
    if (prior.seriesKey !== current.seriesKey) { current.daily.reason = "SERIES_CHANGED"; continue; }
    if (current.metrics.samples < prior.metrics.samples) {
      current.status = "INCOMPLETE"; current.score.total = null;
      current.daily.reason = "LEDGER_REGRESSED";
      current.warnings.push("累计平仓样本回退，可能发生账本截断或重建；不能作为当日亏损");
      continue;
    }
    if (current.score.total === null || prior.score.total === null) { current.daily.reason = "INCOMPLETE_OR_STALE"; continue; }
    const net = current.metrics.cumulativeNetPnlUsdt, baseline = prior.metrics.cumulativeNetPnlUsdt;
    if (numeric(net) === null || numeric(baseline) === null) continue;
    current.daily = { netPnlUsdt: net - baseline,
      returnPct: kind === "paper" && numeric(current.metrics.equityUsdt) !== null && prior.metrics.equityUsdt > 0 ? (current.metrics.equityUsdt / prior.metrics.equityUsdt - 1) * 100 : null,
      reason: "CONSECUTIVE_SNAPSHOTS", from: previous.capturedAt, to: research.generatedAt };
  }
  return { schemaVersion: 1, scoreVersion: STRATEGY_DAILY_SCORE_VERSION, date, timeZone: "Asia/Shanghai",
    capturedAt: research.generatedAt, automaticTradingEligible: false, strategies };
}

function decode(text, date) {
  const value = JSON.parse(text);
  if (value.report?.schemaVersion !== 1 || value.report.date !== date || !Array.isArray(value.report.strategies) ||
    value.hash !== hash(value.report)) throw new Error(`Daily journal integrity error: ${date}`);
  return value.report;
}

// Publish one immutable file per Beijing observation date. No historical backfill.
export async function saveStrategyDaily(directory, report) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date) || beijingDate(report.capturedAt) !== report.date) throw new Error("Invalid journal date");
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const path = join(directory, report.date + ".json"), temporary = join(directory, "." + randomUUID() + ".tmp");
  await writeFile(temporary, JSON.stringify({ hash: hash(report), report }) + "\n", { flag: "wx", mode: 0o640 });
  try {
    await link(temporary, path);
    return { created: true, date: report.date };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    decode(await readFile(path, "utf8"), report.date);
    return { created: false, date: report.date };
  } finally { await unlink(temporary); }
}

export async function readStrategyDaily(directory, { limit = 90 } = {}) {
  let files;
  try { files = await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return { status: "MISSING", records: [], errors: [] }; throw error; }
  const records = [], errors = [];
  for (const name of files.filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse().slice(0, limit)) {
    try { records.push(decode(await readFile(join(directory, name), "utf8"), name.slice(0, 10))); }
    catch { errors.push(name.slice(0, 10)); }
  }
  return { status: errors.length ? "ERROR" : records.length ? "AVAILABLE" : "MISSING", records, errors };
}
