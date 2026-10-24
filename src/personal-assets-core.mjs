export const PLATFORMS = ["汇丰基金", "ZA Bank", "富途", "盈立", "OKX", "币安", "A股", "待确认", "民生银行", "TokenPocket", "Polymarket", "Future", "币安Agentic Wallet", "OKX Agentic Wallet"];
export const CURRENCIES = ["CNY", "HKD", "USD", "USDT", "USDC", "EUR", "GBP", "JPY", "SGD", "AUD"];
export const CATEGORIES = ["现金", "定期存款", "货币基金", "股票", "股票ETF", "基金", "债券", "稳定币", "加密资产", "组合资产", "其他", "未分类"];

const MAX_AMOUNT = 1_000_000_000_000;
const DAY_MS = 86_400_000;
const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });

function today() {
  return dateFormatter.format(new Date());
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > today()) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式不正确`);
  return value;
}

function text(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${label}不能为空且最多 ${max} 字符`);
  return value.trim();
}

function noteText(value, label) {
  if (typeof value !== "string" || value.trim().length > 1000) throw new Error(`${label}须为最多 1000 字符的文本`);
  return value.trim();
}

function choice(value, values, label) {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label}不支持：${String(value)}`);
  return value;
}

function validAmount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
}

export function emptyPortfolio() {
  return {
    accounts: PLATFORMS.map((platform, index) => ({ id: `account-${index + 1}`, platform, name: platform, basis: "total", ...(platform === "待确认" ? { reviewStatus: "pending" } : {}) })),
    entries: [],
    rates: { CNY: { value: 1, date: today() } },
  };
}

export function entryIdentity(entry) {
  return JSON.stringify(entry.kind === "total" ? [entry.accountId.trim(), entry.kind] : [entry.accountId.trim(), entry.kind, entry.name.trim(), entry.currency]);
}

export function validatePortfolio(input) {
  const value = object(input, "资产数据");
  if (!Array.isArray(value.accounts) || value.accounts.length > 100) throw new Error("账户必须是列表，最多 100 个");
  if (!Array.isArray(value.entries) || value.entries.length > 5000) throw new Error("资产记录必须是列表，最多 5000 条");
  const accountIds = new Set();
  const accounts = value.accounts.map((raw, index) => {
    const account = object(raw, `第 ${index + 1} 个账户`);
    const id = text(account.id, "账户 ID", 100);
    if (accountIds.has(id)) throw new Error(`账户 ID 重复：${id}`);
    accountIds.add(id);
    const validated = { id, platform: choice(account.platform, PLATFORMS, "平台"), name: text(account.name, "账户名称"), basis: choice(account.basis, ["total", "holdings"], "账户统计口径") };
    if (account.reviewStatus !== undefined) validated.reviewStatus = choice(account.reviewStatus, ["confirmed", "pending"], "账户确认状态");
    if (account.note !== undefined) validated.note = noteText(account.note, "账户备注");
    return validated;
  });
  const entryIds = new Set();
  const totals = new Set();
  const holdings = new Set();
  const entries = value.entries.map((raw, index) => {
    const row = object(raw, `第 ${index + 1} 条资产`);
    const id = text(row.id, "资产 ID", 100);
    if (entryIds.has(id)) throw new Error(`资产 ID 重复：${id}`);
    entryIds.add(id);
    const accountId = text(row.accountId, "账户 ID", 100);
    if (!accountIds.has(accountId)) throw new Error(`第 ${index + 1} 条资产的账户不存在`);
    const kind = choice(row.kind, ["total", "holding"], "资产类型");
    if (kind === "total") {
      if (totals.has(accountId)) throw new Error("同一账户只能有一条账户总额，请更新现有总额或使用持仓明细");
      totals.add(accountId);
    }
    if (!validAmount(row.amount)) throw new Error(`第 ${index + 1} 条资产金额须为 0 至 ${MAX_AMOUNT} 的有限数字`);
    if (!validDate(row.asOf)) throw new Error(`第 ${index + 1} 条资产日期须为有效的 YYYY-MM-DD，且不能晚于今天`);
    const entry = {
      id, accountId, kind,
      name: text(row.name, "资产名称"),
      category: choice(row.category, CATEGORIES, "资产类别"),
      currency: choice(row.currency, CURRENCIES, "币种"),
      amount: row.amount, asOf: row.asOf,
      source: choice(row.source, ["manual", "csv", "screenshot", "api"], "数据来源"),
    };
    if (row.note !== undefined) entry.note = noteText(row.note, "资产备注");
    if (row.asOfBasis !== undefined) entry.asOfBasis = choice(row.asOfBasis, ["statement", "imported"], "资产日期依据");
    if (kind === "holding") {
      const signature = entryIdentity(entry);
      if (holdings.has(signature)) throw new Error(`第 ${index + 1} 条持仓记录重复，请更新现有记录，勿重复导入`);
      holdings.add(signature);
    }
    return entry;
  });
  const rawRates = object(value.rates, "汇率");
  const rates = {};
  for (const [currency, raw] of Object.entries(rawRates)) {
    choice(currency, CURRENCIES, "汇率币种");
    const rate = object(raw, `${currency} 汇率`);
    if (typeof rate.value !== "number" || !Number.isFinite(rate.value) || rate.value <= 0 || rate.value > 1_000_000_000) throw new Error(`${currency} 汇率须为大于 0 的有限数字`);
    if (!validDate(rate.date)) throw new Error(`${currency} 汇率日期须有效且不能晚于今天`);
    if (currency === "CNY" && rate.value !== 1) throw new Error("CNY 汇率固定为 1");
    rates[currency] = { value: rate.value, date: rate.date };
    if (rate.note !== undefined) rates[currency].note = noteText(rate.note, `${currency} 汇率备注`);
  }
  rates.CNY ??= { value: 1, date: today() };
  return { accounts, entries, rates };
}

export function summarize(portfolio) {
  const included = [];
  const excluded = [];
  const missing = [];
  const stale = [];
  const pending = [];
  const byPlatform = new Map();
  const byCategory = new Map();
  const byCurrency = new Map();
  const accounts = new Map(portfolio.accounts.map((account) => [account.id, account]));
  const usedTotals = new Set();
  let total = 0;
  for (const entry of portfolio.entries) {
    const account = accounts.get(entry.accountId);
    if (account?.reviewStatus === "pending" || account?.platform === "待确认") {
      pending.push(entry);
      excluded.push(entry);
      continue;
    }
    if (!account || !validDate(entry.asOf) || !validAmount(entry.amount) || entry.kind !== (account.basis === "total" ? "total" : "holding") || (entry.kind === "total" && usedTotals.has(entry.accountId))) {
      excluded.push(entry);
      continue;
    }
    if (entry.kind === "total") usedTotals.add(entry.accountId);
    if ((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${entry.asOf}T00:00:00Z`)) / DAY_MS > 30) stale.push(entry);
    const rate = entry.currency === "CNY" ? 1 : portfolio.rates[entry.currency]?.value;
    const rateDateValid = entry.currency === "CNY" || validDate(portfolio.rates[entry.currency]?.date);
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1_000_000_000 || !rateDateValid) {
      missing.push(entry);
      continue;
    }
    const value = entry.amount * rate;
    total += value;
    included.push(entry);
    byPlatform.set(account.platform, (byPlatform.get(account.platform) ?? 0) + value);
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + value);
    byCurrency.set(entry.currency, (byCurrency.get(entry.currency) ?? 0) + value);
  }
  const groups = (map) => Array.from(map, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  return { total: included.length ? total : null, included, excluded, missing, stale, pending, byPlatform: groups(byPlatform), byCategory: groups(byCategory), byCurrency: groups(byCurrency) };
}

