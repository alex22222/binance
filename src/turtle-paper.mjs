function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function dailyAtrPct(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  const ranges = recent.slice(1).map((candle, index) => Math.max(
    Number(candle.high) - Number(candle.low),
    Math.abs(Number(candle.high) - Number(recent[index].close)),
    Math.abs(Number(candle.low) - Number(recent[index].close))
  ));
  const close = Number(recent.at(-1).close);
  if (!(close > 0) || ranges.some((value) => !Number.isFinite(value))) return null;
  return ranges.reduce((sum, value) => sum + value, 0) / period / close * 100;
}

export function turtleDailyFeature(candles) {
  const valid = candles.filter((candle) => (
    finite(candle.high) != null && finite(candle.low) != null && finite(candle.close) != null
  )).sort((left, right) => left.openTime - right.openTime);
  if (valid.length < 56) return null;
  const latest = valid.at(-1);
  const previous55 = valid.slice(-56, -1);
  const previous20 = valid.slice(-21, -1);
  const atrPct = dailyAtrPct(valid, 20);
  if (!(atrPct > 0)) return null;
  const entryHigh = Math.max(...previous55.map(({ high }) => Number(high)));
  const exitLow = Math.min(...previous20.map(({ low }) => Number(low)));
  return {
    signalDate: new Date(latest.openTime).toISOString(),
    latestHigh: Number(latest.high),
    latestLow: Number(latest.low),
    entryHigh,
    exitLow,
    entryBreakout: Number(latest.high) > entryHigh,
    exitBreakout: Number(latest.low) < exitLow,
    breakoutStrengthPct: (Number(latest.high) / entryHigh - 1) * 100,
    dailyAtrPct: atrPct,
    initialRiskPct: atrPct * 2
  };
}

export function initialTurtlePaperState(startedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    mode: "paper",
    strategyId: "daily-turtle-55-20",
    evidenceLevel: "PAPER_CANDLE_PROXY",
    startedAt,
    updatedAt: startedAt,
    lastEntryEvaluationDate: null,
    position: null,
    trades: [],
    realizedPnlUsdt: 0,
    totalCostUsdt: 0,
    lastObservation: null
  };
}

export function advanceTurtlePaper(inputState, snapshot, options = {}) {
  const notionalUsdt = finite(options.notionalUsdt) ?? 50;
  const roundTripCostPct = finite(options.roundTripCostPct) ?? 1;
  if (!(notionalUsdt > 0) || roundTripCostPct < 0) throw new Error("Invalid Turtle Paper cost settings");
  const state = structuredClone(inputState);
  const events = [];
  state.updatedAt = snapshot.at;
  state.lastObservation = {
    at: snapshot.at,
    sessionDate: snapshot.sessionDate,
    regularOpen: snapshot.regularOpen
  };
  if (!snapshot.regularOpen) {
    events.push({ type: "PAPER_MARKET_CLOSED", at: snapshot.at, sessionDate: snapshot.sessionDate });
    return { state, events };
  }

  if (state.position) {
    const observation = snapshot.positionObservation;
    if (!observation || observation.symbol !== state.position.symbol || !(observation.price > 0)) {
      throw new Error(`Missing Paper mark for ${state.position.symbol}`);
    }
    const grossReturnPct = (observation.price / state.position.entryPrice - 1) * 100;
    const netReturnPct = grossReturnPct - roundTripCostPct;
    state.position.markPrice = observation.price;
    state.position.markedAt = snapshot.at;
    state.position.grossReturnPct = grossReturnPct;
    state.position.netReturnPct = netReturnPct;
    state.position.unrealizedPnlUsdt = notionalUsdt * netReturnPct / 100;
    state.position.peakNetReturnPct = Math.max(state.position.peakNetReturnPct, netReturnPct);
    state.position.worstNetReturnPct = Math.min(state.position.worstNetReturnPct, netReturnPct);
    const reason = grossReturnPct <= -state.position.initialRiskPct
      ? "TURTLE_2N_STOP"
      : observation.exitBreakout ? "TURTLE_20D_EXIT" : null;
    if (reason) {
      const grossPnlUsdt = state.position.quantity * observation.price - notionalUsdt;
      const costUsdt = notionalUsdt * roundTripCostPct / 100;
      const pnlUsdt = grossPnlUsdt - costUsdt;
      const trade = {
        strategyId: state.strategyId,
        symbol: state.position.symbol,
        openedAt: state.position.openedAt,
        closedAt: snapshot.at,
        entryPrice: state.position.entryPrice,
        exitPrice: observation.price,
        quantity: state.position.quantity,
        notionalUsdt,
        grossPnlUsdt,
        costUsdt,
        pnlUsdt,
        returnPct: pnlUsdt / notionalUsdt * 100,
        initialRiskPct: state.position.initialRiskPct,
        peakNetReturnPct: state.position.peakNetReturnPct,
        worstNetReturnPct: state.position.worstNetReturnPct,
        reason,
        evidenceLevel: "PAPER_CANDLE_PROXY"
      };
      state.trades.push(trade);
      state.realizedPnlUsdt += pnlUsdt;
      state.totalCostUsdt += costUsdt;
      state.position = null;
      events.push({ type: "PAPER_SELL_FILLED", at: snapshot.at, ...trade });
    } else {
      events.push({
        type: "PAPER_POSITION_MARKED",
        at: snapshot.at,
        symbol: state.position.symbol,
        price: observation.price,
        unrealizedPnlUsdt: state.position.unrealizedPnlUsdt,
        evidenceLevel: "PAPER_CANDLE_PROXY"
      });
    }
    return { state, events };
  }

  if (state.lastEntryEvaluationDate === snapshot.sessionDate) {
    events.push({ type: "PAPER_ENTRY_ALREADY_EVALUATED", at: snapshot.at, sessionDate: snapshot.sessionDate });
    return { state, events };
  }
  state.lastEntryEvaluationDate = snapshot.sessionDate;
  const selected = [...(snapshot.candidates || [])]
    .filter((candidate) => candidate.price > 0 && candidate.initialRiskPct > 0)
    .sort((left, right) => right.breakoutStrengthPct - left.breakoutStrengthPct)[0];
  if (!selected) {
    events.push({ type: "PAPER_NO_SIGNAL", at: snapshot.at, sessionDate: snapshot.sessionDate });
    return { state, events };
  }
  state.position = {
    symbol: selected.symbol,
    openedAt: snapshot.at,
    entryPrice: selected.price,
    quantity: notionalUsdt / selected.price,
    notionalUsdt,
    initialRiskPct: selected.initialRiskPct,
    breakoutStrengthPct: selected.breakoutStrengthPct,
    signalDate: selected.signalDate,
    markPrice: selected.price,
    markedAt: snapshot.at,
    grossReturnPct: 0,
    netReturnPct: -roundTripCostPct,
    unrealizedPnlUsdt: -notionalUsdt * roundTripCostPct / 100,
    peakNetReturnPct: -roundTripCostPct,
    worstNetReturnPct: -roundTripCostPct,
    evidenceLevel: "PAPER_CANDLE_PROXY"
  };
  events.push({
    type: "PAPER_BUY_FILLED",
    at: snapshot.at,
    sessionDate: snapshot.sessionDate,
    symbol: selected.symbol,
    price: selected.price,
    quantity: state.position.quantity,
    notionalUsdt,
    initialRiskPct: selected.initialRiskPct,
    signalDate: selected.signalDate,
    evidenceLevel: "PAPER_CANDLE_PROXY"
  });
  return { state, events };
}
