import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseUsmartStatement, usmartStatementDecision } from "../scripts/parse-usmart-statement.mjs";

const account = { provider: "usmart-hk", accountId: "12345678" };
const now = new Date("2026-10-30T06:00:00Z");
const header = "香港證監會中央編號SFC CE NO.BJA907\n地址：香港測試地址\n電話：+852 0000 0000 傳真：+852 0000 0001\n盈立證券有限公司 uSmart Securities Limited 郵箱：cs@usmarthk.com 網址：www.usmartsecurities.com";
const ordinary = "证券 币种 持有数量 已交收数量 收市价 市值 抵押比率 抵押市值";
const fractional = ordinary.replace("证券", "代码");
const options = "代码 币种 数量 乘数 最新价 市值 沽空保证金 成本价 持仓盈亏";
const shorts = "代码 币种 持有数量 已交收数量 收市价 市值 沽空保证金 持仓盈亏 抵押比率 抵押市值";
const three = (label, hkd, usd, cny = "--") => `${label} ${hkd} ${label} ${usd} ${label} ${cny}`;
function fixture() {
  return [
    ["证券合并日结单", "结单日期：2026-10-22", "印单日期：2026-10-27 11:00:00",
      "市场/币种 港股/HKD 市场/币种 美股/USD 市场/币种 A股通/CNY",
      three("账户号码", account.accountId, account.accountId),
      three("期初净资产", "100.00", "0.00"), three("期初证券市值", "0.00", "0.00"), three("期初账户结余", "100.00", "0.00"),
      three("期末净资产", "50.00", "120.00"), three("期末证券市值", "0.00", "150.00"), three("期末账户结余", "50.00", "-30.00"),
      three("待交收金额", "0.00", "-30.00"), three("期末抵押市值", "0.00", "75.00"), three("期末负债金额", "0.00", "-30.00")].join("\n"),
    "交易明细(港股)\n暂无数据\n交易明细(美股整股)\n暂无数据\n交易明细(美股期权)\n暂无数据\n交易明细(美股沽空)\n暂无数据\n交易明细(美股碎股)\n暂无数据\n交易明细(A股通)\n暂无数据",
    `持仓明细(港股)\n${ordinary}\n暂无数据\n持仓明细(美股整股)\n${ordinary}\nTEST (Synthetic stock) USD 10 5 15 150 50.00% 75\n持仓明细(美股期权)\n${options}\n暂无数据`,
    `持仓明细(美股沽空)\n${shorts}\n暂无数据\n持仓明细(美股碎股)\n${fractional}\n暂无数据\n持仓明细(A股通)\n${ordinary}\n暂无数据\n币种 HKD 币种 USD 币种 CNY\n${three("市值汇总", "0.0000", "150.0000", "0.0000")}\n${three("抵押市值汇总", "0.0000", "75.0000", "0.0000")}\n资金出入\n暂无数据\n证券提存\n暂无数据`,
    "融资利息\n币种 利率/年化 本月累计利息\nHKD 7.63% 0.00\nUSD 6.63% 0.17\n融券利息\n暂无数据\n重要提示\n1.The client acknowledges investment risks.",
    "11.No signature is required for this computer printout.",
    "13.Please inform us immediately of any changes in your personal information.\n如閣下之個人資料如有任何變更，敬請立即通知本公司。",
  ].map((page, index) => `${header}\n${page}\n${index + 1}`);
}
const parse = pages => parseUsmartStatement({ pages, expectedAccount: account, now });
const hash = value => createHash("sha256").update(value).digest("hex");

test("HK statements retain native currency, signed cash, held quantities and the asset date independently of print date", () => {
  const value = parse(fixture());
  assert.equal(value.provider, "usmart-hk");
  assert.equal(value.asOf, "2026-10-22");
  assert.equal(value.printedAt, "2026-10-27T11:00:00");
  assert.equal(value.printTimeZone, null);
  assert.equal(value.statementType, "daily");
  assert.deepEqual(value.balances.map(b => b.currency), ["HKD", "USD"]);
  const usd = value.balances[1];
  assert.equal(usd.netAssets, 120);
  assert.equal(usd.cash, -30);
  assert.equal(usd.securitiesValue + usd.cash, usd.netAssets);
  assert.equal(usd.unsettledAmount, -30);
  assert.equal(usd.debtAmount, -30);
  assert.equal(value.holdings[0].quantity, "10");
  assert.equal(value.holdings[0].settledQuantity, "5");
  assert.equal(value.requiresLedgerReconciliation, true);
  assert.equal(value.financialWrites, 0);
  assert.ok(value.reviewReasons.includes("signed-cash-or-debt"));
});

test("monthly statements use the actual statement date and do not manufacture CNY zero balances", () => {
  const pages = fixture().map(p => p.replace("证券合并日结单", "月结单").replace("2026-10-22", "2026-09-30"));
  const value = parse(pages);
  assert.equal(value.statementType, "monthly");
  assert.equal(value.asOf, "2026-09-30");
  assert.equal(value.balances.some(b => b.currency === "CNY"), false);
});

