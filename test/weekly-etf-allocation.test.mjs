import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateConfig } from "../src/strategy.mjs";
import { evaluatePromotion, strategyIdentity } from "../src/strategy-governance.mjs";
import {
  allocationPlan, allocationExecutionAllowed, mergeAllocationFill, positionFingerprint,
  topUpEligible
} from "../src/weekly-etf-allocation.mjs";

const ID = "weekly-etf-dual-momentum-defense";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const TOKEN = "0x0cde6936d305d5b34667fc46425e852efd73559a";
const NOW = Date.parse("2026-10-12T14:00:00Z");
const policy = { allocationPct: 50, cashReservePct: 50, maxSingleLossUsdt: 20 };
const base = JSON.parse(await readFile(new URL("../config.example.json", import.meta.url), "utf8"));
const config = { ...base, mode: "live", maxTradeUsdt: 250, weeklyEtfAllocation: policy };
const position = { symbol: "QQQ", address: TOKEN, strategyId: ID, quantity: "0.068565020872654946",
  costBasisUsdt: 50, entryGasUsdt: 0.02, openedAt: "2026-09-15T14:00:00Z", orderId: "original", entryTxHash: "old-tx" };
const snapshot = { cashUsdt: "388.855389427538252054", positionValueUsdt: 51.428338791124084,
  tokenBefore: position.quantity, nativeGasValueUsdt: 5, gasUsdt: 0.042258985136513175,
  checkedAt: new Date(NOW).toISOString(), positionQuotedAt: new Date(NOW).toISOString() };
function fixture() {
  const state = { positions: [{ ...position }], realizedPnlUsdt: 0 };
  const identity = strategyIdentity(config, ID, "a".repeat(64));
  const authorization = { type: "EXPERIMENTAL_EXCEPTION", strategyId: ID, identityHash: identity.identityHash,
    approvedBy: "henry", approvedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 86400000).toISOString(),
    reason: "Explicit 50 percent allocation, 20 U risk budget and one-off current-position top-up", riskAccepted: true,
    limits: { maxTradeUsdt: 250, maxOpenPositions: 1, dailyLossLimitUsdt: 2, weeklyEtfAllocation: policy },
    topUpRequest: { requestId: "one-off-current-qqq", positionHash: positionFingerprint(position) } };
  const gate = evaluatePromotion({ config, identity, authorization, nowMs: NOW });
  const plan = allocationPlan(config, state.positions[0], snapshot);
  const details = { side: "BUY", strategyId: ID, symbol: "QQQ", address: TOKEN, fromToken: USDT, toToken: TOKEN,
    fromTokenQty: plan.amountUsdt, costBasisUsdt: Number(plan.amountUsdt), entryType: "TOP_UP",
    topUpRequestId: authorization.topUpRequest.requestId, allocation: plan,
    tokenBefore: position.quantity, parentOrderId: position.orderId };
  return { state, gate, details, authorization, identity };
}

test("only explicit bounded weekly allocation permits a ticket above 50 U", () => {
  assert.doesNotThrow(() => validateConfig(config));
  for (const changed of [ { ...config, weeklyEtfAllocation: undefined },
    { ...config, defaultStrategyId: "adaptive-momentum" }, { ...config, maxOpenPositions: 2 },
    { ...config, weeklyEtfAllocation: { ...policy, allocationPct: 51 } },
    { ...config, weeklyEtfAllocation: { ...policy, maxSingleLossUsdt: 21 } } ]) {
    assert.throws(() => validateConfig(changed));
  }
});

test("existing executable value counts toward the 50 percent target and total risk caps the increment", () => {
  const plan = allocationPlan(config, position, snapshot);
  assert.equal(plan.allowed, true);
  assert.ok(Number(plan.amountUsdt) <= 168.713);
  assert.ok(plan.cashAfterUsdt >= plan.cashReserveUsdt);
  assert.ok(plan.estimatedLossUsdt <= 20);
  assert.ok(plan.positionCostAfterUsdt <= 250);
  const huge = allocationPlan(config, null, { ...snapshot, cashUsdt: "10000", positionValueUsdt: 0, tokenBefore: "0" });
  assert.ok(Number(huge.amountUsdt) < 250);
  assert.ok(huge.estimatedLossUsdt <= 20);
});

