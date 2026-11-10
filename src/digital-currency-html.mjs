import { SITE_CSS, siteHeader } from "./site-shell.mjs";
import { CRYPTO_WATCH_CSS, cryptoWatchSection } from "./crypto-watch-html.mjs";

const escape = (value) => String(value ?? "—").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const number = (value, digits) => Number.isFinite(value) ? value.toLocaleString("en-US", digits === undefined ? { maximumSignificantDigits: 10 } : { maximumFractionDigits: digits }) : "—";
const percent = (value, digits = 2) => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(digits)}%` : "—";
const fraction = (value) => Number.isFinite(value) ? percent(value * 100, 1) : "—";
const level = (value) => ["green", "yellow", "orange", "red"].includes(value) ? value : "unknown";
const sourceName = (value) => ({ account: "普通永续", grid: "合约网格", dca: "合约马丁格尔" })[value] || "BTC 永续";
const sourceKey = (value) => ({ account: "accountPositions", grid: "gridPositions", dca: "dcaPositions" })[value];
const trendName = (value) => ({ LONG: "多头环境", AVOID: "回避环境" })[value] || "未确定";
const list = (value) => Array.isArray(value) ? value : [];

function time(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function sourceLink([label, value]) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !["www.okx.com", "polymarket.com", "home.treasury.gov", "alternative.me"].includes(url.hostname)) return `<span>${escape(label)} · 链接未核验</span>`;
    return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>`;
  } catch { return `<span>${escape(label)} · 链接未核验</span>`; }
}

function stat(label, value, note = "") {
  return `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd>${note ? `<small>${escape(note)}</small>` : ""}</div>`;
}

function positionCard(position, current, staleSources) {
  const valid = current && !position.stale && !staleSources.some(({ key }) => key === sourceKey(position.source));
  const source = sourceName(position.source), direction = position.direction === "short" ? "做空" : position.direction === "long" ? "做多" : "方向未核实";
  const dca = position.source === "dca" || !position.source;
  const header = `${source} · ${direction}${Number.isFinite(position.lever) ? ` · ${number(position.lever)}x` : ""}`;
  return `<article class="dc-position"><div class="dc-section-head"><h3>${escape(header)}</h3><span class="dc-badge dc-${valid ? level(position.level) : "unknown"}">${valid ? escape(position.level_name || "当前风险未核实") : "当前风险未核实"}</span></div>
<p class="dc-stamp">${valid ? "持仓采集" : "历史持仓"} ${time(position.fetchedAt)} · 北京时间${position.id ? ` · ${escape(position.id)}` : ""}</p>
${!valid ? '<p class="dc-warning-inline">旧持仓仅供复核，不提供当前风险评级或退出测算。</p>' : ""}
<dl class="dc-stats">${stat("仓位", `${number(position.sz_btc)} BTC`)}${stat("均价 · USDT", number(position.avg))}${stat("浮动盈亏 · USDT", number(position.unrealized_pnl))}${stat("固定价格止损 · USDT", position.sl > 0 ? number(position.sl) : "价格止损未确认", position.sl_price_type === "mark" ? "标记价触发" : "")}${stat("止盈 · USDT", position.tp > 0 ? number(position.tp) : "未确认")}${stat("强平价 · USDT", number(position.liq))}${stat("距止损", valid && position.sl > 0 ? percent(position.d_sl) : "—")}${stat("距强平", valid ? percent(position.d_liq) : "—")}${stat("距止盈", valid ? percent(position.d_tp) : "—")}
${position.source === "account" ? "" : stat("策略总收益 · USDT", number(position.total_pnl))}${dca ? stat("自动补仓", `${number(position.safety_filled, 0)} / ${number(position.safety_max, 0)}`, position.next_safety > 0 ? `下次补仓 ${number(position.next_safety)} USDT` : "") : ""}${position.source === "grid" ? `${stat("网格收益 · USDT", number(position.grid_pnl))}${stat("网格区间 · USDT", list(position.grid_range).map((price) => number(price)).join(" — ") || "—")}` : ""}</dl>
${position.stop_note ? `<p class="dc-note">${escape(position.stop_note)}</p>` : ""}${valid && position.risk_reason ? `<p class="dc-note">${escape(position.risk_reason)}</p>` : ""}</article>`;
}

