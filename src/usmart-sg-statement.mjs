const fail = message => { throw Object.assign(new Error(message), { statementError: true }); };
const normalize = page => page.normalize("NFKC").replaceAll("戶", "户").split(/\r?\n/).map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean);
const validHash = value => /^[a-f0-9]{64}$/.test(value || "");
const institution = "uSMART Securities (Singapore) Pte. Ltd.";
const emptySections = [
  ["交易明细", "证券/编号 市场 买/卖 数量 币种 价格 金额 成交时间 交收日期"],
  ["股票持仓明细", "证券/编号 币种 持有数量 已交收数量 收市价 市值 抵押比率 抵押市值"],
  ["资金出入", "业务标志 币种 金额 时间 备注"],
  ["证券提存", "业务类型 证券 数量 时间 备注"],
  ["结构性产品交易明细", "票据名称 交易市场 交易方向 交易数量 币种 价格 总金额 交易日期 交割日期"],
  ["结构性产品持仓明细", "票据名称 币种 已交割数量 未交割数量 持有数量 价格 总金额 融资抵押比率 抵押市值"],
  ["结构性产品事件记录", "票据名称 币种 事件 交割方式 数量 金额 整股股数 日期"],
  ["基金交易明细", "基金名称 交易类别 币种 参考持仓市值 交易金额 手续费 确认金额 确认份额 确认价格 交易日期 完成日期"],
  ["基金持仓明细", "基金名称 币种 基金持仓市值 持有份额 可用份额 单位净值 净值日期"],
  ["基金分红明细", "基金名称 币种 参与份额 分红方式 每份分红 总分红 交收日期"],
  ["其他金融资产交易记录-基金类", "产品名称 交易方向 交易币种 总金额 交易费用 成交金额 成交净值 成交数量 交易日期 交收日期 结算币种 结算总金额"],
  ["其他金融资产交易记录-债券类", "产品名称 交易方向 交易币种 总金额 应计利息 交易费用 成交金额 成交净值 成交数量 交易日期 交收日期 结算币种 结算总金额"],
  ["其他金融资产交易记录-股票类", "产品名称 交易方向 交易币种 总金额 交易费用 成交金额 成交价格 成交数量 交易日期 交收日期 结算币种 结算总金额"],
  ["其他金融资产持仓明细", "产品名称 资产大类 交易币种 已交割数量 未交割数量 成本价 最新价格 持仓市值 结算币种 结算市值"],
];

export function validateUsmartSgBinding(account) {
  if (account?.provider !== "usmart-sg" || !/^\d{6,20}$/.test(account.accountId || "")
    || account.sourceIdentityVerified !== true || account.accountIdentityVerified !== true) fail("需要独立核实的新加坡法律实体及账户绑定");
}

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || !Number.isFinite(Date.parse(value + "T00:00:00Z"))
    || new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) fail("结单日期无效");
  return value;
}

function money(value) {
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value || "")) fail("结单金额格式无法核对");
  const [whole, fraction = ""] = value.replaceAll(",", "").replace(/^-/, "").split(".");
  const result = BigInt(whole + fraction.padEnd(2, "0")) * (value.startsWith("-") ? -1n : 1n);
  if (result < 0n || result > 1_000_000_000_000n) fail("当前新加坡纯现金模板不支持负现金、负债或超限金额，须完整审阅");
  return result;
}

