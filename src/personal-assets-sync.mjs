import { constants } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CATEGORIES, CURRENCIES, validatePortfolio, nextAssetRefreshAt } from "./personal-assets-core.mjs";
import { readPersonalAssets, savePersonalAssets, createPersonalAssetsSnapshot } from "./personal-assets.mjs";
import { fetchOkxAssets } from "./personal-assets-okx.mjs";
import { fetchPolymarketAssets } from "./personal-assets-polymarket.mjs";
import { fetchWalletAssets } from "./personal-assets-wallets.mjs";
import { valuePersonalAssetState } from "./personal-assets-fx.mjs";
import { registerFutuClient, createFutuAuthorization, exchangeFutuCode, refreshFutuToken, fetchFutuAccounts, fetchFutuAssets } from "./personal-assets-futu.mjs";

const PROVIDERS = { okx: { id: "okx-exchange", platform: "OKX", name: "OKX · 交易所" }, futu: { id: "futu-hk", platform: "富途", name: "富途 · 证券账户" },
  polymarket: { id: "polymarket-main", platform: "Polymarket", name: "Polymarket · 资产账户" }, future: { id: "future-main", platform: "Future", name: "Future · Polygon 交易账户" },
  okxweb3: { id: "okx-web3", platform: "OKX", name: "OKX · Web3 钱包" }, tokenpocket: { id: "tokenpocket-main", platform: "TokenPocket", name: "TokenPocket · 钱包" } };
const adapters = { fetchOkxAssets, fetchPolymarketAssets, fetchWalletAssets, registerFutuClient, createFutuAuthorization, exchangeFutuCode, refreshFutuToken, fetchFutuAccounts, fetchFutuAssets };
const INTERVAL = 12 * 60 * 60_000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const failureText = "只读同步未完成，请检查授权、账户地区和网络，并核对最近入账状态。";
const callbackUri = "https://spaceflag.site/api/assets/sync/futu/callback";
const syncError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const predictionProvider = (provider) => ["polymarket", "future"].includes(provider);
const walletProvider = (provider) => ["okxweb3", "tokenpocket"].includes(provider);
const metadataLines = (value) => Array.isArray(value) ? value.filter((line) => typeof line === "string").map((line) => line.slice(0, 500)).slice(0, 20) : [];

function walletAddress(value, chainIndex) {
  if (typeof value !== "string") throw syncError("请输入有效的钱包公开地址。");
  const address = value.trim();
  if (chainIndex !== "501") {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address) || /^0x0{40}$/i.test(address)) throw syncError("请输入有效的钱包 EVM 公开地址。");
    return address.toLowerCase();
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw syncError("请输入有效的 Solana 钱包地址。");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const character of address) decoded = decoded * 58n + BigInt(alphabet.indexOf(character));
  if (!decoded || address.match(/^1*/)[0].length + Math.ceil(decoded.toString(16).length / 2) !== 32) throw syncError("请输入有效的 Solana 钱包地址。");
  return address;
}

function walletList(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw syncError("请至少绑定一个钱包地址，最多 10 个。");
  const seen = new Set();
  return value.map((row) => {
    if (!row || !["1", "501", "137"].includes(row.chainIndex)) throw syncError("钱包仅支持 Ethereum、Solana 和 Polygon 链。");
    const address = walletAddress(row.address, row.chainIndex);
    const key = `${row.chainIndex}:${address}`;
    if (seen.has(key)) throw syncError("同一链的钱包地址重复，请核对绑定。");
    seen.add(key);
    return { chainIndex: row.chainIndex, address };
  });
}

const walletIdentity = (wallets) => `wallets:${digest(wallets.map((row) => `${row.chainIndex}:${row.address}`).sort().join("|"))}`;
const exactQuantity = (value) => typeof value === "string" && value.length <= 120 && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));

function unpricedSummary(value = []) {
  if (!Array.isArray(value) || value.length > 999) throw syncError("钱包未估值资产无法核验。", 502);
  return value.map((row) => {
    if (!row || !["1", "501", "137"].includes(row.chainIndex) || typeof row.contract !== "string"
      || !exactQuantity(row.quantity) || !/[1-9]/.test(row.quantity)
      || ["symbol", "name", "reason"].some((key) => typeof row[key] !== "string" || !row[key].trim() || row[key].length > (key === "reason" ? 500 : key === "name" ? 180 : 100) || /[\u0000-\u001f\u007f]/.test(row[key]))) throw syncError("钱包未估值资产无法核验。", 502);
    let contract = "";
    try { if (row.contract) contract = walletAddress(row.contract, row.chainIndex); }
    catch { throw syncError("钱包未估值资产合约无法核验。", 502); }
    return { chainIndex: row.chainIndex, contract, symbol: row.symbol, name: row.name, quantity: row.quantity, reason: row.reason };
  });
}

function walletBindings(data) {
  if (data.walletBindings === undefined) return [];
  if (!Array.isArray(data.walletBindings) || data.walletBindings.length > 100) throw syncError("钱包来源绑定无法核验，请检查同步配置。", 500);
  return data.walletBindings.map((row) => {
    if (!row || !walletProvider(row.provider) || typeof row.targetAccountId !== "string") throw syncError("钱包来源绑定无法核验，请检查同步配置。", 500);
    return { provider: row.provider, targetAccountId: row.targetAccountId, wallets: walletList(row.wallets) };
  });
}