function accountRiskSection(latest, current, now) {
  const account = latest.accountRisk;
  if (!account) return ""; // v2 DTOs have no accountRisk; keep their existing page unchanged.
  const freshAt = stamp => {
    const age = Number(now) - Date.parse(stamp);
    return Number.isFinite(age) && age >= -60_000 && age <= 5 * 3_600_000;
  };
  const fresh = current && !account.stale && freshAt(account.fetchedAt)
    && !list(latest.data_status?.staleSources).some(source => source?.key === "accountRisk");
  const positions = list(account.positions).filter(row => row && typeof row === "object" && !Array.isArray(row));
  const incomplete = !fresh || account.complete !== true || !Array.isArray(account.positions)
    || positions.length !== account.positions.length || list(account.errors).length > 0;
  // Render the saved advisory only: never derive a v3 allowance from a v2 score.
  const limit = fresh && Number.isFinite(latest.score) && latest.score >= 0 && latest.score <= 100
    && [1, 3, 5].includes(account.limit) && account.spotOnly === (account.limit === 1) ? account.limit : null;
  const rows = positions.map(row => {
    const valid = fresh && !row.stale && (row.fetchedAt === undefined || freshAt(row.fetchedAt));
    const unit = row.sizeUnit === "contracts" ? "张" : row.sizeUnit === "base" ? "基础币" : "单位未核实";
    const coverage = valid && ["long", "short"].includes(row.direction) && ["base", "contracts"].includes(row.sizeUnit)
      && Number.isFinite(row.size) && row.size > 0 && Number.isFinite(row.stopSize) && row.stopSize >= 0 && row.stopSize <= row.size
      && Number.isFinite(row.stopCoverage) && row.stopCoverage >= 0 && row.stopCoverage <= 1 && row.coverageLevel !== "unknown"
      && Math.abs(row.stopSize / row.size - row.stopCoverage) <= 1e-9 ? row.stopCoverage : null;
    // Never round a partial stop up to 100%.
    const coverageText = coverage === null ? "未核实" : coverage === 1 ? "100%" : `${number(Math.floor(coverage * 100_000) / 1000, 3)}%`;
    const leverage = valid && Number.isFinite(row.leverage) && row.leverage > 0 ? `${number(row.leverage)}x` : "未核实";
    const breach = valid && limit !== null && (limit === 1 || leverage !== "未核实") && typeof row.overLimit === "boolean" ? row.overLimit : null;
    const source = ({ account: "主账户", grid: "合约网格", dca: "合约马丁格尔" })[row.source] || "来源未核实";
    return `<tr><th scope="row">${escape(row.instId)}<small>${source} · ${row.direction === "long" ? "做多" : row.direction === "short" ? "做空" : "方向未核实"}</small></th><td>${number(row.size)} ${unit}</td><td>${coverage === null ? "未核实" : `${number(row.stopSize)} ${unit}`}</td><td><span class="${coverage === null ? "" : coverage < 1 ? "dc-negative" : "dc-positive"}">${coverageText}</span>${row.coverageNote ? `<small>${escape(row.coverageNote)}</small>` : ""}</td><td>${leverage}<small class="${breach === true ? "dc-negative" : ""}">${breach === null ? "杠杆约束未核实" : breach ? "超出建议上限" : "未超建议上限"}</small></td></tr>`;
  }).join("");
  return `<section class="dc-panel" id="account-risk" aria-labelledby="account-risk-title"><div class="dc-section-head"><div><p class="dc-eyebrow">LEVERAGED ACCOUNT SNAPSHOT</p><h2 id="account-risk-title">全部杠杆仓位 · 止损覆盖</h2></div><span class="dc-stamp">采集 ${time(account.fetchedAt)} · 北京时间</span></div>
<p class="dc-note${incomplete ? " dc-warning-inline" : ""}">${incomplete ? "账户来源不完整或非最新，未取得的仓位与止损风险未核实。" : "本次账户持仓来源完整；止损覆盖与杠杆约束仍须逐项核对。"}</p>
<p class="dc-note">当前建议杠杆上限：${limit === null ? "未核实" : limit === 1 ? "仅现货（不持有杠杆合约）" : `${number(limit)}x`}。仅沿用已保存的建议，不修改杠杆或委托。</p>
${rows ? `<div class="dc-table-wrap"><table class="dc-table"><caption>主账户与策略子账户分列，不合并不同品种的数量</caption><thead><tr><th scope="col">品种 / 来源</th><th scope="col">持仓数量</th><th scope="col">止损数量</th><th scope="col">止损覆盖率</th><th scope="col">杠杆</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="dc-empty">暂无可展示的全部杠杆仓位；空白不代表所有账户无风险。</p>'}
${list(account.errors).length ? `<ul class="dc-source-list">${account.errors.map(error => `<li>${escape(error)}</li>`).join("")}</ul>` : ""}
<p class="dc-footnote">覆盖率仅核对已识别止损委托的数量，不保证触发或成交。未知单位、策略内部止损和失效来源不视为 100% 覆盖。</p></section>`;
}

function riskSection(latest, current) {
  const positions = list(latest.positions || (latest.position ? [latest.position] : [])).slice(0, 100);
  const staleSources = list(latest.data_status?.staleSources);
  const incomplete = !current || positions.some((position) => position.stale) || staleSources.some(({ key }) => ["accountPositions", "gridPositions", "dcaPositions"].includes(key));
  const configured = latest.data_status?.okxConfigured === true;
  const summary = !configured ? "只读账户接入状态未核实，当前风险未核实。" : incomplete ? "持仓来源不完整或非最新，当前风险未核实。" : positions.length ? `${positions.length} 笔 BTC 永续快照，按来源分别展示。` : "本次快照未读取到 BTC 永续持仓，不代表其他币种空仓。";
  return `<section class="dc-panel" id="btc-risk" aria-labelledby="btc-risk-title"><div class="dc-section-head"><div><p class="dc-eyebrow">ACCOUNT SNAPSHOT</p><h2 id="btc-risk-title">BTC 持仓与风险</h2></div><a class="dc-text-link" href="/btc-radar?view=detail#account-risk">高级情景与总资金设置 ↗</a></div>
<p class="dc-note${incomplete || !configured ? " dc-warning-inline" : ""}">${summary}</p><p class="dc-note">仅覆盖 BTC 普通永续、合约网格与马丁格尔；${latest.accountRisk ? "全账户止损覆盖见上方独立分区" : "全账户止损覆盖未提供"}。各来源不合并均价或收益。</p>
${positions.length ? `<div class="dc-positions">${positions.map((position) => positionCard(position, current, staleSources)).join("")}</div>` : '<div class="dc-empty">暂无可展示的 BTC 持仓明细。请核对账户、子账户及合约品种；空白不代表所有账户无风险。</div>'}
<p class="dc-footnote">止损、止盈、强平和距离沿用已保存的评估值；缺失显示 —。拖动预览与总资金设置在高级详情中保留，不会修改 OKX 委托。</p></section>`;
}

function trendSection(latest, current) {
  const trend = latest.trend;
  const stale = !current || list(latest.data_status?.staleSources).some(({ key }) => key === "trend");
  return `<section class="dc-panel dc-trend" id="btc-trend" aria-labelledby="btc-trend-title"><div class="dc-section-head"><div><p class="dc-eyebrow">SLOW TREND</p><h2 id="btc-trend-title">${stale ? "历史趋势" : "慢趋势"}</h2></div><span class="dc-badge dc-${stale ? "unknown" : trend?.state === "LONG" ? "green" : trend?.state === "AVOID" ? "orange" : "unknown"}">${stale ? "当前趋势未核实" : escape(trendName(trend?.state))}</span></div>
${trend ? `<dl class="dc-stats">${stat(`日收盘 ${trend.date || "—"} · USDT`, number(trend.close))}${stat("200 日均线 · USDT", number(trend.average))}${stat("距均线", fraction(trend.distance))}${stat("状态开始", trend.since || "近 100 天内未切换", trend.previous ? `此前为${trendName(trend.previous)}` : "")}</dl><p class="dc-note">${stale ? `历史记录为${escape(trendName(trend.state))}，保留原日线日期。` : ""}按日收盘与 200 日均线的 ±${Number.isFinite(trend.band) ? number(trend.band * 100, 1) : "—"}% 缓冲区观察；回避环境不是做空信号。</p>` : '<p class="dc-empty">日线数据暂缺或不足 200 天，当前趋势未核实。</p>'}</section>`;
}

function factorSection(latest, current) {
  const factors = list(latest.factors).slice(0, 32);
  const indicators = latest.indicators || {};
  return `<section class="dc-panel" id="btc-factors" aria-labelledby="btc-factors-title"><div class="dc-section-head"><div><p class="dc-eyebrow">PRESSURE FACTORS</p><h2 id="btc-factors-title">评分因子</h2></div><span class="dc-stamp">沿用当前生产模型口径</span></div>
${factors.length ? `<div class="dc-factor-grid">${factors.map((factor) => `<details class="dc-factor"><summary><span>${escape(factor.name)}</span><span class="dc-factor-score">${factor.weight === 0 ? "原始盘口 · 不计分" : `${current ? number(factor.score, 1) : "—"} / 100`}<small>权重 ${number(factor.weight)}</small></span></summary><dl>${list(factor.metrics).filter(Array.isArray).map(([label, value]) => stat(label, value)).join("")}</dl>${factor.note ? `<p class="dc-note">${escape(factor.note)}</p>` : ""}</details>`).join("")}</div>` : '<p class="dc-empty">暂无可展示的因子；缺失不会补为中性分数。</p>'}
${indicators.rsi14 || indicators.fearGreed ? `<details class="dc-reference"><summary>独立参考指标 · 不作为交易概率</summary><dl class="dc-stats">${indicators.rsi14 ? `${stat("RSI(14) 日线收盘", number(indicators.rsi14.closed, 1), indicators.rsi14.date || "")}${stat("RSI(14) 含当日盘中", number(indicators.rsi14.intraday, 1))}` : ""}${indicators.fearGreed ? stat("恐惧贪婪指数", `${number(indicators.fearGreed.value, 0)} · ${indicators.fearGreed.label || "—"}`, indicators.fearGreed.date || "") : ""}</dl>${!current ? '<p class="dc-note">历史指标，当前状态未核实。</p>' : ""}</details>` : ""}</section>`;
}

function historySection(radar, latest) {
  const version = latest.modelVersion;
  const daily = radar.daily;
  const rows = version ? list(daily?.snapshots).filter((row) => (row.modelVersion || daily.modelVersion) === version).slice(-120).reverse() : [];
  const history = version ? list(radar.history).filter((row) => row.modelVersion === version).slice(-60).reverse() : [];
  const horizons = daily?.modelVersion === version ? list(daily?.horizons).filter(({ days }) => [1, 7, 30].includes(days)) : [];
  const forward = (value) => Number.isFinite(value) ? `<span class="${value < 0 ? "dc-negative" : value > 0 ? "dc-positive" : ""}">${fraction(value)}</span>` : '<small>未到期 / —</small>';
  return `<section class="dc-panel" id="btc-history" aria-labelledby="btc-history-title"><div class="dc-section-head"><div><p class="dc-eyebrow">DAILY EVIDENCE</p><h2 id="btc-history-title">评分与后续走势</h2></div><span class="dc-stamp">同一模型 · 最近 ${rows.length} 期</span></div><p class="dc-note">北京时间 08:00 后首次评估留作每日快照。后续涨跌从快照价格算到约 N 天后的 UTC 日收盘；分数是压力指标，不是亏损概率。</p>
${rows.length ? `<div class="dc-table-wrap"><table class="dc-table"><caption>当前模型每日快照与后续涨跌</caption><thead><tr><th scope="col">日期</th><th scope="col">评分</th><th scope="col">BTC · USDT</th><th scope="col">1 天后</th><th scope="col">7 天后</th><th scope="col">30 天后</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escape(row.date)}${row.rescoredFrom ? '<small>按本版规则重算</small>' : ""}${list(row.staleSources).length ? '<small>部分来源沿用旧值</small>' : ""}</th><td>${number(row.score, 1)}</td><td>${number(row.price)}</td>${[1, 7, 30].map((days) => `<td>${forward(row.forward?.[days])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : '<p class="dc-empty">当前模型的每日快照暂未取得，其他版本不混入本表。</p>'}
${horizons.length ? `<details class="dc-reference"><summary>已到期样本与秩相关</summary><div class="dc-table-wrap"><table class="dc-table"><thead><tr><th>窗口</th><th>已到期</th><th>平均后续涨跌</th><th>秩相关 ρ</th></tr></thead><tbody>${horizons.map((horizon) => `<tr><th>${number(horizon.days, 0)} 天</th><td>${number(horizon.matured, 0)}</td><td>${fraction(horizon.mean)}</td><td>${Number.isFinite(horizon.spearman) ? number(horizon.spearman, 2) : `需 ${number(daily.minSamples, 0)} 天样本`}</td></tr>`).join("")}</tbody></table></div><p class="dc-note">统计直接沿用该模型的已保存结果。7、30 天窗口相互重叠，样本不独立；样本不足不代表模型有效。</p></details>` : ""}
<details class="dc-reference"><summary>最近评估快照 · ${history.length} 次</summary>${history.length ? `<div class="dc-table-wrap"><table class="dc-table"><thead><tr><th>评估时间 · 北京</th><th>评分</th><th>BTC · USDT</th></tr></thead><tbody>${history.map((row) => `<tr><th>${time(row.ts)}</th><td>${number(row.score, 1)}</td><td>${number(row.price)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="dc-note">暂无同版本评估记录。</p>'}</details></section>`;
}

const DIGITAL_CURRENCY_CSS = `
.digital-currency{max-width:1180px;margin:0 auto;padding:30px 20px 64px;font-size:14px;line-height:1.6}.digital-currency *{box-sizing:border-box}.digital-currency :is(h1,h2,h3,p){margin:0}.digital-currency a{color:var(--brand);text-decoration:none}.digital-currency a:hover{text-decoration:underline}.digital-currency :is(a,summary):focus-visible{outline:2px solid var(--brand);outline-offset:4px}.digital-currency :is(section,details)[id]{scroll-margin-top:100px}.digital-currency .dc-page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:22px}.digital-currency h1{font-size:30px;letter-spacing:-.03em;line-height:1.25}.digital-currency .dc-eyebrow{font-size:10px;letter-spacing:.12em;color:var(--muted);margin-bottom:6px}.digital-currency .dc-lead{font-size:13px;color:var(--muted);margin-top:10px}.digital-currency .dc-jumps{display:flex;gap:6px;flex-wrap:wrap}.digital-currency .dc-jumps a{font-size:12px;white-space:nowrap;border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:8px 12px}.digital-currency .dc-hero{padding:26px 28px;background:linear-gradient(115deg,var(--brand-soft),transparent 70%),var(--surface);border:1px solid var(--line);border-radius:var(--radius);display:grid;grid-template-columns:150px minmax(0,1fr) 200px;gap:28px;align-items:center}.digital-currency .dc-score{font:54px var(--font-num);letter-spacing:-.06em;display:block;line-height:1.1}.digital-currency .dc-score-unit{font-size:11px;color:var(--muted);margin-top:6px}.digital-currency .dc-hero h2{font-size:22px;letter-spacing:-.02em}.digital-currency .dc-summary{font-size:13px;margin-top:8px;white-space:pre-line;color:var(--muted)}.digital-currency .dc-quote{border-left:1px solid var(--line);padding-left:24px}.digital-currency .dc-price{font:23px var(--font-num);letter-spacing:-.04em;overflow-wrap:anywhere}.digital-currency .dc-stamp{font-size:10px;color:var(--muted);overflow-wrap:anywhere}.digital-currency .dc-hero .dc-stamp{margin-top:7px}.digital-currency .dc-warning{margin-top:12px;border:1px solid rgba(183,121,31,.3);background:var(--gold-soft);border-radius:var(--radius-sm);padding:12px 16px;font-size:12px;overflow-wrap:anywhere}.digital-currency .dc-warning strong{display:block;margin-bottom:3px}.digital-currency .dc-warning-inline{color:var(--gold)}.digital-currency .dc-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;margin-top:16px}.digital-currency .dc-panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:22px 24px;min-width:0}.digital-currency .dc-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:12px}.digital-currency .dc-section-head h2{font-size:18px;letter-spacing:-.02em}.digital-currency .dc-section-head h3{font-size:14px}.digital-currency .dc-text-link{font-size:11px;flex-shrink:0}.digital-currency .dc-note{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.digital-currency .dc-note+.dc-note{margin-top:5px}.digital-currency .dc-note.dc-warning-inline{color:var(--gold)}.digital-currency .dc-footnote{font-size:10px;color:var(--muted);margin-top:14px}.digital-currency .dc-badge{display:inline-flex;align-items:center;padding:3px 8px;border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:11px;white-space:nowrap}.digital-currency .dc-green{color:var(--green);background:var(--green-soft)}.digital-currency .dc-yellow{color:var(--gold);background:var(--gold-soft)}.digital-currency .dc-orange{color:var(--orange);background:rgba(232,131,12,.1)}.digital-currency .dc-red{color:var(--red);background:var(--red-soft)}.digital-currency .dc-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin:18px 0}.digital-currency dt{font-size:10px;color:var(--muted)}.digital-currency dd{font:15px var(--font-num);margin:5px 0 0;overflow-wrap:anywhere}.digital-currency .dc-stats small{font-size:10px;color:var(--muted);display:block;margin-top:3px}.digital-currency .dc-positions{display:grid;gap:14px;margin-top:16px}.digital-currency .dc-position{border:1px solid var(--line-soft);border-radius:var(--radius-sm);padding:16px}.digital-currency .dc-position .dc-section-head{margin-bottom:4px}.digital-currency .dc-position .dc-stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:4px}.digital-currency .dc-position dd{font-size:13px}.digital-currency .dc-position .dc-warning-inline{font-size:11px;margin-top:8px}.digital-currency .dc-empty{font-size:12px;color:var(--muted);padding:18px 0 4px}.digital-currency .dc-factor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.digital-currency .dc-factor{border:1px solid var(--line-soft);border-radius:var(--radius-sm);padding:12px 14px;min-width:0}.digital-currency .dc-factor>summary{display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer;font-size:12px;font-weight:600}.digital-currency .dc-factor>summary:before{content:"+";color:var(--muted)}.digital-currency .dc-factor[open]>summary:before{content:"−"}.digital-currency .dc-factor-score{font:13px var(--font-num);margin-left:auto;text-align:right}.digital-currency .dc-factor-score small{display:block;color:var(--muted);font:10px var(--font);margin-top:3px}.digital-currency .dc-factor dl{display:grid;gap:10px;margin:16px 0 12px}.digital-currency .dc-factor dd{font:12px var(--font);white-space:pre-line}.digital-currency .dc-reference{margin-top:16px;border-top:1px solid var(--line-soft);padding-top:10px}.digital-currency .dc-reference>summary{font-size:11px;color:var(--muted);cursor:pointer;padding:4px 0}.digital-currency .dc-table-wrap{overflow-x:auto;margin-top:16px}.digital-currency .dc-table{border-collapse:collapse;width:100%;font-size:11px;white-space:nowrap;font-family:var(--font-num)}.digital-currency .dc-table caption{text-align:left;color:var(--muted);font:10px var(--font);padding:0 0 8px}.digital-currency .dc-table th,.digital-currency .dc-table td{border-bottom:1px solid var(--line-soft);text-align:right;padding:11px 12px}.digital-currency .dc-table th:first-child{text-align:left}.digital-currency .dc-table th{font-weight:500;color:var(--muted)}.digital-currency .dc-table small{font:10px var(--font);display:block;color:var(--muted)}.digital-currency .dc-positive{color:var(--green)}.digital-currency .dc-negative{color:var(--red)}.digital-currency .dc-sources{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:11px;padding-top:12px}.digital-currency .dc-source-list{margin:10px 0 0;padding-left:18px;font-size:11px;color:var(--muted)}.digital-currency .dc-separator{height:1px;background:var(--line);margin:36px 0 28px}.digital-currency .dc-page-stamp{font-size:10px;color:var(--muted);margin-top:24px}
@media(max-width:760px){.digital-currency .dc-page-head{display:block}.digital-currency .dc-jumps{margin-top:16px}.digital-currency .dc-hero{grid-template-columns:110px minmax(0,1fr);gap:18px;padding:22px}.digital-currency .dc-quote{grid-column:1/-1;border-left:0;border-top:1px solid var(--line);padding:14px 0 0;display:flex;align-items:center;justify-content:space-between;gap:20px}.digital-currency .dc-quote .dc-stamp{max-width:45%}.digital-currency .dc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.digital-currency .dc-section-head{flex-wrap:wrap}.digital-currency .dc-position .dc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){.digital-currency{padding:24px 12px 40px}.digital-currency h1{font-size:27px}.digital-currency .dc-panel{padding:18px 16px}.digital-currency .dc-factor-grid{grid-template-columns:1fr}.digital-currency .dc-score{font-size:46px}.digital-currency .dc-hero{padding:18px;grid-template-columns:90px minmax(0,1fr)}.digital-currency .dc-hero h2{font-size:19px}.digital-currency .dc-price{font-size:20px}.digital-currency .dc-table th,.digital-currency .dc-table td{padding:10px 8px}.digital-currency .dc-position{padding:12px}.digital-currency .dc-jumps a{padding:7px 10px}.digital-currency .dc-quote{display:block}.digital-currency .dc-quote .dc-stamp{max-width:none}.digital-currency .dc-position .dc-section-head{align-items:flex-start}}
@media print{.digital-currency .dc-jumps,.digital-currency .dc-text-link{display:none}.digital-currency .dc-panel{break-inside:avoid}}
`;

export function digitalCurrencyHtml({ radar = {}, watch = {}, now = new Date() } = {}) {
  const latest = radar.latest || {};
  // The production loader owns model and age validity; this page only renders its DTO.
  const current = radar.status === "AVAILABLE" && radar.freshness?.expired !== true && Boolean(radar.latest);
  const staleSources = list(latest.data_status?.staleSources);
  const missing = radar.status === "MISSING" || !radar.latest;
  const warning = radar.status === "ERROR" ? ["BTC 评估读取失败", radar.error || "暂时无法读取 BTC 快照；收藏日报独立展示。"] : !current && !missing ? ["BTC 评估已失效", "当前评分、趋势与持仓风险结论不再有效。历史记录保留原时间，收藏日报独立更新。"] : missing ? ["BTC 评估尚未取得", "当前评分与持仓风险未核实；已有收藏日报仍可查看。"] : null;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>BTC 与收藏 · 数字货币</title><style>${SITE_CSS}${DIGITAL_CURRENCY_CSS}${CRYPTO_WATCH_CSS}</style></head><body>${siteHeader("/crypto")}<main class="digital-currency">
<div class="dc-page-head"><div><p class="dc-eyebrow">DIGITAL ASSETS</p><h1>BTC 与收藏</h1><p class="dc-lead">先看 BTC 的压力、趋势与持仓，再逐个查看 OKX 收藏标的。</p></div><nav class="dc-jumps" aria-label="页内分区"><a href="#btc-overview">BTC 概览</a><a href="#btc-risk">持仓风险</a><a href="#btc-history">每日证据</a><a href="#favorites">收藏与新闻</a></nav></div>
<section class="dc-hero" id="btc-overview" aria-labelledby="btc-overview-title"><div><p class="dc-eyebrow">BTC PRESSURE</p><strong class="dc-score">${current ? number(latest.score, 1) : "—"}</strong><p class="dc-score-unit">压力评分 / 100 · 非亏损概率</p></div><div><h2 id="btc-overview-title">${current ? escape(latest.level_name || "当前评分未核实") : "当前评估未核实"}</h2><p class="dc-summary">${!current && latest.summary ? "历史摘要：" : ""}${escape(latest.summary || "尚无有效的 BTC 评估结论。")}</p><p class="dc-stamp">评估 ${time(latest.ts)} · 北京时间</p></div><div class="dc-quote"><div><p class="dc-eyebrow">${current ? "快照现价" : "历史报价"} · USDT</p><p class="dc-price">${number(latest.price)}</p></div><p class="dc-stamp">与评估同一时点<br>页面刷新不会生成新行情</p></div></section>
${warning ? `<aside class="dc-warning" role="status"><strong>${warning[0]}</strong>${escape(warning[1])}</aside>` : ""}
${staleSources.length ? `<aside class="dc-warning"><strong>部分来源沿用旧值</strong>${current ? "评分沿用生产评估返回的有效值；" : "当前结论已失效；"}以下来源保留原采集时间。<ul class="dc-source-list">${staleSources.map((source) => `<li>${escape(source.label || source.key)} · ${time(source.since)} 北京时间</li>`).join("")}</ul></aside>` : ""}
<div class="dc-layout">${accountRiskSection(latest, current, now)}${riskSection(latest, current)}${trendSection(latest, current)}${factorSection(latest, current)}${historySection(radar, latest)}</div>
<details class="dc-reference"><summary>BTC 模型与来源</summary><p class="dc-note">模型版本 ${escape(latest.modelVersion)}。页面只展示已保存的生产评估，不重算评分或账户风险。评分、慢趋势与账户风险分别观察；预测盘口为原始参考，不提供止盈止损概率。</p><div class="dc-sources">${list(latest.sources).filter(Array.isArray).slice(0, 16).map(sourceLink).join("") || '<span>来源链接暂缺</span>'}</div></details>
<div class="dc-separator" aria-hidden="true"></div>${cryptoWatchSection(watch)}<p class="dc-page-stamp">页面读取 ${time(now)} · 北京时间 · 每 60 秒刷新，来源各自保留原始时间。</p>
</main></body></html>`;
}
