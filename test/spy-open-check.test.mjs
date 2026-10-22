import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSpyCheck, readCheckTrace, deliverCheck } from "../ops/spy-open-check/check.mjs";

const ID = "weekly-etf-dual-momentum-defense";
const at = "2026-10-22T13:45:00.000Z";
function fixture() {
  return {
    observedAt: at, openAt: "2026-10-22T13:30:00.000Z", dueAt: at,
    config: { mode: "live", dailyLossLimitUsdt: 2, maxTradeUsdt: 250 },
    control: { strategyId: ID, entriesPaused: false },
    state: { updatedAt: at, positions: [], realizedPnlUsdt: 0, date: "2026-10-22" },
    gate: { allowed: true, reasons: [], limits: { weeklyEtfAllocation: {} } }, stop: null,
    policy: { regularOpen: true, newYorkDate: "2026-10-22", weeklyTarget: "SPY", weeklyDecisionUsable: true, fomcAllowed: true, symbolAllowed: true, cooldownActive: false },
    trace: { complete: true, successfulCycles: 5, fills: [], submissions: [], lastCycle: { status: "succeeded", timestamp: at }, blockers: [], malformedLines: 0 }
  };
}
const fill = () => ({ timestamp: at, orderId: "B1", symbol: "SPY", strategyId: ID, quantity: "0.3", costBasisUsdt: 200 });

