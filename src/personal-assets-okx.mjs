import { createHmac } from "node:crypto";

const HOSTS = Object.freeze({ global: "https://openapi.okx.com", us: "https://us.okx.com", eea: "https://eea.okx.com" });
const PATHS = new Set(["/api/v5/account/config", "/api/v5/account/balance", "/api/v5/asset/asset-valuation?ccy=USD"]);
const MAX_RESPONSE_BYTES = 1_000_000;
const STABLECOINS = new Set(["USDT", "USDC", "USDG", "DAI", "USDE", "PYUSD", "FDUSD", "TUSD"]);
const FIAT = new Set(["USD", "HKD", "CNY", "EUR", "GBP", "JPY", "SGD", "AUD", "CAD", "CHF"]);

class OkxAssetsError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode;
  }
}

function invalidData() {
  return new OkxAssetsError("OKX 资产响应缺少有效估值，未生成可导入数据");
}

function decimal(value) {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) throw invalidData();
  const number = Number(value);
  if (!Number.isFinite(number)) throw invalidData();
  return number;
}

function nonnegative(value) {
  const number = decimal(value);
  if (number < 0) throw new OkxAssetsError("OKX 返回负净资产，当前资产页暂不支持负资产导入", 422);
  return number;
}

async function readJson(response) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw invalidData();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw invalidData();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function oneRow(rows) {
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" || Array.isArray(rows[0])) throw invalidData();
  return rows[0];
}

function category(symbol) {
  if (STABLECOINS.has(symbol)) return "稳定币";
  if (FIAT.has(symbol)) return "现金";
  return "加密资产";
}

