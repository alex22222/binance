import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DAY = 86_400_000;
const MAX_BYTES = 2_000_000;
const REFRESH_STALE_MS = 45 * 60_000;
export const ASSETS = Object.freeze([
  ["spy", "SPY", "标普 500", "equity"], ["qqq", "QQQ", "纳指 100", "equity"], ["iwm", "IWM", "美国小盘股", "equity"],
  ["aiq", "AIQ", "人工智能与科技 ETF", "ai"], ["smh", "SMH", "半导体 ETF", "ai"], ["igv", "IGV", "软件 ETF", "ai"],
  ["xlf", "XLF", "金融 ETF", "sector"], ["xle", "XLE", "能源 ETF", "sector"], ["xlu", "XLU", "公用事业 ETF", "sector"],
  ["tlt", "TLT", "长期美国国债 ETF", "bonds"], ["ief", "IEF", "中期美国国债 ETF", "bonds"], ["shy", "SHY", "短期美国国债 ETF", "bonds"],
  ["uup", "UUP", "美元指数期货 ETF", "currency"], ["gld", "GLD", "黄金 ETF", "commodities"], ["uso", "USO", "原油期货 ETF", "commodities"],
  ["btc", "BTC-USD", "比特币", "crypto"], ["vix", "^VIX", "VIX 波动率指数", "risk"]
].map(([id, symbol, label, group]) => Object.freeze({ id, symbol, label, group })));
const MODELS = new Set(["SPY", "QQQ", "IWM"]);
const clock = now => {
  const value = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(value.getTime())) throw new Error("市场汇总时间无效");
  return value;
};
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const timestamp = value => Number.isSafeInteger(value) && value >= 946_684_800;
const isoTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const sourceUrl = asset => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?range=2y&interval=1d&events=div%2Csplits`;
const priceBasis = asset => ["BTC-USD", "^VIX"].includes(asset.symbol) ? "price_return" : "adjusted_total_return";
const dateFormats = Object.fromEntries(["UTC", "America/New_York", "America/Chicago"].map(timeZone => [timeZone, new Intl.DateTimeFormat("en-CA", { timeZone })]));
const localDate = (time, timeZone) => dateFormats[timeZone].format(new Date(time));
const sourceNote = asset => asset.symbol === "BTC-USD"
  ? "Yahoo Finance 美元价格日线；比特币按 UTC 自然日计算，收益未含费用，与美股交易日不同。"
  : asset.symbol === "^VIX" ? "Yahoo Finance VIX 指数日线，表示指数点位变化，不是可直接投资的收益。"
    : "Yahoo Finance 当前版本复权日线，含分红与拆分调整；现价为未复权常规时段报价，报价与日线可能不同步。ETF 是对应市场的代理。";

function emptyAsset(asset, error, attemptedAt) {
  return { ...asset, price: null, change1d: null, change5d: null, change20d: null, asOf: null, fetchedAt: null,
    sourceUrl: sourceUrl(asset), status: "FAILED", error, history: [], returnBasis: priceBasis(asset), sourceNote: sourceNote(asset),
    lastAttemptAt: attemptedAt, intraday: false, sessionState: "UNKNOWN", missingHistoryCount: 0, stale: true };
}

async function fetchChart(asset, fetchImpl) {
  const response = await fetchImpl(sourceUrl(asset), { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Yahoo 公共行情 HTTP ${response.status}`); }
  if (!response.body || Number(response.headers.get("content-length")) > MAX_BYTES) { await response.body?.cancel().catch(() => {}); throw new Error("行情响应为空或超过大小限制"); }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("行情响应超过大小限制");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

function session(meta, now, crypto) {
  if (crypto) return "CONTINUOUS";
  for (const [key, label] of [["regular", "REGULAR"], ["pre", "PRE"], ["post", "POST"]]) {
    const period = meta.currentTradingPeriod?.[key];
    if (timestamp(period?.start) && timestamp(period?.end) && now >= period.start * 1000 && now < period.end * 1000) return label;
  }
  return "CLOSED";
}

