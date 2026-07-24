import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const transientNetworkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

export class BawError extends Error {
  constructor({ code, name = "BAW_ERROR", message = "Command failed", operation }) {
    super(`${name}: ${message}`);
    this.code = code;
    this.name = name;
    this.operation = operation;
  }
}

export function isWalletSessionExpired(error) {
  return Number(error?.code) === 100001005 ||
    /SESSION_EXPIRED|UNAUTHORIZED/.test(String(error?.name || "")) ||
    /Wallet status is UNCONNECTED/.test(String(error?.message || ""));
}

export function isTransientNetworkError(error) {
  if (error instanceof TypeError) return true;
  if (transientNetworkCodes.has(error?.code) || transientNetworkCodes.has(error?.cause?.code)) return true;
  if (/REQUEST_TIMEOUT|NETWORK_ERROR|CONNECT_TIMEOUT/.test(String(error?.name || ""))) return true;
  if (/fetch failed|Connect Timeout|network/i.test(String(error?.message || ""))) return true;
  const status = Number(error?.status);
  return status === 429 || status >= 500;
}

export function assertQuoteFresh({ quotedAt, nowMs = Date.now(), maxAgeMs }) {
  const quotedAtMs = Date.parse(quotedAt || "");
  if (!Number.isFinite(quotedAtMs) || nowMs - quotedAtMs > maxAgeMs) {
    throw new Error(`Quote is stale: age=${Number.isFinite(quotedAtMs) ? nowMs - quotedAtMs : "unknown"}ms`);
  }
}

export function quoteDriftPct(previousOutput, currentOutput) {
  if (!(Number(previousOutput) > 0) || !(Number(currentOutput) >= 0)) return Infinity;
  return Math.abs((Number(currentOutput) / Number(previousOutput)) - 1) * 100;
}

export function createOrderIntent(order) {
  const normalized = {
    side: order.side,
    symbol: order.symbol,
    address: order.address,
    fromToken: order.fromToken,
    toToken: order.toToken,
    fromTokenQty: String(order.fromTokenQty),
    createdAt: order.createdAt
  };
  const intentId = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 24);
  return {
    ...order,
    fromTokenQty: String(order.fromTokenQty),
    intentId,
    status: "SUBMITTING",
    orderId: null
  };
}

export function recoveryActionForPending(pendingOrder) {
  if (!pendingOrder) return "NONE";
  if (["SUBMITTING", "AMBIGUOUS"].includes(pendingOrder.status)) return "RECONCILE";
  if (pendingOrder.status === "REVIEW_REQUIRED") return "HALT";
  if (pendingOrder.status === "SUBMITTED" && pendingOrder.orderId) return "POLL";
  if (pendingOrder.orderId) return "POLL";
  return "HALT";
}

export function matchingOrdersForIntent(orders, pendingOrder) {
  return orders.filter((order) => (
    order.fromToken?.toLowerCase() === pendingOrder.fromToken.toLowerCase() &&
    order.toToken?.toLowerCase() === pendingOrder.toToken.toLowerCase() &&
    Math.abs(Number(order.fromTokenQty) - Number(pendingOrder.fromTokenQty)) < 1e-12
  ));
}

export function shouldNotifyFailure(previousFingerprint, currentFingerprint) {
  return previousFingerprint !== currentFingerprint;
}

export async function resolveWalletStatus(callWallet) {
  try {
    return await callWallet(["wallet", "status"]);
  } catch (error) {
    const statusEndpointBug =
      Number(error?.code) === 2 &&
      error?.name === "SERVICE_ERROR" &&
      /illegal parameter/i.test(String(error?.message || ""));
    if (!statusEndpointBug) throw error;

    const wallet = await callWallet(["wallet", "address"]);
    return {
      status: wallet.addresses?.length ? "CONNECTED" : "CREATING",
      verifiedBy: "wallet address"
    };
  }
}

