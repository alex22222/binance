import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { repairTurtlePaperAccounting } from "../src/turtle-paper-repair.mjs";

function fixture() {
  const buy = { type: "PAPER_BUY_FILLED", at: "2026-10-05T13:35:00Z", symbol: "QQQ",
    price: 100, quantity: 0.5, notionalUsdt: 50, initialRiskPct: 4, evidenceLevel: "PAPER_CANDLE_PROXY" };
  const sell = { type: "PAPER_SELL_FILLED", at: "2026-10-14T15:40:00Z", symbol: "QQQ",
    strategyId: "daily-turtle-55-20", openedAt: buy.at, closedAt: "2026-10-14T15:40:00Z",
    entryPrice: 100, exitPrice: 95, quantity: 0.5, notionalUsdt: 250, grossPnlUsdt: -202.5,
    costUsdt: 2.1, pnlUsdt: -204.6, returnPct: -81.84, initialRiskPct: 4,
    peakNetReturnPct: 0.16, worstNetReturnPct: -5.84, reason: "TURTLE_2N_STOP", evidenceLevel: "PAPER_CANDLE_PROXY" };
  const { type, at, ...trade } = sell;
  return {
    state: { mode: "paper", strategyId: "daily-turtle-55-20", position: null, trades: [trade],
      realizedPnlUsdt: -204.6, totalCostUsdt: 2.1, updatedAt: "2026-10-16T21:55:00Z" },
    events: [buy,
      { type: "PAPER_POSITION_MARKED", at: "2026-10-05T13:40:00Z", symbol: "QQQ", price: 100, unrealizedPnlUsdt: -0.5 },
      { type: "PAPER_MARKET_CLOSED", at: "2026-10-10T13:00:00Z", sessionDate: "2026-10-10" },
      { type: "PAPER_POSITION_MARKED", at: "2026-10-12T13:35:00Z", symbol: "QQQ", price: 101, unrealizedPnlUsdt: 0.4 },
      sell]
  };
}

test("repairs fills, historical marks and aggregate totals from original entry evidence", () => {
  const input = fixture(), before = structuredClone(input);
  const result = repairTurtlePaperAccounting(input.state, input.events);
  assert.deepEqual(input, before);
  const trade = result.state.trades[0];
  assert.equal(trade.notionalUsdt, 50);
  assert.equal(trade.roundTripCostPct, 1);
  assert.equal(trade.grossPnlUsdt, -2.5);
  assert.equal(trade.costUsdt, 0.5);
  assert.equal(trade.pnlUsdt, -3);
  assert.equal(trade.returnPct, -6);
  assert.ok(Math.abs(trade.peakNetReturnPct) < 1e-9);
  assert.ok(Math.abs(trade.worstNetReturnPct + 6) < 1e-9);
  assert.ok(Math.abs(result.events[3].unrealizedPnlUsdt) < 1e-9);
  assert.equal(result.state.realizedPnlUsdt, -3);
  assert.equal(result.state.totalCostUsdt, 0.5);
  assert.equal(result.state.updatedAt, input.state.updatedAt);
  assert.equal(result.events.length, input.events.length);
  assert.deepEqual(result.events[2], input.events[2]);
  for (const field of ["symbol", "openedAt", "closedAt", "entryPrice", "exitPrice", "quantity", "reason", "initialRiskPct"]) {
    assert.equal(trade[field], input.state.trades[0][field]);
  }
  const { type, at, ...eventTrade } = result.events.at(-1);
  assert.deepEqual(eventTrade, trade);
  assert.equal(result.report.costSources[0].source, "FIRST_RECORDED_MARK");
});

test("a second repair is an exact no-op", () => {
  const input = fixture();
  const first = repairTurtlePaperAccounting(input.state, input.events);
  const second = repairTurtlePaperAccounting(first.state, first.events);
  assert.deepEqual(second.state, first.state);
  assert.deepEqual(second.events, first.events);
  assert.equal(second.report.changedEvents, 0);
  assert.equal(second.report.changedTrades, 0);
});

test("repairs an open legacy position and its peak/worst without changing decisions", () => {
  const input = fixture();
  input.events.pop();
  input.state.trades = [];
  input.state.realizedPnlUsdt = 0;
  input.state.totalCostUsdt = 0;
  input.state.position = { symbol: "QQQ", openedAt: input.events[0].at,
    entryPrice: 100, quantity: 0.5, notionalUsdt: 50, markPrice: 101,
    markedAt: input.events.at(-1).at, grossReturnPct: 1, netReturnPct: 0.16,
    unrealizedPnlUsdt: 0.4, peakNetReturnPct: 0.16, worstNetReturnPct: -1, initialRiskPct: 4 };
  const result = repairTurtlePaperAccounting(input.state, input.events);
  assert.equal(result.state.position.notionalUsdt, 50);
  assert.equal(result.state.position.roundTripCostPct, 1);
  assert.ok(Math.abs(result.state.position.unrealizedPnlUsdt) < 1e-9);
  assert.ok(Math.abs(result.state.position.peakNetReturnPct) < 1e-9);
  assert.equal(result.state.position.worstNetReturnPct, -1);
  assert.equal(result.state.lastEntryEvaluationDate, input.state.lastEntryEvaluationDate);
});

