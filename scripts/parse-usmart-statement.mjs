import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const currencies = ["HKD", "USD", "CNY"];
const markets = ["港股", "美股整股", "美股期权", "美股沽空", "美股碎股", "A股通"];
const ordinaryHeader = "证券 币种 持有数量 已交收数量 收市价 市值 抵押比率 抵押市值";
const tableHeaders = [ordinaryHeader, ordinaryHeader, "代码 币种 数量 乘数 最新价 市值 沽空保证金 成本价 持仓盈亏",
  "代码 币种 持有数量 已交收数量 收市价 市值 沽空保证金 持仓盈亏 抵押比率 抵押市值", ordinaryHeader.replace("证券", "代码"), ordinaryHeader];
const fail = message => { throw Object.assign(new Error(message), { statementError: true }); };
const lines = text => text.normalize("NFKC").replaceAll("戶", "户").split(/\r?\n/).map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean);
const amount = value => Number(value) / 10_000;
const cents = value => (value < 0n ? -1n : 1n) * (((value < 0n ? -value : value) + 50n) / 100n);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const validHash = value => /^[a-f0-9]{64}$/.test(value || "");

function decimal(value, places = 4, signed = true) {
  if (!new RegExp(`^[+-]?(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d{1,${places}})?$`).test(value)) fail("结单金额或持仓数字格式无法核对");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replaceAll(",", "").replace(/^[+-]/, "").split(".");
  const result = BigInt(whole + fraction.padEnd(places, "0")) * (negative ? -1n : 1n);
  const limit = 10_000_000_000n * 10n ** BigInt(places);
  if ((!signed && result < 0n) || result < -limit || result > limit) fail("结单金额或持仓数字超出支持范围");
  return result;
}

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + "T00:00:00Z"))
    || new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) fail("结单日期无效");
  return value;
}

function binding(account) {
  if (account?.provider !== "usmart-hk" || !/^\d{6,20}$/.test(account.accountId || "")) fail("需要已核实的盈立香港账户绑定");
}

function triple(rows, label) {
  const matches = rows.filter(row => row.startsWith(label + " "));
  if (matches.length !== 1) fail("结单币种汇总缺失、重复或版式无法核对");
  const parts = matches[0].split(label + " ");
  if (parts.length !== 4 || parts[0] || parts.slice(1).some(p => !p.trim() || /\s/.test(p.trim()))) fail("结单币种列无法核对");
  return parts.slice(1).map(p => p.trim());
}