test("a submitted intent or pending order is not a confirmed BUY", () => {
  const x = fixture(); x.state.pendingOrder = { side: "BUY", symbol: "SPY", status: "SUBMITTED" };
  x.trace.submissions = [{ timestamp: at, orderId: "B1", symbol: "SPY" }];
  assert.equal(analyzeSpyCheck(x).status, "IN_FLIGHT");
});
test("a fresh matching terminal BUY and exact held quantity confirm the fill", () => {
  const x = fixture(); x.trace.fills = [fill()];
  x.state.positions = [{ ...fill(), quantity: "0.3000", shadow: false }];
  assert.equal(analyzeSpyCheck(x).status, "CONFIRMED_BUY");
});
test("an old fill, shadow holding, mismatched order, or balance mismatch cannot confirm tonight", () => {
  for (const edit of [
    x => { x.trace.fills[0].timestamp = "2026-10-21T13:45:00Z"; },
    x => { x.state.positions[0].shadow = true; },
    x => { x.state.positions[0].orderId = "OTHER"; },
    x => { x.state.positions[0].quantity = "0.31"; },
    x => { x.trace.fills[0].costBasisUsdt = null; }
  ]) {
    const x = fixture(); x.trace.fills = [fill()]; x.state.positions = [{ ...fill(), shadow: false }]; edit(x);
    assert.notEqual(analyzeSpyCheck(x).status, "CONFIRMED_BUY");
  }
});
test("missing or partial evidence and stale heartbeat stay UNKNOWN, not zero trades", () => {
  for (const edit of [x => { x.trace.complete = false; }, x => { x.trace.successfulCycles = 0; }, x => { x.state.updatedAt = "2026-10-22T13:00:00Z"; }]) {
    const x = fixture(); edit(x); assert.equal(analyzeSpyCheck(x).status, "UNCONFIRMED");
  }
});
test("an expired grant explains no BUY but valid governance alone does not prove a cause", () => {
  const x = fixture(); x.gate = { allowed: false, reasons: ["EXPERIMENT_EXPIRED_OR_INVALID"] };
  assert.equal(analyzeSpyCheck(x).reason, "AUTHORIZATION_BLOCKED");
  assert.equal(analyzeSpyCheck(fixture()).reason, "NO_EXPLICIT_BLOCKER_RECORDED");
});
test("risk and target checks remain distinct and do not revive consumed top-ups", () => {
  const x = fixture(); x.state.realizedPnlUsdt = -7.59;
  assert.equal(analyzeSpyCheck(x).reason, "DAILY_LOSS_LIMIT");
  x.state.realizedPnlUsdt = 0; x.policy.weeklyTarget = "CASH";
  assert.equal(analyzeSpyCheck(x).reason, "WEEKLY_TARGET_NOT_SPY");
});
test("a failed latest cycle is an operational failure, not successful monitoring", () => {
  const x = fixture(); x.trace.lastCycle = { status: "failed", timestamp: at, error: "REQUEST_TIMEOUT" };
  assert.equal(analyzeSpyCheck(x).reason, "LATEST_CYCLE_FAILED");
});
test("a delayed one-shot does not pass off tomorrow's state as the opening check", () => {
  const x = fixture(); x.observedAt = "2026-10-23T13:45:00Z"; x.state.updatedAt = x.observedAt;
  x.trace.fills = [{ ...fill(), timestamp: x.observedAt }]; x.state.positions = [{ ...x.trace.fills[0], shadow: false }];
  assert.equal(analyzeSpyCheck(x).reason, "CHECK_DELAYED");
});
test("invalid exact quantities never match each other", () => {
  const x = fixture(); x.trace.fills = [{ ...fill(), quantity: "3e-1" }];
  x.state.positions = [{ ...fill(), quantity: "9e-1", shadow: false }];
  assert.notEqual(analyzeSpyCheck(x).status, "CONFIRMED_BUY");
});
test("stale evidence with approval, stale cycles and unmatched holdings remain unconfirmed", () => {
  for (const edit of [
    x => { x.trace.complete = false; x.state.approvalRequest = { side: "BUY", symbol: "SPY" }; },
    x => { x.trace.lastCycle.timestamp = "2026-10-22T13:30:00Z"; },
    x => { x.state.positions = [{ ...fill(), shadow: false }]; }
  ]) { const x = fixture(); edit(x); assert.equal(analyzeSpyCheck(x).status, "UNCONFIRMED"); }
});
test("a blocker from an old cycle cannot be reused as tonight's current cause", () => {
  const x = fixture(); x.trace.lastCycle.cycleId = "new";
  x.trace.blockers = [{ cycleId: "old", timestamp: at, reason: "COST_GATE", detail: "old" }];
  assert.equal(analyzeSpyCheck(x).reason, "NO_EXPLICIT_BLOCKER_RECORDED");
});
test("collector scans the complete file, deduplicates fills, and flags conflicting final records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spy-check-test-")), path = join(dir, "trace.jsonl");
  const row = { timestamp: at, event: "pending_order", status: "finished", cycleId: "C1", details: { ...fill(), side: "BUY" } };
  await writeFile(path, [{ timestamp: "2026-10-21T00:00:00Z", event: "cycle", status: "succeeded" }, row, row,
    { timestamp: at, event: "cycle", status: "succeeded", cycleId: "C1", details: {} }].map(JSON.stringify).join("\n") + "\n");
  const trace = await readCheckTrace(path, "2026-10-22T13:30:00Z", at);
  assert.equal(trace.fills.length, 1); assert.equal(trace.complete, true);
  await writeFile(path, JSON.stringify({ ...row, details: { ...row.details, quantity: "0.4" } }) + "\n", { flag: "a" });
  assert.equal((await readCheckTrace(path, "2026-10-22T13:30:00Z", at)).complete, false);
});
test("unavailable traces are explicit evidence failures", async () => {
  const trace = await readCheckTrace("/nonexistent/spy-check-trace", "2026-10-22T13:30:00Z", at);
  assert.equal(trace.complete, false); assert.ok(trace.errors.length);
});
test("notification is archived before send, receipt backed and sent only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spy-delivery-test-")); let calls = 0;
  const send = async (text, uuid) => { calls++; assert.ok(uuid); assert.equal(await readFile(join(directory, "scheduled.message.txt"), "utf8"), text); assert.equal(JSON.parse(await readFile(join(directory, "scheduled.report.json"))).status, "UNCONFIRMED"); assert.equal(JSON.parse(await readFile(join(directory, "scheduled.receipt.json"))).status, "SENDING"); return { channel: "app", messageId: "M1" }; };
  const args = { directory, kind: "scheduled", report: analyzeSpyCheck(fixture()), text: "SPY 核验：原因未确认", send };
  assert.equal((await deliverCheck(args)).status, "SENT");
  await deliverCheck(args); assert.equal(calls, 1);
});
test("an uncertain delivery is preserved and never blindly resent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spy-delivery-test-")); let calls = 0;
  const args = { directory, kind: "scheduled", report: analyzeSpyCheck(fixture()), text: "核验", send: async () => { calls++; throw Error("network"); } };
  await assert.rejects(deliverCheck(args));
  assert.equal(JSON.parse(await readFile(join(directory, "scheduled.receipt.json"))).status, "SENDING");
  await assert.rejects(deliverCheck(args), /Uncertain delivery/); assert.equal(calls, 1);
});
test("a missing business receipt never becomes SENT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spy-delivery-test-"));
  await assert.rejects(deliverCheck({ directory, kind: "scheduled", report: {}, text: "核验", send: async () => ({ channel: "app" }) }), /Missing Feishu/);
  assert.equal(JSON.parse(await readFile(join(directory, "scheduled.receipt.json"))).status, "SENDING");
});
