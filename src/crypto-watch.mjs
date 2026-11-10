import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectCryptoNews } from "./crypto-news.mjs";

const DAY = 86_400_000;
const API = "https://openapi.okx.com";
const FAVORITES = "https://www.okx.com/zh-hans/markets/favorite";
const dateInShanghai = value => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(value);
const clock = now => {
  const value = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(value.getTime())) throw new Error("数字货币汇总时间无效");
  return value;
};
const decimal = value => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const positive = value => { const number = decimal(value); return number > 0 ? number : null; };
const time = value => typeof value === "string" && /^\d{13}$/.test(value) ? Number(value) : null;
const fresh = (value, now) => value !== null && now - value <= 600_000 && value - now <= 60_000;

export function validateWatchlist(value) {
  if (value?.schemaVersion !== 1 || typeof value.source !== "string" || !value.source.trim() || value.source.length > 200
    || value.sourceUrl !== FAVORITES || typeof value.syncedAt !== "string" || !Number.isFinite(Date.parse(value.syncedAt))
    || !Array.isArray(value.instruments) || value.instruments.length > 100) throw new Error("OKX 收藏列表格式或来源无效");
  const identities = new Set();
  const instruments = value.instruments.map(row => {
    if (!row || typeof row.instId !== "string" || !/^[A-Z0-9]{1,30}-USDT(?:-SWAP)?$/.test(row.instId) || identities.has(row.instId)
      || typeof row.name !== "string" || !row.name.trim() || row.name.length > 100 || !["crypto", "tradfi"].includes(row.kind)) throw new Error("OKX 收藏列表含无效或重复交易品种");
    identities.add(row.instId);
    return { instId: row.instId, name: row.name, kind: row.kind };
  });
  return { schemaVersion: 1, source: value.source, sourceUrl: value.sourceUrl, syncedAt: value.syncedAt, instruments };
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJson(path, value) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function readNews(directory) {
  try {
    const value = await readJson(join(directory, "news.json"));
    if (value !== null && (value.schemaVersion !== 1 || !["OK", "PARTIAL", "FAILED"].includes(value.status)
      || !Number.isFinite(Date.parse(value.generatedAt)) || !Array.isArray(value.sources) || !Array.isArray(value.byBase) || !Array.isArray(value.announcements))) throw new Error("Invalid news report");
    return value;
  } catch {
    return { schemaVersion: 1, status: "FAILED", generatedAt: null, sources: [], byBase: [], announcements: [], errors: ["已保存的新闻公告无法读取，请检查采集记录。"] };
  }
}

async function acquireCollectorLock(path) {
  const owner = randomUUID();
  const readOwner = async () => {
    const value = await readJson(path);
    if (!Number.isInteger(value?.pid) || value.pid <= 0 || typeof value.owner !== "string") throw new Error("Collector already running or lock incomplete; inspect collector.lock before retrying");
    return value;
  };
  const isAlive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== "ESRCH"; }
  };
  const create = async () => {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, owner })); }
    finally { await handle.close(); }
    return { async release() {
      try { if ((await readOwner()).owner === owner) await unlink(path); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } };
  };
  try { return await create(); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (isAlive((await readOwner()).pid)) throw new Error("Collector already running");
  // Serialize stale-PID recovery so a second recoverer cannot unlink a new lock.
  // A crash inside this short guard leaves a visible recovery lock to inspect.
  let recovery;
  try { recovery = await open(`${path}.recovery`, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Collector lock recovery already running; inspect collector.lock.recovery before retrying");
    throw error;
  }
  try {
    const existing = await readJson(path);
    if (existing !== null) {
      const current = await readOwner();
      if (isAlive(current.pid)) throw new Error("Collector already running");
      await unlink(path);
    }
    return await create();
  } finally { await recovery.close(); await unlink(`${path}.recovery`); }
}

async function request(path, fetchImpl) {
  let response;
  try { response = await fetchImpl(`${API}${path}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } }); }
  catch { throw new Error("OKX 公共接口连接失败或超时"); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`OKX 公共接口 HTTP ${response.status}`); }
  const payload = await response.json();
  if (payload?.code !== "0" || !Array.isArray(payload.data)) throw new Error("OKX 公共接口返回错误或无效数据");
  return payload.data;
}

function tickerMetrics(rows, instId, now) {
  if (rows.length !== 1 || rows[0]?.instId !== instId) throw new Error("行情交易品种不匹配");
  const row = rows[0], observed = time(row.ts), price = positive(row.last);
  if (!fresh(observed, now)) throw new Error("行情时间缺失、过期或超前");
  if (price === null) throw new Error("行情价格缺失或无效");
  const open = positive(row.open24h), high = positive(row.high24h), low = positive(row.low24h), bid = positive(row.bidPx), ask = positive(row.askPx);
  if (high !== null && low !== null && high < low) throw new Error("行情价格区间无效");
  const volume = decimal(row.volCcy24h);
  return { price, change24hPct: open === null ? null : (price / open - 1) * 100, high24h: high, low24h: low,
    volume24hQuote: instId.endsWith("-SWAP") || volume === null || volume < 0 ? null : volume,
    bid, ask, spreadPct: bid !== null && ask !== null && ask >= bid ? (ask - bid) / ((ask + bid) / 2) * 100 : null,
    observedAt: new Date(observed).toISOString() };
}

function weeklyReturn(rows, now) {
  const closed = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row[8] !== "1") continue;
    const stamp = time(row[0]), close = positive(row[4]);
    if (stamp === null || stamp % DAY !== 0 || stamp + DAY > now || close === null || closed.has(stamp)) throw new Error("已收盘日线数据无效");
    closed.set(stamp, close);
  }
  const end = Math.floor(now / DAY) * DAY - DAY;
  if (!Array.from({ length: 8 }, (_, index) => end - index * DAY).every(stamp => closed.has(stamp))) throw new Error("缺少最近连续八根已收盘 UTC 日线");
  return (closed.get(end) / closed.get(end - 7 * DAY) - 1) * 100;
}

function fundingMetrics(rows, instId, now) {
  if (rows.length !== 1 || rows[0]?.instId !== instId) throw new Error("资金费率交易品种不匹配");
  const row = rows[0], rate = decimal(row.fundingRate), settlement = time(row.fundingTime);
  if (rate === null || !fresh(time(row.ts), now) || settlement === null || settlement < now - 60_000 || settlement > now + 2 * DAY) throw new Error("资金费率或结算时间缺失、过期或无效");
  return { fundingRatePct: rate * 100, fundingTime: new Date(settlement).toISOString() };
}

async function collectToken(instrument, fetchImpl, now) {
  const { instId, name, kind } = instrument;
  const swap = instId.endsWith("-SWAP");
  const row = { instId, name, kind, instType: swap ? "SWAP" : "SPOT", status: "FAILED", price: null, change24hPct: null, high24h: null, low24h: null,
    volume24hQuote: null, bid: null, ask: null, spreadPct: null, observedAt: null, fundingRatePct: null, fundingTime: null, return7dPct: null,
    summary: "行情采集失败，暂无可用日报。", errors: [], sourceUrl: `https://www.okx.com/zh-hans/${swap ? "trade-swap" : "trade-spot"}/${instId.toLowerCase()}` };
  const query = `instId=${encodeURIComponent(instId)}`;
  try { Object.assign(row, tickerMetrics(await request(`/api/v5/market/ticker?${query}`, fetchImpl), instId, clock(now).getTime())); }
  catch (error) { row.errors.push(`行情：${error.message}`); return row; }
  try { row.return7dPct = weeklyReturn(await request(`/api/v5/market/candles?${query}&bar=1Dutc&limit=10`, fetchImpl), clock(now).getTime()); }
  catch (error) { row.errors.push(`七日走势：${error.message}`); }
  if (swap) {
    try { Object.assign(row, fundingMetrics(await request(`/api/v5/public/funding-rate?${query}`, fetchImpl), instId, clock(now).getTime())); }
    catch (error) { row.errors.push(`资金费率：${error.message}`); }
  }
  if ([row.change24hPct, row.high24h, row.low24h, row.spreadPct].some(value => value === null) || (!swap && row.volume24hQuote === null)) row.errors.push("部分行情字段缺失");
  row.status = row.errors.length ? "PARTIAL" : "OK";
  const pct = value => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  row.summary = [row.change24hPct === null ? "24 小时涨跌未知" : `24 小时 ${pct(row.change24hPct)}`, row.return7dPct === null ? "七日收盘走势待补齐" : `最近七日收盘 ${pct(row.return7dPct)}`,
    swap ? "永续合约，需关注杠杆与资金费用" : null, kind === "tradfi" ? "传统资产关联衍生品，与项目代币区分查看" : null].filter(Boolean).join("；") + "。";
  return row;
}

export async function runCryptoWatch({ directory, fetchImpl = fetch, now = () => new Date() }) {
  const started = clock(now), generatedAt = started.toISOString(), date = dateInShanghai(started);
  await mkdir(join(directory, "daily"), { recursive: true, mode: 0o700 });
  const lock = await acquireCollectorLock(join(directory, "collector.lock"));
  try {
    let watchlist;
    try { watchlist = validateWatchlist(await readJson(join(directory, "watchlist.json"))); }
    catch (error) {
      await writeJson(join(directory, "state.json"), { schemaVersion: 1, lastRunAt: generatedAt, lastAttempt: { date, startedAt: generatedAt, finishedAt: clock(now).toISOString(), status: "FAILED", errors: [error.message] } });
      throw error;
    }
    const tokens = [];
    for (const instrument of watchlist.instruments) tokens.push(await collectToken(instrument, fetchImpl, now));
    const previousNews = await readJson(join(directory, "news.json")).catch(() => null);
    const news = await collectCryptoNews({ instruments: watchlist.instruments, previous: previousNews, fetchImpl, now });
    await writeJson(join(directory, "news.json"), news);
    const failed = tokens.filter(row => row.status === "FAILED").length;
    const status = tokens.length && failed === tokens.length ? "FAILED" : tokens.some(row => row.status !== "OK") ? "PARTIAL" : "OK";
    const report = { schemaVersion: 1, date, generatedAt, status, watchlist, tokens, news, errors: failed ? [`${failed} 个交易品种行情采集失败`] : [] };
    const oldHistory = await readJson(join(directory, "history.json"), []);
    if (!Array.isArray(oldHistory)) throw new Error("数字货币历史索引已损坏");
    const history = [...oldHistory.filter(row => row.date !== date), { date, generatedAt, status, tokenCount: tokens.length, failedCount: failed }].sort((left, right) => left.date.localeCompare(right.date)).slice(-90);
    await writeJson(join(directory, "daily", `${date}.json`), report);
    if (status !== "FAILED") await writeJson(join(directory, "latest.json"), report);
    await writeJson(join(directory, "history.json"), history);
    await writeJson(join(directory, "state.json"), { schemaVersion: 1, lastRunAt: generatedAt, lastAttempt: { date, startedAt: generatedAt, finishedAt: clock(now).toISOString(), status, newsStatus: news.status, errors: [...report.errors, ...news.errors] } });
    return report;
  } finally { await lock.release(); }
}

export async function loadCryptoWatch({ directory, now = () => new Date() }) {
  const savedNews = await readNews(directory);
  const empty = { status: "MISSING", latest: null, history: [], watchlist: null, lastAttempt: null, stale: false, watchlistStale: false, news: savedNews };
  try {
    const [latest, history, rawList, state] = await Promise.all([readJson(join(directory, "latest.json")), readJson(join(directory, "history.json"), []), readJson(join(directory, "watchlist.json")), readJson(join(directory, "state.json"))]);
    const watchlist = rawList === null ? null : validateWatchlist(rawList);
    if (!Array.isArray(history) || history.some(row => !/^\d{4}-\d{2}-\d{2}$/.test(row?.date) || !["OK", "PARTIAL", "FAILED"].includes(row.status))
      || (latest !== null && (latest.schemaVersion !== 1 || !Array.isArray(latest.tokens) || !Number.isFinite(Date.parse(latest.generatedAt)) || !["OK", "PARTIAL"].includes(latest.status)))
      || (state !== null && (state.schemaVersion !== 1 || !["OK", "PARTIAL", "FAILED"].includes(state.lastAttempt?.status)))) throw new Error("数字货币汇总文件格式无效");
    const nowMs = clock(now).getTime();
    const stale = latest !== null && (nowMs - Date.parse(latest.generatedAt) > 26 * 3_600_000 || Date.parse(latest.generatedAt) > nowMs + 60_000);
    const watchlistStale = watchlist !== null && (nowMs - Date.parse(watchlist.syncedAt) > 36 * 3_600_000 || Date.parse(watchlist.syncedAt) > nowMs + 300_000);
    const status = state?.lastAttempt.status === "FAILED" ? "FAILED" : latest === null ? "MISSING" : stale ? "STALE" : latest.status === "PARTIAL" ? "PARTIAL" : "AVAILABLE";
    const news = savedNews || latest?.news || null;
    const newsStale = news !== null && (!Number.isFinite(Date.parse(news.generatedAt)) || nowMs - Date.parse(news.generatedAt) > 26 * 3_600_000 || Date.parse(news.generatedAt) > nowMs + 300_000);
    return { status, latest, history: history.slice(-90).reverse(), watchlist, lastAttempt: state?.lastAttempt ?? null, stale, watchlistStale, news: news ? { ...news, stale: newsStale } : null };
  } catch (error) { return { ...empty, status: "ERROR", error: error.message }; }
}
