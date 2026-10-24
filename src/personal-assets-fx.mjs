import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const FIAT = ["USD", "HKD", "EUR", "GBP", "JPY", "SGD", "AUD"];
const COINS = ["USDT", "USDC"];
const INTERVAL = 5 * 60_000;
const inflight = new Map();
const day = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(at);
const validValue = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e9;
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const invalid = () => new Error("Invalid automatic exchange rate response");

async function publicJson(url, fetchImpl) {
  const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 150_000) {
    await response.body?.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 150_000) throw invalid();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

function decimal(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) throw invalid();
  const number = Number(value);
  if (!validValue(number)) throw invalid();
  return number;
}

async function fiatRates(fetchImpl, now) {
  let values;
  let metadata;
  try {
    const json = await publicJson("https://api.coinbase.com/v2/exchange-rates?currency=USD", fetchImpl);
    if (json.data?.currency !== "USD" || decimal(json.data.rates?.USD) !== 1) throw invalid();
    values = { CNY: decimal(json.data.rates.CNY) };
    for (const currency of FIAT) values[currency] = decimal(json.data.rates[currency]);
    // Coinbase provides current rates but no market observation timestamp.
    metadata = { source: "Coinbase", date: day(now), asOf: null, timeBasis: "retrieved", fetchedAt: now.toISOString() };
  } catch {
    const json = await publicJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY,HKD,EUR,GBP,JPY,SGD,AUD", fetchImpl);
    if (json.base !== "USD" || json.amount !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(json.date) || !Number.isFinite(Date.parse(json.date))
      || Date.parse(json.date) > now.getTime() || now.getTime() - Date.parse(json.date) > 7 * 86_400_000) throw invalid();
    values = { USD: 1 };
    for (const currency of ["CNY", ...FIAT.filter((value) => value !== "USD")]) {
      if (!validValue(json.rates?.[currency])) throw invalid();
      values[currency] = json.rates[currency];
    }
    metadata = { source: "ECB / Frankfurter（日参考）", date: json.date, asOf: null, timeBasis: "daily", fetchedAt: now.toISOString() };
  }
  const rates = {};
  for (const currency of FIAT) {
    const value = values.CNY / values[currency];
    if (!validValue(value)) throw invalid();
    rates[currency] = { value, ...metadata };
  }
  return rates;
}

async function stablecoinPrice(currency, fetchImpl, now) {
  const json = await publicJson(`https://api.kraken.com/0/public/Trades?pair=${currency}USD&count=1`, fetchImpl);
  const key = currency === "USDT" ? "USDTZUSD" : "USDCUSD";
  if (!Array.isArray(json.error) || json.error.length || !Array.isArray(json.result?.[key]) || json.result[key].length !== 1) throw invalid();
  const trade = json.result[key][0];
  if (!Array.isArray(trade) || typeof trade[2] !== "number" || !Number.isFinite(trade[2])) throw invalid();
  const asOf = new Date(trade[2] * 1000);
  if (!Number.isFinite(asOf.getTime()) || asOf.getTime() > now.getTime() + 60_000 || now.getTime() - asOf.getTime() > 86_400_000) throw invalid();
  return { price: decimal(trade[0]), asOf: asOf.toISOString() };
}

export async function fetchPersonalAssetRates({ fetchImpl = fetch, now = new Date() } = {}) {
  const [fiat, ...coins] = await Promise.allSettled([fiatRates(fetchImpl, now), ...COINS.map((currency) => stablecoinPrice(currency, fetchImpl, now))]);
  const rates = {};
  const errors = [];
  if (fiat.status === "fulfilled") Object.assign(rates, fiat.value);
  else errors.push("外汇报价暂不可用。");
  COINS.forEach((currency, index) => {
    if (coins[index].status !== "fulfilled" || !rates.USD) { errors.push(`${currency} 汇率暂不可用，未按 1 美元估算。`); return; }
    const trade = coins[index].value;
    const value = trade.price * rates.USD.value;
    if (!validValue(value)) { errors.push(`${currency} 汇率暂不可用。`); return; }
    rates[currency] = { value, date: rates.USD.date, source: `Kraken × ${rates.USD.source}`, fetchedAt: now.toISOString(),
      asOf: trade.asOf, timeBasis: "market-and-retrieved", usdPrice: trade.price, fiatTimeBasis: rates.USD.timeBasis };
  });
  if (rates.USD?.timeBasis === "daily") errors.push("最新外汇接口暂不可用，当前使用标明日期的日参考汇率。");
  return { rates, errors };
}

function cachePath(stateDir) { return join(resolve(stateDir), "personal-assets-fx.json"); }

