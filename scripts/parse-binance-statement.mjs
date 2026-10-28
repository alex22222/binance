import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const usdPattern = /([+-]?\d[\d,]*\.\d{2}) USD\b/g;
const walletNames = ["funding", "spotAndMargin", "futures", "options", "earn", "stock"];
const walletHeader = "Funding Spot & Margin Futures Options Earn Stock";
const fail = message => { throw Object.assign(new Error(message), { statementError: true }); };
const lines = text => text.replace(/\u2212/g, "-").split(/\r?\n/).map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean);
const amount = cents => Number(cents) / 100;
const financialRow = row => /^(?:[A-Z0-9._-]+\s+(?!\/).*\$|\$)/.test(row);

function cents(value, signed = true) {
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(value)) fail("结单金额格式无法核对");
  const result = BigInt(value.replace(/[,\.]/g, "").replace(/^\+/, ""));
  if ((!signed && result < 0n) || result < -100_000_000_000_000n || result > 100_000_000_000_000n) fail("结单金额超出支持范围");
  return result;
}

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + "T00:00:00Z"))
    || new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) fail("结单日期无效");
  return value;
}

function englishDate(value) {
  const match = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  const month = match && months.indexOf(match[1]);
  if (!match || month < 0) fail("结单英文日期无法核对");
  return date(`${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`);
}

function netValue(page, cover = false) {
  const rows = lines(page);
  const index = rows.findIndex(line => line.includes("Total Account Value (Net of Debt)"));
  if (index < 0) fail("结单缺少扣除负债后的账户净资产");
  const match = cover ? /Total Account Value \(Net of Debt\):\s*([+-]?\d[\d,]*\.\d{2}) USD\b/.exec(rows[index])
    : /^([+-]?\d[\d,]*\.\d{2}) USD\b/.exec(rows[index + 1] || "");
  if (!match) fail("结单净资产币种或版式未获支持；未转换为美元");
  return cents(match[1], false);
}

function wallets(page) {
  const rows = lines(page);
  const headers = rows.map((row, i) => row === walletHeader ? i : -1).filter(i => i >= 0);
  if (headers.length !== 1) fail("结单缺少完整钱包合计");
  const values = [...(rows[headers[0] + 1] || "").matchAll(usdPattern)];
  if (values.length !== walletNames.length || (rows[headers[0] + 1] || "").replace(usdPattern, "").trim()) fail("钱包币种或数量无法核对");
  return Object.fromEntries(walletNames.map((name, i) => [name, cents(values[i][1])]));
}

function sameWallets(first, second) {
  if (walletNames.some(name => first[name] !== second[name])) fail("合并摘要与账户明细的钱包金额不一致");
}

