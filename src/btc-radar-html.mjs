// BTC risk radar page, migrated from the claude.ai artifact. Data comes from
// /api/btc-radar, written every four hours by scripts/run-btc-radar.mjs.
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
:root{
  --bg:#0f1514; --panel:#161e1d; --ink:#e4ebe9; --muted:#93a29f; --line:#2a3634;
  --accent:#5cc4bc; --track:#25302e;
  --ok:#5fc283; --warn:#e2b54a; --alert:#f08a4b; --crit:#f0645d;
  --ok-bg:#183126; --warn-bg:#33291a; --alert-bg:#3a2417; --crit-bg:#3d1c1b;
  --f-body:"Noto Sans SC",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  --f-num:"IBM Plex Mono",ui-monospace,"SFMono-Regular",Menlo,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{background:var(--bg);color:var(--ink);font-family:var(--f-body);font-size:14px;line-height:1.6;margin:0;padding-bottom:env(safe-area-inset-bottom,0px)}
a{color:var(--accent)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.topbar{display:flex;align-items:center;gap:28px;min-height:60px;padding:0 20px;border-bottom:1px solid var(--line);background:var(--panel)}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);font-weight:700;font-size:17px;text-decoration:none;white-space:nowrap}
.brand img{width:24px;height:24px}
.topbar nav{display:flex;align-self:stretch;gap:20px;overflow-x:auto;scrollbar-width:none}
.topbar nav a{display:flex;align-items:center;color:var(--muted);text-decoration:none;font-weight:600;white-space:nowrap;border-bottom:3px solid transparent}
.topbar nav a[aria-current]{color:var(--accent);border-color:var(--accent)}
@media (max-width:640px){.topbar{gap:14px;padding:0 14px}.brand span{display:none}.topbar nav{gap:14px}}
.wrap{max-width:1120px;margin:0 auto;padding-inline:16px;padding-block:20px 48px;display:grid;gap:16px}
.num{font-family:var(--f-num);font-variant-numeric:tabular-nums}
h1{font-size:22px;font-weight:900;margin:0;letter-spacing:.02em}
h2{font-size:13px;font-weight:700;margin:0;color:var(--muted);letter-spacing:.08em;text-wrap:balance}
.top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}
.stamp{color:var(--muted);font-size:12px}
.stamp b{font-weight:500;color:var(--ink)}
.stale{color:var(--crit);font-weight:700}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}
.hero{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:16px}
@media (max-width:760px){.hero{grid-template-columns:minmax(0,1fr)}}
.gauge{display:grid;justify-items:center;gap:6px;text-align:center}
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
.note{font-size:13px;margin:0}
.hist svg{width:100%;height:auto;display:block}
.hist text{fill:var(--muted);font-family:var(--f-num);font-size:11px}
.empty{color:var(--muted);text-align:center;padding:40px 16px}
.method{display:grid;gap:8px;font-size:13px;color:var(--muted)}
.method p{margin:0;max-width:75ch}
.legend{display:flex;flex-wrap:wrap;gap:8px}
</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><img src="/favicon.svg" alt=""><span>Agentic Wallet</span></a>
  <nav aria-label="主导航"><a href="/">仪表盘</a><a href="/strategies">策略</a><a href="/reviews">复盘</a><a href="/fund-manager">基金经理</a><a href="/btc-radar" aria-current="page">BTC 风控</a></nav>
</header>
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
      <div class="stamp">青色竖线是现价，红橙色段是止损以下的危险区。</div>
      <div class="stats" id="posstats"></div>
    </div>
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
    <p>持仓警报单独计算：现价离止损不到 5% 为橙色，不到 3% 为红色。服务器每 4 小时自动评估一次（北京时间每 4 小时的第 43 分），综合等级升高、持仓接近止损、自动补仓增加或策略状态变化时推送飞书。</p>
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

