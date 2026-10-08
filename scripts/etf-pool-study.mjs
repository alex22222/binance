// Isolated research engine. Not imported by Bot, not a Paper or wallet runner.
import { weeklyPaperWeek } from "../src/weekly-etf-rotation-paper.mjs";

const DAY = 86400000;
const period = (date, frequency) => frequency === "W" ? weeklyPaperWeek(date) : date.slice(0, 7);

export function spliceDefensive(actual, proxy) {
  const first = actual[0];
  const overlap = proxy.find(row => row.date === first?.date);
  if (!first || !overlap) throw new Error("Defensive proxy requires same-day overlap");
  const scale = first.close / overlap.close;
  return [...proxy.filter(row => row.date < first.date).map(row => ({
    ...row, open: row.open * scale, close: row.close * scale, source: "BIL_PROXY"
  })), ...actual.map(row => ({ ...row, source: "SGOV" }))];
}

function rsi(values, length) {
  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (i <= length) { gain += Math.max(change, 0) / length; loss += Math.max(-change, 0) / length; }
    else { gain = (gain * (length - 1) + Math.max(change, 0)) / length; loss = (loss * (length - 1) + Math.max(-change, 0)) / length; }
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

export function studySignal(rows, index, risk, momentumDays, rsiPeriod = 14) {
  if (index <= Math.max(momentumDays, rsiPeriod)) throw new Error("Insufficient real history");
  // Match the production fetch window relative to the execution date, not today's partial bar.
  const cutoff = Date.parse(rows[index].date) - 179 * DAY;
  const history = rows.slice(0, index).filter(row => Date.parse(row.date) >= cutoff);
  if (history.length <= rsiPeriod) throw new Error("Insufficient RSI history");
  const momentum = ticker => rows[index - 1].prices[ticker].close / rows[index - momentumDays - 1].prices[ticker].close - 1;
  const allRiskAssets = risk.map(ticker => ({ ticker, momentum: momentum(ticker),
    rsi: rsi(history.map(row => row.prices[ticker].close), rsiPeriod) }));
  const candidates = allRiskAssets.filter(row => row.momentum > 0 && row.rsi >= 40)
    .sort((a, b) => b.momentum - a.momentum || a.ticker.localeCompare(b.ticker));
  const defensiveMomentum = momentum("SGOV");
  return { target: candidates[0]?.ticker || (defensiveMomentum > 0 ? "SGOV" : "CASH"),
    signalDate: rows[index - 1].date, allRiskAssets, defensiveMomentum };
}

export function runStudy({ rows, risk, momentumDays = 20, rsiPeriod = 14, frequency = "W",
  startDate, endDate = rows.at(-1)?.date, roundTripCostPct = 0.35, gasPerSideUsd = 0,
  initialCapitalUsd = 50, maxTicketUsd = Infinity, disasterPct = 8, buyHold = null }) {
  if (!["W", "M"].includes(frequency) || !Number.isInteger(momentumDays) || momentumDays < 1 ||
      !Number.isInteger(rsiPeriod) || rsiPeriod < 1 || !Number.isFinite(roundTripCostPct) ||
      roundTripCostPct < 0 || roundTripCostPct >= 100 || !Number.isFinite(gasPerSideUsd) || gasPerSideUsd < 0 ||
      !Number.isFinite(initialCapitalUsd) || initialCapitalUsd <= 0 || !(maxTicketUsd > 0) ||
      (disasterPct != null && (!Number.isFinite(disasterPct) || disasterPct <= 0 || disasterPct >= 100))) throw new Error("Invalid study configuration");
  if (!risk?.length || risk.includes("SGOV") || new Set(risk).size !== risk.length) throw new Error("Invalid risk universe");
  const tickers = [...risk, "SGOV"];
  if (buyHold && !tickers.includes(buyHold)) throw new Error("Unknown benchmark");
  if (rows.some((row, index) => !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      (index && row.date <= rows[index - 1].date) || tickers.some(ticker =>
        ![row.prices[ticker]?.open, row.prices[ticker]?.close].every(value => Number.isFinite(value) && value > 0)))) throw new Error("Invalid daily rows");
  const rate = roundTripCostPct / 200;
  const trades = [], decisions = [], equityCurve = [];
  let cash = initialCapitalUsd, holding = null, units = 0, entryBudget = 0;
  let pendingExit = null, blockedPeriod = null, rebalanceCount = 0, stopCount = 0;
  let peak = initialCapitalUsd, maxDrawdown = 0;
  const sell = (row, reason, signalDate) => {
    const price = row.prices[holding].open;
    const notionalUsd = units * price, spreadCostUsd = notionalUsd * rate;
    const costUsd = spreadCostUsd + gasPerSideUsd;
    if (notionalUsd <= costUsd) throw new Error("Insufficient proceeds for costs");
    cash += notionalUsd - costUsd;
    trades.push({ date: row.date, signalDate, side: "SELL", ticker: holding, price, quantity: units,
      notionalUsd, spreadCostUsd, gasUsd: gasPerSideUsd, costUsd, cashAfterUsd: cash, reason });
    holding = null; units = 0;
  };
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (row.date < startDate || row.date > endDate) continue;
    const currentPeriod = period(row.date, frequency);
    if (pendingExit) {
      sell(row, "CLOSE_TRIGGER_NEXT_OPEN_STOP_PROXY", pendingExit.signalDate);
      pendingExit = null; blockedPeriod = currentPeriod; stopCount++;
    }
    const decisionDue = buyHold ? !equityCurve.length
      : currentPeriod !== period(rows[index - 1].date, frequency) && currentPeriod !== blockedPeriod;
    if (decisionDue) {
      const decision = buyHold ? { target: buyHold, signalDate: null } : studySignal(rows, index, risk, momentumDays, rsiPeriod);
      decisions.push({ date: row.date, ...decision });
      if (decision.target !== (holding || "CASH")) {
        if (holding) { sell(row, "REBALANCE", decision.signalDate); rebalanceCount++; }
        if (decision.target !== "CASH") {
          const budget = Math.min(cash, maxTicketUsd), spreadCostUsd = budget * rate;
          const costUsd = spreadCostUsd + gasPerSideUsd;
          if (budget <= costUsd) throw new Error("Insufficient capital for costs");
          const price = row.prices[decision.target].open;
          units = (budget - costUsd) / price; cash -= budget; entryBudget = budget; holding = decision.target;
          trades.push({ date: row.date, signalDate: decision.signalDate, side: "BUY", ticker: holding,
            price, quantity: units, notionalUsd: budget, spreadCostUsd, gasUsd: gasPerSideUsd,
            costUsd, cashAfterUsd: cash, reason: "REBALANCE" });
        }
      }
    }
    const markPrice = holding ? row.prices[holding].close : 0;
    const equityUsd = cash + units * markPrice;
    peak = Math.max(peak, equityUsd); maxDrawdown = Math.max(maxDrawdown, (peak - equityUsd) / peak);
    equityCurve.push({ date: row.date, equityUsd, cashUsd: cash, units, markPrice, holding: holding || "CASH" });
    // An exit is only queued at this close. Never use tomorrow's price in today's ledger.
    // Applies to defensive assets too. Still a daily proxy, not executable intraday quotes.
    if (!buyHold && holding && disasterPct != null &&
        (units * markPrice * (1 - rate) - gasPerSideUsd) / entryBudget - 1 <= -disasterPct / 100) {
      pendingExit = { signalDate: row.date, ticker: holding };
    }
  }
  if (equityCurve.length < 2) throw new Error("Insufficient evaluation range");
  const years = (Date.parse(equityCurve.at(-1).date) - Date.parse(equityCurve[0].date)) / (365.2425 * DAY);
  let previous = initialCapitalUsd;
  const daily = equityCurve.map(row => { const value = row.equityUsd / previous - 1; previous = row.equityUsd; return value; });
  const mean = daily.reduce((sum, value) => sum + value, 0) / daily.length;
  const deviation = Math.sqrt(daily.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (daily.length - 1));
  return { evidenceLevel: "HISTORICAL_PROXY", automaticTradingEligible: false, trades, decisions, equityCurve, pendingExit,
    metrics: { startDate: equityCurve[0].date, endDate: equityCurve.at(-1).date, initialCapitalUsd,
      endingEquityUsd: previous, cagrPct: ((previous / initialCapitalUsd) ** (1 / years) - 1) * 100,
      maxDrawdownPct: maxDrawdown * 100, sharpeZeroRf: deviation ? mean / deviation * Math.sqrt(252) : null,
      totalCostUsd: trades.reduce((sum, trade) => sum + trade.costUsd, 0),
      buyOrders: trades.filter(trade => trade.side === "BUY").length,
      sellOrders: trades.filter(trade => trade.side === "SELL").length,
      rebalanceCount, stopCount, rebalancePerYear: rebalanceCount / years,
      cashDays: equityCurve.filter(row => row.holding === "CASH").length,
      terminalHolding: holding || "CASH", terminalLiquidation: false }
  };
}
