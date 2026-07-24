import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireProcessLock,
  activateEmergencyStop,
  assertQuoteFresh,
  clearEmergencyStop,
  createOrderIntent,
  isEmergencyStopped,
  isTransientNetworkError,
  isWalletSessionExpired,
  matchingOrdersForIntent,
  quoteDriftPct,
  recoveryActionForPending,
  resolveWalletStatus,
  runtimeFailureUpdate,
  sessionExpiryStatus,
  shouldNotifyFailure,
  walletSessionStatusFromSettings
} from "../src/reliability.mjs";

test("recognizes an expired wallet session without treating network errors as authentication failures", () => {
  assert.equal(isWalletSessionExpired({ code: 100001005, name: "SESSION_EXPIRED" }), true);
  assert.equal(isWalletSessionExpired({ name: "UNAUTHORIZED", message: "Wallet status is UNCONNECTED" }), true);
  assert.equal(isWalletSessionExpired({ code: "ETIMEDOUT", message: "Connect Timeout Error" }), false);
});

test("retries only transient read failures", () => {
  assert.equal(isTransientNetworkError(new TypeError("fetch failed")), true);
  assert.equal(isTransientNetworkError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientNetworkError({ status: 503 }), true);
  assert.equal(isTransientNetworkError({ status: 400 }), false);
});

test("rejects stale quotes and calculates adverse quote drift", () => {
  assert.doesNotThrow(() => assertQuoteFresh({
    quotedAt: "2026-07-24T13:00:00.000Z",
    nowMs: Date.parse("2026-07-24T13:00:09.000Z"),
    maxAgeMs: 10_000
  }));
  assert.throws(() => assertQuoteFresh({
    quotedAt: "2026-07-24T13:00:00.000Z",
    nowMs: Date.parse("2026-07-24T13:00:11.000Z"),
    maxAgeMs: 10_000
  }), /stale/i);
  assert.ok(Math.abs(quoteDriftPct(100, 99.5) - 0.5) < 1e-9);
});

test("creates a deterministic write-ahead intent and requires review after an ambiguous crash", () => {
  const order = {
    side: "BUY",
    symbol: "NVDA",
    address: "0xabc",
    fromToken: "0xusdt",
    toToken: "0xabc",
    fromTokenQty: 50,
    createdAt: "2026-07-24T13:00:00.000Z"
  };
  const left = createOrderIntent(order);
  const right = createOrderIntent(order);
  assert.equal(left.intentId, right.intentId);
  assert.equal(left.status, "SUBMITTING");
  assert.equal(recoveryActionForPending(left), "RECONCILE");
  assert.equal(recoveryActionForPending({ ...left, status: "AMBIGUOUS" }), "RECONCILE");
  assert.equal(recoveryActionForPending({ ...left, status: "SUBMITTED", orderId: "123" }), "POLL");
  assert.equal(recoveryActionForPending({ ...left, status: "REVIEW_REQUIRED" }), "HALT");
  assert.deepEqual(matchingOrdersForIntent([
    { orderId: "match", fromToken: "0xUSDT", toToken: "0xAbC", fromTokenQty: "50" },
    { orderId: "wrong-amount", fromToken: "0xusdt", toToken: "0xabc", fromTokenQty: "49" },
    { orderId: "wrong-token", fromToken: "0xusdt", toToken: "0xdef", fromTokenQty: "50" }
  ], left).map((item) => item.orderId), ["match"]);
});

test("suppresses repeated notifications for the same persistent failure", () => {
  assert.equal(shouldNotifyFailure(null, "wallet:expired"), true);
  assert.equal(shouldNotifyFailure("wallet:expired", "wallet:expired"), false);
  assert.equal(shouldNotifyFailure("wallet:expired", "network:timeout"), true);
});

test("persists session expiry once and recovers without losing unrelated state", () => {
  const state = {
    lastFailureFingerprint: null,
    position: { symbol: "NVDA" }
  };
  const first = runtimeFailureUpdate(state, {
    code: 100001005,
    name: "SESSION_EXPIRED",
    message: "Session expired"
  }, "2026-07-24T13:00:00.000Z");
  assert.equal(first.shouldNotify, true);
  assert.equal(first.patch.walletSession.status, "EXPIRED");
  assert.equal(first.patch.lastFailureFingerprint, "wallet:expired");
  assert.deepEqual(state.position, { symbol: "NVDA" });

  const second = runtimeFailureUpdate({
    ...state,
    ...first.patch
  }, {
    code: 100001005,
    name: "SESSION_EXPIRED",
    message: "Session expired"
  }, "2026-07-24T13:01:00.000Z");
  assert.equal(second.shouldNotify, false);
});

