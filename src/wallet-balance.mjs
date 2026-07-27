import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function summarizeWalletBalances(balances, checkedAt = new Date().toISOString()) {
  if (!Array.isArray(balances)) throw new TypeError("Wallet balances must be an array");
  const totalUsd = balances.reduce((total, balance) => {
    const value = Number(balance?.value);
    if (Number.isFinite(value)) return total + value;
    const quantity = Number(balance?.balance);
    const price = Number(balance?.price);
    return Number.isFinite(quantity) && Number.isFinite(price) ? total + quantity * price : total;
  }, 0);
  return {
    totalUsd,
    assetCount: balances.length,
    checkedAt
  };
}

function shanghaiDate(checkedAt) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(checkedAt));
}

function validSnapshot(snapshot) {
  const totalUsd = Number(snapshot?.totalUsd);
  const checkedAtMs = Date.parse(snapshot?.checkedAt || "");
  if (!Number.isFinite(totalUsd) || totalUsd < 0 || !Number.isFinite(checkedAtMs)) return null;
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(snapshot.date || "")
      ? snapshot.date
      : shanghaiDate(snapshot.checkedAt),
    totalUsd,
    assetCount: Math.max(0, Number(snapshot.assetCount) || 0),
    checkedAt: new Date(checkedAtMs).toISOString()
  };
}

export function buildAssetTrend(history, currentBalance = null, maxPoints = 30) {
  const byDate = new Map();
  for (const item of [...(Array.isArray(history) ? history : []), currentBalance]) {
    const snapshot = validSnapshot(item);
    if (!snapshot) continue;
    const previous = byDate.get(snapshot.date);
    if (!previous || Date.parse(snapshot.checkedAt) >= Date.parse(previous.checkedAt)) {
      byDate.set(snapshot.date, snapshot);
    }
  }
  return [...byDate.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-Math.max(1, maxPoints));
}

export async function upsertWalletBalanceSnapshot(path, walletBalance, maxDays = 90) {
  const current = validSnapshot(walletBalance);
  if (!current) return [];
  const history = await readFile(path, "utf8")
    .then(JSON.parse)
    .catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const snapshots = buildAssetTrend(history, current, maxDays);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshots, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  return snapshots;
}