test("normalization handles the compatibility glyphs and fullwidth punctuation used by actual PDF extraction", () => {
  const pages = fixture().map(p => p.replaceAll("账户", "账⼾").replaceAll("香港", "⾹港").replaceAll("持仓明细(", "持仓明细（").replaceAll(")\n", "）\n"));
  assert.equal(parse(pages).holdings[0].quantity, "10");
});

test("collateral keeps four decimal places while the cover is rounded to cents", () => {
  const pages = fixture().map(p => p.replace("50.00% 75", "50.01% 75.015").replace("抵押市值汇总 75.0000", "抵押市值汇总 75.0150").replace("期末抵押市值 75.00", "期末抵押市值 75.02"));
  const value = parse(pages);
  assert.equal(value.holdings[0].collateralValue, 75.015);
  assert.equal(value.balances[1].collateralValue, 75.02);
  assert.equal(value.balances[1].netAssets, 120);
});

test("entity, bound account and currency-column identity are required", () => {
  for (const modify of [
    p => p.map(x => x.replace("BJA907", "OTHER")),
    p => p.map(x => x.replace("uSmart Securities Limited", "uSMART Singapore")),
    p => p.map(x => x.replaceAll(account.accountId, "99999999")),
    p => p.map(x => x.replace("港股/HKD", "港股/USD")),
    p => p.map(x => x.replace("期末净资产 --", "期末净资产 1.00")),
  ]) assert.throws(() => parse(modify(fixture())), /身份|账户|币种/);
  assert.throws(() => parseUsmartStatement({ pages: fixture(), expectedAccount: { ...account, provider: "usmart-sg" }, now }), /绑定/);
});

test("truncated, reordered and duplicated pages or missing holding sections cannot become complete statements", () => {
  const pages = fixture();
  for (const altered of [pages.slice(0, -1), [pages[0], pages[2], pages[1], ...pages.slice(3)], [...pages.slice(0, 3), pages[2], ...pages.slice(4)], pages.map(p => p.replace("持仓明细(美股碎股)", "缺少碎股")), pages.map(p => p.replace("融资利息\n", "缺少融资\n"))]) {
    assert.throws(() => parse(altered), /页面|完整|持仓|融资/);
  }
});

test("future, impossible and conflicting statement or print dates are rejected", () => {
  for (const modify of [
    p => p.map(x => x.replace("2026-10-22", "2026-02-30")),
    p => p.map(x => x.replace("2026-10-27 11:00:00", "2026-10-31 11:00:00")),
    p => p.map(x => x.replace("2026-10-27 11:00:00", "2026-10-21 11:00:00")),
    p => p.map(x => x.replace("2026-10-27 11:00:00", "2026-10-27 25:00:00")),
    p => p.map(x => x.replace("结单日期：2026-10-22", "结单日期：2026-10-22\n结单日期：2026-10-23")),
  ]) assert.throws(() => parse(modify(fixture())), /日期|时间/);
});

test("net assets, cover securities, complete holdings and collateral totals must reconcile", () => {
  for (const [old, replacement] of [
    ["期末净资产 120.00", "期末净资产 121.00"],
    ["市值汇总 150.0000", "市值汇总 151.0000"],
    ["期末抵押市值 75.00", "期末抵押市值 74.00"],
    ["10 5 15 150", "10 5 15 151"],
    ["50.00% 75", "50.00% 74"],
    ["期初净资产 100.00", "期初净资产 100.01"],
    ["期末证券市值 150.00", "期末证券市值 1,50.00"],
  ]) assert.throws(() => parse(fixture().map(p => p.replace(old, replacement))), /合计|核对|不一致|格式/);
});

test("unrecognized holdings, unknown currencies and settled quantities larger than held quantities stop review", () => {
  for (const row of [
    "TEST (Synthetic stock) EUR 10 5 15 150 50.00% 75",
    "TEST (Synthetic stock) USD 10 11 15 150 50.00% 75",
    "TEST (Synthetic stock) USD ten 5 15 150 50.00% 75",
    "TEST (Synthetic stock) USD 10 5 15 150 50.00% 75\nTEST (Synthetic stock) USD 10 5 15 150 50.00% 75",
    "TEST (Synthetic stock) USD 10 5 15 150 50.00% 75\nUNSUPPORTED 0 0 0",
  ]) assert.throws(() => parse(fixture().map(p => p.replace("TEST (Synthetic stock) USD 10 5 15 150 50.00% 75", row))), /持仓|币种|重复/);
});

test("nonempty options, shorts, fractional holdings and new table types are never silently dropped", () => {
  for (const table of [options, shorts, fractional]) {
    assert.throws(() => parse(fixture().map(p => p.replace(table + "\n暂无数据", table + "\nUNSUPPORTED USD 1 1 1 1"))), /未支持|持仓/);
  }
  assert.throws(() => parse(fixture().map(p => p.replace("资金出入", "持仓明细(其他产品)\n暂无数据\n资金出入"))), /未支持|持仓/);
});

