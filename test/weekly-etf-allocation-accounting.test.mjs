import assert from "node:assert/strict";
import test from "node:test";
import { ledgerEntries, ledgerTrades } from "../src/trade-ledger.mjs";
import { buildTradingReview } from "../src/trade-review.mjs";

const ID = "weekly-etf-dual-momentum-defense";
const record = (timestamp, event, details) => ({ timestamp, event, status: event === "pending_order" ? "finished" : "submitted", details });
const records = [
  record("2026-10-12T13:31:00Z", "buy_submission", { symbol: "QQQ", strategyId: ID, orderId: "B1", amountUsdt: 50 }),
  record("2026-10-12T13:32:00Z", "pending_order", { side: "BUY", symbol: "QQQ", orderId: "B1", txHash: "tx1", gasUsdt: 0.02 }),
  record("2026-10-12T14:00:00Z", "buy_submission", { symbol: "QQQ", strategyId: ID, orderId: "B2", amountUsdt: 164, entryType: "TOP_UP", parentOrderId: "B1" }),
  record("2026-10-12T14:01:00Z", "pending_order", { side: "BUY", symbol: "QQQ", orderId: "B2", txHash: "tx2", gasUsdt: 0.03, entryType: "TOP_UP", parentOrderId: "B1", costBasisUsdt: 164 }),
  record("2026-10-12T15:00:00Z", "sell_submission", { symbol: "QQQ", strategyId: ID, orderId: "S1", reason: "WEEKLY_REBALANCE" }),
  record("2026-10-12T15:01:00Z", "pending_order", { side: "SELL", symbol: "QQQ", strategyId: ID, orderId: "S1", entryTxHash: "tx1", costBasisUsdt: 214, proceedsUsdt: 212, grossPnlUsdt: -2, gasCostUsdt: 0.09, realizedPnlUsdt: -2.09 })
];

test("top-up is one entry with combined cost and Gas, not a second round trip", () => {
  const entries = ledgerEntries(records);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].orderId, "B1");
  assert.equal(entries[0].amountUsdt, 214);
  assert.equal(entries[0].gasUsdt, 0.05);
  const [trade] = ledgerTrades(records);
  assert.equal(trade.costUsdt, 214);
  assert.equal(trade.entryAt, "2026-10-12T13:32:00Z");
  assert.equal(trade.returnPct, -2.09 / 214 * 100);
  const review = buildTradingReview({ records, state: { positions: [] }, tradingDate: "2026-10-12" });
  assert.equal(review.daily.entries, 1);
  assert.equal(review.trades[0].amountUsdt, 214);
  assert.equal(review.trades[0].openedAt, "2026-10-12T13:32:00Z");
});

test("a missing original entry is not fabricated from a top-up fill", () => {
  assert.equal(ledgerEntries(records.slice(2)).length, 0);
  const review = buildTradingReview({ records: records.slice(2), state: { positions: [] }, tradingDate: "2026-10-12" });
  assert.equal(review.daily.entries, 0);
  assert.equal(review.trades[0].openedAt, null);
  assert.equal(review.trades[0].amountUsdt, 214);
});

test("a re-recorded top-up terminal fill does not add its cost or Gas twice", () => {
  const replay = { ...records[3], timestamp: "2026-10-12T14:02:00Z" };
  const repeated = [...records.slice(0, 4), replay, ...records.slice(4)];
  assert.equal(ledgerEntries(repeated)[0].amountUsdt, 214);
  assert.equal(ledgerEntries(repeated)[0].gasUsdt, 0.05);
  const withoutSellCost = repeated.map(record => { const copy = structuredClone(record); if (copy.details.side === "SELL") delete copy.details.costBasisUsdt; return copy; });
  const review = buildTradingReview({ records: withoutSellCost, state: { positions: [] }, tradingDate: "2026-10-12" });
  assert.equal(review.daily.entries, 1);
  assert.equal(review.trades[0].amountUsdt, 214);
});