function rememberWalletBinding(data, provider, value) {
  if (!walletProvider(provider) || !value?.lastAppliedAt) return;
  const wallets = walletList(value.appliedWallets || value.wallets);
  const targetAccountId = value.targetAccountId || PROVIDERS[provider].id;
  data.walletBindings = [...walletBindings(data).filter((row) => row.targetAccountId !== targetAccountId), { provider, targetAccountId, wallets }];
}

function uniqueWalletSource(data, current, provider, wallets, targetAccountId) {
  if (provider === "okxweb3" && targetAccountId === (data.providers.okx?.targetAccountId || PROVIDERS.okx.id)) throw syncError("OKX 交易所账户不能作为 Web3 钱包同步目标。", 409);
  const keys = new Set(wallets.map((row) => `${row.chainIndex}:${row.address}`));
  const configured = Object.entries(data.providers).filter(([name, value]) => walletProvider(name) && name !== provider && value.wallets).map(([name, value]) => ({ provider: name, targetAccountId: value.targetAccountId || PROVIDERS[name].id, wallets: walletList(value.wallets), configured: true }));
  for (const row of [...configured, ...walletBindings(data)]) {
    if (row.provider === provider && row.targetAccountId === targetAccountId || !row.wallets.some((wallet) => keys.has(`${wallet.chainIndex}:${wallet.address}`))) continue;
    const account = current.portfolio.accounts.find((item) => item.id === row.targetAccountId);
    const counted = account && account.reviewStatus !== "pending" && current.portfolio.entries.some((entry) => entry.accountId === account.id && entry.kind === (account.basis === "holdings" ? "holding" : "total"));
    if (row.configured || counted) throw syncError("同一链和钱包地址已绑定其他账户，不能通过 OKX Web3 与 TokenPocket 重复计入；请先核对原账户。", 409);
  }
}

function separateExchangeTarget(data, provider, targetAccountId) {
  if (provider === "okx" && (data.providers.okxweb3?.targetAccountId === targetAccountId
    || walletBindings(data).some((row) => row.provider === "okxweb3" && row.targetAccountId === targetAccountId))) throw syncError("已绑定的 Web3 钱包账户不能作为 OKX 交易所同步目标。", 409);
}

async function walletAssets(provider, credentials, wallets, api, now) {
  const startedAt = Date.now();
  const result = await api.fetchWalletAssets({ provider, credentials, wallets, now: () => new Date(now.getTime() + Date.now() - startedAt) });
  if (result.externalAccountId !== walletIdentity(wallets)) throw syncError("返回的钱包来源与已绑定地址不符。", 502);
  return result;
}

function valuationSummary(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw syncError("资产估值来源无法核验。", 502);
  const result = {};
  for (const key of ["sourceAmount", "usdPrice", "indexLagSeconds"]) if (value[key] !== undefined) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1e12 || key === "usdPrice" && value[key] === 0) throw syncError("资产估值来源无法核验。", 502);
    result[key] = value[key];
  }
  if (value.sourceCurrency !== undefined) {
    if (!CURRENCIES.includes(value.sourceCurrency)) throw syncError("资产原币无法核验。", 502);
    result.sourceCurrency = value.sourceCurrency;
  }
  for (const key of ["quoteObservedAt", "cashObservedAt", "indexComputedAt"]) if (value[key] !== undefined) {
    if (typeof value[key] !== "string" || value[key].length > 40 || !Number.isFinite(Date.parse(value[key]))) throw syncError("资产来源时点无法核验。", 502);
    result[key] = value[key];
  }
  if (value.cashRawBalance !== undefined) {
    if (typeof value.cashRawBalance !== "string" || !/^\d{1,80}$/.test(value.cashRawBalance)) throw syncError("资产链上余额无法核验。", 502);
    result.cashRawBalance = value.cashRawBalance;
  }
  if (value.cashBlockNumber !== undefined) {
    if (typeof value.cashBlockNumber !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value.cashBlockNumber)) throw syncError("资产链上区块无法核验。", 502);
    result.cashBlockNumber = value.cashBlockNumber;
  }
  return result;
}

function predictionBindings(data) {
  if (data.predictionBindings === undefined) return [];
  if (!Array.isArray(data.predictionBindings) || data.predictionBindings.length > 100
    || data.predictionBindings.some((row) => !row || !predictionProvider(row.provider) || typeof row.targetAccountId !== "string" || typeof row.address !== "string" || !/^0x[a-f0-9]{40}$/.test(row.address))) throw syncError("公开资产来源绑定无法核验，请检查同步配置。", 500);
  return data.predictionBindings;
}

function rememberPredictionBinding(data, provider, value) {
  if (!predictionProvider(provider) || !value?.address || !value.lastAppliedAt) return;
  const targetAccountId = value.targetAccountId || PROVIDERS[provider].id;
  data.predictionBindings = [...predictionBindings(data).filter((row) => row.targetAccountId !== targetAccountId), { provider, targetAccountId, address: value.address.toLowerCase() }];
}

