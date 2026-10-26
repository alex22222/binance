import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATEGORIES,
  CURRENCIES,
  PLATFORMS,
  assetSleeve,
  csvTemplate,
  detectCurrency,
  emptyPortfolio,
  entryIdentity,
  extractOcrCandidates,
  parseCsv,
  summarize,
  validatePortfolio,
  nextAssetRefreshAt,
  readPersonalAssets,
  savePersonalAssets,
  createPersonalAssetsSnapshot,
} from "../src/personal-assets.mjs";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

test("asset refresh has one daily Beijing slot across UTC midnight", () => {
  assert.equal(nextAssetRefreshAt("2026-10-24T22:59:59Z"), "2026-10-24T23:00:00.000Z");
  assert.equal(nextAssetRefreshAt("2026-10-24T23:00:00Z"), "2026-10-25T23:00:00.000Z");
  assert.equal(nextAssetRefreshAt("2026-10-24T12:59:59Z"), "2026-10-24T23:00:00.000Z");
  assert.equal(nextAssetRefreshAt("2026-10-24T13:00:00Z"), "2026-10-24T23:00:00.000Z");
});

test("stock floating PnL is signed reference data, counted once per confirmed account and never added to assets", () => {
  const value = portfolio([entry(), entry({ id: "two", accountId: "account-2", currency: "USD", amount: 20 }), entry({ id: "pending", accountId: "account-3", amount: 50 })]);
  value.accounts[2].reviewStatus = "pending";
  value.rates.USD = { value: 7, date: today };
  value.stockPnl = [
    { accountId: "account-1", amount: -30, currency: "CNY", asOf: today, source: "screenshot", asOfBasis: "imported" },
    { accountId: "account-2", amount: 2, currency: "USD", asOf: today, source: "manual", asOfBasis: "statement" },
    { accountId: "account-3", amount: -999, currency: "CNY", asOf: today, source: "manual" },
  ];
  const clean = validatePortfolio(value);
  assert.deepEqual(clean.stockPnl, value.stockPnl);
  const summary = summarize(clean);
  assert.equal(summary.total, 240);
  assert.equal(summary.stockPnl.total, -16);
  assert.equal(summary.stockPnl.included.length, 2);
  assert.equal(summary.stockPnl.excluded.length, 1);
  delete clean.rates.USD;
  assert.equal(summarize(clean).stockPnl.total, -30);
  assert.equal(summarize(clean).stockPnl.missing.length, 1);
  assert.equal(summarize(portfolio([entry()])).stockPnl.total, null);
  for (const patch of [{ amount: NaN }, { amount: -1e13 }, { currency: "XYZ" }, { accountId: "absent" }, { asOf: "2099-01-01" }]) {
    assert.throws(() => validatePortfolio({ ...value, stockPnl: [{ ...value.stockPnl[0], ...patch }] }), /盈亏|账户|币种|日期/);
  }
  assert.throws(() => validatePortfolio({ ...value, stockPnl: [value.stockPnl[0], value.stockPnl[0]] }), /重复/);
});
test("API stock PnL retains a verified retrieval timestamp and rejects invalid provenance", () => {
  const value = portfolio([entry()]);
  const row = { accountId: "account-1", amount: -12, currency: "CNY", asOf: today, source: "api", asOfBasis: "imported", fetchedAt: new Date().toISOString() };
  value.stockPnl = [row]; assert.deepEqual(validatePortfolio(value).stockPnl, [row]);
  for (const patch of [{ fetchedAt: "invalid" }, { fetchedAt: "2099-01-01T00:00:00.000Z" }, { source: "screenshot" }]) {
    assert.throws(() => validatePortfolio({ ...value, stockPnl: [{ ...row, ...patch }] }), /盈亏.*读取/);
  }
});

function entry(overrides = {}) {
  return { id: "entry-1", accountId: "account-1", kind: "total", name: "账户总额", category: "未分类", currency: "CNY", amount: 100, asOf: today, source: "manual", ...overrides };
}
function portfolio(entries, overrides = {}) {
  return { ...emptyPortfolio(), entries, ...overrides };
}

test("new portfolios contain supported empty accounts and no invented balances or FX", () => {
  const value = emptyPortfolio();
  assert.deepEqual(value.accounts.map((account) => account.platform), PLATFORMS);
  assert.equal(value.entries.length, 0);
  assert.deepEqual(Object.keys(value.rates), ["CNY"]);
  assert.equal(summarize(value).total, null);
  assert.equal(CURRENCIES.includes("USDT"), true);
  assert.equal(CATEGORIES.includes("未分类"), true);
});

test("unattributed accounts start pending and legacy accounts remain confirmed by default", () => {
  const value = emptyPortfolio();
  assert.equal(PLATFORMS.includes("待确认"), true);
  const pending = value.accounts.find((account) => account.platform === "待确认");
  assert.equal(pending.reviewStatus, "pending");
  assert.equal(value.accounts.filter((account) => account.platform !== "待确认").length, PLATFORMS.length - 1);
  assert.equal(summarize(validatePortfolio(portfolio([entry()]))).total, 100);
  const legacy = validatePortfolio(portfolio([entry()]));
  assert.equal("reviewStatus" in legacy.accounts[0], false);
  assert.equal("asOfBasis" in legacy.entries[0], false);
  assert.equal("note" in legacy.entries[0], false);
});

test("pending accounts never contribute to totals, distributions or missing FX", () => {
  const value = portfolio([
    entry(),
    entry({ id: "pending-usd", accountId: "account-2", currency: "USD", amount: 1000, asOf: "2020-01-01" }),
    entry({ id: "pending-hkd", accountId: "account-3", currency: "HKD", amount: 2000 }),
  ]);
  value.accounts[1].reviewStatus = "pending";
  value.accounts[2].reviewStatus = "pending";
  value.rates.USD = { value: 7, date: today };
  const result = summarize(validatePortfolio(value));
  assert.equal(result.total, 100);
  assert.deepEqual(result.pending.map((row) => row.id), ["pending-usd", "pending-hkd"]);
  assert.deepEqual(result.excluded.map((row) => row.id), ["pending-usd", "pending-hkd"]);
  assert.deepEqual(result.included.map((row) => row.id), ["entry-1"]);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.byPlatform, [{ name: "汇丰基金", value: 100 }]);
  assert.deepEqual(result.byCategory, [{ name: "未分类", value: 100 }]);
  assert.deepEqual(result.byCurrency, [{ name: "CNY", value: 100 }]);
  value.entries = value.entries.slice(1);
  assert.equal(summarize(value).total, null);
});

