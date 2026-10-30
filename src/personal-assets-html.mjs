import { SITE_CSS, siteHeader } from "./site-shell.mjs";

// Asset-type colors, indexed like CATEGORIES in personal-assets-core.mjs. The
// client paints charts with var(--cat-N) so each theme supplies its own set.
const DARK_CATEGORY_COLORS = ["#f5c14f", "#6ba4ed", "#64c7ab", "#b5a2f4", "#e89a67", "#d77ea7", "#74beca", "#c2ca70", "#ae9679", "#8d9edf", "#75b988", "#a4a9b3"];
const LIGHT_CATEGORY_COLORS = ["#8e8e93", "#32ade6", "#34c759", "#007aff", "#5856d6", "#af52de", "#a2845e", "#00c7be", "#ff9500", "#ffcc00", "#ff6482", "#c7c7cc"];
const categoryVars = (colors) => colors.map((color, index) => `--cat-${index}:${color}`).join(";");

// Extra light-theme polish for this page; the shared shell supplies the light
// and dark tokens. iOS system colors mark asset types and tables read like a
// ledger. Dark is an opt-in saved in localStorage.
const LIGHT_THEME_CSS = `
[data-theme=light] .panel,[data-theme=light] .source-details{border-radius:12px}
[data-theme=light] .platform-number,[data-theme=light] .stock-pnl-value,[data-theme=light] .history-item .num,[data-theme=light] .type-pie-total{font-family:var(--font);font-weight:400;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
[data-theme=light] .stock-pnl{border-top-color:var(--line)}
[data-theme=light] .pill.gold{border-color:rgba(82,102,235,.25)}
[data-theme=light] .platform-mark{border-radius:8px}
[data-theme=light] th{background:var(--surface-2);color:var(--muted);font-size:11px;font-weight:500}
[data-theme=light] td{font-variant-numeric:tabular-nums}
[data-theme=light] tbody tr:hover td{background:#fafafc}
[data-theme=light] td.num,[data-theme=light] td .num{font-family:var(--font-num)}
[data-theme=light] .atlas-panel{background:var(--surface)}
[data-theme=light] dialog::backdrop{background:rgba(23,23,33,.35)}
`;

// Page tools live behind a gear at the right end of the shared top bar; the
// client opens the menu and runs each item's existing action.
const icon = (paths) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SETTINGS_MENU = `<div class="settings-menu"><button type="button" class="settings-button" id="settings-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="settings-panel" aria-label="设置" title="设置">${icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')}</button>`
  + `<div class="settings-panel" id="settings-panel" role="menu" aria-label="资产页设置" hidden>`
  + `<button type="button" class="settings-item primary" role="menuitem" data-action="import" data-needs-data disabled>${icon('<path d="M12 15V3M7 8l5-5 5 5M5 21h14"/>')}导入资产</button>`
  + `<button type="button" class="settings-item" role="menuitem" data-action="sync" data-needs-data disabled>${icon('<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5"/>')}只读同步</button>`
  + `<a class="settings-item" role="menuitem" href="/assets?settings=refresh-schedule">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')}自动更新</a>`
  + `<a class="settings-item" role="menuitem" href="/assets?settings=statement-passwords">${icon('<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>')}结单密码</a>`
  + `<button type="button" class="settings-item" role="menuitem" data-action="export" data-needs-data disabled>${icon('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>')}导出备份</button>`
  + `<button type="button" class="settings-item" role="menuitem" data-action="ai-settings">${icon('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M16 7l3 3M18.5 4.5l2 2"/>')}Moonshot 配置</button>`
  + `<button type="button" class="settings-item" role="menuitem" id="theme-toggle" aria-pressed="false">${icon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>')}<span id="theme-toggle-label">明亮模式</span></button>`
  + `</div></div>`;

