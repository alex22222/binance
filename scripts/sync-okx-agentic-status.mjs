import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeOkxAgenticSnapshot, OKX_AGENTIC_SOURCE_NAME } from "../src/okx-agentic-status.mjs";
import { acquireStatusLock, writeStatusJson } from "./receive-okx-agentic-status.mjs";

const SOURCE_ROOT = "/Users/henry/projects/OKX";
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT_DIRECTORY = join(PROJECT_ROOT, "state", "okx-agentic-bridge");
export const OKX_AGENTIC_SOURCE_FILES = Object.freeze(["reports/watch-latest.json", "reports/auto-trade-latest.json", "auto-trade.json",
  "reports/execution-health.json", "reports/trade-heartbeat.json", "reports/auto-trade-state.json", "reports/shadow-research-latest.json"]);
const CHAINS = new Set(["xlayer", "solana", "base", "ethereum", "bsc"]);
const clock = now => {
  const value = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(value.getTime())) throw new Error("INVALID_BRIDGE_TIME");
  return value;
};
const record = value => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_COMPONENT"); return value; };
const count = value => { if (!Number.isSafeInteger(value) || value < 0 || value > 10000000) throw new Error("INVALID_COUNT"); return value; };
const boolean = value => { if (typeof value !== "boolean") throw new Error("INVALID_BOOLEAN"); return value; };
function sourceTime(value, now) {
  let milliseconds;
  if (typeof value === "number" && Number.isFinite(value)) milliseconds = value * 1000;
  else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)) {
    const local = value.replace(" ", "T");
    milliseconds = Date.parse(local + "+08:00");
    if (!Number.isFinite(milliseconds) || new Date(milliseconds + 8 * 3600000).toISOString().slice(0, 19) !== local) throw new Error("INVALID_SOURCE_TIME");
  } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 946684800000 || milliseconds > now + 300000) throw new Error("INVALID_SOURCE_TIME");
  return new Date(milliseconds).toISOString();
}

