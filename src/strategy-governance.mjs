import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { strategyById } from "./strategy-lab.mjs";

const codeRoot = resolve(import.meta.dirname, "..");
const HASH = /^[a-f0-9]{64}$/;
const CONFIG_FIELDS = [
  "symbols", "entryBlockedSymbols", "maxTradeUsdt", "maxOpenPositions", "dailyLossLimitUsdt",
  "entryIntervalMinutes", "pollSeconds", "reentryCooldownMinutes", "disasterStopLossPct",
  "atrPeriod", "atrStopMultiplier", "entryAtrMultiplier", "minInitialStopPct", "maxInitialStopPct",
  "profitProtectionR", "trailingAtrMultiplier", "finalTakeProfitR", "signalReviewHours",
  "signalReviewMinR", "minDirectionalMinutes", "maxRoundTripCostPct", "slippagePct",
  "executionBufferPct", "estimatedRoundTripGasUsdt", "minNetEdgePct", "regularOnlyEntries",
  "entryCutoffMinutes", "fomcEntryBlackoutDates", "quoteMaxAgeSeconds", "maxQuoteDriftPct",
  "allowUnsupportedAuditForOfficialRwa", "basisExitPct"
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])])
  );
  return value;
}

export const evidenceHash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const contentHash = (value) => createHash("sha256").update(value).digest("hex");

export async function runtimeCodeHash() {
  const names = (await readdir(join(codeRoot, "src"))).filter((name) => !name.startsWith(".") && name.endsWith(".mjs")).sort();
  return evidenceHash(await Promise.all(names.map(async (name) => [name,
    contentHash(await readFile(join(codeRoot, "src", name)))
  ])));
}

// Pin the identity when this process loads its modules. New files on disk must
// never let an old, still-running process borrow a new version's authorization.
const processCodeHash = await runtimeCodeHash();

export function strategyIdentity(config, strategyId, codeHash) {
  const strategy = strategyById(strategyId);
  if (!strategy) throw new Error("Unknown strategy identity");
  const rule = { strategyId, entry: strategy.entry, exit: strategy.exit, timeframe: strategy.timeframe || strategy.horizon };
  const configInputs = Object.fromEntries(CONFIG_FIELDS.map((key) => [key, config[key] ?? null]));
  const identity = {
    strategyId, ruleVersion: evidenceHash(rule), codeHash,
    configHash: evidenceHash(configInputs), universe: [...(config.symbols || [])],
    costModel: {
      model: "LIVE_AMOUNT_QUOTES_PLUS_GAS", maxTradeUsdt: config.maxTradeUsdt ?? null,
      maxRoundTripCostPct: config.maxRoundTripCostPct ?? null,
      executionBufferPct: config.executionBufferPct ?? null,
      estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt ?? null,
      slippagePct: config.slippagePct ?? null, minNetEdgePct: config.minNetEdgePct ?? null
    }
  };
  return { ...identity, identityHash: evidenceHash(identity) };
}

export async function archiveEvidence(directory, record) {
  const id = evidenceHash(record);
  await mkdir(directory, { recursive: true });
  const path = join(directory, id + ".json");
  try {
    await writeFile(path, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o640 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (evidenceHash(JSON.parse(await readFile(path, "utf8"))) !== id) throw new Error("Evidence archive corrupt");
  }
  return id;
}

export async function readEvidence(directory) {
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const name of names.sort().filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    const record = JSON.parse(await readFile(join(directory, name), "utf8"));
    const id = name.slice(0, -5);
    if (evidenceHash(record) !== id) throw new Error("Evidence archive corrupt");
    records.push({ id, record });
  }
  return records;
}

