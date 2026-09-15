import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTradingReviewRecords, buildTradingReview } from "../src/trade-review.mjs";

test("streams a trace and retains fill, Shadow, and failure evidence without scan payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-reader-"));
  const path = join(directory, "trace.jsonl");
  const at = "2026-09-11T15:00:00.000Z";
  const rows = [
    ...Array.from({ length: 2000 }, () => ({ timestamp: at, event: "market_scan", details: { unused: "x".repeat(1000) } })),
    { timestamp: at, event: "shadow_sub_strategy", status: "observed", cycleId: "buy", details: { symbol: "SPY", subStrategyId: "shadow-trend-pullback-confirmation", decision: "WOULD_WAIT" } },
    { timestamp: at, event: "buy_submission", status: "submitted", cycleId: "buy", details: { orderId: "1", symbol: "SPY", amountUsdt: 50 } },
    { timestamp: at, event: "pending_order", status: "finished", details: { side: "BUY", orderId: "1", symbol: "SPY" } },
    { timestamp: at, event: "pending_order", status: "finished", details: { side: "SELL", symbol: "SPY", realizedPnlUsdt: -1, grossPnlUsdt: -0.9, gasCostUsdt: 0.1 } },
    { timestamp: at, event: "wallet_cli", status: "failed", details: { error: "unavailable", operation: "quote", stdout: "unused".repeat(10000) } }
  ];
  await writeFile(path, `${rows.map(JSON.stringify).join("\n")}\nbroken\n`);
  const result = await readTradingReviewRecords(path);
  assert.equal(result.records.length, 5);
  assert.equal(result.malformedLines, 1);
  assert.equal(result.totalRecords, rows.length);
  assert.equal(result.records.at(-1).details.stdout, undefined);
  const actual = buildTradingReview({ records: result.records, state: {}, tradingDate: "2026-09-11" });
  const expected = buildTradingReview({ records: rows, state: {}, tradingDate: "2026-09-11" });
  assert.deepEqual(actual.daily, expected.daily);
  assert.deepEqual(actual.trades, expected.trades);
  assert.deepEqual(actual.systemFailures, expected.systemFailures);
});

test("does not turn a missing trace into a zero-trade day", async () => {
  await assert.rejects(readTradingReviewRecords("/nonexistent-manager-trace.jsonl"), { code: "ENOENT" });
});