test("warns before the maximum wallet session expiry without guessing unknown timestamps", () => {
  const nowMs = Date.parse("2026-07-24T13:00:00.000Z");
  assert.equal(sessionExpiryStatus({
    sessionExpireTime: "2026-07-25T12:00:00.000Z",
    nowMs,
    warningMs: 24 * 60 * 60 * 1000
  }).status, "EXPIRING");
  assert.equal(sessionExpiryStatus({
    sessionExpireTime: "2026-07-26T13:00:00.000Z",
    nowMs,
    warningMs: 24 * 60 * 60 * 1000
  }).status, "CONNECTED");
  assert.equal(sessionExpiryStatus({
    sessionExpireTime: null,
    nowMs,
    warningMs: 24 * 60 * 60 * 1000
  }).status, "UNKNOWN");
});

test("uses the seven-day maximum deadline instead of the rolling inactivity deadline", () => {
  const result = walletSessionStatusFromSettings({
    settings: {
      maxSigninDuration: "7d",
      inactiveSignoutDuration: "24h",
      sessionExpireTime: "2026-07-25T21:59:39+08:00",
      inactiveSignOutTime: "2026-07-25T21:59:39+08:00",
      signInMaxTime: "2026-07-31T21:57:28+08:00"
    },
    nowMs: Date.parse("2026-07-24T22:00:00+08:00"),
    warningMs: 24 * 60 * 60 * 1000
  });

  assert.equal(result.status, "CONNECTED");
  assert.equal(result.maxExpireTime, "2026-07-31T21:57:28+08:00");
  assert.equal(result.effectiveExpireTime, "2026-07-25T21:59:39+08:00");
  assert.ok(result.remainingMs > 6 * 24 * 60 * 60 * 1000);
});

test("does not present a stale connected state after wallet status itself fails", () => {
  const failure = runtimeFailureUpdate({
    walletSession: {
      status: "CONNECTED",
      checkedAt: "2026-07-24T12:00:00.000Z"
    }
  }, {
    operation: "wallet status",
    code: 2,
    name: "SERVICE_ERROR",
    message: "SERVICE_ERROR: illegal parameter"
  }, "2026-07-24T13:00:00.000Z");
  assert.equal(failure.patch.walletSession.status, "UNKNOWN");
  assert.equal(failure.patch.walletSession.checkedAt, "2026-07-24T12:00:00.000Z");
  assert.equal(failure.patch.walletSession.lastCheckFailedAt, "2026-07-24T13:00:00.000Z");
});

test("probes a wallet endpoint when status returns the CLI illegal-parameter bug", async () => {
  const calls = [];
  const result = await resolveWalletStatus(async (args) => {
    calls.push(args.join(" "));
    if (args.join(" ") === "wallet status") {
      const error = new Error("SERVICE_ERROR: illegal parameter");
      error.code = 2;
      error.name = "SERVICE_ERROR";
      throw error;
    }
    return { addresses: [{ binanceChainId: "56", address: "0xabc" }] };
  });

  assert.deepEqual(calls, ["wallet status", "wallet address"]);
  assert.deepEqual(result, { status: "CONNECTED", verifiedBy: "wallet address" });
});

test("preserves the exact expired-session error returned by the wallet probe", async () => {
  await assert.rejects(() => resolveWalletStatus(async (args) => {
    if (args.join(" ") === "wallet status") {
      const error = new Error("SERVICE_ERROR: illegal parameter");
      error.code = 2;
      error.name = "SERVICE_ERROR";
      throw error;
    }
    const error = new Error("SESSION_EXPIRED: Please log in first.");
    error.code = 10003002;
    error.name = "SESSION_EXPIRED";
    throw error;
  }), (error) => error.code === 10003002 && error.name === "SESSION_EXPIRED");
});

test("uses a single-instance lock and recovers a stale lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-lock-"));
  const path = join(directory, "bot.lock");
  const first = await acquireProcessLock(path, {
    pid: 123,
    isAlive: (pid) => pid === 123
  });
  await assert.rejects(() => acquireProcessLock(path, {
    pid: 456,
    isAlive: (pid) => pid === 123
  }), /already running/i);
  await first.release();

  await writeFile(path, "999\n", "utf8");
  const recovered = await acquireProcessLock(path, {
    pid: 456,
    isAlive: () => false
  });
  assert.equal((await readFile(path, "utf8")).trim(), "456");
  await recovered.release();
});

test("persists emergency stop and archives it on explicit resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-stop-"));
  const markerPath = join(directory, "EMERGENCY_STOP");
  const historyDirectory = join(directory, "history");
  await activateEmergencyStop(markerPath, { reason: "operator_test", requestedBy: "test" });
  assert.equal(await isEmergencyStopped(markerPath), true);
  const archivedPath = await clearEmergencyStop(markerPath, historyDirectory);
  assert.match(archivedPath, /history/);
  assert.equal(await isEmergencyStopped(markerPath), false);
  assert.match(await readFile(archivedPath, "utf8"), /operator_test/);
});
