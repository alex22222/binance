import assert from "node:assert/strict";
import test from "node:test";
import { Script, createContext, runInContext } from "node:vm";
import { buildDashboardSnapshot } from "../src/dashboard.mjs";
import { liveDashboardHtml } from "../src/live-dashboard-html.mjs";

const ID = "weekly-etf-dual-momentum-defense";
const policy = { allocationPct: 50, cashReservePct: 50, maxSingleLossUsdt: 20 };
const config = {
  mode: "live", defaultStrategyId: ID, weeklyEtfAllocation: policy,
  maxTradeUsdt: 250, maxOpenPositions: 1, dailyLossLimitUsdt: 2, disasterStopLossPct: 8,
  estimatedRoundTripGasUsdt: 0.1, symbols: ["QQQ", "SPY", "SGOV"], pollSeconds: 60,
  maxRoundTripCostPct: 0.7, executionBufferPct: 0.1, minNetEdgePct: 0.1,
  minInitialStopPct: 1, maxInitialStopPct: 3.5, profitProtectionR: 1, finalTakeProfitR: 2
};
const position = {
  strategyId: ID, symbol: "QQQ", quantity: "0.068565", costBasisUsdt: 50,
  initialRiskPct: 1, entryGasUsdt: 0.04, lastQuoteProceedsUsdt: 51.5, shadow: false
};
function snapshot(overrides = {}) {
  return buildDashboardSnapshot({
    config, state: { positions: [position], realizedPnlUsdt: 0 }, traceRecords: [],
    nowMs: Date.parse("2026-10-10T04:00:00Z"), ...overrides
  });
}

class Node {
  children = [];
  text = "";
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(" "); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; this.text = ""; }
}
function riskView(data) {
  const script = liveDashboardHtml().match(/<script>([\s\S]*)<\/script>/)[1];
  new Script(script);
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const context = createContext({ data, document: { createElement: () => new Node(), getElementById: get } });
  runInContext(script.slice(0, script.indexOf('    document.getElementById("stopButton").addEventListener')), context);
  runInContext("renderStrategyRisk(data)", context);
  return get("strategyRisk").textContent;
}

test("weekly allocation snapshot discloses the bounded policy and copies its last plan and top-up status", () => {
  const plan = { targetValueUsdt: 220, cashReserveUsdt: 220, amountUsdt: "150", estimatedLossUsdt: 18.8,
    topUp: true, checkedAt: "2026-10-10T03:59:00Z" };
  const topUps = { request1: { status: "FINISHED", orderId: "filled-1" } };
  const data = snapshot({ state: { positions: [position], realizedPnlUsdt: 0,
    weeklyEtfAllocation: { plan }, allocationTopUps: topUps } });
  assert.deepEqual(data.risk.weeklyEtfAllocation, {
    ...policy, absoluteCostCapUsdt: 250, lossBudgetIsGuaranteed: false,
    portfolioBasis: "AVAILABLE_USDT_PLUS_EXECUTABLE_POSITION_VALUE", plan, topUpRequests: topUps
  });
  data.risk.weeklyEtfAllocation.plan.amountUsdt = "10";
  data.risk.weeklyEtfAllocation.topUpRequests.request1.status = "changed";
  assert.equal(plan.amountUsdt, "150");
  assert.equal(topUps.request1.status, "FINISHED");
  assert.equal(data.risk.dailyLossLimitUsdt, 2);
  assert.equal(data.risk.maxOpenPositions, 1);
});