test("original attachment hashes and statement dates control deduplication rather than reprint dates", () => {
  const statement = parse(fixture());
  const original = "a".repeat(64), different = "b".repeat(64);
  const source = { ...account, retainedAsOf: "2026-10-24", reviewedDocuments: [{ documentSha256: original, asOf: "2026-10-22" }] };
  const decide = (value, sha) => usmartStatementDecision({ statement: value, documentSha256: sha, source });
  assert.equal(decide(statement, original), "skip-already-reviewed");
  assert.equal(decide(statement, different), "skip-older-statement");
  assert.equal(decide({ ...statement, asOf: "2026-10-24" }, different), "review-same-date-changed-document");
  assert.equal(decide({ ...statement, asOf: "2026-10-25" }, different), "review-newer-statement");
  assert.throws(() => decide({ ...statement, asOf: "2026-10-23" }, original), /哈希|日期/);
  assert.throws(() => decide({ ...statement, accountId: "99999999" }, different), /绑定/);
});

test("CLI verifies original and decrypted hashes, writes only a private preview and never overwrites it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usmart-statement-"));
  try {
    const pdf = join(directory, "unlocked.pdf"), original = join(directory, "original.pdf"), source = join(directory, "source.json"), output = join(directory, "preview.json"), extractor = join(directory, "extractor");
    const bytes = "%PDF-1.7\nsynthetic unlocked fixture\n", encrypted = "%PDF-1.7\nsynthetic encrypted fixture\n";
    await writeFile(pdf, bytes, { mode: 0o600 }); await writeFile(original, encrypted, { mode: 0o600 });
    const binding = JSON.stringify({ ...account, retainedAsOf: "2026-10-21", reviewedDocuments: [], originalPdfPath: original, originalDocumentSha256: hash(encrypted), parsedDocumentSha256: hash(bytes) });
    await writeFile(source, binding, { mode: 0o600 });
    await writeFile(extractor, "#!/usr/bin/env node\nprocess.stdout.write(" + JSON.stringify(JSON.stringify(fixture())) + ");\n", { mode: 0o700 });
    const run = (target = output) => spawnSync(process.execPath, [resolve("scripts/parse-usmart-statement.mjs"), pdf, source, target], { encoding: "utf8", env: { ...process.env, USMART_STATEMENT_PYTHON: extractor } });
    const first = run(); assert.equal(first.status, 0, first.stderr);
    const preview = JSON.parse(await readFile(output, "utf8"));
    assert.equal(preview.documentSha256, hash(encrypted));
    assert.equal(preview.parsedDocumentSha256, hash(bytes));
    assert.equal(preview.decision, "review-newer-statement");
    assert.equal(preview.financialWrites, 0);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(await readFile(source, "utf8"), binding);
    assert.equal(await readFile(pdf, "utf8"), bytes);
    assert.equal(await readFile(original, "utf8"), encrypted);
    assert.equal(first.stdout.includes(account.accountId), false);
    const saved = await readFile(output, "utf8");
    assert.equal(run().status, 1); assert.equal(await readFile(output, "utf8"), saved);
    await writeFile(pdf, bytes + "tampered\n");
    const mismatch = run(join(directory, "must-not-exist.json"));
    assert.equal(mismatch.status, 1); assert.match(mismatch.stderr, /哈希/);
    await assert.rejects(readFile(join(directory, "must-not-exist.json")), { code: "ENOENT" });
    await chmod(source, 0o644);
    assert.match(run().stderr, /仅当前用户/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI rejects original attachment substitution before extraction and redacts external errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usmart-statement-errors-"));
  try {
    const pdf = join(directory, "unlocked.pdf"), original = join(directory, "original.pdf"), source = join(directory, "source.json"), output = join(directory, "preview.json"), extractor = join(directory, "extractor");
    const bytes = "%PDF-1.7\nsynthetic fixture\n";
    await writeFile(pdf, bytes, { mode: 0o600 }); await writeFile(original, bytes, { mode: 0o600 });
    await writeFile(source, JSON.stringify({ ...account, retainedAsOf: "2026-10-24", reviewedDocuments: [], originalPdfPath: original, originalDocumentSha256: hash(bytes), parsedDocumentSha256: hash(bytes) }), { mode: 0o600 });
    const run = () => spawnSync(process.execPath, [resolve("scripts/parse-usmart-statement.mjs"), pdf, source, output], { encoding: "utf8", env: { ...process.env, USMART_STATEMENT_PYTHON: extractor } });
    await writeFile(extractor, '#!/usr/bin/env node\nprocess.stderr.write("PRIVATE_EXTRACTOR_ERROR");process.exit(1);\n', { mode: 0o700 });
    await writeFile(original, bytes + "substituted\n");
    const mismatch = run(); assert.equal(mismatch.status, 1); assert.match(mismatch.stderr, /哈希/);
    await writeFile(original, bytes);
    const failure = run(); assert.equal(failure.status, 1); assert.match(failure.stderr, /现有资产未修改/);
    assert.doesNotMatch(failure.stderr + failure.stdout, /PRIVATE_EXTRACTOR_ERROR|12345678/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
