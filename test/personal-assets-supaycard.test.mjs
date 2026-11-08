import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyPortfolio, readPersonalAssets, savePersonalAssets, summarize } from "../src/personal-assets.mjs";

test("Supaycard saves two screenshot cash balances and counts them once without inventing an automatic source", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "supaycard-assets-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const portfolio = emptyPortfolio();
  const account = portfolio.accounts.find(row => row.platform === "Supaycard");
  assert.ok(account);
  assert.equal(portfolio.entries.length, 0);
  account.basis = "holdings";
  const asOf = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  portfolio.entries = [["grok", "Grok", 287.15], ["chatgpt", "ChatGPT", 100.50]].map(([id, name, amount]) => ({
    id: `supay-${id}`, accountId: account.id, kind: "holding", name: `${name} 卡现金余额`,
    category: "现金", currency: "USD", amount, asOf, asOfBasis: "imported", source: "screenshot",
  }));
  portfolio.entries.push({ ...portfolio.entries[0], id: "supay-reference", kind: "total", name: "两张卡合计（核对）", amount: 387.65 });
  portfolio.rates.USD = { value: 7, date: asOf };
  await savePersonalAssets({ stateDir, portfolio, revision: 0 });
  const saved = await readPersonalAssets({ stateDir });
  const summary = summarize(saved.portfolio);
  assert.equal(summary.included.length, 2);
  assert.equal(summary.excluded.length, 1);
  assert.ok(Math.abs(summary.total - 387.65 * 7) < 1e-9);
  assert.equal(summary.byCategory[0].name, "现金");
  assert.equal(summary.byPlatform[0].name, "Supaycard");
  assert.equal(summary.sleeves.core.value, summary.total);
  assert.ok(saved.portfolio.entries.every(row => row.source === "screenshot" && row.asOfBasis === "imported"));
});
