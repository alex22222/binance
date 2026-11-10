import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { SITE_CSS, siteHeader } from "./site-shell.mjs";

const escape = value => String(value ?? "—").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const number = (value, digits = 2) => Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
const percent = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%` : "—";
const points = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)} 个百分点` : "—";
const sign = value => Number.isFinite(value) ? value > 0 ? "positive" : value < 0 ? "negative" : "neutral" : "unknown";
const dateValid = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const today = now => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
const reportUrl = date => `/fund-manager?date=${encodeURIComponent(date)}&edition=daily`;

function time(value) {
  if (value == null || !Number.isFinite(Date.parse(value))) return "—";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(value)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

async function boundedRead(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > limit) throw new Error("Invalid report file");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!size || size > limit) throw new Error("Report exceeds read limit");
    return { text: buffer.subarray(0, size).toString("utf8"), modifiedAt: info.mtime.toISOString() };
  } finally { await handle.close(); }
}

function section(text, heading, limit) {
  const start = text.match(new RegExp(`^##[ \\t]+${heading}[ \\t]*$`, "m"));
  if (!start) return "";
  const body = text.slice(start.index + start[0].length).split(/^##[ \t]+/m)[0];
  const plain = body.replace(/\[([^\]\n]+)\]\([^\n)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim();
  return plain.length > limit ? `${plain.slice(0, limit).trimEnd()}…` : plain;
}

export async function loadLandingReports(directory, { now = new Date() } = {}) {
  const empty = { latest: null, history: [], error: null };
  try {
    const names = new Set();
    let count = 0;
    for await (const entry of await opendir(directory)) {
      if (++count > 4096) throw new Error("Report archive directory exceeds read limit");
      if (entry.isFile()) names.add(entry.name);
    }
    const dates = [...names].flatMap(name => {
      const match = /^(\d{4}-\d{2}-\d{2})-daily\.html$/.exec(name);
      return match && dateValid(match[1]) && match[1] <= today(now) && names.has(`${match[1]}-daily.md`) ? [match[1]] : [];
    }).sort().reverse().slice(0, 32);
    const history = [];
    let latest = null, failed = false;
    for (const date of dates) {
      if (history.length === 3) break;
      try {
        const source = await boundedRead(join(directory, `${date}-daily.md`), 64 * 1024);
        const archive = await boundedRead(join(directory, `${date}-daily.html`), 256 * 1024);
        const required = ["经理结论", "实盘回溯", "Paper", "全球动态", "美联储", "黄金", "美股", "重大事件", "风险与行动", "数据与来源"];
        if (!source.text.includes(date) || required.some(heading => !new RegExp(`^##[ \\t]+${heading}[ \\t]*$`, "m").test(source.text))
          || !/<!doctype html>/i.test(archive.text) || !/<\/html>\s*$/i.test(archive.text)) throw new Error("Incomplete archived report");
        const entry = { date, url: reportUrl(date), archivedAt: archive.modifiedAt };
        history.push(entry);
        latest ||= { ...entry, summary: section(source.text, "经理结论", 420), research: section(source.text, "市场与[ \\t]*AI[ \\t]*研究", 700) };
      } catch { failed = true; }
    }
    return { latest, history, error: failed ? "部分日报档案无法读取，已保留最近可用的正式报告。" : null };
  } catch (error) {
    return error.code === "ENOENT" ? empty : { ...empty, error: "日报档案读取失败，请稍后重试。" };
  }
}

function yahooLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    const quote = url.hostname === "finance.yahoo.com" && /^\/quote\/[A-Za-z0-9^=.%_-]+\/?$/.test(url.pathname);
    const chart = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"].includes(url.hostname) && /^\/v8\/finance\/chart\/[A-Za-z0-9^=.%_-]+$/.test(url.pathname);
    if (!quote && !chart) return "";
    url.hash = "";
    if (chart) {
      if (url.searchParams.size !== 3 || url.searchParams.get("range") !== "2y" || url.searchParams.get("interval") !== "1d" || url.searchParams.get("events") !== "div,splits") return "";
    } else url.search = "";
    return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${chart ? "原始数据" : "Yahoo"} ↗</a>`;
  } catch { return ""; }
}

function value(asset, field) {
  return !["FAILED", "MISSING"].includes(asset?.status) && Number.isFinite(asset?.[field]) ? asset[field] : null;
}

function sparkline(history, now) {
  const entries = Array.isArray(history) ? history.filter(row => Number.isFinite(Date.parse(row?.time)) && Date.parse(row.time) <= now.getTime() + 60_000 && Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-20) : [];
  if (entries.length < 2 || Date.parse(entries[0].time) === Date.parse(entries.at(-1).time)) return '<span class="chart-empty">历史不足</span>';
  const prices = entries.map(row => row.close), low = Math.min(...prices), high = Math.max(...prices);
  const first = Date.parse(entries[0].time), span = Date.parse(entries.at(-1).time) - first;
  const coordinates = entries.map(row => `${(2 + (Date.parse(row.time) - first) / span * 196).toFixed(1)},${(high === low ? 20 : 3 + (high - row.close) / (high - low) * 34).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 200 40" role="img" aria-label="最近 20 个观测点走势"><polyline points="${coordinates}" fill="none" stroke="currentColor" stroke-width="1.7" vector-effect="non-scaling-stroke"/></svg>`;
}

function tile(asset, period, now) {
  const change = value(asset, `change${period}`), price = value(asset, "price");
  const level = change === null ? 0 : Math.min(3, Math.max(1, Math.ceil(Math.abs(change) / 3)));
  const state = asset.returnsSynchronized === false ? "日线不同步" : ({ OK: "", PARTIAL: "部分缺失", CACHED: "沿用缓存", FAILED: "采集失败", MISSING: "尚未采集", STALE: "数据陈旧" })[asset.status] ?? "待核验";
  const session = ({ REGULAR: "盘中", PRE: "盘前", POST: "盘后", CLOSED: "休市", CONTINUOUS: "连续交易", UNKNOWN: "时段未知" })[asset.sessionState] || "时段未知";
  const returnDate = typeof asset.returnsAsOf === "string" && Number.isFinite(Date.parse(asset.returnsAsOf)) ? new Intl.DateTimeFormat("en-CA", {
    timeZone: asset.symbol === "BTC-USD" ? "UTC" : asset.symbol === "^VIX" ? "America/Chicago" : "America/New_York"
  }).format(new Date(asset.returnsAsOf)) : null;
  return `<article class="heat-tile ${sign(change)} level-${level}" data-asset="${escape(asset.id)}">
<div class="tile-head"><div><span class="tile-symbol">${escape(asset.symbol)}</span><h3 title="${escape(asset.label)}">${escape(asset.label)}</h3></div>${state ? `<span class="tile-state">${state}</span>` : ""}</div>
<div class="tile-numbers"><strong class="tile-return">${percent(change)}</strong><span class="tile-price">${number(price)}${price === null ? "" : asset.symbol === "^VIX" ? " 点" : " USD"}</span></div>
<div class="tile-chart">${sparkline(asset.history, now)}</div><footer><span>${session} · 可能延迟</span><details class="quote-details"><summary>时间与来源</summary><div>行情 ${time(asset.asOf)}${returnDate ? `<br>收益日线 ${returnDate}` : ""}<br>采集 ${time(asset.fetchedAt)}<br>${yahooLink(asset.sourceUrl)}</div></details></footer>
${asset.error ? `<details class="tile-error"><summary>采集说明</summary><p>${escape(asset.error)}</p></details>` : ""}</article>`;
}

function strengthSummary(assets, market, now) {
  const find = symbol => assets.find(asset => asset.symbol === symbol);
  const eligible = asset => !market.stale && !["FAILED", "ERROR", "MISSING", "STALE"].includes(market.status) && asset?.status === "OK" && !asset.stale
    && typeof asset.asOf === "string" && Number.isFinite(Date.parse(asset.asOf)) && Date.parse(asset.asOf) <= now.getTime() + 60_000;
  const observed = symbol => eligible(find(symbol)) ? value(find(symbol), "change5d") : null;
  const bond = observed("TLT"), dollar = observed("UUP"), ai = observed("AIQ"), spy = observed("SPY");
  const sessionDate = (asset, field) => Number.isFinite(Date.parse(asset[field])) ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(asset[field])) : null;
  const returnDate = asset => sessionDate(asset, Object.hasOwn(asset, "returnsAsOf") ? "returnsAsOf" : "asOf");
  const aligned = ai !== null && spy !== null && sessionDate(find("AIQ"), "asOf") === sessionDate(find("SPY"), "asOf")
    && returnDate(find("AIQ")) !== null && returnDate(find("AIQ")) === returnDate(find("SPY"));
  const relative = aligned ? ai - spy : null;
  const rows = [["长期美债", "TLT · 5 日", percent(bond), bond], ["美元", "UUP · 5 日", percent(dollar), dollar], ["AI 相对 SPY", "AIQ − SPY · 5 日", points(relative), relative]];
  return `<div class="strength-summary">${rows.map(([label, basis, result, change]) => `<div><div><span>${label}</span><small>${basis}</small></div><strong class="${sign(change)}">${result}${change === null ? " · 未核实" : ""}</strong></div>`).join("")}</div>`;
}

function modelCards(signals, stale) {
  const direction = value => ({ UP: "向上", DOWN: "向下", FLAT: "持平" })[value] || "—";
  return `<section class="model-section"><div class="section-head"><div><p class="eyebrow">02 / TREND & VOLATILITY</p><h2>CTA 趋势与波动率观察</h2></div><p>仅模型 · 使用已收盘日线</p></div><div class="model-grid">${["SPY", "QQQ", "IWM"].map(symbol => {
    const signal = Array.isArray(signals) ? signals.find(row => row?.symbol === symbol) : null;
    const outdated = signal && (stale || signal.status === "STALE");
    const available = signal?.modelOnly === true && !outdated && ["OK", "PARTIAL", "CACHED"].includes(signal.status);
    const state = outdated ? "模型数据陈旧" : signal?.status === "CACHED" ? "沿用缓存 · 仅模型" : available ? "仅模型" : "模型数据缺失";
    const cutoff = typeof signal?.asOf === "string" && Number.isFinite(Date.parse(signal.asOf)) ? `<time datetime="${escape(signal.asOf)}">日线日期 ${escape(signal.asOf.slice(0, 10))}</time>` : "日线日期 —";
    return `<article class="model-card" data-model="${symbol}"><header><h3>${symbol}</h3><span class="tag">${state}</span></header><div class="directions">${[20, 60, 200].map(days => `<div><span>${days} 日趋势</span><strong>${available ? direction(signal[`direction${days}`]) : "—"}</strong></div>`).join("")}</div><div class="model-metrics"><div><span>20 日实现波动率 · 年化</span><strong>${available ? number(signal.RV20Pct) + (Number.isFinite(signal.RV20Pct) ? "%" : "") : "—"}</strong></div><div><span>波动率目标模型敞口</span><strong>${available && Number.isFinite(signal.targetExposurePct) ? `${number(signal.targetExposurePct)}%` : "—"}</strong></div></div><p class="model-note">${available ? `${number(signal.targetVolPct, 0)}% 年化目标 · 上限 100% · ` : "等待有效收盘历史 · "}${cutoff}</p></article>`;
  }).join("")}</div><p class="model-footnote">模型敞口按目标波动率计算，不代表真实 CTA 仓位或交易指令。Gamma 真实数据未接入。</p></section>`;
}

function reportsPanel(reports, now) {
  const latest = dateValid(reports?.latest?.date) && reports.latest.date <= today(now) ? reports.latest : null;
  const history = Array.isArray(reports?.history) ? reports.history.filter(entry => dateValid(entry?.date) && entry.date <= today(now)).slice(0, 3) : [];
  return `<section class="report-section"><div class="section-head"><div><p class="eyebrow">THE DAILY BRIEF</p><h2>基金经理日报</h2></div><a class="text-link" href="/fund-manager">报告档案 ↗</a></div>
${reports?.error ? `<aside class="report-warning"><strong>日报读取暂不可用</strong><p>${escape(reports.error)}</p></aside>` : ""}
${latest ? `<article class="report-card"><div class="report-top"><span class="tag">${latest.date === today(now) ? "今日日报" : "最近日报"} · ${escape(latest.date)}</span><span>归档 ${time(latest.archivedAt)} · 北京时间</span></div><h3>经理结论</h3><p class="report-summary">${escape(latest.summary || "请在全文中查看经理结论。")}</p>${latest.research ? `<details class="report-research"><summary>市场与 AI 研究摘要</summary><p>${escape(latest.research)}</p></details>` : ""}<a class="report-button" href="${escape(reportUrl(latest.date))}">阅读完整日报 <span aria-hidden="true">↗</span></a></article>` : '<div class="report-empty"><h3>日报尚未生成</h3><p>正式日报归档后，下一次页面刷新会自动显示。</p></div>'}
${history.length ? `<nav class="report-history" aria-label="最近三期日报"><span>近期归档</span>${history.map(entry => `<a href="${escape(reportUrl(entry.date))}">${escape(entry.date)}</a>`).join("")}</nav>` : ""}</section>`;
}

export function marketOverviewHtml({ market = {}, reports = {}, period = "5d", now = new Date() } = {}) {
  const selected = ["1d", "5d", "20d"].includes(period) ? period : "5d";
  const assets = Array.isArray(market.assets) ? market.assets.filter(asset => asset && typeof asset === "object") : [];
  const groups = [["跨资产", ["bonds", "currency", "commodities", "crypto"]], ["美股与 AI", ["equity", "ai", "sector"]], ["风险温度", ["risk"]]];
  const failed = market.status === "FAILED" || market.lastAttempt?.status === "FAILED";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="300"><title>资本市场温度 · HQ Capital</title>
<style>${SITE_CSS}
:root{--site-width:1380px}*{box-sizing:border-box}body{font-size:14px;line-height:1.65}main{max-width:1380px;margin:auto;padding:36px 24px 64px}h1,h2,h3,p{margin:0}a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,summary:focus-visible{outline:2px solid var(--brand);outline-offset:4px}.eyebrow{color:var(--brand);font-size:10px;letter-spacing:.16em;font-weight:750;margin-bottom:7px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;margin-bottom:28px}.hero h1{font-size:36px;line-height:1.2;letter-spacing:-.045em;font-weight:730}.lead{color:var(--muted);margin-top:12px;font-size:14px}.updated{text-align:right;color:var(--muted);font-size:11px;line-height:1.8;white-space:nowrap}.updated strong{display:block;color:var(--text);font:12px var(--font-num)}.strength-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);border-radius:12px;background:var(--surface);margin-bottom:26px}.strength-summary>div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;min-width:0}.strength-summary>div+div{border-left:1px solid var(--line)}.strength-summary span{font-size:12px;font-weight:650}.strength-summary small{display:block;font-size:10px;color:var(--muted);margin-top:2px}.strength-summary strong{font:16px var(--font-num);white-space:nowrap}.positive{color:var(--green)}.negative{color:var(--red)}.neutral,.unknown{color:var(--muted)}.market-section,.model-section,.report-section{margin-top:30px}.section-head{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:15px}.section-head h2{font-size:19px;letter-spacing:-.02em}.section-head>p{color:var(--muted);font-size:11px}.periods{display:flex;gap:3px;padding:3px;border:1px solid var(--line);border-radius:9px;background:var(--surface)}.periods a{padding:6px 13px;border-radius:6px;color:var(--muted);font-size:12px}.periods a[aria-current]{color:var(--brand);background:var(--brand-soft);font-weight:700}.scope-note{font-size:12px;color:var(--muted);margin-bottom:18px}.scope-note strong{color:var(--text);font-weight:550}.market-group+.market-group{margin-top:22px}.group-head{display:flex;gap:8px;align-items:center;margin-bottom:10px}.group-head h3{font-size:13px;font-weight:650}.group-head span{font:10px var(--font-num);color:var(--muted)}.heat-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}.heat-tile{min-width:0;min-height:201px;padding:14px 14px 11px;border:1px solid var(--line);border-radius:11px;background:var(--surface);display:flex;flex-direction:column;overflow-wrap:anywhere;box-shadow:0 1px 1px rgba(23,23,33,.02)}.heat-tile.positive{background:#f1faf5;border-color:#d9eee1}.heat-tile.positive.level-2{background:#e7f6ed;border-color:#c8e5d4}.heat-tile.positive.level-3{background:#dcf0e5;border-color:#b6ddc7}.heat-tile.negative{background:#fff4f4;border-color:#f3dddd}.heat-tile.negative.level-2{background:#fdebeb;border-color:#efcece}.heat-tile.negative.level-3{background:#f9e1e2;border-color:#e9bfc3}.tile-head{display:flex;align-items:flex-start;justify-content:space-between;gap:5px}.tile-symbol{font:11px var(--font-num);font-weight:700;color:var(--text)}.tile-head h3{max-width:150px;font-size:11px;color:var(--muted);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.tile-state{font-size:9px;color:var(--gold);white-space:nowrap}.tile-numbers{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-top:15px}.tile-return{font:23px var(--font-num);font-weight:650;letter-spacing:-.04em}.tile-price{font:10px var(--font-num);color:var(--muted);text-align:right}.tile-chart{height:40px;margin:10px 0 7px;display:flex;align-items:center}.tile-chart svg{display:block;width:100%;height:40px}.chart-empty{font-size:10px;color:var(--faint)}.heat-tile footer{display:flex;justify-content:space-between;align-items:flex-end;gap:6px;font-size:9px;line-height:1.65;color:var(--muted);margin-top:auto}.heat-tile footer a{white-space:nowrap;font-size:9px}.tile-error{font-size:10px;color:var(--gold);padding-top:6px}.tile-error summary{cursor:pointer}.tile-error p{margin-top:5px}.notice,.report-warning{padding:12px 16px;border:1px solid rgba(183,121,31,.25);background:var(--gold-soft);border-radius:9px;margin:10px 0;font-size:12px;color:var(--gold)}.notice p{margin-top:2px}.market-empty,.report-empty{padding:28px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--muted)}.market-empty h3,.report-empty h3{font-size:15px;color:var(--text)}.market-empty p,.report-empty p{font-size:12px;margin-top:6px}.model-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.model-card{min-width:0;padding:19px 20px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.model-card header,.report-top{display:flex;align-items:center;justify-content:space-between;gap:12px}.model-card h3{font:16px var(--font-num);font-weight:700}.tag{font-size:10px;padding:3px 8px;border-radius:5px;color:var(--muted);background:var(--surface-2)}.directions{display:flex;gap:18px;margin:19px 0}.directions>div{display:flex;flex-direction:column;gap:4px}.directions span,.model-metrics span{font-size:10px;color:var(--muted)}.directions strong{font-size:12px;font-weight:550}.model-metrics{padding-top:12px;border-top:1px solid var(--line-soft)}.model-metrics>div{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:6px}.model-metrics strong{font:14px var(--font-num)}.model-note{font-size:9px;color:var(--muted);margin-top:12px}.model-footnote{font-size:11px;color:var(--muted);margin-top:11px}.report-section{padding-top:28px;border-top:1px solid var(--line);margin-top:32px}.text-link{font-size:12px}.report-card{border:1px solid var(--line);border-radius:13px;background:var(--surface);padding:25px 28px}.report-top>span:last-child{font-size:10px;color:var(--muted)}.report-card h3{font-size:16px;margin:20px 0 10px}.report-summary,.report-research p{white-space:pre-line;font-size:13px;line-height:1.9;max-width:90ch;overflow-wrap:anywhere}.report-research{margin-top:16px}.report-research summary{font-size:12px;cursor:pointer;color:var(--muted)}.report-research p{margin-top:10px;color:var(--muted)}.report-button{display:inline-flex;gap:24px;align-items:center;border-radius:8px;padding:10px 14px;margin-top:20px;background:var(--brand);color:var(--brand-ink);font-size:12px;font-weight:650}.report-button:hover{background:var(--brand-strong);text-decoration:none}.report-history{display:flex;gap:15px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin-top:13px}.source-details{margin-top:30px;border-top:1px solid var(--line);padding-top:15px;font-size:11px;color:var(--muted)}.source-details summary{cursor:pointer}.source-details p{margin-top:8px;max-width:110ch}
.tile-head>div{min-width:0}.tile-head h3{max-width:100%}
@media(max-width:1120px){.heat-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.strength-summary strong{font-size:14px}.strength-summary>div{padding:14px}.hero h1{font-size:32px}}
@media(max-width:760px){main{padding:28px 16px 45px}.hero{display:block}.updated{text-align:left;margin-top:14px}.updated strong{display:inline}.strength-summary{grid-template-columns:1fr}.strength-summary>div+div{border-left:0;border-top:1px solid var(--line)}.model-grid{grid-template-columns:1fr}.section-head{align-items:flex-start}.report-top{align-items:flex-start;flex-direction:column}.report-card{padding:21px}.model-card{padding:17px 20px}}
@media(max-width:640px){main{padding-inline:12px}.hero h1{font-size:30px}.heat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.heat-tile{padding:13px;min-height:206px}.section-head h2{font-size:17px}.periods a{padding:6px 10px}.tile-return{font-size:24px}.tile-numbers{align-items:flex-start;flex-direction:column;gap:3px}.tile-head h3{max-width:110px}.report-card{padding:19px}.model-footnote{font-size:10px}}
@media print{.periods,.source-details,.report-button{display:none}.heat-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.heat-tile,.model-card,.report-card{break-inside:avoid;box-shadow:none}}

/* Market overview: editorial hierarchy, compact heatmap, daily letter rail. */
body{background:#f4f5f9}main{max-width:1480px;padding:24px 28px 64px}.market-masthead{position:relative;isolation:isolate;overflow:hidden;padding:30px 34px 0;border-radius:20px;color:#f4f6ff;background:#17233e;background-image:radial-gradient(ellipse at 90% 0%,rgba(102,129,255,.2),transparent 55%);box-shadow:0 12px 30px rgba(23,35,62,.08)}.market-masthead:before{content:"";position:absolute;z-index:-1;inset:0;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(90deg,transparent,#000)}.hero{margin-bottom:28px}.hero h1{font-size:38px;letter-spacing:-.04em}.hero h1 span{font-weight:400;color:#b7c5fb;margin-left:8px}.market-masthead .eyebrow{color:#b6c6ff;letter-spacing:.2em}.market-masthead .lead{color:#c1cadc;font-size:13px}.market-masthead .updated{color:#bec8df}.market-masthead .updated strong{color:#fff;font-size:13px}.strength-summary{border:0;border-top:1px solid #3a455f;background:transparent;border-radius:0;margin-bottom:0;gap:0}.strength-summary>div{display:block;padding:20px 24px 23px}.strength-summary>div:first-child{padding-left:0}.strength-summary>div+div{border-color:#3a455f}.strength-summary>div>div{display:flex;align-items:center;justify-content:space-between;gap:12px}.strength-summary span{color:#e0e6f7;font-size:12px}.strength-summary small{color:#aebbd6;font:10px var(--font-num);margin:0}.strength-summary strong{display:block;font-size:29px;margin-top:10px;letter-spacing:-.04em}.market-masthead .positive{color:#87dfc0}.market-masthead .negative{color:#ffa8b0}.market-masthead .unknown,.market-masthead .neutral{color:#c1cadc}.market-masthead .notice{background:#3b3540;border-color:#6a5260;color:#ffe0be}.overview-layout{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:28px;align-items:start}.market-main{min-width:0}.market-sidebar{position:sticky;top:20px;min-width:0}.market-section,.model-section{margin-top:30px}.section-head{margin-bottom:14px}.section-head .eyebrow{color:#747d92;font-size:9px;letter-spacing:.14em;margin-bottom:5px}.section-head h2{font-size:21px}.scope-note{font-size:10px;line-height:1.8}.scope-note strong{font-weight:500}.periods{box-shadow:0 2px 5px rgba(20,30,60,.03)}.periods a{min-height:32px;display:flex;align-items:center}.heat-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.group-head{margin:16px 0 10px}.group-head h3{font-size:12px}.group-head span{border:1px solid var(--line);border-radius:20px;padding:0 6px;background:#fff}.group-head:after{content:"";height:1px;flex:1;background:var(--line);margin-left:4px}.heat-tile{min-height:180px;padding:16px 14px 11px;border-radius:12px;box-shadow:none;transition:border-color .18s,box-shadow .18s}.heat-tile:hover{border-color:#a3b4c8;box-shadow:0 5px 14px rgba(30,45,70,.06)}.heat-tile.positive{color:#187650;background:#edf7f1;border-color:#d8eade}.heat-tile.positive.level-2{background:#dcefe4;border-color:#c2dfcd}.heat-tile.positive.level-3{background:#c9e5d6;border-color:#a9d0bb}.heat-tile.negative{color:#b23348;background:#fcf0f0;border-color:#efdddd}.heat-tile.negative.level-2{background:#f7dfe1;border-color:#eac8ce}.heat-tile.negative.level-3{background:#efcdd2;border-color:#deb3bd}.tile-symbol{font-size:12px;letter-spacing:.02em}.tile-head h3{color:#566174}.tile-numbers{display:block;margin-top:13px}.tile-return{font-size:28px;line-height:1.15}.tile-price{display:block;margin-top:4px;font-size:10px;text-align:left;color:#566174}.tile-chart{height:33px;margin:10px 0}.tile-chart svg{height:33px}.heat-tile footer{font-size:9px;color:#566174;align-items:flex-start;flex-wrap:wrap}.quote-details{margin-left:auto;text-align:right;max-width:100%;font-size:9px}.quote-details summary{cursor:pointer;min-height:24px;display:list-item}.quote-details>div{text-align:left;padding-top:6px;line-height:1.8}.quote-details[open]{flex-basis:100%}.tile-state{white-space:normal;text-align:right;max-width:55px}.model-grid{gap:10px}.model-card{padding:16px 14px;border-radius:12px}.model-card h3{font-size:15px}.model-card .tag{padding:2px 5px;font-size:9px}.directions{justify-content:space-between;gap:6px;margin:16px 0}.model-metrics>div{display:block;margin-top:8px}.model-metrics strong{display:block;margin-top:2px}.model-metrics span{font-size:9px}.model-note{line-height:1.8}.report-section{border:0;padding:0;margin-top:30px}.report-section>.section-head{align-items:flex-end}.report-section .eyebrow{color:#747d92;font-size:9px;letter-spacing:.14em}.report-section h2{font-size:19px}.report-section .text-link{font-size:10px;white-space:nowrap}.report-card{padding:23px 22px;border-radius:14px;border-top:3px solid #5266eb;box-shadow:0 4px 18px rgba(30,40,70,.035)}.report-top{display:block}.report-top>span:last-child{display:block;line-height:1.8;font-size:9px;margin-top:12px}.report-top .tag{background:#edf0fe;color:#465bc3;padding:5px 8px}.report-card h3{font-size:14px;margin-top:22px}.report-summary{font-size:12px;line-height:1.95;color:#4c566e}.report-button{display:flex;justify-content:space-between;margin-top:24px;min-height:42px}.report-research summary{font-size:11px;padding-block:6px}.report-research p{font-size:11px}.report-history{gap:10px;font-size:10px;padding:12px 2px}.report-history>span{flex-basis:100%;font-size:9px;letter-spacing:.06em}.source-details{margin-top:28px;color:#667085}.source-details summary{padding:8px 0}.notice{overflow-wrap:anywhere}
@media(min-width:1600px){.overview-layout{grid-template-columns:minmax(0,1fr) 340px}.heat-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
@media(max-width:1120px){.overview-layout{grid-template-columns:minmax(0,1fr) 280px;gap:20px}.heat-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.market-masthead{padding:26px 26px 0}.strength-summary strong{font-size:25px}}
@media(max-width:900px){.overview-layout{grid-template-columns:1fr}.market-sidebar{position:static}.heat-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.report-card{max-width:none}}
@media(max-width:760px){main{padding:20px 16px 45px}.market-masthead{padding:24px 22px 0;border-radius:16px}.hero h1{font-size:32px}.hero{margin-bottom:22px}.strength-summary{grid-template-columns:repeat(3,minmax(0,1fr))}.strength-summary>div{padding:16px 10px}.strength-summary>div+div{border-top:0;border-left:1px solid #3a455f}.strength-summary>div>div{display:block}.strength-summary small{margin-top:4px;font-size:9px}.strength-summary strong{font-size:21px}.heat-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.model-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:640px){main{padding:14px 12px 40px}.market-masthead{padding:22px 18px 0}.hero h1{font-size:29px}.hero h1 span{margin-left:5px}.lead{max-width:28ch}.strength-summary{grid-template-columns:1fr}.strength-summary>div{padding:13px 0;display:flex;align-items:center;justify-content:space-between;gap:8px}.strength-summary>div+div{border-left:0;border-top:1px solid #3a455f}.strength-summary>div>div{display:block}.strength-summary strong{font-size:23px;margin:0}.strength-summary small{font-size:10px}.heat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.heat-tile{min-height:177px;padding:14px 12px 9px}.tile-return{font-size:27px}.tile-head h3{max-width:100%}.section-head{gap:8px;align-items:center}.section-head h2{font-size:19px}.periods a{padding:7px 9px;min-height:36px}.scope-note{font-size:10px}.model-grid{grid-template-columns:1fr}.model-metrics>div{display:flex}.directions{justify-content:flex-start;gap:30px}.report-card{padding:22px}.model-metrics strong{margin:0}.market-section,.model-section{margin-top:24px}}
@media(max-width:640px){.market-masthead .updated{white-space:normal;line-height:1.9}.market-masthead .updated strong{display:block}.quote-details summary{min-height:44px;display:flex;align-items:center;justify-content:flex-end}}
@media(prefers-reduced-motion:reduce){.heat-tile{transition:none}}
</style></head><body>${siteHeader("/market")}<main>
<div class="market-masthead"><header class="hero"><div><p class="eyebrow">MARKET PULSE</p><h1>资本市场<span>温度</span></h1><p class="lead">从跨资产到美股与 AI，用价格与趋势观察市场强弱。</p></div><div class="updated">最近采集 · 北京时间<strong>${time(market.generatedAt)}</strong><span>公开行情可能延迟 · 每 15 分钟采集<br>页面每 5 分钟刷新</span></div></header>
${market.status === "ERROR" ? `<aside class="notice"><strong>行情读取暂不可用</strong><p>${escape(market.error || "等待下一次有效更新。")}</p></aside>` : ""}
${failed ? '<aside class="notice"><strong>最近采集失败</strong><p>保留的报价与走势沿用原始时间，请核对各标的状态。</p></aside>' : market.status === "PARTIAL" ? '<aside class="notice"><strong>部分数据未更新</strong><p>可用标的照常展示，失败或缓存状态逐项标注。</p></aside>' : ""}
${assets.length && (market.stale || market.status === "STALE") ? '<aside class="notice"><strong>行情已陈旧</strong><p>这些数据保留原行情时点，不代表当前可交易价格。</p></aside>' : ""}
${strengthSummary(assets, market, now)}</div><div class="overview-layout"><div class="market-main">
<section class="market-section"><div class="section-head"><div><p class="eyebrow">01 / ASSET PERFORMANCE</p><h2>市场热力</h2></div><nav class="periods" aria-label="收益观察区间">${[["1d", "1 日"], ["5d", "5 日"], ["20d", "20 日"]].map(([key, label]) => `<a href="?period=${key}"${selected === key ? ' aria-current="true"' : ""}>${label}</a>`).join("")}</nav></div><p class="scope-note"><strong>收益强弱代理，不代表真实资金净流入/净流出。</strong> 等面积卡片，颜色表示所选区间收益；绿涨红跌。</p>
${assets.length ? groups.map(([label, members]) => {
    const rows = assets.filter(asset => members.includes(asset.group));
    return rows.length ? `<section class="market-group"><div class="group-head"><h3>${label}</h3><span>${rows.length}</span></div><div class="heat-grid">${rows.map(asset => tile(asset, selected, now)).join("")}</div></section>` : "";
  }).join("") : '<div class="market-empty"><h3>行情尚未生成</h3><p>等待公共行情采集；缺失字段显示为 —，不会当作零收益。</p></div>'}</section>
${modelCards(market.signals, market.stale)}</div><aside class="market-sidebar" aria-label="基金经理日报">${reportsPanel(reports, now)}</aside></div>
<details class="source-details"><summary>来源与指标口径</summary><p>价格为 Yahoo Finance 公共报价，可能延迟；每个标的保留真实行情时点与采集时间。ETF 为复权收益，含分红等复权影响；非实际净申赎。BTC 按 UTC 自然日，美股按交易日；波动率指数 VIX 以点数计，不作为资金流入资产。</p><p>小图展示最近 20 个有效观测点。趋势与 20 日实现波动率仅使用已收盘日线，波动率目标模型没有方向开关；模型敞口不等于真实仓位。基金经理日报读取现有正式归档，新日报发布后会在下一次页面读取时出现。</p></details>
</main></body></html>`;
}