function evaluateExperimentalAuthorization({ identity, authorization, config, nowMs }) {
  const reasons = [];
  const approvedAt = Date.parse(authorization.approvedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  if (identity.strategyId !== "weekly-etf-dual-momentum-defense" || authorization.strategyId !== identity.strategyId ||
      authorization.identityHash !== identity.identityHash) reasons.push("EXPERIMENT_SCOPE_MISMATCH");
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > nowMs || expiresAt <= nowMs ||
      expiresAt <= approvedAt || expiresAt - approvedAt > 7 * 86400000) reasons.push("EXPERIMENT_EXPIRED_OR_INVALID");
  if (typeof authorization.approvedBy !== "string" || !authorization.approvedBy.trim() ||
      typeof authorization.reason !== "string" || !authorization.reason.trim() || authorization.riskAccepted !== true ||
      authorization.review != null || (authorization.evidenceIds != null && (!Array.isArray(authorization.evidenceIds) || authorization.evidenceIds.length))) {
    reasons.push("EXPLICIT_EXPERIMENT_AUTHORIZATION_REQUIRED");
  }
  const ceilings = { maxTradeUsdt: 50, maxOpenPositions: 1, dailyLossLimitUsdt: 2 };
  for (const [key, ceiling] of Object.entries(ceilings)) {
    const limit = authorization.limits?.[key], value = config?.[key];
    if (!Number.isFinite(limit) || limit <= 0 || limit > ceiling ||
        !Number.isFinite(value) || value <= 0 || value > limit ||
        (key === "maxOpenPositions" && (!Number.isInteger(limit) || !Number.isInteger(value)))) {
      reasons.push("EXPERIMENT_LIMIT_INVALID:" + key);
    }
  }
  return {
    allowed: reasons.length === 0, researchStatus: "NOT_QUALIFIED", researchQualified: false,
    authorizationType: "EXPERIMENTAL_EXCEPTION", reasons, identity,
    authorizationId: evidenceHash(authorization), evidenceIds: [], reviewedBy: null,
    approvedBy: authorization.approvedBy || null, approvedAt: authorization.approvedAt,
    expiresAt: authorization.expiresAt, limits: authorization.limits || null,
    limitations: ["RESEARCH_GATES_NOT_PASSED", "USER_ACCEPTED_EXPERIMENTAL_RISK"],
    evaluatedAt: new Date(nowMs).toISOString(), protectiveExitAllowed: true
  };
}

export function evaluatePromotion({ identity, authorization, evidence = [], nowMs = Date.now(), config }) {
  if (authorization?.type === "EXPERIMENTAL_EXCEPTION") return evaluateExperimentalAuthorization({ identity, authorization, config, nowMs });
  const reasons = [];
  const fail = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (!authorization) fail("NO_LIVE_AUTHORIZATION");
  else {
    if (authorization.type != null && authorization.type !== "REVIEWED_EVIDENCE") fail("UNKNOWN_AUTHORIZATION_TYPE");
    const review = authorization.review;
    const reviewedAt = Date.parse(review?.reviewedAt);
    const approvedAt = Date.parse(authorization.approvedAt);
    const expiresAt = Date.parse(authorization.expiresAt);
    if (authorization.strategyId !== identity.strategyId || authorization.identityHash !== identity.identityHash) fail("STRATEGY_VERSION_MISMATCH");
    if (!authorization.approvedBy || !Number.isFinite(approvedAt) || approvedAt > nowMs ||
        !Number.isFinite(expiresAt) || expiresAt <= nowMs || expiresAt <= approvedAt) fail("AUTHORIZATION_EXPIRED_OR_INVALID");
    if (!review || review.status !== "PASS" || !review.reviewer ||
        review.identityHash !== identity.identityHash || !Number.isFinite(reviewedAt) || reviewedAt > approvedAt ||
        !["costs", "independentForward", "risk", "benchmark", "execution"].every((key) => review.checks?.[key] === true)) fail("INDEPENDENT_REVIEW_REQUIRED");
    const ids = authorization.evidenceIds;
    if (!Array.isArray(ids) || ids.length < 3 || new Set(ids).size !== ids.length || !ids.every((id) => HASH.test(id)) ||
        evidenceHash(ids) !== evidenceHash(review?.evidenceIds || [])) fail("REVIEW_EVIDENCE_MISMATCH");
    const records = new Map(evidence.map((record) => [evidenceHash(record), record]));
    const kinds = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
      const record = records.get(id);
      if (!record) { fail("EVIDENCE_MISSING_OR_MODIFIED"); continue; }
      kinds.add(record.kind);
      if (record.schemaVersion !== 1 || record.strategyId !== identity.strategyId ||
          evidenceHash(record.identity) !== evidenceHash(identity)) fail("EVIDENCE_VERSION_UNBOUND");
      const cutoff = Date.parse(record.dataCutoff);
      const generated = Date.parse(record.generatedAt);
      const validUntil = Date.parse(record.validUntil);
      if (![cutoff, generated, validUntil].every(Number.isFinite) || cutoff > generated ||
          generated > reviewedAt || validUntil <= nowMs || validUntil < expiresAt) fail("EVIDENCE_STALE_OR_INVALID");
      if (!record.author || record.author === review?.reviewer) fail("INDEPENDENT_REVIEW_REQUIRED");
      if (!HASH.test(record.sourceHash || "") || !record.costModel || !record.evidenceLevel) fail("EVIDENCE_PROVENANCE_MISSING");
      if (record.kind === "FORWARD" && !["QUOTE_REPLAY", "LIVE_TERMINAL_FILLS"].includes(record.evidenceLevel)) fail("EXECUTABLE_FORWARD_REQUIRED");
    }
    if (!["HISTORICAL", "FORWARD", "PAPER"].every((kind) => kinds.has(kind))) fail("EVIDENCE_COVERAGE_INCOMPLETE");
  }
  return {
    allowed: reasons.length === 0, researchStatus: reasons.length ? "NOT_QUALIFIED" : "REVIEWED_ELIGIBLE",
    researchQualified: reasons.length === 0, authorizationType: authorization ? "REVIEWED_EVIDENCE" : null,
    reasons, identity, authorizationId: authorization ? evidenceHash(authorization) : null,
    evidenceIds: authorization?.evidenceIds || [], reviewedBy: authorization?.review?.reviewer || null,
    approvedBy: authorization?.approvedBy || null, expiresAt: authorization?.expiresAt || null,
    evaluatedAt: new Date(nowMs).toISOString(), protectiveExitAllowed: true
  };
}

