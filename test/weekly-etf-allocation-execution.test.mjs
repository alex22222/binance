import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createWeeklyEtfAllocationExecution } from "../src/weekly-etf-allocation-execution.mjs";
import { createOrderExecution } from "../src/order-execution.mjs";
import { mergeAllocationFill, positionFingerprint } from "../src/weekly-etf-allocation.mjs";

const ID = "weekly-etf-dual-momentum-defense";
const TOKEN = "0x0cde6936d305d5b34667fc46425e852efd73559a";
const base = JSON.parse(await readFile(new URL("../config.example.json", import.meta.url), "utf8"));
const config = { ...base, mode: "live", activeStrategyId: ID, maxTradeUsdt: 250,
  weeklyEtfAllocation: { allocationPct: 50, cashReservePct: 50, maxSingleLossUsdt: 20 } };
function harness() {
  const clock = { nowMs: Date.parse("2026-10-12T14:00:00Z") };
  const position = { symbol: "QQQ", strategyId: ID, address: TOKEN, quantity: "0.068565020872654946",
    costBasisUsdt: 50, entryGasUsdt: 0.02, entryGasSource: "ACTUAL_RECEIPT", openedAt: "2026-09-21T14:00:00Z", orderId: "B1" };
  const state = { positions: [position], realizedPnlUsdt: 0,
    weeklyEtfLive: { week: "2026-10-12", decision: { target: "QQQ", signalDate: "2026-10-09" } } };
  const gate = { allowed: true, authorizationType: "EXPERIMENTAL_EXCEPTION", authorizationId: "G1", identity: { identityHash: "H1" },
    limits: { maxTradeUsdt: 250, maxOpenPositions: 1, dailyLossLimitUsdt: 2, weeklyEtfAllocation: config.weeklyEtfAllocation },
    topUpRequest: { requestId: "once", positionHash: positionFingerprint(position) } };
  const snapshot = { cashUsdt: "388.855389427538252054", positionValueUsdt: 51.428, tokenBefore: position.quantity,
    nativeGasValueUsdt: 5, gasUsdt: 0.04 };
  const settings = { quotaLeft: 1000, sessionExpireTime: "2026-10-13T14:00:00Z" };
  const auditResult = { allowed: true, status: "LOW" };
  const effects = { approvals: [], swaps: [], saves: [], traces: [], snapshots: 0 };
  let execution;
  const runner = createWeeklyEtfAllocationExecution({
    now: () => clock.nowMs,
    loadDecision: async () => state.weeklyEtfLive.decision,
    loadGate: async () => structuredClone(gate),
    loadSnapshot: async () => { effects.snapshots++; return { ...snapshot, checkedAt: new Date(clock.nowMs).toISOString(), positionQuotedAt: new Date(clock.nowMs).toISOString() }; },
    resolveAsset: async () => ({ contractAddress: TOKEN }),
    assetStatus: async () => ({ openState: true, reasonCode: "TRADING", marketStatus: "regular" }),
    buildCandidate: async (_s, _a, cfg) => ({ buyQuantity: String(cfg.maxTradeUsdt / 750),
      buyQuotedAt: new Date(clock.nowMs).toISOString(), roundTripCostPct: 0.2,
      grossEdgeProxyPct: 2, finalTakeProfitPct: 2, atr15Pct: 0.5, costCoverage: { allowed: true, allInCostPct: 0.35 } }),
    quote: async (qty, from) => ({ toCoinAmount: String(from === TOKEN ? Number(qty) * 750 * 0.998 : Number(qty) / 750), quotedAt: new Date(clock.nowMs).toISOString() }),
    audit: async () => { await effects.onAudit?.(); return auditResult; },
    walletSettings: async () => settings,
    requestApproval: async (_c, _s, _p, details) => effects.approvals.push(structuredClone(details)),
    submitOrder: (...args) => execution.submitOrder(...args),
    trace: async (...args) => effects.traces.push(args)
  });
  execution = createOrderExecution({ now: () => clock.nowMs,
    readEmergencyStop: async () => null, authorizeEntry: async () => gate,
    revalidateAllocation: runner.revalidate,
    saveJson: async (_p, value) => effects.saves.push(structuredClone(value)),
    trace: async (...args) => effects.traces.push(args),
    baw: async args => { effects.swaps.push(args); return { orderId: "B2" }; } });
  return { clock, state, position, gate, snapshot, settings, auditResult, effects, runner };
}
async function approve(h) {
  await h.runner.run(config, h.state, "state", "stop");
  assert.equal(h.effects.approvals.length, 1);
  return { ...h.effects.approvals[0], approvalId: "A1" };
}