export function personalAssetsHtml({ nonce }) {
  const safeNonce = String(nonce).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>个人资产 · HQ Capital</title>
<script nonce="${safeNonce}">{let theme="light";try{if(localStorage.getItem("assets-theme")==="dark")theme="dark"}catch{}document.documentElement.dataset.theme=theme}</script>
<style>
${SITE_CSS}
:root{--site-width:1280px;${categoryVars(LIGHT_CATEGORY_COLORS)}}
:root[data-theme=dark]{${categoryVars(DARK_CATEGORY_COLORS)}}
${LIGHT_THEME_CSS}
*{box-sizing:border-box}[hidden]{display:none!important}body{font-size:14px;line-height:1.6}
button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.5}a{color:var(--brand)}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--brand);outline-offset:3px}
.assets-wrap{max-width:1280px;margin:auto;padding:30px 20px 56px}.asset-head,.section-head,.row,.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.eyebrow{color:var(--brand);font-size:11px;font-weight:700;letter-spacing:.16em;margin:0 0 5px}h1{font-size:30px;margin:0;letter-spacing:.02em}h2{font-size:18px;margin:0}h3{font-size:14px;margin:0}.muted,.subtitle{color:var(--muted)}.subtitle{margin:6px 0 0}.small{font-size:12px}.num{font-family:var(--font-num);font-variant-numeric:tabular-nums}
.button{min-height:42px;padding:9px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--text);font-weight:600;font-size:13px}.button:hover{border-color:var(--faint)}.button.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}.button.quiet{background:transparent}.button.danger{color:var(--red)}.button.small{min-height:34px;padding:6px 10px;font-size:12px}.actions{justify-content:flex-start;gap:8px}
.asset-tabs{display:flex;gap:5px;border-bottom:1px solid var(--line);padding:22px 0 12px;margin-bottom:22px;overflow:auto}.asset-tabs button{white-space:nowrap;padding:9px 15px;border:0;background:transparent;color:var(--muted);border-radius:8px}.asset-tabs button[aria-current]{background:var(--brand-soft);color:var(--brand);font-weight:700}
.panel{border:1px solid var(--line);background:var(--surface);border-radius:14px;padding:20px;min-width:0}.section-head{margin-bottom:18px}.pill{display:inline-flex;align-items:center;padding:3px 8px;border:1px solid var(--line);border-radius:6px;font-size:11px;color:var(--muted)}.pill.gold{color:var(--brand);background:var(--brand-soft);border-color:rgba(245,193,79,.25)}
.notice{border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:8px;background:var(--surface-2);padding:12px 15px;font-size:13px;margin:16px 0;color:var(--muted)}.notice.error{border-left-color:var(--red);color:var(--red)}.notice.success{border-left-color:var(--green);color:var(--green)}.notice p{margin:0}.notice .actions{margin-top:10px}
.metric-label{color:var(--muted);font-size:12px}.metric-foot{color:var(--muted);font-size:12px}
.stock-pnl{border-top:1px solid rgba(245,193,79,.2);margin-top:18px;padding-top:12px}.stock-pnl-value{font-size:24px;margin:4px 0}.negative{color:var(--red)}.positive{color:var(--green)}.stock-pnl .metric-foot{margin:4px 0}.pnl-sources{font-size:11px;color:var(--muted);margin-top:8px}.pnl-sources summary,.source-details>summary{cursor:pointer}.pnl-source{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--line-soft)}.pnl-source small{display:block;font-size:10px}.pnl-edit-row{border-bottom:1px solid var(--line);padding:12px 0 18px;margin-bottom:18px}.pnl-edit-row legend{font-size:13px;font-weight:600}.overview-distributions{display:grid;grid-template-columns:1.3fr 1fr;gap:18px;margin-bottom:20px}.type-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.type-all{margin-top:8px}.overview-distributions .type-pie-layout{grid-template-columns:minmax(140px,.7fr) minmax(0,1fr);gap:12px}.overview-distributions .type-legend-item{padding:6px 4px;gap:8px}.overview-distributions .bar-list{gap:12px;margin-top:12px}.source-details{border:1px solid var(--line);border-radius:14px;background:var(--surface);margin-top:22px}.source-details>summary{padding:18px 20px;font-weight:600}.source-details>summary span{color:var(--muted);font-size:11px;font-weight:400;margin-left:12px}.source-details-body{padding:0 18px}.source-details-body .panel{background:var(--bg)}
.currency-toggle{display:flex;gap:3px;padding:3px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}.currency-toggle button{min-height:32px;padding:4px 8px;border:0;border-radius:5px;background:transparent;color:var(--muted);font-size:11px;white-space:nowrap}.currency-toggle button[aria-pressed=true]{background:var(--brand-soft);color:var(--brand);font-weight:700}
.platform-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.platform-card{padding:17px;display:grid;gap:14px}.platform-top{display:flex;align-items:center;gap:10px}.platform-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;color:var(--brand);background:var(--brand-soft);font-size:13px;font-weight:800}.platform-name{font-size:14px;font-weight:700}.platform-number{font:23px var(--font-num)}.platform-bottom{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--muted);font-size:11px}.platform-bottom button{font-size:11px;background:transparent;border:0;color:var(--brand);padding:2px}
.platform-native,.platform-pending{display:grid;gap:5px}.platform-native .platform-number{font-size:20px;overflow-wrap:anywhere}.platform-pending{border-top:1px dashed var(--line);padding-top:10px;color:var(--muted);font-size:12px}.type-pie-layout{display:grid;grid-template-columns:minmax(200px,.8fr) minmax(0,1.7fr);gap:30px;align-items:center}.type-pie{display:block;width:100%;max-width:300px;margin:auto}.type-pie-label{fill:var(--muted);font-size:10px}.type-pie-total{fill:var(--text);font:18px var(--font-num)}.type-legend{display:grid;gap:4px}.type-legend-item{display:flex;align-items:center;gap:10px;text-align:left;background:transparent;color:var(--text);border:1px solid transparent;border-radius:8px;padding:10px 8px;min-width:0}.type-legend-item:hover{background:var(--surface-2);border-color:var(--line)}.type-key{width:10px;height:10px;border-radius:3px;flex-shrink:0}.type-name{flex:1;font-size:13px;min-width:0}.type-name small,.type-figures small{display:block;color:var(--muted);font-size:10px;font-weight:400;line-height:1.6;margin-top:2px}.type-figures{font-size:13px;text-align:right;white-space:nowrap}.charts .type-chart-panel{grid-column:1/-1}.charts:has(.type-chart-panel){grid-template-columns:1fr 1fr}
.columns{display:grid;grid-template-columns:1.2fr 1fr;gap:18px;margin-top:20px}.charts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.bar-list{display:grid;gap:17px;margin-top:22px}.bar-label{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:6px}.bar-track{height:7px;background:var(--surface-3);border-radius:6px;overflow:hidden}.bar-fill{height:100%;background:var(--brand);border-radius:6px}.bar-fill.color-1{background:var(--blue)}.bar-fill.color-2{background:var(--green)}.bar-fill.color-3{background:#b5a2f4}.bar-fill.color-4{background:var(--orange)}
.insights{display:grid;gap:0;margin-top:12px}.insight{border-top:1px solid var(--line-soft);padding:15px 0}.insight:last-child{padding-bottom:0}.insight strong{font-size:13px;font-weight:600}.insight p{font-size:12px;color:var(--muted);margin:5px 0 0}.empty{padding:32px 20px;text-align:center;color:var(--muted)}.empty h3{color:var(--text);margin-bottom:8px}.empty p{margin:5px auto 18px;max-width:52ch}.empty-mark{font-size:28px;color:var(--brand);margin-bottom:10px}
.account-list{display:grid;gap:16px}.account-card .section-head{margin-bottom:12px}.basis{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.basis label{font-size:12px;color:var(--muted)}.basis select{font-size:12px;padding:6px 28px 6px 8px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:500;padding:10px 12px;border-bottom:1px solid var(--line)}td{padding:13px 12px;border-bottom:1px solid var(--line-soft)}tbody tr:last-child td{border:0}td .name{font-weight:600;max-width:210px;overflow:hidden;text-overflow:ellipsis;display:block}.source-label{font-size:10px;color:var(--muted)}.excluded{color:var(--muted)}.record-actions{display:flex;gap:6px}.record-actions button{min-height:30px;padding:3px 8px;font-size:11px}
input,select,textarea{border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text);padding:9px 10px;min-width:0;max-width:100%}input[type=checkbox]{accent-color:var(--brand);width:16px;height:16px;flex-shrink:0}input[type=file]{width:100%;font-size:12px}input[type=file]::file-selector-button{background:var(--surface-3);color:var(--text);border:0;padding:7px 10px;border-radius:4px;margin-right:8px}.check-label{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.7;color:var(--muted)}
dialog{color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:0;width:min(620px,calc(100% - 32px));max-height:90vh;box-shadow:var(--shadow)}dialog.wide{width:min(1050px,calc(100% - 32px))}dialog::backdrop{background:rgba(0,0,0,.78);backdrop-filter:blur(5px)}.dialog-header{padding:20px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.dialog-header p{font-size:12px;color:var(--muted);margin:5px 0 0}.dialog-header button{font-size:20px;border:0;background:transparent;color:var(--muted);padding:0 4px}.dialog-body{padding:20px 22px}.dialog-footer{display:flex;gap:8px;justify-content:flex-end;padding:16px 22px;border-top:1px solid var(--line);background:var(--surface-2)}fieldset{border:0;padding:0;margin:0}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.field{display:grid;gap:6px}.field.full{grid-column:1/-1}.field label{font-size:12px;color:var(--muted)}.form-note{margin-top:16px;padding:12px;background:var(--brand-soft);border-radius:7px;color:var(--muted);font-size:12px}.rate-row{display:grid;grid-template-columns:55px 1fr 1fr;gap:12px;align-items:center;margin:10px 0}.rate-row strong{font:12px var(--font-num)}.rate-labels{display:grid;grid-template-columns:55px 1fr 1fr;gap:12px;font-size:11px;color:var(--muted)}
.import-tabs{display:flex;gap:8px;margin-bottom:18px}.upload-zone{border:1px dashed var(--line);border-radius:10px;padding:22px;text-align:center;background:var(--bg)}.upload-zone p{color:var(--muted);font-size:12px}.upload-zone input{max-width:400px}.import-help{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:15px 0;font-size:12px;color:var(--muted)}.preview-table input,.preview-table select{font-size:11px;min-width:110px;width:100%;padding:7px}.preview-table th,.preview-table td{padding:8px}.preview-table input[data-field=name]{min-width:150px}.preview-table input[data-field=amount]{min-width:115px}.preview-table{margin-top:16px}.candidate-list{display:grid;gap:8px;margin-top:16px}.candidate{display:flex;text-align:left;justify-content:space-between;gap:16px;padding:13px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:12px}.candidate span{overflow-wrap:anywhere}.candidate b{white-space:nowrap;font-family:var(--font-num);color:var(--brand)}.ocr-layout{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-top:18px}.ocr-image{display:block;width:100%;max-height:250px;object-fit:contain;background:var(--bg);border-radius:8px}.ocr-layout textarea{width:100%;min-height:180px;font-size:12px;resize:vertical}.ocr-status{font-size:12px;color:var(--muted)}.privacy-mask{min-height:180px;display:grid;place-items:center;color:var(--muted);font-size:12px;border:1px dashed var(--line);border-radius:8px}
.history-list{display:grid;gap:12px}.history-item{display:flex;justify-content:space-between;gap:16px;align-items:center}.history-item strong{font-size:13px}.history-item .num{font-size:24px}.footnote{font-size:11px;color:var(--muted);margin:22px 0 0}.asset-footer{display:flex;justify-content:space-between;gap:15px;flex-wrap:wrap;margin-top:30px;color:var(--faint);font-size:11px}.loading{padding:80px 20px;text-align:center;color:var(--muted)}.export-grid{display:grid;gap:12px}.export-grid .button{text-align:left}.export-grid small{display:block;font-weight:400;color:var(--muted);margin-top:4px}
.history-trend{margin-bottom:20px}.history-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:8px 0 24px}.history-summary strong{display:block;font-size:27px;font-weight:500;overflow-wrap:anywhere}.history-summary strong small{font-size:14px}.history-summary>div>small{display:block;font-size:11px}.history-graph{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:0 12px}.history-y-axis{display:flex;flex-direction:column;justify-content:space-between;padding:4px 0;font-size:11px;color:var(--muted);text-align:right}.history-plot{position:relative;min-width:0}.history-plot svg{display:block;width:100%;height:240px;overflow:visible}.history-line{fill:none;stroke:var(--brand);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.history-grid{stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke;stroke-dasharray:3 5}.history-dot{position:absolute;width:7px;height:7px;transform:translate(-50%,-50%);border:1.5px solid var(--surface);border-radius:50%;background:var(--brand)}.history-dot.partial{background:var(--surface);border-color:var(--brand)}.history-x-axis{grid-column:2;display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:10px}.history-x-axis span{max-width:48%}.history-x-axis span:last-child{text-align:right}.history-caption{margin:16px 0 0;line-height:1.8}
.sync-list{display:grid;gap:18px}.sync-card{padding:18px}.sync-card .section-head{margin-bottom:10px}.sync-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;margin:14px 0;font-size:12px;color:var(--muted)}.sync-meta strong{display:block;color:var(--text);font-weight:500}.sync-preview{border-top:1px solid var(--line);margin-top:16px;padding-top:16px}.sync-preview .table-scroll{max-height:280px}.sync-steps{padding-left:20px;color:var(--muted);font-size:12px}.sync-steps li{margin:6px 0}
.history-comparison-toggle{display:block;width:100%;padding:0;border:0;border-radius:6px;text-align:left;background:transparent;color:var(--text)}.history-comparison-toggle:hover .metric-label,.comparison-hint{color:var(--brand)}.comparison-hint{display:block;font-size:11px;margin:4px 0}.history-changes{margin-bottom:24px;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.history-change-row{display:grid;grid-template-columns:minmax(160px,1fr) repeat(3,minmax(95px,auto));gap:14px;align-items:center;padding:12px 0;border-top:1px solid var(--line-soft);font-size:13px}.history-change-row small{display:block;font:11px var(--font);margin-bottom:3px}.history-change-row>.num{text-align:right}.history-change-name{min-width:0;overflow-wrap:anywhere}.history-change-total{padding-top:12px;border-top:1px solid var(--line)}@media(max-width:600px){.history-change-row{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;font-size:12px}.history-change-name{grid-column:1/-1}.history-change-row>.num{text-align:left}}
@media(max-width:1000px){.platform-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.charts{grid-template-columns:1fr}.charts .bar-list{grid-template-columns:1fr 1fr}.columns{grid-template-columns:1fr}}
@media(max-width:600px){.assets-wrap{padding:22px 12px 32px}h1{font-size:25px}.asset-head{align-items:flex-start}.asset-head>.actions{width:100%}.asset-head>.actions .button{flex:1 1 auto;white-space:nowrap;padding:9px 10px;font-size:12px}.asset-tabs{margin-bottom:16px}.asset-tabs button{font-size:12px;padding:8px 11px}.platform-grid{grid-template-columns:1fr 1fr;gap:10px}.platform-card{padding:14px}.platform-number{font-size:20px}.platform-bottom{align-items:flex-start}.platform-mark{width:30px;height:30px}.platform-name{font-size:12px}.panel{padding:16px}.charts .bar-list{grid-template-columns:1fr}.section-head{gap:10px}.section-head h2{font-size:16px}.form-grid{grid-template-columns:1fr}.field.full{grid-column:auto}.dialog-header,.dialog-body{padding:17px}.dialog-footer{padding:14px 17px}.rate-row,.rate-labels{grid-template-columns:45px 1fr 1.1fr;gap:7px}.rate-row input{font-size:11px;padding:8px 6px}.ocr-layout{grid-template-columns:1fr}.import-help{align-items:flex-start;flex-direction:column}.history-item{align-items:flex-start}.history-item .num{font-size:19px}.asset-footer span:last-child{display:none}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
@media(max-width:1000px){.overview-distributions{grid-template-columns:1fr}}
@media(max-width:600px){.stock-pnl-value{font-size:22px}.source-details>summary span{display:block;margin:5px 0 0}.overview-distributions .type-pie-layout{grid-template-columns:1fr}.overview-distributions .type-pie{max-width:200px}.pnl-source{flex-wrap:wrap}}
@media(max-width:600px){.type-pie-layout{grid-template-columns:1fr;gap:14px}.type-pie{max-width:230px}.type-name{font-size:12px}.type-figures{font-size:12px}.type-name small{max-width:24ch}.type-legend-item{padding:9px 0;gap:8px}.charts:has(.type-chart-panel){grid-template-columns:1fr}.platform-native .platform-number{font-size:17px}}
.asset-head{justify-content:space-between;border-bottom:1px solid var(--line);padding:22px 0 12px;margin-bottom:22px}.asset-head .asset-tabs{flex:1 1 auto;min-width:0;border:0;padding:0;margin:0}.atlas-live .atlas-bubble{animation:none}.settings-menu{position:relative}.settings-button{display:grid;place-items:center;width:38px;height:38px;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--muted)}.settings-button:hover,.settings-button[aria-expanded=true]{color:var(--text);border-color:var(--faint)}.settings-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:30;display:grid;gap:2px;min-width:196px;padding:6px;border:1px solid var(--line);border-radius:12px;background:var(--surface);box-shadow:var(--shadow)}.settings-item{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:var(--text);font-size:13px;text-align:left;white-space:nowrap}.settings-item:hover{background:var(--surface-2)}.settings-item svg{flex-shrink:0;color:var(--muted)}.settings-item.primary,.settings-item.primary svg{color:var(--brand);font-weight:600}.eye-toggle{display:grid;place-items:center;width:38px;height:38px;flex-shrink:0;padding:0;border:0;border-radius:50%;background:transparent;color:var(--muted)}.eye-toggle:hover{background:var(--surface-2);color:var(--text)}@media(max-width:760px){.site-actions{order:1;width:auto;margin-left:auto}}.atlas-panel{margin:20px 0;background:radial-gradient(ellipse at 50% 35%,rgba(245,193,79,.045),transparent 65%),var(--surface)}.atlas-plot{position:relative;width:100%;overflow:hidden}.atlas-mobile{display:none}.atlas-position{position:absolute;aspect-ratio:1;transform:translate(-50%,-50%)}.atlas-bubble{position:relative;display:grid;place-items:center;width:100%;height:100%;padding:0;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--bubble-color) 78%,transparent);background:radial-gradient(circle,rgba(14,15,19,.92) 0 50%,color-mix(in srgb,var(--bubble-color) 16%,rgba(14,15,19,.9)) 72%,color-mix(in srgb,var(--bubble-color) 62%,transparent) 100%);box-shadow:0 0 18px color-mix(in srgb,var(--bubble-color) 28%,transparent);color:#fff;container-type:inline-size;animation:atlas-float var(--bubble-duration) ease-in-out var(--bubble-delay) infinite;transition:box-shadow .2s,border-color .2s,transform .2s}.atlas-bubble:hover{border-color:var(--bubble-color);box-shadow:0 0 30px color-mix(in srgb,var(--bubble-color) 55%,transparent);transform:scale(1.04)}.bubble-label{display:grid;justify-items:center;gap:2cqi;text-align:center;max-width:86%;pointer-events:none}.bubble-mark{display:grid;place-items:center;min-width:22cqi;height:22cqi;padding:0 4cqi;border-radius:11cqi;background:var(--bubble-color);color:#0e0f13;font-size:8.5cqi;font-weight:800;letter-spacing:-.02em;margin-bottom:2cqi}.bubble-name{font-size:max(10px,var(--name-size,17cqi));font-weight:700;line-height:1.05;letter-spacing:-.01em;white-space:nowrap}.bubble-value{font-family:var(--font);font-size:max(9px,12cqi);font-weight:500;line-height:1.2;color:rgba(255,255,255,.82)}@container (max-width:72px){.bubble-mark{display:none}}.atlas-stage{background:#0e0f13;border-radius:16px;padding:10px;overflow:hidden}.atlas-key{display:flex;flex-wrap:wrap;gap:6px 14px;padding:10px 6px 2px;font-size:11px;color:rgba(255,255,255,.62)}.atlas-key span{display:inline-flex;align-items:center;gap:6px}.atlas-key i{width:9px;height:9px;border-radius:50%}.atlas-caption{margin:12px 0 16px}.atlas-legend{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}.atlas-legend-row{display:flex;justify-content:space-between;gap:14px;align-items:center;min-height:58px;text-align:left;background:transparent;border:0;border-top:1px solid var(--line-soft);padding:10px 0;color:var(--text)}.atlas-legend-row:hover strong{color:var(--brand)}.atlas-legend-row strong{font-size:12px}.atlas-legend-row>.num{text-align:right;font-size:12px}.atlas-legend-row small,.atlas-unvalued-item small{display:block;font-size:10px;color:var(--muted);font-weight:400;margin-top:3px}.atlas-unvalued{border-top:1px solid var(--line);padding-top:18px;margin-top:16px}.atlas-unvalued h3{font-size:12px;color:var(--muted);margin-bottom:12px}.atlas-unvalued-item{border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--muted);padding:9px 12px;text-align:left}.atlas-unvalued-item strong{font-size:11px}.atlas-details{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}.atlas-details>summary{cursor:pointer;font-size:12px;color:var(--muted)}.atlas-details>summary span{margin-left:10px}.atlas-details .platform-grid{margin-top:16px}.atlas-private{margin-top:18px}@keyframes atlas-float{0%,100%{transform:translateY(calc(-1 * var(--float-distance,1.6px)))}50%{transform:translateY(var(--float-distance,1.6px))}}
@media(max-width:600px){.asset-head{padding-top:16px;margin-bottom:16px}.asset-head .asset-tabs{flex-basis:100%}.atlas-wide{display:none}.atlas-mobile{display:block;--float-distance:.6px}.atlas-legend{grid-template-columns:1fr}.atlas-details>summary span{display:block;margin:5px 0 0}.atlas-panel .section-head{margin-bottom:8px}.bubble-label{gap:5px}.atlas-unvalued .actions{display:grid;grid-template-columns:1fr 1fr}.atlas-legend-row{min-height:64px}}
@media(prefers-reduced-motion:reduce){.atlas-bubble{animation:none;transition:none}}
.sleeve-panel{margin-bottom:20px}.sleeve-meter{position:relative;margin:6px 0 12px}.sleeve-bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--surface-3)}.sleeve-bar span{height:100%}.sleeve-target{position:absolute;top:-5px;bottom:-5px;width:2px;margin-left:-1px;background:var(--text);border-radius:1px}.sleeve-core{background:var(--brand)}.sleeve-satellite{background:var(--blue)}.sleeve-unassigned{background:repeating-linear-gradient(45deg,var(--surface-3) 0 4px,var(--muted) 4px 6px)}.sleeve-legend{display:flex;flex-wrap:wrap;gap:8px 24px;font-size:13px}.sleeve-legend>div{display:flex;align-items:baseline;gap:6px}.sleeve-legend strong{font-size:18px}.sleeve-legend small{color:var(--muted);font-size:11px}.sleeve-key{width:10px;height:10px;border-radius:3px;display:inline-block;align-self:center}.sleeve-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:24px;margin-top:16px}.sleeve-columns .bar-list{margin-top:12px}
</style>
</head>
<body>
${siteHeader("/assets", SETTINGS_MENU)}
<main class="assets-wrap" id="assets-app" aria-label="个人资产管理">
  <header class="asset-head"><nav class="asset-tabs" aria-label="资产页面导航"><button data-page="overview" aria-current="page">资产总览</button><button data-page="holdings">账户与持仓</button><button data-page="analysis">资产分析</button><button data-page="history">历史快照</button></nav></header>
  <div id="asset-message" role="status" aria-live="polite" hidden></div>
  <div id="asset-error" role="alert" hidden></div>
  <div id="asset-content"><div class="loading" role="status">正在读取你的资产记录…</div></div>
  <footer class="asset-footer"><span>手动录入 / 只读同步 · 首次核对后更新 · 无自动交易</span><span>HQ Capital / 个人资产工作台</span></footer>
