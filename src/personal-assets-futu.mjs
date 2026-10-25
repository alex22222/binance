// Official REST OAuth and account schemas: https://open.futunn.com/api/overview/getting-started
const FUTU_ORIGIN = "https://webapi.futunn.com";
const READ_SCOPE = "trade:read";
const MAX_RESPONSE_BYTES = 2_000_000;
const SUPPORTED_CURRENCIES = new Set(["CNY", "HKD", "USD", "EUR", "GBP", "JPY", "SGD", "AUD"]);

export class FutuAssetsError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
    this.statusCode = status;
  }
}

function requiredText(value, label, max = 16384) {
  if (typeof value !== "string" || !value || value.length > max || /[\s\u0000-\u001f\u007f]/.test(value)) throw new FutuAssetsError(`${label}无效`, 400);
  return value;
}

function redirectUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new FutuAssetsError("富途回调地址无效", 400); }
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) throw new FutuAssetsError("富途回调地址必须使用 HTTPS", 400);
  return url.href;
}

function atTime(now = () => new Date()) {
  const at = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(at.getTime())) throw new FutuAssetsError("同步时间无效", 400);
  return at;
}

async function readJson(response) {
  const declared = response.headers?.get("content-length");
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new FutuAssetsError("富途响应过大，未导入资产");
  let source;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw new FutuAssetsError("富途响应过大，未导入资产");
        chunks.push(value);
      }
      source = Buffer.concat(chunks).toString("utf8");
    } finally {
      await reader.cancel().catch(() => {});
    }
  } else {
    source = await response.text();
    if (Buffer.byteLength(source) > MAX_RESPONSE_BYTES) throw new FutuAssetsError("富途响应过大，未导入资产");
  }
  try {
    return JSON.parse(source, (key, value, context) => {
      if (!["account_id", "position_id"].includes(key) || typeof value !== "number" || Number.isSafeInteger(value)) return value;
      // Recover uint64 identifiers from the original JSON digits, never a rounded Number.
      if (!context?.source || !/^[0-9]{1,20}$/.test(context.source) || BigInt(context.source) > 18446744073709551615n) throw new Error("Invalid uint64 identifier");
      return context.source;
    });
  } catch { throw new FutuAssetsError("富途响应格式无效，未导入资产"); }
}

