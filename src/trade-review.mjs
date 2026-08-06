import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newYorkDate } from "./strategy-data.mjs";

function finiteNumber(value, fallback = 0) {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function atomicJson(path, value) {
  return mkdir(dirname(path), { recursive: true }).then(async () => {
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  });
}

function shadowKey(id) {
  if (id === "shadow-trend-pullback-confirmation") return "pullback";
  if (id === "shadow-downtrend-veto") return "downtrend";
  if (id === "shadow-trend-quality") return "trendQuality";
  return id;
}

function summaryForTrades(trades) {
  const pnls = trades.map(({ realizedPnlUsdt }) => finiteNumber(realizedPnlUsdt));
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);
  const grossProfitUsdt = wins.reduce((sum, value) => sum + value, 0);
  const grossLossUsdt = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsdt = 0;
  for (const value of pnls) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? wins.length / trades.length * 100 : null,
    realizedPnlUsdt: pnls.reduce((sum, value) => sum + value, 0),
    grossPnlUsdt: trades.reduce((sum, trade) => sum + finiteNumber(trade.grossPnlUsdt), 0),
    gasCostUsdt: trades.reduce((sum, trade) => sum + finiteNumber(trade.gasCostUsdt), 0),
    grossProfitUsdt,
    grossLossUsdt,
    profitFactor: grossLossUsdt > 0 ? grossProfitUsdt / grossLossUsdt : null,
    averageWinUsdt: wins.length ? grossProfitUsdt / wins.length : null,
    averageLossUsdt: losses.length ? -grossLossUsdt / losses.length : null,
    payoffRatio: wins.length && losses.length
      ? (grossProfitUsdt / wins.length) / (grossLossUsdt / losses.length)
      : null,
    maxDrawdownUsdt,
    exitReasons: Object.fromEntries(Object.entries(
      trades.reduce((counts, { exitReason }) => {
        const reason = exitReason || "UNKNOWN";
        counts[reason] = (counts[reason] || 0) + 1;
        return counts;
      }, {})
    ).sort(([left], [right]) => left.localeCompare(right)))
  };
}

function regimeRelativePullbackCounterfactual(trades) {
  const vetoDecisions = new Set(["WOULD_WAIT", "WOULD_SKIP", "WOULD_BLOCK"]);
  const labeled = trades.filter(
    ({ entryShadow }) => entryShadow.regimeRelativePullback?.decision
  );
  const vetoed = labeled.filter(
    ({ entryShadow }) => vetoDecisions.has(entryShadow.regimeRelativePullback.decision)
  );
  const vetoedPnls = vetoed.map(({ realizedPnlUsdt }) => finiteNumber(realizedPnlUsdt));
  const avoidedLossUsdt = Math.abs(
    vetoedPnls.filter((value) => value < 0).reduce((sum, value) => sum + value, 0)
  );
  const missedProfitUsdt = vetoedPnls
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  return {
    strategyId: "regime-relative-pullback-momentum",
    evidence: "REAL_FILL_PNL_CONDITIONAL_ON_SHADOW_ENTRY_DECISION",
    labeledTrades: labeled.length,
    wouldEnterTrades: labeled.filter(
      ({ entryShadow }) => entryShadow.regimeRelativePullback.decision === "WOULD_ENTER"
    ).length,
    vetoedTrades: vetoed.length,
    insufficientDataTrades: labeled.filter(
      ({ entryShadow }) => entryShadow.regimeRelativePullback.decision === "INSUFFICIENT_DATA"
    ).length,
    avoidedLossUsdt,
    missedProfitUsdt,
    netPnlImprovementUsdt: avoidedLossUsdt - missedProfitUsdt
  };
}

