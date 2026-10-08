import { SITE_CSS, siteHeader } from "./site-shell.mjs";

// Review page: what the account did over a period, why the active strategy
// holds what it holds, every completed live trade, and what went wrong in
// execution. Data comes from /api/review (src/trade-review-overview.mjs).
export function tradeReviewHtml({ nonce = "" } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>交易复盘 · Agentic Wallet</title>
<style>
${SITE_CSS}
:root{--site-width:1180px}
*{box-sizing:border-box}
body{font-size:14px;line-height:1.6;padding-bottom:env(safe-area-inset-bottom,0px)}
.wrap{max-width:1180px;margin:0 auto;padding:20px 16px 48px;display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.top-left{display:grid;gap:2px}
h1{font-size:22px;font-weight:900;margin:0}
h2{font-size:13px;font-weight:700;margin:0;color:var(--muted);letter-spacing:.08em}
h3{font-size:14px;margin:16px 0 8px}
.stamp,.note{color:var(--muted);font-size:12px}
.note{margin:8px 0 0}
.tabs{display:inline-flex;gap:4px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
.tabs button{border:0;background:none;color:var(--muted);padding:6px 14px;border-radius:7px;font:inherit;font-weight:650;cursor:pointer}
.tabs button[aria-pressed="true"]{background:var(--brand-soft);color:var(--brand)}
.tabs button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow);min-width:0;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-content:start}
.panel-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px}
.findings{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.findings li{display:grid;grid-template-columns:10px minmax(0,1fr);gap:10px;font-size:15px}
.dot{width:8px;height:8px;border-radius:50%;margin-top:9px;background:var(--muted)}
.dot.good{background:var(--green)} .dot.bad{background:var(--red)}
.two{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px}
@media (max-width:860px){.two{grid-template-columns:minmax(0,1fr)}}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px}
.kpi{border-top:1px solid var(--line);padding-top:8px;min-width:0}
.kpi span{display:block;font-size:12px;color:var(--muted)}
.kpi strong{display:block;font-family:var(--font-num);font-size:17px;font-weight:600}
.kpi small{display:block;color:var(--muted);font-size:12px}
.up{color:var(--green)} .down{color:var(--red)}
.chart svg{width:100%;height:auto;display:block}
.chart text{fill:var(--muted);font-family:var(--font-num);font-size:11px}
.position{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;grid-template-columns:minmax(0,1fr);gap:10px}
.position-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.position-head b{font-size:18px}
.badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700;background:var(--surface-2);color:var(--muted)}
.badge.good{background:var(--green-soft);color:var(--green)} .badge.bad{background:var(--red-soft);color:var(--red)} .badge.brand{background:var(--brand-soft);color:var(--brand)}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12px}
td.num,th.num{text-align:right;font-family:var(--font-num)}
tr.picked td{background:var(--brand-soft)}
.empty{color:var(--muted);padding:6px 0}
.incidents{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.incidents li{display:grid;grid-template-columns:90px minmax(0,1fr);gap:10px;font-size:13px}
.incidents .when{color:var(--muted);font-family:var(--font-num)}
.incidents .what{min-width:0;overflow-wrap:anywhere}
.history{display:flex;flex-wrap:wrap;gap:6px}
</style>
</head>
<body>
${siteHeader("/reviews")}
<main class="wrap">
  <header class="top">
    <div class="top-left">
      <h1>交易复盘</h1>
      <div class="stamp" id="stamp" role="status">正在读取…</div>
    </div>
    <div class="tabs" role="group" aria-label="复盘周期">
      <button type="button" data-period="7d" aria-pressed="false">近 7 天</button>
      <button type="button" data-period="30d" aria-pressed="true">近 30 天</button>
      <button type="button" data-period="all" aria-pressed="false">全部</button>
    </div>
  </header>

  <section class="panel" aria-labelledby="findingsTitle">
    <h2 id="findingsTitle">本期结论</h2>
    <ul class="findings" id="findings"></ul>
  </section>

  <section class="two">
    <div class="panel" aria-labelledby="accountTitle">
      <div class="panel-head"><h2 id="accountTitle">账户净值</h2><span class="stamp" id="accountStamp"></span></div>
      <div class="kpis" id="accountKpis"></div>
      <div class="chart" id="equityChart"></div>
    </div>
    <div class="panel" aria-labelledby="positionsTitle">
      <h2 id="positionsTitle">当前持仓</h2>
      <div id="positions"></div>
    </div>
  </section>

  <section class="panel" aria-labelledby="decisionTitle">
    <div class="panel-head"><h2 id="decisionTitle">策略决策</h2><span class="stamp" id="decisionStamp"></span></div>
    <div id="decision"></div>
  </section>

  <section class="panel" aria-labelledby="tradesTitle">
    <h2 id="tradesTitle">交易记录</h2>
    <div id="strategySummary"></div>
    <div id="trades"></div>
  </section>

  <section class="two">
    <div class="panel" aria-labelledby="executionTitle">
      <h2 id="executionTitle">执行与运行</h2>
      <div id="execution"></div>
    </div>
    <div class="panel" aria-labelledby="premarketTitle">
      <h2 id="premarketTitle">盘前环境（最近一次）</h2>
      <div id="premarket"></div>
    </div>
  </section>

  <p class="note" id="sourceNote">数据来自完整交易日志、钱包每日余额与机器人状态。浮动盈亏按最新卖出报价估算，未扣卖出 gas。复盘不构成投资建议。</p>
</main>
<script nonce="${nonce}">
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const isNum = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const num = (v, d = 2) => isNum(v) ? Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";
const signed = (v, d = 2) => isNum(v) ? (Number(v) > 0 ? "+" : "") + num(v, d) : "—";
const tone = v => isNum(v) ? (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "") : "";
const day = iso => iso ? String(iso).slice(0, 10) : "—";
const when = iso => iso ? new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const held = h => !isNum(h) ? "—" : h < 24 ? Math.max(1, Math.round(h)) + " 小时" : (h / 24).toFixed(1) + " 天";
const kpi = (label, value, cls = "", hint = "") => '<div class="kpi"><span>' + esc(label) + '</span><strong class="' + cls + '">' + value + '</strong>' + (hint ? '<small>' + esc(hint) + '</small>' : "") + "</div>";
const table = (head, rows, numeric = []) => '<div class="table-wrap"><table><thead><tr>' + head.map((h, i) => '<th class="' + (numeric.includes(i) ? "num" : "") + '">' + esc(h) + "</th>").join("") + "</tr></thead><tbody>"
  + rows.map(r => '<tr class="' + (r.picked ? "picked" : "") + '">' + r.cells.map((c, i) => '<td class="' + (numeric.includes(i) ? "num " : "") + (c.cls || "") + '">' + (c.html ?? esc(c)) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
let period = new URLSearchParams(location.search).get("period");
if (!["7d", "30d", "all"].includes(period)) period = "30d";

function renderFindings(items) {
  $("findings").innerHTML = (items || []).map(f => '<li><span class="dot ' + esc(f.tone) + '"></span><span>' + esc(f.text) + "</span></li>").join("") || '<li class="empty">暂无结论。</li>';
}

function chart(series, marks) {
  if (!series || series.length < 2) return '<div class="empty">至少需要两天的余额记录才能画出走势。</div>';
  const W = 720, H = 220, L = 12, R = 60, T = 14, B = 26, n = series.length;
  const values = series.map(p => p.totalUsd), min = Math.min(...values), max = Math.max(...values), pad = Math.max((max - min) * 0.12, 0.5);
  const lo = min - pad, hi = max + pad;
  const x = i => L + (W - L - R) * i / (n - 1), y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  // A trade on a day without a balance point sits on the latest earlier point.
  const pointFor = date => { let found = -1; for (let i = 0; i < n && series[i].date <= date; i += 1) found = i; return found; };
  let s = '<polyline points="' + series.map((p, i) => x(i).toFixed(1) + "," + y(p.totalUsd).toFixed(1)).join(" ") + '" fill="none" stroke="var(--brand)" stroke-width="2.2"/>';
  for (const v of [hi - pad, (hi + lo) / 2, lo + pad]) s += '<text x="' + (W - R + 6) + '" y="' + (y(v) + 4).toFixed(1) + '">' + num(v, 1) + "</text>";
  for (const m of marks) {
    const i = pointFor(m.date);
    if (i < 0) continue;
    s += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(series[i].totalUsd).toFixed(1) + '" r="4.5" fill="' + m.color + '" stroke="var(--surface)" stroke-width="1.5"><title>' + esc(m.title) + "</title></circle>";
  }
  s += '<text x="' + L + '" y="' + (H - 6) + '">' + esc(series[0].date) + '</text><text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + esc(series[n - 1].date) + "</text>";
  return '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="账户净值走势">' + s + '</svg><p class="note">金色线是每日钱包总值；绿点是买入，红点和绿点分别是亏损和盈利的卖出。</p>';
}

function renderAccount(a, d) {
  if (!a) { $("accountKpis").innerHTML = '<div class="empty">还没有钱包余额记录。</div>'; $("equityChart").innerHTML = ""; return; }
  $("accountStamp").textContent = "钱包检查 " + when(a.checkedAt);
  $("accountKpis").innerHTML = kpi("当前净值", num(a.end.totalUsd) + " U")
    + kpi(d.period.days ? d.period.label + "变化" : "累计变化", signed(a.changeUsd) + " U", tone(a.changeUsd), signed(a.changePct) + "%")
    + kpi("期间最大回撤", num(a.maxDrawdownPct) + "%", a.maxDrawdownPct > 0 ? "down" : "")
    + kpi("可用 USDT", num(a.availableUsdt) + " U", "", "其余在持仓中");
  const marks = [
    ...(d.entries || []).map(e => ({ date: day(e.timestamp), color: "var(--green)", title: day(e.timestamp) + " 买入 " + e.symbol })),
    ...(d.trades || []).map(t => ({ date: day(t.exitAt), color: t.realizedPnlUsdt > 0 ? "var(--green)" : "var(--red)", title: day(t.exitAt) + " 卖出 " + t.symbol + " " + signed(t.realizedPnlUsdt) + " U" }))
  ];
  $("equityChart").innerHTML = chart(a.series, marks);
}

function renderPositions(list) {
  if (!list || !list.length) { $("positions").innerHTML = '<div class="empty">目前没有持仓。</div>'; return; }
  $("positions").innerHTML = list.map(p => '<div class="position"><div class="position-head"><b>' + esc(p.symbol) + '</b><span class="badge brand">' + esc(p.strategyName) + '</span><span class="badge ' + (p.unrealizedPnlUsdt >= 0 ? "good" : "bad") + '">' + signed(p.returnPct) + "%</span></div>"
    + '<div class="kpis">' + kpi("开仓", esc(day(p.openedAt)), "", isNum(p.daysHeld) ? "已持有 " + p.daysHeld + " 天" : "")
    + kpi("成本 → 估值", num(p.costBasisUsdt) + " → " + num(p.valueUsdt))
    + kpi("浮动盈亏", signed(p.unrealizedPnlUsdt) + " U", tone(p.unrealizedPnlUsdt))
    + kpi("持有期间最高 / 最低", signed(p.peakReturnPct) + "% / " + signed(p.worstReturnPct) + "%") + "</div>"
    + '<p class="note">退出规则：' + esc(p.exitRule) + "</p>"
    + '<p class="note">估值：' + esc(when(p.markedAt)) + " 的卖出报价</p></div>").join("");
}

function renderDecision(d) {
  const box = $("decision");
  if (!d || !d.latest) { box.innerHTML = '<div class="empty">没有周度策略的决策记录。</div>'; $("decisionStamp").textContent = ""; return; }
  const l = d.latest;
  $("decisionTitle").textContent = "策略决策 · " + l.strategyName;
  $("decisionStamp").textContent = "评估于 " + when(l.evaluatedAt);
  const rows = l.assets.map(a => ({ picked: a.ticker === l.target, cells: [a.ticker, { html: '<span class="' + tone(a.momentumPct) + '">' + signed(a.momentumPct) + "%</span>" }, num(a.rsi, 1), a.eligible ? "合格" : "不合格", a.ticker === l.target ? "本周目标" : ""] }));
  if (l.defensive) rows.push({ picked: l.target === l.defensive.ticker, cells: [l.defensive.ticker + "（防守）", { html: '<span class="' + tone(l.defensive.momentumPct) + '">' + signed(l.defensive.momentumPct) + "%</span>" }, "—", l.defensive.eligible ? "可用" : "不可用", l.target === l.defensive.ticker ? "本周目标" : ""] });
  box.innerHTML = '<p>' + esc(l.week) + " 这周（信号日 " + esc(l.signalDate) + "）的目标是 <b>" + esc(l.target === "CASH" ? "现金" : l.target) + "</b>。</p>"
    + table(["ETF", "20 日涨幅", "RSI(14)", "资格", ""], rows, [1, 2])
    + '<p class="note">规则：每只风险 ETF 看 20 日涨幅和 RSI(14)，RSI 不低于 40 且 20 日涨幅为正才合格，在合格的里选涨幅最高的；都不合格时，防守资产 20 日为正就转入防守资产，否则转为现金。每周第一个交易日开盘后评估一次，下次约在 ' + esc(d.nextEvaluation) + "。</p>"
    + (d.history && d.history.length ? '<h3>近几周的选择</h3><div class="history">' + d.history.map(h => '<span class="badge">' + esc(h.week) + " · " + esc(h.target === "CASH" ? "现金" : h.target) + "</span>").join("") + "</div>" : "");
}

function renderTrades(d) {
  const all = d.strategies.all || [];
  $("strategySummary").innerHTML = all.length
    ? '<h3>按策略汇总（全部记录）</h3>' + table(["策略", "期间", "笔数", "胜率", "已实现", "盈利因子", "平均赚 / 亏", "主要退出原因"], all.map(s => ({ cells: [s.name, day(s.from) + " ~ " + day(s.to), String(s.trades), num(s.winRatePct, 1) + "%", { html: '<span class="' + tone(s.realizedPnlUsdt) + '">' + signed(s.realizedPnlUsdt) + " U</span>" }, num(s.profitFactor), signed(s.averageWinUsdt) + " / " + signed(s.averageLossUsdt), Object.entries(s.exitReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v).join("、")] })), [2, 3, 4, 5])
    : '<div class="empty">还没有完成的实盘交易。</div>';
  const trades = d.trades || [];
  $("trades").innerHTML = '<h3>' + esc(d.period.label) + "完成的交易（" + trades.length + " 笔）</h3>" + (trades.length
    ? table(["卖出时间", "标的", "策略", "持有", "成本", "已实现", "收益率", "退出原因"], trades.map(t => ({ cells: [when(t.exitAt), t.symbol, t.strategyName, held(t.holdingHours), num(t.costUsdt), { html: '<span class="' + tone(t.realizedPnlUsdt) + '">' + signed(t.realizedPnlUsdt) + "</span>" }, { html: '<span class="' + tone(t.returnPct) + '">' + signed(t.returnPct) + "%</span>" }, t.exitReasonLabel] })), [4, 5, 6])
    : '<div class="empty">这段时间没有平仓。周度策略通常数周才换一次仓。</div>');
}

function renderExecution(e, p) {
  const changes = (e.autoApprovalChanges || []).map(c => when(c.at) + (c.enabled ? " 开启" : " 关闭") + "自动审批");
  $("execution").innerHTML = '<div class="kpis">' + kpi("成交", e.fills + " 笔") + kpi("Gas", num(e.gasUsdt, 3) + " U") + kpi("自动审批", e.autoApproved + " 次", "", e.approved > e.autoApproved ? "人工 " + (e.approved - e.autoApproved) + " 次" : "")
    + kpi("休市报价失败", e.closedMarketQuotes + " 次", "", e.closedMarketDays + " 天，属正常") + "</div>"
    + (e.incidents.length
      ? '<h3>需要注意（' + e.incidents.length + "）</h3><ul class=\\"incidents\\">" + e.incidents.map(i => '<li><span class="when">' + esc(when(i.at)) + '</span><span class="what"><b>' + esc(i.kind) + "</b>" + (i.symbol ? " · " + esc(i.symbol) : "") + "<br>" + esc(i.detail) + "</span></li>").join("") + "</ul>"
      : '<p class="empty">' + esc(p.label) + "没有执行故障。</p>")
    + (changes.length ? '<p class="note">' + esc(changes.join("；")) + "</p>" : "");
}

function renderPremarket(m) {
  if (!m) { $("premarket").innerHTML = '<div class="empty">暂无盘前简报。</div>'; return; }
  const level = { DEFENSIVE: ["防守", "bad"], SELECTIVE_LONG: ["选择性做多", "brand"], RISK_ON: ["积极", "good"] }[m.level] || [m.level || "未知", ""];
  $("premarket").innerHTML = '<div class="position-head"><span class="badge ' + level[1] + '">' + esc(level[0]) + '</span><span class="stamp">' + esc(m.tradingDate) + " 美股盘前</span></div>"
    + "<p>" + esc(m.summary) + "</p>"
    + '<div class="kpis">' + kpi("基准平均", signed(m.benchmarkAveragePct) + "%", tone(m.benchmarkAveragePct)) + kpi("上涨家数占比", num(m.breadthPositivePct, 1) + "%") + kpi("VIX 变化", signed(m.vixChangePct) + "%", tone(-m.vixChangePct)) + "</div>"
    + (m.errors ? '<p class="note">有 ' + m.errors + " 个数据源读取失败，简报可能不完整。</p>" : "")
    + '<p class="note">盘前简报只作参考，不改变策略的执行。</p>';
}

function render(d) {
  $("stamp").textContent = d.period.label + " · 交易日志 " + day(d.ledger.from) + " 起，更新到 " + when(d.ledger.to);
  renderFindings(d.findings); renderAccount(d.account, d); renderPositions(d.positions); renderDecision(d.decision);
  renderTrades(d); renderExecution(d.execution, d.period); renderPremarket(d.premarket);
}

async function load() {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-pressed", String(b.dataset.period === period));
  try {
    const response = await fetch("/api/review?period=" + period, { cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (response.status === 401) { location.assign("/login"); return; }
    if (!response.ok) throw new Error("HTTP " + response.status);
    render(await response.json());
  } catch (error) {
    $("stamp").textContent = "复盘数据读取失败（" + error.message + "），稍后刷新再试";
  }
}
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => {
  period = b.dataset.period;
  history.replaceState(null, "", "/reviews?period=" + period);
  load();
});
load();
</script>
</body>
</html>`;
}
