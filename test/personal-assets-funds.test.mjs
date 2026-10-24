import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyPortfolio, readPersonalAssets, savePersonalAssets } from "../src/personal-assets.mjs";
import { configureAssetFund, fetchAssetFundNav, fetchAssetHoldingQuote, readAssetFundStatus, runAssetFundCycle } from "../src/personal-assets-funds.mjs";

process.env.PERSONAL_ASSETS_FX_DISABLED = "1";

const now = new Date("2026-10-24T14:00:00Z");
const isin = "HK0000857299";
function source({ nav = "12.1", date = "2026-10-23", wrongClass = false, fail = false } = {}) {
  return async (url, init) => {
    assert.equal(init.redirect, "error"); assert.ok(init.signal); assert.equal(init.headers.Authorization, undefined);
    if (fail) throw new Error("private upstream body");
    if (url.includes("gaotengasset")) return new Response(`<script>window.__REACT_QUERY_STATE__ = ${JSON.stringify({ queries: [{ queryKey: ["indexNewsCenter"], state: { data: [[{
      fundId: "10008", fundName: " 高騰微基金-高騰微財貨幣基金", fundClassInfo: [{ isinCode: "HK0000478872", fundClassId: "10008003", fundClassName: wrongClass ? "P(港元)-累積" : "A(港元)-累積", currency: "港元", fundNav: nav, navDate: date }]
    }]] } }] })};</script>`);
    assert.equal(init.method, "POST"); assert.deepEqual(JSON.parse(init.body), { fundCode: "20220530", language: "hk" });
    if (url.endsWith("transacTional")) return Response.json({ code: 0, data: { fundId: 134, isinCode: "HK0000857299（A類 – 美元）" } });
    assert.equal(url, "https://hk.taikangasset.cn/api/tblProductQuotation/getTheLast");
    return Response.json({ code: 0, data: [{ fundCode: "20220530", classType: "ausdacc", className: wrongClass ? "B類-美元-累積" : "A類-美元-累積", currencyCode: "美元", netAssets: nav, date }] });
  };
}
async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "assets-funds-")); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const portfolio = emptyPortfolio(); portfolio.accounts[0].basis = "holdings";
  portfolio.entries = [{ id: "fund-one", accountId: "account-1", kind: "holding", name: "Synthetic fund", category: "货币基金", currency: "USD", amount: 1, asOf: "2026-10-24", source: "manual" },
    { id: "other-stock", accountId: "account-1", kind: "holding", name: "Unrelated ETF", category: "股票ETF", currency: "USD", amount: 5, asOf: "2026-10-24", source: "manual" }];
  await savePersonalAssets({ stateDir, portfolio, revision: 0 }); return stateDir;
}
const bind = (stateDir, more = {}) => configureAssetFund({ stateDir, entryId: "fund-one", isin, quantity: "2.5", confirmedOn: "2026-10-24", revision: 1, fetchImpl: source(), now, ...more });

function stockSource(change = () => {}, suffix = "") {
  const fields = Array(88).fill(""); fields[1] = "NAME"; fields[2] = "000534"; fields[3] = "19.14"; fields[30] = "20261023161421"; fields[61] = "GP-A";
  change(fields);
  // GB18030 bytes for 万泽股份 exercise the provider's real wire encoding.
  const body = Buffer.concat([Buffer.from('v_sz000534="' + fields.join("~").split("NAME")[0]), Buffer.from("cdf2d4f3b9c9b7dd", "hex"), Buffer.from(fields.join("~").split("NAME")[1] + '";' + suffix)]);
  return async (url, init) => { assert.equal(url, "https://qt.gtimg.cn/q=sz000534"); assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.headers.Referer, "https://gu.qq.com/"); return new Response(body); };
}

