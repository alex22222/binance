import assert from "node:assert/strict";
import test from "node:test";
import { createLoginLimiter, loginClientKey } from "../src/dashboard-login-limit.mjs";

test("eight failures in the window block the client, and a success clears them", () => {
  let now = 1_000;
  const limiter = createLoginLimiter({ now: () => now });
  for (let attempt = 0; attempt < 7; attempt += 1) assert.equal(limiter.recordFailure("203.0.113.8"), false);
  assert.equal(limiter.recordFailure("203.0.113.8"), true);
  assert.equal(limiter.blocked("203.0.113.8"), true);
  assert.equal(limiter.blocked("203.0.113.9"), false);
  now += 15 * 60 * 1000;
  assert.equal(limiter.blocked("203.0.113.8"), false);
  limiter.recordFailure("203.0.113.9");
  limiter.recordSuccess("203.0.113.9");
  assert.equal(limiter.blocked("203.0.113.9"), false);
});

test("the client key uses the forwarded address only from loopback", () => {
  assert.equal(loginClientKey({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.1" } }), "203.0.113.4");
  assert.equal(loginClientKey({ socket: { remoteAddress: "198.51.100.2" }, headers: { "x-forwarded-for": "203.0.113.4" } }), "198.51.100.2");
  assert.equal(loginClientKey({ socket: {}, headers: {} }), "unknown");
});
