export function tradeReviewHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>策略体检 · Agentic Wallet</title>
  <style>
    :root {
      --bg: #080c11; --panel: #10161d; --panel-raised: #141c25; --line: #26313d;
      --line-soft: rgba(255,255,255,.07); --text: #f4f6f8; --muted: #96a2b1;
      --gold: #f6c85d; --gold-soft: rgba(246,200,93,.12); --green: #55d7a0;
      --green-soft: rgba(85,215,160,.11); --red: #ff6978; --red-soft: rgba(255,105,120,.11);
      --blue: #78afff; --blue-soft: rgba(120,175,255,.11);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; min-height: 100vh; color: var(--text); font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: linear-gradient(135deg, rgba(22,31,41,.32), transparent 42rem), var(--bg); }
    button, select, a { font: inherit; }
    button, select { color: inherit; }
    button:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
    .shell { width: min(1420px, calc(100% - 40px)); margin: 0 auto; }
    header { position: sticky; top: 0; z-index: 10; border-bottom: 1px solid var(--line-soft); background: rgba(8,12,17,.91); backdrop-filter: blur(18px); }
    .nav { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .brand, .nav-actions { display: flex; align-items: center; gap: 12px; }
    .brand { color: var(--text); font-size: 14px; font-weight: 760; text-decoration: none; }
    .brand img { width: 27px; height: 27px; border-radius: 7px; }
    .nav-actions { justify-content: flex-end; }
    .nav-link, select, .button { min-height: 40px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-raised); }
    .nav-link { display: inline-flex; align-items: center; justify-content: center; padding: 8px 18px; color: var(--text); text-decoration: none; font-size: 13px; }
    .nav-link:hover, .button.secondary:hover { border-color: #465467; background: #18222d; }
    select { min-width: 190px; padding: 8px 12px; font-size: 13px; }
    main { padding: 22px 0 48px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 22px; align-items: start; }
    .primary, .rail { min-width: 0; }
    section + section, .rail > * + * { margin-top: 18px; }
    .page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 16px; }
    .eyebrow { color: #cbd2db; font-size: 13px; }
    h1 { margin: 0; font-size: clamp(30px, 3.4vw, 44px); line-height: 1.05; letter-spacing: -.045em; }
    h2 { margin: 0; font-size: 19px; letter-spacing: -.015em; }
    h3 { margin: 0; }
    p { margin: 0; }
    .freshness { margin-top: 10px; color: #d7dce3; font-size: 14px; }
    .freshness strong { color: var(--red); font-weight: 720; }
    .intro { margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .page-head-side { display: flex; flex-direction: column; align-items: flex-end; gap: 15px; }
    .actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
    .button { min-height: 43px; padding: 0 18px; cursor: pointer; font-weight: 720; font-size: 13px; }
    .button.primary { border-color: #f4c65d; color: #15110a; background: var(--gold); box-shadow: 0 8px 24px rgba(246,200,93,.13); }
    .button.primary:hover { background: #ffdb78; }
    .button.secondary { background: var(--panel-raised); }
    .panel { border: 1px solid var(--line); border-radius: 10px; background: linear-gradient(135deg, rgba(255,255,255,.018), transparent 48%), var(--panel); }
    .health { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 26px; min-height: 136px; padding: 27px 30px; align-items: center; }
    .health-title { display: flex; align-items: baseline; gap: 12px; font-size: 22px; font-weight: 680; }
    .health-title strong { color: var(--gold); font-size: 34px; letter-spacing: -.035em; }
    .health-title strong.green { color: var(--green); }
    .health-title strong.red { color: var(--red); }
    .health-evidence { margin-top: 13px; color: #d9dee5; font-size: 14px; line-height: 1.65; }
    .health-evidence .green { color: var(--green); } .health-evidence .red { color: var(--red); }
    .health-verdict { padding-left: 28px; border-left: 1px solid #3a4654; color: var(--muted); font-size: 13px; line-height: 1.65; }
    .section-head { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
    .section-head p { margin-top: 5px; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .scope-note { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .mobile-table-note { display: none; }
    .table-wrap { overflow: auto; }
    table { width: 100%; min-width: 760px; border-collapse: collapse; }
    th, td { height: 39px; padding: 9px 16px; border-bottom: 1px solid var(--line-soft); text-align: left; font-size: 12px; }
    th { color: #dbe0e6; background: rgba(255,255,255,.025); font-weight: 650; }
    th small { margin-left: 4px; color: var(--muted); font-weight: 450; }
    tbody tr:last-child td { border-bottom: 0; }
    td:first-child { color: #e8ebef; font-weight: 620; }
    td.value { font: 680 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .green { color: var(--green); } .red { color: var(--red); } .gold { color: var(--gold); }
    .judgement { color: #c4ccd6; }
    .diagnosis-list { display: grid; gap: 8px; }
    .diagnosis { display: grid; grid-template-columns: 40px 148px minmax(0, 1fr) auto; gap: 12px; align-items: center; min-height: 72px; padding: 13px 16px; }
    .rank { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; color: #1a1408; background: var(--gold); font: 800 14px ui-monospace, SFMono-Regular, monospace; }
    .diagnosis-name { font-size: 15px; }
    .severity { display: inline-flex; margin-left: 7px; padding: 4px 7px; border: 1px solid rgba(255,105,120,.42); border-radius: 999px; color: var(--red); background: var(--red-soft); font-size: 10px; vertical-align: 1px; }
    .severity.watch { border-color: rgba(246,200,93,.42); color: var(--gold); background: var(--gold-soft); }
    .diagnosis ul { margin: 0; padding-left: 17px; color: #cbd2da; font-size: 12px; line-height: 1.55; }
    .evidence-badge { padding: 6px 9px; border-radius: 999px; font-size: 10px; font-weight: 650; white-space: nowrap; }
    .evidence-badge.real { color: var(--green); background: var(--green-soft); border: 1px solid rgba(85,215,160,.24); }
    .evidence-badge.shadow { color: var(--blue); background: var(--blue-soft); border: 1px solid rgba(120,175,255,.22); }
    .evidence-badge.descriptive { color: #b7c1ce; background: rgba(183,193,206,.08); border: 1px solid rgba(183,193,206,.15); }
    .rail-card { padding: 17px; }
    .rail-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 13px; }
    .rail-title h2 { font-size: 17px; }
    .scope-item { padding: 12px 0 12px 13px; border-left: 3px solid #617083; }
    .scope-item + .scope-item { border-top: 1px solid var(--line-soft); }
    .scope-item.real { border-left-color: var(--green); }
    .scope-item.shadow { border-left-color: var(--blue); }
    .scope-item strong { display: block; margin-bottom: 4px; font-size: 14px; }
    .scope-item p { color: var(--muted); font-size: 11px; line-height: 1.55; }
    .scope-foot { margin-top: 10px; padding: 12px; border: 1px solid var(--line-soft); border-radius: 7px; color: #b9c3ce; background: rgba(255,255,255,.018); font-size: 11px; line-height: 1.55; }
    .trade-card { padding: 15px; border: 1px solid var(--line-soft); border-radius: 8px; background: rgba(255,255,255,.015); }
    .trade-card + .trade-card { margin-top: 9px; }
    .trade-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .trade-top strong { font-size: 18px; letter-spacing: .02em; }
    .trade-pnl { font: 760 16px ui-monospace, SFMono-Regular, monospace; }
    .trade-sub { margin-top: 5px; color: #c8d0d9; font-size: 11px; }
    .trade-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--line-soft); }
    .trade-metrics span, .evidence-grid span { color: var(--muted); font-size: 10px; }
    .trade-metrics strong, .evidence-grid strong { display: block; margin-top: 4px; font: 680 12px ui-monospace, SFMono-Regular, monospace; }
    .trade-result { margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--line-soft); color: #dce1e7; font-size: 11px; line-height: 1.5; }
    details { border-top: 1px solid var(--line-soft); }
    details:first-child { border-top: 0; }
    summary { padding: 13px 0; color: #d6dce3; cursor: pointer; font-size: 12px; font-weight: 650; }
    details[open] summary { color: var(--gold); }
    .evidence-detail { padding: 0 0 14px; }
    .evidence-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .raw-list { max-height: 260px; overflow: auto; margin: 0; padding: 0; list-style: none; }
    .raw-list li { padding: 9px 0; border-top: 1px solid var(--line-soft); color: #aeb8c4; font: 10px/1.5 ui-monospace, SFMono-Regular, monospace; overflow-wrap: anywhere; }
    .incident { padding: 13px 0; }
    .incident + .incident { border-top: 1px solid var(--line-soft); }
    .incident-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .incident-head strong { font-size: 13px; }
    .incident-count { color: var(--red); font: 760 15px ui-monospace, SFMono-Regular, monospace; }
    .incident dl { display: grid; grid-template-columns: 72px 1fr; gap: 7px; margin: 10px 0 0; font-size: 11px; }
    .incident dt { color: var(--muted); }
    .incident dd { margin: 0; color: #c7cfd8; overflow-wrap: anywhere; }
    .empty { padding: 18px 4px; color: var(--muted); text-align: center; font-size: 12px; }
    .context-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .context-cell { padding: 12px; border: 1px solid var(--line-soft); border-radius: 7px; }
    .context-cell span { color: var(--muted); font-size: 10px; }
    .context-cell strong { display: block; margin-top: 5px; font: 680 12px ui-monospace, SFMono-Regular, monospace; }
    .context-note { margin: 0 0 11px; color: #b9c3ce; font-size: 11px; line-height: 1.55; }
    .context-grid + .context-note { margin: 11px 0 0; }
    .loading-error { color: var(--red); }
    @media (max-width: 1080px) {
      .layout { grid-template-columns: 1fr; }
      .rail { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
      .rail > * + * { margin-top: 0; }
      .rail > .wide { grid-column: 1 / -1; }
    }
    @media (max-width: 760px) {
      .shell { width: min(100% - 24px, 1420px); }
      .nav { min-height: 62px; }
      .brand span { display: none; }
      .nav-actions { gap: 7px; }
      select { min-width: 0; width: 156px; }
      .nav-link { padding-inline: 12px; }
      .page-head { align-items: flex-start; flex-direction: column; }
      .page-head-side { width: 100%; align-items: flex-start; }
      .actions { width: 100%; }
      .button { flex: 1; padding-inline: 10px; }
      .health { grid-template-columns: 1fr; padding: 22px; }
      .health-verdict { padding: 15px 0 0; border-left: 0; border-top: 1px solid #3a4654; }
      .diagnosis { grid-template-columns: 40px minmax(0, 1fr); }
      .diagnosis ul, .diagnosis .evidence-badge { grid-column: 2; }
      .diagnosis .evidence-badge { justify-self: start; }
      .rail { grid-template-columns: 1fr; }
      .rail > .wide { grid-column: auto; }
      .context-grid { grid-template-columns: repeat(2, 1fr); }
      .mobile-table-note { display: block; padding: 10px 16px 0; color: var(--gold); font-size: 11px; }
    }
    @media (max-width: 480px) {
      .nav-link:first-of-type { display: none; }
      .health-title { align-items: flex-start; flex-direction: column; gap: 5px; }
      .health-title strong { font-size: 30px; }
      .scope-note { display: none; }
    }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  </style>
</head>
<body>
  <header><div class="shell nav">
    <a class="brand" href="/reviews"><img src="/favicon.svg" alt=""><span>交易复盘</span></a>
    <div class="nav-actions"><select id="reviewDate" aria-label="选择交易日"></select><a class="nav-link" href="/strategies">策略</a><a class="nav-link" href="/">仪表盘</a></div>
  </div></header>
  <main class="shell">
    <div class="layout">
      <div class="primary">
        <div class="page-head">
          <div>
            <h1>策略体检</h1>
            <div class="freshness" id="generatedAt" aria-live="polite">读取中…</div>
            <p class="intro">对比今日、近 5 日、近 20 日的交易证据，判断交易过程是否在改善。</p>
          </div>
          <div class="page-head-side"><div class="eyebrow" id="reviewPhase">复盘阶段：读取中</div><div class="actions"><button class="button primary" id="diagnosisButton" type="button">查看需改进项</button><button class="button secondary" id="evidenceButton" type="button">展开完整证据</button></div></div>
        </div>

        <section class="panel health" id="healthSummary" aria-live="polite">
          <div><div class="health-title">策略健康度：<strong id="healthStatus">读取中</strong></div><div class="health-evidence" id="dailyMetrics"></div></div>
          <p class="health-verdict" id="healthVerdict">基于历史数据的客观诊断，不构成未来表现保证。</p>
        </section>

        <section>
          <div class="section-head"><div><h2>关键指标对比</h2><p>从结果、执行、风险等维度，对比三个观察窗口。</p></div><span class="scope-note">Shadow 不计入真实成交</span></div>
          <div class="panel table-wrap"><p class="mobile-table-note">左右滑动查看近 20 日与判断</p><table id="comparisonTable"><thead><tr><th>指标</th><th>今日 <small id="todayDate"></small></th><th>近 5 日 <small id="fiveDates"></small></th><th>近 20 日 <small id="twentyDates"></small></th><th>判断</th></tr></thead><tbody id="periodComparison"></tbody></table></div>
        </section>

        <section id="diagnosisSection">
          <div class="section-head"><div><h2>问题诊断（按影响程度排序）</h2><p>每项结论标注证据类型，避免把模拟结果或低样本归因当成真实收益。</p></div></div>
          <div class="diagnosis-list" id="diagnosisList"></div>
        </section>

        <section id="completeEvidence">
          <div class="section-head"><div><h2>补充证据</h2><p>默认收起，按需查看盘前环境、市场归因、系统生成结论与开放风险。</p></div></div>
          <div class="panel rail-card">
            <details class="evidence-detail"><summary>盘前市场环境</summary><div id="premarketBrief"></div></details>
            <details class="evidence-detail"><summary>外部市场归因</summary><div id="externalMarket"></div></details>
            <details class="evidence-detail"><summary>系统生成结论</summary><ul class="raw-list" id="findings"></ul></details>
            <details class="evidence-detail"><summary>收盘开放风险</summary><div id="openRisk"></div></details>
          </div>
        </section>
      </div>

      <aside class="rail" aria-label="交易证据">
        <section class="panel rail-card" id="evidenceScope">
          <div class="rail-title"><h2>证据范围说明</h2></div>
          <div class="scope-item real"><strong>真实成交</strong><p>来自交易所的已成交记录，用于衡量实际表现。</p></div>
          <div class="scope-item shadow"><strong>Shadow 研究</strong><p>相同路径、相同市场条件下的非执行对照，用于评估机会成本。</p></div>
          <div class="scope-item"><strong>描述性归因 / 低样本</strong><p>仅用于现象描述，不代表稳定规律或因果关系。</p></div>
          <p class="scope-foot">当前报告为历史数据分析，不包含预测或自动交易建议。</p>
        </section>

        <section class="panel rail-card">
          <div class="rail-title"><h2 id="tradeHeading">本次完成交易</h2><span class="evidence-badge real">真实成交</span></div>
          <div id="tradeRows"></div>
        </section>

        <section class="panel rail-card wide">
          <div class="rail-title"><h2>重复事件（已聚合）</h2><span class="evidence-badge descriptive">运行记录</span></div>
          <div id="systemFailures"></div>
        </section>
      </aside>
    </div>
  </main>
  <script>
    const money = (value) => value == null ? "—" : (Number(value) >= 0 ? "+" : "") + Number(value).toFixed(3) + " U";
    const pct = (value) => value == null ? "—" : Number(value).toFixed(1) + "%";
    const number = (value, digits = 2) => value == null ? "—" : Number(value).toFixed(digits);
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const tone = (value) => value == null || !Number.isFinite(Number(value)) || Number(value) === 0 ? "" : Number(value) > 0 ? "green" : "red";
    const period = (report, sessions) => (report.periods || []).find((item) => item.sessions === sessions) || null;
    const shortDate = (value) => value ? value.slice(5) : "—";
    const dateRange = (item) => item ? "(" + shortDate(item.startDate) + "～" + shortDate(item.endDate) + ")" : "";
    const ageDays = (date) => {
      const timestamp = Date.parse(date + "T00:00:00Z");
      return Number.isFinite(timestamp) ? Math.max(0, Math.floor((Date.now() - timestamp) / 86400000)) : null;
    };
    const humanDuration = (minutes) => {
      if (minutes == null) return "—";
      const rounded = Math.round(Number(minutes));
      const days = Math.floor(rounded / 1440);
      const hours = Math.floor((rounded % 1440) / 60);
      const mins = rounded % 60;
      if (days) return days + " 天 " + hours + " 小时";
      if (hours) return hours + " 小时 " + mins + " 分";
      return mins + " 分钟";
    };
    const strategyName = (id) => ({ "adaptive-momentum": "自适应动量" }[id] || id || "未知策略");
    const exitName = (reason) => ({ TRAILING_STOP: "移动止盈", INITIAL_STOP: "初始止损", TAKE_PROFIT_2R: "2R 止盈", TIME_EXIT: "时间退出", DISASTER_STOP: "灾难止损" }[reason] || reason || "未知退出");
    const shadowDecisionName = (decision) => ({ WOULD_SKIP: "会跳过", WOULD_BLOCK: "会阻止", WOULD_ALLOW: "会放行", INSUFFICIENT_DATA: "数据不足" }[decision] || decision || "无对照");
    const failureName = (failure) => {
      const source = failure.error || failure.operation || "未知错误";
      if (/no available liquidity|opening hours/i.test(source)) return "美股非开盘时段暂无代币流动性";
      return source;
    };
    let history = [];

    function appendContextMetric(root, label, value, valueTone = "") {
      const cell = el("div", "context-cell");
      cell.append(el("span", "", label), el("strong", valueTone, value));
      root.append(cell);
    }

    function healthFor(report) {
      const long = period(report, 20);
      if (!long || long.trades < 10) return { label: "证据不足", tone: "gold" };
      if (long.realizedPnlUsdt < 0 || long.profitFactor == null || long.profitFactor < 1 || long.payoffRatio == null || long.payoffRatio < 1) return { label: "需改进", tone: "gold" };
      return { label: "状态良好", tone: "green" };
    }

    function renderHealth(report) {
      const daily = report.daily || {};
      const five = period(report, 5);
      const twenty = period(report, 20);
      const health = healthFor(report);
      const status = document.getElementById("healthStatus");
      status.className = health.tone;
      status.textContent = health.label;
      const evidence = document.getElementById("dailyMetrics");
      evidence.replaceChildren();
      [["今日", daily.realizedPnlUsdt], ["近 5 日", five?.realizedPnlUsdt], ["近 20 日", twenty?.realizedPnlUsdt]].forEach(([label, value], index) => {
        if (index) evidence.append(document.createTextNode("，"));
        evidence.append(document.createTextNode(label + " "));
        evidence.append(el("span", tone(value), money(value)));
      });
      if (twenty) {
        evidence.append(document.createTextNode("；20 日 PF "));
        evidence.append(el("span", twenty.profitFactor != null && twenty.profitFactor < 1 ? "red" : "", number(twenty.profitFactor)));
        evidence.append(document.createTextNode("，盈亏比 "));
        evidence.append(el("span", twenty.payoffRatio != null && twenty.payoffRatio < 1 ? "red" : "", number(twenty.payoffRatio)));
        evidence.append(document.createTextNode("。"));
      }
      let verdict = "数据只描述已经发生的交易，不构成未来表现保证。";
      if (daily.realizedPnlUsdt > 0 && twenty?.realizedPnlUsdt < 0) verdict = "单日盈利不能改变近 20 日仍为负的判断，交易过程尚未证实改善。";
      else if (twenty?.realizedPnlUsdt < 0) verdict = "近 20 日结果仍为负，优先处理长期表现与执行稳定性。";
      document.getElementById("healthVerdict").textContent = verdict;
    }

    function renderComparison(report) {
      const daily = report.daily || {};
      const five = period(report, 5);
      const twenty = period(report, 20);
      document.getElementById("todayDate").textContent = "(" + report.tradingDate + ")";
      document.getElementById("fiveDates").textContent = dateRange(five);
      document.getElementById("twentyDates").textContent = dateRange(twenty);
      const judgements = {
        pnl: twenty?.realizedPnlUsdt < 0 ? "整体仍为负" : "整体保持盈利",
        trades: daily.trades <= 1 ? "单日样本不可独立判断" : "结合更长窗口判断",
        winRate: twenty?.winRatePct < 50 ? "长期胜率不足" : "长期胜率过半",
        pf: twenty?.profitFactor == null ? "样本不足" : twenty.profitFactor < 1 ? "低于 1，尚未盈利" : "高于 1",
        payoff: twenty?.payoffRatio == null ? "样本不足" : twenty.payoffRatio < 1 ? "低于 1，盈利空间不足" : "高于 1",
        drawdown: twenty?.maxDrawdownUsdt > 0 ? "关注回撤存续" : "暂无已实现回撤"
      };
      const rows = [
        ["净收益 (U)", money(daily.realizedPnlUsdt), money(five?.realizedPnlUsdt), money(twenty?.realizedPnlUsdt), judgements.pnl, true],
        ["交易次数", String(daily.trades ?? 0), String(five?.trades ?? "—"), String(twenty?.trades ?? "—"), judgements.trades, false],
        ["胜率", pct(daily.winRatePct), pct(five?.winRatePct), pct(twenty?.winRatePct), judgements.winRate, false],
        ["Profit Factor", number(daily.profitFactor), number(five?.profitFactor), number(twenty?.profitFactor), judgements.pf, false],
        ["盈亏比", number(daily.payoffRatio), number(five?.payoffRatio), number(twenty?.payoffRatio), judgements.payoff, false],
        ["最大回撤", money(daily.maxDrawdownUsdt == null ? null : -daily.maxDrawdownUsdt), money(five?.maxDrawdownUsdt == null ? null : -five.maxDrawdownUsdt), money(twenty?.maxDrawdownUsdt == null ? null : -twenty.maxDrawdownUsdt), judgements.drawdown, true]
      ];
      const root = document.getElementById("periodComparison");
      root.replaceChildren();
      rows.forEach(([label, today, fiveValue, twentyValue, judgement, signed]) => {
        const row = document.createElement("tr");
        row.append(el("td", "", label));
        [today, fiveValue, twentyValue].forEach((value) => row.append(el("td", "value " + (signed ? tone(Number.parseFloat(value)) : ""), value)));
        row.append(el("td", "judgement", judgement));
        root.append(row);
      });
    }

    function renderDiagnosis(report) {
      const twenty = period(report, 20);
      const shadow = report.shadowCounterfactuals?.regimeRelativePullbackMomentum;
      const failures = report.systemFailures?.events || [];
      const external = report.externalMarket;
      const root = document.getElementById("diagnosisList");
      root.replaceChildren();
      const diagnoses = [
        { name: "策略信号", severity: "主要问题", evidence: "证据：Shadow 研究", evidenceClass: "shadow", points: [
          shadow?.vetoedTrades ? "Shadow 过滤器会否决 " + shadow.vetoedTrades + " 笔真实入场，回看错过盈利 " + money(shadow.missedProfitUsdt) + "。" : "Shadow 样本不足，暂不能判断过滤器的机会成本。",
          twenty ? "近 20 日净收益 " + money(twenty.realizedPnlUsdt) + "，PF " + number(twenty.profitFactor) + "，盈亏比 " + number(twenty.payoffRatio) + "。" : "缺少近 20 日证据。"
        ] },
        { name: "执行与成本", severity: "重要问题", evidence: "证据：真实成交", evidenceClass: "real", points: [
          "当日交易手续费（Gas）为 " + money(-(report.daily?.gasCostUsdt || 0)) + "，直接减少实际净收益。",
          failures.length ? failures.length + " 条运行事件已聚合为 " + groupFailures(failures).length + " 个根因，避免重复记录淹没判断。" : "当日没有记录到执行失败事件。"
        ] },
        { name: "系统与数据", severity: "需关注", severityClass: "watch", evidence: "证据：描述性归因 / 低样本", evidenceClass: "descriptive", points: [
          external?.status === "AVAILABLE" ? "市场归因样本 " + external.observedTrades + " / " + external.totalTrades + " 笔，结论置信度有限。" : "可对齐分钟数据不足，无法估算外部市场关联。",
          "建议持续检查数据完整性与运行状态；本页不会改变交易、风控或审批规则。"
        ] }
      ];
      diagnoses.forEach((item, index) => {
        const card = el("article", "panel diagnosis");
        card.append(el("span", "rank", String(index + 1)));
        const name = el("div", "diagnosis-name");
        name.append(el("strong", "", item.name), el("span", "severity " + (item.severityClass || ""), item.severity));
        const list = el("ul", "");
        item.points.forEach((point) => list.append(el("li", "", point)));
        card.append(name, list, el("span", "evidence-badge " + item.evidenceClass, item.evidence));
        root.append(card);
      });
    }

    function renderTrades(report) {
      const trades = report.trades || [];
      document.getElementById("tradeHeading").textContent = "本次完成交易（" + trades.length + " 笔）";
      const root = document.getElementById("tradeRows");
      root.replaceChildren();
      if (!trades.length) {
        root.append(el("div", "empty", "该交易日没有完成的真实卖出成交。"));
        return;
      }
      trades.forEach((trade) => {
        const card = el("article", "trade-card");
        const top = el("div", "trade-top");
        top.append(el("strong", "", trade.symbol), el("span", "trade-pnl " + tone(trade.realizedPnlUsdt), money(trade.realizedPnlUsdt)));
        const metrics = el("div", "trade-metrics");
        [["MAE", pct(trade.maePct), "red"], ["MFE", pct(trade.mfePct), "green"]].forEach(([label, value, valueTone]) => {
          const cell = el("div", "");
          cell.append(el("span", "", label), el("strong", valueTone, value));
          metrics.append(cell);
        });
        const shadowDecision = trade.entryShadow?.regimeRelativePullback?.decision || trade.entryShadow?.pullback?.decision;
        const result = trade.realizedPnlUsdt > 0 && ["WOULD_SKIP", "WOULD_BLOCK"].includes(shadowDecision)
          ? "结果盈利，但 Shadow 过滤器当时" + shadowDecisionName(shadowDecision) + "。"
          : "真实成交结果与 Shadow 对照分开记录。";
        const details = el("details", "evidence-detail");
        details.append(el("summary", "", "查看完整成交证据"));
        const grid = el("div", "evidence-grid");
        [["真实净收益", money(trade.realizedPnlUsdt)], ["Gas", money(-trade.gasCostUsdt)], ["投入金额", money(trade.amountUsdt)], ["持仓时长", humanDuration(trade.holdingMinutes)], ["退出原因", exitName(trade.exitReason)], ["Shadow 判断", shadowDecisionName(shadowDecision)], ["止损触发", (trade.stopTriggerCount || 0) + " 次"], ["复核取消", (trade.stopRevalidationCancelledCount || 0) + " 次"]].forEach(([label, value]) => appendContextMetric(grid, label, value));
        details.append(grid);
        card.append(top, el("p", "trade-sub", strategyName(trade.strategyId) + " · 持仓 " + humanDuration(trade.holdingMinutes) + " · " + exitName(trade.exitReason)), metrics, el("p", "trade-result", result), details);
        root.append(card);
      });
    }

    function groupFailures(events) {
      const groups = new Map();
      events.forEach((failure) => {
        const label = failureName(failure);
        if (!groups.has(label)) groups.set(label, { label, count: 0, first: failure.timestamp, last: failure.timestamp, symbols: new Set(), events: new Set(), raw: [] });
        const group = groups.get(label);
        group.count += 1;
        group.first = group.first < failure.timestamp ? group.first : failure.timestamp;
        group.last = group.last > failure.timestamp ? group.last : failure.timestamp;
        if (failure.symbol) group.symbols.add(failure.symbol);
        if (failure.event) group.events.add(failure.event);
        group.raw.push(failure);
      });
      return [...groups.values()].sort((a, b) => b.count - a.count);
    }

    function renderFailures(report) {
      const events = report.systemFailures?.events || [];
      const root = document.getElementById("systemFailures");
      root.replaceChildren();
      if (!events.length) {
        root.append(el("div", "empty", "该交易日没有记录到失败事件。"));
        return;
      }
      groupFailures(events).forEach((group) => {
        const incident = el("article", "incident");
        const head = el("div", "incident-head");
        head.append(el("strong", "", group.label), el("span", "incident-count", group.count + " 次"));
        const facts = document.createElement("dl");
        [["影响资产", group.symbols.size ? [...group.symbols].join("、") : "未标记"], ["涉及环节", [...group.events].join("、") || "未知"], ["首次发生", new Date(group.first).toLocaleString("zh-CN")], ["最后发生", new Date(group.last).toLocaleString("zh-CN")]].forEach(([label, value]) => facts.append(el("dt", "", label), el("dd", "", value)));
        const details = el("details", "evidence-detail");
        details.append(el("summary", "", "展开查看 " + group.count + " 条原始事件"));
        const raw = el("ul", "raw-list");
        group.raw.forEach((failure) => raw.append(el("li", "", new Date(failure.timestamp).toLocaleString("zh-CN") + " · " + (failure.event || "未知事件") + (failure.symbol ? " · " + failure.symbol : "") + " · " + (failure.error || failure.operation || "未知错误"))));
        details.append(raw);
        incident.append(head, facts, details);
        root.append(incident);
      });
    }

    function renderPremarket(brief) {
      const root = document.getElementById("premarketBrief");
      root.replaceChildren();
      if (!brief || brief.status !== "AVAILABLE") {
        root.append(el("div", "empty", "该交易日尚无可用盘前简报；交易执行不受影响。"));
        return;
      }
      const grid = el("div", "context-grid");
      appendContextMetric(grid, "大盘平均", pct(brief.market?.benchmarkAveragePct), tone(brief.market?.benchmarkAveragePct));
      appendContextMetric(grid, "标的上涨广度", pct(brief.market?.breadthPositivePct));
      appendContextMetric(grid, "VIX 变化", pct(brief.market?.vixChangePct), tone(-(brief.market?.vixChangePct || 0)));
      appendContextMetric(grid, "风险新闻", (brief.news?.riskHeadlineCount || 0) + " / " + (brief.news?.headlineCount || 0));
      root.append(el("p", "context-note", brief.advice?.summary || "无文字建议"), grid, el("p", "context-note", "仅用于环境提示；不会自动放宽或收紧策略门槛，也不会触发下单。"));
    }

    function renderExternalMarket(market) {
      const root = document.getElementById("externalMarket");
      root.replaceChildren();
      if (!market || market.status !== "AVAILABLE") {
        root.append(el("div", "empty", "可对齐的分钟数据不足，无法估算市场关联。"));
        return;
      }
      const grid = el("div", "context-grid");
      appendContextMetric(grid, "可观测交易", market.observedTrades + " / " + market.totalTrades + " 笔");
      appendContextMetric(grid, "平均相关系数", number(market.averageCorrelation, 3));
      appendContextMetric(grid, "亏损同向率", pct(market.lossDirectionAlignmentPct));
      appendContextMetric(grid, "数据错误", String((market.errors || []).length));
      root.append(grid, el("p", "context-note", "基于持仓期间标的与 SPY/QQQ 对齐的一分钟收益；这是描述性统计，不代表市场造成了交易结果。"));
    }

    function renderSupplement(report) {
      renderPremarket(report.premarketBrief);
      renderExternalMarket(report.externalMarket);
      const findings = document.getElementById("findings");
      const reportFindings = report.findings || [];
      findings.replaceChildren(...(reportFindings.length ? reportFindings : ["该交易日没有额外系统结论。"]).map((finding) => el("li", "", finding)));
      const open = document.getElementById("openRisk");
      open.replaceChildren();
      const positions = report.openPositions || [];
      if (!positions.length) {
        open.append(el("div", "empty", "收盘复盘时没有开放仓位。"));
        return;
      }
      const grid = el("div", "context-grid");
      positions.forEach((position) => appendContextMetric(grid, position.symbol, "未实现 " + money(position.grossUnrealizedPnlUsdt), position.grossUnrealizedPnlUsdt < 0 ? "red" : "green"));
      open.append(grid);
    }

    function render(report) {
      const phase = report.reviewPhase === "FINAL" ? "终版" : "收盘预览";
      document.getElementById("reviewPhase").textContent = "复盘阶段：历史数据分析 · " + phase;
      const staleDays = ageDays(report.tradingDate);
      const freshness = document.getElementById("generatedAt");
      freshness.replaceChildren(document.createTextNode("历史复盘 · 数据截至 " + report.tradingDate));
      if (staleDays > 0) freshness.append(document.createTextNode(" · "), el("strong", "", staleDays + " 天未更新"));
      renderHealth(report);
      renderComparison(report);
      renderDiagnosis(report);
      renderTrades(report);
      renderFailures(report);
      renderSupplement(report);
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

    document.getElementById("diagnosisButton").addEventListener("click", () => document.getElementById("diagnosisSection").scrollIntoView({ behavior: "smooth", block: "start" }));
    document.getElementById("evidenceButton").addEventListener("click", () => {
      document.querySelectorAll("#completeEvidence details").forEach((detail) => { detail.open = true; });
      document.getElementById("completeEvidence").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    load().catch((error) => {
      const generatedAt = document.getElementById("generatedAt");
      generatedAt.className = "freshness loading-error";
      generatedAt.textContent = "读取失败：" + error.message;
    });
  </script>
</body>
</html>`;
}
