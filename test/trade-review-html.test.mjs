import assert from "node:assert/strict";
import test from "node:test";
import { tradeReviewHtml } from "../src/trade-review-html.mjs";

test("trade review page renders daily, periodic, trade and risk sections", () => {
  const html = tradeReviewHtml();

  assert.match(html, /id="reviewDate"/);
  assert.match(html, /id="dailyMetrics"/);
  assert.match(html, /id="periodComparison"/);
  assert.match(html, /id="premarketBrief"/);
  assert.match(html, /id="externalMarket"/);
  assert.match(html, /id="tradeRows"/);
  assert.match(html, /id="openRisk"/);
  assert.match(html, /\/api\/trade-reviews/);
  assert.match(html, /5 个交易日/);
  assert.match(html, /20 个交易日/);
  assert.match(html, /市场解释亏损/);
  assert.match(html, /盘前交易建议/);
  assert.match(html, /href="\/strategies"/);
  assert.match(html, /href="\/"/);
});