function uniquePredictionSource(data, current, provider, address, targetAccountId) {
  const configured = Object.entries(data.providers).filter(([name, value]) => predictionProvider(name) && name !== provider && value.address).map(([name, value]) => ({ provider: name, address: value.address, targetAccountId: value.targetAccountId || PROVIDERS[name].id, configured: true }));
  for (const row of [...configured, ...predictionBindings(data)]) {
    if (row.provider === provider && row.targetAccountId === targetAccountId || row.address.toLowerCase() !== address) continue;
    const account = current.portfolio.accounts.find((item) => item.id === row.targetAccountId);
    const counted = account && account.platform !== "待确认" && account.reviewStatus !== "pending" && current.portfolio.entries.some((entry) => entry.accountId === account.id && entry.kind === (account.basis === "holdings" ? "holding" : "total"));
    if (row.configured || counted) throw syncError("同一 Polygon 资金来源已绑定其他账户，不能通过 Polymarket 或 Future 重复计入；请先核对原账户。", 409);
  }
}

async function predictionAssets(provider, address, api, now) {
  const startedAt = Date.now();
  const result = await api.fetchPolymarketAssets({ address, now: () => new Date(now.getTime() + Date.now() - startedAt) });
  if (result.provider !== "polymarket") throw syncError("预测市场资产来源无法核验。", 502);
  return provider === "future" ? { ...result, provider: "future", accountLabel: "Future · Polygon 交易账户",
    holdings: result.holdings.map((row) => ({ ...row, name: row.name.replace(/^Polymarket/, "Future") })),
    coverage: [...(result.coverage || []), "读取已核实的 Future Polygon 交易账户，资产来源为 Polymarket 上游"],
    warnings: ["仅统计 Polygon 交易账户已到账资产；不包含未到账或跨链途中的 Solana 充值。", ...(result.warnings || [])] } : result;
}

function pathFor(stateDir) {
  if (typeof stateDir !== "string" || !stateDir.trim()) throw syncError("资产存储目录未配置。", 500);
  return join(resolve(stateDir), "personal-assets-sync.json");
}

async function readPrivate(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 4_000_000) throw new Error();
    const data = JSON.parse(await file.readFile("utf8"));
    if (data.schemaVersion !== 1 || !data.providers || typeof data.providers !== "object" || Array.isArray(data.providers)) throw new Error();
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, providers: {} };
    throw syncError("同步配置无法读取，请检查文件权限和备份。", 500);
  } finally { await file?.close(); }
}

async function writePrivate(path, data) {
  const source = JSON.stringify(data, null, 2) + "\n";
  if (Buffer.byteLength(source) > 4_000_000) throw syncError("同步记录过大。", 500);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(source);
    await file.sync();
    await file.close(); file = null;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function locked(stateDir, update) {
  const path = pathFor(stateDir);
  const directory = resolve(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022)) throw syncError("同步目录不安全。", 500);
  let lock;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { lock = await open(`${path}.lock`, "wx", 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 39) throw syncError("同步正在进行，请稍后重试。", 409);
      await delay(50);
    }
  }
  try { return await update(await readPrivate(path), (data) => writePrivate(path, data)); }
  finally { await lock.close(); await unlink(`${path}.lock`); }
}

function status(data, now = new Date()) {
  const providers = {};
  for (const name of Object.keys(PROVIDERS)) {
    const value = data.providers[name] || {};
    const dueAt = value.enabled && Number.isFinite(Date.parse(value.lastFetchedAt)) ? nextAssetRefreshAt(value.lastFetchedAt) : null;
    providers[name] = {
      connected: name === "okx" || walletProvider(name) ? Boolean(value.credentials) : predictionProvider(name) ? Boolean(value.address) : Boolean(value.tokens),
      enabled: value.enabled === true,
      targetAccountId: value.targetAccountId || (value.enabled ? PROVIDERS[name].id : null),
      lastAttemptAt: value.lastAttemptAt || null,
      lastFetchedAt: value.lastFetchedAt || null,
      lastAppliedAt: value.lastAppliedAt || null,
      dueAt,
      overdue: Boolean(dueAt && now.getTime() > Date.parse(dueAt) + INTERVAL),
      observedAt: value.observedAt || null,
      timeBasis: value.timeBasis || "retrieved",
      lastCoverage: metadataLines(value.lastCoverage),
      lastWarnings: metadataLines(value.lastWarnings),
      lastValuation: valuationSummary(value.lastValuation),
      lastError: value.lastError || null,
      accountLabel: value.accountLabel || null,
      ...(value.preview ? { preview: value.preview } : {}),
      ...(walletProvider(name) ? { wallets: value.wallets ? walletList(value.wallets) : [], lastUnpricedAssets: unpricedSummary(value.lastUnpricedAssets), lastValuationComplete: typeof value.lastValuationComplete === "boolean" ? value.lastValuationComplete : null } : {}),
      ...(name === "futu" ? { accounts: value.accounts || [], selectedAccountId: value.externalAccountId || null } : {})
    };
  }
  return { providers, serverIp: "173.199.122.23", intervalMinutes: 720, schedule: "北京时间每天 09:00、21:00" };
}

export async function readAssetSyncStatus({ stateDir, now = new Date() }) { return status(await readPrivate(pathFor(stateDir)), now); }

