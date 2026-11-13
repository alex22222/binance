import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { digitalCurrencyHtml } from "../src/digital-currency-html.mjs";

const NOW = new Date("2026-11-09T04:00:00Z");
const VERSION = "pressure-v2-no-touch-probability";
const radar = (changes = {}) => ({ status: "AVAILABLE", freshness: { expired: false }, settings: { capitalUsdt: 5000 },
  latest: { modelVersion: VERSION, ts: "2026-11-09T03:00:00Z", price: 0.0000123456789, score: 63.5, level: "orange", level_name: "警戒", summary: "原生产模型结论。",
    factors: [{ key: "fed", name: "美联储", weight: 20, score: 75, metrics: [["原始指标", "4.5%"]], note: "原生产因子解释。" }, { key: "poly", name: "预测盘口", weight: 0, score: null, metrics: [["Yes 原始报价", "20¢"]], note: "不计分。" }],
    positions: [{ id: "account:btc", source: "account", direction: "short", lever: 3, sz_btc: 0.1, avg: 82000, sl: 85000, tp: 75000, liq: 100000, d_sl: 3.2, d_liq: 12, d_tp: -5, level: "yellow", level_name: "原风险标签", fetchedAt: "2026-11-09T03:00:00Z", unrealized_pnl: -4 }],
    trend: { state: "AVOID", date: "2026-11-08", close: 80000, average: 84000, distance: -0.047619, band: 0.03, since: "2026-11-01" },
    data_status: { okxConfigured: true, staleSources: [] }, sources: [["OKX", "https://www.okx.com"]] },
  history: [{ ts: "2026-11-09T03:00:00Z", modelVersion: VERSION, price: 80000, score: 63.5 }, { ts: "2026-11-08T03:00:00Z", modelVersion: "old-model", price: 70000, score: 99 }],
  daily: { modelVersion: VERSION, snapshots: [{ date: "2026-11-08", modelVersion: VERSION, price: 81000, score: 62, forward: { 1: -0.01, 7: null, 30: null } }, { date: "2026-11-07", modelVersion: "old-model", price: 70000, score: 99 }], horizons: [{ days: 7, matured: 3, mean: -0.01, spearman: null }], minSamples: 20 }, ...changes });
const watch = (changes = {}) => ({ status: "AVAILABLE", watchlist: { syncedAt: "2026-11-09T00:00:00Z", source: "OKX 自选 / 全部", sourceUrl: "https://www.okx.com/markets/favorite", instruments: [{ instId: "GRASS-USDT" }] },
  latest: { date: "2026-11-09", generatedAt: "2026-11-09T00:01:00Z", status: "OK", tokens: [{ instId: "GRASS-USDT", instType: "SPOT", name: "Grass", kind: "crypto", status: "OK", price: 0.000000123456, change24hPct: 2, return7dPct: -4, errors: [], sourceUrl: "https://www.okx.com/trade-spot/grass-usdt" }] }, history: [], ...changes });