test("bad balances, missing mark, insufficient native gas or a filled allocation never produce a BUY", () => {
  for (const changed of [ { ...snapshot, cashUsdt: "NaN" }, { ...snapshot, positionValueUsdt: null },
    { ...snapshot, nativeGasValueUsdt: 0 }, { ...snapshot, cashUsdt: "40", positionValueUsdt: 60 } ]) {
    assert.equal(allocationPlan(config, position, changed).allowed, false);
  }
});

test("allocation and one-off top-up remain experimental and bound to exact operator permission", () => {
  const f = fixture();
  assert.equal(f.gate.allowed, true);
  assert.equal(f.gate.researchQualified, false);
  assert.equal(topUpEligible(f.state, f.gate, f.state.positions[0]), true);
  for (const edit of [ x => { delete x.authorization.limits.weeklyEtfAllocation; },
    x => { x.authorization.limits.weeklyEtfAllocation = { ...policy, maxSingleLossUsdt: 21 }; },
    x => { x.authorization.topUpRequest.positionHash = "bad"; } ]) {
    const x = fixture(); edit(x);
    assert.equal(evaluatePromotion({ ...x, config, nowMs: NOW }).allowed, false);
  }
  f.state.allocationTopUps = { "one-off-current-qqq": { status: "FINISHED" } };
  assert.equal(topUpEligible(f.state, f.gate, f.state.positions[0]), false);
});

test("frozen amount, exact position, fresh mark, reserve and risk are rechecked before submission", () => {
  const f = fixture();
  assert.equal(allocationExecutionAllowed(config, f.state, f.details, f.gate, snapshot, NOW), true);
  for (const [state, details, data] of [
    [f.state, { ...f.details, fromTokenQty: "220" }, snapshot],
    [f.state, { ...f.details, strategyId: "adaptive-momentum" }, snapshot],
    [f.state, { ...f.details, toToken: USDT }, snapshot],
    [f.state, f.details, { ...snapshot, cashUsdt: "300" }],
    [f.state, f.details, { ...snapshot, tokenBefore: "0.068565020872654947" }],
    [f.state, f.details, { ...snapshot, positionQuotedAt: new Date(NOW - 31000).toISOString() }],
    [{ ...f.state, realizedPnlUsdt: -2 }, f.details, snapshot],
    [{ ...f.state, positions: [...f.state.positions, { ...position, symbol: "SPY" }] }, f.details, snapshot]
  ]) assert.equal(allocationExecutionAllowed(config, state, details, f.gate, data, NOW), false);
});

test("top-up merges exact quantity, costs and Gas into one holding without erasing its original entry", () => {
  const f = fixture();
  const pending = { ...f.details, orderId: "topup-order", createdAt: new Date(NOW).toISOString() };
  const merged = mergeAllocationFill(f.state, pending, "0.280000000000000001", { gasUsdt: 0.03, txHash: "topup-tx", source: "ACTUAL_RECEIPT" });
  assert.equal(f.state.positions.length, 1);
  assert.equal(merged.quantity, "0.280000000000000001");
  assert.equal(merged.costBasisUsdt, 50 + Number(pending.fromTokenQty));
  assert.equal(merged.entryGasUsdt, 0.05);
  assert.equal(merged.orderId, "original");
  assert.equal(merged.entryTxHash, "old-tx");
  assert.equal(merged.openedAt, position.openedAt);
  assert.equal(merged.additions[0].quantity, "0.211434979127345055");
  assert.equal(merged.excursionPartial, true);
  assert.equal(f.state.allocationTopUps[pending.topUpRequestId].status, "FINISHED");
  assert.throws(() => mergeAllocationFill(f.state, pending, merged.quantity, { gasUsdt: 0.03 }), /already|changed/i);
});
