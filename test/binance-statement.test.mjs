import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBinanceStatement, statementDecision } from "../scripts/parse-binance-statement.mjs";

const account = { accountUid: "123456789", accountEmail: "owner@example.com" };
const now = new Date("2026-10-28T15:00:00Z");
const header = "Report Period: October 21, 2026 - October 26, 2026\nReport Date: 2026/10/28\nAccount ID: 123456789";
const wallets = "Funding Spot & Margin Futures Options Earn Stock\n0.00 USD 30.00 USD 20.00 USD 0.00 USD 0.00 USD 0.00 USD";
function fixture() {
  return [
    "Report Date\nACCOUNT STATEMENT 2026/10/28\nReport Period\nOctober 21, 2026 - October 26, 2026 Summary for your account in this period\nAccount ID: 123456789\nAccount Email: owner@example.com\nYour opening total account value: 100.00 USD\nChange value: -50.00 USD\nTotal Account Value (Net of Debt): 50.00 USD",
    "CONSOLIDATED SUMMARY\nTotal Account Value (Net of Debt) Beginning Value / Change\n50.00 USD 100.00 USD / -50.00 USD\n" + header + "\nWallet Value (Net of Debt)\n" + wallets + "\nAsset Allocation Your Consolidated Top 10 Assets",
    "Futures Balances (As of October 26, 2026)\nReport Period Margin Balance Wallet Balance Unrealized PnL\nOctober 21, 2026 - October 26, 2026 20.00 USD 8.00 USD 12.00 USD\n" + header,
    "Futures Positions (As of October 26, 2026)\nSymbol Size Mark Price Unrealized PNL (USD)\nETHUSDT +0.020000 0.000000 $2,100.000000 $0.000000 $12.00 $0.00\n" + header,
    "Crypto Holdings (As of October 26, 2026)\n" + header + "\nBTC Bitcoin $10.000000 $0.000000 3.000000 0.000000 $30.00 $0.00\nUSDT TetherUS $1.000000 $0.000000 8.000000 0.000000 $8.00 $0.00\nDUST Example $0.000010 $0.000000 0.000100 0.000000 $0.00 $0.00",
    "ACCOUNT BREAKDOWN\nTotal Account Value (Net of Debt) Beginning Value/Change\n50.00 USD 100.00 USD / -50.00 USD\n" + header + "\nAccount Balance Details\nAccount ID:123456789\nowner@example.com 100.00 USD -50.00 USD 50.00 USD\n" + wallets,
  ];
}
const parse = pages => parseBinanceStatement({ pages, expectedAccount: account, now });

test("full statement retains native USD, source date and net equity including futures PnL once", () => {
  const value = parse(fixture());
  assert.equal(value.netAssets, 50);
  assert.equal(value.asOf, "2026-10-26");
  assert.equal(value.reportDate, "2026-10-28");
  assert.equal(value.currency, "USD");
  assert.equal(value.wallets.spotAndMargin + value.wallets.futures, value.netAssets);
  assert.equal(value.futures.marginBalanceUsd, 20);
  assert.equal(value.futures.walletBalanceUsd, 8);
  assert.equal(value.futures.unrealizedPnlUsd, 12);
  assert.equal(value.futures.positions[0].displayedSize, "+0.020000");
  assert.equal(value.holdings[2].roundedZero, true);
  assert.match(value.quantityBasis, /displayed precision/);
  assert.equal(value.countedBasis, "total");
  assert.equal(value.financialWrites, 0);
  assert.equal(value.requiresLedgerReconciliation, true);
});

test("wrong or additional account identities are rejected before preparing a preview", () => {
  for (const alter of [
    p => p.map(x => x.replaceAll("123456789", "999999999")),
    p => [...p.slice(0, -1), p.at(-1) + "\nAccount ID:999999999"],
    p => p.map(x => x.replaceAll("owner@example.com", "other@example.com")),
    p => [...p.slice(0, -1), p.at(-1) + "\nother@example.com"],
  ]) assert.throws(() => parse(alter(fixture())), /账户|邮箱/);
});

