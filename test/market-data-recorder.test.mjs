import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMarketDataRecorder,
  normalizeCandles
} from "../src/market-data-recorder.mjs";

test("normalizes raw market candles into numeric OHLCV records", () => {
  assert.deepEqual(normalizeCandles([
    ["1000", "10", "11", "9", "10.5", "42.25", "1999"]
  ]), [{
    openTime: 1000,
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 42.25,
    closeTime: 1999
  }]);
});

test("writes concurrent scan records as complete date-partitioned JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-data-"));
  const record = createMarketDataRecorder(directory, {
    runId: "run-1",
    timeZone: "Asia/Shanghai"
  });
  const timestamp = "2026-07-24T16:30:00.000Z";

  await Promise.all([
    record("market_scan", { cycleId: "cycle-1", symbol: "NVDA" }, timestamp),
    record("market_scan", { cycleId: "cycle-1", symbol: "TSLA" }, timestamp)
  ]);

  const path = join(directory, "2026-07-25.jsonl");
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.symbol), ["NVDA", "TSLA"]);
  assert.deepEqual(lines.map((line) => line.sequence), [1, 2]);
  assert.ok(lines.every((line) => line.schemaVersion === 1));
  assert.ok(lines.every((line) => line.recordType === "market_scan"));
  assert.ok(lines.every((line) => line.runId === "run-1"));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