test("unattributed platform remains excluded even if its status is confirmed or omitted", () => {
  for (const reviewStatus of ["confirmed", undefined]) {
    const value = portfolio([entry()]);
    value.accounts[0].platform = "待确认";
    if (reviewStatus !== undefined) value.accounts[0].reviewStatus = reviewStatus;
    const result = summarize(validatePortfolio(value));
    assert.equal(result.total, null);
    assert.deepEqual(result.pending.map((row) => row.id), ["entry-1"]);
    assert.deepEqual(result.excluded.map((row) => row.id), ["entry-1"]);
    assert.deepEqual(result.missing, []);
  }
});

test("account and entry provenance is preserved with explicit review and date bases", () => {
  const value = portfolio([entry({ source: "screenshot", note: "  截图未包含估值日期  ", asOfBasis: "imported" })]);
  value.accounts[0].reviewStatus = "pending";
  value.accounts[0].note = "  截图归属待核实  ";
  const validated = validatePortfolio(value);
  assert.equal(validated.accounts[0].reviewStatus, "pending");
  assert.equal(validated.accounts[0].note, "截图归属待核实");
  assert.equal(validated.entries[0].note, "截图未包含估值日期");
  assert.equal(validated.entries[0].asOfBasis, "imported");
  validated.accounts[0].reviewStatus = "confirmed";
  validated.entries[0].asOfBasis = "statement";
  assert.equal(validatePortfolio(validated).accounts[0].reviewStatus, "confirmed");
  assert.equal(validatePortfolio(validated).entries[0].asOfBasis, "statement");
  assert.equal(summarize(validated).total, 100);
});

test("notes accept 1000 characters or clearing and reject invalid types or excess length", () => {
  for (const note of ["", " ", "备".repeat(1000)]) {
    const value = portfolio([entry({ note })]);
    value.accounts[0].note = note;
    const validated = validatePortfolio(value);
    assert.equal(validated.accounts[0].note, note.trim());
    assert.equal(validated.entries[0].note, note.trim());
  }
  for (const note of ["备".repeat(1001), 123, null, {}]) {
    assert.throws(() => validatePortfolio(portfolio([entry({ note })])), /备注/);
    const value = portfolio([entry()]);
    value.accounts[0].note = note;
    assert.throws(() => validatePortfolio(value), /备注/);
  }
});

test("invalid review statuses and valuation date bases are rejected", () => {
  for (const reviewStatus of ["", "unknown", null, true]) {
    const value = portfolio([entry()]);
    value.accounts[0].reviewStatus = reviewStatus;
    assert.throws(() => validatePortfolio(value), /确认状态/);
  }
  for (const asOfBasis of ["", "ocr", null, 1]) {
    assert.throws(() => validatePortfolio(portfolio([entry({ asOfBasis })])), /日期依据/);
  }
});

test("exchange rate notes preserve source context and share the note validation rules", () => {
  for (const note of ["  合成测试来源；交叉换算  ", "", "备".repeat(1000)]) {
    const value = portfolio([entry({ currency: "USD" })]);
    value.rates.USD = { value: 7, date: today, note };
    const validated = validatePortfolio(value);
    assert.equal(validated.rates.USD.note, note.trim());
    assert.equal(summarize(validated).total, 700);
    assert.equal("note" in validated.rates.CNY, false);
  }
  for (const note of ["备".repeat(1001), 123, null, {}]) {
    const value = emptyPortfolio();
    value.rates.USD = { value: 7, date: today, note };
    assert.throws(() => validatePortfolio(value), /汇率备注/);
  }
});

test("account basis prevents totals and holdings from being counted twice", () => {
  const value = portfolio([entry(), entry({ id: "holding", kind: "holding", name: "基金", amount: 60 })]);
  assert.equal(summarize(value).total, 100);
  assert.deepEqual(summarize(value).excluded.map((row) => row.id), ["holding"]);
  value.accounts[0].basis = "holdings";
  assert.equal(summarize(value).total, 60);
});

test("new asset categories validate and import from explicit CSV categories", () => {
  const categories = ["定期存款", "股票ETF", "稳定币", "组合资产"];
  const value = emptyPortfolio();
  value.accounts[0].basis = "holdings";
  const csv = "平台,账户,类型,资产名称,类别,币种,金额,日期\n" + categories.map((category, index) => `汇丰基金,汇丰基金,持仓,资产${index},${category},CNY,100,${today}`).join("\n");
  for (const category of categories) {
    assert.equal(validatePortfolio(portfolio([entry({ category })])).entries[0].category, category);
  }
  value.entries = parseCsv(csv, value.accounts);
  const validated = validatePortfolio(value);
  assert.deepEqual(validated.entries.map((row) => row.category), categories);
  assert.equal(summarize(validated).total, 400);
  assert.deepEqual(new Set(summarize(validated).byCategory.map((row) => row.name)), new Set(categories));
});

test("category distributions separate stock ETFs, stablecoins, deposits and mixed portfolios", () => {
  const categories = ["现金", "股票", "股票ETF", "稳定币", "加密资产", "定期存款", "组合资产"];
  const amounts = [10, 20, 30, 2, 40, 50, 60];
  const value = portfolio(categories.map((category, index) => entry({
    id: `category-${index}`, kind: "holding", name: `资产${index}`, category, amount: amounts[index], currency: category === "稳定币" ? "USDT" : "CNY",
  })));
  value.accounts[0].basis = "holdings";
  value.rates.USDT = { value: 7, date: today };
  const result = summarize(validatePortfolio(value));
  assert.equal(result.total, 224);
  assert.deepEqual(Object.fromEntries(result.byCategory.map(({ name, value }) => [name, value])), {
    组合资产: 60, 定期存款: 50, 加密资产: 40, 股票ETF: 30, 股票: 20, 稳定币: 14, 现金: 10,
  });
  assert.equal(result.missing.length, 0);
  const explicit = validatePortfolio(portfolio([entry({ name: "USDT现金股票ETF", category: "未分类" })]));
  assert.equal(explicit.entries[0].category, "未分类");
  assert.deepEqual(summarize(explicit).byCategory, [{ name: "未分类", value: 100 }]);
});

