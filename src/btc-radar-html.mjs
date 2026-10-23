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
.obs{display:grid;gap:12px}
.obs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.obs-item{border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:grid;gap:4px;align-content:start;font-size:13px}
.obs-item .obs-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.obs-item .s{color:var(--muted);font-size:12px}
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
    <div class="panel gauge" aria-label="下跌压力指数（未验证）">
      <h2>下跌压力指数 · 未验证预测力</h2>
      <svg viewBox="-12 0 264 140" id="gauge" role="img" aria-label="评分仪表"></svg>
      <span class="pill" id="lvpill">—</span>
      <p class="summary" id="summary">等待第一次评估写入数据。</p>
      <div class="price">BTC 快照价 <b class="num" id="price">—</b></div>
    </div>
    <div class="panel pos">
      <div class="pos-head">
        <h2 id="poshead">OKX · BTCUSDT 永续持仓</h2>
        <span class="pill" id="pospill">—</span>
      </div>
      <div id="positionList" class="stats"></div>
      <label class="stamp" id="positionPicker" hidden>查看持仓 <select id="positionSelect" class="btn" aria-label="选择 BTC 持仓"></select></label>
      <div class="ruler" id="ruler"></div>
      <div class="stamp" id="rulerHelp"></div>
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

  <section class="panel obs" aria-label="观察模式">
    <div class="pos-head">
      <h2>观察模式 · 只记录，不推送</h2>
      <span class="stamp" id="obsstamp"></span>
    </div>
    <p class="foot" id="obsinputs"></p>
    <div class="obs-grid" id="obsrules"></div>
    <p class="foot">这些候选信号在调研中没有通过 2022 年以后的检验。服务器每天按 UTC 日收盘检查一次，记录每次触发，以及之后 7、30、90 天的涨跌（从次日收盘算起），再与同期随机日子比较。某条规则要在观察开始后积累至少 10 次到期的触发、并且明显好于随机（p&lt;0.05），才值得考虑改为推送。</p>
  </section>

  <section class="grid" id="factors"></section>

  <section class="panel hist">
    <h2>评分走势</h2>
    <div id="hist"><div class="empty">累计两次以上的评估后，这里会画出评分和 BTC 价格的走势。</div></div>
  </section>

  <section class="panel method">
    <h2>怎么读这个评分</h2>
    <div class="legend">
      <span class="pill lv-green">0–39 下跌压力较低（非低风险）</span><span class="pill lv-yellow">40–54 中性</span>
      <span class="pill lv-orange">55–69 警戒</span><span class="pill lv-red">70–100 高风险</span>
    </div>
    <p>这是未验证的下跌压力指数，不是亏损概率、低风险证明或多空交易信号。Polymarket 触价盘只展示原始报价，不再计分或插值为未来概率；其余五因子按原相对权重 20:20:15:10:10 归一化。新版评分与旧版历史不连线比较。</p>
    <p>「参考」标记的指标只展示、不计入评分：RSI(14) 按 OKX BTC-USDT 的 UTC 日线以 Wilder 方法计算，分别给出已收盘和含当日盘中的读数；恐惧贪婪指数来自 alternative.me。</p>
    <p>持仓警报优先检查强平是否先于止损，以及距强平是否不足 3%/5%，再检查止损距离；未知或旧数据不宣称安全。服务器每 4 小时评估一次，五小时后评估或评分输入失效；不是实时持仓保护，不会自动下单。等级升高、持仓高危、自动补仓或策略状态变化时推送飞书；200 日均线切换另发一条。</p>
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
}

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
  $("factors").innerHTML=F.map(f=>{const score=dataUsable?num(f.score):NaN, lv=Number.isFinite(score)?lvOf(score):"yellow", refs=referenceRows(f.key, indicators);return \`<article class="panel fac lv-\${lv}-b">
    <div class="fac-head"><div><h3>\${esc(f.name)}</h3><span class="w">\${f.weight>0?"相对权重 "+fmt(f.weight):"参考 · 不计分"}</span></div><span class="score" style="color:\${Number.isFinite(score)?LV[lv]:"var(--muted)"}">\${fmt(score)}</span></div>
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
  gauge(d.score);
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
    gauge(null); $("lvpill").textContent=connectionError?"连接中断":"数据失效"; $("lvpill").className="pill lv-yellow";
    $("summary").textContent="仅保留历史快照，不能用于当前交易判断。";
    $("pospill").textContent="持仓结论失效"; $("pospill").className="pill lv-yellow";
    $("risk").hidden=true; $("ruler").innerHTML="";
    $("trendpill").textContent="历史趋势 · 数据失效"; $("trendpill").className="pill lv-yellow";
    if(wasUsable) renderFactors(radar.factors||[],radar.indicators||{});
  }else if(activePosition()?.fetchedAt && btcRadarFreshness({ts:activePosition().fetchedAt}).expired){
    renderPosition(activePosition(),radar.price,radar.data_status);
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
gauge(null);
refresh();
setInterval(() => { updateHealth(); if(!document.hidden) refresh(); }, 60000);
</script>
</body>
</html>`;
}