function parseChart(body, asset, fetched) {
  const results = body?.chart?.result;
  if (body?.chart?.error || !Array.isArray(results) || results.length !== 1) throw new Error("Yahoo 未返回有效行情");
  const row = results[0], meta = row.meta, crypto = asset.symbol === "BTC-USD", index = asset.symbol === "^VIX";
  const type = crypto ? "CRYPTOCURRENCY" : index ? "INDEX" : "ETF";
  const zone = crypto ? "UTC" : index ? "America/Chicago" : "America/New_York";
  const now = fetched.getTime();
  if (meta?.symbol !== asset.symbol || meta.currency !== "USD" || meta.instrumentType !== type || meta.exchangeTimezoneName !== zone) throw new Error("Yahoo 行情标的、币种或市场身份不匹配");
  if (!positive(meta.regularMarketPrice) || !timestamp(meta.regularMarketTime) || meta.regularMarketTime * 1000 > now + 300_000) throw new Error("Yahoo 最新价格或原始时点无效、超前");
  const period = meta.currentTradingPeriod?.regular;
  if (!timestamp(period?.start) || !timestamp(period?.end) || period.end <= period.start || period.end - period.start > 86_400) throw new Error("Yahoo 交易时段数据无效");
  const observed = meta.regularMarketTime * 1000;
  if (now - observed > (crypto ? REFRESH_STALE_MS : 5 * DAY)
    || (!crypto && now >= period.start * 1000 + REFRESH_STALE_MS && now < period.end * 1000 && now - observed > REFRESH_STALE_MS)
    || (!crypto && now >= period.end * 1000 + REFRESH_STALE_MS && observed < period.end * 1000 - REFRESH_STALE_MS)) throw new Error("Yahoo 行情原始时点已过期");
  const stamps = row.timestamp, quotes = row.indicators?.quote?.[0]?.close;
  const adjusted = row.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(stamps) || stamps.length < 2 || stamps.length > 1000 || !Array.isArray(quotes) || quotes.length !== stamps.length
    || (!crypto && !index && (!Array.isArray(adjusted) || adjusted.length !== stamps.length))) throw new Error("Yahoo 日线或复权字段缺失");
  let previous = -Infinity, previousDate = "";
  const history = stamps.map((stamp, position) => {
    if (!timestamp(stamp) || stamp <= previous || stamp * 1000 > now) throw new Error("Yahoo 日线存在未来、重复或乱序时点");
    const date = localDate(stamp * 1000, zone);
    if (date <= previousDate) throw new Error("Yahoo 日线交易日期重复或乱序");
    previous = stamp; previousDate = date;
    const raw = quotes[position], close = crypto || index ? raw : adjusted[position];
    if ((raw !== null && !positive(raw)) || (close !== null && !positive(close))) throw new Error("Yahoo 日线包含无效数值");
    return { time: new Date(stamp * 1000).toISOString(), close: raw === null || close === null ? null : close };
  });
  if (observed < stamps.at(-1) * 1000 - 300_000) throw new Error("Yahoo 最新报价与日线时点不匹配");
  const latest = history.at(-1), lastTime = Date.parse(latest.time);
  const returnsSynchronized = localDate(observed, zone) === localDate(lastTime, zone);
  const intraday = crypto ? Math.floor(lastTime / DAY) * DAY + DAY > now
    : localDate(lastTime, zone) === localDate(period.start * 1000, zone) && now < period.end * 1000;
  const missingHistoryCount = history.filter(bar => bar.close === null).length;
  const recentMissing = history.slice(-21).some(bar => bar.close === null);
  const change = days => {
    const window = history.slice(-(days + 1));
    return !returnsSynchronized || window.length !== days + 1 || window.some(bar => bar.close === null) ? null : (window.at(-1).close / window[0].close - 1) * 100;
  };
  return { ...asset, price: meta.regularMarketPrice, change1d: change(1), change5d: change(5), change20d: change(20),
    asOf: new Date(observed).toISOString(), fetchedAt: fetched.toISOString(), sourceUrl: sourceUrl(asset), status: !returnsSynchronized || recentMissing || history.length < 21 ? "PARTIAL" : "OK",
    error: !returnsSynchronized ? "最新报价与日线交易日期不同步，当前收益强弱暂不计算；模型仅保留已确认收盘历史" : recentMissing ? "近期收益窗口存在缺失日线，受影响收益未计算" : history.length < 21 ? "日线数量不足以计算 20 日收益" : null,
    history, returnBasis: priceBasis(asset), sourceNote: sourceNote(asset), returnsAsOf: latest.time, lastAttemptAt: fetched.toISOString(),
    intraday, sessionState: session(meta, now, crypto), missingHistoryCount, returnsSynchronized, stale: false };
}

function cachedAsset(previous, asset, attemptedAt, error) {
  const prior = Array.isArray(previous?.assets) ? previous.assets.find(row => row?.id === asset.id && row.symbol === asset.symbol) : null;
  const now = Date.parse(attemptedAt);
  if (!prior || !positive(prior.price) || prior.sourceUrl !== sourceUrl(asset) || prior.returnBasis !== priceBasis(asset)
    || !isoTime(prior.asOf) || !isoTime(prior.fetchedAt) || Date.parse(prior.asOf) > now + 300_000 || Date.parse(prior.fetchedAt) > now + 300_000
    || !Array.isArray(prior.history) || prior.history.length < 2 || prior.history.length > 1000) return emptyAsset(asset, error, attemptedAt);
  let last = -Infinity;
  for (const bar of prior.history) {
    const stamp = Date.parse(bar?.time);
    if (!isoTime(bar?.time) || stamp <= last || stamp > now || (bar.close !== null && !positive(bar.close))) return emptyAsset(asset, error, attemptedAt);
    last = stamp;
  }
  const stale = now - Date.parse(prior.fetchedAt) > REFRESH_STALE_MS || now - Date.parse(prior.asOf) > (asset.symbol === "BTC-USD" ? REFRESH_STALE_MS : 5 * DAY);
  return { ...prior, ...asset, status: "CACHED", lastAttemptAt: attemptedAt, error, stale, sessionState: "UNKNOWN" };
}

