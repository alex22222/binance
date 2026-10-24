import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readPersonalAssets, savePersonalAssets, createPersonalAssetsSnapshot } from "./personal-assets.mjs";
import { valuePersonalAssetState } from "./personal-assets-fx.mjs";
import { nextAssetRefreshAt } from "./personal-assets-core.mjs";

const CATALOG = {
  HK0000857299: { name: "泰康开泰美元货币（A Acc）", currency: "USD", source: "泰康资产管理（香港）", url: "https://hk.taikangasset.cn/hk/product_service/productService.html" },
  HK0000478872: { name: "高腾微财货币基金（A 港元累积）", currency: "HKD", source: "高腾国际资产管理", url: "https://www.gaotengasset.com/zh-HK/product-services" },
  US9229083632: { name: "Vanguard 标普500 ETF（VOO）", currency: "USD", source: "Vanguard（发行人）", priceBasis: "market-close", url: "https://investor.vanguard.com/investment-products/etfs/profile/voo" },
};
const INTERVAL = 12 * 60 * 60_000;
const fail = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode, fundError: true });
const day = at => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(at);
const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validQuantity = value => typeof value === "string" && /^\d{1,12}(?:\.\d{1,9})?$/.test(value) && Number.isFinite(Number(value)) && Number(value) <= 1e12;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const filePath = stateDir => join(resolve(stateDir), "personal-assets-funds.json");

async function publicText(url, body, fetchImpl) {
  const response = await fetchImpl(url, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { Accept: body ? "application/json" : "text/html", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 1_000_000) { await response.body?.cancel(); throw fail("基金管理人接口暂不可用，保留上次有效估值。"); }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1_000_000) throw fail("基金报价响应过大，未更新估值。"); chunks.push(Buffer.from(value)); }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}

