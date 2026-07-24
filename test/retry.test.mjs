import assert from "node:assert/strict";
import test from "node:test";
import { retry } from "../src/retry.mjs";

test("retries a transient failure and returns the successful result", async () => {
  let attempts = 0;
  const result = await retry(async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError("fetch failed");
    return "sent";
  }, {
    attempts: 3,
    delayMs: 0,
    shouldRetry: (error) => error instanceof TypeError
  });

  assert.equal(result, "sent");
  assert.equal(attempts, 3);
});

test("does not retry a non-transient application error", async () => {
  let attempts = 0;
  await assert.rejects(() => retry(async () => {
    attempts += 1;
    throw new Error("Feishu message failed: permission denied");
  }, {
    attempts: 3,
    delayMs: 0,
    shouldRetry: (error) => error instanceof TypeError
  }), /permission denied/);
  assert.equal(attempts, 1);
});
