import { btcRadarFreshness, dcaScenario } from "./btc-radar-risk.mjs";
import { SITE_CSS, siteHeader } from "./site-shell.mjs";

// BTC risk radar page, migrated from the claude.ai artifact. Data comes from
// /api/btc-radar, written every four hours by scripts/run-btc-radar.mjs.
// Dragging the stop or take-profit only previews scenarios on this page; the
// server holds a read-only OKX key and nothing here changes the OKX bot.
export function btcRadarHtml({ nonce }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>BTC 风控雷达 · Agentic Wallet</title>
<style>
${SITE_CSS}
:root{--site-width:1184px;
  --ink:var(--text); --accent:var(--blue); --track:#232b36;
  --ok:var(--green); --warn:#e7b94c; --alert:var(--orange); --crit:var(--red);
  --ok-bg:var(--green-soft); --warn-bg:rgba(231,185,76,.13); --alert-bg:rgba(240,160,75,.14); --crit-bg:var(--red-soft);
  --f-body:var(--font); --f-num:var(--font-num)}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{font-size:14px;line-height:1.6;padding-bottom:env(safe-area-inset-bottom,0px)}
a{color:var(--blue)}
a:focus-visible{outline:2px solid var(--brand);outline-offset:3px}
.wrap{max-width:1184px;margin:0 auto;padding-inline:16px;padding-block:28px 48px;display:grid;gap:16px;min-width:0}
.num{font-family:var(--f-num);font-variant-numeric:tabular-nums}
h1{font-size:28px;font-weight:800;margin:0;letter-spacing:.02em}
h2{font-size:13px;font-weight:700;margin:0;color:var(--muted);letter-spacing:.08em;text-wrap:balance}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}
.eyebrow{font-size:11px;letter-spacing:.16em;color:var(--brand);margin:0 0 6px;font-weight:700}
.subtitle{margin:6px 0 0;color:var(--muted);font-size:13px}
.page-meta{display:flex;flex-wrap:wrap;gap:8px}
.tag{display:inline-flex;align-items:center;padding:4px 9px;border:1px solid var(--line);border-radius:6px;font-size:11px;color:var(--muted)}
.tag.readonly{color:var(--blue);border-color:rgba(120,169,255,.3);background:var(--blue-soft)}
.layer-nav{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.layer-nav a{display:flex;align-items:center;gap:12px;min-height:64px;padding:12px 16px;border:1px solid var(--line);border-radius:10px;background:var(--surface);text-decoration:none;color:var(--text);transition:border-color .15s,background-color .15s}
.layer-nav a:hover{border-color:var(--blue);background:var(--surface-2)}
.layer-nav .index{color:var(--brand);font-family:var(--font-num);font-size:12px}
.layer-nav b{display:block;font-size:14px}.layer-nav small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.health-bar{padding:12px 16px;border:1px solid var(--line);border-left:3px solid var(--blue);border-radius:9px;background:var(--surface)}
.account-alert{display:block;padding:12px 16px;border:1px solid var(--alert);border-radius:9px;background:var(--alert-bg);color:var(--ink);font-size:13px;text-decoration:none;min-height:44px}
.layer{display:grid;gap:14px;padding-top:16px;scroll-margin-top:100px;min-width:0}
.layer-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.layer-title{display:flex;align-items:center;gap:10px}.layer-title .index{font:12px var(--font-num);color:var(--brand)}
.layer-title h2{font-size:20px;letter-spacing:0;color:var(--text)}
.layer-heading p{font-size:12px;color:var(--muted);margin:4px 0 0}
.context-top{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;padding:18px 20px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
.context-note{font-size:13px;color:var(--muted);max-width:62ch;margin:0}
.stamp{color:var(--muted);font-size:12px}
.stamp b{font-weight:500;color:var(--ink)}
.stale{color:var(--crit);font-weight:700}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow)}
.disclosure{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);min-width:0}
summary{cursor:pointer;min-height:44px;list-style-position:inside}
summary:focus-visible{outline:2px solid var(--brand);outline-offset:3px;border-radius:6px}
.disclosure>summary{padding:16px 18px;font-size:13px;font-weight:650}
.disclosure>summary small{font-size:11px;color:var(--muted);margin-left:10px;font-weight:400}
.detail-body{padding:0 18px 18px;display:grid;gap:16px}
.pressure-row{display:grid;grid-template-columns:140px minmax(0,1fr);gap:20px;align-items:center}
.pressure-number{font:36px var(--font-num);line-height:1.2}.pressure-number small{font-size:13px;color:var(--muted)}
.pressure-label{font-size:11px;color:var(--muted);margin-bottom:6px}
.account-layout{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:16px;align-items:start}
.account-boundary{display:grid;gap:14px;min-width:0}
.account-boundary h3{font-size:13px;margin:0}.account-boundary p,.account-boundary li{font-size:12px;color:var(--muted);margin:0}
.account-boundary ol{padding-left:18px;margin:0;display:grid;gap:10px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 12px;border-radius:999px;font-weight:700;font-size:13px}
.lv-green{color:var(--ok);background:var(--ok-bg)} .lv-yellow{color:var(--warn);background:var(--warn-bg)}
.lv-orange{color:var(--alert);background:var(--alert-bg)} .lv-red{color:var(--crit);background:var(--crit-bg)}
.summary{font-size:13px;margin:8px 0 0;color:var(--muted)}
.price{font-size:13px;color:var(--muted)}
.price b{display:block;font-size:30px;color:var(--ink);font-weight:600;line-height:1.4}
.pos{display:grid;gap:14px;min-width:0}
.pos-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;align-items:center}
.ruler{position:relative;height:88px;margin:4px 8px 0}
.ruler .bar{position:absolute;left:0;right:0;top:40px;height:8px;border-radius:4px;
  background:linear-gradient(90deg,var(--crit) 0%,var(--alert) var(--slp,30%),var(--track) var(--slp,30%),var(--track) 100%)}
