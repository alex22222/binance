import assert from "node:assert/strict";
import test from "node:test";
import { tradeReviewHtml } from "../src/trade-review-html.mjs";

test("trade review page renders health, comparison, diagnosis and evidence sections", () => {
  const html = tradeReviewHtml();

  assert.match(html, /id="reviewDate"/);
  assert.match(html, /id="healthSummary"/);
  assert.match(html, /id="dailyMetrics"/);
  assert.match(html, /id="comparisonTable"/);
  assert.match(html, /id="periodComparison"/);
  assert.match(html, /id="diagnosisList"/);
  assert.match(html, /id="evidenceScope"/);
  assert.match(html, /id="premarketBrief"/);
  assert.match(html, /id="externalMarket"/);
  assert.match(html, /id="tradeRows"/);
  assert.match(html, /id="openRisk"/);
  assert.match(html, /id="systemFailures"/);
  assert.match(html, /\/api\/trade-reviews/);
  assert.match(html, /近 5 日/);
  assert.match(html, /近 20 日/);
  assert.match(html, /策略健康度/);
  assert.match(html, /问题诊断（按影响程度排序）/);
  assert.match(html, /重复事件（已聚合）/);
  assert.match(html, /Shadow 不计入真实成交/);
  assert.match(html, /href="\/strategies"/);
  assert.match(html, /href="\/"/);
});

test("trade review keeps full evidence expandable and primary actions functional", () => {
  const html = tradeReviewHtml();

  assert.match(html, /id="diagnosisButton"/);
  assert.match(html, /id="evidenceButton"/);
  assert.match(html, /querySelectorAll\("#completeEvidence details"\)/);
  assert.match(html, /查看完整成交证据/);
  assert.match(html, /展开查看 .* 条原始事件/);
  assert.match(html, /groupFailures\(events\)/);
});