function newYorkMinutes(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function reconstructTrades(records) {
  const shadowsByCycle = new Map();
  const marketRegimeByCycle = new Map();
  const submissions = new Map();
  const entries = [];
  const openBySymbol = new Map();
  const earlyExitBySymbol = new Map();
  const stopStateBySymbol = new Map();
  const trades = [];

  for (const record of records) {
    const details = record.details || {};
    if (record.event === "shadow_sub_strategy" && record.status === "observed") {
      const key = `${record.cycleId || ""}:${details.symbol || ""}`;
      const shadows = shadowsByCycle.get(key) || {};
      shadows[shadowKey(details.subStrategyId)] = {
        decision: details.decision,
        reason: details.reason,
        trendEfficiency: details.trendEfficiency ?? null,
        atr15Pct: details.atr15Pct ?? null,
        pullbackDepthPct: details.pullbackDepthPct ?? null
      };
      shadowsByCycle.set(key, shadows);
    }
    if (record.event === "shadow_market_regime" && record.status === "observed") {
      marketRegimeByCycle.set(record.cycleId || "", {
        decision: details.decision,
        reason: details.reason,
        benchmarkStates: details.benchmarkStates || null
      });
    }
    if (record.event === "buy_submission" && record.status === "submitted") {
      submissions.set(details.orderId, {
        symbol: details.symbol,
        strategyId: details.strategyId,
        submittedAt: record.timestamp,
        amountUsdt: finiteNumber(details.amountUsdt),
        allInCostPct: finiteNumber(details.allInCostPct, null),
        netEdgeProxyPct: finiteNumber(details.netEdgeProxyPct, null),
        initialRiskPct: finiteNumber(details.initialRiskPct, null),
        atr15Pct: finiteNumber(details.atr15Pct, null),
        entryShadow: {
          ...(shadowsByCycle.get(`${record.cycleId || ""}:${details.symbol || ""}`) || {}),
          marketRegime: marketRegimeByCycle.get(record.cycleId || "") || null,
          regimeRelativePullback: details.shadowRegimeRelativePullbackDecision ? {
            decision: details.shadowRegimeRelativePullbackDecision,
            reason: details.shadowRegimeRelativePullbackReason || null,
            relativeStrengthRank: finiteNumber(
              details.shadowRegimeRelativePullbackRank,
              null
            ),
            benchmarkRelativeReturn60mPct: finiteNumber(
              details.shadowRegimeRelativePullbackReturn60mPct,
              null
            ),
            benchmarkStates: details.shadowRegimeRelativePullbackBenchmarkStates || null
          } : null
        }
      });
    }
    if (
      record.event === "pending_order" &&
      record.status === "finished" &&
      details.side === "BUY"
    ) {
      const submission = submissions.get(details.orderId) || {
        symbol: details.symbol,
        strategyId: details.strategyId,
        submittedAt: null,
        entryShadow: {}
      };
      const entry = {
        ...submission,
        openedAt: record.timestamp,
        entryOrderId: details.orderId,
        entryGasUsdt: finiteNumber(details.gasUsdt, null)
      };
      openBySymbol.set(details.symbol, entry);
      entries.push(entry);
      earlyExitBySymbol.delete(details.symbol);
      stopStateBySymbol.set(details.symbol, {
        triggers: 0,
        cancelled: 0,
        stopAllowedAwaitingApproval: false,
        awaitingRevalidation: false
      });
    }
    if (
      record.event === "shadow_exit_counterfactual" &&
      record.status === "observed" &&
      openBySymbol.has(details.symbol) &&
      details.decision === "WOULD_EXIT" &&
      !earlyExitBySymbol.has(details.symbol)
    ) {
      earlyExitBySymbol.set(details.symbol, {
        decision: details.decision,
        reason: details.reason,
        observedAt: record.timestamp,
        returnPct: finiteNumber(details.returnPct, null),
        returnR: finiteNumber(details.returnR, null)
      });
    }
    if (
      record.event === "exit_decision" &&
      record.status === "allowed" &&
      details.reason === "stop_loss_override" &&
      openBySymbol.has(details.symbol)
    ) {
      const stop = stopStateBySymbol.get(details.symbol);
      stop.stopAllowedAwaitingApproval = true;
    }
    if (
      record.event === "trade_approval" &&
      record.status === "requested" &&
      details.side === "SELL" &&
      stopStateBySymbol.get(details.symbol)?.stopAllowedAwaitingApproval
    ) {
      const stop = stopStateBySymbol.get(details.symbol);
      stop.triggers += 1;
      stop.stopAllowedAwaitingApproval = false;
      stop.awaitingRevalidation = true;
    }
    if (
      record.event === "exit_decision" &&
      record.status === "skipped" &&
      ["dynamic_exit_not_triggered", "fresh_quote_no_longer_triggers_exit"].includes(details.reason) &&
      stopStateBySymbol.get(details.symbol)?.awaitingRevalidation
    ) {
      const stop = stopStateBySymbol.get(details.symbol);
      stop.cancelled += 1;
      stop.awaitingRevalidation = false;
    }
    if (
      record.event === "pending_order" &&
      record.status === "finished" &&
      details.side === "SELL"
    ) {
      const entry = openBySymbol.get(details.symbol) || {};
      const stop = stopStateBySymbol.get(details.symbol) || { triggers: 0, cancelled: 0 };
      trades.push({
        symbol: details.symbol,
        strategyId: details.strategyId || entry.strategyId || "unknown",
        openedAt: entry.openedAt || entry.submittedAt || null,
        completedAt: record.timestamp,
        holdingMinutes: entry.openedAt
          ? (Date.parse(record.timestamp) - Date.parse(entry.openedAt)) / 60_000
          : null,
        amountUsdt: entry.amountUsdt || null,
        allInCostPct: entry.allInCostPct ?? null,
        netEdgeProxyPct: entry.netEdgeProxyPct ?? null,
        initialRiskPct: entry.initialRiskPct ?? null,
        grossPnlUsdt: finiteNumber(details.grossPnlUsdt),
        gasCostUsdt: finiteNumber(details.gasCostUsdt),
        realizedPnlUsdt: finiteNumber(details.realizedPnlUsdt),
        exitReason: details.exitReason || "UNKNOWN",
        maePct: finiteNumber(details.maePct, null),
        mfePct: finiteNumber(details.mfePct, null),
        maeR: finiteNumber(details.maeR, null),
        mfeR: finiteNumber(details.mfeR, null),
        realizedR: finiteNumber(details.realizedR, null),
        stopTriggerCount: stop.triggers,
        stopRevalidationCancelledCount: stop.cancelled,
        entryShadow: entry.entryShadow || {},
        earlyExitShadow: earlyExitBySymbol.get(details.symbol) || null
      });
      openBySymbol.delete(details.symbol);
      earlyExitBySymbol.delete(details.symbol);
      stopStateBySymbol.delete(details.symbol);
    }
  }
  return { trades, entries };
}

function reviewFindings(
  dailyTrades,
  dailyEntries,
  openPositions,
  systemFailures,
  externalMarket,
  regimeRelativePullback
) {
  const findings = [];
  const cancelledStops = dailyTrades.reduce(
    (sum, trade) => sum + trade.stopRevalidationCancelledCount,
    0
  );
  const pullbackWarnings = dailyEntries.filter(({ entryShadow }) => (
    ["WOULD_WAIT", "WOULD_SKIP", "WOULD_BLOCK"].includes(entryShadow.pullback?.decision)
  )).length;
  const earlyExitWarnings = dailyTrades.filter(
    ({ earlyExitShadow }) => earlyExitShadow?.decision === "WOULD_EXIT"
  ).length;
  const lateEntries = dailyEntries.filter(
    ({ openedAt, submittedAt }) => newYorkMinutes(openedAt || submittedAt) >= 15 * 60
  ).length;
  const invalidOpen = openPositions.filter(({ lastSignalValid }) => lastSignalValid === false).length;
  if (externalMarket?.status === "AVAILABLE") {
    findings.push(
      `外部市场同向下跌占可观测亏损交易的 ${finiteNumber(externalMarket.lossDirectionAlignmentPct).toFixed(1)}%；` +
      `按分钟 beta 描述性估算，约解释 ${finiteNumber(externalMarket.marketAttributedLossSharePct).toFixed(1)}% 的标的跌幅。`
    );
  } else {
    findings.push("外部市场分钟数据不足，暂不对当日亏损作市场归因。");
  }
  if (cancelledStops) findings.push(`止损触发后有 ${cancelledStops} 次因重新报价不再满足条件而取消退出。`);
  if (pullbackWarnings) findings.push(`${pullbackWarnings} 笔入场未通过趋势回撤再确认 Shadow。`);
  if (earlyExitWarnings) findings.push(`${earlyExitWarnings} 笔已平仓交易触发早期失败退出 Shadow。`);
  if (regimeRelativePullback.vetoedTrades) {
    findings.push(
      `相对强度回撤 Shadow 否决 ${regimeRelativePullback.vetoedTrades} 笔真实入场；` +
      `回溯避免亏损 ${regimeRelativePullback.avoidedLossUsdt.toFixed(4)} USDT，` +
      `错过盈利 ${regimeRelativePullback.missedProfitUsdt.toFixed(4)} USDT。`
    );
  }
  if (lateEntries) findings.push(`${lateEntries} 笔入场发生在美东 15:00 以后，需关注隔夜暴露。`);
  if (invalidOpen) findings.push(`收盘后仍有 ${invalidOpen} 个信号已失效的开放仓位。`);
  if (systemFailures.length) findings.push(`交易日记录到 ${systemFailures.length} 个系统失败事件，需区分报价流动性与运行故障。`);
  if (!findings.length) findings.push("未发现预设的止损重验证、追涨、晚盘入场或运行异常警报。");
  return findings;
}

export function buildTradingReview({
  records,
  state,
  tradingDate,
  generatedAt = new Date().toISOString(),
  sessionDates = [tradingDate],
  externalMarket = null,
  premarketBrief = null
}) {
  const ordered = [...records].sort((left, right) => (
    Date.parse(left.timestamp) - Date.parse(right.timestamp)
  ));
  const reconstructed = reconstructTrades(ordered);
  const dailyTrades = reconstructed.trades.filter(
    ({ completedAt }) => newYorkDate(Date.parse(completedAt)) === tradingDate
  );
  const dailyEntries = reconstructed.entries.filter(
    ({ openedAt }) => newYorkDate(Date.parse(openedAt)) === tradingDate
  );
  const failures = ordered.filter((record) => (
    record.status === "failed" &&
    newYorkDate(Date.parse(record.timestamp)) === tradingDate
  ));
  const openPositions = (state.positions || (state.position ? [state.position] : [])).map((position) => ({
    symbol: position.symbol,
    strategyId: position.strategyId || "unknown",
    openedAt: position.openedAt || null,
    costBasisUsdt: finiteNumber(position.costBasisUsdt),
    lastQuoteProceedsUsdt: finiteNumber(position.lastQuoteProceedsUsdt, null),
    grossUnrealizedPnlUsdt: position.lastQuoteProceedsUsdt == null
      ? null
      : finiteNumber(position.lastQuoteProceedsUsdt) - finiteNumber(position.costBasisUsdt),
    peakReturnPct: finiteNumber(position.peakReturnPct, null),
    worstReturnPct: finiteNumber(position.worstReturnPct, null),
    lastSignalValid: position.lastSignalValid ?? null,
    lastQuoteAt: position.lastQuoteAt || null
  }));
  const periods = [5, 20].map((sessions) => {
    const dates = sessionDates.slice(-sessions);
    const trades = reconstructed.trades.filter(
      ({ completedAt }) => dates.includes(newYorkDate(Date.parse(completedAt)))
    );
    return {
      sessions,
      startDate: dates[0] || tradingDate,
      endDate: dates.at(-1) || tradingDate,
      ...summaryForTrades(trades)
    };
  });
  const regimeRelativePullback = regimeRelativePullbackCounterfactual(dailyTrades);
  return {
    schemaVersion: 3,
    generatedAt,
    tradingDate,
    sources: {
      fills: "action-trace pending_order finished SELL",
      openPositions: "bot-state snapshot",
      shadow: "non-executing action-trace observations"
    },
    daily: {
      entries: dailyEntries.length,
      ...summaryForTrades(dailyTrades)
    },
    periods,
    trades: dailyTrades,
    shadowCounterfactuals: {
      regimeRelativePullbackMomentum: regimeRelativePullback
    },
    openPositions,
    systemFailures: {
      count: failures.length,
      events: failures.slice(0, 50).map((record) => ({
        timestamp: record.timestamp,
        event: record.event,
        symbol: record.details?.symbol || null,
        operation: record.details?.operation || null,
        error: record.details?.error || null
      }))
    },
    externalMarket: externalMarket || {
      status: "INSUFFICIENT_DATA",
      observedTrades: 0,
      totalTrades: dailyTrades.length,
      trades: [],
      errors: ["External market attribution was not collected."]
    },
    premarketBrief,
    findings: reviewFindings(
      dailyTrades,
      dailyEntries,
      openPositions,
      failures,
      externalMarket,
      regimeRelativePullback
    ),
    limitations: [
      "Realized performance includes only terminal SELL fills; Shadow observations are not counted as trades.",
      "Open-position values use the latest stored executable quote and are not realized PnL.",
      "Counterfactual observations are quote-based and do not prove fillable savings.",
      "Periodic statistics cover action-trace history currently retained by the system."
    ]
  };
}

export function shouldGenerateTradingReview({
  currentNewYorkDate,
  tradingDate,
  archiveExists
}) {
  return currentNewYorkDate === tradingDate || !archiveExists;
}

export async function writeTradingReviewArchive(directory, report) {
  const dailyDirectory = join(directory, "daily");
  await atomicJson(join(dailyDirectory, `${report.tradingDate}.json`), report);
  await atomicJson(join(directory, "latest.json"), report);
  const files = (await readdir(dailyDirectory))
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .sort()
    .reverse();
  const reports = await Promise.all(files.map(async (file) => {
    const archived = JSON.parse(await readFile(join(dailyDirectory, file), "utf8"));
    return {
      tradingDate: archived.tradingDate,
      generatedAt: archived.generatedAt,
      trades: archived.daily.trades,
      realizedPnlUsdt: archived.daily.realizedPnlUsdt,
      winRatePct: archived.daily.winRatePct,
      openPositions: archived.openPositions.length
    };
  }));
  await atomicJson(join(directory, "index.json"), {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    reports
  });
  return report;
}