function targetAccount(current, provider, requested, value = {}) {
  const mapping = PROVIDERS[provider];
  if (requested !== undefined && (typeof requested !== "string" || !requested.trim() || requested.length > 100)) throw syncError("请选择有效的目标资产账户。");
  const id = requested?.trim() || value.targetAccountId || mapping.id;
  const account = current.portfolio.accounts.find((row) => row.id === id);
  const walletTarget = (row) => row.id === PROVIDERS.okxweb3.id || /web3|wallet|钱包/i.test(`${row.id} ${row.name}`);
  const samePlatform = current.portfolio.accounts.filter((row) => row.platform === mapping.platform && (provider !== "okxweb3" || walletTarget(row)));
  if (account && account.platform !== mapping.platform) throw syncError("目标账户的平台不匹配，请重新选择。", 409);
  if (walletProvider(provider) && !requested && !value.targetAccountId) throw syncError("请明确选择钱包目标账户，避免重复计入。", 409);
  if (provider === "okxweb3" && (id === PROVIDERS.okx.id || account && !walletTarget(account) && value.targetAccountId !== id)) throw syncError("请选择明确的 OKX Web3 钱包账户，交易所账户不可作为目标。", 409);
  if (provider === "okx" && /web3|wallet|钱包/i.test(`${id} ${account?.name || ""}`)) throw syncError("请选择 OKX 交易所目标账户，Web3 钱包不可作为目标。", 409);
  if (!requested && !value.targetAccountId && !current.portfolio.entries.some((entry) => entry.accountId === id)
    && samePlatform.some((row) => row.id !== id && current.portfolio.entries.some((entry) => entry.accountId === row.id))) throw syncError("此平台已有资产账户，请明确选择已有账户进行绑定，避免重复计入。", 409);
  if (!account) {
    if (id !== mapping.id) throw syncError("目标账户不存在，请先在资产页添加账户。", 409);
    if (((predictionProvider(provider) || walletProvider(provider)) && (!requested || samePlatform.length))
      || samePlatform.some((row) => current.portfolio.entries.some((entry) => entry.accountId === row.id))) throw syncError("此平台已有资产账户，请明确选择已有账户进行绑定，避免重复计入。", 409);
  }
  if (value.lastAppliedAt && id !== (value.targetAccountId || mapping.id)) throw syncError("此来源已绑定其他资产账户，请先核对原账户记录后再迁移绑定。", 409);
  return id;
}

function sameExternal(provider, first, second) {
  return predictionProvider(provider) ? String(first).toLowerCase() === String(second).toLowerCase() : first === second;
}

function fingerprint(portfolio, accountId) {
  const account = portfolio.accounts.find((item) => item.id === accountId);
  const normalized = account ? { ...account } : undefined;
  if (normalized?.note === "") delete normalized.note;
  return digest(JSON.stringify({ account: normalized, entries: portfolio.entries.filter((item) => item.accountId === accountId) }));
}

function makePreview(result, provider, revision, now, targetAccountId) {
  if (result.provider !== provider || !CURRENCIES.includes(result.currency) || !Number.isFinite(result.total) || result.total < 0 || result.total > 1e12
    || typeof result.externalAccountId !== "string" || !result.externalAccountId || result.externalAccountId.length > 200
    || !Array.isArray(result.holdings) || result.holdings.length > 1000
    || !/^\d{4}-\d{2}-\d{2}$/.test(result.asOf) || !Number.isFinite(Date.parse(result.fetchedAt))
    || (result.observedAt !== undefined && result.observedAt !== null && (typeof result.observedAt !== "string" || !Number.isFinite(Date.parse(result.observedAt)) || Date.parse(result.observedAt) > now.getTime() + 300_000))
    || (result.timeBasis !== undefined && !["retrieved", "source", "statement"].includes(result.timeBasis))) throw syncError("平台返回的资产数据不完整，未更新原有资产。", 502);
  const holdings = result.holdings.map((row, index) => {
    if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 180 || !CATEGORIES.includes(row.category) || !CURRENCIES.includes(row.currency)
      || !Number.isFinite(row.amount) || row.amount < 0 || row.amount > 1e12) throw syncError("持仓明细无法核验，未更新原有资产。", 502);
    if ((row.sourceCurrency !== undefined || row.sourceAmount !== undefined) && (!CURRENCIES.includes(row.sourceCurrency) || typeof row.sourceAmount !== "number" || !Number.isFinite(row.sourceAmount) || row.sourceAmount < 0 || row.sourceAmount > 1e12)) throw syncError("持仓原币估值无法核验。", 502);
    if (row.rawQuantity !== undefined && !exactQuantity(row.rawQuantity)) throw syncError("钱包持仓原始数量无法核验。", 502);
    return { externalId: String(row.externalId || index).slice(0, 100), name: row.name, category: row.category, currency: row.currency, amount: row.amount,
      ...(typeof row.symbol === "string" ? { symbol: row.symbol.slice(0, 100) } : {}),
      ...(row.sourceCurrency !== undefined ? { sourceCurrency: row.sourceCurrency, sourceAmount: row.sourceAmount } : {}),
      ...(row.rawQuantity !== undefined ? { rawQuantity: row.rawQuantity } : {}),
      ...(row.quantity !== undefined ? { quantity: String(row.quantity).slice(0, 80) } : {}) };
  });
  const sum = holdings.reduce((value, row) => value + (row.currency === result.currency ? row.amount : 0), 0);
  let unpricedAssets;
  if (walletProvider(provider)) {
    unpricedAssets = unpricedSummary(result.unpricedAssets);
    if (typeof result.valuationComplete !== "boolean" || !Array.isArray(result.unpricedAssets) || result.valuationComplete && unpricedAssets.length
      || result.currency !== "USD" || !holdings.every((row) => row.currency === "USD") || Math.abs(sum - result.total) >= 0.005) throw syncError("钱包已定价小计与持仓明细无法核对。", 502);
  }
  // Only a reconciled, complete nonnegative breakdown can replace the net total.
  const countedBasis = walletProvider(provider) ? holdings.length || !result.valuationComplete ? "holdings" : "total"
    : result.breakdownComplete === true && holdings.length && holdings.every((row) => row.currency === result.currency) && Math.abs(sum - result.total) < 0.005 ? "holdings" : "total";
  const warnings = (result.warnings || []).filter((value) => typeof value === "string").map((value) => value.slice(0, 500)).slice(0, 20);
  if (countedBasis === "total") warnings.push("净资产总额作为统计口径；明细仅供对账，不与总额相加。未对齐部分不推定为现金或负债。");
  return { id: randomUUID(), provider, currency: result.currency, total: result.total, asOf: result.asOf, fetchedAt: result.fetchedAt,
    observedAt: result.observedAt || null, timeBasis: result.observedAt ? result.timeBasis || "source" : "retrieved",
    ...(result.valuation !== undefined ? { valuation: valuationSummary(result.valuation) } : {}),
    ...(walletProvider(provider) ? { unpricedAssets, valuationComplete: result.valuationComplete } : {}),
    accountLabel: String(result.accountLabel || PROVIDERS[provider].name).slice(0, 150), externalAccountId: result.externalAccountId,
    holdings, coverage: (result.coverage || []).filter((value) => typeof value === "string").map((value) => value.slice(0, 500)).slice(0, 20), warnings,
    targetAccountId, revision, countedBasis, expiresAt: new Date(now.getTime() + 20 * 60_000).toISOString() };
}

