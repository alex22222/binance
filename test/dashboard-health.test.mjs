import assert from "node:assert/strict";
import test from "node:test";
import { dashboardHealth } from "../src/dashboard-health.mjs";

test("health reports the UI release name and the trading identity when both are readable", async () => {
  const health = await dashboardHealth({
    uiRoot: "/opt/binance-agentic-personal-assets/current",
    resolvePath: async () => "/opt/binance-agentic-personal-assets/releases/20261113-okx-desk",
    identityText: JSON.stringify({ liveCodeHash: "a".repeat(64), other: "ignored" })
  });
  assert.deepEqual(health, { status: "ok", uiRelease: "20261113-okx-desk", tradingIdentity: "a".repeat(64) });
});

test("health stays ok when the release link or identity file is absent", async () => {
  const health = await dashboardHealth({
    uiRoot: "/missing",
    resolvePath: async () => { throw new Error("ENOENT"); },
    readIdentity: async () => { throw new Error("ENOENT"); }
  });
  assert.deepEqual(health, { status: "ok", uiRelease: null, tradingIdentity: null });
});
