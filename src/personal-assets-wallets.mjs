import { createHash, createHmac } from "node:crypto";

const HOST = "https://web3.okx.com";
const BALANCES = "/api/v6/dex/balance/all-token-balances-by-address";
const DEFI = "/api/v6/defi/user/asset/platform/list";
const QUOTE = "https://api.kraken.com/0/public/Trades?pair=USDTUSD&count=1";
const MAX_BYTES = 1_000_000;
const MAX_ASSETS = 999;
const MAX_VALUE = 1_000_000_000_000;
const CHAINS = Object.freeze({ "1": { name: "Ethereum", symbol: "ETH" }, "501": { name: "Solana", symbol: "SOL" }, "137": { name: "Polygon", symbol: "POL" },
  "56": { name: "BNB Smart Chain", symbol: "BNB" }, "196": { name: "X Layer", symbol: "OKB" } });
// Contract identity comes from https://tether.to/en/supported-protocols/; names alone never identify USDt.
// BSC Binance-Peg contract: https://www.binance.com/en-PH/skills/detail/binance-web3/binance-agentic-wallet
const USDT = Object.freeze({ "1": "0xdac17f958d2ee523a2206206994597c13d831ec7", "501": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "56": "0x55d398326f99059ff775485246999027b3197955" });
// USDT0 issuer deployment: https://docs.usdt0.to/technical-documentation/deployments
// SPYon BSC identity: Binance public RWA list?type=1; underlying ETF: https://app.ondo.finance/assets/spyon
const SOURCE_PRICED = Object.freeze({ "196:0x779ded0c9e1022225f8e0630b35a9b54be713736": { symbol: "USDT0", category: "稳定币" },
  "56:0x6a708ead771238919d85930b5a0f10454e1c331a": { symbol: "SPYon", name: "SPYon · Ondo 代币化ETF", category: "股票ETF" } });
const PROVIDER_NAMES = Object.freeze({ okxweb3: "OKX Web3", tokenpocket: "TokenPocket", binanceagentic: "币安Agentic Wallet", okxagentic: "OKX Agentic Wallet" });
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

class WalletAssetsError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode;
  }
}

const invalid = () => new WalletAssetsError("钱包资产响应不完整或无法核实，现有资产未被改动");
const denied = () => new WalletAssetsError("OnchainOS 开发者凭据、权限或 IP 校验未通过，请核对", 400);
const digest = (value) => createHash("sha256").update(value).digest("hex");

function atTime(now) {
  const at = now();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new WalletAssetsError("同步服务器时间无效", 500);
  return at;
}

function solanaAddress(value) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let decoded = 0n;
  for (const character of value) decoded = decoded * 58n + BigInt(BASE58.indexOf(character));
  if (decoded === 0n) return false;
  const leading = value.match(/^1*/)[0].length;
  return leading + Math.ceil(decoded.toString(16).length / 2) === 32;
}

function address(value, chainIndex) {
  if (chainIndex === "501") {
    if (!solanaAddress(value)) throw invalid();
    return value;
  }
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw invalid();
  return value.toLowerCase();
}

function decimal(value) {
  if (typeof value !== "string" || value.length > 120 || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw invalid();
  return value;
}

const positive = (value) => /[1-9]/.test(value);

function price(value) {
  return typeof value === "string" && value.length <= 120 && /^\d+(?:\.\d+)?$/.test(value)
    && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= MAX_VALUE ? Number(value) : null;
}

function label(value, fallback, max = 100) {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value.trim().slice(0, max) || fallback;
}

function noMorePages(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 2) return false;
  if (["next", "nextCursor", "next_cursor", "cursor"].some((key) => value[key] !== undefined && value[key] !== null && value[key] !== "")) return false;
  if (["has_more", "hasMore"].some((key) => value[key] !== undefined && value[key] !== false)) return false;
  return value.pagination === undefined || noMorePages(value.pagination, depth + 1);
}