async function fetched(data, provider, stateDir, api, now, accountId, persist, requestedTarget, allowAccountChange = false) {
  const value = data.providers[provider];
  if (!value) throw syncError("请先授权此平台。");
  value.lastAttemptAt = now.toISOString();
  let result;
  if (provider === "okx") {
    if (!value.credentials) throw syncError("请先配置 OKX 只读密钥。");
    result = await api.fetchOkxAssets({ credentials: value.credentials, now: () => now });
  } else if (walletProvider(provider)) {
    if (!value.credentials) throw syncError("请先填写并验证 OnchainOS Developer 开发者凭据。");
    result = await walletAssets(provider, value.credentials, walletList(value.wallets), api, now);
  } else if (predictionProvider(provider)) {
    if (!value.address) throw syncError("请先配置公开资金地址。");
    result = await predictionAssets(provider, value.address, api, now);
  } else {
    if (!value.tokens) throw syncError("请先完成富途只读授权。");
    if (!accountId || !value.accounts?.some((account) => account.id === accountId)) throw syncError("请选择已授权的真实证券账户。");
    if (Date.parse(value.tokens.expiresAt) <= now.getTime() + 60_000) {
      value.tokens = await api.refreshFutuToken({ clientId: data.futuClient.clientId, refreshToken: value.tokens.refreshToken, now: () => now });
      await persist(data);
    }
    result = await api.fetchFutuAssets({ accessToken: value.tokens.accessToken, accountId, now: () => now });
    if (result.externalAccountId !== accountId) throw syncError("富途返回的账户与所选账户不符。", 502);
  }
  const expectedExternalId = walletProvider(provider) ? walletIdentity(walletList(value.wallets)) : value.externalAccountId || value.preview?.externalAccountId || (predictionProvider(provider) ? value.address : null);
  if (expectedExternalId && !sameExternal(provider, result.externalAccountId, expectedExternalId) && !allowAccountChange) {
    value.enabled = false;
    throw syncError("平台账户标识已变化，请重新核对账户和授权。", 409);
  }
  const current = await readPersonalAssets({ stateDir });
  let targetAccountId;
  try { targetAccountId = targetAccount(current, provider, requestedTarget, value); }
  catch (error) { if (value.enabled && requestedTarget === undefined) value.enabled = false; throw error; }
  separateExchangeTarget(data, provider, targetAccountId);
  if (predictionProvider(provider)) uniquePredictionSource(data, current, provider, value.address.toLowerCase(), targetAccountId);
  if (walletProvider(provider)) uniqueWalletSource(data, current, provider, walletList(value.wallets), targetAccountId);
  value.preview = makePreview(result, provider, current.revision, now, targetAccountId);
  value.targetAccountId = targetAccountId;
  value.lastFetchedAt = value.preview.fetchedAt;
  value.lastError = null;
  value.accountLabel = value.preview.accountLabel;
  if (!value.lastAppliedAt) { value.observedAt = value.preview.observedAt; value.timeBasis = value.preview.timeBasis; }
  return value.preview;
}

