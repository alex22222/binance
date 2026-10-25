import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { emptyPortfolio, summarize, validatePortfolio } from "./personal-assets-core.mjs";

export * from "./personal-assets-core.mjs";

const MAX_STATE_BYTES = 8_000_000;
const MAX_SNAPSHOTS = 500;
const snapshotIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class PersonalAssetsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.statusCode = status;
  }
}

function statePath(stateDir) {
  if (typeof stateDir !== "string" || !stateDir.trim()) throw new PersonalAssetsError("资产存储目录未配置", 500);
  return join(resolve(stateDir), "personal-assets.json");
}

function validRevision(revision) {
  return Number.isSafeInteger(revision) && revision >= 0;
}

function checkRevision(state, revision) {
  if (!validRevision(revision)) throw new PersonalAssetsError("请提供有效的数据版本");
  if (revision !== state.revision) throw new PersonalAssetsError("资产已在其他页面更新，请重新加载后再保存", 409);
}

function validateStoredState(value) {
  if (!value || value.schemaVersion !== 1 || !validRevision(value.revision) || !Array.isArray(value.snapshots) || value.snapshots.length > MAX_SNAPSHOTS) throw new Error("Invalid asset state");
  if (value.updatedAt !== null && (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)))) throw new Error("Invalid asset timestamp");
  const ids = new Set();
  const snapshots = value.snapshots.map((snapshot) => {
    if (!snapshot || typeof snapshot.id !== "string" || !snapshotIdPattern.test(snapshot.id) || ids.has(snapshot.id)
      || typeof snapshot.at !== "string" || !Number.isFinite(Date.parse(snapshot.at))
      || !validRevision(snapshot.revision) || snapshot.revision > value.revision
      || (snapshot.valuationId !== undefined && (typeof snapshot.valuationId !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.valuationId)))
      || (snapshot.dailyDate !== undefined && (typeof snapshot.dailyDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.dailyDate) || !Number.isFinite(Date.parse(snapshot.dailyDate + "T00:00:00Z"))))
      || (snapshot.total !== null && (typeof snapshot.total !== "number" || !Number.isFinite(snapshot.total) || snapshot.total < 0))
      || !Number.isInteger(snapshot.missing) || snapshot.missing < 0 || snapshot.missing > 5000
      || !Number.isInteger(snapshot.entries) || snapshot.entries < 0 || snapshot.entries > 5000) throw new Error("Invalid asset snapshot");
    ids.add(snapshot.id);
    return { id: snapshot.id, at: snapshot.at, total: snapshot.total, missing: snapshot.missing, entries: snapshot.entries, revision: snapshot.revision,
      ...(snapshot.valuationId !== undefined ? { valuationId: snapshot.valuationId } : {}),
      ...(snapshot.dailyDate !== undefined ? { dailyDate: snapshot.dailyDate } : {}) };
  });
  return { schemaVersion: 1, revision: value.revision, updatedAt: value.updatedAt, portfolio: validatePortfolio(value.portfolio), snapshots };
}

export async function readPersonalAssets({ stateDir }) {
  const path = statePath(stateDir);
  let handle;
  try {
    handle = await open(path, "r");
    if ((await handle.stat()).size > MAX_STATE_BYTES) throw new Error("Asset state is too large");
    return validateStoredState(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, revision: 0, updatedAt: null, portfolio: emptyPortfolio(), snapshots: [] };
    throw new PersonalAssetsError("资产文件无法读取或格式已损坏，请先检查备份，现有数据未被覆盖", 500);
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(path, value) {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(source) > MAX_STATE_BYTES) throw new PersonalAssetsError("资产数据过大，请减少记录数量");
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function withWriteLock(stateDir, update) {
  const path = statePath(stateDir);
  await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let handle;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 39) throw new PersonalAssetsError("资产文件正在保存，请稍后重试；若持续出现，请检查遗留写入锁", 409);
      await delay(25);
    }
  }
  try {
    return await update(path);
  } finally {
    await handle.close();
    await unlink(lockPath);
  }
}

const statementProviders = ["usmart-hk", "usmart-sg"];
const validStatementPassword = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

async function statementPasswordConfig(stateDir) {
  statePath(stateDir);
  let handle;
  try {
    handle = await open(join(resolve(stateDir), "personal-assets-statement-passwords.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 10_000) throw new Error();
    const value = JSON.parse(await handle.readFile("utf8"));
    if (value?.schemaVersion !== 1 || !value.passwords || typeof value.passwords !== "object" || Array.isArray(value.passwords)
      || Object.entries(value.passwords).some(([provider, row]) => !statementProviders.includes(provider) || !validStatementPassword(row?.password)
        || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt)))) throw new Error();
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, passwords: {} };
    throw new PersonalAssetsError("结单密码配置无法读取，请检查受保护的服务器文件", 500);
  } finally { await handle?.close(); }
}

