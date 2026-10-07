import { dcaScenario, ladderProbability } from "./btc-radar-risk.mjs";
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
:root{--site-width:1120px;
  --ink:var(--text); --accent:var(--blue); --track:#232b36;
  --ok:var(--green); --warn:#e7b94c; --alert:var(--orange); --crit:var(--red);
  --ok-bg:var(--green-soft); --warn-bg:rgba(231,185,76,.13); --alert-bg:rgba(240,160,75,.14); --crit-bg:var(--red-soft);
  --f-body:var(--font); --f-num:var(--font-num)}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{font-size:14px;line-height:1.6;padding-bottom:env(safe-area-inset-bottom,0px)}
a{color:var(--blue)}
a:focus-visible{outline:2px solid var(--brand);outline-offset:3px}
.wrap{max-width:1120px;margin:0 auto;padding-inline:16px;padding-block:20px 48px;display:grid;gap:16px}
.num{font-family:var(--f-num);font-variant-numeric:tabular-nums}
h1{font-size:22px;font-weight:900;margin:0;letter-spacing:.02em}
h2{font-size:13px;font-weight:700;margin:0;color:var(--muted);letter-spacing:.08em;text-wrap:balance}
.top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}
.stamp{color:var(--muted);font-size:12px}
.stamp b{font-weight:500;color:var(--ink)}
.stale{color:var(--crit);font-weight:700}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow)}
.hero{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:16px}
@media (max-width:760px){.hero{grid-template-columns:minmax(0,1fr)}}
.gauge{display:grid;justify-items:center;align-content:start;gap:6px;text-align:center}
.gauge svg{width:100%;max-width:280px;height:auto}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 12px;border-radius:999px;font-weight:700;font-size:13px}
.lv-green{color:var(--ok);background:var(--ok-bg)} .lv-yellow{color:var(--warn);background:var(--warn-bg)}
.lv-orange{color:var(--alert);background:var(--alert-bg)} .lv-red{color:var(--crit);background:var(--crit-bg)}
.summary{font-size:15px;margin:4px 0 0;max-width:30ch}
.price{font-size:13px;color:var(--muted)}
.price b{font-size:18px;color:var(--ink);font-weight:600}
.pos{display:grid;gap:14px;min-width:0}
.pos-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;align-items:center}
.ruler{position:relative;height:88px;margin:4px 8px 0}
.ruler .bar{position:absolute;left:0;right:0;top:40px;height:8px;border-radius:4px;
  background:linear-gradient(90deg,var(--crit) 0%,var(--alert) var(--slp,30%),var(--track) var(--slp,30%),var(--track) 100%)}
