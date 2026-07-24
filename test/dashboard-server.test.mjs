import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createApprovalRequest } from "../src/approvals.mjs";

test("dashboard records one exact approval without writing the bot state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-dashboard-"));
  const config = JSON.parse(await readFile(resolve("config.example.json"), "utf8"));
  const statePath = join(directory, "state.json");
  const configPath = join(directory, "config.json");
  const approvalDirectory = join(directory, "approvals");
  const createdAt = new Date().toISOString();
  const approvalRequest = createApprovalRequest({
    side: "BUY",
    symbol: "NVDA",
    address: "0x1111111111111111111111111111111111111111",
    fromToken: "0x55d398326f99059fF775485246999027B3197955",
    toToken: "0x1111111111111111111111111111111111111111",
    fromTokenQty: "50",
    expectedOutputQty: "0.42",
    quoteTimestamp: createdAt,
    audit: { status: "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED" }
  }, {
    createdAt,
    ttlSeconds: 300
  });
  const state = {
    date: "2026-07-24",
    realizedPnlUsdt: 0,
    position: null,
    pendingOrder: null,
    approvalRequest,
    updatedAt: createdAt
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(configPath, `${JSON.stringify({
    ...config,
    stateFile: statePath,
    traceFile: join(directory, "trace.jsonl"),
    emergencyStopFile: join(directory, "EMERGENCY_STOP"),
    emergencyStopHistoryDirectory: join(directory, "stop-history"),
    processLockFile: join(directory, "bot.lock"),
    approvalDecisionDirectory: approvalDirectory
  }, null, 2)}\n`);

  const port = 41873;
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["scripts/serve-live-dashboard.mjs"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      BOT_CONFIG: configPath,
      DASHBOARD_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await fetch(`${origin}/api/snapshot`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
    }
    assert.equal(ready, true);

    const invalid = await fetch(`${origin}/api/approval-decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": origin
      },
      body: JSON.stringify({
        approvalId: approvalRequest.approvalId,
        decision: "APPROVE",
        confirmation: "wrong",
        dyorAcknowledged: true
      })
    });
    assert.equal(invalid.status, 400);

    const missingAuditAcknowledgement = await fetch(`${origin}/api/approval-decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": origin
      },
      body: JSON.stringify({
        approvalId: approvalRequest.approvalId,
        decision: "APPROVE",
        confirmation: `APPROVE:${approvalRequest.approvalId}`,
        dyorAcknowledged: true
      })
    });
    assert.equal(missingAuditAcknowledgement.status, 400);
    assert.equal(
      (await missingAuditAcknowledgement.json()).error,
      "Explicit acknowledgment of unavailable security audit required"
    );

    const approved = await fetch(`${origin}/api/approval-decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": origin
      },
      body: JSON.stringify({
        approvalId: approvalRequest.approvalId,
        decision: "APPROVE",
        confirmation: `APPROVE:${approvalRequest.approvalId}`,
        dyorAcknowledged: true,
        auditUnavailableAcknowledged: true
      })
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).status, "APPROVED_PENDING_REVALIDATION");

    const persistedState = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(persistedState, state);
    const decision = JSON.parse(await readFile(join(approvalDirectory, `${approvalRequest.approvalId}.json`), "utf8"));
    assert.equal(decision.decision, "APPROVE");
    assert.equal(decision.dyorAcknowledged, true);
    assert.equal(decision.auditUnavailableAcknowledged, true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
});
