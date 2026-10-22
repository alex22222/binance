const number = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const close = (left, right) => number(left) != null && number(right) != null
  && Math.abs(Number(left) - Number(right)) <= 1e-9 * Math.max(1, Math.abs(Number(right)));

function patch(target, values) {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "number" || typeof target[key] !== "number" || !close(target[key], value)) target[key] = value;
  }
}

function checkEntry(entry) {
  if (!(number(entry.price) > 0) || !(number(entry.quantity) > 0) || !(number(entry.notionalUsdt) > 0)
    || !close(entry.quantity * entry.price, entry.notionalUsdt)) throw new Error("Invalid Turtle Paper entry capital");
}

function entryCost(entry, observations, sell, position) {
  if (number(entry.roundTripCostPct) != null) return { rate: Number(entry.roundTripCostPct), source: "ENTRY_EVENT" };
  const first = observations[0];
  if (first) {
    if (!(number(first.price) > 0) || number(first.unrealizedPnlUsdt) == null) throw new Error("Missing first-mark cost evidence");
    // Recover the original cost model from the earliest retained mark, before sizing changed.
    const rate = (first.price / entry.price - 1) * 100 - first.unrealizedPnlUsdt / entry.notionalUsdt * 100;
    return { rate: Number(rate.toFixed(12)), source: "FIRST_RECORDED_MARK" };
  }
  if (sell && close(sell.notionalUsdt, entry.notionalUsdt) && number(sell.costUsdt) != null) {
    return { rate: sell.costUsdt / entry.notionalUsdt * 100, source: "MATCHING_CLOSED_TRADE" };
  }
  if (position && number(position.roundTripCostPct) != null) {
    return { rate: Number(position.roundTripCostPct), source: "OPEN_POSITION" };
  }
  throw new Error("Missing Turtle Paper entry cost evidence");
}

// Recompute accounting only. Prices, quantities, timestamps, signals and exits are immutable.
export function repairTurtlePaperAccounting(inputState, inputEvents) {
  if (inputState.mode !== "paper" || inputState.strategyId !== "daily-turtle-55-20"
    || !Array.isArray(inputState.trades) || !Array.isArray(inputEvents)) throw new Error("Turtle Paper identity mismatch");
  const state = structuredClone(inputState), events = structuredClone(inputEvents);
  const groups = [];
  let active = null, previousAt = -Infinity;
  for (const event of events) {
    const time = Date.parse(event.at);
    if (!Number.isFinite(time) || time < previousAt) throw new Error("Invalid Turtle Paper event chronology");
    previousAt = time;
    if (event.type === "PAPER_BUY_FILLED") {
      if (active) throw new Error("Duplicate Turtle Paper entry");
      checkEntry(event);
      active = { entry: event, observations: [], sell: null };
      groups.push(active);
    } else if (["PAPER_POSITION_MARKED", "PAPER_SELL_FILLED"].includes(event.type)) {
      if (!active || event.symbol !== active.entry.symbol) throw new Error("Missing or mismatched Turtle Paper entry");
      if (event.type === "PAPER_POSITION_MARKED") active.observations.push(event);
      else {
        if (event.openedAt !== active.entry.at || event.closedAt !== event.at
          || !close(event.entryPrice, active.entry.price) || !close(event.quantity, active.entry.quantity)
          || !(number(event.exitPrice) > 0)) throw new Error("Turtle Paper sell/entry mismatch");
        active.sell = event;
        active = null;
      }
    }
  }
  const closed = groups.filter(group => group.sell);
  if (closed.length !== state.trades.length || Boolean(active) !== Boolean(state.position)) {
    throw new Error("Turtle Paper state/event count mismatch");
  }
  const costSources = [];
  for (const group of groups) {
    const { entry, observations, sell } = group;
    const position = sell ? null : state.position;
    const trade = sell ? state.trades[closed.indexOf(group)] : null;
    if (trade && ["symbol", "openedAt", "closedAt", "entryPrice", "exitPrice", "quantity", "reason"].some(key => trade[key] !== sell[key])) {
      throw new Error("Turtle Paper state/event trade mismatch");
    }
    if (position && (position.symbol !== entry.symbol || position.openedAt !== entry.at
      || !close(position.entryPrice, entry.price) || !close(position.quantity, entry.quantity))) {
      throw new Error("Turtle Paper state/event position mismatch");
    }
    const { rate, source } = entryCost(entry, observations, sell, position);
    if (!Number.isFinite(rate) || rate < 0 || rate >= 100) throw new Error("Invalid Turtle Paper recovered cost");
    costSources.push({ symbol: entry.symbol, openedAt: entry.at, roundTripCostPct: rate, source,
      evidenceAt: source === "FIRST_RECORDED_MARK" ? observations[0].at : entry.at });
    entry.roundTripCostPct = rate;
    let peak = -rate, worst = -rate;
    function mark(price) {
      if (!(number(price) > 0)) throw new Error("Invalid Turtle Paper mark price");
      const grossReturnPct = (price / entry.price - 1) * 100;
      const netReturnPct = grossReturnPct - rate;
      peak = Math.max(peak, netReturnPct);
      worst = Math.min(worst, netReturnPct);
      return { grossReturnPct, netReturnPct, unrealizedPnlUsdt: entry.notionalUsdt * netReturnPct / 100 };
    }
    for (const observation of observations) patch(observation, { unrealizedPnlUsdt: mark(observation.price).unrealizedPnlUsdt });
    if (sell) {
      mark(sell.exitPrice);
      const grossPnlUsdt = entry.quantity * sell.exitPrice - entry.notionalUsdt;
      const costUsdt = entry.notionalUsdt * rate / 100;
      const pnlUsdt = grossPnlUsdt - costUsdt;
      const accounting = { notionalUsdt: entry.notionalUsdt, roundTripCostPct: rate, grossPnlUsdt, costUsdt,
        pnlUsdt, returnPct: pnlUsdt / entry.notionalUsdt * 100, peakNetReturnPct: peak, worstNetReturnPct: worst };
      patch(sell, accounting);
      patch(trade, accounting);
    } else {
      const last = observations.at(-1);
      if (last && (position.markedAt !== last.at || !close(position.markPrice, last.price))) {
        throw new Error("Turtle Paper last mark mismatch");
      }
      patch(position, { ...mark(position.markPrice), notionalUsdt: entry.notionalUsdt, roundTripCostPct: rate,
        peakNetReturnPct: peak, worstNetReturnPct: worst });
    }
  }
  state.realizedPnlUsdt = state.trades.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  state.totalCostUsdt = state.trades.reduce((sum, trade) => sum + trade.costUsdt, 0);
  return { state, events, report: {
    changedEvents: events.filter((event, index) => JSON.stringify(event) !== JSON.stringify(inputEvents[index])).length,
    changedTrades: state.trades.filter((trade, index) => JSON.stringify(trade) !== JSON.stringify(inputState.trades[index])).length,
    before: { realizedPnlUsdt: inputState.realizedPnlUsdt, totalCostUsdt: inputState.totalCostUsdt },
    after: { realizedPnlUsdt: state.realizedPnlUsdt, totalCostUsdt: state.totalCostUsdt }, costSources,
    trades: state.trades.map((trade, index) => ({ symbol: trade.symbol, openedAt: trade.openedAt,
      before: { pnlUsdt: inputState.trades[index].pnlUsdt, returnPct: inputState.trades[index].returnPct },
      after: { pnlUsdt: trade.pnlUsdt, returnPct: trade.returnPct, notionalUsdt: trade.notionalUsdt, costUsdt: trade.costUsdt } }))
  } };
}
