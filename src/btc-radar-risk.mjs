// Scenario math for the radar's contract DCA panel. The radar page embeds these
// functions with toString(), so each must stay self-contained: no imports and
// no references outside its own body.

// Shared by the API and the browser clock. A newly stamped evaluation must not
// extend the lifetime of an older scored input. Five hours allows the 4h timer
// its existing one-hour grace period; this is not real-time position monitoring.
export function btcRadarFreshness(snapshot, nowMs = Date.now()) {
  const maxAgeMs = 5 * 3_600_000;
  const scored = new Set(["btcMarket", "gold", "funding", "openInterest", "fed", "treasury", "sentiment"]);
  const stamps = [["snapshot", snapshot?.ts], ...Object.entries(snapshot?.data_status?.sourceFetchedAt || {}).filter(([key]) => scored.has(key))];
  const expiredSources = stamps.filter(([, stamp]) => {
    const ms = Date.parse(stamp);
    return !Number.isFinite(ms) || nowMs - ms > maxAgeMs || ms - nowMs > 60_000;
  }).map(([key]) => key);
  if (Object.hasOwn(snapshot || {}, "score") && snapshot.modelVersion !== "pressure-v2-no-touch-probability") expiredSources.push("modelVersion");
  return { expired: expiredSources.length > 0, expiredSources, ageHours: (nowMs - Date.parse(snapshot?.ts)) / 3_600_000 };
}

// What a long or short DCA position looks like if the stop or take-profit
// triggers. Safety orders on the path to the stop fill first, so the stop
// loss is taken on that larger position. The liquidation estimate assumes each
// fill adds notional / leverage of isolated margin; slippage is not included.
export function dcaScenario({ position, price, stop, takeProfit, capitalUsdt = null, takerFee = 0.0005, maintenanceMargin = 0.004 }) {
  const direction = position.direction === "short" ? -1 : 1;
  const size = Number(position.sz_btc);
  const average = Number(position.avg);
  const contractValue = Number(position.ladder && position.ladder.ctVal) > 0 ? Number(position.ladder.ctVal) : 0.01;
  const pending = ((position.ladder && position.ladder.pending) || [])
    .map(([orderPrice, contracts]) => [Number(orderPrice), Number(contracts)])
    .filter(([orderPrice, contracts]) => orderPrice > 0 && contracts > 0);
  const hasStop = stop > 0;
  const filling = hasStop ? pending.filter(([orderPrice]) => direction * (orderPrice - stop) > 0) : pending;
  const addedSize = filling.reduce((sum, [, contracts]) => sum + contracts * contractValue, 0);
  const addedCost = filling.reduce((sum, [orderPrice, contracts]) => sum + orderPrice * contracts * contractValue, 0);
  const worstSize = size + addedSize;
  const worstAverage = (average * size + addedCost) / worstSize;
  const lever = Number(position.lever);
  const liquidation = Number(position.liq);
  let worstLiquidation = null;
  if (position.source === "account" || position.source === "grid") {
    worstLiquidation = liquidation > 0 ? liquidation : null;
  } else if (lever > 0 && liquidation > 0) {
    const margin = direction * (average * size - liquidation * size * (1 - direction * maintenanceMargin));
    worstLiquidation = (worstAverage * worstSize - direction * (margin + addedCost / lever)) / (worstSize * (1 - direction * maintenanceMargin));
  }
  const lossAtStop = hasStop ? direction * worstSize * (worstAverage - stop) + worstSize * stop * takerFee : null;
  const profitAtTarget = takeProfit > 0 ? direction * size * (takeProfit - average) - size * takeProfit * takerFee : null;
  const share = (value) => capitalUsdt > 0 && value !== null ? value / capitalUsdt : null;
  return {
    stop: hasStop ? stop : null,
    takeProfit: takeProfit > 0 ? takeProfit : null,
    stopDistance: hasStop ? stop / price - 1 : null,
    targetDistance: takeProfit > 0 ? takeProfit / price - 1 : null,
    targetFromAverage: takeProfit > 0 ? takeProfit / average - 1 : null,
    fills: filling.length,
    worstSize,
    worstAverage,
    worstLiquidation,
    stopAboveLiquidation: hasStop && worstLiquidation > 0 ? direction * (stop / worstLiquidation - 1) : null,
    lossAtStop,
    profitAtTarget,
    lossShare: share(lossAtStop),
    profitShare: share(profitAtTarget),
    breakevenWinRate: lossAtStop > 0 && profitAtTarget > 0 ? lossAtStop / (lossAtStop + profitAtTarget) : null
  };
}
