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
  modelVersion: "pressure-v2-no-touch-probability",
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
    history: [{ modelVersion: latest.modelVersion, ts: "2026-10-01T09:00:00+08:00", price: 83000, score: 60 }, { modelVersion: latest.modelVersion, ts: latest.ts, price: 83555.9, score: 63.5 }]
  });
  assert.match(html, /<a href="\/btc-radar" aria-current="page">BTC 风控<\/a>/);
  assert.doesNotMatch(html, /fonts\.googleapis|window\.claude/);
  assert.equal(get("pressureValue").textContent, "64");
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

test("lists the observed candidate rules with their record since the start", async () => {
  const rule = (overrides) => ({
    id: "A_LONG", label: "趋势延续 · 做多", direction: 1, horizon: 7, evidence: "2022 年后 7 天胜率 75%", today: false,
    lastEvent: null, events: 0, matured: 0, hit: null, mean: null, base: null, p: null, ...overrides
  });
  const observation = {
    startedAt: "2026-10-06", asOf: "2026-10-07", minEvents: 10,
    inputs: { trend: 1, r28: 0.086, funding7: 0.041, funding30: 0.03, fng: 70, macro: -1 },
    rules: [
      rule({ lastEvent: { date: "2026-09-18", beforeStart: true } }),
      rule({ id: "A_SHORT", label: "<b>x</b>", direction: -1, today: null }),
      rule({
        id: "FUNDING_HOT", label: "资金费率过热", direction: -1, horizon: 30, today: true, lastEvent: { date: "2026-10-07", beforeStart: false },
        events: 12, matured: 11, hit: 0.636, mean: 0.0412, base: 0.011, p: 0.031, crashRate: 0.182, baseCrashRate: 0.05
      })
    ]
  };
  const { get } = await render({ status: "AVAILABLE", latest: { ...latest, observation }, history: [] });
  assert.equal(get("obsstamp").textContent, "自 2026-10-06 起记录 · 数据截至 2026-10-07");
  assert.equal(get("obsinputs").textContent, "今日输入：站上 4/4 条均线 · 4 周 +8.6% · 资金费率年化 7 日 +4.1%、30 日 +3.0% · 恐惧贪婪 70 · 宏观逆风（美元、实际利率都在升）");
  const cards = get("obsrules").innerHTML;
  assert.match(cards, /最近触发：2026-09-18（观察开始前） · 观察开始后 0 次/);
  assert.match(cards, /还没有到期的触发/);
  assert.equal(cards.match(/样本不足：已到期 0 \/ 10 次/g).length, 2);
  assert.match(cards, /<b>&lt;b&gt;x&lt;\/b&gt;<\/b><span class="pill">数据不全<\/span>/);
  assert.match(cards, /<span class="pill lv-orange">今天触发<\/span>/);
  assert.match(cards, /30 天：方向正确 64%，平均 \+4\.1%（同期随机 \+1\.1%） · p=0\.03/);
  assert.match(cards, /30 天内跌超 20%：18%（随机 5%）/);
  assert.match(cards, /回测：2022 年后 7 天胜率 75%/);

  const missing = await render({ status: "AVAILABLE", latest: { ...latest, observation: null }, history: [] });
  assert.match(missing.get("obsrules").innerHTML, /观察所需的数据暂时读取失败/);
});

