import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectLocalOkxAgenticStatus, runOkxAgenticStatusBridge, sendOkxAgenticStatus, OKX_AGENTIC_SOURCE_FILES } from "../scripts/sync-okx-agentic-status.mjs";
import { receiveOkxAgenticStatus, receiveOkxAgenticInput } from "../scripts/receive-okx-agentic-status.mjs";

const NOW = new Date("2026-11-09T01:00:00Z");
const SOURCE_TIME = new Date("2026-11-08T23:30:00Z");
const epoch = SOURCE_TIME.getTime() / 1000;
const PRIVATE = "PRIVATE-ADDRESS-SESSION-AMOUNT-SENTINEL";
const raw = () => ({
  "reports/watch-latest.json": { completedAt: "2026-11-09 07:30:00", chain: "xlayer", counts: { "符合·量能回流": 0, "观察·未企稳": 1, "淘汰": 1, "出错": 0 }, unverifiedBlocked: 1, funnel: { sampled: 2 }, results: [{ address: PRIVATE }, { address: PRIVATE }] },
  "reports/auto-trade-latest.json": { completed_at: epoch, as_of: epoch - 60, mode: "dry_run", chain: "xlayer", qualified_candidates: 0, blocked: ["本轮没有全部条件通过的标的", PRIVATE], free_usdc: PRIVATE, quote_token: PRIVATE },
  "auto-trade.json": { chain: "xlayer", live_enabled: false, account_name: PRIVATE, wallet_address: PRIVATE, quote_token: PRIVATE, trade_size_usdc: PRIVATE },
  "reports/execution-health.json": { observed_at: epoch, healthy: false, issues: ["执行器输出过期", PRIVATE] },
  "reports/trade-heartbeat.json": { started_at: epoch - 30, completed_at: epoch, status: "complete", raw: PRIVATE },
  "reports/auto-trade-state.json": { positions: { one: { status: "OPEN", address: PRIVATE }, two: { status: "CLOSED", amount: PRIVATE } }, orders: ["SUBMITTING", "PENDING", "UNKNOWN", "RECONCILE_REQUIRED", "FILLED"].map(status => ({ status, raw: PRIVATE })), scope: { account_name: PRIVATE } },
  "reports/shadow-research-latest.json": { mode: "shadow_research", candidate_observations: 5, unique_setups: 2, quote_cost_observations: 3, net_performance_verified: false, outcomes: [{ private: PRIVATE }] }
});
async function fixture(t, overrides = {}) {
  const sourceRoot = await mkdtemp(join(tmpdir(), "okx-agentic-bridge-source-"));
  const outputDirectory = await mkdtemp(join(tmpdir(), "okx-agentic-bridge-output-"));
  t.after(() => Promise.all([rm(sourceRoot, { recursive: true, force: true }), rm(outputDirectory, { recursive: true, force: true })]));
  for (const [name, value] of Object.entries({ ...raw(), ...overrides })) {
    if (value === null) continue;
    const path = join(sourceRoot, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    await utimes(path, SOURCE_TIME, SOURCE_TIME);
  }
  return { sourceRoot, outputDirectory };
}

test("local projection reads only seven fixed files and retains original component times without private fields", async t => {
  const f = await fixture(t);
  assert.equal(OKX_AGENTIC_SOURCE_FILES.length, 7);
  const before = await Promise.all(OKX_AGENTIC_SOURCE_FILES.map(name => readFile(join(f.sourceRoot, name), "utf8")));
  const snapshot = await collectLocalOkxAgenticStatus({ sourceRoot: f.sourceRoot, now: NOW });
  assert.equal(snapshot.exportedAt, NOW.toISOString());
  assert.equal(snapshot.monitor.asOf, SOURCE_TIME.toISOString());
  assert.equal(snapshot.executor.asOf, SOURCE_TIME.toISOString());
  assert.equal(snapshot.executor.reportedMode, "dry-run");
  assert.equal(snapshot.executor.policyEnabled, false);
  assert.deepEqual(snapshot.monitor.counts, { sampled: 2, qualified: 0, watching: 1, rejected: 1, errors: 0, unverifiedBlocked: 1 });
  assert.deepEqual(snapshot.executor.blocked, ["NO_QUALIFIED_CANDIDATES", "SOURCE_BLOCKED"]);
  assert.deepEqual(snapshot.health.issues, ["EXECUTOR_STALE", "SOURCE_ISSUE"]);
  assert.deepEqual(snapshot.ledger, { asOf: SOURCE_TIME.toISOString(), positionCount: 2, openPositionCount: 1, orderCount: 5, pendingOrderCount: 4, unknownOrderCount: 2 });
  assert.equal(snapshot.research.netPerformanceVerified, false);
  assert.equal(snapshot.source.chain, "xlayer");
  assert.deepEqual(snapshot.errors, []);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [PRIVATE, "wallet_address", "account_name", "quote_token", "free_usdc", "scope", "outcomes", "results"]) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(await Promise.all(OKX_AGENTIC_SOURCE_FILES.map(name => readFile(join(f.sourceRoot, name), "utf8"))), before, "source reports/config are never modified");
});

