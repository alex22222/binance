import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStrategyDaily, saveStrategyDaily, readStrategyDaily } from "../src/strategy-daily.mjs";
import { recordStrategyDaily } from "../scripts/record-strategy-daily.mjs";
import { initialFrequencyPaper } from "../src/etf-frequency-paper.mjs";

const at = "2026-11-10T23:35:00.000Z";
function research() {
  return { generatedAt: at, trace: { status: "AVAILABLE" }, positionsStatus: "AVAILABLE",
    strategies: [{ id: "a", name: "策略 A", status: "RESEARCH", active: false,
      performance: { trades: 0, realizedPnlUsdt: null, excludedRecords: 0, conflictingOrders: 0 }, openPositions: [] },
    { id: "b", name: "策略 B", status: "SHADOW", active: false,
      performance: { trades: 0 }, openPositions: [] }],
    paper: { a: { status: "AVAILABLE", sourceHash: "a".repeat(64), startedAt: "2026-10-01", updatedAt: at,
      initialCapitalUsdt: 50, realizedPnlUsdt: 0, closedTrades: 0, totalCostUsdt: 0.1,
      liquidationEquityUsdt: 51, liquidationReturnPct: 2, estimatedExitCostUsdt: 0.1,
      costModel: "BUY_BUDGET_SELL_PROCEEDS_PERCENT", position: { symbol: "QQQ", markedAt: at } } },
    validation: { status: "MISSING" }, shadow: { status: "MISSING" }, frequencyPaper: { status: "MISSING" } };
}

test("every catalog strategy gets a Beijing-dated record; missing evidence is never a zero score", () => {
  const snapshot = buildStrategyDaily(research());
  assert.equal(snapshot.date, "2026-11-11");
  assert.equal(snapshot.timeZone, "Asia/Shanghai");
  assert.equal(snapshot.strategies.length, 2);
  const missing = snapshot.strategies[1];
  assert.equal(missing.sources.paper.score.total, null);
  assert.equal(missing.sources.live.score.total, null);
  assert.equal(missing.sources.paper.status, "MISSING");
  assert.equal(snapshot.strategies[0].sources.paper.score.total, 75);
  assert.equal(snapshot.strategies[0].sources.paper.daily.netPnlUsdt, null);
  assert.equal(snapshot.automaticTradingEligible, false);
});

test("daily Paper deltas use consecutive snapshots and never mix Live, gaps, or changed series", () => {
  const prior = buildStrategyDaily(research());
  const next = research(); next.generatedAt = "2026-11-11T23:35:00Z";
  next.paper.a.position.markedAt = next.generatedAt;
  next.paper.a.updatedAt = next.generatedAt; next.paper.a.liquidationEquityUsdt = 52;
  let record = buildStrategyDaily(next, prior).strategies[0];
  assert.equal(record.sources.paper.daily.netPnlUsdt, 1);
  assert.ok(Math.abs(record.sources.paper.daily.returnPct - 100 / 51) < 1e-10);
  assert.equal(record.sources.live.daily.netPnlUsdt, null);
  next.paper.a.startedAt = "2026-11-01";
  assert.equal(buildStrategyDaily(next, prior).strategies[0].sources.paper.daily.reason, "SERIES_CHANGED");
  next.generatedAt = "2026-11-13T23:35:00Z";
  assert.equal(buildStrategyDaily(next, prior).strategies[0].sources.paper.daily.reason, "NO_CONSECUTIVE_BASELINE");
});

test("freshly rewritten reports cannot launder stale or future price marks into a score", () => {
  const input = research(); input.paper.a.position.markedAt = "2026-10-01T00:00:00Z";
  let row = buildStrategyDaily(input).strategies[0].sources.paper;
  assert.equal(row.status, "STALE"); assert.equal(row.score.total, null);
  input.paper.a.position.markedAt = "2026-11-12T00:00:00Z";
  row = buildStrategyDaily(input).strategies[0].sources.paper;
  assert.equal(row.status, "FUTURE_DATA"); assert.equal(row.score.total, null);
});

test("opening or closing Paper positions is not a series reset, but collection failures withhold scores", () => {
  const priorInput = research(); const prior = buildStrategyDaily(priorInput);
  const input = research(); input.generatedAt = "2026-11-11T23:35:00Z";
  input.paper.a.updatedAt = input.generatedAt;
  input.paper.a.position = null; input.paper.a.costModel = null;
  input.paper.a.closedTrades = 1;
  input.paper.a.liquidationEquityUsdt = 52;
  let row = buildStrategyDaily(input, prior).strategies[0].sources.paper;
  assert.equal(row.daily.netPnlUsdt, 1);
  input.paper.a.collectionStatus = "DATA_QUALITY_BLOCKED";
  row = buildStrategyDaily(input, prior).strategies[0].sources.paper;
  assert.equal(row.status, "ERROR"); assert.equal(row.score.total, null);
});

test("missing current equity never coerces to a -100% return; malformed fees never earn cost points", () => {
  const prior = buildStrategyDaily(research());
  const input = research(); input.generatedAt = "2026-11-11T23:35:00Z";
  input.paper.a.position.markedAt = input.generatedAt;
  input.paper.a.liquidationEquityUsdt = null; input.paper.a.hypotheticalExitNetPnlUsdt = 2;
  let value = buildStrategyDaily(input, prior).strategies[0].sources.paper;
  assert.equal(value.daily.netPnlUsdt, 1);
  assert.equal(value.daily.returnPct, null);
  input.paper.a.totalCostUsdt = "bad";
  value = buildStrategyDaily(input, prior).strategies[0].sources.paper;
  assert.equal(value.score.components.costs.points, 0);
});

