const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.2425;

export const US_ETF_ROTATION_UNIVERSE = Object.freeze({
  riskTickers: Object.freeze(["QQQ", "IWO", "VYM", "SPY"]),
  defensiveTicker: "IEI"
});

export const US_ETF_ROTATION_CONFIG = Object.freeze({
  momentumDays: 20,
  rsiPeriod: 14,
  rsiThreshold: 40,
  costBpsPerSide: 5,
  initialCapitalUsd: 100_000
});

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function parseYahooAdjustedDailyChart(chart) {
  const timestamps = chart?.timestamp || [];
  const quote = chart?.indicators?.quote?.[0] || {};
  const adjusted = chart?.indicators?.adjclose?.[0]?.adjclose || [];
  return timestamps.map((timestamp, index) => {
    const open = finitePositive(quote.open?.[index]);
    const close = finitePositive(quote.close?.[index]);
    const adjustedClose = finitePositive(adjusted[index]);
    if (open == null || close == null || adjustedClose == null) return null;
    const adjustmentFactor = adjustedClose / close;
    return {
      date: new Date(Number(timestamp) * 1000).toISOString().slice(0, 10),
      open: open * adjustmentFactor,
      close: adjustedClose
    };
  }).filter(Boolean);
}

export function alignDailySeries(seriesByTicker, tickers) {
  const maps = Object.fromEntries(tickers.map((ticker) => [
    ticker,
    new Map((seriesByTicker[ticker] || []).map((bar) => [bar.date, bar]))
  ]));
  const dates = [...maps[tickers[0]].keys()].filter((date) => (
    tickers.every((ticker) => maps[ticker].has(date))
  )).sort();
  return dates.map((date) => ({
    date,
    prices: Object.fromEntries(tickers.map((ticker) => [ticker, maps[ticker].get(date)]))
  }));
}

function rsiSeries(values, period) {
  const output = new Array(values.length).fill(null);
  if (values.length <= period) return output;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0) / period;
    averageLoss += Math.max(-change, 0) / period;
  }
  output[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return output;
}

function weekKey(date) {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  const day = new Date(timestamp).getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  return new Date(timestamp - daysFromMonday * DAY_MS).toISOString().slice(0, 10);
}

function summarizeEquity(equityCurve, initialCapitalUsd) {
  if (equityCurve.length < 2) throw new Error("At least two equity observations are required");
  const first = equityCurve[0];
  const last = equityCurve.at(-1);
  const elapsedYears = (Date.parse(`${last.date}T00:00:00Z`) - Date.parse(`${first.date}T00:00:00Z`))
    / (YEAR_DAYS * DAY_MS);
  const totalReturn = last.equityUsd / initialCapitalUsd - 1;
  const dailyReturns = [];
  let peak = initialCapitalUsd;
  let peakDate = first.date;
  let maxDrawdown = 0;
  let maxDrawdownPeakDate = first.date;
  let maxDrawdownTroughDate = first.date;
  for (let index = 0; index < equityCurve.length; index += 1) {
    const equity = equityCurve[index].equityUsd;
    if (equity > peak) {
      peak = equity;
      peakDate = equityCurve[index].date;
    }
    const drawdown = 1 - equity / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPeakDate = peakDate;
      maxDrawdownTroughDate = equityCurve[index].date;
    }
    if (index) dailyReturns.push(equity / equityCurve[index - 1].equityUsd - 1);
  }
  const average = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, value) => sum + (value - average) ** 2, 0)
    / Math.max(1, dailyReturns.length - 1);
  const volatility = Math.sqrt(variance) * Math.sqrt(252);
  const cagr = elapsedYears > 0 ? (last.equityUsd / initialCapitalUsd) ** (1 / elapsedYears) - 1 : null;
  return {
    startDate: first.date,
    endDate: last.date,
    tradingDays: equityCurve.length,
    elapsedYears,
    endingEquityUsd: last.equityUsd,
    totalReturnPct: totalReturn * 100,
    cagrPct: cagr * 100,
    annualVolatilityPct: volatility * 100,
    sharpeZeroRf: volatility > 0 ? average * 252 / volatility : null,
    maxDrawdownPct: maxDrawdown * 100,
    maxDrawdownPeakDate,
    maxDrawdownTroughDate,
    calmar: maxDrawdown > 0 ? cagr / maxDrawdown : null
  };
}

function validateInputs(rows, riskTickers, defensiveTicker, config) {
  if (!Array.isArray(rows) || rows.length < 3) throw new Error("Daily rows are required");
  if (!riskTickers.length || riskTickers.includes(defensiveTicker)) throw new Error("Invalid ETF universe");
  if (!Number.isInteger(config.momentumDays) || config.momentumDays < 1
    || !Number.isInteger(config.rsiPeriod) || config.rsiPeriod < 1
    || config.costBpsPerSide < 0 || config.costBpsPerSide >= 10_000
    || !(config.initialCapitalUsd > 0)) throw new Error("Invalid backtest configuration");
  const tickers = [...riskTickers, defensiveTicker];
  for (const row of rows) {
    if (!row.date || tickers.some((ticker) => {
      const price = row.prices?.[ticker];
      return !price || ![price.open, price.close].every((value) => Number.isFinite(value) && value > 0);
    })) throw new Error(`Incomplete price row: ${row.date || "unknown"}`);
  }
}

