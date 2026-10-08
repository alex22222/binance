import assert from "node:assert/strict";
import test from "node:test";
import { emptyTradeLedger, ingestTraceLine } from "../src/trade-ledger.mjs";
import { buildReviewOverview } from "../src/trade-review-overview.mjs";

const NOW = Date.parse("2026-10-09T03:00:00Z");
let sequence = 0;
function ledgerOf(lines) {
  const ledger = emptyTradeLedger(1);
  for (const [timestamp, event, status, details] of lines) ingestTraceLine(ledger, JSON.stringify({ timestamp, runId: "r", sequence: sequence += 1, event, status, details }));
  ledger.records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return ledger;
}
const ledger = ledgerOf([
  ["2026-07-27T16:36:53Z", "buy_submission", "submitted", { symbol: "CRCL", strategyId: "adaptive-momentum", amountUsdt: 50, orderId: "B1" }],
  ["2026-07-27T16:37:58Z", "pending_order", "finished", { orderId: "B1", side: "BUY", symbol: "CRCL", txHash: "0xb1", gasUsdt: 0.02 }],
  ["2026-07-27T22:05:00Z", "pending_order", "halted", { intentId: "I9", reason: "NO_MATCHING_ORDER" }],
  ["2026-07-28T02:59:46Z", "sell_submission", "submitted", { symbol: "CRCL", strategyId: "adaptive-momentum", reason: "INITIAL_STOP", orderId: "S1" }],
  ["2026-07-28T03:00:51Z", "pending_order", "finished", { orderId: "S1", side: "SELL", symbol: "CRCL", strategyId: "adaptive-momentum", proceedsUsdt: 48.7, grossPnlUsdt: -1.3, gasCostUsdt: 0.03, realizedPnlUsdt: -1.33, entryTxHash: "0xb1", exitGasUsdt: 0.014 }],
  ["2026-09-17T17:00:00Z", "buy_submission", "submitted", { symbol: "SPY", strategyId: "weekly-etf-dual-momentum-defense", amountUsdt: 50, orderId: "F1" }],
  ["2026-09-17T17:09:51Z", "pending_order", "failed", { orderId: "F1", side: "BUY" }],
  ["2026-09-21T13:30:08Z", "weekly_etf_live_decision", "succeeded", { week: "2026-09-21", signalDate: "2026-09-18", target: "QQQ", candidateCount: 2, defensiveEligible: true }],
  ["2026-09-21T13:32:33Z", "buy_submission", "submitted", { symbol: "QQQ", strategyId: "weekly-etf-dual-momentum-defense", amountUsdt: 50, orderId: "B2" }],
  ["2026-09-21T13:33:39Z", "pending_order", "finished", { orderId: "B2", side: "BUY", symbol: "QQQ", txHash: "0xb2", gasUsdt: 0.03 }],
  ["2026-09-21T13:32:20Z", "trade_approval", "auto_approved", { approvalId: "a", side: "BUY", symbol: "QQQ" }],
  ["2026-10-02T03:22:00Z", "position_monitoring", "failed", { symbol: "QQQ", error: "DNS_RESOLVE_FAILED: Host not found" }],
  ["2026-10-04T01:00:00Z", "position_monitoring", "failed", { symbol: "QQQ", error: "SERVICE_ERROR: Token QQQon currently has no available liquidity." }],
  ["2026-10-04T02:00:00Z", "position_monitoring", "failed", { symbol: "QQQ", error: "SERVICE_ERROR: Token QQQon currently has no available liquidity." }],
  ["2026-10-05T13:31:20Z", "weekly_etf_live_decision", "succeeded", { week: "2026-10-05", signalDate: "2026-10-02", target: "QQQ", candidateCount: 1, defensiveEligible: true }]
]);
const botState = {
  positions: [{ symbol: "QQQ", strategyId: "weekly-etf-dual-momentum-defense", costBasisUsdt: 50, lastQuoteProceedsUsdt: 51.5, lastQuoteAt: "2026-10-09T02:59:00Z", openedAt: "2026-09-21T13:32:31Z", peakReturnPct: 4.53, worstReturnPct: -0.18, finalTakeProfitPct: 2, initialRiskPct: 1 }],
  walletBalance: { totalUsd: 446, availableUsdt: 394, checkedAt: "2026-10-09T02:00:00Z" },
  weeklyEtfLive: {
    strategyId: "weekly-etf-dual-momentum-defense", week: "2026-10-05", evaluatedAt: "2026-10-05T13:31:20Z",
    decision: {
      signalDate: "2026-10-02", target: "QQQ", absoluteMomentumRequired: true,
      allRiskAssets: [
        { ticker: "VTI", momentumPct: -0.52, rsi: 54, eligible: false },
        { ticker: "QQQ", momentumPct: 4.56, rsi: 65.6, eligible: true }
      ],
      defensiveAsset: { ticker: "SGOV", momentumPct: 0.31, eligible: true }
    }
  }
};
const walletHistory = [
  { date: "2026-07-27", totalUsd: 450 }, { date: "2026-09-05", totalUsd: 444 },
  { date: "2026-09-20", totalUsd: 446 }, { date: "2026-09-30", totalUsd: 443 }, { date: "2026-10-08", totalUsd: 445 }
];
const premarket = { status: "AVAILABLE", tradingDate: "2026-10-08", generatedAt: "2026-10-08T13:15:00Z", advice: { level: "SELECTIVE_LONG", summary: "选择性做多" }, market: { benchmarkAveragePct: -0.48, breadthPositivePct: 39.13, vixChangePct: 3.85 }, errors: ["fetch failed"] };
const build = (period) => buildReviewOverview({ ledger, botState, walletHistory, premarket, disasterStopLossPct: 8, nowMs: NOW, period });