.ruler .bar.short{background:linear-gradient(90deg,var(--track) 0%,var(--track) var(--slp,70%),var(--alert) var(--slp,70%),var(--crit) 100%)}
.mk{position:absolute;top:0;transform:translateX(-50%);display:grid;justify-items:center;font-size:11px;white-space:nowrap;line-height:1.3}
.mk .t{color:var(--muted)} .mk .v{font-family:var(--f-num);font-size:11px}
.mk .tick{width:2px;height:18px;background:var(--muted);margin-top:2px}
.mk.low{top:auto;bottom:0} .mk.low .tick{order:-1;margin:0 0 2px}
.ruler .now{position:absolute;top:32px;width:4px;height:24px;margin-left:-2px;border-radius:2px;background:var(--accent);box-shadow:0 0 0 2px var(--panel)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.stat{border-top:1px solid var(--line);padding-top:8px}
.stat .k{font-size:12px;color:var(--muted)} .stat .v{font-family:var(--f-num);font-size:16px;font-weight:500}
.neg{color:var(--crit)} .pos-c{color:var(--ok)}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.fac{display:grid;gap:14px;align-content:start;box-shadow:none;min-width:0}
.fac-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.fac-head h3{margin:0;font-size:15px;font-weight:700}
.factor-method{border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.factor-method summary{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px}
.factor-method summary::after{content:'+';font-size:16px}.factor-method[open] summary::after{content:'−'}
.factor-method .note{font-size:12px;color:var(--muted)}
.kv{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:7px 12px;font-size:12px;margin:0}
.kv dt{color:var(--muted)} .kv dd{margin:0;font-family:var(--f-num);text-align:right;overflow-wrap:anywhere}
.kv .ref-first{border-top:1px dashed var(--line);padding-top:6px;margin-top:4px}
.ref{margin-left:6px;padding:0 5px;border:1px solid var(--line);border-radius:4px;font-size:10px;color:var(--muted);font-family:var(--f-body)}
.note{font-size:13px;margin:0}
.hist svg{width:100%;height:auto;display:block}
.hist text{fill:var(--muted);font-family:var(--f-num);font-size:11px}
.empty{color:var(--muted);text-align:center;padding:40px 16px}
.method{display:grid;gap:8px;font-size:13px;color:var(--muted)}
.method p{margin:0;max-width:75ch}
.mk.drag{cursor:ew-resize;touch-action:none;z-index:2}
.mk.drag .t{color:var(--ink);font-weight:700}
.mk.drag .tick{width:4px;height:22px;border-radius:2px;background:var(--ink)}
.mk.drag:focus{outline:none}
.mk.drag:focus-visible .tick{box-shadow:0 0 0 3px var(--panel),0 0 0 5px var(--ink)}
.mk.drag.moved .v{color:var(--warn);font-weight:700}
.ruler .rung{position:absolute;top:40px;width:1px;height:8px;margin-left:-.5px;background:var(--muted);opacity:.55}
.risk{display:grid;gap:10px;border-top:1px solid var(--line);padding-top:12px}
.risk-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.risk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.risk-item{border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:grid;gap:2px}
.risk-item .k{font-size:12px;color:var(--muted)}
.risk-item .v{font-family:var(--f-num);font-size:17px;font-weight:600}
.risk-item .s{font-size:12px;color:var(--muted)}
.preview-tag{color:var(--warn);font-size:12px;font-weight:700}
.capital{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.capital input{width:130px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font-family:var(--f-num)}
.btn{min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:6px;background:var(--track);color:var(--ink);cursor:pointer;font:inherit;font-size:13px;max-width:100%}
.btn:focus-visible,.capital input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.foot{font-size:12px;color:var(--muted);margin:0}
.trend{display:grid;gap:20px;border-top:2px solid var(--blue)}
.trend .pos-head h3{font-size:15px;margin:0}.trend #trendpill{font-size:16px;padding:6px 14px}
.trend .stats{grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.trend .stat .v{font-size:22px;margin-top:4px}
.trend .foot{padding-top:12px;border-top:1px solid var(--line)}
.obs{display:grid;gap:12px}
.obs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.obs-item{border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:grid;gap:4px;align-content:start;font-size:13px}
.obs-item .obs-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.obs-item .s{color:var(--muted);font-size:12px}
.stat .v small{display:block;font-family:var(--f-body);font-size:12px;font-weight:400;color:var(--muted)}
.score-hero{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(0,1.7fr);gap:28px;align-items:start}
.score-main{display:grid;gap:8px;align-content:start;justify-items:start}
.score-main .pressure-number{font-size:56px;line-height:1.05}
.score-why{display:grid;gap:10px;min-width:0}.score-why h3,.validity h3{margin:0;font-size:14px}
.contrib{display:grid;gap:9px}
.contrib-row{display:grid;grid-template-columns:minmax(96px,1fr) auto minmax(0,2fr) 52px;gap:10px;align-items:center;font-size:12px}
.contrib-row .w{color:var(--muted);font-family:var(--f-num);white-space:nowrap}
.contrib-bar{position:relative;height:10px;border-radius:5px;background:var(--surface-2)}
.contrib-bar::before{content:"";position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:var(--faint)}
.contrib-bar i{position:absolute;top:0;bottom:0;border-radius:5px}
.contrib-row .d{text-align:right;font-family:var(--f-num);font-weight:600}
.contrib-total{border-top:1px solid var(--line);padding-top:8px;font-size:12px;color:var(--muted)}
.fac-score{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.fac-score b{font:28px var(--font-num);line-height:1.1}.fac-score small{color:var(--muted)}
.delta{margin-left:auto;font:12px var(--font-num);padding:2px 8px;border-radius:999px;background:var(--surface-2)}
.rule{font-size:12px;margin:0;padding:8px 10px;border-radius:8px;background:var(--surface-2);color:var(--ink)}
.rule span{display:block;font-size:11px;color:var(--muted);margin-bottom:2px}
.lv-t-green{color:var(--ok)}.lv-t-yellow{color:var(--warn)}.lv-t-orange{color:var(--alert)}.lv-t-red{color:var(--crit)}
.daily-chart svg{width:100%;height:auto;display:block}
.daily-chart text{fill:var(--muted);font-family:var(--f-num);font-size:11px}
.daily-chart .cap{font-family:var(--f-body)}
.validity{display:grid;gap:12px}
.table-scroll{overflow-x:auto;min-width:0}
.vtable{width:100%;border-collapse:collapse;font-size:12px;min-width:540px}
.vtable th,.vtable td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}
.vtable th:first-child,.vtable td:first-child{text-align:left}
.vtable th{color:var(--muted);font-weight:600}
.vtable td{font-family:var(--f-num)}.vtable td small{display:block;color:var(--muted);font-size:11px;font-family:var(--f-body)}
@media(max-width:1000px){.score-hero{grid-template-columns:minmax(0,1fr);gap:20px}}
@media(max-width:600px){.layer-nav{grid-template-columns:repeat(2,minmax(0,1fr))}.contrib-row{grid-template-columns:minmax(0,1fr) auto 52px;gap:4px 10px}.contrib-row .contrib-bar{grid-column:1/-1;order:5}.score-main .pressure-number{font-size:44px}}
@media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.account-layout{grid-template-columns:minmax(0,1fr)}.account-boundary{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}}
@media(max-width:600px){.wrap{padding:20px 12px 36px}.layer-nav{gap:6px}.layer-nav a{padding:10px;gap:6px;min-height:66px}.layer-nav b{font-size:12px}.layer-nav small{font-size:10px}.layer-nav .index{display:none}.grid{grid-template-columns:minmax(0,1fr)}.panel{padding:16px}.layer{scroll-margin-top:16px}.layer-heading .tag{font-size:10px}.context-top{padding:16px}.context-note{font-size:12px}.pressure-row{grid-template-columns:minmax(0,1fr);gap:12px}.trend .stats{grid-template-columns:repeat(2,minmax(0,1fr))}.trend .stat .v{font-size:19px}.account-boundary{grid-template-columns:minmax(0,1fr)}.pos-head{align-items:flex-start}.pos-head h2{max-width:100%;overflow-wrap:anywhere}.obs-grid{grid-template-columns:minmax(0,1fr)}.disclosure>summary small{display:block;margin:4px 0 0 16px}}
@media(prefers-reduced-motion:reduce){.layer-nav a,.site-nav a{transition:none}}
</style>
</head>
<body>
${siteHeader("/btc-radar")}
<main class="wrap">
  <header class="top">
    <div><p class="eyebrow">BTC / READ-ONLY RADAR</p><h1>BTC 风控雷达</h1><p class="subtitle">市场背景与评分 · 分数与真实价格 · 长期环境 · 账户暴露</p></div>
    <div class="page-meta"><span class="tag readonly">只读 · 不下单</span><span class="tag">4h 快照 · 非实时保护</span></div>
  </header>
  <nav class="layer-nav" aria-label="雷达分区导航">
    <a href="#market-background"><span class="index">01</span><span><b>市场背景与评分</b><small>因子、规则与贡献</small></span></a>
    <a href="#score-history"><span class="index">02</span><span><b>评分与 BTC 走势</b><small>每日快照与之后涨跌</small></span></a>
    <a href="#slow-trend"><span class="index">03</span><span><b>慢趋势</b><small>200 日均线环境</small></span></a>
    <a href="#account-risk"><span class="index">04</span><span><b>账户风险</b><small>持仓与强平边界</small></span></a>
  </nav>
  <div class="health-bar"><div class="stamp" id="stamp" role="status">正在读取最新评估…</div></div>
  <a id="accountAlert" class="account-alert" href="#account-risk" aria-live="polite" hidden></a>

  <section id="market-background" class="layer" aria-labelledby="market-background-title">
    <div class="layer-heading"><div><div class="layer-title"><span class="index">01</span><h2 id="market-background-title">市场背景与评分</h2></div><p>五个背景因子各打 0–100 分，按 20:20:15:10:10 加权成下跌压力分：50 为中性，越高表示背景越不利于 BTC。</p></div><span class="tag">未验证 / 非预测</span></div>
    <div class="panel score-hero" aria-label="当前评分">
      <div class="score-main">
        <div class="pressure-label">下跌压力分 · 当前</div>
        <div class="pressure-number"><span id="pressureValue">—</span><small> / 100</small></div>
        <span class="pill" id="lvpill">—</span>
        <p class="summary" id="summary">等待第一次评估写入数据。</p>
        <div class="price">BTC / USDT · 采集时点价格<b class="num" id="price">—</b></div>
      </div>
      <div class="score-why">
        <div class="pos-head"><h3>分数怎么来的</h3><span class="stamp">每个因子按权重偏离 50 的分数</span></div>
        <div id="contrib" class="contrib"><div class="empty">等待第一次评估写入数据。</div></div>
      </div>
    </div>
    <div class="grid" id="factors"></div>
    <details id="score-method" class="disclosure">
      <summary>评分规则与等级<small>公式、权重、阈值与局限</small></summary>
      <div class="detail-body method"><p>总分 = 50 + Σ（因子分 − 50）× 权重 / 75，等于五个因子按 20:20:15:10:10 的加权平均。每个因子分都截断在 0–100。等级：≥70 高风险、55–70 警戒、40–55 中性、&lt;40 下跌压力较低。</p><p>这是未验证的下跌压力分，不是亏损概率、低风险证明或多空交易信号。因子规则是模型假设，不是已经核实的因果关系；「评分与 BTC 走势」按每日快照对照之后的真实收盘价，用来检验它。Polymarket 只展示各合约区间的原始报价，不计分。新版评分与旧版历史不连线比较。</p><p>「参考」指标不计分：RSI(14) 使用 OKX UTC 日线和 Wilder 平滑；恐惧贪婪指数来自 alternative.me。</p></div>
    </details>
  </section>

  <section id="score-history" class="layer" aria-labelledby="score-history-title">
    <div class="layer-heading"><div><div class="layer-title"><span class="index">02</span><h2 id="score-history-title">评分与 BTC 走势</h2></div><p>每天北京时间 08:00 后第一次评估（UTC 日线收盘后）存为当日快照，与之后的真实收盘价对照。</p></div><span class="tag" id="dailyStamp">每日快照</span></div>
    <div class="panel" aria-label="每日评分与 BTC 价格"><div id="daily" class="daily-chart"><div class="empty">正在读取每日快照…</div></div></div>
    <div class="panel validity" aria-label="评分合理性">
      <div class="pos-head"><div><h3>评分合理性 · 快照之后 BTC 怎么走</h3><p class="subtitle">若分数有用，高分之后的涨跌应更差、低分之后更好。</p></div><span class="pill" id="validityPill">样本积累中</span></div>
      <div id="validity" class="table-scroll"></div>
      <p class="foot" id="validityNote"></p>
    </div>
    <details class="disclosure">
      <summary>每日快照明细<small>分数、价格与之后 1/7/30 天涨跌</small></summary>
      <div class="detail-body"><div id="dailyTable" class="table-scroll"></div></div>
    </details>
    <details id="intraday-history" class="disclosure">
      <summary>4 小时评估明细<small>当前版本的每次评估</small></summary>
      <div class="detail-body"><div class="hist" id="hist"><div class="empty">等待同版本评估历史。</div></div></div>
    </details>
  </section>

  <section id="slow-trend" class="layer" aria-labelledby="slow-trend-title">
    <div class="layer-heading"><div><div class="layer-title"><span class="index">03</span><h2 id="slow-trend-title">慢趋势</h2></div><p>判断日级环境，不猜下一根 K 线。</p></div><span class="tag">UTC 已收盘日线</span></div>
    <div class="panel trend" aria-label="趋势状态">
      <div class="pos-head"><div><h3>200 日均线 · ±3% 缓冲带</h3><p class="subtitle">只在已收盘日线确认状态，缓冲带内维持此前环境。</p></div><span class="pill" id="trendpill">—</span></div>
      <div class="stats" id="trendstats"></div>
      <p class="foot">回避只表示不持有多头，不是做空信号；多头环境也不是买点或杠杆安全证明。状态切换按原规则推送飞书，不会自动执行交易。</p>
      <details class="disclosure"><summary>规则与历史证据<small>历史回撤仍可能很大</small></summary><div class="detail-body method"><p>日收盘高于 200 日均线 3% 以上为多头环境，低于 3% 以下为回避环境，在 ±3% 之内维持原状态。回测（2022 年以来，现货、次日执行、含手续费）：按此规则持有的最大回撤约 −39%，一直持有约 −67%。这是历史研究，不保证未来结果，不适用于直接推断杠杆仓位安全。</p></div></details>
    </div>
    <details id="candidate-observations" class="disclosure">
      <summary>候选信号观察<small>未验证 · 只记录，不推送</small></summary>
      <div class="detail-body obs" aria-label="观察模式"><div class="pos-head"><h3>前向观察记录</h3><span class="stamp" id="obsstamp"></span></div><p class="foot" id="obsinputs"></p><div class="obs-grid" id="obsrules"></div>
      <p class="foot">这些候选信号没有通过 2022 年以后的历史检验。系统按 UTC 日收盘记录触发及之后 7、30、90 天的涨跌（从次日收盘算起），与同期随机日子比较。原观察口径保留：至少 10 次到期触发才给出 p 值；p&lt;0.05 也不等于具备交易资格。</p></div>
    </details>
  </section>

  <section id="account-risk" class="layer" aria-labelledby="account-risk-title">
    <div class="layer-heading"><div><div class="layer-title"><span class="index">04</span><h2 id="account-risk-title">账户风险</h2></div><p id="accountSummary">等待只读账户快照，当前风险未核实。</p></div><span class="tag readonly">OKX / 只读</span></div>
    <div class="account-layout">
      <div class="panel pos">
        <div class="pos-head"><h2 id="poshead">OKX · BTCUSDT 永续持仓</h2><span class="pill" id="pospill">—</span></div>
        <div id="positionList" class="stats"></div>
        <label class="stamp" id="positionPicker" hidden>查看持仓 <select id="positionSelect" class="btn" aria-label="选择 BTC 持仓"></select></label>
        <div class="ruler" id="ruler"></div><div class="stamp" id="rulerHelp"></div><div class="stats" id="posstats"></div><div class="risk" id="risk" hidden></div>
      </div>
      <aside class="account-boundary" aria-label="账户风险边界">
        <div class="panel method"><h3>先检查什么</h3><ol><li>强平是否会先于止损。</li><li>距强平、距止损还有多远。</li><li>补仓后的敞口与假设退出损益。</li></ol><p>绿色也只是距离参考，不是安全保证。</p></div>
        <div class="panel method"><h3>这页不做什么</h3><p>仅覆盖只读账户中的 BTC-USDT 永续、合约网格与马丁格尔，不代表现货、其他币对或股票 Bot 的全部资产。</p><p>每 4 小时采集、每 60 秒查看缓存；不是实时保护。五小时失效后不保留当前风险结论。</p><p>拖动止损/止盈仅作本页预览。总资金设置只保存展示占比，不修改 OKX 或交易参数。</p></div>
      </aside>
    </div>
  </section>

  <footer class="method"><p id="sources">数据来源：Polymarket、美国财政部、OKX。</p><p>数据汇总与研究观察，不构成投资建议；此页面不会自动开仓、平仓或调整杠杆。</p></footer>
</main>
<script nonce="${nonce}">
const $ = id => document.getElementById(id);
const LV = {green:"var(--ok)",yellow:"var(--warn)",orange:"var(--alert)",red:"var(--crit)"};
const LEVELS = new Set(Object.keys(LV));
const lvOf = s => s>=70?"red":s>=55?"orange":s>=40?"yellow":"green";
const lvSafe = v => LEVELS.has(v) ? v : "yellow";
const num = v => { const n = v == null || v === "" ? NaN : Number(v); return Number.isFinite(n) ? n : NaN; };
const fmt = (n,d=0) => Number.isFinite(num(n)) ? num(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}) : "—";
const pct = n => Number.isFinite(num(n)) ? (num(n)>0?"+":"")+num(n).toFixed(2)+"%" : "—";
const esc = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const httpsUrl = u => { try { const url = new URL(String(u)); return url.protocol === "https:" ? url.href : null; } catch { return null; } };
${btcRadarFreshness.toString()}
${dcaScenario.toString()}
let radar = null, settings = {}, preview = {}, dragging = null, scale = null, selectedId = null, connectionError = null, dataUsable = true;
const sourceName = p => p.source === "grid" ? "合约网格" : p.source === "account" ? "普通永续" : "合约马丁格尔";
const activePosition = () => (radar && (radar.positions || []).find(p => p.id === selectedId)) || (radar && radar.position);
function selectPosition(id){
  selectedId = id; preview = {};
  if(radar) renderPosition(activePosition(), radar.price, radar.data_status);
}
function renderPositions(d){
  const positions = d.positions || (d.position ? [d.position] : []);
  if(!positions.some(p => p.id === selectedId)){ selectedId = d.position && d.position.id; preview = {}; }
  $("positionList").innerHTML = positions.length > 1 ? positions.map(p => '<div class="stat"><div class="k">'+esc(sourceName(p))+" · "+(p.direction === "short" ? "做空" : "做多")+'</div><div class="v">'+fmt(p.sz_btc,4)+' BTC<small>'+(p.stale ? "旧数据 · " : "")+"浮动盈亏 "+fmt(p.unrealized_pnl,2)+" USDT</small></div></div>").join("") : "";
  $("positionPicker").hidden = positions.length < 2;
  const select = $("positionSelect");
  select.innerHTML = positions.map((p,i) => '<option value="'+esc(p.id)+'">'+(i+1)+" · "+esc(sourceName(p))+" · "+(p.direction === "short" ? "做空" : "做多")+" · "+fmt(p.sz_btc,4)+' BTC</option>').join("");
  select.value = selectedId;
  select.onchange = () => selectPosition(select.value);
  renderPosition(activePosition(), d.price, d.data_status);
  renderAccountAttention(d);
}

function renderAccountAttention(d){
  const positions=d.positions||(d.position?[d.position]:[]);
  const stale=p=>p.stale||(p.fetchedAt&&btcRadarFreshness({ts:p.fetchedAt}).expired);
  const incomplete=positions.some(stale)||(d.data_status?.staleSources||[]).some(s=>["dcaPositions","accountPositions","gridPositions"].includes(s.key));
  const attention=positions.filter(p=>!stale(p)&&["red","orange"].includes(p.level));
  $("accountSummary").textContent=!d.data_status?.okxConfigured?"未接入只读账户，当前账户风险未核实。":incomplete?"持仓来源不完整或非最新，当前账户风险未核实。":positions.length?positions.length+" 笔 BTC 永续快照 · 分来源展示，不合并均价或收益。":"本次快照未读取到 BTC 永续持仓，不代表其他资产空仓。";
  $("accountAlert").hidden=attention.length===0&&!incomplete;
  $("accountAlert").textContent=attention.length?"账户风险需关注 · "+attention.map(p=>sourceName(p)+"："+p.level_name).join("；")+" · 查看账户风险":"账户数据非最新或不完整，当前风险未核实 · 查看账户风险";
}

function renderPressure(score){
  $("pressureValue").textContent=Number.isFinite(num(score))?String(Math.round(num(score))):"—";
}

const effective = (kind, p) => preview[kind] != null ? preview[kind] : num(kind === "sl" ? p.sl : p.tp);
const shift = q => q > 88 ? "translateX(-90%)" : q < 12 ? "translateX(-10%)" : "translateX(-50%)";

function rulerScale(p, price){
  const rungs = ((p.ladder && p.ladder.pending) || []).map(([px]) => px);
  const values = [p.liq, p.sl, p.next_safety, p.avg, p.tp, price, ...rungs].map(num).filter(v => Number.isFinite(v) && v > 0);
  return { lo: Math.min(...values) * 0.98, hi: Math.max(...values) * 1.03 };
}

function renderPosition(p, price, status){
  const risk = $("risk");
  if(!p){
    $("poshead").textContent="OKX · BTCUSDT 永续持仓"; $("rulerHelp").textContent="";
    $("pospill").textContent="未接入持仓";$("pospill").className="pill";$("ruler").innerHTML="";risk.hidden=true;
    $("posstats").innerHTML='<div class="empty">'+(status&&status.okxConfigured?"当前只读账户未读取到 BTC-USDT 永续持仓、合约网格或马丁格尔。请核对账户/子账户、实盘和合约品种；数据失败请看顶部来源提示。":"服务器尚未配置 OKX 只读 API Key，持仓与舆情暂未接入。")+'</div>';
    return;
  }
  price = p.reference_price > 0 ? p.reference_price : price;
  const short = p.direction === "short", dca = !p.source || p.source === "dca";
  $("poshead").textContent=sourceName(p)+" · BTCUSDT 永续 "+(Number.isFinite(num(p.lever))?num(p.lever)+"x ":"")+(short ? "做空" : "做多")+(p.stale ? " · 旧数据" : "");
  const expired = p.fetchedAt && btcRadarFreshness({ts:p.fetchedAt}).expired;
  if(!dataUsable || p.stale || expired){
    $("pospill").textContent=!dataUsable?"持仓结论失效":"持仓数据非最新"; $("pospill").className="pill lv-yellow";
    $("ruler").innerHTML=""; $("rulerHelp").textContent="旧持仓仅供复核，不提供风险评级或退出测算。";
    $("posstats").innerHTML=""; risk.hidden=true; return;
  }
  $("rulerHelp").textContent="蓝色竖线是现价，红橙色段是止损"+(short ? "以上" : "以下")+"的危险区。"+(p.sl > 0 ? "" : (p.stop_note || "未设置止损")+"。")+"拖动「止损」「止盈」仅预览，不会修改 OKX。";
  $("pospill").textContent=p.level_name; $("pospill").className="pill lv-"+lvSafe(p.level);
  scale = rulerScale(p, price);
  const x = v => (v - scale.lo) / (scale.hi - scale.lo) * 100;
  const stop = effective("sl", p), target = effective("tp", p);
  let h = '<div class="bar'+(short ? " short" : "")+'" id="dangerBar" style="--slp:' + (stop > 0 ? x(stop) : short ? 100 : 0).toFixed(1) + '%"></div>';
  ((p.ladder && p.ladder.pending) || []).forEach(([px]) => { const n = num(px); if(n > 0) h += '<div class="rung" style="left:' + x(n).toFixed(2) + '%"></div>'; });
  [["强平", p.liq, "low"], ["下次补仓", p.next_safety, "low"], ["均价", p.avg, ""]].forEach(([t, v, c]) => {
    const n = num(v);
    if(Number.isFinite(n) && n > 0) h += '<div class="mk ' + c + '" style="left:' + x(n).toFixed(2) + '%;transform:' + shift(x(n)) + '"><span class="t">' + t + '</span><span class="v">' + fmt(n) + '</span><span class="tick"></span></div>';
  });
  [["sl", "止损", stop, ""], ["tp", "止盈", target, "low"]].forEach(([kind, t, n, c]) => {
    if(!(n > 0)) return;
    h += '<div class="mk drag ' + c + (preview[kind] != null ? " moved" : "") + '" data-kind="' + kind + '" role="slider" tabindex="0" aria-label="拖动预览' + t + '价" aria-valuemin="' + Math.round(scale.lo) + '" aria-valuemax="' + Math.round(scale.hi) + '" aria-valuenow="' + Math.round(n) + '" style="left:' + x(n).toFixed(2) + '%;transform:' + shift(x(n)) + '"><span class="t">' + t + '</span><span class="v">' + fmt(n) + '</span><span class="tick"></span></div>';
  });
  if(Number.isFinite(num(price))) h += '<div class="now" style="left:' + x(num(price)).toFixed(2) + '%" title="现价 ' + fmt(price) + '"></div>';
  $("ruler").innerHTML = h;
  bindRuler(p, price);
  const pnl=num(p.total_pnl);
  const st=[["现价",fmt(price,1),""],["方向 / 仓位",(short ? "空头" : "多头")+" / "+fmt(p.sz_btc,4)+" BTC",""],["距止损"+(p.sl_price_type === "mark" ? "（标记价）" : ""),num(p.sl)>0?pct(p.d_sl):"价格止损未确认",num(p.sl)>0&&(short ? -num(p.d_sl) : num(p.d_sl))>-5?"neg":""],["距强平"+(p.mark_price > 0 ? "（标记价）" : ""),pct(p.d_liq),""],["距止盈",pct(p.d_tp),""],
    ...(p.source === "account" ? [] : [["策略总收益",Number.isFinite(pnl)?(pnl>0?"+":"")+fmt(pnl,2)+" USDT":"—",pnl<0?"neg":"pos-c"]]),
    ...(dca ? [["自动补仓",fmt(p.safety_filled)+" / "+fmt(p.safety_max)+(num(p.manual_adds)>0?" · 手动 "+fmt(p.manual_adds):""),""]] : [["浮动盈亏",fmt(p.unrealized_pnl,2)+" USDT",num(p.unrealized_pnl)<0?"neg":"pos-c"]]),
    ...(p.source === "grid" ? [["网格收益",fmt(p.grid_pnl,2)+" USDT",num(p.grid_pnl)<0?"neg":"pos-c"],["网格区间",(p.grid_range || []).map(v=>fmt(v)).join(" — "),""]] : [])];
  $("posstats").innerHTML=st.map(([k,v,c])=>'<div class="stat"><div class="k">'+k+'</div><div class="v '+c+'">'+esc(v)+'</div></div>').join("");
  const capital = num(settings.capitalUsdt) > 0 ? num(settings.capitalUsdt) : "";
  risk.hidden = !dataUsable;
  risk.innerHTML = '<div id="riskBody"></div>'
    + '<div class="capital"><label for="capitalInput">总资金</label><input id="capitalInput" inputmode="decimal" autocomplete="off" placeholder="例如 5000" value="' + esc(capital) + '"> USDT <button class="btn" id="saveCapital" type="button">保存</button><span id="capitalStatus" role="status"></span></div>'
    + '<p class="foot">不提供止盈止损概率：日历触价合约不是未来交易路径概率。' + (dca ? (p.ladder && p.ladder.complete ? "" : "补仓挂单数据暂缺，最坏亏损可能偏低。")+"按 0.4% 维持保证金率估算强平价。" : "仅按当前持仓测算，不预测网格后续买卖或其他挂单，不是最大亏损；强平价直接读取 OKX。") + '按 0.05% 吃单手续费，未计滑点及未来资金费。总资金只用于计算占比，保存在服务器上。</p>';
  const save = $("saveCapital");
  if(save && save.addEventListener) save.addEventListener("click", saveCapital);
  renderRisk(p, price);
}

function bindRuler(p, price){
  const ruler = $("ruler");
  if(!ruler.querySelectorAll) return;
  ruler.querySelectorAll(".mk.drag").forEach(handle => {
    const kind = handle.getAttribute("data-kind");
    const follow = e => {
      const rect = ruler.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      setPreview(kind, scale.lo + fraction * (scale.hi - scale.lo), p, price, handle);
    };
    handle.addEventListener("pointerdown", e => { e.preventDefault(); dragging = kind; if(handle.setPointerCapture) handle.setPointerCapture(e.pointerId); handle.focus({ preventScroll: true }); follow(e); });
    handle.addEventListener("pointermove", e => { if(dragging === kind) follow(e); });
    const finish = () => { if(dragging === kind) dragging = null; };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
    handle.addEventListener("keydown", e => {
      if(e.key === "Escape"){ resetPreview(); return; }
      const steps = { ArrowLeft: -1, ArrowDown: -1, PageDown: -10, ArrowRight: 1, ArrowUp: 1, PageUp: 10 }[e.key];
      if(!steps) return;
      e.preventDefault();
      setPreview(kind, effective(kind, p) + steps * num(price) * 0.001, p, price, handle);
    });
  });
}

// Moves one handle in place, so an active pointer capture survives the update.
function setPreview(kind, value, p, price, handle){
  if(!dataUsable || p.stale) return;
  const below = p.direction === "short" ? kind === "tp" : kind === "sl";
  const low = below ? scale.lo : num(price) * 1.001;
  const high = below ? num(price) * 0.999 : scale.hi;
  preview[kind] = Math.round(Math.min(high, Math.max(low, value)) * 10) / 10;
  const q = (preview[kind] - scale.lo) / (scale.hi - scale.lo) * 100;
  if(handle){
    handle.style.left = q.toFixed(2) + "%";
    handle.style.transform = shift(q);
    handle.setAttribute("aria-valuenow", String(Math.round(preview[kind])));
    handle.classList.add("moved");
    const label = handle.querySelector(".v");
    if(label) label.textContent = fmt(preview[kind]);
  }
  const bar = $("dangerBar");
  if(kind === "sl" && bar && bar.style && bar.style.setProperty) bar.style.setProperty("--slp", q.toFixed(1) + "%");
  renderRisk(p, price);
}

function resetPreview(){
  preview = {};
  if(radar) renderPosition(activePosition(), radar.price, radar.data_status);
}

function renderRisk(p, price){
  if(!dataUsable || p.stale) return;
  price = p.reference_price > 0 ? p.reference_price : price;
  const s = dcaScenario({ position: p, price: num(price), stop: effective("sl", p), takeProfit: effective("tp", p), capitalUsdt: num(settings.capitalUsdt) > 0 ? num(settings.capitalUsdt) : null });
  const short = p.direction === "short", dca = !p.source || p.source === "dca";
  const share = v => v == null ? "填写总资金后显示占比" : "约占总资金 " + (v * 100).toFixed(1) + "%";
  const previewing = preview.sl != null || preview.tp != null;
  const items = [
    ["止损触发时", s.lossAtStop == null ? "价格止损未确认" : (s.lossAtStop < 0 ? "+" : "") + fmt(-s.lossAtStop, 1) + " USDT", s.lossAtStop == null ? "无法测算止损亏损" : share(s.lossShare),
      (dca ? "会先成交 " + s.fills + " 笔补仓，仓位 " : "固定当前仓位 ") + fmt(s.worstSize, 4) + " BTC，均价 " + fmt(s.worstAverage)],
    ["止盈触发时", s.profitAtTarget == null ? "—" : (s.profitAtTarget > 0 ? "+" : "") + fmt(s.profitAtTarget, 1) + " USDT", share(s.profitShare),
      "相对均价 " + pct(s.targetFromAverage * 100) + " · 距现价 " + pct(s.targetDistance * 100)],
    [dca ? "止损前补仓后的估算强平价" : "当前强平价（OKX）", s.worstLiquidation ? (dca ? "约 " : "") + fmt(s.worstLiquidation) : "—",
      s.stopAboveLiquidation == null ? "" : s.stopAboveLiquidation > 0 ? "止损"+(short ? "低于" : "高于")+"强平 " + (s.stopAboveLiquidation * 100).toFixed(1) + "%" : "止损已越过强平价，可能先被强平",
      s.stop ? "止损距现价 " + pct(s.stopDistance * 100) : ""],
    ["打平所需止盈比例", s.breakevenWinRate == null ? "—" : (s.breakevenWinRate * 100).toFixed(1) + "%", "仅损益比例，不是预测胜率", "按一次止损对一次止盈计算"]
  ];
  $("riskBody").innerHTML = '<div class="risk-head"><h2>风险测算</h2>'
    + (previewing ? '<span class="preview-tag">预览中 · 不会修改 OKX</span><button class="btn" id="resetPreview" type="button">恢复实际设置</button>' : "")
    + '</div><div class="risk-grid">'
    + items.map(([k, v, a, b]) => '<div class="risk-item"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span>' + (a ? '<span class="s">' + esc(a) + '</span>' : "") + (b ? '<span class="s">' + esc(b) + '</span>' : "") + '</div>').join("")
    + '</div>';
  const reset = $("resetPreview");
  if(previewing && reset && reset.addEventListener) reset.addEventListener("click", resetPreview);
}

async function saveCapital(){
  const status = $("capitalStatus");
  const raw = String($("capitalInput").value || "").split(",").join("").trim();
  const value = raw === "" ? null : Number(raw);
  if(value !== null && !(value > 0)){ status.textContent = "请输入大于 0 的数字"; return; }
  status.textContent = "保存中…";
  try{
    const response = await fetch("/api/btc-radar/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capitalUsdt: value }), signal: AbortSignal.timeout(15000) });
    if(response.status === 401){ status.textContent = "登录已过期，请重新登录"; return; }
    const result = await response.json();
    if(!response.ok) throw new Error(result.error || "保存失败");
    settings = result.settings || {};
    status.textContent = value === null ? "已清除" : "已保存";
    if(activePosition()) renderRisk(activePosition(), radar.price);
  }catch(error){
    status.textContent = error.message || "保存失败";
  }
}

function referenceRows(key, indicators){
  const rsi=indicators&&indicators.rsi14, fearGreed=indicators&&indicators.fearGreed;
  if(key==="tech"&&rsi) return [["RSI(14) 日线收盘",fmt(rsi.closed,1)],["RSI(14) 含当日盘中",fmt(rsi.intraday,1)]];
  if(key==="deriv"&&fearGreed) return [["恐惧贪婪指数",fmt(fearGreed.value)+" "+fearGreed.label]];
  return [];
}

// Scoring rules as written in src/btc-radar-model.mjs; each factor score is clamped to 0-100.
const RULES = {
  fed:"50 + 50 ×［0.6 ×（年内加息 − 年内降息概率）+ 0.4 ×（下次议息加息 − 降息概率）］",
  ust:"50 + 10 年期 10 日变化（bp）+（10 年期收益率 − 4.5%）× 15",
  gold:"50 − 5 × 金价 10 日涨跌（%）",
  tech:"50 − 300 ×（现价 / 20 日均线 − 1）− 100 ×（现价 / 50 日均线 − 1）− 2 × 7 日涨跌（%）",
  deriv:"50 +（资金费率均值 bp − 1）× 8 + 持仓量 7 日变化（%）+（舆情多 − 空 − 0.3）× 30",
  poly:"不计分：只展示各合约区间的原始 Yes 报价"
};
const signed = (n,d=1) => Number.isFinite(num(n)) ? (num(n)>0?"+":num(n)<0?"−":"")+Math.abs(num(n)).toFixed(d) : "—";
// Total = 50 + Σ (factor − 50) × weight / Σ weights, the model's weighted mean.
function contributions(F){
  const scored=F.filter(f=>num(f.weight)>0), total=scored.reduce((sum,f)=>sum+num(f.weight),0);
  return scored.map(f=>({f, share:total?num(f.weight)/total:NaN,
    delta:dataUsable&&total&&Number.isFinite(num(f.score))?(num(f.score)-50)*num(f.weight)/total:NaN}));
}
function renderContrib(F){
  const rows=contributions(F);
  if(!rows.length||rows.some(r=>!Number.isFinite(r.delta))){
    $("contrib").innerHTML='<div class="empty">'+(rows.length?"数据失效，当前不显示分数构成。":"等待第一次评估写入数据。")+'</div>';
    return;
  }
  const max=Math.max(...rows.map(r=>Math.abs(r.delta)),1), sum=rows.reduce((total,r)=>total+r.delta,0);
  $("contrib").innerHTML=rows.slice().sort((a,b)=>b.delta-a.delta).map(r=>{
    const up=r.delta>=0, width=(Math.abs(r.delta)/max*50).toFixed(1)+"%";
    return '<div class="contrib-row"><span>'+esc(r.f.name)+'</span><span class="w">'+fmt(r.f.score)+' 分 · 权重 '+Math.round(r.share*100)+'%</span>'
      +'<span class="contrib-bar" aria-hidden="true"><i style="'+(up?"left":"right")+':50%;width:'+width+';background:'+(up?"var(--crit)":"var(--ok)")+'"></i></span>'
      +'<span class="d '+(up?"neg":"pos-c")+'">'+signed(r.delta)+'</span></div>';
  }).join("")+'<div class="contrib-total">中性 50 '+(sum<0?"−":"+")+" "+Math.abs(sum).toFixed(1)+" = "+(50+sum).toFixed(1)+' 分 · 正值推高下跌压力，负值降低压力</div>';
}

function renderFactors(F, indicators){
  F=F.filter(f=>f.key!=="poly"||radar.modelVersion==="pressure-v2-no-touch-probability");
  const delta=Object.fromEntries(contributions(F).map(r=>[r.f.key,r.delta]));
  $("factors").innerHTML=F.map(f=>{
    const scored=num(f.weight)>0, score=dataUsable?num(f.score):NaN, refs=referenceRows(f.key, indicators), d=delta[f.key];
    return '<article class="panel fac"><div class="fac-head"><h3>'+esc(f.name)+'</h3><span class="tag">'+(scored?"权重 "+fmt(f.weight)+" / 75":"原始盘口 · 不计分")+'</span></div>'
      +(scored?'<div class="fac-score"><b class="'+(Number.isFinite(score)?"lv-t-"+lvOf(score):"")+'">'+fmt(score)+'</b><small>/ 100</small><span class="delta">贡献 '+signed(d)+' 分</span></div>':"")
      +'<dl class="kv">'+(f.metrics||[]).map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join("")
      +refs.map(([k,v],i)=>'<dt class="'+(i?"":"ref-first")+'">'+esc(k)+'<span class="ref">参考</span></dt><dd class="'+(i?"":"ref-first")+'">'+esc(v)+'</dd>').join("")+'</dl>'
      +'<p class="rule"><span>评分规则'+(scored?" · 截断在 0–100":"")+'</span>'+esc(RULES[f.key]||"规则未记录")+'</p>'
      +'<p class="note">'+(scored?"模型解读（未验证）：":"")+esc(f.note)+'</p></article>';
  }).join("");
  renderContrib(F);
}

const BANDS = [["green","低压力 <40"],["yellow","中性 40–55"],["orange","警戒 55–70"],["red","高风险 ≥70"]];
const dayNum = d => Date.parse(String(d)+"T00:00:00Z")/86400000;
const dayText = n => new Date(n*86400000).toISOString().slice(5,10).replace("-","/");
let lastDaily = null, resizeTimer = 0;
function renderScoreHistory(daily){
  lastDaily = daily; renderDaily(daily); renderValidity(daily); renderDailyTable(daily);
}
// The chart is drawn at its container's width so axis labels keep their size on phones.
if(typeof addEventListener === "function") addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderDaily(lastDaily), 200); });
// A UTC candle closes at the start of the next day, which is when the
// Beijing-date snapshot that follows it is taken, so closes plot one day on.
function renderDaily(daily){
  const box=$("daily");
  if(!daily){ $("dailyStamp").textContent="每日快照"; box.innerHTML='<div class="empty">每日快照暂时读取失败，下一次刷新会重试。</div>'; return; }
  const closes=(daily.closes||[]).filter(c=>num(c.close)>0&&Number.isFinite(dayNum(c.date))).map(c=>[dayNum(c.date)+1,num(c.close)]);
  const snaps=(daily.snapshots||[]).filter(r=>Number.isFinite(num(r.score))&&num(r.price)>0&&Number.isFinite(dayNum(r.date)));
  const rescored=snaps.filter(r=>r.rescoredFrom).length;
  $("dailyStamp").textContent=snaps.length?"当前版本 "+snaps.length+" 天快照"+(rescored?" · "+rescored+" 天重算":""):"当前版本尚无每日快照";
  if(closes.length<2&&snaps.length<2){ box.innerHTML='<div class="empty">尚无足够的日线与快照数据。</div>'; return; }
  const W=Math.round(Math.min(760,Math.max(300,num(box.clientWidth)||760))),L=40,R=W<480?46:60,T=24,PH=W<480?130:150,GAP=36,SH=W<480?100:120,B=24,sTop=T+PH+GAP,H=sTop+SH+B;
  const days=closes.map(c=>c[0]).concat(snaps.map(r=>dayNum(r.date))), d0=Math.min(...days), d1=Math.max(...days);
  const x=n=>(L+(W-L-R)*(n-d0)/Math.max(1,d1-d0)).toFixed(1);
  const prices=closes.map(c=>c[1]).concat(snaps.map(r=>num(r.price))), lo=Math.min(...prices)*0.99, hi=Math.max(...prices)*1.01;
  // The score axis zooms to the recorded range (at least 20 points) so daily moves stay visible.
  const scores=snaps.map(r=>num(r.score));
  let sLo=scores.length?Math.max(0,Math.floor((Math.min(...scores)-5)/5)*5):0, sHi=scores.length?Math.min(100,Math.ceil((Math.max(...scores)+5)/5)*5):100;
  if(sHi-sLo<20){ sLo=Math.max(0,Math.min(sLo,sHi-20)); sHi=Math.min(100,sLo+20); }
  const yp=v=>(T+PH*(1-(v-lo)/(hi-lo))).toFixed(1), ys=v=>(sTop+SH*(1-(Math.min(sHi,Math.max(sLo,v))-sLo)/(sHi-sLo))).toFixed(1);
  let s='<text class="cap" x="'+L+'" y="'+(T-10)+'">BTC 日收盘（USDT · OKX UTC 日线）</text><text class="cap" x="'+L+'" y="'+(sTop-10)+'">每日快照分数</text>';
  [lo,(lo+hi)/2,hi].forEach(v=>s+='<text x="'+(W-R+6)+'" y="'+(Number(yp(v))+4)+'">'+fmt(v/1000,1)+'k</text>');
  if(closes.length>1) s+='<polyline points="'+closes.map(c=>x(c[0])+","+yp(c[1])).join(" ")+'" fill="none" stroke="var(--muted)" stroke-width="1.6"/>';
  [[70,100,"var(--crit-bg)"],[55,70,"var(--alert-bg)"],[40,55,"var(--warn-bg)"]].forEach(([a,b,c])=>{ if(ys(a)-ys(b)>0) s+='<rect x="'+L+'" y="'+ys(b)+'" width="'+(W-L-R)+'" height="'+(ys(a)-ys(b)).toFixed(1)+'" fill="'+c+'" opacity=".7"/>'; });
  [...new Set([sLo,40,55,70,sHi])].filter(v=>v>=sLo&&v<=sHi).forEach(v=>s+='<text x="'+(L-6)+'" y="'+(Number(ys(v))+4)+'" text-anchor="end">'+v+'</text>');
  if(snaps.length>1) s+='<polyline points="'+snaps.map(r=>x(dayNum(r.date))+","+ys(num(r.score))).join(" ")+'" fill="none" stroke="var(--accent)" stroke-width="1.8"/>';
  snaps.forEach(r=>{
    const color=LV[lvOf(num(r.score))], cx=x(dayNum(r.date));
    const tip='<title>'+esc(r.date+" · 分数 "+fmt(r.score,1)+" · BTC "+fmt(r.price)+(r.rescoredFrom?" · 按新版规则重算，旧版原分 "+fmt(r.rescoredFrom.score,1):""))+'</title>';
    const dot=(cy)=>'<circle cx="'+cx+'" cy="'+cy+'" r="3.5" '+(r.rescoredFrom?'fill="var(--panel)" stroke="'+color+'" stroke-width="1.8"':'fill="'+color+'"')+'>'+tip+'</circle>';
    s+=dot(yp(num(r.price)))+dot(ys(num(r.score)));
  });
  s+='<text x="'+L+'" y="'+(H-6)+'">'+dayText(d0)+'</text><text x="'+(W-R)+'" y="'+(H-6)+'" text-anchor="end">'+dayText(d1)+'</text>';
  box.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="每日评分与 BTC 日收盘价">'+s+'</svg>'
    +'<div class="stamp">彩色点为当天快照，颜色即等级：上方是快照时的 BTC 价格，下方是分数。'
    +(rescored?"空心点是旧版时期的快照，用当天记录的五个因子分按新版规则重算（新版只去掉了 Polymarket 计分、其余因子公式未变）。":"")
    +(snaps.length?"":"当前版本尚无每日快照，北京时间 08:00 后第一次评估会记入。")
    +(num(daily.otherVersionDays)>0?" 另有 "+fmt(daily.otherVersionDays)+" 天旧版评分已保存，不与当前版本混用。":"")+'</div>';
}
function renderValidity(daily){
  const hs=(daily&&daily.horizons)||[], min=num(daily&&daily.minSamples)||20;
  if(!hs.length){
    $("validity").innerHTML='<div class="empty">每日快照暂时读取失败。</div>';
    $("validityPill").textContent="暂无数据"; $("validityPill").className="pill"; $("validityNote").textContent="";
    return;
  }
  const ret=v=>'<span class="'+(num(v)<0?"neg":"pos-c")+'">'+frac(v)+'</span>';
  const cell=b=>b&&num(b.n)>0?ret(b.mean)+'<small>下跌 '+Math.round(num(b.downShare)*100)+'% · '+fmt(b.n)+' 天</small>':'—';
  const rows=BANDS.map(([level,label])=>'<tr><td><span class="pill lv-'+level+'">'+esc(label)+'</span></td>'+hs.map(h=>'<td>'+cell((h.bands||[]).find(b=>b.level===level))+'</td>').join("")+'</tr>').join("");
  const all='<tr><td>全部快照</td>'+hs.map(h=>'<td>'+(num(h.matured)>0?ret(h.mean)+'<small>'+fmt(h.matured)+' 天已到期</small>':'<small>尚无到期</small>')+'</td>').join("")+'</tr>';
  const rho='<tr><td>秩相关 ρ<small>负值 = 高分之后更差</small></td>'+hs.map(h=>'<td>'+(Number.isFinite(num(h.spearman))
    ?num(h.spearman).toFixed(2)+'<small>|ρ| ≥ '+(2/Math.sqrt(num(h.matured))).toFixed(2)+' 才算明显</small>'
    :'<small>需 '+min+' 天，现 '+fmt(h.matured)+' 天</small>')+'</td>').join("")+'</tr>';
  $("validity").innerHTML='<table class="vtable"><thead><tr><th>快照分数</th>'+hs.map(h=>'<th>'+fmt(h.days)+' 天后涨跌</th>').join("")+'</tr></thead><tbody>'+rows+all+rho+'</tbody></table>';
  const week=hs.find(h=>num(h.days)===7)||hs[0], r=num(week.spearman), n=num(week.matured), edge=2/Math.sqrt(Math.max(n,1));
  const [text,cls]=!(n>=min)||!Number.isFinite(r)?["样本积累中 · 7 天已到期 "+fmt(n)+" / "+min,"pill"]
    :r<=-edge?["7 天：与模型方向一致","pill lv-green"]:r>=edge?["7 天：与模型方向相反","pill lv-red"]:["7 天：未见明显关系","pill lv-yellow"];
  $("validityPill").textContent=text; $("validityPill").className=cls;
  $("validityNote").textContent="涨跌从快照时的价格算到约 N 天后的 UTC 日收盘，按快照分数分区统计平均涨跌和下跌占比。相邻快照的 7、30 天窗口互相重叠，样本并不独立，显著性会被高估；只统计当前评分规则"+(num(daily.rescoredDays)>0?"（含 "+fmt(daily.rescoredDays)+" 天按新版规则重算的旧版快照）":"")+"，分数不是亏损概率。";
}
function renderDailyTable(daily){
  const rows=((daily&&daily.snapshots)||[]).slice().reverse().slice(0,120);
  if(!rows.length){ $("dailyTable").innerHTML='<div class="empty">当前版本尚无每日快照。</div>'; return; }
  const ret=v=>v==null||!Number.isFinite(num(v))?'<small>未到期</small>':'<span class="'+(num(v)<0?"neg":"pos-c")+'">'+frac(v)+'</span>';
  $("dailyTable").innerHTML='<table class="vtable"><thead><tr><th>日期</th><th>分数</th><th>BTC</th><th>1 天后</th><th>7 天后</th><th>30 天后</th></tr></thead><tbody>'
    +rows.map(r=>{const f=r.forward||{};return '<tr><td>'+esc(r.date)+(r.rescoredFrom?'<small>按新版规则重算（旧版 '+fmt(r.rescoredFrom.score,1)+'）</small>':'')+(r.staleSources&&r.staleSources.length?'<small>部分来源沿用旧值</small>':'')+'</td><td><span class="lv-t-'+lvOf(num(r.score))+'">'+fmt(r.score,1)+'</span></td><td>'+fmt(r.price)+'</td><td>'+ret(f[1])+'</td><td>'+ret(f[7])+'</td><td>'+ret(f[30])+'</td></tr>';}).join("")+'</tbody></table>';
}

