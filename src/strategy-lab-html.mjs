export function strategyLabHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>策略 · Agentic Wallet</title>
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
        radial-gradient(circle at 12% -8%, rgba(120,169,255,.12), transparent 32rem),
        radial-gradient(circle at 92% 18%, rgba(81,214,163,.08), transparent 34rem), var(--bg);
    }
    button, a { font: inherit; }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
    header {
      position: sticky; top: 0; z-index: 5; border-bottom: 1px solid rgba(255,255,255,.07);
      background: rgba(8,10,14,.82); backdrop-filter: blur(18px);
    }
    .nav { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .brand, .nav-actions, .current-strategy { display: flex; align-items: center; gap: 11px; }
    .brand { font-weight: 750; }
    .nav-actions { justify-content: flex-end; }
    .current-strategy { color: var(--muted); font-size: 12px; }
    .current-strategy strong { color: var(--green); font-size: 13px; }
    .mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 11px; background: var(--blue); color: #08101e; font-weight: 900; }
    .back-link { padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; color: var(--text); background: var(--panel-2); text-decoration: none; transition: background-color .2s, border-color .2s; }
    .back-link:hover { border-color: rgba(120,169,255,.65); background: rgba(120,169,255,.12); }
    .back-link:focus-visible, .strategy-switch:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    main { padding: 18px 0 44px; }
    main section + section { margin-top: 18px; }
    .section-head { margin-bottom: 8px; }
    h2 { margin: 0; font-size: 18px; letter-spacing: -.03em; }
    .panel { border: 1px solid var(--line); border-radius: 17px; background: rgba(17,21,28,.88); }
    .return-panel { padding: 12px 14px; }
    .return-row { display: grid; grid-template-columns: 160px minmax(180px, 1fr) 100px; gap: 14px; align-items: center; min-height: 36px; border-bottom: 1px solid rgba(255,255,255,.055); }
    .return-row:last-child { border-bottom: 0; }
    .return-name { font-weight: 720; }
    .return-value { text-align: right; font: 700 13px ui-monospace, SFMono-Regular, monospace; }
    .bar-area { position: relative; height: 8px; border-radius: 999px; background: #202733; overflow: hidden; }
    .bar-area::after { content: ""; position: absolute; inset: 0 auto 0 50%; width: 1px; background: #607087; }
    .return-bar { position: absolute; top: 0; bottom: 0; min-width: 0; }
    .return-bar.positive { left: 50%; background: var(--green); }
    .return-bar.negative { right: 50%; background: var(--red); }
    .strategy-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .strategy-card { display: flex; flex-direction: column; min-width: 0; padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: rgba(17,21,28,.9); }
    .strategy-card.active { border-color: rgba(81,214,163,.55); box-shadow: inset 0 0 0 1px rgba(81,214,163,.1); }
    .strategy-title { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    .strategy-title h3 { margin: 0; font-size: 20px; letter-spacing: -.035em; }
    .badge { display: inline-flex; align-items: center; padding: 6px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font: 700 10px ui-monospace, SFMono-Regular, monospace; white-space: nowrap; }
    .badge.green { color: var(--green); border-color: rgba(81,214,163,.35); }
    .badge.blue { color: var(--blue); border-color: rgba(120,169,255,.35); }
    .badge.gold { color: var(--gold); border-color: rgba(245,193,79,.35); }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
    .metric { min-width: 0; padding: 10px; border-radius: 10px; background: rgba(8,10,14,.55); }
    .label { color: var(--muted); font-size: 10px; letter-spacing: .09em; text-transform: uppercase; }
    .metric strong { display: block; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; font: 700 14px ui-monospace, SFMono-Regular, monospace; }
    .facts { display: grid; gap: 7px; margin-bottom: 12px; }
    .fact { display: grid; grid-template-columns: 66px 1fr; gap: 10px; font-size: 12px; line-height: 1.5; }
    .fact span:last-child { color: #bdc5d0; }
    .strategy-switch { width: 100%; margin-top: auto; padding: 11px 12px; border: 1px solid var(--blue); border-radius: 10px; color: #d8e5ff; background: rgba(120,169,255,.08); cursor: pointer; font-weight: 750; transition: background-color .2s, border-color .2s; }
    .strategy-switch:hover:not(:disabled) { border-color: rgba(120,169,255,.75); background: rgba(120,169,255,.17); }
    .strategy-switch:disabled { border-color: var(--line); color: var(--muted); cursor: not-allowed; opacity: .72; }
    .status { min-height: 20px; margin-top: 12px; color: var(--gold); font-size: 12px; }
    .error { color: var(--red); }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
    @media (max-width: 820px) {
      .strategy-grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 560px) {
      main { padding-top: 14px; }
      .nav { align-items: flex-start; flex-direction: column; padding: 12px 0; }
      .nav-actions { width: 100%; flex-wrap: wrap; justify-content: space-between; }
      .back-link { width: 100%; text-align: center; }
      .return-row { grid-template-columns: 1fr 76px; padding: 9px 0; }
      .bar-area { grid-column: 1 / -1; grid-row: 2; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <div class="brand"><span class="mark">S</span><span>策略</span></div>
      <div class="nav-actions">
        <span class="current-strategy"><span>当前</span><strong id="activeStrategy">读取中</strong></span>
        <span class="badge blue" id="mode">—</span>
        <a class="back-link" href="/">仪表盘</a>
      </div>
    </div>
  </header>
  <main class="shell">
    <section>
      <div class="section-head"><h2>收益</h2></div>
      <div class="panel return-panel" id="returnComparison"></div>
    </section>

    <section>
      <div class="section-head"><h2>策略</h2></div>
      <div class="strategy-grid" id="strategyComparison"></div>
      <div class="status" id="status" aria-live="polite"></div>
    </section>
  </main>
  <script>
    const money = (value) => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pct = (value) => value == null ? "待验证" : Number(value).toFixed(1) + "%";
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    let latestSnapshot = null;
    let switchingStrategyId = null;

    function renderReturns(strategies) {
      const root = document.getElementById("returnComparison");
      root.replaceChildren();
      const maxAbsPnl = Math.max(1, ...strategies.map((strategy) => Math.abs(strategy.performance.realizedPnlUsdt)));
      strategies.forEach((strategy) => {
        const pnl = strategy.performance.realizedPnlUsdt;
        const row = el("div", "return-row");
        const area = el("div", "bar-area");
        const bar = el("div", "return-bar " + (pnl < 0 ? "negative" : "positive"));
        bar.style.width = Math.abs(pnl) / maxAbsPnl * 50 + "%";
        area.append(bar);
        row.append(
          el("div", "return-name", strategy.name),
          area,
          el("div", "return-value " + (pnl < 0 ? "error" : ""), (pnl >= 0 ? "+" : "") + money(pnl) + " U")
        );
        root.append(row);
      });
    }

    function renderStrategies(data) {
      const strategies = Array.isArray(data.strategies) ? data.strategies : [];
      const root = document.getElementById("strategyComparison");
      root.replaceChildren();
      const active = strategies.find((strategy) => strategy.active);
      document.getElementById("activeStrategy").textContent = active?.name || data.strategy.activeStrategyId;
      document.getElementById("mode").textContent = data.mode.toUpperCase();
      strategies.forEach((strategy) => {
        const card = el("article", "strategy-card" + (strategy.active ? " active" : ""));
        const title = el("div", "strategy-title");
        title.append(
          el("h3", "", strategy.name),
          el("span", "badge " + (strategy.active ? "green" : strategy.switchable ? "blue" : "gold"), strategy.active ? "运行中" : strategy.status)
        );
        card.append(title);
        const metrics = el("div", "metrics");
        [
          ["累计收益", (strategy.performance.realizedPnlUsdt >= 0 ? "+" : "") + money(strategy.performance.realizedPnlUsdt) + " U"],
          ["胜率", pct(strategy.performance.winRatePct)],
          ["交易数", String(strategy.performance.trades)],
          ["最大回撤", money(strategy.performance.maxDrawdownUsdt) + " U"]
        ].forEach(([label, value]) => {
          const metric = el("div", "metric");
          metric.append(el("span", "label", label), el("strong", "", value));
          metrics.append(metric);
        });
        card.append(metrics);
        const facts = el("div", "facts");
        [
          ["入场", strategy.entry],
          ["退出", strategy.exit]
        ].forEach(([label, value]) => {
          const fact = el("div", "fact");
          fact.append(el("span", "label", label), el("span", "", value));
          facts.append(fact);
        });
        card.append(facts);
        const button = el("button", "strategy-switch", strategy.active ? "当前" : strategy.switchable ? "切换" : "不可切换");
        button.type = "button";
        button.disabled = strategy.active || !strategy.switchable || switchingStrategyId != null;
        button.addEventListener("click", () => switchStrategy(strategy.id));
        card.append(button);
        root.append(card);
      });
      renderReturns(strategies);
    }

    async function switchStrategy(strategyId) {
      switchingStrategyId = strategyId;
      document.getElementById("status").textContent = "切换中…";
      renderStrategies(latestSnapshot);
      try {
        const response = await fetch("/api/strategy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ strategyId })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "HTTP " + response.status);
        await refresh();
        const status = document.getElementById("status");
        status.className = "status";
        status.textContent = "已切换";
      } catch (error) {
        const status = document.getElementById("status");
        status.className = "status error";
        status.textContent = "切换失败：" + error.message;
      } finally {
        switchingStrategyId = null;
        if (latestSnapshot) renderStrategies(latestSnapshot);
      }
    }

    async function refresh() {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        latestSnapshot = await response.json();
        renderStrategies(latestSnapshot);
      } catch (error) {
        const status = document.getElementById("status");
        status.className = "status error";
        status.textContent = "数据读取失败：" + error.message;
      }
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}
