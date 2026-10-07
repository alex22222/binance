import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
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
      DASHBOARD_PORT: String(port),
      DASHBOARD_MARKET_INDEX_DISABLED: "1",
      DASHBOARD_STOCK_MARKET_DISABLED: "1",
      DASHBOARD_WALLET_BALANCE_DISABLED: "1",
      TRADE_REVIEW_DIR: join(directory, "trade-reviews"),
      FUND_MANAGER_DIR: join(directory, "fund-manager"),
      WEEKLY_RESEARCH_DIR: join(directory, "weekly-research"),
      BTC_RADAR_DIR: join(directory, "btc-radar")
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

    const researchResponse = await fetch(`${origin}/api/strategy-research`);
    assert.equal(researchResponse.status, 200);
    assert.equal(researchResponse.headers.get("cache-control"), "no-store");
    const research = await researchResponse.json();
    assert.equal(research.strategies.length, 12);
    assert.equal(research.trace.status, "MISSING");
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);

    const reviewPage = await fetch(`${origin}/reviews`);
    assert.equal(reviewPage.status, 200);
    assert.match(await reviewPage.text(), /id="dailyMetrics"/);

    const managerPage = await fetch(`${origin}/fund-manager`);
    assert.equal(managerPage.status, 200);
    assert.match(managerPage.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(await managerPage.text(), /日报尚未生成/);
    assert.equal((await fetch(`${origin}/fund-manager?date=invalid`)).status, 400);

    const weeklyPage = await fetch(`${origin}/weekly-strategy`);
    assert.equal(weeklyPage.status, 200);
    assert.match(await weeklyPage.text(), /周报尚未生成/);
    assert.equal((await fetch(`${origin}/api/weekly-strategy`).then((response) => response.json())).available, false);
    assert.equal((await fetch(`${origin}/weekly-strategy?week=invalid`)).status, 400);

    const radarPage = await fetch(`${origin}/btc-radar`);
    assert.equal(radarPage.status, 200);
    const radarPolicy = radarPage.headers.get("content-security-policy");
    const radarNonce = radarPolicy.match(/script-src 'nonce-([^']+)'/)[1];
    const radarHtml = await radarPage.text();
    assert.ok(radarHtml.includes(`<script nonce="${radarNonce}">`));
    assert.match(radarPolicy, /default-src 'none'.*connect-src 'self'.*frame-ancestors 'none'/);
    assert.match(radarHtml, /href="\/btc-radar" aria-current="page"/);
    const nextRadarPolicy = (await fetch(`${origin}/btc-radar`)).headers.get("content-security-policy");
    assert.notEqual(nextRadarPolicy, radarPolicy);
    assert.deepEqual(await fetch(`${origin}/api/btc-radar`).then((response) => response.json()), { status: "MISSING", latest: null, history: [], settings: {} });
    await mkdir(join(directory, "btc-radar"), { recursive: true });
    await writeFile(join(directory, "btc-radar", "latest.json"), JSON.stringify({ ts: "2026-10-01T21:43:00+08:00", score: 63.5, level: "orange" }));
    await writeFile(join(directory, "btc-radar", "history.json"), JSON.stringify([{ ts: "2026-10-01T21:43:00+08:00", price: 83555.9, score: 63.5 }]));
    const radarResponse = await fetch(`${origin}/api/btc-radar`);
    assert.equal(radarResponse.headers.get("cache-control"), "no-store");
    const radar = await radarResponse.json();
    assert.equal(radar.status, "AVAILABLE");
    assert.equal(radar.latest.score, 63.5);
    assert.equal(radar.history.length, 1);
    const saveCapital = (capitalUsdt, requestOrigin = origin) => fetch(`${origin}/api/btc-radar/settings`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin }, body: JSON.stringify({ capitalUsdt })
    });
    const saved = await saveCapital(5000);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).settings.capitalUsdt, 5000);
    assert.equal((await saveCapital(-1)).status, 400);
    assert.equal((await saveCapital(1, "https://evil.example")).status, 403);
    assert.equal((await fetch(`${origin}/api/btc-radar`).then((response) => response.json())).settings.capitalUsdt, 5000);

    const reviews = await fetch(`${origin}/api/trade-reviews`).then((response) => response.json());
    assert.equal(reviews.available, false);

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
      body: JSON.stringify({ strategyId: "weekly-etf-dual-momentum-defense" })
    });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).appliesTo, "next_entry");
    const snapshot = await fetch(`${origin}/api/snapshot`).then((response) => response.json());
    assert.equal(snapshot.strategy.activeStrategyId, "weekly-etf-dual-momentum-defense");

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
    const liveConfig = { ...JSON.parse(await readFile(configPath, "utf8")), mode: "live" };
    await writeFile(configPath, JSON.stringify(liveConfig));
    const liveSwitch = await fetch(`${origin}/api/strategy`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ strategyId: "weekly-etf-dual-momentum-defense" })
    });
    assert.equal(liveSwitch.status, 409);
    const liveApproval = await fetch(`${origin}/api/approval-decision`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ approvalId: automaticRequest.approvalId, decision: "APPROVE",
        confirmation: `APPROVE:${automaticRequest.approvalId}`, dyorAcknowledged: true })
    });
    assert.equal(liveApproval.status, 409);
    await assert.rejects(readFile(join(approvalDirectory, `${automaticRequest.approvalId}.json`)), { code: "ENOENT" });
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
      DASHBOARD_MARKET_INDEX_DISABLED: "1",
      DASHBOARD_STOCK_MARKET_DISABLED: "1",
      DASHBOARD_WALLET_BALANCE_DISABLED: "1",
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

    const managerEntry = await fetch(`${origin}/fund-manager?date=2026-09-13&edition=preview`, { redirect: "manual" });
    assert.equal(managerEntry.status, 303);
    assert.equal(managerEntry.headers.get("location"), "/login");

    const radarEntry = await fetch(`${origin}/btc-radar`, { redirect: "manual" });
    assert.equal(radarEntry.status, 303);
    assert.equal(radarEntry.headers.get("location"), "/login");
    assert.equal((await fetch(`${origin}/api/btc-radar`)).status, 401);
    assert.equal((await fetch(`${origin}/api/btc-radar/settings`, { method: "POST", body: "{}" })).status, 401);

    const weeklyEntry = await fetch(`${origin}/weekly-strategy`, { redirect: "manual" });
    assert.equal(weeklyEntry.status, 303);
    assert.equal(weeklyEntry.headers.get("location"), "/login");
    assert.equal((await fetch(`${origin}/api/weekly-strategy`)).status, 401);
    assert.equal((await fetch(`${origin}/api/strategy-research`)).status, 401);
    assert.equal((await fetch(`${origin}/api/strategy-research`, { headers: { Authorization: authorization } })).status, 200);

    const loginPage = await fetch(`${origin}/login`);
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /登录手机 Dashboard/);
    assert.match(loginHtml, /<input name="remember" type="checkbox" value="1" checked>在这台设备上保持登录 30 天/);

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
    assert.match(sessionCookie, /Max-Age=43200/);
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /Secure/);
    assert.match(sessionCookie, /SameSite=Lax/);

    const remembered = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "operator", password: "server-secret", remember: "1" }),
      redirect: "manual"
    });
    assert.match(remembered.headers.get("set-cookie"), /Max-Age=2592000/);
    const signedIn = await fetch(`${origin}/login`, { headers: { Cookie: remembered.headers.get("set-cookie").split(";")[0] }, redirect: "manual" });
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get("location"), "/");

    // Scripts (no Sec-Fetch headers, like curl) still get the Basic challenge;
    // a page's own fetch does not, so the browser shows no login box.
    const unauthorized = await new Promise((resolvePromise, reject) => {
      httpGet(`${origin}/api/snapshot`, (response) => { response.resume(); resolvePromise(response); }).on("error", reject);
    });
    assert.equal(unauthorized.statusCode, 401);
    assert.match(unauthorized.headers["www-authenticate"], /Basic/);
    const pageFetch = await fetch(`${origin}/api/snapshot`);
    assert.equal(pageFetch.status, 401);
    assert.equal(pageFetch.headers.get("www-authenticate"), null);

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
      body: JSON.stringify({ strategyId: "weekly-etf-dual-momentum-defense" })
    });
    assert.equal(publicOriginRequest.status, 200);

    const rejectedOrigin = await fetch(`${origin}/api/strategy`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Origin: "https://attacker.example"
      },
      body: JSON.stringify({ strategyId: "weekly-etf-dual-momentum-defense" })
    });
    assert.equal(rejectedOrigin.status, 403);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
});