export function backtestEtfRotation({
  rows,
  riskTickers = US_ETF_ROTATION_UNIVERSE.riskTickers,
  defensiveTicker = US_ETF_ROTATION_UNIVERSE.defensiveTicker,
  startDate = null,
  endDate = null,
  ...overrides
}) {
  const config = { ...US_ETF_ROTATION_CONFIG, ...overrides };
  validateInputs(rows, riskTickers, defensiveTicker, config);
  const tickers = [...riskTickers, defensiveTicker];
  const closes = Object.fromEntries(tickers.map((ticker) => [
    ticker,
    rows.map((row) => row.prices[ticker].close)
  ]));
  const rsi = Object.fromEntries(riskTickers.map((ticker) => [ticker, rsiSeries(closes[ticker], config.rsiPeriod)]));
  const costRate = config.costBpsPerSide / 10_000;
  let cash = config.initialCapitalUsd;
  let holding = null;
  let units = 0;
  let totalCostUsd = 0;
  let actualSwitches = 0;
  let weeklyDecisions = 0;
  const trades = [];
  const decisions = [];
  const equityCurve = [];
  const holdingDays = Object.fromEntries(tickers.map((ticker) => [ticker, 0]));

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (startDate && row.date < startDate) continue;
    if (endDate && row.date > endDate) continue;
    const signalIndex = index - 1;
    const enoughHistory = signalIndex >= Math.max(config.momentumDays, config.rsiPeriod);
    const firstTradingDayOfWeek = weekKey(row.date) !== weekKey(rows[index - 1].date);
    if (enoughHistory && firstTradingDayOfWeek) {
      weeklyDecisions += 1;
      const candidates = riskTickers.map((ticker) => ({
        ticker,
        momentumPct: (closes[ticker][signalIndex] / closes[ticker][signalIndex - config.momentumDays] - 1) * 100,
        rsi: rsi[ticker][signalIndex]
      })).filter(({ rsi: value }) => value != null && value >= config.rsiThreshold)
        .sort((left, right) => right.momentumPct - left.momentumPct || left.ticker.localeCompare(right.ticker));
      const target = candidates[0]?.ticker || defensiveTicker;
      decisions.push({
        signalDate: rows[signalIndex].date,
        executionDate: row.date,
        target,
        candidates
      });
      if (target !== holding) {
        const previousHolding = holding;
        if (holding) {
          const grossProceeds = units * row.prices[holding].open;
          const sellCost = grossProceeds * costRate;
          cash = grossProceeds - sellCost;
          totalCostUsd += sellCost;
        }
        const buyCost = cash * costRate;
        units = (cash - buyCost) / row.prices[target].open;
        cash = 0;
        totalCostUsd += buyCost;
        holding = target;
        if (previousHolding) actualSwitches += 1;
        trades.push({
          signalDate: rows[signalIndex].date,
          executionDate: row.date,
          from: previousHolding,
          to: target,
          executionOpen: row.prices[target].open,
          equityAfterCostsUsd: units * row.prices[target].open
        });
      }
    }
    if (!holding) continue;
    holdingDays[holding] += 1;
    equityCurve.push({ date: row.date, equityUsd: units * row.prices[holding].close, holding });
  }
  const metrics = summarizeEquity(equityCurve, config.initialCapitalUsd);
  const investedDays = Object.values(holdingDays).reduce((sum, value) => sum + value, 0);
  return {
    config,
    metrics: {
      ...metrics,
      weeklyDecisions,
      actualSwitches,
      tradesIncludingInitialEntry: trades.length,
      totalCostUsd,
      holdingPct: Object.fromEntries(tickers.map((ticker) => [ticker, investedDays ? holdingDays[ticker] / investedDays * 100 : 0]))
    },
    trades,
    decisions,
    equityCurve
  };
}

export function backtestBuyAndHold({
  rows,
  weights,
  startDate,
  endDate,
  initialCapitalUsd = US_ETF_ROTATION_CONFIG.initialCapitalUsd,
  costBpsPerSide = US_ETF_ROTATION_CONFIG.costBpsPerSide
}) {
  const tickers = Object.keys(weights);
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(totalWeight - 1) > 1e-9) throw new Error("Benchmark weights must sum to one");
  const selected = rows.filter((row) => (!startDate || row.date >= startDate) && (!endDate || row.date <= endDate));
  if (selected.length < 2) throw new Error("Benchmark range is empty");
  const costRate = costBpsPerSide / 10_000;
  const units = Object.fromEntries(tickers.map((ticker) => [
    ticker,
    initialCapitalUsd * weights[ticker] * (1 - costRate) / selected[0].prices[ticker].open
  ]));
  const equityCurve = selected.map((row) => ({
    date: row.date,
    equityUsd: tickers.reduce((sum, ticker) => sum + units[ticker] * row.prices[ticker].close, 0)
  }));
  return {
    weights,
    metrics: {
      ...summarizeEquity(equityCurve, initialCapitalUsd),
      totalCostUsd: initialCapitalUsd * costRate
    },
    equityCurve
  };
}