function renderPosition(p, price, status){
  if(!p){
    $("pospill").textContent="未接入持仓";$("pospill").className="pill";$("ruler").innerHTML="";
    $("posstats").innerHTML='<div class="empty">'+(status&&status.okxConfigured?"没有正在运行的 BTC-USDT 永续合约马丁格尔。":"服务器尚未配置 OKX 只读 API Key，持仓与舆情暂未接入。")+'</div>';
    return;
  }
  $("poshead").textContent="合约马丁格尔 · BTCUSDT 永续 "+(Number.isFinite(num(p.lever))?num(p.lever)+"x ":"")+"做多";
  $("pospill").textContent=p.level_name; $("pospill").className="pill lv-"+lvSafe(p.level);
  const values=[p.liq,p.sl,p.next_safety,p.avg,p.tp,price].map(num).filter(v=>Number.isFinite(v)&&v>0);
  const lo=Math.min(...values)*0.985, hi=Math.max(...values)*1.01, x=v=>((v-lo)/(hi-lo)*100);
  const marks=[["强平",p.liq,"low"],["止损",p.sl,""],["下次补仓",p.next_safety,"low"],["均价",p.avg,""],["止盈",p.tp,"low"]];
  let h=\`<div class="bar" style="--slp:\${(num(p.sl)>0?x(num(p.sl)):0).toFixed(1)}%"></div>\`;
  const tf=v=>{const q=x(v);return q>88?"translateX(-90%)":q<12?"translateX(-10%)":"translateX(-50%)"};
  marks.forEach(([t,v,c])=>{ const n=num(v); if(Number.isFinite(n)&&n>0) h+=\`<div class="mk \${c}" style="left:\${x(n).toFixed(2)}%;transform:\${tf(n)}"><span class="t">\${t}</span><span class="v">\${fmt(n)}</span><span class="tick"></span></div>\`});
  if(Number.isFinite(num(price))) h+=\`<div class="now" style="left:\${x(num(price)).toFixed(2)}%" title="现价 \${fmt(price)}"></div>\`;
  $("ruler").innerHTML=h;
  const pnl=num(p.total_pnl);
  const st=[["现价",fmt(price,1),""],["距止损",num(p.sl)>0?pct(p.d_sl):"未设置止损",num(p.sl)>0&&num(p.d_sl)>-5?"neg":""],["距强平",pct(p.d_liq),""],["距止盈",pct(p.d_tp),""],
    ["策略总收益",Number.isFinite(pnl)?(pnl>0?"+":"")+fmt(pnl,2)+" USDT":"—",pnl<0?"neg":"pos-c"],
    ["自动补仓",\`\${fmt(p.safety_filled)} / \${fmt(p.safety_max)}\`,""],
    ["本周触及止损概率",p.p_sl_week!=null&&Number.isFinite(num(p.p_sl_week))?Math.round(num(p.p_sl_week)*100)+"%":"—",""],
    ["本周触及止盈概率",p.p_tp_week!=null&&Number.isFinite(num(p.p_tp_week))?Math.round(num(p.p_tp_week)*100)+"%":"—",""]];
  $("posstats").innerHTML=st.map(([k,v,c])=>\`<div class="stat"><div class="k">\${k}</div><div class="v \${c}">\${esc(v)}</div></div>\`).join("");
}

function renderFactors(F){
  $("factors").innerHTML=F.map(f=>{const score=num(f.score), lv=lvOf(score);return \`<article class="panel fac lv-\${lv}-b">
    <div class="fac-head"><div><h3>\${esc(f.name)}</h3><span class="w">权重 \${fmt(f.weight)}%</span></div><span class="score" style="color:\${LV[lv]}">\${fmt(score)}</span></div>
    <div class="meter"><i style="width:\${Math.max(0,Math.min(100,score||0))}%;background:\${LV[lv]}"></i></div>
    <dl class="kv">\${(f.metrics||[]).map(([k,v])=>\`<dt>\${esc(k)}</dt><dd>\${esc(v)}</dd>\`).join("")}</dl>
    <p class="note">\${esc(f.note)}</p></article>\`}).join("");
}

function renderLatest(d){
  gauge(d.score);
  $("lvpill").textContent=d.level_name; $("lvpill").className="pill lv-"+lvSafe(d.level);
  $("summary").textContent=d.summary; $("price").textContent=fmt(d.price,1);
  const t=new Date(d.ts), age=(Date.now()-t)/3.6e6;
  const stale=(d.data_status&&d.data_status.staleSources)||[];
  $("stamp").innerHTML=\`最近评估 <b class="num">\${esc(t.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}))}</b>\`+(age>5?\` · <span class="stale">已超过 \${Math.floor(age)} 小时未更新</span>\`:" · 每 4 小时更新")
    +(stale.length?\` · <span class="stale">沿用旧数据：\${stale.map(s=>esc(s.label)).join("、")}</span>\`:"");
  renderPosition(d.position,d.price,d.data_status); renderFactors(d.factors||[]);
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
  if(busy) return; busy = true;
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
