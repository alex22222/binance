import assert from "node:assert/strict";
import test from "node:test";
import { CRYPTO_WATCH_CSS, cryptoWatchHtml, cryptoWatchSection } from "../src/crypto-watch-html.mjs";

const watchlist = {
  source: "OKX 原生应用 · 收藏 / 全部", sourceUrl: "https://www.okx.com/markets/favorite",
  syncedAt: "2026-10-31T03:00:00.000Z", instruments: [{ instId: "GRASS-USDT" }, { instId: "GRASS-USDT-SWAP" }, { instId: "SPCX-USDT-SWAP" }]
};
const token = {
  instId: "GRASS-USDT", name: "Grass", kind: "crypto", instType: "SPOT", status: "OK",
  price: 0.3254, change24hPct: -2.35, high24h: 0.35, low24h: 0.31, volume24hQuote: 1200000,
  bid: 0.3253, ask: 0.3255, spreadPct: 0.0614, observedAt: "2026-10-31T03:01:00.000Z",
  return7dPct: 5.2, summary: "24 小时回落，7 日仍上涨。", errors: [],
  sourceUrl: "https://www.okx.com/trade-spot/grass-usdt"
};
function state(changes = {}) {
  return {
    status: "OK", stale: false, watchlistStale: false, watchlist,
    latest: { schemaVersion: 1, date: "2026-10-31", generatedAt: "2026-10-31T03:02:00.000Z", status: "OK", watchlist, tokens: [token], errors: [] },
    history: [{ date: "2026-10-30", status: "PARTIAL", generatedAt: "2026-10-30T00:00:00.000Z" }],
    ...changes
  };
}
function news(changes = {}) {
  const item = { id: "grass-news", sourceId: "coindesk", kind: "news", title: "Grass network adds a data partner", url: "https://www.coindesk.com/tech/2026/10/31/grass-network-data-partner", publishedAt: "2026-10-31T01:00:00Z", fetchedAt: "2026-10-31T03:10:00Z", matchedTerms: ["Grass network"] };
  return { schemaVersion: 1, generatedAt: "2026-10-31T03:10:00Z", windowDays: 7, status: "OK",
    sources: [
      { id: "coindesk", label: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", kind: "news", status: "OK", fetchedAt: "2026-10-31T03:10:00Z", lastAttemptAt: "2026-10-31T03:10:00Z", coverage: { feedItems: 25 }, items: [item] },
      { id: "okx-announcements", label: "OKX 公告", url: "https://www.okx.com/help/section/announcements-latest-announcements", kind: "announcement", status: "OK", fetchedAt: "2026-10-31T03:10:00Z", lastAttemptAt: "2026-10-31T03:10:00Z", coverage: "最近公告列表", items: [] }
    ], byBase: [{ base: "GRASS", name: "Grass", status: "OK", items: [item] }],
    announcements: [{ id: "okx-global", sourceId: "okx-announcements", kind: "announcement", title: "OKX service maintenance notice", url: "https://www.okx.com/help/service-maintenance-notice", publishedAt: "2026-10-30T06:00:00Z", fetchedAt: "2026-10-31T03:10:00Z" }], errors: [], ...changes };
}

test("crypto daily page uses shared navigation and distinguishes collection time from the saved OKX favorites", () => {
  const html = cryptoWatchHtml(state());
  assert.match(html, /<a href="\/crypto" aria-current="page">BTC 与收藏<\/a>/);
  assert.match(html, /每天 08:00 · 北京时间/);
  assert.match(html, /收藏名单同步/);
  assert.match(html, /2026-10-31 11:00/);
  assert.match(html, /日报生成/);
  assert.match(html, /2026-10-31 11:02/);
  assert.match(html, /行情时点：2026-10-31 11:01/);
  assert.match(html, /新闻与项目公告尚未接入/);
  assert.match(html, /每天 07:00 随“我的资产”任务/);
  assert.doesNotMatch(html, /07:50/);
  assert.doesNotMatch(html, /<script|USD\b|fonts\.googleapis/);
});

test("spot and swap instruments stay separate and TradFi listings are identified as derivatives", () => {
  const value = state();
  value.latest.tokens.push(
    { ...token, instId: "GRASS-USDT-SWAP", instType: "SWAP", volume24hQuote: null, fundingRatePct: 0.0123, fundingTime: "2026-10-31T08:00:00Z", sourceUrl: "https://www.okx.com/trade-swap/grass-usdt-swap" },
    { ...token, instId: "SPCX-USDT-SWAP", instType: "SWAP", kind: "tradfi", name: "SpaceX", volume24hQuote: null, sourceUrl: "https://www.okx.com/zh-hans/trade-swap/spcx-usdt-swap" }
  );
  const html = cryptoWatchHtml(value);
  assert.match(html, /现货 <span[^>]*>1<\/span>/);
  assert.match(html, /永续合约 <span[^>]*>2<\/span>/);
  for (const instId of ["GRASS-USDT", "GRASS-USDT-SWAP", "SPCX-USDT-SWAP"]) assert.match(html, new RegExp(`data-instrument="${instId}"`));
  assert.match(html, /TradFi \/ Pre-IPO/);
  assert.match(html, /合约标的，不代表持有公司股票/);
  assert.match(html, /\+0\.0123%/);
  assert.match(html, /下一结算周期/);
  assert.match(html, /1,200,000 USDT/);
  assert.match(html, /href="https:\/\/www\.okx\.com\/zh-hans\/trade-swap\/spcx-usdt-swap"/);
});

test("tiny token prices preserve meaningful digits across the price range and order book", () => {
  const value = state();
  value.latest.tokens = [{ ...token, price: 0.0000002332, high24h: 0.000000236, low24h: 0.0000002327, bid: 0.00000023319, ask: 0.00000023321 }];
  const html = cryptoWatchHtml(value);
  assert.match(html, /class="token-price">0\.0000002332<\/div>/);
  assert.match(html, /0\.000000236 \/ 0\.0000002327/);
  assert.match(html, /买一 0\.00000023319 USDT · 卖一 0\.00000023321 USDT/);
  assert.match(html, /1,200,000 USDT/);
  assert.doesNotMatch(html, /class="token-price">0<\/div>|2\.332e-7/);
});

test("missing and failed collections show explicit empty states without fabricating a report", () => {
  const missing = cryptoWatchHtml({ status: "MISSING", latest: null, history: [], watchlist });
  assert.match(missing, /日报尚未生成/);
  assert.match(missing, /尚无可展示的行情汇总/);
  assert.doesNotMatch(missing, /data-instrument=/);
  const failed = cryptoWatchHtml({ status: "FAILED", latest: null, history: [], watchlist, lastAttempt: { status: "FAILED", attemptedAt: "2026-10-31T00:00:00Z", errors: ["行情接口超时"] } });
  assert.match(failed, /最近采集失败/);
  assert.match(failed, /行情接口超时/);
  const unreadable = cryptoWatchHtml({ status: "ERROR", error: "文件格式无效 <b>错误</b>" });
  assert.match(unreadable, /日报数据读取失败/);
  assert.match(unreadable, /文件格式无效 &lt;b&gt;错误&lt;\/b&gt;/);
});

test("a verified empty favorites report remains a completed report with its original date and time", () => {
  const value = state();
  value.watchlist = { ...watchlist, instruments: [] };
  value.latest = { ...value.latest, watchlist: value.watchlist, tokens: [] };
  const html = cryptoWatchHtml(value);
  assert.match(html, /收藏列表为空/);
  assert.match(html, /采集完整/);
  assert.match(html, /最新日报 · 2026-10-31/);
  assert.match(html, /日报生成 2026-10-31 11:02/);
  assert.doesNotMatch(html, /日报尚未生成|下一次每日采集|data-instrument=/);
});

test("partial reports display unavailable fields as dashes and retain per-instrument errors", () => {
  const value = state();
  value.status = value.latest.status = "PARTIAL";
  value.latest.tokens = [{ ...token, status: "FAILED", price: null, change24hPct: null, high24h: null, low24h: null, volume24hQuote: null, spreadPct: null, return7dPct: null, summary: null, errors: ["该标的行情未返回"] }];
  const html = cryptoWatchHtml(value);
  assert.match(html, /部分数据缺失/);
  assert.match(html, /采集失败/);
  assert.match(html, /该标的行情未返回/);
  assert.match(html, /class="token-price">—<\/div>/);
  assert.doesNotMatch(html, /NaN|Infinity|null|0\.00%/);
});

test("old reports and outdated favorite lists carry separate visible warnings", () => {
  const html = cryptoWatchHtml(state({ stale: true, watchlistStale: true, lastAttempt: { status: "FAILED", errors: ["本次采集未完成"] } }));
  assert.match(html, /历史日报/);
  assert.match(html, /行情已过期，不代表当前价格/);
  assert.match(html, /收藏名单待重新同步/);
  assert.match(html, /当前名单仅代表上次确认的收藏快照/);
  assert.match(html, /本次采集未完成/);
});

test("all external strings are escaped and only official OKX market or trading links are clickable", () => {
  for (const sourceUrl of ["javascript:alert(1)", "https://evil.invalid/trade-spot/grass-usdt", "https://www.okx.com.evil.invalid/markets/favorite", "https://me@www.okx.com/markets/favorite", "http://www.okx.com/markets/favorite", "https://www.okx.com/redirect?url=https://evil.invalid", "https://www.okx.com/markets/favorite-redirect"]) {
    const value = state();
    value.latest.tokens = [{ ...token, name: '<img src=x onerror="alert(1)">', summary: "<script>alert(1)</script>", errors: ["<b>bad</b>"], sourceUrl }];
    value.watchlist = value.latest.watchlist = { ...watchlist, source: "<svg/onload=alert(1)>", sourceUrl };
    const html = cryptoWatchHtml(value);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<img|<script|<svg\/onload|href="(?:javascript:|http:|https:\/\/evil|https:\/\/me@|https:\/\/www\.okx\.com\.evil)/);
    assert.equal(html.includes(`href="${sourceUrl}"`), false);
  }
});

test("the static page uses compact instrument rows and responsive scoped styles", () => {
  const html = cryptoWatchHtml(state());
  assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(html, /minmax\(0,1fr\)/);
  assert.match(html, /@media\(max-width:640px\)/);
  assert.match(html, /\.crypto-watch \.token-row/);
  assert.match(html, /class="token-row"/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /:focus-visible/);
});

test("the reusable watch section has no document shell and keeps every instrument behind compact details", () => {
  const value = state({ news: news() });
  value.latest.tokens.push({ ...token, instId: "GRASS-USDT-SWAP", instType: "SWAP" });
  const fragment = cryptoWatchSection(value);
  assert.doesNotMatch(fragment, /<!doctype|<html|<head>|<body>|<script|site-header/);
  assert.equal((fragment.match(/data-instrument=/g) || []).length, 2);
  assert.equal((fragment.match(/class="instrument-details"/g) || []).length, 2);
  assert.match(fragment, /7 日收盘涨跌/);
  assert.match(fragment, /Grass network adds a data partner/);
  assert.match(CRYPTO_WATCH_CSS, /\.crypto-watch \.news-list/);
  assert.doesNotMatch(CRYPTO_WATCH_CSS, /(^|})\s*(?:body|h1|h2|p|main)\s*\{/);
});

test("news uses independent collection time, shares base headlines across spot and swap and keeps global notices separate", () => {
  const value = state({ news: news() });
  value.latest.tokens.push({ ...token, instId: "GRASS-USDT-SWAP", instType: "SWAP" });
  const html = cryptoWatchHtml(value);
  assert.match(html, /新闻与公告/);
  assert.match(html, /新闻采集 2026-10-31 11:10/);
  assert.match(html, /日报生成 2026-10-31 11:02/);
  assert.match(html, /发布 2026-10-31 09:00/);
  assert.match(html, /仅覆盖各来源返回的标题/);
  assert.match(html, /媒体报道/);
  assert.match(html, /官方公告/);
  assert.equal((html.match(/Grass network adds a data partner/g) || []).length, 2);
  assert.equal((html.match(/OKX service maintenance notice/g) || []).length, 1);
  assert.match(html, /href="https:\/\/www\.coindesk\.com\/tech\/2026\/10\/31\/grass-network-data-partner"/);
  assert.doesNotMatch(html, /新闻与项目公告尚未接入/);
});

test("headline matches distinguish successful scans with no matches, failed sources and unknown identities", () => {
  const value = state({ news: news({ byBase: [{ base: "GRASS", status: "NO_MATCHES", items: [] }] }) });
  assert.match(cryptoWatchHtml(value), /本次已接入来源中未匹配到相关新闻/);
  value.news.byBase[0].status = "UNAVAILABLE";
  let html = cryptoWatchHtml(value);
  assert.match(html, /新闻来源暂不可用/);
  assert.doesNotMatch(html, /本次已接入来源中未匹配到相关新闻/);
  value.news.byBase[0].status = "UNSUPPORTED";
  html = cryptoWatchHtml(value);
  assert.match(html, /该标的新闻身份尚未核验/);
  assert.doesNotMatch(html, /本次已接入来源中未匹配到相关新闻|本周无事/);
});

test("cached and failed news sources remain visible with original collection time and errors", () => {
  const value = state({ news: news() });
  value.news.status = "PARTIAL";
  Object.assign(value.news.sources[0], { status: "CACHED", fetchedAt: "2026-10-30T03:10:00Z", lastAttemptAt: "2026-10-31T03:10:00Z", error: "媒体连接超时" });
  Object.assign(value.news.sources[1], { status: "FAILED", error: "公告不可用" });
  value.news.byBase[0].status = "PARTIAL";
  const html = cryptoWatchHtml(value);
  assert.match(html, /沿用缓存/);
  assert.match(html, /原采集 2026-10-30 11:10/);
  assert.match(html, /媒体连接超时/);
  assert.match(html, /公告不可用/);
  assert.match(html, /部分来源未更新/);
  assert.doesNotMatch(html, /本次已接入来源中未匹配到相关新闻/);
});

test("news can come from a saved report and TradFi items are described as underlying-company news", () => {
  const value = state();
  value.latest.tokens = [{ ...token, instId: "SPCX-USDT-SWAP", instType: "SWAP", kind: "tradfi", name: "SpaceX" }];
  value.latest.news = news({ byBase: [{ base: "SPCX", status: "OK", items: [{ ...news().byBase[0].items[0], title: "SpaceX company update" }] }] });
  const html = cryptoWatchHtml(value);
  assert.match(html, /标的公司新闻/);
  assert.match(html, /SpaceX company update/);
  assert.match(html, /不代表相关合约发行或股票持有/);
});

test("news headlines and errors are escaped and unsafe publisher links never become anchors", () => {
  for (const url of ["javascript:alert(1)", "https://evil.invalid/story", "https://cointelegraph.com.evil.invalid/news/story", "https://me@www.coindesk.com/story", "https://www.coindesk.com:8443/story", "https://www.okx.com/trade-spot/btc-usdt", "https://constructor/story", "https://__proto__/story"]) {
    const value = state({ news: news() });
    Object.assign(value.news.byBase[0].items[0], { title: '<img src=x onerror="alert(1)">', url });
    Object.assign(value.news.sources[0], { label: "CoinDesk <b>source</b>", url });
    value.news.sources[0].error = "<script>error</script>";
    const html = cryptoWatchHtml(value);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;script&gt;error&lt;\/script&gt;/);
    assert.equal(html.includes(`href="${url}"`), false);
    assert.doesNotMatch(html, /<img|<script/);
  }
});

test("stale news and unreadable saved news have their own warning independent of the market report", () => {
  const stale = cryptoWatchHtml(state({ news: news({ stale: true }) }));
  assert.match(stale, /新闻数据已过期/);
  assert.match(stale, /标题保留原发布与采集时间/);
  assert.match(stale, /新闻采集 2026-10-31 11:10/);
  const failed = cryptoWatchHtml(state({ news: { status: "FAILED", generatedAt: null, sources: [], byBase: [], announcements: [], errors: ["已保存的新闻公告无法读取，请检查采集记录。"] } }));
  assert.match(failed, /已保存的新闻公告无法读取，请检查采集记录。/);
  assert.match(failed, /新闻来源暂不可用/);
  assert.doesNotMatch(failed, /本次已接入来源中未匹配到相关新闻|该标的新闻身份尚未核验/);
});