test("missing or malformed source components stay unknown and cannot manufacture healthy zeros", async t => {
  const f = await fixture(t, { "reports/watch-latest.json": null, "reports/auto-trade-state.json": "bad-json", "reports/execution-health.json": { healthy: true, observed_at: "bad", issues: [] } });
  const snapshot = await collectLocalOkxAgenticStatus({ sourceRoot: f.sourceRoot, now: NOW });
  assert.equal(snapshot.monitor.status, "MISSING");
  assert.equal(snapshot.monitor.counts.sampled, null);
  assert.equal(snapshot.ledger.positionCount, null);
  assert.equal(snapshot.health.reportedHealthy, null);
  assert.ok(snapshot.errors.includes("WATCH_MISSING"));
  assert.ok(snapshot.errors.includes("LEDGER_INVALID"));
  assert.ok(snapshot.errors.includes("HEALTH_INVALID"));
  const wrong = await fixture(t, { "reports/watch-latest.json": { ...raw()["reports/watch-latest.json"], funnel: { sampled: 20 } } });
  const invalid = await collectLocalOkxAgenticStatus({ sourceRoot: wrong.sourceRoot, now: NOW });
  assert.equal(invalid.monitor.status, "ERROR");
  assert.equal(invalid.monitor.counts.sampled, null);
});

test("source symlinks, oversized files, future times and chain mismatches are rejected as safe component codes", async t => {
  const f = await fixture(t);
  const path = join(f.sourceRoot, "reports/watch-latest.json");
  await rm(path); await symlink(join(f.sourceRoot, "auto-trade.json"), path);
  const linked = await collectLocalOkxAgenticStatus({ sourceRoot: f.sourceRoot, now: NOW });
  assert.equal(linked.monitor.status, "ERROR");
  assert.ok(linked.errors.includes("WATCH_INVALID"));
  await rm(path); await writeFile(path, "x".repeat(2_000_001));
  const large = await collectLocalOkxAgenticStatus({ sourceRoot: f.sourceRoot, now: NOW });
  assert.ok(large.errors.includes("WATCH_INVALID"));
  const wrong = await fixture(t, { "auto-trade.json": { chain: "base", live_enabled: false }, "reports/trade-heartbeat.json": { started_at: NOW.getTime() / 1000 + 301, completed_at: null, status: "running" } });
  const mismatched = await collectLocalOkxAgenticStatus({ sourceRoot: wrong.sourceRoot, now: NOW });
  assert.equal(mismatched.source.chain, "unknown");
  assert.ok(mismatched.errors.includes("CHAIN_MISMATCH"));
  assert.ok(mismatched.errors.includes("HEARTBEAT_INVALID"));
});

test("receiver applies strict projection, ten-minute export freshness and atomic private permissions", async t => {
  const f = await fixture(t);
  const snapshot = await collectLocalOkxAgenticStatus({ sourceRoot: f.sourceRoot, now: NOW });
  snapshot.raw = PRIVATE; snapshot.executor.session = PRIVATE;
  const receipt = await receiveOkxAgenticStatus(snapshot, { directory: f.outputDirectory, now: NOW });
  assert.equal(receipt.status, "ACCEPTED");
  const path = join(f.outputDirectory, "latest.json");
  const saved = await readFile(path, "utf8");
  assert.equal(saved.includes(PRIVATE), false);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(saved).health.asOf, SOURCE_TIME.toISOString(), "fresh export does not refresh the old healthy/unhealthy source time");
  const expired = { ...snapshot, exportedAt: new Date(NOW.getTime() - 601_000).toISOString() };
  await assert.rejects(receiveOkxAgenticStatus(expired, { directory: f.outputDirectory, now: NOW }));
  assert.equal(await readFile(path, "utf8"), saved);
  const malformed = structuredClone(snapshot); malformed.executor.blocked = [PRIVATE];
  await assert.rejects(receiveOkxAgenticStatus(malformed, { directory: f.outputDirectory, now: NOW }));
  assert.equal(await readFile(path, "utf8"), saved);
});