test("the core/satellite rule classifies by category and index exposure and leaves mixed records unassigned", () => {
  const sleeve = (name, category, platform = "OKX") => {
    const { sleeve, group } = assetSleeve({ name, category }, { platform });
    return `${sleeve}:${group}`;
  };
  assert.equal(sleeve("汇丰环球货币基金", "货币基金"), "core:货币基金");
  assert.equal(sleeve("定期存款", "定期存款"), "core:现金与定期");
  assert.equal(sleeve("USDT0（X Layer）", "稳定币"), "core:USDT");
  assert.equal(sleeve("USDC", "稳定币"), "core:USDC");
  assert.equal(sleeve("Polymarket 资金（pUSD）", "稳定币"), "core:其他稳定币");
  assert.equal(sleeve("BTC（交易账户）", "加密资产"), "core:BTC");
  assert.equal(sleeve("WBTC", "加密资产"), "core:BTC");
  assert.equal(sleeve("BTCST", "加密资产"), "satellite:代币");
  assert.equal(sleeve("OKSOL", "加密资产"), "satellite:代币");
  assert.equal(sleeve("Vanguard 标普500 ETF（VOO）", "股票ETF"), "core:标普500");
  assert.equal(sleeve("SPYon · Ondo 代币化ETF（BNB Chain）", "股票ETF", "TokenPocket"), "core:标普500");
  assert.equal(sleeve("Invesco QQQ Trust", "股票ETF"), "core:纳指100");
  assert.equal(sleeve("SPYD 高股息", "股票ETF"), "satellite:股票与ETF");
  assert.equal(sleeve("隆基绿能", "股票"), "satellite:股票与ETF");
  assert.equal(sleeve("TSLAon", "股票", "币安Agentic Wallet"), "satellite:链上股票代币");
  for (const category of ["组合资产", "未分类", "基金", "债券", "其他"]) assert.equal(sleeve("账户净值", category), `unassigned:${category}`);

  const value = portfolio([
    entry({ id: "mmf", kind: "holding", name: "货基", category: "货币基金", amount: 60 }),
    entry({ id: "btc", kind: "holding", name: "BTC", category: "加密资产", amount: 10, currency: "USD" }),
    entry({ id: "stock", kind: "holding", name: "隆基绿能", category: "股票", amount: 50 }),
    entry({ id: "mix", kind: "holding", name: "账户净值", category: "组合资产", amount: 20 }),
  ]);
  value.accounts[0].basis = "holdings";
  value.rates.USD = { value: 7, date: today };
  const { total, sleeves } = summarize(validatePortfolio(value));
  assert.equal(total, 200);
  assert.deepEqual(sleeves.core, { value: 130, groups: [{ name: "BTC", value: 70 }, { name: "货币基金", value: 60 }] });
  assert.deepEqual(sleeves.satellite, { value: 50, groups: [{ name: "股票与ETF", value: 50 }] });
  assert.deepEqual(sleeves.unassigned, { value: 20, groups: [{ name: "组合资产", value: 20 }] });
  const empty = summarize(emptyPortfolio()).sleeves;
  assert.deepEqual(empty.core, { value: 0, groups: [] });
});

test("a reconciled synced breakdown classifies an account total and prediction markets are satellite", () => {
  const futu = "account-3";
  const holding = (id, name, category, currency, amount, overrides = {}) => entry({ id, accountId: futu, kind: "holding", name, category, currency, amount, source: "api", ...overrides });
  const build = (rows) => {
    const value = portfolio([
      entry({ id: "futu-total", accountId: futu, category: "组合资产", currency: "HKD", amount: 1000, source: "api" }),
      ...rows,
      entry({ id: "pm-yes", accountId: "account-11", kind: "holding", name: "Will X happen? · Yes", category: "组合资产", currency: "USD", amount: 10, source: "api" }),
    ]);
    value.rates.USD = { value: 7, date: today };
    value.rates.HKD = { value: 0.9, date: today };
    value.accounts[10].basis = "holdings";
    return summarize(validatePortfolio(value));
  };
  const pony = holding("pony", "Pony AI", "股票", "USD", 90);
  const voo = holding("voo", "Vanguard 标普500 ETF（VOO）", "股票ETF", "HKD", 300);
  const { total, sleeves } = build([pony, voo]);
  assert.equal(total, 970, "positions of a total counted account are never added to the total");
  assert.deepEqual(sleeves.lookedThrough, [futu]);
  assert.deepEqual(sleeves.core.groups, [{ name: "标普500", value: 270 }]);
  assert.deepEqual(sleeves.satellite.groups, [{ name: "股票与ETF", value: 630 }, { name: "预测市场", value: 70 }]);
  assert.deepEqual(sleeves.unassigned, { value: 0, groups: [] });

  const unassigned = (rows) => {
    const result = build(rows).sleeves;
    assert.deepEqual(result.lookedThrough, []);
    assert.deepEqual(result.unassigned.groups, [{ name: "组合资产", value: 900 }]);
  };
  unassigned([pony, { ...voo, amount: 330 }]);
  unassigned([pony, { ...voo, source: "manual" }]);
  unassigned([pony, { ...voo, currency: "SGD" }]);
  unassigned([]);
  assert.equal(assetSleeve({ name: "资金账户（汇总，类型待细分）", category: "组合资产", kind: "holding" }, { platform: "OKX" }).sleeve, "unassigned");
  assert.equal(assetSleeve({ name: "Will Y? · No", category: "组合资产", kind: "holding" }, { platform: "Future" }).group, "预测市场");
});

