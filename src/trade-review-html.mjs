export function tradeReviewHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>交易复盘 · Agentic Wallet</title>
  <style>
    :root {
      --bg: #080a0e; --panel: #11151c; --panel-2: #171d26; --line: #29313d;
      --text: #f5f7fa; --muted: #8f9baa; --gold: #f5c14f; --green: #51d6a3;
      --red: #ff6c78; --blue: #78a9ff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--text); font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at 12% -8%, rgba(245,193,79,.11), transparent 32rem), radial-gradient(circle at 92% 18%, rgba(120,169,255,.08), transparent 34rem), var(--bg); }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
    header { position: sticky; top: 0; z-index: 5; border-bottom: 1px solid rgba(255,255,255,.07); background: rgba(8,10,14,.88); backdrop-filter: blur(18px); }
    .nav { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    .brand, .nav-actions { display: flex; align-items: center; gap: 10px; }
    .brand { font-weight: 760; }
    .mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 11px; color: #171108; background: var(--gold); font-weight: 900; }
    a, select { font: inherit; }
    .nav-link, select { min-height: 38px; padding: 8px 11px; border: 1px solid var(--line); border-radius: 10px; color: var(--text); background: var(--panel-2); text-decoration: none; }
    .nav-link:hover { border-color: rgba(120,169,255,.65); }
    main { padding: 22px 0 48px; }
    section + section { margin-top: 20px; }
    .section-head { display: flex; align-items: end; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    h1 { margin: 0; font-size: clamp(28px, 5vw, 48px); letter-spacing: -.05em; }
    h2 { margin: 0; font-size: 18px; }
    .muted { color: var(--muted); font-size: 12px; line-height: 1.5; }
    .panel { border: 1px solid var(--line); border-radius: 16px; background: rgba(17,21,28,.9); overflow: hidden; }
    .metrics { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; background: var(--line); }
    .metric { min-width: 0; padding: 14px; background: var(--panel); }
    .label { color: var(--muted); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
    .metric strong { display: block; margin-top: 8px; font: 720 16px ui-monospace, SFMono-Regular, monospace; }
    .green { color: var(--green); } .red { color: var(--red); } .gold { color: var(--gold); }
    .periods { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .period { padding: 15px; }
    .period h3 { margin: 0 0 12px; font-size: 15px; }
    .period-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .period-grid span { color: var(--muted); font-size: 10px; }
    .period-grid strong { display: block; margin-top: 5px; font: 700 13px ui-monospace, SFMono-Regular, monospace; }
    .table-wrap { overflow: auto; }
    table { width: 100%; min-width: 900px; border-collapse: collapse; }
    th, td { padding: 11px 12px; border-bottom: 1px solid rgba(255,255,255,.06); text-align: left; font-size: 12px; }
    th { color: var(--muted); background: rgba(255,255,255,.018); font-size: 10px; letter-spacing: .05em; }
    td.number { text-align: right; font-family: ui-monospace, SFMono-Regular, monospace; }
    .list { margin: 0; padding: 14px 16px 14px 34px; }
    .list li { padding: 5px 0; color: #c7ced8; line-height: 1.5; font-size: 13px; }
    .risk-row { display: grid; grid-template-columns: 90px 1fr repeat(3, 110px); gap: 12px; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.06); align-items: center; font-size: 12px; }
    .context { padding: 16px; }
    .context-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    .context h3 { margin: 0; font-size: 16px; }
    .badge { padding: 5px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--gold); font: 700 10px ui-monospace, SFMono-Regular, monospace; }
    .context-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 15px; }
    .context-grid span { color: var(--muted); font-size: 10px; }
    .context-grid strong { display: block; margin-top: 5px; font: 700 13px ui-monospace, SFMono-Regular, monospace; }
    .context-note { margin: 13px 0 0; color: #c7ced8; font-size: 13px; line-height: 1.55; }
    .empty { padding: 20px; color: var(--muted); text-align: center; }
    @media (max-width: 820px) {
      .metrics { grid-template-columns: repeat(3, 1fr); }
      .periods { grid-template-columns: 1fr; }
      .context-grid { grid-template-columns: repeat(2, 1fr); }
      .risk-row { grid-template-columns: 72px 1fr; }
      .risk-row span:nth-child(n+3) { color: var(--muted); }
    }
    @media (max-width: 560px) {
      .nav { padding: 11px 0; align-items: flex-start; flex-direction: column; }
      .nav-actions { width: 100%; display: grid; grid-template-columns: 1fr 1fr; }
      select { grid-column: 1 / -1; }
      .metrics { grid-template-columns: repeat(2, 1fr); }
      .period-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <header><div class="shell nav">
    <div class="brand"><span class="mark">R</span><span>交易复盘</span></div>
    <div class="nav-actions"><select id="reviewDate" aria-label="选择交易日"></select><a class="nav-link" href="/strategies">策略</a><a class="nav-link" href="/">仪表盘</a></div>
  </div></header>
  <main class="shell">
    <section>
      <div class="section-head"><div><h1 id="title">收盘复盘</h1><div class="muted" id="generatedAt">读取中…</div></div></div>
      <div class="panel metrics" id="dailyMetrics"></div>
    </section>
    <section><div class="section-head"><h2>阶段性表现</h2><span class="muted">固定比较最近 5 个交易日与 20 个交易日</span></div><div class="periods" id="periodComparison"></div></section>
    <section><div class="section-head"><h2>盘前交易建议</h2><span class="muted">研究信息，不改变策略执行</span></div><div class="panel" id="premarketBrief"></div></section>
    <section><div class="section-head"><h2>外部市场归因</h2><span class="muted">相关性与 beta 是描述性统计，不代表因果</span></div><div class="panel" id="externalMarket"></div></section>
    <section><div class="section-head"><h2>复盘结论</h2></div><div class="panel"><ul class="list" id="findings"></ul></div></section>
    <section><div class="section-head"><h2>已完成交易</h2></div><div class="panel table-wrap"><table><thead><tr><th>标的</th><th>策略</th><th>持仓</th><th>退出</th><th>净收益</th><th>Gas</th><th>MAE / MFE</th><th>Shadow 对照</th><th>止损复核</th></tr></thead><tbody id="tradeRows"></tbody></table></div></section>
    <section><div class="section-head"><h2>收盘开放风险</h2></div><div class="panel" id="openRisk"></div></section>
    <section><div class="section-head"><h2>系统异常</h2></div><div class="panel" id="systemFailures"></div></section>
  </main>
  <script>
    const money = (value) => value == null ? "—" : (Number(value) >= 0 ? "+" : "") + Number(value).toFixed(3) + " U";
    const pct = (value) => value == null ? "—" : Number(value).toFixed(2) + "%";
    const number = (value, digits = 2) => value == null ? "—" : Number(value).toFixed(digits);
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    let history = [];

    function metric(root, label, value, tone = "") {
      const card = el("div", "metric");
      card.append(el("span", "label", label), el("strong", tone, value));
      root.append(card);
    }
    function contextMetric(root, label, value) {
      const cell = el("div", "");
      cell.append(el("span", "", label), el("strong", "", value));
      root.append(cell);
    }
    function renderPremarket(brief) {
      const root = document.getElementById("premarketBrief");
      root.replaceChildren();
      if (!brief) {
        root.append(el("div", "empty", "该交易日尚无盘前简报；交易执行不受影响。"));
        return;
      }
      const body = el("div", "context");
      const head = el("div", "context-head");
      head.append(el("h3", "", brief.advice.summary), el("span", "badge", brief.advice.level));
      const grid = el("div", "context-grid");
      contextMetric(grid, "大盘平均", pct(brief.market.benchmarkAveragePct));
      contextMetric(grid, "标的上涨广度", pct(brief.market.breadthPositivePct));
      contextMetric(grid, "VIX 变化", pct(brief.market.vixChangePct));
      contextMetric(grid, "风险新闻", brief.news.riskHeadlineCount + " / " + brief.news.headlineCount);
      body.append(head, grid, el("p", "context-note", "仅用于当日环境提示；不会自动放宽/收紧门槛，也不会触发下单。"));
      root.append(body);
    }
    function renderExternalMarket(market) {
      const root = document.getElementById("externalMarket");
      root.replaceChildren();
      if (!market || market.status !== "AVAILABLE") {
        root.append(el("div", "empty", "可对齐的分钟数据不足，无法科学估算市场关联。"));
        return;
      }
      const body = el("div", "context");
      const head = el("div", "context-head");
      head.append(el("h3", "", "市场解释亏损 " + pct(market.marketAttributedLossSharePct)), el("span", "badge", market.observedTrades + " / " + market.totalTrades + " 笔可观测"));
      const grid = el("div", "context-grid");
      contextMetric(grid, "亏损同向率", pct(market.lossDirectionAlignmentPct));
      contextMetric(grid, "平均相关系数", number(market.averageCorrelation, 3));
      contextMetric(grid, "样本交易", market.observedTrades + " 笔");
      contextMetric(grid, "数据错误", String((market.errors || []).length));
      body.append(head, grid, el("p", "context-note", "估算基于持仓期间标的与 SPY/QQQ 对齐的一分钟收益；Gas、点差和代币折溢价不计入回归。"));
      root.append(body);
    }
    function render(report) {
      document.getElementById("title").textContent = report.tradingDate + " 收盘复盘";
      document.getElementById("generatedAt").textContent = "生成于 " + new Date(report.generatedAt).toLocaleString("zh-CN") + " · Shadow 不计入真实成交";
      const daily = document.getElementById("dailyMetrics");
      daily.replaceChildren();
      metric(daily, "净收益", money(report.daily.realizedPnlUsdt), report.daily.realizedPnlUsdt < 0 ? "red" : "green");
      metric(daily, "交易", String(report.daily.trades));
      metric(daily, "胜率", pct(report.daily.winRatePct));
      metric(daily, "Profit Factor", number(report.daily.profitFactor));
      metric(daily, "Gas", money(-report.daily.gasCostUsdt), "gold");
      metric(daily, "最大回撤", money(-report.daily.maxDrawdownUsdt), "red");

      const periods = document.getElementById("periodComparison");
      periods.replaceChildren();
      report.periods.forEach((period) => {
        const card = el("article", "panel period");
        card.append(el("h3", "", period.sessions + " 个交易日 · " + period.startDate + " — " + period.endDate));
        const grid = el("div", "period-grid");
        [["净收益", money(period.realizedPnlUsdt)], ["交易", String(period.trades)], ["胜率", pct(period.winRatePct)], ["Profit Factor", number(period.profitFactor)], ["平均盈利", money(period.averageWinUsdt)], ["平均亏损", money(period.averageLossUsdt)], ["盈亏比", number(period.payoffRatio)], ["最大回撤", money(-period.maxDrawdownUsdt)]].forEach(([label, value]) => {
          const cell = el("div", "");
          cell.append(el("span", "", label), el("strong", value.startsWith("-") ? "red" : "", value));
          grid.append(cell);
        });
        card.append(grid);
        periods.append(card);
      });
      renderPremarket(report.premarketBrief);
      renderExternalMarket(report.externalMarket);

      const findings = document.getElementById("findings");
      findings.replaceChildren(...report.findings.map((finding) => el("li", "", finding)));
      const rows = document.getElementById("tradeRows");
      rows.replaceChildren();
      report.trades.forEach((trade) => {
        const row = document.createElement("tr");
        const pullback = trade.entryShadow?.pullback?.decision || "—";
        const early = trade.earlyExitShadow?.decision || "—";
        [
          trade.symbol,
          trade.strategyId,
          trade.holdingMinutes == null ? "—" : number(trade.holdingMinutes, 0) + "m",
          trade.exitReason,
          money(trade.realizedPnlUsdt),
          money(-trade.gasCostUsdt),
          pct(trade.maePct) + " / " + pct(trade.mfePct),
          pullback + " / " + early,
          trade.stopTriggerCount + " 次触发 / " + trade.stopRevalidationCancelledCount + " 次取消"
        ].forEach((value, index) => row.append(el("td", index >= 4 && index <= 6 ? "number" : "", value)));
        rows.append(row);
      });
      if (!report.trades.length) {
        const row = document.createElement("tr");
        const cell = el("td", "empty", "该交易日没有完成的真实卖出成交。");
        cell.colSpan = 9;
        row.append(cell);
        rows.append(row);
      }

      const open = document.getElementById("openRisk");
      open.replaceChildren();
      report.openPositions.forEach((position) => {
        const row = el("div", "risk-row");
        row.append(el("strong", "", position.symbol), el("span", "", position.strategyId), el("span", "", "原始未实现 " + money(position.grossUnrealizedPnlUsdt)), el("span", "", "峰值 " + pct(position.peakReturnPct)), el("span", position.lastSignalValid === false ? "red" : "", position.lastSignalValid === false ? "信号失效" : "信号有效/未知"));
        open.append(row);
      });
      if (!report.openPositions.length) open.append(el("div", "empty", "收盘复盘时没有开放仓位。"));

      const failures = document.getElementById("systemFailures");
      failures.replaceChildren();
      if (!report.systemFailures.events.length) {
        failures.append(el("div", "empty", "该交易日没有记录到失败事件。"));
      } else {
        const list = el("ul", "list");
        report.systemFailures.events.forEach((failure) => list.append(el("li", "", new Date(failure.timestamp).toLocaleTimeString("zh-CN") + " · " + failure.event + (failure.symbol ? " · " + failure.symbol : "") + " · " + (failure.error || failure.operation || "未知错误"))));
        failures.append(list);
      }
    }
    async function load(date = "") {
      const suffix = date ? "?date=" + encodeURIComponent(date) : "";
      const response = await fetch("/api/trade-reviews" + suffix, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.available) throw new Error(payload.error || "复盘尚未生成");
      history = payload.history || history;
      const select = document.getElementById("reviewDate");
      if (!select.options.length) {
        history.forEach((item) => {
          const option = el("option", "", item.tradingDate + " · " + money(item.realizedPnlUsdt));
          option.value = item.tradingDate;
          select.append(option);
        });
        select.addEventListener("change", () => load(select.value));
      }
      select.value = payload.report.tradingDate;
      render(payload.report);
    }
    load().catch((error) => {
      document.getElementById("generatedAt").textContent = "读取失败：" + error.message;
    });
  </script>
</body>
</html>`;
}
