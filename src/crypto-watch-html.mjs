import { SITE_CSS, siteHeader } from "./site-shell.mjs";

const escape = (value) => String(value ?? "—").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const number = (value, maximumFractionDigits) => Number.isFinite(value) ? value.toLocaleString("en-US", maximumFractionDigits === undefined ? { maximumSignificantDigits: 10 } : { maximumFractionDigits }) : "—";
const percent = (value, digits = 2) => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(digits)}%` : "—";
const changeClass = (value) => Number.isFinite(value) ? value > 0 ? "positive" : value < 0 ? "negative" : "" : "muted";
const message = (error) => typeof error === "string" ? error : error?.message || error?.error || "采集未完成";
const statusLabel = (value) => ({ OK: "采集完整", PARTIAL: "部分数据缺失", FAILED: "采集失败", MISSING: "尚未采集" })[value] || "数据待核验";
const SORTS = Object.freeze([["24h", "24 小时"], ["7d", "7 日"], ["name", "名称"]]);

function time(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function okxLink(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !["www.okx.com", "okx.com", "app.okx.com", "us.okx.com", "eea.okx.com"].includes(url.hostname)
      || !/^\/(?:[a-z]{2}(?:-[a-z]+)?\/)?(?:markets\/favorite\/?|trade-(?:spot|swap)\/[a-z0-9-]+\/?)$/i.test(url.pathname)) return "";
    return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(label)} <span aria-hidden="true">↗</span></a>`;
  } catch { return ""; }
}

function newsPublisher(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const labels = { "www.coindesk.com": "CoinDesk", "coindesk.com": "CoinDesk", "cointelegraph.com": "Cointelegraph", "www.cointelegraph.com": "Cointelegraph", "decrypt.co": "Decrypt", "www.decrypt.co": "Decrypt" };
    const label = Object.hasOwn(labels, url.hostname) ? labels[url.hostname] : null;
    if (label) return { url: url.href, label, kind: "news" };
    if (["www.okx.com", "okx.com"].includes(url.hostname) && /^\/(?:[a-z]{2}(?:-[a-z]+)?\/)?help(?:\/|$)/i.test(url.pathname)) return { url: url.href, label: "OKX", kind: "announcement" };
  } catch {}
  return null;
}

function newsLink(value, label) {
  const publisher = newsPublisher(value);
  return publisher ? `<a href="${escape(publisher.url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>` : `<span>${escape(label)}</span>`;
}

function newsItems(items, news, limit) {
  const sources = Array.isArray(news.sources) ? news.sources : [];
  return `<ul class="news-list">${items.slice(0, limit).map((item) => {
    const publisher = newsPublisher(item.url), source = sources.find((source) => source.id === item.sourceId);
    const cached = source?.status === "CACHED";
    return `<li><div class="news-badges"><span class="badge">${publisher?.kind === "announcement" ? "官方公告" : publisher ? "媒体报道" : "来源链接未核验"}</span>${cached ? '<span class="badge warning">沿用缓存</span>' : ""}</div><p>${newsLink(item.url, item.title)}</p><p class="news-meta">${escape(publisher?.label || "未核验来源")} · 发布 ${time(item.publishedAt)}<br>${cached ? "原采集" : "采集"} ${time(source?.fetchedAt || item.fetchedAt)} · 北京时间</p></li>`;
  }).join("")}</ul>`;
}

