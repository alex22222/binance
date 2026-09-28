import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadStrategyResearch } from "../src/strategy-research.mjs";

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), "strategy-research-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const save = async (path, value) => {
    const target = join(projectRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
  };
  await save("config.json", { mode: "live", strategyControlFile: "control.json", traceFile: "trace.jsonl", secret: "NOT_PUBLIC" });
  return { projectRoot, configPath: join(projectRoot, "config.json"), save };
}

test("missing research stays missing without inventing zero performance or exposing config", async (t) => {
  const input = await fixture(t);
  const report = await loadStrategyResearch(input);
  assert.equal(report.strategies.length, 12);
  assert.equal(report.trace.status, "MISSING");
  assert.equal(report.validation.status, "MISSING");
  assert.equal(report.paper["daily-turtle-55-20"].status, "MISSING");
  assert.equal(report.strategies[0].performance.realizedPnlUsdt, null);
  assert.equal(report.activeStrategyId, "weekly-etf-dual-momentum-defense");
  assert.doesNotMatch(JSON.stringify(report), /NOT_PUBLIC/);
});

test("one malformed report does not hide independent evidence; control errors never claim active", async (t) => {
  const input = await fixture(t);
  await input.save("control.json", "{");
  await input.save("state/strategy-validation/latest.json", "{");
  await input.save("state/shadow-outcomes/latest.json", { generatedAt: "2026-09-26", method: {}, horizons: [{ horizonMinutes: 30, strategyCohorts: {} }], outcomes: [{ private: true }] });
  const report = await loadStrategyResearch(input);
  assert.equal(report.control.status, "ERROR");
  assert.equal(report.activeStrategyId, null);
  assert.equal(report.validation.status, "ERROR");
  assert.equal(report.shadow.status, "AVAILABLE");
  assert.equal(report.shadow.outcomes, undefined);
  assert.ok(report.strategies.every((strategy) => !strategy.active));
});

test("projects source periods and paper identity without modifying saved reports", async (t) => {
  const input = await fixture(t);
  const trace = JSON.stringify({ timestamp: "2026-09-25T12:00:00Z", event: "pending_order", status: "finished", details: { side: "SELL", strategyId: "adaptive-momentum", orderId: "a", realizedPnlUsdt: 0 } }) + "\n";
  await input.save("trace.jsonl", trace);
  await input.save("state/strategy-validation/latest.json", { generatedAt: "2026-09-26", historical: { strategies: [{ id: "adaptive-momentum", performance: { trades: 1, pnlUsdt: -2 }, trades: [{ private: true }] }] } });
  await input.save("state/turtle-paper/latest.json", { mode: "paper", strategyId: "daily-turtle-55-20", trades: [], realizedPnlUsdt: 0, private: true });
  await input.save("state/weekly-etf-dual-momentum-paper/latest.json", { mode: "live", strategyId: "weekly-etf-dual-momentum-defense", trades: [] });
  const report = await loadStrategyResearch(input);
  assert.equal(report.trace.period.from, "2026-09-25T12:00:00.000Z");
  assert.equal(report.strategies.find((strategy) => strategy.id === "adaptive-momentum").performance.realizedPnlUsdt, 0);
  assert.equal(report.validation.historical.strategies[0].trades, undefined);
  assert.equal(report.paper["daily-turtle-55-20"].closedTrades, 0);
  assert.equal(report.paper["daily-turtle-55-20"].equityUsdt, null);
  assert.equal(report.paper["weekly-etf-dual-momentum-defense"].status, "ERROR");
  assert.equal(await readFile(join(input.projectRoot, "trace.jsonl"), "utf8"), trace);
});

test("unknown control strategy is a read error rather than an invented current strategy", async (t) => {
  const input = await fixture(t);
  await input.save("control.json", { strategyId: "unknown-strategy" });
  const report = await loadStrategyResearch(input);
  assert.equal(report.control.status, "ERROR");
  assert.equal(report.activeStrategyId, null);
});

test("approval mode is runtime state, while ACTIVE without reviewed evidence is not eligible", async (t) => {
  const input = await fixture(t);
  await input.save("state/approval-control.json", { enabled: true, updatedBy: "operator" });
  let report = await loadStrategyResearch(input);
  assert.equal(report.approval.mode, "AUTO");
  const current = report.strategies.find((s) => s.active);
  assert.equal(current.governance.allowed, false);
  assert.equal(current.switchable, false);
  assert.equal(current.governance.protectiveExitAllowed, true);
  await input.save("state/approval-control.json", { enabled: false });
  report = await loadStrategyResearch(input);
  assert.equal(report.approval.mode, "MANUAL");
  await input.save("state/approval-control.json", "{");
  assert.equal((await loadStrategyResearch(input)).approval.mode, "UNKNOWN");
});
