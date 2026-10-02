import assert from "node:assert/strict";
import test from "node:test";
import { retry } from "../src/retry.mjs";
import { BawError, isTransientNetworkError } from "../src/reliability.mjs";

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

test("recovers a read after transient DNS failures within the existing three-attempt limit", async () => {
  let attempts = 0;
  const retries = [];
  const result = await retry(async () => {
    attempts += 1;
    if (attempts < 3) throw new BawError({ code: 50001004, name: "DNS_RESOLVE_FAILED", message: "Host not found (www.binance.com)" });
    return "fresh quote";
  }, {
    attempts: 3,
    delayMs: 0,
    shouldRetry: isTransientNetworkError,
    onRetry: async (_error, attempt, nextAttempt) => retries.push([attempt, nextAttempt])
  });
  assert.equal(result, "fresh quote");
  assert.equal(attempts, 3);
  assert.deepEqual(retries, [[1, 2], [2, 3]]);
});

test("propagates persistent DNS failures after bounded read retries", async () => {
  let attempts = 0;
  const error = new BawError({ code: 50001004, name: "DNS_RESOLVE_FAILED", message: "Host not found (www.binance.com)" });
  await assert.rejects(() => retry(async () => {
    attempts += 1;
    throw error;
  }, { attempts: 3, delayMs: 0, shouldRetry: isTransientNetworkError }), (failure) => failure === error);
  assert.equal(attempts, 3);
});

test("never repeats a state-changing operation after a DNS failure", async () => {
  let attempts = 0;
  const error = new BawError({ code: 50001004, name: "DNS_RESOLVE_FAILED", message: "Host not found (www.binance.com)" });
  await assert.rejects(() => retry(async () => {
    attempts += 1;
    throw error;
  }, { attempts: 1, delayMs: 0, shouldRetry: isTransientNetworkError }), (failure) => failure === error);
  assert.equal(attempts, 1);
});