</main>
<dialog id="asset-dialog" aria-labelledby="dialog-title"><header class="dialog-header"><div><h2 id="dialog-title"></h2><p id="dialog-description"></p></div><button type="button" data-action="close-dialog" aria-label="关闭窗口">×</button></header><div class="dialog-body" id="dialog-body"></div><footer class="dialog-footer" id="dialog-footer"></footer></dialog>
<script type="module" nonce="${safeNonce}" src="/assets/app.mjs"></script>
</body>
</html>`;
}

export function statementPasswordsHtml({ nonce }) {
  const safeNonce = String(nonce).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>结单密码 · HQ Capital</title>
<style>${SITE_CSS}
.passwords-wrap{max-width:760px;margin:36px auto;padding:0 20px 40px}.passwords-wrap h1{font-size:26px;margin:20px 0 10px}.passwords-wrap p{color:var(--muted);line-height:1.7}.password-card{margin:20px 0;padding:24px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}.password-card h2{font-size:18px;margin:0 0 8px}.password-card label{display:block;margin-top:18px;font-size:13px}.password-card input{box-sizing:border-box;width:100%;padding:12px;margin:8px 0 14px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}.password-actions{display:flex;gap:10px;flex-wrap:wrap}.password-actions button,.back-link{font:inherit;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--text);text-decoration:none}.password-actions button[type=submit]{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}button:disabled{opacity:.5;cursor:wait}.password-status{font-size:13px;color:var(--muted)}#password-message{white-space:pre-wrap}#password-message[data-error=true]{color:var(--red)}
</style></head><body>${siteHeader("/assets")}<main class="passwords-wrap"><a class="back-link" href="/assets">← 返回个人资产</a><h1>结单密码</h1><p>保存用于打开电子结单的密码。已保存的密码不会回显；更新某个账户不会改动另一个账户。保存后仍需解密、核对结单，才会更新资产。</p><p id="password-message" role="status" aria-live="polite">正在读取配置状态…</p>
${[["usmart-hk", "盈立香港", "用于香港盈立发送的日结单和月结单。"], ["usmart-sg", "盈立新加坡", "用于盈立新加坡发送的结单，与香港账户分开配置。"]].map(([provider, label, description]) => `<form class="password-card" data-provider="${provider}" autocomplete="off"><h2>${label}</h2><p>${description}</p><div class="password-status" id="status-${provider}">状态待读取</div><label for="password-${provider}">结单打开密码</label><input type="password" id="password-${provider}" autocomplete="new-password" spellcheck="false" maxlength="256" required placeholder="输入新密码；已保存的密码不会显示"><div class="password-actions"><button type="submit" disabled>保存密码</button><button type="button" data-clear disabled>清除已保存密码</button></div></form>`).join("")}
<p>密码通过本站 HTTPS 提交，仅保存在受限的服务器配置文件中，不进入资产导出、快照、AI 点评或浏览器存储。这里不需要邮箱登录密码、银行登录密码或交易密码。</p></main>
<script nonce="${safeNonce}">
const message = document.getElementById("password-message");
let ready = false;
function notify(text, error = false) { message.textContent = text; message.dataset.error = String(error); }
function showStatus(data) {
  for (const form of document.querySelectorAll("form[data-provider]")) {
    const status = data.providers[form.dataset.provider];
    document.getElementById("status-" + form.dataset.provider).textContent = status.configured ? "已配置 · 保存时间 " + new Date(status.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "尚未配置";
    form.querySelector("[data-clear]").disabled = !status.configured;
    form.querySelector("button[type=submit]").disabled = false;
  }
}
async function request(body) {
  const response = await fetch("/api/assets/statement-passwords", { method: body ? "POST" : "GET", cache: "no-store", credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "配置未保存，请重新登录后重试。");
  return data;
}
async function save(form, clear) {
  if (!ready) return;
  const input = form.querySelector("input");
  const body = clear ? { provider: form.dataset.provider, clear: true } : { provider: form.dataset.provider, password: input.value };
  input.value = "";
  ready = false;
  document.querySelectorAll("form button, form input").forEach(element => { element.disabled = true; });
  notify("正在保存…");
  try { showStatus(await request(body)); notify(clear ? "已清除该账户的结单密码。" : "结单密码已保存。尚未据此验证结单，也未改动资产金额。"); }
  catch (error) { notify(error.message, true); try { showStatus(await request()); } catch {} }
  finally { document.querySelectorAll("form input").forEach(element => { element.disabled = false; }); ready = true; }
}
document.querySelectorAll("form[data-provider]").forEach(form => {
  form.addEventListener("submit", event => { event.preventDefault(); save(form, false); });
  form.querySelector("[data-clear]").addEventListener("click", () => save(form, true));
});
request().then(data => { showStatus(data); ready = true; notify("配置状态已读取。请在对应账户下填写结单密码。"); }).catch(error => notify(error.message, true));
window.addEventListener("pagehide", () => { document.querySelectorAll("form input").forEach(input => { input.value = ""; }); });
</script></body></html>`;
}

