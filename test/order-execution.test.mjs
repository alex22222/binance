import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createApprovalRequest, recordApprovalDecision } from "../src/approvals.mjs";
import { createOrderExecution } from "../src/order-execution.mjs";
import { activateEmergencyStop, readEmergencyStop } from "../src/reliability.mjs";

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const TOKEN = "0x0cde6936d305d5b34667fc46425e852efd73559a";
const LIVE = { mode: "live", slippagePct: 0.5 };
const CREATED_AT = "2026-09-28T14:00:00.000Z";

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function harness({ nowMs = Date.parse(CREATED_AT), bawHandler, onTrace, shutdown = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "order-execution-"));
  const paths = {
    state: join(directory, "bot-state.json"),
    emergencyStop: join(directory, "EMERGENCY_STOP"),
    decisions: join(directory, "approval-decisions")
  };
  const calls = [];
  const traces = [];
  const clock = { nowMs };
  const execution = createOrderExecution({
    baw: async (args, options = {}) => {
      calls.push({ args, options });
      return bawHandler(args, options);
    },
    saveJson,
    trace: async (stage, status, details) => {
      traces.push({ stage, status, details });
      await onTrace?.({ stage, status, details, paths });
    },
    readEmergencyStop,
    isShutdownRequested: () => shutdown,
    now: () => clock.nowMs
  });
  return { execution, paths, calls, traces, clock };
}

