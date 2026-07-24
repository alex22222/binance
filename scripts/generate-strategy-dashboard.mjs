import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(projectRoot, "artifacts", "strategy-mock-dashboard.html");

async function loadLatestMock() {
  const mockDirectory = resolve(projectRoot, "state", "mock-trades");
  const files = (await readdir(mockDirectory)).filter((file) => file.endsWith(".json"));
  const records = await Promise.all(files.map(async (file) => (
    JSON.parse(await readFile(resolve(mockDirectory, file), "utf8"))
  )));
  const successful = records
    .filter((record) => record.mode === "mock" && record.notificationSent === true)
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  if (!successful.length) throw new Error("No successful mock result found");
  return successful[0];
}

async function loadTimeline(runId) {
  const content = await readFile(resolve(projectRoot, "state", "action-trace.jsonl"), "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.runId === runId)
    .sort((left, right) => left.sequence - right.sequence);
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function buildDashboard({ config, mock, timeline, generatedAt }) {
  const payload = safeJson({ config, mock, timeline, generatedAt });
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Agentic Strategy Lab · 策略与 Mock 审计</title>
  <style>
    :root {
      --bg: #07090d;
      --panel: #10141b;
      --panel-2: #151b24;
      --line: #27303d;
      --text: #f5f7fa;
      --muted: #8f9aaa;
      --gold: #f6c453;
      --green: #55d6a8;
      --red: #ff6b74;
      --blue: #73a7ff;
      --radius: 18px;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--text);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 12% -8%, rgba(246, 196, 83, .12), transparent 28rem),
        radial-gradient(circle at 90% 20%, rgba(115, 167, 255, .09), transparent 30rem),
        var(--bg);
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .25;
      background-image:
        linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px);
      background-size: 40px 40px;
      mask-image: linear-gradient(to bottom, black, transparent 80%);
    }
    a { color: inherit; }
    button { font: inherit; }
    .shell { width: min(1180px, calc(100% - 36px)); margin: 0 auto; }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(18px);
      background: rgba(7, 9, 13, .76);
      border-bottom: 1px solid rgba(255,255,255,.07);
    }
    .nav {
      min-height: 70px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 720; letter-spacing: -.02em; }
    .mark {
      width: 34px; height: 34px; border-radius: 11px;
      display: grid; place-items: center;
      color: #161006; background: var(--gold); font-size: 15px; font-weight: 900;
      box-shadow: 0 0 30px rgba(246,196,83,.25);
    }
    .nav-links { display: flex; gap: 8px; }
    .nav-links a {
      text-decoration: none; color: var(--muted); padding: 9px 12px;
      border-radius: 10px; font-size: 14px;
    }
    .nav-links a:hover { color: var(--text); background: rgba(255,255,255,.05); }
    .mode {
      display: inline-flex; align-items: center; gap: 8px;
      color: var(--gold); border: 1px solid rgba(246,196,83,.28);
      background: rgba(246,196,83,.07); border-radius: 999px;
      padding: 7px 11px; font: 700 12px ui-monospace, SFMono-Regular, monospace;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 12px currentColor; }
    main { position: relative; z-index: 1; }
    .hero {
      display: grid;
      grid-template-columns: 1.3fr .7fr;
      gap: 28px;
      padding: 78px 0 38px;
      align-items: end;
    }
    .eyebrow { color: var(--gold); font: 700 12px ui-monospace, SFMono-Regular, monospace; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 14px 0 18px; font-size: clamp(42px, 7vw, 78px); line-height: .98; letter-spacing: -.065em; max-width: 850px; }
    .lead { max-width: 720px; margin: 0; color: #aab3c0; font-size: 18px; line-height: 1.7; }
    .hero-card {
      padding: 24px; border: 1px solid var(--line); border-radius: var(--radius);
      background: linear-gradient(145deg, rgba(85,214,168,.12), rgba(16,20,27,.92) 48%);
      box-shadow: 0 24px 70px rgba(0,0,0,.28);
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .1em; }
    .pnl { margin: 12px 0 2px; color: var(--green); font-size: 46px; font-weight: 760; letter-spacing: -.055em; }
    .subvalue { color: #b9c2ce; font-size: 14px; }
    .hero-card .divider { height: 1px; background: var(--line); margin: 22px 0; }
    .mini-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .mini strong { display: block; margin-top: 5px; font-size: 16px; }
    .status-line { display: flex; align-items: center; gap: 8px; color: var(--green); font-size: 13px; margin-top: 20px; }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 12px 0 86px; }
    .metric {
      padding: 19px; border: 1px solid var(--line); border-radius: 15px;
      background: rgba(16,20,27,.76);
    }
    .metric strong { display: block; margin-top: 9px; font-size: 24px; letter-spacing: -.035em; }
    section { padding: 0 0 92px; }
    .section-head { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin-bottom: 24px; }
    h2 { margin: 8px 0 0; font-size: clamp(29px, 4vw, 44px); letter-spacing: -.045em; }
    .section-copy { color: var(--muted); max-width: 470px; line-height: 1.65; }
    .panel { border: 1px solid var(--line); border-radius: var(--radius); background: rgba(16,20,27,.86); overflow: hidden; }
    .universe { display: flex; flex-wrap: wrap; gap: 9px; padding: 22px; border-bottom: 1px solid var(--line); }
    .ticker {
      padding: 8px 11px; border-radius: 9px; background: var(--panel-2);
      border: 1px solid #303a49; font: 700 13px ui-monospace, SFMono-Regular, monospace;
    }
    .gates { display: grid; grid-template-columns: repeat(5, 1fr); }
    .gate { min-height: 190px; padding: 21px; border-right: 1px solid var(--line); }
    .gate:last-child { border-right: 0; }
    .gate-num { color: var(--gold); font: 700 12px ui-monospace, SFMono-Regular, monospace; }
    .gate h3 { margin: 34px 0 9px; font-size: 17px; letter-spacing: -.02em; }
    .gate p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .exit-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 12px; }
    .exit-card { position: relative; padding: 24px; min-height: 150px; border: 1px solid var(--line); border-radius: 15px; background: var(--panel); }
    .exit-card strong { display: block; margin-top: 18px; font-size: 31px; letter-spacing: -.045em; }
    .exit-card.stop strong { color: var(--red); }
    .exit-card.take strong { color: var(--green); }
    .flow {
      display: grid; grid-template-columns: 1fr auto 1fr auto 1fr;
      align-items: center; gap: 14px; padding: 27px;
      border-bottom: 1px solid var(--line);
    }
    .flow-node { padding: 19px; border-radius: 14px; background: var(--panel-2); border: 1px solid #303a49; }
    .flow-node strong { display: block; font-size: 24px; margin-top: 7px; letter-spacing: -.035em; }
    .arrow { color: var(--gold); font-size: 24px; }
    .safety-row { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--line); }
    .safety { padding: 18px 22px; border-right: 1px solid var(--line); }
    .safety:last-child { border-right: 0; }
    .safety strong { display: block; margin-top: 7px; color: var(--green); }
    .timeline-tools { display: flex; align-items: center; justify-content: space-between; padding: 20px 22px; gap: 14px; }
    .filters { display: flex; gap: 7px; flex-wrap: wrap; }
    .filter {
      color: var(--muted); background: transparent; border: 1px solid var(--line);
      padding: 8px 11px; border-radius: 9px; cursor: pointer;
    }
    .filter.active, .filter:hover { color: var(--text); background: #202734; }
    .run-id { color: var(--muted); font: 12px ui-monospace, SFMono-Regular, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .timeline { padding: 0 22px 24px; }
    .event {
      display: grid; grid-template-columns: 50px 16px minmax(0,1fr) auto;
      gap: 14px; min-height: 74px; align-items: start;
    }
    .event-time { padding-top: 4px; color: #747f8e; font: 12px ui-monospace, SFMono-Regular, monospace; }
    .rail { position: relative; height: 100%; display: flex; justify-content: center; }
    .rail::before { content: ""; position: absolute; top: 15px; bottom: -15px; width: 1px; background: var(--line); }
    .event:last-child .rail::before { display: none; }
    .rail-dot { position: relative; z-index: 1; width: 10px; height: 10px; margin-top: 5px; border: 2px solid var(--panel); border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 3px rgba(115,167,255,.12); }
    .event.trade .rail-dot { background: var(--gold); box-shadow: 0 0 0 3px rgba(246,196,83,.13); }
    .event.success .rail-dot { background: var(--green); box-shadow: 0 0 0 3px rgba(85,214,168,.13); }
    .event-main { padding-bottom: 23px; }
    .event-title { font-weight: 680; letter-spacing: -.01em; }
    .event-desc { margin-top: 6px; color: var(--muted); font-size: 13px; line-height: 1.5; word-break: break-word; }
    .event pre {
      display: none; overflow: auto; margin: 11px 0 0; padding: 13px;
      color: #b8c3d1; background: #080b10; border: 1px solid #202733;
      border-radius: 10px; font-size: 11px; line-height: 1.55;
    }
    .event.open pre { display: block; }
    .details {
      color: var(--muted); background: transparent; border: 0; cursor: pointer;
      padding: 3px 0 0 10px; font-size: 12px;
    }
    .details:hover { color: var(--text); }
    .notice {
      margin-top: 12px; padding: 20px 22px; display: flex; align-items: flex-start; gap: 13px;
      border: 1px solid rgba(246,196,83,.22); border-radius: 15px; background: rgba(246,196,83,.055);
      color: #d8c89d; line-height: 1.6; font-size: 14px;
    }
    footer { padding: 26px 0 44px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
    .footer-row { display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
    @media (max-width: 900px) {
      .hero { grid-template-columns: 1fr; padding-top: 54px; }
      .hero-card { max-width: 520px; }
      .metrics { grid-template-columns: 1fr 1fr; }
      .gates { grid-template-columns: 1fr 1fr; }
      .gate { border-bottom: 1px solid var(--line); }
      .flow { grid-template-columns: 1fr; }
      .arrow { transform: rotate(90deg); justify-self: center; }
    }
    @media (max-width: 640px) {
      .shell { width: min(100% - 24px, 1180px); }
      .nav-links { display: none; }
      .mode { padding: 6px 8px; }
      .hero { padding-top: 42px; }
      .lead { font-size: 16px; }
      .metrics, .exit-grid, .safety-row, .gates { grid-template-columns: 1fr; }
      .gate, .safety { border-right: 0; border-bottom: 1px solid var(--line); min-height: auto; }
      .gate h3 { margin-top: 17px; }
      .section-head { align-items: start; flex-direction: column; }
      .timeline-tools { align-items: start; flex-direction: column; }
      .event { grid-template-columns: 38px 14px minmax(0,1fr); }
      .event .details { grid-column: 3; justify-self: start; padding: 0 0 18px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <div class="brand"><span class="mark">A</span><span>Agentic Strategy Lab</span></div>
      <nav class="nav-links" aria-label="页面导航">
        <a href="#strategy">策略</a>
        <a href="#mock">Mock 过程</a>
      </nav>
      <span class="mode"><span class="dot"></span><span id="modeLabel">SHADOW</span></span>
    </div>
  </header>
  <main class="shell">
    <div class="hero">
      <div>
        <div class="eyebrow">Traceable by design · 每个动作可追溯</div>
        <h1>看懂每一次决策，而不是只看盈亏。</h1>
        <p class="lead">这是 Binance Agentic Stock Bot 的本地策略快照。页面把风险门、入场逻辑、退出条件和最新 Mock 往返交易放在同一条证据链中。</p>
      </div>
      <aside class="hero-card" aria-label="最新 Mock 结果">
        <div class="label">Latest mock · realized PnL</div>
        <div class="pnl" id="heroPnl">+$0.00</div>
        <div class="subvalue" id="heroReturn">+0.00% · TAKE_PROFIT</div>
        <div class="divider"></div>
        <div class="mini-grid">
          <div class="mini"><span class="label">投入</span><strong id="heroSpend">0 USDT</strong></div>
          <div class="mini"><span class="label">回收</span><strong id="heroProceeds">0 USDT</strong></div>
        </div>
        <div class="status-line"><span class="dot"></span>飞书送达 · 本地结果已保存</div>
      </aside>
    </div>
    <div class="metrics" id="metrics"></div>

    <section id="strategy">
      <div class="section-head">
        <div><div class="eyebrow">01 · Strategy system</div><h2>策略不是预测，是一组硬门槛</h2></div>
        <div class="section-copy">只有市场状态、15 分钟趋势、方向一致性、可执行成本和安全检查同时通过，才允许从候选池中选择最高排名标的。</div>
      </div>
      <div class="panel">
        <div class="universe" id="universe"></div>
        <div class="gates" id="gates"></div>
      </div>
      <div class="exit-grid" id="exitGrid"></div>
    </section>

    <section id="mock">
      <div class="section-head">
        <div><div class="eyebrow">02 · Mock audit trail</div><h2>一次完整往返，13 个可验证动作</h2></div>
        <div class="section-copy">Mock 使用合成价格验证状态机，不访问钱包、不签名、不广播。合约地址仍来自当次币安官方 BSC RWA 列表。</div>
      </div>
      <div class="panel">
        <div class="flow" id="flow"></div>
        <div class="safety-row" id="safety"></div>
        <div class="timeline-tools">
          <div class="filters" role="group" aria-label="时间线筛选">
            <button class="filter active" data-filter="all">全部</button>
            <button class="filter" data-filter="trade">交易决策</button>
            <button class="filter" data-filter="system">系统与通知</button>
          </div>
          <div class="run-id" id="runId"></div>
        </div>
        <div class="timeline" id="timeline"></div>
      </div>
      <div class="notice"><span>⚠</span><span>此页面展示的是 Mock 证据，不是链上成交证明。模拟盈利不代表真实收益；真实交易还会受到流动性、手续费、滑点、钱包策略和市场变化影响。</span></div>
    </section>
  </main>
  <footer>
    <div class="shell footer-row">
      <span>LOCAL SNAPSHOT · 不包含凭据、Session Token 或私钥</span>
      <span id="generatedAt"></span>
    </div>
  </footer>
  <script>
    const DATA = ${payload};
    const money = (value, digits = 2) => Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const time = (value) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
    const eventMap = {
      startup: ["启动 Mock 运行", "加载 Shadow 配置并声明零钱包访问"],
      mock_trade: ["Mock 状态机", "开始或完成本次模拟往返"],
      external_api_call: ["官方合约数据", "读取 Binance 官方 BSC RWA 列表"],
      buy_submission: ["模拟买入", "记录投入、合约、价格与数量"],
      position_change: ["持仓状态变化", "在 FLAT 与 LONG 之间更新模拟状态"],
      exit_decision: ["退出条件触发", "达到 TAKE_PROFIT，生成卖出决策"],
      sell_submission: ["模拟卖出", "记录回收金额与模拟订单"],
      feishu_notification: ["飞书通知", "发送本次 Mock 结果"],
      mock_result_saved: ["结果落盘", "保存独立 JSON 结果文件"]
    };
    const tradeEvents = new Set(["buy_submission", "position_change", "exit_decision", "sell_submission"]);

    document.getElementById("modeLabel").textContent = DATA.config.mode.toUpperCase();
    document.getElementById("heroPnl").textContent = "+$" + money(DATA.mock.realizedPnlUsdt);
    document.getElementById("heroReturn").textContent = "+" + money(DATA.mock.returnPct) + "% · " + DATA.mock.exitReason;
    document.getElementById("heroSpend").textContent = money(DATA.mock.amountUsdt) + " USDT";
    document.getElementById("heroProceeds").textContent = money(DATA.mock.proceedsUsdt) + " USDT";
    document.getElementById("runId").textContent = "RUN " + DATA.mock.runId;
    document.getElementById("generatedAt").textContent = "生成于 " + new Date(DATA.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

    const metrics = [
      ["单笔上限", money(DATA.config.maxTradeUsdt) + " USDT"],
      ["日亏损停止", "−" + money(DATA.config.dailyLossLimitUsdt) + " USDT"],
      ["最大持仓", DATA.config.maxOpenPositions + " 个"],
      ["入场周期", DATA.config.entryIntervalMinutes + " 分钟"]
    ];
    document.getElementById("metrics").innerHTML = metrics.map(([label, value]) =>
      '<div class="metric"><span class="label">' + label + '</span><strong>' + value + '</strong></div>'
    ).join("");
    document.getElementById("universe").innerHTML = DATA.config.symbols.map((symbol) => '<span class="ticker">' + symbol + '</span>').join("");

    const gates = [
      ["市场状态", "仅接受 openState=true 且 reasonCode=TRADING。"],
      ["15 分钟趋势", "闭合 1 分钟 K 线累计涨幅 ≥ " + DATA.config.minTrend15mPct + "%。"],
      ["方向一致性", "最近 15 次变化至少 " + DATA.config.minDirectionalMinutes + " 次上涨。"],
      ["可执行成本", "买入后立即卖回的报价成本 ≤ " + DATA.config.maxRoundTripCostPct + "%。"],
      ["安全与来源", "合约必须来自官方 BSC RWA 列表；审计不可用只走已确认窄例外。"]
    ];
    document.getElementById("gates").innerHTML = gates.map(([title, description], index) =>
      '<article class="gate"><span class="gate-num">GATE 0' + (index + 1) + '</span><h3>' + title + '</h3><p>' + description + '</p></article>'
    ).join("");

    const exits = [
      ["stop", "止损", "−" + DATA.config.stopLossPct + "%", "使用可执行卖出报价判断"],
      ["take", "止盈", "+" + DATA.config.takeProfitPct + "%", "达到阈值后提交退出"],
      ["", "再入冷却", DATA.config.reentryCooldownMinutes + " 分钟", "同一标的退出后重新过门"]
    ];
    document.getElementById("exitGrid").innerHTML = exits.map(([className, label, value, copy]) =>
      '<article class="exit-card ' + className + '"><span class="label">' + label + '</span><strong>' + value + '</strong><div class="subvalue">' + copy + '</div></article>'
    ).join("");

    document.getElementById("flow").innerHTML = [
      '<div class="flow-node"><span class="label">Start · USDT</span><strong>' + money(DATA.mock.amountUsdt) + '</strong></div>',
      '<div class="arrow">→</div>',
      '<div class="flow-node"><span class="label">Long · ' + DATA.mock.symbol + '</span><strong>' + DATA.mock.quantity + '</strong></div>',
      '<div class="arrow">→</div>',
      '<div class="flow-node"><span class="label">Exit · USDT</span><strong>' + money(DATA.mock.proceedsUsdt) + '</strong></div>'
    ].join("");
    document.getElementById("safety").innerHTML = [
      ["钱包访问", DATA.mock.walletAccess ? "是" : "否"],
      ["链上广播", DATA.mock.onchainBroadcast ? "是" : "否"],
      ["飞书通知", DATA.mock.notificationSent ? "成功" : "失败"]
    ].map(([label, value]) => '<div class="safety"><span class="label">' + label + '</span><strong>' + value + '</strong></div>').join("");

    function renderTimeline(filter = "all") {
      const records = DATA.timeline.filter((record) => {
        if (filter === "trade") return tradeEvents.has(record.event);
        if (filter === "system") return !tradeEvents.has(record.event);
        return true;
      });
      document.getElementById("timeline").innerHTML = records.map((record) => {
        const mapped = eventMap[record.event] || [record.event, "记录系统动作"];
        const category = tradeEvents.has(record.event) ? "trade" : (record.status === "succeeded" ? "success" : "system");
        const detail = JSON.stringify(record.details, null, 2);
        return '<article class="event ' + category + '">' +
          '<div class="event-time">' + time(record.timestamp) + '</div>' +
          '<div class="rail"><span class="rail-dot"></span></div>' +
          '<div class="event-main"><div class="event-title">' + String(record.sequence).padStart(2, "0") + ' · ' + mapped[0] + '</div>' +
          '<div class="event-desc">' + mapped[1] + ' · <span class="label">' + record.status + '</span></div>' +
          '<pre>' + detail.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") + '</pre></div>' +
          '<button class="details" aria-label="展开原始详情">详情</button></article>';
      }).join("");
      document.querySelectorAll(".details").forEach((button) => {
        button.addEventListener("click", () => {
          const event = button.closest(".event");
          event.classList.toggle("open");
          button.textContent = event.classList.contains("open") ? "收起" : "详情";
        });
      });
    }
    document.querySelectorAll(".filter").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        renderTimeline(button.dataset.filter);
      });
    });
    renderTimeline();
  </script>
</body>
</html>`;
}

async function main() {
  const config = JSON.parse(await readFile(resolve(projectRoot, "config.json"), "utf8"));
  const mock = await loadLatestMock();
  const timeline = await loadTimeline(mock.runId);
  const html = buildDashboard({
    config,
    mock,
    timeline,
    generatedAt: new Date().toISOString()
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  console.log(outputPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
