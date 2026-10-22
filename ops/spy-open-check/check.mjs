import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const STRATEGY_ID = "weekly-etf-dual-momentum-defense";
export const OPEN_AT = "2026-10-22T13:30:00.000Z";
export const DUE_AT = "2026-10-22T13:45:00.000Z";
const digest = value => createHash("sha256").update(value).digest("hex");
const within = (at, start, end) => Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(start) && Date.parse(at) <= Date.parse(end);
const positive = value => value != null && Number.isFinite(Number(value)) && Number(value) > 0;
const quantity = value => /^\d+(?:\.\d+)?$/.test(String(value)) ? String(value).replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : null;
export const safeError = value => String(value || "").replace(/https?:\/\/\S+/g, "[url]").replace(/0x[0-9a-f]{40,}/gi, "[redacted]").replace(/(?:secret|password|authorization|access_token)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, 260);

export async function readCheckTrace(path, openAt, observedAt) {
  const result = { complete: true, successfulCycles: 0, fills: [], submissions: [], blockers: [], malformedLines: 0, lastCycle: null, errors: [], firstAt: null, lastAt: null };
  try {
    const before = await stat(path);
    if (!before.size) throw new Error("EMPTY_TRACE");
    const fills = new Map();
    const reader = createInterface({ input: createReadStream(path, { end: before.size - 1, highWaterMark: 1024 * 1024 }), crlfDelay: Infinity });
    for await (const line of reader) {
      let row;
      try { row = JSON.parse(line); } catch { result.malformedLines++; continue; }
      if (!Number.isFinite(Date.parse(row.timestamp))) { result.malformedLines++; continue; }
      result.firstAt ||= row.timestamp; result.lastAt = row.timestamp;
      if (!within(row.timestamp, openAt, observedAt)) continue;
      const d = row.details || {};
      if (row.event === "cycle" && ["succeeded", "failed"].includes(row.status)) {
        if (row.status === "succeeded") result.successfulCycles++;
        result.lastCycle = { timestamp: row.timestamp, status: row.status, cycleId: row.cycleId, ...(d.error ? { error: safeError(d.error) } : {}) };
      }
      if (row.event === "pending_order" && row.status === "finished" && d.side === "BUY" && d.symbol === "SPY" && d.strategyId === STRATEGY_ID && d.orderId) {
        const fill = { timestamp: row.timestamp, orderId: d.orderId, symbol: d.symbol, strategyId: d.strategyId, quantity: d.quantity, costBasisUsdt: d.costBasisUsdt };
        const prior = fills.get(d.orderId);
        if (prior && (quantity(prior.quantity) !== quantity(fill.quantity) || prior.costBasisUsdt !== fill.costBasisUsdt)) result.errors.push("CONFLICTING_BUY_TERMINALS");
        else if (!prior) fills.set(d.orderId, fill);
      }
      if (["buy_submission", "order_intent", "order_submission"].includes(row.event) && d.symbol === "SPY" && d.strategyId === STRATEGY_ID) {
        result.submissions.push({ timestamp: row.timestamp, event: row.event, status: row.status, orderId: d.orderId || null });
        if (result.submissions.length > 20) result.submissions.shift();
      }
      const explicitGate = row.event === "strategy_promotion" && row.status === "blocked" && d.symbol === "SPY";
      const explicitPlan = row.event === "weekly_etf_allocation" && row.status === "blocked" && d.symbol === "SPY";
      const cost = row.event === "candidate_evaluated" && d.symbol === "SPY" && d.costCoverageAllowed === false;
      if (explicitGate || explicitPlan || cost) {
        result.blockers.push({ timestamp: row.timestamp, cycleId: row.cycleId, reason: explicitGate ? "AUTHORIZATION_BLOCKED" : explicitPlan ? "ALLOCATION_LIMIT" : "COST_GATE", detail: safeError(explicitGate ? (d.reasons || []).join(" / ") : explicitPlan ? d.reason : d.costCoverageReason) });
        if (result.blockers.length > 20) result.blockers.shift();
      }
    }
    result.fills = [...fills.values()];
    const after = await stat(path);
    if (before.ino !== after.ino || after.size < before.size) result.errors.push("TRACE_ROTATED_DURING_READ");
    if (!result.firstAt || Date.parse(result.firstAt) > Date.parse(openAt)) result.errors.push("TRACE_STARTS_AFTER_OPEN");
    if (result.malformedLines) result.errors.push("MALFORMED_TRACE_LINES");
  } catch (error) { result.errors.push(error.code || safeError(error.message)); }
  result.complete = result.errors.length === 0;
  return result;
}