function tokenNews(token, news) {
  if (!news) return "";
  const base = String(token.instId || "").split("-")[0];
  const entry = Array.isArray(news.byBase) ? news.byBase.find((entry) => entry.base === base) : null;
  const state = entry?.status || (news.status === "FAILED" ? "UNAVAILABLE" : "UNSUPPORTED");
  const items = Array.isArray(entry?.items) ? entry.items : [];
  const notice = ({
    NO_MATCHES: "本次已接入来源中未匹配到相关新闻。",
    PARTIAL: "部分来源未更新，以下结果仅供查阅已取得的标题。",
    UNAVAILABLE: "新闻来源暂不可用，无法判断是否有相关更新。",
    UNSUPPORTED: "该标的新闻身份尚未核验，暂不匹配标题。"
  })[state];
  return `<section class="token-news"><h4>${token.kind === "tradfi" ? "标的公司新闻" : "相关新闻与公告"}</h4>${token.kind === "tradfi" ? '<p class="news-note">公司消息不代表相关合约发行或股票持有。</p>' : ""}${notice ? `<p class="news-note${["PARTIAL", "UNAVAILABLE"].includes(state) ? " warning" : ""}">${notice}</p>` : ""}${items.length ? newsItems(items, news, 3) : state === "OK" ? '<p class="news-note">暂无可展示的标题。</p>' : ""}</section>`;
}

function headlineFeed(news) {
  if (!news) return [];
  const seen = new Set();
  const rows = [];
  for (const item of [...(Array.isArray(news.announcements) ? news.announcements : []), ...((Array.isArray(news.byBase) ? news.byBase : []).flatMap((entry) => (Array.isArray(entry.items) ? entry.items.map((item) => ({ ...item, base: entry.base })) : [])))]) {
    const key = item.id || item.url || item.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(item);
  }
  return rows.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
}

function newsOverview(news) {
  if (!news) return "";
  const sources = Array.isArray(news.sources) ? news.sources : [];
  const count = (state) => sources.filter((source) => source.status === state).length;
  const headlines = headlineFeed(news);
  return `<section class="notice news-overview"><div class="section-head"><h2>今日标题</h2><span class="badge${news.status === "OK" ? "" : " warning"}">${({ OK: "来源已更新", PARTIAL: "部分来源未更新", FAILED: "新闻采集失败" })[news.status] || "新闻状态待核验"}</span></div>
<p class="news-note">新闻采集 ${time(news.generatedAt)} · 北京时间；仅覆盖各来源返回的标题，未匹配到标题不等于没有事件。</p>
${headlines.length ? newsItems(headlines, news, 8) : `<p class="news-note">${news.status === "FAILED" ? "新闻来源暂不可用，无法判断是否有相关更新。" : "本次窗口内暂无可展示的标题。"}</p>`}
<details class="news-source-details"><summary>来源健康 · ${sources.length} · 正常 ${count("OK")} · 缓存 ${count("CACHED")} · 失败 ${count("FAILED")}</summary><div class="news-sources">${sources.map((source) => `<div><p><span class="badge">${source.kind === "announcement" ? "官方公告" : "媒体报道"}</span> ${newsLink(source.url, source.label)} · ${({ OK: "已更新", CACHED: "沿用缓存", FAILED: "采集失败" })[source.status] || "状态待核验"}</p><p class="news-meta">${source.status === "CACHED" ? "原采集" : "采集"} ${time(source.fetchedAt)} · 最近尝试 ${time(source.lastAttemptAt)} · 北京时间</p>${typeof source.coverage === "string" ? `<p class="news-note">${escape(source.coverage)}</p>` : ""}${source.error ? `<p class="news-note warning">${escape(message(source.error))}</p>` : ""}</div>`).join("")}</div></details>${Array.isArray(news.errors) && news.errors.length ? `<ul class="errors">${news.errors.map((error) => `<li>${escape(message(error))}</li>`).join("")}</ul>` : ""}</section>`;
}

function globalAnnouncements(news) {
  if (!news) return "";
  const items = Array.isArray(news.announcements) ? news.announcements : [];
  const source = Array.isArray(news.sources) ? news.sources.find((source) => source.kind === "announcement") : null;
  return `<section class="group global-announcements"><div class="section-head"><h2>OKX 平台公告 <span>${items.length}</span></h2><p>平台公告单独展示；仅标题明确相关时才归入标的。</p></div>${items.length ? newsItems(items, news, 10) : `<p class="news-note">${source?.status === "OK" ? "本次返回的公告列表中没有有效条目。" : "公告来源未更新，暂无可展示的有效条目。"}</p>`}</section>`;
}

