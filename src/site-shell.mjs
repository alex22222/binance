// Shared look for every dashboard page: design tokens, the page background,
// and the top navigation. Each page puts SITE_CSS first in its <style> and
// renders siteHeader() as the first element of <body>. The brand mark is text,
// so the header also renders under CSPs that block images.

// Links in display order. Consecutive links naming the same group (third field)
// share one dropdown in the bar, labelled with that group name.
const WALLET_GROUP = "智能钱包";
const CRYPTO_GROUP = "数字货币";
export const SITE_NAV = Object.freeze([
  ["/market", "市场总览"],
  ["/assets", "个人资产"],
  ["/dashboard", "交易总览", WALLET_GROUP],
  ["/agentic-wallet/okx", "OKX 钱包", WALLET_GROUP],
  ["/strategies", "策略", WALLET_GROUP],
  ["/reviews", "复盘", WALLET_GROUP],
  ["/fund-manager", "基金经理", WALLET_GROUP],
  ["/operations", "运行总览", WALLET_GROUP],
  ["/crypto", "BTC 与收藏", CRYPTO_GROUP],
  ["/crypto/desk", "交易过程", CRYPTO_GROUP],
  ["/gmgn/", "GMGN", CRYPTO_GROUP],
  ["https://poly.spaceflag.site/future-btc5m-bridge", "Poly 跟单"],
  ["https://polym.trade/perps", "Polymtrade"]
]);

export const THEME_COOKIE = "hq-theme";

export function themeFromCookie(cookieHeader = "") {
  const match = String(cookieHeader).match(/(?:^|;\s*)hq-theme=(dark|light)(?:;|$)/);
  return match?.[1] === "dark" ? "dark" : "light";
}

export function themeToggleHref(nextTheme, nextPath = "/") {
  const path = typeof nextPath === "string" && nextPath.startsWith("/") && !nextPath.startsWith("//")
    ? nextPath
    : "/";
  return `/api/theme?set=${nextTheme === "dark" ? "dark" : "light"}&next=${encodeURIComponent(path)}`;
}

function themeToggleControl(theme, activePath) {
  const dark = theme === "dark";
  const href = themeToggleHref(dark ? "light" : "dark", activePath || "/");
  const label = dark ? "明亮模式" : "深色模式";
  return `<a class="site-theme" href="${href}" aria-label="${label}">${label}</a>`;
}

// `actions` is page-owned trusted markup shown on the right of the bar.
// Pass `theme` so the toggle can offer the opposite mode; default light.
const SITE_SETTINGS = (theme, activePath) => `<details class="site-group site-settings"><summary>设置</summary><div class="site-submenu">${themeToggleControl(theme, activePath)}<a href="/assets?settings=refresh-schedule">资产自动更新</a><a href="/assets?settings=statement-passwords">结单密码</a><a href="/assets">资产导入、同步与备份</a></div></details>`;

