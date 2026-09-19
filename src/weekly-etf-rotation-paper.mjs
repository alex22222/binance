const DAY_MS = 86_400_000;

export const WEEKLY_ETF_ROTATION_STRATEGY_ID = "weekly-etf-momentum-rsi-rotation";
export const WEEKLY_ETF_DEFENSIVE_STRATEGY_ID = "weekly-etf-dual-momentum-defense";

export const WEEKLY_ETF_ROTATION_UNIVERSE = Object.freeze({
  riskTickers: Object.freeze(["QQQ", "VTI", "VTV", "SPY"]),
  defensiveTicker: "SGOV"
});

export const WEEKLY_ETF_ROTATION_CONFIG = Object.freeze({
  momentumDays: 20,
  rsiPeriod: 14,
  rsiThreshold: 40
});

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function wilderRsi(closes, period) {
  if (closes.length <= period) return null;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1];
    averageGain += Math.max(change, 0) / period;
    averageLoss += Math.max(-change, 0) / period;
  }
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  return averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
}

function normalizedDailySeries(values) {
  return [...(values || [])].map((row) => ({
    date: String(row?.date || ""),
    close: finitePositive(row?.close)
  })).filter(({ date, close }) => date && close != null)
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function weeklyEtfRotationSignal(seriesByTicker, overrides = {}) {
  const config = { ...WEEKLY_ETF_ROTATION_CONFIG, ...overrides };
  const requiredRows = Math.max(config.momentumDays, config.rsiPeriod) + 1;
  if (!Number.isInteger(config.momentumDays) || config.momentumDays < 1
    || !Number.isInteger(config.rsiPeriod) || config.rsiPeriod < 1
    || !Number.isFinite(config.rsiThreshold)) throw new Error("Invalid weekly ETF signal configuration");

  const allRiskAssets = WEEKLY_ETF_ROTATION_UNIVERSE.riskTickers.map((ticker) => {
    const series = normalizedDailySeries(seriesByTicker?.[ticker]);
    if (series.length < requiredRows) throw new Error(`Insufficient daily history: ${ticker}`);
    const closes = series.map(({ close }) => close);
    const latest = series.at(-1);
    const momentumPct = (latest.close / series.at(-(config.momentumDays + 1)).close - 1) * 100;
    const rsi = wilderRsi(closes, config.rsiPeriod);
    return {
      ticker,
      signalDate: latest.date,
      momentumPct,
      rsi,
      eligible: rsi != null && rsi >= config.rsiThreshold
    };
  });
  const signalDates = new Set(allRiskAssets.map(({ signalDate }) => signalDate));
  if (signalDates.size !== 1) throw new Error("Risk ETF signal dates do not align");
  const candidates = allRiskAssets.filter(({ eligible }) => eligible)
    .sort((left, right) => right.momentumPct - left.momentumPct || left.ticker.localeCompare(right.ticker));
  return {
    config,
    signalDate: allRiskAssets[0].signalDate,
    target: candidates[0]?.ticker || WEEKLY_ETF_ROTATION_UNIVERSE.defensiveTicker,
    candidates,
    allRiskAssets
  };
}

export function weeklyEtfDefensiveSignal(seriesByTicker) {
  const baseline = weeklyEtfRotationSignal(seriesByTicker);
  const defensiveTicker = WEEKLY_ETF_ROTATION_UNIVERSE.defensiveTicker;
  const defensive = normalizedDailySeries(seriesByTicker?.[defensiveTicker]);
  if (defensive.length < WEEKLY_ETF_ROTATION_CONFIG.momentumDays + 1) {
    throw new Error(`Insufficient daily history: ${defensiveTicker}`);
  }
  if (defensive.at(-1).date !== baseline.signalDate) {
    throw new Error(`${defensiveTicker} signal date does not align`);
  }
  const momentumPct = (defensive.at(-1).close / defensive.at(-21).close - 1) * 100;
  const allRiskAssets = baseline.allRiskAssets.map((asset) => ({
    ...asset,
    eligible: asset.eligible && asset.momentumPct > 0
  }));
  const candidates = baseline.candidates.filter((asset) => asset.momentumPct > 0);
  return {
    ...baseline,
    allRiskAssets,
    candidates,
    defensiveAsset: { ticker: defensiveTicker, momentumPct, eligible: momentumPct > 0 },
    target: candidates[0]?.ticker || (momentumPct > 0 ? defensiveTicker : "CASH"),
    absoluteMomentumRequired: true
  };
}

function weeklyEtfAsset(items, ticker) {
  const matches = (items || []).filter((item) => item?.ticker === ticker && String(item?.chainId) === "56");
  if (matches.length !== 1 || matches[0].assetType !== 3 || !String(matches[0].contractAddress || "").trim()) {
    throw new Error(`Expected one Binance BSC ETF: ${ticker}`);
  }
  return matches[0];
}

export function weeklyEtfRotationAssets(items) {
  return [...WEEKLY_ETF_ROTATION_UNIVERSE.riskTickers, WEEKLY_ETF_ROTATION_UNIVERSE.defensiveTicker]
    .map((ticker) => weeklyEtfAsset(items, ticker));
}

export function weeklyEtfValuationAssets(items, heldTicker = null) {
  const assets = weeklyEtfRotationAssets(items);
  if (!heldTicker || assets.some(({ ticker }) => ticker === heldTicker)) return assets;
  return [...assets, weeklyEtfAsset(items, heldTicker)];
}

export function weeklyPaperWeek(date) {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid session date: ${date}`);
  const day = new Date(timestamp).getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  return new Date(timestamp - daysFromMonday * DAY_MS).toISOString().slice(0, 10);
}

export function initialWeeklyEtfRotationPaperState(
  startedAt = new Date().toISOString(),
  initialCapitalUsdt = 50,
  lastDecisionWeek = null
) {
  if (!(finitePositive(initialCapitalUsdt) > 0)) throw new Error("Invalid Paper capital");
  return {
    schemaVersion: 1,
    mode: "paper",
    strategyId: WEEKLY_ETF_ROTATION_STRATEGY_ID,
    evidenceLevel: "PAPER_CANDLE_PROXY",
    startedAt,
    updatedAt: startedAt,
    initialCapitalUsdt: Number(initialCapitalUsdt),
    cashUsdt: Number(initialCapitalUsdt),
    equityUsdt: Number(initialCapitalUsdt),
    totalReturnPct: 0,
    realizedPnlUsdt: 0,
    totalCostUsdt: 0,
    actualSwitches: 0,
    lastDecisionWeek,
    lastDecision: null,
    position: null,
    trades: [],
    lastObservation: null
  };
}

function markPosition(state, snapshot) {
  if (!state.position) {
    state.equityUsdt = state.cashUsdt;
    state.totalReturnPct = (state.equityUsdt / state.initialCapitalUsdt - 1) * 100;
    return;
  }
  const price = finitePositive(snapshot.prices?.[state.position.symbol]);
  if (price == null) throw new Error(`Missing Paper mark for ${state.position.symbol}`);
  state.position.markPrice = price;
  state.position.markedAt = snapshot.at;
  state.position.unrealizedPnlUsdt = state.position.quantity * price - state.position.entryCapitalUsdt;
  state.equityUsdt = state.position.quantity * price;
  state.totalReturnPct = (state.equityUsdt / state.initialCapitalUsdt - 1) * 100;
}

export function advanceWeeklyEtfRotationPaper(inputState, snapshot, options = {}) {
  const roundTripCostPct = Number(options.roundTripCostPct ?? 1);
  if (!(roundTripCostPct >= 0 && roundTripCostPct < 100)) throw new Error("Invalid Paper cost settings");
  const sideCostRate = roundTripCostPct / 200;
  const state = structuredClone(inputState);
  const events = [];
  state.updatedAt = snapshot.at;
  state.lastObservation = {
    at: snapshot.at,
    sessionDate: snapshot.sessionDate,
    week: snapshot.week,
    regularOpen: snapshot.regularOpen
  };
  if (!snapshot.regularOpen) {
    events.push({ type: "PAPER_MARKET_CLOSED", at: snapshot.at, sessionDate: snapshot.sessionDate });
    return { state, events };
  }

  if (!snapshot.decision) {
    markPosition(state, snapshot);
    events.push({
      type: state.position ? "PAPER_POSITION_MARKED" : "PAPER_WAITING_FOR_WEEKLY_DECISION",
      at: snapshot.at,
      symbol: state.position?.symbol || null,
      equityUsdt: state.equityUsdt,
      evidenceLevel: state.evidenceLevel
    });
    return { state, events };
  }
  if (state.lastDecisionWeek === snapshot.week) {
    markPosition(state, snapshot);
    events.push({ type: "PAPER_WEEK_ALREADY_EVALUATED", at: snapshot.at, week: snapshot.week });
    return { state, events };
  }

  const allowedTargets = new Set([
    ...WEEKLY_ETF_ROTATION_UNIVERSE.riskTickers,
    WEEKLY_ETF_ROTATION_UNIVERSE.defensiveTicker
  ]);
  if (state.strategyId === WEEKLY_ETF_DEFENSIVE_STRATEGY_ID) allowedTargets.add("CASH");
  const target = snapshot.decision.target;
  if (!allowedTargets.has(target)) throw new Error(`Invalid weekly ETF target: ${target}`);
  state.lastDecisionWeek = snapshot.week;
  state.lastDecision = structuredClone(snapshot.decision);

  if (state.position?.symbol === target) {
    markPosition(state, snapshot);
    events.push({
      type: "PAPER_TARGET_UNCHANGED",
      at: snapshot.at,
      week: snapshot.week,
      symbol: target,
      equityUsdt: state.equityUsdt
    });
    return { state, events };
  }

  let availableCapital = state.cashUsdt;
  if (state.position) {
    const exitPrice = finitePositive(snapshot.prices?.[state.position.symbol]);
    if (exitPrice == null) throw new Error(`Missing Paper exit price for ${state.position.symbol}`);
    const grossProceedsUsdt = state.position.quantity * exitPrice;
    const sellCostUsdt = grossProceedsUsdt * sideCostRate;
    availableCapital = grossProceedsUsdt - sellCostUsdt;
    const grossPnlUsdt = state.position.entryCapitalUsdt * (exitPrice / state.position.entryPrice - 1);
    const pnlUsdt = availableCapital - state.position.entryCapitalUsdt;
    const trade = {
      strategyId: state.strategyId,
      from: state.position.symbol,
      to: target,
      openedAt: state.position.openedAt,
      closedAt: snapshot.at,
      signalDate: snapshot.decision.signalDate,
      entryPrice: state.position.entryPrice,
      exitPrice,
      entryCapitalUsdt: state.position.entryCapitalUsdt,
      grossPnlUsdt,
      costUsdt: state.position.entryCostUsdt + sellCostUsdt,
      pnlUsdt,
      returnPct: pnlUsdt / state.position.entryCapitalUsdt * 100,
      evidenceLevel: state.evidenceLevel
    };
    state.trades.push(trade);
    state.realizedPnlUsdt += pnlUsdt;
    state.totalCostUsdt += sellCostUsdt;
    state.actualSwitches += 1;
    events.push({ type: "PAPER_SELL_FILLED", at: snapshot.at, ...trade });
  }

  if (target === "CASH") {
    state.position = null;
    state.cashUsdt = availableCapital;
    markPosition(state, snapshot);
    events.push({ type: "PAPER_CASH_HELD", at: snapshot.at, week: snapshot.week, equityUsdt: state.equityUsdt });
    return { state, events };
  }

  const entryPrice = finitePositive(snapshot.prices?.[target]);
  if (entryPrice == null) throw new Error(`Missing Paper entry price for ${target}`);
  const buyCostUsdt = availableCapital * sideCostRate;
  const investedUsdt = availableCapital - buyCostUsdt;
  state.totalCostUsdt += buyCostUsdt;
  state.cashUsdt = 0;
  state.position = {
    symbol: target,
    openedAt: snapshot.at,
    signalDate: snapshot.decision.signalDate,
    entryPrice,
    entryCapitalUsdt: availableCapital,
    entryCostUsdt: buyCostUsdt,
    quantity: investedUsdt / entryPrice,
    markPrice: entryPrice,
    markedAt: snapshot.at,
    unrealizedPnlUsdt: -buyCostUsdt,
    evidenceLevel: state.evidenceLevel
  };
  state.equityUsdt = investedUsdt;
  state.totalReturnPct = (state.equityUsdt / state.initialCapitalUsdt - 1) * 100;
  events.push({
    type: "PAPER_BUY_FILLED",
    at: snapshot.at,
    week: snapshot.week,
    symbol: target,
    signalDate: snapshot.decision.signalDate,
    price: entryPrice,
    quantity: state.position.quantity,
    capitalUsdt: availableCapital,
    costUsdt: buyCostUsdt,
    evidenceLevel: state.evidenceLevel
  });
  return { state, events };
}