function tokenRow(token, news) {
  const swap = token.instType === "SWAP";
  const errors = Array.isArray(token.errors) ? token.errors : [];
  return `<article class="token-row" data-instrument="${escape(token.instId)}">
<div class="token-head"><div class="token-identity"><h3>${escape(token.name || token.instId)}</h3><p class="instrument">${escape(token.instId)}</p><span class="badge${token.status === "OK" ? "" : " warning"}">${statusLabel(token.status)}</span></div><div><div class="eyebrow">现价 · USDT</div><div class="token-price">${number(token.price)}</div></div><div class="change ${changeClass(token.change24hPct)}">${percent(token.change24hPct)}<small>24 小时</small></div><div class="change ${changeClass(token.return7dPct)}">${percent(token.return7dPct)}<small>7 日收盘涨跌</small></div></div>
${token.kind === "tradfi" ? '<p class="asset-kind">TradFi / Pre-IPO · 合约标的，不代表持有公司股票。</p>' : ""}
<details class="instrument-details"><summary>报价、指标与相关新闻</summary><p class="digest">${escape(token.summary || "暂无可用行情摘要。")}</p>
<dl class="metrics"><div><dt>24h 最高 / 最低 · USDT</dt><dd>${number(token.high24h)} / ${number(token.low24h)}</dd></div>
${swap ? `<div><dt>资金费率 · 下一结算周期</dt><dd>${percent(token.fundingRatePct, 4)}</dd></div><div><dt>下次资金费结算 · 北京时间</dt><dd>${time(token.fundingTime)}</dd></div>` : `<div><dt>24h 成交额</dt><dd>${Number.isFinite(token.volume24hQuote) ? `${number(token.volume24hQuote, 0)} USDT` : "—"}</dd></div><div><dt>买卖价差</dt><dd>${percent(token.spreadPct, 4)}</dd></div>`}</dl>
<p class="quote">买一 ${number(token.bid)} USDT · 卖一 ${number(token.ask)} USDT${swap ? ` · 价差 ${percent(token.spreadPct, 4)}` : ""}</p>${errors.length ? `<ul class="errors">${errors.map((error) => `<li>${escape(message(error))}</li>`).join("")}</ul>` : '<p class="news-note">此标的未记录采集错误。</p>'}
${tokenNews(token, news)}</details>
<footer><span>行情时点：${time(token.observedAt)}</span>${okxLink(token.sourceUrl, "OKX 原始行情")}</footer></article>`;
}

function sortKey(sort) {
  return SORTS.some(([id]) => id === sort) ? sort : "24h";
}

function sortedTokens(tokens, sort) {
  const key = sortKey(sort);
  const rows = [...tokens];
  if (key === "name") return rows.sort((a, b) => String(a.name || a.instId || "").localeCompare(String(b.name || b.instId || ""), "zh"));
  const field = key === "7d" ? "return7dPct" : "change24hPct";
  return rows.sort((a, b) => (Number.isFinite(b[field]) ? b[field] : -Infinity) - (Number.isFinite(a[field]) ? a[field] : -Infinity));
}

function moverChip(token) {
  return `<a class="mover ${changeClass(token.change24hPct)}" href="#instrument-${escape(token.instId)}"><strong>${escape(token.name || token.instId)}</strong><span>${percent(token.change24hPct)}</span></a>`;
}

function moversSection(tokens) {
  const usable = tokens.filter((token) => Number.isFinite(token.change24hPct));
  if (usable.length < 2) return "";
  const byType = (instType) => usable.filter((token) => token.instType === instType);
  const block = (label, rows) => {
    if (rows.length < 2) return "";
    const up = [...rows].sort((a, b) => b.change24hPct - a.change24hPct).slice(0, 3);
    const down = [...rows].sort((a, b) => a.change24hPct - b.change24hPct).slice(0, 3);
    return `<div class="movers-block"><p class="eyebrow">${label} · 24 小时</p><div class="movers-row"><span class="movers-label">涨幅</span>${up.map(moverChip).join("")}</div><div class="movers-row"><span class="movers-label">跌幅</span>${down.map(moverChip).join("")}</div></div>`;
  };
  const body = `${block("现货", byType("SPOT"))}${block("永续", byType("SWAP"))}`;
  return body ? `<section class="movers" aria-label="今日异动">${body}</section>` : "";
}