export async function fetchAssetFundNav({ isin, fetchImpl = fetch, now = new Date() }) {
  if (!Object.hasOwn(CATALOG, isin)) throw fail("暂不支持此基金份额类别，请核对 ISIN。", 400);
  try {
    let nav; let date;
    if (isin === "HK0000857299") {
      const body = { fundCode: "20220530", language: "hk" };
      const [identity, quotes] = await Promise.all(["/api/product/transacTional", "/api/tblProductQuotation/getTheLast"].map(async path => JSON.parse(await publicText("https://hk.taikangasset.cn" + path, body, fetchImpl))));
      if (identity.code !== 0 || identity.data?.fundId !== 134 || !identity.data?.isinCode?.includes("HK0000857299（A類 – 美元）") || quotes.code !== 0 || !Array.isArray(quotes.data)) throw Error();
      const rows = quotes.data.filter(row => row.fundCode === "20220530" && row.classType === "ausdacc");
      if (rows.length !== 1 || rows[0].className !== "A類-美元-累積" || rows[0].currencyCode !== "美元") throw Error();
      nav = rows[0].netAssets; date = rows[0].date;
    } else if (isin === "US9229083632") {
      const html = await publicText(CATALOG[isin].url, null, fetchImpl);
      const blocks = [...html.matchAll(/\bdata-vgn-funds-profile="([^"]+)"/g)];
      if (blocks.length !== 1) throw Error();
      const entities = { "&#34;": '"', "&quot;": '"', "&amp;": "&", "&#39;": "'", "&lt;": "<", "&gt;": ">" };
      const data = JSON.parse(blocks[0][1].replace(/&#34;|&quot;|&amp;|&#39;|&lt;|&gt;/g, entity => entities[entity]));
      const overview = data.overview; const dashboard = data.dashboard; const price = data.price;
      if (overview?.cusip !== "922908363" || overview.fundId !== "0968" || overview.iovTickerSymbol !== "VOO.P"
        || dashboard?.ticker !== "VOO" || dashboard.fundId !== "0968" || dashboard.fundFullName !== "Vanguard S&P 500 ETF" || data.fundFlags?.isEtf !== true
        || overview.marketPrice !== dashboard.marketPrice || overview.marketPrice !== price?.marketPrice
        || overview.marketPriceAsOfDate !== dashboard.marketPriceAsOfDate || overview.marketPriceAsOfDate !== price.marketPriceAsOfDate
        || typeof overview.marketPrice !== "string" || !/^\$(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,9})?$/.test(overview.marketPrice)
        || typeof overview.marketPriceAsOfDate !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(overview.marketPriceAsOfDate)) throw Error();
      nav = overview.marketPrice.slice(1).replaceAll(",", "");
      const [month, day, year] = overview.marketPriceAsOfDate.split("/"); date = `${year}-${month}-${day}`;
    } else {
      const html = await publicText(CATALOG[isin].url, null, fetchImpl);
      // Parse the site's JSON hydration data without evaluating any page script.
      const blocks = [...html.matchAll(/window\.__REACT_QUERY_STATE__\s*=\s*(\{[^\r\n]*\});/g)];
      if (blocks.length !== 1) throw Error();
      const state = JSON.parse(blocks[0][1]);
      const products = state.queries?.filter(query => query.queryKey?.length === 1 && query.queryKey[0] === "indexNewsCenter");
      if (products?.length !== 1 || !Array.isArray(products[0].state?.data?.[0])) throw Error();
      const funds = products[0].state.data[0].filter(fund => fund.fundId === "10008" && fund.fundName?.trim() === "高騰微基金-高騰微財貨幣基金");
      if (funds.length !== 1 || !Array.isArray(funds[0].fundClassInfo)) throw Error();
      const rows = funds[0].fundClassInfo.filter(row => row.isinCode === isin);
      if (rows.length !== 1 || rows[0].fundClassId !== "10008003" || rows[0].fundClassName !== "A(港元)-累積" || rows[0].currency !== "港元") throw Error();
      nav = rows[0].fundNav; date = rows[0].navDate;
    }
    if (typeof nav !== "string" || !/^\d{1,9}(?:\.\d{1,9})?$/.test(nav) || Number(nav) <= 0 || !validDate(date) || date > day(now)) throw Error();
    if (Date.parse(day(now)) - Date.parse(date) > 7 * 86_400_000) throw fail("官方净值或价格超过七天未更新，保留上次有效估值。");
    return { isin, ...CATALOG[isin], nav, date, fetchedAt: now.toISOString() };
  } catch (error) { if (error.fundError) throw error; throw fail("官方基金或 ETF 身份、份额类别或报价无法核实，保留上次有效估值。"); }
}

async function readConfig(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 500_000) throw Error();
    const config = JSON.parse(await file.readFile("utf8")); const ids = new Set();
    if (config.schemaVersion !== 1 || !Array.isArray(config.bindings) || config.bindings.length > 100) throw Error();
    for (const row of config.bindings) {
      if (!row || typeof row.entryId !== "string" || ids.has(row.entryId) || !Object.hasOwn(CATALOG, row.isin) || !validQuantity(row.quantity)
        || !validDate(row.confirmedOn) || typeof row.enabled !== "boolean" || !/^[a-f0-9]{64}$/.test(row.fingerprint)) throw Error();
      ids.add(row.entryId);
    }
    return config;
  } catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, bindings: [] }; throw fail("基金重估配置无法读取，已保存资产未被改动。", 500); }
  finally { await file?.close(); }
}
async function writePrivate(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`; let file;
  try { file = await open(temporary, "wx", 0o600); await file.writeFile(JSON.stringify(data) + "\n"); await file.sync(); await file.close(); file = null; await rename(temporary, path); }
  finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function locked(stateDir, action) {
  const directory = resolve(stateDir); await mkdir(directory, { recursive: true, mode: 0o700 }); const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022)) throw fail("基金存储目录不安全。", 500);
  const path = filePath(stateDir); let lock;
  try { lock = await open(path + ".lock", "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw fail("基金重估正在进行，请稍后重试。", 409); throw error; }
  try { const config = await readConfig(path); return await action(config, () => writePrivate(path, config)); }
  finally { await lock.close(); await unlink(path + ".lock"); }
}
function target(state, entryId) {
  const entry = state.portfolio.entries.find(row => row.id === entryId);
  const account = entry && state.portfolio.accounts.find(row => row.id === entry.accountId);
  if (!entry || entry.kind !== "holding" || !["货币基金", "基金", "股票ETF"].includes(entry.category) || account?.basis !== "holdings" || account.reviewStatus === "pending" || account.platform === "待确认") throw fail("请选择已确认账户中按持仓计入的基金或 ETF 记录。", 409);
  return { entry, account, fingerprint: hash({ entry, account }) };
}
function revalued(entry, binding, quote) {
  const amount = Number((Number(binding.quantity) * Number(quote.nav)).toFixed(8));
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw fail("基金份额与净值乘积超出支持范围。", 400);
  return { ...entry, name: quote.name, currency: quote.currency, amount, asOf: quote.date, asOfBasis: "statement", source: "api",
    note: quote.priceBasis === "market-close"
      ? `发行人公布市场收盘价重估，非银行账户同步；ISIN ${binding.isin}；长期持有股数 ${binding.quantity}（用户确认日 ${binding.confirmedOn}，不是到期日）；市场收盘价 ${quote.nav} ${quote.currency}，价格日 ${quote.date}；来源 ${quote.source}。股数不自动变化，买卖或拆并股后请更新；不是盘中实时价格。`
      : `官方净值重估，非银行账户同步；ISIN ${binding.isin}；长期持有份额 ${binding.quantity}（用户确认日 ${binding.confirmedOn}，不是到期日）；净值 ${quote.nav} ${quote.currency}，净值日 ${quote.date}；来源 ${quote.source}。份额不自动变化，申购赎回后请更新。` };
}
function status(config, state, now) {
  return { status: "available", bindings: config.bindings.map(binding => {
    const quote = binding.quote;
    let changed = true; try { changed = target(state, binding.entryId).fingerprint !== binding.fingerprint; } catch {}
    return { entryId: binding.entryId, accountId: binding.accountId, isin: binding.isin, ...CATALOG[binding.isin], quantity: binding.quantity, confirmedOn: binding.confirmedOn,
      enabled: binding.enabled && !changed, lastAttemptAt: binding.lastAttemptAt || null, lastFetchedAt: binding.lastFetchedAt || null, lastAppliedAt: binding.lastAppliedAt || null,
      nav: quote?.nav || null, navDate: quote?.date || null,
      delayed: !binding.lastFetchedAt || now - Date.parse(binding.lastFetchedAt) > INTERVAL * 2 || Boolean(quote?.date && Date.parse(day(now)) - Date.parse(quote.date) > 4 * 86_400_000),
      lastError: changed ? "持仓已手动修改或被其他来源更新，自动净值重估已暂停，请重新确认份额。" : binding.lastError || null };
  }) };
}
export async function readAssetFundStatus({ stateDir, state, now = new Date() }) { return status(await readConfig(filePath(stateDir)), state || await readPersonalAssets({ stateDir }), now); }

export async function configureAssetFund({ stateDir, entryId, isin, quantity, confirmedOn, revision, fetchImpl = fetch, now = new Date() }) {
  if (!Object.hasOwn(CATALOG, isin) || !validQuantity(quantity) || !validDate(confirmedOn) || confirmedOn > day(now)) throw fail("请核对基金 ISIN、非负份额及确认日期。", 400);
  return locked(stateDir, async (config, persist) => {
    const current = await readPersonalAssets({ stateDir }); if (current.revision !== revision) throw fail("资产版本已更新，请重新载入后核对。", 409);
    const original = target(current, entryId);
    if ((CATALOG[isin].priceBasis === "market-close") !== (original.entry.category === "股票ETF")) throw fail("基金或 ETF 类型与所选报价不匹配，请核对原持仓。", 400);
    const quote = await fetchAssetFundNav({ isin, fetchImpl, now });
    const binding = { entryId, accountId: original.account.id, isin, quantity, confirmedOn, enabled: true };
    const entry = revalued(original.entry, binding, quote);
    const valued = await valuePersonalAssetState(current, { stateDir });
    await createPersonalAssetsSnapshot({ stateDir, revision, valuation: { rates: valued.portfolio.rates, fx: valued.fx } });
    await writePrivate(join(resolve(stateDir), "personal-assets-funds-previous.json"), current);
    const assets = await savePersonalAssets({ stateDir, revision, portfolio: { ...current.portfolio, entries: current.portfolio.entries.map(row => row.id === entryId ? entry : row) } });
    Object.assign(binding, { quote, fingerprint: target(assets, entryId).fingerprint, lastAttemptAt: now.toISOString(), lastFetchedAt: quote.fetchedAt, lastAppliedAt: now.toISOString(), lastError: null });
    config.bindings = [...config.bindings.filter(row => row.entryId !== entryId), binding]; await persist(); return assets;
  });
}

export async function runAssetFundCycle({ stateDir, fetchImpl = fetch, now = new Date() }) {
  if (!(await readConfig(filePath(stateDir))).bindings.some(row => row.enabled)) return { attempted: 0, applied: 0, failed: 0 };
  return locked(stateDir, async (config, persist) => {
    const result = { attempted: 0, applied: 0, failed: 0 };
    for (const binding of config.bindings) {
      if (!binding.enabled || binding.lastAttemptAt && now.getTime() < Date.parse(nextAssetRefreshAt(binding.lastAttemptAt))) continue;
      result.attempted++; binding.lastAttemptAt = now.toISOString();
      try {
        let current = await readPersonalAssets({ stateDir });
        if (target(current, binding.entryId).fingerprint !== binding.fingerprint) { binding.enabled = false; throw fail("持仓已修改，自动重估暂停，请重新确认份额。", 409); }
        const quote = await fetchAssetFundNav({ isin: binding.isin, fetchImpl, now });
        if (binding.quote?.date > quote.date) throw fail("官方净值日期发生倒退，保留上次有效估值。");
        for (let attempt = 0; attempt < 3; attempt++) {
          current = await readPersonalAssets({ stateDir }); const selected = target(current, binding.entryId);
          if (selected.fingerprint !== binding.fingerprint) { binding.enabled = false; throw fail("持仓已修改，自动重估暂停，请重新确认份额。", 409); }
          const entry = revalued(selected.entry, binding, quote);
          if (JSON.stringify(entry) === JSON.stringify(selected.entry)) break;
          try {
            await writePrivate(join(resolve(stateDir), "personal-assets-funds-previous.json"), current);
            const assets = await savePersonalAssets({ stateDir, revision: current.revision, portfolio: { ...current.portfolio, entries: current.portfolio.entries.map(row => row.id === binding.entryId ? entry : row) } });
            binding.fingerprint = target(assets, binding.entryId).fingerprint; binding.lastAppliedAt = now.toISOString(); result.applied++; break;
          } catch (error) { if (error.statusCode !== 409 || attempt === 2) throw error; }
        }
        binding.quote = quote; binding.lastFetchedAt = quote.fetchedAt; binding.lastError = null;
      } catch (error) { binding.lastError = error.fundError ? error.message : "基金重估失败，保留上次有效数据。"; result.failed++; }
      await persist();
    }
    return result;
  });
}