export function analyzeSpyCheck(input) {
  const { state = {}, control = {}, gate = {}, config = {}, policy = {}, trace = {}, stop } = input;
  const base = { schemaVersion: 1, strategyId: STRATEGY_ID, symbol: "SPY", observedAt: input.observedAt, openAt: input.openAt, dueAt: input.dueAt, evidence: {
    heartbeatAt: state.updatedAt || null, authorizationAllowed: gate.allowed === true, authorizationReasons: gate.reasons || [],
    authorizationExpiresAt: gate.expiresAt || null, weeklyTarget: policy.weeklyTarget || null,
    traceComplete: trace.complete === true, traceErrors: trace.errors || [], successfulCycles: trace.successfulCycles || 0,
    lastCycle: trace.lastCycle || null
  } };
  const result = (status, reason, detail = null) => ({ ...base, status, reason, detail });
  const age = Date.parse(input.observedAt) - Date.parse(state.updatedAt || "");
  const maxAge = Math.max(180000, Number(config.pollSeconds || 60) * 3000);
  const fresh = Number.isFinite(age) && age >= 0 && age <= maxAge;
  if (Date.parse(input.observedAt) < Date.parse(input.dueAt)) return result("UNCONFIRMED", "CHECK_NOT_DUE");
  if (Date.parse(input.observedAt) - Date.parse(input.dueAt) > 900000) return result("UNCONFIRMED", "CHECK_DELAYED");
  const positions = Array.isArray(state.positions) ? state.positions : state.position ? [state.position] : [];
  const fills = (trace.fills || []).filter(f => within(f.timestamp, input.openAt, input.observedAt) && f.strategyId === STRATEGY_ID && f.symbol === "SPY" && positive(f.quantity) && positive(f.costBasisUsdt));
  if (fills.length) {
    const fill = fills.at(-1);
    const holding = positions.find(p => quantity(fill.quantity) !== null && p.symbol === "SPY" && p.strategyId === STRATEGY_ID && p.shadow === false && p.orderId === fill.orderId && quantity(p.quantity) === quantity(fill.quantity) && Number(p.costBasisUsdt) === Number(fill.costBasisUsdt));
    if (holding && fresh && trace.complete) return { ...result("CONFIRMED_BUY", "TERMINAL_BUY_AND_HOLDING_MATCH"), fill };
    return { ...result("UNCONFIRMED", "TERMINAL_BUY_NEEDS_RECONCILIATION"), fill };
  }
  if (positions.some(p => p.symbol === "SPY" && p.shadow !== true)) return result("UNCONFIRMED", "HOLDING_WITHOUT_TERMINAL_EVIDENCE");
  const cycleAge = Date.parse(input.observedAt) - Date.parse(trace.lastCycle?.timestamp || "");
  if (!fresh || !trace.complete || !trace.successfulCycles || !Number.isFinite(cycleAge) || cycleAge < 0 || cycleAge > maxAge) return result("UNCONFIRMED", "INCOMPLETE_OR_STALE_EVIDENCE");
  if (state.pendingOrder) return result("IN_FLIGHT", "PENDING_ORDER", { side: state.pendingOrder.side, symbol: state.pendingOrder.symbol, status: state.pendingOrder.status });
  if (state.approvalRequest) return result("NOT_BOUGHT", "AWAITING_APPROVAL", { side: state.approvalRequest.side, symbol: state.approvalRequest.symbol });
  if (trace.lastCycle?.status === "failed" || state.lastError) return result("NOT_BOUGHT", "LATEST_CYCLE_FAILED", safeError(state.lastError || trace.lastCycle.error));
  if (stop?.active) return result("NOT_BOUGHT", "EMERGENCY_STOP");
  if (control.entriesPaused) return result("NOT_BOUGHT", "ENTRIES_PAUSED");
  if (config.mode !== "live" || control.strategyId !== STRATEGY_ID) return result("NOT_BOUGHT", "STRATEGY_OR_MODE_CHANGED");
  if (!policy.regularOpen) return result("NOT_BOUGHT", "MARKET_NOT_REGULAR", "这是检查时状态，不能据此断言开盘时也休市");
  if (!policy.fomcAllowed) return result("NOT_BOUGHT", "FOMC_ENTRY_BLACKOUT");
  if (state.date !== policy.newYorkDate || !Number.isFinite(state.realizedPnlUsdt)) return result("UNCONFIRMED", "RISK_DAY_OR_PNL_UNAVAILABLE");
  if (state.realizedPnlUsdt <= -config.dailyLossLimitUsdt) return result("NOT_BOUGHT", "DAILY_LOSS_LIMIT");
  if (!policy.weeklyDecisionUsable) return result("NOT_BOUGHT", "WEEKLY_DECISION_UNAVAILABLE");
  if (policy.weeklyTarget !== "SPY") return result("NOT_BOUGHT", "WEEKLY_TARGET_NOT_SPY", policy.weeklyTarget);
  if (policy.skipEntryWeek) return result("NOT_BOUGHT", "WEEK_STOPPED_AFTER_DISASTER_EXIT");
  if (positions.length) return result("NOT_BOUGHT", "EXISTING_POSITION");
  if (gate.allowed !== true || !gate.limits?.weeklyEtfAllocation) return result("NOT_BOUGHT", "AUTHORIZATION_BLOCKED", gate.reasons || []);
  if (!policy.symbolAllowed) return result("NOT_BOUGHT", "SYMBOL_POLICY_BLOCKED");
  if (policy.cooldownActive) return result("NOT_BOUGHT", "COOLDOWN_ACTIVE");
  const blocker = (trace.blockers || []).filter(b => b.cycleId && b.cycleId === trace.lastCycle?.cycleId).at(-1);
  if (blocker) return result("NOT_BOUGHT", blocker.reason, { observedAt: blocker.timestamp, detail: blocker.detail });
  if (trace.submissions?.length) return result("UNCONFIRMED", "SUBMITTED_WITHOUT_TERMINAL_EVIDENCE");
  return result("UNCONFIRMED", "NO_EXPLICIT_BLOCKER_RECORDED", "授权、市场及已知风险检查未发现阻断，但当前入场路径部分分支静默返回；不能据此猜测成本、流动性、审计或钱包额度的具体原因。");
}