test("A-share quotes identify exchange, code, Chinese name and source timestamp without calling a broker", async () => {
  const quote = await fetchAssetHoldingQuote({ symbol: "sz000534", fetchImpl: stockSource(), now });
  assert.equal(quote.symbol, "sz000534"); assert.equal(quote.currency, "CNY"); assert.equal(quote.price, "19.14"); assert.equal(quote.nav, undefined);
  assert.equal(quote.observedAt, "2026-10-23T08:14:21.000Z"); assert.equal(quote.date, "2026-10-23"); assert.equal(quote.priceBasis, "market-quote");
  for (const change of [f => { f[2] = "000535"; }, f => { f[3] = "0"; }, f => { f[3] = "NaN"; }, f => { f[30] = "20261025090000"; },
    f => { f[30] = "20260230150000"; }, f => { f[30] = "20261023161499"; }, f => { f[61] = "GP-B"; }]) {
    await assert.rejects(fetchAssetHoldingQuote({ symbol: "sz000534", fetchImpl: stockSource(change), now }), /身份|报价|日期/);
  }
  let called = false;
  await assert.rejects(fetchAssetHoldingQuote({ symbol: "sz999999", fetchImpl: async () => { called = true; }, now })); assert.equal(called, false);
  await assert.rejects(fetchAssetHoldingQuote({ isin, symbol: "sz000534", fetchImpl: stockSource(), now }));
  for (const symbol of [null, ["sz000534"], {}, "https://other.example/stock"]) await assert.rejects(fetchAssetHoldingQuote({ symbol, now }));
  for (const fetchImpl of [stockSource(() => {}, 'v_sz000534="duplicate";'), async () => new Response('v_sz000534="unexpected name";'),
    async () => new Response("blocked", { status: 302 })]) await assert.rejects(fetchAssetHoldingQuote({ symbol: "sz000534", fetchImpl, now }));
});

test("screenshot stock quantities revalue only the existing holding and preserve cash, PnL and old snapshots", async t => {
  const stateDir = await fixture(t); const current = await readPersonalAssets({ stateDir });
  const stock = { id: "stock-one", accountId: "account-1", kind: "holding", name: "万泽股份", category: "股票", currency: "CNY", amount: 1900, asOf: "2026-10-24", source: "screenshot", asOfBasis: "imported" };
  current.portfolio.entries.push(stock, { ...stock, id: "cash-one", name: "可用现金", category: "现金", amount: 0.32 }); current.portfolio.stockPnl = [{ accountId: "account-1", amount: -30, currency: "CNY", asOf: "2026-10-24", source: "screenshot" }];
  await savePersonalAssets({ stateDir, portfolio: current.portfolio, revision: current.revision });
  const options = { stateDir, entryId: "stock-one", symbol: "sz000534", quantity: "100", quantityBasis: "screenshot", confirmedOn: "2026-10-24", revision: 2, fetchImpl: stockSource(), now };
  for (const more of [{ quantity: "1.5" }, { isin }, { entryId: "other-stock" }]) await assert.rejects(configureAssetFund({ ...options, ...more }));
  const next = await configureAssetFund(options); assert.equal(next.portfolio.entries[2].amount, 1914);
  assert.deepEqual(next.portfolio.entries.filter(row=>row.id!==stock.id), current.portfolio.entries.filter(row=>row.id!==stock.id)); assert.deepEqual(next.portfolio.stockPnl, current.portfolio.stockPnl);
  assert.match(next.portfolio.entries[2].note, /截图数量|持股时点未核实/); assert.match(next.portfolio.entries[2].note, /非券商账户同步/);
  const saved = await readAssetFundStatus({ stateDir, now }); assert.equal(saved.bindings[0].symbol, "sz000534"); assert.equal(saved.bindings[0].isin, undefined);
  assert.equal(saved.bindings[0].quantityBasis, "screenshot"); assert.equal(saved.bindings[0].price, "19.14");
  const ledger = await readFile(join(stateDir,"personal-assets.json"),"utf8");
  assert.deepEqual(await runAssetFundCycle({ stateDir, now: new Date("2026-10-25T01:00:00Z"), fetchImpl: async () => { throw Error("network down"); } }), { attempted:1, applied:0, failed:1 });
  assert.equal(await readFile(join(stateDir,"personal-assets.json"),"utf8"), ledger);
  const prior = JSON.parse(await readFile(join(stateDir,"personal-assets-snapshots",next.snapshots[0].id+".json"),"utf8")); assert.deepEqual(prior.portfolio.entries[2],stock);
});