export function siteHeader(active, actions = "", { theme = "light" } = {}) {
  // "/" now lands on market overview and the trading dashboard lives at
  // /dashboard, but that page (part of the Live code identity) still says "/".
  const current = active === "/" ? "/dashboard" : active === "/btc-radar" ? "/crypto" : active;
  const link = ([href, label]) => {
    const external = href.startsWith("https://");
    const text = external ? `${label} ↗` : label;
    return `<a href="${href}"${href === current ? ' aria-current="page"' : ""}${external ? ' class="site-external" target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
  };
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
  const right = actions || SITE_SETTINGS(theme, current);
  return `<header class="site-header"><div class="site-bar">`
    + `<a class="site-brand" href="/"><span class="site-mark" aria-hidden="true">H</span><span class="site-name">HQ Capital</span></a>`
    + `<nav class="site-nav" aria-label="主导航">${links}</nav>`
    + `<div class="site-actions">${right}</div>`
    + `</div></header>`;
}

// One brand hue for light and dark (cool indigo workbench). Amber stays
// semantic warning gold — it is never the brand in either theme.
const LIGHT_TOKENS = `color-scheme:light;
--bg:#f4f5f9;--surface:#fff;--surface-2:#f7f8fc;--surface-3:#eceef5;--line:#e2e4ee;--line-soft:#eef0f6;
--text:#171721;--muted:#5c5e6e;--faint:#9294a3;
--brand:#5266eb;--brand-strong:#3d52d9;--brand-ink:#fff;--brand-soft:rgba(82,102,235,.1);
--green:#1f9d55;--red:#d92d3a;--blue:#007aff;--orange:#e8830c;
--green-soft:rgba(31,157,85,.1);--red-soft:rgba(217,45,58,.08);--blue-soft:rgba(0,122,255,.08);
--shadow:0 16px 40px rgba(23,23,33,.08);--panel-shadow:0 1px 2px rgba(23,23,33,.04);
--gold:#b7791f;--gold-soft:rgba(183,121,31,.1)`;
const DARK_TOKENS = `color-scheme:dark;
--bg:#0a0c12;--surface:#12151e;--surface-2:#181c28;--surface-3:#1e2433;--line:#2a3142;--line-soft:rgba(255,255,255,.08);
--text:#f2f4f8;--muted:#8b93a7;--faint:#5e6678;
--brand:#7b8cff;--brand-strong:#9aa6ff;--brand-ink:#0c1020;--brand-soft:rgba(123,140,255,.14);
--green:#51d6a3;--red:#ff6c78;--blue:#78a9ff;--orange:#f0a04b;
--green-soft:rgba(81,214,163,.12);--red-soft:rgba(255,108,120,.12);--blue-soft:rgba(120,169,255,.12);
--shadow:0 18px 48px rgba(0,0,0,.28);--panel-shadow:0 1px 2px rgba(0,0,0,.2);
--gold:#e2b857;--gold-soft:rgba(226,184,87,.12)`;

// Live dashboard and a few dark-era pages still hard-code panel colors.
// Keep a thin light-theme remap until those pages move onto tokens.
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
html:not([data-theme=dark]) body:has(form[action="/login"]) input{border-color:var(--line);background:var(--surface);color:var(--text)}
html:not([data-theme=dark]) body:has(form[action="/login"]) label{color:var(--muted)}
html:not([data-theme=dark]) body:has(form[action="/login"]) .error{color:var(--red);background:var(--red-soft)}
`;

export const SITE_CSS = `
:root{${LIGHT_TOKENS};
--nav-width:1280px;--content-width:1180px;--site-width:var(--nav-width);
--radius:12px;--radius-sm:8px;--radius-pill:6px;
--font:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
--font-num:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--text-eyebrow:10px;--text-h1:30px;--text-h2:18px;--text-body:14px;--text-meta:12px;
--panel:var(--surface);--panel-2:var(--surface-2);--panel-raised:var(--surface-2)}
:root[data-theme=dark]{${DARK_TOKENS}}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;color:var(--text);font-family:var(--font);font-size:var(--text-body);line-height:1.6;background:
  radial-gradient(ellipse 80% 50% at 10% -10%,rgba(82,102,235,.07),transparent 50%),
  radial-gradient(ellipse 60% 40% at 100% 0%,rgba(0,122,255,.04),transparent 45%),
  var(--bg);
transition:background-color .2s ease,color .2s ease}
[data-theme=dark] body{background:
  radial-gradient(ellipse 70% 45% at 12% -8%,rgba(123,140,255,.12),transparent 48%),
  radial-gradient(ellipse 55% 40% at 96% 8%,rgba(120,169,255,.06),transparent 42%),
  linear-gradient(rgba(255,255,255,.012) 1px,transparent 1px),
  linear-gradient(90deg,rgba(255,255,255,.012) 1px,transparent 1px),
  var(--bg);
background-size:auto,auto,32px 32px,32px 32px,auto;background-attachment:fixed}
.site-header{position:sticky;top:0;z-index:20;padding:10px 16px 0;background:linear-gradient(var(--bg) 0%,rgba(244,245,249,.92) 70%,transparent);transition:box-shadow .2s ease,border-color .2s ease}
[data-theme=dark] .site-header{background:linear-gradient(var(--bg) 0%,rgba(10,12,18,.92) 70%,transparent)}
.site-bar{max-width:var(--nav-width);margin:0 auto;min-height:58px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:8px 12px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.88);box-shadow:0 1px 2px rgba(23,23,33,.04);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}
[data-theme=dark] .site-bar{border-color:var(--line-soft);background:rgba(14,18,24,.88);box-shadow:0 12px 38px rgba(0,0,0,.22)}
.site-brand{display:flex;align-items:center;gap:10px;color:var(--text);font-size:15px;font-weight:750;text-decoration:none;white-space:nowrap}
.site-mark{width:34px;height:34px;display:grid;place-items:center;border-radius:11px;background:var(--brand);color:var(--brand-ink);font-weight:900;transition:box-shadow .2s ease}
[data-theme=dark] .site-mark{box-shadow:0 0 20px rgba(123,140,255,.22)}
.site-nav{display:flex;align-items:center;gap:4px;min-width:0;flex-wrap:wrap}
.site-nav::-webkit-scrollbar{display:none}
.site-nav a{padding:8px 12px;border-radius:var(--radius-sm);color:var(--muted);font-size:13px;font-weight:650;text-decoration:none;white-space:nowrap;transition:color .15s,background-color .15s}
.site-nav a:hover{color:var(--text);background:rgba(23,23,33,.05);text-decoration:none}
[data-theme=dark] .site-nav a:hover{background:rgba(255,255,255,.05)}
.site-nav a[aria-current]{color:var(--brand);background:var(--brand-soft)}
.site-nav a.site-external{color:var(--faint);font-weight:600}
.site-brand:focus-visible,.site-nav a:focus-visible,.site-group>summary:focus-visible,.site-theme:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
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
@media (hover:hover) and (pointer:fine){.site-group[open] .site-submenu{display:none}.site-group:hover .site-submenu,.site-group:focus-within .site-submenu{display:flex}.site-group::after{content:"";position:absolute;left:0;right:0;top:100%;height:8px}}
.site-settings .site-submenu{left:auto;right:0}.site-settings .site-submenu a,.site-settings .site-submenu .site-theme{box-sizing:border-box;display:block;padding:10px 12px;min-height:40px;border-radius:8px;color:var(--text);font-size:13px;text-decoration:none;white-space:nowrap}.site-settings .site-submenu a:hover,.site-settings .site-submenu .site-theme:hover{background:var(--surface-2)}.site-settings .site-submenu a:focus-visible,.site-settings .site-submenu .site-theme:focus-visible{outline:2px solid var(--brand);outline-offset:-2px}
.site-actions{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.site-status,.site-tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--radius-pill);font-size:var(--text-meta);font-weight:650;white-space:nowrap;border:1px solid transparent}
.site-status{background:var(--surface-3);color:var(--muted)}.site-status.ok{color:var(--green);background:var(--green-soft)}.site-status.bad{color:var(--red);background:var(--red-soft)}.site-status.warn{color:var(--gold);background:var(--gold-soft)}.site-status.info{color:var(--blue);background:var(--blue-soft)}
.site-tag{background:var(--brand-soft);color:var(--brand)}
@media (max-width:760px){
.site-header{position:static;padding:calc(8px + env(safe-area-inset-top)) 12px 0}
.site-bar{gap:8px;padding:8px 10px}
.site-nav{order:2;width:100%}
.site-actions{order:3;width:100%;margin-left:0}.site-actions:has(.site-settings){order:1;width:auto;margin-left:auto}.site-settings .site-submenu a,.site-settings .site-submenu .site-theme{min-height:44px}
}
@media print{.site-header{display:none}}
${PAGE_LIGHT_CSS}`;