export function runtimeFailureUpdate(state, error, now = new Date().toISOString()) {
  const fingerprint = isWalletSessionExpired(error)
    ? "wallet:expired"
    : isTransientNetworkError(error)
      ? `network:${error.code || error.name || "unavailable"}`
      : `error:${error.code || error.name || error.message}`;
  return {
    fingerprint,
    shouldNotify: shouldNotifyFailure(state.lastFailureFingerprint, fingerprint),
    patch: {
      updatedAt: now,
      lastError: error.message,
      lastFailureFingerprint: fingerprint,
      ...(isWalletSessionExpired(error)
        ? {
            walletSession: {
              status: "EXPIRED",
              detectedAt: now,
              errorCode: error.code || null,
              errorName: error.name || null
            }
          }
        : error.operation === "wallet status"
          ? {
              walletSession: {
                ...state.walletSession,
                status: "UNKNOWN",
                lastCheckFailedAt: now,
                errorCode: error.code || null,
                errorName: error.name || null
              }
            }
        : {})
    }
  };
}

export function sessionExpiryStatus({ sessionExpireTime, nowMs = Date.now(), warningMs }) {
  const expiresAtMs = Date.parse(sessionExpireTime || "");
  if (!Number.isFinite(expiresAtMs)) return { status: "UNKNOWN", remainingMs: null };
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) return { status: "EXPIRED", remainingMs };
  if (remainingMs <= warningMs) return { status: "EXPIRING", remainingMs };
  return { status: "CONNECTED", remainingMs };
}

export function walletSessionStatusFromSettings({ settings, nowMs = Date.now(), warningMs }) {
  const maxExpireTime = settings.signInMaxTime || settings.sessionExpireTime || null;
  const effectiveExpireTime = settings.sessionExpireTime || settings.inactiveSignOutTime || null;
  const maximum = sessionExpiryStatus({
    sessionExpireTime: maxExpireTime,
    nowMs,
    warningMs
  });
  const effective = sessionExpiryStatus({
    sessionExpireTime: effectiveExpireTime,
    nowMs,
    warningMs: 0
  });
  return {
    status: effective.status === "EXPIRED" ? "EXPIRED" : maximum.status,
    remainingMs: maximum.remainingMs,
    maxExpireTime,
    effectiveExpireTime
  };
}

export async function acquireProcessLock(path, {
  pid = process.pid,
  isAlive = (candidatePid) => {
    try {
      process.kill(candidatePid, 0);
      return true;
    } catch {
      return false;
    }
  }
} = {}) {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${pid}\n`, "utf8");
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existingPid = Number((await readFile(path, "utf8")).trim());
    if (Number.isInteger(existingPid) && isAlive(existingPid)) {
      throw new Error(`Bot is already running with PID ${existingPid}`);
    }
    await unlink(path).catch((unlinkError) => {
      if (unlinkError.code !== "ENOENT") throw unlinkError;
    });
    return acquireProcessLock(path, { pid, isAlive });
  }

  return {
    async release() {
      try {
        const currentPid = Number((await readFile(path, "utf8")).trim());
        if (currentPid === pid) await unlink(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  };
}

export async function activateEmergencyStop(path, {
  reason = "operator",
  requestedBy = "operator",
  activatedAt = new Date().toISOString()
} = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({
    active: true,
    reason,
    requestedBy,
    activatedAt
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function readEmergencyStop(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function isEmergencyStopped(path) {
  return Boolean((await readEmergencyStop(path))?.active);
}

export async function clearEmergencyStop(path, historyDirectory) {
  const marker = await readEmergencyStop(path);
  if (!marker) return null;
  await mkdir(historyDirectory, { recursive: true });
  const stamp = String(marker.activatedAt || new Date().toISOString()).replaceAll(":", "-");
  const archivedPath = join(historyDirectory, `EMERGENCY_STOP-${stamp}.json`);
  await rename(path, archivedPath);
  return archivedPath;
}
