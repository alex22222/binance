import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export const OKX_AGENTIC_SOURCE_NAME = "OKX 回调二波";
export const OKX_AGENTIC_BLOCK_CODES = Object.freeze(["HEALTH_UNVERIFIED", "BALANCE_UNVERIFIED", "ORDER_RECONCILE_REQUIRED", "SAFETY_UNVERIFIED", "QUOTE_UNVERIFIED", "ACCOUNT_UNVERIFIED", "SCOPE_UNVERIFIED", "RISK_LIMIT", "SIGNAL_UNVERIFIED", "NO_QUALIFIED_CANDIDATES", "SOURCE_BLOCKED"]);
export const OKX_AGENTIC_HEALTH_CODES = Object.freeze(["EXECUTOR_STALE", "EXECUTOR_ERROR", "EXECUTOR_INCOMPLETE", "EXECUTOR_UNVERIFIED", "HEARTBEAT_UNVERIFIED", "ORDER_UNVERIFIED", "POSITION_UNVERIFIED", "EXIT_QUOTES_FAILED", "LEDGER_UNVERIFIED", "SOURCE_ISSUE"]);
export const OKX_AGENTIC_ERROR_CODES = Object.freeze(["WATCH_MISSING", "WATCH_INVALID", "EXECUTOR_MISSING", "EXECUTOR_INVALID", "HEALTH_MISSING", "HEALTH_INVALID", "HEARTBEAT_MISSING", "HEARTBEAT_INVALID", "LEDGER_MISSING", "LEDGER_INVALID", "RESEARCH_MISSING", "RESEARCH_INVALID", "POLICY_MISSING", "POLICY_INVALID", "CHAIN_MISMATCH"]);
export const OKX_AGENTIC_MESSAGES = Object.freeze({
  HEALTH_UNVERIFIED: "独立健康检查未通过或未核实", BALANCE_UNVERIFIED: "可用资金尚未核实", ORDER_RECONCILE_REQUIRED: "订单或成交回执待核验", SAFETY_UNVERIFIED: "候选安全条件尚未通过", QUOTE_UNVERIFIED: "报价、滑点或费用尚未核实", ACCOUNT_UNVERIFIED: "源账户状态尚未核实", SCOPE_UNVERIFIED: "执行范围尚未核实", RISK_LIMIT: "风险或次数限额阻断", SIGNAL_UNVERIFIED: "策略信号尚未通过", NO_QUALIFIED_CANDIDATES: "本轮没有全部条件通过的标的", SOURCE_BLOCKED: "源系统报告阻断，详情需在本机核对",
  EXECUTOR_STALE: "执行器心跳已过期", EXECUTOR_ERROR: "执行器报告异常", EXECUTOR_INCOMPLETE: "执行器尚无近期完成记录", EXECUTOR_UNVERIFIED: "执行器状态未核实", HEARTBEAT_UNVERIFIED: "执行器心跳未核实", ORDER_UNVERIFIED: "订单结果待核验", POSITION_UNVERIFIED: "策略持仓状态待核验", EXIT_QUOTES_FAILED: "持仓退出报价持续失败", LEDGER_UNVERIFIED: "策略账本未核实", SOURCE_ISSUE: "本机健康检查报告异常",
  WATCH_MISSING: "筛选快照缺失", WATCH_INVALID: "筛选快照无法核验", EXECUTOR_MISSING: "执行快照缺失", EXECUTOR_INVALID: "执行快照无法核验", HEALTH_MISSING: "健康快照缺失", HEALTH_INVALID: "健康快照无法核验", HEARTBEAT_MISSING: "执行器心跳缺失", HEARTBEAT_INVALID: "执行器心跳无法核验", LEDGER_MISSING: "策略账本快照缺失", LEDGER_INVALID: "策略账本快照无法核验", RESEARCH_MISSING: "研究摘要缺失", RESEARCH_INVALID: "研究摘要无法核验", POLICY_MISSING: "源配置开关未读取", POLICY_INVALID: "源配置开关无法核验", CHAIN_MISMATCH: "本机来源链范围不一致"
});

