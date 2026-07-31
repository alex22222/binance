export function liveDashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>Agentic Wallet · 实时持仓</title>
  <style>
    :root {
      --bg: #07090d; --panel: #11151c; --panel-2: #171d26; --line: #29313d;
      --text: #f5f7fa; --muted: #8f9baa; --gold: #f5c14f; --green: #51d6a3;
      --red: #ff6c78; --blue: #78a9ff; --panel-shadow: 0 18px 48px rgba(0,0,0,.24);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; color: var(--text);
      -webkit-text-size-adjust: 100%;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 15% -8%, rgba(245,193,79,.12), transparent 31rem),
        radial-gradient(circle at 95% 26%, rgba(120,169,255,.08), transparent 34rem),
        linear-gradient(rgba(255,255,255,.012) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.012) 1px, transparent 1px), var(--bg);
      background-size: auto, auto, 32px 32px, 32px 32px, auto;
    }
    .shell { width: min(1220px, calc(100% - 40px)); margin: 0 auto; }
    header {
      position: sticky; top: 0; z-index: 5; padding: 12px 0 0;
      background: linear-gradient(var(--bg) 0%, rgba(7,9,13,.92) 72%, transparent);
    }
    .nav {
      min-height: 70px; padding: 10px 12px; display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 10px 18px;
      border: 1px solid rgba(255,255,255,.08); border-radius: 17px;
      background: rgba(14,18,24,.88); box-shadow: 0 12px 38px rgba(0,0,0,.22);
      backdrop-filter: blur(18px);
    }
    .brand { grid-column: 1; grid-row: 1; display: flex; align-items: center; gap: 11px; font-weight: 750; white-space: nowrap; }
    .nav-info { display: contents; }
    .top-stats { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; padding-top: 10px; border-top: 1px solid var(--line); background: var(--line); }
    .mark { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; background: var(--gold); color: #171108; font-weight: 900; box-shadow: 0 0 24px rgba(245,193,79,.18); }
    .nav-link { margin-left: 6px; padding: 8px 11px; border: 1px solid rgba(120,169,255,.35); border-radius: 9px; color: #d8e5ff; background: rgba(120,169,255,.08); text-decoration: none; font-size: 12px; transition: background-color .2s, border-color .2s; }
    .nav-link:hover { border-color: rgba(120,169,255,.65); background: rgba(120,169,255,.16); }
    .nav-link:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .top-stat { display: inline-flex; align-items: baseline; justify-content: center; gap: 6px; min-width: 0; white-space: nowrap; padding: 7px 9px; background: #0f1319; }
    .top-stat span { color: var(--muted); font-size: 11px; }
    .top-stat strong { font-size: 14px; letter-spacing: -.02em; }
    .badges { grid-column: 2; grid-row: 1; display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .badge { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: rgba(255,255,255,.018); font: 700 11px ui-monospace, SFMono-Regular, monospace; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
    main { padding: 22px 0 56px; }
    .eyebrow { color: var(--gold); font: 700 12px ui-monospace, SFMono-Regular, monospace; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 13px 0 12px; font-size: clamp(42px, 7vw, 74px); line-height: 1; letter-spacing: -.06em; }
    .lead { margin: 0; color: #aab3bf; max-width: 720px; font-size: 17px; line-height: 1.65; }
    .control-actions { display: flex; gap: 8px; flex-shrink: 0; }
    .control-button { padding: 9px 13px; border: 1px solid var(--line); border-radius: 10px; color: var(--text); background: var(--panel-2); cursor: pointer; font-weight: 720; transition: background-color .2s, border-color .2s, color .2s; }
    .control-button:hover { border-color: #465365; background: #1c2430; }
    .control-button:focus-visible, .approval-button:focus-visible, .signal-toggle:focus-visible, .wallet-login a:focus-visible, .wallet-login button:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .control-button.stop { border-color: rgba(255,108,120,.4); color: #ffadb4; background: rgba(255,108,120,.08); }
    .control-button.resume { border-color: rgba(81,214,163,.35); color: var(--green); background: rgba(81,214,163,.07); }
    .control-button.auto-on { border-color: rgba(255,108,120,.55); color: #ffadb4; background: rgba(255,108,120,.12); }
    .control-button[hidden] { display: none; }
    .approval { padding: 16px; }
    .approval-head { display: flex; justify-content: space-between; gap: 18px; align-items: start; }
    .approval-title { font-size: 27px; font-weight: 780; letter-spacing: -.04em; }
    .approval-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 14px; }
    .approval-cell strong { display: block; margin-top: 7px; font-size: 16px; word-break: break-word; }
    .approval-addresses { margin-top: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: rgba(8,10,14,.45); }
    .approval-check { display: flex; gap: 11px; align-items: start; margin-top: 18px; padding: 14px; border: 1px solid rgba(245,193,79,.35); border-radius: 12px; color: #d9c998; background: rgba(245,193,79,.055); font-size: 13px; line-height: 1.5; cursor: pointer; }
    .approval-check input { width: 17px; height: 17px; margin: 2px 0 0; accent-color: var(--gold); flex: 0 0 auto; }
    .approval-actions { display: flex; gap: 9px; margin-top: 14px; }
    .approval-button { min-height: 52px; padding: 11px 16px; border-radius: 10px; cursor: pointer; font-weight: 760; }
    .approval-button.approve { color: #07150f; border: 1px solid var(--green); background: var(--green); }
    .approval-button.reject { color: #ffadb4; border: 1px solid rgba(255,108,120,.4); background: rgba(255,108,120,.08); }
    .approval-button:disabled { cursor: not-allowed; opacity: .45; }
    .approval-result { margin-top: 12px; color: var(--gold); font-size: 13px; }
    .wallet-login { margin-bottom: 14px; padding: 16px; border-color: rgba(255,108,120,.45); }
    .wallet-login[hidden] { display: none; }
    .wallet-login-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    .wallet-login a, .wallet-login button { min-height: 46px; padding: 11px 14px; border-radius: 10px; font-weight: 750; }
    .wallet-login a { color: #07150f; background: var(--gold); text-decoration: none; }
    .wallet-login button { color: var(--text); border: 1px solid var(--line); background: var(--panel-2); }
    .panel {
      border: 1px solid rgba(255,255,255,.085); background: linear-gradient(145deg, rgba(19,24,32,.96), rgba(13,17,23,.96));
      border-radius: 18px; box-shadow: var(--panel-shadow);
    }
    .label { color: var(--muted); font-size: 11px; letter-spacing: .11em; text-transform: uppercase; }
    .value { display: block; margin-top: 12px; font-size: 25px; letter-spacing: -.04em; }
    .green { color: var(--green); } .red { color: var(--red); } .gold { color: var(--gold); }
    .asset-trend-section { margin-bottom: 20px; }
    .asset-trend-head::after { display: none; }
    .asset-trend-summary { margin-left: auto; color: var(--muted); font-size: 12px; text-align: right; }
    .asset-trend-card { position: relative; min-height: 276px; padding: 12px 14px 8px; overflow: hidden; }
    .asset-trend-chart { display: block; width: 100%; height: 252px; touch-action: pan-y; }
    .asset-trend-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: 13px; pointer-events: none; }
    .asset-trend-empty[hidden] { display: none; }
    .asset-trend-tooltip { position: absolute; z-index: 2; min-width: 104px; padding: 8px 10px; border: 1px solid rgba(120,169,255,.32); border-radius: 9px; color: var(--text); background: rgba(7,9,13,.94); box-shadow: 0 10px 30px rgba(0,0,0,.3); pointer-events: none; transform: translateY(-50%); font-size: 11px; }
    .asset-trend-tooltip[hidden] { display: none; }
    .asset-trend-tooltip strong { display: block; margin-top: 4px; color: var(--blue); font-size: 13px; }
    .dashboard-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; }
    .insight-grid { display: grid; grid-template-columns: 1.25fr 1fr; gap: 18px; margin-top: 20px; }
    section { margin: 0; min-width: 0; }
    .signals-section { grid-column: 1 / -1; }
    .actions-section { margin-top: 24px; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 30px; margin-bottom: 10px; }
    .section-head::after { content: ""; height: 1px; flex: 1; margin-left: 4px; background: linear-gradient(90deg, rgba(255,255,255,.12), transparent); }
    .section-head > :last-child:not(:first-child) { order: 2; }
    h2 { margin: 0; font-size: 17px; letter-spacing: -.025em; white-space: nowrap; }
    .muted { color: var(--muted); }
    .position { padding: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: center; }
    .position + .position { border-top: 1px solid var(--line); }
    .position-symbol { font-size: 24px; font-weight: 780; letter-spacing: -.045em; }
    .position > :first-child { grid-column: 1 / -1; }
    .contract { margin-top: 7px; color: var(--muted); font: 11px ui-monospace, SFMono-Regular, monospace; word-break: break-all; }
    .position-cell strong { display: block; margin-top: 7px; font-size: 19px; }
    .empty { min-height: 118px; display: grid; place-items: center; padding: 22px; text-align: center; color: var(--muted); background: radial-gradient(circle at 50% 50%, rgba(120,169,255,.04), transparent 55%); }
    .signals { overflow: hidden; }
    .signal-table-head, .signal { display: grid; grid-template-columns: 1.05fr .65fr 1.15fr .9fr .85fr; gap: 10px; align-items: center; }
    .signal-table-head { padding: 12px 16px; border-bottom: 1px solid var(--line); color: var(--muted); background: rgba(255,255,255,.018); font-size: 10px; letter-spacing: .05em; }
    .signal { min-height: 60px; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,.055); transition: background-color .2s; }
    .signal:hover { background: rgba(120,169,255,.035); }
    .signal:last-child { border-bottom: 0; }
    .signal.historical { background: rgba(245,193,79,.025); }
    .signal-code { display: flex; flex-direction: column; gap: 3px; font-weight: 780; }
    .signal-symbol-link { width: max-content; color: var(--text); text-decoration-color: rgba(120,169,255,.45); text-underline-offset: 3px; }
    .signal-symbol-link:hover { color: var(--blue); text-decoration-color: currentColor; }
    .signal-symbol-link:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; border-radius: 3px; }
    .signal-source { color: var(--gold); font-size: 9px; font-weight: 700; }
    .signal-shadow { color: var(--gold); font-size: 9px; font-weight: 700; }
    .signal-context { color: var(--muted); font-size: 11px; }
    .signal-direction { font-size: 18px; }
    .signal-strength, .signal-time { color: var(--muted); font-size: 11px; }
    .signal-change { font-size: 14px; letter-spacing: -.02em; }
    .signal-toggle { display: none; width: 100%; min-height: 44px; border: 0; border-top: 1px solid var(--line); color: var(--muted); background: transparent; cursor: pointer; font-weight: 700; }
    .action-head-tools { display: flex; align-items: center; gap: 10px; }
    .timeline-filters { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.02); }
    .timeline-filter { min-height: 32px; padding: 6px 10px; border: 0; border-radius: 7px; color: var(--muted); background: transparent; cursor: pointer; font-size: 11px; font-weight: 720; }
    .timeline-filter span { margin-left: 4px; font: 700 10px ui-monospace, SFMono-Regular, monospace; }
    .timeline-filter.active { color: var(--text); background: var(--panel-2); box-shadow: 0 4px 14px rgba(0,0,0,.22); }
    .timeline-filter:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .timeline { max-height: 300px; overflow: auto; box-shadow: none; }
    .event { display: grid; grid-template-columns: 66px 1fr; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); align-items: start; }
    .event:last-child { border-bottom: 0; }
    .event time { color: #768292; font: 11px ui-monospace, SFMono-Regular, monospace; }
    .event-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .event-name { font-weight: 680; }
    .event-kind { padding: 3px 6px; border: 1px solid rgba(120,169,255,.25); border-radius: 999px; color: var(--blue); font-size: 9px; font-weight: 720; }
    .event-kind.decision { border-color: rgba(245,193,79,.3); color: var(--gold); }
    .event-kind.trade { border-color: rgba(81,214,163,.3); color: var(--green); }
    .event-details { margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.5; word-break: break-word; }
    .event-status { color: var(--blue); font: 700 10px ui-monospace, SFMono-Regular, monospace; grid-column: 2; }
    .event-status.green { color: var(--green); }
    .event-status.red { color: var(--red); }
    .event-status.gold { color: var(--gold); }
    .event-raw { margin-top: 7px; color: #738091; font-size: 10px; }
    .event-raw summary { width: max-content; cursor: pointer; user-select: none; }
    .event-raw pre { margin: 6px 0 0; padding: 8px; overflow: auto; border-radius: 8px; background: rgba(0,0,0,.2); font: 10px/1.45 ui-monospace, SFMono-Regular, monospace; white-space: pre-wrap; word-break: break-word; }
    .policy-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .policy-item { min-height: 92px; padding: 13px; border: 1px solid rgba(255,255,255,.075); border-radius: 14px; background: linear-gradient(145deg, rgba(20,25,33,.96), rgba(14,18,24,.96)); box-shadow: 0 10px 28px rgba(0,0,0,.16); }
    .policy-item strong { display: block; margin-top: 7px; font-size: 13px; line-height: 1.45; }
    .workflow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 14px; }
    .workflow-step { min-height: 92px; padding: 12px 10px; border: 1px solid var(--line); border-radius: 12px; color: var(--muted); background: rgba(255,255,255,.015); }
    .workflow-step.active { border-color: rgba(81,214,163,.45); color: var(--green); background: rgba(81,214,163,.06); }
    .workflow-step strong { display: block; margin-top: 8px; color: inherit; font-size: 12px; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
    @media (max-width: 900px) {
      .nav { display: flex; align-items: stretch; flex-direction: column; }
      .nav-info { display: flex; justify-content: space-between; }
      .top-stats { width: 100%; }
      .dashboard-grid { grid-template-columns: 1fr 1fr; }
      .signals-section { grid-column: 1 / -1; }
      .insight-grid { grid-template-columns: 1fr; }
      .position { grid-template-columns: 1fr 1fr; }
      .position > :first-child { grid-column: 1 / -1; }
    }
    @media (max-width: 600px) {
      .shell { width: min(100% - 24px, 480px); }
      header { position: static; padding-top: calc(8px + env(safe-area-inset-top)); }
      main { padding-top: 16px; padding-bottom: calc(36px + env(safe-area-inset-bottom)); }
      .asset-trend-section { margin-bottom: 18px; }
      .asset-trend-head { align-items: flex-end; }
      .asset-trend-summary { max-width: 62%; font-size: 10px; line-height: 1.35; }
      .asset-trend-card { min-height: 218px; padding: 8px 8px 4px; }
      .asset-trend-chart { height: 204px; }
      .dashboard-grid { grid-template-columns: 1fr; gap: 18px; }
      .signals-section { grid-column: auto; }
      .policy-grid { grid-template-columns: 1fr 1fr; }
      .workflow { grid-template-columns: repeat(3, 1fr); }
      .section-head { align-items: center; margin-bottom: 10px; }
      h2 { font-size: 19px; }
      .action-section-head { align-items: flex-start; flex-wrap: wrap; }
      .action-section-head::after { display: none; }
      .action-head-tools { width: 100%; align-items: stretch; flex-direction: column; gap: 6px; }
      .action-head-tools #lastError:empty { display: none; }
      .timeline-filters { width: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .timeline-filter { min-width: 0; padding-inline: 4px; white-space: nowrap; }
      .event { grid-template-columns: 54px minmax(0, 1fr); padding-inline: 9px; }
      .control-button { min-height: 44px; }
      .nav { align-items: stretch; flex-direction: column; gap: 12px; padding: 12px; border-radius: 16px; }
      .brand { min-height: 44px; }
      .nav-link { min-height: 40px; display: inline-flex; align-items: center; }
      .nav-info { width: 100%; flex-direction: column-reverse; align-items: stretch; gap: 12px; }
      .top-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0; padding: 12px 0 0; border-top: 1px solid var(--line); }
      .top-stat { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 8px 6px; text-align: center; }
      .top-stat + .top-stat { border-left: 1px solid var(--line); }
      .top-stat:nth-child(odd) { border-left: 0; }
      .top-stat:nth-child(n+3) { border-top: 1px solid var(--line); }
      .top-stat strong { font-size: 15px; }
      .badges { justify-content: flex-start; align-items: center; }
      .control-actions { width: 100%; margin-left: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; }
      .control-button { min-width: 0; }
      .approval { padding: 16px; }
      .approval-title { font-size: 25px; }
      .approval-grid { grid-template-columns: 1fr 1fr; }
      .approval-actions { display: grid; grid-template-columns: 1fr 1fr; }
      .approval-button { min-height: 56px; padding: 10px 8px; }
      .position { grid-template-columns: 1fr 1fr; }
      .position-cell strong { font-size: 16px; }
      .signal-table-head, .signal { grid-template-columns: 1.05fr .65fr 1.15fr .9fr .85fr; gap: 6px; }
      .signal-table-head { padding: 10px 9px; font-size: 9px; letter-spacing: 0; }
      .signal { min-height: 58px; padding: 10px 9px; }
      .signal-code, .signal-change { font-size: 12px; }
      .signal-direction { font-size: 16px; }
      .signal-strength, .signal-time { font-size: 10px; }
      #signals:not(.expanded) .signal:nth-child(n+6) { display: none; }
      .signal-toggle { display: block; }
      .timeline { max-height: 300px; }
      .insight-grid { gap: 18px; margin-top: 18px; }
      .actions-section { margin-top: 18px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <div class="brand"><span class="mark">A</span><span>Agentic Wallet</span><a class="nav-link" href="/strategies">策略</a><a class="nav-link" href="/reviews">复盘</a></div>
      <div class="nav-info"><div class="top-stats"><span class="top-stat"><span>钱包余额</span><strong id="walletBalance">—</strong></span><span class="top-stat"><span>盈亏</span><strong class="green" id="realizedPnl">—</strong></span><span class="top-stat"><span>日亏余量</span><strong id="dailyLossRemaining">—</strong></span><span class="top-stat"><span>单笔上限</span><strong id="maxTrade">—</strong></span></div><div class="badges"><span class="badge" id="walletStatus" aria-live="polite"><span class="dot"></span><span>钱包 未检测</span></span><span class="badge" id="mode"><span class="dot"></span><span></span></span><span class="badge" id="health"><span class="dot"></span><span></span></span><div class="control-actions"><button class="control-button" id="autoApprovalToggle" type="button" role="switch" aria-checked="false">自动审批：关</button><button class="control-button stop" id="stopButton" type="button">停机</button><button class="control-button resume" id="resumeButton" type="button" hidden>恢复</button></div></div></div>
    </div>
  </header>
  <main class="shell">
    <section class="panel wallet-login" id="walletLogin" hidden>
      <h2>钱包已断开</h2>
      <p class="muted">生成一次性 Binance 授权页面。同一台手机可直接打开；使用另一台设备时可在官方页面扫码。</p>
      <div class="wallet-login-actions">
        <button id="walletLoginStart" type="button">生成扫码授权</button>
        <a id="walletLoginLink" target="_blank" rel="noopener noreferrer" hidden>打开 Binance 授权页面</a>
      </div>
      <div class="approval-result" id="walletLoginStatus"></div>
    </section>
    <section class="asset-trend-section">
      <div class="section-head asset-trend-head"><h2>资产趋势</h2><span class="asset-trend-summary" id="assetTrendSummary">读取资产快照…</span></div>
      <div class="panel asset-trend-card" id="assetTrendCard">
        <canvas class="asset-trend-chart" id="assetTrendChart" role="img" aria-label="每日钱包总资产趋势"></canvas>
        <div class="asset-trend-empty" id="assetTrendEmpty">等待首次资产快照</div>
        <div class="asset-trend-tooltip" id="assetTrendTooltip" hidden></div>
      </div>
    </section>
    <div class="dashboard-grid">
    <section>
      <div class="section-head"><h2>待确认订单</h2></div>
      <div class="panel" id="approval"></div>
    </section>

    <section>
      <div class="section-head"><h2>持仓</h2></div>
      <div class="panel" id="position"></div>
    </section>

    <section class="signals-section">
      <div class="section-head"><h2>信号</h2><span class="signal-context" id="signalContext">读取市场状态…</span></div>
      <div class="panel signals">
        <div class="signal-table-head" aria-hidden="true"><span>代码</span><span>方向</span><span>强度 / 15分钟</span><span>变化</span><span>拉取时间</span></div>
        <div id="signals"></div>
        <button class="signal-toggle" id="signalToggle" type="button" aria-expanded="false">查看全部</button>
      </div>
    </section>

    </div>
    <div class="insight-grid">
      <section>
        <div class="section-head"><h2>策略与风控</h2></div>
        <div id="strategyRisk"></div>
      </section>
      <section>
        <div class="section-head"><h2>执行流程</h2></div>
        <div class="panel" id="workflow"></div>
      </section>
    </div>
    <section class="actions-section">
      <div class="section-head action-section-head"><h2>动作</h2><div class="action-head-tools"><span class="muted" id="lastError"></span><div class="timeline-filters" role="group" aria-label="动作日志筛选"><button class="timeline-filter active" id="timelineDecisionFilter" type="button" aria-pressed="true">决策判断 <span id="timelineDecisionCount">0</span></button><button class="timeline-filter" id="timelineTradeFilter" type="button" aria-pressed="false">交易动作 <span id="timelineTradeCount">0</span></button><button class="timeline-filter" id="timelineSystemFilter" type="button" aria-pressed="false">系统日志 <span id="timelineSystemCount">0</span></button></div></div></div>
      <div class="panel timeline" id="timeline"></div>
    </section>
  </main>
  <script>
    const money = (value) => value == null ? "—" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pct = (value) => value == null ? "—" : (Number(value) >= 0 ? "+" : "") + Number(value).toFixed(3) + "%";
    const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "等待首次心跳";
    const shortTime = (value) => value ? new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
    const countdown = (value) => {
      const seconds = Math.max(0, Math.floor((Date.parse(value || "") - Date.now()) / 1000));
      return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
    };
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    const tradingViewSymbols = {
      NVDA: "NASDAQ:NVDA",
      TSLA: "NASDAQ:TSLA",
      AAPL: "NASDAQ:AAPL",
      MSFT: "NASDAQ:MSFT",
      AMZN: "NASDAQ:AMZN",
      META: "NASDAQ:META",
      CRCL: "NYSE:CRCL",
      GOOGL: "NASDAQ:GOOGL",
      SPY: "AMEX:SPY",
      QQQ: "NASDAQ:QQQ"
    };
    const stockChartUrl = (symbol) => {
      const tradingViewSymbol = tradingViewSymbols[symbol];
      return tradingViewSymbol
        ? "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(tradingViewSymbol)
        : null;
    };
    const decisionEvents = new Set([
      "candidate_evaluated",
      "candidate_evaluation",
      "candidate_rejected",
      "candidate_selected",
      "cost_coverage_decision",
      "entry_decision",
      "exit_decision",
      "shadow_risk_overlay",
      "shadow_sub_strategy",
      "signal_refresh",
      "token_audit_decision"
    ]);
    const tradeEvents = new Set([
      "buy_submission",
      "gas_accounting",
      "market_order",
      "order_intent",
      "order_recovery",
      "order_submission",
      "pending_order",
      "position_change",
      "sell_submission",
      "trade_approval"
    ]);
    const actionEventLabels = {
      buy_submission: "买入提交",
      candidate_evaluated: "候选评估",
      candidate_evaluation: "候选评估",
      candidate_rejected: "候选未通过",
      candidate_selected: "入场候选",
      cost_coverage_decision: "成本覆盖判断",
      cycle: "轮询周期",
      entry_decision: "入场判断",
      exit_decision: "退出判断",
      external_api_call: "外部接口调用",
      external_api_retry: "外部接口重试",
      feishu_notification: "飞书通知",
      feishu_retry: "飞书重试",
      gas_accounting: "Gas 成本记录",
      market_order: "市场订单",
      mock_result_saved: "模拟结果保存",
      mock_trade: "模拟交易",
      order_intent: "订单意图",
      order_recovery: "订单恢复",
      order_submission: "订单提交",
      pending_order: "待处理订单",
      position_change: "持仓变化",
      position_monitoring: "持仓监控",
      sell_submission: "卖出提交",
      shadow_risk_overlay: "Shadow 风控观察",
      shadow_sub_strategy: "Shadow 子策略观察",
      shutdown: "系统停止",
      signal_refresh: "信号刷新判断",
      startup: "系统启动",
      state_saved: "状态已保存",
      token_audit_decision: "代币审计判断",
      trade_approval: "交易审批",
      wallet_balance: "钱包余额查询",
      wallet_cli: "钱包命令调用",
      wallet_cli_retry: "钱包命令重试",
      wallet_session_check: "钱包会话检查",
      wallet_status_fallback: "钱包状态复核"
    };
    const actionStatusLabels = {
      allowed: "已放行",
      ambiguous: "状态不明确",
      approved: "已批准",
      auto_approved: "自动批准",
      closed: "已关闭",
      failed: "失败",
      fallback: "使用估算",
      finished: "已完成",
      halted: "已暂停",
      invalidated: "已失效",
      observed: "已记录",
      persisted: "已保存",
      reconciled: "已核对",
      requested: "待确认",
      scheduled: "已安排重试",
      simulated: "模拟执行",
      skipped: "未执行",
      started: "进行中",
      submitted: "已提交",
      succeeded: "成功",
      triggered: "已触发",
      waiting: "等待中"
    };
    const actionReasonLabels = {
      already_held: "已持有该标的",
      cooldown: "仍在冷却期",
      daily_loss_limit: "已达到日亏损上限",
      dynamic_exit_not_triggered: "未触发退出条件",
      fresh_cost_not_covered: "最新报价无法覆盖全部成本",
      fresh_initial_risk_rejected: "最新波动对应止损超出上限",
      fresh_quote_no_longer_triggers_exit: "复核报价已不满足退出条件",
      fresh_round_trip_cost: "最新往返成本超限",
      market_status_interval: "未到下一次市场状态检查",
      market_status_unavailable: "市场状态不可用",
      market_or_trend_gate: "市场状态或趋势未通过",
      max_open_positions: "已达到最大持仓数",
      no_candidate_passed: "没有候选通过全部入场门槛",
      no_eligible_symbol: "没有可扫描标的",
      no_loss_floor: "未达到覆盖全部成本的退出底线",
      non_regular_session: "当前不是美股常规交易时段",
      quote_drift: "报价漂移超限",
      signal: "收到停止信号",
      signal_refresh_interval: "未到下一次持仓信号刷新",
      stop_loss_override: "止损优先于不亏损底线",
      insufficient_closed_candles: "收盘分钟线数量不足",
      insufficient_closed_atr_candles: "ATR 收盘数据不足",
      COSTS_COVERED: "预计收益覆盖全部成本",
      INSUFFICIENT_NET_EDGE: "扣除成本后净收益不足",
      TARGET_DOES_NOT_COVER_COSTS: "止盈目标无法覆盖全部成本"
    };
    const actionValueLabels = {
      BUY: "买入",
      SELL: "卖出",
      FLAT: "空仓",
      LONG: "持仓",
      CONNECTED: "已连接",
      REGULAR_OPEN_TRANSITION: "常规交易时段开盘复查",
      STANDARD_ENTRY_CADENCE: "标准 15 分钟入场节奏",
      "market-order list": "查询市场订单",
      "market-order quote": "获取交易报价",
      "market-order swap": "提交兑换订单",
      "wallet balance": "查询钱包余额",
      "wallet settings": "查询钱包设置",
      "wallet status": "钱包状态"
    };
    const actionDetailLabels = {
      candidateCount: "候选数",
      endpoint: "接口",
      error: "错误",
      expectedProceedsUsdt: "预计回收",
      expiresAt: "确认截止",
      from: "原状态",
      gasUsdt: "Gas",
      hasPendingOrder: "待处理订单",
      intervalMs: "间隔",
      method: "方法",
      openPositionCount: "当前持仓",
      operation: "操作",
      orderId: "订单",
      positionCount: "持仓数",
      proceedsUsdt: "回收",
      realizedPnlUsdt: "已实现盈亏",
      reason: "原因",
      returnPct: "当前收益",
      scheduleReason: "调度",
      side: "方向",
      status: "状态",
      symbol: "标的",
      to: "新状态"
    };
    const durationLabel = (milliseconds) => {
      const minutes = Number(milliseconds) / 60_000;
      return Number.isFinite(minutes) ? (minutes >= 1 ? minutes.toFixed(minutes % 1 ? 1 : 0) + " 分钟" : Math.round(Number(milliseconds) / 1000) + " 秒") : "—";
    };
    const actionValue = (key, value) => {
      if (value == null) return "—";
      if (key === "reason") return actionReasonLabels[value] || value;
      if (["from", "operation", "scheduleReason", "side", "status", "to"].includes(key)) return actionValueLabels[value] || value;
      if (key === "intervalMs") return durationLabel(value);
      if (key === "returnPct") return pct(value);
      if (["expectedProceedsUsdt", "gasUsdt", "proceedsUsdt", "realizedPnlUsdt"].includes(key)) return money(value) + " USDT";
      if (typeof value === "boolean") return value ? "是" : "否";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    };
    function actionSummary(record) {
      const details = record.details || {};
      const preferredKeys = record.event === "exit_decision"
        ? ["symbol", "reason", "returnPct"]
        : record.event === "state_saved"
          ? ["positionCount", "hasPendingOrder", "realizedPnlUsdt"]
          : record.event === "cycle"
            ? ["positionCount", "hasPendingOrder", "error"]
            : record.event === "external_api_call"
              ? ["method", "endpoint", "error"]
              : ["symbol", "reason", "scheduleReason", "intervalMs", "error"];
      const entries = preferredKeys
        .filter((key) => details[key] != null)
        .map((key) => (actionDetailLabels[key] || key) + "：" + actionValue(key, details[key]));
      if (entries.length) return entries.join(" · ");
      const fallback = Object.entries(details).slice(0, 3);
      return fallback.length
        ? fallback.map(([key, value]) => (actionDetailLabels[key] || key) + "：" + actionValue(key, value)).join(" · ")
        : "无附加信息";
    }
    function actionCategory(record) {
      if (decisionEvents.has(record.event)) return "decision";
      if (tradeEvents.has(record.event)) return "trade";
      return "system";
    }
    function tradeActionSummary(record) {
      const details = record.details || {};
      const symbol = details.symbol ? details.symbol + " · " : "";
      if (record.event === "trade_approval") {
        return "交易审批：" + symbol + actionValue("side", details.side) + " · " + (actionStatusLabels[record.status] || record.status) +
          (details.expiresAt ? " · 截止 " + new Date(details.expiresAt).toLocaleString("zh-CN", { hour12: false }) : "");
      }
      if (record.event === "buy_submission") {
        return "买入提交：" + symbol + (details.amountUsdt == null ? "金额待确认" : money(details.amountUsdt) + " USDT") +
          (details.orderId ? " · 订单 " + details.orderId : "");
      }
      if (record.event === "sell_submission") {
        const proceedsUsdt = details.expectedProceedsUsdt ?? details.proceedsUsdt;
        return "卖出提交：" + symbol +
          (proceedsUsdt == null ? "回收金额待确认" : "预计回收 " + money(proceedsUsdt) + " USDT") +
          (details.realizedPnlUsdt == null ? "" : " · 已实现 " + (Number(details.realizedPnlUsdt) >= 0 ? "+" : "") + money(details.realizedPnlUsdt) + " USDT");
      }
      if (record.event === "position_change") {
        return "持仓变化：" + symbol + actionValue("from", details.from) + " → " + actionValue("to", details.to) +
          (details.realizedPnlUsdt == null ? "" : " · 已实现 " + (Number(details.realizedPnlUsdt) >= 0 ? "+" : "") + money(details.realizedPnlUsdt) + " USDT");
      }
      if (record.event === "pending_order") {
        return "订单进度：" + symbol + actionValue("side", details.side) + " · " + (actionStatusLabels[record.status] || record.status) +
          (details.orderId ? " · " + details.orderId : "");
      }
      if (record.event === "order_intent") {
        return "准备下单：" + symbol + actionValue("side", details.side);
      }
      if (record.event === "order_submission") {
        return "下单结果待确认：" + symbol + actionValue("side", details.side) + (details.error ? " · " + details.error : "");
      }
      if (record.event === "order_recovery") {
        return "订单恢复：" + (details.orderId || details.intentId || "待核对") + " · " + (actionStatusLabels[record.status] || record.status);
      }
      if (record.event === "gas_accounting") {
        const gasUsdt = details.gasUsdt ?? details.fallbackGasUsdt;
        return "Gas 结算：" + (gasUsdt == null ? "使用预估值" : money(gasUsdt) + " USDT（预估）");
      }
      if (record.event === "market_order") {
        return "模拟订单：" + (details.fromTokenQty == null ? "金额待确认" : details.fromTokenQty + " · ") + (details.orderId || "未生成订单号");
      }
      return actionSummary(record);
    }
    let timelineFilter = "decision";
    let recentActionRecords = [];
    let submittedApprovalId = null;
    let autoApprovalEnabled = false;
    let walletLoginPoll = null;
    let assetTrendPoints = [];
    let assetTrendHoverIndex = null;
    let assetTrendGeometry = [];
    function assetTrendDateLabel(value) {
      const parts = String(value || "").split("-");
      return parts.length === 3 ? parts[1] + "/" + parts[2] : value;
    }
    function traceAssetTrendPath(context, points) {
      if (!points.length) return;
      context.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        const middleX = (previous.x + current.x) / 2;
        context.bezierCurveTo(middleX, previous.y, middleX, current.y, current.x, current.y);
      }
    }
    function drawAssetTrend() {
      const canvas = document.getElementById("assetTrendChart");
      const context = canvas.getContext("2d");
      const width = Math.max(280, canvas.clientWidth);
      const height = Math.max(180, canvas.clientHeight);
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      assetTrendGeometry = [];
      if (!assetTrendPoints.length) return;

      const compact = width < 520;
      const padding = { top: 18, right: compact ? 12 : 20, bottom: 30, left: compact ? 42 : 54 };
      const plotWidth = width - padding.left - padding.right;
      const plotHeight = height - padding.top - padding.bottom;
      const values = assetTrendPoints.map((point) => Number(point.totalUsd));
      const low = Math.min(...values);
      const high = Math.max(...values);
      const spread = Math.max(high - low, Math.max(1, high * 0.04));
      const minimum = Math.max(0, low - spread * 0.22);
      const maximum = high + spread * 0.22;
      const range = Math.max(1, maximum - minimum);
      assetTrendGeometry = assetTrendPoints.map((point, index) => ({
        x: assetTrendPoints.length === 1
          ? padding.left + plotWidth / 2
          : padding.left + (index / (assetTrendPoints.length - 1)) * plotWidth,
        y: padding.top + ((maximum - Number(point.totalUsd)) / range) * plotHeight
      }));

      context.lineWidth = 1;
      context.font = (compact ? "10px" : "11px") + " ui-monospace, SFMono-Regular, monospace";
      context.fillStyle = "#7f8b9a";
      context.strokeStyle = "rgba(143,155,170,.18)";
      context.textAlign = "right";
      context.textBaseline = "middle";
      for (let index = 0; index < 4; index += 1) {
        const y = padding.top + (index / 3) * plotHeight;
        const value = maximum - (index / 3) * range;
        context.beginPath();
        context.moveTo(padding.left, y);
        context.lineTo(width - padding.right, y);
        context.stroke();
        context.fillText("$" + money(value), padding.left - 8, y);
      }

      const labelEvery = Math.max(1, Math.ceil(assetTrendPoints.length / (compact ? 4 : 8)));
      context.textAlign = "center";
      context.textBaseline = "top";
      assetTrendPoints.forEach((point, index) => {
        if (index % labelEvery !== 0 && index !== assetTrendPoints.length - 1) return;
        context.fillText(assetTrendDateLabel(point.date), assetTrendGeometry[index].x, height - padding.bottom + 10);
      });

      const fill = context.createLinearGradient(0, padding.top, 0, height - padding.bottom);
      fill.addColorStop(0, "rgba(120,169,255,.24)");
      fill.addColorStop(1, "rgba(120,169,255,.015)");
      context.beginPath();
      traceAssetTrendPath(context, assetTrendGeometry);
      context.lineTo(assetTrendGeometry.at(-1).x, height - padding.bottom);
      context.lineTo(assetTrendGeometry[0].x, height - padding.bottom);
      context.closePath();
      context.fillStyle = fill;
      context.fill();

      context.beginPath();
      traceAssetTrendPath(context, assetTrendGeometry);
      context.strokeStyle = "#78a9ff";
      context.lineWidth = 3;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();

      assetTrendGeometry.forEach((point, index) => {
        if (assetTrendPoints.length > 16 && index !== assetTrendHoverIndex && index !== assetTrendPoints.length - 1) return;
        context.beginPath();
        context.arc(point.x, point.y, index === assetTrendHoverIndex ? 5 : 3.5, 0, Math.PI * 2);
        context.fillStyle = "#11151c";
        context.fill();
        context.strokeStyle = index === assetTrendHoverIndex ? "#f5c14f" : "#78a9ff";
        context.lineWidth = 2;
        context.stroke();
      });
    }
    function renderAssetTrend(points) {
      assetTrendPoints = Array.isArray(points)
        ? points.filter((point) => Number.isFinite(Number(point.totalUsd)))
        : [];
      const empty = document.getElementById("assetTrendEmpty");
      empty.hidden = assetTrendPoints.length > 0;
      const summary = document.getElementById("assetTrendSummary");
      if (!assetTrendPoints.length) {
        summary.textContent = "每日最后一次成功快照";
      } else {
        const first = assetTrendPoints[0];
        const latest = assetTrendPoints.at(-1);
        const change = Number(latest.totalUsd) - Number(first.totalUsd);
        const changePct = Number(first.totalUsd) > 0 ? change / Number(first.totalUsd) * 100 : null;
        summary.className = "asset-trend-summary " + (change < 0 ? "red" : change > 0 ? "green" : "");
        summary.textContent = assetTrendPoints.length === 1
          ? "当前 $" + money(latest.totalUsd) + " · 开始记录"
          : assetTrendPoints.length + " 日 · " + (change >= 0 ? "+" : "") + "$" + money(change) +
            (changePct == null ? "" : " (" + (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%)");
      }
      const canvas = document.getElementById("assetTrendChart");
      canvas.setAttribute("aria-label", assetTrendPoints.length
        ? "每日钱包总资产趋势，共 " + assetTrendPoints.length + " 个快照"
        : "每日钱包总资产趋势，等待首次快照");
      assetTrendHoverIndex = null;
      document.getElementById("assetTrendTooltip").hidden = true;
      drawAssetTrend();
    }
    async function pollWalletLogin() {
      const response = await fetch("/api/wallet-login/status", { cache: "no-store" });
      const login = await response.json();
      const status = document.getElementById("walletLoginStatus");
      if (login.status === "CONNECTED") {
        status.textContent = "钱包授权成功，等待 Bot 复核连接状态…";
        clearInterval(walletLoginPoll);
        walletLoginPoll = null;
        await refresh();
      } else if (["FAILED", "EXPIRED"].includes(login.status)) {
        status.textContent = login.error || "授权失败，请重新生成";
        clearInterval(walletLoginPoll);
        walletLoginPoll = null;
      }
    }
    async function startWalletLogin() {
      const status = document.getElementById("walletLoginStatus");
      status.textContent = "正在生成一次性授权…";
      const response = await fetch("/api/wallet-login/start", { method: "POST" });
      const login = await response.json();
      if (!response.ok) {
        status.textContent = login.error || "无法启动钱包登录";
        return;
      }
      if (login.status === "CONNECTED") {
        status.textContent = "钱包已经连接";
        return;
      }
      const link = document.getElementById("walletLoginLink");
      link.href = login.urlForWeb;
      link.hidden = false;
      status.textContent = "配对码：" + login.pairingCode + " · 请核对后在 Binance App 确认";
      clearInterval(walletLoginPoll);
      walletLoginPoll = setInterval(pollWalletLogin, 2000);
    }
    function renderPosition(data) {
      const root = document.getElementById("position");
      root.replaceChildren();
      const positions = Array.isArray(data.positions)
        ? data.positions
        : data.position
          ? [data.position]
          : [];
      if (!positions.length) {
        const copy = data.pendingOrder ? "处理中：" + data.pendingOrder.side + " " + data.pendingOrder.symbol : "空仓";
        root.append(el("div", "empty", copy));
        return;
      }
      positions.forEach((position) => {
        const row = el("div", "position");
        const identity = el("div");
        identity.append(
          el("div", "position-symbol", position.symbol + " · " + (position.shadow ? "SHADOW" : "ON-CHAIN")),
          el("div", "contract", position.address)
        );
        row.append(identity);
        const pnlText = position.unrealizedPnlUsdt == null
          ? "等待首个可执行报价"
          : (position.unrealizedPnlUsdt >= 0 ? "+" : "") + money(position.unrealizedPnlUsdt) + " USDT · " + pct(position.returnPct);
        const gasText = money(position.entryGasUsdt) + " 已计入场 · " +
          money(position.estimatedExitGasUsdt) + " 预估出场";
        const riskText = position.initialRiskPct == null
          ? "等待风险参数"
          : "1R " + money(position.riskUsdt) + " USDT · 报价 MAE " +
            (position.maeR == null ? "待采集" : position.maeR.toFixed(2) + "R") +
            " · MFE " + (position.mfeR == null ? "待采集" : position.mfeR.toFixed(2) + "R") +
            " · 峰值 " + pct(position.peakReturnPct) +
            " · 成本下限 " + pct(position.profitFloorPct) +
            " · 保护 " + (position.trailingStopPct == null ? "未启用" : pct(position.trailingStopPct));
        [
          ["数量", String(position.quantity)],
          ["成本", money(position.costBasisUsdt) + " USDT"],
          ["可执行卖出值", money(position.lastQuoteProceedsUsdt) + " USDT"],
          ["预估净盈亏", pnlText],
          ["Gas", gasText],
          ["动态风控", riskText]
        ].forEach(([label, value], index) => {
          const cell = el("div", "position-cell");
          cell.append(el("span", "label", label), el("strong", index === 3 ? (position.unrealizedPnlUsdt >= 0 ? "green" : "red") : "", value));
          row.append(cell);
        });
        root.append(row);
      });
    }
    function renderApproval(data) {
      const root = document.getElementById("approval");
      root.replaceChildren();
      const request = data.approvalRequest;
      if (!request) {
        const shadowPosition = (data.positions || []).find((position) => position.shadow) || data.position;
        const copy = data.mode === "shadow"
          ? shadowPosition?.shadow
            ? "当前为 SHADOW 模拟：" + shadowPosition.symbol + " 等模拟仓位不会扣除钱包资产，不能确认。切换 Live 后，新的合格候选才会在这里出现真实确认按钮。"
            : "当前为 SHADOW 模拟：候选即使通过也只会模拟，不会生成真实确认按钮。"
          : "暂无待确认订单";
        root.append(el("div", "empty", copy));
        submittedApprovalId = null;
        return;
      }
      const panel = el("div", "approval");
      const head = el("div", "approval-head");
      const identity = el("div");
      identity.append(
        el("div", "approval-title " + (request.side === "BUY" ? "green" : "gold"), request.side + " · " + request.symbol),
        el("div", "contract", request.address)
      );
      const statusText = request.automaticallyApproved
        ? "自动复核中"
        : request.canDecide
          ? "过期倒计时 " + countdown(request.expiresAt)
          : request.displayStatus;
      head.append(identity, el(
        "span",
        "badge " + (request.canDecide || request.automaticallyApproved ? "gold" : "red"),
        statusText
      ));
      panel.append(head);
      const grid = el("div", "approval-grid");
      const expected = request.side === "BUY"
        ? String(request.expectedOutputQty) + " " + request.symbol
        : money(request.expectedOutputQty) + " USDT";
      [
        ["支付数量", String(request.fromTokenQty)],
        ["预计收到", expected],
        ["报价往返成本", pct(request.roundTripCostPct)],
        ["全成本估算", pct(request.allInCostPct)],
        ["15分钟趋势", pct(request.trend15mPct)],
        ["初始风险 R", pct(request.initialRiskPct)],
        ["Shadow 建议", request.shadowRisk
          ? (request.shadowRisk.trendQuality?.decision === "WOULD_BLOCK" ? "高波动震荡 · " : "") +
            (request.shadowRisk.concentration?.decision === "WOULD_LIMIT" ? "集中度限制 · " : "") +
            "建议 " + money(request.shadowRisk.positionSize?.suggestedTradeUsdt) + " USDT（仅观测）"
          : "—"],
        ["退出原因", request.reason || "—"],
        ["有效期至", time(request.expiresAt)]
      ].forEach(([label, value]) => {
        const cell = el("div", "approval-cell");
        cell.append(el("span", "label", label), el("strong", "", value));
        grid.append(cell);
      });
      panel.append(grid);
      const addresses = el("div", "approval-addresses");
      addresses.append(
        el("div", "label", "完整合约地址"),
        el("div", "contract", "来源：" + request.fromToken),
        el("div", "contract", "目标：" + request.toToken),
        el("div", "contract", "审计：" + (request.audit?.riskLevel || request.audit?.status || "TRUSTED_TARGET")),
        el("div", "contract", "滑点：" + data.strategy.slippagePct + "% · MEV保护：开 · Gas：HIGH · 审批编号：" + request.approvalId)
      );
      panel.append(addresses);
      if (request.automaticallyApproved) {
        panel.append(el(
          "div",
          "approval-result",
          "已自动审批，等待重新报价与风控复核；本页面无需人工操作。"
        ));
        root.append(panel);
        submittedApprovalId = null;
        return;
      }
      const requiresAuditAcknowledgement = request.audit?.status === "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED";
      let auditAcknowledgement = null;
      if (requiresAuditAcknowledgement) {
        const check = el("label", "approval-check");
        auditAcknowledgement = el("input");
        auditAcknowledgement.type = "checkbox";
        auditAcknowledgement.checked = true;
        const copy = el("span", "", "审计数据不可用：此官方 RWA 标的在 BSC 上没有可用的安全审计数据。我已阅读并仍要继续本笔交易。");
        check.append(auditAcknowledgement, copy);
        panel.append(check);
      }
      const actions = el("div", "approval-actions");
      const approve = el("button", "approval-button approve", request.side === "BUY" ? "确认买入" : "确认卖出");
      const reject = el("button", "approval-button reject", "拒绝本次交易");
      approve.type = "button";
      reject.type = "button";
      const alreadySubmitted = submittedApprovalId === request.approvalId;
      const updateApproveState = () => {
        approve.disabled = !request.canDecide || alreadySubmitted || (requiresAuditAcknowledgement && !auditAcknowledgement.checked);
      };
      updateApproveState();
      reject.disabled = !request.canDecide || alreadySubmitted;
      auditAcknowledgement?.addEventListener("change", updateApproveState);
      approve.addEventListener("click", () => decideApproval(request, "APPROVE", auditAcknowledgement?.checked === true));
      reject.addEventListener("click", () => decideApproval(request, "REJECT"));
      actions.append(approve, reject);
      panel.append(actions, el(
        "div",
        "approval-result",
        alreadySubmitted ? "已提交，等待复核" : ""
      ));
      root.append(panel);
    }
    async function decideApproval(request, decision, auditUnavailableAcknowledged = false) {
      const response = await fetch("/api/approval-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: request.approvalId,
          decision,
          confirmation: decision + ":" + request.approvalId,
          dyorAcknowledged: decision === "APPROVE",
          auditUnavailableAcknowledged: decision === "APPROVE" && auditUnavailableAcknowledged
        })
      });
      const result = await response.json();
      if (!response.ok) {
        const message = document.getElementById("approval").querySelector(".approval-result");
        if (message) message.textContent = "决策未记录：" + (result.error || "HTTP " + response.status);
        return;
      }
      submittedApprovalId = request.approvalId;
      await refresh();
    }
    function renderSignals(data) {
      const root = document.getElementById("signals");
      root.replaceChildren();
      const availableSignals = Object.values(data.signals);
      const historicalCount = availableSignals.filter((signal) => signal.source === "local-history").length;
      const liveCount = availableSignals.length - historicalCount;
      const marketClosed = ["offhours", "closed"].includes(data.marketSession);
      const context = document.getElementById("signalContext");
      context.className = "signal-context" + (historicalCount ? " gold" : "");
      context.textContent = historicalCount
        ? marketClosed
          ? "休市中 · 显示本地历史信号"
          : historicalCount + " 条本地历史 · 等待服务器更新"
        : marketClosed
          ? "休市中 · 常规时段自动扫描"
          : liveCount
            ? "服务器实时信号"
            : "等待首次常规时段扫描";
      data.strategy.symbols.forEach((symbol) => {
        const signal = data.signals[symbol];
        const historical = signal?.source === "local-history";
        const costsCovered = signal?.costCoverageAllowed === true;
        const signalPassed = signal && signal.trend15mPct >= signal.atr15Pct * data.strategy.entryAtrMultiplier && signal.upMinutes >= data.strategy.minDirectionalMinutes;
        const direction = !signal ? "—" : signal.trend15mPct > 0 ? "↑" : signal.trend15mPct < 0 ? "↓" : "—";
        const row = el("article", "signal" + (historical ? " historical" : ""));
        const code = el("span", "signal-code");
        const chartUrl = stockChartUrl(symbol);
        if (chartUrl) {
          const symbolLink = el("a", "signal-symbol-link", symbol);
          symbolLink.href = chartUrl;
          symbolLink.target = "_blank";
          symbolLink.rel = "noopener noreferrer";
          symbolLink.title = symbol + " 美股实时走势图 · TradingView";
          symbolLink.setAttribute("aria-label", symbolLink.title);
          code.append(symbolLink);
        } else {
          code.append(el("strong", "", symbol));
        }
        if (historical) code.append(el("small", "signal-source", "本地历史"));
        if (signal && !historical) {
          const shadowObservations = [];
          if (signal.shadowTrendQualityDecision === "WOULD_BLOCK") shadowObservations.push("高波动震荡");
          if (signal.shadowConcentrationDecision === "WOULD_LIMIT") shadowObservations.push("集中度");
          if (signal.shadowPositionSizeDecision === "WOULD_REDUCE") {
            shadowObservations.push("建议 $" + money(signal.shadowSuggestedTradeUsdt));
          }
          if (shadowObservations.length) {
            code.append(el("small", "signal-shadow", "Shadow · " + shadowObservations.join(" · ")));
          }
        }
        row.title = !signal
          ? marketClosed ? "休市中，等待常规时段扫描" : "等待信号"
          : historical
            ? "本地历史信号，仅供参考，不触发交易"
            : costsCovered ? "成本已覆盖" : signal.costCoverageReason || "未通过成本门槛";
        const fetchedTime = el("time", "signal-time", shortTime(signal?.dataFetchedAt));
        if (signal?.dataFetchedAt) {
          fetchedTime.dateTime = signal.dataFetchedAt;
          fetchedTime.title = new Date(signal.dataFetchedAt).toLocaleString("zh-CN", { hour12: false });
        }
        row.append(
          code,
          el("span", "signal-direction " + (!signal ? "muted" : signal.trend15mPct >= 0 ? "green" : "red"), direction),
          el("span", "signal-strength", signal ? (signal.upMinutes ?? "—") + "/15 ↑" : "—"),
          el("span", "signal-change " + (signalPassed ? "green" : signal ? "red" : "muted"), signal ? pct(signal.trend15mPct) : "—"),
          fetchedTime
        );
        root.append(row);
      });
    }
    function renderTimeline(data) {
      const root = document.getElementById("timeline");
      root.replaceChildren();
      recentActionRecords = data.recentActions;
      const decisions = recentActionRecords.filter((record) => actionCategory(record) === "decision");
      const trades = recentActionRecords.filter((record) => actionCategory(record) === "trade");
      const systemLogs = recentActionRecords.filter((record) => actionCategory(record) === "system");
      document.getElementById("timelineDecisionCount").textContent = decisions.length;
      document.getElementById("timelineTradeCount").textContent = trades.length;
      document.getElementById("timelineSystemCount").textContent = systemLogs.length;
      const decisionButton = document.getElementById("timelineDecisionFilter");
      const tradeButton = document.getElementById("timelineTradeFilter");
      const systemButton = document.getElementById("timelineSystemFilter");
      decisionButton.classList.toggle("active", timelineFilter === "decision");
      tradeButton.classList.toggle("active", timelineFilter === "trade");
      systemButton.classList.toggle("active", timelineFilter === "system");
      decisionButton.setAttribute("aria-pressed", String(timelineFilter === "decision"));
      tradeButton.setAttribute("aria-pressed", String(timelineFilter === "trade"));
      systemButton.setAttribute("aria-pressed", String(timelineFilter === "system"));
      const records = timelineFilter === "decision" ? decisions : timelineFilter === "trade" ? trades : systemLogs;
      if (!records.length) {
        root.append(el("div", "empty", timelineFilter === "decision" ? "暂无决策判断" : timelineFilter === "trade" ? "暂无交易动作" : "暂无系统日志"));
        return;
      }
      records.forEach((record) => {
        const category = actionCategory(record);
        const row = el("article", "event");
        row.append(el("time", "", new Date(record.timestamp).toLocaleTimeString("zh-CN", { hour12: false })));
        const body = el("div");
        const title = el("div", "event-title");
        title.append(
          el("div", "event-name", actionEventLabels[record.event] || record.event),
          el("span", "event-kind " + category, category === "decision" ? "决策" : category === "trade" ? "交易" : "系统")
        );
        body.append(title, el("div", "event-details", category === "trade" ? tradeActionSummary(record) : actionSummary(record)));
        if (record.details && Object.keys(record.details).length) {
          const raw = el("details", "event-raw");
          raw.append(el("summary", "", "原始日志"), el("pre", "", JSON.stringify(record.details, null, 2)));
          body.append(raw);
        }
        const statusClass = ["failed", "halted", "ambiguous"].includes(record.status)
          ? " red"
          : ["succeeded", "finished", "allowed", "triggered", "submitted"].includes(record.status)
            ? " green"
            : ["skipped", "waiting", "requested", "scheduled"].includes(record.status)
              ? " gold"
              : "";
        row.append(body, el("span", "event-status" + statusClass, actionStatusLabels[record.status] || record.status));
        root.append(row);
      });
    }
    function renderStrategyRisk(data) {
      const root = document.getElementById("strategyRisk");
      root.replaceChildren();
      const policy = el("div", "policy-grid");
      const items = [
        ["入场", data.strategy.entryIntervalMinutes + " 分钟 · ≥ " + data.strategy.entryAtrMultiplier + "×ATR15 · " + data.strategy.minDirectionalMinutes + "/15 上涨"],
        [
          "成本",
          "报价往返 ≤ " + pct(data.strategy.maxRoundTripCostPct) +
            " · 执行缓冲 " + pct(data.strategy.executionBufferPct) +
            " · Gas " + money(data.strategy.effectiveRoundTripGasUsdt) + " USDT" +
            (data.strategy.gasEstimateSource === "ACTUAL_P90"
              ? "（实际 P90，" + data.strategy.actualGasSampleCount + " 笔）"
              : "（固定估算，已采集 " + data.strategy.actualGasSampleCount + "/10 笔）") +
            " · 净边 ≥ " + pct(data.strategy.minNetEdgePct)
        ],
        ["初始止损", "clamp(" + data.strategy.atrStopMultiplier + "×ATR15, " + pct(data.risk.minInitialStopPct) + ", " + pct(data.risk.maxInitialStopPct) + ")"],
        ["盈利保护", "+" + data.risk.profitProtectionR + "R 启动 · " + data.strategy.trailingAtrMultiplier + "×ATR15 回撤"],
        ["止盈 / 失效", "+" + data.risk.finalTakeProfitR + "R · " + data.strategy.signalReviewHours + "h 信号失效且 < " + data.strategy.signalReviewMinR + "R"],
        ["硬风控", "单笔 " + money(data.risk.maxTradeUsdt) + " · 日亏 " + money(data.risk.dailyLossLimitUsdt) + " · " + data.risk.maxOpenPositions + " 仓 · 灾难 " + pct(data.risk.disasterStopLossPct)],
        ["开放风险", money(data.risk.openRiskUsdt) + " USDT · 占日亏损上限 " + pct(data.risk.openRiskToDailyLimitPct)],
        ["日亏损额度使用", money(data.risk.dailyLossUsedUsdt) + " / " + money(data.risk.dailyLossLimitUsdt) + " USDT · " + pct(data.risk.dailyLossUsedPct)],
        ["Shadow 风控", "单标的集中度 · 趋势效率/震荡 · ATR 仓位建议 · 仅观测，不改变下单"]
      ];
      items.forEach(([label, value]) => {
        const item = el("div", "policy-item");
        item.append(el("span", "label", label), el("strong", "", value));
        policy.append(item);
      });
      root.append(policy);
    }
    function renderWorkflow(data) {
      const root = document.getElementById("workflow");
      root.replaceChildren();
      const stage = data.health.status !== "RUNNING"
        ? -1
        : data.pendingOrder
          ? 4
          : data.approvalRequest
            ? 3
            : data.positions?.length || data.position
              ? 5
              : 1;
      const steps = ["15分钟扫描", "趋势/成本/审计", "创建订单", "逐笔确认", "复核并执行", "60秒退出检查"];
      const workflow = el("div", "workflow");
      steps.forEach((label, index) => {
        const item = el("div", "workflow-step" + (index === stage ? " active" : ""));
        item.append(el("span", "label", String(index + 1)), el("strong", "", label));
        workflow.append(item);
      });
      root.append(workflow);
    }
    function renderWalletStatus(walletSession) {
      const walletStatus = document.getElementById("walletStatus");
      const states = {
        CONNECTED: { label: "钱包 已连接", tone: "green" },
        EXPIRING: { label: "钱包 即将过期", tone: "gold" },
        EXPIRED: { label: "钱包 已断开", tone: "red" },
        UNKNOWN: { label: "钱包 状态未知", tone: "gold" }
      };
      const state = states[walletSession?.status] || { label: "钱包 未检测", tone: "gold" };
      walletStatus.className = "badge " + state.tone;
      walletStatus.querySelector("span:last-child").textContent = state.label;
      walletStatus.title = walletSession?.checkedAt
        ? "最近检查：" + new Date(walletSession.checkedAt).toLocaleString("zh-CN", { hour12: false })
        : "尚无钱包状态检查记录";
      document.getElementById("walletLogin").hidden = walletSession?.status !== "EXPIRED";
    }
    function renderMode(value) {
      const mode = document.getElementById("mode");
      const normalized = String(value || "shadow").toLowerCase();
      mode.className = "badge" + (normalized === "live" ? " green" : "");
      mode.querySelector("span:last-child").textContent = normalized.toUpperCase();
    }
    async function refresh() {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        autoApprovalEnabled = data.autoApproval?.enabled === true;
        const autoToggle = document.getElementById("autoApprovalToggle");
        autoToggle.setAttribute("aria-checked", String(autoApprovalEnabled));
        autoToggle.textContent = "自动审批：" + (autoApprovalEnabled ? "开" : "关");
        autoToggle.classList.toggle("auto-on", autoApprovalEnabled);
        renderMode(data.mode);
        renderWalletStatus(data.health.walletSession);
        const health = document.getElementById("health");
        health.className = "badge " + (data.health.status === "RUNNING" ? "green" : ["STALE", "HALTED", "DEGRADED", "AUTH_REQUIRED"].includes(data.health.status) ? "red" : "gold");
        health.querySelector("span:last-child").textContent = data.health.status;
        const halted = data.health.status === "HALTED";
        const authRequired = data.health.status === "AUTH_REQUIRED";
        const sessionExpiring = data.health.walletSession?.status === "EXPIRING";
        document.getElementById("stopButton").hidden = halted;
        document.getElementById("resumeButton").hidden = !halted;
        document.getElementById("lastError").textContent = data.health.lastError || (halted ? "已停机" : authRequired ? "需登录" : sessionExpiring ? "会话即将到期" : "");
        const walletBalance = document.getElementById("walletBalance");
        walletBalance.textContent = data.walletBalance?.totalUsd == null ? "—" : "$" + money(data.walletBalance.totalUsd);
        walletBalance.title = data.walletBalance?.checkedAt
          ? data.walletBalance.assetCount + " 项资产 · 更新于 " + new Date(data.walletBalance.checkedAt).toLocaleString("zh-CN", { hour12: false })
          : "等待 Bot 获取钱包余额";
        const realizedPnl = document.getElementById("realizedPnl");
        realizedPnl.textContent = (data.risk.realizedPnlUsdt >= 0 ? "+" : "") + money(data.risk.realizedPnlUsdt) + " USDT";
        realizedPnl.className = data.risk.realizedPnlUsdt >= 0 ? "green" : "red";
        realizedPnl.title = "毛盈亏 " + money(data.risk.realizedGrossPnlUsdt) +
          " USDT · Gas -" + money(data.risk.gasCostUsdt) + " USDT · 当前显示净盈亏";
        document.getElementById("dailyLossRemaining").textContent = money(data.risk.dailyLossRemainingUsdt) + " USDT";
        document.getElementById("maxTrade").textContent = money(data.risk.maxTradeUsdt) + " USDT";
        renderAssetTrend(data.assetTrend);
        renderApproval(data);
        renderPosition(data);
        renderSignals(data);
        renderTimeline(data);
        renderStrategyRisk(data);
        renderWorkflow(data);
      } catch (error) {
        const health = document.getElementById("health");
        health.className = "badge red";
        health.querySelector("span:last-child").textContent = "DASHBOARD ERROR";
        document.getElementById("lastError").textContent = error.message;
      }
    }
    document.getElementById("stopButton").addEventListener("click", async () => {
      if (!window.confirm("确认立即停止交易守护进程？停机标记会持久保存，重启电脑后仍保持停止。")) return;
      await fetch("/api/emergency-stop", { method: "POST" });
      await refresh();
    });
    document.getElementById("walletLoginStart").addEventListener("click", startWalletLogin);
    document.getElementById("autoApprovalToggle").addEventListener("click", async () => {
      const enabled = !autoApprovalEnabled;
      if (enabled && !window.confirm("开启后，未来合格订单可在复核后自动执行真实交易。确认开启自动审批？")) return;
      const response = await fetch("/api/auto-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          confirmation: enabled ? "ENABLE_AUTO_APPROVAL" : "DISABLE_AUTO_APPROVAL"
        })
      });
      if (!response.ok) {
        const result = await response.json();
        window.alert(result.error || "自动审批设置失败");
      }
      await refresh();
    });
    document.getElementById("resumeButton").addEventListener("click", async () => {
      if (!window.confirm("确认解除紧急停机？此操作不会自动启动交易进程。")) return;
      await fetch("/api/emergency-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESUME" })
      });
      await refresh();
    });
    document.getElementById("signalToggle").addEventListener("click", (event) => {
      const signals = document.getElementById("signals");
      const expanded = signals.classList.toggle("expanded");
      event.currentTarget.setAttribute("aria-expanded", String(expanded));
      event.currentTarget.textContent = expanded ? "收起" : "查看全部";
    });
    document.getElementById("timelineDecisionFilter").addEventListener("click", () => {
      timelineFilter = "decision";
      renderTimeline({ recentActions: recentActionRecords });
    });
    document.getElementById("timelineTradeFilter").addEventListener("click", () => {
      timelineFilter = "trade";
      renderTimeline({ recentActions: recentActionRecords });
    });
    document.getElementById("timelineSystemFilter").addEventListener("click", () => {
      timelineFilter = "system";
      renderTimeline({ recentActions: recentActionRecords });
    });
    const assetTrendCanvas = document.getElementById("assetTrendChart");
    assetTrendCanvas.addEventListener("pointermove", (event) => {
      if (!assetTrendGeometry.length) return;
      const rect = assetTrendCanvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      assetTrendHoverIndex = assetTrendGeometry.reduce((closest, point, index) => (
        Math.abs(point.x - pointerX) < Math.abs(assetTrendGeometry[closest].x - pointerX) ? index : closest
      ), 0);
      drawAssetTrend();
      const point = assetTrendPoints[assetTrendHoverIndex];
      const geometry = assetTrendGeometry[assetTrendHoverIndex];
      const tooltip = document.getElementById("assetTrendTooltip");
      tooltip.replaceChildren(
        el("span", "", point.date),
        el("strong", "", "$" + money(point.totalUsd))
      );
      tooltip.style.left = Math.min(rect.width - 118, Math.max(8, geometry.x + 10)) + "px";
      tooltip.style.top = Math.max(28, geometry.y) + "px";
      tooltip.hidden = false;
    });
    assetTrendCanvas.addEventListener("pointerleave", () => {
      assetTrendHoverIndex = null;
      document.getElementById("assetTrendTooltip").hidden = true;
      drawAssetTrend();
    });
    new ResizeObserver(drawAssetTrend).observe(assetTrendCanvas);
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}