test("receiver refuses an out-of-order export and an oversized stdin without altering the saved snapshot", async t => {
  const f = await fixture(t);
  const snapshot = await collectLocalOkxAgenticStatus({ sourceRoot: f.sourceRoot, now: NOW });
  await receiveOkxAgenticStatus(snapshot, { directory: f.outputDirectory, now: NOW });
  const path = join(f.outputDirectory, "latest.json"), before = await readFile(path, "utf8");
  await assert.rejects(receiveOkxAgenticStatus({ ...snapshot, exportedAt: new Date(NOW.getTime() - 1000).toISOString() }, { directory: f.outputDirectory, now: NOW }));
  async function* tooLarge() { yield Buffer.alloc(65537, 120); }
  await assert.rejects(receiveOkxAgenticInput(tooLarge(), { directory: f.outputDirectory, now: NOW }));
  assert.equal(await readFile(path, "utf8"), before);
});

test("transport uses a fixed SSH command and stdin JSON without shell interpolation or raw error forwarding", async t => {
  const f = await fixture(t), snapshot = await collectLocalOkxAgenticStatus({ sourceRoot: f.sourceRoot, now: NOW });
  let capture;
  const execFileImpl = (file, args, options, callback) => ({ stdin: { on() {}, end(input) { capture = { file, args, options, input }; queueMicrotask(() => callback(null, JSON.stringify({ status: "ACCEPTED", exportedAt: snapshot.exportedAt, savedAt: NOW.toISOString() }), "")); } } });
  assert.equal((await sendOkxAgenticStatus(snapshot, { now: NOW, execFileImpl })).status, "ACCEPTED");
  assert.equal(capture.file, "/usr/bin/ssh");
  assert.ok(capture.args.includes("IdentityAgent=none"));
  assert.ok(capture.args.includes("IdentitiesOnly=yes"));
  assert.ok(capture.args.includes("BatchMode=yes"));
  assert.equal(capture.args.at(-2), "root@173.199.122.23");
  assert.equal(capture.args.at(-1), "runuser -u binancebot -- /usr/bin/node /opt/binance-agentic-personal-assets/current/scripts/receive-okx-agentic-status.mjs");
  assert.equal(capture.args.join(" ").includes(snapshot.exportedAt), false);
  assert.equal(capture.input.includes(PRIVATE), false);
  assert.equal(JSON.parse(capture.input).health.asOf, SOURCE_TIME.toISOString());
});

test("default bridge exports locally; explicit send failures preserve a safe failure receipt and release the mutex", async t => {
  const f = await fixture(t);
  let calls = 0;
  const transport = async () => { calls += 1; throw new Error(PRIVATE); };
  const exported = await runOkxAgenticStatusBridge({ ...f, now: NOW, transport });
  assert.equal(exported.receipt.status, "EXPORTED");
  assert.equal(calls, 0);
  await assert.rejects(runOkxAgenticStatusBridge({ ...f, now: NOW, send: true, transport }));
  assert.equal(calls, 1);
  const receipt = JSON.parse(await readFile(join(f.outputDirectory, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "FAILED");
  assert.equal(JSON.stringify(receipt).includes(PRIVATE), false);
  await assert.rejects(lstat(join(f.outputDirectory, "bridge.lock")), { code: "ENOENT" });
  assert.equal((await lstat(join(f.outputDirectory, "latest.json"))).mode & 0o777, 0o600);
});

test("the bridge mutex prevents overlapping sends before reading or transmitting another snapshot", async t => {
  const f = await fixture(t);
  await writeFile(join(f.outputDirectory, "bridge.lock"), JSON.stringify({ pid: process.pid, owner: "existing-run" }));
  let sends = 0;
  await assert.rejects(runOkxAgenticStatusBridge({ ...f, now: NOW, send: true, transport: async () => { sends += 1; } }), /already running/);
  assert.equal(sends, 0);
});
