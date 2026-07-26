import assert from "node:assert/strict";
import test from "node:test";
import { summarizeWalletBalances } from "../src/wallet-balance.mjs";

test("summarizes the wallet USD value without exposing asset details", () => {
  assert.deepEqual(
    summarizeWalletBalances([
      { symbol: "USDT", balance: "400", price: "1", value: "400" },
      { symbol: "BNB", balance: "0.1", price: "496.75" }
    ], "2026-07-26T15:00:00.000Z"),
    {
      totalUsd: 449.675,
      assetCount: 2,
      checkedAt: "2026-07-26T15:00:00.000Z"
    }
  );
});

test("rejects an invalid wallet balance response", () => {
  assert.throws(() => summarizeWalletBalances(null), /must be an array/);
});