// Operator-controlled, not writable by the service user. No Dashboard or research
// writer can publish a grant. Deployment intentionally ships an empty grant set.
async function loadAuthorizations(projectRoot) {
  const directory = join(projectRoot, "strategy-governance");
  const path = join(directory, "authorizations.json");
  const [fileInfo, directoryInfo, owner] = await Promise.all([stat(path), stat(directory), stat(join(projectRoot, "src/strategy-governance.mjs"))]);
  if ([fileInfo, directoryInfo].some((info) => info.uid !== owner.uid || (info.mode & 0o022))) throw new Error("Unsafe authorization permissions");
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.schemaVersion !== 1 || !Array.isArray(value.authorizations)) throw new Error("Invalid authorization registry");
  return value.authorizations;
}

export async function loadStrategyGate({ projectRoot = codeRoot, config, strategyId, nowMs = Date.now(), codeHash }) {
  const identity = strategyIdentity(config, strategyId, processCodeHash);
  try {
    if ((codeHash || await runtimeCodeHash()) !== processCodeHash) return {
      ...evaluatePromotion({ identity, nowMs }), reasons: ["RUNTIME_CODE_CHANGED_RESTART_REQUIRED"]
    };
    const grants = await loadAuthorizations(projectRoot);
    const matches = grants.filter((grant) => grant.strategyId === strategyId);
    if (matches.length > 1) throw new Error("Duplicate live authorization");
    const authorization = matches[0];
    const evidence = [];
    // Read only the referenced immutable objects in the execution hot path.
    for (const id of authorization?.evidenceIds || []) {
      if (!HASH.test(id)) throw new Error("Invalid evidence ID");
      const record = JSON.parse(await readFile(join(projectRoot, "state/strategy-evidence", id + ".json"), "utf8"));
      if (evidenceHash(record) !== id) throw new Error("Evidence archive corrupt");
      evidence.push(record);
    }
    return evaluatePromotion({ identity, authorization, evidence, nowMs, config });
  } catch (error) {
    return { ...evaluatePromotion({ identity, nowMs }), reasons: [error.code === "ENOENT" ? "GOVERNANCE_EVIDENCE_MISSING" : "GOVERNANCE_READ_ERROR"] };
  }
}

export function assertStrategyGate(gate) {
  if (gate?.allowed === true) return gate;
  const error = new Error("Strategy promotion blocked: " + (gate?.reasons || ["GATE_UNAVAILABLE"]).join(", "));
  error.code = "STRATEGY_PROMOTION_BLOCKED";
  error.statusCode = 409;
  throw error;
}

export async function loadApprovalMode(projectRoot, config) {
  try {
    const control = JSON.parse(await readFile(resolve(dirname(resolve(projectRoot, config.stateFile || "state/bot-state.json")), "approval-control.json"), "utf8"));
    if (typeof control.enabled !== "boolean") throw new Error("Invalid approval control");
    return { mode: control.enabled ? "AUTO" : "MANUAL", updatedAt: control.updatedAt || null, updatedBy: control.updatedBy || null };
  } catch (error) {
    return { mode: error.code === "ENOENT" ? "MANUAL" : "UNKNOWN", updatedAt: null, updatedBy: null };
  }
}
