import assert from "node:assert/strict";
import test from "node:test";
import { createWalletLoginManager } from "../src/wallet-login.mjs";

test("starts one official Binance login and verifies it in the background", async () => {
  let finishVerification;
  const calls = [];
  const manager = createWalletLoginManager({
    executeBaw: async (args) => {
      calls.push(args);
      if (args[1] === "signin") {
        return {
          urlForWeb: "https://web3.binance.com/en/agent-login?token=test",
          qrCodeId: "a191884d-0e05-435b-a887-336bc242fafc",
          expireAt: String(Date.now() + 300_000),
          pairingCode: "654321"
        };
      }
      return new Promise((resolve) => { finishVerification = resolve; });
    }
  });

  const started = await manager.start();
  assert.equal(started.status, "PENDING");
  assert.equal(started.pairingCode, "654321");
  assert.match(started.urlForWeb, /^https:\/\/web3\.binance\.com\//);
  assert.equal(started.qrCodeId, undefined);
  assert.deepEqual(calls[0], ["auth", "signin"]);
  assert.deepEqual(calls[1], ["auth", "verify", "--qrCodeId", "a191884d-0e05-435b-a887-336bc242fafc"]);

  finishVerification({ status: "SUCCESS" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.status().status, "CONNECTED");
});

test("rejects non-Binance login links", async () => {
  const manager = createWalletLoginManager({
    executeBaw: async () => ({
      urlForWeb: "https://attacker.example/qr",
      qrCodeId: "a191884d-0e05-435b-a887-336bc242fafc",
      expireAt: String(Date.now() + 300_000),
      pairingCode: "654321"
    })
  });
  await assert.rejects(() => manager.start(), /official Binance HTTPS URL/);
});