const TREND = {LONG:["多头环境","green"],AVOID:["回避环境","orange"]};
function renderTrend(t){
  if(!t){
    $("trendpill").textContent="暂无数据"; $("trendpill").className="pill";
    $("trendstats").innerHTML='<div class="empty">日线数据暂时读取失败或不足 200 天，下一次评估会重试。</div>';
    return;
  }
  const known = TREND[t.state], previous = TREND[t.previous], dist = num(t.distance)*100;
  $("trendpill").textContent = known ? known[0] : "未确定"; $("trendpill").className = known ? "pill lv-"+known[1] : "pill";
  $("trendstats").innerHTML = [
    ["日收盘 "+esc(t.date), fmt(t.close)],
    ["200 日均线", fmt(t.average)],
    ["距均线", '<span class="'+(dist>=0?"pos-c":"neg")+'">'+pct(dist)+'</span>'],
    ["状态开始", t.since ? esc(t.since)+(previous ? "<small>此前为"+previous[0]+"</small>" : "") : "近 100 天内未切换"]
  ].map(([k,v])=>'<div class="stat"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join("");
}

const frac = v => Number.isFinite(num(v)) ? (num(v)>0?"+":"")+(num(v)*100).toFixed(1)+"%" : "—";
function renderObservation(o){
  if(!o){
    $("obsstamp").textContent=""; $("obsinputs").textContent="";
    $("obsrules").innerHTML='<div class="empty">观察所需的数据暂时读取失败，下一次评估会重试。</div>';
    return;
  }
  const i = o.inputs || {}, trend = num(i.trend), macro = num(i.macro);
  $("obsstamp").textContent = "自 "+o.startedAt+" 起记录 · 数据截至 "+o.asOf;
  $("obsinputs").textContent = "今日输入：站上 "+(Number.isFinite(trend) ? Math.round((trend+1)*2) : "—")+"/4 条均线 · 4 周 "+frac(i.r28)
    +" · 资金费率年化 7 日 "+frac(i.funding7)+"、30 日 "+frac(i.funding30)+" · 恐惧贪婪 "+(Number.isFinite(num(i.fng)) ? num(i.fng) : "—")
    +" · 宏观"+(macro===1 ? "顺风（美元、实际利率都在降）" : macro===-1 ? "逆风（美元、实际利率都在升）" : Number.isFinite(macro) ? "分歧" : "暂无数据");
  $("obsrules").innerHTML = (o.rules||[]).map(r => {
    const today = r.today===true ? ['今天触发', r.direction>0 ? "pill lv-green" : "pill lv-orange"] : r.today===false ? ["未触发","pill"] : ["数据不全","pill"];
    const last = r.lastEvent ? esc(r.lastEvent.date)+(r.lastEvent.beforeStart ? "（观察开始前）" : "") : "尚未触发";
    const h = num(r.horizon);
    const result = num(r.matured) > 0
      ? h+" 天：方向正确 "+Math.round(num(r.hit)*100)+"%，平均 "+frac(r.mean)+"（同期随机 "+frac(r.base)+"）"+(r.p!=null ? " · p="+num(r.p).toFixed(2) : "")
      : "还没有到期的触发";
    const crash = r.crashRate!=null ? '<div class="s">30 天内跌超 20%：'+Math.round(num(r.crashRate)*100)+"%（随机 "+(r.baseCrashRate!=null ? Math.round(num(r.baseCrashRate)*100)+"%" : "—")+"）</div>" : "";
    const enough = num(r.matured) >= num(o.minEvents) ? "" : '<div class="s">样本不足：已到期 '+fmt(r.matured)+" / "+fmt(o.minEvents)+" 次</div>";
    return '<article class="obs-item"><div class="obs-head"><b>'+esc(r.label)+'</b><span class="'+today[1]+'">'+today[0]+'</span></div>'
      +'<div class="s">最近触发：'+last+' · 观察开始后 '+fmt(r.events)+' 次</div>'
      +'<div>'+esc(result)+'</div>'+crash+enough
      +'<div class="s">回测：'+esc(r.evidence)+'</div></article>';
  }).join("");
}

function renderLatest(d){
  radar = d;
  dataUsable = !connectionError && !btcRadarFreshness(d).expired;
  renderPressure(d.score);
  $("lvpill").textContent=d.level_name; $("lvpill").className="pill lv-"+lvSafe(d.level);
  $("summary").textContent=d.summary; $("price").textContent=fmt(d.price,1);
  renderPositions(d); renderTrend(d.trend||null); renderObservation(d.observation||null); renderFactors(d.factors||[], d.indicators||{});
  const sources=(d.sources||[]).map(([n,u])=>[n,httpsUrl(u)]).filter(([,u])=>u);
  if(sources.length) $("sources").innerHTML="数据来源："+sources.map(([n,u])=>\`<a href="\${esc(u)}" target="_blank" rel="noopener noreferrer">\${esc(n)}</a>\`).join("、")+"。";
  updateHealth();
}

// Runs independently of payload changes, including after a failed request.
function updateHealth(){
  if(!radar) return;
  const freshness=btcRadarFreshness(radar), t=new Date(radar.ts);
  const stale=(radar.data_status&&radar.data_status.staleSources)||[];
  const wasUsable=dataUsable;
  dataUsable=!connectionError&&!freshness.expired;
  $("stamp").innerHTML='最近评估 <b class="num">'+esc(t.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}))+'</b> · 每 4 小时更新'
    +(freshness.expired?' · <span class="stale">'+(freshness.expiredSources.includes("modelVersion")?'旧版评估已停用，等待新版采集':'数据已过期（五小时有效期），当前结论失效')+'</span>':'')
    +(connectionError==='AUTH'?' · 登录已过期，请<a href="/login">重新登录</a>':connectionError?' · <span class="stale">连接中断，当前结论失效</span>':'')
    +(stale.some(s=>s.since!==null)?' · <span class="stale">沿用旧数据：'+stale.filter(s=>s.since!==null).map(s=>esc(s.label)).join("、")+'</span>':'')
    +(stale.some(s=>s.since===null)?' · <span class="stale">采集失败：'+stale.filter(s=>s.since===null).map(s=>esc(s.label)).join("、")+'</span>':'');
  if(!dataUsable){
    renderPressure(null); $("lvpill").textContent=connectionError?"连接中断":"数据失效"; $("lvpill").className="pill lv-yellow";
    $("summary").textContent="仅保留历史快照，不能用于当前交易判断。";
    $("pospill").textContent="持仓结论失效"; $("pospill").className="pill lv-yellow";
    $("risk").hidden=true; $("ruler").innerHTML="";
    $("trendpill").textContent="历史趋势 · 数据失效"; $("trendpill").className="pill lv-yellow";
    $("accountSummary").textContent="数据失效，当前账户风险未核实。";
    $("accountAlert").hidden=false; $("accountAlert").textContent="数据失效，当前账户风险未核实 · 查看账户风险";
    if(wasUsable) renderFactors(radar.factors||[],radar.indicators||{});
  }else if(activePosition()?.fetchedAt && btcRadarFreshness({ts:activePosition().fetchedAt}).expired){
    renderPosition(activePosition(),radar.price,radar.data_status);
    renderAccountAttention(radar);
  }
}

function renderHist(rows){
  rows=rows.filter(r=>r.modelVersion===radar.modelVersion);
  rows=rows.filter(r=>Number.isFinite(num(r.score))&&Number.isFinite(num(r.price))&&Number.isFinite(Date.parse(r.ts)));
  if(rows.length<2){ $("hist").innerHTML='<div class="empty">当前版本尚不足两次评估；旧版评分不混用。</div>'; return; }
  const W=720,H=220,L=36,R=56,T=14,B=28, n=rows.length;
  const xs=i=>L+(W-L-R)*i/(n-1), ys=v=>T+(H-T-B)*(1-v/100);
  const ps=rows.map(r=>num(r.price)), pmin=Math.min(...ps)*0.995, pmax=Math.max(...ps)*1.005;
  const yp=v=>T+(H-T-B)*(1-(v-pmin)/(pmax-pmin));
  let s="";
  [[70,"var(--crit-bg)",100],[55,"var(--alert-bg)",70],[40,"var(--warn-bg)",55]].forEach(([a,c,b])=>s+=\`<rect x="\${L}" y="\${ys(b)}" width="\${W-L-R}" height="\${ys(a)-ys(b)}" fill="\${c}" opacity=".7"/>\`);
  [0,40,55,70,100].forEach(v=>s+=\`<text x="\${L-6}" y="\${ys(v)+4}" text-anchor="end">\${v}</text>\`);
  [pmin,(pmin+pmax)/2,pmax].forEach(v=>s+=\`<text x="\${W-R+6}" y="\${yp(v)+4}">\${fmt(v/1000,1)}k</text>\`);
  s+=\`<polyline points="\${rows.map((r,i)=>xs(i)+","+yp(num(r.price))).join(" ")}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3"/>\`;
  s+=\`<polyline points="\${rows.map((r,i)=>xs(i)+","+ys(num(r.score))).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>\`;
  const last=rows[n-1]; s+=\`<circle cx="\${xs(n-1)}" cy="\${ys(num(last.score))}" r="4.5" fill="var(--accent)"/>\`;
  const d0=new Date(rows[0].ts), d1=new Date(last.ts), f=d=>d.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",month:"numeric",day:"numeric",hour:"2-digit",hour12:false});
  s+=\`<text x="\${L}" y="\${H-8}">\${esc(f(d0))}</text><text x="\${W-R}" y="\${H-8}" text-anchor="end">\${esc(f(d1))}</text>\`;
  $("hist").innerHTML=\`<svg viewBox="0 0 \${W} \${H}" role="img" aria-label="评分与价格走势">\${s}</svg>
    <div class="stamp">实线：综合评分（左轴）　虚线：BTC 价格（右轴）</div>\`;
}

let busy = false, lastPayload = "";
async function refresh(){
  if(busy || dragging) return; busy = true;
  try{
    const response = await fetch("/api/btc-radar", { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if(response.status === 401){ connectionError='AUTH'; if(radar) updateHealth(); else $("stamp").innerHTML='登录已过期，请<a href="/login">重新登录</a>'; return; }
    if(!response.ok) throw new Error("读取失败");
    const payload = await response.text();
    const recovering=Boolean(connectionError); connectionError=null;
    if(payload === lastPayload){ if(recovering) renderLatest(radar); else updateHealth(); return; }
    const data = JSON.parse(payload);
    if(!["AVAILABLE","STALE"].includes(data.status) || !data.latest){
      if(radar){ connectionError='DATA'; updateHealth(); return; }
      $("stamp").textContent = data.status === "ERROR" ? "评估数据读取失败，稍后刷新再试" : "等待服务器第一次评估写入数据";
      return;
    }
    settings = data.settings || {};
    renderLatest(data.latest); renderHist(data.history||[]); renderScoreHistory(data.daily||null); lastPayload = payload;
  }catch(error){
    connectionError='NETWORK'; updateHealth();
    if(!lastPayload) $("stamp").textContent="暂时读不到评估数据，稍后刷新页面再试";
  }finally{ busy = false; }
}
renderPressure(null);
refresh();
setInterval(() => { updateHealth(); if(!document.hidden) refresh(); }, 60000);
</script>
</body>
</html>`;
}
