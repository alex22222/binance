import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadOkxAgenticStatus, normalizeOkxAgenticSnapshot, projectOkxAgenticAssets } from "../src/okx-agentic-status.mjs";

const NOW = new Date("2026-11-09T01:00:00Z");
const at = (seconds = 0) => new Date(NOW.getTime() - seconds * 1000).toISOString();
function snapshot() {
  return { schemaVersion: 1, exportedAt: at(), source: { name: "OKX 回调二波", chain: "xlayer", machine: "Mac" },
    monitor: { asOf: at(30), status: "OK", counts: { sampled: 4, qualified: 0, watching: 1, rejected: 2, errors: 1, unverifiedBlocked: 2 } },
    executor: { asOf: at(30), reportedMode: "live", policyEnabled: true, blocked: ["NO_QUALIFIED_CANDIDATES"], qualifiedCandidates: 0 },
    health: { asOf: at(30), reportedHealthy: true, issues: [] }, heartbeat: { startedAt: at(10), completedAt: at(30), status: "running" },
    ledger: { asOf: at(30), positionCount: 0, openPositionCount: 0, orderCount: 0, pendingOrderCount: 0, unknownOrderCount: 0 },
    research: { asOf: at(100000), mode: "shadow_research", candidateObservations: 1, uniqueSetups: 0, quoteCostObservations: 0, netPerformanceVerified: false }, errors: [] };
}
async function fixture(t, value = snapshot()) {
  const directory = await mkdtemp(join(tmpdir(), "okx-agentic-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "latest.json");
  if (value) await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { directory, path };
}

test("normalizer projects a fixed source schema without exposing unknown wallet, session or account metadata", () => {
  const value = snapshot();
  value.credentials = { apiKey: "private-sentinel" }; value.rawCLI = "private-sentinel";
  value.source.accountId = "private-sentinel"; value.executor.session = "private-sentinel";
  value.ledger.orders = [{ private: "private-sentinel" }];
  const normalized = normalizeOkxAgenticSnapshot(value, { now: NOW });
  assert.equal(JSON.stringify(normalized).includes("private-sentinel"), false);
  assert.equal(normalized.exportedAt, at());
  assert.equal(normalized.health.asOf, at(30));
  assert.equal(normalized.ledger.orderCount, 0);
});

test("normalizer rejects malformed identities, future times, impossible counts, unrecognized reasons and fabricated verified performance", () => {
  const cases = [value => { value.source.name = "fake"; }, value => { value.health.asOf = at(-301); },
    value => { value.monitor.counts.qualified = 10; }, value => { value.ledger.pendingOrderCount = 1; },
    value => { value.executor.blocked = ["secret-session-text"]; }, value => { value.research.netPerformanceVerified = true; },
    value => { value.ledger.orderCount = -1; }];
  for (const corrupt of cases) {
    const value = snapshot(); corrupt(value);
    assert.throws(() => normalizeOkxAgenticSnapshot(value, { now: NOW }), error => error.statusCode === 400 && error.code === "INVALID_OKX_SNAPSHOT" && !error.message.includes("secret-session-text"));
  }
  const old = snapshot(); old.exportedAt = at(601);
  assert.throws(() => normalizeOkxAgenticSnapshot(old, { now: NOW, maxExportAgeMs: 600000 }));
  assert.equal(normalizeOkxAgenticSnapshot(old, { now: NOW }).exportedAt, at(601));
});

test("a freshly copied old healthy report stays stale at its own source time", async t => {
  const value = snapshot();
  value.health.asOf = value.executor.asOf = value.heartbeat.startedAt = value.heartbeat.completedAt = at(3600);
  const { directory, path } = await fixture(t, value);
  const before = await readFile(path, "utf8");
  const result = await loadOkxAgenticStatus(directory, { now: NOW });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.stale, false);
  assert.equal(result.components.health.status, "STALE");
  assert.equal(result.snapshot.health.reportedHealthy, true);
  assert.equal(result.snapshot.health.asOf, at(3600));
  assert.equal(await readFile(path, "utf8"), before);
});

test("fresh source snapshots, old bridge exports and a current failed health report have distinct states", async t => {
  const f = await fixture(t);
  assert.equal((await loadOkxAgenticStatus(f.directory, { now: NOW })).status, "AVAILABLE");
  const value = snapshot(); value.exportedAt = at(901);
  await writeFile(f.path, JSON.stringify(value));
  assert.equal((await loadOkxAgenticStatus(f.directory, { now: NOW })).status, "STALE");
  value.exportedAt = at(); value.health.reportedHealthy = false; value.health.issues = ["EXECUTOR_ERROR"];
  await writeFile(f.path, JSON.stringify(value));
  const failed = await loadOkxAgenticStatus(f.directory, { now: NOW });
  assert.equal(failed.status, "PARTIAL"); assert.equal(failed.components.health.status, "ERROR");
});

test("missing, corrupt, oversized, public or symlinked snapshots never manufacture a healthy zero state", async t => {
  const f = await fixture(t, null);
  assert.equal((await loadOkxAgenticStatus(f.directory, { now: NOW })).status, "MISSING");
  await writeFile(f.path, "bad-json", { mode: 0o600 });
  assert.equal((await loadOkxAgenticStatus(f.directory, { now: NOW })).status, "ERROR");
  await writeFile(f.path, "x".repeat(65537));
  assert.equal((await loadOkxAgenticStatus(f.directory, { now: NOW })).status, "ERROR");
  await writeFile(f.path, JSON.stringify(snapshot())); await chmod(f.path, 0o644);
  assert.equal((await loadOkxAgenticStatus(f.directory, { now: NOW })).status, "ERROR");
  await rm(f.path); const outside = join(f.directory, "private.json"); await writeFile(outside, "private-sentinel"); await symlink(outside, f.path);
  const result = await loadOkxAgenticStatus(f.directory, { now: NOW });
  assert.equal(result.status, "ERROR"); assert.equal(JSON.stringify(result).includes("private-sentinel"), false);
});

test("asset projection includes only the exact saved OKX Agentic platform and never adds totals or currencies", () => {
  const state = { updatedAt: at(), sync: { credentials: "private-sentinel" }, portfolio: {
    accounts: [{ id: "wallet-private-id", name: "链上钱包", platform: "OKX Agentic Wallet", basis: "holdings", reviewStatus: "confirmed", note: "private-sentinel" }, { id: "exchange", name: "OKX交易所", platform: "OKX", basis: "total" }],
    entries: [{ id: "private-record", accountId: "wallet-private-id", name: "USDt0", kind: "holding", currency: "USD", amount: 12.5, asOf: "2026-11-08", asOfBasis: "statement", source: "api", note: "private-sentinel" }, { accountId: "exchange", name: "交易所余额", kind: "total", currency: "USD", amount: 900, asOf: "2026-11-08" }] } };
  const result = projectOkxAgenticAssets(state);
  assert.equal(result.scope, "okx-agentic-assets");
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].records[0].amount, 12.5);
  assert.equal(result.accounts[0].records[0].currency, "USD");
  assert.equal(result.accounts[0].records[0].asOf, "2026-11-08");
  for (const secret of ["private-sentinel", "wallet-private-id", "private-record", "交易所余额"]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal("total" in result, false);
  assert.equal(projectOkxAgenticAssets({ portfolio: { accounts: [], entries: [] } }).accounts.length, 0);
  assert.deepEqual(projectOkxAgenticAssets(result), result);
  assert.equal(projectOkxAgenticAssets({ scope: "okx-agentic-assets", accounts: [{ platform: "OKX", name: "private-exchange", records: [] }] }).accounts.length, 0);
  const failed = projectOkxAgenticAssets({ status: "ERROR", error: "private-sentinel", accounts: [] });
  assert.equal(failed.status, "ERROR");
  assert.equal(JSON.stringify(failed).includes("private-sentinel"), false);
});