function usSource(symbol, change = () => {}) {
  const product = symbol === "usSPY" ? ["标普500指数ETF-SPDR", "SPY.AM", "State Street Spdr S&P 500 Etf", "GP-ETF"] : ["SpaceX", "SPCX.OQ", "Space Exploration Technologies Corp.", "GP"];
  const fields = Array(73).fill(""); fields[0] = "200"; fields[1] = "NAME"; fields[2] = product[1]; fields[3] = "147.49"; fields[30] = "2026-10-23 16:00:01"; fields[35] = "USD"; fields[46] = product[2]; fields[56] = product[3]; change(fields);
  const name = symbol === "usSPY" ? Buffer.from("b1eac6d5353030d6b8cafd4554462d53504452", "hex") : Buffer.from(product[0]);
  const text = fields.join("~").split("NAME");
  const body = Buffer.concat([Buffer.from(`v_${symbol}="` + text[0]), name, Buffer.from(text[1] + '\";\n')]);
  return async (url, init) => { assert.equal(url, "https://qt.gtimg.cn/q=" + symbol); assert.equal(init.redirect, "error"); return new Response(body); };
}

test("US quotes distinguish current issuer, ETF and ADR products and keep an unverified source timezone explicit", async () => {
  const quote = await fetchAssetHoldingQuote({ symbol: "usSPCX", fetchImpl: usSource("usSPCX"), now });
  assert.equal(quote.currency, "USD"); assert.equal(quote.price, "147.49"); assert.equal(quote.nav, undefined); assert.equal(quote.date, "2026-10-23");
  assert.equal(quote.observedAt, null); assert.equal(quote.sourceTime, "2026-10-23 16:00:01"); assert.equal(quote.timeBasis, "provider-timezone-unverified");
  const spy = await fetchAssetHoldingQuote({ symbol: "usSPY", fetchImpl: usSource("usSPY"), now }); assert.equal(spy.category, "股票ETF");
  for (const change of [f => { f[2] = "SPCX.AM"; }, f => { f[35] = "CNY"; }, f => { f[46] = "The SPAC and New Issue ETF"; }, f => { f[56] = "GP-ETF"; },
    f => { f[30] = "2026-10-25 16:00:01"; }, f => { f[30] = "2026-10-23 16:00:99"; }, f => { f[30] = "2026-10-01 16:00:00"; }]) {
    await assert.rejects(fetchAssetHoldingQuote({ symbol: "usSPCX", fetchImpl: usSource("usSPCX", change), now }));
  }
});

test("US shares accept manually confirmed fractional quantities while an ETF cannot use a stock category", async t => {
  const stateDir = await fixture(t); const current = await readPersonalAssets({ stateDir });
  current.portfolio.entries.push({ id: "us-one", accountId: "account-1", kind: "holding", name: "SpaceX（SPCX）", category: "股票", currency: "USD", amount: 100, asOf: "2026-10-24", source: "manual" });
  await savePersonalAssets({ stateDir, revision: current.revision, portfolio: current.portfolio });
  const next = await configureAssetFund({ stateDir, entryId: "us-one", symbol: "usSPCX", quantity: "0.5", confirmedOn: "2026-10-24", revision: 2, fetchImpl: usSource("usSPCX"), now });
  assert.equal(next.portfolio.entries[2].amount, 73.745); assert.equal(next.portfolio.entries[2].currency, "USD"); assert.match(next.portfolio.entries[2].note, /时区未核实/);
  const status = await readAssetFundStatus({ stateDir, now }); assert.equal(status.bindings[0].quantityBasis, "manual"); assert.equal(status.bindings[0].sourceTime, "2026-10-23 16:00:01");
  const original = next.portfolio.entries[2]; original.name = "SPDR 标普500 ETF（SPY）";
  await savePersonalAssets({ stateDir, revision: next.revision, portfolio: next.portfolio });
  await assert.rejects(configureAssetFund({ stateDir, entryId: "us-one", symbol: "usSPY", quantity: "2", confirmedOn: "2026-10-24", revision: next.revision + 1, fetchImpl: usSource("usSPY"), now }), /证券类型/);
});

