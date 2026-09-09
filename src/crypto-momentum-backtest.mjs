import { analyzeCandles, calculateAtrPct } from "./strategy-signals.mjs";
import { dynamicExitDecision } from "./strategy-exit.mjs";
import { initialRiskDecision, costCoverageDecision, isStopLossExit } from "./strategy.mjs";
import { noLossExitDecision } from "./execution-accounting.mjs";

const MINUTE = 60_000;
const DAY = 86_400_000;

// Read-only production parameter snapshot, 2026-09-05. Exchange spot adaptation:
// no gas; 24/7 UTC days replace NYSE sessions; no stock/FOMC/wallet/approval gates.
export const CURRENT_MOMENTUM_CONFIG = Object.freeze({
  maxTradeUsdt: 50,
  dailyLossLimitUsdt: 2,
  entryAtrMultiplier: 0.75,
  minDirectionalMinutes: 9,
  entryIntervalMinutes: 15,
  atrPeriod: 14,
  atrStopMultiplier: 1.5,
  minInitialStopPct: 1,
  maxInitialStopPct: 3.5,
  profitProtectionR: 1,
  trailingAtrMultiplier: 1,
  finalTakeProfitR: 2,
  signalReviewHours: 4,
  signalReviewMinR: 0.5,
  disasterStopLossPct: 8,
  maxRoundTripCostPct: 0.7,
  executionBufferPct: 0.1,
  minNetEdgePct: 0.1,
  noLossSlippageReservePct: 0.5
});

export function prepareCryptoFeatures(candles, config = CURRENT_MOMENTUM_CONFIG) {
  const trend = new Float64Array(candles.length).fill(NaN);
  const atr = new Float64Array(candles.length).fill(NaN);
  const up = new Uint8Array(candles.length);
  const completed15m = [];
  let aggregate = null;
  let latestAtr = NaN;
  for (let i = 1; i < candles.length; i++) {
    const previous = candles[i - 1];
    const bucket = Math.floor(previous.openTime / (15 * MINUTE)) * 15 * MINUTE;
    if (!aggregate || aggregate.openTime !== bucket) {
      aggregate = { ...previous, openTime: bucket, count: 1 };
    } else {
      aggregate.high = Math.max(aggregate.high, previous.high);
      aggregate.low = Math.min(aggregate.low, previous.low);
      aggregate.close = previous.close;
      aggregate.closeTime = previous.closeTime;
      aggregate.count++;
    }
    if (previous.openTime + MINUTE === bucket + 15 * MINUTE && aggregate.count === 15) {
      completed15m.push(aggregate);
      if (completed15m.length > config.atrPeriod + 1) completed15m.shift();
      latestAtr = calculateAtrPct(completed15m, config.atrPeriod, candles[i].openTime)?.atrPct ?? NaN;
    }
    const signal = analyzeCandles(candles.slice(Math.max(0, i - 16), i), candles[i].openTime);
    if (signal) { trend[i] = signal.trend15mPct; up[i] = signal.upMinutes; }
    atr[i] = latestAtr;
  }
  return { trend, atr, up };
}

