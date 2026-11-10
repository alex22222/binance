// Serialized into the nonce-protected overview. The only POST saves a draft;
// wallet switching and refresh never call a trading or wallet-login endpoint.
export function agenticWalletClient() {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? "—").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const number = value => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: value > 0 && value < 0.01 ? 0 : 2, maximumFractionDigits: value > 0 && value < 0.01 ? 10 : 2 }) : "—";
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未核实";
  const metric = (label, value, note) => `<div class="wallet-metric"><span>${escape(label)}</span><strong>${escape(value)}</strong><small>${escape(note)}</small></div>`;
  const fresh = (value, age) => value && Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) <= age && Date.parse(value) <= Date.now() + 60000;
  let selected = new URL(location.href).searchParams.get("wallet") === "okx" ? "okx" : "binance";
  let data = null, snapshot = null, snapshotFailed = false, loading = false, saving = false;
  const pending = {};

  async function request(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20000), ...options });
    if (response.status === 401) { location.assign("/login"); throw new Error("登录已过期"); }
    if (!response.ok) throw new Error(response.status === 409 ? "记录已被其他页面修改，请刷新后重新选择。" : "请求未完成，请稍后重试。");
    return response.json();
  }

  function renderAssets(wallet) {
    const root = $("walletAssets");
    $("assetScope").textContent = "仅含本钱包已保存的资产记录；不包含 OKX 交易所账户，不跨钱包合计。";
    if (wallet.assetsStatus === "ERROR") { root.innerHTML = '<div class="wallet-empty warning">资产来源读取失败，不能判断余额或空仓。</div>'; return; }
    if (!wallet.accounts.length) { root.innerHTML = '<div class="wallet-empty">尚未接入该钱包的资产明细。<a href="/assets">在个人资产中配置只读同步</a>；未接入不表示余额为零。</div>'; return; }
    root.innerHTML = wallet.accounts.map(account => `<article class="wallet-account"><div class="wallet-account-head"><div><h3>${escape(account.name)}</h3><p>${account.confirmed ? "已确认账户" : "待确认 · 不计入小计"} · ${account.basis === "holdings" ? "持仓口径" : account.basis === "total" ? "账户汇总口径" : "口径未核实"}</p></div><div class="wallet-subtotal"><small>账本已定价小计 · 非实时余额</small><strong>${account.subtotals.length ? account.subtotals.map(row => `${escape(row.currency)} ${number(row.amount)}`).join("<br>") : "—"}</strong></div></div>
      ${account.rows.length ? `<div class="wallet-table-wrap"><table><thead><tr><th>资产</th><th>参考市值 / 金额</th><th>数据日期</th><th>统计口径</th></tr></thead><tbody>${account.rows.map(row => `<tr><td><strong>${escape(row.name)}</strong><small>${({ api: "只读 API 入账", manual: "手工记录", csv: "CSV 导入", screenshot: "截图记录" })[row.source] || "来源未核实"}</small></td><td class="wallet-numeric">${number(row.amount)} ${escape(row.currency)}</td><td>${escape(row.asOf)}<small class="${row.historical || row.future ? "warning" : ""}">${row.future ? "未来日期 · 不采用" : row.historical ? "历史记录 · 非当前余额" : row.timeBasis === "imported" ? "导入日期 · 精确时点未知" : row.timeBasis === "statement" ? "来源日期 · 非实时" : "精确时点未核实"}</small></td><td>${row.counted ? "计入账本小计" : "参考 · 不重复相加"}</td></tr>`).join("")}</tbody></table></div>` : '<p class="wallet-empty">没有已定价明细，不能据此判断空仓。</p>'}
      ${account.unpriced.length ? `<div class="wallet-unpriced"><h4>未估值资产 · 保留数量，不记为零</h4>${account.unpriced.map(row => `<div><strong>${escape(row.name || row.symbol)}</strong><span>${escape(row.quantity)} ${escape(row.symbol)}</span><small>链 ${escape(row.chain)} · ${escape(row.contract || "native")}<br>${escape(row.reason)}</small></div>`).join("")}</div>` : ""}</article>`).join("");
  }

  function renderRuntime(wallet) {
    $("runtimeLink").href = selected === "binance" ? "/dashboard?view=execution" : "/agentic-wallet/okx";
    $("runtimeLink").textContent = selected === "binance" ? "币安执行详情 ↗" : "OKX 来源详情 ↗";
    if (selected === "binance") {
      const current = snapshot && !snapshotFailed && fresh(snapshot.health?.updatedAt, 300000);
      const activeId = snapshot?.strategy?.activeStrategyId;
      $("actualStrategy").textContent = activeId ? wallet.strategies.find(row => row.id === activeId)?.name || activeId : "未读取到策略配置";
      $("actualStrategyNote").textContent = `${current ? "源配置" : "未核实 / 历史配置"} · 不代表当前获准买入；选择待启用策略不会改变它。`;
      const balance = snapshot?.walletBalance;
      const balanceFresh = !snapshotFailed && fresh(balance?.checkedAt, 300000) && !(balance?.lastCheckFailedAt && Date.parse(balance.lastCheckFailedAt) >= Date.parse(balance.checkedAt));
      const cashFresh = !snapshotFailed && fresh(balance?.availableUsdtCheckedAt, 300000) && !balance?.availableUsdtStale;
      $("walletMetrics").innerHTML = metric("钱包估值", balanceFresh && balance?.totalUsd != null ? "$" + number(balance.totalUsd) : "未核实", "仅币安来源 · 不与资产账本相加")
        + metric("可用 USDT", cashFresh ? number(balance?.availableUsdt) : "未核实", "BSC · 原可用余额口径")
        + metric("执行器状态", current ? ({ RUNNING: "运行中", HALTED: "已停止", DEGRADED: "来源异常", AUTH_REQUIRED: "待登录", STALE: "心跳过期", WAITING: "等待心跳" })[snapshot.health.status] || "未核实" : "未核实", "心跳 " + time(snapshot?.health?.updatedAt));
      $("runtimeStatus").textContent = snapshotFailed ? "币安状态读取失败；资产账本仍可独立查看。" : "运行状态、策略配置与真实成交是不同证据。审批、停机等原有控制保留在币安执行详情。";
      $("runtimeStatus").className = snapshotFailed || !current ? "warning" : "muted";
      $("positionsTitle").textContent = "币安策略持仓";
      $("walletPositions").innerHTML = !current ? '<p class="wallet-empty">持仓时点未核实，请查看执行详情。</p>' : !Array.isArray(snapshot.positions) ? '<p class="wallet-empty">持仓列表缺失，不能判断空仓。</p>' : !snapshot.positions.length ? '<p class="wallet-empty">来源快照中没有策略持仓；这不代表钱包没有其他资产。</p>' : `<div class="position-list">${snapshot.positions.map(position => `<div><strong>${escape(position.symbol)}</strong><span>数量 ${escape(position.quantity ?? position.tokenAmount)}</span><small>${escape(wallet.strategies.find(row => row.id === position.strategyId)?.name || position.strategyId || "归属未核实")}</small></div>`).join("")}</div>`;
    } else {
      const status = data.okxStatus, source = status?.snapshot;
      const current = status?.components?.executor?.status === "FRESH" && fresh(source?.executor?.asOf, 180000) && fresh(source?.exportedAt, 900000);
      $("actualStrategy").textContent = source ? "OKX 回调二波 · 独立来源" : "尚无运行来源";
      $("actualStrategyNote").textContent = "尚未证明此独立策略与下方资产账户相同；不是已选钱包的实盘绑定。";
      $("walletMetrics").innerHTML = metric("钱包资产", wallet.accounts.length ? wallet.accounts.length + " 个账本账户" : "未接入", "只读来源 · 非交易所余额")
        + metric("策略源配置", current ? source.executor.policyEnabled === true ? "源开关开启" : source.executor.policyEnabled === false ? "源开关关闭" : "未核实" : "未核实", "配置不代表真实执行")
        + metric("最近源采样", time(source?.executor?.asOf), current ? "原始采样时间 · 北京时间" : "来源缺失或已陈旧");
      $("runtimeStatus").textContent = current ? "该来源仅提供脱敏运行状态，不提供钱包登录、签名或交易权限。" : "来源未核实或已陈旧。重新读取页面不会更新源心跳，也不会启动 OKX 策略。";
      $("runtimeStatus").className = current ? "muted" : "warning";
      $("positionsTitle").textContent = "OKX 策略账本";
      const ledgerCurrent = fresh(source?.ledger?.asOf, 900000) && fresh(source?.exportedAt, 900000) && status?.components?.ledger?.status === "FRESH";
      $("walletPositions").innerHTML = `<p class="wallet-empty">${ledgerCurrent && Number.isSafeInteger(source.ledger.openPositionCount) ? "独立来源记录 " + source.ledger.openPositionCount + " 个未关闭策略持仓。" : "未取得近期可核实的策略持仓记录。"}不包含钱包全部资产；订单、成交及退出回执请在来源详情中核对。</p>`;
    }
  }

  function render() {
    for (const id of ["binance", "okx"]) {
      $("wallet-" + id).setAttribute("aria-pressed", String(selected === id));
      $("wallet-" + id).classList.toggle("selected", selected === id);
    }
    $("selectedWalletName").textContent = selected === "binance" ? "Binance Agentic Wallet" : "OKX Agentic Wallet";
    $("runtimeLink").href = selected === "binance" ? "/dashboard?view=execution" : "/agentic-wallet/okx";
    $("runtimeLink").textContent = selected === "binance" ? "币安执行详情 ↗" : "OKX 来源详情 ↗";
    if (!data) return;
    const wallet = data.wallets.find(row => row.id === selected);
    if (!wallet) return;
    $("selectedWalletName").textContent = wallet.name;
    $("walletDataTime").textContent = wallet.sync.failed ? "最近同步失败 · 保留原资产记录，未置零" : "最近入账 " + time(wallet.sync.appliedAt) + " · 北京时间（不是实时余额时间）";
    $("walletDataTime").className = wallet.sync.failed ? "warning" : "muted";
    renderAssets(wallet);
    renderRuntime(wallet);
    const saved = data.preferences?.drafts?.[selected];
    const chosen = pending[selected] ?? saved?.strategyId ?? "";
    $("strategyChoice").innerHTML = '<option value="">请选择待启用策略</option>' + wallet.strategies.map(row => `<option value="${escape(row.id)}">${escape(row.name)} · ${escape(row.stage)}</option>`).join("");
    $("strategyChoice").value = wallet.strategies.some(row => row.id === chosen) ? chosen : "";
    $("strategyChoice").disabled = saving;
    $("saveStrategy").disabled = saving || loading || !data.preferences || !$("strategyChoice").value || $("strategyChoice").value === saved?.strategyId;
    $("savedStrategy").textContent = saved ? (wallet.strategies.find(row => row.id === saved.strategyId)?.name || "已存方案") + " · " + time(saved.savedAt) : data.preferences ? "尚未保存待启用策略" : "待启用方案读取失败，暂不能保存";
    const strategy = wallet.strategies.find(row => row.id === $("strategyChoice").value);
    $("strategyThesis").textContent = strategy?.thesis || "先选择策略以查看方案；研究或 Shadow 策略不是已批准的实盘策略。";
  }

  async function refresh() {
    if (loading || saving) return;
    loading = true; $("walletRefresh").disabled = true; $("saveStrategy").disabled = true;
    const selectedAtStart = selected;
    try {
      const overview = request("/api/agentic-wallets").then(value => {
        // A read already in flight must not roll back a just-saved revision.
        if (data?.preferences && value.preferences && data.preferences.revision > value.preferences.revision) value.preferences = data.preferences;
        data = value; $("loadStatus").textContent = ""; render();
      });
      const runtime = selectedAtStart === "binance" ? request("/api/snapshot").then(value => { snapshot = value; snapshotFailed = false; }).catch(() => { snapshotFailed = true; }) : Promise.resolve();
      const results = await Promise.allSettled([overview, runtime]);
      if (results[0].status === "rejected") {
        data = null; $("walletAssets").innerHTML = '<div class="wallet-empty warning">来源读取失败，当前资产未核实。请重新读取。</div>';
        $("walletMetrics").replaceChildren(); $("walletPositions").replaceChildren(); $("actualStrategy").textContent = "当前未核实";
        $("actualStrategyNote").textContent = "运行来源未读取成功。"; $("walletDataTime").textContent = "来源读取失败";
        $("savedStrategy").textContent = "待启用方案未读取成功，暂不能保存。";
        $("runtimeStatus").textContent = "来源读取失败，不据此判断运行状态。";
        $("strategyChoice").disabled = true; $("saveStrategy").disabled = true;
        $("loadStatus").textContent = "读取失败；未将失败解释为零余额或无持仓。";
      }
      render();
    } finally { loading = false; $("walletRefresh").disabled = false; render(); }
  }

  for (const id of ["binance", "okx"]) $("wallet-" + id).addEventListener("click", () => {
    if (saving) return;
    selected = id;
    const url = new URL(location.href); url.searchParams.set("wallet", id); history.replaceState(null, "", url);
    $("saveStatus").textContent = "";
    render(); refresh();
  });
  $("strategyChoice").addEventListener("change", event => { pending[selected] = event.target.value; $("saveStatus").textContent = ""; render(); });
  $("saveStrategy").addEventListener("click", async () => {
    if (loading || saving || !data?.preferences) return;
    const walletId = selected, strategyId = $("strategyChoice").value;
    if (!data.wallets.find(row => row.id === walletId)?.strategies.some(row => row.id === strategyId)) return;
    saving = true; render();
    try {
      data.preferences = await request("/api/agentic-wallets/preferences", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId, strategyId, revision: data.preferences.revision }) });
      delete pending[walletId];
      $("saveStatus").textContent = "已保存待启用方案。运行策略、风控和授权均未改变。";
    } catch (error) { $("saveStatus").textContent = error.message; }
    finally { saving = false; render(); }
  });
  $("walletRefresh").addEventListener("click", refresh);
  render(); refresh();
  setInterval(() => { if (!document.hidden && !saving) refresh(); }, 60000);
}