test("new categories retain account-basis and pending-account exclusions", () => {
  const value = portfolio([
    entry({ category: "组合资产", amount: 500 }),
    entry({ id: "etf-holding", kind: "holding", name: "资产明细", category: "股票ETF", amount: 100 }),
    entry({ id: "pending-stable", accountId: "account-2", category: "稳定币", currency: "USDT", amount: 200 }),
  ]);
  value.accounts[1].reviewStatus = "pending";
  value.rates.USDT = { value: 7, date: today };
  let result = summarize(validatePortfolio(value));
  assert.equal(result.total, 500);
  assert.deepEqual(result.byCategory, [{ name: "组合资产", value: 500 }]);
  assert.deepEqual(result.excluded.map((row) => row.id), ["etf-holding", "pending-stable"]);
  assert.deepEqual(result.pending.map((row) => row.id), ["pending-stable"]);
  assert.deepEqual(result.missing, []);
  value.accounts[0].basis = "holdings";
  result = summarize(validatePortfolio(value));
  assert.equal(result.total, 100);
  assert.deepEqual(result.byCategory, [{ name: "股票ETF", value: 100 }]);
  assert.deepEqual(result.excluded.map((row) => row.id), ["entry-1", "pending-stable"]);
});

test("missing currencies remain visible and USD is never used as a USDT rate", () => {
  const value = portfolio([
    entry(),
    entry({ id: "usd", accountId: "account-2", currency: "USD", amount: 10 }),
    entry({ id: "usdt", accountId: "account-3", currency: "USDT", amount: 20 }),
  ], { rates: { USD: { value: 7.1, date: today } } });
  const result = summarize(value);
  assert.equal(result.total, 171);
  assert.deepEqual(result.missing.map((row) => row.id), ["usdt"]);
  assert.deepEqual(result.byCurrency, [{ name: "CNY", value: 100 }, { name: "USD", value: 71 }]);
  assert.equal(summarize(portfolio([entry({ currency: "HKD" })])).total, null);
});

test("zero is recorded rather than treated as missing and CNY is always one", () => {
  assert.equal(summarize(portfolio([entry({ amount: 0 })])).total, 0);
  assert.equal(summarize(portfolio([entry()], { rates: { CNY: { value: 8, date: today } } })).total, 100);
});

test("duplicate IDs and multiple account total rows are rejected", () => {
  assert.throws(() => validatePortfolio(portfolio([entry(), entry({ amount: 200 })])), /重复/);
  assert.throws(() => validatePortfolio(portfolio([entry(), entry({ id: "another" })])), /总额/);
  const value = emptyPortfolio();
  value.accounts.push({ ...value.accounts[0] });
  assert.throws(() => validatePortfolio(value), /重复/);
});

test("reimported holdings are rejected across existing and newly parsed data", () => {
  const value = emptyPortfolio();
  const imported = parseCsv(`平台,账户,类型,资产名称,类别,币种,金额,日期\n汇丰基金,汇丰基金,持仓,基金A,基金,CNY,100,${today}`, value.accounts);
  value.entries = imported;
  const repeated = parseCsv(`平台,账户,类型,资产名称,类别,币种,金额,日期\n汇丰基金,汇丰基金,持仓,基金A,基金,CNY,100,${today}`, value.accounts);
  assert.notEqual(imported[0].id, repeated[0].id);
  assert.throws(() => validatePortfolio({ ...value, entries: [...imported, ...repeated] }), /重复/);
  assert.equal(validatePortfolio({ ...value, entries: [{ ...imported[0], amount: 120 }] }).entries[0].amount, 120);
  assert.throws(() => validatePortfolio({ ...value, entries: [...imported, { ...repeated[0], amount: 120 }] }), /重复/);
});

test("one current holding per normalized account, name and currency survives changing amount, date and category", () => {
  const holding = entry({ kind: "holding", name: "基金A" });
  for (const change of [{ name: "基金A ", amount: 200 }, { asOf: "2020-01-01" }, { category: "基金" }]) {
    assert.throws(() => validatePortfolio(portfolio([holding, { ...holding, id: "different", ...change }])), /重复/);
  }
  assert.equal(validatePortfolio(portfolio([holding, { ...holding, id: "different", currency: "USD" }])).entries.length, 2);
  assert.equal(validatePortfolio(portfolio([holding, { ...holding, id: "different", accountId: "account-2" }])).entries.length, 2);
  const csv = `平台,账户,类型,资产名称,类别,币种,金额,日期\n汇丰基金,汇丰基金,持仓,基金A,基金,CNY,100,${today}\n汇丰基金,汇丰基金,持仓,基金A ,其他,CNY,200,2020-01-01`;
  assert.throws(() => parseCsv(csv, emptyPortfolio().accounts), /重复/);
});

test("shared entry identity trims account and asset names and totals ignore name and currency", () => {
  const holding = entry({ kind: "holding", name: "基金A" });
  assert.equal(entryIdentity(holding), entryIdentity({ ...holding, accountId: " account-1 ", name: " 基金A " }));
  assert.notEqual(entryIdentity(holding), entryIdentity({ ...holding, currency: "USD" }));
  assert.equal(entryIdentity(entry()), entryIdentity(entry({ accountId: " account-1 ", name: "不同名称", currency: "USD" })));
  assert.notEqual(entryIdentity(entry()), entryIdentity(holding));
});

test("strict dates reject calendar overflow and future dates; summary excludes untrusted dates", () => {
  for (const asOf of ["2026-02-30", "2026-2-01", "2099-01-01", "", "not-a-date"]) {
    assert.throws(() => validatePortfolio(portfolio([entry({ asOf })])), /日期/);
    assert.equal(summarize(portfolio([entry({ asOf })])).total, null);
  }
  const old = summarize(portfolio([entry({ asOf: "2020-01-01" })]));
  assert.equal(old.stale.length, 1);
  assert.equal(old.total, 100);
});

test("negative, non-finite, excessive and string amounts are rejected", () => {
  for (const amount of [-1, Infinity, NaN, 1e13, "100", null]) {
    assert.throws(() => validatePortfolio(portfolio([entry({ amount })])), /金额/);
  }
  assert.throws(() => validatePortfolio(portfolio([entry({ accountId: "missing" })])), /账户/);
  assert.throws(() => validatePortfolio(portfolio([entry({ currency: "BAD" })])), /币种/);
  assert.throws(() => validatePortfolio(portfolio([entry({ category: "BAD" })])), /类别/);
  assert.throws(() => validatePortfolio({ ...emptyPortfolio(), entries: Array.from({ length: 5001 }, (_, i) => entry({ id: String(i) })) }), /5000/);
});

