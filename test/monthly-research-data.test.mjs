import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { parseMonthlyResearchHistory, collectMonthlyResearchData } from "../src/monthly-research-data.mjs";
import { runMonthlyTrendResearch } from "../scripts/run-monthly-trend-research.mjs";

function payload(ticker = "VTI") {
  const dates = researchTradingDates("2020-01-01", "2021-06-30");
  return { chart: { result: [{
    meta: { symbol: ticker, currency: "USD", exchangeTimezoneName: "America/New_York", instrumentType: "ETF", firstTradeDate: Date.parse("2020-01-02T14:30Z") / 1000 },
    timestamp: dates.map((date) => Date.parse(`${date}T14:30Z`) / 1000),
    indicators: { quote: [{ open: dates.map(() => 100), close: dates.map(() => 100) }], adjclose: [{ adjclose: dates.map(() => 90) }] }
  }] } };
}

test("research data preserve adjusted opens and reject identity, missing, null and duplicate days", () => {
  const raw = payload();
  const parse = (value) => parseMonthlyResearchHistory(JSON.stringify(value), "VTI", "2021-06-30");
  assert.equal(parse(raw).quality.passed, true);
  assert.equal(parse(raw).bars[0].open, 90);
  assert.throws(() => parse(payload("QQQ")), /identity/);
  const missing = structuredClone(raw);
  missing.chart.result[0].indicators.adjclose[0].adjclose[100] = null;
  assert.equal(parse(missing).quality.passed, false);
  assert.equal(parse(missing).quality.invalidRowCount, 1);
  assert.equal(parse(missing).quality.missingDates.length, 1);
  const duplicate = structuredClone(raw);
  duplicate.chart.result[0].timestamp[100] = duplicate.chart.result[0].timestamp[99];
  assert.equal(parse(duplicate).quality.passed, false);
});

test("incomplete bars are explicitly excluded and future cutoff cannot be requested", async () => {
  const parsed = parseMonthlyResearchHistory(JSON.stringify(payload()), "VTI", "2021-06-29");
  assert.equal(parsed.quality.passed, true);
  assert.equal(parsed.quality.excludedAfterCutoff, 1);
  await assert.rejects(collectMonthlyResearchData({ nowMs: Date.parse("2026-09-28T14:00Z"), cutoff: "2026-09-28" }), /completed/);
});

test("source metadata cannot move the frozen history boundary or invent earlier SGOV", () => {
  const shifted = payload();
  shifted.chart.result[0].meta.firstTradeDate = Date.parse("2021-05-03T13:30Z") / 1000;
  assert.equal(parseMonthlyResearchHistory(JSON.stringify(shifted), "VTI", "2021-06-30").quality.passed, false);
  const synthetic = payload("SGOV");
  assert.equal(parseMonthlyResearchHistory(JSON.stringify(synthetic), "SGOV", "2021-06-30").quality.passed, false);
});

test("code edited during collection blocks the run instead of attaching new hashes to old execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monthly-code-drift-"));
  await cp(new URL("../src", import.meta.url), join(directory, "src"), { recursive: true });
  await mkdir(join(directory, "scripts"));
  const runner = join(directory, "scripts/run-monthly-trend-research.mjs");
  await cp(new URL("../scripts/run-monthly-trend-research.mjs", import.meta.url), runner);
  const { runMonthlyTrendResearch: isolatedRun } = await import(pathToFileURL(runner));
  let changed = false;
  const result = await isolatedRun({ directory: join(directory, "output"), nowMs: Date.parse("2026-09-28T14:00Z"), fetchText: async () => {
    if (!changed) { await appendFile(join(directory, "src/monthly-trend-research.mjs"), "\n// simulated concurrent edit\n"); changed = true; }
    throw new Error("Fixture data unavailable");
  } });
  assert.equal(result.report.status, "CODE_CHANGED_DURING_RUN");
  assert.equal(result.report.periods, undefined);
  assert.equal(result.report.automaticTradingEligible, false);
});

test("provider failure is persisted with missing evidence, isolated immutable runs and no fake returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monthly-research-test-"));
  const options = { directory, nowMs: Date.parse("2026-09-28T14:00Z"), fetchText: async () => { throw new Error("Unavailable"); } };
  const first = await runMonthlyTrendResearch(options);
  const second = await runMonthlyTrendResearch(options);
  assert.notEqual(first.runDirectory, second.runDirectory);
  assert.equal(first.report.status, "DATA_QUALITY_BLOCKED");
  assert.equal(first.report.periods, undefined);
  assert.equal(first.report.dataSources.length, 5);
  assert.equal(first.report.automaticTradingEligible, false);
  assert.equal((await readdir(directory)).length, 2);
  assert.match(await readFile(join(first.runDirectory, "report.md"), "utf8"), /未生成收益/);
});
