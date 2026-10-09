import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frequencyDailyRows, frequencyTokenPrice, runFrequencyPaper } from "../scripts/run-etf-frequency-paper.mjs";
import { frequencyHash } from "../src/etf-frequency-paper.mjs";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";

test("only completed adjusted ETF rows are eligible, not current partial daily data", () => {
  const chart = { chart: { result: [{ meta: { symbol: "QQQ", currency: "USD", instrumentType: "ETF", exchangeTimezoneName: "America/New_York" },
    timestamp: [Date.parse("2026-10-09") / 1000, Date.parse("2026-10-12") / 1000], indicators: { adjclose: [{ adjclose: [100, 999] }] } }] } };
  assert.deepEqual(frequencyDailyRows(chart, "QQQ", "2026-10-12"), [{ date: "2026-10-09", close: 100 }]);
  assert.throws(() => frequencyDailyRows(chart, "SPY", "2026-10-12"), /identity/);
});

test("real collection rechecks freshness and closing time before committing simulated fills", async t => {
  const directory = await mkdtemp(join(tmpdir(), "etf-final-clock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await runFrequencyPaper({ directory, nowMs: Date.parse("2026-10-09T14:00:00Z") });
  const now = Date.parse("2026-10-12T19:58:00Z");
  const fetchJson = async input => {
    const url = new URL(input); let payload;
    if (url.hostname.includes("yahoo")) {
      const ticker = url.pathname.split("/").at(-1), dates = researchTradingDates("2024-11-12", "2026-10-09");
      payload = { chart: { result: [{ meta: { symbol: ticker, currency: "USD", instrumentType: "ETF", exchangeTimezoneName: "America/New_York" },
        timestamp: dates.map(date => Date.parse(date) / 1000), indicators: { adjclose: [{ adjclose: dates.map((_, i) => 100 + i) }] } }] } };
    } else if (url.pathname.includes("detail/list")) {
      payload = { code: "000000", data: ["QQQ", "SPY", "SGOV"].map(ticker => ({ ticker, assetType: 3, chainId: "56", contractAddress: "contract-" + ticker })) };
    } else payload = { code: "000000", data: { klineInfos: [[now - 60000, 0, 0, 0, 100, 0, now - 1]] } };
    const raw = JSON.stringify(payload); return { payload, raw, url: String(url), collectedAt: new Date(now).toISOString(), sourceHash: frequencyHash(raw) };
  };
  await assert.rejects(runFrequencyPaper({ directory, nowMs: now, fetchJson, elapsedMs: () => 3 * 60000 }), /closed during/);
  assert.ok(JSON.parse(await readFile(join(directory, "latest.json"))).experiments.every(ledger => !ledger.position));
  const success = await runFrequencyPaper({ directory, nowMs: now, fetchJson, elapsedMs: () => 0 });
  assert.equal(success.experiments.find(ledger => ledger.id === "W-20-base").position.symbol, "QQQ");
  assert.equal(success.experiments.find(ledger => ledger.id === "M-20-base").position, null);
  await assert.rejects(runFrequencyPaper({ directory, nowMs: Date.parse("2026-10-12T14:00:00Z"), fetchJson: async input => {
    const source = await fetchJson(input);
    if (new URL(input).pathname.includes("kline")) {
      source.payload.data.klineInfos = [[Date.parse("2026-10-12T13:59:00Z"), 0, 0, 0, 100, 0, Date.parse("2026-10-12T13:59:59Z")]];
    }
    return source;
  }, elapsedMs: () => 6 * 60000 }), /Stale Paper/);
  assert.equal(JSON.parse(await readFile(join(directory, "latest.json"))).experiments.find(ledger => ledger.id === "W-20-base").trades.length, 1);
});

test("minute marks must be complete, fresh and inside the regular session", () => {
  const now = Date.parse("2026-10-12T14:00:00Z"), bounds = { openMs: now - 30 * 60000, closeMs: now + 6 * 3600000 };
  const payload = { code: "000000", data: { klineInfos: [[now - 60000, 0, 0, 0, 100, 0, now - 1]] } };
  assert.equal(frequencyTokenPrice(payload, "QQQ", bounds, now).price, 100);
  assert.throws(() => frequencyTokenPrice(payload, "QQQ", bounds, now + 10 * 60000), /Stale/);
});

test("initializes without network or orders, freezes specification, and preserves failures", async t => {
  const directory = await mkdtemp(join(tmpdir(), "etf-paper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const fetchJson = async () => { calls++; throw new Error("simulated public data outage"); };
  const first = await runFrequencyPaper({ directory, nowMs: Date.parse("2026-10-09T14:00:00Z"), fetchJson });
  assert.equal(calls, 0); assert.equal(first.experiments.length, 27);
  const frozen = await readFile(join(directory, "specification.json"), "utf8");
  await assert.rejects(runFrequencyPaper({ directory, nowMs: Date.parse("2026-10-12T14:00:00Z"), fetchJson }), /outage/);
  const failed = JSON.parse(await readFile(join(directory, "latest.json")));
  assert.equal(failed.collectionStatus, "DATA_QUALITY_BLOCKED");
  assert.ok(failed.experiments.every(ledger => !ledger.position && !ledger.trades.length));
  assert.equal(await readFile(join(directory, "specification.json"), "utf8"), frozen);
  failed.codeHash = "invalid"; await writeFile(join(directory, "latest.json"), JSON.stringify(failed));
  await assert.rejects(runFrequencyPaper({ directory, nowMs: Date.parse("2026-10-12T14:00:00Z"), fetchJson }), /code\/specification/);
});