function sortToolbar(sort, { path = "/crypto", view = "" } = {}) {
  const active = sortKey(sort);
  const query = (id) => {
    const params = new URLSearchParams();
    if (view === "favorites") params.set("view", "favorites");
    if (id !== "24h") params.set("sort", id);
    const text = params.toString();
    return `${path}${text ? `?${text}` : ""}${view === "favorites" ? "" : "#favorites"}`;
  };
  return `<nav class="sort-bar" aria-label="收藏排序">${SORTS.map(([id, label]) => `<a href="${escape(query(id))}"${id === active ? ' aria-current="true"' : ""}>${label}</a>`).join("")}</nav>`;
}

export const CRYPTO_WATCH_CSS = `
.crypto-watch{font-size:14px;line-height:1.6;min-width:0}.crypto-watch *{box-sizing:border-box}.crypto-watch :is(h2,h3,h4,p){margin:0}.crypto-watch a{color:var(--brand);text-decoration:none}.crypto-watch a:hover{text-decoration:underline}.crypto-watch :is(a,summary):focus-visible{outline:2px solid var(--brand);outline-offset:4px}.crypto-watch h2{font-size:22px;letter-spacing:-.02em}.crypto-watch h3{font-size:14px;line-height:1.4}.crypto-watch .muted,.crypto-watch .eyebrow{color:var(--muted)}.crypto-watch .eyebrow{font-size:11px}.crypto-watch .cw-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:18px}.crypto-watch .cw-hero .eyebrow{margin-bottom:6px}.crypto-watch .lead{font-size:13px;color:var(--muted);margin-top:8px}.crypto-watch .actions a{display:inline-flex;align-items:center;min-height:40px;padding:8px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface);font-size:12px;white-space:nowrap}.crypto-watch .overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px}.crypto-watch .overview>div{padding:14px 16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);min-width:0}.crypto-watch .overview .value{font:17px var(--font-num);margin-top:6px}.crypto-watch .overview small{display:block;color:var(--muted);margin-top:5px;font-size:11px}.crypto-watch .notice{padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);margin:12px 0;overflow-wrap:anywhere}.crypto-watch .notice.warning{border-color:rgba(183,121,31,.35);background:var(--gold-soft)}.crypto-watch .notice strong{display:block;margin-bottom:3px}.crypto-watch .notice p,.crypto-watch .notice li{font-size:12px}.crypto-watch .notice ul{margin:6px 0 0;padding-left:20px}.crypto-watch .group{margin-top:22px}.crypto-watch .section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.crypto-watch .group h2{font-size:16px}.crypto-watch .section-head h2 span{display:inline-block;font:11px var(--font-num);margin-left:6px;padding:2px 8px;border-radius:20px;background:var(--surface-3);color:var(--muted)}.crypto-watch .section-head>p{font-size:11px;color:var(--muted)}.crypto-watch .token-list{display:grid;gap:8px}.crypto-watch .token-row{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);padding:14px 16px;overflow-wrap:anywhere;scroll-margin-top:88px}.crypto-watch .token-head{display:grid;grid-template-columns:minmax(150px,1.5fr) minmax(130px,1fr) repeat(2,minmax(80px,.7fr));align-items:center;gap:16px}.crypto-watch .token-identity .badge{margin-top:5px}.crypto-watch .instrument{color:var(--muted);font:10px var(--font-num);margin-top:3px}.crypto-watch .badge{display:inline-block;padding:2px 6px;border-radius:5px;background:var(--surface-2);color:var(--muted);font-size:10px}.crypto-watch .badge.warning{background:var(--gold-soft);color:var(--gold)}.crypto-watch .asset-kind{color:var(--gold);font-size:11px;margin-top:8px}.crypto-watch .token-price{font:18px var(--font-num);letter-spacing:-.03em;margin-top:4px;overflow-wrap:anywhere}.crypto-watch .change{font:14px var(--font-num);text-align:right}.crypto-watch .change small{display:block;font:10px var(--font);color:var(--muted);margin-top:5px}.crypto-watch .positive{color:var(--green)}.crypto-watch .negative{color:var(--red)}.crypto-watch .instrument-details{margin-top:8px;font-size:12px}.crypto-watch .instrument-details>summary{padding:6px 0;color:var(--muted);cursor:pointer;font-size:11px}.crypto-watch .digest{color:var(--muted);white-space:pre-line;margin:8px 0 12px}.crypto-watch .metrics{margin:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 24px}.crypto-watch .metrics dt{font-size:11px;color:var(--muted)}.crypto-watch .metrics dd{margin:4px 0 0;font:12px var(--font-num)}.crypto-watch .quote{font-size:11px;color:var(--muted);margin:12px 0}.crypto-watch .errors{color:var(--gold);padding-left:18px;margin:8px 0 10px}.crypto-watch .token-row footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:5px;margin-top:6px;font-size:10px;color:var(--muted)}.crypto-watch .empty{padding:24px;margin-top:16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm)}.crypto-watch .empty h2{font-size:16px}.crypto-watch .empty p{margin-top:8px;color:var(--muted);font-size:12px}.crypto-watch .scope{font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:16px;margin-top:24px}.crypto-watch .scope p+p{margin-top:5px}.crypto-watch .sync-note{font-size:11px}.crypto-watch .history{margin-top:16px;font-size:11px;color:var(--muted)}.crypto-watch .history summary{cursor:pointer;padding:8px 0}.crypto-watch .history-list{display:flex;flex-wrap:wrap;gap:8px 18px}.crypto-watch .history-list span{padding:5px 0}.crypto-watch .history time{font-family:var(--font-num)}
.crypto-watch .token-news{margin:14px 0 8px;padding-top:12px;border-top:1px solid var(--line-soft)}.crypto-watch .token-news h4{margin-bottom:8px;font-size:12px}.crypto-watch .news-note{font-size:11px;color:var(--muted);line-height:1.7}.crypto-watch .news-note.warning{color:var(--gold)}.crypto-watch .news-list{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:14px}.crypto-watch .news-list li{min-width:0;overflow-wrap:anywhere}.crypto-watch .news-list li>p{font-size:12px;margin-top:5px;line-height:1.65}.crypto-watch .news-badges{display:flex;gap:5px;flex-wrap:wrap}.crypto-watch .news-meta,.crypto-watch .news-list .news-meta{font-size:10px;color:var(--muted)}.crypto-watch .news-overview .section-head{margin-bottom:6px}.crypto-watch .news-overview h2{font-size:14px}.crypto-watch .news-source-details{margin-top:8px}.crypto-watch .news-source-details summary{cursor:pointer;font-size:11px;color:var(--muted);padding:4px 0}.crypto-watch .news-sources{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:10px}.crypto-watch .news-sources>div{padding-top:10px;border-top:1px solid var(--line-soft);min-width:0}.crypto-watch .platform-news{margin-top:20px;padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface)}.crypto-watch .platform-news>summary{cursor:pointer;font-size:13px;font-weight:600}.crypto-watch .global-announcements{margin-top:12px}.crypto-watch .global-announcements .news-list{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.crypto-watch .movers{display:grid;gap:12px;margin:14px 0;padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface)}.crypto-watch .movers-block+.movers-block{padding-top:12px;border-top:1px solid var(--line-soft)}.crypto-watch .movers-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}.crypto-watch .movers-label{font-size:11px;color:var(--muted);min-width:2.5em}.crypto-watch .mover{display:inline-flex;align-items:baseline;gap:8px;padding:6px 10px;border-radius:8px;background:var(--surface-2);font-size:12px}.crypto-watch .mover strong{font-weight:600;color:var(--text)}.crypto-watch .sort-bar{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 4px}.crypto-watch .sort-bar a{font-size:12px;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--muted)}.crypto-watch .sort-bar a[aria-current="true"]{color:var(--brand-ink);background:var(--brand);border-color:var(--brand)}
@media(max-width:640px){.crypto-watch .cw-hero{display:block}.crypto-watch .actions{margin-top:10px}.crypto-watch .overview{grid-template-columns:1fr;gap:8px}.crypto-watch .overview>div{padding:11px 14px}.crypto-watch .token-head{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.crypto-watch .change{text-align:left}.crypto-watch .token-row{padding:12px 14px}.crypto-watch .metrics,.crypto-watch .news-sources,.crypto-watch .global-announcements .news-list{grid-template-columns:1fr}.crypto-watch .section-head{display:block}.crypto-watch .section-head>p{margin-top:4px}.crypto-watch .notice{padding:12px 14px}.crypto-watch .token-price{font-size:18px}}
@media print{.crypto-watch .actions,.crypto-watch .sort-bar{display:none}.crypto-watch .token-row{break-inside:avoid}.crypto-watch .instrument-details>summary{display:none}}
`;