test("summary-only, missing holdings and missing account breakdown are not complete statements", () => {
  assert.throws(() => parse(fixture().slice(0, 2)), /不完整/);
  assert.throws(() => parse(fixture().filter(p => !p.startsWith("Crypto Holdings"))), /完整加密资产/);
  const pages = fixture(); pages[5] = pages[5].replace("Account Balance Details", "Top 10 accounts");
  assert.throws(() => parse(pages), /完整官方结单/);
});

test("different report dates, future dates and position-asOf conflicts are rejected", () => {
  for (const pages of [
    fixture().map((p, i) => i === 1 ? p.replace("2026/10/28", "2026/10/27") : p),
    fixture().map(p => p.replaceAll("2026/10/28", "2026/10/30")),
    fixture().map(p => p.replace("(As of October 26, 2026)", "(As of October 25, 2026)")),
    fixture().map((p, i) => i === 1 ? p.replace("October 21, 2026 - October 26, 2026", "October 20, 2026 - October 26, 2026") : p),
  ]) assert.throws(() => parse(pages), /日期|时点|期间/);
});

test("native report currency cannot be inferred from the website estimate setting", () => {
  assert.throws(() => parse(fixture().map(p => p.replaceAll("USD", "USDT"))), /币种|格式/);
});

test("cover, consolidated net assets and the final account breakdown must agree", () => {
  for (const index of [1, 5]) {
    const pages = fixture(); pages[index] = pages[index].replace("50.00 USD 100.00", "49.99 USD 100.00");
    assert.throws(() => parse(pages), /净资产不一致/);
  }
  const pages = fixture(); pages[0] = pages[0].replace("Change value: -50.00", "Change value: -49.00");
  assert.throws(() => parse(pages), /期初/);
});

test("missing wallets, conflicting wallet summaries or unreconciled totals retain old financial data", () => {
  for (const pages of [
    fixture().map(p => p.replaceAll("30.00 USD 20.00 USD", "29.99 USD 20.00 USD")),
    fixture().map((p, i) => i === 5 ? p.replace("30.00 USD 20.00 USD", "29.00 USD 21.00 USD") : p),
    fixture().map(p => p.replaceAll("Funding Spot & Margin Futures Options Earn Stock", "Funding Spot Futures")),
  ]) assert.throws(() => parse(pages), /钱包/);
});

test("futures margin, collateral and unrealized PnL must reconcile without notional double counting", () => {
  const pages = fixture(); pages[2] = pages[2].replace("20.00 USD 8.00 USD 12.00 USD", "20.00 USD 9.00 USD 12.00 USD");
  assert.throws(() => parse(pages), /合约保证金权益/);
  const positions = fixture(); positions[3] = positions[3].replace("$12.00 $0.00", "$11.00 $0.00");
  assert.throws(() => parse(positions), /持仓浮盈/);
  assert.throws(() => parse(fixture().filter(p => !p.startsWith("Futures Positions"))), /合约持仓/);
});

test("negative PnL is retained as signed evidence while net margin stays the counted value", () => {
  const pages = fixture().map((p, i) => i === 2 ? p.replace("20.00 USD 8.00 USD 12.00 USD", "20.00 USD 32.00 USD -12.00 USD") : i === 3 ? p.replace("$12.00 $0.00", "$-12.00 $0.00") : p);
  const value = parse(pages);
  assert.equal(value.netAssets, 50);
  assert.equal(value.futures.unrealizedPnlUsd, -12);
  assert.equal(value.futures.walletBalanceUsd, 32);
});

test("duplicate holding rows are rejected and rounded dust is retained as displayed evidence", () => {
  const pages = fixture(); pages[4] += "\nBTC Bitcoin $10.000000 $0.000000 3.000000 0.000000 $30.00 $0.00";
  assert.throws(() => parse(pages), /重复币种/);
  const value = parse(fixture());
  assert.equal(value.holdings[2].displayedQuantity, "0.000100");
  assert.equal(value.holdings[2].reportedValueUsd, 0);
  assert.equal(value.holdings[2].roundedZero, true);
});

