const DATA_HOST = "https://data-api.polymarket.com";
const RPC_HOSTS = ["https://polygon.drpc.org", "https://polygon.publicnode.com"];
const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const MAX_BYTES = 1_000_000;
const MAX_HOLDINGS = 999;
const MAX_VALUE = 1_000_000_000_000;
const MAX_AGE = 120_000;

class PolymarketAssetsError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode;
  }
}

const invalid = () => new PolymarketAssetsError("Polymarket 资产响应不完整或无法核实，现有资产未被改动");
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_VALUE;

function atTime(now) {
  const at = now();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new PolymarketAssetsError("同步服务器时间无效", 500);
  return at;
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

function hex(value, { bytes } = {}) {
  if (typeof value !== "string" || !(bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).test(value)) throw invalid();
  return BigInt(value);
}

function text(value, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value.trim();
}

function status(payload, at) {
  const row = payload?.data;
  const computed = typeof row?.computed_at === "string" ? Date.parse(row.computed_at) : NaN;
  if (!Number.isFinite(computed) || computed > at.getTime() + 10_000 || at.getTime() - computed > MAX_AGE
    || !number(row.age_seconds) || row.age_seconds * 1000 > MAX_AGE
    || !number(row.serving?.lag_seconds) || row.serving.lag_seconds * 1000 > MAX_AGE
    || Math.max(row.age_seconds * 1000, at.getTime() - computed) + row.serving.lag_seconds * 1000 > MAX_AGE
    || row.ingestion?.chain_id !== 137 || row.ingestion?.network !== "polygon") {
    throw new PolymarketAssetsError("Polymarket 索引数据已延迟或时点无法核实，暂不更新资产");
  }
  return row;
}

export async function fetchPolymarketAssets({ address, fetchImpl = fetch, now = () => new Date() }) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)
    || /^0x0{40}$/i.test(address) || address.toLowerCase() === PUSD) {
    throw new PolymarketAssetsError("请填写 Polymarket 的 Polygon 资金或代理钱包地址", 400);
  }
  address = address.toLowerCase();
  const started = atTime(now);
  const deadline = AbortSignal.timeout(45_000);
  async function request(url, body) {
    const target = new URL(url);
    if (![DATA_HOST, ...RPC_HOSTS, "https://api.kraken.com"].includes(target.origin)) throw invalid();
    try {
      const response = await fetchImpl(url, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.any([deadline, AbortSignal.timeout(8000)]),
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) throw new PolymarketAssetsError("Polymarket 只读数据访问受限，请稍后重试", 429);
        throw invalid();
      }
      return await readJson(response);
    } catch (error) {
      if (error instanceof PolymarketAssetsError) throw error;
      throw new PolymarketAssetsError("Polymarket 只读请求失败或超时，现有资产未被改动");
    }
  }
  async function rpc(host, calls) {
    const result = await request(host, calls.map(([method, params], index) => ({ jsonrpc: "2.0", id: index + 1, method, params })));
    if (!Array.isArray(result) || result.length !== calls.length) throw invalid();
    const byId = new Map();
    for (const row of result) {
      if (row?.jsonrpc !== "2.0" || !Number.isInteger(row.id) || row.id < 1 || row.id > calls.length || byId.has(row.id)
        || row.error || !Object.hasOwn(row, "result") || row.result === null) throw invalid();
      byId.set(row.id, row.result);
    }
    return calls.map((_, index) => byId.get(index + 1));
  }
  async function cash(host) {
    const [chain, block] = await rpc(host, [["eth_chainId", []], ["eth_blockNumber", []]]);
    if (hex(chain) !== 137n || hex(block) === 0n) throw invalid();
    const [balance, detail] = await rpc(host, [
      ["eth_call", [{ to: PUSD, data: `0x70a08231${address.slice(2).padStart(64, "0")}` }, block]],
      ["eth_getBlockByNumber", [block, false]],
    ]);
    const raw = hex(balance, { bytes: 32 });
    if (raw > BigInt(Number.MAX_SAFE_INTEGER) || !detail || hex(detail.number) !== hex(block)) throw invalid();
    const timestamp = Number(hex(detail.timestamp)) * 1000;
    const at = atTime(now).getTime();
    if (!Number.isFinite(timestamp) || timestamp > at + 10_000 || at - timestamp > MAX_AGE) {
      throw new PolymarketAssetsError("Polygon 区块时点已过期或不正确，暂不更新 Polymarket 资产");
    }
    return { raw, quantity: Number(raw) / 1_000_000, block, observedAt: new Date(timestamp).toISOString(), host };
  }
  async function initialCash() {
    for (const host of RPC_HOSTS) {
      try { return await cash(host); }
      catch (error) { if (host === RPC_HOSTS.at(-1)) throw error; }
    }
  }
  async function pages(kind) {
    const rows = [];
    const cursors = new Set();
    let cursor;
    for (let index = 0; index < 20; index++) {
      const query = new URLSearchParams({ user: address, limit: "100" });
      if (kind === "positions") {
        query.set("status", "OPEN"); query.set("filter_type", "TOKENS");
        query.set("filter_amount", "0"); query.set("include_archived", "true");
      }
      if (cursor) query.set("cursor", cursor);
      const payload = await request(`${DATA_HOST}/v2/${kind}?${query}`);
      if (!Array.isArray(payload?.data) || payload.data.length > 100 || !payload.pagination
        || typeof payload.pagination.has_more !== "boolean") throw invalid();
      rows.push(...payload.data);
      if (rows.length > MAX_HOLDINGS) throw new PolymarketAssetsError("Polymarket 持仓数量超过当前同步上限，尚未完整读取");
      const next = payload.pagination.next_cursor;
      if (!payload.pagination.has_more) {
        if (next !== null) throw invalid();
        return rows;
      }
      if (!payload.data.length || typeof next !== "string" || !next.length || next.length > 4000 || cursors.has(next)) throw invalid();
      cursors.add(next); cursor = next;
    }
    throw new PolymarketAssetsError("Polymarket 持仓尚未完整读取，现有资产未被改动");
  }
  async function usdcPrice() {
    const payload = await request("https://api.kraken.com/0/public/Trades?pair=USDCUSD&count=1");
    const trades = payload?.result?.USDCUSD;
    if (!Array.isArray(payload?.error) || payload.error.length || !Array.isArray(trades) || trades.length !== 1) throw invalid();
    const trade = trades[0];
    if (!Array.isArray(trade) || typeof trade[0] !== "string" || !/^\d+(?:\.\d+)?$/.test(trade[0])
      || !number(Number(trade[0])) || Number(trade[0]) === 0 || !number(trade[2])) throw invalid();
    const at = atTime(now).getTime();
    const timestamp = trade[2] * 1000;
    if (timestamp > at + 10_000 || at - timestamp > 15 * 60_000) {
      throw new PolymarketAssetsError("USDC / USD 市场报价已过期，未按固定 1 美元换算资产");
    }
    return { value: Number(trade[0]), observedAt: new Date(timestamp).toISOString() };
  }

  const [firstCash, positions, combos, initialStatus, price] = await Promise.all([
    initialCash(), pages("positions"), pages("positions/combos"), request(`${DATA_HOST}/v2/status`), usdcPrice(),
  ]);
  status(initialStatus, atTime(now));
  for (const row of combos) {
    if (!row || typeof row.proxy_wallet !== "string" || row.proxy_wallet.toLowerCase() !== address || !number(row.current_size)) throw invalid();
    if (row.current_size > 0) throw new PolymarketAssetsError("Polymarket 存在组合仓位，尚无完整的实时市值口径；现有资产未被改动", 422);
  }
  const holdings = [];
  const seen = new Set();
  let positionValue = 0;
  let fractionalValue = 0;
  let fractionalCount = 0;
  for (const row of positions) {
    if (!row || typeof row.proxy_wallet !== "string" || row.proxy_wallet.toLowerCase() !== address
      || typeof row.token_id !== "string" || !/^\d{1,78}$/.test(row.token_id) || BigInt(row.token_id) >= 2n ** 256n
      || typeof row.condition_id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.condition_id)
      || !number(row.current_size) || !number(row.current_price) || row.current_price > 1 || !number(row.current_value)
      || !["OPEN", "REDEEMABLE"].includes(row.status) || typeof row.redeemable !== "boolean"
      || Math.abs(row.current_size * row.current_price - row.current_value) > 0.010001) throw invalid();
    // Repeated positions can reflect an index change during pagination; never add them twice.
    if (seen.has(row.token_id)) throw new PolymarketAssetsError("Polymarket 分页出现重复持仓，本轮数据可能变化，请稍后重试");
    seen.add(row.token_id);
    if (row.current_size === 0) {
      if (row.current_value !== 0) throw invalid();
      continue;
    }
    const title = text(row.title || "预测市场持仓", 500).slice(0, 130);
    const outcome = text(row.outcome, 100).slice(0, 35);
    positionValue += row.current_value;
    if (row.current_size < 1) { fractionalValue += row.current_value; fractionalCount++; }
    holdings.push({ externalId: `position:${row.token_id}`, name: `${title} · ${outcome}`, category: "组合资产", currency: "USD",
      amount: row.current_value * price.value, quantity: row.current_size, symbol: row.token_id, sourceCurrency: "USDC", sourceAmount: row.current_value });
  }
  const [lastCash, officialValue, finalStatus] = await Promise.all([
    cash(firstCash.host), request(`${DATA_HOST}/v2/value?${new URLSearchParams({ user: address })}`), request(`${DATA_HOST}/v2/status`),
  ]);
  const fetched = atTime(now);
  const index = status(finalStatus, fetched);
  if (fetched.getTime() - started.getTime() < 0 || fetched.getTime() - started.getTime() > 45_000
    || firstCash.raw !== lastCash.raw || hex(lastCash.block) < hex(firstCash.block)) {
    throw new PolymarketAssetsError("Polymarket 账户在读取期间发生变化或读取过久，请稍后重试；现有资产未被改动");
  }
  if (typeof officialValue?.data?.proxy_wallet !== "string" || officialValue.data.proxy_wallet.toLowerCase() !== address
    || !number(officialValue.data.value) || !number(positionValue)) throw invalid();
  const fullValueMatches = Math.abs(positionValue - officialValue.data.value) <= 0.010001;
  // The public aggregate has been observed to omit sub-one-share positions.
  // Accept that exact, independently computed scope only; retain every held fraction.
  const fractionalValueMatches = fractionalCount > 0 && Math.abs(positionValue - fractionalValue - officialValue.data.value) <= 0.010001;
  if (!fullValueMatches && !fractionalValueMatches) {
    throw new PolymarketAssetsError("Polymarket 全部分页持仓与官方估值未对齐，暂不更新资产");
  }
  if (lastCash.quantity > 0) holdings.unshift({ externalId: "cash:137:pusd", name: "Polymarket 资金（pUSD）", category: "稳定币", currency: "USD",
    amount: lastCash.quantity * price.value, quantity: lastCash.quantity, symbol: "pUSD", sourceCurrency: "USDC", sourceAmount: lastCash.quantity });
  const total = holdings.reduce((sum, row) => sum + row.amount, 0);
  if (!number(total) || holdings.some((row) => !number(row.amount))) throw invalid();
  return {
    provider: "polymarket", currency: "USD", total, externalAccountId: address, accountLabel: "Polymarket · Polygon 资金钱包",
    asOf: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(fetched), observedAt: null, timeBasis: "retrieved", fetchedAt: fetched.toISOString(),
    holdings, breakdownComplete: true,
    coverage: ["Polygon pUSD 自有余额", "所有已返回分页中的预测市场持仓，含不足 1 份碎仓和待赎回仓位", "已核实当前没有仍持有的组合仓位", "现金和持仓均按 USDC / USD 市场报价折算"],
    warnings: ["账户总额为自有 pUSD 余额加预测仓位现值；持仓已包含待赎回价值，不再次加总。",
      "pUSD 为 USDC 抵押凭证；现金和持仓使用同一 USDC / USD 报价，不默认固定 1 美元。",
      `Polygon 现金区块时间：${lastCash.observedAt}；Kraken USDC / USD 最近成交：${price.observedAt}。`,
      "平台持仓未提供本次估值时点，页面日期为获取日期；不含其他链、其他钱包、NFT、DeFi 或该地址其他代币。",
      "如 Future 或 TokenPocket 使用同一资金地址，其相同现金和持仓只能计入一次。",
      ...(!fullValueMatches && fractionalValueMatches ? [`官方持仓汇总未含 ${fractionalCount} 条不足 1 份的碎仓；本页保留这些真实持仓，总额使用全部明细合计。`] : [])],
    valuation: { sourceCurrency: "USDC", sourceAmount: lastCash.quantity + positionValue, usdPrice: price.value, quoteObservedAt: price.observedAt,
      cashRawBalance: lastCash.raw.toString(), cashBlockNumber: lastCash.block, cashObservedAt: lastCash.observedAt,
      indexComputedAt: index.computed_at, indexLagSeconds: index.serving.lag_seconds },
  };
}