function updatedPortfolio(current, preview) {
  const mapping = PROVIDERS[preview.provider];
  const old = current.portfolio.accounts.find((item) => item.id === preview.targetAccountId);
  if (old && old.platform !== mapping.platform) throw syncError("目标账户的平台不匹配，请先核对账户。", 409);
  const account = { ...(old || { id: preview.targetAccountId, platform: mapping.platform, name: mapping.name }), basis: preview.countedBasis, reviewStatus: "confirmed" };
  if (walletProvider(preview.provider)) {
    const note = (old?.note || "").split("\n").filter((line) => !line.startsWith("【钱包同步范围】")).join("\n").trim();
    const scope = `【钱包同步范围】${preview.valuationComplete ? "指定地址已核实的已定价资产" : "仅已定价部分"}，${preview.unpricedAssets.length}项未估值，NFT/未核验协议不含。`;
    account.note = [note.slice(0, Math.max(0, 999 - scope.length)), scope].filter(Boolean).join("\n");
  }
  const common = { accountId: preview.targetAccountId, asOf: preview.asOf, asOfBasis: preview.observedAt ? "statement" : "imported", source: "api" };
  const sourceTime = preview.observedAt ? `；来源估值时间 ${preview.observedAt}` : "；源未提供精确资产时点";
  const valuation = preview.valuation;
  const quoteNote = valuation?.usdPrice !== undefined ? `；${valuation.sourceCurrency || "原币"}/USD 报价 ${valuation.usdPrice}${valuation.quoteObservedAt ? `；报价时点 ${valuation.quoteObservedAt}` : ""}` : "";
  const sourceTotal = valuation?.sourceAmount !== undefined ? `；原币估值 ${valuation.sourceAmount} ${valuation.sourceCurrency || ""}` : "";
  const entries = [{ ...common, id: `sync-${preview.provider}-total`, kind: "total", name: walletProvider(preview.provider) ? "只读 API · 已定价资产小计" : "只读 API · 净资产总额", category: "组合资产", currency: preview.currency, amount: preview.total,
    note: `${walletProvider(preview.provider) ? "指定钱包已定价口径；未估值资产及未核实协议未加入，明细与小计不相加。" : "平台净资产口径；明细与总额不相加。"}读取时间 ${preview.fetchedAt}${sourceTime}${sourceTotal}${quoteNote}` }];
  if (walletProvider(preview.provider) && !preview.valuationComplete && !preview.holdings.length) entries.length = 0;
  preview.holdings.forEach((row, index) => entries.push({ ...common, id: `sync-${preview.provider}-${digest(row.externalId + ":" + index).slice(0, 24)}`, kind: "holding",
    name: `${row.name}${preview.holdings.some((item, other) => other !== index && item.name === row.name && item.currency === row.currency) ? ` · ${index + 1}` : ""}`,
    category: row.category, currency: row.currency, amount: row.amount,
    note: [`读取时间 ${preview.fetchedAt}${sourceTime}`, row.symbol ? `代码 ${row.symbol}` : "", row.rawQuantity !== undefined || row.quantity !== undefined ? `数量 ${row.rawQuantity ?? row.quantity}${row.symbol ? ` ${row.symbol}` : ""}；金额为市值` : "",
      row.sourceAmount !== undefined ? `原币估值 ${row.sourceAmount} ${row.sourceCurrency}` : ""].filter(Boolean).join("；") + quoteNote }));
  return validatePortfolio({ ...current.portfolio, accounts: [...current.portfolio.accounts.filter((item) => item.id !== preview.targetAccountId), account],
    entries: [...current.portfolio.entries.filter((item) => item.accountId !== preview.targetAccountId), ...entries] });
}

async function applyPreview({ stateDir, data, provider, previewId, revision, now, automatic = false }) {
  const value = data.providers[provider];
  const preview = value?.preview;
  if (!preview || preview.id !== previewId || Date.parse(preview.expiresAt) < now.getTime()) throw syncError("预览已失效，请重新拉取后核对。", 409);
  const current = await readPersonalAssets({ stateDir });
  if (targetAccount(current, provider, preview.targetAccountId, value) !== preview.targetAccountId) throw syncError("目标账户绑定已变化，请重新核对预览。", 409);
  separateExchangeTarget(data, provider, preview.targetAccountId);
  if (predictionProvider(provider)) uniquePredictionSource(data, current, provider, value.address.toLowerCase(), preview.targetAccountId);
  if (walletProvider(provider)) {
    const wallets = walletList(value.wallets);
    if (preview.externalAccountId !== walletIdentity(wallets)) throw syncError("钱包绑定已变化，请重新拉取预览。", 409);
    uniqueWalletSource(data, current, provider, wallets, preview.targetAccountId);
  }
  if (automatic && fingerprint(current.portfolio, preview.targetAccountId) !== value.appliedFingerprint) {
    value.enabled = false;
    throw syncError("此账户已被手动修改，自动同步已暂停。请重新拉取并确认预览。", 409);
  }
  if (current.revision !== revision || preview.revision !== revision) throw syncError("资产版本已更新，请重新拉取预览。", 409);
  const portfolio = updatedPortfolio(current, preview);
  if (!automatic && current.portfolio.entries.length) {
    const valued = await valuePersonalAssetState(current, { stateDir });
    await createPersonalAssetsSnapshot({ stateDir, revision, valuation: { rates: valued.portfolio.rates, fx: valued.fx } });
  }
  // One rolling private backup per provider avoids exhausting immutable history on every poll.
  await writePrivate(join(resolve(stateDir), `personal-assets-sync-${provider}-previous.json`), { schemaVersion: 1, providers: {}, assetState: current });
  const assets = await savePersonalAssets({ stateDir, portfolio, revision });
  value.enabled = true;
  value.targetAccountId = preview.targetAccountId;
  value.externalAccountId = preview.externalAccountId;
  value.lastAppliedAt = now.toISOString();
  value.observedAt = preview.observedAt;
  value.timeBasis = preview.timeBasis;
  value.lastCoverage = preview.coverage;
  value.lastWarnings = preview.warnings;
  value.lastValuation = preview.valuation || null;
  if (walletProvider(provider)) {
    value.lastUnpricedAssets = preview.unpricedAssets;
    value.lastValuationComplete = preview.valuationComplete;
    value.appliedWallets = walletList(value.wallets);
    rememberWalletBinding(data, provider, value);
  }
  value.appliedFingerprint = fingerprint(assets.portfolio, preview.targetAccountId);
  rememberPredictionBinding(data, provider, value);
  delete value.preview;
  return assets;
}