function buyDetails(overrides = {}) {
  return {
    side: "BUY",
    symbol: "QQQ",
    address: TOKEN,
    fromToken: USDT,
    toToken: TOKEN,
    fromTokenQty: 50,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function swapCalls(calls) {
  return calls.filter(({ args }) => args[1] === "swap");
}

function listedOrder(orderId, overrides = {}) {
  return { orderId, fromToken: USDT, toToken: TOKEN, fromTokenQty: "50", ...overrides };
}

test("persists the intent before the swap and records the submitted order after it", async () => {
  let stateAtSwap = null;
  const { execution, paths, calls } = await harness({
    bawHandler: async (args) => {
      stateAtSwap = await loadJson(paths.state);
      return { orderId: "order-1" };
    }
  });
  const state = {};

  const result = await execution.submitOrder(LIVE, state, paths.state, paths.emergencyStop, buyDetails());

  assert.equal(result.orderId, "order-1");
  assert.equal(stateAtSwap.pendingOrder.status, "SUBMITTING");
  assert.match(stateAtSwap.pendingOrder.intentId, /^[a-f0-9]{24}$/);
  const [swap] = swapCalls(calls);
  assert.deepEqual(swap.options, { stateChanging: true });
  assert.deepEqual(swap.args.slice(2, 8), ["--fromTokenQty", "50", "--fromToken", USDT, "--toToken", TOKEN]);
  const saved = await loadJson(paths.state);
  assert.equal(saved.pendingOrder.status, "SUBMITTED");
  assert.equal(saved.pendingOrder.orderId, "order-1");
  assert.equal(saved.pendingOrder.intentId, stateAtSwap.pendingOrder.intentId);
});

test("a failed swap is marked AMBIGUOUS, never retried, and reconciles to the single matching order after restart", async () => {
  const first = await harness({
    bawHandler: async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
  });
  await assert.rejects(
    first.execution.submitOrder(LIVE, {}, first.paths.state, first.paths.emergencyStop, buyDetails()),
    /socket hang up/
  );
  assert.equal(swapCalls(first.calls).length, 1);
  const persisted = await loadJson(first.paths.state);
  assert.equal(persisted.pendingOrder.status, "AMBIGUOUS");
  assert.equal(persisted.pendingOrder.lastError, "socket hang up");
  assert.ok(first.traces.some(({ stage, status }) => stage === "order_submission" && status === "ambiguous"));

  const restartedAtMs = Date.parse(CREATED_AT) + 90_000;
  const restarted = createOrderExecution({
    baw: async (args) => {
      assert.equal(args[1], "list");
      return { list: [listedOrder("order-7"), listedOrder("other", { fromTokenQty: "10" })] };
    },
    saveJson,
    trace: async () => {},
    readEmergencyStop,
    now: () => restartedAtMs
  });
  const state = await loadJson(first.paths.state);

  assert.equal(await restarted.recoverPendingOrder(state, first.paths.state), "POLL");
  const reconciled = await loadJson(first.paths.state);
  assert.equal(reconciled.pendingOrder.status, "SUBMITTED");
  assert.equal(reconciled.pendingOrder.orderId, "order-7");
  assert.equal(reconciled.pendingOrder.reconciledAt, new Date(restartedAtMs).toISOString());
});

test("reconciliation searches from one minute before the intent to now", async () => {
  const nowMs = Date.parse(CREATED_AT) + 5 * 60_000;
  const { execution, paths, calls } = await harness({
    nowMs,
    bawHandler: async () => ({ list: [listedOrder("order-1")] })
  });
  const state = { pendingOrder: { ...buyDetails(), fromTokenQty: "50", intentId: "i", status: "AMBIGUOUS" } };

  await execution.recoverPendingOrder(state, paths.state);

  const args = calls[0].args;
  assert.equal(args[args.indexOf("--startTime") + 1], String(Date.parse(CREATED_AT) - 60_000));
  assert.equal(args[args.indexOf("--endTime") + 1], String(nowMs));
});

for (const [label, list, reason, matchCount] of [
  ["no matching order", [listedOrder("x", { toToken: USDT })], "NO_MATCHING_ORDER", 0],
  ["multiple matching orders", [listedOrder("a"), listedOrder("b")], "MULTIPLE_MATCHING_ORDERS", 2]
]) {
  test(`reconciliation with ${label} requires review and then halts without further wallet calls`, async () => {
    const { execution, paths, calls, traces } = await harness({ bawHandler: async () => ({ list }) });
    const state = { pendingOrder: { ...buyDetails(), fromTokenQty: "50", intentId: "i", status: "SUBMITTING", orderId: null } };

    assert.equal(await execution.recoverPendingOrder(state, paths.state), "REVIEW_REQUIRED");
    const saved = await loadJson(paths.state);
    assert.equal(saved.pendingOrder.status, "REVIEW_REQUIRED");
    assert.equal(saved.pendingOrder.reviewReason, reason);
    assert.equal(saved.pendingOrder.orderId, null);
    assert.equal(traces.at(-1).details.matchCount, matchCount);

    const callsBefore = calls.length;
    assert.equal(await execution.recoverPendingOrder(saved, paths.state), "HALTED");
    assert.equal(calls.length, callsBefore);
  });
}

test("an emergency stop raised after the intent is persisted cancels it without submitting", async () => {
  const { execution, paths, calls, traces } = await harness({
    bawHandler: async () => assert.fail("swap must not be called"),
    onTrace: async ({ stage, status, paths: { emergencyStop } }) => {
      if (stage === "order_intent" && status === "persisted") {
        await activateEmergencyStop(emergencyStop, { reason: "operator test" });
      }
    }
  });
  const state = {};

  await assert.rejects(
    execution.submitOrder(LIVE, state, paths.state, paths.emergencyStop, buyDetails()),
    (error) => error.code === "EMERGENCY_STOP"
  );

  assert.equal(swapCalls(calls).length, 0);
  assert.equal((await loadJson(paths.state)).pendingOrder, null);
  assert.equal(state.emergencyStop.reason, "operator test");
  assert.ok(traces.some(({ stage, status, details }) => (
    stage === "order_intent" && status === "cancelled" && details.reason === "EMERGENCY_STOP"
  )));
});

test("an active emergency stop or shutdown blocks before any intent is written", async () => {
  const stopped = await harness({ bawHandler: async () => assert.fail("no wallet call") });
  await activateEmergencyStop(stopped.paths.emergencyStop, { reason: "halt" });
  await assert.rejects(
    stopped.execution.submitOrder(LIVE, {}, stopped.paths.state, stopped.paths.emergencyStop, buyDetails()),
    (error) => error.code === "EMERGENCY_STOP"
  );
  await assert.rejects(readFile(stopped.paths.state), { code: "ENOENT" });

  const shuttingDown = await harness({ shutdown: true, bawHandler: async () => assert.fail("no wallet call") });
  await assert.rejects(
    shuttingDown.execution.submitOrder(LIVE, {}, shuttingDown.paths.state, shuttingDown.paths.emergencyStop, buyDetails()),
    (error) => error.code === "SHUTDOWN_REQUESTED"
  );
  await assert.rejects(readFile(shuttingDown.paths.state), { code: "ENOENT" });
});

test("shadow mode simulates the order without an intent or wallet call", async () => {
  const { execution, paths, calls, traces } = await harness({ bawHandler: async () => assert.fail("no wallet call") });
  const state = {};

  const result = await execution.submitOrder({ mode: "shadow" }, state, paths.state, paths.emergencyStop, buyDetails());

  assert.equal(result.shadow, true);
  assert.equal(state.pendingOrder, undefined);
  assert.equal(calls.length, 0);
  assert.equal(traces[0].status, "simulated");
});

async function approvalHarness({ decision, consumeAtSeconds }) {
  const context = await harness({ bawHandler: async () => assert.fail("no wallet call") });
  const request = createApprovalRequest(buyDetails(), { createdAt: CREATED_AT, ttlSeconds: 300 });
  if (decision) {
    await recordApprovalDecision(context.paths.decisions, request, {
      approvalId: request.approvalId,
      decision,
      dyorAcknowledged: true,
      decidedAt: new Date(Date.parse(CREATED_AT) + 60_000).toISOString()
    });
  }
  context.clock.nowMs = Date.parse(CREATED_AT) + consumeAtSeconds * 1000;
  const state = { approvalRequest: request };
  const outcome = await context.execution.resolveApprovalRequest(state, context.paths.state, context.paths.decisions);
  return { ...context, request, state, outcome };
}

test("an approval that is still undecided stays pending and is not persisted", async () => {
  const { outcome, state, request, paths } = await approvalHarness({ consumeAtSeconds: 30 });
  assert.equal(outcome.status, "WAITING");
  assert.equal(state.approvalRequest, request);
  await assert.rejects(readFile(paths.state), { code: "ENOENT" });
});

test("an approval granted in time but consumed after expiry is closed as EXPIRED", async () => {
  const { outcome, paths, traces, request } = await approvalHarness({ decision: "APPROVE", consumeAtSeconds: 301 });
  assert.equal(outcome.status, "EXPIRED");
  const saved = await loadJson(paths.state);
  assert.equal(saved.approvalRequest, null);
  assert.equal(saved.lastApprovalDecision.status, "EXPIRED");
  assert.equal(saved.lastApprovalDecision.approvalId, request.approvalId);
  assert.equal(traces.at(-1).status, "closed");
});

test("an approval consumed within its window is approved once and cleared", async () => {
  const { outcome, paths, traces, state } = await approvalHarness({ decision: "APPROVE", consumeAtSeconds: 120 });
  assert.equal(outcome.status, "APPROVED");
  const saved = await loadJson(paths.state);
  assert.equal(saved.approvalRequest, null);
  assert.equal(saved.lastApprovalDecision.decidedAt, new Date(Date.parse(CREATED_AT) + 60_000).toISOString());
  assert.equal(traces.at(-1).status, "approved");
  assert.equal(state.approvalRequest, null);
});

test("a rejected approval is closed without execution", async () => {
  const { outcome, paths, calls } = await approvalHarness({ decision: "REJECT", consumeAtSeconds: 120 });
  assert.equal(outcome.status, "REJECTED");
  assert.equal((await loadJson(paths.state)).lastApprovalDecision.status, "REJECTED");
  assert.equal(calls.length, 0);
});
