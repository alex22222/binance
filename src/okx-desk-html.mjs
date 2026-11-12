import { falsifierOf, gateOf, present } from "./okx-desk-ledger.mjs";
import { SITE_CSS, siteHeader } from "./site-shell.mjs";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const KIND_LABEL = { idea: "有点子", watch: "弱关注", review: "复验", flat: "无信号", note: "记录", chart: "图表", strategy: "策略", risk: "风控", coverage: "覆盖" };
const GROUPS = [
  ["idea", "有点子"],
  ["watch", "弱关注"],
  ["review", "复验"],
  ["chart", "图表"],
  ["strategy", "策略"],
  ["risk", "风控"]
];

function shanghai(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)).replace(/\//g, "-");
}

function countText(value) {
  return value === null || value === undefined ? "—" : String(value);
}

function chips(row) {
  const gate = row.kind === "coverage" ? "" : gateOf(row.idea);
  return gate ? `<ul class="desk-chips"><li>${escapeHtml(gate)}</li></ul>` : "";
}

function facts(pairs) {
  const rows = pairs.filter(([, value]) => present(value));
  if (!rows.length) return "";
  return `<dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function card(row) {
  const falsifier = falsifierOf(row.idea) || falsifierOf(row.evidence);
  const when = `${String(row.hour).padStart(2, "0")}:${String(row.minute).padStart(2, "0")}`;
  return `<article class="desk-card" data-kind="${escapeHtml(row.kind)}">
<header><h3>${escapeHtml(row.symbol || "—")}</h3><span class="desk-pill ${escapeHtml(row.kind)}">${KIND_LABEL[row.kind] || "记录"}</span><span class="desk-role">${escapeHtml(row.role)}</span><time>${when}</time></header>
<p>${escapeHtml(row.idea)}</p>
${row.kind === "coverage" ? "" : chips(row)}
${facts([
  ["评分", row.score === null ? "" : String(row.score)],
  ["状态", row.status],
  ["风控", row.riskDecision],
  ["入场", row.entry],
  ["止损", row.stop],
  ["目标", row.target],
  ["影子仓位", row.size],
  ["风险%", row.riskPct],
  ["影子结果", row.result],
  ["否决条件", falsifier],
  ["教训", row.lesson]
])}
${present(row.evidence) ? `<details><summary>证据与来源</summary><p>${escapeHtml(row.evidence)}</p></details>` : ""}
</article>`;
}

function summaryBlock(note) {
  return `<article class="desk-summary"><h3>${escapeHtml(note.heading)}</h3><pre>${escapeHtml(note.text)}</pre></article>`;
}

function detail(ledger, shift) {
  const roles = [...new Set(shift.rows.map((row) => row.role))];
  const later = ["策略师", "风控"].filter((role) => !roles.includes(role));
  const hidden = shift.rows.filter((row) => row.kind === "flat" || row.kind === "note");
  const coverageRows = shift.rows.filter((row) => row.kind === "coverage");
  const reports = ledger.reports?.notes?.[shift.date] || [];
  const sourceNote = shift.counts.source === "scan" ? "数字取自本班覆盖行原文" : "覆盖行没有写出个数，按标的行归类计数";
  return `<p class="desk-back"><a href="/crypto/desk">全部班次</a></p>
<header class="desk-head"><div><p class="desk-kicker">${shift.kind === "scheduled" ? "定时班次 · Asia/Shanghai" : "非定时记录 · Asia/Shanghai"}</p><h1>${escapeHtml(shift.label)}</h1><p>${escapeHtml(sourceNote)}。${later.length ? `本班日志没有${later.join("、")}行。` : "本班日志含后续角色行。"}</p></div>
<span class="desk-pill ${shift.breaker === "已触发" ? "risk" : "watch"}">熔断${shift.breaker ? escapeHtml(shift.breaker) : "未写"}</span></header>
<section class="desk-counts" aria-label="本班计数"><div><span>有点子</span><strong>${countText(shift.counts.ideas)}</strong></div><div><span>弱关注</span><strong>${countText(shift.counts.watch)}</strong></div><div><span>无信号</span><strong>${countText(shift.counts.none)}</strong></div></section>
${coverageRows.length ? `<section><h2>覆盖</h2><div class="desk-stack">${coverageRows.map(card).join("")}</div></section>` : ""}
${GROUPS.map(([kind, label]) => {
  const rows = shift.rows.filter((row) => row.kind === kind);
  if (!rows.length) return "";
  const stated = kind === "idea" ? shift.counts.ideas : kind === "watch" ? shift.counts.watch : null;
  const note = shift.counts.source === "scan" && stated !== null && stated !== rows.length
    ? `<p class="desk-lead">覆盖行写${label} ${stated}。下面 ${rows.length} 行是日志原行，一行里可以有多只标的。</p>` : "";
  return `<section><h2>${label}</h2>${note}<div class="desk-stack">${rows.map(card).join("")}</div></section>`;
}).join("")}
${hidden.length ? `<details class="desk-fold"><summary>无信号与其他记录（${hidden.length}）</summary><div class="desk-stack">${hidden.map(card).join("")}</div></details>` : ""}
${shift.summaries.length ? `<section><h2>班次摘要</h2>${shift.summaries.map(summaryBlock).join("")}</section>` : ""}
${shift.plans.length ? `<section><h2>策略计划明细</h2>${shift.plans.map(summaryBlock).join("")}</section>` : ""}
${reports.length ? `<section><h2>同日日报里写到影子台的句子</h2>${reports.map((sentence) => `<p class="desk-report">${escapeHtml(sentence)}</p>`).join("")}</section>` : ""}`;
}

function index(ledger) {
  const dates = [...new Set(ledger.shifts.map((shift) => shift.date))].reverse();
  const status = Object.entries(ledger.status || {});
  const loose = ledger.loose || [];
  const body = dates.map((date) => {
    const shifts = ledger.shifts.filter((shift) => shift.date === date).slice().reverse();
    return `<tbody><tr class="desk-day"><th colspan="6">${escapeHtml(date)}</th></tr>${shifts.map((shift) => `<tr><td><a href="/crypto/desk?shift=${encodeURIComponent(shift.id)}">${escapeHtml(shift.kind === "scheduled" ? shift.slot : shift.label.slice(11))}</a>${shift.kind === "manual" ? '<small>非定时</small>' : ""}</td><td class="num">${countText(shift.counts.ideas)}</td><td class="num">${countText(shift.counts.watch)}</td><td class="num">${countText(shift.counts.none)}</td><td>${shift.breaker ? escapeHtml(shift.breaker) : "—"}</td><td>${escapeHtml(shift.summaryLine || "日志没有一句话摘要")}</td></tr>`).join("")}</tbody>`;
  }).join("");
  return `${status.length ? `<dl class="desk-status">${status.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : ""}
${ledger.capital ? `<p class="desk-capital">${escapeHtml(ledger.capital)}</p>` : ""}
${ledger.shifts.length ? `<div class="desk-table"><table><thead><tr><th>班次</th><th>有点子</th><th>弱关注</th><th>无信号</th><th>熔断</th><th>一句话</th></tr></thead>${body}</table></div>` : `<p class="desk-empty">影子日志里没有可显示的班次。</p>`}
${loose.length ? `<section><h2>未归入班次的摘要</h2>${loose.map(summaryBlock).join("")}</section>` : ""}`;
}

export function okxDeskHtml(ledger, { shiftId = "", unknown = false, theme = "light" } = {}) {
  const shift = shiftId ? ledger.shifts.find((item) => item.id === shiftId) : null;
  const missing = unknown || (Boolean(shiftId) && !shift);
  const source = ledger.source || { kind: "unavailable", label: "影子日志不可读", readAt: "" };
  const themeAttr = theme === "dark" ? ' data-theme="dark"' : "";
  return `<!doctype html><html lang="zh-CN"${themeAttr}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>交易过程 · HQ Capital</title><style>${SITE_CSS}
:root{--content-width:1180px}*{box-sizing:border-box}body{font-size:14px;line-height:1.6}
.desk{max-width:var(--content-width);margin:0 auto;padding:28px 20px 64px}.desk h1,.desk h2,.desk h3,.desk p{margin:0}.desk h1{font-size:30px;letter-spacing:-.03em;line-height:1.25}.desk h2{margin:28px 0 12px;font-size:18px}.desk a{color:var(--brand);text-decoration:none}.desk a:hover{text-decoration:underline}.desk :is(a,summary):focus-visible{outline:2px solid var(--brand);outline-offset:3px}
.desk-kicker{font-size:12px;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}.desk-head,.desk-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:18px}.desk-head p,.desk-lead{color:var(--muted);font-size:13px;margin-top:8px}
.desk-status{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 16px;margin:0 0 14px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.desk-status div{min-width:0}.desk-status dt{color:var(--muted);font-size:12px}.desk-status dd{margin:0}
.desk-capital{color:var(--muted);font-size:13px;margin-bottom:16px}
.desk-counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:8px 0 4px}.desk-counts div{padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.desk-counts span{display:block;color:var(--muted);font-size:12px}.desk-counts strong{font-size:28px;font-weight:650;font-variant-numeric:tabular-nums}
.desk-table{overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface)}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:11px 14px;border-bottom:1px solid var(--line-soft);vertical-align:top}th{font-size:12px;font-weight:600;color:var(--muted);background:var(--surface-2);white-space:nowrap}.desk-table :is(th,td):nth-child(-n+5){white-space:nowrap}td small{display:block;color:var(--muted);font-size:11px}.desk-day th{color:var(--text);background:var(--surface);font-size:13px}tr:hover td{background:var(--surface-2)}.num{font-variant-numeric:tabular-nums}
.desk-stack{display:grid;gap:12px}.desk-card,.desk-summary,.desk-report{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:14px 16px}.desk-card header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}.desk-card h3{font-size:16px}.desk-card time,.desk-role{color:var(--muted);font-size:12px}.desk-card p,.desk-summary pre,.desk-report{white-space:pre-wrap;overflow-wrap:anywhere}.desk-summary pre{margin:8px 0 0;font:13px/1.6 var(--font)}
.desk-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--radius-pill);background:var(--surface-3);color:var(--muted);font-size:12px;font-weight:650}.desk-pill.idea{color:var(--green);background:var(--green-soft)}.desk-pill.watch,.desk-pill.review{color:var(--gold);background:var(--gold-soft)}.desk-pill.chart{color:var(--blue);background:var(--blue-soft)}.desk-pill.risk,.desk-pill.flat{color:var(--red);background:var(--red-soft)}
.desk-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;padding:0;list-style:none}.desk-chips li{padding:2px 8px;border-radius:var(--radius-pill);background:var(--surface-2);color:var(--muted);font-size:12px}
.desk-card dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px;margin:12px 0 0}.desk-card dl div{min-width:0}.desk-card dt{color:var(--muted);font-size:12px}.desk-card dd{margin:0;overflow-wrap:anywhere}
.desk-card details,.desk-fold{margin-top:10px}.desk-card summary,.desk-fold>summary{cursor:pointer;color:var(--muted);font-size:13px}.desk-fold{margin-top:22px}.desk-back{margin-bottom:12px}.desk-empty,.desk-missing{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
@media(max-width:760px){.desk{padding:22px 12px 40px}.desk h1{font-size:26px}.desk-head,.desk-top{display:block}.desk-status,.desk-counts,.desk-card dl{grid-template-columns:1fr}.desk-head .desk-pill{margin-top:12px}}
@media print{.desk-back{display:none}.desk-card,.desk-summary{break-inside:avoid}}
</style></head><body>${siteHeader("/crypto/desk", "", { theme, returnTo: shiftId ? `/crypto/desk?shift=${encodeURIComponent(shiftId)}` : "/crypto/desk" })}<main class="desk">
${shift ? "" : `<header class="desk-top"><div><p class="desk-kicker">数字货币 · 阶段1影子</p><h1>交易过程</h1><p class="desk-lead">侦察 → 图表 → 策略 → 风控。只读班次记录，不连接下单。</p></div></header>`}
<p class="desk-lead">来源：${escapeHtml(source.label)}${source.readAt ? ` · 读取 ${shanghai(source.readAt)}` : ""}</p>
${missing ? `<p class="desk-missing">没有这一班。下面仍是日志里的班次。</p>${index(ledger)}` : shift ? detail(ledger, shift) : index(ledger)}
</main></body></html>`;
}
