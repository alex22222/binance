import { open, readFile, rename, stat, writeFile } from "node:fs/promises";

// Durable index of the trading records in state/action-trace.jsonl. The trace
// keeps every record since launch but grows by hundreds of MB, so pages cannot
// read it per request (the 8 MB tail they used covers about a day). The ledger
// keeps only what reviews need, and each update reads just the bytes appended
// since the previous one. A replaced or truncated trace is re-read in full.

export const TRADE_LEDGER_VERSION = 1;

const KEPT = new Set([
  "pending_order/finished", "pending_order/failed",
  "buy_submission/submitted", "buy_submission/simulated",
  "sell_submission/submitted", "sell_submission/simulated",
  "exit_decision/allowed",
  "weekly_etf_live_decision/succeeded",
  "order_submission/ambiguous", "order_recovery/halted", "pending_order_review/resolved",
  "trade_approval/approved", "trade_approval/auto_approved", "trade_approval/invalidated",
  "auto_approval/enabled", "auto_approval/disabled"
]);
// Repeated by design, so only counted: a halted order is retried every cycle
// until resolved, and quotes fail whenever the tokenized market is closed.
const COUNTED = new Set(["pending_order/halted", "position_monitoring/failed"]);
const CANDIDATE = /"event":"(pending_order|buy_submission|sell_submission|exit_decision|weekly_etf_live_decision|order_submission|order_recovery|pending_order_review|trade_approval|auto_approval|position_monitoring)"/;

export function emptyTradeLedger(inode = null) {
  return { version: TRADE_LEDGER_VERSION, inode, offset: 0, firstAt: null, lastAt: null, updatedAt: null, records: [], halted: {}, monitoring: {} };
}

export function monitoringKind(error) {
  return /no available liquidity/i.test(String(error)) ? "NO_LIQUIDITY" : "OTHER";
}

function count(bucket, key, timestamp, extra = {}) {
  const entry = bucket[key] || { count: 0, firstAt: timestamp, lastAt: timestamp, ...extra };
  entry.count += 1;
  if (timestamp < entry.firstAt) entry.firstAt = timestamp;
  if (timestamp > entry.lastAt) entry.lastAt = timestamp;
  bucket[key] = entry;
}

// Adds one trace line to the ledger; returns false for lines it does not keep.
export function ingestTraceLine(ledger, line, seen = null) {
  if (!CANDIDATE.test(line)) return false;
  let record;
  try { record = JSON.parse(line); } catch { return false; }
  const kind = `${record.event}/${record.status}`;
  const ms = Date.parse(record.timestamp);
  if (!Number.isFinite(ms)) return false;
  const timestamp = new Date(ms).toISOString();
  if (!ledger.firstAt || timestamp < ledger.firstAt) ledger.firstAt = timestamp;
  if (!ledger.lastAt || timestamp > ledger.lastAt) ledger.lastAt = timestamp;
  const details = record.details || {};
  if (kind === "pending_order/halted") {
    count(ledger.halted, details.intentId || details.orderId || "unknown", timestamp, { reason: details.reason || null });
    return true;
  }
  if (kind === "position_monitoring/failed") {
    const kindOf = monitoringKind(details.error);
    count(ledger.monitoring, `${timestamp.slice(0, 10)}|${details.symbol || "?"}|${kindOf}`, timestamp,
      kindOf === "OTHER" ? { error: String(details.error || "").slice(0, 160) } : {});
    return true;
  }
  if (!KEPT.has(kind)) return false;
  const key = `${timestamp}|${record.runId || ""}|${record.sequence ?? ""}|${kind}`;
  if (seen?.has(key)) return false;
  seen?.add(key);
  ledger.records.push({ key, timestamp, event: record.event, status: record.status, details });
  return true;
}