test("an unsupported asset row cannot be silently omitted from a supposedly complete holdings report", () => {
  const pages = fixture();
  pages[4] += "\nNEW New Asset $2.000000 $0.000000 unknown 0.000000 $1.00 $0.00";
  assert.throws(() => parse(pages), /持仓行.*识别/);
});

test("an unsupported futures row cannot be dropped even when its displayed PnL is zero", () => {
  const pages = fixture();
  pages[3] += "\nBTCUSDT unknown 0.000000 $50,000.000000 $0.000000 $0.00 $0.00";
  assert.throws(() => parse(pages), /合约行.*识别/);
});

test("repeat and older statements cannot become a fresh financial update", () => {
  const statement = parse(fixture());
  const first = "a".repeat(64), second = "b".repeat(64);
  const watchState = { ...account, lastAcceptedAsOf: "2026-10-26", lastDocumentSha256: first };
  const decision = (documentSha256, patch = {}) => statementDecision({ statement, documentSha256, watchState: { ...watchState, ...patch } });
  assert.equal(decision(first), "skip-already-applied");
  assert.equal(decision(second), "review-same-date-changed-document");
  assert.equal(decision(second, { lastAcceptedAsOf: "2026-10-27" }), "skip-older-statement");
  assert.equal(decision(second, { lastAcceptedAsOf: "2026-10-25" }), "review-newer-statement");
  assert.throws(() => decision(first, { lastAcceptedAsOf: "2026-10-25" }), /哈希与结单日期/);
  assert.throws(() => decision(second, { accountUid: "999999999" }), /来源绑定/);
});

test("CLI writes a private preview only, preserves its inputs and refuses to overwrite a previous preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-statement-cli-"));
  try {
    const pdf = join(directory, "synthetic.pdf"), source = join(directory, "source.json"), output = join(directory, "preview.json"), extractor = join(directory, "extractor");
    const binding = JSON.stringify({ ...account, lastAcceptedAsOf: "2026-10-25", lastDocumentSha256: "a".repeat(64) });
    await writeFile(pdf, "%PDF-1.7\nsynthetic fixture\n", { mode: 0o600 });
    await writeFile(source, binding, { mode: 0o600 });
    await writeFile(extractor, "#!/usr/bin/env node\nprocess.stdout.write(" + JSON.stringify(JSON.stringify(fixture())) + ");\n", { mode: 0o700 });
    const run = () => spawnSync(process.execPath, [resolve("scripts/parse-binance-statement.mjs"), pdf, source, output], { env: { ...process.env, BINANCE_STATEMENT_PYTHON: extractor }, encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const preview = JSON.parse(await readFile(output, "utf8"));
    assert.equal(preview.decision, "review-newer-statement");
    assert.equal(preview.netAssets, 50);
    assert.equal(preview.financialWrites, 0);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(await readFile(source, "utf8"), binding);
    assert.equal(await readFile(pdf, "utf8"), "%PDF-1.7\nsynthetic fixture\n");
    assert.equal(first.stdout.includes(account.accountUid), false);
    assert.equal(first.stdout.includes(account.accountEmail), false);
    const saved = await readFile(output, "utf8");
    assert.equal(run().status, 1);
    assert.equal(await readFile(output, "utf8"), saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI rejects publicly readable source bindings before extraction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-statement-permissions-"));
  try {
    const pdf = join(directory, "input.pdf"), source = join(directory, "source.json"), output = join(directory, "preview.json");
    await writeFile(pdf, "%PDF-1.7\n", { mode: 0o600 });
    await writeFile(source, JSON.stringify({ ...account }), { mode: 0o600 });
    await chmod(source, 0o644);
    const result = spawnSync(process.execPath, [resolve("scripts/parse-binance-statement.mjs"), pdf, source, output], { encoding: "utf8", env: { ...process.env, BINANCE_STATEMENT_PYTHON: "/must-not-run" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /仅当前用户/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