test("fund checking respects the twice-daily schedule and normal intervals are not marked delayed", async t => {
  const stateDir = await fixture(t); await bind(stateDir);
  let called = false;
  assert.deepEqual(await runAssetFundCycle({ stateDir, now: new Date(now.getTime() + 60 * 60_000), fetchImpl: async () => { called = true; throw Error(); } }), { attempted: 0, applied: 0, failed: 0 });
  assert.equal(called, false);
  assert.equal((await readAssetFundStatus({ stateDir, now: new Date(now.getTime() + 10 * 60 * 60_000) })).bindings[0].delayed, false);
});

function etfSource(change = () => {}) {
  const data = { overview: { cusip: "922908363", fundId: "0968", iovTickerSymbol: "VOO.P", marketPrice: "$123.45", marketPriceAsOfDate: "10/23/2026", navPrice: "$120.00" },
    dashboard: { ticker: "VOO", fundId: "0968", fundFullName: "Vanguard S&P 500 ETF", marketPrice: "$123.45", marketPriceAsOfDate: "10/23/2026" },
    price: { marketPrice: "$123.45", marketPriceAsOfDate: "10/23/2026" }, fundFlags: { isEtf: true } };
  change(data);
  return async (url, init) => {
    assert.equal(url, "https://investor.vanguard.com/investment-products/etfs/profile/voo"); assert.equal(init.method, "GET"); assert.equal(init.redirect, "error");
    return new Response(`<div data-vgn-funds-profile="${JSON.stringify(data).replaceAll('"', "&#34;").replaceAll("&P", "&amp;P")}"></div>`);
  };
}

test("VOO uses issuer-published market close rather than NAV, preserving price date and ETF identity", async t => {
  const quote = await fetchAssetFundNav({ isin: "US9229083632", fetchImpl: etfSource(), now });
  assert.equal(quote.nav, "123.45"); assert.equal(quote.priceBasis, "market-close"); assert.equal(quote.date, "2026-10-23"); assert.equal(quote.currency, "USD");
  const stateDir = await fixture(t);
  const before = await readPersonalAssets({ stateDir });
  const next = await bind(stateDir, { entryId: "other-stock", isin: "US9229083632", quantity: "4.125", fetchImpl: etfSource() });
  assert.equal(next.portfolio.entries[1].amount, 509.23125); assert.equal(next.portfolio.entries[1].category, "股票ETF");
  assert.match(next.portfolio.entries[1].note, /市场收盘价|不是盘中实时/); assert.deepEqual(next.portfolio.entries[0], before.portfolio.entries[0]);
});

test("VOO refuses missing market price, foreign identities and inconsistent dates without substituting NAV", async () => {
  for (const change of [d => { delete d.overview.marketPrice; }, d => { d.overview.cusip = "wrong"; }, d => { d.dashboard.ticker = "VTI"; },
    d => { d.dashboard.fundId = "1234"; }, d => { d.fundFlags.isEtf = false; }, d => { d.price.marketPrice = "$100.00"; },
    d => { d.dashboard.marketPriceAsOfDate = "10/22/2026"; }, d => { d.overview.marketPriceAsOfDate = d.dashboard.marketPriceAsOfDate = d.price.marketPriceAsOfDate = "02/30/2026"; },
    d => { d.overview.marketPrice = d.dashboard.marketPrice = d.price.marketPrice = "-$2.00"; }]) {
    await assert.rejects(fetchAssetFundNav({ isin: "US9229083632", fetchImpl: etfSource(change), now }), /身份|报价/);
  }
});

