import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTracer } from "../src/trace.mjs";

test("appends ordered JSONL action records with run and cycle identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-trace-"));
  const tracePath = join(directory, "actions.jsonl");
  const trace = createTracer(tracePath, { runId: "run-1" });

  await trace("startup", "succeeded", { mode: "shadow" });
  await trace("candidate_rejected", "skipped", { symbol: "NVDA", reason: "trend" }, "cycle-1");

  const records = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(records.map(({ sequence, event }) => [sequence, event]), [
    [1, "startup"],
    [2, "candidate_rejected"]
  ]);
  assert.equal(records[0].runId, "run-1");
  assert.equal(records[1].cycleId, "cycle-1");
  assert.match(records[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("redacts credentials, tokens, authorization headers and webhook URLs recursively", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-trace-"));
  const tracePath = join(directory, "actions.jsonl");
  const trace = createTracer(tracePath, { runId: "run-2" });

  await trace("external_call", "failed", {
    app_secret: "secret-value",
    accessToken: "token-value",
    headers: { Authorization: "Bearer private", "Content-Type": "application/json" },
    webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/private",
    nested: { apiKey: "key-value", symbol: "NVDA" }
  });

  const content = await readFile(tracePath, "utf8");
  assert.doesNotMatch(content, /secret-value|token-value|Bearer private|hook\/private|key-value/);
  const record = JSON.parse(content);
  assert.equal(record.details.app_secret, "[REDACTED]");
  assert.equal(record.details.accessToken, "[REDACTED]");
  assert.equal(record.details.headers.Authorization, "[REDACTED]");
  assert.equal(record.details.headers["Content-Type"], "application/json");
  assert.equal(record.details.webhookUrl, "[REDACTED]");
  assert.equal(record.details.nested.apiKey, "[REDACTED]");
  assert.equal(record.details.nested.symbol, "NVDA");
});