export function backtestCryptoMomentum({
  symbol,
  candles,
  startMs,
  endMs,
  config = CURRENT_MOMENTUM_CONFIG,
  features = prepareCryptoFeatures(candles, config),
  initialCapitalUsdt = 1000,
  feePct = 0.1,
  slippagePct = 0.02,
  entryPhaseMinutes = 0
}) {
  if (!(startMs < endMs) || !(initialCapitalUsdt >= config.maxTradeUsdt)
    || feePct < 0 || slippagePct < 0 || feePct >= 100 || slippagePct >= 100) throw new Error("Invalid backtest inputs");
  const buyFactor = (1 + feePct / 100) * (1 + slippagePct / 100);
  const sellFactor = (1 - feePct / 100) * (1 - slippagePct / 100);
  const roundTripCostPct = (1 - sellFactor / buyFactor) * 100;
  let cash = initialCapitalUsdt;
  let position = null;
  let day = null;
  let dailyRealized = 0;
  let quarantineUntilDay = -Infinity;
  const stopDays = [];
  const trades = [];
  const dailyEquity = [];
  let peakEquity = initialCapitalUsdt;
  let maxDrawdownUsdt = 0;
  let maxDrawdownPct = 0;
  let exposureMinutes = 0;
  let firstPrice = null;
  let lastCandle = null;
  let signalCandidates = 0;
  let costBlocked = 0;
  let noLossBlockedMinutes = 0;
  let previousEquity = initialCapitalUsdt;

  function mark(price, timestamp) {
    const equity = cash + (position ? position.quantity * price * sellFactor : 0);
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peakEquity - equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peakEquity - equity) / peakEquity * 100);
    previousEquity = equity;
    return { timestamp: new Date(timestamp).toISOString(), equityUsdt: equity };
  }

  function close(price, timestamp, reason) {
    const exitValueUsdt = position.quantity * price * sellFactor;
    const pnlUsdt = exitValueUsdt - config.maxTradeUsdt;
    const grossPnlUsdt = config.maxTradeUsdt * (price / position.entryReferencePrice - 1);
    cash += exitValueUsdt;
    dailyRealized += pnlUsdt;
    trades.push({ symbol, openedAt: new Date(position.openedAtMs).toISOString(), closedAt: new Date(timestamp).toISOString(), reason,
      entryReferencePrice: position.entryReferencePrice, exitReferencePrice: price, quantity: position.quantity,
      entryValueUsdt: config.maxTradeUsdt, exitValueUsdt, pnlUsdt, returnPct: pnlUsdt / config.maxTradeUsdt * 100,
      grossPnlUsdt, totalCostUsdt: grossPnlUsdt - pnlUsdt, initialRiskPct: position.initialRiskPct,
      heldHours: (timestamp - position.openedAtMs) / 3_600_000,
      maePct: position.maePct, mfePct: position.peakReturnPct });
    if (reason === "INITIAL_STOP") {
      if (stopDays.some((stopDay) => stopDay >= day - 4)) quarantineUntilDay = day + 5;
      stopDays.push(day);
    }
    position = null;
  }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const now = candle.openTime;
    if (now < startMs || now >= endMs) continue;
    const currentDay = Math.floor(now / DAY);
    if (day !== currentDay) {
      if (day !== null) dailyEquity.push({ timestamp: new Date(now).toISOString(), equityUsdt: previousEquity });
      day = currentDay;
      dailyRealized = 0;
    }
    firstPrice ??= candle.open;
    lastCandle = candle;
    const atr15Pct = features.atr[i];
    const signalValid = Number.isFinite(atr15Pct) && features.trend[i] + 1e-9 >= atr15Pct * config.entryAtrMultiplier
      && features.up[i] >= config.minDirectionalMinutes;
    let exited = false;
    if (position) {
      exposureMinutes++;
      const proceedsUsdt = position.quantity * candle.open * sellFactor;
      const returnPct = (proceedsUsdt / config.maxTradeUsdt - 1) * 100;
      position.maePct = Math.min(position.maePct, returnPct);
      const decision = dynamicExitDecision({ ...config, ...position, returnPct, atr15Pct, signalValid, nowMs: now });
      position.peakReturnPct = decision.peakReturnPct;
      position.profitProtectionActive = decision.profitProtectionActive;
      if (decision.type) {
        const noLoss = noLossExitDecision({ proceedsUsdt, costBasisUsdt: config.maxTradeUsdt, slippagePct: config.noLossSlippageReservePct });
        if (isStopLossExit(decision.type) || noLoss.allowed) {
          close(candle.open, now, decision.type);
          exited = true;
        } else noLossBlockedMinutes++;
      }
    }
    const entryDue = (now / MINUTE - entryPhaseMinutes) % config.entryIntervalMinutes === 0;
    if (!position && !exited && entryDue && signalValid && dailyRealized > -config.dailyLossLimitUsdt
      && day > quarantineUntilDay && !stopDays.includes(day) && cash >= config.maxTradeUsdt) {
      signalCandidates++;
      const risk = initialRiskDecision({ atr15Pct, atrStopMultiplier: config.atrStopMultiplier,
        minStopPct: config.minInitialStopPct, maxStopPct: config.maxInitialStopPct });
      const cost = costCoverageDecision({ tradeUsdt: config.maxTradeUsdt, grossEdgeProxyPct: features.trend[i],
        takeProfitPct: risk.initialRiskPct * config.finalTakeProfitR, quotedRoundTripCostPct: roundTripCostPct,
        executionBufferPct: config.executionBufferPct, estimatedRoundTripGasUsdt: 0, minNetEdgePct: config.minNetEdgePct });
      if (risk.allowed && roundTripCostPct <= config.maxRoundTripCostPct && cost.allowed) {
        cash -= config.maxTradeUsdt;
        position = { quantity: config.maxTradeUsdt / (candle.open * buyFactor), entryReferencePrice: candle.open,
          openedAtMs: now, initialRiskPct: risk.initialRiskPct, profitFloorPct: cost.allInCostPct + config.minNetEdgePct,
          peakReturnPct: 0, maePct: -roundTripCostPct, profitProtectionActive: false };
      } else costBlocked++;
    }
    mark(candle.open, now);
  }
  if (!lastCandle) throw new Error("No candles in requested range");
  // Explicit liquidation for finite-period accounting, not a strategy-generated exit.
  if (position) close(lastCandle.close, endMs - 1, "END_OF_TEST");
  dailyEquity.push(mark(lastCandle.close, endMs));
  const netPnlUsdt = cash - initialCapitalUsdt;
  const positives = trades.filter((trade) => trade.pnlUsdt > 0);
  const negatives = trades.filter((trade) => trade.pnlUsdt < 0);
  const grossProfit = positives.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  const grossLoss = -negatives.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  const monthly = {};
  const exitReasons = {};
  for (const trade of trades) {
    const month = trade.closedAt.slice(0, 7);
    monthly[month] ||= { trades: 0, pnlUsdt: 0 };
    monthly[month].trades++;
    monthly[month].pnlUsdt += trade.pnlUsdt;
    exitReasons[trade.reason] = (exitReasons[trade.reason] || 0) + 1;
  }
  const benchmarkReturnPct = (lastCandle.close / firstPrice * sellFactor / buyFactor - 1) * 100;
  return {
    summary: { initialCapitalUsdt, fixedTradeUsdt: config.maxTradeUsdt, netPnlUsdt, accountReturnPct: netPnlUsdt / initialCapitalUsdt * 100,
      endingEquityUsdt: cash, trades: trades.length, wins: positives.length, losses: negatives.length,
      winRatePct: trades.length ? positives.length / trades.length * 100 : null,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null, maxDrawdownUsdt, maxDrawdownPct,
      averageTradeUsdt: trades.length ? netPnlUsdt / trades.length : null,
      totalCostUsdt: trades.reduce((sum, trade) => sum + trade.totalCostUsdt, 0),
      averageHeldHours: trades.length ? trades.reduce((sum, trade) => sum + trade.heldHours, 0) / trades.length : null,
      exposurePct: exposureMinutes / ((endMs - startMs) / MINUTE) * 100,
      benchmarkReturnPct, benchmarkFixed50PnlUsdt: config.maxTradeUsdt * benchmarkReturnPct / 100,
      feePct, slippagePct, roundTripCostPct, entryPhaseMinutes, signalCandidates, costBlocked, noLossBlockedMinutes, exitReasons, monthly },
    trades, dailyEquity
  };
}
