export function strategyLabHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>策略研究 · Agentic Wallet</title>
  <style>
    :root { --bg: #080b0f; --panel: #11161e; --line: #28313d; --text: #f1f4f8; --muted: #9caabc; --blue: #88b2ff; --green: #56d7a4; --gold: #edc36e; --red: #ff7885; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.6; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    button, input, select { font: inherit; color: var(--text); }
    button { cursor: pointer; }
    button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 4px; }
    button:disabled { cursor: wait; opacity: .6; }
    .skip { position: absolute; top: -80px; left: 20px; z-index: 10; background: var(--panel); padding: 12px; }
    .skip:focus { top: 8px; }
    .topbar { height: 69px; padding: 0 28px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 50px; }
    .brand { display: flex; align-items: center; gap: 12px; color: var(--text); font-size: 21px; font-weight: 700; white-space: nowrap; }
    .brand img { width: 30px; height: 30px; }
    .topbar nav { display: flex; align-self: stretch; gap: 32px; }
    .topbar nav a { display: flex; align-items: center; color: var(--muted); border-bottom: 3px solid transparent; padding: 0 8px; font-weight: 600; }
    .topbar nav a[aria-current] { color: var(--blue); border-color: var(--blue); }
    .top-meta { margin-left: auto; color: var(--muted); font-size: 12px; }
    .workspace { display: grid; grid-template-columns: 370px minmax(0, 1fr); max-width: 1680px; margin: auto; }
    .directory { padding: 28px 26px; border-right: 1px solid var(--line); height: calc(100vh - 69px); position: sticky; top: 0; display: flex; flex-direction: column; }
    .directory h1 { font-size: 23px; margin: 0 0 2px; letter-spacing: -.03em; }
    .muted, .directory p { color: var(--muted); }
    .directory p { margin: 0 0 18px; }
    .directory-body { display: flex; flex-direction: column; min-height: 0; }
    .search { width: 100%; padding: 11px 13px; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; margin-bottom: 12px; }
    .directory-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; margin-bottom: 15px; }
    select { background: var(--panel); border: 1px solid var(--line); border-radius: 5px; padding: 5px 7px; max-width: 100%; }
    .strategy-list { overflow-y: auto; min-height: 0; scrollbar-width: thin; }
    .strategy-item { width: 100%; background: transparent; border: 0; border-bottom: 1px solid var(--line); border-left: 3px solid transparent; padding: 17px 14px; text-align: left; }
    .strategy-item:first-child { border-top: 1px solid var(--line); }
    .strategy-item:hover { background: #131b27; }
    .strategy-item[aria-pressed="true"] { border-left-color: var(--blue); background: #131d2f; }
    .item-top { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
    .item-top strong { font-size: 15px; line-height: 1.5; }
    .item-meta { color: var(--muted); font-size: 12px; margin-top: 5px; display: flex; justify-content: space-between; gap: 8px; }
    .directory-footer { font-size: 12px; padding-top: 18px; margin-top: auto; color: var(--muted); }
    .directory-toggle { display: none; }
    .dossier { min-width: 0; padding: 27px 30px 40px; }
    .breadcrumb { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
    .title-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    h2 { font-size: 30px; line-height: 1.35; letter-spacing: -.035em; margin: 0; }
    .badge { display: inline-flex; padding: 3px 9px; border: 1px solid #42516a; background: #19212d; border-radius: 6px; color: #b7cbed; font-size: 12px; white-space: nowrap; }
    .badge.green { color: var(--green); border-color: #2e6653; background: #11241f; }
    .badge.gold { color: var(--gold); border-color: #655532; background: #262216; }
    .thesis { font-size: 17px; color: #b5c0d0; margin: 10px 0 20px; }
    .verdict { border: 1px solid #4a402a; border-left: 3px solid var(--gold); background: #1b1913; padding: 15px 20px; border-radius: 7px; margin-bottom: 18px; }
    .verdict strong { font-size: 18px; }
    .verdict p { margin: 4px 0 0; color: #c5c2b6; }
    .section-tabs { display: flex; gap: 16px; border-bottom: 1px solid var(--line); margin-bottom: 24px; }
    .section-tabs button { color: var(--muted); background: transparent; border: 0; border-bottom: 3px solid transparent; padding: 12px 19px; font-weight: 600; }
    .section-tabs button[aria-pressed="true"] { color: var(--blue); border-bottom-color: var(--blue); }
    h3 { font-size: 18px; margin: 0 0 12px; }
    h4 { font-size: 15px; margin: 0 0 7px; }
    p { margin: 0 0 12px; }
    .analysis-head { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
    .evidence-tabs { display: flex; gap: 3px; background: #161d27; border: 1px solid var(--line); border-radius: 9px; padding: 3px; }
    .evidence-tabs button { background: none; border: 0; border-radius: 7px; color: #b7c1d0; padding: 5px 18px; }
    .evidence-tabs button[aria-pressed="true"] { background: var(--blue); color: #081426; font-weight: 700; }
    .source-meta { color: var(--muted); font-size: 12px; }
    .analysis-head .source-meta { margin: 0; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; margin: 25px 0 29px; }
    .metric { border-right: 1px solid var(--line); padding-right: 14px; }
    .metric:last-child { border: 0; }
    .metric span { display: block; color: var(--muted); font-size: 13px; }
    .metric strong { display: block; font-size: 26px; font-weight: 650; line-height: 1.5; font-variant-numeric: tabular-nums; }
    .metric small { color: var(--muted); font-size: 11px; }
    .negative { color: var(--red); }
    .table-wrap { border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; margin-bottom: 22px; }
    .table-hint { display: none; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
    th { background: #171e28; color: var(--muted); font-weight: 500; }
    th, td { padding: 12px 15px; border-bottom: 1px solid var(--line); }
    th:not(:first-child), td:not(:first-child) { white-space: nowrap; }
    tr:last-child td { border: 0; }
    .insights { display: grid; grid-template-columns: 1fr 1.15fr; gap: 28px; margin: 26px 0; }
    .insight { border-left: 1px solid #425064; padding-left: 20px; }
    .insight p { color: #b5c0d0; margin: 0; }
    .actions { display: flex; align-items: center; gap: 18px; margin-top: 28px; flex-wrap: wrap; }
    .primary, .secondary { border-radius: 6px; padding: 10px 18px; font-weight: 600; }
    .primary { background: var(--blue); color: #0a1424; border: 1px solid var(--blue); }
    .primary:hover { background: #a1c3ff; }
    .secondary { color: var(--blue); background: transparent; border: 1px solid var(--line); }
    .empty { padding: 23px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin: 18px 0; color: var(--muted); }
    .empty strong { color: var(--text); display: block; margin-bottom: 5px; }
    .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; margin: 22px 0; }
    .fact { border-top: 1px solid var(--line); padding-top: 17px; }
    .fact p { color: #b5c0d0; }
    details { border-top: 1px solid var(--line); padding: 14px 0; }
    summary { cursor: pointer; color: var(--blue); }
    details p, details ul { color: var(--muted); margin-top: 12px; }
    .note { font-size: 12px; color: var(--muted); }
    .read-status { margin-top: 26px; padding-top: 15px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
    .read-status button { padding: 5px 10px; border: 1px solid var(--line); border-radius: 5px; background: transparent; }
    .error { color: var(--red); }
    @media (max-width: 1200px) { .workspace { grid-template-columns: 300px minmax(0, 1fr); } .directory { padding: 24px 18px; } .dossier { padding: 24px; } .metric strong { font-size: 23px; } .topbar { gap: 28px; } }
    @media (max-width: 760px) {
      .topbar { height: 60px; padding: 0 16px; gap: 14px; } .brand { font-size: 15px; gap: 7px; } .brand img { width: 23px; height: 23px; }
      .topbar nav { gap: 12px; margin-left: auto; } .topbar nav a { padding: 0; font-size: 12px; } .top-meta { display: none; }
      .workspace { display: block; } .directory { height: auto; position: static; padding: 16px; border-right: 0; border-bottom: 1px solid var(--line); }
      .directory h1 { font-size: 19px; } .directory p, .directory-footer { display: none; }
      .directory-toggle { display: block; margin-top: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); text-align: left; }
      .directory-body { display: none; } .directory-body.open { display: flex; padding-top: 14px; } .strategy-list { max-height: 340px; }
      .dossier { padding: 21px 16px 30px; } h2 { font-size: 25px; } .thesis { font-size: 15px; } .breadcrumb { font-size: 12px; margin-bottom: 12px; }
      .verdict { padding: 13px 15px; } .verdict strong { font-size: 16px; } .section-tabs { gap: 3px; margin-bottom: 20px; } .section-tabs button { padding: 11px 12px; font-size: 13px; }
      .evidence-tabs { width: 100%; } .evidence-tabs button { flex: 1; padding: 6px 10px; } .metrics { grid-template-columns: 1fr 1fr; gap: 19px 14px; margin: 21px 0; }
      .metric:nth-child(2) { border: 0; } .insights, .facts { grid-template-columns: 1fr; gap: 22px; } .insight { padding-left: 14px; }
      .actions { gap: 12px; } .primary, .secondary { padding: 10px 13px; } th, td { padding: 11px 12px; }
      .table-hint { display: block; margin: 0 0 8px; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#dossier">跳到研究档案</a>
  <header class="topbar">
    <a class="brand" href="/"><img src="/favicon.svg" alt="">Agentic Wallet</a>
    <nav aria-label="主导航"><a href="/strategies" aria-current="page">策略研究</a><a href="/reviews">复盘</a><a href="/btc-radar">BTC 风控</a></nav>
    <span class="top-meta">只读研究 · 交易管理请前往仪表盘</span>
  </header>
  <div class="workspace">
    <aside class="directory" aria-label="策略目录">
      <h1>策略研究档案</h1><p>从研究假设，到可验证的表现。</p>
      <button id="directoryToggle" class="directory-toggle" aria-expanded="false" aria-controls="directoryBody">选择策略</button>
      <div class="directory-body" id="directoryBody">
        <input class="search" id="strategySearch" type="search" placeholder="搜索策略名称或关键词…" aria-label="搜索策略">
        <div class="directory-meta"><span id="strategyCount">正在读取目录</span><select id="stageFilter" aria-label="筛选策略阶段"><option value="">全部阶段</option><option value="current">当前策略</option><option value="SHADOW">Shadow</option><option value="RESEARCH">研究中</option></select></div>
        <div id="strategyComparison" class="strategy-list"></div>
      </div>
      <div class="directory-footer">研究不等于可执行业绩。<br>所有实验均不改变现有交易与风控。</div>
    </aside>
    <main class="dossier" id="dossier" tabindex="-1">
      <div id="dossierContent"><div class="empty">正在读取策略与研究证据…</div></div>
      <footer class="read-status"><span id="readStatus" role="status">连接研究档案…</span><button id="refreshButton">刷新数据</button></footer>
    </main>
  </div>
  <script>
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const number = (value, digits = 2) => value == null || value === "" || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const pct = (value) => value == null ? "—" : number(value) + "%";
    const date = (value) => !value || !Number.isFinite(Date.parse(value)) ? "未提供" : new Date(value).toISOString().slice(0, 10);
    const period = (value) => value?.from && value?.to ? date(value.from) + " — " + date(value.to) : "覆盖期间未提供";
    const age = (value) => !value ? "报告日期未提供" : date(value) + (Date.now() - Date.parse(value) > 7 * 86400000 ? " · 超过 7 天未更新" : "");
    let data = null, selectedId = location.hash.slice(1), section = "performance", evidence = "live", busy = false, lastPayload = "";
    const selected = () => data?.strategies.find((strategy) => strategy.id === selectedId);
    const stage = (strategy) => strategy.active ? "当前策略" : strategy.status === "SHADOW" ? "Shadow" : strategy.status === "ACTIVE" ? "可运行" : "研究中";
    const badge = (strategy) => el("span", "badge " + (strategy.active ? "green" : strategy.status === "SHADOW" ? "gold" : ""), stage(strategy));
    const reportFailure = (source) => source?.status === "ERROR" ? "报告读取失败" : "尚无该来源的研究记录";
    function button(text, className, action) { const node = el("button", className, text); node.addEventListener("click", action); return node; }
    function defaultEvidence(strategy) {
      if (strategy.active || strategy.performance.trades) return "live";
      if (data.paper[strategy.id]?.status === "AVAILABLE") return "paper";
      if ([data.validation.historical, data.validation.forward].some((value) => value?.strategies.some((row) => row.id === strategy.id))) return "history";
      return "shadow";
    }
    function selectStrategy(id) {
      selectedId = id; evidence = defaultEvidence(selected()); history.replaceState(null, "", "#" + id);
      document.getElementById("directoryBody").classList.remove("open"); document.getElementById("directoryToggle").setAttribute("aria-expanded", "false");
      renderDirectory(); renderDossier();
      if (matchMedia("(max-width: 760px)").matches) document.getElementById("dossier").focus();
    }
    function renderDirectory() {
      const query = document.getElementById("strategySearch").value.trim().toLowerCase();
      const filter = document.getElementById("stageFilter").value;
      const rows = data.strategies.filter((strategy) => (!filter || (filter === "current" ? strategy.active : strategy.status === filter)) && [strategy.name, strategy.thesis, strategy.classification.family.label].join(" ").toLowerCase().includes(query));
      const list = document.getElementById("strategyComparison");
      const focused = list.contains(document.activeElement) ? document.activeElement.textContent : null;
      list.replaceChildren();
      document.getElementById("strategyCount").textContent = rows.length + " / " + data.strategies.length + " 个策略";
      document.getElementById("directoryToggle").textContent = "选择策略 · " + selected().name;
      for (const strategy of rows) {
        const item = button("", "strategy-item", () => selectStrategy(strategy.id)); item.setAttribute("aria-pressed", String(strategy.id === selectedId));
        const top = el("div", "item-top"); top.append(el("strong", "", strategy.name)); if (strategy.active) top.append(badge(strategy));
        const meta = el("div", "item-meta"); meta.append(el("span", "", strategy.classification.family.label), el("span", "", strategy.active ? "独立跟踪" : stage(strategy)));
        item.append(top, meta); list.append(item);
      }
      if (!rows.length) list.append(el("div", "empty", "未找到匹配策略，请调整关键词或阶段。"));
      if (focused) [...list.querySelectorAll("button")].find((item) => item.textContent === focused)?.focus({ preventScroll: true });
    }
    function facts(parent, entries) {
      const grid = el("div", "facts"); for (const [title, text] of entries) { const item = el("section", "fact"); item.append(el("h3", "", title), el("p", "", text || "尚未提供")); grid.append(item); } parent.append(grid);
    }
    function metrics(parent, entries) {
      const grid = el("div", "metrics"); for (const [label, value, hint, tone] of entries) { const item = el("div", "metric"); item.append(el("span", "", label), el("strong", tone || "", value), el("small", "", hint)); grid.append(item); } parent.append(grid);
    }
    function table(parent, headers, rows) {
      const wrap = el("div", "table-wrap"), node = el("table"), head = el("thead"), tr = el("tr"), body = el("tbody");
      wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "表现数据表，可横向滚动");
      for (const label of headers) { const cell = el("th", "", label); cell.scope = "col"; tr.append(cell); } head.append(tr);
      for (const row of rows) { const line = el("tr"); for (const value of row) line.append(el("td", String(value).startsWith("-") ? "negative" : "", value)); body.append(line); }
      node.append(head, body); wrap.append(node); parent.append(el("p", "table-hint note", "左右滑动查看完整表格"), wrap);
    }
    function empty(parent, title, text) { const node = el("div", "empty"); node.append(el("strong", "", title), el("span", "", text)); parent.append(node); }
    function insights(parent, result, boundary) { const grid = el("div", "insights"); for (const [title, text] of [["结果解读", result], ["证据边界", boundary]]) { const item = el("section", "insight"); item.append(el("h3", "", title), el("p", "", text)); grid.append(item); } parent.append(grid); }
    function renderLive(parent, strategy) {
      const value = strategy.performance;
      parent.append(el("p", "source-meta", "日志窗口：" + period(data.trace.period) + " · 不是完整历史账本"));
      metrics(parent, [["已实现收益", value.realizedPnlUsdt == null ? "—" : number(value.realizedPnlUsdt) + " U", "仅已完成的真实卖出", value.realizedPnlUsdt < 0 ? "negative" : ""], ["已实现收益回撤", value.maxDrawdownUsdt == null ? "—" : number(value.maxDrawdownUsdt) + " U", "不含持仓浮动损益"], ["有效平仓", data.trace.status === "AVAILABLE" ? number(value.trades, 0) + " 笔" : "—", "按订单去重"], ["匹配基准", "尚未提供", "不计算超额收益"]]);
      if (data.trace.status !== "AVAILABLE" || !value.trades) empty(parent, data.trace.status === "AVAILABLE" ? "此窗口暂无可核验的实盘平仓" : reportFailure(data.trace), "这不代表历史零收益，也不能据此判断策略无风险。");
      else table(parent, ["成交期间", "胜率", "盈利因子", "数据范围"], [[period(value.period), pct(value.winRatePct), number(value.profitFactor), "有限日志窗口"]]);
      insights(parent, value.trades ? "本窗口有 " + value.trades + " 笔可核验平仓。收益只反映已有成交，不构成长期表现或升级依据。" : "尚不能形成实盘业绩判断。继续积累已完成成交和完整资金曲线。", "读取交易日志中的已实现收益；成本按原记账口径，未重新审计。无完整账户净值，因此不提供年化收益、Sharpe 或组合最大回撤。");
      if (value.duplicateRecords || value.excludedRecords || value.conflictingOrders) parent.append(el("p", "note", "数据质量：合并 " + value.duplicateRecords + " 条重复记录；排除 " + value.excludedRecords + " 条无效记录及 " + value.conflictingOrders + " 个收益冲突订单。统计可能不完整。"));
    }
    function renderHistory(parent, strategy) {
      const report = data.validation;
      const rows = [["历史基线", report.historical], ["报告内前向模拟", report.forward]].map(([label, window]) => ({ label, window, result: window?.strategies.find((value) => value.id === strategy.id) })).filter((row) => row.result);
      parent.append(el("p", "source-meta", "报告生成：" + age(report.generatedAt)));
      if (report.status !== "AVAILABLE" || !rows.length) { empty(parent, report.status === "AVAILABLE" ? "此报告没有该策略的模拟结果" : reportFailure(report), "不使用其他策略或规则变体的结果填补空白。原始研究依据可在“研究概览”查看。"); return; }
      const current = rows.at(-1), value = current.result.performance || {}, notional = current.window.assumptions?.notionalUsdt;
      const valid = Number(value.trades) > 0;
      metrics(parent, [["收益 / 固定名义本金", valid ? pct(value.returnPct) : "—", "分母 " + number(notional) + " USDT", value.returnPct < 0 ? "negative" : ""], ["模拟最大回撤", valid ? pct(value.maxDrawdownPct) : "—", "同一固定本金口径"], ["已平仓", number(value.trades, 0) + " 笔", current.label], ["匹配基准", "尚未提供", "不计算超额收益"]]);
      parent.append(el("h3", "", "历史表现对比"));
      table(parent, ["阶段", "收益 / 固定本金", "最大回撤", "成交笔数", "时间区间"], rows.map((row) => { const p = row.result.performance || {}; return [row.label, p.trades > 0 ? pct(p.returnPct) : "—", p.trades > 0 ? pct(p.maxDrawdownPct) : "—", number(p.trades, 0), period(row.window.dataCoverage)]; }));
      insights(parent, !valid ? "没有已平仓样本，不能解读为零风险或零收益。" : value.pnlUsdt < 0 ? "所选模拟窗口成本后结果为负。需要检验亏损来源和不同市场环境，不能据此支持升级。" : "模拟结果不能直接外推为可执行收益；仍需成本敏感性、跨市场环境和独立前向验证。", "收益率是净损益除以固定单笔名义本金，不是组合收益率。K线代理及成本假设不等于真实成交；报告内前向窗口不代表独立样本外验证。");
      const costModel = current.window.assumptions?.costModel;
      parent.append(el("p", "note", "成本模型：" + (costModel === "roundTripCostPct deducted from every completed trade" ? "每笔完成交易扣除假设往返成本" : costModel || "未提供") + " · 往返成本假设 " + pct(current.window.assumptions?.roundTripCostPct)));
    }
    function renderPaper(parent, strategy) {
      const report = data.paper[strategy.id];
      if (report?.status !== "AVAILABLE") { empty(parent, reportFailure(report), "Paper 账本与实盘、历史模拟独立；未建立账本时不展示虚构净值。"); return; }
      parent.append(el("p", "source-meta", period({ from: report.startedAt, to: report.updatedAt }) + " · 更新：" + age(report.updatedAt)));
      metrics(parent, [["Paper 账本净值", report.equityUsdt == null ? "—" : number(report.equityUsdt) + " U", "包含代理价格估值"], ["已实现收益", number(report.realizedPnlUsdt) + " U", "独立模拟账本", report.realizedPnlUsdt < 0 ? "negative" : ""], ["已平仓", number(report.closedTrades, 0) + " 笔", "Paper 成交"], ["账本收益率", pct(report.totalReturnPct), "相对初始资金"]]);
      table(parent, ["初始资金", "模型成本", "持仓浮动损益", "持仓估值日"], [[number(report.initialCapitalUsdt) + " U", number(report.totalCostUsdt) + " U", report.position ? number(report.position.unrealizedPnlUsdt) + " U" : "无持仓", report.position ? date(report.position.markedAt) : "—"]]);
      insights(parent, report.closedTrades ? "分别检查已实现损益与未平仓估值，避免把浮盈当作落袋收益。" : "尚无已完成的 Paper 交易。即便账本净值未变化，也不足以证明策略有效。", "PAPER_CANDLE_PROXY：信号与估值使用日线代理，模型成本不保证覆盖代币报价、滑点及实际成交约束。不是实盘业绩。");
    }
    function renderShadow(parent, strategy) {
      const report = data.shadow;
      const rows = (report.horizons || []).map((horizon) => ({ minutes: horizon.horizonMinutes, value: horizon.strategyCohorts?.[strategy.id] })).filter((row) => row.value?.samples > 0);
      parent.append(el("p", "source-meta", "报告生成：" + age(report.generatedAt)));
      if (report.status !== "AVAILABLE" || !rows.length) empty(parent, report.status === "AVAILABLE" ? "尚无该策略已标注的 Shadow 样本" : reportFailure(report), "等待候选信号及后续价格标注；没有样本不等于没有偏离机会。");
      else table(parent, ["持有窗口", "样本数", "代理平均收益", "代理胜率", "盈利因子"], rows.map((row) => [row.minutes + " 分钟", number(row.value.samples, 0), pct(row.value.averageNetReturnPct), pct(row.value.winRatePct), number(row.value.profitFactor)]));
      insights(parent, "不同窗口可能来自同一候选，样本不能相加当成独立交易。需继续检查样本覆盖和偏离存续。", "COUNTERFACTUAL_NON_EXECUTING：代币扫描收盘价代理，扣入场成本一次，未完整计入卖出成本；不是可执行净收益，也不下单。");
      const simulation = strategy.performanceByEvidence.simulated;
      if (simulation.trades) { const detail = el("details"); detail.append(el("summary", "", "独立查看旧模拟执行日志（不计入上述 Shadow）")); detail.append(el("p", "", simulation.trades + " 笔模拟卖出，日志损益 " + number(simulation.realizedPnlUsdt) + " U；" + period(simulation.period) + "。非真实成交。")); parent.append(detail); }
    }
    function renderPerformance(parent, strategy) {
      parent.append(el("h3", "", "表现分析"));
      const head = el("div", "analysis-head"), tabs = el("div", "evidence-tabs"); tabs.setAttribute("aria-label", "表现证据来源");
      for (const [id, label] of [["live", "实盘"], ["paper", "Paper"], ["history", "历史模拟"], ["shadow", "Shadow"]]) { const item = button(label, "", () => { evidence = id; renderDossier(); }); item.setAttribute("aria-pressed", String(id === evidence)); tabs.append(item); } head.append(tabs); parent.append(head);
      ({ live: renderLive, paper: renderPaper, history: renderHistory, shadow: renderShadow })[evidence](parent, strategy);
      const metadata = [...parent.children].find((node) => node.className === "source-meta");
      if (metadata) head.append(metadata);
      const actions = el("div", "actions"); actions.append(button("阅读研究依据", "primary", () => { section = "overview"; renderDossier(); }), button("交易规则与数据来源", "secondary", () => { section = "rules"; renderDossier(); })); parent.append(actions);
    }
    function renderOverview(parent, strategy) {
      facts(parent, [["研究假设", strategy.thesis], ["适用周期与风险暴露", strategy.classification.family.label + " · " + strategy.classification.horizon.label + "；主要风险：" + strategy.classification.riskCluster.label], ["已有研究依据", strategy.evidence], ["可能失效的情形", strategy.risk]]);
      const identity = strategy.governance?.identity;
      facts(parent, [["当前规则版本", identity?.ruleVersion || "未提供"], ["当前代码哈希", identity?.codeHash || "未提供"], ["当前配置哈希", identity?.configHash || "未提供"], ["当前标的池", identity?.universe?.join(" / ") || "未提供"]]);
      parent.append(el("h3", "", "不可变证据档案"));
      const records = (data.archive?.records || []).filter((record) => record.strategyId === strategy.id);
      if (!records.length) empty(parent, data.archive?.status === "ERROR" ? "证据档案校验失败" : "尚无归档证据", "缺少生成时版本证明的旧报告不可用于晋级；不会倒填为当前规则结果。");
      else table(parent, ["证据类型", "数据截止", "生成时版本", "内容哈希"], records.map((record) => [record.kind + " · " + record.evidenceLevel, date(record.dataCutoff), record.identity?.ruleVersion?.slice(0, 12) || "未绑定旧报告", record.id.slice(0, 16)]));
      const plan = el("section", "insight"); plan.append(el("h3", "", "下一步验证"), el("p", "", "积累独立前向样本，核对真实可执行成本、公司行动与数据时效；在同期间基准下检验收益与风险。历史正收益或单个窗口的高胜率不构成上线依据。")); parent.append(plan);
      parent.append(el("p", "note", "以上依据来自策略目录，包含历史研究摘要；不是本系统当前完整业绩。具体来源与规则见下一页签。"));
    }
    function renderRules(parent, strategy) {
      facts(parent, [["入场条件", strategy.entry], ["退出条件", strategy.exit], ["数据与价格", strategy.backtestData || "分别采用执行日志、已保存验证报告、Paper 账本或 Shadow 报告；具体价格与成本口径见表现页。"], ["交易边界", strategy.active ? "当前配置策略；是否运行、暂停或待审批请以仪表盘为准。本页不修改交易规则、审批和风控。" : "研究或 Shadow 阶段，不在本页开放实盘切换。研究观察不改变现有风控。"]]);
      parent.append(el("h3", "", "原始参考"));
      if (!strategy.sources?.length) parent.append(el("p", "muted", "此策略目录尚未登记外部原始链接。研究摘要不等于可复现报告。"));
      for (const source of strategy.sources || []) { if (!/^https?:/.test(source.url)) continue; const p = el("p"), link = el("a", "", source.title); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer"; p.append(link); parent.append(p); }
      if (strategy.subStrategies.length) {
        const detail = el("details"); detail.append(el("summary", "", "共同 Shadow 风控实验 · " + strategy.subStrategies.length + " 项（仅观测）"));
        for (const rule of strategy.subStrategies) { const item = el("section", "fact"); item.append(el("h4", "", rule.name), el("p", "", rule.rule), el("p", "note", rule.evidence + "；风险：" + rule.risk)); detail.append(item); } parent.append(detail);
      }
      const method = el("details"); method.append(el("summary", "", "展示方法与研究标准"), el("p", "", "参考机构研究对可复现性、成本、期间及风险披露的做法；不宣称 GIPS 合规，不把论文业绩当作本系统表现。"));
      for (const [title, url] of [["AQR · 研究复现", "https://www.aqr.com/insights/perspectives/the-replication-crisis-that-wasnt"], ["AQR · 交易成本", "https://www.aqr.com/insights/research/working-paper/trading-costs"], ["GIPS · 业绩呈现", "https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/"]]) { const p = el("p"), link = el("a", "", title); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; p.append(link); method.append(p); } parent.append(method);
    }
    function renderDossier() {
      const strategy = selected(), parent = document.getElementById("dossierContent");
      const focus = document.activeElement?.textContent; const wasButton = document.activeElement?.tagName === "BUTTON" && parent.contains(document.activeElement);
      const openDetails = new Set([...parent.querySelectorAll("details[open]")].map((item) => item.querySelector("summary").textContent));
      parent.replaceChildren(); parent.append(el("div", "breadcrumb", "策略研究 / " + strategy.name));
      const title = el("div", "title-row"); title.append(el("h2", "", strategy.name), badge(strategy)); parent.append(title, el("p", "thesis", strategy.thesis));
      const gate = strategy.governance;
      const experimental = gate?.authorizationType === "EXPERIMENTAL_EXCEPTION";
      const approval = ({ AUTO: "自动审批", MANUAL: "人工逐笔审批", UNKNOWN: "审批状态读取失败" })[data.approval?.mode] || "审批状态未读取";
      const verdict = el("section", "verdict");
      verdict.append(el("strong", "", (strategy.active ? "当前配置策略 · " : "研究资格 · ") + (gate?.allowed ? experimental ? "实验性例外授权生效 · 研究未通过" : "证据门禁已通过" : "未获新增实盘资格")),
        el("p", "", "运行模式：" + (data.mode || "未读取") + " · " + approval + "（不等于研究合格）。新增买入仍须通过门禁；持仓退出与止损不受此门禁限制。"));
      if (gate?.reasons?.length) verdict.append(el("p", "note", "门禁原因：" + gate.reasons.join(" / ")));
      if (gate?.approvedBy) verdict.append(el("p", "note", (experimental ? "实验性例外授权（研究未通过）" : "独立复核：" + gate.reviewedBy) + " · 授权：" + gate.approvedBy + " · 到期（UTC）：" + gate.expiresAt));
      if (experimental) verdict.append(el("p", "note", "仅豁免研究晋级条件，不豁免执行风控；不自动续期。单笔 ≤ " + number(gate.limits?.maxTradeUsdt) + " USDT · 最多 " + number(gate.limits?.maxOpenPositions, 0) + " 仓 · 已实现日净亏损达 " + number(gate.limits?.dailyLossLimitUsdt) + " USDT 后停止新增买入（不保证总亏损封顶）。"));
      parent.append(verdict);
      const tabs = el("nav", "section-tabs"); tabs.setAttribute("aria-label", "研究档案章节");
      for (const [id, label] of [["overview", "研究概览"], ["performance", "表现与风险"], ["rules", "规则与来源"]]) { const item = button(label, "", () => { section = id; renderDossier(); }); item.setAttribute("aria-pressed", String(id === section)); tabs.append(item); } parent.append(tabs);
      ({ overview: renderOverview, performance: renderPerformance, rules: renderRules })[section](parent, strategy);
      for (const detail of parent.querySelectorAll("details")) detail.open = openDetails.has(detail.querySelector("summary").textContent);
      if (wasButton) [...parent.querySelectorAll("button")].find((item) => item.textContent === focus)?.focus({ preventScroll: true });
    }
    async function refresh() {
      if (busy) return; busy = true; document.getElementById("refreshButton").disabled = true;
      const status = document.getElementById("readStatus");
      try {
        const response = await fetch("/api/strategy-research", { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请重新登录" : "研究数据读取失败");
        const next = await response.json(); const payload = JSON.stringify({ ...next, generatedAt: null });
        if (payload !== lastPayload) {
          const first = !data; data = next;
          if (!selected()) selectedId = data.activeStrategyId || data.strategies[0].id;
          if (first) evidence = defaultEvidence(selected());
          const scroll = document.getElementById("strategyComparison").scrollTop;
          renderDirectory(); renderDossier(); document.getElementById("strategyComparison").scrollTop = scroll; lastPayload = payload;
        }
        status.className = ""; status.textContent = "已读取 " + new Date(next.generatedAt).toLocaleTimeString("zh-CN", { hour12: false }) + " · 报告日期以各来源为准";
        if (data.control.status === "ERROR") status.textContent += " · 当前策略配置读取失败";
      } catch (error) { status.className = "error"; status.textContent = error.message + (data ? "；当前保留上次成功读取的数据。" : "，可点击刷新重试。"); }
      finally { busy = false; document.getElementById("refreshButton").disabled = false; }
    }
    document.getElementById("strategySearch").addEventListener("input", () => data && renderDirectory());
    document.getElementById("stageFilter").addEventListener("change", () => data && renderDirectory());
    document.getElementById("refreshButton").addEventListener("click", refresh);
    document.getElementById("directoryToggle").addEventListener("click", () => { const open = document.getElementById("directoryBody").classList.toggle("open"); document.getElementById("directoryToggle").setAttribute("aria-expanded", String(open)); });
    window.addEventListener("hashchange", () => { if (data?.strategies.some((strategy) => strategy.id === location.hash.slice(1))) selectStrategy(location.hash.slice(1)); });
    refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  </script>
</body>
</html>`;
}
