import assert from "node:assert/strict";
import test from "node:test";
import { buildBawEnvironment } from "../src/baw-runtime.mjs";

test("builds one stable wallet environment for proxy and session encryption", () => {
  const original = {
    PATH: "/usr/bin:/bin",
    NODE_OPTIONS: "--trace-warnings"
  };
  const result = buildBawEnvironment({
    environment: original,
    instanceId: "stable-instance"
  });

  assert.equal(result.BINANCE_INSTANCE_ID, "stable-instance");
  assert.equal(result.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(result.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(result.ALL_PROXY, "socks5://127.0.0.1:7890");
  assert.equal(result.NO_PROXY, "127.0.0.1");
  assert.equal(result.NODE_OPTIONS, "--trace-warnings --use-env-proxy");
  assert.equal(original.NODE_OPTIONS, "--trace-warnings");
});

test("does not duplicate the Node environment proxy flag", () => {
  const result = buildBawEnvironment({
    environment: { NODE_OPTIONS: "--use-env-proxy" },
    instanceId: "stable-instance"
  });

  assert.equal(result.NODE_OPTIONS, "--use-env-proxy");
});

test("refuses to run without the stable Keychain instance ID", () => {
  assert.throws(() => buildBawEnvironment({
    environment: {},
    instanceId: ""
  }), /instance ID is missing/);
});