test("invalid FX dates and values are rejected and not used by summary", () => {
  for (const rate of [{ value: 0, date: today }, { value: -1, date: today }, { value: 7, date: "2099-01-01" }]) {
    const value = portfolio([entry({ currency: "USD" })], { rates: { USD: rate } });
    assert.throws(() => validatePortfolio(value), /汇率/);
    assert.equal(summarize(value).missing.length, 1);
  }
});

test("CSV supports BOM, CRLF, quoted commas, escaped quotes, and multiline names", () => {
  const csv = '\ufeff平台,账户,类型,资产名称,类别,币种,金额,日期\r\n汇丰基金,汇丰基金,持仓,"基金,\"\"稳健\"\"\nA",基金,CNY,"1,234.56",' + today + "\r\n";
  const rows = parseCsv(csv, emptyPortfolio().accounts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '基金,"稳健"\nA');
  assert.equal(rows[0].amount, 1234.56);
  assert.equal(rows[0].source, "csv");
  assert.equal(rows[0].kind, "holding");
});

test("CSV supports English aliases, canonical platform names and explicit account selection", () => {
  const rows = parseCsv(`platform,account,kind,name,category,currency,amount,asOf\nZABANK,ZA Bank,total,账户总额,现金,HKD,100,${today}`, emptyPortfolio().accounts);
  assert.equal(rows[0].accountId, "account-2");
  assert.equal(rows[0].currency, "HKD");
  assert.equal(parseCsv(`platform,account,kind,name,category,currency,amount,asOf\nZABANK,,total,账户总额,现金,HKD,100,${today}`, emptyPortfolio().accounts)[0].accountId, "account-2");
});

test("prediction market accounts validate and import separately without renumbering legacy accounts", () => {
  const value = emptyPortfolio();
  for (const platform of ["Polymarket", "Future"]) {
    value.accounts.push({ id: `synthetic-${platform}`, platform, name: `${platform} 合成账户`, basis: "total" });
  }
  value.entries = parseCsv(`平台,账户,类型,资产名称,类别,币种,金额,日期\nPolymarket,Polymarket 合成账户,总额,账户总额,其他,USD,100,${today}\nFuture,Future 合成账户,总额,账户总额,其他,USD,200,${today}`, value.accounts);
  value.rates.USD = { value: 7, date: today };
  const validated = validatePortfolio(value);
  assert.deepEqual(summarize(validated).byPlatform, [{ name: "Future", value: 1400 }, { name: "Polymarket", value: 700 }]);
  assert.equal(validated.accounts.find((account) => account.platform === "待确认").id, "account-8");
  assert.equal(validated.accounts.find((account) => account.platform === "民生银行").id, "account-9");
  assert.equal(validated.accounts.find((account) => account.platform === "TokenPocket").id, "account-10");
});

test("currency detection recognizes explicit codes, Chinese aliases and unambiguous symbols", () => {
  const samples = {
    CNY: ["CNY", "人民币", "RMB"], HKD: ["hkd", "港币", "港元", "HK$"], USD: ["USD", "美元", "美金", "US$"],
    USDT: ["USDT"], USDC: ["USDC"], EUR: ["欧元", "€"], GBP: ["英镑", "£"], JPY: ["日元", "日圆"],
    SGD: ["SGD", "新加坡元", "新币", "S$"], AUD: ["澳元", "澳币", "A$"],
  };
  for (const [currency, aliases] of Object.entries(samples)) for (const alias of aliases) {
    assert.deepEqual(detectCurrency(alias), { currency, candidates: [currency], ambiguous: false }, alias);
  }
});

test("currency detection leaves ambiguous symbols and mixed currencies for manual correction", () => {
  assert.deepEqual(detectCurrency("总资产 $100"), { currency: null, candidates: ["USD", "HKD", "SGD", "AUD"], ambiguous: true });
  assert.deepEqual(detectCurrency("账户净值 ￥8,000.00"), { currency: null, candidates: ["CNY", "JPY"], ambiguous: true });
  assert.deepEqual(detectCurrency("HKD 100；USD 20"), { currency: null, candidates: ["HKD", "USD"], ambiguous: true });
  assert.deepEqual(detectCurrency("总资产 USD 等值 100；现金 HKD 20"), { currency: null, candidates: ["USD", "HKD"], ambiguous: true });
  assert.deepEqual(detectCurrency("总资产 USD 等值 $100"), { currency: "USD", candidates: ["USD"], ambiguous: false });
  for (const value of ["富途账户", "Vanguard标普500ETF", "BTC 0.25", "USDT 数量 2422.3241", "数量 2422.324 USDT", "数量（USDC）10", "泰康美元货币基金", "USDStock"]) {
    assert.deepEqual(detectCurrency(value), { currency: null, candidates: [], ambiguous: false }, value);
  }
});

test("explicit valuation currency takes precedence over token quantities without assuming stablecoin parity", () => {
  assert.deepEqual(detectCurrency("USDT 数量 2422.32411617，金额是截图 USD 估值"), { currency: "USD", candidates: ["USD"], ambiguous: false });
  assert.deepEqual(detectCurrency("数量 2422.324 USDT；USD 估值 2419.17"), { currency: "USD", candidates: ["USD"], ambiguous: false });
  assert.deepEqual(detectCurrency("USDT数量2422；USD估值2419"), { currency: "USD", candidates: ["USD"], ambiguous: false });
  assert.deepEqual(detectCurrency("估值币种：港元；BTC 数量 0.2"), { currency: "HKD", candidates: ["HKD"], ambiguous: false });
  assert.deepEqual(detectCurrency("USDT 100；USDC 20"), { currency: null, candidates: ["USDT", "USDC"], ambiguous: true });
});