async function readCache(path, now) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 150_000) return null;
    const value = JSON.parse(await file.readFile("utf8"));
    if (value.schemaVersion !== 1 || !validTime(value.attemptedAt) || Date.parse(value.attemptedAt) > now.getTime() + 60_000
      || !value.rates || typeof value.rates !== "object" || Array.isArray(value.rates) || !Array.isArray(value.errors)) return null;
    for (const [currency, rate] of Object.entries(value.rates)) {
      if (![...FIAT, ...COINS].includes(currency) || !validValue(rate.value) || !validTime(rate.fetchedAt) || Date.parse(rate.fetchedAt) > now.getTime() + 60_000
        || !/^\d{4}-\d{2}-\d{2}$/.test(rate.date) || !["retrieved", "daily", "market-and-retrieved"].includes(rate.timeBasis)
        || typeof rate.source !== "string" || rate.source.length > 150 || (rate.asOf !== null && !validTime(rate.asOf))) return null;
    }
    return value;
  } catch { return null; }
  finally { await file?.close(); }
}

function view(cache, now, extraErrors = []) {
  const rates = {};
  for (const [currency, rate] of Object.entries(cache?.rates || {})) {
    const age = now.getTime() - Date.parse(rate.fetchedAt);
    if (age > (COINS.includes(currency) ? 86_400_000 : 7 * 86_400_000)) continue;
    if (COINS.includes(currency) && (!validTime(rate.asOf) || now.getTime() - Date.parse(rate.asOf) > 86_400_000)) continue;
    if ((rate.timeBasis === "daily" || rate.fiatTimeBasis === "daily") && now.getTime() - Date.parse(rate.date) > 7 * 86_400_000) continue;
    const oldTrade = COINS.includes(currency) && now.getTime() - Date.parse(rate.asOf) > INTERVAL * 2;
    rates[currency] = { ...rate, stale: age > INTERVAL * 2 || oldTrade || rate.stale === true };
  }
  const available = Object.values(rates);
  const status = !rates.USD ? "unavailable" : extraErrors.length || available.some((rate) => rate.stale) || cache?.errors?.length ? "stale" : "fresh";
  return { mode: "automatic", status, fetchedAt: available.length ? new Date(Math.max(...available.map((rate) => Date.parse(rate.fetchedAt)))).toISOString() : null,
    source: [...new Set(available.map((rate) => rate.source))].join(" / ") || null,
    rates, errors: [...new Set([...(cache?.errors || []), ...extraErrors])] };
}

async function writeCache(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(JSON.stringify(data, null, 2) + "\n");
    await file.sync();
    await file.close(); file = null;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function getPersonalAssetRates({ stateDir, force = false, fetchImpl = fetch, now = new Date() }) {
  if (process.env.PERSONAL_ASSETS_FX_DISABLED === "1") return view(null, now, ["当前环境未启用自动汇率。"]);
  const path = cachePath(stateDir);
  const cached = await readCache(path, now);
  if (cached && now.getTime() - Date.parse(cached.attemptedAt) < (force ? 10_000 : INTERVAL)) return view(cached, now);
  if (inflight.has(path)) return inflight.get(path);
  const pending = (async () => {
    try {
      await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
      const directory = await lstat(resolve(stateDir));
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022)) throw invalid();
      // Only derived quotes live here. Atomic replacement is sufficient when the
      // Dashboard and collector refresh together; no persistent lock can strand it.
      const fresh = await fetchPersonalAssetRates({ fetchImpl, now });
      const rates = { ...view(cached, now).rates };
      for (const currency of Object.keys(rates)) rates[currency].stale = true;
      Object.assign(rates, fresh.rates);
      const next = { schemaVersion: 1, attemptedAt: now.toISOString(), rates, errors: fresh.errors };
      await writeCache(path, next);
      return view(next, now);
    } catch { return view(cached, now, ["自动汇率暂不可用，保留上次可用数据。"]); }
  })();
  inflight.set(path, pending);
  try { return await pending; }
  finally { inflight.delete(path); }
}

export async function valuePersonalAssetState(state, options) {
  const fx = await getPersonalAssetRates(options);
  const rates = { CNY: { value: 1, date: day(options.now || new Date()) } };
  for (const [currency, rate] of Object.entries(fx.rates)) rates[currency] = { value: rate.value, date: rate.date,
    note: `${rate.source}；获取时间 ${rate.fetchedAt}${rate.asOf ? `；最近成交 ${rate.asOf}` : "；源未提供精确报价时间"}${rate.stale ? "；更新延迟" : ""}` };
  return { ...state, portfolio: { ...state.portfolio, rates }, fx };
}