const reasons = {
  TERMINAL_BUY_AND_HOLDING_MATCH: "真实BUY终态与当前持仓的订单、精确数量及成本一致",
  TERMINAL_BUY_NEEDS_RECONCILIATION: "已有BUY终态，但当前持仓/时效/日志完整性未能对应，需核对后续退出或记账",
  HOLDING_WITHOUT_TERMINAL_EVIDENCE: "当前有SPY仓位，但没有匹配的本晚成交终态，不能判为未买入",
  PENDING_ORDER: "存在在途订单，尚不能确认成交", AWAITING_APPROVAL: "存在待审批请求",
  INCOMPLETE_OR_STALE_EVIDENCE: "心跳或日志证据不完整/过期，不能把缺失当作零成交",
  LATEST_CYCLE_FAILED: "最近一轮运行失败", EMERGENCY_STOP: "紧急停止生效", ENTRIES_PAUSED: "新增买入被暂停",
  STRATEGY_OR_MODE_CHANGED: "当前策略或运行模式已变化", MARKET_NOT_REGULAR: "检查时不在常规交易时段",
  FOMC_ENTRY_BLACKOUT: "FOMC入场禁入规则生效", RISK_DAY_OR_PNL_UNAVAILABLE: "风险日或日盈亏不可核验",
  DAILY_LOSS_LIMIT: "纽约交易日已实现亏损达到原限制", WEEKLY_DECISION_UNAVAILABLE: "没有本周可用的周度信号",
  WEEKLY_TARGET_NOT_SPY: "当前周度目标不是SPY", WEEK_STOPPED_AFTER_DISASTER_EXIT: "灾难退出后本周禁止再入场",
  EXISTING_POSITION: "已有受管理仓位，不能按空仓新开SPY", AUTHORIZATION_BLOCKED: "当前买入授权闸门未放行",
  SYMBOL_POLICY_BLOCKED: "标的黑名单/隔离规则阻断", COOLDOWN_ACTIVE: "再入场冷却中",
  ALLOCATION_LIMIT: "仓位、现金预留或估算风险预算未通过", COST_GATE: "该轮SPY候选成本检查未通过",
  SUBMITTED_WITHOUT_TERMINAL_EVIDENCE: "有提交记录但未取得匹配的终态证据", NO_EXPLICIT_BLOCKER_RECORDED: "未买入的具体原因尚未确认（缺少明确阻断日志）",
  CHECK_NOT_DUE: "尚未到计划核验时间", CHECK_DELAYED: "执行已迟于计划15分钟以上，不能代替原定开盘检查", COLLECTION_FAILED: "读取证据失败，无法确认成交与原因"
};
export function checkMessage(report) {
  const labels = { CONFIRMED_BUY: "已确认自动买入 SPY", NOT_BOUGHT: "尚未买入 SPY", IN_FLIGHT: "订单在途，成交未确认", UNCONFIRMED: "SPY 核验未确认" };
  const time = value => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const lines = [`[Agentic Stock Bot] ${labels[report.status] || "SPY核验"}`, `核验时间（北京）：${time(report.observedAt)}`, `结论：${reasons[report.reason] || report.reason}`];
  if (report.fill) lines.push(`终态时间（北京）：${time(report.fill.timestamp)}`, `数量：${report.fill.quantity} SPYon；投入：${report.fill.costBasisUsdt} USDT`, `订单：${report.fill.orderId}`);
  if (report.detail != null) lines.push(`依据/限制：${safeError(typeof report.detail === "string" ? report.detail : JSON.stringify(report.detail))}`);
  lines.push(`当前授权：${report.evidence?.authorizationAllowed ? "有效（仍须其他执行检查通过）" : "未放行/未知"}`, "本检查只读；未下单、未审批、未补买、未修改授权或风控。", "https://spaceflag.site");
  return lines.join("\n");
}