export async function performAssetSyncAction({ stateDir, provider, action, body = {}, sessionBinding = "", api = adapters, now = new Date() }) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw syncError("不支持此同步平台。", 404);
  return locked(stateDir, async (data, persist) => {
    let assets;
    if (action === "disconnect") {
      rememberPredictionBinding(data, provider, data.providers[provider]);
      rememberWalletBinding(data, provider, data.providers[provider]);
      if (walletProvider(provider) && data.providers[provider]?.lastAppliedAt) {
        delete data.providers[provider].credentials;
        delete data.providers[provider].preview;
        data.providers[provider].enabled = false;
      } else delete data.providers[provider];
      if (provider === "futu") delete data.oauth;
    } else if (walletProvider(provider) && ["bind", "connect"].includes(action)) {
      if (action === "bind" && Object.keys(body).some((key) => !["wallets", "targetAccountId"].includes(key))) throw syncError("此操作只保存公开钱包绑定，不接受凭据或密钥。");
      const previous = data.providers[provider] || {};
      const wallets = walletList(body.wallets ?? previous.wallets);
      const before = await readPersonalAssets({ stateDir });
      const targetAccountId = targetAccount(before, provider, body.targetAccountId, previous);
      uniqueWalletSource(data, before, provider, wallets, targetAccountId);
      rememberWalletBinding(data, provider, previous);
      if (action === "bind") {
        const value = { ...previous, wallets, targetAccountId, enabled: false, lastError: null };
        delete value.preview;
        data.providers[provider] = value;
      } else {
        const credentials = {};
        for (const key of ["apiKey", "secret", "passphrase"]) {
          if (typeof body[key] !== "string" || !body[key].trim() || body[key].length > 300 || /[\r\n]/.test(body[key])) throw syncError("请填写有效的 OnchainOS Developer API Key、Secret 和 Passphrase。");
          credentials[key] = body[key].trim();
        }
        const result = await walletAssets(provider, credentials, wallets, api, now);
        const current = await readPersonalAssets({ stateDir });
        targetAccount(current, provider, targetAccountId, previous);
        uniqueWalletSource(data, current, provider, wallets, targetAccountId);
        const preview = makePreview(result, provider, current.revision, now, targetAccountId);
        data.providers[provider] = { ...previous, credentials, wallets, targetAccountId, enabled: false, preview, lastAttemptAt: now.toISOString(),
          lastFetchedAt: preview.fetchedAt, accountLabel: preview.accountLabel, lastError: null,
          ...(!previous.lastAppliedAt ? { observedAt: preview.observedAt, timeBasis: preview.timeBasis } : {}) };
      }
    } else if (provider === "okx" && action === "connect") {
      const credentials = {};
      for (const key of ["apiKey", "secret", "passphrase"]) {
        if (typeof body[key] !== "string" || !body[key].trim() || body[key].length > 300 || /[\r\n]/.test(body[key])) throw syncError("请填写有效的 OKX API Key、Secret 和 Passphrase。");
        credentials[key] = body[key].trim();
      }
      if (!["global", "us", "eea"].includes(body.region)) throw syncError("请选择 OKX 账户所属地区。");
      credentials.region = body.region;
      const previous = data.providers.okx || {};
      const before = await readPersonalAssets({ stateDir });
      const targetAccountId = targetAccount(before, provider, body.targetAccountId, previous);
      separateExchangeTarget(data, provider, targetAccountId);
      const result = await api.fetchOkxAssets({ credentials, now: () => now });
      const expectedExternalId = previous.externalAccountId || previous.preview?.externalAccountId;
      if (expectedExternalId && !sameExternal(provider, expectedExternalId, result.externalAccountId)) throw syncError("OKX 真实账户与已绑定账户不同，请先核对并断开旧授权。", 409);
      const current = await readPersonalAssets({ stateDir });
      targetAccount(current, provider, targetAccountId, previous);
      const preview = makePreview(result, provider, current.revision, now, targetAccountId);
      data.providers.okx = { ...previous, credentials, targetAccountId, enabled: false, preview, lastAttemptAt: now.toISOString(),
        lastFetchedAt: preview.fetchedAt, accountLabel: preview.accountLabel, lastError: null,
        ...(!previous.lastAppliedAt ? { observedAt: preview.observedAt, timeBasis: preview.timeBasis } : {}) };
    } else if (predictionProvider(provider) && action === "connect") {
      if (typeof body.address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(body.address.trim())) throw syncError("请输入有效的 Polygon 公开交易账户地址，不能使用 Solana 充值地址。");
      const address = body.address.trim().toLowerCase();
      const previous = data.providers[provider] || {};
      if (previous.address && !sameExternal(provider, previous.address, address)) throw syncError("此来源已绑定其他地址，请先核对并断开旧同步。", 409);
      const before = await readPersonalAssets({ stateDir });
      const targetAccountId = targetAccount(before, provider, body.targetAccountId, previous);
      uniquePredictionSource(data, before, provider, address, targetAccountId);
      const result = await predictionAssets(provider, address, api, now);
      if (!sameExternal(provider, result.externalAccountId, address)) throw syncError("返回的资金地址与所选地址不符。", 502);
      const current = await readPersonalAssets({ stateDir });
      targetAccount(current, provider, targetAccountId, previous);
      uniquePredictionSource(data, current, provider, address, targetAccountId);
      const preview = makePreview(result, provider, current.revision, now, targetAccountId);
      data.providers[provider] = { ...previous, address, targetAccountId, enabled: false, preview, lastAttemptAt: now.toISOString(),
        lastFetchedAt: preview.fetchedAt, accountLabel: preview.accountLabel, lastError: null,
        ...(!previous.lastAppliedAt ? { observedAt: preview.observedAt, timeBasis: preview.timeBasis } : {}) };
    } else if (provider === "futu" && action === "authorize") {
      if (!sessionBinding) throw syncError("请先登录资产页面。", 401);
      data.futuClient ||= await api.registerFutuClient({ redirectUri: callbackUri });
      const state = randomBytes(32).toString("base64url");
      const codeVerifier = randomBytes(48).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      data.oauth = { stateHash: digest(state), bindingHash: digest(sessionBinding), codeVerifier, expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString() };
      const authorizationUrl = api.createFutuAuthorization({ clientId: data.futuClient.clientId, redirectUri: callbackUri, state, codeChallenge });
      const target = new URL(authorizationUrl);
      if (target.origin !== "https://webapi.futunn.com" || target.pathname !== "/oauth2/authorize/confirm") throw syncError("富途授权地址校验失败。", 502);
      await persist(data);
      return { authorizationUrl };
    } else if (action === "preview") {
      const accountId = body.accountId || data.providers.futu?.externalAccountId;
      const previousAccountId = data.providers.futu?.externalAccountId || data.providers.futu?.preview?.externalAccountId;
      const changedAccount = provider === "futu" && previousAccountId && accountId !== previousAccountId;
      try { await fetched(data, provider, stateDir, api, now, accountId, persist, body.targetAccountId, Boolean(changedAccount)); }
      catch (error) {
        if (data.providers[provider]) { data.providers[provider].lastError = failureText; await persist(data); }
        throw error;
      }
      if (changedAccount) data.providers.futu.enabled = false;
    } else if (action === "apply") {
      assets = await applyPreview({ stateDir, data, provider, previewId: body.previewId, revision: body.revision, now });
    } else throw syncError("不支持这个同步操作。", 404);
    await persist(data);
    return assets ? { sync: status(data, now), assets } : status(data, now);
  });
}