test("official NAV identifies exact fund, share class, currency and actual NAV date", async () => {
  const usd = await fetchAssetFundNav({ isin, fetchImpl: source(), now });
  assert.equal(usd.nav, "12.1"); assert.equal(usd.currency, "USD"); assert.equal(usd.date, "2026-10-23");
  const hkd = await fetchAssetFundNav({ isin: "HK0000478872", fetchImpl: source({ nav: "11.6" }), now });
  assert.equal(hkd.currency, "HKD"); assert.equal(hkd.nav, "11.6");
  for (const id of [isin, "HK0000478872"]) for (const options of [{ wrongClass: true }, { date: "2026-02-30" }, { date: "2026-10-25" }, { date: "2026-10-01" }, { nav: "NaN" }, { nav: "0" }]) {
    await assert.rejects(fetchAssetFundNav({ isin: id, fetchImpl: source(options), now }), /净值|身份|报价/);
  }
});
test("public quote reads reject redirects, oversized data, malformed JSON and untrusted HTML scripts", async () => {
  for (const response of [() => new Response("secret", { status: 302 }), () => new Response("{}", { headers: { "content-length": "1000001" } }),
    () => new Response("{broken"), () => new Response(" ".repeat(1_000_001))]) {
    await assert.rejects(fetchAssetFundNav({ isin, fetchImpl: async () => response(), now }), e => !e.message.includes("secret"));
  }
  await assert.rejects(fetchAssetFundNav({ isin: "HK0000478872", fetchImpl: async () => new Response('<script>window.__REACT_QUERY_STATE__ = process.exit(9);</script>'), now }));
});
test("binding replaces one existing holding, saves old history and preserves unrelated assets", async t => {
  const stateDir = await fixture(t); const before = await readPersonalAssets({ stateDir });
  const next = await bind(stateDir);
  assert.equal(next.portfolio.entries.length, 2); assert.equal(next.portfolio.entries[0].amount, 30.25);
  assert.equal(next.portfolio.entries[0].asOf, "2026-10-23"); assert.equal(next.portfolio.entries[0].source, "api");
  assert.match(next.portfolio.entries[0].note, /不是到期日/); assert.deepEqual(next.portfolio.entries[1], before.portfolio.entries[1]);
  const prior = JSON.parse(await readFile(join(stateDir, "personal-assets-snapshots", next.snapshots[0].id + ".json"), "utf8"));
  assert.deepEqual(prior.portfolio.entries, before.portfolio.entries);
  assert.equal((await stat(join(stateDir, "personal-assets-funds.json"))).mode & 0o777, 0o600);
  const view = await readAssetFundStatus({ stateDir, now }); assert.equal(view.bindings[0].enabled, true); assert.equal("fingerprint" in view.bindings[0], false);
});
test("HKD fund uses native NAV rather than interpreting a prior USD equivalent as HKD units", async t => {
  const stateDir = await fixture(t); const next = await bind(stateDir, { isin: "HK0000478872", quantity: "7.5", fetchImpl: source({ nav: "11.6" }) });
  assert.equal(next.portfolio.entries[0].currency, "HKD"); assert.equal(next.portfolio.entries[0].amount, 87);
});
test("unchanged NAV is idempotent, a new NAV updates only its holding and long-term units never expire", async t => {
  const stateDir = await fixture(t); await bind(stateDir, { confirmedOn: "2020-10-24" });
  const later = new Date("2026-10-25T01:00:00Z");
  assert.deepEqual(await runAssetFundCycle({ stateDir, now: later, fetchImpl: source() }), { attempted: 1, applied: 0, failed: 0 });
  assert.equal((await readPersonalAssets({ stateDir })).revision, 2);
  const monthsLater = new Date("2026-10-25T13:00:00Z");
  assert.deepEqual(await runAssetFundCycle({ stateDir, now: monthsLater, fetchImpl: source({ nav: "12.2" }) }), { attempted: 1, applied: 1, failed: 0 });
  assert.equal((await readPersonalAssets({ stateDir })).portfolio.entries[0].amount, 30.5);
  assert.equal((await readAssetFundStatus({ stateDir, now: monthsLater })).bindings[0].enabled, true);
  assert.equal((await readAssetFundStatus({ stateDir, now: monthsLater })).bindings[0].confirmedOn, "2020-10-24");
});
test("failed, stale and regressing NAV preserves the exact ledger and last successful time", async t => {
  const stateDir = await fixture(t); await bind(stateDir); const ledger = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const lastGoodFetchedAt = (await readAssetFundStatus({ stateDir, now })).bindings[0].lastFetchedAt;
  for (const [i, options] of [{ fail: true }, { date: "2026-10-01" }, { date: "2026-10-22" }].entries()) {
    const result = await runAssetFundCycle({ stateDir, now: new Date(Date.parse("2026-10-25T01:00:00Z") + i * 12 * 60 * 60_000), fetchImpl: source(options) });
    assert.equal(result.failed, 1); assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), ledger);
    const status = await readAssetFundStatus({ stateDir, now }); assert.equal(status.bindings[0].lastFetchedAt, lastGoodFetchedAt); assert.ok(status.bindings[0].lastError);
    assert.doesNotMatch(JSON.stringify(status), /private upstream body/);
  }
});
test("manual changes pause automatic overwrite, while unrelated changes do not", async t => {
  const stateDir = await fixture(t); await bind(stateDir); let current = await readPersonalAssets({ stateDir });
  current.portfolio.entries[1].amount = 55; await savePersonalAssets({ stateDir, revision: current.revision, portfolio: current.portfolio });
  const later = new Date("2026-10-25T01:00:00Z"); assert.equal((await runAssetFundCycle({ stateDir, now: later, fetchImpl: source() })).failed, 0);
  current = await readPersonalAssets({ stateDir }); current.portfolio.entries[0].amount = 88; await savePersonalAssets({ stateDir, revision: current.revision, portfolio: current.portfolio });
  const untouched = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const result = await runAssetFundCycle({ stateDir, now: new Date(later.getTime() + 12 * 60 * 60_000), fetchImpl: source({ nav: "99" }) });
  assert.equal(result.failed, 1); assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), untouched);
  assert.equal((await readAssetFundStatus({ stateDir })).bindings[0].enabled, false);
});
test("missing configuration does not create files and stale revisions or invalid units cannot bind", async t => {
  const stateDir = await fixture(t); assert.deepEqual(await runAssetFundCycle({ stateDir }), { attempted: 0, applied: 0, failed: 0 });
  for (const more of [{ quantity: "-1" }, { quantity: "1e2" }, { confirmedOn: "2026-10-25" }, { isin: "unknown" }, { entryId: "other-stock" }, { revision: 0 }]) await assert.rejects(bind(stateDir, more));
  assert.equal((await readPersonalAssets({ stateDir })).revision, 1);
});