test("existing holding follows approval, two independent submission checks, and one exact merged fill", async () => {
  const h = harness(), approved = await approve(h);
  assert.equal(approved.entryType, "TOP_UP");
  assert.ok(Number(approved.fromTokenQty) > 160 && Number(approved.fromTokenQty) < 169);
  await h.runner.run(config, h.state, "state", "stop", approved);
  assert.equal(h.effects.swaps.length, 1);
  assert.equal(h.effects.swaps[0][3], approved.fromTokenQty);
  assert.equal(h.state.pendingOrder.status, "SUBMITTED");
  assert.equal(h.effects.saves[0].pendingOrder.status, "SUBMITTING");
  assert.ok(h.effects.snapshots >= 6, "independent fresh balances before intent and before swap");
  mergeAllocationFill(h.state, h.state.pendingOrder, "0.28", { gasUsdt: 0.02, source: "ACTUAL_RECEIPT" });
  h.state.pendingOrder = null;
  await h.runner.run(config, h.state, "state", "stop");
  assert.equal(h.effects.approvals.length, 1, "no continual re-top-up");
});

test("weekend, changed target, CASH, used request and paused governance have no approval or swap", async () => {
  for (const alter of [
    h => { h.clock.nowMs = Date.parse("2026-10-10T14:00:00Z"); },
    h => { h.state.weeklyEtfLive.decision.target = "SPY"; },
    h => { h.state.weeklyEtfLive.decision.target = "CASH"; },
    h => { h.state.allocationTopUps = { once: { status: "FAILED" } }; },
    h => { h.gate.allowed = false; },
    h => { h.state.realizedPnlUsdt = -2; },
    h => { h.state.weeklyEtfLive.skipEntryWeek = "2026-10-12"; }
  ]) {
    const h = harness(); alter(h);
    await h.runner.run(config, h.state, "state", "stop");
    assert.equal(h.effects.approvals.length, 0);
    assert.equal(h.effects.swaps.length, 0);
  }
});

test("cash spent after approval, expired wallet, inadequate quota and revoked audit all block", async () => {
  for (const alter of [
    h => { h.snapshot.cashUsdt = "300"; },
    h => { h.settings.sessionExpireTime = "2026-10-11T14:00:00Z"; },
    h => { h.settings.quotaLeft = 50; },
    h => { h.auditResult.allowed = false; },
    h => { h.gate.authorizationId = "changed"; }
  ]) {
    const h = harness(), approved = await approve(h); alter(h);
    try { await h.runner.run(config, h.state, "state", "stop", approved); }
    catch (error) { assert.equal(error.code, "STRATEGY_PROMOTION_BLOCKED"); }
    assert.equal(h.effects.swaps.length, 0);
    assert.ok(!h.state.pendingOrder);
  }
});

test("loss of cash between persisted intent and swap cancels known-not-submitted intent", async () => {
  const h = harness(), approved = await approve(h);
  const push = h.effects.traces.push.bind(h.effects.traces);
  h.effects.traces.push = (...items) => {
    if (items.some(item => item[0] === "order_intent" && item[1] === "persisted")) h.snapshot.cashUsdt = "300";
    return push(...items);
  };
  await assert.rejects(h.runner.run(config, h.state, "state", "stop", approved), { code: "STRATEGY_PROMOTION_BLOCKED" });
  assert.equal(h.effects.swaps.length, 0);
  assert.equal(h.state.pendingOrder, null);
  assert.ok(h.effects.traces.some(([event, status]) => event === "order_intent" && status === "cancelled"));
});

test("new empty-position allocation is allowed without reusing a top-up permission", async () => {
  const h = harness();
  h.state.positions = [];
  h.snapshot.positionValueUsdt = 0; h.snapshot.tokenBefore = "0";
  const approved = await approve(h);
  assert.equal(approved.entryType, "NEW_POSITION");
  assert.equal(approved.topUpRequestId, null);
  assert.ok(Number(approved.fromTokenQty) <= Number(h.snapshot.cashUsdt) / 2);
  await h.runner.run(config, h.state, "state", "stop", approved);
  assert.equal(h.effects.swaps.length, 1);
});

test("governance revoked during slow pre-trade IO is reloaded at the final boundary", async () => {
  const h = harness(), approved = await approve(h);
  h.effects.onAudit = () => { h.gate.allowed = false; };
  assert.equal(await h.runner.revalidate(config, h.state, approved, structuredClone(h.gate)), false);
});