export function parseUsmartStatement({ pages, expectedAccount, now = new Date() }) {
  binding(expectedAccount);
  if (!Array.isArray(pages) || pages.length < 3 || pages.length > 200 || pages.some(p => typeof p !== "string" || !p.trim())
    || pages.reduce((size, p) => size + p.length, 0) > 4_000_000) fail("结单页面不完整或超出支持范围");
  const clean = pages.map((page, index) => {
    const rows = lines(page);
    if (rows[0] !== "香港證監會中央編號SFC CE NO.BJA907" || !rows[1]?.startsWith("地址:") || !rows[2]?.startsWith("電話:")
      || rows[3] !== "盈立證券有限公司 uSmart Securities Limited 郵箱:cs@usmarthk.com 網址:www.usmartsecurities.com") fail("结单法律实体身份无法核对；仅支持已验证的香港版式");
    if (rows.at(-1) !== String(index + 1)) fail("结单页面缺失、重复或顺序不一致");
    return rows.slice(4, -1);
  });
  const rows = clean.flat(), all = rows.join("\n"), cover = clean[0];
  const statementType = cover[0] === "证券合并日结单" ? "daily" : cover[0] === "月结单" ? "monthly" : null;
  if (!statementType || !clean.at(-1).includes("13.Please inform us immediately of any changes in your personal information.")
    || !rows.includes("融资利息") || !rows.includes("融券利息") || !rows.includes("证券提存") || !rows.includes("重要提示")) fail("需要完整官方结单，包含融资、提存及末页提示");
  const dates = [...all.matchAll(/^结单日期:\s*(\d{4}-\d{2}-\d{2})$/gm)];
  const printed = [...all.matchAll(/^印单日期:\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/gm)];
  if (dates.length !== 1 || printed.length !== 1 || !Number.isFinite(now.getTime())) fail("结单日期或印单时间缺失或重复");
  const asOf = date(dates[0][1]), printDate = date(printed[0][1]), time = printed[0][2];
  const printedAt = `${printDate}T${time}`;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time) || asOf > printDate || printDate > today) fail("结单日期或印单时间冲突或晚于当前日期");
  if (!cover.includes("市场/币种 港股/HKD 市场/币种 美股/USD 市场/币种 A股通/CNY")) fail("结单市场和币种列无法核对");
  const accounts = triple(cover, "账户号码");
  if (accounts.every(id => id === "--") || accounts.some(id => id !== "--" && id !== expectedAccount.accountId)
    || [...all.matchAll(/账户号码 (\d+|--)/g)].some(m => m[1] !== "--" && m[1] !== expectedAccount.accountId)) fail("结单账户身份不匹配");
  const fields = { openingNetAssets: "期初净资产", openingSecuritiesValue: "期初证券市值", openingCash: "期初账户结余",
    netAssets: "期末净资产", securitiesValue: "期末证券市值", cash: "期末账户结余", unsettledAmount: "待交收金额", collateralValue: "期末抵押市值", debtAmount: "期末负债金额" };
  const values = Object.fromEntries(Object.entries(fields).map(([key, label]) => [key, triple(cover, label)]));
  const balances = [];
  for (const [index, currency] of currencies.entries()) {
    if (accounts[index] === "--") {
      if (Object.values(values).some(v => v[index] !== "--")) fail("未启用币种账户出现未绑定金额");
      continue;
    }
    const value = Object.fromEntries(Object.entries(values).map(([key, amounts]) => [key, decimal(amounts[index])]));
    if (value.securitiesValue < 0n || value.collateralValue < 0n) fail("负证券或抵押市值持仓未支持，须人工核对");
    if (value.openingNetAssets !== value.openingSecuritiesValue + value.openingCash || value.netAssets !== value.securitiesValue + value.cash) fail("账户净资产与证券、现金合计不一致");
    balances.push({ currency, ...value });
  }

  const starts = rows.map((row, index) => row.startsWith("持仓明细(") ? index : -1).filter(index => index >= 0);
  if (starts.length !== markets.length || starts.some((index, i) => rows[index] !== `持仓明细(${markets[i]})`)) fail("完整持仓分区缺失、重复或存在未支持的持仓类型");
  const end = rows.indexOf("币种 HKD 币种 USD 币种 CNY", starts.at(-1));
  if (end < 0 || rows[end + 3] !== "资金出入") fail("完整持仓币种汇总或资金出入部分缺失");
  const holdings = [], keys = new Set();
  for (const [section, start] of starts.entries()) {
    const table = rows.slice(start + 1, starts[section + 1] ?? end);
    if (table[0] !== tableHeaders[section]) fail("持仓明细表头版式未支持");
    const data = table.slice(1);
    if (data.length === 1 && data[0] === "暂无数据") continue;
    if (!data.length || [2, 3, 4].includes(section)) fail("非空期权、沽空或碎股持仓版式未支持，须重新核对");
    for (const row of data) {
      const m = /^([A-Z0-9][A-Z0-9.-]*) \(([^()]*)\) ([A-Z]{3}) (\d+) (\d+) ([\d.,]+) ([\d.,]+) ([\d.]+)% ([\d.,]+)$/.exec(row);
      if (!m) fail("完整持仓行无法识别，不能静默略过");
      const currency = currencies[section === 0 ? 0 : section === 1 ? 1 : 2];
      if (m[3] !== currency || !balances.some(b => b.currency === currency)) fail("持仓币种与已绑定市场不一致");
      const quantity = BigInt(m[4]), settled = BigInt(m[5]);
      if (quantity > 10_000_000_000n || settled > quantity) fail("持仓数量与已交收数量无法核对");
      const price = decimal(m[6], 8, false), value = decimal(m[7], 4, false), ratio = decimal(m[8], 2, false), collateral = decimal(m[9], 4, false);
      if (ratio > 10_000n || (quantity * price + 5_000n) / 10_000n !== value || (value * ratio + 5_000n) / 10_000n !== collateral) fail("持仓收市价、市值或抵押金额核对不一致");
      const key = `${currency}:${m[1]}`;
      if (keys.has(key)) fail("持仓代码重复，须核对账户范围");
      keys.add(key);
      holdings.push({ symbol: m[1], name: m[2], market: markets[section], currency, quantity: m[4], settledQuantity: m[5], closingPrice: m[6].replaceAll(",", ""), value, collateral });
    }
  }
  const totals = triple(rows.slice(end, end + 3), "市值汇总").map(v => decimal(v));
  const margins = triple(rows.slice(end, end + 3), "抵押市值汇总").map(v => decimal(v));
  for (const [index, currency] of currencies.entries()) {
    const securities = holdings.filter(h => h.currency === currency).reduce((sum, h) => sum + h.value, 0n);
    const collateral = holdings.filter(h => h.currency === currency).reduce((sum, h) => sum + h.collateral, 0n);
    const coverBalance = balances.find(b => b.currency === currency);
    if (securities !== totals[index] || collateral !== margins[index] || cents(totals[index]) !== cents(coverBalance?.securitiesValue ?? 0n)
      || cents(margins[index]) !== cents(coverBalance?.collateralValue ?? 0n)) fail("持仓及抵押合计与币种汇总、账户证券市值不一致");
  }
  return { schemaVersion: 1, provider: "usmart-hk", institution: "uSmart Securities Limited", accountId: expectedAccount.accountId, statementType, asOf, printedAt, printTimeZone: null,
    balances: balances.map(b => Object.fromEntries(Object.entries(b).map(([key, value]) => [key, typeof value === "bigint" ? amount(value) : value]))),
    holdings: holdings.map(({ value, collateral, ...holding }) => ({ ...holding, marketValue: amount(value), collateralValue: amount(collateral) })), pages: pages.length,
    reviewReasons: balances.some(b => b.cash < 0n || b.debtAmount !== 0n) ? ["signed-cash-or-debt"] : [],
    quantityBasis: "PDF held quantity; settled quantity is separate; no automatic quote binding", countedBasis: "per-currency net assets; debt and unsettled cash already represented, collateral is not extra assets",
    requiresLedgerReconciliation: true, financialWrites: 0 };
}