function statementPasswordStatus(config) {
  return { providers: Object.fromEntries(statementProviders.map(provider => [provider, {
    configured: Boolean(config.passwords[provider]), updatedAt: config.passwords[provider]?.updatedAt || null,
  }])) };
}

export async function readStatementPasswordStatus({ stateDir }) {
  return statementPasswordStatus(await statementPasswordConfig(stateDir));
}

export async function configureStatementPassword({ stateDir, provider, password, clear = false }) {
  if (!statementProviders.includes(provider) || typeof clear !== "boolean" || (clear ? password !== undefined : !validStatementPassword(password))) {
    throw new PersonalAssetsError("请选择支持的结单账户并填写有效密码；清除时不要同时提交新密码");
  }
  return withWriteLock(stateDir, async () => {
    const config = await statementPasswordConfig(stateDir);
    if (clear) delete config.passwords[provider];
    else config.passwords[provider] = { password, updatedAt: new Date().toISOString() };
    await atomicWrite(join(resolve(stateDir), "personal-assets-statement-passwords.json"), config);
    return statementPasswordStatus(config);
  });
}

export async function savePersonalAssets({ stateDir, portfolio, revision }) {
  let validated;
  try {
    validated = validatePortfolio(portfolio);
  } catch (error) {
    throw new PersonalAssetsError(error.message);
  }
  return withWriteLock(stateDir, async (path) => {
    const current = await readPersonalAssets({ stateDir });
    checkRevision(current, revision);
    if (!Number.isSafeInteger(current.revision + 1)) throw new PersonalAssetsError("资产数据版本已达上限", 500);
    const next = { ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(), portfolio: validated };
    await atomicWrite(path, next);
    return next;
  });
}

export async function createPersonalAssetsSnapshot({ stateDir, revision, valuation, daily = false, now = new Date(), sourceCoverage }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new PersonalAssetsError("快照时间无效");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(part => [part.type, part.value]));
  const dailyDate = `${parts.year}-${parts.month}-${parts.day}`;
  return withWriteLock(stateDir, async (path) => {
    const current = await readPersonalAssets({ stateDir });
    checkRevision(current, revision);
    let portfolio = current.portfolio;
    let valuationId;
    if (valuation !== undefined) {
      try { portfolio = validatePortfolio({ ...current.portfolio, rates: valuation.rates }); }
      catch (error) { throw new PersonalAssetsError(error.message); }
      const rates = Object.fromEntries(Object.entries(portfolio.rates).sort(([a], [b]) => a.localeCompare(b)).map(([currency, rate]) => [currency, { value: rate.value, date: rate.date }]));
      const fxRates = Object.fromEntries(Object.entries(valuation.fx?.rates || {}).sort(([a], [b]) => a.localeCompare(b)).map(([currency, rate]) => [currency, {
        value: rate.value, date: rate.date, asOf: rate.asOf, source: rate.source,
      }]));
      valuationId = createHash("sha256").update(JSON.stringify({ rates, fxRates })).digest("hex");
    }
    if (current.snapshots.some((snapshot) => daily ? snapshot.dailyDate === dailyDate : snapshot.revision === revision && (valuationId === undefined || snapshot.valuationId === valuationId))) return current;
    if (!current.portfolio.entries.length) throw new PersonalAssetsError("请先录入资产再保存快照");
    if (current.snapshots.length >= MAX_SNAPSHOTS) throw new PersonalAssetsError(`资产快照最多保存 ${MAX_SNAPSHOTS} 份，请先备份历史数据`);
    const summary = summarize(portfolio);
    const snapshot = { id: randomUUID(), at: now.toISOString(), total: summary.total, missing: summary.missing.length, entries: current.portfolio.entries.length, revision,
      ...(valuationId !== undefined ? { valuationId } : {}), ...(daily ? { dailyDate } : {}) };
    const directory = join(resolve(stateDir), "personal-assets-snapshots");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(join(directory, `${snapshot.id}.json`), { ...snapshot, portfolio, ...(valuation?.fx !== undefined ? { fx: valuation.fx } : {}), ...(sourceCoverage !== undefined ? { sync: sourceCoverage } : {}) });
    const next = { ...current, snapshots: [snapshot, ...current.snapshots] };
    await atomicWrite(path, next);
    return next;
  });
}