export function cryptoWatchSection(status = {}, { sort = "24h", path = "/crypto", view = "" } = {}) {
  const report = status.latest;
  const news = status.news || report?.news;
  const watchlist = status.watchlist || report?.watchlist || {};
  const tokens = sortedTokens(Array.isArray(report?.tokens) ? report.tokens : [], sort);
  const history = Array.isArray(status.history) ? status.history : [];
  const reportStatus = report?.status || status.status || "MISSING";
  const failedAttempt = status.lastAttempt?.status === "FAILED" || (!report && reportStatus === "FAILED");
  const errors = [...(Array.isArray(status.lastAttempt?.errors) && failedAttempt ? status.lastAttempt.errors : []), ...(Array.isArray(report?.errors) ? report.errors : [])];
  const groups = [["SPOT", "现货"], ["SWAP", "永续合约"]];
  const available = tokens.filter((token) => Number.isFinite(token.price)).length;
  const instruments = Array.isArray(report?.watchlist?.instruments) ? report.watchlist.instruments : Array.isArray(watchlist.instruments) ? watchlist.instruments : [];
  const emptyFavorites = reportStatus === "OK" && Array.isArray(report?.watchlist?.instruments) && !report.watchlist.instruments.length && !tokens.length;
  return `<section class="crypto-watch" id="favorites" aria-labelledby="favorites-title">
<header class="cw-hero"><div><p class="eyebrow">收藏日报</p><h2 id="favorites-title">OKX 自选</h2><p class="lead">每天 08:00 · 北京时间<br>现货和永续分别记录；展开标的查看完整报价、指标与相关新闻。</p></div><div class="actions">${okxLink(watchlist.sourceUrl, "OKX 自选原页")}</div></header>
<div class="overview"><div><div class="eyebrow">${status.stale ? "历史日报" : "最新日报"} · ${escape(report?.date)}</div><div class="value">${statusLabel(reportStatus)}</div><small>日报生成 ${time(report?.generatedAt)} · 北京时间</small></div><div><div class="eyebrow">行情可用 / 日报名单</div><div class="value">${available} / ${instruments.length || tokens.length}</div><small>按完整交易标的计数，现货和永续不合并。</small></div><div><div class="eyebrow">收藏名单同步 · 北京时间</div><div class="value">${time(watchlist.syncedAt)}</div><small>${escape(watchlist.source || "尚未读取收藏名单")}</small></div></div>
${moversSection(tokens)}
${sortToolbar(sort, { path, view })}
${newsOverview(news)}
${news?.stale ? '<aside class="notice warning"><strong>新闻数据已过期</strong><p>以下标题保留原发布与采集时间，不代表本次更新。</p></aside>' : ""}
${status.stale ? '<aside class="notice warning"><strong>历史日报</strong><p>行情已过期，不代表当前价格。请核对下方原始行情时点。</p></aside>' : ""}
${status.status === "ERROR" ? `<aside class="notice warning"><strong>日报数据读取失败</strong><p>${escape(status.error || "无法读取已保存的日报，请检查采集记录。")}</p></aside>` : ""}
<p class="muted sync-note">收藏名单每天 07:00 随“我的资产”任务通过本机 OKX 同步；本机或登录不可用时沿用上次名单，不代表实时同步。</p>
${status.watchlistStale ? '<aside class="notice warning"><strong>收藏名单待重新同步</strong><p>当前名单仅代表上次确认的收藏快照，尚未完成新的收藏同步。</p></aside>' : ""}
${failedAttempt || reportStatus === "FAILED" ? '<aside class="notice warning"><strong>最近采集失败</strong><p>本次未取得完整的新数据；已有日报保留原时间，缺失字段显示为 —。</p></aside>' : reportStatus === "PARTIAL" ? '<aside class="notice warning"><strong>部分数据缺失</strong><p>可用信息照常展示；缺失与失败原因可在各标的采集详情中查看。</p></aside>' : ""}
${errors.length ? `<aside class="notice warning"><strong>采集记录</strong><ul>${errors.map((error) => `<li>${escape(message(error))}</li>`).join("")}</ul></aside>` : ""}
${emptyFavorites ? '<section class="empty"><h2>收藏列表为空</h2><p>本次已确认的收藏名单没有交易标的，日报已完成。</p></section>' : !report || !tokens.length ? '<section class="empty"><h2>日报尚未生成</h2><p>尚无可展示的行情汇总。下一次每日采集后将在这里显示结果。</p></section>' : groups.map(([instType, label]) => {
    const entries = tokens.filter((token) => token.instType === instType);
    return entries.length ? `<section class="group"><div class="section-head"><h2>${label} <span>${entries.length}</span></h2><p>${instType === "SPOT" ? "价格与成交额以 USDT 计" : "资金费率按下一结算周期展示，不作年化"}</p></div><div class="token-list">${entries.map((token) => `<div id="instrument-${escape(token.instId)}">${tokenRow(token, news)}</div>`).join("")}</div></section>` : "";
  }).join("")}
${news ? `<details class="platform-news"><summary>OKX 平台公告 · 单独归档</summary>${globalAnnouncements(news)}</details>` : ""}
<footer class="scope">${news ? '<p>新闻仅展示来源标题与发布时间，不据此判断情绪或解释价格变化。</p>' : '<p>新闻与项目公告尚未接入。</p>'}<p>24h 涨跌与高低价为滚动行情；7 日涨跌使用已收盘日线。— 表示未取得有效数据。</p><p>行情数据来源：OKX。日报每次采集保留各标的原始时间；此页展示市场信息，不执行交易。</p></footer>
<details class="history"><summary>近期采集记录 · ${history.length} 天</summary><div class="history-list">${history.map((entry) => `<span><time>${escape(entry.date)}</time> · ${statusLabel(entry.status)} · ${time(entry.generatedAt)}</span>`).join("") || "暂无历史记录"}</div></details>
</section>`;
}

export function cryptoWatchHtml(status = {}, options = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数字货币 · 收藏日报</title><style>${SITE_CSS}
.crypto-watch-page{max-width:1180px;margin:auto;padding:28px 20px 56px}.crypto-watch-page>h1{font-size:28px;margin:0 0 26px;letter-spacing:-.02em}@media(max-width:640px){.crypto-watch-page{padding:24px 12px 40px}}
${CRYPTO_WATCH_CSS}</style></head><body>${siteHeader("/crypto")}<main class="crypto-watch-page"><h1>数字货币</h1>${cryptoWatchSection(status, options)}</main></body></html>`;
}
