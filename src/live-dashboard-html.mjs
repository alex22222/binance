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
    .mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 11px; background: var(--gold); color: #171108; font-weight: 900; }
    .badges { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .badge { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font: 700 11px ui-monospace, SFMono-Regular, monospace; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
    main { padding: 62px 0 70px; }
    .eyebrow { color: var(--gold); font: 700 12px ui-monospace, SFMono-Regular, monospace; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 13px 0 12px; font-size: clamp(42px, 7vw, 74px); line-height: 1; letter-spacing: -.06em; }
    .lead { margin: 0; color: #aab3bf; max-width: 720px; font-size: 17px; line-height: 1.65; }
    .notice { margin: 30px 0 14px; padding: 17px 19px; border: 1px solid rgba(245,193,79,.24); border-radius: 14px; color: #d9c998; background: rgba(245,193,79,.055); line-height: 1.55; }
    .controls { margin-bottom: 14px; padding: 15px 17px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border: 1px solid var(--line); border-radius: 14px; background: rgba(17,21,28,.88); }
    .control-copy { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .control-actions { display: flex; gap: 8px; flex-shrink: 0; }
    .control-button { padding: 9px 13px; border: 1px solid var(--line); border-radius: 10px; color: var(--text); background: var(--panel-2); cursor: pointer; font-weight: 720; }
    .control-button.stop { border-color: rgba(255,108,120,.4); color: #ffadb4; background: rgba(255,108,120,.08); }
    .control-button.resume { border-color: rgba(81,214,163,.35); color: var(--green); background: rgba(81,214,163,.07); }
    .control-button[hidden] { display: none; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 14px 0 52px; }
    .card, .panel { border: 1px solid var(--line); background: rgba(17,21,28,.88); border-radius: 17px; }
    .card { padding: 19px; min-height: 112px; }
    .label { color: var(--muted); font-size: 11px; letter-spacing: .11em; text-transform: uppercase; }
    .value { display: block; margin-top: 12px; font-size: 25px; letter-spacing: -.04em; }
    .green { color: var(--green); } .red { color: var(--red); } .gold { color: var(--gold); }
    section { margin-top: 48px; }
    .section-head { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
    h2 { margin: 7px 0 0; font-size: 31px; letter-spacing: -.045em; }
    .muted { color: var(--muted); }
    .position { padding: 24px; display: grid; grid-template-columns: 1.3fr repeat(5, 1fr); gap: 18px; align-items: center; }
    .position-symbol { font-size: 34px; font-weight: 780; letter-spacing: -.045em; }
    .contract { margin-top: 7px; color: var(--muted); font: 11px ui-monospace, SFMono-Regular, monospace; word-break: break-all; }
    .position-cell strong { display: block; margin-top: 7px; font-size: 19px; }
    .empty { padding: 34px 24px; text-align: center; color: var(--muted); }
    .signals { display: grid; grid-template-columns: repeat(5, 1fr); }
    .signal { min-height: 142px; padding: 17px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .signal:nth-child(5n) { border-right: 0; }
    .signal-name { display: flex; justify-content: space-between; gap: 8px; font-weight: 750; }
    .signal-main { margin-top: 24px; font-size: 22px; letter-spacing: -.035em; }
    .signal-meta { margin-top: 7px; color: var(--muted); font-size: 12px; }
    .timeline { max-height: 520px; overflow: auto; }
    .event { display: grid; grid-template-columns: 105px 1fr auto; gap: 15px; padding: 15px 18px; border-bottom: 1px solid var(--line); align-items: start; }
    .event:last-child { border-bottom: 0; }
    .event time { color: #768292; font: 11px ui-monospace, SFMono-Regular, monospace; }
    .event-name { font-weight: 680; }
    .event-details { margin-top: 5px; color: var(--muted); font: 11px/1.5 ui-monospace, SFMono-Regular, monospace; word-break: break-word; }
    .event-status { color: var(--blue); font: 700 10px ui-monospace, SFMono-Regular, monospace; text-transform: uppercase; }
    footer { padding: 30px 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr 1fr; }
      .position { grid-template-columns: 1fr 1fr; }
      .position > :first-child { grid-column: 1 / -1; }
      .signals { grid-template-columns: 1fr 1fr; }
      .signal:nth-child(5n) { border-right: 1px solid var(--line); }
      .signal:nth-child(2n) { border-right: 0; }
    }
    @media (max-width: 600px) {
      main { padding-top: 38px; }
      .grid, .position, .signals { grid-template-columns: 1fr; }
      .signal { border-right: 0 !important; }
      .section-head { align-items: start; flex-direction: column; }
      .event { grid-template-columns: 78px 1fr; }
      .event-status { grid-column: 2; }
      .controls { align-items: stretch; flex-direction: column; }
      .control-actions { width: 100%; }
      .control-button { flex: 1; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <div class="brand"><span class="mark">A</span><span>Agentic Wallet Monitor</span></div>
      <div class="badges"><span class="badge" id="mode"></span><span class="badge" id="health"><span class="dot"></span><span></span></span></div>
    </div>
  </header>
  <main class="shell">
    <div class="eyebrow">Local only · Safety control dashboard</div>
    <h1>实时持仓，一眼看清。</h1>
    <p class="lead">每 3 秒刷新机器人状态；持仓盈亏来自机器人最近一次可执行卖出报价，不用理论中间价。</p>
    <div class="notice">信号筛选、报价和风控检查可以自动运行；根据 Binance Agentic Wallet 官方安全规则，每一笔链上买卖仍需单独确认。请自行研究并确认风险（DYOR）。</div>
    <div class="controls">
      <div class="control-copy" id="controlStatus">守护进程运行状态加载中……</div>
      <div class="control-actions">
        <button class="control-button stop" id="stopButton" type="button">紧急停机</button>
        <button class="control-button resume" id="resumeButton" type="button" hidden>解除停机</button>
      </div>
    </div>
    <div class="grid" id="metrics"></div>

    <section>
      <div class="section-head"><div><div class="eyebrow">01 · Position</div><h2>当前持仓</h2></div><span class="muted" id="updatedAt"></span></div>
      <div class="panel" id="position"></div>
    </section>

    <section>
      <div class="section-head"><div><div class="eyebrow">02 · Signal board</div><h2>15 分钟趋势门</h2></div><span class="muted">门槛：+0.8% · 10/15 上涨分钟</span></div>
      <div class="panel signals" id="signals"></div>
    </section>

    <section>
      <div class="section-head"><div><div class="eyebrow">03 · Action trace</div><h2>最近动作</h2></div><span class="muted" id="lastError"></span></div>
      <div class="panel timeline" id="timeline"></div>
    </section>
  </main>
  <footer><div class="shell">127.0.0.1 本机安全控制界面 · 不包含私钥、Session Token 或飞书凭据</div></footer>
  <script>
    const money = (value) => value == null ? "—" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pct = (value) => value == null ? "—" : (Number(value) >= 0 ? "+" : "") + Number(value).toFixed(3) + "%";
    const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "等待首次心跳";
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    function metric(label, value, tone = "") {
      const card = el("div", "card");
      card.append(el("span", "label", label), el("strong", "value " + tone, value));
      return card;
    }
    function renderPosition(data) {
      const root = document.getElementById("position");
      root.replaceChildren();
      if (!data.position) {
        const copy = data.pendingOrder ? "订单处理中：" + data.pendingOrder.side + " " + data.pendingOrder.symbol : "当前空仓，等待所有入场门同时通过。";
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
    function renderSignals(data) {
      const root = document.getElementById("signals");
      root.replaceChildren();
      data.strategy.symbols.forEach((symbol) => {
        const signal = data.signals[symbol];
        const costsCovered = signal?.costCoverageAllowed === true;
        const card = el("article", "signal");
        const name = el("div", "signal-name");
        name.append(
          el("span", "", symbol),
          el("span", costsCovered ? "green" : signal ? "red" : "muted", costsCovered ? "成本已覆盖" : signal ? "未通过" : "等待")
        );
        card.append(name);
        card.append(el("div", "signal-main " + ((signal?.trend15mPct || 0) >= data.strategy.minTrend15mPct ? "green" : ""), signal ? pct(signal.trend15mPct) : "—"));
        card.append(el(
          "div",
          "signal-meta",
          signal
            ? (signal.upMinutes ?? "—") + "/15 上涨分钟 · 报价成本 " + pct(signal.roundTripCostPct) +
              " · 全成本 " + pct(signal.allInCostPct) + " · 净余量 " + pct(signal.netEdgeProxyPct) +
              " · ATR15 " + pct(signal.atr15Pct) + " · R " + pct(signal.initialRiskPct)
            : "暂无本轮数据"
        ));
        root.append(card);
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
    async function refresh() {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        document.getElementById("mode").textContent = data.mode.toUpperCase();
        const health = document.getElementById("health");
        health.className = "badge " + (data.health.status === "RUNNING" ? "green" : ["STALE", "HALTED", "DEGRADED", "AUTH_REQUIRED"].includes(data.health.status) ? "red" : "gold");
        health.querySelector("span:last-child").textContent = data.health.status;
        const halted = data.health.status === "HALTED";
        const authRequired = data.health.status === "AUTH_REQUIRED";
        const sessionExpiring = data.health.walletSession?.status === "EXPIRING";
        document.getElementById("stopButton").hidden = halted;
        document.getElementById("resumeButton").hidden = !halted;
        document.getElementById("controlStatus").textContent = halted
          ? "紧急停机已生效：" + (data.health.emergencyStop?.reason || "operator") + "。解除后仍需手动重启监控。"
          : authRequired
            ? "钱包会话已失效，需要在终端启动扫码登录；登录完成前所有交易动作保持关闭。"
            : sessionExpiring
              ? "钱包会话即将到期：" + time(data.health.walletSession.sessionExpireTime) + "。请提前重新登录。"
              : "紧急停机会写入持久标记并终止交易进程；重启机器也不会自动恢复交易。";
        document.getElementById("updatedAt").textContent = "最后心跳 " + time(data.health.updatedAt);
        document.getElementById("lastError").textContent = data.health.lastError ? "最近错误：" + data.health.lastError : "无未处理错误";
        const metrics = document.getElementById("metrics");
        metrics.replaceChildren(
          metric("当日已实现盈亏", (data.risk.realizedPnlUsdt >= 0 ? "+" : "") + money(data.risk.realizedPnlUsdt) + " USDT", data.risk.realizedPnlUsdt >= 0 ? "green" : "red"),
          metric("日亏损余量", money(data.risk.dailyLossRemainingUsdt) + " USDT"),
          metric("单笔上限", money(data.risk.maxTradeUsdt) + " USDT"),
          metric("最大持仓", data.risk.maxOpenPositions + " 个")
        );
        renderPosition(data);
        renderSignals(data);
        renderTimeline(data);
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
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}
