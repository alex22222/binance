import { strategyById } from "./strategy-lab.mjs";
import { ledgerEntries, ledgerTrades } from "./trade-ledger.mjs";

// The review page (/reviews): account, open positions, the active strategy's
// latest decision, completed trades, and execution problems for one period,
// built from the trade ledger and saved state only (no wallet or market calls).

const DAY = 86_400_000;
export const REVIEW_PERIODS = Object.freeze({
  "7d": { label: "近 7 天", days: 7 },
  "30d": { label: "近 30 天", days: 30 },
  all: { label: "全部", days: null }
});
const EXIT_REASONS = {
  INITIAL_STOP: "初始止损", INITIAL_STOP_SAME_SESSION: "初始止损", TRAILING_STOP: "移动止损",
  TAKE_PROFIT: "止盈", TAKE_PROFIT_2R: "2R 止盈", WEEKLY_REBALANCE: "周度换仓", WEEKLY_TO_CASH: "周度转现金",
  DISASTER_STOP: "灾难止损", EMERGENCY_STOP: "紧急停止"
};
const WEEKLY_STRATEGIES = new Set(["weekly-etf-dual-momentum-defense", "weekly-etf-momentum-rsi-rotation"]);

const finite = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const round = (value, places = 2) => (value === null ? null : Number(value.toFixed(places)));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const strategyName = (id) => (id ? strategyById(id)?.name || id : "未标注策略");
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

function strategySummaries(trades) {
  const groups = new Map();
  for (const trade of trades) {
    const list = groups.get(trade.strategyId) || [];
    list.push(trade);
    groups.set(trade.strategyId, list);
  }
  return [...groups].map(([strategyId, list]) => {
    const pnl = list.map(({ realizedPnlUsdt }) => realizedPnlUsdt ?? 0);
    const wins = pnl.filter((value) => value > 0);
    const losses = pnl.filter((value) => value <= 0);
    const exitReasons = {};
    for (const { exitReasonLabel } of list) exitReasons[exitReasonLabel] = (exitReasons[exitReasonLabel] || 0) + 1;
    return {
      strategyId,
      name: strategyName(strategyId),
      trades: list.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: round((wins.length / list.length) * 100, 1),
      realizedPnlUsdt: round(sum(pnl)),
      profitFactor: losses.length && sum(losses) < 0 ? round(sum(wins) / -sum(losses)) : null,
      averageWinUsdt: wins.length ? round(sum(wins) / wins.length) : null,
      averageLossUsdt: losses.length ? round(sum(losses) / losses.length) : null,
      from: list[0].exitAt,
      to: list.at(-1).exitAt,
      exitReasons
    };
  }).sort((left, right) => right.trades - left.trades);
}

