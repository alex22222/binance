export function liveDashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Agentic Wallet · 实时持仓</title>
  <style>
    :root {
      --bg: #080a0e; --panel: #11151c; --panel-2: #171d26; --line: #29313d;
      --text: #f5f7fa; --muted: #8f9baa; --gold: #f5c14f; --green: #51d6a3;
      --red: #ff6c78; --blue: #78a9ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; color: var(--text);
      -webkit-text-size-adjust: 100%;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 15% -8%, rgba(245,193,79,.13), transparent 31rem),
        radial-gradient(circle at 95% 26%, rgba(120,169,255,.09), transparent 34rem), var(--bg);
    }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
    header {
      position: sticky; top: 0; z-index: 5; border-bottom: 1px solid rgba(255,255,255,.07);
      background: rgba(8,10,14,.78); backdrop-filter: blur(18px);
    }
    .nav { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .brand { display: flex; align-items: center; gap: 11px; font-weight: 750; }
    .nav-info, .top-stats { display: flex; align-items: center; gap: 16px; }
    .mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 11px; background: var(--gold); color: #171108; font-weight: 900; }
    .nav-link { margin-left: 6px; padding: 8px 11px; border: 1px solid rgba(120,169,255,.35); border-radius: 9px; color: #d8e5ff; background: rgba(120,169,255,.08); text-decoration: none; font-size: 12px; transition: background-color .2s, border-color .2s; }
    .nav-link:hover { border-color: rgba(120,169,255,.65); background: rgba(120,169,255,.16); }
    .nav-link:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .top-stat { display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; }
    .top-stat span { color: var(--muted); font-size: 11px; }
    .top-stat strong { font-size: 14px; letter-spacing: -.02em; }
    .badges { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .badge { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font: 700 11px ui-monospace, SFMono-Regular, monospace; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
    main { padding: 16px 0 48px; }
    .eyebrow { color: var(--gold); font: 700 12px ui-monospace, SFMono-Regular, monospace; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 13px 0 12px; font-size: clamp(42px, 7vw, 74px); line-height: 1; letter-spacing: -.06em; }
    .lead { margin: 0; color: #aab3bf; max-width: 720px; font-size: 17px; line-height: 1.65; }
    .control-actions { display: flex; gap: 8px; flex-shrink: 0; }
    .control-button { padding: 9px 13px; border: 1px solid var(--line); border-radius: 10px; color: var(--text); background: var(--panel-2); cursor: pointer; font-weight: 720; }
    .control-button.stop { border-color: rgba(255,108,120,.4); color: #ffadb4; background: rgba(255,108,120,.08); }
    .control-button.resume { border-color: rgba(81,214,163,.35); color: var(--green); background: rgba(81,214,163,.07); }
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
    .panel { border: 1px solid var(--line); background: rgba(17,21,28,.88); border-radius: 17px; }
    .label { color: var(--muted); font-size: 11px; letter-spacing: .11em; text-transform: uppercase; }
    .value { display: block; margin-top: 12px; font-size: 25px; letter-spacing: -.04em; }
    .green { color: var(--green); } .red { color: var(--red); } .gold { color: var(--gold); }
    .dashboard-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; }
    .insight-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 12px; margin-top: 12px; }
    section { margin: 0; min-width: 0; }
    .signals-section { grid-column: span 2; }
    .actions-section { grid-column: 3; grid-row: 1 / span 2; }
    .section-head { display: flex; align-items: end; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    h2 { margin: 0; font-size: 18px; letter-spacing: -.03em; }
    .muted { color: var(--muted); }
    .position { padding: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: center; }
    .position-symbol { font-size: 24px; font-weight: 780; letter-spacing: -.045em; }
    .position > :first-child { grid-column: 1 / -1; }
    .contract { margin-top: 7px; color: var(--muted); font: 11px ui-monospace, SFMono-Regular, monospace; word-break: break-all; }
    .position-cell strong { display: block; margin-top: 7px; font-size: 19px; }
    .empty { min-height: 92px; display: grid; place-items: center; padding: 16px; text-align: center; color: var(--muted); }
    .signals { overflow: hidden; }
    .signal-table-head, .signal { display: grid; grid-template-columns: 1.05fr .65fr 1.15fr .9fr .85fr; gap: 10px; align-items: center; }
    .signal-table-head { padding: 10px 12px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 10px; letter-spacing: .05em; }
    .signal { min-height: 58px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .signal:last-child { border-bottom: 0; }
    .signal.historical { background: rgba(245,193,79,.025); }
    .signal-code { display: flex; flex-direction: column; gap: 3px; font-weight: 780; }
    .signal-source { color: var(--gold); font-size: 9px; font-weight: 700; }
    .signal-context { color: var(--muted); font-size: 11px; }
    .signal-direction { font-size: 18px; }
    .signal-strength, .signal-time { color: var(--muted); font-size: 11px; }
    .signal-change { font-size: 14px; letter-spacing: -.02em; }
    .signal-toggle { display: none; width: 100%; min-height: 44px; border: 0; border-top: 1px solid var(--line); color: var(--muted); background: transparent; cursor: pointer; font-weight: 700; }
    .timeline { max-height: 354px; overflow: auto; }
    .event { display: grid; grid-template-columns: 66px 1fr; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); align-items: start; }
    .event:last-child { border-bottom: 0; }
    .event time { color: #768292; font: 11px ui-monospace, SFMono-Regular, monospace; }
    .event-name { font-weight: 680; }
    .event-details { margin-top: 5px; color: var(--muted); font: 11px/1.5 ui-monospace, SFMono-Regular, monospace; word-break: break-word; }
    .event-status { color: var(--blue); font: 700 10px ui-monospace, SFMono-Regular, monospace; text-transform: uppercase; grid-column: 2; }
    .policy-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border-radius: 17px; overflow: hidden; }
    .policy-item { min-height: 84px; padding: 12px; background: rgba(17,21,28,.95); }
    .policy-item strong { display: block; margin-top: 7px; font-size: 13px; line-height: 1.45; }
    .workflow { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; padding: 12px; }
    .workflow-step { min-height: 84px; padding: 10px 8px; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); }
    .workflow-step.active { border-color: rgba(81,214,163,.45); color: var(--green); background: rgba(81,214,163,.06); }
    .workflow-step strong { display: block; margin-top: 8px; color: inherit; font-size: 12px; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
    @media (max-width: 900px) {
      .dashboard-grid { grid-template-columns: 1fr 1fr; }
      .signals-section { grid-column: span 2; }
      .actions-section { grid-column: span 2; grid-row: auto; }
      .insight-grid { grid-template-columns: 1fr; }
      .position { grid-template-columns: 1fr 1fr; }
      .position > :first-child { grid-column: 1 / -1; }
    }
    @media (max-width: 600px) {
      .shell { width: min(100% - 24px, 480px); }
      header { position: static; padding-top: env(safe-area-inset-top); }
      main { padding-top: 16px; padding-bottom: calc(36px + env(safe-area-inset-bottom)); }
      .dashboard-grid { grid-template-columns: 1fr; gap: 18px; }
      .signals-section { grid-column: auto; }
      .actions-section { grid-column: auto; }
      .policy-grid { grid-template-columns: 1fr 1fr; }
      .workflow { grid-template-columns: repeat(3, 1fr); }
      .section-head { align-items: center; }
      h2 { font-size: 21px; }
      .event { grid-template-columns: 66px 1fr; }
      .control-button { min-height: 44px; }
      .nav { align-items: stretch; flex-direction: column; gap: 12px; padding: 12px 0; }
      .brand { min-height: 44px; }
      .nav-link { min-height: 40px; display: inline-flex; align-items: center; }
      .nav-info { width: 100%; flex-direction: column-reverse; align-items: stretch; gap: 12px; }
      .top-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; padding: 12px 0; border-top: 1px solid var(--line); }
      .top-stat { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 0 6px; text-align: center; }
      .top-stat + .top-stat { border-left: 1px solid var(--line); }
      .top-stat strong { font-size: 15px; }
      .badges { justify-content: flex-start; align-items: center; }
      .control-actions { margin-left: auto; }
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
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <div class="brand"><span class="mark">A</span><span>Agentic Wallet</span><a class="nav-link" href="/strategies">策略</a></div>
      <div class="nav-info"><div class="top-stats"><span class="top-stat"><span>盈亏</span><strong class="green" id="realizedPnl">—</strong></span><span class="top-stat"><span>日亏余量</span><strong id="dailyLossRemaining">—</strong></span><span class="top-stat"><span>单笔上限</span><strong id="maxTrade">—</strong></span></div><div class="badges"><span class="badge" id="walletStatus" aria-live="polite"><span class="dot"></span><span>钱包 未检测</span></span><span class="badge" id="mode"></span><span class="badge" id="health"><span class="dot"></span><span></span></span><div class="control-actions"><button class="control-button stop" id="stopButton" type="button">停机</button><button class="control-button resume" id="resumeButton" type="button" hidden>恢复</button></div></div></div>
    </div>
  </header>
  <main class="shell">
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
        <div class="signal-table-head" aria-hidden="true"><span>代码</span><span>方向</span><span>强度 / 15分钟</span><span>变化</span><span>更新时间</span></div>
        <div id="signals"></div>
        <button class="signal-toggle" id="signalToggle" type="button" aria-expanded="false">查看全部</button>
      </div>
    </section>

    <section class="actions-section">
      <div class="section-head"><h2>动作</h2><span class="muted" id="lastError"></span></div>
      <div class="panel timeline" id="timeline"></div>
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
    let submittedApprovalId = null;
    function renderPosition(data) {
      const root = document.getElementById("position");
      root.replaceChildren();
      if (!data.position) {
        const copy = data.pendingOrder ? "处理中：" + data.pendingOrder.side + " " + data.pendingOrder.symbol : "空仓";
        root.append(el("div", "empty", copy));
        return;
      }
      const position = data.position;
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
      const riskText = position.initialRiskPct == null
        ? "等待风险参数"
        : "R " + pct(position.initialRiskPct) + " · 峰值 " + pct(position.peakReturnPct) +
          " · 成本下限 " + pct(position.profitFloorPct) +
          " · 保护 " + (position.trailingStopPct == null ? "未启用" : pct(position.trailingStopPct));
      [
        ["数量", String(position.quantity)],
        ["成本", money(position.costBasisUsdt) + " USDT"],
        ["可执行卖出值", money(position.lastQuoteProceedsUsdt) + " USDT"],
        ["未实现盈亏", pnlText],
        ["动态风控", riskText]
      ].forEach(([label, value], index) => {
        const cell = el("div", "position-cell");
        cell.append(el("span", "label", label), el("strong", index === 3 ? (position.unrealizedPnlUsdt >= 0 ? "green" : "red") : "", value));
        row.append(cell);
      });
      root.append(row);
    }
    function renderApproval(data) {
      const root = document.getElementById("approval");
      root.replaceChildren();
      const request = data.approvalRequest;
      if (!request) {
        const copy = data.mode === "shadow"
          ? data.position?.shadow
            ? "当前为 SHADOW 模拟：" + data.position.symbol + " 模拟仓位不会扣除钱包资产，不能确认。切换 Live 后，新的合格候选才会在这里出现真实确认按钮。"
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
      const statusText = request.canDecide ? "过期倒计时 " + countdown(request.expiresAt) : request.displayStatus;
      head.append(identity, el("span", "badge " + (request.canDecide ? "gold" : "red"), statusText));
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
        code.append(el("strong", "", symbol));
        if (historical) code.append(el("small", "signal-source", "本地历史"));
        row.title = !signal
          ? marketClosed ? "休市中，等待常规时段扫描" : "等待信号"
          : historical
            ? "本地历史信号，仅供参考，不触发交易"
            : costsCovered ? "成本已覆盖" : signal.costCoverageReason || "未通过成本门槛";
        row.append(
          code,
          el("span", "signal-direction " + (!signal ? "muted" : signal.trend15mPct >= 0 ? "green" : "red"), direction),
          el("span", "signal-strength", signal ? (signal.upMinutes ?? "—") + "/15 ↑" : "—"),
          el("span", "signal-change " + (signalPassed ? "green" : signal ? "red" : "muted"), signal ? pct(signal.trend15mPct) : "—"),
          el("time", "signal-time", shortTime(signal?.timestamp))
        );
        root.append(row);
      });
    }
    function renderTimeline(data) {
      const root = document.getElementById("timeline");
      root.replaceChildren();
      if (!data.recentActions.length) {
        root.append(el("div", "empty", "暂无动作记录"));
        return;
      }
      data.recentActions.forEach((record) => {
        const row = el("article", "event");
        row.append(el("time", "", new Date(record.timestamp).toLocaleTimeString("zh-CN", { hour12: false })));
        const body = el("div");
        body.append(el("div", "event-name", record.event), el("div", "event-details", JSON.stringify(record.details)));
        row.append(body, el("span", "event-status", record.status));
        root.append(row);
      });
    }
    function renderStrategyRisk(data) {
      const root = document.getElementById("strategyRisk");
      root.replaceChildren();
      const policy = el("div", "policy-grid");
      const items = [
        ["入场", data.strategy.entryIntervalMinutes + " 分钟 · ≥ " + data.strategy.entryAtrMultiplier + "×ATR15 · " + data.strategy.minDirectionalMinutes + "/15 上涨"],
        ["成本", "报价 ≤ " + pct(data.strategy.maxRoundTripCostPct) + " · Gas+" + pct(data.strategy.executionBufferPct) + " 缓冲 · 净边 ≥ " + pct(data.strategy.minNetEdgePct)],
        ["初始止损", "clamp(" + data.strategy.atrStopMultiplier + "×ATR15, " + pct(data.risk.minInitialStopPct) + ", " + pct(data.risk.maxInitialStopPct) + ")"],
        ["盈利保护", "+" + data.risk.profitProtectionR + "R 启动 · " + data.strategy.trailingAtrMultiplier + "×ATR15 回撤"],
        ["止盈 / 失效", "+" + data.risk.finalTakeProfitR + "R · " + data.strategy.signalReviewHours + "h 信号失效且 < " + data.strategy.signalReviewMinR + "R"],
        ["硬风控", "单笔 " + money(data.risk.maxTradeUsdt) + " · 日亏 " + money(data.risk.dailyLossLimitUsdt) + " · " + data.risk.maxOpenPositions + " 仓 · 灾难 " + pct(data.risk.disasterStopLossPct)]
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
            : data.position
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
    }
    async function refresh() {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        document.getElementById("mode").textContent = data.mode.toUpperCase();
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
        const realizedPnl = document.getElementById("realizedPnl");
        realizedPnl.textContent = (data.risk.realizedPnlUsdt >= 0 ? "+" : "") + money(data.risk.realizedPnlUsdt) + " USDT";
        realizedPnl.className = data.risk.realizedPnlUsdt >= 0 ? "green" : "red";
        document.getElementById("dailyLossRemaining").textContent = money(data.risk.dailyLossRemainingUsdt) + " USDT";
        document.getElementById("maxTrade").textContent = money(data.risk.maxTradeUsdt) + " USDT";
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
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}
