import { PLATFORMS, CURRENCIES, CATEGORIES, emptyPortfolio, entryIdentity, validatePortfolio, summarize, parseCsv, csvTemplate, extractOcrCandidates, detectCurrency } from "./core.mjs";

const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const currentDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dateTime = (value) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "尚未更新";
const errorText = (error) => error instanceof Error ? error.message : "操作未完成，请重试。";
const options = (values, value) => values.map((item) => `<option value="${escape(item)}"${item === value ? " selected" : ""}>${escape(item)}</option>`).join("");
const accountOptions = (value) => portfolio().accounts.map((account) => `<option value="${escape(account.id)}"${account.id === value ? " selected" : ""}>${escape(account.name)}${account.name === account.platform ? "" : ` · ${escape(account.platform)}`}</option>`).join("");
const basisName = (basis) => basis === "total" ? "账户总额" : "持仓合计";
const kindName = (kind) => kind === "total" ? "账户总额" : "持仓明细";
const sourceName = (source) => ({ manual: "手动录入", csv: "CSV 导入", screenshot: "截图核对", api: "只读 API" })[source] || "已录入";
const marks = ["HS", "ZA", "富", "盈", "OKX", "币", "A", "?", "民", "TP", "PM", "F", "BAW", "OAW"];
const displayCurrencyKey = "personal-assets-display-currency";
let displayCurrency = "CNY";
try { const stored = window.localStorage.getItem(displayCurrencyKey); if (["CNY", "USD", "HKD"].includes(stored)) displayCurrency = stored; } catch {}
let state = null;
let page = "overview";
let categoryFilter = "all";
let platformFilter = "all";
let hidden = false;
let saving = false;
let loading = false;
let conflict = false;
let loadFailed = false;
let modal = null;
let draft = null;
let editingId = null;
let currencyManual = false;
let currencyDetection = null;
let currencyFromCandidate = false;
let currencyPlatform = "";
let currencyDraft = {};
let currencyOriginal = {};
let deleteId = null;
let ratesRefreshing = false;
let accountDraft = { platform: PLATFORMS[0], name: "", reviewStatus: "confirmed", note: "" };
let editingAccountId = null;
let importTab = "screenshot";
let csvEntries = [];
let importBasis = {};
let csvFilename = "";
let replaceConfirmed = false;
let screenshotConfirmed = false;
let ocrImage = "";
let ocrText = "";
let candidates = [];
let ocrWorker = null;
let ocrBusy = false;
let ocrStatus = "";
let ocrRun = 0;
let ocrLibrary = null;
let toastTimer;
let syncState = null;
let syncLoading = false;
let syncError = "";
let syncAccountId = "";
const syncTargets = {};
const syncAgenticProviders = ["binanceagentic", "okxagentic"];
const syncWalletProviders = ["okxweb3", "tokenpocket", ...syncAgenticProviders];
const syncReuseCredentials = {};
const syncWalletDrafts = {};
const syncWalletNetworks = [{ chainIndex: "1", name: "Ethereum" }, { chainIndex: "501", name: "Solana" }, { chainIndex: "137", name: "Polygon" }, { chainIndex: "56", name: "BSC" }, { chainIndex: "196", name: "X Layer" }];
const syncProviders = ["okx", "futu", "polymarket", "future", ...syncWalletProviders];
const syncNames = { okx: "OKX 交易所", futu: "富途", polymarket: "Polymarket", future: "Future", okxweb3: "OKX Web3 钱包", tokenpocket: "TokenPocket", binanceagentic: "币安Agentic Wallet", okxagentic: "OKX Agentic Wallet" };
const syncPlatforms = { okx: "OKX", futu: "富途", polymarket: "Polymarket", future: "Future", okxweb3: "OKX", tokenpocket: "TokenPocket", binanceagentic: "币安Agentic Wallet", okxagentic: "OKX Agentic Wallet" };
let syncCallbackHandled = false;
let fundEditingId = null;
let stockPnlDraft = null;
let aiState = null;
let aiLoading = false;
let aiOpened = false;