const hsbcIsin = "HK0000465903";
function hsbcData() {
  return { view: "Prices", invalidConfigurationErrorMessage: null, messages: [], filteredTotal: 1, fundsTotal: 1, shareTotal: 1,
    paging: { currentPage: 1, fundsPerPage: 20, numberOfFunds: 1, totalPages: 1 },
    funds: [{ name: "HSBC Global Money Funds - Hong Kong Dollar", id: "FSGBR06FJR", shareClasses: [{ id: "F0000119QG", name: "D", isin: hsbcIsin, data: [
      { columnId: "DropDown_PriceCurrency", selected: "0P0001EPQ8", groups: [{ name: "Base Currency", options: [{ value: "HKD", id: "0P0001EPQ8" }] }] },
      { columnId: "UniqueIdentifier", value: hsbcIsin + " " }, { columnId: "Nav", value: "11.5950 " }, { columnId: "PriceDate", value: "23 Oct 2026  " },
    ] }] }] };
}
function hsbcSource(change = () => {}, options = {}) {
  const data = hsbcData(); change(data); const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init }); assert.equal(init.method, "POST"); assert.equal(init.redirect, "error"); assert.ok(init.signal); assert.equal(init.headers.Cookie, undefined);
    if (url === "https://www.assetmanagement.hsbc.com.hk/api/v1/token/issue") {
      assert.equal(init.headers["X-Country"], "HK"); assert.equal(init.headers["X-Language"], "EN"); assert.equal(init.headers["Content-Length"], "0");
      assert.equal(init.headers.Authorization, undefined); assert.equal(init.body, undefined);
      return options.tokenResponse ? options.tokenResponse() : new Response("anonymous.public.token");
    }
    assert.equal(url, "https://www.assetmanagement.hsbc.com.hk/api/v1/nav/funds"); assert.equal(init.headers.Authorization, "Bearer anonymous.public.token");
    const body = JSON.parse(init.body); assert.equal(body.view, "Prices"); assert.deepEqual(body.searchTerm, [hsbcIsin]); assert.deepEqual(body.selectedValues, []);
    assert.deepEqual(body.paging, { currentPage: 1, fundsPerPage: 20 }); assert.equal(body.pageInformation.investorType, "INDV");
    assert.doesNotMatch(init.body, /10466\.17|121355\.31|apiKey|secret|wallet/);
    return options.dataResponse ? options.dataResponse() : Response.json(data);
  };
  return { fetchImpl, calls };
}