.mk{position:absolute;top:0;transform:translateX(-50%);display:grid;justify-items:center;font-size:11px;white-space:nowrap;line-height:1.3}
.mk .t{color:var(--muted)} .mk .v{font-family:var(--f-num);font-size:11px}
.mk .tick{width:2px;height:18px;background:var(--muted);margin-top:2px}
.mk.low{top:auto;bottom:0} .mk.low .tick{order:-1;margin:0 0 2px}
.ruler .now{position:absolute;top:32px;width:4px;height:24px;margin-left:-2px;border-radius:2px;background:var(--accent);box-shadow:0 0 0 2px var(--panel)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.stat{border-top:1px solid var(--line);padding-top:8px}
.stat .k{font-size:12px;color:var(--muted)} .stat .v{font-family:var(--f-num);font-size:16px;font-weight:500}
.neg{color:var(--crit)} .pos-c{color:var(--ok)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
@media (max-width:400px){.grid{grid-template-columns:minmax(0,1fr)}}
.fac{display:grid;gap:10px;border-left-width:4px}
.fac.lv-green-b{border-left-color:var(--ok)} .fac.lv-yellow-b{border-left-color:var(--warn)}
.fac.lv-orange-b{border-left-color:var(--alert)} .fac.lv-red-b{border-left-color:var(--crit)}
.fac-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.fac-head h3{margin:0;font-size:15px;font-weight:700}
.fac-head .w{font-size:11px;color:var(--muted)}
.score{font-family:var(--f-num);font-size:26px;font-weight:600;line-height:1}
.meter{height:6px;background:var(--track);border-radius:3px;overflow:hidden}
.meter i{display:block;height:100%;border-radius:3px}
.kv{display:grid;grid-template-columns:1fr auto;gap:2px 12px;font-size:13px;margin:0}
.kv dt{color:var(--muted)} .kv dd{margin:0;font-family:var(--f-num);text-align:right}
.kv .ref-first{border-top:1px dashed var(--line);padding-top:6px;margin-top:4px}
.ref{margin-left:6px;padding:0 5px;border:1px solid var(--line);border-radius:4px;font-size:10px;color:var(--muted);font-family:var(--f-body)}
.note{font-size:13px;margin:0}
.hist svg{width:100%;height:auto;display:block}
.hist text{fill:var(--muted);font-family:var(--f-num);font-size:11px}
.empty{color:var(--muted);text-align:center;padding:40px 16px}
.method{display:grid;gap:8px;font-size:13px;color:var(--muted)}
.method p{margin:0;max-width:75ch}
.legend{display:flex;flex-wrap:wrap;gap:8px}
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
.btn{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--track);color:var(--ink);cursor:pointer;font:inherit;font-size:13px}
.btn:focus-visible,.capital input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.foot{font-size:12px;color:var(--muted);margin:0}
.trend{display:grid;gap:12px}
.stat .v small{display:block;font-family:var(--f-body);font-size:12px;font-weight:400;color:var(--muted)}
</style>
</head>
<body>
${siteHeader("/btc-radar")}
<main class="wrap">
  <header class="top">
    <h1>BTC 风控雷达</h1>
    <div class="stamp" id="stamp" role="status">正在读取最新评估…</div>
  </header>

  <section class="hero">
    <div class="panel gauge" aria-label="综合风险评分">
      <h2>综合风险评分</h2>
      <svg viewBox="-12 0 264 140" id="gauge" role="img" aria-label="评分仪表"></svg>
      <span class="pill" id="lvpill">—</span>
      <p class="summary" id="summary">等待第一次评估写入数据。</p>
      <div class="price">BTC 现价 <b class="num" id="price">—</b></div>
    </div>
    <div class="panel pos">
      <div class="pos-head">
        <h2 id="poshead">合约马丁格尔 · BTCUSDT 永续 做多</h2>
        <span class="pill" id="pospill">—</span>
      </div>
      <div class="ruler" id="ruler"></div>
      <div class="stamp">蓝色竖线是现价，红橙色段是止损以下的危险区。拖动「止损」「止盈」可以预览调整后的结果，不会修改 OKX。</div>
      <div class="stats" id="posstats"></div>
      <div class="risk" id="risk" hidden></div>
    </div>
  </section>

  <section class="panel trend" aria-label="趋势状态">
    <div class="pos-head">
      <h2>趋势状态 · 200 日均线</h2>
      <span class="pill" id="trendpill">—</span>
    </div>
    <div class="stats" id="trendstats"></div>
    <p class="foot">日收盘高于 200 日均线 3% 以上为多头环境，低于 3% 以下为回避环境，在 ±3% 之内维持原状态；状态切换时推送飞书。回避只表示不持有多头，不是做空信号。回测（2022 年以来，现货、次日执行、含手续费）：按此规则持有的最大回撤 −39%，一直持有为 −67%；其他常见的多空信号没有通过同样的检验。</p>
  </section>

  <section class="grid" id="factors"></section>

  <section class="panel hist">
    <h2>评分走势</h2>
    <div id="hist"><div class="empty">累计两次以上的评估后，这里会画出评分和 BTC 价格的走势。</div></div>
  </section>

  <section class="panel method">
    <h2>怎么读这个评分</h2>
    <div class="legend">
      <span class="pill lv-green">0–39 偏多 / 低风险</span><span class="pill lv-yellow">40–54 中性</span>
      <span class="pill lv-orange">55–69 警戒</span><span class="pill lv-red">70–100 高风险</span>
    </div>
    <p>分数越高，BTC 下跌的压力越大。六个因子各自打 0–100 分，按权重加总：预测市场 25%、美联储利率预期 20%、美债收益率 20%、BTC 技术面 15%、黄金 10%、衍生品与情绪 10%。</p>
    <p>「参考」标记的指标只展示、不计入评分：RSI(14) 按 OKX BTC-USDT 的 UTC 日线以 Wilder 方法计算，分别给出已收盘和含当日盘中的读数；恐惧贪婪指数来自 alternative.me。</p>
    <p>持仓警报单独计算：现价离止损不到 5% 为橙色，不到 3% 为红色。服务器每 4 小时自动评估一次（北京时间每 4 小时的第 43 分），综合等级升高、持仓接近止损、自动补仓增加或策略状态变化时推送飞书；200 日均线趋势状态切换时另发一条。</p>
    <p id="sources">数据来源：Polymarket、美国财政部、OKX。</p>
    <p>评分是对公开数据的机械汇总，用来提醒你该去看盘了，不预测价格，也不构成投资建议。</p>
  </section>
</main>
<script nonce="${nonce}">
const $ = id => document.getElementById(id);
const LV = {green:"var(--ok)",yellow:"var(--warn)",orange:"var(--alert)",red:"var(--crit)"};
const LEVELS = new Set(Object.keys(LV));
const lvOf = s => s>=70?"red":s>=55?"orange":s>=40?"yellow":"green";
const lvSafe = v => LEVELS.has(v) ? v : "yellow";
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const fmt = (n,d=0) => Number.isFinite(num(n)) ? num(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}) : "—";
const pct = n => Number.isFinite(num(n)) ? (num(n)>0?"+":"")+num(n).toFixed(2)+"%" : "—";
const esc = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const httpsUrl = u => { try { const url = new URL(String(u)); return url.protocol === "https:" ? url.href : null; } catch { return null; } };
${ladderProbability.toString()}
${dcaScenario.toString()}
let radar = null, settings = {}, preview = {}, dragging = null, scale = null;