test("fails closed on missing buy evidence, ambiguous costs, or state/event disagreement", () => {
  const input = fixture();
  assert.throws(() => repairTurtlePaperAccounting(input.state, input.events.slice(1)), /entry/i);
  const noMarks = input.events.filter(e => e.type !== "PAPER_POSITION_MARKED");
  assert.throws(() => repairTurtlePaperAccounting(input.state, noMarks), /cost/i);
  input.state.trades[0].exitPrice = 94;
  assert.throws(() => repairTurtlePaperAccounting(input.state, input.events), /mismatch/i);
});

test("rejects duplicate fills, invalid prices and another strategy", () => {
  const input = fixture();
  assert.throws(() => repairTurtlePaperAccounting(input.state, [input.events[0], ...input.events]), /entry/i);
  input.events[0].price = 0;
  assert.throws(() => repairTurtlePaperAccounting(input.state, input.events), /entry/i);
  input.state.mode = "live";
  assert.throws(() => repairTurtlePaperAccounting(input.state, input.events), /identity/i);
});

test("uses an explicitly saved zero cost and supports trades with no intermediate mark", () => {
  const input = fixture();
  input.events[0].roundTripCostPct = 0;
  input.events = input.events.filter(e => e.type !== "PAPER_POSITION_MARKED");
  const result = repairTurtlePaperAccounting(input.state, input.events);
  assert.equal(result.state.trades[0].costUsdt, 0);
  assert.equal(result.state.trades[0].pnlUsdt, -2.5);
});

test("repair CLI defaults to dry run, pins hashes, preserves backups and is idempotent", async t => {
  const directory = await mkdtemp(join(tmpdir(), "turtle-repair-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = fixture();
  const originalState = `${JSON.stringify(input.state)}\n`;
  const originalEvents = input.events.map(event => `${JSON.stringify(event)}\n`).join("");
  const statePath = join(directory, "latest.json"), eventsPath = join(directory, "events.jsonl");
  await writeFile(statePath, originalState, { mode: 0o600 });
  await writeFile(eventsPath, originalEvents, { mode: 0o600 });
  const cli = resolve("scripts/repair-turtle-paper-accounting.mjs");
  const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath,
    [cli, "--directory", directory, ...args])).stdout);
  const preview = await run();
  assert.equal(preview.mode, "DRY_RUN");
  assert.equal(await readFile(statePath, "utf8"), originalState);
  assert.equal(await readFile(eventsPath, "utf8"), originalEvents);
  assert.deepEqual((await readdir(directory)).sort(), ["events.jsonl", "latest.json"]);
  await assert.rejects(() => run("--apply", "--expect-state-sha256", "wrong"), /hashes/);
  assert.equal(await readFile(statePath, "utf8"), originalState);
  const backup = join(directory, "backup");
  const applied = await run("--apply", "--expect-state-sha256", preview.inputHashes.state,
    "--expect-events-sha256", preview.inputHashes.events, "--backup-directory", backup);
  assert.equal(applied.after.realizedPnlUsdt, -3);
  assert.equal(await readFile(join(backup, "latest.json"), "utf8"), originalState);
  assert.equal(await readFile(join(backup, "events.jsonl"), "utf8"), originalEvents);
  assert.equal(JSON.parse(await readFile(join(backup, "repair-report.json"), "utf8")).status, "APPLIED");
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(eventsPath)).uid, (await stat(join(backup, "events.jsonl"))).uid);
  const bytes = await readFile(statePath, "utf8");
  assert.equal((await run()).changed, false);
  assert.equal((await run("--apply")).changed, false);
  assert.equal(await readFile(statePath, "utf8"), bytes);
});

test("repair CLI refuses a changed event file after preview before creating backups", async t => {
  const directory = await mkdtemp(join(tmpdir(), "turtle-repair-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = fixture();
  await writeFile(join(directory, "latest.json"), JSON.stringify(input.state));
  const events = input.events.map(event => JSON.stringify(event)).join("\n");
  await writeFile(join(directory, "events.jsonl"), events);
  const run = promisify(execFile), cli = resolve("scripts/repair-turtle-paper-accounting.mjs");
  const preview = JSON.parse((await run(process.execPath, [cli, "--directory", directory])).stdout);
  await writeFile(join(directory, "events.jsonl"), `${events}\n`);
  await assert.rejects(() => run(process.execPath, [cli, "--directory", directory, "--apply",
    "--expect-state-sha256", preview.inputHashes.state, "--expect-events-sha256", preview.inputHashes.events]), /hashes/);
  assert.deepEqual((await readdir(directory)).sort(), ["events.jsonl", "latest.json"]);
});