function csvRows(text) {
  if (text.length > 2_000_000) throw new Error("CSV 文件过大，请限制在 2 MB 以内");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') { quoted = false; closed = true; }
      else cell += character;
    } else if (character === "," || character === "\n") {
      row.push(cell);
      cell = "";
      closed = false;
      if (character === "\n") { rows.push(row); row = []; }
    } else if (character === '"') {
      if (cell || closed) throw new Error("CSV 引号格式不正确");
      quoted = true;
    } else {
      if (closed && character.trim()) throw new Error("CSV 引号结束后存在多余字符");
      if (!closed) cell += character;
    }
  }
  if (quoted) throw new Error("CSV 存在未闭合的引号");
  row.push(cell);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows.filter((row) => row.some((cell) => cell.trim()));
}

const HEADERS = {
  platform: ["平台", "platform"], account: ["账户", "账户名称", "account"],
  kind: ["类型", "资产类型", "kind"], name: ["资产名称", "名称", "name"],
  category: ["类别", "资产类别", "category"], currency: ["币种", "货币", "currency"],
  amount: ["金额", "市值", "amount"], asOf: ["日期", "估值日期", "asof", "as_of", "date"],
};

function platformName(value) {
  const aliases = { zabank: "ZA Bank", za银行: "ZA Bank", 众安银行: "ZA Bank", a股: "A股", okx: "OKX", binance: "币安", futu: "富途" };
  return aliases[value.replace(/\s/g, "").toLowerCase()] ?? value;
}

