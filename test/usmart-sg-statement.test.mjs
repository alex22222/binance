import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseUsmartSgStatement, usmartSgStatementDecision } from "../src/usmart-sg-statement.mjs";

const account = { provider: "usmart-sg", accountId: "12345678", sourceIdentityVerified: true, accountIdentityVerified: true };
const now = new Date("2026-11-14T00:00:00Z");
const empty = (name, header) => `${name}\n${header}\n暂无数据`;
function fixture() {
  return [
    `uSMART Securities (Singapore) Pte. Ltd.\nCMS Licence No. CMS101161\n月结单\n感谢您的支持,以下是您 HK 保证金账户 2026-10 的月结单。\n0.00\n证券市值\n1,800.00\n现金结余\n1,800.00\n资产净值\n0.00\n其他金融资产\n0.00\n结构性产品\n0.00\n基金\n账户号码 ${account.accountId} 结单日期 2026-10\n账户类型 MARGIN 账户 印单日期 2026-11-03 07:51:08\n市场/币种 港股/HKD 地址 Private address\n资产变动\n${empty("交易明细", "证券/编号 市场 买/卖 数量 币种 价格 金额 成交时间 交收日期")}\n${empty("股票持仓明细", "证券/编号 币种 持有数量 已交收数量 收市价 市值 抵押比率 抵押市值")}\n期初资产 期末资产\n期末净资产 1,800.00 待交收金额 0.00\n期末证券市值 0.00 期末抵押市值 0.00\n期末账户结余 1,800.00 期末负债金额 0.00\n期初净资产 1,800.00\n期初证券市值 0.00\n期初账户结余 1,800.00`,
    [empty("资金出入", "业务标志 币种 金额 时间 备注"), empty("证券提存", "业务类型 证券 数量 时间 备注"),
      "融资利息\n币种 利率/年化 本月累计利息\nHKD 7.88% 0.00",
      empty("结构性产品交易明细", "票据名称 交易市场 交易方向 交易数量 币种 价格 总金额 交易日期 交割日期"),
      empty("结构性产品持仓明细", "票据名称 币种 已交割数量 未交割数量 持有数量 价格 总金额 融资抵押比率 抵押市值"),
      empty("结构性产品事件记录", "票据名称 币种 事件 交割方式 数量 金额 整股股数 日期"),
      empty("基金交易明细", "基金名称 交易类别 币种 参考持仓市值 交易金额 手续费 确认金额 确认份额 确认价格 交易日期 完成日期"),
      empty("基金持仓明细", "基金名称 币种 基金持仓市值 持有份额 可用份额 单位净值 净值日期"), "基金分红明细"].join("\n"),
    ["基金名称 币种 参与份额 分红方式 每份分红 总分红 交收日期\n暂无数据",
      empty("其他金融资产交易记录-基金类", "产品名称 交易方向 交易币种 总金额 交易费用 成交金额 成交净值 成交数量 交易日期 交收日期 结算币种 结算总金额"),
      empty("其他金融资产交易记录-债券类", "产品名称 交易方向 交易币种 总金额 应计利息 交易费用 成交金额 成交净值 成交数量 交易日期 交收日期 结算币种 结算总金额"),
      empty("其他金融资产交易记录-股票类", "产品名称 交易方向 交易币种 总金额 交易费用 成交金额 成交价格 成交数量 交易日期 交收日期 结算币种 结算总金额"),
      empty("其他金融资产持仓明细", "产品名称 资产大类 交易币种 已交割数量 未交割数量 成本价 最新价格 持仓市值 结算币种 结算市值"),
      "NOTES AND IMPORTANT INFORMATION", ...Array.from({ length: 10 }, (_, i) => `${i + 1}. Official information.`),
      "注意事项和重要信息", ...Array.from({ length: 10 }, (_, i) => `${i + 1}. 官方提示。`)].join("\n"),
  ].map((page, i) => `${page}\n${i + 1}`);
}
const parse = pages => parseUsmartSgStatement({ pages, expectedAccount: account, now });

test("verified Singapore HKD cash-only monthly statement reconciles all asset sections and uses period end", () => {
  const value = parse(fixture());
  assert.equal(value.provider, "usmart-sg");
  assert.equal(value.institution, "uSMART Securities (Singapore) Pte. Ltd.");
  assert.equal(value.asOf, "2026-10-31");
  assert.equal(value.printedAt, "2026-11-03T07:51:08");
  assert.equal(value.printTimeZone, null);
  assert.deepEqual(value.balances, [{ currency: "HKD", netAssets: 1800, cash: 1800, securitiesValue: 0, unsettledAmount: 0, debtAmount: 0 }]);
  assert.deepEqual(value.holdings, []);
  assert.equal(value.financialWrites, 0);
  assert.equal(value.requiresLedgerReconciliation, true);
});

test("Singapore entity, independent binding, exact account and declared currency cannot be inferred from filename", () => {
  for (const [from, to] of [["CMS101161", "BJA907"], ["uSMART Securities (Singapore) Pte. Ltd.", "uSmart Securities Limited"], [account.accountId, "87654321"], ["港股/HKD", "港股/USD"]]) {
    assert.throws(() => parse(fixture().map(page => page.replace(from, to))));
  }
  for (const change of [{ provider: "usmart-hk" }, { sourceIdentityVerified: false }, { accountIdentityVerified: false }]) {
    assert.throws(() => parseUsmartSgStatement({ pages: fixture(), expectedAccount: { ...account, ...change }, now }), /绑定/);
  }
});

