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

async function render(payload, status = 200) {
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
    fetch: async () => ({ status, ok: status === 200, text: async () => JSON.stringify(payload) })
  });
  runInContext(script, context);
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  return { html, get };
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