async function request(path, { fetchImpl = fetch, method = "GET", accessToken, body, contentType } = {}) {
  let response;
  try {
    response = await fetchImpl(`${FUTU_ORIGIN}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: "application/json",
        ...(accessToken ? { Authorization: `Bearer ${requiredText(accessToken, "富途访问令牌")}` } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) throw new FutuAssetsError(response.status === 401 ? "富途授权已失效，请重新授权" : "富途请求失败，请稍后重试");
    return await readJson(response);
  } catch (error) {
    if (error instanceof FutuAssetsError) throw error;
    throw new FutuAssetsError("无法连接富途或请求超时，请稍后重试");
  }
}

function readScope(value) {
  if (typeof value !== "string" || value.length > 4096) throw new FutuAssetsError("富途未返回有效授权范围，请重新选择只读权限");
  const scopes = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  if (!scopes.includes(READ_SCOPE) || scopes.some((scope) => ![READ_SCOPE, "quote:read", "accid:*"].includes(scope) && !/^accid:[0-9]{1,24}$/.test(scope))) throw new FutuAssetsError("富途授权必须仅含读取权限，请取消所有写入或交易权限后重新授权");
  return scopes.join(" ");
}

function tokenResult(value, { refreshToken, now } = {}) {
  if (!value || value.token_type?.toLowerCase() !== "bearer" || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0 || value.expires_in > 31_536_000) throw new FutuAssetsError("富途令牌响应无效，请重新授权");
  return {
    accessToken: requiredText(value.access_token, "富途访问令牌"),
    refreshToken: requiredText(value.refresh_token ?? refreshToken, "富途刷新令牌"),
    expiresAt: new Date(atTime(now).getTime() + value.expires_in * 1000).toISOString(),
    scope: readScope(value.scope),
  };
}

export async function registerFutuClient({ redirectUri, fetchImpl }) {
  const value = await request("/oauth2/register", {
    fetchImpl,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      redirect_uris: [redirectUrl(redirectUri)],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Personal Assets Read Only",
      scope: READ_SCOPE,
    }),
  });
  if (value.token_endpoint_auth_method !== undefined && value.token_endpoint_auth_method !== "none") throw new FutuAssetsError("富途未接受 PKCE 客户端注册");
  return { clientId: requiredText(value.client_id, "富途客户端编号", 256) };
}

export function createFutuAuthorization({ clientId, redirectUri, state, codeChallenge }) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(state)) throw new FutuAssetsError("富途授权校验值无效", 400);
  if (typeof codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new FutuAssetsError("富途 PKCE 校验值无效", 400);
  const url = new URL("/oauth2/authorize/confirm", FUTU_ORIGIN);
  url.search = new URLSearchParams({
    client_id: requiredText(clientId, "富途客户端编号", 256),
    redirect_uri: redirectUrl(redirectUri),
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: READ_SCOPE,
  }).toString();
  return url.href;
}

export async function exchangeFutuCode({ clientId, redirectUri, code, codeVerifier, fetchImpl, now }) {
  if (typeof codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new FutuAssetsError("富途 PKCE 校验值无效", 400);
  const value = await request("/oauth2/token", {
    fetchImpl,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: requiredText(clientId, "富途客户端编号", 256),
      redirect_uri: redirectUrl(redirectUri),
      code: requiredText(code, "富途授权码", 4096),
      code_verifier: codeVerifier,
    }).toString(),
  });
  return tokenResult(value, { now });
}

export async function refreshFutuToken({ clientId, refreshToken, fetchImpl, now }) {
  const value = await request("/oauth2/token", {
    fetchImpl,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: requiredText(clientId, "富途客户端编号", 256),
      refresh_token: requiredText(refreshToken, "富途刷新令牌"),
    }).toString(),
  });
  return tokenResult(value, { refreshToken, now });
}

async function getData(path, options) {
  const value = await request(path, options);
  if (value?.s !== "ok" || value.d === undefined) throw new FutuAssetsError("富途未返回可用资产，请检查授权范围或稍后重试");
  return value.d;
}

function accountId(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new FutuAssetsError("富途账户编号精度异常，未导入资产");
  const id = String(value ?? "");
  if (!/^[0-9]{1,24}$/.test(id)) throw new FutuAssetsError("富途账户编号无效", 400);
  return id;
}

export async function fetchFutuAccounts({ accessToken, fetchImpl }) {
  const value = await getData("/api/v1.0/accounts/authorized_trd_accs", { accessToken, fetchImpl });
  if (!value || !Array.isArray(value.accounts) || value.accounts.length > 100 || value.accounts.some((account) => !account || typeof account !== "object" || Array.isArray(account))) throw new FutuAssetsError("富途账户列表格式无效");
  const seen = new Set();
  return value.accounts.filter((account) => {
    // This endpoint is the authorized trading list; simulated accounts use /sim-trade/accounts.
    const environment = String(account?.trd_env ?? account?.environment ?? "REAL").toUpperCase();
    return environment === "REAL" && account?.is_simulated !== true && account?.is_paper !== true;
  }).map((account) => {
    const id = accountId(account.account_id);
    const securityFirm = account.security_firm;
    const accountType = account.acc_type;
    if (seen.has(id) || typeof securityFirm !== "string" || !/^[A-Z0-9_]{1,32}$/.test(securityFirm) || !["cash", "margin", "derivative"].includes(accountType)) throw new FutuAssetsError("富途账户列表格式无效");
    seen.add(id);
    const card = typeof account.account_card_number === "string" && /^[0-9]{4,24}$/.test(account.account_card_number) ? account.account_card_number : id;
    const kind = { cash: "现金账户", margin: "保证金账户", derivative: "衍生品账户" }[accountType];
    return { id, label: `富途 ${securityFirm} ${kind} · 尾号 ${card.slice(-4)}`, securityFirm, accountType, environment: "REAL" };
  });
}

function amount(value, label, { signed = false } = {}) {
  if (typeof value !== "string" && typeof value !== "number") throw new FutuAssetsError(`${label}缺失，未导入资产`);
  if (typeof value === "string" && !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) throw new FutuAssetsError(`${label}无效，未导入资产`);
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e15 || (!signed && number < 0)) throw new FutuAssetsError(`${label}无效，未导入资产`);
  return number;
}

function currency(value) {
  if (!SUPPORTED_CURRENCIES.has(value)) throw new FutuAssetsError("富途资产币种暂不支持，未导入资产");
  return value;
}

function positionCategory(value) {
  if (value === "ETF") return "股票ETF";
  if (value === "STOCK") return "股票";
  if (value === "BOND") return "债券";
  if (value === "FUND") return "基金";
  return "未分类";
}

export async function fetchFutuAssets({ accessToken, accountId: selectedId, fetchImpl, now }) {
  const id = accountId(selectedId);
  const accounts = await fetchFutuAccounts({ accessToken, fetchImpl });
  const account = accounts.find((row) => row.id === id);
  if (!account) throw new FutuAssetsError("所选富途实盘账户未获授权，请重新选择账户", 400);
  if (account.accountType === "derivative" || /JP/.test(account.securityFirm)) throw new FutuAssetsError("首版同步暂不支持日本或衍生品账户，请选择证券账户", 400);
  const funds = await getData(`/api/v1.0/accounts/${id}/funds?currency=HKD`, { accessToken, fetchImpl });
  const positions = await getData(`/api/v1.0/accounts/${id}/positions`, { accessToken, fetchImpl });
  if (!funds || typeof funds !== "object" || Array.isArray(funds) || !Array.isArray(positions) || positions.length > 5000) throw new FutuAssetsError("富途资产响应格式无效，未导入资产");
  const total = amount(funds.total_assets, "富途净资产");
  const totalCurrency = currency(funds.currency);
  const warnings = ["账户总额使用富途总净资产；证券、现金和购买力不重复加总。持仓明细仅供核对。"];
  const holdings = [];
  const seen = new Set();
  for (const position of positions) {
    if (!position || typeof position.code !== "string" || !/^[A-Z]{2}\.[A-Za-z0-9._-]{1,64}$/.test(position.code)) throw new FutuAssetsError("富途持仓代码无效，未导入资产");
    if (typeof position.stock_name !== "string" || !position.stock_name.trim() || position.stock_name.length > 200) throw new FutuAssetsError("富途持仓名称无效，未导入资产");
    const value = amount(position.market_val, "富途持仓市值", { signed: true });
    const quantity = amount(position.qty, "富途持仓数量", { signed: true });
    if (position.position_side === "SHORT" || value < 0 || quantity < 0) {
      warnings.push(`持仓 ${position.code} 含空头或负值，仅反映在账户净资产中，未作为正资产明细导入。`);
      continue;
    }
    const positionCurrency = currency(position.currency);
    const externalId = `position:${position.code}:${position.position_id ?? "LONG"}`;
    if (seen.has(externalId)) throw new FutuAssetsError("富途持仓标识重复，未导入资产");
    seen.add(externalId);
    holdings.push({ externalId, name: position.stock_name.trim(), category: positionCategory(position.security_type), currency: positionCurrency, amount: value, quantity, symbol: position.code });
  }
  for (const [field, nativeCurrency] of [["hk_cash", "HKD"], ["us_cash", "USD"], ["cn_cash", "CNY"], ["sg_cash", "SGD"], ["jp_cash", "JPY"], ["au_cash", "AUD"]]) {
    if (funds[field] === undefined || funds[field] === "") continue;
    const value = amount(funds[field], "富途币种现金", { signed: true });
    if (value < 0) warnings.push(`${nativeCurrency} 现金为负，仅反映在账户净资产中，未作为正资产明细导入。`);
    else if (value > 0) holdings.push({ externalId: `cash:${nativeCurrency}`, name: `${nativeCurrency} 现金`, category: "现金", currency: nativeCurrency, amount: value });
  }
  if (holdings.some((row) => row.category === "未分类")) warnings.push("部分证券类型未能明确识别，已标记未分类，可在资产页手动纠正。");
  const at = atTime(now);
  return {
    provider: "futu", currency: totalCurrency, total,
    breakdownComplete: false,
    asOf: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(at),
    fetchedAt: at.toISOString(), accountLabel: account.label, externalAccountId: id, holdings,
    coverage: ["所选实盘证券业务账户总净资产", "证券持仓与已返回的分币种现金；明细不参与账户总额加总"],
    warnings: [...new Set(warnings)],
  };
}