test("HSBC U50001 uses only the exact D accumulating HKD share class and its official dated NAV", async () => {
  const source = hsbcSource(); const quote = await fetchAssetFundNav({ isin: hsbcIsin, fetchImpl: source.fetchImpl, now });
  assert.equal(quote.isin, hsbcIsin); assert.equal(quote.nav, "11.5950"); assert.equal(quote.currency, "HKD"); assert.equal(quote.date, "2026-10-23"); assert.match(quote.name, /D.*累积/);
  assert.equal(source.calls.length, 2); assert.doesNotMatch(JSON.stringify(quote), /anonymous\.public\.token|Authorization/);
});

test("HSBC NAV rejects other funds, classes, currencies, duplicate fields and incomplete result sets", async () => {
  const share = data => data.funds[0].shareClasses[0];
  for (const change of [d => { d.funds[0].id = "other"; }, d => { d.funds[0].name += " Other"; }, d => { share(d).isin = "HK0000434412"; },
    d => { share(d).name = "DD"; }, d => { share(d).id = "other"; }, d => { share(d).data[0].groups[0].options[0].value = "USD"; },
    d => { share(d).data[0].selected = "foreign-currency"; }, d => { share(d).data[1].value = "HK0000465895"; },
    d => { share(d).data.push({ columnId: "Nav", value: "999" }); }, d => { share(d).data = share(d).data.filter(row => row.columnId !== "PriceDate"); },
    d => { d.funds.push(d.funds[0]); }, d => { d.paging.totalPages = 2; }, d => { d.filteredTotal = 2; }, d => { d.view = "Performance"; },
    d => { d.invalidConfigurationErrorMessage = "unavailable"; }, d => { d.messages.push("incomplete"); }]) {
    const source = hsbcSource(change); await assert.rejects(fetchAssetFundNav({ isin: hsbcIsin, fetchImpl: source.fetchImpl, now }), /身份|净值|报价/); assert.equal(source.calls.length, 2);
  }
  for (const [field, value] of [["Nav", "0"], ["Nav", "NaN"], ["Nav", "-1"], ["PriceDate", "25 Oct 2026"], ["PriceDate", "30 Feb 2026"], ["PriceDate", "01 Oct 2026"], ["PriceDate", "23 Foo 2026"]]) {
    const source = hsbcSource(d => { share(d).data.find(row => row.columnId === field).value = value; });
    await assert.rejects(fetchAssetFundNav({ isin: hsbcIsin, fetchImpl: source.fetchImpl, now }), /身份|净值|报价/);
  }
});

test("HSBC public token and NAV failures never retry, expose tokens or overwrite a valid holding", async t => {
  const stateDir = await fixture(t); const source = hsbcSource();
  const initial = await bind(stateDir, { isin: hsbcIsin, quantity: "10466.17", fetchImpl: source.fetchImpl });
  assert.equal(initial.portfolio.entries[0].amount, 121355.24115); assert.equal(initial.portfolio.entries[0].currency, "HKD"); assert.equal(initial.portfolio.entries.length, 2);
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  const lastGoodFetchedAt = (await readAssetFundStatus({ stateDir, now })).bindings[0].lastFetchedAt;
  for (const [index, options] of [{ tokenResponse: () => new Response("private upstream secret", { status: 429 }) }, { tokenResponse: () => new Response("<html>blocked</html>") },
    { dataResponse: () => new Response("anonymous.public.token", { status: 400 }) }, { dataResponse: () => new Response("broken") }].entries()) {
    const bad = hsbcSource(() => {}, options);
    const result = await runAssetFundCycle({ stateDir, fetchImpl: bad.fetchImpl, now: new Date(Date.parse("2026-10-25T01:00:00Z") + index * 12 * 60 * 60_000) });
    assert.deepEqual(result, { attempted: 1, applied: 0, failed: 1 }); assert.ok(bad.calls.length <= 2);
    assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
    const status = await readAssetFundStatus({ stateDir }); assert.doesNotMatch(JSON.stringify(status), /private upstream secret|anonymous\.public\.token/); assert.equal(status.bindings[0].lastFetchedAt, lastGoodFetchedAt);
  }
  assert.doesNotMatch(await readFile(join(stateDir, "personal-assets-funds.json"), "utf8"), /anonymous\.public\.token|Authorization/);
});