function riskSignal(asset) {
  const signal = { id: asset.id, symbol: asset.symbol, status: asset.status, asOf: null, ma20: null, ma60: null, ma200: null,
    direction20: null, direction60: null, direction200: null, RV20Pct: null, RV20PreviousPct: null, RV20ChangePp: null,
    targetVolPct: 10, targetExposurePct: null, previousExposurePct: null, exposureChangePp: null, modelOnly: true,
    error: asset.error, sourceNote: "使用已收盘复权日线；20 日对数收益样本波动率 × √252。假设目标年化波动率 10%，敞口上限 100%；仅模型代理，不是账户仓位。日线时点为该日标签。" };
  if (asset.status === "FAILED" || asset.stale) return { ...signal, status: asset.stale && asset.status !== "FAILED" ? "STALE" : asset.status };
  const closed = asset.intraday ? asset.history.slice(0, -1) : asset.history;
  signal.asOf = closed.at(-1)?.time ?? null;
  if (closed.length < 200 || closed.slice(-200).some(bar => bar.close === null)) return { ...signal, status: asset.status === "CACHED" ? "CACHED" : "PARTIAL", error: "模型需要最近 200 根完整的已收盘日线" };
  const prices = closed.map(bar => bar.close), latest = prices.at(-1);
  for (const days of [20, 60, 200]) {
    const average = prices.slice(-days).reduce((sum, value) => sum + value, 0) / days;
    signal[`ma${days}`] = average;
    signal[`direction${days}`] = Math.abs(latest - average) <= average * 1e-10 ? "FLAT" : latest > average ? "UP" : "DOWN";
  }
  const volatility = values => {
    const changes = values.slice(1).map((value, index) => Math.log(value / values[index]));
    const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length;
    return Math.sqrt(changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (changes.length - 1)) * Math.sqrt(252) * 100;
  };
  signal.RV20Pct = volatility(prices.slice(-21));
  signal.RV20PreviousPct = volatility(prices.slice(-22, -1));
  signal.RV20ChangePp = signal.RV20Pct - signal.RV20PreviousPct;
  const exposure = volatilityPct => volatilityPct > 1e-9 ? Math.min(100, 10 / volatilityPct * 100) : null;
  signal.targetExposurePct = exposure(signal.RV20Pct);
  signal.previousExposurePct = exposure(signal.RV20PreviousPct);
  signal.exposureChangePp = signal.targetExposurePct === null || signal.previousExposurePct === null ? null : signal.targetExposurePct - signal.previousExposurePct;
  if (signal.targetExposurePct === null) { signal.status = asset.status === "CACHED" ? "CACHED" : "PARTIAL"; signal.error = "20 日波动率接近零，风险预算无有效定义"; }
  return signal;
}

export async function collectMarketOverview({ fetchImpl = fetch, now = () => new Date(), previous = null } = {}) {
  const generatedAt = clock(now).toISOString();
  const assets = new Array(ASSETS.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < ASSETS.length) {
      const index = cursor++, asset = ASSETS[index];
      try { assets[index] = parseChart(await fetchChart(asset, fetchImpl), asset, clock(now)); }
      catch (error) {
        const message = error.name === "TimeoutError" || error.name === "AbortError" ? "Yahoo 公共行情读取超时" : error instanceof SyntaxError ? "Yahoo 行情响应格式无效" : error.message === "offline" ? "Yahoo 公共行情连接失败" : String(error.message || "Yahoo 公共行情读取失败").slice(0, 180);
        assets[index] = cachedAsset(previous, asset, clock(now).toISOString(), message);
      }
    }
  }));
  const signals = assets.filter(asset => MODELS.has(asset.symbol)).map(riskSignal);
  const fresh = assets.filter(asset => ["OK", "PARTIAL"].includes(asset.status)).length;
  const status = fresh === 0 ? "FAILED" : assets.some(asset => asset.status !== "OK") || signals.some(signal => signal.status !== "OK") ? "PARTIAL" : "OK";
  return { schemaVersion: 1, generatedAt, status, assets, signals,
    errors: [...assets.filter(asset => asset.status !== "OK").map(asset => `${asset.symbol}：${asset.error || "采集未完成"}`), ...signals.filter(signal => signal.status !== "OK" && signal.error).map(signal => `${signal.symbol} 模型：${signal.error}`)],
    notes: ["收益强弱是价格/复权收益代理，不能证明真实资金净申赎或资金流。", "美股 ETF 按交易日计算；比特币按 UTC 自然日计算。", "数据可能延迟，原始行情时点与采集时点分别保留；均线和风险预算只使用已收盘日线。"] };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