export function refreshScheduleHtml({ nonce }) {
  const safeNonce = String(nonce).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自动更新 · HQ Capital</title>
<style>${SITE_CSS}
.schedule-wrap{max-width:660px;margin:36px auto;padding:0 20px 40px}.schedule-wrap h1{font-size:26px;margin:20px 0 10px}.schedule-wrap p{color:var(--muted);line-height:1.7}.schedule-card{margin:20px 0;padding:24px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}.schedule-card label{display:block;font-size:14px}.schedule-card input{display:block;box-sizing:border-box;width:100%;max-width:240px;padding:12px;margin:12px 0 20px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}.schedule-card button,.back-link{font:inherit;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--text);text-decoration:none}.schedule-card button{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}button:disabled,input:disabled{opacity:.5}#schedule-message[data-error=true]{color:var(--red)}#schedule-status{white-space:pre-line;font-size:13px}
</style></head><body>${siteHeader("/assets")}<main class="schedule-wrap"><a class="back-link" href="/assets">← 返回个人资产</a><h1>自动更新</h1><p>每天自动更新一次已接入的资产来源、基金和股票估值，统一使用北京时间。</p><form class="schedule-card" id="schedule-form"><label for="refresh-time">每日更新时间 · 北京时间（UTC+8）</label><input id="refresh-time" name="time" type="time" step="60" value="07:00" required disabled><button type="submit" id="schedule-save" disabled>保存更新时间</button><p id="schedule-status">正在读取更新计划…</p></form><p id="schedule-message" role="status" aria-live="polite"></p><p>当天已自动执行后，修改时间不会再次刷新。执行失败保留上次有效数据，下个更新时间再尝试。服务器恢复后会补做当天尚未执行的任务。</p><p>此设置控制服务器资产刷新。邮箱结单由本机任务每天 07:00 独立检查，需要本机和邮箱会话可用。每日资产快照仍在 23:55 保存。</p></main>
<script nonce="${safeNonce}">
const form = document.getElementById("schedule-form"), input = document.getElementById("refresh-time"), button = document.getElementById("schedule-save"), message = document.getElementById("schedule-message");
const format = value => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "尚未记录";
let ready = false;
function notify(text, error = false) { message.textContent = text; message.dataset.error = String(error); }
function show(data) {
  input.value = data.time;
  document.getElementById("schedule-status").textContent = "每天一次 · 北京时间 " + data.time + "\\n下次执行：" + format(data.nextRunAt) + "\\n最近开始：" + format(data.lastAttemptAt) + "\\n最近完成：" + format(data.lastCompletedAt) + (data.lastError ? "\\n" + data.lastError : "");
}
async function request(body) {
  const response = await fetch("/api/assets/refresh-schedule", { method: body ? "POST" : "GET", cache: "no-store", credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "更新时间未保存，请重新登录后重试。");
  return data;
}
form.addEventListener("submit", async event => {
  event.preventDefault(); if (!ready) return;
  const body = { time: input.value }; ready = false; input.disabled = button.disabled = true;
  notify("正在保存…");
  try { show(await request(body)); notify("更新时间已保存，服务器将按新计划执行。保存设置不会立即拉取资产。"); }
  catch (error) { notify(error.message, true); }
  finally { ready = true; input.disabled = button.disabled = false; }
});
request().then(data => { show(data); ready = true; input.disabled = button.disabled = false; }).catch(error => notify(error.message, true));
</script></body></html>`;
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const OPERATION_STATUS = {
  ok: ["正常", "ok"], running: ["运行中", "info"], failed: ["失败", "bad"], stale: ["数据滞后", "warn"], attention: ["需关注", "warn"],
  never: ["尚未运行", "muted"], finished: ["已结束", "muted"], missing: ["未安装", "bad"]
};
const beijingTime = (iso) => iso ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)).replace(/\//g, "-") : "—";
function ageText(iso, nowMs) {
  const diff = nowMs - Date.parse(iso);
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const span = minutes < 1 ? "不到 1 分钟" : minutes < 60 ? `${minutes} 分钟` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
  return diff < 0 ? `${span}后` : `${span}前`;
}

// Server-rendered run overview of the systemd timers; see readOperationsOverview.
export function operationsHtml(overview) {
  const nowMs = Date.parse(overview.generatedAt);
  const { renewal, counts } = overview;
  const pill = (status) => `<span class="op-pill ${OPERATION_STATUS[status]?.[1] || "muted"}">${OPERATION_STATUS[status]?.[0] || escapeHtml(status)}</span>`;
  const renewalTone = !renewal.verified ? "bad" : renewal.state === "ACTIVE" ? "ok" : renewal.state === "HALTED" ? "warn" : "bad";
  const dataCell = (row) => {
    if (!row.dataAsOf) return `<span class="muted">${escapeHtml(row.dataNote || "—")}</span>`;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(row.dataAsOf);
    return `<span class="num">${day ? `${escapeHtml(row.dataAsOf)} 交易日` : beijingTime(row.dataAsOf)}</span><small>${day ? "" : ageText(row.dataAsOf, nowMs)}${row.dataNote ? `${day ? "" : " · "}${escapeHtml(row.dataNote)}` : ""}</small>`;
  };
  const runCell = (row) => {
    const started = row.startedAt || row.lastTriggerAt;
    if (!started) return '<span class="muted">尚无记录</span>';
    const seconds = row.startedAt && row.finishedAt ? Math.max(0, Math.round((Date.parse(row.finishedAt) - Date.parse(row.startedAt)) / 1000)) : null;
    const detail = [ageText(started, nowMs), seconds !== null ? `耗时 ${seconds < 120 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`}` : "",
      row.result && row.result !== "success" ? `结果 ${escapeHtml(row.result)} · 退出码 ${escapeHtml(row.exitStatus)}` : ""].filter(Boolean).join(" · ");
    return `<span class="num">${beijingTime(started)}</span><small>${detail}</small>`;
  };
  const groups = [...new Set(overview.tasks.map((row) => row.group))];
  const table = groups.map((group) => `<tbody><tr class="op-group"><th colspan="5">${escapeHtml(group)}</th></tr>${overview.tasks.filter((row) => row.group === group).map((row) => `<tr data-status="${escapeHtml(row.status)}"><td><strong>${escapeHtml(row.label)}</strong><small class="mono">${escapeHtml(row.unit)} · ${escapeHtml(row.cadence)}</small></td><td>${pill(row.status)}</td><td>${runCell(row)}</td><td>${dataCell(row)}</td><td><span class="num">${row.nextRunAt ? beijingTime(row.nextRunAt) : "—"}</span><small>${row.nextRunAt ? ageText(row.nextRunAt, nowMs) : row.status === "finished" ? "一次性任务" : ""}</small></td></tr>`).join("")}</tbody>`).join("");
  const metric = (label, value, tone) => `<div class="op-metric ${tone}"><span>${label}</span><strong>${value}</strong></div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>运行总览 · HQ Capital</title>
<style>${SITE_CSS}
:root{--site-width:1280px}*{box-sizing:border-box}body{font-size:14px;line-height:1.6}
.op-wrap{max-width:1280px;margin:auto;padding:26px 20px 56px}.op-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:18px}.op-head h1{font-size:26px;margin:0}.op-head p{margin:4px 0 0;color:var(--muted);font-size:13px}
.op-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) minmax(0,1.6fr);gap:12px;margin-bottom:18px}.op-metric,.op-renewal{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:14px 16px}.op-metric span{display:block;color:var(--muted);font-size:12px}.op-metric strong{font-size:26px;font-weight:500;font-variant-numeric:tabular-nums}.op-metric.bad strong{color:var(--red)}.op-metric.warn strong{color:var(--gold)}.op-metric.ok strong{color:var(--green)}
.op-renewal .row{display:flex;justify-content:space-between;align-items:center;gap:8px}.op-renewal h2{font-size:13px;margin:0;color:var(--muted);font-weight:500}.op-renewal dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:10px 0 0;font-size:12px}.op-renewal dt{color:var(--muted)}.op-renewal dd{margin:0;font-variant-numeric:tabular-nums}
.op-notice{border:1px solid var(--line);border-left:3px solid var(--red);padding:10px 14px;border-radius:0;background:var(--surface);margin-bottom:16px;color:var(--red)}
.op-table-wrap{border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}th{padding:10px 14px;color:var(--muted);font-weight:500;font-size:12px;background:var(--surface-2);border-bottom:1px solid var(--line);white-space:nowrap}td{padding:11px 14px;border-bottom:1px solid var(--line-soft);vertical-align:top;white-space:nowrap}td small{display:block;color:var(--muted);font-size:11px;white-space:normal;max-width:300px}tr.op-group th{background:var(--surface);color:var(--text);font-weight:600;font-size:12px;padding-top:16px}tbody tr:not(.op-group):hover td{background:var(--surface-2)}
.mono{font-family:var(--font-num)}.num{font-variant-numeric:tabular-nums}.muted{color:var(--muted)}
.op-pill{display:inline-flex;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}.op-pill.ok{color:var(--green);background:var(--green-soft)}.op-pill.bad{color:var(--red);background:var(--red-soft)}.op-pill.warn{color:var(--gold);background:var(--gold-soft)}.op-pill.info{color:var(--blue);background:var(--blue-soft)}.op-pill.muted{color:var(--muted);background:var(--surface-3)}
.op-foot{margin-top:14px;color:var(--muted);font-size:12px}
@media(max-width:900px){.op-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.op-renewal{grid-column:1/-1}}
@media(max-width:600px){.op-wrap{padding:20px 12px 40px}td small.mono{display:none}td,th{padding:10px}}
</style></head><body>${siteHeader("/operations")}<main class="op-wrap" aria-label="运行总览">
<div class="op-head"><div><h1>运行总览</h1><p>服务器 ${overview.tasks.length} 个定时任务 · 生成于 ${beijingTime(overview.generatedAt)}（北京时间）· 每分钟自动刷新</p></div></div>
${overview.systemdError ? `<div class="op-notice" role="alert">${escapeHtml(overview.systemdError)}；下表的运行时间与状态不可用。</div>` : ""}
<section class="op-metrics" aria-label="状态汇总">${metric("正常", counts.ok, "ok")}${metric("失败 / 未安装", counts.failed + counts.missing, counts.failed + counts.missing ? "bad" : "")}${metric("数据滞后 / 需关注", counts.stale + counts.attention, counts.stale + counts.attention ? "warn" : "")}${metric("运行中", counts.running, "")}
<div class="op-renewal"><div class="row"><h2>交易授权续签</h2><span class="op-pill ${renewalTone}">${renewal.verified ? escapeHtml(renewal.state) : "未核实"}</span></div><dl><dt>原因</dt><dd class="mono">${escapeHtml(renewal.reason)}</dd>${renewal.verified ? `<dt>买入授权</dt><dd>${renewal.authorizationAllowed && renewal.entryControlsOpen ? "有效" : "已阻断"}</dd><dt>租约到期</dt><dd>${beijingTime(renewal.leaseExpiresAt)}</dd><dt>最终截止</dt><dd>${beijingTime(renewal.hardDeadline)}</dd>` : ""}<dt>检查于</dt><dd>${renewal.checkedAt ? `${beijingTime(renewal.checkedAt)} · ${ageText(renewal.checkedAt, nowMs)}` : "—"}</dd></dl></div></section>
<div class="op-table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>最近运行</th><th>数据截至</th><th>下次运行</th></tr></thead>${table}</table></div>
<p class="op-foot">只读视图：读取 systemd 定时器与各任务产物，不触发、不修改任何任务。「数据截至」取自任务产物中的数据日期或生成时间；交易日数据按当日结束计算滞后。授权有效不代表通过全部交易风控。</p>
</main></body></html>`;
}