test("missing pages, duplicate sections and nonempty or unidentified financial rows never become zero holdings", () => {
  for (const pages of [fixture().slice(0, 2), [fixture()[0], fixture()[2], fixture()[1]], [...fixture(), fixture()[2]],
    fixture().map(p => p.replace("基金持仓明细\n", "未知持仓明细\n")),
    fixture().map(p => p.replace("股票持仓明细\n", "股票持仓明细\n股票持仓明细\n")),
    fixture().map(p => p.replace("0.00\n基金", "0.00\n基金\n100.00\n未知资产")),
    fixture().map(p => p.replace("暂无数据", "TEST USD 10 10 15 150")),
    fixture().map(p => p.replace("暂无数据", "暂无数据\nUNKNOWN 5.00"))]) assert.throws(() => parse(pages));
});

test("cover amounts, closing cash, zero securities, debt, unsettled amounts and cash movements must all reconcile", () => {
  for (const [from, to] of [["期末账户结余 1,800.00", "期末账户结余 1,799.99"], ["期初账户结余 1,800.00", "期初账户结余 1,799.99"],
    ["0.00\n基金", "10.00\n基金"], ["期末证券市值 0.00", "期末证券市值 1.00"], ["待交收金额 0.00", "待交收金额 0.01"],
    ["期末负债金额 0.00", "期末负债金额 -1.00"], ["HKD 7.88% 0.00", "HKD 7.88% 0.01"], ["1,800.00\n资产净值", "1,80.00\n资产净值"]]) {
    assert.throws(() => parse(fixture().map(p => p.replace(from, to))));
  }
});

test("month end handles leap years; impossible periods and future or premature print dates are rejected", () => {
  assert.equal(parse(fixture().map(p => p.replaceAll("2026-10", "2024-02"))).asOf, "2024-02-29");
  for (const [from, to] of [["2026-10", "2026-13"], ["2026-10", "2026-11"], ["2026-11-03 07:51:08", "2026-10-30 07:51:08"],
    ["2026-11-03 07:51:08", "2026-11-15 07:51:08"], ["2026-11-03 07:51:08", "2026-11-03 25:51:08"]]) {
    assert.throws(() => parse(fixture().map(p => p.replaceAll(from, to))), /日期|月份|时间/);
  }
});

test("review decisions deduplicate original attachment hashes and protect more recent records", () => {
  const statement = parse(fixture()), digest = "a".repeat(64);
  const source = { ...account, retainedAsOf: "2026-11-01", reviewedDocuments: [] };
  const decide = s => usmartSgStatementDecision({ statement, documentSha256: digest, source: s });
  assert.equal(decide(source), "skip-older-statement");
  assert.equal(decide({ ...source, retainedAsOf: "2026-10-30" }), "review-newer-statement");
  assert.equal(decide({ ...source, retainedAsOf: "2026-10-31" }), "review-same-date-changed-document");
  assert.equal(decide({ ...source, reviewedDocuments: [{ documentSha256: digest, asOf: "2026-10-31" }] }), "skip-already-reviewed");
  assert.throws(() => decide({ ...source, reviewedDocuments: [{ documentSha256: digest, asOf: "2026-10-30" }] }), /冲突/);
});

test("CLI uses SG binding despite an HK filename, preserves original PDFs and refuses invalid identity or hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usmart-sg-preview-"));
  try {
    const pdf = join(directory, "HK-unlocked.pdf"), original = join(directory, "HK-original.pdf"), source = join(directory, "source.json"), output = join(directory, "preview.json"), extractor = join(directory, "extractor");
    const bytes = "%PDF-1.7\nsynthetic unlocked fixture\n", originalBytes = "%PDF-1.7\nsynthetic original fixture\n";
    const hash = text => createHash("sha256").update(text).digest("hex");
    await writeFile(pdf, bytes, { mode: 0o600 }); await writeFile(original, originalBytes, { mode: 0o600 });
    await writeFile(extractor, "#!/usr/bin/env node\nprocess.stdout.write(" + JSON.stringify(JSON.stringify(fixture())) + ");\n", { mode: 0o700 });
    const bound = { ...account, retainedAsOf: "2026-10-30", reviewedDocuments: [], originalPdfPath: original, originalDocumentSha256: hash(originalBytes), parsedDocumentSha256: hash(bytes) };
    await writeFile(source, JSON.stringify(bound), { mode: 0o600 });
    const run = target => spawnSync(process.execPath, [resolve("scripts/parse-usmart-statement.mjs"), pdf, source, target], { encoding: "utf8", env: { ...process.env, USMART_STATEMENT_PYTHON: extractor } });
    const success = run(output); assert.equal(success.status, 0, success.stderr);
    const value = JSON.parse(await readFile(output, "utf8"));
    assert.equal(value.provider, "usmart-sg"); assert.equal(value.balances[0].cash, 1800);
    assert.equal(value.decision, "review-newer-statement"); assert.equal(value.financialWrites, 0);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.doesNotMatch(success.stdout, new RegExp(account.accountId));
    assert.equal(run(output).status, 1);
    for (const change of [{ accountIdentityVerified: false }, { provider: "usmart-hk" }, { originalDocumentSha256: "0".repeat(64) }]) {
      await writeFile(source, JSON.stringify({ ...bound, ...change }), { mode: 0o600 });
      const target = join(directory, "rejected.json"), result = run(target);
      assert.equal(result.status, 1); assert.doesNotMatch(result.stderr + result.stdout, new RegExp(account.accountId));
      await assert.rejects(readFile(target), { code: "ENOENT" });
    }
    assert.equal(await readFile(pdf, "utf8"), bytes); assert.equal(await readFile(original, "utf8"), originalBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
