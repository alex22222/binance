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
    approvalDecisionDirectory: approvalDirectory,
    strategyControlFile: join(directory, "strategy-control.json")
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

    const favicon = await fetch(`${origin}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await favicon.text(), /#f3ba2f/);

    const strategyPage = await fetch(`${origin}/strategies`);
    assert.equal(strategyPage.status, 200);
    assert.match(await strategyPage.text(), /id="strategyComparison"/);

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

    const switched = await fetch(`${origin}/api/strategy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": origin },
      body: JSON.stringify({ strategyId: "executable-basis-reversion" })
    });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).appliesTo, "next_entry");
    const snapshot = await fetch(`${origin}/api/snapshot`).then((response) => response.json());
    assert.equal(snapshot.strategy.activeStrategyId, "executable-basis-reversion");

    const invalidAutoApproval = await fetch(`${origin}/api/auto-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ enabled: true, confirmation: "wrong" })
    });
    assert.equal(invalidAutoApproval.status, 400);

    const enabledAutoApproval = await fetch(`${origin}/api/auto-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ enabled: true, confirmation: "ENABLE_AUTO_APPROVAL" })
    });
    assert.equal(enabledAutoApproval.status, 200);
    assert.equal((await enabledAutoApproval.json()).enabled, true);
    const autoSnapshot = await fetch(`${origin}/api/snapshot`).then((response) => response.json());
    assert.equal(autoSnapshot.autoApproval.enabled, true);

    const automaticRequest = createApprovalRequest({
      side: "BUY",
      symbol: "TSLA",
      address: "0x2222222222222222222222222222222222222222",
      fromToken: "0x55d398326f99059fF775485246999027B3197955",
      toToken: "0x2222222222222222222222222222222222222222",
      fromTokenQty: "50",
      expectedOutputQty: "0.11",
      quoteTimestamp: new Date().toISOString(),
      audit: { status: "TRUSTED" }
    }, {
      createdAt: new Date().toISOString(),
      ttlSeconds: 300
    });
    await writeFile(statePath, `${JSON.stringify({
      ...state,
      approvalRequest: automaticRequest
    }, null, 2)}\n`);
    const blockedManualDecision = await fetch(`${origin}/api/approval-decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": origin
      },
      body: JSON.stringify({
        approvalId: automaticRequest.approvalId,
        decision: "APPROVE",
        confirmation: `APPROVE:${automaticRequest.approvalId}`,
        dyorAcknowledged: true
      })
    });
    assert.equal(blockedManualDecision.status, 409);
    assert.equal(
      (await blockedManualDecision.json()).error,
      "Manual decisions are disabled while automatic approval is enabled"
    );

    const disabledAutoApproval = await fetch(`${origin}/api/auto-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ enabled: false, confirmation: "DISABLE_AUTO_APPROVAL" })
    });
    assert.equal(disabledAutoApproval.status, 200);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
});

test("dashboard protects public access with basic auth and an exact HTTPS origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-dashboard-auth-"));
  const config = JSON.parse(await readFile(resolve("config.example.json"), "utf8"));
  const statePath = join(directory, "state.json");
  const configPath = join(directory, "config.json");
  await writeFile(statePath, `${JSON.stringify({
    date: "2026-07-25",
    realizedPnlUsdt: 0,
    position: null,
    pendingOrder: null,
    approvalRequest: null,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`);
  await writeFile(configPath, `${JSON.stringify({
    ...config,
    stateFile: statePath,
    traceFile: join(directory, "trace.jsonl"),
    emergencyStopFile: join(directory, "EMERGENCY_STOP"),
    emergencyStopHistoryDirectory: join(directory, "stop-history"),
    processLockFile: join(directory, "bot.lock"),
    approvalDecisionDirectory: join(directory, "approvals"),
    strategyControlFile: join(directory, "strategy-control.json")
  }, null, 2)}\n`);

  const port = 41874;
  const origin = `http://127.0.0.1:${port}`;
  const publicOrigin = "https://stocks.example.com";
  const authorization = `Basic ${Buffer.from("operator:server-secret").toString("base64")}`;
  const child = spawn(process.execPath, ["scripts/serve-live-dashboard.mjs"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      BOT_CONFIG: configPath,
      DASHBOARD_PORT: String(port),
      DASHBOARD_USERNAME: "operator",
      DASHBOARD_PASSWORD: "server-secret",
      DASHBOARD_PUBLIC_ORIGIN: publicOrigin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await fetch(`${origin}/health`, {
          headers: { Authorization: authorization }
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
    }
    assert.equal(ready, true);

    const mobileEntry = await fetch(`${origin}/`, { redirect: "manual" });
    assert.equal(mobileEntry.status, 303);
    assert.equal(mobileEntry.headers.get("location"), "/login");

    const loginPage = await fetch(`${origin}/login`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /登录手机 Dashboard/);

    const invalidLogin = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "operator", password: "wrong" })
    });
    assert.equal(invalidLogin.status, 401);
    assert.equal(invalidLogin.headers.get("set-cookie"), null);

    const login = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "operator", password: "server-secret" }),
      redirect: "manual"
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), "/");
    const sessionCookie = login.headers.get("set-cookie");
    assert.match(sessionCookie, /^dashboard_session=/);
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /Secure/);
    assert.match(sessionCookie, /SameSite=Strict/);

    const unauthorized = await fetch(`${origin}/api/snapshot`);
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate"), /Basic/);

    const sessionAuthorized = await fetch(`${origin}/api/snapshot`, {
      headers: { Cookie: sessionCookie.split(";")[0] }
    });
    assert.equal(sessionAuthorized.status, 200);

    const authorized = await fetch(`${origin}/api/snapshot`, {
      headers: { Authorization: authorization }
    });
    assert.equal(authorized.status, 200);

    const connectedLoginAttempt = await fetch(`${origin}/api/wallet-login/start`, {
      method: "POST",
      headers: { Authorization: authorization, Origin: publicOrigin }
    });
    assert.equal(connectedLoginAttempt.status, 409);
    assert.match((await connectedLoginAttempt.json()).error, /confirmed disconnect/);

    const publicOriginRequest = await fetch(`${origin}/api/strategy`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Origin: publicOrigin
      },
      body: JSON.stringify({ strategyId: "adaptive-momentum" })
    });
    assert.equal(publicOriginRequest.status, 200);

    const rejectedOrigin = await fetch(`${origin}/api/strategy`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Origin: "https://attacker.example"
      },
      body: JSON.stringify({ strategyId: "adaptive-momentum" })
    });
    assert.equal(rejectedOrigin.status, 403);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
});