export async function fetchOkxAssets({ credentials, fetchImpl = fetch, now = () => new Date() }) {
  if (!credentials || !Object.hasOwn(HOSTS, credentials.region)
    || [credentials.apiKey, credentials.secret, credentials.passphrase].some((value) => typeof value !== "string" || !value.length || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new OkxAssetsError("请填写 OKX API Key、Secret、Passphrase，并选择账户所属区域", 400);
  }
  const fetched = now();
  if (!(fetched instanceof Date) || !Number.isFinite(fetched.getTime())) throw new OkxAssetsError("同步服务器时间无效", 500);
  const fetchedAt = fetched.toISOString();
  async function get(path) {
    if (!PATHS.has(path)) throw new OkxAssetsError("OKX 只读接口不在允许列表中", 500);
    const timestamp = now().toISOString();
    const sign = createHmac("sha256", credentials.secret).update(`${timestamp}GET${path}`).digest("base64");
    try {
      const response = await fetchImpl(`${HOSTS[credentials.region]}${path}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: {
          "Accept": "application/json", "OK-ACCESS-KEY": credentials.apiKey,
          "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": credentials.passphrase,
        },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) throw new OkxAssetsError("OKX 访问频率受限，请稍后重试", 429);
        throw new OkxAssetsError("OKX 只读接口访问失败，请检查账户区域、IP 白名单和授权凭证");
      }
      const payload = await readJson(response);
      if (payload?.code === "50011") throw new OkxAssetsError("OKX 访问频率受限，请稍后重试", 429);
      if (payload?.code !== "0" || !Array.isArray(payload.data)) throw new OkxAssetsError("OKX 授权或资产读取失败，请检查账户区域、IP 白名单和只读凭证");
      return payload.data;
    } catch (error) {
      if (error instanceof OkxAssetsError) throw error;
      throw new OkxAssetsError("OKX 只读请求失败或超时，请稍后重试；现有资产未被改动");
    }
  }

  const config = oneRow(await get("/api/v5/account/config"));
  const permissions = typeof config.perm === "string" ? config.perm.split(",").map((value) => value.trim()) : [];
  if (permissions.length !== 1 || permissions[0] !== "read_only") throw new OkxAssetsError("只接受仅有 Read 权限的 OKX API Key；请移除 Trade、Withdraw 等其他权限后重新授权", 403);
  if (typeof config.uid !== "string" || !/^\d{1,40}$/.test(config.uid)) throw invalidData();
  const [valuationRows, balanceRows] = await Promise.all([
    get("/api/v5/asset/asset-valuation?ccy=USD"), get("/api/v5/account/balance"),
  ]);
  const valuation = oneRow(valuationRows);
  const balance = oneRow(balanceRows);
  const total = nonnegative(valuation.totalBal);
  const tradingTotal = nonnegative(balance.totalEq);
  if (typeof valuation.ts !== "string" || !/^\d{13}$/.test(valuation.ts)) throw invalidData();
  const valuationTime = new Date(Number(valuation.ts));
  if (!Number.isFinite(valuationTime.getTime()) || valuationTime.getTime() > fetched.getTime() + 300_000) throw new OkxAssetsError("OKX 估值时间与服务器不符，请检查服务器时间后重试");
  if (fetched.getTime() - valuationTime.getTime() > 900_000) throw new OkxAssetsError("OKX 返回的汇总估值已超过 15 分钟，暂不更新资产，请稍后重新拉取");
  const warnings = ["账户总额使用 OKX 全账户 USD 估值；交易、资金、赚币明细已包含在总额内，不能再次相加。", "仅读取当前授权账户，不含其他子账户、Web3 钱包或合约名义本金。"];
  const coverage = ["全账户 USD 汇总估值", "交易账户净权益与币种明细"];
  if (!Array.isArray(balance.details) || balance.details.length > 5000) throw invalidData();
  const holdings = [];
  const symbols = new Set();
  let breakdownComplete = true;
  for (const row of balance.details) {
    if (!row || typeof row.ccy !== "string" || !/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(row.ccy) || symbols.has(row.ccy)) throw invalidData();
    symbols.add(row.ccy);
    if (row.eqUsd === "" || row.eqUsd === undefined || row.eqUsd === null) {
      breakdownComplete = false;
      warnings.push(`${row.ccy} 未返回 USD 估值，未生成该币种明细；账户总额仍使用官方汇总。`);
      continue;
    }
    const amount = decimal(row.eqUsd);
    if (amount < 0) {
      breakdownComplete = false;
      warnings.push(`${row.ccy} 为负币种权益，暂不导入明细；其负值已包含在账户净权益中。`);
      continue;
    }
    const holding = { externalId: `trading:${row.ccy}`, name: `${row.ccy}（交易账户）`, category: category(row.ccy), currency: "USD", amount, symbol: row.ccy };
    if (row.eq !== undefined && row.eq !== "") {
      const quantity = decimal(row.eq);
      if (quantity >= 0) holding.quantity = quantity;
      else breakdownComplete = false;
    } else breakdownComplete = false;
    if (amount > 0 || holding.quantity > 0) holdings.push(holding);
  }
  const tradingSum = holdings.reduce((sum, row) => sum + row.amount, 0);
  if (Math.abs(tradingSum - tradingTotal) >= 0.005) {
    breakdownComplete = false;
    warnings.push("交易币种明细与交易净权益存在差异，未用差额补造持仓；请以账户汇总为准。");
  }
  if (!valuation.details || typeof valuation.details !== "object" || Array.isArray(valuation.details)) throw invalidData();
  if (valuation.details.trading === undefined || valuation.details.trading === "" || Math.abs(nonnegative(valuation.details.trading) - tradingTotal) >= 0.005) {
    breakdownComplete = false;
    warnings.push("全账户中的交易估值未与交易净权益对齐，明细仅供对账。");
  }
  for (const [key, label] of [["funding", "资金账户"], ["earn", "赚币账户"], ["classic", "经典账户"]]) {
    const raw = valuation.details[key];
    if (raw === undefined || raw === "") {
      if (key !== "classic") {
        breakdownComplete = false;
        warnings.push(`${label}未返回独立汇总，暂不显示该账户明细。`);
      }
      continue;
    }
    const amount = nonnegative(raw);
    coverage.push(`${label} USD 汇总估值`);
    if (amount > 0) holdings.push({ externalId: `${key}:summary`, name: `${label}（汇总，类型待细分）`, category: "组合资产", currency: "USD", amount });
  }
  const totalDetails = holdings.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isFinite(totalDetails)) throw invalidData();
  if (Math.abs(totalDetails - total) >= 0.005) {
    breakdownComplete = false;
    warnings.push("各账户明细与全账户汇总可能存在估值时差、负权益或未覆盖资产；不会用差额补造资产。");
  }
  if (symbols.has("OKSOL")) warnings.push("OKSOL 按 OKX 返回的独立币种权益保留，不转换成 SOL，也不另计链上资产。");
  return {
    provider: "okx", currency: "USD", total,
    asOf: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(valuationTime),
    fetchedAt, observedAt: valuationTime.toISOString(), timeBasis: "source",
    accountLabel: `OKX · 交易所（${credentials.region === "global" ? "全球" : credentials.region === "us" ? "美国 / 澳洲" : "欧洲经济区"}）`,
    externalAccountId: config.uid, holdings, coverage, warnings, breakdownComplete,
  };
}
