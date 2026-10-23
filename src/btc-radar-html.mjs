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
.layer-nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
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
@media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.account-layout{grid-template-columns:minmax(0,1fr)}.account-boundary{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}}
@media(max-width:600px){.wrap{padding:20px 12px 36px}.layer-nav{gap:6px}.layer-nav a{padding:10px;gap:6px;min-height:66px}.layer-nav b{font-size:12px}.layer-nav small{font-size:10px}.layer-nav .index{display:none}.grid{grid-template-columns:minmax(0,1fr)}.panel{padding:16px}.layer{scroll-margin-top:16px}.layer-heading .tag{font-size:10px}.context-top{padding:16px}.context-note{font-size:12px}.pressure-row{grid-template-columns:minmax(0,1fr);gap:12px}.trend .stats{grid-template-columns:repeat(2,minmax(0,1fr))}.trend .stat .v{font-size:19px}.account-boundary{grid-template-columns:minmax(0,1fr)}.pos-head{align-items:flex-start}.pos-head h2{max-width:100%;overflow-wrap:anywhere}.obs-grid{grid-template-columns:minmax(0,1fr)}.disclosure>summary small{display:block;margin:4px 0 0 16px}}
@media(prefers-reduced-motion:reduce){.layer-nav a,.site-nav a{transition:none}}
</style>
</head>
<body>
${siteHeader("/btc-radar")}
<main class="wrap">
  <header class="top">
    <div><p class="eyebrow">BTC / READ-ONLY RADAR</p><h1>BTC 风控雷达</h1><p class="subtitle">市场发生了什么 · 长期环境如何 · 账户暴露在哪里</p></div>
    <div class="page-meta"><span class="tag readonly">只读 · 不下单</span><span class="tag">4h 快照 · 非实时保护</span></div>
  </header>
  <nav class="layer-nav" aria-label="雷达三层导航">
    <a href="#market-background"><span class="index">01</span><span><b>市场背景</b><small>宏观、行情与盘口</small></span></a>
    <a href="#slow-trend"><span class="index">02</span><span><b>慢趋势</b><small>200 日均线环境</small></span></a>
    <a href="#account-risk"><span class="index">03</span><span><b>账户风险</b><small>持仓与强平边界</small></span></a>
  </nav>
  <div class="health-bar"><div class="stamp" id="stamp" role="status">正在读取最新评估…</div></div>
  <a id="accountAlert" class="account-alert" href="#account-risk" aria-live="polite" hidden></a>

  <section id="market-background" class="layer" aria-labelledby="market-background-title">
    <div class="layer-heading"><div><div class="layer-title"><span class="index">01</span><h2 id="market-background-title">市场背景</h2></div><p>先看原始指标；背景变化不等于交易信号。</p></div><span class="tag">观察层 / 非预测</span></div>
    <div class="context-top">
      <div class="price">BTC / USDT · 采集时点价格<b class="num" id="price">—</b></div>
      <p class="context-note">宏观、技术面与衍生品分开阅读。Polymarket 是各自合约区间的原始报价，不代表从现在开始的触价概率。</p>
    </div>
    <div class="grid" id="factors"></div>
    <details id="experimental-pressure" class="disclosure">
      <summary>实验性压力指数与历史<small>未验证预测力 · 默认收起</small></summary>
      <div class="detail-body">
        <div class="pressure-row">
          <div><div class="pressure-label">下跌压力指数 / 非风险概率</div><div class="pressure-number"><span id="pressureValue">—</span><small> / 100</small></div></div>
          <div><span class="pill" id="lvpill">—</span><p class="summary" id="summary">等待第一次评估写入数据。</p></div>
        </div>
        <div class="hist" id="hist"><div class="empty">等待同版本评估历史。</div></div>
        <div class="method"><p>这是未验证的下跌压力指数，不是亏损概率、低风险证明或多空交易信号。Polymarket 不计分；其余五因子按原相对权重 20:20:15:10:10 归一化。新版评分与旧版历史不连线比较。</p><p>「参考」指标不计分：RSI(14) 使用 OKX UTC 日线和 Wilder 平滑；恐惧贪婪指数来自 alternative.me。因子解释是模型假设，不是已经核实的因果关系。</p></div>
      </div>
    </details>
  </section>

  <section id="slow-trend" class="layer" aria-labelledby="slow-trend-title">
    <div class="layer-heading"><div><div class="layer-title"><span class="index">02</span><h2 id="slow-trend-title">慢趋势</h2></div><p>判断日级环境，不猜下一根 K 线。</p></div><span class="tag">UTC 已收盘日线</span></div>
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
    <div class="layer-heading"><div><div class="layer-title"><span class="index">03</span><h2 id="account-risk-title">账户风险</h2></div><p id="accountSummary">等待只读账户快照，当前风险未核实。</p></div><span class="tag readonly">OKX / 只读</span></div>
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

function renderFactors(F, indicators){
  F=F.filter(f=>f.key!=="poly"||radar.modelVersion==="pressure-v2-no-touch-probability");
  $("factors").innerHTML=F.map(f=>{const score=dataUsable?num(f.score):NaN, refs=referenceRows(f.key, indicators);return \`<article class="panel fac">
    <div class="fac-head"><h3>\${esc(f.name)}</h3><span class="tag">\${f.weight>0?"背景数据":"原始盘口"}</span></div>
    <dl class="kv">\${(f.metrics||[]).map(([k,v])=>\`<dt>\${esc(k)}</dt><dd>\${esc(v)}</dd>\`).join("")}\${refs.map(([k,v],i)=>\`<dt class="\${i?"":"ref-first"}">\${esc(k)}<span class="ref">参考</span></dt><dd class="\${i?"":"ref-first"}">\${esc(v)}</dd>\`).join("")}</dl>
    <details class="factor-method"><summary>\${f.weight>0?"模型解释 · 未验证":"盘口说明 · 不计分"}<span class="num">\${f.weight>0?fmt(score)+" / 100":"仅报价"}</span></summary>
    <p class="note">\${esc(f.note)}</p>\${f.weight>0?'<p class="note">相对权重 '+fmt(f.weight)+'；不是风险概率。</p>':''}</details></article>\`}).join("");
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
    renderLatest(data.latest); renderHist(data.history||[]); lastPayload = payload;
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