function csvAmount(value) {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) throw new Error("金额须为非负数字，可使用标准千分位逗号");
  const amount = Number(value.replace(/,/g, ""));
  if (!validAmount(amount)) throw new Error("金额超出允许范围");
  return amount;
}

const CURRENCY_ALIASES = {
  RMB: "CNY", "HK$": "HKD", "US$": "USD", "S$": "SGD", "A$": "AUD", "€": "EUR", "£": "GBP",
  人民币: "CNY", 港币: "HKD", 港元: "HKD", 美元: "USD", 美金: "USD", 欧元: "EUR", 英镑: "GBP",
  日元: "JPY", 日圆: "JPY", 新加坡元: "SGD", 新币: "SGD", 澳元: "AUD", 澳币: "AUD",
};
const currencyPattern = `(?<![A-Za-z])(?:${[...CURRENCIES, "RMB"].join("|")})(?![A-Za-z])|HK\\$|US\\$|S\\$|A\\$|新加坡元|人民币|港币|港元|美元|美金|欧元|英镑|日元|日圆|新币|澳元|澳币|€|£|\\$|¥|￥`;
const quantityLabel = /(?:数量|quantity|qty)\s*[:：]?\s*(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:万|亿)?\s*)?[（(]?\s*$/i;

function currencyTokens(source) {
  return Array.from(source.matchAll(new RegExp(currencyPattern, "gi"))).flatMap((match) => {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    const before = source.slice(0, start);
    const after = source.slice(end);
    if (quantityLabel.test(before) || /^[\s:：）)]*(?:数量|quantity|qty)/i.test(after) || /^(?:货币基金|货币|基金|股票|债券|指数|ETF)/i.test(after)) return [];
    const candidates = raw === "$" ? ["USD", "HKD", "SGD", "AUD"] : /[¥￥]/.test(raw) ? ["CNY", "JPY"] : [CURRENCY_ALIASES[raw.toUpperCase()] ?? raw.toUpperCase()];
    return [{ raw, start, end, candidates }];
  });
}

export function detectCurrency(source) {
  const tokens = currencyTokens(typeof source === "string" ? source : "");
  const explicit = [...new Set(tokens.filter((token) => token.candidates.length === 1).flatMap((token) => token.candidates))];
  const candidates = [...new Set(tokens.flatMap((token) => explicit.length === 1 && token.candidates.includes(explicit[0]) ? explicit : token.candidates))];
  return { currency: candidates.length === 1 ? candidates[0] : null, candidates, ambiguous: candidates.length > 1 };
}

function csvCurrency(value) {
  const normalized = value.toUpperCase();
  return choice(CURRENCY_ALIASES[normalized] ?? normalized, CURRENCIES, "币种");
}

export function parseCsv(sourceText, accounts) {
  const rows = csvRows(sourceText);
  if (!rows.length) throw new Error("CSV 缺少表头");
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const columns = {};
  for (const [key, aliases] of Object.entries(HEADERS)) {
    const matching = header.map((cell, index) => aliases.includes(cell) ? index : -1).filter((index) => index >= 0);
    if (matching.length !== 1) throw new Error(`CSV 表头须包含且只能包含一个「${aliases[0]}」列`);
    columns[key] = matching[0];
  }
  if (rows.length - 1 > 5000) throw new Error("CSV 最多导入 5000 条记录");
  const entries = [];
  const signatures = new Set();
  const totals = new Set();
  for (let index = 1; index < rows.length; index++) {
    try {
      const row = rows[index];
      if (row.length !== header.length) throw new Error("列数与表头不一致");
      const field = (key) => row[columns[key]].trim();
      const platform = platformName(field("platform"));
      const accountName = field("account") || platform;
      const matches = accounts.filter((account) => account.platform === platform && account.name === accountName);
      if (matches.length !== 1) throw new Error("平台与账户名称未匹配到唯一的已有账户");
      const kindAliases = { total: "total", 总额: "total", 账户总额: "total", holding: "holding", holdings: "holding", 持仓: "holding", 持仓明细: "holding" };
      const kind = kindAliases[field("kind").toLowerCase()];
      if (!["total", "holding"].includes(kind)) throw new Error("类型须为「账户总额」或「持仓明细」");
      const entry = {
        id: `csv-${crypto.randomUUID()}`, accountId: matches[0].id, kind,
        name: text(field("name"), "资产名称"), category: choice(field("category"), CATEGORIES, "类别"),
        currency: csvCurrency(field("currency")), amount: csvAmount(field("amount")),
        asOf: field("asOf"), source: "csv",
      };
      if (!validDate(entry.asOf)) throw new Error("日期须为有效的 YYYY-MM-DD，且不能晚于今天");
      if (kind === "total" && totals.has(entry.accountId)) throw new Error("同一账户只能导入一条账户总额");
      if (kind === "total") totals.add(entry.accountId);
      const signature = entryIdentity(entry);
      if (signatures.has(signature)) throw new Error("资产记录重复，请先检查文件");
      signatures.add(signature);
      entries.push(entry);
    } catch (error) {
      throw new Error(`CSV 第 ${index + 1} 行：${error instanceof Error ? error.message : "数据不正确"}`);
    }
  }
  return entries;
}