async function readJson(response) {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw invalid();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

function defiIsEmpty(data, at) {
  const updated = typeof data?.updateAt === "string" && /^\d{13}$/.test(data.updateAt) ? Number(data.updateAt) : data?.updateAt;
  if (data?.assetStatus !== 1 || !Number.isSafeInteger(updated) || updated > at.getTime() + 10_000 || at.getTime() - updated > 300_000
    || !Array.isArray(data.walletIdPlatformList) || data.walletIdPlatformList.length > 10 || !noMorePages(data)) return false;
  return data.walletIdPlatformList.every((wallet) => wallet && Array.isArray(wallet.platformList) && wallet.platformList.length === 0
    && (wallet.totalAssets === undefined || (typeof wallet.totalAssets === "string" && /^0(?:\.0+)?$/.test(wallet.totalAssets))));
}

export async function fetchWalletAssets({ provider, credentials, wallets, fetchImpl = fetch, now = () => new Date() }) {
  if (!Object.hasOwn(PROVIDER_NAMES, provider) || !credentials || [credentials.apiKey, credentials.secret, credentials.passphrase]
    .some((value) => typeof value !== "string" || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new WalletAssetsError("请填写有效的 OnchainOS Developer API Key、Secret 和 Passphrase", 400);
  }
  if (!Array.isArray(wallets) || !wallets.length || wallets.length > 10) throw new WalletAssetsError("请配置已确认网络的钱包公开地址", 400);
  const seenWallets = new Set();
  const bindings = wallets.map((wallet) => {
    try {
      if (!wallet || typeof wallet.chainIndex !== "string" || !Object.hasOwn(CHAINS, wallet.chainIndex)) throw invalid();
      const normalized = { chainIndex: wallet.chainIndex, address: address(wallet.address, wallet.chainIndex) };
      const key = `${normalized.chainIndex}:${normalized.address}`;
      if (seenWallets.has(key)) throw invalid();
      seenWallets.add(key);
      return normalized;
    } catch { throw new WalletAssetsError("钱包地址、网络或重复绑定无效，请核对 Ethereum、Solana、Polygon、BNB Smart Chain 或 X Layer 地址", 400); }
  });
  const started = atTime(now);
  const deadline = AbortSignal.timeout(45_000);
  async function request(url, body) {
    const target = new URL(url);
    const onchain = target.origin === HOST && [BALANCES, DEFI].includes(target.pathname)
      && ((target.pathname === BALANCES && body === undefined) || (target.pathname === DEFI && body !== undefined && !target.search));
    if (!onchain && url !== QUOTE) throw invalid();
    const method = body === undefined ? "GET" : "POST";
    const encoded = body === undefined ? "" : JSON.stringify(body);
    const timestamp = atTime(now).toISOString();
    const headers = { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) };
    if (onchain) Object.assign(headers, { "OK-ACCESS-KEY": credentials.apiKey, "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": credentials.passphrase,
      "OK-ACCESS-SIGN": createHmac("sha256", credentials.secret).update(`${timestamp}${method}${target.pathname}${target.search}${encoded}`).digest("base64") });
    try {
      const response = await fetchImpl(url, { method, headers, redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]), ...(body === undefined ? {} : { body: encoded }) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (onchain && [401, 403].includes(response.status)) throw denied();
        if (response.status === 429) throw new WalletAssetsError("钱包只读查询访问受限，请稍后重试", 429);
        throw new WalletAssetsError("钱包只读接口访问失败，请检查开发者凭据和服务权限");
      }
      const payload = await readJson(response);
      if (!onchain) return payload;
      if (["50103", "50114"].includes(String(payload?.code))) throw denied();
      if (String(payload?.code) === "50011") throw new WalletAssetsError("钱包只读查询访问受限，请稍后重试", 429);
      if (![0, "0"].includes(payload?.code) || !Object.hasOwn(payload, "data") || !noMorePages(payload)) throw invalid();
      return payload.data;
    } catch (error) {
      if (error instanceof WalletAssetsError) throw error;
      throw new WalletAssetsError("钱包只读请求失败或超时，现有资产未被改动");
    }
  }
  const scopes = [];
  for (const wallet of bindings) {
    const query = new URLSearchParams({ address: wallet.address, chains: wallet.chainIndex, excludeRiskToken: "1", filter: "1" });
    const payload = await request(`${HOST}${BALANCES}?${query}`);
    if (!Array.isArray(payload) || payload.length !== 1 || !Array.isArray(payload[0]?.tokenAssets)
      || !noMorePages(payload[0]) || payload[0].tokenAssets.length > MAX_ASSETS) throw invalid();
    const seen = new Set();
    const rows = payload[0].tokenAssets.map((row) => {
      if (!row || row.chainIndex !== wallet.chainIndex || address(row.address, wallet.chainIndex) !== wallet.address
        || typeof row.tokenContractAddress !== "string" || typeof row.isRiskToken !== "boolean") throw invalid();
      const contract = row.tokenContractAddress === "" ? "" : address(row.tokenContractAddress, wallet.chainIndex);
      if (seen.has(contract)) throw invalid();
      seen.add(contract);
      const quantity = decimal(row.balance);
      const symbol = label(row.symbol, contract ? "未知代币" : CHAINS[wallet.chainIndex].symbol);
      if (!contract && symbol !== CHAINS[wallet.chainIndex].symbol) throw invalid();
      return { ...wallet, contract, symbol, name: label(row.tokenName, symbol, 130), quantity, tokenPrice: price(row.tokenPrice), risk: row.isRiskToken };
    }).filter((row) => positive(row.quantity));
    let defiClear = false;
    try {
      const data = await request(`${HOST}${DEFI}`, { walletAddressList: [{ chainIndex: wallet.chainIndex, walletAddress: wallet.address }] });
      defiClear = defiIsEmpty(data, atTime(now));
    } catch { /* Token inventory remains useful; a failed protocol query never proves zero DeFi. */ }
    scopes.push({ wallet, rows, defiClear });
  }
  const rows = scopes.flatMap((scope) => scope.rows);
  if (rows.length > MAX_ASSETS) throw invalid();
  let usdtPrice = null;
  if (rows.some((row) => row.contract && row.contract === USDT[row.chainIndex] && !row.risk)) {
    try {
      const payload = await request(QUOTE);
      const pairs = payload?.result && Object.keys(payload.result).filter((key) => key !== "last");
      if (!Array.isArray(payload?.error) || payload.error.length || pairs?.length !== 1 || !["USDTZUSD", "USDTUSD"].includes(pairs[0])) throw invalid();
      const trades = payload.result[pairs[0]];
      const trade = Array.isArray(trades) && trades.length === 1 ? trades[0] : null;
      const value = price(trade?.[0]);
      const observed = typeof trade?.[2] === "number" ? trade[2] * 1000 : NaN;
      const at = atTime(now).getTime();
      if (!value || !Number.isFinite(observed) || observed > at + 10_000 || at - observed > 900_000) throw invalid();
      usdtPrice = { value, observedAt: new Date(observed).toISOString() };
    } catch { /* Keep exact USDT quantity unpriced instead of assuming its peg. */ }
  }
  const holdings = [];
  const unpricedAssets = [];
  for (const row of rows) {
    const native = row.contract === "";
    const tether = !native && row.contract === USDT[row.chainIndex];
    const sourcePriced = SOURCE_PRICED[`${row.chainIndex}:${row.contract}`];
    const known = native || tether || sourcePriced;
    const usdPrice = row.risk || !known ? null : tether ? usdtPrice?.value : row.tokenPrice;
    if (!usdPrice) {
      unpricedAssets.push({ chainIndex: row.chainIndex, contract: row.contract, symbol: row.symbol, name: row.name, quantity: row.quantity,
        reason: !known || row.risk ? "代币身份、风险或报价时点尚未核实，未采用提供商估值" : "缺少可核实的有效 USD 报价，未按固定美元价格估值" });
      continue;
    }
    const amount = Number(row.quantity) * usdPrice;
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_VALUE) throw invalid();
    const symbol = native ? CHAINS[row.chainIndex].symbol : tether ? "USDT" : sourcePriced.symbol;
    holdings.push({ externalId: `token:${digest(`${row.chainIndex}:${row.address}:${row.contract || "native"}`)}`,
      chainIndex: row.chainIndex, contract: row.contract, name: `${sourcePriced?.name || symbol}（${CHAINS[row.chainIndex].name}）`, category: tether ? "稳定币" : sourcePriced?.category || "加密资产",
      currency: "USD", amount, quantity: row.quantity, rawQuantity: row.quantity, symbol });
  }
  const fetched = atTime(now);
  const total = holdings.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isFinite(total) || total > MAX_VALUE || fetched.getTime() < started.getTime() || fetched.getTime() - started.getTime() > 45_000) throw invalid();
  const pendingDefi = scopes.filter((scope) => !scope.defiClear);
  return {
    provider, currency: "USD", total, holdings, unpricedAssets, breakdownComplete: true,
    valuationComplete: unpricedAssets.length === 0 && pendingDefi.length === 0,
    externalAccountId: `wallets:${digest([...seenWallets].sort().join("|"))}`,
    accountLabel: `${PROVIDER_NAMES[provider]} · ${bindings.map((wallet) => CHAINS[wallet.chainIndex].name).join(" / ")}`,
    asOf: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(fetched),
    fetchedAt: fetched.toISOString(), observedAt: null, timeBasis: "retrieved",
    coverage: ["指定链和公开地址的原生币与提供商完整返回的 ERC20 / SPL / Token2022 代币；风险与空投过滤已关闭。",
      "不含 NFT、压缩 NFT、其他地址或其他链；未解码的质押、借款和待领取权益不视为零。",
      ...scopes.map((scope) => `${CHAINS[scope.wallet.chainIndex].name}：${scope.defiClear ? "DeFi 查询明确返回近期空协议列表" : "DeFi 协议资产或覆盖范围待核实"}。`)],
    warnings: ["总额仅为已核实币种的已定价小计；缺价资产保留准确数量，未用零金额占位。",
      "代币余额与原生币来源报价未提供精确资产或报价时点，页面标记为获取时间，不代表同一实时区块。",
      "只按链与合约识别资产；未知代币即使返回价格也暂不估值，名称和风险标记不构成身份确认。",
      ...(usdtPrice ? [`USDT 使用 Kraken USDT / USD 最近成交价；报价时点 ${usdtPrice.observedAt}，不假设固定 1 美元。`] : []),
      ...(rows.some((row) => row.chainIndex === "56" && row.contract === USDT["56"]) ? ["BSC USDT 为 Binance-Peg 合约；美元估值使用 USDT / USD 参考成交价，不核实其链上赎回或跨链溢折价。"] : []),
      ...(holdings.some((row) => row.symbol === "USDT0") ? ["USDT0 使用提供商返回的实际 USD 报价，不按固定 1 美元估值；源未提供精确报价时点，标记为获取时间。"] : []),
      ...(holdings.some((row) => row.symbol === "SPYon") ? ["SPYon 为 Ondo 代币化 ETF，按实际代币数量和提供商每代币 USD 价格估值，不转换为券商股数，也不使用固定份额乘数；源未提供精确报价时点。"] : []),
      ...(pendingDefi.length ? ["DeFi 覆盖待核实：协议汇总未加入小计；Polymarket / pUSD 与地址或代理账户口径冲突时，需要独立核对并避免重复计入。"] : [])],
  };
}
