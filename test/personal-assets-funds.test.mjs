import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyPortfolio, readPersonalAssets, savePersonalAssets } from "../src/personal-assets.mjs";
import { configureAssetFund, fetchAssetFundNav, readAssetFundStatus, runAssetFundCycle } from "../src/personal-assets-funds.mjs";

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
  for (const [i, options] of [{ fail: true }, { date: "2026-10-01" }, { date: "2026-10-22" }].entries()) {
    const result = await runAssetFundCycle({ stateDir, now: new Date(Date.parse("2026-10-25T01:00:00Z") + i * 12 * 60 * 60_000), fetchImpl: source(options) });
    assert.equal(result.failed, 1); assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), ledger);
    const status = await readAssetFundStatus({ stateDir, now }); assert.equal(status.bindings[0].lastFetchedAt, now.toISOString()); assert.ok(status.bindings[0].lastError);
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