test("CSV canonicalizes explicit currency aliases without relaxing amounts or guessing from names", () => {
  const header = "平台,账户,类型,资产名称,类别,币种,金额,日期\n";
  for (const [alias, currency] of [["人民币", "CNY"], ["港币", "HKD"], ["美元", "USD"], ["日元", "JPY"], ["S$", "SGD"], ["A$", "AUD"], ["€", "EUR"], ["£", "GBP"]]) {
    assert.equal(parseCsv(header + `汇丰基金,汇丰基金,持仓,合成资产,其他,${alias},100,${today}`, emptyPortfolio().accounts)[0].currency, currency);
  }
  for (const currency of ["$", "¥", "", "美元股票"]) assert.throws(() => parseCsv(header + `汇丰基金,汇丰基金,持仓,USD股票,其他,${currency},100,${today}`, emptyPortfolio().accounts), /币种/);
  for (const amount of ["1e3", "1万", "100 USD", "+100", "12.34.56"]) assert.throws(() => parseCsv(header + `汇丰基金,汇丰基金,持仓,合成资产,其他,美元,${amount},${today}`, emptyPortfolio().accounts), /金额/);
});

test("CSV rejects malformed, unknown, invalid and duplicate rows with readable errors", () => {
  const header = "平台,账户,类型,资产名称,类别,币种,金额,日期\n";
  for (const row of [
    `汇丰基金,汇丰基金,总额,总额,其他,CNY,abc,${today}`,
    `汇丰基金,汇丰基金,总额,总额,其他,CNY,-1,${today}`,
    `汇丰基金,汇丰基金,总额,总额,其他,CNY,100,2026-02-30`,
    `未知,未知,总额,总额,其他,CNY,100,${today}`,
    `汇丰基金,汇丰基金,奇怪类型,总额,其他,CNY,100,${today}`,
    `汇丰基金,汇丰基金,总额,"未结束,其他,CNY,100,${today}`,
  ]) assert.throws(() => parseCsv(header + row, emptyPortfolio().accounts), /CSV/);
  const row = `汇丰基金,汇丰基金,总额,总额,其他,CNY,100,${today}`;
  assert.throws(() => parseCsv(header + row + "\n" + row, emptyPortfolio().accounts), /总额/);
  const holding = row.replace("总额,总额", "持仓,基金");
  assert.throws(() => parseCsv(header + holding + "\n" + holding, emptyPortfolio().accounts), /重复/);
  assert.throws(() => parseCsv("platform,amount\n汇丰基金,100", emptyPortfolio().accounts), /表头/);
});

test("CSV kind aliases reject object prototype property names", () => {
  for (const kind of ["constructor", "__proto__", "toString"]) {
    const csv = `平台,账户,类型,资产名称,类别,币种,金额,日期\n汇丰基金,汇丰基金,${kind},总额,其他,CNY,100,${today}`;
    assert.throws(() => parseCsv(csv, emptyPortfolio().accounts), /类型/);
  }
});

test("CSV template contains headers only and never pretends sample assets are real", () => {
  assert.equal(csvTemplate().trim(), "平台,账户,类型,资产名称,类别,币种,金额,日期");
  assert.deepEqual(parseCsv(csvTemplate(), emptyPortfolio().accounts), []);
});

test("OCR candidates understand currency and Chinese magnitude without silently assigning currency", () => {
  const result = extractOcrCandidates("总资产 HKD 12.5万\n资产净值 1,234.56 USD\n总额 2万\nBTC 0.25\n收益率 12.5%\n更新时间 2026-10-24");
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(({ amount, currency }) => [amount, currency]), [[125000, "HKD"], [1234.56, "USD"], [20000, undefined]]);
  assert.equal(extractOcrCandidates("总资产 USDT 1000")[0].currency, "USDT");
  assert.equal(extractOcrCandidates("总资产 1.2亿元")[0].amount, 120000000);
});

test("OCR keeps candidate labels and ignores negative P&L, dates and percentages", () => {
  assert.deepEqual(extractOcrCandidates("浮动盈亏 -100 USD\n收益率 USD 12%\n总资产 2026-10-24"), []);
  assert.match(extractOcrCandidates("账户净值 ￥8,000.00")[0].label, /账户净值/);
  assert.equal(extractOcrCandidates("账户净值 ￥8,000.00")[0].currency, undefined);
});

test("OCR recognizes parenthesized report currencies and carries a header only to its adjacent amount", () => {
  const result = extractOcrCandidates("总资产（USD 等值）\n$5,959.53\n现金余额（港币）20.00\n总市值（日元）\n¥12,000\n普通说明\n100");
  assert.deepEqual(result.map(({ amount, currency }) => [amount, currency]), [[5959.53, "USD"], [20, "HKD"], [12000, "JPY"]]);
  assert.match(result[0].label, /USD/);
  assert.deepEqual(extractOcrCandidates("总资产（USD）\n\n100"), []);
});

test("OCR matches each amount to its own currency and never treats token quantities as valuations", () => {
  const result = extractOcrCandidates("总资产 USD 100；现金 HKD 20\nUSDT 数量 2422.32411617，持有金额 USD 2419.17\n总资产 $50\n净资产 ¥100\nBTC 0.25\nUSDC 数量 10\n总资产 USDT 1000");
  assert.deepEqual(result.map(({ amount, currency }) => [amount, currency]), [[100, "USD"], [20, "HKD"], [2419.17, "USD"], [50, undefined], [100, undefined], [1000, "USDT"]]);
  for (const text of ["现金 USD 100 HKD 20", "现金 100 USD 20 HKD", "总资产 USD 等值 100；现金 HKD 20"]) {
    assert.deepEqual(extractOcrCandidates(text).map(({ amount, currency }) => [amount, currency]), [[100, "USD"], [20, "HKD"]], text);
  }
  assert.deepEqual(extractOcrCandidates("USDT 数量 2422，USD 估值 2419.17").map(({ amount, currency }) => [amount, currency]), [[2419.17, "USD"]]);
  for (const text of ["USDT 持仓市值 2419.17", "USDC 市值 2419.17"]) assert.deepEqual(extractOcrCandidates(text).map(({ amount, currency }) => [amount, currency]), [[2419.17, undefined]], text);
  assert.deepEqual(extractOcrCandidates("估值币种 USDT；市值 100").map(({ amount, currency }) => [amount, currency]), [[100, "USDT"]]);
});

