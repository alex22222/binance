import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readPersonalAssets, savePersonalAssets, createPersonalAssetsSnapshot, readAssetRefreshSchedule } from "./personal-assets.mjs";
import { valuePersonalAssetState } from "./personal-assets-fx.mjs";
import { nextAssetRefreshAt } from "./personal-assets-core.mjs";

const CATALOG = {
  HK0000857299: { name: "泰康开泰美元货币（A Acc）", currency: "USD", source: "泰康资产管理（香港）", url: "https://hk.taikangasset.cn/hk/product_service/productService.html" },
  HK0000478872: { name: "高腾微财货币基金（A 港元累积）", currency: "HKD", source: "高腾国际资产管理", url: "https://www.gaotengasset.com/zh-HK/product-services" },
  HK0000465903: { name: "汇丰环球货币基金－港元（D 累积）", currency: "HKD", source: "汇丰环球投资管理", url: "https://www.assetmanagement.hsbc.com.hk/en/individual-investor/fund-centre" },
  US9229083632: { name: "Vanguard 标普500 ETF（VOO）", currency: "USD", source: "Vanguard（发行人）", priceBasis: "market-close", url: "https://investor.vanguard.com/investment-products/etfs/profile/voo" },
};
const STOCKS = {
  ...Object.fromEntries([
    ["sz000534", "万泽股份"], ["sz002617", "露笑科技"], ["sh600704", "物产中大"], ["sh601012", "隆基绿能"], ["sh601216", "君正集团"],
  ].map(([symbol, name]) => [symbol, { name, currency: "CNY", source: "腾讯证券行情", priceBasis: "market-quote", url: `https://gu.qq.com/${symbol}/gp` }])),
  ...Object.fromEntries([
    ["usSPCX", "SpaceX（SPCX）", "SpaceX", "SPCX.OQ", "Space Exploration Technologies Corp.", "股票"],
    ["usSPY", "SPDR 标普500 ETF（SPY）", "标普500指数ETF-SPDR", "SPY.AM", "State Street Spdr S&P 500 Etf", "股票ETF"],
    ["usPONY", "小马智行（PONY）", "小马智行", "PONY.OQ", "Pony Ai Inc", "股票"],
    ["usTEM", "Tempus AI（TEM）", "Tempus AI", "TEM.OQ", "Tempus Ai, Inc.", "股票"],
    ["usSFTBY", "软银集团 ADR（SFTBY）", "软银", "SFTBY.PS", "Softbank Group Corp", "股票"],
  ].map(([symbol, name, quoteName, quoteCode, issuer, category]) => [symbol, { name, quoteName, quoteCode, issuer, category, currency: "USD", source: "腾讯证券行情", priceBasis: "market-quote", url: `https://gu.qq.com/${symbol}/gp` }])),
};
const instrument = row => row.symbol === undefined ? CATALOG[row.isin] : STOCKS[row.symbol];
const validInstrument = row => row.symbol === undefined ? typeof row.isin === "string" && Object.hasOwn(CATALOG, row.isin) : row.isin === undefined && typeof row.symbol === "string" && Object.hasOwn(STOCKS, row.symbol);
const INTERVAL = 24 * 60 * 60_000;
const fail = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode, fundError: true });
const day = at => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(at);
const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validQuantity = value => typeof value === "string" && /^\d{1,12}(?:\.\d{1,9})?$/.test(value) && Number.isFinite(Number(value)) && Number(value) <= 1e12;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const filePath = stateDir => join(resolve(stateDir), "personal-assets-funds.json");
// Public fund-centre component configuration, not customer credentials. Keep requests on the fixed official host.
const HSBC_PAGE = {
  country: "HK", language: "EN", investorType: "INDV", tokenIssue: { url: "/api/v1/token/issue" },
  dataUrl: { url: "/api/v1/nav/funds", id: "e0FFNDg5MTJELUFEMzEtNEQ5RC04MzA4LTdBQzZERTgyQTc4Rn0=" },
  shareClassUrl: { url: "/api/v1/nav/shareclass", id: "ezUxODdjODJiLWY1YmItNDIzOC1hM2Y0LWY5NzZlY2JmMTU3OX0=" },
  filterUrl: { url: "/api/v1/nav/filters", id: "ezRFREYxQTU3LTVENkYtNDBDRC1CMjJDLTQ0NDc4Nzc1NTlFQn0=" },
  presentationUrl: { url: "/api/v1/nav/presentation", id: "e0E1NEZDODZGLUE5MDctNDUzQi04RTYyLTIxNDNBMEM1MEVGQ30=" },
  liveDataUrl: { id: "ezlEMjA2MDk5LUNCRTItNENGMy1BRThBLUM0RTMwMEIzMjlDQ30=" },
  fundDetailPageUrl: "/en/individual-investor/fund-centre", forceHttps: true,
};