function portfolio() { return state?.portfolio ?? emptyPortfolio(); }
function number(value, decimals = 2) { return hidden ? "••••••" : value === null || value === undefined ? "—" : value.toLocaleString("zh-CN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
function displayValue(value) {
  if (!Number.isFinite(value)) return null;
  if (displayCurrency === "CNY") return value;
  const rate = portfolio().rates[displayCurrency]?.value;
  const converted = Number.isFinite(rate) && rate > 0 && rate <= 1e9 ? value / rate : null;
  return Number.isFinite(converted) ? converted : null;
}
function displayAmount(value) { return number(displayValue(value)); }
function displayCurrencyControl() {
  return `<div class="currency-toggle" role="group" aria-label="显示币种">${["CNY", "USD", "HKD"].map((currency) => `<button type="button" data-action="display-currency" data-currency="${currency}" aria-pressed="${displayCurrency === currency}">${currency}${displayCurrency === currency ? " 基准" : ""}</button>`).join("")}</div>`;
}
async function changeDisplayCurrency(currency) {
  if (!["CNY", "USD", "HKD"].includes(currency) || !state || loading || saving && !ratesRefreshing || currency === displayCurrency) return;
  displayCurrency = currency;
  try { window.localStorage.setItem(displayCurrencyKey, currency); } catch {}
  render();
  await refreshRates();
}
function percentage(value, total) { return hidden ? "•••" : total > 0 ? `${(value / total * 100).toFixed(1)}%` : "—"; }
function pendingAccount(account) { return account.platform === "待确认" || account.reviewStatus === "pending"; }
function selectedEntries(account) { return portfolio().entries.filter((entry) => entry.accountId === account.id && entry.kind === (account.basis === "total" ? "total" : "holding")); }
function currencyTotals(entries) {
  const totals = new Map();
  for (const entry of entries) totals.set(entry.currency, (totals.get(entry.currency) || 0) + entry.amount);
  return [...totals].map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name));
}
function originalCurrencyTotals() { return currencyTotals(portfolio().accounts.filter((account) => !pendingAccount(account)).flatMap(selectedEntries)); }
function visibleNote(note) { return !hidden && note ? `<p class="muted small" style="margin:6px 0;white-space:normal;overflow-wrap:anywhere">${escape(note)}</p>` : ""; }
function entryDateBasis(entry) { const fund = state?.funds?.bindings?.find(row => row.entryId === entry.id); return fund ? fund.priceBasis === "market-quote" ? `行情日期 · 股数${fund.quantityBasis === "screenshot" ? "来自截图" : "手动确认"}` : fund.priceBasis === "market-close" ? "市场收盘价日期 · 股数手动确认" : "净值日期 · 份额手动确认" : entry.asOfBasis === "imported" ? entry.source === "api" ? "读取日期 · 源未提供资产时点" : "导入日期 · 截图日期未核实" : "资产日期"; }
function accountSyncDetails(account) { return Object.entries(state?.sync?.providers || {}).find(([, details]) => details.targetAccountId === account.id); }
function accountHasRecords(account) {
  const details = accountSyncDetails(account)?.[1];
  return portfolio().entries.some((entry) => entry.accountId === account.id) || Boolean(details?.lastAppliedAt && (details.lastValuationComplete === false || details.lastUnpricedAssets?.length));
}
function partialValuationSources() { return Object.values(state?.sync?.providers || {}).filter((details) => details.lastAppliedAt && details.lastValuationComplete === false && portfolio().accounts.some((account) => account.id === details.targetAccountId)); }
function partialValuationNotice() {
  const sources = partialValuationSources();
  if (!sources.length) return "";
  const count = sources.reduce((total, details) => total + (Array.isArray(details.lastUnpricedAssets) ? details.lastUnpricedAssets.length : 0), 0);
  return `<div class="notice">估值不完整 · ${count ? `${count} 项未估值` : "未估值明细待提供"}。总额、饼图与分布仅含已定价且已换算的记录，未估值数量不按 0 计入。NFT 与未核验 DeFi 不在本次覆盖范围，协议资产待核实。</div>`;
}
function unpricedAssetsPanel(assets, incomplete) {
  const rows = Array.isArray(assets) ? assets : [];
  if (!rows.length && !incomplete) return "";
  return `<div class="notice"><strong>估值不完整 · 已定价部分合计</strong><p class="small">未估值资产保留数量，不按 0 计入金额。NFT 与未核验 DeFi 不在本次覆盖范围，协议资产待核实。</p>${hidden ? '<p class="muted small">隐私模式已隐藏未估值资产及数量。</p>' : rows.length ? `<div class="table-scroll"><table><thead><tr><th>未估值资产 / 网络</th><th>数量</th><th>未估值原因</th></tr></thead><tbody>${rows.map((asset) => `<tr><td>${escape(asset.name || asset.symbol || "未识别资产")}<span class="source-label" style="display:block">${escape(asset.symbol || "")} · ${escape(syncWalletNetworks.find((network) => network.chainIndex === asset.chainIndex)?.name || asset.chainIndex || "网络待核实")}${asset.contract ? ` · ${escape(asset.contract)}` : ""}</span></td><td class="num">${escape(asset.quantity ?? "数量未提供")}</td><td>${escape(asset.reason || "未取得可核实的价格")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted small">源未提供完整的未估值明细，请核对账户。</p>'}</div>`;
}
function syncStatusLabel(details) {
  return !details.connected ? details.lastAppliedAt ? "已断开 · 保留上次入账" : "尚未授权" : details.lastError ? "同步失败 · 请核对已保存数据" : !details.enabled ? "已授权 · 待核对入账" : details.overdue ? "更新延迟" : details.lastAppliedAt ? "自动同步已开启" : "等待首次入账";
}
function syncTimes(details) {
  return `<div class="sync-meta"><div>源资产时点<strong>${details.observedAt ? escape(dateTime(details.observedAt)) : "源未提供资产时点"}</strong></div><div>最近成功读取<strong>${escape(dateTime(details.lastFetchedAt))}</strong></div><div>最近成功入账<strong>${escape(dateTime(details.lastAppliedAt))}</strong></div><div>最近尝试 / 下次检查<strong>${escape(dateTime(details.lastAttemptAt))} / ${escape(dateTime(details.dueAt))}</strong></div></div>`;
}
function syncSourceNotes(details) {
  const coverage = Array.isArray(details.lastCoverage) ? details.lastCoverage : [];
  const warnings = Array.isArray(details.lastWarnings) ? details.lastWarnings : [];
  const valuation = details.lastValuation;
  const unpriced = unpricedAssetsPanel(details.lastUnpricedAssets, details.lastValuationComplete === false);
  if (!coverage.length && !warnings.length && !valuation && !unpriced) return "";
  if (hidden) return `<p class="muted small">隐私模式已隐藏覆盖详情与核对说明。</p>${unpriced}`;
  return `${coverage.length ? `<p class="muted small">最近入账覆盖：${coverage.map(escape).join("；")}</p>` : ""}${valuation ? `<p class="muted small">源估值 ${escape(valuation.sourceCurrency)} ${number(valuation.sourceAmount, 6)} · USD 报价 ${number(valuation.usdPrice, 6)} · 报价时点 ${escape(dateTime(valuation.quoteObservedAt))}</p>` : ""}${warnings.map((warning) => `<p class="muted small">${escape(warning)}</p>`).join("")}${unpriced}`;
}
function accountSyncPanel(account) {
  const binding = accountSyncDetails(account);
  if (state?.sync?.status === "unavailable") return '<p class="notice error">同步状态暂不可用，当前连接与自动刷新状态未核实。以下沿用已保存资产。</p>';
  if (!binding && state?.funds?.bindings?.some(row => row.accountId === account.id)) return fundValuationPanel(account.id);
  if (!binding) return `<p class="muted small">尚未接入自动同步 · ${portfolio().entries.some((entry) => entry.accountId === account.id && entry.source === "api") ? "保存的 API 估值，当前同步未绑定" : "按已录入的截图、CSV 或手动记录展示"}</p>`;
  const [provider, details] = binding;
  return `<div class="notice"><strong>${escape(syncNames[provider] || provider)} · ${syncStatusLabel(details)}</strong>${syncTimes(details)}${syncSourceNotes(details)}${details.lastError ? `<p>${hidden ? "显示金额后可查看同步错误详情。" : escape(details.lastError)}</p>` : ""}</div>`;
}
function fundValuationPanel(accountId) {
  if (state?.funds?.status === "unavailable") return '<div class="notice error">持仓重估状态暂不可用，沿用已保存估值。</div>';
  const bindings = (state?.funds?.bindings || []).filter(row => !accountId || row.accountId === accountId);
  if (!bindings.length) return "";
  return `<section class="panel" aria-label="持仓自动估值" style="margin-bottom:20px"><h3>基金、ETF 与股票自动估值</h3><p class="muted small">每天北京时间 09:00、21:00 检查最新公布报价。基金使用官方净值，VOO 使用发行人市场收盘价，A 股和美股使用腾讯未复权行情；报价日可能早于今天。数量日期不是到期日，也不代表银行或券商的最新持仓与现金已自动同步。</p>${bindings.map(row => {
    const stock = row.priceBasis === "market-quote"; const shares = stock || row.priceBasis === "market-close";
    const screenshot = stock && row.quantityBasis === "screenshot";
    return `<div class="notice"><div class="section-head"><strong>${escape(row.name)}</strong><span class="pill">${!row.enabled ? "已暂停" : row.lastError ? "更新失败 · 保留上次估值" : row.delayed ? "更新延迟" : "报价自动更新"}</span></div>${hidden ? '<p class="muted small">隐私模式已隐藏数量、报价和时间详情。</p>' : `<p class="small">${shares ? "股数" : "份额"} ${escape(row.quantity)} · ${screenshot ? "截图数量录入日" : "确认日"} ${escape(row.confirmedOn)}${screenshot ? "（截图持股时点未核实）" : "（不是到期日）"}<br>${stock ? "未复权行情价" : shares ? "市场收盘价" : "最新入账净值"} ${escape(row.price || row.nav || "待获取")} ${escape(row.currency)} · ${shares ? "价格日" : "净值日"} ${escape(row.priceDate || row.navDate || "待获取")}${row.priceBasis === "market-close" ? "（非盘中实时）" : ""}${stock ? `<br>源返回行情时间 ${row.sourceTime ? `${escape(row.sourceTime)}（源时区未核实）` : escape(dateTime(row.observedAt))} · 买卖或送转后需更新股数；现金与截图盈亏未自动更新。` : ""}<br>最近成功读取 ${escape(dateTime(row.lastFetchedAt))} · 最近估值入账 ${escape(dateTime(row.lastAppliedAt))}<br>最近尝试 ${escape(dateTime(row.lastAttemptAt))}</p><p class="muted small">来源：<a href="${escape(row.url)}" target="_blank" rel="noopener noreferrer">${escape(row.source)}</a> · ${escape(row.symbol || row.isin)}</p>${row.lastError ? `<p class="small">${escape(row.lastError)}</p>` : ""}<button class="button small" data-action="fund-edit" data-id="${escape(row.entryId)}">更新 / 重新确认数量</button>`}</div>`;
  }).join("")}</section>`;
}
function openFund(entryId) {
  const binding = state?.funds?.bindings?.find(row => row.entryId === entryId);
  if (!binding || hidden) return;
  fundEditingId = entryId; modal = "fund";
  const stock = binding.priceBasis === "market-quote"; const shares = stock || binding.priceBasis === "market-close";
  setDialog("确认持有数量", `${binding.name} · ${binding.symbol || binding.isin}`, `<form id="fund-form"><p class="muted small">保存后按${stock ? "腾讯最新未复权行情" : shares ? "发行人公布的市场收盘价" : "官方最新净值"}更新这条已有持仓，不新增重复资产。数量日期仅记录本次确认时间；买卖、申赎或送转后请更新。</p><div class="field"><label for="fund-quantity">${shares ? "持有股数" : "持有份额"}</label><input id="fund-quantity" type="number" min="0" step="${stock && binding.currency === "CNY" ? "1" : "any"}" required value="${escape(binding.quantity)}"></div><div class="field"><label for="fund-confirmed">数量确认日期（不是到期日）</label><input id="fund-confirmed" type="date" max="${currentDate()}" required value="${currentDate()}"></div></form>`, '<button class="button" data-action="close-dialog">取消</button><button class="button primary" type="submit" form="fund-form">保存数量并启用自动估值</button>');
}
async function configureFund() {
  const binding = state?.funds?.bindings?.find(row => row.entryId === fundEditingId);
  if (!binding || saving) return;
  saving = true; syncBusy();
  try {
    const response = await fetch("/api/assets/funds/configure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entryId: binding.entryId, isin: binding.isin, symbol: binding.symbol, quantityBasis: "manual", quantity: $("fund-quantity").value, confirmedOn: $("fund-confirmed").value, revision: state.revision }) });
    state = await readResponse(response); saving = false; closeDialog(); render(); notify("数量已确认，自动估值已开启");
  } catch (error) { showError(errorText(error)); }
  finally { saving = false; syncBusy(); }
}
function syncCoveragePanel() {
  if (state?.sync?.status === "unavailable") return '<section class="notice error" aria-label="自动同步覆盖">同步状态暂不可用，自动同步覆盖当前未核实。已保存资产仍正常展示，请核对同步配置。</section>';
  const accounts = portfolio().accounts.filter(accountHasRecords);
  const automatic = accounts.filter((account) => { const details = accountSyncDetails(account)?.[1]; return details?.connected && details.enabled && details.lastAppliedAt; });
  const delayed = automatic.filter((account) => { const details = accountSyncDetails(account)[1]; return details.overdue || details.lastError; });
  return `<section class="panel" aria-label="自动同步覆盖" style="margin-bottom:20px"><div class="section-head"><div><h3>自动同步覆盖</h3><span class="muted small">${automatic.length} / ${accounts.length} 个已录入账户完成首次同步${delayed.length ? ` · ${delayed.length} 个更新延迟或失败` : ""}</span></div><button class="button small" data-action="sync">管理只读同步</button></div><p class="muted small" style="margin:0">已完成首次同步的账户每天北京时间 09:00、21:00 检查；其他金额沿用已保存记录。汇率自动刷新不代表账户余额已更新。每个账户的数据来源与时间见“账户与持仓”。</p></section>`;
}
function fxStatusText() {
  const fx = state?.fx;
  if (!fx || fx.status === "unavailable") return "自动汇率暂不可用，未取得汇率的币种暂不折算。";
  return `${fx.status === "stale" ? "汇率更新延迟 · 部分币种使用上次数据或日参考汇率" : "按最新可用汇率折算"}${fx.source ? ` · 来源 ${fx.source}` : ""} · 获取 ${dateTime(fx.fetchedAt)}`;
}
function fxNotes() {
  return Array.isArray(state?.fx?.errors) ? state.fx.errors.map((message) => `<p class="notice small">${escape(message)}</p>`).join("") : "";
}
function rateTime(metadata) {
  if (metadata.timeBasis === "daily") return `${escape(metadata.date)}（日参考）`;
  if (metadata.timeBasis === "retrieved") return `获取 ${escape(dateTime(metadata.fetchedAt))}（源未提供报价时间）`;
  if (metadata.timeBasis === "market-and-retrieved") return `获取 ${escape(dateTime(metadata.fetchedAt))}<span class="source-label" style="display:block">最近成交 ${escape(dateTime(metadata.asOf))}${metadata.fiatTimeBasis === "daily" ? ` · 外汇 ${escape(metadata.date)}（日参考）` : " · 外汇源未提供报价时间"}</span>`;
  return escape(dateTime(metadata.asOf));
}
function rateTable() {
  return `<div class="table-scroll"><table><thead><tr><th>币种</th><th>1 单位 = CNY</th><th>时间 / 来源</th><th>状态</th></tr></thead><tbody>${[...new Set(["CNY", ...portfolio().entries.map((entry) => entry.currency), ...Object.keys(portfolio().rates)])].map((currency) => {
    const rate = portfolio().rates[currency];
    const metadata = state?.fx?.rates?.[currency];
    return `<tr><td>${escape(currency)}</td><td class="num">${rate ? number(rate.value, 6) : "等待自动获取"}</td><td>${currency === "CNY" ? "—" : metadata ? `${rateTime(metadata)}<span class="source-label" style="display:block">${escape(metadata.source || state.fx.source || "自动汇率")}</span>` : "尚未取得自动报价"}</td><td>${currency === "CNY" ? "基准币种" : !rate ? "暂不计入" : !metadata ? "历史参考 · 待自动更新" : metadata.stale ? "更新延迟" : metadata.timeBasis === "daily" || metadata.fiatTimeBasis === "daily" ? "日参考汇率" : "自动汇率"}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}
function originalCurrencyPanel() {
  const totals = originalCurrencyTotals();
  return `<section class="panel" style="margin-bottom:20px"><div class="section-head"><div><h3>自动汇率 · ${displayCurrency} 折算</h3><span class="muted small">${escape(fxStatusText())}</span></div><div class="actions"><button class="button small quiet" data-action="rates">汇率详情</button><button class="button small" data-action="refresh-rates"${ratesRefreshing ? " disabled" : ""}>${ratesRefreshing ? "正在刷新…" : "刷新汇率"}</button></div></div>${fxNotes()}${totals.length ? `<div class="actions"><span class="muted small">原币参考</span>${totals.map((group) => `<span class="pill"><span class="num">${escape(group.name)} ${number(group.value)}</span></span>`).join("")}</div><p class="muted small" style="margin:10px 0 0">原币金额保留用于核对；总额与分布按最新可用汇率折算，待确认账户不计入。</p>` : '<p class="muted small">尚无已确认、符合所选统计口径的资产记录。</p>'}</section>`;
}
function pendingAccountsPanel() {
  const accounts = portfolio().accounts.filter((account) => pendingAccount(account) && portfolio().entries.some((entry) => entry.accountId === account.id));
  if (!accounts.length) return "";
  return `<section class="notice" aria-label="待确认账户"><div class="section-head"><div><h2>待确认账户 · 未计入资产合计</h2><span class="muted small">确认实际平台、账户归属与统计状态后，再纳入总额和分布。</span></div><span class="pill">${accounts.length} 个账户</span></div><div class="account-list">${accounts.map((account) => `<div class="panel"><div class="row"><div><h3>${escape(account.name)}</h3><span class="muted small">${escape(account.platform)} · 按${basisName(account.basis)}列示</span></div><button class="button small" data-action="edit-account" data-id="${escape(account.id)}">核对账户</button></div><p class="num" style="margin:10px 0">${currencyTotals(selectedEntries(account)).map((group) => `${escape(group.name)} ${number(group.value)}`).join(" · ") || "当前统计口径尚无记录"}</p>${visibleNote(account.note)}</div>`).join("")}</div></section>`;
}
function categoryDescription(category) {
  return ({ "定期存款": "定期存款单列，与现金和货币基金分开。", "货币基金": "货币基金与现金分开，按基金产品列示。", "股票ETF": "股票ETF与个股分开，不直接归为单只股票。", "稳定币": "稳定币与银行存款分开，不归为现金。", "组合资产": "组合资产待拆分，不能据此判断底层股票或债券敞口。" })[category] || "";
}
function assetTypeGuide() {
  return '<p class="footnote">货币基金与现金分开；稳定币与银行存款分开；股票ETF与个股分开。组合资产待拆分，不能据此判断底层股票或债券敞口。稳定币仅统计已识别部分，未展开的加密资产中也可能含稳定币。分类金额各自四舍五入，显示合计可能有尾差。</p>';
}
function assetTypesPanel(summary, compact = false) {
  return `<section class="panel" aria-label="资产类型" style="margin:0"><div class="section-head"><div><h2>资产类型</h2><span class="muted small">仅统计已确认、已换算且符合账户口径的记录 · 点击图例查看明细</span></div><button class="button small quiet" data-action="clear-category">查看全部资产 →</button></div>${assetTypeChart(summary, compact)}${compact ? `<details class="pnl-sources"><summary>资产分类说明</summary>${assetTypeGuide()}</details>` : assetTypeGuide()}</section>`;
}
function assetTypeChart(summary, compact = false) {
  const color = (name) => `var(--cat-${Math.max(0, CATEGORIES.indexOf(name))})`;
  const legend = `<div class="type-legend">${summary.byCategory.map((group) => `<button type="button" class="type-legend-item" data-action="category" data-category="${escape(group.name)}"><span class="type-key" style="background:${color(group.name)}" aria-hidden="true"></span><span class="type-name">${escape(group.name)}${!compact && categoryDescription(group.name) ? `<small>${escape(categoryDescription(group.name))}</small>` : ""}</span><span class="type-figures num">${displayCurrency} ${displayAmount(group.value)}<small>${percentage(group.value, summary.total)} · 查看明细 →</small></span></button>`).join("")}</div>`;
  if (hidden) return `<div class="type-pie-layout"><div class="empty small">分布及占比已隐藏</div>${legend}</div>`;
  if (!(summary.total > 0)) return `<div class="empty small">暂无可绘制的资产类型金额，录入并核算资产后显示饼图。</div>${legend}`;
  let offset = 0;
  const segments = summary.byCategory.filter((group) => group.value > 0).map((group) => {
    const share = Math.min(100, Math.max(0, group.value / summary.total * 100));
    const segment = `<circle class="type-pie-segment" data-pie-category="${escape(group.name)}" cx="110" cy="110" r="80" fill="none" style="stroke:${color(group.name)}" stroke-width="27" pathLength="100" stroke-dasharray="${share.toFixed(6)} ${(100 - share).toFixed(6)}" stroke-dashoffset="${(-offset).toFixed(6)}" transform="rotate(-90 110 110)"><title>${escape(group.name)} · ${percentage(group.value, summary.total)} · ${displayCurrency} ${displayAmount(group.value)}</title></circle>`;
    offset += share;
    return segment;
  }).join("");
  return `<div class="type-pie-layout"><svg class="type-pie" viewBox="0 0 220 220" role="img" aria-labelledby="asset-type-pie-title asset-type-pie-description"><title id="asset-type-pie-title">资产类型占比</title><desc id="asset-type-pie-description">按已核算资产折合 ${displayCurrency} 的金额绘制。对应颜色、金额和占比见图例，图例可打开持仓明细。</desc>${segments}<text x="110" y="102" text-anchor="middle" class="type-pie-label">已核算资产 · ${displayCurrency}</text><text x="110" y="127" text-anchor="middle" class="type-pie-total">${displayAmount(summary.total)}</text></svg>${legend}</div>`;
}
function platformCard(platform, index, summary) {
  const accounts = portfolio().accounts.filter((account) => account.platform === platform);
  const entries = portfolio().entries.filter((entry) => accounts.some((account) => account.id === entry.accountId));
  const unpricedOnly = !entries.length && accounts.some(accountHasRecords);
  const confirmed = currencyTotals(accounts.filter((account) => !pendingAccount(account)).flatMap(selectedEntries));
  const pending = currencyTotals(accounts.filter(pendingAccount).flatMap(selectedEntries));
  const value = summary.byPlatform.find((group) => group.name === platform)?.value;
  const missing = summary.missing.some((entry) => accounts.some((account) => account.id === entry.accountId));
  return `<section class="panel platform-card"><div class="platform-top"><span class="platform-mark">${marks[index] || "?"}</span><span class="platform-name">${escape(platform)}</span></div>${confirmed.length ? `<div class="platform-native"><span class="muted small">已确认原币</span>${confirmed.map((group) => `<div class="platform-number">${escape(group.name)} ${number(group.value)}</div>`).join("")}</div>` : `<div class="platform-number">${entries.length ? pending.length ? "待确认" : "当前口径未录入" : "—"}</div>`}${unpricedOnly ? '<p class="muted small">已记录未估值资产，金额待核实；数量见账户来源。</p>' : ""}${pending.length ? `<div class="platform-pending"><span class="muted small">待确认原币 · 不计入合计</span>${pending.map((group) => `<div class="num">${escape(group.name)} ${number(group.value)}</div>`).join("")}</div>` : ""}${confirmed.length ? `<div class="muted small">${value === undefined ? `折合 ${displayCurrency} 待核算` : displayValue(value) === null ? `折合 ${displayCurrency} 待换算` : `折合 ${displayCurrency} ${displayAmount(value)} · ${percentage(value, summary.total)}`}${missing ? " · 含缺汇率记录" : ""}</div>` : ""}<div class="platform-bottom"><span>${unpricedOnly ? "未估值数量见账户来源" : entries.length ? "按账户所选口径识别币种" : "尚未录入"}</span><button data-action="${accounts.length ? "manual" : "account"}" data-account="${escape(accounts[0]?.id || "")}" data-platform="${escape(platform)}">${entries.length ? "新增" : accounts.length ? "录入" : "添加账户"} →</button></div>${entries.length ? `<button class="button small quiet" data-action="correct-currency" data-platform="${escape(platform)}">纠正币种</button>` : ""}</section>`;
}
// Bubble area tracks value, but small platforms are lifted to `minimum` (out
// of a 100 radius for the largest) so every bubble stays big enough to name.
function layoutPlatformBubbles(groups, aspect = 2, minimum = 34) {
  const width = 1000; const height = width / aspect;
  if (!groups.length) return { width, height, nodes: [] };
  const maximum = Math.max(...groups.map(group => group.value));
  const placed = []; const gap = 14;
  const bounds = (nodes) => ({ left: Math.min(...nodes.map(node => node.x - node.r)), right: Math.max(...nodes.map(node => node.x + node.r)), top: Math.min(...nodes.map(node => node.y - node.r)), bottom: Math.max(...nodes.map(node => node.y + node.r)) });
  for (const group of groups) {
    const r = Math.max(minimum, Math.sqrt(group.value / maximum) * 100);
    if (!placed.length) { placed.push({ ...group, x: 0, y: 0, r }); continue; }
    let best = null; let bestScore = Infinity;
    for (const neighbor of placed) for (let angle = 0; angle < 24; angle++) {
      const radians = angle * Math.PI / 12;
      const candidate = { ...group, r, x: neighbor.x + Math.cos(radians) * (neighbor.r + r + gap), y: neighbor.y + Math.sin(radians) * (neighbor.r + r + gap) };
      if (placed.some(node => Math.hypot(candidate.x - node.x, candidate.y - node.y) < r + node.r + gap - 1e-7)) continue;
      const box = bounds([...placed, candidate]);
      const score = Math.max((box.right - box.left) / aspect, box.bottom - box.top) + (box.right - box.left) * (box.bottom - box.top) * 1e-5;
      if (score < bestScore) { best = candidate; bestScore = score; }
    }
    placed.push(best);
  }
  const box = bounds(placed); const padding = 18;
  // The 0.86 leaves open space for the bubbles to drift and collide in.
  const scale = 0.86 * Math.min((width - padding * 2) / (box.right - box.left), (height - padding * 2) / (box.bottom - box.top));
  const left = (width - (box.right - box.left) * scale) / 2; const top = (height - (box.bottom - box.top) * scale) / 2;
  return { width, height, nodes: placed.map(node => ({ ...node, x: (node.x - box.left) * scale + left, y: (node.y - box.top) * scale + top, r: node.r * scale })) };
}
function platformCoverage(platform, summary) {
  const accounts = portfolio().accounts.filter(account => account.platform === platform);
  const ids = new Set(accounts.map(account => account.id));
  const priced = summary.included.filter(entry => ids.has(entry.accountId)).length;
  const missing = summary.missing.some(entry => ids.has(entry.accountId));
  const partial = Object.values(state?.sync?.providers || {}).some(row => ids.has(row.targetAccountId) && row.lastAppliedAt && row.lastValuationComplete === false);
  const pending = accounts.some(account => pendingAccount(account) && accountHasRecords(account));
  return priced ? `${priced} 条已核算${partial ? " · 含未估值" : ""}${missing ? " · 含缺汇率" : ""}${pending ? " · 含待确认" : ""}` : partial ? "已记录未估值资产" : missing ? "缺汇率 · 待核算" : pending ? "待确认 · 未计入" : accounts.some(accountHasRecords) ? "当前口径无正值估值" : "尚未录入";
}
// The asset type holding the most accounted value on each platform; it picks
// the bubble's rim color, matching the asset-type pie.
function platformLeadCategories(summary) {
  const platformOf = new Map(portfolio().accounts.map(account => [account.id, account.platform]));
  const totals = new Map();
  for (const entry of summary.included) {
    const rate = entry.currency === "CNY" ? 1 : portfolio().rates[entry.currency]?.value;
    const platform = platformOf.get(entry.accountId);
    if (!platform || !(rate > 0)) continue;
    const byCategory = totals.get(platform) ?? new Map();
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + entry.amount * rate);
    totals.set(platform, byCategory);
  }
  return new Map([...totals].map(([platform, byCategory]) => [platform, [...byCategory].sort((a, b) => b[1] - a[1])[0][0]]));
}
function platformAtlas(summary) {
  const convertible = displayValue(1) !== null;
  const groups = convertible ? summary.byPlatform.filter(group => Number.isFinite(group.value) && group.value > 0) : [];
  const priced = new Set(groups.map(group => group.name));
  const leadCategories = platformLeadCategories(summary);
  const atlasButton = (platform, body, className = "") => `<button type="button" class="${className}" data-action="atlas-platform" data-platform="${escape(platform)}">${body}</button>`;
  const legend = `<div class="atlas-legend">${groups.map(group => atlasButton(group.name, `<span><strong>${escape(group.name)}</strong><small>${escape(platformCoverage(group.name, summary))}</small></span><span class="num">${displayCurrency} ${displayAmount(group.value)}<small>${percentage(group.value, summary.total)} · 查看账户 →</small></span>`, "atlas-legend-row")).join("")}</div>`;
  const chart = (aspect, mobile) => {
    const layout = layoutPlatformBubbles(groups, aspect, mobile ? 46 : 34);
    return `<div class="atlas-plot ${mobile ? "atlas-mobile" : "atlas-wide"}" style="aspect-ratio:${aspect}" data-aspect="${aspect}" role="group" aria-label="平台资产气泡">${layout.nodes.map((node, index) => {
      const label = `${node.name} · 折合 ${displayCurrency} ${displayAmount(node.value)} · ${percentage(node.value, summary.total)} · ${platformCoverage(node.name, summary)} · 查看账户`;
      const lead = leadCategories.get(node.name);
      // Shrink long names so they stay on one line: CJK counts as a full em, Latin about half.
      const nameEm = [...node.name].reduce((sum, character) => sum + (/[\u3000-\u9fff]/.test(character) ? 1 : 0.58), 0);
      return `<div class="atlas-position" style="left:${(node.x / layout.width * 100).toFixed(8)}%;top:${(node.y / layout.height * 100).toFixed(8)}%;width:${(node.r * 2 / layout.width * 100).toFixed(8)}%"><button type="button" class="atlas-bubble" data-action="atlas-platform" data-platform="${escape(node.name)}" data-bubble-platform="${escape(node.name)}" aria-label="${escape(label)}" title="${escape(label)}" tabindex="-1" style="--bubble-color:var(--cat-${Math.max(0, CATEGORIES.indexOf(lead))});--name-size:${Math.min(19, 68 / Math.max(1, nameEm)).toFixed(2)}cqi;--bubble-delay:-${index * 1.3}s;--bubble-duration:${9 + index % 5}s"><span class="bubble-label"><span class="bubble-mark" aria-hidden="true">${escape(marks[PLATFORMS.indexOf(node.name)] || "?")}</span><span class="bubble-name">${escape(node.name)}</span><span class="bubble-value num">${percentage(node.value, summary.total)}</span></span></button></div>`;
    }).join("")}</div>`;
  };
  const shownCategories = CATEGORIES.filter(category => [...leadCategories.values()].includes(category));
  const bubbleKey = `<div class="atlas-key" aria-label="气泡颜色说明"><span>颜色 = 平台主要资产类型</span>${shownCategories.map(category => `<span><i style="background:var(--cat-${CATEGORIES.indexOf(category)})" aria-hidden="true"></i>${escape(category)}</span>`).join("")}</div>`;
  const unvalued = PLATFORMS.filter(platform => !priced.has(platform));
  return `<section class="panel atlas-panel" aria-label="平台资产气泡图"><div class="section-head"><div><h2>我的资产版图</h2><span class="muted small">${hidden ? "气泡大小与金额已隐藏" : `气泡面积按已核算 ${displayCurrency} 金额比例绘制 · 轻触平台查看账户`}</span></div><button class="button small" data-action="manual">＋ 录入资产</button></div>${hidden ? `<div class="privacy-mask">气泡大小与金额已隐藏</div><div class="actions atlas-private">${PLATFORMS.map(platform => atlasButton(platform, escape(platform), "button small quiet")).join("")}</div>` : groups.length ? `<div class="atlas-stage">${chart(2, false)}${chart(1 / 1.1, true)}${bubbleKey}</div><p class="muted small atlas-caption">较小气泡放大到可读尺寸，面积不再与金额同比例；实际金额与覆盖范围见下方。漂浮与碰撞仅为展示，不代表市场涨跌，悬停时暂停。</p>${legend}`  : !convertible ? `<div class="empty small">${displayCurrency}/CNY 汇率暂不可用，暂不绘制金额气泡；原币金额见下方明细。</div>` : '<div class="empty small">尚无可绘制的正值估值；未核算金额不按 0 绘制气泡。</div>'}${!hidden && unvalued.length ? `<div class="atlas-unvalued"><h3>未核算与尚未录入</h3><div class="actions">${unvalued.map(platform => atlasButton(platform, `<strong>${escape(platform)}</strong><small>${escape(platformCoverage(platform, summary))}</small>`, "atlas-unvalued-item")).join("")}</div></div>` : ""}<details class="atlas-details"><summary>原币明细与币种纠错 <span class="muted small">添加账户、手动录入及逐条纠正币种</span></summary><div class="platform-grid">${PLATFORMS.map((platform, index) => platformCard(platform, index, summary)).join("")}</div><button class="button small" data-action="account" style="margin-top:14px">＋ 添加资产账户</button></details></section>`;
}
// Drifting bubbles with elastic collisions, run in the same 1000-wide units
// as layoutPlatformBubbles. Only the visible plot moves; hovering or focusing
// it pauses motion so a bubble can be clicked, and reduced motion keeps the
// packed layout still.
let bubbleFrame = 0;
function startBubbleMotion() {
  if (typeof requestAnimationFrame !== "function") return;
  cancelAnimationFrame(bubbleFrame);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const plot = [...document.querySelectorAll(".atlas-plot")].find(element => element.offsetWidth > 0);
  if (!plot) return;
  const width = 1000; const height = width / Number(plot.dataset.aspect);
  const bubbles = [...plot.querySelectorAll(".atlas-position")].map((element, index) => {
    const r = parseFloat(element.style.width) * width / 200;
    const angle = index * 2.399963;
    const speed = 14 + 22 * (1 - Math.min(1, r / 160));
    return { element, r, mass: r * r, x: parseFloat(element.style.left) * width / 100, y: parseFloat(element.style.top) * height / 100, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
  });
  let paused = false;
  const pause = () => { paused = true; };
  const resume = () => { paused = false; };
  plot.addEventListener("pointerenter", pause);
  plot.addEventListener("pointerleave", resume);
  plot.addEventListener("focusin", pause);
  plot.addEventListener("focusout", resume);
  plot.classList.add("atlas-live");
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!plot.isConnected) return;
    if (!paused) {
      for (const bubble of bubbles) {
        bubble.x += bubble.vx * dt;
        bubble.y += bubble.vy * dt;
        if (bubble.x - bubble.r < 0) { bubble.x = bubble.r; bubble.vx = Math.abs(bubble.vx); }
        if (bubble.x + bubble.r > width) { bubble.x = width - bubble.r; bubble.vx = -Math.abs(bubble.vx); }
        if (bubble.y - bubble.r < 0) { bubble.y = bubble.r; bubble.vy = Math.abs(bubble.vy); }
        if (bubble.y + bubble.r > height) { bubble.y = height - bubble.r; bubble.vy = -Math.abs(bubble.vy); }
      }
      for (let i = 0; i < bubbles.length; i++) for (let j = i + 1; j < bubbles.length; j++) {
        const a = bubbles[i]; const b = bubbles[j];
        const dx = b.x - a.x; const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const overlap = a.r + b.r + 4 - distance;
        if (overlap <= 0) continue;
        const nx = dx / distance; const ny = dy / distance;
        const total = a.mass + b.mass;
        a.x -= nx * overlap * b.mass / total; a.y -= ny * overlap * b.mass / total;
        b.x += nx * overlap * a.mass / total; b.y += ny * overlap * a.mass / total;
        const approach = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (approach <= 0) continue;
        const impulse = 2 * approach / total;
        a.vx -= impulse * b.mass * nx; a.vy -= impulse * b.mass * ny;
        b.vx += impulse * a.mass * nx; b.vy += impulse * a.mass * ny;
      }
      for (const bubble of bubbles) {
        // Keep every bubble near its cruising speed so the field never stalls or races.
        const speed = Math.hypot(bubble.vx, bubble.vy) || 1;
        const target = 14 + 22 * (1 - Math.min(1, bubble.r / 160));
        const correction = 1 + (target / speed - 1) * Math.min(1, dt * 0.8);
        bubble.vx *= correction; bubble.vy *= correction;
        bubble.element.style.left = `${(bubble.x / width * 100).toFixed(4)}%`;
        bubble.element.style.top = `${(bubble.y / height * 100).toFixed(4)}%`;
      }
    }
    bubbleFrame = requestAnimationFrame(step);
  };
  bubbleFrame = requestAnimationFrame(step);
}
function notify(message) {
  clearTimeout(toastTimer);
  $("asset-message").className = "notice success";
  $("asset-message").textContent = message;
  $("asset-message").hidden = false;
  toastTimer = setTimeout(() => { $("asset-message").hidden = true; }, 5000);
}
function showError(message) {
  const id = modal ? "dialog-error" : "asset-error";
  const target = $(id);
  if (!target) return;
  target.className = "notice error";
  target.innerHTML = `${escape(message)}${conflict ? '<div class="actions"><button class="button small" data-action="backup-json">导出备份（含当前草稿）</button><button class="button small" data-action="reload">重新载入最新数据</button></div>' : ""}`;
  target.hidden = !message;
}
function aiQuotaUsed() { return aiState?.quota?.remaining === 0 && aiState.quota.date === currentDate(); }
function aiPanel() {
  const review = aiState?.review; const used = aiQuotaUsed();
  const label = aiLoading ? "正在读取…" : review && review.revision !== state?.revision ? "数据已变化 · 上次点评" : ({ fresh: "今日点评", cached: "已保存点评", outdated: "数据已变化 · 上次点评", unavailable: "点评不可用 · 保留上次结果", unconfigured: "待配置 Moonshot" })[aiState?.status] || "等待点评";
  const provider = ({ moonshot: "Moonshot", openai: "OpenAI（历史点评）" })[review?.provider] || "历史点评 · 来源未记录";
  return `<section class="panel" aria-label="AI 资产点评" style="margin-bottom:20px"><div class="section-head"><div><h2>AI 资产点评</h2><span class="pill">${label}</span></div><div class="actions"><button class="button small quiet" data-action="ai-settings">${aiState?.configured ? "更新 Moonshot 配置" : "配置 Moonshot"}</button><button class="button small" data-action="ai-review"${aiLoading || !aiState?.configured || used ? " disabled" : ""}>${used ? "今日调用已用完" : "生成今日点评"}</button></div></div><p class="muted small">Moonshot · 每天最多调用 1 次，北京时间 00:00 重置。打开页面复用已保存点评；调用失败当天也不重试。${used && aiState?.quota?.nextAllowedAt ? `下次可调用 ${escape(dateTime(aiState.quota.nextAllowedAt))}。` : ""}数据或汇率变化后，旧点评会明确标注。</p>${aiState?.error ? `<p class="notice error">${escape(aiState.error)}</p>` : ""}${hidden ? '<p class="muted">隐私模式已隐藏点评内容。</p>' : review ? `<p class="muted small">${provider} · ${escape(review.model)} · 生成 ${escape(dateTime(review.generatedAt))} · 资产版本 ${escape(review.revision)}</p><div style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(review.text)}</div>` : `<p class="muted">${aiLoading ? "正在读取已保存点评，或按今日额度生成…" : aiState?.status === "unconfigured" ? "请在安全入口配置 Moonshot API Key。" : "暂未取得有效 AI 点评，资产记录仍可正常查看。"}</p>`}<p class="muted small">点评结合资产配置与外部市场环境；外部环境来自模型自身知识并会注明时点，不是实时行情。仅向 Moonshot 发送平台/类型/报表币种汇总与占比、估值、系统汇率和历史总额；不发送账户名称、持仓名称、备注、钱包地址或其他平台凭据。资产变化不能直接视为投资收益。</p></section>`;
}
async function aiRequest(action, body = {}) {
  const response = await fetch(`/api/assets/ai/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data; try { data = await response.json(); } catch { throw new Error("AI 服务未返回有效数据。"); }
  if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请重新登录。" : data.error || "AI 暂时无法完成点评，请稍后重试。");
  if (!data || typeof data.configured !== "boolean" || !["fresh", "cached", "outdated", "unavailable", "unconfigured"].includes(data.status)) throw new Error("AI 点评格式无法核验，未替换上次结果。");
  return data;
}
async function loadAi() {
  if (aiLoading || !state || aiQuotaUsed()) return;
  aiLoading = true; render();
  try { aiState = await aiRequest("review"); }
  catch (error) { aiState = { ...aiState, status: "unavailable", error: errorText(error) }; }
  finally { aiLoading = false; render(); }
}
function openAiSettings() {
  modal = "ai";
  setDialog("Moonshot 安全配置", "填写 Moonshot 国内平台的 API Key；每天最多调用一次，修改 Key 不会增加当天额度。", '<form id="ai-config-form" autocomplete="off"><div class="field"><label for="ai-api-key">Moonshot API Key</label><input id="ai-api-key" type="password" autocomplete="new-password" spellcheck="false" required maxlength="500"></div><p class="muted small">Key 仅保存在受保护的服务器，不写入导出、快照或浏览器存储。使用 Kimi K3.1 Pro。若今日尚未调用，保存后会尝试生成；调用失败也会消耗今日唯一额度，替换 Key 后需等到次日再调用。</p><button class="button primary" type="submit">保存 Moonshot 配置</button></form>', cancelButton);
}
async function configureAi() {
  const apiKey = $("ai-api-key").value.trim(); $("ai-api-key").value = "";
  if (!apiKey) { showError("请填写 Moonshot API Key。"); return; }
  saving = true; syncBusy();
  try { aiState = await aiRequest("configure", { apiKey }); modal = null; $("asset-dialog").close(); render(); notify(aiState.status === "fresh" ? "Moonshot 资产点评已生成，今日调用已用完" : aiState.configurationSaved ? aiState.status === "unavailable" ? "Moonshot 配置已保存；本次点评未完成，请查看提示" : "Moonshot 配置已保存；今日沿用已保存点评" : "Moonshot 状态已更新"); }
  catch (error) { showError(errorText(error)); }
  finally { saving = false; syncBusy(); }
}

function syncBusy() {
  document.querySelectorAll("[data-needs-data]").forEach((element) => { element.disabled = !state || saving || loading; });
  document.querySelectorAll("#asset-content button, #asset-content select").forEach((element) => { element.disabled = saving || loading || element.dataset.action === "snapshot" && !portfolio().entries.length; });
  document.querySelectorAll('[data-action="ai-review"]').forEach((element) => { element.disabled = saving || loading || aiLoading || !aiState?.configured || aiQuotaUsed(); });
  document.querySelectorAll('[data-action="display-currency"]').forEach((element) => { element.disabled = loading || saving && !ratesRefreshing; });
  const fieldset = $("dialog-fields");
  if (fieldset) fieldset.disabled = saving;
  document.querySelectorAll("#asset-dialog .dialog-footer button, #asset-dialog .dialog-header button").forEach((element) => { element.disabled = saving; });
  if ($("confirm-csv")) $("confirm-csv").disabled = saving || !csvEntries.length;
  if ($("manual-from-import")) $("manual-from-import").disabled = saving || ocrBusy;
}
async function readResponse(response) {
  let data;
  try { data = await response.json(); } catch { throw new Error("服务器未返回有效数据，请稍后重试。"); }
  if (!response.ok) {
    if (response.status === 409) {
      conflict = true;
      throw new Error("另一处页面已修改资产。当前草稿仍保留。可先导出备份，再点击“重新载入最新数据”，核对后重新保存。");
    }
    if (response.status === 401) throw new Error("登录已过期，请重新登录后再载入资产。");
    throw new Error(data.error || "资产操作未完成，请稍后重试。");
  }
  if (!data || !Number.isSafeInteger(data.revision) || !Array.isArray(data.snapshots)) throw new Error("资产数据格式不正确，未替换当前记录。");
  return { ...data, portfolio: validatePortfolio(data.portfolio) };
}
async function load() {
  if (saving || loading) return;
  loading = true;
  syncBusy();
  try {
    const response = await fetch("/api/assets", { cache: "no-store" });
    state = await readResponse(response);
    conflict = false;
    loadFailed = false;
    $("asset-error").hidden = true;
    if (modal) showError("最新数据已载入，当前草稿已保留。请核对后再保存。");
    render();
    if (!aiOpened) { aiOpened = true; void loadAi(); }
    if (!modal && !syncCallbackHandled && /[?&]sync=futu-(?:authorized|error)(?:&|$)/.test(location.search || "")) {
      syncCallbackHandled = true;
      await openSync();
      if (!syncError && syncState?.providers.futu.connected && syncState.providers.futu.accounts?.length && /[?&]sync=futu-authorized(?:&|$)/.test(location.search || "")) notify("富途只读授权已完成，请选择真实账户并核对资产预览");
      else { syncError ||= syncState?.providers.futu.lastError || "富途授权未完成，请查看同步状态后重试。"; renderSync(); }
    }
  } catch (error) {
    loadFailed = true;
    if (!state) $("asset-content").innerHTML = '<section class="panel empty"><h3>资产暂时无法载入</h3><p>未能读取已保存的数据，请重试。此处不会用空资产替代读取失败。</p><button class="button" data-action="reload">重新载入</button><a class="button quiet" href="/login">重新登录</a></section>';
    showError(errorText(error));
  } finally { loading = false; syncBusy(); }
}
async function save(next, message) {
  if (!state || saving) return false;
  if (conflict) { showError("请先重新载入最新数据，再核对保留的草稿。当前草稿尚未保存。"); return false; }
  saving = true;
  syncBusy();
  try {
    const cleaned = validatePortfolio(next);
    const response = await fetch("/api/assets", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ portfolio: cleaned, revision: state.revision }) });
    state = await readResponse(response);
    loadFailed = false;
    render();
    notify(message);
    return true;
  } catch (error) { showError(errorText(error)); return false; }
  finally { saving = false; syncBusy(); }
}
function distribution(groups, total, categoryLinks = false) {
  if (hidden) return `${categoryLinks ? `<div class="actions">${groups.map((group) => `<button class="button small quiet" data-action="category" data-category="${escape(group.name)}">${escape(group.name)} →</button>`).join("")}</div>` : ""}<div class="empty small">分布及占比已隐藏</div>`;
  if (!groups.length) return '<div class="empty small">录入资产后显示分布</div>';
  return `<div class="bar-list">${groups.map((group, index) => `<div><div class="bar-label">${categoryLinks ? `<button class="button small quiet" data-action="category" data-category="${escape(group.name)}">${escape(group.name)} →</button>` : `<span>${escape(group.name)}</span>`}<span class="num">${percentage(group.value, total)} · ${displayCurrency} ${displayAmount(group.value)}</span></div><div class="bar-track"><div class="bar-fill color-${index % 5}" style="width:${total > 0 ? Math.min(100, Math.max(0, group.value / total * 100)) : 0}%"></div></div>${categoryLinks && categoryDescription(group.name) ? `<p class="muted small">${escape(categoryDescription(group.name))}</p>` : ""}</div>`).join("")}</div>`;
}
function insights(summary) {
  const top = summary.byPlatform[0];
  return `<div class="insights"><div class="insight"><strong>${top && !hidden ? `${escape(top.name)}占已核算资产 ${percentage(top.value, summary.total)}` : "平台集中度"}</strong><p>${top ? "平台占比帮助识别托管与账户集中情况，不等于底层投资风险。不同平台也可能持有相同资产。" : "录入各账户后，即可比较平台分布。空账户保持未录入，不按零资产处理。"}</p></div><div class="insight"><strong>${summary.missing.length ? `${summary.missing.length} 条记录等待汇率` : "核算范围与币种"}</strong><p>${summary.missing.length ? `${escape([...new Set(summary.missing.map((entry) => entry.currency))].join("、"))} 尚未换算，已从总额和分布中排除。` : `当前以 ${displayCurrency} 展示资产。汇率自动获取，USD、USDT、USDC 分别核算；仅统计各账户选定口径的记录。`}</p></div><div class="insight"><strong>${summary.stale.length ? `${summary.stale.length} 条记录超过 30 天未更新` : "资产估值的新鲜度"}</strong><p>${summary.stale.length ? "请核对金额和资产日期，尽量在相近日期更新不同账户。" : "页面展示最近成功入账的估值。已授权账户按同步状态更新；其他账户请定期核对，并保存时点快照。"}</p></div></div>`;
}
function stockPnlAccounts() {
  return portfolio().accounts.filter(account => !pendingAccount(account) && ((portfolio().stockPnl || []).some(row => row.accountId === account.id)
    || portfolio().entries.some(row => row.accountId === account.id && ["股票", "股票ETF"].includes(row.category))));
}
function stockPnlPanel(summary) {
  const pnl = summary.stockPnl;
  const rows = [...pnl.included, ...pnl.missing];
  const value = displayValue(pnl.total);
  return `<div class="stock-pnl"><div class="row"><span class="metric-label">股票浮动盈亏 · 已记录部分</span><button class="button small quiet" data-action="stock-pnl">更新盈亏</button></div><div class="stock-pnl-value num${!hidden && value < 0 ? " negative" : !hidden && value > 0 ? " positive" : ""}">${displayCurrency} ${!hidden && value > 0 ? "+" : ""}${number(value)}</div><p class="metric-foot">已含在当前市值中，不重复加减 · ${pnl.included.length} / ${stockPnlAccounts().length} 个股票账户已提供${pnl.missing.length ? ` · ${pnl.missing.length} 个缺汇率` : ""}</p><details class="pnl-sources"><summary>查看盈亏来源与日期</summary>${hidden ? '<p class="muted small">盈亏明细已隐藏。</p>' : rows.length ? rows.map(row => `<div class="pnl-source"><span>${escape(portfolio().accounts.find(account => account.id === row.accountId)?.name)}<small>${sourceName(row.source)} · ${escape(row.asOf)}${row.asOfBasis === "imported" ? row.source === "api" ? "（读取日期，源盈亏时点未提供）" : "（导入日期，截图时点未核实）" : "（盈亏记录日）"}${row.fetchedAt ? ` · 成功读取 ${escape(dateTime(row.fetchedAt))}` : ""}</small></span><span class="num">${escape(row.currency)} ${number(row.amount)}</span></div>`).join("") : '<p class="muted small">尚未提供股票盈亏；缺失值不按零统计。</p>'}</details></div>`;
}
function openStockPnl() {
  stockPnlDraft ??= Object.fromEntries(stockPnlAccounts().map(account => {
    const original = portfolio().stockPnl?.find(row => row.accountId === account.id);
    return [account.id, { amount: original ? String(original.amount) : "", currency: original?.currency || selectedEntries(account)[0]?.currency || "CNY", asOf: original?.asOf || currentDate(), original }];
  }));
  modal = "stock-pnl";
  setDialog("股票浮动盈亏", "按账户录入股票及股票 ETF 的未实现盈亏，亏损填负数。该数值仅展示，不改变资产市值。", hidden ? '<p class="muted">隐私模式已隐藏盈亏草稿，显示金额后可继续编辑。</p>' : `<form id="stock-pnl-form"><p class="muted small">留空表示尚未提供；不同日期的记录会标明来源，不能视为同一时点的完整收益。</p>${Object.entries(stockPnlDraft).map(([id,row]) => `<fieldset class="pnl-edit-row"><legend>${escape(portfolio().accounts.find(account => account.id === id)?.name)}</legend><div class="form-grid"><div class="field"><label for="pnl-amount-${escape(id)}">浮动盈亏（可为负数）</label><input id="pnl-amount-${escape(id)}" type="number" step="any" value="${escape(row.amount)}" data-pnl-account="${escape(id)}" data-pnl-field="amount" placeholder="尚未提供"></div><div class="field"><label for="pnl-currency-${escape(id)}">盈亏币种</label><select id="pnl-currency-${escape(id)}" data-pnl-account="${escape(id)}" data-pnl-field="currency">${options(CURRENCIES,row.currency)}</select></div><div class="field full"><label for="pnl-date-${escape(id)}">盈亏记录日期</label><input id="pnl-date-${escape(id)}" type="date" required max="${currentDate()}" value="${escape(row.asOf)}" data-pnl-account="${escape(id)}" data-pnl-field="asOf"></div></div></fieldset>`).join("")}</form>`, `${cancelButton}${hidden ? "" : '<button class="button primary" type="submit" form="stock-pnl-form">保存盈亏记录</button>'}`);
}
async function saveStockPnl() {
  if (!stockPnlDraft || hidden) return;
  const rows = Object.entries(stockPnlDraft).filter(([, row]) => row.amount.trim() !== "").map(([accountId, row]) => {
    if (row.original && String(row.original.amount) === row.amount && row.original.currency === row.currency && row.original.asOf === row.asOf) return row.original;
    return { accountId, amount: Number(row.amount), currency: row.currency, asOf: row.asOf, source: "manual", asOfBasis: "statement" };
  });
  const untouched = (portfolio().stockPnl || []).filter(row => !Object.hasOwn(stockPnlDraft, row.accountId));
  if (await save({ ...portfolio(), stockPnl: [...untouched, ...rows] }, "股票盈亏已保存，总资产继续按市值统计")) closeDialog();
}
function renderOverview(summary) {
  const active = portfolio().accounts.filter(accountHasRecords).length;
  const partial = partialValuationSources().length > 0;
  const initial = !active;
  const automatic = Object.values(state.sync?.providers || {}).filter(row => row.connected && row.enabled && row.lastAppliedAt).length;
  return `<div class="metrics"><section class="panel metric total"><div class="row"><span class="metric-label">${partial || summary.missing.length || summary.pending.length ? "已核算资产 · 部分估值" : "已录入资产总额"}</span>${displayCurrencyControl()}</div><div class="total-line"><div class="metric-value"><small>${displayCurrency === "USD" ? "$" : displayCurrency === "HKD" ? "HK$" : "¥"}</small>${displayAmount(partial && !summary.included.length ? null : summary.total)}</div>${privacyToggle()}</div><div class="metric-foot">${initial ? "尚未录入真实金额" : "当前市值 · 按最新可用汇率折算"}${partial ? " · 仅含已定价记录" : ""}</div>${stockPnlPanel(summary)}</section><section class="panel metric overview-status"><div><span class="metric-label">已录入账户 / 全部账户</span><div class="metric-value">${active}<span class="muted"> / ${portfolio().accounts.length}</span></div><span class="metric-foot">${automatic} 个账户已开启只读同步</span></div><div class="summary-update"><span class="metric-label">最近保存</span><div class="small num">${escape(state.updatedAt ? dateTime(state.updatedAt) : "尚未录入")}</div><span class="metric-foot">${summary.included.length} 条计入 · ${summary.missing.length} 条缺汇率 · ${summary.pending.length} 条待确认</span></div></section><section class="panel metric overview-status"><div><span class="metric-label">自动更新计划 · 北京时间</span><div class="refresh-times num">09:00 <span>/</span> 21:00</div><span class="metric-foot">每天两次 · 仅刷新已接入的资产来源</span></div><div class="summary-update"><span class="metric-label">${displayCurrency} 汇率</span><p class="metric-foot">${escape(fxStatusText())}</p><button class="button small quiet" data-action="sync">管理只读同步 →</button></div></section></div>
  <div class="overview-distributions">${assetTypesPanel(summary, true)}<section class="panel"><div class="section-head"><h2>平台分布</h2><span class="pill">按已核算 ${displayCurrency}</span></div>${distribution(summary.byPlatform, summary.total)}</section></div>
  ${displayCurrency !== "CNY" && displayValue(1) === null ? `<div class="notice">${displayCurrency}/CNY 自动汇率暂不可用，总额待换算。可切回 CNY 查看人民币金额。</div>` : ""}${summary.missing.length ? `<div class="notice">${displayCurrency} 合计仅覆盖已完成换算的记录，其余资产见原币参考。缺汇率记录和待确认账户均未计入总额与分布。</div>` : ""}${partialValuationNotice()}${aiPanel()}${pendingAccountsPanel()}
  ${platformAtlas(summary)}
  <details class="source-details"><summary>数据更新与来源 <span>每天 09:00 / 21:00 · 汇率、连接状态与基金估值明细</span></summary><div class="source-details-body">${originalCurrencyPanel()}${syncCoveragePanel()}${fundValuationPanel()}</div></details>${initial ? '<div class="notice">从一个真实数字开始：可先录入账户总额，也可导入截图或 CSV。</div>' : ""}`;
}
function renderHoldings(summary) {
  const included = new Set(summary.included.map((entry) => entry.id));
  const missing = new Set(summary.missing.map((entry) => entry.id));
  const pending = new Set(summary.pending.map((entry) => entry.id));
  const matchesCategory = (entry) => (categoryFilter === "all" || entry.category === categoryFilter) && (platformFilter === "all" || portfolio().accounts.find(account => account.id === entry.accountId)?.platform === platformFilter);
  const accounts = portfolio().accounts.filter((account) => (platformFilter === "all" || account.platform === platformFilter) && (categoryFilter === "all" || portfolio().entries.some((entry) => entry.accountId === account.id && matchesCategory(entry))));
  const filteredGroup = { value: summary.included.filter(matchesCategory).reduce((total, entry) => total + entry.amount * portfolio().rates[entry.currency].value, 0) };
  const filteredIncluded = summary.included.filter(matchesCategory);
  return `<div class="section-head"><div><h2>账户与持仓</h2><span class="muted small">每个账户选择一种统计口径，避免总额与明细重复计算。</span></div><div class="actions"><button class="button small" data-action="account">添加账户</button><button class="button primary small" data-action="manual">＋ 录入资产</button></div></div><section class="panel" id="holdings-filter" style="margin-bottom:18px;scroll-margin-top:100px"><div class="row"><div class="basis"><label for="holding-platform-filter">平台</label><select id="holding-platform-filter"><option value="all"${platformFilter === "all" ? " selected" : ""}>全部平台</option>${options(PLATFORMS, platformFilter)}</select><label for="holding-category-filter">资产类型</label><select id="holding-category-filter"><option value="all"${categoryFilter === "all" ? " selected" : ""}>全部资产类型</option>${options(CATEGORIES, categoryFilter)}</select></div><button class="button small quiet" data-action="clear-category">全部 / 恢复筛选</button></div>${categoryFilter !== "all" ? `<div class="notice"><strong>${escape(categoryFilter)}</strong> · 筛选后已计入 <span class="num">${displayCurrency} ${displayAmount(filteredGroup?.value ?? null)}</span> · ${filteredIncluded.length} 条已计入记录<p>金额仅描述符合账户口径且完成换算的部分；待确认、缺汇率和口径排除的匹配记录仍显示，不能把显示行相加。</p></div>` : ""}${assetTypeGuide()}</section><div class="account-list">${accounts.map((account) => {
    const entries = portfolio().entries.filter((entry) => entry.accountId === account.id && matchesCategory(entry));
    return `<section class="panel account-card"><div class="section-head"><div><h3>${escape(account.name)} <span class="pill${pendingAccount(account) ? "" : " gold"}">${pendingAccount(account) ? "待确认 · 不计入合计" : "已确认"}</span></h3><span class="muted small">${escape(account.platform)} · ${entries.length} 条${categoryFilter === "all" ? "" : "匹配"}记录</span></div><div class="basis"><label for="basis-${escape(account.id)}">统计口径</label><select id="basis-${escape(account.id)}" data-basis="${escape(account.id)}"><option value="total"${account.basis === "total" ? " selected" : ""}>账户总额</option><option value="holdings"${account.basis === "holdings" ? " selected" : ""}>持仓合计</option></select><button class="button small" data-action="edit-account" data-id="${escape(account.id)}">编辑账户</button><button class="button small" data-action="manual" data-account="${escape(account.id)}">＋ 录入</button></div></div>${visibleNote(account.note)}${accountSyncPanel(account)}${entries.length ? `<p class="muted small">${pendingAccount(account) ? "待确认原币金额（不计入合计）" : "所选口径原币金额"}${categoryFilter === "all" ? "" : " · 符合当前筛选"}：<span class="num">${currencyTotals(selectedEntries(account).filter(matchesCategory)).map((group) => `${escape(group.name)} ${number(group.value)}`).join(" · ") || "当前口径尚无记录"}</span></p><div class="table-scroll"><table><thead><tr><th>资产 / 类型</th><th>资产类型</th><th>原币金额</th><th>折合 ${displayCurrency}</th><th>日期 / 依据</th><th>统计状态</th><th>操作</th></tr></thead><tbody>${entries.map((entry) => `<tr${included.has(entry.id) || missing.has(entry.id) ? "" : ' class="excluded"'}><td><span class="name">${escape(entry.name)}</span><span class="source-label">${kindName(entry.kind)} · ${sourceName(entry.source)}</span>${visibleNote(entry.note)}</td><td>${escape(entry.category)}${entry.category === "组合资产" ? '<span class="source-label" style="display:block">待拆分</span>' : ""}</td><td class="num">${escape(entry.currency)} ${number(entry.amount)}</td><td class="num">${portfolio().rates[entry.currency] && displayValue(1) !== null ? displayAmount(entry.amount * portfolio().rates[entry.currency].value) : "待换算"}</td><td>${escape(entry.asOf)}<span class="source-label" style="display:block">${entryDateBasis(entry)}</span></td><td><span class="pill${included.has(entry.id) ? " gold" : ""}">${pending.has(entry.id) ? "待确认排除" : included.has(entry.id) ? "已计入" : missing.has(entry.id) ? "缺汇率" : "口径排除"}</span></td><td><div class="record-actions"><button class="button quiet" data-action="edit" data-id="${escape(entry.id)}">编辑</button><button class="button quiet danger" data-action="delete" data-id="${escape(entry.id)}">删除</button></div></td></tr>`).join("")}</tbody></table></div>` : accountHasRecords(account) ? '<p class="muted small">已记录未估值资产，数量见上方来源说明。尚无可计入的估值，不能按零资产处理。</p>' : '<p class="muted small">尚未录入资产。此账户的实际余额当前未核实。</p>'}</section>`;
  }).join("") || '<section class="panel empty"><h3>此资产类型暂无记录</h3><p>可恢复全部资产类型，或在录入时选择相应类型。</p><button class="button" data-action="clear-category">恢复全部资产</button></section>'}</div><p class="footnote">账户总额和持仓明细都会保留；只有所选口径计入总资产。待确认账户切换统计口径仍不会纳入合计，需通过“编辑账户”核对平台和确认状态。持仓金额填写当前市值，不填写持仓数量。</p>`;
}
function renderAnalysis(summary) {
  return `${partialValuationNotice()}<div class="charts">${[["资产类型", summary.byCategory], ["平台分布", summary.byPlatform], ["估值币种分布", summary.byCurrency]].map(([title, groups]) => `<section class="panel${title === "资产类型" ? " type-chart-panel" : ""}"><h2>${title}</h2><p class="muted small">${title === "估值币种分布" ? "按记录的估值 / 报表币种分类，未穿透底层资产" : title === "资产类型" ? `按已核算资产折合 ${displayCurrency} · 点击类型查看明细` : `按已核算资产折合 ${displayCurrency}`}</p>${title === "资产类型" ? assetTypeChart(summary) : distribution(groups, summary.total)}</section>`).join("")}</div>${assetTypeGuide()}<div class="columns"><section class="panel"><h2>分布与新鲜度</h2>${insights(summary)}</section><section class="panel"><div class="section-head"><h2>自动汇率与核算范围</h2><button class="button small" data-action="rates">汇率详情</button></div><p class="muted small">${escape(fxStatusText())}</p>${fxNotes()}${rateTable()}</section></div><p class="footnote">分布描述已录入资产的组成。币种按估值 / 报表币种列示，未穿透底层持仓，不代表实际外汇敞口。账户总额未拆分时类别可保留为“未分类”；需要类别分析时可录入持仓并切换统计口径。这里不计算投资收益或负债净额。</p>`;
}
function renderHistory() {
  return `<div class="notice">快照保留保存时的 CNY 金额，不使用今天的汇率重算。转入转出、汇率变化和记录调整都会影响总额，资产变化不能直接视为投资收益。</div><div class="section-head"><div><h2>你的资产时间线</h2><span class="muted small">${state.snapshots.length} 个已保存快照 · 每日北京时间 23:55 自动保存</span></div><button class="button primary small" data-action="snapshot"${!portfolio().entries.length ? " disabled" : ""}>＋ 保存当前快照</button></div>${state.snapshots.length ? `<div class="history-list">${[...state.snapshots].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((snapshot) => `<section class="panel history-item"><div><strong>${escape(dateTime(snapshot.at))}${snapshot.dailyDate ? " · 每日自动快照" : ""}</strong><p class="muted small" style="margin:4px 0 0">${snapshot.missing ? `${snapshot.missing} 条缺汇率 · 部分估值` : "已录入资产估值"} · 资产变化非投资收益</p></div><div><span class="muted small">CNY</span><div class="num">${number(snapshot.total)}</div></div></section>`).join("")}</div>` : '<section class="panel empty"><div class="empty-mark">◷</div><h3>把今天，留给未来的自己</h3><p>录入资产后保存当前快照，逐步留下每个时点的资产全貌。</p><button class="button" data-action="manual">先录入一笔资产</button></section>'}`;
}
const eyeIcon = (paths) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
function privacyToggle() {
  const label = hidden ? "显示金额" : "隐藏金额";
  return `<button type="button" class="eye-toggle" id="privacy-toggle" aria-pressed="${hidden}" aria-label="${label}" title="${label}">${hidden
    ? eyeIcon('<path d="M3 3l18 18"/><path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>')
    : eyeIcon('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>')}</button>`;
}
function setSettingsOpen(open) {
  $("settings-panel").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
}
function render() {
  if (!state) return;
  const summary = summarize(portfolio());
  document.querySelectorAll("[data-page]").forEach((button) => { if (button.dataset.page === page) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  $("asset-content").innerHTML = `${loadFailed ? '<div class="notice error">最近一次重新载入失败，以下仍为上次读取的资产记录。</div>' : ""}${page === "overview" ? renderOverview(summary) : page === "holdings" ? renderHoldings(summary) : page === "analysis" ? renderAnalysis(summary) : renderHistory()}`;
  syncBusy();
  startBubbleMotion();
}
function setDialog(title, description, body, footer, wide = false) {
  clearSyncSecrets();
  $("dialog-title").textContent = title;
  $("dialog-description").textContent = description;
  $("dialog-body").innerHTML = `<div id="dialog-error" role="alert" hidden></div><fieldset id="dialog-fields">${body}</fieldset>`;
  $("dialog-footer").innerHTML = footer;
  $("asset-dialog").className = wide ? "wide" : "";
  if (!$("asset-dialog").open) $("asset-dialog").showModal();
  syncBusy();
}
const cancelButton = '<button class="button" type="button" data-action="close-dialog">取消</button>';
function clearOcr() {
  ocrRun++;
  if (ocrWorker) void ocrWorker.terminate().catch(() => {});
  ocrWorker = null;
  ocrBusy = false;
  if (ocrImage) URL.revokeObjectURL(ocrImage);
  ocrImage = "";
  ocrText = "";
  candidates = [];
  ocrStatus = "";
}
function closeDialog() {
  if (saving) return;
  clearOcr();
  clearSyncSecrets();
  if (modal === "sync") $("dialog-body").innerHTML = "";
  modal = null;
  $("asset-dialog").close();
}
function clearSyncSecrets() {
  if ($("ai-api-key")) $("ai-api-key").value = "";
  for (const provider of ["okx", ...syncWalletProviders]) for (const field of ["key", "secret", "passphrase"]) if ($(`sync-${provider}-${field}`)) $(`sync-${provider}-${field}`).value = "";
}
async function syncRequest(path = "", body) {
  const response = await fetch(`/api/assets/sync${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error("同步服务未返回有效数据，请稍后重试。"); }
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已过期，请重新登录后再授权。");
    if (response.status === 409) throw new Error("资产或同步预览已变化。请重新载入资产并获取最新预览，再核对入账。");
    throw new Error(data.error || "只读同步未完成，请稍后重试。");
  }
  return data;
}
function acceptSyncState(data) {
  if (!data?.providers || !syncProviders.every((provider) => typeof data.providers[provider]?.connected === "boolean")) throw new Error("同步状态格式不正确，请重试。");
  syncState = data;
}
async function openSync() {
  modal = "sync";
  if (syncLoading) { renderSync(); return; }
  syncError = "";
  syncState = null;
  syncLoading = true;
  renderSync();
  try {
    const [sync, assets] = await Promise.allSettled([syncRequest(), fetch("/api/assets", { cache: "no-store" }).then(readResponse)]);
    if (assets.status === "fulfilled") {
      state = assets.value;
      conflict = false;
      loadFailed = false;
      render();
    }
    if (sync.status === "fulfilled") {
      acceptSyncState(sync.value);
      syncAccountId = "";
    } else syncError = errorText(sync.reason);
    if (assets.status === "rejected") throw assets.reason;
  }
  catch (error) { syncError = errorText(error); }
  finally { syncLoading = false; if (modal === "sync") renderSync(); }
}
function syncPreview(provider, details) {
  const preview = details.preview;
  if (!preview) return "";
  const account = portfolio().accounts.find((item) => item.id === preview.targetAccountId);
  const current = account ? currencyTotals(selectedEntries(account)) : [];
  const holdings = Array.isArray(preview.holdings) ? preview.holdings : [];
  const warningText = Array.isArray(preview.warnings) ? preview.warnings : [];
  const coverage = Array.isArray(preview.coverage) ? preview.coverage.join("；") : typeof preview.coverage === "string" ? preview.coverage : "以账户总额及下方覆盖说明为准";
  const stale = preview.revision !== state?.revision;
  const partial = preview.valuationComplete === false;
  const total = partial && !holdings.length ? null : Number.isFinite(preview.total) ? preview.total : null;
  return `<div class="sync-preview"><div class="section-head"><h3>入账前核对${partial ? " · 已定价部分合计" : ""}</h3><span class="pill gold">${escape(preview.currency)} ${number(total)}</span></div><p class="muted small">更新到：${escape(account?.name || preview.targetAccountId)} · ${preview.observedAt ? `源资产时点 ${escape(dateTime(preview.observedAt))}` : `读取日期 ${escape(preview.asOf)} · 源未提供资产时点`}<br>成功读取：${escape(dateTime(preview.fetchedAt))}<br>当前所选口径：${current.map((group) => `${escape(group.name)} ${number(group.value)}`).join(" · ") || "尚未录入"}<br>新统计口径：${basisName(preview.countedBasis)}。账户总额和持仓明细不重复计入。</p>${preview.stockPnl ? `<p class="muted small">账户未实现盈亏：${escape(preview.stockPnl.currency)} ${number(preview.stockPnl.amount)} · 已含在净资产中，不重复加减。</p>` : ""}${hidden ? '<p class="muted small">隐私模式已隐藏覆盖详情与核对说明。</p>' : `<p class="muted small">覆盖范围：${escape(coverage)}</p>${warningText.map((warning) => `<div class="notice">${escape(warning)}</div>`).join("")}`}${unpricedAssetsPanel(preview.unpricedAssets, partial)}${holdings.length ? `<div class="table-scroll"><table><thead><tr><th>资产</th><th>类型</th><th>估值</th></tr></thead><tbody>${holdings.map((holding) => `<tr><td>${escape(holding.name)}</td><td>${escape(holding.category)}</td><td class="num">${escape(holding.currency)} ${number(Number.isFinite(holding.amount) ? holding.amount : null)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted small">此预览暂无可列示的已定价持仓明细。</p>'}${stale ? '<div class="notice">资产记录已变化，请重新获取预览后再入账。</div>' : ""}<div class="actions" style="margin-top:14px"><button class="button primary small" data-action="sync-apply" data-provider="${provider}"${stale ? " disabled" : ""}>核对并入账，开启自动同步</button></div><p class="muted small">首次入账后每天北京时间 09:00、21:00 更新此账户。手动修改此账户后，自动同步会暂停，需重新核对预览。断开后保留已入账数据。</p></div>`;
}
function syncTargetControl(provider, details) {
  const accounts = portfolio().accounts.filter((account) => account.platform === syncPlatforms[provider] && (provider !== "okx" || !/web3|wallet|钱包/i.test(`${account.id} ${account.name}`)) && (provider !== "okxweb3" || /web3|wallet|钱包/i.test(`${account.id} ${account.name}`)));
  const choices = accounts.length ? accounts : [{ id: ({ polymarket: "polymarket-main", future: "future-main", okx: "okx-exchange", futu: "futu-hk", okxweb3: "okx-web3", tokenpocket: "tokenpocket-main", binanceagentic: "binance-agentic-wallet", okxagentic: "okx-agentic-wallet" })[provider], name: `新建 ${syncNames[provider]} 账户` }];
  if (details.lastAppliedAt && details.targetAccountId) syncTargets[provider] = details.targetAccountId;
  else if (!choices.some((account) => account.id === syncTargets[provider])) syncTargets[provider] = choices.some((account) => account.id === details.targetAccountId) ? details.targetAccountId : choices.length === 1 ? choices[0].id : "";
  return `<div class="field" style="margin:12px 0"><label for="sync-${provider}-target">更新到资产页中的账户</label><select id="sync-${provider}-target" data-sync-target="${provider}" required${details.lastAppliedAt ? " disabled" : ""}><option value=""${!syncTargets[provider] ? " selected" : ""}>请选择已有账户，避免重复计入</option>${choices.map((account) => `<option value="${escape(account.id)}"${account.id === syncTargets[provider] ? " selected" : ""}>${escape(account.name)}</option>`).join("")}</select><span class="muted small">${details.lastAppliedAt ? "此数据源已绑定上方账户，后续覆盖更新此账户。" : "首次入账会替换所选账户的当前记录，并保留入账前备份和历史快照。"}</span></div>`;
}
function syncWalletForm(provider, details) {
  if (hidden) return '<p class="muted small">隐私模式已隐藏钱包地址，显示金额后可核对地址或更换 Developer 凭据。</p>';
  const wallets = Array.isArray(details.wallets) ? details.wallets : [];
  const canReuse = syncAgenticProviders.includes(provider) && syncState.developerCredentialsAvailable;
  syncReuseCredentials[provider] ??= Boolean(canReuse);
  const reuse = canReuse && syncReuseCredentials[provider];
  return `<form id="sync-${provider}-form" autocomplete="off"><p class="muted small">使用独立 OnchainOS Developer API 凭据，不同于 OKX 交易所 API。本站仅调用只读资产与价格接口；不需要钱包私钥、助记词或钱包登录，不复制 Agentic Wallet session。请在开发者平台限制服务器 IP：${escape(syncState.serverIp || "173.199.122.23")}。</p><div class="form-grid">${syncWalletNetworks.map((network) => `<div class="field full"><label for="sync-${provider}-address-${network.chainIndex}">${network.name} 公开钱包地址</label><input id="sync-${provider}-address-${network.chainIndex}" data-sync-wallet-provider="${provider}" data-chain-index="${network.chainIndex}" value="${escape(syncWalletDrafts[provider]?.[network.chainIndex] ?? wallets.find((wallet) => wallet.chainIndex === network.chainIndex)?.address ?? "")}" spellcheck="false" autocomplete="off" maxlength="${network.chainIndex === "501" ? 44 : 42}" placeholder="未使用此网络可留空"></div>`).join("")}</div>${canReuse ? `<label class="check-label" style="margin:12px 0"><input type="checkbox" data-sync-reuse="${provider}"${reuse ? " checked" : ""}>复用服务器已保存的只读 Developer 凭据，仅新增此平台的公开地址绑定。</label>` : ""}<fieldset id="sync-${provider}-credentials"${reuse ? " disabled" : ""}><div class="form-grid"><div class="field full"><label for="sync-${provider}-key">Developer API Key</label><input id="sync-${provider}-key" type="password" required autocomplete="off" spellcheck="false"></div><div class="field full"><label for="sync-${provider}-secret">Developer Secret Key</label><input id="sync-${provider}-secret" type="password" required autocomplete="new-password" spellcheck="false"></div><div class="field full"><label for="sync-${provider}-passphrase">Developer API Passphrase</label><input id="sync-${provider}-passphrase" type="password" required autocomplete="new-password" spellcheck="false"></div></div></fieldset><p class="muted small">至少填写一个网络地址；仅同步上方非空网络，不推测其他链。修改地址后需提交凭据验证并重新核对预览，当前自动同步仍使用上次已保存的绑定。合计仅包含可核实价格的资产，NFT 与未核验 DeFi 不在本次覆盖范围。</p><button class="button primary small" type="submit">${reuse ? "复用只读凭据并读取预览" : details.connected ? "验证 Developer 凭据并更新绑定" : "验证 Developer 凭据并读取预览"}</button></form>`;
}
function syncProviderCard(provider) {
  const details = syncState.providers[provider];
  const name = syncNames[provider];
  const connected = details.connected;
  const accounts = Array.isArray(details.accounts) ? details.accounts : [];
  if (provider === "futu" && !accounts.some((account) => account.id === syncAccountId)) syncAccountId = [details.preview?.externalAccountId, details.selectedAccountId].find((id) => accounts.some((account) => account.id === id)) || accounts[0]?.id || "";
  const introduction = syncWalletProviders.includes(provider) ? "按明确绑定的网络与公开地址同步原生币及代币，单独列出缺价数量；钱包与交易所资产分别入账。" : provider === "okx" ? "同步到 OKX · 交易所账户，不包含 OKX Web3 钱包。" : provider === "futu" ? "选择本人真实证券账户；净资产总额为统计依据。" : provider === "future" ? "Solana 充值地址需对应至 Future 的 Polygon 交易账户；此处使用账户页面的 0x 持仓地址。不需要私钥、助记词或签名。不含未到账的充值。" : "用 Polygon 公开持仓地址读取预测仓位与 pUSD 现金。不需要私钥、助记词或签名。";
  let content;
  if (connected) {
    content = `<div class="muted small">${["polymarket", "future", ...syncWalletProviders].includes(provider) ? "公开账户" : "授权账户"}：${hidden ? "已隐藏" : escape(details.accountLabel || "已连接，等待读取账户")}</div>${syncTimes(details)}${syncSourceNotes(details)}${provider === "futu" && accounts.length ? `<div class="field" style="margin-bottom:12px"><label for="sync-futu-account">授权的真实证券账户</label><select id="sync-futu-account">${accounts.map((account) => `<option value="${escape(account.id)}"${account.id === syncAccountId ? " selected" : ""}>${escape(account.label)}</option>`).join("")}</select></div>` : ""}<div class="actions">${provider === "futu" ? '<button class="button small" data-action="sync-futu-accounts">重新读取账户</button><button class="button quiet small" data-action="sync-futu-authorize">重新授权</button>' : ""}<button class="button small" data-action="sync-preview" data-provider="${provider}"${provider === "futu" && !accounts.length ? " disabled" : ""}>读取最新预览</button><button class="button quiet small danger" data-action="sync-disconnect" data-provider="${provider}">断开本站同步</button></div><p class="muted small">${details.usesExistingCredentials ? "断开只停止此钱包的本站同步，不会移除其他账户复用的 Developer 凭据；已入账数据保留。" : ["polymarket", "future"].includes(provider) ? "断开会停止本站同步，保留已入账数据及防止重复计入所需的来源记录。" : "断开会移除本站保存的凭证并停止同步。平台上的 API / OAuth 授权请到对应平台撤销。"}</p>${syncPreview(provider, details)}`;
  } else if (provider === "okx") {
    content = `<ol class="sync-steps"><li>在 OKX 的 API 管理中新建独立 API，只勾选 Read（读取），不要启用交易或提币。</li><li>绑定服务器 IP：<span class="num">${escape(syncState.serverIp || "173.199.122.23")}</span>。选择账户所属地区，再填写新 API 的凭证。</li><li>验证通过后先查看预览，核对后才更新已录入资产。</li></ol><form id="sync-okx-form" autocomplete="off"><div class="form-grid"><div class="field full"><label for="sync-okx-region">OKX 账户所属地区 / 实体</label><select id="sync-okx-region"><option value="global">全球站账户</option><option value="us">美国 / 澳大利亚账户</option><option value="eea">欧洲经济区账户（EEA）</option></select></div><div class="field full"><label for="sync-okx-key">API Key</label><input id="sync-okx-key" type="password" required autocomplete="off" spellcheck="false"></div><div class="field full"><label for="sync-okx-secret">Secret Key</label><input id="sync-okx-secret" type="password" required autocomplete="new-password" spellcheck="false"></div><div class="field full"><label for="sync-okx-passphrase">API Passphrase（创建 API 时设置）</label><input id="sync-okx-passphrase" type="password" required autocomplete="new-password" spellcheck="false"></div></div><div class="actions" style="margin-top:14px"><button class="button primary small" type="submit">验证只读权限并读取预览</button></div></form>`;
  } else if (syncWalletProviders.includes(provider)) {
    content = syncWalletForm(provider, details);
  } else if (provider === "futu") {
    content = '<p class="muted small">前往富途官方页面登录并授权，只申请读取账户资产与持仓。授权时请确认权限不包含交易或资金操作。</p><button class="button primary small" data-action="sync-futu-authorize">前往富途授权</button><p class="muted small">不需要在本站填写富途密码，也不需要安装 OpenD。</p>';
  } else {
    content = `<form id="sync-${provider}-form" autocomplete="off"><div class="field"><label for="sync-${provider}-address">Polygon 公开持仓地址</label><input id="sync-${provider}-address" required pattern="0x[0-9a-fA-F]{40}" maxlength="42" spellcheck="false" autocomplete="off" placeholder="0x…"><span class="muted small">填写实际持有预测仓位的账户地址；充值地址可能与持仓地址不同。</span></div><div class="actions" style="margin-top:14px"><button class="button primary small" type="submit">验证地址并读取预览</button></div></form>`;
  }
  if (!connected && details.lastAppliedAt && syncWalletProviders.includes(provider)) content = `<div class="notice"><strong>已断开本站同步</strong><p class="small">以下为上次入账记录，自动刷新已停止。重新验证凭据后需核对新的资产预览。</p>${syncTimes(details)}${syncSourceNotes(details)}</div>${content}`;
  return `<section class="panel sync-card" aria-label="${name}只读同步"><div class="section-head"><h3>${name}</h3><span class="pill${connected ? " gold" : ""}">${syncStatusLabel(details)}</span></div><p class="muted small">${introduction}</p>${details.lastError ? `<div class="notice error">${hidden ? "最近同步失败，显示金额后可查看详情。" : escape(details.lastError)}</div>` : ""}${syncTargetControl(provider, details)}${content}${connected && syncWalletProviders.includes(provider) ? syncWalletForm(provider, details) : ""}</section>`;
}
function renderSync() {
  setDialog("只读资产同步", "授权后先核对预览。每个平台只更新对应账户，其他已录入资产与历史快照保留。", `${syncError ? `<div class="notice error" role="alert">${escape(syncError)}</div>` : ""}${syncLoading ? '<div class="loading" role="status">正在读取授权与同步状态…</div>' : syncState ? `<div class="notice">仅申请读取资产与持仓；不申请交易、转账或提币权限。凭证仅保存在受保护的服务器，不写入资产导出文件。</div><div class="sync-list">${syncProviders.map(syncProviderCard).join("")}</div>` : '<div class="empty"><p>当前同步状态未核实；已保存资产仍可查看。</p></div>'}`, '<button class="button quiet" data-action="sync-reload">刷新同步状态</button><button class="button" data-action="close-dialog">关闭</button>', true);
}
async function syncMutation(path, body, message) {
  if (saving) return;
  saving = true;
  syncError = "";
  syncBusy();
  try {
    const data = await syncRequest(path, body);
    if (data.assets) {
      state = await readResponse({ ok: true, json: async () => data.assets });
      conflict = false;
      loadFailed = false;
      acceptSyncState(data.sync);
      render();
    } else acceptSyncState(data);
    if (state) state.sync = syncState;
    render();
    clearSyncSecrets();
    if (message) notify(message);
  } catch (error) { syncError = errorText(error); }
  finally { saving = false; if (modal === "sync") renderSync(); syncBusy(); }
}
function syncTargetBody(provider) { return syncTargets[provider] ? { targetAccountId: syncTargets[provider] } : {}; }
async function connectPolymarket() {
  const address = $("sync-polymarket-address").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { showError("请填写有效的 Polygon 公开持仓地址（0x 开头的 42 位地址）。"); return; }
  await syncMutation("/polymarket/connect", { address, ...syncTargetBody("polymarket") }, "公开地址已读取，请核对资产预览");
}
async function connectFuture() {
  const address = $("sync-future-address").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { showError("请填写 Future 的 Polygon 交易账户地址（0x 开头），Solana 充值地址不能直接读取持仓。"); return; }
  await syncMutation("/future/connect", { address, ...syncTargetBody("future") }, "Future 交易账户已读取，请核对资产预览");
}
async function connectOkx() {
  const body = { apiKey: $("sync-okx-key").value.trim(), secret: $("sync-okx-secret").value.trim(), passphrase: $("sync-okx-passphrase").value, region: $("sync-okx-region").value, ...syncTargetBody("okx") };
  if (!body.apiKey || !body.secret || !body.passphrase) { showError("请填写新建只读 API 的 Key、Secret 和 Passphrase。"); return; }
  await syncMutation("/okx/connect", body, "OKX 只读权限已验证，请核对资产预览");
}
async function connectWallet(provider) {
  if (!syncWalletProviders.includes(provider) || saving) return;
  if (hidden) { clearSyncSecrets(); showError("请先显示金额，再核对公开钱包地址。"); return; }
  const reuse = syncAgenticProviders.includes(provider) && syncState?.developerCredentialsAvailable && syncReuseCredentials[provider];
  const body = { ...(reuse ? { useExistingCredentials: true } : { apiKey: $(`sync-${provider}-key`).value.trim(), secret: $(`sync-${provider}-secret`).value.trim(), passphrase: $(`sync-${provider}-passphrase`).value }), wallets: syncWalletNetworks.map((network) => ({ chainIndex: network.chainIndex, address: $(`sync-${provider}-address-${network.chainIndex}`).value.trim() })).filter((wallet) => wallet.address), ...syncTargetBody(provider) };
  clearSyncSecrets();
  if (!reuse && (!body.apiKey || !body.secret || !body.passphrase)) { showError("请填写独立 Developer API 的 Key、Secret 和 Passphrase。"); return; }
  if (!body.wallets.length) { showError("请至少填写一个网络的公开钱包地址。"); return; }
  const invalid = body.wallets.find((wallet) => !(wallet.chainIndex === "501" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/).test(wallet.address));
  if (invalid) { showError(`请填写有效的 ${syncWalletNetworks.find((network) => network.chainIndex === invalid.chainIndex).name} 公开钱包地址，请勿混用网络。`); return; }
  await syncMutation(`/${provider}/connect`, body, "Developer 凭据与公开地址已验证，请核对已定价金额及未估值资产");
}
async function authorizeFutu() {
  if (saving) return;
  saving = true;
  syncBusy();
  try {
    const data = await syncRequest("/futu/authorize", {});
    const url = new URL(data.authorizationUrl);
    if (url.origin !== "https://webapi.futunn.com" || url.pathname !== "/oauth2/authorize/confirm" || url.username || url.password || url.hash) throw new Error("富途授权地址无效，未跳转。");
    clearSyncSecrets();
    location.assign(url.href);
  } catch (error) { syncError = errorText(error); }
  finally { saving = false; if (modal === "sync") renderSync(); syncBusy(); }
}
async function refreshSyncPreview(provider) {
  if (!syncProviders.includes(provider)) return;
  await syncMutation(`/${provider}/preview`, { ...syncTargetBody(provider), ...(provider === "futu" && syncAccountId ? { accountId: syncAccountId } : {}) }, "最新资产已读取，请核对预览");
}
async function applySyncPreview(provider) {
  const preview = syncState?.providers?.[provider]?.preview;
  if (provider === "futu" && preview?.externalAccountId !== syncAccountId) { showError("所选证券账户与预览不同，请重新获取预览后核对。"); return; }
  if (!preview || preview.revision !== state?.revision) { showError("资产记录已变化，请重新获取预览后再入账。"); return; }
  await syncMutation(`/${provider}/apply`, { previewId: preview.id, revision: state.revision }, "资产已入账，此账户已开启每天两次只读同步");
}
function openEntry(entry = null, candidate = null, accountId = "") {
  clearOcr();
  editingId = entry?.id ?? null;
  screenshotConfirmed = false;
  const firstAccount = portfolio().accounts.find((account) => account.id === accountId) || portfolio().accounts[0];
  if (!firstAccount) { openAccount(); return; }
  currencyManual = Boolean(entry);
  currencyDetection = candidate ? detectCurrency(candidate.label) : null;
  draft = entry ? { ...entry } : { id: crypto.randomUUID(), accountId: firstAccount.id, kind: "total", name: "账户总额", category: "未分类", currency: candidate && CURRENCIES.includes(candidate.currency) ? candidate.currency : "", amount: candidate?.amount ?? NaN, asOf: currentDate(), asOfBasis: candidate ? "imported" : "statement", source: candidate ? "screenshot" : "manual" };
  currencyFromCandidate = Boolean(candidate && draft.currency);
  modal = "manual";
  renderManual();
}
function currencyNote() {
  return `${currencyManual ? `当前币种 ${escape(draft.currency || "待选择")}，以你的手动选择为准。` : draft.currency ? `已自动识别 ${escape(draft.currency)}，可在上方手动纠正。` : currencyDetection?.ambiguous ? "币种存在歧义，请手动选择。" : "可从名称中的明确计价标签（如 USD、HKD、美元现金）识别币种；未识别时请手动选择。"} 修改币种仅修正标签，不自动兑换金额。`;
}
function manualNote() {
  const account = portfolio().accounts.find((item) => item.id === draft.accountId);
  const hasEntries = portfolio().entries.some((entry) => entry.accountId === draft.accountId);
  return `${account && pendingAccount(account) ? "此账户待确认，记录不会计入资产合计。" : ""}${hasEntries ? `当前账户按“${basisName(account?.basis)}”统计。另一类型的记录保留供查看，不重复计入总额，可在账户与持仓中切换。` : `这是此账户的第一条记录，保存后将使用“${draft.kind === "total" ? "账户总额" : "持仓合计"}”统计。`}${draft.currency && !portfolio().rates[draft.currency] ? ` ${escape(draft.currency)} 尚未取得自动汇率，暂不计入资产合计。` : ""}${draft.asOfBasis === "imported" ? draft.source === "api" ? " 当前日期为读取日期，源未提供资产时点。" : " 当前日期为导入日期，截图中的资产日期尚未核实；确认实际日期后可调整日期依据。" : ""}`;
}
function renderManual() {
  setDialog(editingId ? "编辑资产记录" : draft.source === "screenshot" ? "核对截图资产" : "新增资产记录", draft.source === "screenshot" ? "识别结果仅作为草稿。请逐项核对账户、金额、币种和日期依据，确认后才会保存。" : "记录账户总额，或添加一项持仓。持仓金额填写当前市值。", `<form id="entry-form"><div class="form-grid"><div class="field"><label for="entry-account">所属账户</label><select id="entry-account" data-entry-field="accountId">${accountOptions(draft.accountId)}</select></div><div class="field"><label for="entry-kind">记录类型</label><select id="entry-kind" data-entry-field="kind"><option value="total"${draft.kind === "total" ? " selected" : ""}>账户总额</option><option value="holding"${draft.kind === "holding" ? " selected" : ""}>持仓明细</option></select></div><div class="field full"><label for="entry-name">资产名称</label><input id="entry-name" data-entry-field="name" value="${escape(draft.name)}" required maxlength="200" placeholder="例如：账户总额、港股持仓、美元现金"></div><div class="field"><label for="entry-amount">原币金额 / 市值</label><input id="entry-amount" data-entry-field="amount" type="${hidden ? "password" : "number"}" inputmode="decimal" min="0" step="any" autocomplete="off" required value="${Number.isFinite(draft.amount) ? draft.amount : ""}" placeholder="填写实际金额"></div><div class="field"><label for="entry-currency">币种</label><select id="entry-currency" data-entry-field="currency" required><option value="" disabled${!draft.currency ? " selected" : ""}>请选择并核对币种</option>${options(CURRENCIES, draft.currency)}</select><span class="muted small" id="manual-currency-note">${currencyNote()}</span></div><div class="field"><label for="entry-category">资产类别</label><select id="entry-category" data-entry-field="category">${options(CATEGORIES, draft.category)}</select></div><div class="field"><label for="entry-date" id="entry-date-label">${entryDateBasis(draft)}</label><input id="entry-date" data-entry-field="asOf" type="date" min="1900-01-01" max="${currentDate()}" required value="${escape(draft.asOf)}"></div><div class="field full"><label for="entry-date-basis">日期依据</label><select id="entry-date-basis" data-entry-field="asOfBasis"><option value="statement"${draft.asOfBasis !== "imported" ? " selected" : ""}>资产日期</option><option value="imported"${draft.asOfBasis === "imported" ? " selected" : ""}>${draft.source === "api" ? "仅记录读取日期 · 源未提供资产时点" : "仅记录导入日期 · 截图日期未核实"}</option></select></div><div class="field full"><label for="entry-note">备注 / 核对说明</label><textarea id="entry-note" data-entry-field="note" maxlength="1000"${hidden ? ' readonly placeholder="隐私模式已隐藏备注，显示金额后可编辑"' : ""}>${escape(hidden ? "" : draft.note || "")}</textarea></div></div><div class="form-note" id="manual-note">${manualNote()}</div>${draft.source === "screenshot" ? `<label class="check-label" style="margin-top:16px"><input type="checkbox" id="screenshot-confirm" required${screenshotConfirmed ? " checked" : ""}>我已逐项核对账户、金额、币种与日期依据，确认保存上述字段。原图和识别文字不会保存。</label>` : ""}<div id="deleted-draft" class="notice" hidden>这条记录已在其他页面删除。草稿仍保留。<button class="button small" data-action="new-from-draft" type="button">作为新记录继续核对</button></div></form>`, `${cancelButton}<button class="button primary" type="submit" form="entry-form">确认保存</button>`);
}
async function saveEntry() {
  if (!draft || saving) return;
  if (editingId && !portfolio().entries.some((entry) => entry.id === editingId)) {
    $("deleted-draft").hidden = false;
    showError("这条记录已在其他页面删除。当前草稿仍保留，请明确选择作为新记录继续核对。");
    return;
  }
  if (draft.source === "screenshot" && !screenshotConfirmed) { showError("请先核对截图字段并勾选确认。"); return; }
  const entry = { ...draft, name: draft.name.trim(), accountId: draft.accountId.trim(), currency: draft.currency.trim() };
  if (portfolio().entries.some((item) => item.id !== editingId && entryIdentity(item) === entryIdentity(entry))) { showError(entry.kind === "total" ? "这个账户已有总额记录，请编辑已有总额或使用其他账户。" : "这个账户已有同名、同币种的持仓，请编辑已有记录，避免重复累加。"); return; }
  const entries = editingId ? portfolio().entries.map((item) => item.id === editingId ? entry : item) : [...portfolio().entries, entry];
  const accounts = portfolio().accounts.map((account) => account.id === entry.accountId && !portfolio().entries.some((item) => item.accountId === account.id) ? { ...account, basis: entry.kind === "total" ? "total" : "holdings" } : account);
  if (await save({ ...portfolio(), accounts, entries }, editingId ? "资产记录已更新" : "资产记录已保存")) closeDialog();
}
function openCurrencyCorrections(platform) {
  if (!PLATFORMS.includes(platform)) return;
  currencyPlatform = platform;
  const ids = new Set(portfolio().accounts.filter((account) => account.platform === platform).map((account) => account.id));
  currencyDraft = Object.fromEntries(portfolio().entries.filter((entry) => ids.has(entry.accountId)).map((entry) => [entry.id, entry.currency]));
  currencyOriginal = { ...currencyDraft };
  modal = "currencies";
  renderCurrencyCorrections();
}
function renderCurrencyCorrections() {
  setDialog(`${currencyPlatform} · 纠正币种`, "逐条核对记录使用的估值 / 报表币种，保存后资产版图会重新分组。", `<div class="notice">修改币种不自动兑换金额，请核对原币金额是否正确。缺少汇率的记录会从人民币合计和饼图中排除；待确认账户保持待确认。</div><div class="table-scroll"><table><thead><tr><th>账户 / 资产</th><th>原币金额</th><th>纠正后的币种</th></tr></thead><tbody>${portfolio().entries.filter((entry) => Object.hasOwn(currencyDraft, entry.id)).map((entry) => {
    const account = portfolio().accounts.find((item) => item.id === entry.accountId);
    const selected = selectedEntries(account).some((item) => item.id === entry.id);
    return `<tr><td><span class="name">${escape(entry.name)}</span><span class="source-label">${escape(account.name)} · ${kindName(entry.kind)} · ${pendingAccount(account) ? "待确认排除" : selected ? "当前统计口径" : "口径排除"}</span></td><td class="num">${escape(entry.currency)} ${number(entry.amount)}</td><td><select aria-label="${escape(entry.name)}的币种" data-currency-entry="${escape(entry.id)}">${options(CURRENCIES, currencyDraft[entry.id])}</select></td></tr>`;
  }).join("")}</tbody></table></div>`, `${cancelButton}<button class="button primary" data-action="save-currencies">保存币种修正</button>`, true);
}
async function saveCurrencyCorrections() {
  const changes = Object.keys(currencyDraft).filter((id) => currencyDraft[id] !== currencyOriginal[id]);
  if (!changes.length) { showError("请先选择需要修正的币种。当前记录尚未改动。"); return; }
  if (changes.some((id) => !portfolio().entries.some((entry) => entry.id === id))) { showError("需要修正的记录已在其他页面删除，请关闭窗口后重新核对。"); return; }
  const entries = portfolio().entries.map((entry) => changes.includes(entry.id) ? { ...entry, currency: currencyDraft[entry.id] } : entry);
  if (await save({ ...portfolio(), entries }, "币种修正已保存，资产版图已更新")) closeDialog();
}
function openAccount(id = null, platform = PLATFORMS[0]) {
  const account = id ? portfolio().accounts.find((item) => item.id === id) : null;
  if (id && !account) { showError("此账户已不存在，请重新载入最新数据。"); return; }
  modal = "account";
  editingAccountId = account?.id || null;
  const selectedPlatform = PLATFORMS.includes(platform) ? platform : PLATFORMS[0];
  accountDraft = account ? { ...account, reviewStatus: pendingAccount(account) ? "pending" : "confirmed", note: account.note || "" } : { platform: selectedPlatform, name: "", reviewStatus: selectedPlatform === "待确认" ? "pending" : "confirmed", note: "" };
  renderAccount();
}
function renderAccount() {
  setDialog(editingAccountId ? "编辑资产账户" : "添加资产账户", "确认实际平台、账户归属和统计状态。待确认账户不会计入资产合计。", `<form id="account-form"><div class="form-grid"><div class="field full"><label for="account-platform">平台</label><select id="account-platform">${options(PLATFORMS, accountDraft.platform)}</select></div><div class="field full"><label for="account-name">账户名称</label><input id="account-name" required maxlength="200" value="${escape(accountDraft.name)}" placeholder="例如：ZA Bank 港币账户"></div><div class="field full"><label for="account-review-status">统计状态</label><select id="account-review-status"><option value="pending"${accountDraft.reviewStatus === "pending" ? " selected" : ""}>待确认 · 不计入合计</option><option value="confirmed"${accountDraft.reviewStatus === "confirmed" ? " selected" : ""}>已确认 · 按所选口径计入</option></select></div><div class="field full"><label for="account-note">账户备注 / 核对说明</label><textarea id="account-note" maxlength="1000"${hidden ? ' readonly placeholder="隐私模式已隐藏备注，显示金额后可编辑"' : ""}>${escape(hidden ? "" : accountDraft.note || "")}</textarea></div></div><div class="form-note">选择“待确认”平台时，需先改为实际平台并核对账户归属，才能设置“已确认”。统计口径可在账户与持仓中单独切换。</div></form>`, `${cancelButton}<button class="button primary" type="submit" form="account-form">${editingAccountId ? "保存账户" : "添加账户"}</button>`);
}
async function saveAccount() {
  const name = accountDraft.name.trim();
  if (editingAccountId && !portfolio().accounts.some((account) => account.id === editingAccountId)) { showError("此账户已在其他页面删除，当前草稿仍保留，请先核对最新数据。"); return; }
  if (accountDraft.platform === "待确认" && accountDraft.reviewStatus === "confirmed") { showError("请先选择实际平台并核对账户归属，再设置为已确认。"); return; }
  if (portfolio().accounts.some((account) => account.id !== editingAccountId && account.platform === accountDraft.platform && account.name.trim() === name)) { showError("同一平台已有这个账户名称，请使用不同名称。"); return; }
  const account = { ...accountDraft, id: editingAccountId || crypto.randomUUID(), name, basis: portfolio().accounts.find((item) => item.id === editingAccountId)?.basis || "total" };
  const accounts = editingAccountId ? portfolio().accounts.map((item) => item.id === editingAccountId ? account : item) : [...portfolio().accounts, account];
  if (await save({ ...portfolio(), accounts }, editingAccountId ? "账户信息已更新" : "新账户已添加")) closeDialog();
}
function openRates() {
  modal = "rates";
  renderRates();
}
function renderRates() {
  setDialog("自动汇率", "支持人民币与美元展示，并支持 HKD 港币基准；下表按每单位折合 CNY 列示，无需手动填写。", `<p class="${state?.fx?.status === "fresh" ? "muted small" : "notice"}">${escape(fxStatusText())}</p>${fxNotes()}${rateTable()}<div class="form-note">CNY 固定为 1。USD、USDT 与 USDC 分别获取汇率，不默认等值。报价时间以数据源为准；汇率更新不改变原币资产金额，也不代表持仓市值已更新。</div>`, '<button class="button" data-action="close-dialog">关闭</button><button class="button primary" data-action="refresh-rates"' + (ratesRefreshing ? ' disabled' : '') + '>' + (ratesRefreshing ? "正在刷新…" : "刷新汇率") + '</button>', true);
}
async function refreshRates() {
  if (!state || saving || loading || ratesRefreshing) return;
  let failure = "";
  ratesRefreshing = true;
  saving = true;
  render();
  if (modal === "rates") renderRates();
  try {
    const response = await fetch("/api/assets/rates/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    state = await readResponse(response);
    loadFailed = false;
    render();
    if (modal === "rates") renderRates();
    if (state.fx?.status === "fresh") notify(`汇率已更新，资产已重新折合 ${displayCurrency}`);
    else failure = state.fx?.status === "stale" ? "部分汇率使用上次数据或日参考汇率，请查看来源与时间。" : "自动汇率暂不可用，未取得汇率的币种暂不折算。";
  } catch (error) { failure = errorText(error); }
  finally { ratesRefreshing = false; saving = false; render(); if (modal === "rates") renderRates(); if (failure) showError(failure); syncBusy(); }
}
function openDelete(id) {
  const entry = portfolio().entries.find((item) => item.id === id);
  if (!entry) return;
  deleteId = id;
  modal = "delete";
  setDialog("删除资产记录", "删除后不再计入当前资产。已经保存的历史快照会保留。", `<p>确认删除“${escape(entry.name)}”${hidden ? "" : `（${escape(entry.currency)} ${number(entry.amount)}）`}？</p>`, `${cancelButton}<button class="button danger" data-action="confirm-delete">确认删除</button>`);
}
async function confirmDelete() {
  if (!portfolio().entries.some((entry) => entry.id === deleteId)) { showError("这条记录已被删除，请关闭窗口查看最新数据。"); return; }
  if (await save({ ...portfolio(), entries: portfolio().entries.filter((entry) => entry.id !== deleteId) }, "资产记录已删除")) closeDialog();
}
function openImport() {
  clearOcr();
  csvEntries = [];
  importBasis = {};
  csvFilename = "";
  replaceConfirmed = false;
  importTab = "screenshot";
  modal = "import";
  renderImport();
}
function mergedCsv() {
  const entries = [...portfolio().entries];
  const identities = new Set();
  let replacements = 0;
  for (const imported of csvEntries) {
    const cleaned = { ...imported, accountId: imported.accountId.trim(), name: imported.name.trim(), currency: imported.currency.trim() };
    const identity = entryIdentity(cleaned);
    if (identities.has(identity)) throw new Error("预览中存在同账户、类型、名称与币种的重复记录。请先合并或移除，避免重复累加。");
    identities.add(identity);
    const index = entries.findIndex((entry) => entryIdentity(entry) === identity);
    if (index >= 0) { replacements++; entries[index] = { ...entries[index], ...cleaned, id: entries[index].id }; } else entries.push(cleaned);
  }
  return { portfolio: { ...portfolio(), entries, accounts: portfolio().accounts.map((account) => importBasis[account.id] ? { ...account, basis: importBasis[account.id] } : account) }, replacements };
}
function csvWarnings() {
  if (!csvEntries.length) return "";
  try {
    const { replacements } = mergedCsv();
    return replacements ? `<div class="notice">此导入将替换 ${replacements} 条已有记录：账户总额按账户匹配；持仓按账户、名称和币种匹配。请逐条核对。<label class="check-label" style="margin-top:10px"><input type="checkbox" id="replace-confirm"${replaceConfirmed ? " checked" : ""}>我已核对，同意替换以上匹配记录。</label></div>` : '<div class="notice">将添加新记录。尚未点击“确认导入”，不会写入资产。</div>';
  } catch (error) { return `<div class="notice error">${escape(errorText(error))}</div>`; }
}
function csvPreview() {
  return `${csvEntries.length ? `<div class="row"><h3>导入前核对</h3><span class="muted small">${escape(csvFilename)} · ${csvEntries.length} 条</span></div><div class="table-scroll"><table class="preview-table"><thead><tr><th>账户</th><th>类型</th><th>名称</th><th>类别</th><th>原币金额</th><th>币种</th><th>日期</th><th></th></tr></thead><tbody>${csvEntries.map((entry, index) => `<tr><td><select aria-label="第${index + 1}条账户" data-row="${index}" data-field="accountId">${accountOptions(entry.accountId)}</select></td><td><select aria-label="第${index + 1}条类型" data-row="${index}" data-field="kind"><option value="total"${entry.kind === "total" ? " selected" : ""}>账户总额</option><option value="holding"${entry.kind === "holding" ? " selected" : ""}>持仓明细</option></select></td><td><input aria-label="第${index + 1}条名称" data-row="${index}" data-field="name" value="${escape(entry.name)}" maxlength="200"></td><td><select aria-label="第${index + 1}条类别" data-row="${index}" data-field="category">${options(CATEGORIES, entry.category)}</select></td><td><input aria-label="第${index + 1}条金额" data-row="${index}" data-field="amount" type="${hidden ? "password" : "number"}" min="0" step="any" value="${Number.isFinite(entry.amount) ? entry.amount : ""}"></td><td><select aria-label="第${index + 1}条币种" data-row="${index}" data-field="currency">${options(CURRENCIES, entry.currency)}</select></td><td><input aria-label="第${index + 1}条日期" data-row="${index}" data-field="asOf" type="date" min="1900-01-01" max="${currentDate()}" value="${escape(entry.asOf)}"></td><td><button class="button small danger" data-action="remove-preview" data-index="${index}" aria-label="移除第${index + 1}条预览">×</button></td></tr>`).join("")}</tbody></table></div><div id="csv-warnings">${csvWarnings()}</div><h3 style="margin:16px 0 8px">确认各账户统计口径</h3>${[...new Set(csvEntries.map((entry) => entry.accountId))].map((id) => `<div class="row" style="margin-bottom:8px"><label class="small" for="import-basis-${escape(id)}">${escape(portfolio().accounts.find((account) => account.id === id)?.name || "未知账户")}</label><select id="import-basis-${escape(id)}" data-import-basis="${escape(id)}"><option value="total"${importBasis[id] === "total" ? " selected" : ""}>账户总额</option><option value="holdings"${importBasis[id] === "holdings" ? " selected" : ""}>持仓合计</option></select></div>`).join("")}` : ""}`;
}
function renderImport() {
  setDialog("导入你的资产", "截图识别与表格导入，都先核对，再保存。无需提供平台密码。", `<div class="import-tabs"><button class="button ${importTab === "screenshot" ? "primary" : "quiet"}" data-action="import-screenshot"${ocrBusy ? " disabled" : ""}>截图识别</button><button class="button ${importTab === "csv" ? "primary" : "quiet"}" data-action="import-csv"${ocrBusy ? " disabled" : ""}>CSV 表格</button></div>${importTab === "screenshot" ? `<div class="upload-zone"><h3>把账户截图，变成资产记录</h3><p>PNG、JPEG、WebP · 单张不超过 10 MB<br>图片仅在浏览器内识别，不上传、不保存原图。</p><input id="screenshot-file" type="file" aria-label="选择账户截图" accept="image/png,image/jpeg,image/webp"${ocrBusy ? " disabled" : ""}></div><p class="ocr-status" id="ocr-status" role="status">${escape(ocrStatus)}</p>${ocrImage ? `<div class="ocr-layout">${hidden ? '<div class="privacy-mask">隐私模式已隐藏原图</div>' : `<img class="ocr-image" src="${escape(ocrImage)}" alt="待核对的账户截图，仅在本机显示">`}<div><label class="muted small" for="ocr-text">识别文字 · 可编辑后重新提取</label><textarea id="ocr-text"${hidden || ocrBusy ? " readonly" : ""}>${escape(hidden ? "隐私模式已隐藏识别文字" : ocrText)}</textarea><button class="button small quiet" data-action="extract-candidates"${hidden || !ocrText || ocrBusy ? " disabled" : ""}>重新提取金额</button></div></div>` : ""}${candidates.length ? `<h3 style="margin-top:20px">选择一项金额继续核对</h3><div class="candidate-list">${candidates.map((candidate, index) => `<button class="candidate" data-action="candidate" data-index="${index}"><span>${hidden ? `识别候选 ${index + 1}` : escape(candidate.label)}</span><b>${escape(candidate.currency || "币种待核对")} ${number(candidate.amount)} →</b></button>`).join("")}</div>` : ocrText && !ocrBusy ? '<div class="notice">没有找到可确认的金额。可修正识别文字后重新提取，或改为手动录入。</div>' : ""}` : `<div class="upload-zone"><h3>用一张表，整理多个账户</h3><p>UTF-8 CSV · 最大 2 MB · 请使用下方模板表头</p><input id="csv-file" type="file" aria-label="选择资产 CSV 文件" accept=".csv,text/csv"></div><div class="import-help"><span>平台与账户名称须匹配已有账户。<br>需要新账户时，请先在“账户与持仓”中添加。</span><button class="button small quiet" data-action="csv-template">下载空白模板 ↓</button></div>${csvPreview()}`}`, `${cancelButton}${importTab === "csv" ? '<button class="button primary" id="confirm-csv" data-action="confirm-csv">确认导入</button>' : '<button class="button" id="manual-from-import" data-action="manual">改为手动录入</button>'}`, true);
}
async function readCsv(file) {
  if (file.size > 2 * 1024 * 1024) { showError("CSV 文件请控制在 2 MB 以内。"); return; }
  try {
    const entries = parseCsv(await file.text(), portfolio().accounts);
    if (modal !== "import") return;
    if (!entries.length) throw new Error("CSV 只有表头，请填写实际资产记录后再导入。");
    csvEntries = entries;
    csvFilename = file.name;
    replaceConfirmed = false;
    importBasis = {};
    for (const entry of entries) {
      const account = portfolio().accounts.find((item) => item.id === entry.accountId);
      importBasis[entry.accountId] ??= portfolio().entries.some((item) => item.accountId === entry.accountId) ? account.basis : entry.kind === "total" ? "total" : "holdings";
    }
    renderImport();
  } catch (error) { showError(errorText(error)); }
}
async function confirmCsv() {
  if (!csvEntries.length) return;
  try {
    const merged = mergedCsv();
    if (merged.replacements && !replaceConfirmed) { showError("导入会替换已有记录。请核对预览并勾选同意替换后再确认。"); return; }
    if (await save(merged.portfolio, `${csvEntries.length} 条资产记录已导入`)) closeDialog();
  } catch (error) { showError(errorText(error)); }
}
function loadOcrLibrary() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!ocrLibrary) ocrLibrary = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/assets/ocr/tesseract.min.js";
    script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("本地识别组件未正确加载"));
    script.onerror = () => { script.remove(); ocrLibrary = null; reject(new Error("本地识别组件加载失败")); };
    document.head.append(script);
  });
  return ocrLibrary;
}
async function recognizeScreenshot(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { showError("请选择 PNG、JPEG 或 WebP 图片。"); return; }
  if (file.size > 10 * 1024 * 1024) { showError("图片不能超过 10 MB，请压缩后重试。"); return; }
  clearOcr();
  const run = ++ocrRun;
  ocrImage = URL.createObjectURL(file);
  ocrBusy = true;
  ocrStatus = "正在准备本地文字识别，首次使用需加载识别模型…";
  renderImport();
  try {
    const tesseract = await loadOcrLibrary();
    if (run !== ocrRun) return;
    const worker = await tesseract.createWorker(["eng", "chi_sim", "chi_tra"], 1, {
      workerPath: `${location.origin}/assets/ocr/worker.min.js`, corePath: `${location.origin}/assets/ocr/core`, langPath: `${location.origin}/assets/ocr/lang`,
      logger: (message) => { if (run !== ocrRun) return; ocrStatus = message.status === "recognizing text" ? `正在本机识别文字… ${Math.round(message.progress * 100)}%` : "正在加载本地识别模型…"; if ($("ocr-status")) $("ocr-status").textContent = ocrStatus; }
    });
    if (run !== ocrRun) { await worker.terminate(); return; }
    ocrWorker = worker;
    const result = await worker.recognize(file);
    if (run !== ocrRun) return;
    ocrText = result.data.text;
    candidates = extractOcrCandidates(ocrText);
    ocrStatus = "识别完成。请选择一项金额，逐项核对后保存。";
  } catch (error) {
    if (run === ocrRun) ocrStatus = `文字识别未完成：${errorText(error)}。可重试或改为手动录入。`;
  } finally {
    if (run === ocrRun) {
      if (ocrWorker) await ocrWorker.terminate().catch(() => {});
      ocrWorker = null;
      ocrBusy = false;
      renderImport();
    }
  }
}
async function takeSnapshot() {
  if (!state || saving || !portfolio().entries.length) return;
  if (conflict) { showError("请先重新载入最新数据，再保存快照。"); return; }
  saving = true;
  syncBusy();
  try {
    const response = await fetch("/api/assets/snapshots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: state.revision }) });
    state = await readResponse(response);
    render();
    notify("当前资产快照已保存");
  } catch (error) { showError(errorText(error)); }
  finally { saving = false; syncBusy(); }
}
function safeCsv(value) { const cell = String(value ?? ""); return `"${(/^[\s]*[=+@-]/.test(cell) ? "'" + cell : cell).replace(/"/g, '""')}"`; }
function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCsv() {
  const rows = [["平台", "账户", "统计口径", "类型", "资产名称", "类别", "币种", "金额", "日期", "来源", "账户确认状态", "日期依据", "账户备注", "资产备注"]];
  for (const entry of portfolio().entries) {
    const account = portfolio().accounts.find((item) => item.id === entry.accountId);
    rows.push([account?.platform, account?.name, basisName(account?.basis), kindName(entry.kind), entry.name, entry.category, entry.currency, entry.amount, entry.asOf, entry.source, account && pendingAccount(account) ? "待确认" : "已确认", entryDateBasis(entry), account?.note, entry.note]);
  }
  download("\uFEFF" + rows.map((row) => row.map(safeCsv).join(",")).join("\r\n"), `资产记录-${currentDate()}.csv`, "text/csv;charset=utf-8");
  notify("已导出真实资产记录 CSV");
}
function exportJson() {
  if (!state) return;
  const unsavedDrafts = { ...(modal === "manual" && draft ? { entry: draft, editingId } : {}), ...(csvEntries.length && modal === "import" ? { csvEntries, importBasis } : {}), ...(modal === "account" ? { account: accountDraft } : {}), ...(modal === "currencies" ? { currencyPlatform, currencyDraft, currencyOriginal } : {}) };
  download(JSON.stringify({ exportedAt: new Date().toISOString(), ...state, ...(Object.keys(unsavedDrafts).length ? { unsavedDrafts } : {}) }, null, 2), `资产备份-${currentDate()}.json`, "application/json;charset=utf-8");
  notify("已导出当前资产、历史快照摘要及打开的草稿");
}
function openExport() {
  modal = "export";
  setDialog("导出你的资产", "下载包含真实金额的文件，请妥善保管。隐私模式仅隐藏页面金额。", '<div class="export-grid"><button class="button" data-action="export-csv">资产记录 CSV ↓<small>仅含已入账估值记录，保留平台、账户、统计口径、原币金额及日期；不含未估值数量明细。</small></button><button class="button" data-action="backup-json">当前资产与历史摘要 JSON ↓<small>当前账户、资产记录、自动汇率、同步来源及未估值数量、历史快照摘要；不含 API 凭据。</small></button></div>', cancelButton);
}
function rerenderDialog() {
  if (modal === "manual") renderManual();
  else if (modal === "import") renderImport();
  else if (modal === "rates") renderRates();
  else if (modal === "account") renderAccount();
  else if (modal === "stock-pnl") openStockPnl();
  else if (modal === "delete") openDelete(deleteId);
  else if (modal === "currencies") renderCurrencyCorrections();
  else if (modal === "sync") renderSync();
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (button?.id === "settings-toggle") { setSettingsOpen($("settings-panel").hidden); return; }
  // Any other click, including choosing a menu item, closes the settings menu.
  if (!$("settings-panel").hidden) setSettingsOpen(false);
  if (!button || button.disabled) return;
  if (button.id === "theme-toggle") {
    const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("assets-theme", theme); } catch {}
    syncThemeToggle();
    return;
  }
  if (button.id === "privacy-toggle") {
    hidden = !hidden;
    render();
    rerenderDialog();
    $("privacy-toggle")?.focus();
    return;
  }
  if (button.dataset.page) { page = button.dataset.page; render(); return; }
  const action = button.dataset.action;
  if (action === "display-currency") { await changeDisplayCurrency(button.dataset.currency); return; }
  if (!action || saving) return;
  if (action === "close-dialog") closeDialog();
  else if (action === "reload") await load();
  else if (action === "stock-pnl") { stockPnlDraft = null; openStockPnl(); }
  else if (action === "ai-settings") openAiSettings();
  else if (action === "ai-review") await loadAi();
  else if (action === "fund-edit") openFund(button.dataset.id);
  else if (action === "atlas-platform" && PLATFORMS.includes(button.dataset.platform)) {
    platformFilter = button.dataset.platform; categoryFilter = "all"; page = "holdings"; render(); $("holdings-filter").scrollIntoView({ block: "start" });
  }
  else if (action === "category" || action === "clear-category") {
    platformFilter = "all";
    categoryFilter = action === "category" && CATEGORIES.includes(button.dataset.category) ? button.dataset.category : "all";
    page = "holdings";
    render();
    $("holdings-filter").scrollIntoView({ block: "start" });
  }
  else if (action === "manual") openEntry(null, null, button.dataset.account);
  else if (action === "edit") openEntry(portfolio().entries.find((entry) => entry.id === button.dataset.id));
  else if (action === "correct-currency") openCurrencyCorrections(button.dataset.platform);
  else if (action === "save-currencies") await saveCurrencyCorrections();
  else if (action === "delete") openDelete(button.dataset.id);
  else if (action === "confirm-delete") await confirmDelete();
  else if (action === "account") openAccount(null, button.dataset.platform);
  else if (action === "edit-account") openAccount(button.dataset.id);
  else if (action === "rates") openRates();
  else if (action === "refresh-rates") await refreshRates();
  else if (action === "import") openImport();
  else if (action === "sync" || action === "sync-reload") await openSync();
  else if (action === "sync-futu-authorize") await authorizeFutu();
  else if (action === "sync-futu-accounts") await syncMutation("/futu/accounts", {}, "授权账户列表已读取，尚未更新资产");
  else if (action === "sync-preview") await refreshSyncPreview(button.dataset.provider);
  else if (action === "sync-apply") await applySyncPreview(button.dataset.provider);
  else if (action === "sync-disconnect" && syncProviders.includes(button.dataset.provider)) await syncMutation(`/${button.dataset.provider}/disconnect`, {}, "本站凭证已移除，已入账资产与历史快照保留；官方授权请到对应平台撤销");
  else if (action === "export") openExport();
  else if (action === "export-csv") exportCsv();
  else if (action === "backup-json") exportJson();
  else if (action === "snapshot") await takeSnapshot();
  else if (action === "csv-template") download(csvTemplate(), "资产导入模板.csv", "text/csv;charset=utf-8");
  else if (action === "import-screenshot" || action === "import-csv") { if (ocrBusy) return; importTab = action === "import-csv" ? "csv" : "screenshot"; renderImport(); }
  else if (action === "remove-preview") { csvEntries.splice(Number(button.dataset.index), 1); replaceConfirmed = false; renderImport(); }
  else if (action === "confirm-csv") await confirmCsv();
  else if (action === "extract-candidates") { if (hidden) return; candidates = extractOcrCandidates(ocrText); renderImport(); }
  else if (action === "candidate") { const candidate = candidates[Number(button.dataset.index)]; if (candidate) openEntry(null, candidate); }
  else if (action === "new-from-draft") { editingId = null; draft.id = crypto.randomUUID(); renderManual(); }
});
document.addEventListener("input", (event) => {
  if (saving) return;
  const target = event.target;
  if (syncWalletProviders.includes(target.dataset.syncWalletProvider)) { (syncWalletDrafts[target.dataset.syncWalletProvider] ??= {})[target.dataset.chainIndex] = target.value; return; }
  if (target.dataset.pnlAccount && stockPnlDraft?.[target.dataset.pnlAccount]) { stockPnlDraft[target.dataset.pnlAccount][target.dataset.pnlField] = target.value; return; }
  if (target.dataset.entryField && draft) {
    const field = target.dataset.entryField;
    if (hidden && field === "note") return;
    draft[field] = field === "amount" ? target.value === "" ? NaN : Number(target.value) : target.value;
    if (field === "currency") currencyManual = true;
    if (field === "name" && !currencyManual && !currencyFromCandidate) {
      currencyDetection = detectCurrency(draft.name);
      if (["USDT", "USDC"].includes(currencyDetection.currency) && !/(?:计价|币种|原币|结算)/.test(draft.name)) currencyDetection = { ...currencyDetection, currency: null };
      draft.currency = currencyDetection.currency || "";
      $("entry-currency").value = draft.currency;
    }
    $("manual-currency-note").innerHTML = currencyNote();
    if (field === "kind" && draft.name === "账户总额" && draft.kind === "holding") { draft.name = ""; $("entry-name").value = ""; }
    screenshotConfirmed = false;
    if ($("screenshot-confirm")) $("screenshot-confirm").checked = false;
    $("manual-note").innerHTML = manualNote();
    if (field === "asOfBasis") $("entry-date-label").textContent = entryDateBasis(draft);
  } else if (target.dataset.currencyEntry && Object.hasOwn(currencyDraft, target.dataset.currencyEntry)) {
    currencyDraft[target.dataset.currencyEntry] = target.value;
  } else if (target.dataset.row !== undefined) {
    const entry = csvEntries[Number(target.dataset.row)];
    if (!entry) return;
    entry[target.dataset.field] = target.dataset.field === "amount" ? target.value === "" ? NaN : Number(target.value) : target.value;
    replaceConfirmed = false;
    $("csv-warnings").innerHTML = csvWarnings();
  } else if (target.id === "account-platform") {
    accountDraft.platform = target.value;
    if (target.value === "待确认") { accountDraft.reviewStatus = "pending"; $("account-review-status").value = "pending"; }
  }
  else if (target.id === "account-name") accountDraft.name = target.value;
  else if (target.id === "account-review-status") accountDraft.reviewStatus = target.value;
  else if (target.id === "account-note" && !hidden) accountDraft.note = target.value;
  else if (target.id === "ocr-text" && !hidden) ocrText = target.value;
});
document.addEventListener("change", async (event) => {
  if (saving) return;
  const target = event.target;
  if (syncAgenticProviders.includes(target.dataset.syncReuse)) {
    const provider = target.dataset.syncReuse; syncReuseCredentials[provider] = target.checked;
    for (const field of ["key", "secret", "passphrase"]) $(`sync-${provider}-${field}`).value = "";
    $(`sync-${provider}-credentials`).disabled = target.checked;
  }
  else if (target.id === "holding-platform-filter") { platformFilter = PLATFORMS.includes(target.value) ? target.value : "all"; render(); }
  else if (target.id === "holding-category-filter") { categoryFilter = CATEGORIES.includes(target.value) ? target.value : "all"; render(); }
  else if (syncProviders.includes(target.dataset.syncTarget)) { const provider = target.dataset.syncTarget; syncTargets[provider] = target.value; if (syncState?.providers[provider]) delete syncState.providers[provider].preview; renderSync(); }
  else if (target.id === "sync-futu-account") { syncAccountId = target.value; if (syncState?.providers.futu) delete syncState.providers.futu.preview; renderSync(); }
  else if (target.id === "csv-file" && target.files?.[0]) await readCsv(target.files[0]);
  else if (target.id === "screenshot-file" && target.files?.[0]) await recognizeScreenshot(target.files[0]);
  else if (target.id === "replace-confirm") replaceConfirmed = target.checked;
  else if (target.id === "screenshot-confirm") screenshotConfirmed = target.checked;
  else if (target.dataset.importBasis) { importBasis[target.dataset.importBasis] = target.value; replaceConfirmed = false; $("csv-warnings").innerHTML = csvWarnings(); }
  else if (target.dataset.row !== undefined && target.dataset.field === "accountId") {
    const id = target.value;
    importBasis[id] ??= portfolio().accounts.find((account) => account.id === id)?.basis ?? "total";
    renderImport();
  } else if (target.dataset.basis) {
    const id = target.dataset.basis;
    const next = { ...portfolio(), accounts: portfolio().accounts.map((account) => account.id === id ? { ...account, basis: target.value } : account) };
    if (!await save(next, "账户统计口径已更新")) render();
  }
});
document.addEventListener("submit", async (event) => {
  if (!["stock-pnl-form", "fund-form", "ai-config-form", "entry-form", "account-form", "sync-okx-form", "sync-polymarket-form", "sync-future-form", "sync-okxweb3-form", "sync-tokenpocket-form", "sync-binanceagentic-form", "sync-okxagentic-form"].includes(event.target.id)) return;
  event.preventDefault();
  if (saving) return;
  if (event.target.id === "stock-pnl-form") await saveStockPnl();
  else if (event.target.id === "ai-config-form") await configureAi();
  else if (event.target.id === "fund-form") await configureFund();
  else if (event.target.id === "entry-form") await saveEntry();
  else if (event.target.id === "account-form") await saveAccount();
  else if (event.target.id === "sync-okx-form") await connectOkx();
  else if (event.target.id === "sync-polymarket-form") await connectPolymarket();
  else if (event.target.id === "sync-future-form") await connectFuture();
  else if (event.target.id === "sync-okxweb3-form") await connectWallet("okxweb3");
  else if (event.target.id === "sync-tokenpocket-form") await connectWallet("tokenpocket");
  else if (event.target.id === "sync-binanceagentic-form") await connectWallet("binanceagentic");
  else if (event.target.id === "sync-okxagentic-form") await connectWallet("okxagentic");
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || $("settings-panel").hidden) return;
  setSettingsOpen(false);
  $("settings-toggle").focus();
});
$("asset-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) { aiOpened = false; void load(); } });
window.addEventListener("pagehide", () => { clearOcr(); clearSyncSecrets(); });
setInterval(async () => {
  if (!state || saving || loading || modal || conflict || document.visibilityState === "hidden") return;
  await load();
}, 12 * 60 * 60 * 1000);
function syncThemeToggle() {
  const light = document.documentElement.dataset.theme === "light";
  $("theme-toggle-label").textContent = light ? "深色模式" : "明亮模式";
  $("theme-toggle").setAttribute("aria-pressed", String(light));
}
syncThemeToggle();
if (typeof matchMedia === "function") matchMedia("(max-width:600px)").addEventListener("change", startBubbleMotion);
void load();