export function usmartStatementDecision({ statement, documentSha256, source }) {
  binding(source);
  if (statement.provider !== source.provider || statement.accountId !== source.accountId) fail("结单来源账户绑定不匹配");
  if (!validHash(documentSha256) || !Array.isArray(source.reviewedDocuments) || source.reviewedDocuments.some(d => !validHash(d.documentSha256))) fail("结单去重哈希或审阅记录无效");
  const retainedAsOf = date(source.retainedAsOf), asOf = date(statement.asOf);
  const known = source.reviewedDocuments.filter(d => d.documentSha256 === documentSha256);
  if (known.some(d => date(d.asOf) !== asOf)) fail("已审阅哈希与结单日期冲突");
  if (known.length) return "skip-already-reviewed";
  if (asOf < retainedAsOf) return "skip-older-statement";
  return asOf === retainedAsOf ? "review-same-date-changed-document" : "review-newer-statement";
}

async function pdfBytes(path) {
  if ((await stat(path)).size > 20_000_000) fail("输入须为不超过20MB的PDF文件");
  const bytes = await readFile(path);
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) fail("输入须为PDF文件");
  return bytes;
}

const entryFile = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entryFile && import.meta.url === pathToFileURL(entryFile).href) {
  try {
    const [input, sourcePath, output] = process.argv.slice(2);
    if (!input || !sourcePath || !output || process.argv.length !== 5) fail("用法：node scripts/parse-usmart-statement.mjs 已解密PDF 来源绑定JSON 新预览JSON");
    if (new Set([resolve(input), resolve(sourcePath), resolve(output)]).size !== 3) fail("PDF、来源绑定与预览必须使用不同文件");
    if ((await stat(sourcePath)).mode & 0o077) fail("结单来源绑定文件必须仅当前用户可读写");
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    binding(source);
    if (!source.originalPdfPath || !validHash(source.originalDocumentSha256) || !validHash(source.parsedDocumentSha256)) fail("需要原始附件与安全解密副本的哈希绑定");
    const inputBytes = await pdfBytes(input), originalBytes = await pdfBytes(resolve(dirname(resolve(sourcePath)), source.originalPdfPath));
    if (sha256(originalBytes) !== source.originalDocumentSha256 || sha256(inputBytes) !== source.parsedDocumentSha256) fail("原始附件或解密副本哈希不匹配，预览已停止");
    const program = "import json,sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nif r.is_encrypted: raise ValueError('secure decryption required first')\nif not 3<=len(r.pages)<=200: raise ValueError('unsupported page count')\nprint(json.dumps([p.extract_text() or '' for p in r.pages]))";
    const extracted = await execute(process.env.USMART_STATEMENT_PYTHON || "python3", ["-c", program, resolve(input)], { timeout: 30_000, maxBuffer: 8_000_000 });
    const statement = parseUsmartStatement({ pages: JSON.parse(extracted.stdout), expectedAccount: source });
    const decision = usmartStatementDecision({ statement, documentSha256: source.originalDocumentSha256, source });
    const preview = { parsedAt: new Date().toISOString(), documentSha256: source.originalDocumentSha256, parsedDocumentSha256: source.parsedDocumentSha256, decision, ...statement };
    const handle = await open(resolve(output), "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(preview, null, 2) + "\n"); } finally { await handle.close(); }
    console.log(JSON.stringify({ task: "usmart-statement-preview", decision, pages: statement.pages, asOf: statement.asOf, financialWrites: 0 }));
  } catch (error) {
    console.error(error.statementError ? error.message : "结单预览未完成；请检查私有输入文件、Python/pypdf依赖和输出路径，现有资产未修改。");
    process.exitCode = 1;
  }
}
