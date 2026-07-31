import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAssetTrend,
  createAvailableUsdtLoader,
  summarizeWalletBalances,
  upsertWalletBalanceSnapshot
} from "../src/wallet-balance.mjs";

test("summarizes the wallet USD value without exposing asset details", () => {
  assert.deepEqual(
    summarizeWalletBalances([
      { symbol: "USDT", binanceChainId: "56", balance: "400", price: "1", value: "400" },
      { symbol: "BNB", balance: "0.1", price: "496.75" }
    ], "2026-07-26T15:00:00.000Z"),
    {
      totalUsd: 449.675,
      availableUsdt: 400,
      assetCount: 2,
      checkedAt: "2026-07-26T15:00:00.000Z"
    }
  );
});

test("counts only BSC USDT as the strategy's available balance", () => {
  const summary = summarizeWalletBalances([
    { symbol: "USDT", binanceChainId: "56", balance: "120.50", price: "1", value: "120.50" },
    { symbol: "USDT", binanceChainId: "CT_501", balance: "25", price: "1", value: "25" },
    { symbol: "USDC", binanceChainId: "56", balance: "30", price: "1", value: "30" }
  ], "2026-07-31T15:30:00.000Z");

  assert.equal(summary.totalUsd, 175.5);
  assert.equal(summary.availableUsdt, 120.5);
});

test("caches the read-only available USDT query and preserves the last value on failure", async () => {
  let calls = 0;
  const load = createAvailableUsdtLoader({
    executeBalance: async () => {
      calls += 1;
      if (calls > 1) throw new Error("temporary wallet read failure");
      return [{ symbol: "USDT", binanceChainId: "56", balance: "88.25", price: "1", value: "88.25" }];
    }
  });

  const first = await load({ nowMs: Date.parse("2026-07-31T15:30:00.000Z") });
  const cached = await load({ nowMs: Date.parse("2026-07-31T15:30:30.000Z") });
  const stale = await load({ nowMs: Date.parse("2026-07-31T15:31:01.000Z") });

  assert.equal(calls, 2);
  assert.strictEqual(cached, first);
  assert.equal(stale.availableUsdt, 88.25);
  assert.equal(stale.stale, true);
});

test("rejects an invalid wallet balance response", () => {
  assert.throws(() => summarizeWalletBalances(null), /must be an array/);
});

test("keeps the latest successful wallet value for each Shanghai calendar day", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-wallet-history-"));
  const path = join(directory, "wallet-balance-history.json");

  await upsertWalletBalanceSnapshot(path, {
    totalUsd: 449.67,
    assetCount: 2,
    checkedAt: "2026-07-26T15:00:00.000Z"
  });
  await upsertWalletBalanceSnapshot(path, {
    totalUsd: 451.25,
    assetCount: 2,
    checkedAt: "2026-07-26T15:30:00.000Z"
  });
  await upsertWalletBalanceSnapshot(path, {
    totalUsd: 455.5,
    assetCount: 3,
    checkedAt: "2026-07-27T15:30:00.000Z"
  });

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [
    {
      date: "2026-07-26",
      totalUsd: 451.25,
      assetCount: 2,
      checkedAt: "2026-07-26T15:30:00.000Z"
    },
    {
      date: "2026-07-27",
      totalUsd: 455.5,
      assetCount: 3,
      checkedAt: "2026-07-27T15:30:00.000Z"
    }
  ]);
});

test("builds a bounded asset trend and includes the current successful balance", () => {
  const trend = buildAssetTrend([
    { date: "2026-07-25", totalUsd: 445, assetCount: 2, checkedAt: "2026-07-25T15:00:00.000Z" },
    { date: "2026-07-26", totalUsd: 449, assetCount: 2, checkedAt: "2026-07-26T15:00:00.000Z" }
  ], {
    totalUsd: 452,
    assetCount: 2,
    checkedAt: "2026-07-27T15:00:00.000Z"
  }, 2);

  assert.deepEqual(trend, [
    { date: "2026-07-26", totalUsd: 449, assetCount: 2, checkedAt: "2026-07-26T15:00:00.000Z" },
    { date: "2026-07-27", totalUsd: 452, assetCount: 2, checkedAt: "2026-07-27T15:00:00.000Z" }
  ]);
});
