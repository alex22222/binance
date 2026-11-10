import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLandingReports, marketOverviewHtml } from "../src/market-overview-html.mjs";

const NOW = new Date("2026-11-08T04:00:00Z");
const sections = ["经理结论", "实盘回溯", "Paper", "全球动态", "美联储", "黄金", "美股", "重大事件", "风险与行动", "数据与来源"];
const text = (date, conclusion = "保留风险预算，等待下一条证据。") => `# 基金经理日报｜${date}\n\n${sections.map(title => `## ${title}\n\n${title === "经理结论" ? conclusion : "已核对的报告内容。"}`).join("\n\n")}\n\n## 市场与 AI 研究\n\n1. 研究新进展及需要关注的证据。\n`;
async function archive(directory, date, { edition = "daily", body = text(date), html = "<!doctype html><html><body>Archive</body></html>" } = {}) {
  const path = join(directory, `${date}-${edition}`);
  await writeFile(`${path}.md`, body);
  await writeFile(`${path}.html`, html);
  await utimes(`${path}.html`, NOW, NOW);
}
const asset = (symbol = "SPY", changes = {}) => ({
  id: symbol.toLowerCase(), symbol, label: "标普 500", group: "equity", price: 612.34,
  change1d: -0.4, change5d: 1.25, change20d: 3.5, asOf: "2026-11-06T21:00:00Z", fetchedAt: "2026-11-08T03:45:00Z",
  sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`, status: "OK", sessionState: "CLOSED", error: null,
  history: Array.from({ length: 25 }, (_, index) => ({ time: new Date(Date.UTC(2026, 9, 10 + index)).toISOString(), close: 580 + index })), ...changes
});
const market = (changes = {}) => ({ schemaVersion: 1, generatedAt: "2026-11-08T03:45:00Z", status: "AVAILABLE", stale: false,
  assets: [asset(), asset("TLT", { group: "bonds", label: "长期美债", change5d: -1.2 }), asset("UUP", { group: "currency", label: "美元", change5d: 0.6 }), asset("AIQ", { group: "ai", label: "AI 主题", change5d: 2.5 })],
  signals: [{ symbol: "SPY", status: "OK", asOf: "2026-11-06T14:30:00Z", direction20: "UP", direction60: "DOWN", direction200: "UP", RV20Pct: 15.2, targetVolPct: 10, targetExposurePct: 65.79, exposureChangePp: -2, modelOnly: true }], ...changes
});

test("market home renders equal-area return tiles, percentage units, real times and plain period links without scripts", () => {
  const html = marketOverviewHtml({ market: market(), reports: {}, now: NOW });
  assert.match(html, /资本市场温度/);
  assert.match(html, /MARKET PULSE/);
  assert.match(html, /href="\?period=5d" aria-current="true"/);
  assert.match(html, /href="\?period=1d"/);
  assert.match(html, /http-equiv="refresh" content="300"/);
  assert.match(html, /跨资产/);
  assert.match(html, /美股与 AI/);
  assert.match(html, /\+1\.25%/);
  assert.match(html, /612\.34/);
  assert.match(html, /2026-11-07 05:00/);
  assert.match(html, /2026-11-08 11:45/);
  assert.match(html, /休市/);
  assert.match(html, /可能延迟/);
  assert.match(html, /收益强弱代理，不代表真实资金净流入\/净流出/);
  assert.match(html, /ETF 为复权收益/);
  assert.match(html, /BTC 按 UTC 自然日/);
  assert.match(html, /等面积/);
  assert.match(html, /AI 相对 SPY/);
  assert.match(html, /\+1\.25 个百分点/);
  assert.match(html, /<svg[^>]*aria-label="最近 20 个观测点走势"/);
  assert.doesNotMatch(html, /<script|iframe|fonts\.googleapis|市值权重|美元净流入/);
});

test("selected periods change tile color and returns while missing data stays unknown", () => {
  const html = marketOverviewHtml({ market: market({ assets: [asset(), asset("TLT", { group: "bonds", price: null, change1d: null, history: [], status: "FAILED", error: "接口超时" })] }), period: "1d", now: NOW });
  assert.match(html, /class="heat-tile negative/);
  assert.match(html, /-0\.40%/);
  assert.match(html, /接口超时/);
  assert.match(html, /class="tile-return">—<\/strong>/);
  assert.match(html, /历史不足/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|null/);
  const missing = marketOverviewHtml({ market: { status: "MISSING", assets: [] }, reports: {}, now: NOW });
  assert.match(missing, /行情尚未生成/);
  assert.doesNotMatch(missing, /0\.00%/);
});

test("cached, stale, failed and partial market states remain visibly distinct", () => {
  const cached = marketOverviewHtml({ market: market({ status: "FAILED", stale: true, lastAttempt: { status: "FAILED", attemptedAt: "2026-11-08T03:55:00Z" }, assets: [asset("SPY", { status: "CACHED" })] }), now: NOW });
  assert.match(cached, /最近采集失败/);
  assert.match(cached, /行情已陈旧/);
  assert.match(cached, /沿用缓存/);
  assert.match(cached, /2026-11-08 11:45/);
  const partial = marketOverviewHtml({ market: market({ status: "PARTIAL" }), now: NOW });
  assert.match(partial, /部分数据未更新/);
  const unreadable = marketOverviewHtml({ market: { status: "ERROR", error: "无法读取 <b>数据</b>", assets: [] }, now: NOW });
  assert.match(unreadable, /无法读取 &lt;b&gt;数据&lt;\/b&gt;/);
});

test("top strength summaries require fresh observations and align AI and SPY by New York trading date", () => {
  const summary = html => html.split('<div class="strength-summary">')[1].split('<section class="market-section">')[0];
  for (const change of [{ status: "CACHED" }, { stale: true }, { asOf: "2026-11-05T21:00:00Z" }, { asOf: null }]) {
    const view = market();
    Object.assign(view.assets.find(row => row.symbol === "AIQ"), change);
    const html = marketOverviewHtml({ market: view, now: NOW });
    assert.doesNotMatch(summary(html), /\+1\.25 个百分点/);
    assert.match(summary(html), /未核实/);
    assert.match(html, /\+2\.50%/, "the tile still displays the original value and time");
  }
  const stale = market({ stale: true });
  assert.doesNotMatch(summary(marketOverviewHtml({ market: stale, now: NOW })), /\+1\.25 个百分点|-1\.20%|\+0\.60%/);
  const cached = market();
  cached.assets.find(row => row.symbol === "TLT").status = "CACHED";
  cached.assets.find(row => row.symbol === "UUP").stale = true;
  assert.doesNotMatch(summary(marketOverviewHtml({ market: cached, now: NOW })), /-1\.20%|\+0\.60%/);
  const aligned = market();
  Object.assign(aligned.assets.find(row => row.symbol === "AIQ"), { asOf: "2026-11-07T00:30:00Z", fetchedAt: "2026-11-08T02:45:00Z" });
  assert.match(summary(marketOverviewHtml({ market: aligned, now: NOW })), /\+1\.25 个百分点/, "different fetch times and UTC dates can still refer to the same New York session");
  Object.assign(aligned.assets.find(row => row.symbol === "AIQ"), { returnsAsOf: "2026-11-05T14:30:00Z" });
  Object.assign(aligned.assets.find(row => row.symbol === "SPY"), { returnsAsOf: "2026-11-06T14:30:00Z" });
  assert.doesNotMatch(summary(marketOverviewHtml({ market: aligned, now: NOW })), /\+1\.25 个百分点/, "the return series cutoff must align too, even when quote dates match");
});

test("only three closed-day trend and volatility model cards appear, with VIX treated as an index", () => {
  const html = marketOverviewHtml({ market: market({ assets: [asset("^VIX", { id: "vix", group: "risk", label: "波动率指数", price: 22.8 })] }), now: NOW });
  assert.equal((html.match(/class="model-card"/g) || []).length, 3);
  for (const symbol of ["SPY", "QQQ", "IWM"]) assert.match(html, new RegExp(`data-model="${symbol}"`));
  assert.match(html, /15\.20%/);
  assert.match(html, /20 日实现波动率 · 年化/);
  assert.match(html, /仅模型/);
  assert.match(html, /Gamma 真实数据未接入/);
  assert.match(html, /风险温度/);
  assert.match(html, /22\.80 点/);
  assert.doesNotMatch(html, /22\.80 USD/);
});

test("cached model cards retain their original daily cutoff and stale models suppress current risk numbers", () => {
  const view = market();
  view.signals[0].status = "CACHED";
  const card = html => html.match(/<article class="model-card" data-model="SPY">([\s\S]*?)<\/article>/)[1];
  const cached = card(marketOverviewHtml({ market: view, now: NOW }));
  assert.match(cached, /沿用缓存/);
  assert.match(cached, /2026-11-06/);
  assert.match(cached, /15\.20%/);
  view.stale = true;
  const stale = card(marketOverviewHtml({ market: view, now: NOW }));
  assert.match(stale, /数据陈旧/);
  assert.match(stale, /2026-11-06/);
  assert.doesNotMatch(stale, /15\.20%|65\.79%/);
});

test("all external strings are escaped, source links are fixed Yahoo hosts and report URLs are reconstructed", () => {
  for (const url of ["javascript:alert(1)", "https://finance.yahoo.com.evil.test/quote/SPY", "https://me@finance.yahoo.com/quote/SPY", "https://finance.yahoo.com:8443/quote/SPY", "https://finance.yahoo.com/redirect?url=https://evil.test", "https://evil.test/quote/SPY"]) {
    const html = marketOverviewHtml({ market: market({ assets: [asset("SPY", { label: '<img src=x onerror="bad">', sourceUrl: url, error: "<script>bad</script>" })] }), reports: { latest: { date: "2026-11-08", url, summary: "<script>report</script>", research: "<b>research</b>" }, history: [] }, now: NOW });
    assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/);
    assert.match(html, /&lt;script&gt;report&lt;\/script&gt;/);
    assert.match(html, /href="\/fund-manager\?date=2026-11-08&amp;edition=daily"/);
    assert.equal(html.includes(`href="${url}"`), false);
    assert.doesNotMatch(html, /<script|<img|<b>research/);
  }
});

test("raw Yahoo source links preserve the fixed chart request and missing snapshots are not described as stale quotes", () => {
  const sourceUrl = "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=2y&interval=1d&events=div%2Csplits";
  const html = marketOverviewHtml({ market: market({ assets: [asset("^VIX", { group: "risk", sourceUrl })] }), now: NOW });
  assert.match(html, /href="https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/%5EVIX\?range=2y&amp;interval=1d&amp;events=div%2Csplits"/);
  assert.match(html, /原始数据 ↗/);
  const missing = marketOverviewHtml({ market: { status: "MISSING", stale: true, assets: [], signals: [] }, now: NOW });
  assert.match(missing, /行情尚未生成/);
  assert.doesNotMatch(missing, /行情已陈旧|模型数据陈旧/);
});

test("quote and return-series dates stay separate when daily prices have not synchronized", () => {
  const html = marketOverviewHtml({ market: market({ assets: [asset("AIQ", { group: "ai", status: "PARTIAL", returnsSynchronized: false, returnsAsOf: "2026-11-05T14:30:00Z", change1d: null, change5d: null, change20d: null, error: "最新报价与日线交易日期不同步" })] }), now: NOW });
  assert.match(html, /行情 2026-11-07 05:00/);
  assert.match(html, /收益日线 2026-11-05/);
  assert.match(html, /日线不同步/);
  assert.match(html, /最新报价与日线交易日期不同步/);
  assert.match(html, /612\.34 USD/);
  assert.match(html, /class="tile-return">—<\/strong>/);
});

test("report reader observes new completed daily archives on its next call and excludes previews, future dates and incomplete pairs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-reports-"));
  await archive(directory, "2026-11-07");
  await archive(directory, "2026-11-08", { edition: "preview", body: text("2026-11-08", "预览不可作为日报") });
  await archive(directory, "2026-11-09");
  await writeFile(join(directory, "2026-11-08-daily.md"), text("2026-11-08"));
  const first = await loadLandingReports(directory, { now: NOW });
  assert.equal(first.latest.date, "2026-11-07");
  assert.equal(first.history.length, 1);
  const original = await readFile(join(directory, "2026-11-07-daily.md"), "utf8");
  await archive(directory, "2026-11-08", { body: text("2026-11-08", "今天的新正式结论。") });
  const next = await loadLandingReports(directory, { now: NOW });
  assert.equal(next.latest.date, "2026-11-08");
  assert.equal(next.latest.url, "/fund-manager?date=2026-11-08&edition=daily");
  assert.match(next.latest.summary, /今天的新正式结论/);
  assert.match(next.latest.research, /研究新进展/);
  assert.equal(next.latest.archivedAt, NOW.toISOString());
  assert.equal(await readFile(join(directory, "2026-11-07-daily.md"), "utf8"), original);
  const html = marketOverviewHtml({ market: market(), reports: first, now: NOW });
  assert.match(html, /最近日报 · 2026-11-07/);
});

test("bounded report reads skip corrupt archives, never follow symlinks and keep market content visible on report errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-reports-errors-"));
  await archive(directory, "2026-11-07");
  await archive(directory, "2026-11-08", { body: "x".repeat(70_000) });
  const result = await loadLandingReports(directory, { now: NOW });
  assert.equal(result.latest.date, "2026-11-07");
  assert.ok(result.error);
  const outside = join(await mkdtemp(join(tmpdir(), "market-private-")), "private.md");
  await writeFile(outside, text("2026-11-06", "Private sentinel must stay private"));
  await symlink(outside, join(directory, "2026-11-06-daily.md"));
  await writeFile(join(directory, "2026-11-06-daily.html"), "<!doctype html><html></html>");
  const safe = await loadLandingReports(directory, { now: NOW });
  assert.doesNotMatch(JSON.stringify(safe), /Private sentinel/);
  const bad = join(directory, "not-a-directory");
  await writeFile(bad, "not a directory");
  const failed = await loadLandingReports(bad, { now: NOW });
  assert.equal(failed.latest, null);
  assert.ok(failed.error);
  const html = marketOverviewHtml({ market: market(), reports: failed, now: NOW });
  assert.match(html, /日报读取暂不可用/);
  assert.match(html, /data-asset="spy"/);
  assert.match(html, /\+1\.25%/);
  assert.equal((await loadLandingReports(join(directory, "missing"), { now: NOW })).error, null);
});

test("reports retain at most three historical daily entries and the page stays responsive without remote assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-reports-history-"));
  for (const day of [4, 5, 6, 7, 8]) await archive(directory, `2026-11-0${day}`);
  const reports = await loadLandingReports(directory, { now: NOW });
  assert.equal(reports.history.length, 3);
  assert.deepEqual(reports.history.map(row => row.date), ["2026-11-08", "2026-11-07", "2026-11-06"]);
  const html = marketOverviewHtml({ market: market(), reports, now: NOW });
  assert.match(html, /@media\(max-width:640px\)/);
  assert.match(html, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /:focus-visible/);
  assert.doesNotMatch(html, /<script|<iframe|<link[^>]+stylesheet/);
});


test("redesigned overview keeps quote provenance expandable and gives the formal report its own rail", () => {
  const html = marketOverviewHtml({ market: market(), reports: { latest: { date: "2026-11-08", summary: "保留风险预算。" } }, now: NOW });
  assert.match(html, /<div class="market-masthead">/);
  assert.match(html, /<aside class="market-sidebar" aria-label="基金经理日报">/);
  assert.match(html, /<details class="quote-details"><summary>时间与来源<\/summary>/);
  assert.match(html, /采集 2026-11-08 11:45/);
  assert.match(html, /保留风险预算。/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.equal((html.match(/data-asset=/g) || []).length, 4);
  assert.equal((html.match(/<!doctype html>/g) || []).length, 1);
});