function gauge(score){
  const cx=120, cy=120, r=96;
  const pt = (v,rr)=>{const a=Math.PI*(1-v/100);return [cx+rr*Math.cos(a), cy-rr*Math.sin(a)]};
  const arc=(a,b,col)=>{const [x1,y1]=pt(a,r),[x2,y2]=pt(b,r);return \`<path d="M\${x1} \${y1} A\${r} \${r} 0 0 1 \${x2} \${y2}" stroke="\${col}" stroke-width="16" fill="none"/>\`};
  let s = arc(0,39.5,LV.green)+arc(40.5,54.5,LV.yellow)+arc(55.5,69.5,LV.orange)+arc(70.5,100,LV.red);
  [0,40,55,70,100].forEach(v=>{const [x,y]=pt(v,r+18);s+=\`<text x="\${x}" y="\${y+4}" text-anchor="middle" font-size="10" fill="var(--muted)" font-family="IBM Plex Mono,monospace">\${v}</text>\`});
  const value = num(score);
  if(Number.isFinite(value)){const clamped=Math.max(0,Math.min(100,value)), [nx,ny]=pt(clamped,r-22);
    s+=\`<line x1="\${cx}" y1="\${cy}" x2="\${nx}" y2="\${ny}" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/><circle cx="\${cx}" cy="\${cy}" r="6" fill="var(--ink)"/>\`;
    s+=\`<text x="\${cx}" y="\${cy-30}" text-anchor="middle" font-size="34" font-weight="600" fill="var(--ink)" font-family="IBM Plex Mono,monospace">\${Math.round(clamped)}</text>\`;}
  $("gauge").innerHTML=s;
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
    $("pospill").textContent="未接入持仓";$("pospill").className="pill";$("ruler").innerHTML="";risk.hidden=true;
    $("posstats").innerHTML='<div class="empty">'+(status&&status.okxConfigured?"没有正在运行的 BTC-USDT 永续合约马丁格尔。":"服务器尚未配置 OKX 只读 API Key，持仓与舆情暂未接入。")+'</div>';
    return;
  }
  $("poshead").textContent="合约马丁格尔 · BTCUSDT 永续 "+(Number.isFinite(num(p.lever))?num(p.lever)+"x ":"")+"做多";
  $("pospill").textContent=p.level_name; $("pospill").className="pill lv-"+lvSafe(p.level);
  scale = rulerScale(p, price);
  const x = v => (v - scale.lo) / (scale.hi - scale.lo) * 100;
  const stop = effective("sl", p), target = effective("tp", p);
  let h = '<div class="bar" id="dangerBar" style="--slp:' + (stop > 0 ? x(stop) : 0).toFixed(1) + '%"></div>';
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
  const st=[["现价",fmt(price,1),""],["距止损",num(p.sl)>0?pct(p.d_sl):"未设置止损",num(p.sl)>0&&num(p.d_sl)>-5?"neg":""],["距强平",pct(p.d_liq),""],["距止盈",pct(p.d_tp),""],
    ["策略总收益",Number.isFinite(pnl)?(pnl>0?"+":"")+fmt(pnl,2)+" USDT":"—",pnl<0?"neg":"pos-c"],
    ["自动补仓",fmt(p.safety_filled)+" / "+fmt(p.safety_max)+(num(p.manual_adds)>0?" · 手动 "+fmt(p.manual_adds):""),""],
    ["本周触及止损概率",p.p_sl_week!=null&&Number.isFinite(num(p.p_sl_week))?Math.round(num(p.p_sl_week)*100)+"%":"—",""],
    ["本周触及止盈概率",p.p_tp_week!=null&&Number.isFinite(num(p.p_tp_week))?Math.round(num(p.p_tp_week)*100)+"%":"—",""]];
  $("posstats").innerHTML=st.map(([k,v,c])=>'<div class="stat"><div class="k">'+k+'</div><div class="v '+c+'">'+esc(v)+'</div></div>').join("");
  const capital = num(settings.capitalUsdt) > 0 ? num(settings.capitalUsdt) : "";
  risk.hidden = false;
  risk.innerHTML = '<div id="riskBody"></div>'
    + '<div class="capital"><label for="capitalInput">总资金</label><input id="capitalInput" inputmode="decimal" autocomplete="off" placeholder="例如 5000" value="' + esc(capital) + '"> USDT <button class="btn" id="saveCapital" type="button">保存</button><span id="capitalStatus" role="status"></span></div>'
    + '<p class="foot">' + (p.ladder && p.ladder.complete ? "" : "补仓挂单数据暂缺，最坏亏损可能偏低。") + '按 0.05% 吃单手续费、0.4% 维持保证金率估算，未计滑点。总资金只用于计算占比，保存在服务器上。</p>';
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
  const low = kind === "sl" ? scale.lo : num(price) * 1.001;
  const high = kind === "sl" ? num(price) * 0.999 : scale.hi;
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
  if(radar) renderPosition(radar.position, radar.price, radar.data_status);
}

function renderRisk(p, price){
  const s = dcaScenario({ position: p, price: num(price), stop: effective("sl", p), takeProfit: effective("tp", p), capitalUsdt: num(settings.capitalUsdt) > 0 ? num(settings.capitalUsdt) : null });
  const week = (radar && radar.ladders && radar.ladders.week) || {};
  const touchStop = s.stop ? ladderProbability(week.dips, s.stop) : null;
  const touchTarget = s.takeProfit ? ladderProbability(week.reaches, s.takeProfit) : null;
  const share = v => v == null ? "填写总资金后显示占比" : "约占总资金 " + (v * 100).toFixed(1) + "%";
  const chance = v => v == null ? "—" : Math.round(v * 100) + "%";
  const previewing = preview.sl != null || preview.tp != null;
  const items = [
    ["止损触发时", s.lossAtStop == null ? "未设置止损" : "-" + fmt(s.lossAtStop, 1) + " USDT", s.lossAtStop == null ? "最坏情况是被强平" : share(s.lossShare),
      "会先成交 " + s.fills + " 笔补仓，仓位 " + fmt(s.worstSize, 4) + " BTC，均价 " + fmt(s.worstAverage)],
    ["止盈触发时", s.profitAtTarget == null ? "—" : (s.profitAtTarget > 0 ? "+" : "") + fmt(s.profitAtTarget, 1) + " USDT", share(s.profitShare),
      "均价上方 " + pct(s.targetFromAverage * 100) + " · 距现价 " + pct(s.targetDistance * 100)],
    ["补仓全部成交后的强平价", s.worstLiquidation ? "约 " + fmt(s.worstLiquidation) : "—",
      s.stopAboveLiquidation == null ? "" : s.stopAboveLiquidation > 0 ? "止损高于强平 " + (s.stopAboveLiquidation * 100).toFixed(1) + "%" : "止损低于估算强平价，会先被强平",
      s.stop ? "止损距现价 " + pct(s.stopDistance * 100) : ""],
    ["打平所需止盈比例", s.breakevenWinRate == null ? "—" : (s.breakevenWinRate * 100).toFixed(1) + "%", "按一次止损对一次止盈计算", ""],
    ["本周触及概率", "止损 " + chance(touchStop) + " · 止盈 " + chance(touchTarget), "Polymarket 本周触价盘插值", ""]
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
    if(radar && radar.position) renderRisk(radar.position, radar.price);
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
  $("factors").innerHTML=F.map(f=>{const score=num(f.score), lv=lvOf(score), refs=referenceRows(f.key, indicators);return \`<article class="panel fac lv-\${lv}-b">
    <div class="fac-head"><div><h3>\${esc(f.name)}</h3><span class="w">权重 \${fmt(f.weight)}%</span></div><span class="score" style="color:\${LV[lv]}">\${fmt(score)}</span></div>
    <div class="meter"><i style="width:\${Math.max(0,Math.min(100,score||0))}%;background:\${LV[lv]}"></i></div>
    <dl class="kv">\${(f.metrics||[]).map(([k,v])=>\`<dt>\${esc(k)}</dt><dd>\${esc(v)}</dd>\`).join("")}\${refs.map(([k,v],i)=>\`<dt class="\${i?"":"ref-first"}">\${esc(k)}<span class="ref">参考</span></dt><dd class="\${i?"":"ref-first"}">\${esc(v)}</dd>\`).join("")}</dl>
    <p class="note">\${esc(f.note)}</p></article>\`}).join("");
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

function renderLatest(d){
  radar = d;
  gauge(d.score);
  $("lvpill").textContent=d.level_name; $("lvpill").className="pill lv-"+lvSafe(d.level);
  $("summary").textContent=d.summary; $("price").textContent=fmt(d.price,1);
  const t=new Date(d.ts), age=(Date.now()-t)/3.6e6;
  const stale=(d.data_status&&d.data_status.staleSources)||[];
  $("stamp").innerHTML=\`最近评估 <b class="num">\${esc(t.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}))}</b>\`+(age>5?\` · <span class="stale">已超过 \${Math.floor(age)} 小时未更新</span>\`:" · 每 4 小时更新")
    +(stale.length?\` · <span class="stale">沿用旧数据：\${stale.map(s=>esc(s.label)).join("、")}</span>\`:"");
  renderPosition(d.position,d.price,d.data_status); renderTrend(d.trend||null); renderFactors(d.factors||[], d.indicators||{});
  const sources=(d.sources||[]).map(([n,u])=>[n,httpsUrl(u)]).filter(([,u])=>u);
  if(sources.length) $("sources").innerHTML="数据来源："+sources.map(([n,u])=>\`<a href="\${esc(u)}" target="_blank" rel="noopener noreferrer">\${esc(n)}</a>\`).join("、")+"。";
}

function renderHist(rows){
  rows=rows.filter(r=>Number.isFinite(num(r.score))&&Number.isFinite(num(r.price))&&Number.isFinite(Date.parse(r.ts)));
  if(rows.length<2) return;
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
    if(response.status === 401){ $("stamp").innerHTML='登录已过期，请<a href="/login">重新登录</a>'; return; }
    if(!response.ok) throw new Error("读取失败");
    const payload = await response.text();
    if(payload === lastPayload) return;
    const data = JSON.parse(payload);
    if(data.status !== "AVAILABLE" || !data.latest){
      $("stamp").textContent = data.status === "ERROR" ? "评估数据读取失败，稍后刷新再试" : "等待服务器第一次评估写入数据";
      return;
    }
    settings = data.settings || {};
    renderLatest(data.latest); renderHist(data.history||[]); lastPayload = payload;
  }catch(error){
    if(!lastPayload) $("stamp").textContent="暂时读不到评估数据，稍后刷新页面再试";
  }finally{ busy = false; }
}
gauge(null);
refresh();
setInterval(() => { if(!document.hidden) refresh(); }, 60000);
</script>
</body>
</html>`;
}
