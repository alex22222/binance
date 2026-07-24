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
  assert.doesNotMatch(html, /id="metrics"/);
  assert.match(html, /class="dashboard-grid"/);
  assert.match(html, /\.dashboard-grid \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(html, /class="actions-section"/);
  assert.match(html, /\.actions-section \{ grid-column: 3; grid-row: 1 \/ span 2; \}/);
  assert.match(html, /id="strategyRisk"/);
  assert.match(html, /id="workflow"/);
  assert.match(html, /function renderStrategyRisk\(data\)/);
  assert.match(html, /function renderWorkflow\(data\)/);
});
