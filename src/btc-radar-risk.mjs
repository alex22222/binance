// Scenario math for the radar's contract DCA panel. The radar page embeds these
// functions with toString(), so each must stay self-contained: no imports and
// no references outside its own body.

// Linear interpolation of a Polymarket {price: probability} ladder, clamped to
// its end points; null when the ladder or target is unusable.
export function ladderProbability(ladder, target) {
  const points = Object.entries(ladder || {})
    .map(([price, probability]) => [Number(price), Number(probability)])
    .filter(([price, probability]) => Number.isFinite(price) && Number.isFinite(probability))
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (!points.length || !Number.isFinite(target)) return null;
  if (target <= points[0][0]) return points[0][1];
  if (target >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    if (x1 <= target && target <= x2) return y1 + (y2 - y1) * (target - x1) / (x2 - x1);
  }
  return null;
}

// What a long contract DCA position looks like if the stop or take-profit
// triggers. Every pending safety order above the stop fills first, so the stop
// loss is taken on that larger position. The liquidation estimate assumes each
// fill adds notional / leverage of isolated margin; slippage is not included.
export function dcaScenario({ position, price, stop, takeProfit, capitalUsdt = null, takerFee = 0.0005, maintenanceMargin = 0.004 }) {
  const size = Number(position.sz_btc);
  const average = Number(position.avg);
  const contractValue = Number(position.ladder && position.ladder.ctVal) > 0 ? Number(position.ladder.ctVal) : 0.01;
  const pending = ((position.ladder && position.ladder.pending) || [])
    .map(([orderPrice, contracts]) => [Number(orderPrice), Number(contracts)])
    .filter(([orderPrice, contracts]) => orderPrice > 0 && contracts > 0);
  const hasStop = stop > 0;
  const filling = hasStop ? pending.filter(([orderPrice]) => orderPrice > stop) : pending;
  const addedSize = filling.reduce((sum, [, contracts]) => sum + contracts * contractValue, 0);
  const addedCost = filling.reduce((sum, [orderPrice, contracts]) => sum + orderPrice * contracts * contractValue, 0);
  const worstSize = size + addedSize;
  const worstAverage = (average * size + addedCost) / worstSize;
  const lever = Number(position.lever);
  const liquidation = Number(position.liq);
  let worstLiquidation = null;
  if (lever > 0 && liquidation > 0) {
    const margin = average * size - liquidation * size * (1 - maintenanceMargin);
    worstLiquidation = (worstAverage * worstSize - margin - addedCost / lever) / (worstSize * (1 - maintenanceMargin));
  }
  const lossAtStop = hasStop ? worstSize * (worstAverage - stop) + worstSize * stop * takerFee : null;
  const profitAtTarget = takeProfit > 0 ? size * (takeProfit - average) - size * takeProfit * takerFee : null;
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
    stopAboveLiquidation: hasStop && worstLiquidation > 0 ? stop / worstLiquidation - 1 : null,
    lossAtStop,
    profitAtTarget,
    lossShare: share(lossAtStop),
    profitShare: share(profitAtTarget),
    breakevenWinRate: lossAtStop > 0 && profitAtTarget > 0 ? lossAtStop / (lossAtStop + profitAtTarget) : null
  };
}
