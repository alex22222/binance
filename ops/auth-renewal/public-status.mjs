import { readFile } from "node:fs/promises";

const publicStatusPath = "/var/lib/binance-agentic-authorization/public-status.json";

// Self-contained so the browser can recheck freshness/deadlines between polls.
// Neither the API nor the browser trusts a saved label, tone or arbitrary fields.
export function publicStatus(raw, { nowMs = Date.now() } = {}) {
  const unknown = () => ({
    schemaVersion: 1, checkedAt: null, strategyId: null, authorizationAllowed: null,
    entryControlsOpen: null, leaseExpiresAt: null, hardDeadline: null,
    autoRenewalState: null, reason: "STATUS_UNVERIFIED", generation: null,
    label: "未核实", tone: "unknown", renewalNotice: "授权状态当前未核实"
  });
  function timestamp(value) {
    if (typeof value !== "string") return NaN;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match) return NaN;
    const [, year, month, day, hour, minute, second, , zone, , offsetHour, offsetMinute] = match;
    const local = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    if (Number(year) < 2000 || local.getUTCFullYear() !== Number(year) ||
        local.getUTCMonth() + 1 !== Number(month) || local.getUTCDate() !== Number(day) ||
        Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
        (zone !== "Z" && (Number(offsetHour) > 14 || Number(offsetMinute) > 59 ||
          (Number(offsetHour) === 14 && Number(offsetMinute) !== 0)))) return NaN;
    return Date.parse(value);
  }
  if (!raw || raw.schemaVersion !== 1 || raw.strategyId !== "weekly-etf-dual-momentum-defense" ||
      typeof raw.authorizationAllowed !== "boolean" || typeof raw.entryControlsOpen !== "boolean" ||
      !["ACTIVE", "HALTED", "EXPIRED", "ERROR"].includes(raw.autoRenewalState) ||
      !Number.isSafeInteger(raw.generation) || raw.generation < 0 || typeof raw.reason !== "string" ||
      !Number.isFinite(nowMs)) return unknown();
  const checked = timestamp(raw.checkedAt);
  const lease = timestamp(raw.leaseExpiresAt);
  const deadline = timestamp(raw.hardDeadline);
  if (![checked, lease, deadline].every(Number.isFinite) || checked > nowMs || nowMs - checked > 180_000) return unknown();
  const authorizationAllowed = nowMs < lease && nowMs < deadline &&
    raw.autoRenewalState !== "EXPIRED" && raw.authorizationAllowed;
  const blocked = !authorizationAllowed || !raw.entryControlsOpen;
  if (!blocked && raw.autoRenewalState === "ERROR") return unknown();
  const nearExpiry = Math.min(lease, deadline) - nowMs <= 48 * 60 * 60 * 1000;
  const halted = raw.autoRenewalState === "HALTED";
  return {
    schemaVersion: 1, checkedAt: raw.checkedAt, strategyId: raw.strategyId,
    authorizationAllowed, entryControlsOpen: raw.entryControlsOpen,
    leaseExpiresAt: raw.leaseExpiresAt, hardDeadline: raw.hardDeadline,
    autoRenewalState: raw.autoRenewalState,
    // Public reason codes only: never reflect paths, free-text errors or tokens.
    reason: /^[A-Z][A-Z0-9_]{0,95}$/.test(raw.reason) ? raw.reason : "REASON_WITHHELD",
    generation: raw.generation,
    label: blocked ? "已阻断" : nearExpiry ? "即将到期(剩余48h)" : "可买入(仅授权)",
    tone: blocked ? "red" : halted || nearExpiry ? "amber" : "green",
    renewalNotice: halted ? "续签已停止；现有租约仅在截止前且原风控允许时有效" :
      blocked ? "新增买入授权已阻断" : "授权有效不代表通过全部交易风控或已成交"
  };
}

export async function readPublicStatus({ path = publicStatusPath, nowMs, read = readFile } = {}) {
  try {
    const raw = JSON.parse(await read(path, "utf8"));
    return publicStatus(raw, { nowMs: nowMs ?? Date.now() });
  } catch {
    return publicStatus(null, { nowMs });
  }
}

export function withAuthorizationBanner(html) {
  // Keep the existing Dashboard hook compatible without injecting a banner.
  // The authenticated status API and renewal/trading controls are unchanged.
  return html;
}