const MAX_BYTES = 65536;
const FUTURE_MS = 300000;
const at = now => {
  const result = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(result.getTime())) throw invalid();
  return result;
};
function invalid() { return Object.assign(new Error("OKX 运行快照格式或来源无法核验。"), { statusCode: 400, code: "INVALID_OKX_SNAPSHOT" }); }
function object(value) { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(); return value; }
function choice(value, values) { if (!values.includes(value)) throw invalid(); return value; }
function count(value) { if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 10000000)) throw invalid(); return value; }
function boolean(value) { if (value !== null && typeof value !== "boolean") throw invalid(); return value; }
function stamp(value, now, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 946684800000 || milliseconds > now + FUTURE_MS) throw invalid();
  return new Date(milliseconds).toISOString();
}
function codes(value, allowed) {
  if (!Array.isArray(value) || value.length > 32 || value.some(code => typeof code !== "string" || !allowed.includes(code))) throw invalid();
  return [...new Set(value)];
}

// Unknown fields are deliberately projected away. No source code, credentials,
// wallet identifiers, CLI results or arbitrary error strings enter this DTO.
export function normalizeOkxAgenticSnapshot(value, { now = new Date(), maxExportAgeMs } = {}) {
  object(value);
  const nowMs = at(now).getTime();
  if (value.schemaVersion !== 1) throw invalid();
  const source = object(value.source), monitor = object(value.monitor), executor = object(value.executor), health = object(value.health);
  const heartbeat = object(value.heartbeat), ledger = object(value.ledger), research = object(value.research), rawCounts = object(monitor.counts);
  if (source.name !== OKX_AGENTIC_SOURCE_NAME || source.machine !== "Mac") throw invalid();
  const exportedAt = stamp(value.exportedAt, nowMs, false);
  if (maxExportAgeMs !== undefined && (!Number.isFinite(maxExportAgeMs) || maxExportAgeMs < 0 || nowMs - Date.parse(exportedAt) > maxExportAgeMs)) throw invalid();
  const counts = Object.fromEntries(["sampled", "qualified", "watching", "rejected", "errors", "unverifiedBlocked"].map(key => [key, count(rawCounts[key])]));
  const monitorStatus = choice(monitor.status, ["OK", "ERROR", "MISSING"]);
  if (monitorStatus === "OK" && (Object.values(counts).some(value => value === null) || counts.qualified + counts.watching + counts.rejected + counts.errors !== counts.sampled || counts.unverifiedBlocked > counts.sampled)) throw invalid();
  const book = Object.fromEntries(["positionCount", "openPositionCount", "orderCount", "pendingOrderCount", "unknownOrderCount"].map(key => [key, count(ledger[key])]));
  for (const [larger, smaller] of [["positionCount", "openPositionCount"], ["orderCount", "pendingOrderCount"], ["pendingOrderCount", "unknownOrderCount"]]) if (book[larger] !== null && book[smaller] !== null && book[smaller] > book[larger]) throw invalid();
  const reportedHealthy = boolean(health.reportedHealthy), issues = codes(health.issues, OKX_AGENTIC_HEALTH_CODES);
  if (reportedHealthy === true && issues.length || research.netPerformanceVerified !== false) throw invalid();
  return { schemaVersion: 1, exportedAt, source: { name: OKX_AGENTIC_SOURCE_NAME, machine: "Mac", chain: choice(source.chain, ["xlayer", "solana", "base", "ethereum", "bsc", "unknown"]) },
    monitor: { asOf: stamp(monitor.asOf, nowMs), status: monitorStatus, counts },
    executor: { asOf: stamp(executor.asOf, nowMs), reportedMode: choice(executor.reportedMode, ["live", "dry-run", "unknown"]), policyEnabled: boolean(executor.policyEnabled), blocked: codes(executor.blocked, OKX_AGENTIC_BLOCK_CODES), qualifiedCandidates: count(executor.qualifiedCandidates) },
    health: { asOf: stamp(health.asOf, nowMs), reportedHealthy, issues },
    heartbeat: { startedAt: stamp(heartbeat.startedAt, nowMs), completedAt: stamp(heartbeat.completedAt, nowMs), status: choice(heartbeat.status, ["running", "complete", "error", "unknown"]) },
    ledger: { asOf: stamp(ledger.asOf, nowMs), ...book },
    research: { asOf: stamp(research.asOf, nowMs), mode: choice(research.mode, ["shadow_research"]), candidateObservations: count(research.candidateObservations), uniqueSetups: count(research.uniqueSetups), quoteCostObservations: count(research.quoteCostObservations), netPerformanceVerified: false },
    errors: codes(value.errors, OKX_AGENTIC_ERROR_CODES) };
}