test("source corruption, unknown positions and unpriced positions withhold Live scores", () => {
  const input = research(); Object.assign(input.strategies[0].performance,
    { trades: 2, realizedPnlUsdt: -1, period: { to: at }, conflictingOrders: 1 });
  assert.equal(buildStrategyDaily(input).strategies[0].sources.live.score.total, null);
  input.strategies[0].performance.conflictingOrders = 0;
  input.positionsStatus = "ERROR";
  assert.equal(buildStrategyDaily(input).strategies[0].sources.live.status, "INCOMPLETE");
});

test("each Live price mark must be current; a recent mark cannot mask a future or stale companion", () => {
  for (const markedAt of ["2026-11-12T00:00:00Z", "2026-11-01T00:00:00Z", "invalid"]) {
    const input = research();
    input.strategies[0].openPositions = [{ markedAt: at, unrealizedPnlUsdt: 1 }, { markedAt, unrealizedPnlUsdt: 10 }];
    const row = buildStrategyDaily(input).strategies[0].sources.live;
    assert.equal(row.status, "INCOMPLETE");
    assert.equal(row.score.total, null);
    assert.equal(row.metrics.unrealizedPnlUsdt, null);
  }
});

test("initialized or not-yet-eligible Paper experiments are recorded as not started, never 75-point zero returns", () => {
  const input = research();
  input.paper.a.position = null;
  input.frequencyPaper = { ...initialFrequencyPaper(at), status: "AVAILABLE", sourceHash: "b".repeat(64) };
  const report = buildStrategyDaily(input);
  assert.equal(report.strategies.length, 29);
  const sources = [report.strategies[0], ...report.strategies.filter(s => s.parentStrategyId)].map(s => s.sources.paper);
  for (const s of sources) {
    assert.equal(s.status, "NOT_STARTED");
    assert.equal(s.score.total, null);
    assert.equal(s.metrics.cumulativeNetPnlUsdt, null);
  }
});

test("Shadow windows are not summed; historical backtests never become daily trading PnL", () => {
  const input = research();
  input.shadow = { status: "AVAILABLE", sourceHash: "b".repeat(64), generatedAt: at, dataCutoff: at,
    horizons: [15, 30].map(horizonMinutes => ({ horizonMinutes, strategyCohorts: { b: { samples: 10, averageNetReturnPct: 1 } } })) };
  const row = buildStrategyDaily(input).strategies[1].sources.shadow;
  assert.equal(row.metrics.samples, 10);
  assert.equal(row.metrics.cumulativeNetPnlUsdt, null);
  assert.equal(row.score.components.costs.points, 0);
});

test("a regressed cumulative ledger is not recorded as a trading loss", () => {
  const input = research(); input.paper.a.closedTrades = 20;
  input.paper.a.liquidationEquityUsdt = 70;
  const prior = buildStrategyDaily(input);
  input.generatedAt = "2026-11-11T23:35:00Z";
  input.paper.a.position.markedAt = input.generatedAt;
  input.paper.a.closedTrades = 1; input.paper.a.liquidationEquityUsdt = 51;
  const value = buildStrategyDaily(input, prior).strategies[0].sources.paper;
  assert.equal(value.daily.reason, "LEDGER_REGRESSED");
  assert.equal(value.daily.netPnlUsdt, null);
  assert.equal(value.score.total, null);
});

test("daily storage is immutable, concurrent-safe and detects tampering", async t => {
  const directory = await mkdtemp(join(tmpdir(), "strategy-daily-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = buildStrategyDaily(research());
  const results = await Promise.all([saveStrategyDaily(directory, snapshot), saveStrategyDaily(directory, snapshot)]);
  assert.equal(results.filter(row => row.created).length, 1);
  const before = await readFile(join(directory, snapshot.date + ".json"), "utf8");
  const changed = research(); changed.paper.a.liquidationEquityUsdt = 55;
  assert.equal((await saveStrategyDaily(directory, buildStrategyDaily(changed))).created, false);
  assert.equal(await readFile(join(directory, snapshot.date + ".json"), "utf8"), before);
  assert.equal((await readStrategyDaily(directory)).records.length, 1);
  const altered = JSON.parse(before); altered.report.strategies[0].name = "altered";
  await writeFile(join(directory, snapshot.date + ".json"), JSON.stringify(altered));
  const read = await readStrategyDaily(directory);
  assert.equal(read.status, "ERROR"); assert.equal(read.records.length, 0);
});

test("daily runner records every strategy without modifying inputs and repeated runs are a no-op", async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), "strategy-daily-runner-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const config = JSON.stringify({ mode: "live", stateFile: "positions.json", traceFile: "trace.jsonl", strategyControlFile: "control.json" });
  await writeFile(join(projectRoot, "config.json"), config);
  await writeFile(join(projectRoot, "trace.jsonl"), "");
  await writeFile(join(projectRoot, "positions.json"), '{"positions":[]}');
  const input = { projectRoot, nowMs: Date.parse(at) };
  const first = await recordStrategyDaily(input), second = await recordStrategyDaily(input);
  assert.equal(first.created, true); assert.equal(first.strategies, 12);
  assert.equal(second.created, false);
  assert.equal(await readFile(join(projectRoot, "config.json"), "utf8"), config);
  assert.equal(await readFile(join(projectRoot, "trace.jsonl"), "utf8"), "");
  assert.equal(await readFile(join(projectRoot, "positions.json"), "utf8"), '{"positions":[]}');
  const history = await readStrategyDaily(join(projectRoot, "state/strategy-daily"));
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].strategies.length, 12);
  assert.ok(history.records[0].strategies.every(s => Object.values(s.sources).every(v => v.score.total === null)));
});
