import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScheduledResearch } from "../scripts/run-scheduled-research.mjs";

const monthly = () => ({ runDirectory: "/research/example", report: {
  periods: { common: {} }, automaticTradingEligible: false, verdicts: { A1: "HISTORICAL_GATE_FAILED", A2: "HISTORICAL_GATE_FAILED" }
} });
const offhours = () => ({ path: "/research/snapshot.json", snapshot: {
  automaticTradingEligible: false, evidenceLabel: "OBSERVATION_ONLY", errors: [],
  summary: { decision: "INSUFFICIENT_EVIDENCE", validPairs: 0, reviewEligible: false },
  observations: ["SPY", "QQQ"].map(ticker => ({ ticker, status: "NO_QUOTE", comparable: false,
    automaticTradingEligible: false, vetoReasons: ["BUY_QUOTE_UNAVAILABLE", "REFERENCE_UNAVAILABLE", "ASSET_NOT_TRADING"] }))
} });

test("monthly scheduler persists running and terminal receipts, with gate rejection distinct from collection failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-schedule-"));
  const receipt = await runScheduledResearch({ job: "monthly", directory, runMonthly: async () => {
    assert.equal(JSON.parse(await readFile(join(directory, "monthly.json"))).status, "RUNNING");
    return monthly();
  } });
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.researchDecision.A1, "HISTORICAL_GATE_FAILED");
  assert.equal(receipt.automaticTradingEligible, false);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "monthly.json"))), receipt);
  assert.deepEqual(await readdir(directory), ["monthly.json"]);
  const failed = await runScheduledResearch({ job: "monthly", directory, runMonthly: async () => ({
    runDirectory: "/research/failed", report: { status: "DATA_QUALITY_BLOCKED", automaticTradingEligible: false }
  }) });
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.artifact, "/research/failed/report.json");
  assert.equal(JSON.parse(await readFile(join(directory, "monthly.json"))).id, failed.id);
});

test("offhours public collection success cannot be confused with valid quote evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-schedule-"));
  const receipt = await runScheduledResearch({ job: "offhours", directory, runOffhours: async () => offhours() });
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.evidenceLabel, "OBSERVATION_ONLY");
  assert.equal(receipt.validPairs, 0);
  assert.equal(receipt.reviewEligible, false);
});

test("a measured exchange pause remains rejected research evidence, not a broken collection job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-schedule-"));
  const result = offhours();
  for (const observation of result.snapshot.observations) {
    observation.session = "pause";
    observation.vetoReasons.push("MARKET_SESSION_UNKNOWN", "MARKET_SESSION_CALENDAR_CONFLICT", "MARKET_NOT_TRADING");
  }
  const receipt = await runScheduledResearch({ job: "offhours", directory, runOffhours: async () => result });
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.observations[0].comparable, false);
  assert.ok(receipt.observations[0].vetoReasons.includes("MARKET_SESSION_CALENDAR_CONFLICT"));
});

test("offhours scheduler fails on provider, identity and stale input errors while preserving artifact paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-schedule-"));
  for (const change of [
    snapshot => { snapshot.errors.push({ reason: "PUBLIC_INPUT_UNAVAILABLE" }); },
    snapshot => { snapshot.observations[0].vetoReasons.push("DISCOVERY_IDENTITY_UNAVAILABLE"); },
    snapshot => { snapshot.observations[0].vetoReasons.push("MARKET_STATUS_STALE_OR_INVALID"); },
    snapshot => { snapshot.observations = []; },
    snapshot => { snapshot.observations[1].ticker = "SPY"; },
    snapshot => { snapshot.automaticTradingEligible = true; }
  ]) {
    const result = offhours(); change(result.snapshot);
    const receipt = await runScheduledResearch({ job: "offhours", directory, runOffhours: async () => result });
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.artifact, result.path);
    assert.equal(receipt.automaticTradingEligible, false);
  }
});

test("runner exceptions stay visible and invalid job names cannot choose a receipt path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-schedule-"));
  const receipt = await runScheduledResearch({ job: "monthly", directory, runMonthly: async () => { throw new Error("ARCHIVE_REQUIRED"); } });
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.error, "ARCHIVE_REQUIRED");
  assert.equal(receipt.artifact, null);
  await assert.rejects(runScheduledResearch({ job: "../live", directory }), /Usage/);
});

test("research services isolate credentials and serialize bounded work; calendars keep NY local time", async () => {
  for (const job of ["monthly", "offhours"]) {
    const unit = await readFile(new URL(`../deploy/binance-agentic-${job}-research.service`, import.meta.url), "utf8");
    assert.match(unit, /User=binanceresearch/);
    assert.match(unit, /WorkingDirectory=\/opt\/binance-agentic-research\/current/);
    assert.match(unit, /ReadWritePaths=\/var\/lib\/binance-agentic-research\n/);
    assert.match(unit, /InaccessiblePaths=.*stock-bot.env.*\/opt\/binance-agentic-stock-bot.*\/var\/lib\/binance-agentic-stock-bot/);
    assert.doesNotMatch(unit, /EnvironmentFile=|BOT_LIVE_TRADING=1|Restart=always/);
    assert.match(unit, /flock --nonblock --conflict-exit-code 75 .*scheduler.lock/);
    assert.match(unit, /MemoryMax=256M/);
    assert.match(unit, /CPUQuota=25%/);
    assert.match(unit, new RegExp(`run-scheduled-research.mjs ${job}`));
  }
  const monthlyTimer = await readFile(new URL("../deploy/binance-agentic-monthly-research.timer", import.meta.url), "utf8");
  const offhoursTimer = await readFile(new URL("../deploy/binance-agentic-offhours-research.timer", import.meta.url), "utf8");
  assert.match(monthlyTimer, /OnCalendar=\*-\*-01 06:10:00 America\/New_York/);
  assert.match(monthlyTimer, /Persistent=true/);
  assert.equal((offhoursTimer.match(/^OnCalendar=/gm) || []).length, 4);
  for (const time of ["09:20", "09:35", "16:10", "20:00"]) assert.ok(offhoursTimer.includes(`${time}:00 America/New_York`));
  assert.match(offhoursTimer, /Persistent=false/);
});