export async function completeFutuAuthorization({ stateDir, query, sessionBinding = "", api = adapters, now = new Date() }) {
  return locked(stateDir, async (data, persist) => {
    const pending = data.oauth;
    if (!pending || !sessionBinding || typeof query.state !== "string" || digest(query.state) !== pending.stateHash || digest(sessionBinding) !== pending.bindingHash || Date.parse(pending.expiresAt) < now.getTime()) throw syncError("富途授权已过期或会话不匹配，请重新授权。", 403);
    delete data.oauth;
    await persist(data);
    if (query.error || typeof query.code !== "string" || !query.code || query.code.length > 2000) throw syncError("富途授权未完成，请重新发起并仅选择读取权限。");
    const tokens = await api.exchangeFutuCode({ clientId: data.futuClient.clientId, redirectUri: callbackUri, code: query.code, codeVerifier: pending.codeVerifier, now: () => now });
    const accounts = await api.fetchFutuAccounts({ accessToken: tokens.accessToken });
    data.providers.futu = { ...data.providers.futu, tokens, accounts, enabled: false, lastError: null };
    await persist(data);
    return status(data, now);
  });
}

export async function runAssetSyncCycle({ stateDir, api = adapters, now = new Date() }) {
  // Reading an unconfigured collector never creates credential or financial files.
  if (!Object.values((await readPrivate(pathFor(stateDir))).providers).some((value) => value.enabled)) return { attempted: 0, applied: 0, failed: 0 };
  return locked(stateDir, async (data, persist) => {
    const result = { attempted: 0, applied: 0, failed: 0 };
    for (const provider of Object.keys(PROVIDERS)) {
      const value = data.providers[provider];
      if (!value?.enabled || value.lastFetchedAt && now.getTime() < Date.parse(nextAssetRefreshAt(value.lastFetchedAt))) continue;
      result.attempted += 1;
      value.lastAttemptAt = now.toISOString();
      try {
        const current = await readPersonalAssets({ stateDir });
        const targetAccountId = value.targetAccountId || PROVIDERS[provider].id;
        if (fingerprint(current.portfolio, targetAccountId) !== value.appliedFingerprint) {
          value.enabled = false;
          throw syncError("此账户已被手动修改，自动同步已暂停。请重新拉取并确认预览。", 409);
        }
        targetAccount(current, provider, undefined, value);
        const preview = await fetched(data, provider, stateDir, api, now, value.externalAccountId, persist);
        if (!sameExternal(provider, preview.externalAccountId, value.externalAccountId)) { value.enabled = false; throw syncError("平台账户标识已变化，请重新核对授权。", 409); }
        await applyPreview({ stateDir, data, provider, previewId: preview.id, revision: preview.revision, now, automatic: true });
        result.applied += 1;
      } catch (error) {
        value.lastError = error.statusCode === 409 ? error.message : failureText;
        result.failed += 1;
      }
      await persist(data);
    }
    return result;
  });
}