async function acquireLock(path) {
  const owner = randomUUID();
  const readOwner = async () => {
    const value = await readJson(path);
    if (!Number.isInteger(value?.pid) || value.pid <= 0 || typeof value.owner !== "string") throw new Error("Market collector already running or lock incomplete");
    return value;
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
  const create = async () => {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, owner })); } finally { await file.close(); }
    return { async release() { try { if ((await readOwner()).owner === owner) await unlink(path); } catch (error) { if (error.code !== "ENOENT") throw error; } } };
  };
  try { return await create(); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (alive((await readOwner()).pid)) throw new Error("Market collector already running");
  let recovery;
  try { recovery = await open(`${path}.recovery`, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Market collector lock recovery already running"); throw error; }
  try {
    if (await readJson(path) !== null) { if (alive((await readOwner()).pid)) throw new Error("Market collector already running"); await unlink(path); }
    return await create();
  } finally { await recovery.close(); await unlink(`${path}.recovery`); }
}

export async function runMarketOverview({ directory, fetchImpl = fetch, now = () => new Date() }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(join(directory, "collector.lock"));
  try {
    const previous = await readJson(join(directory, "latest.json"));
    const report = await collectMarketOverview({ fetchImpl, now, previous });
    if (report.status !== "FAILED") await writeJson(join(directory, "latest.json"), report);
    await writeJson(join(directory, "state.json"), { schemaVersion: 1, lastRunAt: report.generatedAt,
      lastAttempt: { startedAt: report.generatedAt, finishedAt: clock(now).toISOString(), status: report.status, errors: report.errors,
        assets: report.assets.map(({ id, symbol, status, error, lastAttemptAt }) => ({ id, symbol, status, error, lastAttemptAt })) } });
    return report;
  } finally { await lock.release(); }
}

export async function loadMarketOverview(directory, { now = () => new Date() } = {}) {
  const empty = { schemaVersion: 1, generatedAt: null, status: "MISSING", assets: [], signals: [], lastAttempt: null, stale: true, errors: [] };
  try {
    const [latest, state] = await Promise.all([readJson(join(directory, "latest.json")), readJson(join(directory, "state.json"))]);
    if (state !== null && (state.schemaVersion !== 1 || !["OK", "PARTIAL", "FAILED"].includes(state.lastAttempt?.status) || !isoTime(state.lastAttempt.startedAt))) throw new Error("市场采集状态格式无效");
    if (latest === null) return { ...empty, status: state?.lastAttempt.status === "FAILED" ? "FAILED" : "MISSING", lastAttempt: state?.lastAttempt ?? null, errors: state?.lastAttempt.errors || [] };
    if (latest.schemaVersion !== 1 || !isoTime(latest.generatedAt) || !["OK", "PARTIAL"].includes(latest.status)
      || !Array.isArray(latest.assets) || latest.assets.length !== ASSETS.length || !Array.isArray(latest.signals)
      || ASSETS.some((asset, index) => latest.assets[index]?.id !== asset.id || latest.assets[index]?.symbol !== asset.symbol)) throw new Error("市场汇总文件格式无效");
    const current = clock(now), nowMs = current.getTime();
    if (Date.parse(latest.generatedAt) > nowMs + 300_000) throw new Error("市场汇总生成时间超前");
    const failed = state?.lastAttempt.status === "FAILED";
    const stale = nowMs - Date.parse(latest.generatedAt) > REFRESH_STALE_MS;
    const assets = latest.assets.map((row, index) => {
      const failure = failed ? state.lastAttempt.assets?.find(value => value.id === row.id) : null;
      if (failure) return cachedAsset(latest, ASSETS[index], state.lastAttempt.finishedAt, failure.error || "最近采集失败");
      return { ...row, stale: row.stale || (isoTime(row.fetchedAt) && nowMs - Date.parse(row.fetchedAt) > REFRESH_STALE_MS) };
    });
    return { ...latest, dataStatus: latest.status, status: failed ? "FAILED" : stale ? "STALE" : latest.status, assets,
      signals: assets.filter(asset => MODELS.has(asset.symbol)).map(riskSignal), lastAttempt: state?.lastAttempt ?? null, stale,
      errors: failed ? state.lastAttempt.errors : latest.errors };
  } catch (error) { return { ...empty, status: "ERROR", errors: [error.message], error: error.message }; }
}