test("unified page is one real SSR document with BTC before all favorite instruments and the old advanced interaction entry", () => {
  const html = digitalCurrencyHtml({ radar: radar(), watch: watch(), now: NOW });
  for (const tag of ["<!doctype html>", '<html lang="zh-CN">', '<body>', 'class="site-header"']) assert.equal(html.split(tag).length - 1, 1, tag);
  assert.match(html, /<a href="\/crypto" aria-current="page">BTC 与收藏<\/a>/);
  assert.ok(html.indexOf('id="btc-overview"') < html.indexOf('id="favorites"'));
  assert.match(html, /class="dc-score">63\.5<\/strong>/);
  assert.match(html, /原生产模型结论/);
  assert.match(html, /pressure-v2-no-touch-probability/);
  assert.match(html, /0\.0000123456789/);
  assert.match(html, /0\.000000123456/);
  assert.match(html, /href="\/btc-radar\?view=detail/);
  assert.match(html, /高级情景与总资金设置/);
  assert.match(html, /dc-tabs/);
  assert.match(html, /BTC 决策/);
  assert.match(html, /收藏日报/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.doesNotMatch(html, /<iframe|<script|pressure-v3|一年滚动分位数|每 365 天/);
});

test("empty BTC perpetual risk collapses to one compact row", () => {
  const available = radar();
  available.latest.positions = [];
  const html = digitalCurrencyHtml({ radar: available, watch: watch(), now: NOW });
  assert.match(html, /BTC 永续：本次无持仓/);
  assert.match(html, /不代表其他币种空仓/);
  assert.match(html, /dc-risk-compact/);
  assert.doesNotMatch(html, /暂无可展示的 BTC 持仓明细/);
});

test("favorites view leads with the watchlist and keeps a BTC score strip", () => {
  const html = digitalCurrencyHtml({ radar: radar(), watch: watch(), now: NOW, view: "favorites", sort: "7d" });
  assert.ok(html.indexOf("dc-score-strip") < html.indexOf('id="favorites"'));
  assert.ok(html.indexOf('id="favorites"') < html.indexOf("dc-page-stamp"));
  assert.match(html, /aria-current="page">收藏日报</);
  assert.match(html, /打开 BTC 决策/);
  assert.match(html, /sort=7d|aria-current="true">7 日/);
  assert.doesNotMatch(html, /id="btc-overview"/);
});

test("v2 factors, trend and per-source BTC positions are displayed without new risk or score calculations", () => {
  const html = digitalCurrencyHtml({ radar: radar(), watch: watch(), now: NOW });
  assert.match(html, /权重 20/);
  assert.match(html, /原始盘口 · 不计分/);
  assert.match(html, /回避环境/);
  assert.match(html, /不是做空信号/);
  assert.match(html, /普通永续 · 做空/);
  assert.match(html, /原风险标签/);
  assert.match(html, /3x/);
  assert.match(html, /\+3\.20%/);
  assert.match(html, /-4\.8%/);
  assert.doesNotMatch(html, /\+320\.00%/);
  assert.match(html, /全账户止损覆盖未提供/);
  assert.doesNotMatch(html, /止损覆盖率.*100%|全部杠杆仓位.*已核验|当前建议杠杆上限/);
});

test("a valid v2 score survives partial source reuse and legacy DTOs without newer risk or freshness fields", () => {
  const input = radar();
  delete input.freshness;
  input.latest.data_status.staleSources = [{ key: "fed", label: "美联储利率预期", since: "2026-11-08T23:00:00Z" }];
  const html = digitalCurrencyHtml({ radar: input, watch: watch(), now: NOW });
  assert.match(html, /class="dc-score">63\.5<\/strong>/);
  assert.match(html, /部分来源沿用旧值/);
  assert.match(html, /美联储利率预期 · 2026-11-09 07:00/);
  assert.match(html, /原风险标签/);
  assert.match(html, /全账户止损覆盖未提供/);
  assert.doesNotMatch(html, /BTC 评估已失效|模型版本不匹配|pressure-v3/);
  input.latest.data_status.staleSources.push({ key: "accountPositions", label: "普通永续", since: "2026-11-08T23:00:00Z" });
  const partial = digitalCurrencyHtml({ radar: input, watch: watch(), now: NOW });
  assert.match(partial, /class="dc-score">63\.5<\/strong>/);
  assert.match(partial, /当前风险未核实/);
  assert.doesNotMatch(partial, /原风险标签/);
});

test("expired DTOs do not regain current score, trend or risk conclusions but retain same-version historical evidence", () => {
  const input = radar();
  input.status = "STALE";
  input.freshness.expired = true;
  input.latest.positions[0].stale = true;
  const html = digitalCurrencyHtml({ radar: input, watch: watch(), now: NOW });
  assert.match(html, /class="dc-score">—<\/strong>/);
  assert.match(html, /当前风险未核实/);
  assert.match(html, /历史趋势/);
  assert.match(html, /2026-11-08/);
  assert.match(html, /-1\.0%/);
  assert.doesNotMatch(html, /old-model|>99(?:\.0)?<|原风险标签/);
  assert.match(html, /data-instrument="GRASS-USDT"/);
});

test("an expired freshness flag labels a saved summary as history instead of presenting it as a current assessment", () => {
  const input = radar();
  const fresh = digitalCurrencyHtml({ radar: input, watch: watch(), now: NOW });
  assert.match(fresh, /<p class="dc-summary">原生产模型结论。<\/p>/);
  assert.doesNotMatch(fresh, /历史摘要：原生产模型结论。/);
  input.freshness.expired = true;
  const expired = digitalCurrencyHtml({ radar: input, watch: watch(), now: NOW });
  assert.match(expired, /<h2 id="btc-overview-title">当前评估未核实<\/h2>/);
  assert.match(expired, /<p class="dc-summary">历史摘要：原生产模型结论。<\/p>/);
  assert.doesNotMatch(expired, /<p class="dc-summary">原生产模型结论。<\/p>/);
});

test("each source fails independently, and a missing BTC position never claims the whole account is empty", () => {
  const failed = digitalCurrencyHtml({ radar: { status: "ERROR", latest: null }, watch: watch(), now: NOW });
  assert.match(failed, /BTC 评估读取失败/);
  assert.match(failed, /data-instrument="GRASS-USDT"/);
  const available = radar();
  available.latest.positions = [];
  const inverse = digitalCurrencyHtml({ radar: available, watch: { status: "ERROR", error: "收藏读取错误", latest: null }, now: NOW });
  assert.match(inverse, /class="dc-score">63\.5<\/strong>/);
  assert.match(inverse, /收藏读取错误/);
  assert.match(inverse, /BTC 永续：本次无持仓/);
  assert.match(inverse, /不代表其他币种空仓/);
  assert.doesNotMatch(inverse, /账户已空仓|无账户风险/);
});

test("all BTC DTO strings and links remain untrusted while fragment styles and IDs stay in their own scope", async () => {
  const input = radar();
  input.latest.summary = '<script>summary</script>';
  input.latest.factors[0].name = '<img src=x onerror="bad">';
  input.latest.positions[0].id = '"><svg/onload=bad>';
  input.latest.sources = [["Bad source", "javascript:bad"], ["Userinfo", "https://me@www.okx.com/"], ["Safe <x>", "https://www.okx.com/"]];
  const html = digitalCurrencyHtml({ radar: input, watch: watch(), now: NOW });
  assert.match(html, /&lt;script&gt;summary&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(html, /<script|<img|<svg\/onload|href="(?:javascript:|https:\/\/me@)/);
  assert.match(html, /Safe &lt;x&gt;/);
  const source = await readFile(new URL("../src/digital-currency-html.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["'][^"']*btc-radar-(?:risk|model|sources)/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
  assert.equal(new Set(ids).size, ids.length);
});

const accountRadar = () => {
  const input = radar();
  input.latest.modelVersion = "pressure-v3-trailing-percentiles";
  input.latest.accountRisk = { complete: true, fetchedAt: "2026-11-09T03:00:00Z", errors: [], limit: 3, spotOnly: false,
    positions: [{ instId: "HYPE-USDT", instType: "MARGIN", source: "account", direction: "long", size: 10, sizeUnit: "base",
      stopSize: 4, stopCoverage: 0.4, coverageLevel: "red", leverage: 5, overLimit: true }] };
  return input;
};
const accountSection = input => {
  const html = digitalCurrencyHtml({ radar: input, watch: watch(), now: NOW });
  const section = html.match(/<section[^>]*id="account-risk"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section, "the unified page must expose the optional accountRisk DTO");
  return section;
};

test("optional v3 account risk shows all symbols, partial stop coverage and leverage breaches alongside v2 BTC exits", () => {
  const input = accountRadar();
  input.latest.accountRisk.positions.push(
    { ...input.latest.accountRisk.positions[0], instId: "BTC-USDT-SWAP", instType: "SWAP", sizeUnit: "contracts", stopSize: 10, stopCoverage: 1, leverage: 2, overLimit: false },
    { ...input.latest.accountRisk.positions[0], instId: "TAIL-USDT", stopSize: 9.99981, stopCoverage: 0.999981 },
    { ...input.latest.accountRisk.positions[0], instId: "BOT-USDT-SWAP", source: "dca", sizeUnit: "contracts", stopSize: null, stopCoverage: null, coverageLevel: "unknown" }
  );
  const section = accountSection(input);
  for (const text of ["全部杠杆仓位", "HYPE-USDT", "BTC-USDT-SWAP", "BOT-USDT-SWAP", "基础币", "张", "40%", "99.998%", "100%", "5x", "3x", "超出建议上限", "未核实"]) assert.ok(section.includes(text), text);
  assert.match(section, /dc-negative[^>]*>40%/);
  assert.match(section, /dc-negative[^>]*>99\.998%/);
  const html = digitalCurrencyHtml({ radar: input, watch: watch(), now: NOW });
  assert.match(html, /原风险标签/);
  assert.match(html, /data-instrument="GRASS-USDT"/);
  assert.doesNotMatch(html, /全账户止损覆盖未提供|<script/);
});

test("account coverage fails closed for stale, malformed or missing evidence even with a full-coverage DTO", () => {
  const mutations = [
    input => { input.status = "STALE"; },
    input => { input.freshness.expired = true; },
    input => { input.latest.accountRisk.fetchedAt = "2026-11-08T22:00:00Z"; },
    input => { input.latest.accountRisk.fetchedAt = "2026-11-09T05:00:00Z"; },
    input => { delete input.latest.accountRisk.fetchedAt; },
    input => { input.latest.accountRisk.stale = true; },
    input => { input.latest.data_status.staleSources = [{ key: "accountRisk" }]; },
    ...[{ stale: true }, { fetchedAt: "2026-11-08T22:00:00Z" }, { stopCoverage: null }, { stopCoverage: "1" },
      { stopCoverage: 1.01 }, { stopCoverage: -0.1 }, { stopSize: null }, { sizeUnit: "unknown" }, { direction: null }]
      .map(patch => input => Object.assign(input.latest.accountRisk.positions[0], patch))
  ];
  for (const mutate of mutations) {
    const input = accountRadar();
    Object.assign(input.latest.accountRisk.positions[0], { stopSize: 10, stopCoverage: 1, coverageLevel: "green" });
    mutate(input);
    const section = accountSection(input);
    assert.match(section, /未核实/);
    assert.doesNotMatch(section, />100%<|dc-positive[^>]*>100%/);
  }
});

test("optional account risk cannot invent a score-dependent allowance or a safe empty portfolio", () => {
  for (const patch of [{ score: null }, { score: "60" }]) {
    const input = accountRadar();
    Object.assign(input.latest, patch);
    const section = accountSection(input);
    assert.match(section, /当前建议杠杆上限：未核实/);
    assert.doesNotMatch(section, /超出建议上限|未超建议上限/);
    assert.match(section, /40%/, "account evidence is independent of missing model history");
  }
  const input = accountRadar();
  input.latest.accountRisk.limit = 1;
  input.latest.accountRisk.spotOnly = true;
  assert.match(accountSection(input), /仅现货/);
  input.latest.accountRisk.complete = false;
  input.latest.accountRisk.positions = [];
  input.latest.accountRisk.errors = ["dca: size unavailable"];
  const section = accountSection(input);
  assert.match(section, /来源不完整|采集不完整/);
  assert.match(section, /空白不代表/);
  assert.doesNotMatch(section, /全部杠杆仓位.*已核验|账户已空仓|无账户风险/);
});

test("optional account strings are escaped and malformed DTO shapes do not break the v2 page", () => {
  const input = accountRadar();
  Object.assign(input.latest.accountRisk.positions[0], { instId: '<img src=x onerror="bad">', source: "<svg/onload=bad>", coverageNote: "<script>bad</script>" });
  input.latest.accountRisk.errors = ["<script>error</script>"];
  const section = accountSection(input);
  assert.match(section, /&lt;img/);
  assert.match(section, /&lt;script&gt;/);
  assert.doesNotMatch(section, /<script|<img|<svg/);
  for (const value of [null, {}, { positions: [null, {}] }, { positions: "bad" }]) {
    input.latest.accountRisk = value;
    const html = digitalCurrencyHtml({ radar: input, watch: watch(), now: NOW });
    assert.match(html, /原风险标签/);
    assert.doesNotMatch(html, />100%</);
  }
});