test("explains missing position access, empty storage, and an expired login", async () => {
  const unconfigured = await render({
    status: "AVAILABLE", latest: { ...latest, position: null, data_status: { okxConfigured: false, staleSources: [] } }, history: []
  });
  assert.equal(unconfigured.get("pospill").textContent, "未接入持仓");
  assert.match(unconfigured.get("posstats").innerHTML, /尚未配置 OKX 只读 API Key/);
  assert.match(unconfigured.get("hist").innerHTML, /旧版评分不混用/);

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
  assert.doesNotMatch(body, /止损 10% · 止盈 40%/);
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

test("short previews keep the stop above and target below price, without exit probabilities", async () => {
  const short = { ...ladderPosition, id: "dca:short", direction: "short", sl: 105, tp: 96, liq: 110,
    ladder: { ctVal: 0.01, complete: true, pending: [[102, 50], [104, 50]] } };
  const view = await render({ ...ladderPayload, latest: { ...ladderPayload.latest, price: 98, position: short,
    ladders: { week: { dips: { 96: 0.2 }, reaches: { 105: 0.6 } } } } });
  assert.match(view.get("poshead").textContent, /做空/);
  assert.match(view.get("ruler").innerHTML, /class="bar short"/);
  assert.match(view.get("rulerHelp").textContent, /止损以上/);
  assert.match(view.get("riskBody").innerHTML, /-7\.1 USDT/);
  assert.doesNotMatch(view.get("riskBody").innerHTML, /止损 60% · 止盈 20%/);
  assert.match(view.get("riskBody").innerHTML, /止损低于强平/);
  view.run('setPreview("sl", 103, radar.position, radar.price, null)');
  assert.match(view.get("riskBody").innerHTML, /会先成交 1 笔补仓/);
  view.run('setPreview("sl", 50, radar.position, radar.price, null)');
  assert.ok(view.run("preview.sl") > 98);
  view.run('setPreview("tp", 500, radar.position, radar.price, null)');
  assert.ok(view.run("preview.tp") < 98);
});

test("shows grid and account shorts separately and switches the scenario without aggregating or changing OKX", async () => {
  const grid = { id: "grid:g1:net", source: "grid", direction: "short", avg: 100, sz_btc: 1, liq: 120, lever: 10,
    sl: null, tp: null, unrealized_pnl: -2, total_pnl: -1.8, grid_pnl: 0.2, grid_range: [90, 110], level: "yellow", level_name: "止损未确认" };
  const account = { ...grid, id: "account:a1", source: "account", sl: 105, tp: 95, sz_btc: 2, stale: true };
  const view = await render({ ...ladderPayload, latest: { ...ladderPayload.latest, position: grid, positions: [grid, account] } });
  assert.equal(view.get("positionPicker").hidden, false);
  assert.match(view.get("positionList").innerHTML, /合约网格 · 做空/);
  assert.match(view.get("positionList").innerHTML, /普通永续 · 做空/);
  assert.match(view.get("poshead").textContent, /合约网格.*做空/);
  assert.match(view.get("posstats").innerHTML, /网格收益/);
  assert.doesNotMatch(view.get("posstats").innerHTML, /自动补仓|0\.00%/);
  assert.match(view.get("riskBody").innerHTML, /当前强平价（OKX）/);
  assert.doesNotMatch(view.get("riskBody").innerHTML, /会先成交|补仓/);
  assert.match(view.get("risk").innerHTML, /不是最大亏损/);
  view.run('selectPosition("account:a1")');
  assert.match(view.get("poshead").textContent, /普通永续.*做空 · 旧数据/);
  assert.equal(view.get("risk").hidden, true, "stale positions cannot be used for exit calculations");
  view.run('setPreview("sl",105, activePosition(),radar.price,null);resetPreview()');
  assert.match(view.get("poshead").textContent, /普通永续/);
});

test("identical payloads still expire on the clock and a later network outage invalidates the displayed conclusion", async () => {
  const view = await render(ladderPayload);
  view.run('Date.now = () => Date.parse(radar.ts) + 9 * 3600000');
  await view.run("refresh()");
  assert.match(view.get("stamp").innerHTML, /数据已过期/);
  assert.equal(view.get("lvpill").textContent, "数据失效");
  assert.equal(view.get("risk").hidden, true);
  view.run('fetch = async () => { throw new Error("offline"); }');
  await view.run("refresh()");
  assert.match(view.get("stamp").innerHTML, /连接中断/);
  assert.notEqual(view.get("lvpill").className, "pill lv-green");
});

test("neither actual positions nor previews show calendar touch prices as future exit probabilities", async () => {
  const view = await render(ladderPayload);
  assert.doesNotMatch(view.get("posstats").innerHTML, /触及止损概率|触及止盈概率/);
  assert.doesNotMatch(view.get("riskBody").innerHTML, /本周触及概率|止损 10%/);
  assert.match(view.get("risk").innerHTML, /不提供.*概率/);
});

test("switching positions cannot restore risk conclusions while disconnected; recovery restores fresh data", async () => {
  const a = { ...ladderPosition, id: "a" }, b = { ...ladderPosition, id: "b" };
  const view = await render({ ...ladderPayload, latest: { ...ladderPayload.latest, position: a, positions: [a, b] } });
  view.run('const goodFetch = fetch; fetch = async () => { throw Error("offline"); }');
  await view.run("refresh()");
  view.run('selectPosition("b")');
  assert.equal(view.get("pospill").textContent, "持仓结论失效");
  assert.equal(view.get("ruler").innerHTML, "");
  assert.equal(view.get("risk").hidden, true);
  view.run("fetch = goodFetch");
  await view.run("refresh()");
  assert.equal(view.get("risk").hidden, false);
  assert.doesNotMatch(view.get("stamp").innerHTML, /连接中断/);
});

test("old model snapshots fail closed and a model switch clears the previous history SVG", async () => {
  const view = await render({ ...ladderPayload, latest: { ...ladderPayload.latest, modelVersion: undefined } });
  assert.equal(view.get("lvpill").textContent, "数据失效");
  view.get("hist").innerHTML = "<svg>old-version</svg>";
  view.run('radar.modelVersion="pressure-v2-no-touch-probability"; renderHist([{modelVersion:"old",ts:radar.ts,price:100,score:50}])');
  assert.doesNotMatch(view.get("hist").innerHTML, /<svg/);
});

test("leads with the score and its market background, then daily history against real prices", () => {
  const html = btcRadarHtml({ nonce: "layout" });
  const sections = ["market-background", "score-history", "slow-trend", "account-risk"];
  for (const id of sections) {
    assert.match(html, new RegExp('<a[^>]+href="#'+id+'"'));
    assert.match(html, new RegExp('<section[^>]+id="'+id+'"[^>]+aria-labelledby="'+id+'-title"'));
  }
  const at = (marker) => html.indexOf(marker);
  assert.ok(sections.every((id, index) => !index || at('id="'+sections[index - 1]+'"') < at('id="'+id+'"')));
  assert.ok(at('id="market-background"') < at('id="pressureValue"') && at('id="pressureValue"') < at('id="contrib"') && at('id="contrib"') < at('id="factors"'));
  assert.ok(at('id="score-history"') < at('id="daily"') && at('id="daily"') < at('id="validity"') && at('id="validity"') < at('id="slow-trend"'));
  for (const id of ["score-method", "intraday-history", "candidate-observations"]) {
    assert.match(html, new RegExp('<details[^>]+id="'+id+'"[^>]*>\\s*<summary>'));
    assert.doesNotMatch(html, new RegExp('id="'+id+'"[^>]*\\bopen\\b'));
  }
  assert.doesNotMatch(html, /id="experimental-pressure"/);
  assert.match(html, /未验证 \/ 非预测/);
  assert.match(html, /只读.*不下单/);
});

test("account attention remains visible above the three layers and is cleared as current data expires", async () => {
  const dangerous = { ...ladderPosition, id: "account:danger", level: "red", level_name: "止损不先于强平" };
  const view = await render({ ...ladderPayload, latest: { ...ladderPayload.latest, position: dangerous, positions: [dangerous] } });
  assert.equal(view.get("accountAlert").hidden, false);
  assert.match(view.get("accountAlert").textContent, /强平|需关注/);
  assert.match(view.get("accountSummary").textContent, /1 笔/);
  view.run('Date.now=()=>Date.parse(radar.ts)+9*3600000');
  await view.run("refresh()");
  assert.match(view.get("accountSummary").textContent, /未核实|失效/);
  assert.match(view.get("accountAlert").textContent, /失效|未核实/);
});

const v2Factors = [
  { key: "poly", name: "预测市场 Polymarket", weight: 0, score: null, metrics: [["本周下沿触价盘", "$80,000 · Yes 20.0¢"]], note: "仅展示原始报价" },
  { key: "fed", name: "美联储利率预期", weight: 20, score: 80, metrics: [["10月加息", "60%"]], note: "市场押注加息，流动性收紧" },
  { key: "ust", name: "美债收益率", weight: 20, score: 70, metrics: [["10年期", "4.70%"]], note: "收益率平稳" },
  { key: "gold", name: "黄金 (XAUT)", weight: 10, score: 50, metrics: [["10日变化", "+0.0%"]], note: "金价平稳" },
  { key: "tech", name: "BTC 技术面", weight: 15, score: 40, metrics: [["7日涨跌", "+2.0%"]], note: "站上 20 日均线" },
  { key: "deriv", name: "衍生品与情绪", weight: 10, score: 60, metrics: [["持仓量 7日", "+1.0%"]], note: "杠杆水平正常" }
];
const v2Latest = { ...latest, score: 62.7, level: "orange", level_name: "警戒", factors: v2Factors };

test("factor cards show raw data, score, contribution and the scoring rule, and contributions add up to the total", async () => {
  const view = await render({ status: "AVAILABLE", latest: v2Latest, history: [] });
  assert.equal(view.get("pressureValue").textContent, "63");
  const cards = view.get("factors").innerHTML;
  assert.match(cards, /美联储利率预期[\s\S]*权重 20 \/ 75[\s\S]*lv-t-red">80<[\s\S]*贡献 \+8\.0 分[\s\S]*10月加息[\s\S]*评分规则 · 截断在 0–100[\s\S]*0\.6 ×（年内加息 − 年内降息概率）[\s\S]*模型解读（未验证）：市场押注加息/);
  assert.match(cards, /BTC 技术面[\s\S]*贡献 −2\.0 分/);
  assert.match(cards, /预测市场 Polymarket[\s\S]*原始盘口 · 不计分[\s\S]*不计分：只展示各合约区间的原始 Yes 报价/);
  assert.doesNotMatch(cards, /Polymarket<\/h3><span class="tag">原始盘口 · 不计分<\/span><\/div><div class="fac-score">/);
  const contrib = view.get("contrib").innerHTML;
  assert.deepEqual([...contrib.matchAll(/<div class="contrib-row"><span>([^<]+)</g)].map(([, name]) => name), ["美联储利率预期", "美债收益率", "衍生品与情绪", "黄金 (XAUT)", "BTC 技术面"]);
  assert.match(contrib, /中性 50 \+ 12\.7 = 62\.7 分/);
  assert.match(contrib, /80 分 · 权重 27%/);
  view.run('Date.now=()=>Date.parse(radar.ts)+9*3600000; updateHealth()');
  assert.match(view.get("contrib").innerHTML, /数据失效，当前不显示分数构成/);
  assert.doesNotMatch(view.get("factors").innerHTML, /lv-t-red">80</);
});

const dayOf = (offset) => new Date(Date.parse("2026-10-01T00:00:00Z") + offset * 86_400_000).toISOString().slice(0, 10);
function dailyPayload({ snapshots = 3, matured = 2, spearman = null } = {}) {
  const horizons = [1, 7, 30].map((days) => ({ days, matured: days === 1 ? matured : days === 7 ? matured : 0, mean: matured ? -0.012 : null, spearman: days === 7 ? spearman : null,
    bands: [["green", 0, null], ["yellow", 0, null], ["orange", matured, -0.012], ["red", 0, null]].map(([level, n, mean]) => ({ level, n, mean, downShare: n ? 0.5 : null })) }));
  return {
    dailyHour: 8, minSamples: 20, modelVersion: "pressure-v2-no-touch-probability", otherVersionDays: 22, horizons,
    closes: Array.from({ length: 40 }, (_, index) => ({ date: dayOf(index - 40), close: 80000 + index * 100 })),
    snapshots: Array.from({ length: snapshots }, (_, index) => ({ date: dayOf(index - snapshots + 1), ts: dayOf(index - snapshots + 1) + "T08:43:00+08:00", score: 50 + index * 10, level: "orange",
      price: 83000 + index * 50, forward: { 1: index < matured ? -0.01 : null, 7: null, 30: null }, ...(index === 0 ? { staleSources: ["treasury"] } : {}) }))
  };
}

test("plots daily snapshots on real closes and keeps the validity verdict pending until enough days mature", async () => {
  const view = await render({ status: "AVAILABLE", latest: v2Latest, history: [], daily: dailyPayload() });
  const chart = view.get("daily").innerHTML;
  assert.match(chart, /<svg[^>]+aria-label="每日评分与 BTC 日收盘价"/);
  assert.equal(chart.match(/<circle /g)?.length, 6, "each snapshot marks both its price and its score");
  assert.match(chart, /<title>2026-09-29 · 分数 50\.0 · BTC 83,000<\/title>/);
  assert.match(chart, /另有 22 天旧版评分已保存，不与当前版本混用/);
  assert.equal(view.get("dailyStamp").textContent, "当前版本 3 天快照");
  const table = view.get("validity").innerHTML;
  assert.match(table, /低压力 &lt;40<\/span>/);
  assert.match(table, /警戒 55–70<\/span><\/td><td><span class="neg">-1\.2%<\/span><small>下跌 50% · 2 天<\/small>/);
  assert.match(table, /需 20 天，现 2 天/);
  assert.equal(view.get("validityPill").textContent, "样本积累中 · 7 天已到期 2 / 20");
  assert.match(view.get("validityNote").textContent, /互相重叠[\s\S]*不是亏损概率/);
  const rows = view.get("dailyTable").innerHTML;
  assert.ok(rows.indexOf("2026-10-01") < rows.indexOf("2026-09-29"), "newest first");
  assert.match(rows, /2026-09-29<small>部分来源沿用旧值<\/small>/);
  assert.match(rows, /<small>未到期<\/small>/);
});

test("rescored legacy days are drawn hollow and labelled with their original legacy score", async () => {
  const daily = dailyPayload();
  daily.snapshots[0] = { ...daily.snapshots[0], rescoredFrom: { modelVersion: "legacy", score: 47.4 } };
  daily.rescoredDays = 1;
  const view = await render({ status: "AVAILABLE", latest: v2Latest, history: [], daily });
  const chart = view.get("daily").innerHTML;
  assert.equal(chart.match(/fill="var\(--panel\)" stroke=/g)?.length, 2);
  assert.match(chart, /按新版规则重算，旧版原分 47\.4/);
  assert.match(chart, /空心点是旧版时期的快照/);
  assert.equal(view.get("dailyStamp").textContent, "当前版本 3 天快照 · 1 天重算");
  assert.match(view.get("dailyTable").innerHTML, /按新版规则重算（旧版 47\.4）/);
  assert.match(view.get("validityNote").textContent, /含 1 天按新版规则重算的旧版快照/);
});

test("the validity verdict follows the sign and size of the 7-day rank correlation", async () => {
  const verdict = async (spearman) => (await render({ status: "AVAILABLE", latest: v2Latest, history: [], daily: dailyPayload({ matured: 25, spearman }) })).get("validityPill");
  assert.equal((await verdict(-0.6)).textContent, "7 天：与模型方向一致");
  assert.equal((await verdict(0.6)).textContent, "7 天：与模型方向相反");
  assert.equal((await verdict(0.1)).textContent, "7 天：未见明显关系");
  const empty = await render({ status: "AVAILABLE", latest: v2Latest, history: [], daily: dailyPayload({ snapshots: 0, matured: 0 }) });
  assert.match(empty.get("daily").innerHTML, /当前版本尚无每日快照/);
  assert.match(empty.get("dailyTable").innerHTML, /当前版本尚无每日快照/);
  const missing = await render({ status: "AVAILABLE", latest: v2Latest, history: [] });
  assert.match(missing.get("daily").innerHTML, /每日快照暂时读取失败/);
});