export function parseBinanceStatement({ pages, expectedAccount, now = new Date() }) {
  if (!Array.isArray(pages) || pages.length < 3 || pages.length > 200 || pages.some(p => typeof p !== "string" || !p.trim())
    || pages.reduce((size, p) => size + p.length, 0) > 4_000_000) fail("结单页面不完整或超出支持范围");
  if (!expectedAccount || !/^\d{1,20}$/.test(expectedAccount.accountUid) || typeof expectedAccount.accountEmail !== "string" || !expectedAccount.accountEmail.includes("@")) fail("需要已核实的结单账户绑定");
  const clean = pages.map(p => lines(p).join("\n"));
  const all = clean.join("\n");
  const last = clean.at(-1);
  if (!clean[0].includes("ACCOUNT STATEMENT") || !clean[1].includes("Wallet Value (Net of Debt)") || !last.includes("Account Balance Details")) fail("需要完整官方结单，不能只使用总览或前十大持仓");
  const ids = new Set([...all.matchAll(/Account ID:\s*(\d+)/g)].map(m => m[1]));
  if (ids.size !== 1 || !ids.has(expectedAccount.accountUid)) fail("结单账户不匹配或包含多个未核实账户");
  const email = expectedAccount.accountEmail.toLowerCase();
  const emails = new Set([...all.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(m => m[0].toLowerCase()));
  if (emails.size !== 1 || !emails.has(email) || !clean[0].toLowerCase().includes(email) || !last.toLowerCase().includes(email)) fail("结单邮箱身份不一致");
  const periods = [...all.matchAll(/([A-Za-z]+ \d{1,2}, \d{4}) - ([A-Za-z]+ \d{1,2}, \d{4})/g)].map(m => [englishDate(m[1]), englishDate(m[2])]);
  if (!periods.length || periods.some(p => p.join() !== periods[0].join())) fail("结单报告期间不一致");
  const [periodStart, asOf] = periods[0];
  const dates = [...all.matchAll(/Report Date:\s*(\d{4}\/\d{2}\/\d{2})/g)].map(m => date(m[1].replaceAll("/", "-")));
  const coverDate = /ACCOUNT STATEMENT\s+(\d{4}\/\d{2}\/\d{2})/.exec(clean[0]);
  if (!coverDate || !dates.length) fail("结单缺少报告生成日期");
  const reportDate = date(coverDate[1].replaceAll("/", "-"));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
  if (!Number.isFinite(now.getTime()) || dates.some(d => d !== reportDate) || periodStart > asOf || asOf > reportDate || reportDate > today) fail("结单日期冲突或晚于当前北京时间");
  for (const m of all.matchAll(/\(As of ([A-Za-z]+ \d{1,2}, \d{4})\)/g)) if (englishDate(m[1]) !== asOf) fail("持仓时点与结单期末不一致");
  const total = netValue(clean[0], true);
  if (netValue(clean[1]) !== total || netValue(last) !== total) fail("封面、合并摘要与账户明细的净资产不一致");
  const opening = /Your opening total account value:\s*([+-]?\d[\d,]*\.\d{2}) USD\b/.exec(clean[0]);
  const change = /Change value:\s*([+-]?\d[\d,]*\.\d{2}) USD\b/.exec(clean[0]);
  if (!opening || !change || cents(opening[1], false) + cents(change[1]) !== total) fail("期初、期间变动与期末净资产不一致");
  const walletValues = wallets(clean[1]);
  sameWallets(walletValues, wallets(last));
  if (Object.values(walletValues).reduce((a, b) => a + b, 0n) !== total) fail("钱包合计与账户净资产不一致");

  const holdingStart = clean.findIndex(p => p.includes("Crypto Holdings (As of"));
  if (holdingStart < 0) fail("缺少完整加密资产持仓报告，不能用前十大持仓替代");
  const holdings = [];
  const symbols = new Set();
  for (const page of clean.slice(holdingStart)) {
    if (page.includes("Stock Holdings (As of") || page.includes("Account Balance Details")) break;
    for (const row of page.split("\n")) {
      const m = /^([A-Z0-9._-]+)\s+(.+?)\s+\$([+-]?\d[\d,]*\.\d+)\s+\$[+-]?\d[\d,]*\.\d+\s+([+-]?\d[\d,]*\.\d+)\s+[+-]?\d[\d,]*\.\d+\s+\$([+-]?\d[\d,]*\.\d{2})\s+\$[+-]?\d[\d,]*\.\d{2}$/.exec(row);
      if (!m) { if (financialRow(row)) fail("完整持仓行无法识别，结单须重新核对"); continue; }
      if (symbols.has(m[1])) fail("完整持仓报告出现重复币种，需要重新核对账户范围");
      symbols.add(m[1]);
      holdings.push({ symbol: m[1], name: m[2], displayedPriceUsd: m[3].replaceAll(",", ""), displayedQuantity: m[4].replaceAll(",", ""), reportedValueUsd: amount(cents(m[5])), roundedZero: cents(m[5]) === 0n });
    }
  }
  if (walletValues.spotAndMargin > 0n && !holdings.length) fail("现货账户有资产但未解析到完整持仓明细");

  let futures = null;
  if (walletValues.futures !== 0n) {
    const balancePage = clean.find(p => p.includes("Futures Balances (As of") && p.includes("Report Period Margin Balance Wallet Balance Unrealized PnL"));
    if (!balancePage) fail("缺少合约保证金、钱包余额及浮盈的核对依据");
    const rows = balancePage.split("\n");
    const index = rows.findIndex(r => r === "Report Period Margin Balance Wallet Balance Unrealized PnL");
    const values = [...(rows[index + 1] || "").matchAll(usdPattern)].map(m => cents(m[1]));
    if (values.length !== 3 || values[0] !== walletValues.futures || values[1] + values[2] !== values[0]) fail("合约保证金权益未与钱包余额及浮盈对齐");
    const positionPages = clean.filter(p => p.includes("Futures Positions (As of"));
    if (!positionPages.length) fail("缺少合约持仓报告");
    const positions = [];
    for (const page of positionPages) for (const row of page.split("\n")) {
      const m = /^([A-Z0-9._-]+)\s+([+-]?\d[\d,]*\.\d+)\s+[+-]?\d[\d,]*\.\d+\s+\$([+-]?\d[\d,]*\.\d+)\s+\$[+-]?\d[\d,]*\.\d+\s+\$([+-]?\d[\d,]*\.\d{2})\s+\$[+-]?\d[\d,]*\.\d{2}$/.exec(row);
      if (!m && financialRow(row)) fail("完整合约行无法识别，结单须重新核对");
      if (m) positions.push({ symbol: m[1], displayedSize: m[2].replaceAll(",", ""), displayedMarkPriceUsd: m[3].replaceAll(",", ""), reportedUnrealizedPnlUsd: amount(cents(m[4])) });
    }
    if (values[2] !== 0n && !positions.length) fail("合约有浮盈但未解析到持仓");
    const positionPnl = positions.reduce((sum, p) => sum + cents(p.reportedUnrealizedPnlUsd.toFixed(2)), 0n);
    if (positionPnl !== values[2]) fail("合约持仓浮盈与账户浮盈不一致");
    futures = { marginBalanceUsd: amount(values[0]), walletBalanceUsd: amount(values[1]), unrealizedPnlUsd: amount(values[2]), includedInNetTotal: true, positions };
  }
  return { schemaVersion: 1, institution: "Binance exchange", accountUid: expectedAccount.accountUid, accountEmail: expectedAccount.accountEmail,
    periodStart, asOf, reportDate, currency: "USD", netAssets: amount(total), openingNetAssets: amount(cents(opening[1])), periodChange: amount(cents(change[1])),
    wallets: Object.fromEntries(walletNames.map(name => [name, amount(walletValues[name])])), holdings, futures, pages: pages.length,
    quantityBasis: "PDF displayed precision; not exact raw balances or automatic quote bindings", countedBasis: "total", requiresLedgerReconciliation: true, financialWrites: 0 };
}

export function statementDecision({ statement, documentSha256, watchState }) {
  if (!/^[a-f0-9]{64}$/.test(documentSha256) || !watchState || !/^[a-f0-9]{64}$/.test(watchState.lastDocumentSha256 || "")) fail("结单去重哈希或已接入来源状态无效");
  if (statement.accountUid !== watchState.accountUid || statement.accountEmail.toLowerCase() !== watchState.accountEmail?.toLowerCase()) fail("结单来源绑定不匹配");
  const lastDate = date(watchState.lastAcceptedAsOf);
  if (documentSha256 === watchState.lastDocumentSha256) {
    if (statement.asOf !== lastDate) fail("已接入哈希与结单日期冲突");
    return "skip-already-applied";
  }
  if (statement.asOf < lastDate) return "skip-older-statement";
  return statement.asOf === lastDate ? "review-same-date-changed-document" : "review-newer-statement";
}

const entryFile = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entryFile && import.meta.url === pathToFileURL(entryFile).href) {
  try {
    const [input, statePath, output] = process.argv.slice(2);
    if (!input || !statePath || !output || process.argv.length !== 5) fail("用法：node scripts/parse-binance-statement.mjs PDF 来源去重JSON 新预览JSON");
    if (new Set([resolve(input), resolve(statePath), resolve(output)]).size !== 3) fail("PDF、来源状态与预览输出必须使用不同文件");
    if ((await stat(statePath)).mode & 0o077) fail("结单来源状态文件必须仅当前用户可读写");
    const bytes = await readFile(input);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || bytes.length > 20_000_000) fail("输入须为不超过20MB的PDF文件");
    const watchState = JSON.parse(await readFile(statePath, "utf8"));
    const program = "import json,sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nif r.is_encrypted: raise ValueError('encrypted statement requires secure decryption first')\nif not 3<=len(r.pages)<=200: raise ValueError('unsupported page count')\nprint(json.dumps([p.extract_text(extraction_mode='layout') or '' for p in r.pages]))";
    const extracted = await execute(process.env.BINANCE_STATEMENT_PYTHON || "python3", ["-c", program, resolve(input)], { timeout: 30_000, maxBuffer: 8_000_000 });
    const statement = parseBinanceStatement({ pages: JSON.parse(extracted.stdout), expectedAccount: watchState });
    const documentSha256 = createHash("sha256").update(bytes).digest("hex");
    const decision = statementDecision({ statement, documentSha256, watchState });
    const preview = { parsedAt: new Date().toISOString(), documentSha256, decision, ...statement };
    const handle = await open(resolve(output), "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(preview, null, 2) + "\n"); } finally { await handle.close(); }
    console.log(JSON.stringify({ task: "binance-statement-preview", decision, pages: statement.pages, asOf: statement.asOf, financialWrites: 0 }));
  } catch (error) {
    console.error(error.statementError ? error.message : "结单预览未完成；请检查私有输入文件、Python/pypdf依赖和输出路径，现有资产未修改。");
    process.exitCode = 1;
  }
}
