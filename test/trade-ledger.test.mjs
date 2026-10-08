import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ledgerEntries, ledgerTrades, monitoringKind, updateTradeLedger } from "../src/trade-ledger.mjs";

let sequence = 0;
const line = (timestamp, event, status, details) => `${JSON.stringify({ timestamp, runId: "run", sequence: sequence += 1, event, status, details })}\n`;
const roundTrip = [
  line("2026-07-27T16:36:53.000Z", "buy_submission", "submitted", { symbol: "CRCL", strategyId: "adaptive-momentum", amountUsdt: 50, orderId: "B1" }),
  line("2026-07-27T16:37:58.000Z", "pending_order", "finished", { orderId: "B1", side: "BUY", symbol: "CRCL", quantity: 0.4, txHash: "0xbuy", gasUsdt: 0.015 }),
  line("2026-07-27T17:00:00.000Z", "entry_decision", "skipped", { symbol: "TSLA" }),
  line("2026-07-27T22:00:00.000Z", "position_monitoring", "failed", { symbol: "CRCL", error: "SERVICE_ERROR: Token CRCLon currently has no available liquidity. Please trade during stock market opening hours." }),
  line("2026-07-27T22:05:00.000Z", "pending_order", "halted", { intentId: "I9", reason: "NO_MATCHING_ORDER" }),
  line("2026-07-27T22:06:00.000Z", "pending_order", "halted", { intentId: "I9", reason: "NO_MATCHING_ORDER" }),
  line("2026-07-28T02:59:46.000Z", "sell_submission", "submitted", { symbol: "CRCL", strategyId: "adaptive-momentum", reason: "INITIAL_STOP", orderId: "S1" }),
  line("2026-07-28T03:00:51.000Z", "pending_order", "finished", {
    orderId: "S1", side: "SELL", symbol: "CRCL", strategyId: "adaptive-momentum", proceedsUsdt: 48.7, grossPnlUsdt: -1.3,
    gasCostUsdt: 0.03, realizedPnlUsdt: -1.33, entryTxHash: "0xbuy", exitTxHash: "0xsell"
  })
];

test("indexes only trading records and counts repeated ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trade-ledger-"));
  const tracePath = join(directory, "trace.jsonl");
  const ledgerPath = join(directory, "ledger.json");
  await writeFile(tracePath, roundTrip.join(""));
  const ledger = await updateTradeLedger({ tracePath, ledgerPath, chunkBytes: 64 });
  assert.deepEqual(ledger.records.map(({ event, status }) => `${event}/${status}`), [
    "buy_submission/submitted", "pending_order/finished", "sell_submission/submitted", "pending_order/finished"
  ]);
  assert.deepEqual(ledger.halted.I9, { count: 2, firstAt: "2026-07-27T22:05:00.000Z", lastAt: "2026-07-27T22:06:00.000Z", reason: "NO_MATCHING_ORDER" });
  assert.equal(ledger.monitoring["2026-07-27|CRCL|NO_LIQUIDITY"].count, 1);
  assert.equal(ledger.offset, Buffer.byteLength(roundTrip.join("")));
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")).records.length, 4);
  assert.equal(monitoringKind("SERVICE_ERROR: wallet session expired"), "OTHER");
});

test("reads only appended complete lines and rebuilds after the trace is replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trade-ledger-append-"));
  const tracePath = join(directory, "trace.jsonl");
  const ledgerPath = join(directory, "ledger.json");
  await writeFile(tracePath, roundTrip.slice(0, 2).join(""));
  const first = await updateTradeLedger({ tracePath, ledgerPath });
  assert.equal(first.records.length, 2);
  const partial = roundTrip.slice(2).join("");
  await appendFile(tracePath, partial.slice(0, -40));
  const second = await updateTradeLedger({ tracePath, ledgerPath });
  assert.equal(second.records.length, 3, "the unfinished last line waits for the next update");
  await appendFile(tracePath, partial.slice(-40));
  const third = await updateTradeLedger({ tracePath, ledgerPath });
  assert.equal(third.records.length, 4);
  assert.equal(third.halted.I9.count, 2, "no line is counted twice across updates");
  assert.equal((await updateTradeLedger({ tracePath, ledgerPath })).records.length, 4);

  await rm(tracePath);
  await writeFile(tracePath, roundTrip.slice(0, 2).join(""));
  const rebuilt = await updateTradeLedger({ tracePath, ledgerPath });
  assert.equal(rebuilt.records.length, 2, "a new trace file starts a new ledger");
});

test("pairs each sell with its buy for strategy, cost, holding time, and exit reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trade-ledger-trips-"));
  const tracePath = join(directory, "trace.jsonl");
  const open = line("2026-09-21T13:32:33.000Z", "buy_submission", "submitted", { symbol: "QQQ", strategyId: "weekly-etf-dual-momentum-defense", amountUsdt: 50, orderId: "B2" });
  const filled = line("2026-09-21T13:33:39.000Z", "pending_order", "finished", { orderId: "B2", side: "BUY", symbol: "QQQ", txHash: "0xqqq", gasUsdt: 0.02 });
  await writeFile(tracePath, [...roundTrip, roundTrip.at(-1), open, filled].join(""));
  const { records } = await updateTradeLedger({ tracePath, ledgerPath: join(directory, "ledger.json") });
  const [trade, ...others] = ledgerTrades(records);
  assert.equal(others.length, 0, "a repeated fill record is one trade");
  assert.deepEqual({ ...trade, holdingHours: Math.round(trade.holdingHours * 100) / 100, returnPct: Math.round(trade.returnPct * 100) / 100 }, {
    symbol: "CRCL", strategyId: "adaptive-momentum", orderId: "S1", entryAt: "2026-07-27T16:37:58.000Z", exitAt: "2026-07-28T03:00:51.000Z",
    costUsdt: 50, proceedsUsdt: 48.7, grossPnlUsdt: -1.3, gasUsdt: 0.03, realizedPnlUsdt: -1.33, returnPct: -2.66, holdingHours: 10.38, exitReason: "INITIAL_STOP"
  });
  assert.deepEqual(ledgerEntries(records).map(({ symbol, strategyId, amountUsdt }) => [symbol, strategyId, amountUsdt]), [
    ["CRCL", "adaptive-momentum", 50], ["QQQ", "weekly-etf-dual-momentum-defense", 50]
  ]);
});
