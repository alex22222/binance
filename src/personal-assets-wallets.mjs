import { createHash, createHmac } from "node:crypto";

const HOST = "https://web3.okx.com";
const BALANCES = "/api/v6/dex/balance/all-token-balances-by-address";
const DEFI = "/api/v6/defi/user/asset/platform/list";
const MARKET_PRICE = "/api/v6/dex/market/price";
const QUOTE = "https://api.kraken.com/0/public/Trades?pair=USDTUSD&count=1";
// Exact Solana mint and decimals independently matched against its Token2022 mint metadata.
// https://developers.jup.ag/docs/price: blockId identifies the price, not createdAt.
const ZERO_MINT = "EmcxFTNVDqyLHp11NvwvLZ4D7LKGbG9i7B8RF7dwpump";
const ZERO_QUOTE = `https://api.jup.ag/price/v3?ids=${ZERO_MINT}`;
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
// Official Polygon Safe factory ABI and collateral identity: docs.polymarket.com/resources/contracts.
const POLYGON_RPC = "https://polygon.publicnode.com";
const SAFE_FACTORY = "0xaacfeea03eb1561c4e67d661e40682bd20e3541b";
const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const USDC_QUOTE = "https://api.kraken.com/0/public/Trades?pair=USDCUSD&count=1";
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
// SGOVon BSC address/18 decimals and fixed-income ETF identity: https://app.ondo.finance/assets/sgovon supportedNetworks.
const SOURCE_PRICED = Object.freeze({ "196:0x779ded0c9e1022225f8e0630b35a9b54be713736": { symbol: "USDT0", category: "稳定币" },
  "56:0x6a708ead771238919d85930b5a0f10454e1c331a": { symbol: "SPYon", name: "SPYon · Ondo 代币化ETF", category: "股票ETF" },
  "56:0xc008c5f579ec1450f20099c39f587547e27c7523": { symbol: "SGOVon", name: "SGOVon · Ondo 代币化美债ETF", category: "债券" } });
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

