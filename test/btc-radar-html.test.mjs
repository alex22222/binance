import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { btcRadarHtml } from "../src/btc-radar-html.mjs";

class Element {
  innerHTML = "";
  className = "";
  text = "";
  set textContent(value) { this.text = String(value); this.innerHTML = ""; }
  get textContent() { return this.text; }
}

async function render(payload, status = 200, post = null) {
  const html = btcRadarHtml({ nonce: "test-nonce" });
  const script = html.match(/<script nonce="test-nonce">([\s\S]*)<\/script>/)[1];
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const context = createContext({
    document: { hidden: false, getElementById: get },
    AbortSignal,
    URL,
    setInterval: () => 0,
    fetch: async (url, options = {}) => options.method === "POST"
      ? post(url, options)
      : { status, ok: status === 200, text: async () => JSON.stringify(payload) }
  });
  runInContext(script, context);
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  return { html, get, run: (code) => runInContext(code, context) };
}

const latest = {
  ts: new Date().toISOString(),
  price: 83555.9,
  score: 63.5,
  level: "orange",
  level_name: "警戒",
  summary: "综合 63 分（警戒）。",
  factors: [{
    key: "poly", name: "<img src=x onerror=alert(1)>", weight: 25, score: 48,
    metrics: [["本周跌 4%", "<b>22%</b>"]], note: "\"quoted\" note"
  }],
  position: {
    avg: 81250.46, tp: 84500, sl: 77000, liq: 73100, sz_btc: 0.105, lever: 20, total_pnl: -12.35,
    safety_filled: 6, safety_max: 10, next_safety: 79704, d_sl: -4.61, d_liq: -12.51, d_tp: 1.13,
    level: "bogus", level_name: "离止损不远", p_sl_week: 0.17, p_tp_week: 0.168
  },
  sources: [["恶意", "javascript:alert(1)"], ["OKX <x>", "https://www.okx.com"]],
  data_status: { okxConfigured: true, staleSources: [{ key: "treasury", label: "美债<收益率>" }] }
};

