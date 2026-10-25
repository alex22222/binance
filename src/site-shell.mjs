// Shared look for every dashboard page: design tokens, the page background,
// and the top navigation. Each page puts SITE_CSS first in its <style> and
// renders siteHeader() as the first element of <body>. The brand mark is text,
// so the header also renders under CSPs that block images.

// Links in display order. Consecutive links naming the same group (third field)
// share one dropdown in the bar, labelled with that group name.
const WALLET_GROUP = "币安Agent Wallet";
export const SITE_NAV = Object.freeze([
  ["/assets", "个人资产"],
  ["/dashboard", "交易总览", WALLET_GROUP],
  ["/strategies", "策略", WALLET_GROUP],
  ["/reviews", "复盘", WALLET_GROUP],
  ["/fund-manager", "基金经理", WALLET_GROUP],
  ["/operations", "运行总览", WALLET_GROUP],
  ["/btc-radar", "BTC 风控"],
  ["/gmgn/", "GMGN"],
  ["https://polyhermes.107-191-42-75.sslip.io/future-btc5m-bridge", "polymarket"]
]);

// `actions` is page-owned trusted markup shown on the right of the bar.
export function siteHeader(active, actions = "") {
  // "/" now lands on personal assets and the trading dashboard lives at
  // /dashboard, but that page (part of the Live code identity) still says "/".
  const current = active === "/" ? "/dashboard" : active;
  const link = ([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`;
  let links = "";
  for (let index = 0; index < SITE_NAV.length;) {
    const group = SITE_NAV[index][2];
    if (!group) { links += link(SITE_NAV[index++]); continue; }
    const members = [];
    while (index < SITE_NAV.length && SITE_NAV[index][2] === group) members.push(SITE_NAV[index++]);
    // A <details> menu needs no script, so it works under every page's CSP.
    const here = members.some(([href]) => href === current);
    links += `<details class="site-group${here ? " is-current" : ""}"><summary>${group}</summary><div class="site-submenu">${members.map(link).join("")}</div></details>`;
  }
  return `<header class="site-header"><div class="site-bar">`
    + `<a class="site-brand" href="/"><span class="site-mark" aria-hidden="true">H</span><span class="site-name">HQ Capital</span></a>`
    + `<nav class="site-nav" aria-label="主导航">${links}</nav>`
    + (actions ? `<div class="site-actions">${actions}</div>` : "")
    + `</div></header>`;
}

// Light (Mercury-style neutrals, indigo accent) is every page's default. The
// original dark look stays available to a page that sets
// <html data-theme="dark">, as the assets page does from its theme toggle.
const LIGHT_TOKENS = `color-scheme:light;
--bg:#f7f7fa;--surface:#fff;--surface-2:#f7f7fa;--surface-3:#ececf2;--line:#e4e4eb;--line-soft:#efeff4;
--text:#171721;--muted:#6b6b78;--faint:#9a9aa6;
--brand:#5266eb;--brand-strong:#3d52d9;--brand-ink:#fff;--brand-soft:rgba(82,102,235,.08);
--green:#1f9d55;--red:#d92d3a;--blue:#007aff;--orange:#e8830c;
--green-soft:rgba(31,157,85,.1);--red-soft:rgba(217,45,58,.08);--blue-soft:rgba(0,122,255,.08);
--shadow:0 16px 40px rgba(23,23,33,.1);--panel-shadow:0 1px 2px rgba(23,23,33,.04);
--gold:#b7791f;--gold-soft:rgba(183,121,31,.1)`;
const DARK_TOKENS = `color-scheme:dark;
--bg:#07090d;--surface:#11151c;--surface-2:#171d26;--surface-3:#1c2430;--line:#29313d;--line-soft:rgba(255,255,255,.08);
--text:#f5f7fa;--muted:#8f9baa;--faint:#5f6b7a;
--brand:#f5c14f;--brand-strong:#f8d27a;--brand-ink:#171108;--brand-soft:rgba(245,193,79,.12);
--green:#51d6a3;--red:#ff6c78;--blue:#78a9ff;--orange:#f0a04b;
--green-soft:rgba(81,214,163,.12);--red-soft:rgba(255,108,120,.12);--blue-soft:rgba(120,169,255,.12);
--shadow:0 18px 48px rgba(0,0,0,.24);--panel-shadow:var(--shadow);
--gold:var(--brand);--gold-soft:var(--brand-soft)`;

// Page styles still carry colors written for the dark look. Each block below
// re-points them for the light theme on one page only, keyed by that page's
// active nav link (or login form), so shared class names cannot collide. The
// :not([data-theme=dark]) prefix also outranks the page's own later rules.
const onPage = (href) => `html:not([data-theme=dark]) body:has(.site-nav a[aria-current][href="${href}"])`;
const PAGE_LIGHT_CSS = `
${onPage("/dashboard")} :is(.panel,.approval-summary){border-color:var(--line);background:var(--surface)}
${onPage("/dashboard")} .wallet-login{border-color:rgba(217,45,58,.4)}
${onPage("/dashboard")} :is(.top-asset-trend,.top-stat,.signal-ticker,.policy-item){background:var(--surface);border-color:var(--line);box-shadow:none}
${onPage("/dashboard")} :is(.badge,.section-refresh,.signal-stage:not(.failed,.passed,.pending),.signal-table-head,.timeline-filters,.approval-addresses,.event-raw pre,.workflow-step){background:var(--surface-2)}
${onPage("/dashboard")} .workflow-step.active{background:var(--gold-soft)}
${onPage("/dashboard")} .approval-count{background:var(--surface-3)}
${onPage("/dashboard")} :is(.control-button:not(.stop,.resume,.auto-on),.section-refresh):hover{border-color:var(--faint);background:var(--surface-3)}
${onPage("/dashboard")} :is(.asset-trend-tooltip,.signal-stage-tooltip){background:rgba(255,255,255,.97);box-shadow:var(--shadow)}
${onPage("/dashboard")} :is(.approval-button.reject,.control-button.auto-on,.control-button.stop){color:var(--red)}
${onPage("/dashboard")} :is(.signal-strong,.has-approval .approval-count,.wallet-login a,.approval-button.approve){color:#fff}
${onPage("/dashboard")} .approval-check{color:#7a5410}
${onPage("/dashboard")} :is(.lead,.event time,.event-raw){color:var(--muted)}
${onPage("/dashboard")} :is(.signal,.signal-journey){border-color:var(--line-soft)}
${onPage("/dashboard")} .signal:hover{background:rgba(0,122,255,.04)}
${onPage("/dashboard")} .timeline-filter.active{background:var(--surface);box-shadow:0 1px 3px rgba(23,23,33,.12)}
${onPage("/dashboard")} .section-head::after{background:linear-gradient(90deg,var(--line),transparent)}
${onPage("/dashboard")} .empty{background:none}
${onPage("/strategies")} .badge{color:var(--blue);border-color:rgba(0,122,255,.25);background:var(--blue-soft)}
${onPage("/strategies")} .badge.gold{color:var(--gold);border-color:rgba(183,121,31,.3);background:var(--gold-soft)}
${onPage("/strategies")} .badge.green{color:var(--green);border-color:rgba(31,157,85,.3);background:var(--green-soft)}
${onPage("/strategies")} :is(.evidence-tabs,th){background:var(--surface-2)}
${onPage("/strategies")} :is(.evidence-tabs button:not([aria-pressed="true"]),.fact p,.insight p,.thesis,.verdict p){color:var(--muted)}
${onPage("/strategies")} .insight{border-left-color:var(--line)}
${onPage("/strategies")} .secondary:hover{border-color:var(--faint)}
${onPage("/strategies")} .strategy-item:hover{background:var(--surface-2)}
${onPage("/strategies")} .verdict{border-color:rgba(183,121,31,.3);border-left-color:var(--gold);background:var(--gold-soft)}
${onPage("/fund-manager")} .badge{border-color:rgba(82,102,235,.3)}
${onPage("/fund-manager")} .hero{background:linear-gradient(135deg,rgba(82,102,235,.06),transparent 60%),var(--surface)}
${onPage("/fund-manager")} section:first-of-type{border-color:rgba(82,102,235,.25)}
${onPage("/fund-manager")} aside a{color:var(--muted)}
${onPage("/fund-manager")} li{color:var(--text)}
${onPage("/btc-radar")}{--track:#e4e4eb;--warn:#b7791f;--warn-bg:rgba(183,121,31,.12);--alert-bg:rgba(232,131,12,.12)}
html:not([data-theme=dark]) body:has(form[action="/login"]) input{border-color:var(--line);background:var(--surface)}
html:not([data-theme=dark]) body:has(form[action="/login"]) label{color:var(--muted)}
html:not([data-theme=dark]) body:has(form[action="/login"]) .error{color:var(--red)}
`;

export const SITE_CSS = `
:root{${LIGHT_TOKENS};
--radius:14px;--radius-sm:9px;
--font:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
--font-num:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--panel:var(--surface);--panel-2:var(--surface-2);--panel-raised:var(--surface-2)}
:root[data-theme=dark]{${DARK_TOKENS}}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;color:var(--text);font-family:var(--font);background:var(--bg)}
[data-theme=dark] body{background:radial-gradient(circle at 15% -8%,rgba(245,193,79,.1),transparent 31rem),radial-gradient(circle at 95% 26%,rgba(120,169,255,.06),transparent 34rem),linear-gradient(rgba(255,255,255,.012) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.012) 1px,transparent 1px),var(--bg);
background-size:auto,auto,32px 32px,32px 32px,auto;background-attachment:fixed}
.site-header{position:sticky;top:0;z-index:20;padding:10px 16px 0;background:linear-gradient(var(--bg) 0%,rgba(247,247,250,.92) 70%,transparent)}
[data-theme=dark] .site-header{background:linear-gradient(var(--bg) 0%,rgba(7,9,13,.92) 70%,transparent)}
.site-bar{max-width:var(--site-width,1440px);margin:0 auto;min-height:58px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:8px 12px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.88);box-shadow:0 1px 2px rgba(23,23,33,.04);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}
[data-theme=dark] .site-bar{border-color:var(--line-soft);background:rgba(14,18,24,.88);box-shadow:0 12px 38px rgba(0,0,0,.22)}
.site-brand{display:flex;align-items:center;gap:10px;color:var(--text);font-size:15px;font-weight:750;text-decoration:none;white-space:nowrap}
.site-mark{width:34px;height:34px;display:grid;place-items:center;border-radius:11px;background:var(--brand);color:var(--brand-ink);font-weight:900}
[data-theme=dark] .site-mark{box-shadow:0 0 24px rgba(245,193,79,.18)}
.site-nav{display:flex;align-items:center;gap:4px;min-width:0;flex-wrap:wrap}
.site-nav::-webkit-scrollbar{display:none}
.site-nav a{padding:8px 12px;border-radius:var(--radius-sm);color:var(--muted);font-size:13px;font-weight:650;text-decoration:none;white-space:nowrap;transition:color .15s,background-color .15s}
.site-nav a:hover{color:var(--text);background:rgba(23,23,33,.05);text-decoration:none}
[data-theme=dark] .site-nav a:hover{background:rgba(255,255,255,.05)}
.site-nav a[aria-current]{color:var(--brand);background:var(--brand-soft)}
.site-brand:focus-visible,.site-nav a:focus-visible,.site-group>summary:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.site-group{position:relative}
.site-group>summary{display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:var(--radius-sm);color:var(--muted);font-size:13px;font-weight:650;white-space:nowrap;cursor:pointer;list-style:none;transition:color .15s,background-color .15s}
.site-group>summary::-webkit-details-marker{display:none}
.site-group>summary::after{content:"";width:6px;height:6px;margin-top:-3px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg)}
.site-group>summary:hover{color:var(--text);background:rgba(23,23,33,.05)}
[data-theme=dark] .site-group>summary:hover{background:rgba(255,255,255,.05)}
.site-group.is-current>summary{color:var(--brand);background:var(--brand-soft)}
.site-submenu{display:none;position:absolute;left:0;top:calc(100% + 6px);z-index:40;min-width:168px;padding:6px;border:1px solid var(--line);border-radius:12px;background:var(--surface);box-shadow:var(--shadow);flex-direction:column;gap:2px}
.site-group[open] .site-submenu{display:flex}
.site-submenu a{display:block}
/* With a mouse the menu follows hover and focus, so a click never leaves it stuck open. */
@media (hover:hover) and (pointer:fine){.site-group[open] .site-submenu{display:none}.site-group:hover .site-submenu,.site-group:focus-within .site-submenu{display:flex}.site-group::after{content:"";position:absolute;left:0;right:0;top:100%;height:8px}}
.site-actions{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
@media (max-width:760px){
.site-header{position:static;padding:calc(8px + env(safe-area-inset-top)) 12px 0}
.site-bar{gap:8px;padding:8px 10px}
.site-nav{order:2;width:100%}
.site-actions{order:3;width:100%;margin-left:0}
}
@media print{.site-header{display:none}}
${PAGE_LIGHT_CSS}`;