export function parseUsmartSgStatement({ pages, expectedAccount, now = new Date() }) {
  validateUsmartSgBinding(expectedAccount);
  if (!Array.isArray(pages) || pages.length !== 3 || pages.some(page => typeof page !== "string" || !page.trim() || page.length > 500_000)) fail("仅支持已验证的完整三页新加坡纯现金月结单");
  const clean = pages.map((page, i) => {
    const rows = normalize(page);
    if (rows.at(-1) !== String(i + 1)) fail("结单页面缺失、重复或顺序不一致");
    return rows.slice(0, -1);
  });
  const cover = clean[0], rows = clean.flat();
  if (cover[0] !== institution || cover[1] !== "CMS Licence No. CMS101161" || cover.filter(row => row === "月结单").length !== 1) fail("结单新加坡法律实体或月结单身份不匹配");
  const single = pattern => {
    const matches = rows.map(row => row.match(pattern)).filter(Boolean);
    if (matches.length !== 1) fail("结单账户、日期或金额字段缺失或重复");
    return matches[0];
  };
  const account = single(/^账户号码 (\d+) 结单日期 (\d{4}-\d{2})$/);
  if (account[1] !== expectedAccount.accountId || rows.filter(row => row.startsWith("账户号码 ")).length !== 1) fail("结单账户身份不匹配");
  const period = account[2], [year, month] = period.split("-").map(Number);
  if (year < 1900 || month < 1 || month > 12) fail("结单月份无效");
  const asOf = date(new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
  const greeting = `感谢您的支持,以下是您 HK 保证金账户 ${period} 的月结单。`;
  if (!rows.includes(greeting)) fail("结单账户类型或月份无法核对");
  const printed = single(/^账户类型 MARGIN 账户 印单日期 (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  const printDate = date(printed[1]), time = printed[2];
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)
    || asOf > printDate || printDate > new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now)) fail("结单月份、印单日期或时间冲突");
  const currency = single(/^市场\/币种 港股\/(\w+) 地址 .+$/)[1];
  if (currency !== "HKD" || rows.filter(row => row.startsWith("市场/币种 ")).length !== 1) fail("当前新加坡纯现金模板仅支持已核实的HKD币种列");

  const summaryTitle = "期初资产 期末资产", notesTitle = "NOTES AND IMPORTANT INFORMATION";
  const markers = [emptySections[0][0], emptySections[1][0], summaryTitle, ...emptySections.slice(2, 4).map(([name]) => name), "融资利息", ...emptySections.slice(4).map(([name]) => name), notesTitle];
  const positions = markers.map(name => {
    const found = rows.flatMap((row, i) => row === name ? [i] : []);
    if (found.length !== 1) fail("结单财务章节缺失或重复");
    return found[0];
  });
  if (positions.some((position, i) => i && position <= positions[i - 1])) fail("结单财务章节顺序无法核对");
  const sections = Object.fromEntries(markers.slice(0, -1).map((name, i) => [name, rows.slice(positions[i] + 1, positions[i + 1])]));
  for (const [name, header] of emptySections) {
    const block = sections[name];
    if (block.length !== 2 || block[0] !== header || block[1] !== "暂无数据") fail("存在未支持的非空交易、现金变动或持仓章节；不能当作零资产");
  }
  const interest = sections["融资利息"];
  if (interest.length !== 2 || interest[0] !== "币种 利率/年化 本月累计利息"
    || !/^HKD \d+(?:\.\d+)?% 0\.00$/.test(interest[1])) fail("融资利息或币种无法核对，保留原资产");
  const summary = sections[summaryTitle];
  const summaryPatterns = [/^期末净资产 (\S+) 待交收金额 (\S+)$/, /^期末证券市值 (\S+) 期末抵押市值 (\S+)$/,
    /^期末账户结余 (\S+) 期末负债金额 (\S+)$/, /^期初净资产 (\S+)$/, /^期初证券市值 (\S+)$/, /^期初账户结余 (\S+)$/];
  if (summary.length !== summaryPatterns.length) fail("账户汇总包含未识别项目");
  const totals = summaryPatterns.map((pattern, i) => {
    const match = summary[i].match(pattern);
    if (!match) fail("账户汇总列无法核对");
    return match.slice(1).map(money);
  });
  const netAssets = totals[0][0], cash = totals[2][0];
  const coverLabels = ["证券市值", "现金结余", "资产净值", "其他金融资产", "结构性产品", "基金"];
  const coverSummary = cover.slice(cover.indexOf(greeting) + 1, cover.indexOf(account[0]));
  if (coverSummary.length !== coverLabels.length * 2 || coverLabels.some((label, i) => coverSummary[i * 2 + 1] !== label)) fail("封面包含未识别资产类别或金额列");
  const coverValues = Object.fromEntries(coverLabels.map(label => {
    const found = cover.flatMap((row, i) => row === label ? [i] : []);
    if (found.length !== 1 || !found[0]) fail("封面资产汇总缺失或重复");
    return [label, money(cover[found[0] - 1])];
  }));
  if (netAssets !== cash || totals[0][1] !== 0n || totals[1].some(value => value !== 0n) || totals[2][1] !== 0n
    || totals[3][0] !== netAssets || totals[4][0] !== 0n || totals[5][0] !== cash || coverValues["现金结余"] !== cash || coverValues["资产净值"] !== netAssets
    || ["证券市值", "其他金融资产", "结构性产品", "基金"].some(label => coverValues[label] !== 0n)) fail("纯现金、完整持仓、负债与资产汇总核对不一致");
  const notes = rows.slice(positions.at(-1) + 1), numbers = notes.flatMap(row => row.match(/^(\d+)\. /)?.[1] || []);
  if (!notes.includes("注意事项和重要信息") || numbers.join(",") !== [...Array.from({ length: 10 }, (_, i) => String(i + 1)), ...Array.from({ length: 10 }, (_, i) => String(i + 1))].join(",")
    || !notes.at(-1).startsWith("10. ")) fail("末页中英文完整提示缺失，结单不完整");
  return { schemaVersion: 1, provider: "usmart-sg", institution, accountId: expectedAccount.accountId, statementType: "monthly", asOf, period,
    printedAt: `${printDate}T${time}`, printTimeZone: null, pages: pages.length, template: "sg-hkd-idle-cash-monthly",
    balances: [{ currency, netAssets: Number(netAssets) / 100, cash: Number(cash) / 100, securitiesValue: 0, unsettledAmount: 0, debtAmount: 0 }], holdings: [],
    requiresLedgerReconciliation: true, financialWrites: 0 };
}

export function usmartSgStatementDecision({ statement, documentSha256, source }) {
  validateUsmartSgBinding(source);
  if (statement.provider !== source.provider || statement.accountId !== source.accountId) fail("结单来源账户绑定不匹配");
  if (!validHash(documentSha256) || !Array.isArray(source.reviewedDocuments) || source.reviewedDocuments.some(row => !validHash(row.documentSha256))) fail("结单去重哈希或审阅记录无效");
  const retainedAsOf = date(source.retainedAsOf), asOf = date(statement.asOf), known = source.reviewedDocuments.filter(row => row.documentSha256 === documentSha256);
  if (known.some(row => date(row.asOf) !== asOf)) fail("已审阅哈希与结单日期冲突");
  if (known.length) return "skip-already-reviewed";
  if (asOf < retainedAsOf) return "skip-older-statement";
  return asOf === retainedAsOf ? "review-same-date-changed-document" : "review-newer-statement";
}