export function csvTemplate() {
  return "\uFEFF平台,账户,类型,资产名称,类别,币种,金额,日期\r\n";
}

export function extractOcrCandidates(text) {
  const candidates = [];
  const amountPattern = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:万|亿)?";
  const assetPattern = /(?:总资产|资产总额|账户总额|资产净值|账户净值|总额|总市值|余额|净资产|证券市值|持有金额|持仓市值|市值|估值|现金总值)/;
  const fieldPattern = /总资产|资产总额|账户总额|资产净值|账户净值|总额|总市值|余额|净资产|证券市值|持有金额|持仓市值|市值|估值|现金总值|盈亏|收益|损益|利润|盈利|亏损|回报|涨跌|数量|quantity|qty/gi;
  const excludedField = /(?:盈亏|收益|损益|利润|盈利|亏损|回报|涨跌|数量|quantity|qty)/i;
  const amountValue = (value) => Number(value.replace(/[,万亿]/g, "")) * (value.endsWith("万") ? 10_000 : value.endsWith("亿") ? 100_000_000 : 1);
  let previousHeader = "";
  for (const raw of text.replace(/，/g, ",").split(/\r?\n/)) {
    const label = raw.trim();
    const header = previousHeader;
    previousHeader = "";
    if (!label) continue;
    const numbers = Array.from(label.matchAll(new RegExp(amountPattern, "g")));
    const tokens = currencyTokens(label);
    const claimedTokens = new Set();
    if (!numbers.length && (assetPattern.test(label) || /(?:估值|报表|计价)币种/.test(label)) && tokens.length) previousHeader = label;
    for (const [index, match] of numbers.entries()) {
      const end = (match.index ?? 0) + match[0].length;
      const before = label.slice(0, match.index).trimEnd();
      const after = label.slice(end).trimStart();
      const lastField = Array.from(before.matchAll(fieldPattern)).at(-1)?.[0];
      if (/[-−+\d,.:/年月日]$/.test(before) || /^[%％\d,.:/\-年月日]/.test(after) || /^\s*(?:股|份|枚|单位|units?\b)/i.test(after) || (lastField && excludedField.test(lastField))) continue;
      let adjacent = tokens.filter((token) => !claimedTokens.has(token) && (token.end <= match.index ? /^[\s:：()（）·等值估值]*$/.test(label.slice(token.end, match.index)) : token.start >= end && /^[\s()（）]*$/.test(label.slice(end, token.start))));
      if (adjacent.some((token) => token.end <= match.index) && numbers[index + 1]) adjacent = adjacent.filter((token) => token.end <= match.index || !/^[\s:：()（）]*$/.test(label.slice(token.end, numbers[index + 1].index)));
      if (adjacent.some((token) => /[-−+]\s*$/.test(label.slice(0, token.start)))) continue;
      let remaining = label.replace(match[0], "");
      for (const token of tokens) remaining = remaining.replace(token.raw, "");
      const useHeader = header && numbers.length === 1 && /^[\s:：()（）$¥￥]*$/.test(remaining);
      const assetContext = assetPattern.test(before) || useHeader;
      if (!assetContext && !adjacent.length) continue;
      if (!assetContext && adjacent.every((token) => token.candidates.every((currency) => ["USDT", "USDC"].includes(currency)))) continue;
      const localCurrency = adjacent.map((token) => token.raw).join(" ");
      const reportCurrency = tokens.filter((token) => !["USDT", "USDC"].includes(token.candidates[0]) || assetPattern.test(label.slice(0, token.start)) || /(?:估值|报表|计价)币种[\s:：（(]*$/.test(label.slice(0, token.start))).map((token) => token.raw).join(" ");
      const currency = detectCurrency(useHeader && (!localCurrency || adjacent.every((token) => token.candidates.length > 1)) ? `${header} ${localCurrency}` : localCurrency || (numbers.length === 1 && assetContext ? reportCurrency : "")).currency;
      const amount = amountValue(match[0]);
      if (validAmount(amount)) {
        candidates.push({ label: useHeader ? `${header} ${label}` : label, amount, ...(currency ? { currency } : {}) });
        for (const token of adjacent) claimedTokens.add(token);
      }
    }
  }
  return candidates;
}