test("renders the migrated radar from the server API and escapes every saved string", async () => {
  const { html, get } = await render({
    status: "AVAILABLE",
    latest,
    history: [{ ts: "2026-10-01T09:00:00+08:00", price: 83000, score: 60 }, { ts: latest.ts, price: 83555.9, score: 63.5 }]
  });
  assert.match(html, /<a href="\/btc-radar" aria-current="page">BTC 风控<\/a>/);
  assert.doesNotMatch(html, /fonts\.googleapis|window\.claude/);
  assert.match(get("gauge").innerHTML, />64<\/text>/);
  assert.equal(get("lvpill").className, "pill lv-orange");
  assert.equal(get("pospill").className, "pill lv-yellow");
  assert.equal(get("poshead").textContent, "合约马丁格尔 · BTCUSDT 永续 20x 做多");
  assert.match(get("factors").innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(get("factors").innerHTML, /&lt;b&gt;22%&lt;\/b&gt;/);
  assert.doesNotMatch(get("factors").innerHTML, /<img|<b>/);
  assert.match(get("posstats").innerHTML, /-4\.61%/);
  assert.match(get("stamp").innerHTML, /沿用旧数据：美债&lt;收益率&gt;/);
  assert.doesNotMatch(get("sources").innerHTML, /javascript:/);
  assert.match(get("sources").innerHTML, /href="https:\/\/www\.okx\.com\/"[^>]*>OKX &lt;x&gt;<\/a>/);
  assert.match(get("hist").innerHTML, /<svg viewBox="0 0 720 220"/);
});

test("shows the 200-day trend state and explains a missing or undecided one", async () => {
  const trend = { date: "2026-10-05", close: 85835, average: 71578.12, distance: 0.19918, band: 0.03, state: "LONG", since: "2026-08-22", previous: "AVOID" };
  const { html, get } = await render({ status: "AVAILABLE", latest: { ...latest, trend }, history: [] });
  assert.match(html, /回避只表示不持有多头，不是做空信号/);
  assert.equal(get("trendpill").textContent, "多头环境");
  assert.equal(get("trendpill").className, "pill lv-green");
  const stats = get("trendstats").innerHTML;
  assert.match(stats, /日收盘 2026-10-05<\/div><div class="v">85,835</);
  assert.match(stats, /200 日均线<\/div><div class="v">71,578</);
  assert.match(stats, /<span class="pos-c">\+19\.92%<\/span>/);
  assert.match(stats, /2026-08-22<small>此前为回避环境<\/small>/);

  const avoid = await render({ status: "AVAILABLE", latest: { ...latest, trend: { ...trend, state: "AVOID", distance: -0.05, since: null, previous: null } }, history: [] });
  assert.equal(avoid.get("trendpill").className, "pill lv-orange");
  assert.match(avoid.get("trendstats").innerHTML, /<span class="neg">-5\.00%<\/span>/);
  assert.match(avoid.get("trendstats").innerHTML, /近 100 天内未切换/);

  const odd = await render({ status: "AVAILABLE", latest: { ...latest, trend: { ...trend, state: "<b>", date: "<i>x</i>" } }, history: [] });
  assert.equal(odd.get("trendpill").textContent, "未确定");
  assert.equal(odd.get("trendpill").className, "pill");
  assert.match(odd.get("trendstats").innerHTML, /日收盘 &lt;i&gt;x&lt;\/i&gt;/);

  const missing = await render({ status: "AVAILABLE", latest: { ...latest, trend: null }, history: [] });
  assert.equal(missing.get("trendpill").textContent, "暂无数据");
  assert.match(missing.get("trendstats").innerHTML, /不足 200 天/);
});

test("explains missing position access, empty storage, and an expired login", async () => {
  const unconfigured = await render({
    status: "AVAILABLE", latest: { ...latest, position: null, data_status: { okxConfigured: false, staleSources: [] } }, history: []
  });
  assert.equal(unconfigured.get("pospill").textContent, "未接入持仓");
  assert.match(unconfigured.get("posstats").innerHTML, /尚未配置 OKX 只读 API Key/);
  assert.match(unconfigured.get("hist").innerHTML, /^$/);

  const missing = await render({ status: "MISSING", latest: null, history: [] });
  assert.equal(missing.get("stamp").textContent, "等待服务器第一次评估写入数据");

  const expired = await render({}, 401);
  assert.match(expired.get("stamp").innerHTML, /<a href="\/login">重新登录<\/a>/);
});

test("shows RSI and Fear & Greed as unscored reference rows inside their factor cards", async () => {
  const factors = [
    { key: "tech", name: "BTC 技术面", weight: 15, score: 35, metrics: [["7日涨跌", "-0.6%"]], note: "站上 20 日均线" },
    { key: "deriv", name: "衍生品与情绪", weight: 10, score: 48, metrics: [["资金费率均值", "0.0048%"]], note: "杠杆水平正常" }
  ];
  const { get } = await render({
    status: "AVAILABLE", history: [],
    latest: { ...latest, factors, indicators: { rsi14: { closed: 64.8, intraday: 69.3, date: "2026-10-01" }, fearGreed: { value: 72, label: "贪婪<x>", date: "2026-10-02" } } }
  });
  const html = get("factors").innerHTML;
  assert.match(html, /<dt class="ref-first">RSI\(14\) 日线收盘<span class="ref">参考<\/span><\/dt><dd class="ref-first">64\.8<\/dd>/);
  assert.match(html, /RSI\(14\) 含当日盘中<span class="ref">参考<\/span><\/dt><dd class="">69\.3<\/dd>/);
  assert.match(html, /恐惧贪婪指数<span class="ref">参考<\/span><\/dt><dd class="ref-first">72 贪婪&lt;x&gt;<\/dd>/);
  const without = await render({ status: "AVAILABLE", history: [], latest: { ...latest, factors } });
  assert.doesNotMatch(without.get("factors").innerHTML, /参考/);
});

const ladderPosition = {
  ...latest.position, level: "green", level_name: "安全距离", avg: 100, sz_btc: 1, sl: 95, tp: 104, liq: 90, lever: 10,
  next_safety: 98, safety_filled: 4, safety_max: 10, manual_adds: 2, ladder: { ctVal: 0.01, complete: true, pending: [[98, 50], [96, 50]] }
};
const ladderPayload = {
  status: "AVAILABLE", history: [], settings: { capitalUsdt: 100 },
  latest: { ...latest, price: 102, position: ladderPosition, ladders: { week: { dips: { 95: 0.1, 99: 0.3 }, reaches: { 104: 0.4, 108: 0.1 } } } }
};

test("previews the worst case at a dragged stop and resets to the bot's real settings", async () => {
  const view = await render(ladderPayload);
  const body = view.get("riskBody").innerHTML;
  assert.match(body, /-7\.1 USDT/);
  assert.match(body, /约占总资金 7\.1%/);
  assert.match(body, /会先成交 2 笔补仓，仓位 2\.0000 BTC，均价 99/);
  assert.match(body, /止损 10% · 止盈 40%/);
  assert.doesNotMatch(body, /预览中/);
  assert.match(view.get("posstats").innerHTML, /4 \/ 10 · 手动 2/);
  view.run('setPreview("sl", 97, radar.position, radar.price, null)');
  const moved = view.get("riskBody").innerHTML;
  assert.match(moved, /会先成交 1 笔补仓，仓位 1\.5000 BTC/);
  assert.match(moved, /预览中 · 不会修改 OKX/);
  view.run('setPreview("tp", 500, radar.position, radar.price, null)');
  assert.ok(view.run("preview.tp") < 500);
  view.run("resetPreview()");
  assert.equal(view.run("Object.keys(preview).length"), 0);
  assert.doesNotMatch(view.get("riskBody").innerHTML, /预览中/);
});

test("saves the total capital through the authenticated settings endpoint", async () => {
  const requests = [];
  const view = await render({ ...ladderPayload, settings: {} }, 200, async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ success: true, settings: { capitalUsdt: 5000 } }) };
  });
  assert.match(view.get("riskBody").innerHTML, /填写总资金后显示占比/);
  view.get("capitalInput").value = "5,000";
  await view.run("saveCapital()");
  assert.equal(requests[0].url, "/api/btc-radar/settings");
  assert.deepEqual(JSON.parse(requests[0].options.body), { capitalUsdt: 5000 });
  assert.equal(view.get("capitalStatus").textContent, "已保存");
  assert.match(view.get("riskBody").innerHTML, /约占总资金 0\.1%/);
  view.get("capitalInput").value = "-3";
  await view.run("saveCapital()");
  assert.equal(view.get("capitalStatus").textContent, "请输入大于 0 的数字");
  assert.equal(requests.length, 1);
});