async function readSource(sourceRoot, name) {
  let handle;
  try {
    handle = await open(join(sourceRoot, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat(), maximum = 2000000;
    if (!info.isFile() || info.size < 1 || info.size > maximum) throw new Error("INVALID_SOURCE_FILE");
    const buffer = Buffer.alloc(maximum + 1), result = await handle.read(buffer, 0, buffer.length, 0);
    if (!result.bytesRead || result.bytesRead > maximum) throw new Error("INVALID_SOURCE_FILE");
    return { value: record(JSON.parse(buffer.subarray(0, result.bytesRead).toString("utf8"))), mtime: info.mtimeMs };
  } catch (error) { return { error: error.code === "ENOENT" ? "MISSING" : "INVALID" }; }
  finally { await handle?.close(); }
}

function blockedCode(value) {
  if (value === "本轮没有全部条件通过的标的") return "NO_QUALIFIED_CANDIDATES";
  const rules = [[/reconcil|对账|未知订单|订单未知/i, "ORDER_RECONCILE_REQUIRED"], [/health|健康/i, "HEALTH_UNVERIFIED"],
    [/balance|余额|可用资金/i, "BALANCE_UNVERIFIED"], [/safety|安全|蜜罐|honeypot/i, "SAFETY_UNVERIFIED"], [/quote|报价|滑点|slippage|费用/i, "QUOTE_UNVERIFIED"],
    [/account|账户/i, "ACCOUNT_UNVERIFIED"], [/scope|范围/i, "SCOPE_UNVERIFIED"], [/limit|限额|风险|risk/i, "RISK_LIMIT"], [/signal|信号|条件|标的/i, "SIGNAL_UNVERIFIED"]];
  return rules.find(([pattern]) => pattern.test(value))?.[1] || "SOURCE_BLOCKED";
}
function healthCode(value) {
  const rules = [[/退出.*报价|exit.*quote/i, "EXIT_QUOTES_FAILED"], [/heartbeat|心跳/i, "HEARTBEAT_UNVERIFIED"], [/reconcil|order|订单|成交/i, "ORDER_UNVERIFIED"],
    [/position|仓位|持仓/i, "POSITION_UNVERIFIED"], [/ledger|账本/i, "LEDGER_UNVERIFIED"], [/stale|过期|陈旧/i, "EXECUTOR_STALE"],
    [/incomplete|未完成|无.*完成/i, "EXECUTOR_INCOMPLETE"], [/error|错误|异常|失败/i, "EXECUTOR_ERROR"], [/unverified|未核实|未知/i, "EXECUTOR_UNVERIFIED"]];
  return rules.find(([pattern]) => pattern.test(value))?.[1] || "SOURCE_ISSUE";
}
function safeCodes(value, map) {
  if (!Array.isArray(value) || value.length > 1000 || value.some(item => typeof item !== "string")) throw new Error("INVALID_REASONS");
  return [...new Set(value.map(map))];
}

export async function collectLocalOkxAgenticStatus({ sourceRoot = SOURCE_ROOT, now = () => new Date() } = {}) {
  const checked = clock(now), nowMs = checked.getTime();
  const rows = await Promise.all(OKX_AGENTIC_SOURCE_FILES.map(name => readSource(sourceRoot, name)));
  const snapshot = { schemaVersion: 1, exportedAt: checked.toISOString(), source: { name: OKX_AGENTIC_SOURCE_NAME, machine: "Mac", chain: "unknown" },
    monitor: { asOf: null, status: "MISSING", counts: { sampled: null, qualified: null, watching: null, rejected: null, errors: null, unverifiedBlocked: null } },
    executor: { asOf: null, reportedMode: "unknown", policyEnabled: null, blocked: [], qualifiedCandidates: null },
    health: { asOf: null, reportedHealthy: null, issues: [] }, heartbeat: { startedAt: null, completedAt: null, status: "unknown" },
    ledger: { asOf: null, positionCount: null, openPositionCount: null, orderCount: null, pendingOrderCount: null, unknownOrderCount: null },
    research: { asOf: null, mode: "shadow_research", candidateObservations: null, uniqueSetups: null, quoteCostObservations: null, netPerformanceVerified: false }, errors: [] };
  const apply = (index, code, project) => {
    const row = rows[index];
    if (row.error) { snapshot.errors.push(`${code}_${row.error}`); return; }
    try { project(row.value, row); }
    catch { snapshot.errors.push(`${code}_INVALID`); }
  };
  apply(0, "WATCH", value => {
    const asOf = sourceTime(value.completedAt, nowMs), counts = record(value.counts);
    if (!Array.isArray(value.results)) throw new Error("INVALID_RESULTS");
    const sampled = value.funnel?.sampled === undefined ? value.results.length : count(value.funnel.sampled);
    const projected = { sampled, qualified: count(counts["符合·量能回流"]), watching: count(counts["观察·未企稳"]), rejected: count(counts["淘汰"]), errors: count(counts["出错"]), unverifiedBlocked: count(value.unverifiedBlocked) };
    if (sampled !== value.results.length || projected.qualified + projected.watching + projected.rejected + projected.errors !== sampled || projected.unverifiedBlocked > sampled) throw new Error("INVALID_COUNTS");
    snapshot.monitor = { asOf, status: "OK", counts: projected };
  });
  if (snapshot.errors.includes("WATCH_INVALID")) snapshot.monitor.status = "ERROR";
  apply(1, "EXECUTOR", value => {
    const mode = value.mode === "dry_run" || value.mode === "dry-run" ? "dry-run" : value.mode === "live" ? "live" : "unknown";
    if (mode === "unknown") throw new Error("INVALID_MODE");
    const projected = { asOf: sourceTime(value.completed_at ?? value.as_of, nowMs), reportedMode: mode, blocked: safeCodes(value.blocked, blockedCode), qualifiedCandidates: count(value.qualified_candidates) };
    Object.assign(snapshot.executor, projected);
  });
  apply(2, "POLICY", value => { snapshot.executor.policyEnabled = boolean(value.live_enabled); });
  apply(3, "HEALTH", value => {
    const projected = { asOf: sourceTime(value.observed_at, nowMs), reportedHealthy: boolean(value.healthy), issues: safeCodes(value.issues, healthCode) };
    if (projected.reportedHealthy && projected.issues.length) throw new Error("INVALID_HEALTH");
    snapshot.health = projected;
  });
  apply(4, "HEARTBEAT", value => {
    const status = value.status === "completed" ? "complete" : value.status;
    if (!["running", "complete", "error", "unknown"].includes(status)) throw new Error("INVALID_HEARTBEAT");
    const startedAt = sourceTime(value.started_at, nowMs), completedAt = value.completed_at === null || value.completed_at === undefined ? null : sourceTime(value.completed_at, nowMs);
    if (status === "complete" && completedAt === null) throw new Error("INVALID_HEARTBEAT");
    snapshot.heartbeat = { startedAt, completedAt, status };
  });
  apply(5, "LEDGER", (value, row) => {
    const positions = Object.values(record(value.positions));
    if (!Array.isArray(value.orders) || [...positions, ...value.orders].some(item => !item || typeof item !== "object" || typeof item.status !== "string")) throw new Error("INVALID_LEDGER");
    snapshot.ledger = { asOf: sourceTime(row.mtime / 1000, nowMs), positionCount: positions.length, openPositionCount: positions.filter(item => item.status !== "CLOSED").length,
      orderCount: value.orders.length, pendingOrderCount: value.orders.filter(item => ["SUBMITTING", "PENDING", "UNKNOWN", "RECONCILE_REQUIRED"].includes(item.status)).length,
      unknownOrderCount: value.orders.filter(item => ["UNKNOWN", "RECONCILE_REQUIRED"].includes(item.status)).length };
  });
  apply(6, "RESEARCH", (value, row) => {
    if (value.mode !== "shadow_research" || value.net_performance_verified !== false) throw new Error("INVALID_RESEARCH");
    snapshot.research = { asOf: sourceTime(row.mtime / 1000, nowMs), mode: "shadow_research", candidateObservations: count(value.candidate_observations), uniqueSetups: count(value.unique_setups),
      quoteCostObservations: count(value.quote_cost_observations), netPerformanceVerified: false };
  });
  const chains = [0, 1, 2].map(index => rows[index].value?.chain).filter(value => CHAINS.has(value));
  if (chains.length === 3 && new Set(chains).size === 1) snapshot.source.chain = chains[0];
  else if (new Set(chains).size > 1) snapshot.errors.push("CHAIN_MISMATCH");
  return normalizeOkxAgenticSnapshot(snapshot, { now: checked });
}

export async function sendOkxAgenticStatus(value, { now = () => new Date(), execFileImpl = execFile } = {}) {
  const snapshot = normalizeOkxAgenticSnapshot(value, { now: clock(now), maxExportAgeMs: 600000 });
  const args = ["-i", "/Users/henry/.ssh/polymtrade_vultr_ed25519", "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", "root@173.199.122.23",
    "runuser -u binancebot -- /usr/bin/node /opt/binance-agentic-personal-assets/current/scripts/receive-okx-agentic-status.mjs"];
  return new Promise((resolvePromise, reject) => {
    const failed = () => reject(Object.assign(new Error("OKX 状态快照发送失败。"), { code: "STATUS_SEND_FAILED" }));
    const child = execFileImpl("/usr/bin/ssh", args, { encoding: "utf8", timeout: 45000, maxBuffer: 65536 }, (error, stdout) => {
      if (error) return failed();
      try {
        const receipt = JSON.parse(stdout);
        if (receipt.status !== "ACCEPTED" || receipt.exportedAt !== snapshot.exportedAt || !Number.isFinite(Date.parse(receipt.savedAt))) return failed();
        resolvePromise({ status: "ACCEPTED", exportedAt: receipt.exportedAt, savedAt: new Date(receipt.savedAt).toISOString() });
      } catch { failed(); }
    });
    child.stdin.on("error", failed);
    child.stdin.end(JSON.stringify(snapshot) + "\n");
  });
}

export async function runOkxAgenticStatusBridge({ sourceRoot = SOURCE_ROOT, outputDirectory = OUTPUT_DIRECTORY, now = () => new Date(), send = false, transport = sendOkxAgenticStatus } = {}) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const lock = await acquireStatusLock(outputDirectory);
  const attemptedAt = clock(now).toISOString();
  try {
    const snapshot = await collectLocalOkxAgenticStatus({ sourceRoot, now });
    await writeStatusJson(join(outputDirectory, "latest.json"), snapshot);
    let serverReceipt = null;
    if (send) {
      try { serverReceipt = await transport(snapshot, { now }); }
      catch { throw Object.assign(new Error("OKX 状态快照发送失败。"), { code: "STATUS_SEND_FAILED" }); }
      if (serverReceipt?.status !== "ACCEPTED" || serverReceipt.exportedAt !== snapshot.exportedAt) throw Object.assign(new Error("OKX 状态快照接收回执无效。"), { code: "STATUS_SEND_FAILED" });
    }
    const receipt = { schemaVersion: 1, status: send ? "SENT" : "EXPORTED", attemptedAt, exportedAt: snapshot.exportedAt, errors: snapshot.errors, serverReceipt };
    await writeStatusJson(join(outputDirectory, "receipt.json"), receipt);
    return { snapshot, receipt };
  } catch (error) {
    const receipt = { schemaVersion: 1, status: "FAILED", attemptedAt, code: error.code === "STATUS_SEND_FAILED" ? "STATUS_SEND_FAILED" : "STATUS_EXPORT_FAILED" };
    await writeStatusJson(join(outputDirectory, "receipt.json"), receipt).catch(() => {});
    throw Object.assign(new Error("OKX 只读状态桥接未完成。"), { code: receipt.code });
  } finally { await lock.release(); }
}

const entry = process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null);
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some(value => value !== "--send") || arguments_.length > 1) throw new Error("INVALID_ARGUMENTS");
    const { receipt } = await runOkxAgenticStatusBridge({ send: arguments_.includes("--send") });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(JSON.stringify({ status: "FAILED", code: error.code === "STATUS_SEND_FAILED" ? "STATUS_SEND_FAILED" : "STATUS_EXPORT_FAILED" }));
    process.exitCode = 1;
  }
}