function components(snapshot, now) {
  const component = (asOf, maximumAge, failed = false, missing = false) => ({ asOf, status: !asOf || missing ? "MISSING" : now - Date.parse(asOf) > maximumAge ? "STALE" : failed ? "ERROR" : "FRESH" });
  const pulse = snapshot.heartbeat;
  const heartbeatAt = pulse.startedAt && pulse.completedAt ? new Date(Math.min(Date.parse(pulse.startedAt), Date.parse(pulse.completedAt))).toISOString() : null;
  return { bridge: component(snapshot.exportedAt, 900000), monitor: component(snapshot.monitor.asOf, 900000, snapshot.monitor.status === "ERROR", snapshot.monitor.status === "MISSING"),
    executor: component(snapshot.executor.asOf, 180000, false, snapshot.executor.reportedMode === "unknown"),
    health: component(snapshot.health.asOf, 180000, snapshot.health.reportedHealthy === false, snapshot.health.reportedHealthy === null),
    heartbeat: component(heartbeatAt, 180000, pulse.status === "error", pulse.status === "unknown"),
    ledger: component(snapshot.ledger.asOf, 900000, false, Object.values(snapshot.ledger).some(value => value === null)),
    research: component(snapshot.research.asOf, 86400000) };
}

export async function loadOkxAgenticStatus(directory, { now = new Date() } = {}) {
  const checked = at(now), empty = { checkedAt: checked.toISOString(), status: "MISSING", snapshot: null, stale: true, components: {}, errors: [] };
  let handle;
  try {
    handle = await open(join(directory, "latest.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES || info.mode & 0o077) throw invalid();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!bytesRead || bytesRead > MAX_BYTES) throw invalid();
    const snapshot = normalizeOkxAgenticSnapshot(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")), { now: checked });
    const status = components(snapshot, checked.getTime()), stale = status.bridge.status === "STALE";
    const partial = snapshot.errors.length || snapshot.source.chain === "unknown" || ["monitor", "executor", "health", "heartbeat", "ledger"].some(key => status[key].status !== "FRESH");
    return { ...empty, status: stale ? "STALE" : partial ? "PARTIAL" : "AVAILABLE", snapshot, stale, components: status, errors: snapshot.errors };
  } catch (error) {
    return error.code === "ENOENT" ? empty : { ...empty, status: "ERROR", errors: ["SNAPSHOT_UNREADABLE"], error: "OKX 运行快照无法读取或格式不符，请检查本机同步记录。" };
  } finally { await handle?.close(); }
}

const name = value => typeof value === "string" ? value.slice(0, 200) : "未命名记录";
const savedTime = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
function savedRecord(row, account) {
  return { name: name(row.name), kind: ["total", "holding"].includes(row.kind) ? row.kind : null, currency: typeof row.currency === "string" && /^[A-Z]{3,5}$/.test(row.currency) ? row.currency : null,
    amount: typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : null,
    asOf: typeof row.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.asOf) ? row.asOf : null,
    asOfBasis: ["statement", "imported"].includes(row.asOfBasis) ? row.asOfBasis : null, source: ["manual", "csv", "screenshot", "api"].includes(row.source) ? row.source : null,
    counted: account.reviewStatus !== "pending" && (account.basis === "total" ? row.kind === "total" : account.basis === "holdings" && row.kind === "holding") };
}

export function projectOkxAgenticAssets(state) {
  if (state?.status === "ERROR") return { scope: "okx-agentic-assets", status: "ERROR", updatedAt: null, accounts: [], error: "已保存钱包资产暂不可读取。" };
  const projected = state?.scope === "okx-agentic-assets";
  const portfolio = projected ? state : state?.portfolio;
  const accounts = Array.isArray(portfolio?.accounts) ? portfolio.accounts : [];
  const entries = Array.isArray(portfolio?.entries) ? portfolio.entries : [];
  return { scope: "okx-agentic-assets", updatedAt: savedTime(state?.updatedAt), accounts: accounts.filter(account => account?.platform === "OKX Agentic Wallet").slice(0, 100).map(account => ({
    platform: "OKX Agentic Wallet", name: name(account.name), basis: ["total", "holdings"].includes(account.basis) ? account.basis : null, reviewStatus: ["confirmed", "pending"].includes(account.reviewStatus) ? account.reviewStatus : null,
    records: (projected ? Array.isArray(account.records) ? account.records : [] : entries.filter(row => row.accountId === account.id)).slice(0, 5000).map(row => savedRecord(row, account))
  })) };
}