test("a 30-day review covers the account, the open position, this week's decision, and real execution problems", () => {
  const review = build("30d");
  assert.deepEqual([review.period.id, review.period.label, review.period.from], ["30d", "近 30 天", "2026-09-09T03:00:00.000Z"]);
  assert.deepEqual([review.account.start, review.account.end], [{ date: "2026-09-05", totalUsd: 444 }, { date: "2026-10-09", totalUsd: 446 }]);
  assert.deepEqual([review.account.changeUsd, review.account.changePct, review.account.maxDrawdownPct, review.account.sinceStart], [2, 0.45, 0.67, { date: "2026-07-27", changePct: -0.89 }]);
  const [position] = review.positions;
  assert.deepEqual([position.daysHeld, position.unrealizedPnlUsdt, position.returnPct, position.strategyName], [17, 1.5, 3, "周频 ETF 双动量防守轮动"]);
  assert.match(position.exitRule, /目标换成别的 ETF 就换仓.*跌幅超过 8% 时灾难止损/);
  assert.doesNotMatch(position.exitRule, /止盈/, "the weekly strategy has no fixed take-profit");
  assert.deepEqual(review.decision.latest.assets.map(({ ticker }) => ticker), ["QQQ", "VTI"]);
  assert.deepEqual([review.decision.nextEvaluation, review.decision.history.map(({ week }) => week)], ["2026-10-12", ["2026-10-05", "2026-09-21"]]);
  assert.deepEqual([review.trades.length, review.entries.map(({ symbol, strategyId }) => [symbol, strategyId])], [0, [["QQQ", "weekly-etf-dual-momentum-defense"]]]);
  assert.deepEqual(review.execution.incidents.map(({ kind, symbol }) => [kind, symbol]), [["持仓估值失败", "QQQ"], ["订单失败", "SPY"]]);
  assert.deepEqual([review.execution.closedMarketQuotes, review.execution.closedMarketDays, review.execution.fills, review.execution.autoApproved, review.execution.gasUsdt], [2, 1, 1, 1, 0.03]);
  assert.deepEqual(review.findings.map(({ tone }) => tone), ["good", "good", "neutral", "neutral", "bad", "bad"]);
  assert.match(review.findings[0].text, /^账户净值 446\.00 U。近 30 天变化 \+2\.00 U（\+0\.45%），期间最大回撤 0\.67%；自 2026-07-27 起累计 -0\.89%。$/);
  assert.match(review.findings[2].text, /2026-10-05 这周的信号是 QQQ：在 2 只 ETF 里动量最高（\+4\.6%，RSI 65\.6），继续持有。下次评估约在 2026-10-12/);
  assert.equal(review.findings[3].text, "近 30 天没有完成的交易。");
  assert.match(review.findings[4].text, /^更早的记录里，自适应动量在 2026-07-28 至 2026-07-28 完成 1 笔，已实现 -1\.33 U，胜率 0%，盈利因子 0，1 笔以初始止损结束。$/);
  assert.match(review.findings[5].text, /持仓估值失败 1 次、订单失败 1 次.*另有 2 次持仓估值失败发生在美股休市时/);
  assert.deepEqual([review.premarket.level, review.premarket.errors], ["SELECTIVE_LONG", 1]);
});

test("the full history lists every round trip with its exit reason", () => {
  const review = build("all");
  assert.deepEqual(review.trades.map(({ symbol, strategyName, exitReasonLabel, costUsdt, realizedPnlUsdt }) => [symbol, strategyName, exitReasonLabel, costUsdt, realizedPnlUsdt]),
    [["CRCL", "自适应动量", "初始止损", 50, -1.33]]);
  assert.deepEqual(review.strategies.all.map(({ name, trades, wins, losses, realizedPnlUsdt, exitReasons }) => [name, trades, wins, losses, realizedPnlUsdt, exitReasons]),
    [["自适应动量", 1, 0, 1, -1.33, { 初始止损: 1 }]]);
  assert.match(review.findings[0].text, /^账户净值 446\.00 U。自 2026-07-27 起 -4\.00 U（-0\.89%）/);
  assert.ok(review.findings.some(({ text }) => text.startsWith("全部记录里，自适应动量")));
  assert.ok(review.execution.incidents.some(({ kind, detail }) => kind === "订单核对卡住" && /NO_MATCHING_ORDER.*共重试 1 次/.test(detail)));
  assert.deepEqual([review.execution.gasUsdt, review.execution.fills], [0.064, 3]);
});

test("other strategies show their own stops, and an unknown period falls back to 30 days", () => {
  const review = buildReviewOverview({
    ledger: emptyTradeLedger(),
    botState: { positions: [{ symbol: "NVDA", strategyId: "adaptive-momentum", costBasisUsdt: 50, lastQuoteProceedsUsdt: 49, openedAt: "2026-10-08T15:00:00Z", initialRiskPct: 2.3, finalTakeProfitPct: 4.6 }] },
    nowMs: NOW,
    period: "90d"
  });
  assert.equal(review.period.id, "30d");
  assert.equal(review.positions[0].exitRule, "初始止损 -2.3% · 止盈 +4.6%");
  assert.deepEqual([review.account, review.decision, review.premarket], [null, null, null]);
  assert.equal(review.findings[0].tone, "bad");
});