export async function fetchWalletAssets({ provider, credentials, wallets, polymarketSafeOwner = null, fetchImpl = fetch, now = () => new Date() }) {
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
  if (polymarketSafeOwner !== null && (provider !== "tokenpocket" || typeof polymarketSafeOwner !== "string"
    || !bindings.some(wallet => wallet.chainIndex === "137" && wallet.address === polymarketSafeOwner))) throw new WalletAssetsError("Safe 读取范围必须明确选择已绑定的 TokenPocket Polygon owner", 400);
  const started = atTime(now);
  const deadline = AbortSignal.timeout(45_000);
  async function request(url, body) {
    const target = new URL(url);
    const zeroMarket = url === `${HOST}${MARKET_PRICE}` && Array.isArray(body) && body.length === 1
      && Object.keys(body[0] || {}).length === 2 && body[0].chainIndex === "501" && body[0].tokenContractAddress === ZERO_MINT;
    const onchain = zeroMarket || target.origin === HOST && [BALANCES, DEFI].includes(target.pathname)
      && ((target.pathname === BALANCES && body === undefined) || (target.pathname === DEFI && body !== undefined && !target.search));
    const zeroQuote = url === ZERO_QUOTE && body === undefined;
    const zeroTime = url === SOLANA_RPC && body?.jsonrpc === "2.0" && body.id === 1 && body.method === "getBlockTime"
      && Object.keys(body).length === 4 && Array.isArray(body.params) && body.params.length === 1 && Number.isSafeInteger(body.params[0]) && body.params[0] > 0;
    const polygonRead = url === POLYGON_RPC && Array.isArray(body) && body.length > 0 && body.length <= 5 && body.every(row => row?.jsonrpc === "2.0"
      && ["eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode", "eth_getBlockByNumber"].includes(row.method));
    if (!onchain && !([QUOTE, USDC_QUOTE].includes(url) && body === undefined) && !zeroQuote && !zeroTime && !polygonRead) throw invalid();
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
        if (zeroMarket) throw new WalletAssetsError("ZERO 的 OnchainOS 行情查询未完成", response.status);
        if (onchain && [401, 403].includes(response.status)) throw denied();
        if (zeroQuote || zeroTime) throw new WalletAssetsError("ZERO 公开报价查询未完成", response.status);
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
  const derivedWallets = [];
  const safeCoverage = [];
  if (polymarketSafeOwner !== null) {
    async function rpc(calls) {
      const payload = await request(POLYGON_RPC, calls.map(([method, params], index) => ({ jsonrpc: "2.0", id: index + 1, method, params })));
      if (!Array.isArray(payload) || payload.length !== calls.length) throw invalid();
      const byId = new Map();
      for (const row of payload) {
        if (row?.jsonrpc !== "2.0" || !Number.isInteger(row.id) || row.id < 1 || row.id > calls.length || byId.has(row.id)
          || row.error !== undefined || row.result === undefined || row.result === null) throw invalid();
        byId.set(row.id, row.result);
      }
      return calls.map((_, index) => byId.get(index + 1));
    }
    const hex = value => {
      if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || value.length > 66) throw invalid();
      return BigInt(value);
    };
    const uint = value => {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw invalid();
      return BigInt(value);
    };
    const [chain, block] = await rpc([["eth_chainId", []], ["eth_blockNumber", []]]);
    if (hex(chain) !== 137n || hex(block) <= 0n || hex(block) > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
    for (const wallet of bindings.filter(row => row.chainIndex === "137" && row.address === polymarketSafeOwner)) {
      const [encoded] = await rpc([["eth_call", [{ to: SAFE_FACTORY, data: `0xd600539a${wallet.address.slice(2).padStart(64, "0")}` }, block]]]);
      if (typeof encoded !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(encoded)) throw invalid();
      const safe = address(`0x${encoded.slice(-40)}`, "137");
      if ([wallet.address, SAFE_FACTORY, PUSD].includes(safe) || seenWallets.has(`137:${safe}`) || derivedWallets.some(row => row.address === safe)) throw invalid();
      const [code] = await rpc([["eth_getCode", [safe, block]]]);
      if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw invalid();
      if (code === "0x") { safeCoverage.push("Polymarket Safe 候选未部署，未证明归属或余额，不推定为零；不含该候选地址资产。"); continue; }
      const [owners, threshold, decimals, raw, detail] = await rpc([
        ["eth_call", [{ to: safe, data: "0xa0e67e2b" }, block]], ["eth_call", [{ to: safe, data: "0xe75235b8" }, block]],
        ["eth_call", [{ to: PUSD, data: "0x313ce567" }, block]],
        ["eth_call", [{ to: PUSD, data: `0x70a08231${safe.slice(2).padStart(64, "0")}` }, block]], ["eth_getBlockByNumber", [block, false]],
      ]);
      const expectedOwners = `0x${(32n).toString(16).padStart(64, "0")}${(1n).toString(16).padStart(64, "0")}${wallet.address.slice(2).padStart(64, "0")}`;
      if (typeof owners !== "string" || owners.toLowerCase() !== expectedOwners || uint(threshold) !== 1n || uint(decimals) !== 6n
        || uint(raw) > BigInt(Number.MAX_SAFE_INTEGER) || !detail || hex(detail.number) !== hex(block)
        || typeof detail.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(detail.hash)) throw invalid();
      const observed = Number(hex(detail.timestamp)) * 1000, at = atTime(now).getTime();
      if (!Number.isSafeInteger(observed) || observed > at + 10_000 || at - observed > 120_000) throw invalid();
      const balance = uint(raw), quantity = `${balance / 1_000_000n}.${String(balance % 1_000_000n).padStart(6, "0")}`.replace(/\.?0+$/, "");
      const proof = { protocol: "polymarket-safe-pusd", chainIndex: "137", owner: wallet.address, address: safe,
        cashRawBalance: balance.toString(), cashBlockNumber: block, cashObservedAt: new Date(observed).toISOString() };
      derivedWallets.push(proof);
      safeCoverage.push(`Polymarket Safe：同一 Polygon 区块 ${block} 重新核实唯一 owner 与 threshold 1，仅读取 pUSD 现金；余额区块时点 ${proof.cashObservedAt}；不含预测持仓、其他代币或协议。`);
      if (balance > 0n) rows.push({ chainIndex: "137", address: safe, contract: PUSD, symbol: "pUSD", name: "pUSD · USDC抵押权益参考", quantity, risk: false, proof });
    }
    if (rows.length > MAX_ASSETS) throw invalid();
  }
  let pusdPrice = null;
  if (rows.some(row => row.proof)) {
    try {
      const payload = await request(USDC_QUOTE), trades = payload?.result?.USDCUSD;
      const keys = payload?.result && Object.keys(payload.result).filter(key => key !== "last");
      if (!Array.isArray(payload?.error) || payload.error.length || keys?.length !== 1 || keys[0] !== "USDCUSD" || !Array.isArray(trades) || trades.length !== 1) throw invalid();
      const trade = trades[0], value = price(trade?.[0]), observed = typeof trade?.[2] === "number" ? trade[2] * 1000 : NaN, at = atTime(now).getTime();
      if (!value || !Number.isFinite(observed) || observed > at + 10_000 || at - observed > 300_000) throw invalid();
      pusdPrice = { value, observedAt: new Date(observed).toISOString() };
    } catch { /* Keep exact pUSD units; neither its name nor the collateral design proves a dollar peg. */ }
  }
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
  let zeroPrice = null;
  let zeroFallbackAllowed = true;
  let zeroReason = "ZERO 未取得可核实的 Jupiter USD 报价，保留数量暂不估值";
  if (rows.some((row) => row.chainIndex === "501" && row.contract === ZERO_MINT && !row.risk)) {
    try {
      const payload = await request(ZERO_QUOTE);
      const quote = payload?.[ZERO_MINT];
      zeroReason = "ZERO 的 Jupiter 报价未匹配精确 mint、6 位精度或有效 USD 价格与区块，保留数量暂不估值";
      if (payload && !Array.isArray(payload) && Object.keys(payload).length === 1 && Object.hasOwn(payload, ZERO_MINT)
        && quote?.decimals === 6 && typeof quote.usdPrice === "number" && Number.isFinite(quote.usdPrice) && quote.usdPrice > 0 && quote.usdPrice <= MAX_VALUE
        && Number.isSafeInteger(quote.blockId) && quote.blockId > 0) {
        const block = await request(SOLANA_RPC, { jsonrpc: "2.0", id: 1, method: "getBlockTime", params: [quote.blockId] });
        const observed = block?.result * 1000;
        const at = atTime(now).getTime();
        zeroReason = "ZERO 的 Solana 报价区块时点无法核实，保留数量暂不估值";
        if (block?.jsonrpc === "2.0" && block.id === 1 && block.error === undefined && Number.isSafeInteger(block.result) && block.result > 0 && Number.isSafeInteger(observed)) {
          if (observed > at + 10_000) zeroReason = "ZERO 的 Jupiter 报价时点超过允许的未来偏差，保留数量暂不估值";
          else if (at - observed > 300_000) zeroReason = "ZERO 的 Jupiter 报价已超过 5 分钟，保留数量暂不估值";
          else zeroPrice = { value: quote.usdPrice, observedAt: new Date(observed).toISOString(), source: "Jupiter Price V3" };
        }
      }
    } catch (error) {
      zeroFallbackAllowed = !(error instanceof WalletAssetsError && [401, 402, 403, 429].includes(error.statusCode));
      zeroReason = `ZERO 的 Jupiter 报价或 Solana 时点查询失败${error instanceof WalletAssetsError && [401, 402, 403, 429].includes(error.statusCode) ? `（HTTP ${error.statusCode}）` : "或响应无效"}，本次不重试，保留数量暂不估值`;
    }
    if (zeroPrice && atTime(now).getTime() - Date.parse(zeroPrice.observedAt) > 300_000) zeroPrice = null;
    if (!zeroPrice && zeroFallbackAllowed) {
      try {
        const payload = await request(`${HOST}${MARKET_PRICE}`, [{ chainIndex: "501", tokenContractAddress: ZERO_MINT }]);
        const quote = Array.isArray(payload) && payload.length === 1 ? payload[0] : null;
        const value = price(quote?.price), observed = typeof quote?.time === "string" && /^\d{13}$/.test(quote.time) ? Number(quote.time) : NaN;
        const at = atTime(now).getTime();
        zeroReason += "；ZERO 的 OnchainOS 参考报价未匹配精确链、mint、有效价格或 5 分钟内时点，保留数量暂不估值";
        if (quote?.chainIndex === "501" && quote.tokenContractAddress === ZERO_MINT && value && Number.isSafeInteger(observed)
          && observed <= at + 10_000 && at - observed <= 300_000) zeroPrice = { value, observedAt: new Date(observed).toISOString(), source: "OKX OnchainOS Market" };
      } catch (error) {
        zeroReason += `；ZERO 的 OnchainOS 参考报价查询失败${error instanceof WalletAssetsError && [401, 402, 403, 429].includes(error.statusCode) ? `（HTTP ${error.statusCode}）` : "或响应无效"}，未付款或重试，保留数量暂不估值`;
      }
    }
  }
  const fetched = atTime(now);
  if (zeroPrice && (fetched.getTime() - Date.parse(zeroPrice.observedAt) > 300_000 || Date.parse(zeroPrice.observedAt) > fetched.getTime() + 10_000)) {
    zeroPrice = null;
    zeroReason = "ZERO 报价在读取完成时已超出 5 分钟有效期或未来偏差，保留数量暂不估值";
  }
  if (pusdPrice && fetched.getTime() - Date.parse(pusdPrice.observedAt) > 300_000) pusdPrice = null;
  const holdings = [];
  const unpricedAssets = [];
  for (const row of rows) {
    const native = row.contract === "";
    const tether = !native && row.contract === USDT[row.chainIndex];
    const zero = row.chainIndex === "501" && row.contract === ZERO_MINT;
    const pusd = Boolean(row.proof);
    const sourcePriced = SOURCE_PRICED[`${row.chainIndex}:${row.contract}`];
    const known = native || tether || sourcePriced || zero || pusd;
    const usdPrice = row.risk || !known ? null : tether ? usdtPrice?.value : zero ? zeroPrice?.value : pusd ? pusdPrice?.value : row.tokenPrice;
    const externalId = `token:${digest(`${row.chainIndex}:${row.address}:${row.contract || "native"}`)}`;
    if (!usdPrice) {
      unpricedAssets.push({ externalId, chainIndex: row.chainIndex, contract: row.contract, symbol: row.symbol, name: row.name, quantity: row.quantity,
        reason: pusd ? `pUSD 未取得 5 分钟内 USDC/USD 参考报价，暂不估值；已核实 Safe 余额区块 ${row.proof.cashBlockNumber}，时点 ${row.proof.cashObservedAt}` : zero ? row.risk ? "ZERO 被提供商标记风险，保留数量暂不估值" : zeroReason : !known || row.risk ? "代币身份、风险或报价时点尚未核实，未采用提供商估值" : "缺少可核实的有效 USD 报价，未按固定美元价格估值" });
      continue;
    }
    const amount = Number(row.quantity) * usdPrice;
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_VALUE) throw invalid();
    const symbol = native ? CHAINS[row.chainIndex].symbol : tether ? "USDT" : zero ? "ZERO" : pusd ? "pUSD" : sourcePriced.symbol;
    holdings.push({ externalId,
      chainIndex: row.chainIndex, contract: row.contract, name: `${pusd ? row.name : sourcePriced?.name || symbol}（${CHAINS[row.chainIndex].name}）`, category: tether || pusd ? "稳定币" : sourcePriced?.category || "加密资产",
      currency: "USD", amount, quantity: row.quantity, rawQuantity: row.quantity, symbol,
      ...(zero ? { quoteObservedAt: zeroPrice.observedAt, quoteSource: zeroPrice.source } : {}),
      ...(pusd ? { quoteObservedAt: pusdPrice.observedAt, quoteSource: "Kraken USDC/USD · pUSD抵押权益参考", balanceAddress: row.address,
        cashRawBalance: row.proof.cashRawBalance, cashBlockNumber: row.proof.cashBlockNumber, cashObservedAt: row.proof.cashObservedAt } : {}) });
  }
  const finished = atTime(now);
  const total = holdings.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isFinite(total) || total > MAX_VALUE || fetched.getTime() < started.getTime() || finished.getTime() < fetched.getTime() || finished.getTime() - started.getTime() > 45_000) throw invalid();
  const pendingDefi = scopes.filter((scope) => !scope.defiClear);
  return {
    provider, currency: "USD", total, holdings, unpricedAssets, derivedWallets, breakdownComplete: true,
    valuationComplete: unpricedAssets.length === 0 && pendingDefi.length === 0 && polymarketSafeOwner === null,
    externalAccountId: `wallets:${digest([...seenWallets].sort().join("|"))}`,
    accountLabel: `${PROVIDER_NAMES[provider]} · ${bindings.map((wallet) => CHAINS[wallet.chainIndex].name).join(" / ")}`,
    asOf: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(fetched),
    fetchedAt: fetched.toISOString(), observedAt: null, timeBasis: "retrieved",
    coverage: ["指定链和公开地址的原生币与提供商完整返回的 ERC20 / SPL / Token2022 代币；风险与空投过滤已关闭。",
      "不含 NFT、压缩 NFT、其他地址或其他链；未解码的质押、借款和待领取权益不视为零。",
      ...scopes.map((scope) => `${CHAINS[scope.wallet.chainIndex].name}：${scope.defiClear ? "DeFi 查询明确返回近期空协议列表" : "DeFi 协议资产或覆盖范围待核实"}。`), ...safeCoverage],
    warnings: ["总额仅为已核实币种的已定价小计；缺价资产保留准确数量，未用零金额占位。",
      "代币余额与原生币来源报价未提供精确资产或报价时点，页面标记为获取时间，不代表同一实时区块。",
      "只按链与合约识别资产；未知代币即使返回价格也暂不估值，名称和风险标记不构成身份确认。",
      ...(usdtPrice ? [`USDT 使用 Kraken USDT / USD 最近成交价；报价时点 ${usdtPrice.observedAt}，不假设固定 1 美元。`] : []),
      ...(zeroPrice ? [`ZERO 使用精确 Solana mint 的 ${zeroPrice.source} USD 参考价；价格时点 ${zeroPrice.observedAt}，不等于余额时点；仅接受 5 分钟内报价，不保证成交或变现净额。`] : []),
      ...(derivedWallets.length ? ["pUSD 为 USDC 抵押权益，按单位数量及 5 分钟内 Kraken USDC/USD 成交价参考估值；不是 pUSD 的直接成交价，当前抵押储备和赎回能力未核实，不代表可变现净额。"] : []),
      ...(rows.some((row) => row.chainIndex === "56" && row.contract === USDT["56"]) ? ["BSC USDT 为 Binance-Peg 合约；美元估值使用 USDT / USD 参考成交价，不核实其链上赎回或跨链溢折价。"] : []),
      ...(holdings.some((row) => row.symbol === "USDT0") ? ["USDT0 使用提供商返回的实际 USD 报价，不按固定 1 美元估值；源未提供精确报价时点，标记为获取时间。"] : []),
      ...["SPYon", "SGOVon"].filter(symbol => holdings.some(row => row.symbol === symbol)).map(symbol => `${symbol} 为 Ondo 代币化 ETF，按实际代币数量和提供商每代币 USD 价格估值，不转换为券商股数，也不使用固定份额乘数；源未提供精确报价时点。`),
      ...(pendingDefi.length ? ["DeFi 覆盖待核实：协议汇总未加入小计；Polymarket / pUSD 与地址或代理账户口径冲突时，需要独立核对并避免重复计入。"] : [])],
  };
}
