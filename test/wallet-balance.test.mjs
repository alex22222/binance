import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAssetTrend,
  summarizeWalletBalances,
  upsertWalletBalanceSnapshot
} from "../src/wallet-balance.mjs";

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
