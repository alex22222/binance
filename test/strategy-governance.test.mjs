import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  archiveEvidence, evidenceHash, evaluatePromotion, strategyIdentity, loadStrategyGate, runtimeCodeHash
} from "../src/strategy-governance.mjs";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const ID = "weekly-etf-dual-momentum-defense";
const config = { symbols: ["QQQ", "SGOV"], maxTradeUsdt: 50, slippagePct: 0.5 };
const identity = strategyIdentity(config, ID, "a".repeat(64));

function experimentalFixture() {
  const config = { symbols: ["QQQ", "VTI", "VTV", "SPY", "SGOV"], maxTradeUsdt: 50, maxOpenPositions: 1, dailyLossLimitUsdt: 2 };
  const identity = strategyIdentity(config, ID, "a".repeat(64));
  return { config, identity, nowMs: NOW, authorization: {
    type: "EXPERIMENTAL_EXCEPTION", strategyId: ID, identityHash: identity.identityHash,
    approvedBy: "henry", approvedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 7 * 86400000).toISOString(),
    reason: "Explicit user authorization for a bounded experimental run", riskAccepted: true,
    limits: { maxTradeUsdt: 50, maxOpenPositions: 1, dailyLossLimitUsdt: 2 }
  } };
}

test("explicit bounded exception permits execution without claiming research PASS", () => {
  const result = evaluatePromotion(experimentalFixture());
  assert.equal(result.allowed, true);
  assert.equal(result.researchQualified, false);
  assert.equal(result.researchStatus, "NOT_QUALIFIED");
  assert.equal(result.authorizationType, "EXPERIMENTAL_EXCEPTION");
  assert.equal(result.reviewedBy, null);
  assert.equal(result.protectiveExitAllowed, true);
  assert.deepEqual(result.limits, { maxTradeUsdt: 50, maxOpenPositions: 1, dailyLossLimitUsdt: 2 });
});

test("experimental exceptions expire exactly, cannot extend past seven days or forge a review", () => {
  for (const edit of [
    x => { x.nowMs += 7 * 86400000; },
    x => { x.nowMs -= 1; },
    x => { x.authorization.expiresAt = new Date(NOW + 7 * 86400000 + 1).toISOString(); },
    x => { x.authorization.approvedBy = ""; },
    x => { x.authorization.riskAccepted = false; },
    x => { x.authorization.reason = ""; },
    x => { x.authorization.review = { status: "PASS" }; },
    x => { x.authorization.type = "UNKNOWN_EXCEPTION"; },
    x => { x.authorization.identityHash = "b".repeat(64); },
    x => { x.identity = strategyIdentity(x.config, "adaptive-momentum", "a".repeat(64)); x.authorization.strategyId = x.identity.strategyId; x.authorization.identityHash = x.identity.identityHash; },
    x => { x.config.maxTradeUsdt = 51; },
    x => { x.config.maxOpenPositions = 2; },
    x => { x.config.dailyLossLimitUsdt = 3; },
    x => { delete x.config.dailyLossLimitUsdt; },
    x => { x.authorization.limits.maxTradeUsdt = 51; },
    x => { x.authorization.limits.maxOpenPositions = 0; },
    x => { x.authorization.limits.dailyLossLimitUsdt = "2"; }
  ]) { const input = experimentalFixture(); edit(input); assert.equal(evaluatePromotion(input).allowed, false); }
  const input = experimentalFixture();
  input.nowMs += 7 * 86400000 - 1;
  assert.equal(evaluatePromotion(input).allowed, true);
});

test("operator exception loader observes expiry, config changes and revocation without restart", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "strategy-exception-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/strategy-governance.mjs"), "// owner reference\n");
  await mkdir(join(projectRoot, "strategy-governance"), { mode: 0o755 });
  const input = experimentalFixture();
  input.authorization.identityHash = strategyIdentity(input.config, ID, await runtimeCodeHash()).identityHash;
  const registry = join(projectRoot, "strategy-governance/authorizations.json");
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, authorizations: [input.authorization] }), { mode: 0o644 });
  const request = { projectRoot, config: input.config, strategyId: ID, nowMs: NOW };
  const gate = await loadStrategyGate(request);
  assert.equal(gate.allowed, true);
  assert.equal(gate.researchQualified, false);
  assert.equal((await loadStrategyGate({ ...request, nowMs: NOW + 7 * 86400000 })).allowed, false);
  assert.equal((await loadStrategyGate({ ...request, config: { ...input.config, maxTradeUsdt: 40 } })).allowed, false);
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, authorizations: [] }));
  assert.deepEqual((await loadStrategyGate(request)).reasons, ["NO_LIVE_AUTHORIZATION"]);
});

function fixture() {
  const evidence = ["HISTORICAL", "FORWARD", "PAPER"].map((kind) => ({
    schemaVersion: 1, strategyId: ID, kind, identity,
    author: "researcher", generatedAt: "2026-09-27T10:00:00Z",
    dataCutoff: "2026-09-25T20:00:00Z", validUntil: "2026-10-04T00:00:00Z",
    evidenceLevel: kind === "PAPER" ? "PAPER_CANDLE_PROXY" : "QUOTE_REPLAY",
    sourceHash: "b".repeat(64), costModel: { model: "amount-matched-quotes-plus-gas" },
    payload: { trades: 20 }
  }));
  const evidenceIds = evidence.map(evidenceHash);
  const authorization = {
    strategyId: ID, identityHash: identity.identityHash, evidenceIds,
    approvedBy: "operator", approvedAt: "2026-09-28T10:00:00Z",
    expiresAt: "2026-10-03T00:00:00Z",
    review: {
      reviewer: "independent-checker", status: "PASS", identityHash: identity.identityHash,
      evidenceIds, reviewedAt: "2026-09-28T09:00:00Z",
      checks: { costs: true, independentForward: true, risk: true, benchmark: true, execution: true }
    }
  };
  return { identity, authorization, evidence, nowMs: NOW };
}