test("OCR rejects P&L, signed changes, dates, percentages and share quantities beside report currencies", () => {
  assert.deepEqual(extractOcrCandidates("今日收益 USD +2\n持仓盈亏 USD -10\n1周收益 USD 5\n未实现利润 HKD 10\n已实现损益 USD 2\n总资产 -100 USD\n总资产 USD +100\n总资产 USD 12%\n总资产 2026-10-24\n总资产 10/24\n总资产 17:14\n持有数量 USD 10\n持仓 100股 USD\n资产数量（USDT）2422.32"), []);
  assert.deepEqual(extractOcrCandidates("余额 €1,234.56\n余额 S$100\n余额 A$200").map(({ amount, currency }) => [amount, currency]), [[1234.56, "EUR"], [100, "SGD"], [200, "AUD"]]);
});

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "binance-personal-assets-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("existing legacy categories remain readable in saved state and immutable snapshots", async (context) => {
  const stateDir = await fixture(context);
  const categories = ["现金", "货币基金", "股票", "基金", "债券", "加密资产", "其他", "未分类"];
  const legacy = portfolio(categories.map((category, index) => entry({ id: `legacy-${index}`, kind: "holding", name: `旧资产${index}`, category })));
  legacy.accounts = legacy.accounts.filter((account) => account.platform !== "待确认");
  legacy.accounts[0].basis = "holdings";
  await writeFile(join(stateDir, "personal-assets.json"), JSON.stringify({
    schemaVersion: 1, revision: 1, updatedAt: new Date().toISOString(), portfolio: legacy, snapshots: [],
  }));
  const loaded = await readPersonalAssets({ stateDir });
  assert.deepEqual(loaded.portfolio.entries.map((row) => row.category), categories);
  assert.equal(summarize(loaded.portfolio).total, 800);
  const snapshot = await createPersonalAssetsSnapshot({ stateDir, revision: 1 });
  const path = join(stateDir, "personal-assets-snapshots", `${snapshot.snapshots[0].id}.json`);
  const before = await readFile(path, "utf8");
  const historic = JSON.parse(before);
  assert.deepEqual(validatePortfolio(historic.portfolio).entries.map((row) => row.category), categories);
  assert.equal(historic.total, 800);
  legacy.entries[0].category = "股票ETF";
  await savePersonalAssets({ stateDir, portfolio: legacy, revision: 1 });
  assert.equal((await readPersonalAssets({ stateDir })).portfolio.entries[0].category, "股票ETF");
  assert.equal(await readFile(path, "utf8"), before);
});

test("empty asset reads invent no balances and create no files", async (context) => {
  const directory = await fixture(context);
  const stateDir = join(directory, "not-yet-created");
  const current = await readPersonalAssets({ stateDir });
  assert.equal(current.revision, 0);
  assert.equal(current.updatedAt, null);
  assert.deepEqual(current.portfolio.entries, []);
  assert.deepEqual(current.snapshots, []);
  await assert.rejects(stat(stateDir), { code: "ENOENT" });
});