test("weekly allocation open risk uses the disaster rule and all Gas, not old one-percent ATR metadata", () => {
  const data = snapshot();
  assert.ok(Math.abs(data.position.riskUsdt - 4.09) < 1e-9);
  assert.ok(Math.abs(data.risk.openRiskUsdt - 4.09) < 1e-9);
  assert.ok(Math.abs(data.risk.disasterRiskUsdt - 4.09) < 1e-9);
  assert.equal(data.position.initialRiskPct, 1);
  const toppedUp = snapshot({ state: { positions: [{ ...position, costBasisUsdt: 200, entryGasUsdt: 0.08 }] } });
  assert.ok(Math.abs(toppedUp.position.riskUsdt - 16.13) < 1e-9);
  const actualGas = snapshot({ state: { positions: [position], roundTripGasHistoryUsdt: Array(10).fill(0.04) } });
  assert.ok(Math.abs(actualGas.position.riskUsdt - 4.06) < 1e-9);
  assert.equal(actualGas.strategy.gasEstimateSource, "ACTUAL_P90");
});

test("allocation display and risk changes are isolated from Shadow, other active strategies and missing or invalid policy", () => {
  for (const overrides of [
    { config: { ...config, mode: "shadow" } },
    { strategyControl: { strategyId: "adaptive-momentum" } },
    { config: { ...config, weeklyEtfAllocation: undefined } },
    { config: { ...config, weeklyEtfAllocation: { ...policy, allocationPct: 51 } } }
  ]) {
    const data = snapshot(overrides);
    assert.equal(data.risk.weeklyEtfAllocation, null);
    assert.equal(data.risk.openRiskUsdt, 0.5);
    assert.equal(data.risk.disasterRiskUsdt, 4);
  }
  const shadow = snapshot({ state: { positions: [{ ...position, shadow: true }] } });
  assert.equal(shadow.position.riskUsdt, 0.5);
});

test("weekly risk cards distinguish dynamic target, cash reserve, risk budget and absolute cap from a fixed ticket", () => {
  const data = snapshot({ state: { positions: [position], realizedPnlUsdt: 0,
    weeklyEtfAllocation: { plan: { targetValueUsdt: 220, cashReserveUsdt: 220, amountUsdt: "150", estimatedLossUsdt: 18.8, topUp: true, checkedAt: "2026-10-10T03:59:00Z" } },
    allocationTopUps: { request1: { status: "FINISHED", orderId: "filled-1" } } } });
  const text = riskView(data);
  assert.match(text, /目标持仓 ≤ 50%/);
  assert.match(text, /现金预留 ≥ 50%/);
  assert.match(text, /持仓成本绝对上限 250\.00 USDT/);
  assert.match(text, /不是固定下单金额/);
  assert.match(text, /单次估算风险预算 20\.00 USDT/);
  assert.match(text, /非保证亏损封顶/);
  assert.match(text, /计划补仓 150\.00 USDT/);
  assert.match(text, /目标总值 220\.00 USDT/);
  assert.match(text, /现金预留 220\.00 USDT/);
  assert.match(text, /估算风险 18\.80 USDT/);
  assert.match(text, /一次性补仓.*已完成/);
  assert.match(text, /已实现日亏达到 2\.00 USDT 后禁止新开仓/);
  assert.doesNotMatch(text, /单笔 250\.00 USDT/);
  assert.doesNotMatch(text, /未计退出 Gas\/滑点/);
});

test("missing allocation plans remain unknown, while fixed-ticket strategies keep their original risk cards", () => {
  const text = riskView(snapshot());
  assert.match(text, /等待新鲜余额与可执行卖价/);
  assert.doesNotMatch(text, /计划新开 0\.00|计划补仓 0\.00/);
  const legacy = riskView(snapshot({ config: { ...config, weeklyEtfAllocation: undefined, maxTradeUsdt: 50 } }));
  assert.match(legacy, /单笔 50\.00 USDT/);
  assert.doesNotMatch(legacy, /目标持仓 ≤|现金预留 ≥|单次估算风险预算/);
  const withheld = riskView(snapshot({ state: { weeklyEtfAllocation: { plan: { allowed: false, reason: "ALLOCATION_RESERVE_OR_RISK_LIMIT" } } } }));
  assert.match(withheld, /本次资金计划未通过：ALLOCATION_RESERVE_OR_RISK_LIMIT/);
  assert.doesNotMatch(withheld, /计划新开|计划补仓/);
});