test("ACTIVE, an automatic approval, and missing evidence do not grant live eligibility", () => {
  assert.equal(evaluatePromotion({ identity, nowMs: NOW }).allowed, false);
  const input = fixture();
  assert.equal(evaluatePromotion(input).allowed, true);
  input.authorization.review.reviewer = "researcher";
  assert.equal(evaluatePromotion(input).allowed, false);
});

test("a process refuses a different disk code identity until restarted", async () => {
  const gate = await loadStrategyGate({ config, strategyId: ID, codeHash: "f".repeat(64) });
  assert.equal(gate.allowed, false);
  assert.ok(gate.reasons.includes("RUNTIME_CODE_CHANGED_RESTART_REQUIRED"));
  assert.equal(gate.identity.codeHash, await runtimeCodeHash());
});

test("binds approval to exact rules, universe, risk limits, cost inputs and runtime code", () => {
  for (const changed of [{ ...config, maxTradeUsdt: 51 }, { ...config, symbols: ["SPY"] }, { ...config, slippagePct: 1 }]) {
    const input = fixture();
    input.identity = strategyIdentity(changed, ID, "a".repeat(64));
    assert.equal(evaluatePromotion(input).allowed, false);
  }
  const input = fixture();
  input.identity = strategyIdentity(config, ID, "c".repeat(64));
  assert.equal(evaluatePromotion(input).allowed, false);
});

test("rejects stale, future, unbound, modified, incomplete and unreviewed evidence", () => {
  const edits = [
    (x) => { x.authorization.expiresAt = "2026-09-28T11:00:00Z"; },
    (x) => { x.authorization.approvedAt = "2026-09-29T11:00:00Z"; },
    (x) => { x.authorization.review.checks.execution = false; },
    (x) => { x.authorization.review.evidenceIds = []; },
    (x) => { x.evidence[0].payload.trades = 99; },
    (x) => { x.evidence.pop(); },
    (x) => { x.authorization.review.status = "WITHHOLD"; }
  ];
  for (const edit of edits) { const input = fixture(); edit(input); assert.equal(evaluatePromotion(input).allowed, false); }
  for (const edit of [
    (e) => { e.identity = null; },
    (e) => { e.validUntil = "2026-09-27T00:00:00Z"; },
    (e) => { e.dataCutoff = "2026-10-01T00:00:00Z"; }
  ]) {
    const input = fixture(); edit(input.evidence[0]);
    input.authorization.evidenceIds = input.evidence.map(evidenceHash);
    input.authorization.review.evidenceIds = [...input.authorization.evidenceIds];
    assert.equal(evaluatePromotion(input).allowed, false);
  }
});

test("archives retain loss and zero-trade results, are idempotent, and detect corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "strategy-evidence-"));
  const record = { schemaVersion: 1, strategyId: ID, kind: "HISTORICAL", identity: null, payload: { pnl: -2, trades: 0 } };
  const first = await archiveEvidence(directory, record);
  assert.equal(await archiveEvidence(directory, record), first);
  assert.deepEqual(JSON.parse(await readFile(join(directory, first + ".json"), "utf8")), record);
  await writeFile(join(directory, first + ".json"), "{}");
  await assert.rejects(archiveEvidence(directory, record), /corrupt/i);
});

test("loads a complete operator grant and fails closed on archive or permission changes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "strategy-grant-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/strategy-governance.mjs"), "// owner reference\n");
  const directory = join(projectRoot, "strategy-governance");
  await mkdir(directory, { mode: 0o755 });
  const input = fixture();
  input.identity = strategyIdentity(config, ID, await runtimeCodeHash());
  input.evidence.forEach((record) => { record.identity = input.identity; });
  input.authorization.identityHash = input.identity.identityHash;
  input.authorization.review.identityHash = input.identity.identityHash;
  input.authorization.evidenceIds = await Promise.all(input.evidence.map((record) => archiveEvidence(join(projectRoot, "state/strategy-evidence"), record)));
  input.authorization.review.evidenceIds = [...input.authorization.evidenceIds];
  const registry = join(directory, "authorizations.json");
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, authorizations: [input.authorization] }), { mode: 0o644 });
  const request = { projectRoot, config, strategyId: ID, nowMs: NOW };
  assert.equal((await loadStrategyGate(request)).allowed, true);
  await chmod(registry, 0o666);
  assert.deepEqual((await loadStrategyGate(request)).reasons, ["GOVERNANCE_READ_ERROR"]);
  await chmod(registry, 0o644);
  await writeFile(join(projectRoot, "state/strategy-evidence", input.authorization.evidenceIds[0] + ".json"), "{}");
  assert.equal((await loadStrategyGate(request)).allowed, false);
});