async function readLedger(path) {
  try {
    const ledger = JSON.parse(await readFile(path, "utf8"));
    return ledger.version === TRADE_LEDGER_VERSION ? ledger : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

// Reads the trace from the stored offset to its last complete line.
export async function updateTradeLedger({ tracePath, ledgerPath, nowMs = Date.now(), chunkBytes = 4 << 20 }) {
  const info = await stat(tracePath);
  let ledger = await readLedger(ledgerPath);
  if (!ledger || ledger.inode !== info.ino || info.size < ledger.offset) ledger = emptyTradeLedger(info.ino);
  if (info.size === ledger.offset) return ledger;
  const seen = new Set(ledger.records.map(({ key }) => key));
  const handle = await open(tracePath, "r");
  let position = ledger.offset;
  let carry = Buffer.alloc(0);
  try {
    while (position < info.size) {
      const { bytesRead, buffer } = await handle.read({ buffer: Buffer.alloc(Math.min(chunkBytes, info.size - position)), position });
      if (!bytesRead) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let start = 0;
      for (let newline = data.indexOf(10, start); newline >= 0; newline = data.indexOf(10, start)) {
        if (newline > start) ingestTraceLine(ledger, data.toString("utf8", start, newline), seen);
        start = newline + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
  } finally {
    await handle.close();
  }
  ledger.offset = position - carry.length;
  ledger.updatedAt = new Date(nowMs).toISOString();
  ledger.records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  await writeFile(`${ledgerPath}.tmp`, JSON.stringify(ledger), { mode: 0o600 });
  await rename(`${ledgerPath}.tmp`, ledgerPath);
  return ledger;
}

// One update at a time per ledger file within this process.
const pending = new Map();
export function refreshTradeLedger(options) {
  const running = pending.get(options.ledgerPath);
  if (running) return running;
  const update = updateTradeLedger(options).finally(() => pending.delete(options.ledgerPath));
  pending.set(options.ledgerPath, update);
  return update;
}

const number = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

// Completed live round trips: each sell fill paired with its buy fill through
// the entry transaction hash, its strategy from the sell (or the buy order's
// submission), and its exit reason from the sell submission.
export function ledgerTrades(records) {
  const submissions = new Map();
  const exitReasons = new Map();
  const buys = new Map();
  const sells = new Map();
  for (const record of records) {
    const { details } = record;
    if (record.event === "buy_submission" && record.status === "submitted" && details.orderId) submissions.set(details.orderId, details);
    if (record.event === "sell_submission" && record.status === "submitted" && details.orderId) exitReasons.set(details.orderId, details.reason || null);
    if (record.event !== "pending_order" || record.status !== "finished") continue;
    if (details.side === "BUY" && details.txHash) buys.set(details.txHash, { ...details, timestamp: record.timestamp });
    if (details.side === "SELL" && details.orderId && !sells.has(details.orderId)) sells.set(details.orderId, { ...details, timestamp: record.timestamp });
  }
  return [...sells.values()].map((sell) => {
    const buy = buys.get(sell.entryTxHash) || null;
    const submission = buy ? submissions.get(buy.orderId) : null;
    const proceeds = number(sell.proceedsUsdt);
    const gross = number(sell.grossPnlUsdt);
    const cost = number(sell.costBasisUsdt) ?? number(submission?.amountUsdt) ?? (proceeds !== null && gross !== null ? proceeds - gross : null);
    return {
      symbol: sell.symbol,
      strategyId: sell.strategyId || submission?.strategyId || null,
      orderId: sell.orderId,
      entryAt: buy?.timestamp || null,
      exitAt: sell.timestamp,
      costUsdt: cost,
      proceedsUsdt: proceeds,
      grossPnlUsdt: gross,
      gasUsdt: number(sell.gasCostUsdt),
      realizedPnlUsdt: number(sell.realizedPnlUsdt),
      returnPct: cost && number(sell.realizedPnlUsdt) !== null ? (number(sell.realizedPnlUsdt) / cost) * 100 : null,
      holdingHours: buy ? (Date.parse(sell.timestamp) - Date.parse(buy.timestamp)) / 3_600_000 : null,
      exitReason: exitReasons.get(sell.orderId) || null
    };
  }).sort((left, right) => left.exitAt.localeCompare(right.exitAt));
}

// Buy fills by order id with their strategy, for positions still open.
export function ledgerEntries(records) {
  const strategies = new Map(records
    .filter((record) => record.event === "buy_submission" && record.status === "submitted" && record.details.orderId)
    .map((record) => [record.details.orderId, record.details]));
  const entries = new Map();
  const topUpOrders = new Set();
  for (const record of records) {
    if (record.event !== "pending_order" || record.status !== "finished" || record.details.side !== "BUY") continue;
    const fill = record.details, submission = strategies.get(fill.orderId);
    if ((fill.entryType || submission?.entryType) === "TOP_UP") {
      if (!fill.orderId || topUpOrders.has(fill.orderId)) continue;
      topUpOrders.add(fill.orderId);
      const parent = entries.get(fill.parentOrderId || submission?.parentOrderId);
      if (parent) {
        const amount = number(fill.costBasisUsdt) ?? number(submission?.amountUsdt);
        parent.amountUsdt = parent.amountUsdt == null || amount == null ? null : parent.amountUsdt + amount;
        const gas = number(fill.gasUsdt);
        parent.gasUsdt = parent.gasUsdt == null || gas == null ? null : parent.gasUsdt + gas;
      }
      continue;
    }
    entries.set(fill.orderId, { orderId: fill.orderId, symbol: fill.symbol, timestamp: record.timestamp,
      strategyId: submission?.strategyId || fill.strategyId || null,
      amountUsdt: number(submission?.amountUsdt), gasUsdt: number(fill.gasUsdt) });
  }
  return [...entries.values()];
}
