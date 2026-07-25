import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalDecisionPayload,
  approvalMatchesSignal,
  approveSignalThroughDashboard
} from "./dashboard-bridge.mjs";
import { parseSignal } from "./watcher.mjs";

const ADDRESS = "0x992879cd8ce0c312d98648875b5a8d6d042cbf34";
const APPROVAL_ID = "0123456789abcdef01234567";

function signalMessage(event = "APPROVAL REQUIRED") {
  return {
    msg_type: "text",
    body: {
      content: JSON.stringify({
        text: [
          `[Agentic Stock Bot] BUY ${event}`,
          `CRCL ${ADDRESS}`,
          "投入: 50 USDT",
          `审批编号: ${APPROVAL_ID}`
        ].join("\n")
      })
    },
    message_id: "om_test",
    create_time: "1"
  };
}

function approval() {
  return {
    approvalId: APPROVAL_ID,
    side: "BUY",
    symbol: "CRCL",
    address: ADDRESS,
    audit: { status: "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED" }
  };
}

test("parses approval-required and legacy submitted Feishu signals", () => {
  const required = parseSignal(signalMessage());
  assert.equal(required.event, "APPROVAL_REQUIRED");
  assert.equal(required.side, "BUY");
  assert.equal(required.symbol, "CRCL");
  assert.equal(required.address, ADDRESS);
  assert.equal(required.approvalId, APPROVAL_ID);

  const submitted = parseSignal(signalMessage("SUBMITTED SHADOW"));
  assert.equal(submitted.event, "SUBMITTED");
});

test("matches dashboard approvals by side, symbol, address and approval ID", () => {
  const signal = parseSignal(signalMessage());
  assert.deepEqual(approvalMatchesSignal(approval(), signal), {
    matched: true,
    reason: "MATCHED"
  });
  assert.equal(
    approvalMatchesSignal({ ...approval(), symbol: "TSLA" }, signal).reason,
    "SYMBOL_MISMATCH"
  );
  assert.equal(
    approvalMatchesSignal({ ...approval(), approvalId: "aaaaaaaaaaaaaaaaaaaaaaaa" }, signal).reason,
    "APPROVAL_ID_MISMATCH"
  );
});

test("builds the explicit dashboard approval payload", () => {
  assert.deepEqual(approvalDecisionPayload(approval()), {
    approvalId: APPROVAL_ID,
    decision: "APPROVE",
    confirmation: `APPROVE:${APPROVAL_ID}`,
    dyorAcknowledged: true,
    auditUnavailableAcknowledged: true
  });
});

test("dashboard bridge authenticates, matches, and submits exactly once", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/snapshot")) {
      return new Response(JSON.stringify({ approvalRequest: approval() }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ status: "APPROVED_PENDING_REVALIDATION" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const result = await approveSignalThroughDashboard({
    signal: parseSignal(signalMessage()),
    dashboardUrl: "http://127.0.0.1:4173/",
    username: "operator",
    password: "secret",
    fetchImpl
  });

  assert.equal(result.status, "APPROVED");
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].options.headers.Authorization,
    `Basic ${Buffer.from("operator:secret").toString("base64")}`
  );
  assert.deepEqual(JSON.parse(calls[1].options.body), approvalDecisionPayload(approval()));
});

test("dashboard bridge never submits a mismatched approval", async () => {
  let calls = 0;
  const result = await approveSignalThroughDashboard({
    signal: parseSignal(signalMessage()),
    dashboardUrl: "http://127.0.0.1:4173",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        approvalRequest: { ...approval(), address: "0x0000000000000000000000000000000000000000" }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.deepEqual(result, { status: "NOT_READY", reason: "ADDRESS_MISMATCH" });
  assert.equal(calls, 1);
});