test("asset saves use a separate private atomic file and preserve unrelated shared state", async (context) => {
  const stateDir = await fixture(context);
  await chmod(stateDir, 0o755);
  await writeFile(join(stateDir, "state.json"), '{"bot":"unchanged"}\n');
  const mode = (await stat(stateDir)).mode & 0o777;
  const saved = await savePersonalAssets({ stateDir, portfolio: portfolio([entry()]), revision: 0 });
  assert.equal(saved.revision, 1);
  assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
  assert.deepEqual(await readPersonalAssets({ stateDir }), saved);
  assert.equal((await stat(join(stateDir, "personal-assets.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(stateDir)).mode & 0o777, mode);
  assert.equal(await readFile(join(stateDir, "state.json"), "utf8"), '{"bot":"unchanged"}\n');
  assert.deepEqual((await readdir(stateDir)).sort(), ["personal-assets.json", "state.json"]);
});

test("new asset storage directories are private", async (context) => {
  const stateDir = join(await fixture(context), "private-assets");
  await savePersonalAssets({ stateDir, portfolio: emptyPortfolio(), revision: 0 });
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
});

test("pending screenshot details and provenance survive save, reload and snapshot without entering totals", async (context) => {
  const stateDir = await fixture(context);
  const value = portfolio([entry({ source: "screenshot", currency: "USD", note: "  合成截图待归属  ", asOfBasis: "imported" })]);
  value.accounts[0].reviewStatus = "pending";
  value.accounts[0].note = "  合成账户待核实  ";
  value.rates.USD = { value: 7, date: today, note: "  合成测试汇率来源  " };
  const expected = validatePortfolio(value);
  const saved = await savePersonalAssets({ stateDir, portfolio: value, revision: 0 });
  assert.deepEqual(saved.portfolio, expected);
  assert.deepEqual((await readPersonalAssets({ stateDir })).portfolio, expected);
  const snapshot = await createPersonalAssetsSnapshot({ stateDir, revision: 1 });
  assert.equal(snapshot.snapshots[0].total, null);
  assert.equal(snapshot.snapshots[0].missing, 0);
  const stored = JSON.parse(await readFile(join(stateDir, "personal-assets-snapshots", `${snapshot.snapshots[0].id}.json`), "utf8"));
  assert.deepEqual(stored.portfolio, expected);
  assert.deepEqual(summarize(stored.portfolio).pending.map((row) => row.id), ["entry-1"]);
});

test("invalid asset changes and stale revisions leave saved bytes unchanged", async (context) => {
  const stateDir = await fixture(context);
  await savePersonalAssets({ stateDir, portfolio: portfolio([entry()]), revision: 0 });
  const before = await readFile(join(stateDir, "personal-assets.json"), "utf8");
  await assert.rejects(savePersonalAssets({ stateDir, portfolio: portfolio([entry({ amount: -1 })]), revision: 1 }), { status: 400 });
  await assert.rejects(savePersonalAssets({ stateDir, portfolio: emptyPortfolio(), revision: 0 }), { status: 409 });
  await assert.rejects(savePersonalAssets({ stateDir, portfolio: emptyPortfolio(), revision: "1" }), { status: 400 });
  assert.equal(await readFile(join(stateDir, "personal-assets.json"), "utf8"), before);
});

test("concurrent updates accept one revision and retain exactly one complete portfolio", async (context) => {
  const stateDir = await fixture(context);
  const results = await Promise.allSettled([10, 20, 30].map((amount) => savePersonalAssets({ stateDir, portfolio: portfolio([entry({ amount })]), revision: 0 })));
  const successful = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(successful.length, 1);
  assert.deepEqual(rejected.map((result) => result.reason.status), [409, 409]);
  assert.deepEqual(await readPersonalAssets({ stateDir }), successful[0].value);
  assert.deepEqual(await readdir(stateDir), ["personal-assets.json"]);
});

test("separate Node processes cannot overwrite the same asset revision", async (context) => {
  const stateDir = await fixture(context);
  const moduleUrl = new URL("../src/personal-assets.mjs", import.meta.url).href;
  const program = `import { savePersonalAssets, emptyPortfolio } from ${JSON.stringify(moduleUrl)};
    const portfolio = emptyPortfolio();
    portfolio.accounts[0].name = process.argv[2];
    try { await savePersonalAssets({ stateDir: process.argv[1], portfolio, revision: 0 }); process.stdout.write("saved"); }
    catch (error) { process.stdout.write(String(error.status || "unexpected")); }`;
  const results = await Promise.all(["first", "second"].map((name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program, stateDir, name], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { errors += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(errors)));
  })));
  assert.deepEqual(results.sort(), ["409", "saved"]);
  const current = await readPersonalAssets({ stateDir });
  assert.equal(current.revision, 1);
  assert.ok(["first", "second"].includes(current.portfolio.accounts[0].name));
});

test("a pre-existing writer lock is never stolen or removed", async (context) => {
  const stateDir = await fixture(context);
  const lock = join(stateDir, "personal-assets.json.lock");
  await writeFile(lock, "other writer");
  await assert.rejects(savePersonalAssets({ stateDir, portfolio: emptyPortfolio(), revision: 0 }), { status: 409 });
  assert.equal(await readFile(lock, "utf8"), "other writer");
  await assert.rejects(stat(join(stateDir, "personal-assets.json")), { code: "ENOENT" });
});

test("snapshot metadata is bounded, idempotent and separate from full immutable history", async (context) => {
  const stateDir = await fixture(context);
  const original = portfolio([entry(), entry({ id: "usd", accountId: "account-2", currency: "USD", amount: 20 })]);
  await savePersonalAssets({ stateDir, portfolio: original, revision: 0 });
  const first = await createPersonalAssetsSnapshot({ stateDir, revision: 1 });
  assert.equal(first.revision, 1);
  assert.equal(first.snapshots.length, 1);
  assert.equal(first.snapshots[0].total, 100);
  assert.equal(first.snapshots[0].missing, 1);
  assert.equal(first.snapshots[0].entries, 2);
  assert.equal("portfolio" in first.snapshots[0], false);
  const snapshotPath = join(stateDir, "personal-assets-snapshots", `${first.snapshots[0].id}.json`);
  const stored = JSON.parse(await readFile(snapshotPath, "utf8"));
  assert.deepEqual(stored.portfolio, original);
  assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateDir, "personal-assets-snapshots"))).mode & 0o777, 0o700);
  assert.deepEqual(await createPersonalAssetsSnapshot({ stateDir, revision: 1 }), first);
  await savePersonalAssets({ stateDir, portfolio: portfolio([entry({ amount: 999 })]), revision: 1 });
  const second = await createPersonalAssetsSnapshot({ stateDir, revision: 2 });
  assert.equal(second.snapshots.length, 2);
  assert.equal(second.snapshots[0].total, 999);
  assert.equal(second.snapshots[1].id, first.snapshots[0].id);
  assert.deepEqual(JSON.parse(await readFile(snapshotPath, "utf8")), stored);
  assert.equal("portfolio" in JSON.parse(await readFile(join(stateDir, "personal-assets.json"), "utf8")).snapshots[0], false);
  await assert.rejects(createPersonalAssetsSnapshot({ stateDir, revision: 1 }), { status: 409 });
});

test("concurrent snapshot requests create one full history file", async (context) => {
  const stateDir = await fixture(context);
  await savePersonalAssets({ stateDir, portfolio: portfolio([entry()]), revision: 0 });
  const [first, second] = await Promise.all([1, 2].map(() => createPersonalAssetsSnapshot({ stateDir, revision: 1 })));
  assert.deepEqual(first, second);
  assert.equal((await readdir(join(stateDir, "personal-assets-snapshots"))).length, 1);
});

test("corrupt or oversized saved assets fail closed without overwriting original bytes", async (context) => {
  const stateDir = await fixture(context);
  const path = join(stateDir, "personal-assets.json");
  for (const source of ["{", JSON.stringify({ schemaVersion: 99 }), " ".repeat(8_000_001)]) {
    await writeFile(path, source);
    await assert.rejects(readPersonalAssets({ stateDir }), { status: 500 });
    await assert.rejects(savePersonalAssets({ stateDir, portfolio: emptyPortfolio(), revision: 0 }), { status: 500 });
    assert.equal(await readFile(path, "utf8"), source);
  }
});

test("empty snapshots are rejected without creating asset state", async (context) => {
  const stateDir = await fixture(context);
  await assert.rejects(createPersonalAssetsSnapshot({ stateDir, revision: 0 }), { status: 400 });
  assert.deepEqual(await readdir(stateDir), []);
});

test("full snapshot history rejects additions without deleting or overwriting history", async (context) => {
  const stateDir = await fixture(context);
  const current = await savePersonalAssets({ stateDir, portfolio: portfolio([entry()]), revision: 0 });
  current.revision = 501;
  current.snapshots = Array.from({ length: 500 }, (_, index) => ({
    id: randomUUID(), at: new Date().toISOString(), revision: index + 1, total: 100, missing: 0, entries: 1,
  }));
  const path = join(stateDir, "personal-assets.json");
  const before = JSON.stringify(current);
  await writeFile(path, before);
  await assert.rejects(createPersonalAssetsSnapshot({ stateDir, revision: 501 }), { status: 400 });
  assert.equal(await readFile(path, "utf8"), before);
  await assert.rejects(stat(join(stateDir, "personal-assets-snapshots")), { code: "ENOENT" });
});
