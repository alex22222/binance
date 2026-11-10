import assert from "node:assert/strict";
import test from "node:test";
import { okxAgenticHtml } from "../src/okx-agentic-html.mjs";

const NOW = new Date("2026-11-09T01:00:00Z"), sourceTime = "2026-11-08T15:12:00.000Z";
function status() {
  return { status: "PARTIAL", stale: false, checkedAt: NOW.toISOString(), components: { monitor: { status: "STALE" }, executor: { status: "STALE" }, health: { status: "STALE" }, heartbeat: { status: "STALE" }, ledger: { status: "STALE" }, research: { status: "STALE" } },
    snapshot: { exportedAt: NOW.toISOString(), source: { name: "OKX 回调二波", machine: "Mac", chain: "xlayer" },
      monitor: { asOf: sourceTime, status: "OK", counts: { sampled: 4, qualified: 0, watching: 1, rejected: 2, errors: 1, unverifiedBlocked: 2 } },
      executor: { asOf: sourceTime, reportedMode: "live", policyEnabled: true, blocked: ["NO_QUALIFIED_CANDIDATES"], qualifiedCandidates: 0 },
      health: { asOf: sourceTime, reportedHealthy: true, issues: [] }, heartbeat: { startedAt: sourceTime, completedAt: sourceTime, status: "running" },
      ledger: { asOf: sourceTime, positionCount: 0, openPositionCount: 0, orderCount: 0, pendingOrderCount: 0, unknownOrderCount: 0 },
      research: { asOf: "2026-10-31T06:57:00Z", candidateObservations: 1, uniqueSetups: 0, quoteCostObservations: 0, netPerformanceVerified: false }, errors: [] } };
}

test("OKX overview shows actual source cutoffs, stale health, strategy scope and an independent wallet-assets entry", () => {
  const html = okxAgenticHtml({ status: status(), now: NOW });
  assert.match(html, /<title>OKX Agentic Wallet/);
  assert.match(html, /X Layer/);
  assert.match(html, /快照同步 2026-11-09 09:00/);
  assert.match(html, /2026-11-08 23:12/);
  assert.match(html, /来源陈旧/);
  assert.match(html, /历史记录：通过/);
  assert.match(html, /本轮没有全部条件通过的标的/);
  assert.match(html, /未关闭策略持仓/);
  assert.match(html, /策略账本只包含该策略记录，不能据此判断钱包总资产/);
  assert.match(html, /尚无已保存的 OKX Agentic Wallet 资产记录/);
  assert.match(html, /href="\/assets"/);
  assert.doesNotMatch(html, /<script|<form|交易按钮|href="https:\/\/web3\.okx|钱包余额：0/);
});

test("old bridge exports, a missing initial snapshot and read errors remain explicit", () => {
  const old = status(); old.stale = true; old.status = "STALE";
  assert.match(okxAgenticHtml({ status: old, now: NOW }), /本机同步已过期/);
  const missing = okxAgenticHtml({ status: { status: "MISSING", snapshot: null }, now: NOW });
  assert.match(missing, /等待首次同步/);
  assert.doesNotMatch(missing, /已开启|采样时通过|>0<\/strong>/);
  const failed = okxAgenticHtml({ status: { status: "ERROR", snapshot: null, error: "<script>private error</script>" }, now: NOW });
  assert.match(failed, /快照读取失败/);
  assert.doesNotMatch(failed, /private error|<script/);
});

test("health failures and unknown counters use static reasons and dashes, while source configuration is not described as execution", () => {
  const value = status();
  value.components.health.status = "ERROR"; value.snapshot.health.reportedHealthy = false; value.snapshot.health.issues = ["EXECUTOR_ERROR", "ORDER_UNVERIFIED"];
  value.snapshot.ledger.pendingOrderCount = null;
  const html = okxAgenticHtml({ status: value, now: NOW });
  assert.match(html, /执行器报告异常/);
  assert.match(html, /订单结果待核验/);
  assert.match(html, /源配置开关/);
  assert.match(html, /报告模式/);
  assert.match(html, /待核验订单<\/span><strong>—<\/strong>/);
  assert.doesNotMatch(html, /当前正在实盘交易/);
});

test("wallet valuations project only saved OKX Agentic records without summing detail and totals or exposing other platforms", () => {
  const assets = { updatedAt: NOW.toISOString(), portfolio: { accounts: [
    { id: "private-id", platform: "OKX Agentic Wallet", name: '<b>钱包</b>', basis: "total", reviewStatus: "confirmed" },
    { id: "exchange", platform: "OKX", name: "交易所" }], entries: [
    { accountId: "private-id", name: "钱包估值", kind: "total", currency: "USD", amount: 12.5, asOf: "2026-11-06", asOfBasis: "statement", source: "api", note: "secret-note" },
    { accountId: "private-id", name: "USDt0 明细", kind: "holding", currency: "USD", amount: 12.5, asOf: "2026-11-06", asOfBasis: "imported", source: "api" },
    { accountId: "exchange", name: "private-exchange", kind: "total", currency: "USD", amount: 999, asOf: "2026-11-09" }] } };
  const html = okxAgenticHtml({ status: status(), assets, now: NOW });
  assert.match(html, /&lt;b&gt;钱包&lt;\/b&gt;/);
  assert.match(html, /12\.5 USD/);
  assert.match(html, /来源日期 2026-11-06/);
  assert.match(html, /导入日期 2026-11-06/);
  assert.match(html, /历史日期/);
  assert.match(html, /明细参考/);
  assert.doesNotMatch(html, /private-id|private-exchange|secret-note|25 USD|<b>钱包/);
  const failure = okxAgenticHtml({ status: status(), assets: { status: "ERROR", accounts: [], error: "private-exception" }, now: NOW });
  assert.match(failure, /资产读取失败/);
  assert.doesNotMatch(failure, /尚无已保存的 OKX Agentic Wallet 资产记录|private-exception/);
});

test("source identity and unknown free-form errors are never rendered as trusted page content", () => {
  const value = status();
  value.snapshot.source.chain = '<img src=x onerror="bad">';
  value.snapshot.executor.blocked = ["raw secret-token"];
  value.snapshot.health.issues = ["<script>raw</script>"];
  const html = okxAgenticHtml({ status: value, now: NOW });
  assert.match(html, /链范围未核实/);
  assert.doesNotMatch(html, /secret-token|<script|<img/);
  assert.match(html, /未分类来源状态/);
});

test("the read-only page uses shared tokens, supports narrow screens and keeps historical research apart from live execution", () => {
  const html = okxAgenticHtml({ status: status(), now: NOW });
  assert.match(html, /name="viewport"/);
  assert.match(html, /@media\(max-width:640px\)/);
  assert.match(html, /grid-template-columns:1fr/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /历史研究摘要/);
  assert.match(html, /未核验净收益/);
  assert.doesNotMatch(html, /https?:\/\/[^<"]+\.(?:js|css)|fonts\.googleapis/);
});
