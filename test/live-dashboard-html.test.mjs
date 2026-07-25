import assert from "node:assert/strict";
import test from "node:test";
import { liveDashboardHtml } from "../src/live-dashboard-html.mjs";

test("live dashboard makes unavailable-audit acknowledgement explicit in the approval card", () => {
  const html = liveDashboardHtml();

  assert.match(html, /当前为 SHADOW 模拟/);
  assert.match(html, /auditUnavailableAcknowledged/);
  assert.match(html, /审计数据不可用/);
  assert.doesNotMatch(html, /if \(!window\.confirm\(warning\)\) return/);
  assert.doesNotMatch(html, /实时持仓，一眼看清/);
  assert.doesNotMatch(html, /Local only · Safety control dashboard/);
  assert.match(html, /class="top-stats"/);
  assert.match(html, /id="realizedPnl"/);
  assert.match(html, /id="dailyLossRemaining"/);
  assert.match(html, /id="maxTrade"/);
  assert.match(html, /id="walletStatus"/);
  assert.match(html, /function renderWalletStatus\(walletSession\)/);
  assert.match(html, /钱包 已连接/);
  assert.match(html, /钱包 已断开/);
  assert.doesNotMatch(html, /id="metrics"/);
  assert.match(html, /class="dashboard-grid"/);
  assert.match(html, /\.dashboard-grid \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(html, /class="actions-section"/);
  assert.match(html, /\.actions-section \{ grid-column: 3; grid-row: 1 \/ span 2; \}/);
  assert.match(html, /id="strategyRisk"/);
  assert.match(html, /id="workflow"/);
  assert.match(html, /function renderStrategyRisk\(data\)/);
  assert.match(html, /function renderWorkflow\(data\)/);
  assert.match(html, /href="\/strategies"/);
  assert.match(html, />策略<\/a>/);
  assert.doesNotMatch(html, /id="strategyComparison"/);
  assert.doesNotMatch(html, /function renderStrategies\(data\)/);
});

test("live dashboard provides an approval-first iPhone layout and compact signal table", () => {
  const html = liveDashboardHtml();

  assert.match(html, /env\(safe-area-inset-top\)/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
  assert.match(html, /class="signal-table-head"/);
  assert.match(html, />代码<\/span>/);
  assert.match(html, />方向<\/span>/);
  assert.match(html, />强度 \/ 15分钟<\/span>/);
  assert.match(html, />变化<\/span>/);
  assert.match(html, />更新时间<\/span>/);
  assert.match(html, /signal\?\.timestamp/);
  assert.match(html, /id="signalToggle"/);
  assert.match(html, /signals\.classList\.toggle\("expanded"\)/);
  assert.match(html, /\.approval-button \{[^}]*min-height: 52px;/);
  assert.match(html, /@media \(max-width: 600px\)/);
  assert.match(html, /\.signal-table-head, \.signal \{ display: grid; grid-template-columns: 1\.05fr \.65fr 1\.15fr \.9fr \.85fr;/);
});
