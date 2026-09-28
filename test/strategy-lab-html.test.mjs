import assert from "node:assert/strict";
import test from "node:test";
import { Script, createContext, runInContext } from "node:vm";
import { strategyLabHtml } from "../src/strategy-lab-html.mjs";
import { buildStrategyComparison, DEFAULT_STRATEGY_ID } from "../src/strategy-lab.mjs";

class Node {
  children = [];
  attributes = {};
  value = "";
  text = "";
  scrollTop = 0;
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(" "); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; this.text = ""; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener() {}
  contains() { return false; }
  querySelectorAll() { return []; }
}

function page() {
  const script = strategyLabHtml().match(/<script>([\s\S]*)<\/script>/)[1];
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const fixture = {
    mode: "live", approval: { mode: "AUTO" },
    generatedAt: "2026-09-26T10:00:00Z", activeStrategyId: DEFAULT_STRATEGY_ID, control: { status: "AVAILABLE" },
    strategies: buildStrategyComparison(DEFAULT_STRATEGY_ID, []),
    trace: { status: "AVAILABLE" }, validation: { status: "MISSING" }, shadow: { status: "MISSING" }, paper: {}
  };
  const context = createContext({ fixture, location: { hash: "" }, document: { createElement: (tag) => new Node(tag), getElementById: get }, AbortSignal, fetch: async () => ({ ok: true, json: async () => fixture }) });
  new Script(script);
  runInContext(script.slice(0, script.indexOf('    document.getElementById("strategySearch").addEventListener')), context);
  runInContext("data = fixture; selectedId = fixture.activeStrategyId;", context);
  return { fixture, context, get, run: (code) => runInContext(code, context) };
}

test("research shell is read-only, accessible, and uses a single saved-evidence endpoint", () => {
  const html = strategyLabHtml();
  assert.match(html, /<title>策略研究 · Agentic Wallet/);
  assert.match(html, /id="strategyComparison"/);
  assert.match(html, /aria-label="搜索策略"/);
  assert.match(html, /aria-controls="directoryBody"/);
  assert.match(html, /\/api\/strategy-research/);
  assert.doesNotMatch(html, /method:\s*["']POST|innerHTML|\/api\/snapshot|strategy-switch/);
  page();
});

test("missing live results render unknown instead of zero and keep the true strategy thesis", () => {
  const view = page(); view.run("renderDossier()");
  const text = view.get("dossierContent").textContent;
  assert.match(text, /当前配置策略/);
  assert.match(text, /自动审批/);
  assert.match(text, /未获新增实盘资格/);
  assert.doesNotMatch(text, /仅在人工逐笔审批/);
  assert.match(text, /暂无可核验的实盘平仓/);
  assert.match(text, /不是完整历史账本/);
  assert.doesNotMatch(text, /0\.00 U/);
  view.fixture.trace.status = "ERROR";
  view.run("renderDossier()");
  assert.match(view.get("dossierContent").textContent, /报告读取失败/);
  assert.doesNotMatch(view.get("dossierContent").textContent, /0 笔/);
});

test("historical rows keep distinct periods, fixed-notional basis, and missing-strategy state", () => {
  const view = page();
  view.fixture.validation = { status: "AVAILABLE", generatedAt: "2026-08-26", historical: { assumptions: { notionalUsdt: 50 }, dataCoverage: { from: "2026-01-01", to: "2026-06-30" }, strategies: [{ id: DEFAULT_STRATEGY_ID, performance: { trades: 2, returnPct: 0, maxDrawdownPct: 0, pnlUsdt: 0 } }] }, forward: { assumptions: { notionalUsdt: 50 }, dataCoverage: { from: "2026-07-01", to: "2026-08-26" }, strategies: [{ id: DEFAULT_STRATEGY_ID, performance: { trades: 1, returnPct: -2, maxDrawdownPct: 2, pnlUsdt: -1 } }] } };
  view.run('evidence = "history"; renderDossier()');
  const text = view.get("dossierContent").textContent;
  assert.match(text, /0\.00%/);
  assert.match(text, /-2\.00%/);
  assert.match(text, /2026-01-01 — 2026-06-30/);
  assert.match(text, /2026-07-01 — 2026-08-26/);
  assert.match(text, /分母 50\.00 USDT/);
  assert.match(text, /不是组合收益率/);
  view.run('selectedId = "daily-turtle-55-20"; renderDossier()');
  assert.match(view.get("dossierContent").textContent, /没有该策略的模拟结果/);
});

test("search and stage filters combine without changing the selected dossier", () => {
  const view = page();
  view.get("strategySearch").value = "回撤";
  view.get("stageFilter").value = "SHADOW";
  view.run("renderDirectory()");
  assert.equal(view.get("strategyComparison").children.length, 2);
  assert.equal(view.run("selectedId"), DEFAULT_STRATEGY_ID);
  view.get("strategySearch").value = "not-found";
  view.run("renderDirectory()");
  assert.match(view.get("strategyComparison").textContent, /未找到匹配策略/);
});

test("paper and shadow data never become live performance", () => {
  const view = page();
  view.fixture.paper[DEFAULT_STRATEGY_ID] = { status: "AVAILABLE", equityUsdt: 57, realizedPnlUsdt: 7, totalReturnPct: 14, closedTrades: 1 };
  view.fixture.shadow = { status: "AVAILABLE", horizons: [{ horizonMinutes: 30, strategyCohorts: { [DEFAULT_STRATEGY_ID]: { samples: 2, averageNetReturnPct: 1.3 } } }] };
  view.run('evidence = "paper"; renderDossier()');
  assert.match(view.get("dossierContent").textContent, /57\.00 U/);
  assert.match(view.get("dossierContent").textContent, /PAPER_CANDLE_PROXY/);
  view.run('evidence = "shadow"; renderDossier()');
  assert.match(view.get("dossierContent").textContent, /1\.30%/);
  assert.match(view.get("dossierContent").textContent, /未完整计入卖出成本/);
  view.run('evidence = "live"; renderDossier()');
  assert.doesNotMatch(view.get("dossierContent").textContent, /57\.00|7\.00|1\.30%/);
});

test("failed refresh retains prior evidence and clearly reports it as cached", async () => {
  const view = page();
  view.context.fetch = async () => ({ ok: false, status: 401 });
  await view.run("refresh()");
  assert.match(view.get("readStatus").textContent, /登录已过期/);
  assert.match(view.get("readStatus").textContent, /保留上次成功读取/);
  assert.equal(view.get("refreshButton").disabled, false);
});