function equityView(points, wallet, fromDate) {
  const series = [...points]
    .filter((point) => typeof point.date === "string" && finite(point.totalUsd) !== null)
    .map(({ date, totalUsd }) => ({ date, totalUsd: Number(totalUsd) }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const current = finite(wallet?.totalUsd);
  if (current !== null && wallet.checkedAt) {
    const today = wallet.checkedAt.slice(0, 10);
    if (!series.length || series.at(-1).date < today) series.push({ date: today, totalUsd: current });
    else if (series.at(-1).date === today) series[series.length - 1] = { date: today, totalUsd: current };
  }
  if (!series.length) return null;
  const baseIndex = fromDate ? series.findLastIndex(({ date }) => date <= fromDate) : 0;
  const window = series.slice(Math.max(0, baseIndex));
  let peak = window[0].totalUsd;
  let maxDrawdownPct = 0;
  for (const { totalUsd } of window) {
    peak = Math.max(peak, totalUsd);
    maxDrawdownPct = Math.max(maxDrawdownPct, (1 - totalUsd / peak) * 100);
  }
  const start = window[0];
  const end = window.at(-1);
  return {
    start, end,
    changeUsd: round(end.totalUsd - start.totalUsd),
    changePct: round((end.totalUsd / start.totalUsd - 1) * 100),
    maxDrawdownPct: round(maxDrawdownPct),
    sinceStart: { date: series[0].date, changePct: round((end.totalUsd / series[0].totalUsd - 1) * 100) },
    availableUsdt: round(finite(wallet?.availableUsdt)),
    checkedAt: wallet?.checkedAt || null,
    series: window.map(({ date, totalUsd }) => ({ date, totalUsd: round(totalUsd) }))
  };
}

function positionView(position, nowMs, disasterStopLossPct) {
  const cost = finite(position.costBasisUsdt);
  const value = finite(position.lastQuoteProceedsUsdt);
  const valued = cost !== null && cost > 0 && value !== null;
  const weekly = WEEKLY_STRATEGIES.has(position.strategyId);
  const exitRule = weekly
    ? `每周第一个交易日开盘后重新评估：目标换成别的 ETF 就换仓，转为现金就卖出；跌幅超过 ${disasterStopLossPct ?? "?"}% 时灾难止损。`
    : [
      finite(position.initialRiskPct) !== null ? `初始止损 -${round(Number(position.initialRiskPct))}%` : null,
      finite(position.trailingStopPct) !== null ? `移动止损 ${round(Number(position.trailingStopPct))}%` : null,
      finite(position.finalTakeProfitPct) !== null ? `止盈 +${round(Number(position.finalTakeProfitPct))}%` : null
    ].filter(Boolean).join(" · ") || "未记录退出规则";
  return {
    symbol: position.symbol,
    strategyId: position.strategyId || null,
    strategyName: strategyName(position.strategyId),
    openedAt: position.openedAt || null,
    daysHeld: position.openedAt ? Math.floor((nowMs - Date.parse(position.openedAt)) / DAY) : null,
    costBasisUsdt: round(cost),
    valueUsdt: valued ? round(value) : null,
    unrealizedPnlUsdt: valued ? round(value - cost) : null,
    returnPct: valued ? round((value / cost - 1) * 100) : null,
    peakReturnPct: round(finite(position.peakReturnPct)),
    worstReturnPct: round(finite(position.worstReturnPct)),
    markedAt: position.lastQuoteAt || null,
    exitRule
  };
}

function decisionView(live, records) {
  const history = records
    .filter((record) => record.event === "weekly_etf_live_decision" && record.status === "succeeded")
    .map(({ timestamp, details }) => ({
      week: details.week, signalDate: details.signalDate || null, target: details.target || null,
      candidateCount: finite(details.candidateCount), defensiveEligible: details.defensiveEligible ?? null, decidedAt: timestamp
    }))
    .reverse();
  if (!live?.decision) return history.length ? { latest: null, history, nextEvaluation: shiftDate(history[0].week, 7) } : null;
  const { decision } = live;
  const asset = (item) => ({ ticker: item.ticker, momentumPct: round(finite(item.momentumPct)), rsi: round(finite(item.rsi), 1), eligible: Boolean(item.eligible) });
  return {
    latest: {
      strategyId: live.strategyId,
      strategyName: strategyName(live.strategyId),
      week: live.week,
      evaluatedAt: live.evaluatedAt || null,
      signalDate: decision.signalDate || null,
      target: decision.target || null,
      absoluteMomentumRequired: Boolean(decision.absoluteMomentumRequired),
      assets: (decision.allRiskAssets || []).map(asset).sort((left, right) => (right.momentumPct ?? -Infinity) - (left.momentumPct ?? -Infinity)),
      defensive: decision.defensiveAsset ? asset(decision.defensiveAsset) : null
    },
    history,
    nextEvaluation: live.week ? shiftDate(live.week, 7) : null
  };
}

function executionView(ledger, fromIso) {
  const inPeriod = (timestamp) => !fromIso || timestamp >= fromIso;
  const records = ledger.records.filter(({ timestamp }) => inPeriod(timestamp));
  const submitted = new Map(ledger.records
    .filter((record) => ["buy_submission", "sell_submission"].includes(record.event) && record.details.orderId)
    .map((record) => [record.details.orderId, record.details.symbol]));
  const gas = sum(records.filter((record) => record.event === "pending_order" && record.status === "finished")
    .map(({ details }) => finite(details.side === "BUY" ? details.gasUsdt : details.exitGasUsdt) ?? 0));
  const count = (event, status) => records.filter((record) => record.event === event && record.status === status).length;
  const incidents = [
    ...records.filter((record) => record.event === "pending_order" && record.status === "failed")
      .map(({ timestamp, details }) => ({ at: timestamp, kind: "订单失败", symbol: details.symbol || submitted.get(details.orderId) || null, detail: `${details.side === "SELL" ? "卖出" : "买入"}订单 ${details.orderId || ""} 未成交`.trim() })),
    ...records.filter((record) => record.event === "order_submission" && record.status === "ambiguous")
      .map(({ timestamp, details }) => ({ at: timestamp, kind: "下单结果不明", symbol: details.symbol || null, detail: String(details.error || "").slice(0, 160) })),
    ...records.filter((record) => record.event === "order_recovery" && record.status === "halted")
      .map(({ timestamp, details }) => ({ at: timestamp, kind: "订单恢复中止", symbol: details.symbol || null, detail: details.reason || "" })),
    ...Object.values(ledger.halted).filter(({ lastAt }) => inPeriod(lastAt))
      .map(({ firstAt, lastAt, count: retries, reason }) => ({ at: firstAt, kind: "订单核对卡住", symbol: null, detail: `${reason || "未知原因"}，到 ${lastAt.slice(0, 16).replace("T", " ")} UTC 共重试 ${retries} 次` })),
    ...Object.entries(ledger.monitoring)
      .filter(([key, value]) => key.endsWith("|OTHER") && inPeriod(value.lastAt))
      .map(([key, value]) => ({ at: value.firstAt, kind: "持仓估值失败", symbol: key.split("|")[1], detail: `${value.error || ""}（当天 ${value.count} 次）` }))
  ].sort((left, right) => right.at.localeCompare(left.at));
  const closedMarket = Object.entries(ledger.monitoring).filter(([key, value]) => key.endsWith("|NO_LIQUIDITY") && inPeriod(value.lastAt));
  return {
    gasUsdt: round(gas, 3),
    fills: count("pending_order", "finished"),
    autoApproved: count("trade_approval", "auto_approved"),
    approved: count("trade_approval", "approved"),
    autoApprovalChanges: records.filter((record) => record.event === "auto_approval")
      .map(({ timestamp, status }) => ({ at: timestamp, enabled: status === "enabled" })),
    incidents,
    closedMarketQuotes: sum(closedMarket.map(([, value]) => value.count)),
    closedMarketDays: new Set(closedMarket.map(([key]) => key.split("|")[0])).size
  };
}

const signed = (value, digits = 2) => (value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`);

function findings({ period, account, positions, decision, trades, summaries, allSummaries, execution }) {
  const items = [];
  if (account) {
    items.push({
      tone: account.changeUsd > 0 ? "good" : account.changeUsd < 0 ? "bad" : "neutral",
      text: `账户净值 ${account.end.totalUsd.toFixed(2)} U。${period.days ? `${period.label}变化` : `自 ${account.start.date} 起`} ${signed(account.changeUsd)} U（${signed(account.changePct)}%），期间最大回撤 ${account.maxDrawdownPct.toFixed(2)}%${period.days ? `；自 ${account.sinceStart.date} 起累计 ${signed(account.sinceStart.changePct)}%` : ""}。`
    });
  }
  for (const position of positions) {
    items.push({
      tone: (position.unrealizedPnlUsdt ?? 0) >= 0 ? "good" : "bad",
      text: `${position.symbol}（${position.strategyName}）已持有 ${position.daysHeld ?? "?"} 天，浮动 ${signed(position.unrealizedPnlUsdt)} U（${signed(position.returnPct)}%），持有期间最高 ${signed(position.peakReturnPct)}%、最低 ${signed(position.worstReturnPct)}%。`
    });
  }
  if (!positions.length) items.push({ tone: "neutral", text: "目前没有持仓。" });
  const latest = decision?.latest;
  if (latest) {
    const leader = latest.assets.find(({ eligible }) => eligible) || latest.assets[0];
    const holding = positions.some(({ symbol }) => symbol === latest.target);
    items.push({
      tone: "neutral",
      text: latest.target === "CASH"
        ? `${latest.week} 这周的信号是转为现金：所有 ETF 都没有通过绝对动量要求。`
        : `${latest.week} 这周的信号是 ${latest.target}${leader ? `：在 ${latest.assets.length} 只 ETF 里动量最高（${signed(leader.momentumPct, 1)}%，RSI ${leader.rsi ?? "—"}）` : ""}，${holding ? "继续持有" : "需要换仓"}。下次评估约在 ${decision.nextEvaluation}（周一）美股开盘后。`
    });
  }
  const describe = (summary, prefix) => {
    const [reason, times] = Object.entries(summary.exitReasons).sort((left, right) => right[1] - left[1])[0] || [];
    return {
      tone: summary.realizedPnlUsdt >= 0 ? "good" : "bad",
      text: `${prefix}${summary.name}在 ${summary.from.slice(0, 10)} 至 ${summary.to.slice(0, 10)} 完成 ${summary.trades} 笔，已实现 ${signed(summary.realizedPnlUsdt)} U，胜率 ${summary.winRatePct}%，盈利因子 ${summary.profitFactor ?? "—"}${reason ? `，${times} 笔以${reason}结束` : ""}。`
    };
  };
  if (!trades.length) items.push({ tone: "neutral", text: `${period.label}没有完成的交易。` });
  for (const summary of summaries) items.push(describe(summary, period.days ? `${period.label}，` : "全部记录里，"));
  if (period.days) {
    for (const summary of allSummaries.filter((item) => !summaries.some(({ strategyId }) => strategyId === item.strategyId))) items.push(describe(summary, "更早的记录里，"));
  }
  const kinds = new Map();
  for (const { kind } of execution.incidents) kinds.set(kind, (kinds.get(kind) || 0) + 1);
  const quiet = execution.closedMarketQuotes ? `另有 ${execution.closedMarketQuotes} 次持仓估值失败发生在美股休市时（代币没有流动性），属于正常情况。` : "";
  const scope = period.days ? period.label : "全部记录里";
  items.push(execution.incidents.length
    ? { tone: "bad", text: `${scope}的执行问题：${[...kinds].map(([kind, times]) => `${kind} ${times} 次`).join("、")}，明细见「执行与运行」。${quiet}` }
    : { tone: "good", text: `${scope}没有执行故障。${quiet}` });
  return items;
}

export function buildReviewOverview({ ledger, botState = {}, walletHistory = [], premarket = null, disasterStopLossPct = null, nowMs = Date.now(), period = "30d" }) {
  const selected = REVIEW_PERIODS[period] ? period : "30d";
  const { label, days } = REVIEW_PERIODS[selected];
  const fromIso = days ? new Date(nowMs - days * DAY).toISOString() : null;
  const allTrades = ledgerTrades(ledger.records).map((trade) => ({
    ...trade,
    strategyName: strategyName(trade.strategyId),
    exitReasonLabel: EXIT_REASONS[trade.exitReason] || trade.exitReason || "未记录"
  }));
  const trades = allTrades.filter(({ exitAt }) => !fromIso || exitAt >= fromIso);
  const account = equityView(Array.isArray(walletHistory) ? walletHistory : [], botState.walletBalance, fromIso?.slice(0, 10));
  const positions = (botState.positions || []).map((position) => positionView(position, nowMs, disasterStopLossPct));
  const decision = decisionView(botState.weeklyEtfLive, ledger.records);
  const summaries = strategySummaries(trades);
  const allSummaries = strategySummaries(allTrades);
  const execution = executionView(ledger, fromIso);
  const entries = ledgerEntries(ledger.records).filter(({ timestamp }) => !fromIso || timestamp >= fromIso)
    .map((entry) => ({ ...entry, strategyName: strategyName(entry.strategyId) }));
  const periodInfo = { id: selected, label, days, from: fromIso, to: new Date(nowMs).toISOString() };
  return {
    generatedAt: new Date(nowMs).toISOString(),
    period: periodInfo,
    ledger: { from: ledger.firstAt, to: ledger.lastAt, updatedAt: ledger.updatedAt },
    findings: findings({ period: periodInfo, account, positions, decision, trades, summaries, allSummaries, execution }),
    account,
    positions,
    decision,
    trades: [...trades].reverse(),
    entries: [...entries].reverse(),
    strategies: { period: summaries, all: allSummaries },
    execution,
    premarket: premarket && premarket.status === "AVAILABLE" ? {
      tradingDate: premarket.tradingDate,
      generatedAt: premarket.generatedAt,
      level: premarket.advice?.level || null,
      summary: premarket.advice?.summary || null,
      benchmarkAveragePct: round(finite(premarket.market?.benchmarkAveragePct)),
      breadthPositivePct: round(finite(premarket.market?.breadthPositivePct), 1),
      vixChangePct: round(finite(premarket.market?.vixChangePct)),
      errors: Array.isArray(premarket.errors) ? premarket.errors.length : 0
    } : null
  };
}