async function atomicJson(path, data) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
export async function deliverCheck({ directory, kind, report, text, send }) {
  if (!["preflight", "scheduled"].includes(kind)) throw new Error("Invalid check kind");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const receiptPath = join(directory, `${kind}.receipt.json`), lockPath = join(directory, `${kind}.lock`);
  const readReceipt = () => readFile(receiptPath, "utf8").then(JSON.parse).catch(e => e.code === "ENOENT" ? null : Promise.reject(e));
  if ((await readReceipt())?.status === "SENT") return { ...(await readReceipt()), duplicateSkipped: true };
  const lock = await open(lockPath, "wx", 0o600);
  try {
    const old = await readReceipt();
    if (old?.status === "SENT") return { ...old, duplicateSkipped: true };
    if (old?.status === "SENDING") throw new Error("Uncertain delivery: inspect existing receipt; do not resend");
    await atomicJson(join(directory, `${kind}.report.json`), report);
    await writeFile(join(directory, `${kind}.message.txt`), text, { mode: 0o600 });
    const receipt = { schemaVersion: 1, kind, status: "SENDING", hash: digest(text), uuid: digest(`spy-open-check:2026-10-22:${kind}`).slice(0, 40), attemptedAt: new Date().toISOString(), reportStatus: report.status };
    await atomicJson(receiptPath, receipt);
    const delivered = await send(text, receipt.uuid);
    if (delivered?.channel !== "app" || !delivered.messageId) throw new Error("Missing Feishu business delivery receipt");
    const sent = { ...receipt, status: "SENT", sentAt: new Date().toISOString(), channel: delivered.channel, messageId: delivered.messageId };
    await atomicJson(receiptPath, sent);
    return sent;
  } finally { await lock.close(); await unlink(lockPath); }
}
