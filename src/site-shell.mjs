// Shared look for every dashboard page: design tokens, the page background,
// and the top navigation. Each page puts SITE_CSS first in its <style> and
// renders siteHeader() as the first element of <body>. The brand mark is text,
// so the header also renders under CSPs that block images.

export const SITE_NAV = Object.freeze([
  ["/", "仪表盘"],
  ["/strategies", "策略"],
  ["/reviews", "复盘"],
  ["/fund-manager", "基金经理"],
  ["/btc-radar", "BTC 风控"],
  ["/gmgn/", "GMGN"]
]);

// `actions` is page-owned trusted markup shown on the right of the bar.
export function siteHeader(active, actions = "") {
  const links = SITE_NAV
    .map(([href, label]) => `<a href="${href}"${href === active ? ' aria-current="page"' : ""}>${label}</a>`)
    .join("");
  return `<header class="site-header"><div class="site-bar">`
    + `<a class="site-brand" href="/"><span class="site-mark" aria-hidden="true">A</span><span class="site-name">Agentic Wallet</span></a>`
    + `<nav class="site-nav" aria-label="主导航">${links}</nav>`
    + (actions ? `<div class="site-actions">${actions}</div>` : "")
    + `</div></header>`;
}

export const SITE_CSS = `
:root{color-scheme:dark;
--bg:#07090d;--surface:#11151c;--surface-2:#171d26;--surface-3:#1c2430;--line:#29313d;--line-soft:rgba(255,255,255,.08);
--text:#f5f7fa;--muted:#8f9baa;--faint:#5f6b7a;
--brand:#f5c14f;--brand-strong:#f8d27a;--brand-ink:#171108;--brand-soft:rgba(245,193,79,.12);
--green:#51d6a3;--red:#ff6c78;--blue:#78a9ff;--orange:#f0a04b;
--green-soft:rgba(81,214,163,.12);--red-soft:rgba(255,108,120,.12);--blue-soft:rgba(120,169,255,.12);
--radius:14px;--radius-sm:9px;--shadow:0 18px 48px rgba(0,0,0,.24);
--font:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
--font-num:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--panel:var(--surface);--panel-2:var(--surface-2);--panel-raised:var(--surface-2);--panel-shadow:var(--shadow);
--gold:var(--brand);--gold-soft:var(--brand-soft)}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;color:var(--text);font-family:var(--font);
background:radial-gradient(circle at 15% -8%,rgba(245,193,79,.1),transparent 31rem),radial-gradient(circle at 95% 26%,rgba(120,169,255,.06),transparent 34rem),linear-gradient(rgba(255,255,255,.012) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.012) 1px,transparent 1px),var(--bg);
background-size:auto,auto,32px 32px,32px 32px,auto;background-attachment:fixed}
.site-header{position:sticky;top:0;z-index:20;padding:10px 16px 0;background:linear-gradient(var(--bg) 0%,rgba(7,9,13,.92) 70%,transparent)}
.site-bar{max-width:var(--site-width,1440px);margin:0 auto;min-height:58px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:8px 12px;border:1px solid var(--line-soft);border-radius:16px;background:rgba(14,18,24,.88);box-shadow:0 12px 38px rgba(0,0,0,.22);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}
.site-brand{display:flex;align-items:center;gap:10px;color:var(--text);font-size:15px;font-weight:750;text-decoration:none;white-space:nowrap}
.site-mark{width:34px;height:34px;display:grid;place-items:center;border-radius:11px;background:var(--brand);color:var(--brand-ink);font-weight:900;box-shadow:0 0 24px rgba(245,193,79,.18)}
.site-nav{display:flex;gap:4px;min-width:0;overflow-x:auto;scrollbar-width:none}
.site-nav::-webkit-scrollbar{display:none}
.site-nav a{padding:8px 12px;border-radius:var(--radius-sm);color:var(--muted);font-size:13px;font-weight:650;text-decoration:none;white-space:nowrap;transition:color .15s,background-color .15s}
.site-nav a:hover{color:var(--text);background:rgba(255,255,255,.05);text-decoration:none}
.site-nav a[aria-current]{color:var(--brand);background:var(--brand-soft)}
.site-brand:focus-visible,.site-nav a:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.site-actions{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
@media (max-width:760px){
.site-header{position:static;padding:calc(8px + env(safe-area-inset-top)) 12px 0}
.site-bar{gap:8px;padding:8px 10px}
.site-nav{order:2;width:100%}
.site-actions{order:3;width:100%;margin-left:0}
}
@media print{.site-header{display:none}}
`;