// Preserve an injected reference date while network, lock and storage work advances.
function advancingClock(reference) {
  const started = performance.now();
  return () => new Date(reference.getTime() + performance.now() - started);
}

async function publicText(url, body, fetchImpl, encoding = "utf8", headers = {}, method = body ? "POST" : "GET") {
  const response = await fetchImpl(url, { method, redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { Accept: body ? "application/json" : "text/html", ...(body ? { "Content-Type": "application/json" } : {}), ...(encoding === "gb18030" ? { Referer: "https://gu.qq.com/" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 1_000_000) { await response.body?.cancel(); throw fail("报价来源接口暂不可用，保留上次有效估值。"); }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1_000_000) throw fail("报价响应过大，未更新估值。"); chunks.push(Buffer.from(value)); }
    return encoding === "utf8" ? Buffer.concat(chunks).toString("utf8") : new TextDecoder(encoding, { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function fetchAssetHoldingQuote({ isin, symbol, fetchImpl = fetch, now, clock = now ? advancingClock(now) : () => new Date() }) {
  now ??= clock();
  if (!validInstrument({ isin, symbol })) throw fail("暂不支持此证券代码或基金份额，请核对。", 400);
  if (symbol === undefined) return fetchAssetFundNav({ isin, fetchImpl, now, clock });
  try {
    const text = await publicText(`https://qt.gtimg.cn/q=${symbol}`, null, fetchImpl, "gb18030");
    const match = text.match(new RegExp(`^v_${symbol}="([^"\\r\\n]*)";\\s*$`));
    const fields = match?.[1].split("~");
    const metadata = STOCKS[symbol]; const us = metadata.currency === "USD";
    if (!fields || fields.length < 62 || fields.length > 120 || fields[1] !== (metadata.quoteName || metadata.name) || fields[2] !== (metadata.quoteCode || symbol.slice(2))
      || (us ? fields[0] !== "200" || fields[35] !== "USD" || fields[46] !== metadata.issuer || fields[56] !== (metadata.category === "股票ETF" ? "GP-ETF" : "GP") : fields[61] !== "GP-A")
      || !/^\d{1,9}(?:\.\d{1,6})?$/.test(fields[3]) || Number(fields[3]) <= 0) throw Error();
    now = clock();
    const at = fields[30]; let date; let observedAt = null;
    if (us) {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) || Number(at.slice(11,13)) > 23 || Number(at.slice(14,16)) > 59 || Number(at.slice(17,19)) > 59) throw Error();
      date = at.slice(0,10);
      if (!validDate(date) || date > day(now) || Date.parse(day(now)) - Date.parse(date) > 7 * 86_400_000) throw Error();
    } else {
      if (!/^\d{14}$/.test(at)) throw Error();
      date = `${at.slice(0,4)}-${at.slice(4,6)}-${at.slice(6,8)}`;
      const observed = new Date(`${date}T${at.slice(8,10)}:${at.slice(10,12)}:${at.slice(12,14)}+08:00`);
      if (!validDate(date) || Number(at.slice(8,10)) > 23 || Number(at.slice(10,12)) > 59 || Number(at.slice(12,14)) > 59
        || !Number.isFinite(observed.getTime()) || observed.getTime() > now.getTime() + 300_000 || now.getTime() - observed.getTime() > 7 * 86_400_000) throw Error();
      observedAt = observed.toISOString();
    }
    return { symbol, ...metadata, price: fields[3], date, observedAt, ...(us ? { sourceTime: at, timeBasis: "provider-timezone-unverified" } : {}), fetchedAt: now.toISOString() };
  } catch (error) { if (error.fundError) throw error; throw fail("证券身份、未复权报价或行情日期无法核实，保留上次有效估值。"); }
}

export async function fetchAssetFundNav({ isin, fetchImpl = fetch, now, clock = now ? advancingClock(now) : () => new Date() }) {
  now ??= clock();
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
    } else if (isin === "HK0000465903") {
      const host = "https://www.assetmanagement.hsbc.com.hk";
      const token = (await publicText(host + "/api/v1/token/issue", null, fetchImpl, "utf8",
        { "X-Country": "HK", "X-Language": "EN", "X-Component": HSBC_PAGE.dataUrl.id, "Content-Length": "0" }, "POST")).trim();
      if (token.length > 4000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
      const body = { appliedFilters: [], paging: { currentPage: 1, fundsPerPage: 20 }, view: "Prices", searchTerm: [isin], selectedValues: [], pageInformation: HSBC_PAGE };
      const data = JSON.parse(await publicText(host + "/api/v1/nav/funds", body, fetchImpl, "utf8",
        { Authorization: "Bearer " + token, "IFC-Cache-Header": "en,hk,indv,prices,hk0000465903,1,n20" }));
      if (data.view !== "Prices" || data.invalidConfigurationErrorMessage !== null || !Array.isArray(data.messages) || data.messages.length
        || data.filteredTotal !== 1 || data.fundsTotal !== 1 || data.shareTotal !== 1 || data.paging?.currentPage !== 1 || data.paging.numberOfFunds !== 1 || data.paging.totalPages !== 1
        || !Array.isArray(data.funds) || data.funds.length !== 1) throw Error();
      const fund = data.funds[0];
      if (fund.id !== "FSGBR06FJR" || fund.name !== "HSBC Global Money Funds - Hong Kong Dollar" || !Array.isArray(fund.shareClasses) || fund.shareClasses.length !== 1) throw Error();
      const share = fund.shareClasses[0];
      if (share.id !== "F0000119QG" || share.name !== "D" || share.isin !== isin || !Array.isArray(share.data)) throw Error();
      const field = id => { const rows = share.data.filter(row => row.columnId === id); if (rows.length !== 1) throw Error(); return rows[0]; };
      const currency = field("DropDown_PriceCurrency");
      const currencies = currency.groups?.flatMap(group => group.options || []).filter(option => option.id === currency.selected);
      if (currency.selected !== "0P0001EPQ8" || currencies?.length !== 1 || currencies[0].value !== "HKD" || field("UniqueIdentifier").value.trim() !== isin) throw Error();
      nav = field("Nav").value.trim();
      const parts = /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/.exec(field("PriceDate").value.trim());
      if (!parts) throw Error();
      const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(parts[2]) + 1;
      date = `${parts[3]}-${String(month).padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
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
    now = clock();
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
      if (!row || typeof row.entryId !== "string" || ids.has(row.entryId) || !validInstrument(row) || !validQuantity(row.quantity)
        || row.symbol !== undefined && (STOCKS[row.symbol].currency === "CNY" && !Number.isInteger(Number(row.quantity)) || !["manual", "screenshot"].includes(row.quantityBasis))
        || !validDate(row.confirmedOn) || typeof row.enabled !== "boolean" || !/^[a-f0-9]{64}$/.test(row.fingerprint)) throw Error();
      ids.add(row.entryId);
    }
    return config;
  } catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, bindings: [] }; throw fail("持仓重估配置无法读取，已保存资产未被改动。", 500); }
  finally { await file?.close(); }
}
async function writePrivate(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`; let file;
  try { file = await open(temporary, "wx", 0o600); await file.writeFile(JSON.stringify(data) + "\n"); await file.sync(); await file.close(); file = null; await rename(temporary, path); }
  finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function locked(stateDir, action) {
  const directory = resolve(stateDir); await mkdir(directory, { recursive: true, mode: 0o700 }); const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022)) throw fail("持仓估值存储目录不安全。", 500);
  const path = filePath(stateDir); let lock;
  try { lock = await open(path + ".lock", "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw fail("持仓重估正在进行，请稍后重试。", 409); throw error; }
  try { const config = await readConfig(path); return await action(config, () => writePrivate(path, config)); }
  finally { await lock.close(); await unlink(path + ".lock"); }
}
function target(state, entryId) {
  const entry = state.portfolio.entries.find(row => row.id === entryId);
  const account = entry && state.portfolio.accounts.find(row => row.id === entry.accountId);
  if (!entry || entry.kind !== "holding" || !["货币基金", "基金", "股票ETF", "股票"].includes(entry.category) || account?.basis !== "holdings" || account.reviewStatus === "pending" || account.platform === "待确认") throw fail("请选择已确认账户中按持仓计入的基金、ETF 或股票记录。", 409);
  return { entry, account, fingerprint: hash({ entry, account }) };
}
function revalued(entry, binding, quote) {
  const amount = Number((Number(binding.quantity) * Number(quote.price ?? quote.nav)).toFixed(8));
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw fail("持有数量与报价乘积超出支持范围。", 400);
  return { ...entry, name: quote.name, currency: quote.currency, amount, asOf: quote.date, asOfBasis: "statement", source: "api",
    note: quote.priceBasis === "market-quote"
      ? `按未复权市价重估，非券商账户同步；证券代码 ${binding.symbol}；股数 ${binding.quantity}（${binding.quantityBasis === "screenshot" ? "截图数量录入日" : "用户确认日"} ${binding.confirmedOn}${binding.quantityBasis === "screenshot" ? "，截图持股时点未核实" : ""}）；行情价格 ${quote.price} ${quote.currency}，源行情时间 ${quote.observedAt || `${quote.sourceTime}（源时区未核实）`}；来源 ${quote.source}。只更新市值，现金与股数不自动变化；买卖、送转或拆并股后请更新，未将旧截图盈亏当成最新盈亏。`
      : quote.priceBasis === "market-close"
      ? `发行人公布市场收盘价重估，非银行账户同步；ISIN ${binding.isin}；长期持有股数 ${binding.quantity}（用户确认日 ${binding.confirmedOn}，不是到期日）；市场收盘价 ${quote.nav} ${quote.currency}，价格日 ${quote.date}；来源 ${quote.source}。股数不自动变化，买卖或拆并股后请更新；不是盘中实时价格。`
      : `官方净值重估，非银行账户同步；ISIN ${binding.isin}；长期持有份额 ${binding.quantity}（用户确认日 ${binding.confirmedOn}，不是到期日）；净值 ${quote.nav} ${quote.currency}，净值日 ${quote.date}；来源 ${quote.source}。份额不自动变化，申购赎回后请更新。` };
}
function status(config, state, now) {
  return { status: "available", bindings: config.bindings.map(binding => {
    const quote = binding.quote;
    let changed = true; try { changed = target(state, binding.entryId).fingerprint !== binding.fingerprint; } catch {}
    return { entryId: binding.entryId, accountId: binding.accountId, ...(binding.symbol === undefined ? { isin: binding.isin, nav: quote?.nav || null, navDate: quote?.date || null }
      : { symbol: binding.symbol, quantityBasis: binding.quantityBasis, price: quote?.price || null, priceDate: quote?.date || null, observedAt: quote?.observedAt || null, sourceTime: quote?.sourceTime || null, timeBasis: quote?.timeBasis || null }), ...instrument(binding), quantity: binding.quantity, confirmedOn: binding.confirmedOn,
      enabled: binding.enabled && !changed, lastAttemptAt: binding.lastAttemptAt || null, lastFetchedAt: binding.lastFetchedAt || null, lastAppliedAt: binding.lastAppliedAt || null,
      delayed: !binding.lastFetchedAt || now - Date.parse(binding.lastFetchedAt) > INTERVAL * 2 || Boolean(quote?.date && Date.parse(day(now)) - Date.parse(quote.date) > 4 * 86_400_000),
      lastError: changed ? "持仓已手动修改或被其他来源更新，自动估值已暂停，请重新确认数量。" : binding.lastError || null };
  }) };
}
export async function readAssetFundStatus({ stateDir, state, now = new Date() }) { return status(await readConfig(filePath(stateDir)), state || await readPersonalAssets({ stateDir }), now); }

export async function configureAssetFund({ stateDir, entryId, isin, symbol, quantity, quantityBasis = "manual", confirmedOn, revision, fetchImpl = fetch, now, clock = now ? advancingClock(now) : () => new Date() }) {
  now ??= clock();
  if (!validInstrument({ isin, symbol }) || !validQuantity(quantity) || !validDate(confirmedOn) || confirmedOn > day(now)
    || symbol !== undefined && (STOCKS[symbol].currency === "CNY" && !Number.isInteger(Number(quantity)) || !["manual", "screenshot"].includes(quantityBasis))) throw fail("请核对证券标识、非负数量及数量日期。", 400);
  return locked(stateDir, async (config, persist) => {
    const current = await readPersonalAssets({ stateDir }); if (current.revision !== revision) throw fail("资产版本已更新，请重新载入后核对。", 409);
    const original = target(current, entryId);
    const metadata = instrument({ isin, symbol });
    if (symbol !== undefined ? original.entry.category !== (metadata.category || "股票") || original.entry.name !== metadata.name
      : (metadata.priceBasis === "market-close") !== (original.entry.category === "股票ETF") || original.entry.category === "股票") throw fail("证券类型或名称与所选报价不匹配，请核对原持仓。", 400);
    const quote = await fetchAssetHoldingQuote({ isin, symbol, fetchImpl, now, clock });
    const binding = { entryId, accountId: original.account.id, ...(symbol === undefined ? { isin } : { symbol, quantityBasis }), quantity, confirmedOn, enabled: true };
    const entry = revalued(original.entry, binding, quote);
    const valued = await valuePersonalAssetState(current, { stateDir });
    await createPersonalAssetsSnapshot({ stateDir, revision, valuation: { rates: valued.portfolio.rates, fx: valued.fx } });
    await writePrivate(join(resolve(stateDir), "personal-assets-funds-previous.json"), current);
    const assets = await savePersonalAssets({ stateDir, revision, portfolio: { ...current.portfolio, entries: current.portfolio.entries.map(row => row.id === entryId ? entry : row) } });
    Object.assign(binding, { quote, fingerprint: target(assets, entryId).fingerprint, lastAttemptAt: now.toISOString(), lastFetchedAt: quote.fetchedAt, lastAppliedAt: clock().toISOString(), lastError: null });
    config.bindings = [...config.bindings.filter(row => row.entryId !== entryId), binding]; await persist(); return assets;
  });
}

export async function runAssetFundCycle({ stateDir, fetchImpl = fetch, now, clock = now ? advancingClock(now) : () => new Date() }) {
  now ??= clock();
  const { time } = await readAssetRefreshSchedule({ stateDir, now });
  if (!(await readConfig(filePath(stateDir))).bindings.some(row => row.enabled)) return { attempted: 0, applied: 0, failed: 0 };
  return locked(stateDir, async (config, persist) => {
    const result = { attempted: 0, applied: 0, failed: 0 };
    for (const binding of config.bindings) {
      if (!binding.enabled || binding.lastAttemptAt && now.getTime() < Date.parse(nextAssetRefreshAt(binding.lastAttemptAt, time))) continue;
      result.attempted++; binding.lastAttemptAt = clock().toISOString();
      try {
        let current = await readPersonalAssets({ stateDir });
        if (target(current, binding.entryId).fingerprint !== binding.fingerprint) { binding.enabled = false; throw fail("持仓已修改，自动重估暂停，请重新确认份额。", 409); }
        const quote = await fetchAssetHoldingQuote({ isin: binding.isin, symbol: binding.symbol, fetchImpl, now: clock(), clock });
        if (binding.quote?.date > quote.date) throw fail("报价日期发生倒退，保留上次有效估值。");
        for (let attempt = 0; attempt < 3; attempt++) {
          current = await readPersonalAssets({ stateDir }); const selected = target(current, binding.entryId);
          if (selected.fingerprint !== binding.fingerprint) { binding.enabled = false; throw fail("持仓已修改，自动重估暂停，请重新确认份额。", 409); }
          const entry = revalued(selected.entry, binding, quote);
          if (JSON.stringify(entry) === JSON.stringify(selected.entry)) break;
          try {
            await writePrivate(join(resolve(stateDir), "personal-assets-funds-previous.json"), current);
            const assets = await savePersonalAssets({ stateDir, revision: current.revision, portfolio: { ...current.portfolio, entries: current.portfolio.entries.map(row => row.id === binding.entryId ? entry : row) } });
            binding.fingerprint = target(assets, binding.entryId).fingerprint; binding.lastAppliedAt = clock().toISOString(); result.applied++; break;
          } catch (error) { if (error.statusCode !== 409 || attempt === 2) throw error; }
        }
        binding.quote = quote; binding.lastFetchedAt = quote.fetchedAt; binding.lastError = null;
      } catch (error) { binding.lastError = error.fundError ? error.message : "持仓重估失败，保留上次有效数据。"; result.failed++; }
      await persist();
    }
    return result;
  });
}
