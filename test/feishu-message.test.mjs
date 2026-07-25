import assert from "node:assert/strict";
import test from "node:test";
import { feishuMessageWithDashboardLink } from "../src/feishu-message.mjs";

test("adds the public HTTPS Dashboard link to a Feishu notification", () => {
  assert.equal(
    feishuMessageWithDashboardLink("[Agentic Stock Bot] TEST OK", {
      DASHBOARD_PUBLIC_ORIGIN: "https://stocks.example.com/"
    }),
    "[Agentic Stock Bot] TEST OK\n\n📱 打开手机 Dashboard：https://stocks.example.com"
  );
});

test("never sends a loopback Dashboard address to a phone", () => {
  assert.equal(
    feishuMessageWithDashboardLink("[Agentic Stock Bot] TEST OK", {
      DASHBOARD_URL: "http://127.0.0.1:4173"
    }),
    "[Agentic Stock Bot] TEST OK"
  );
});

test("does not append the same public Dashboard link twice", () => {
  const text = "[Agentic Stock Bot] TEST OK\nhttps://stocks.example.com";
  assert.equal(
    feishuMessageWithDashboardLink(text, {
      DASHBOARD_PUBLIC_ORIGIN: "https://stocks.example.com"
    }),
    text
  );
});
