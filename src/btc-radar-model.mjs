// Node port of the BTC risk radar scoring model (btc_alert.py). Rounding and
// number formatting reproduce Python exactly: round() and the "f" format spec
// round the exact binary value half-to-even, which toFixed() does not.

export const BTC_RADAR_LEVELS = Object.freeze(["green", "yellow", "orange", "red"]);

function exactParts(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const negative = high >>> 31 === 1;
  const exponentBits = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  let exponent = -1074;
  if (exponentBits !== 0) {
    mantissa |= 1n << 52n;
    exponent = exponentBits - 1075;
  }
  if (exponent >= 0) return { negative, digits: mantissa << BigInt(exponent), scale: 0 };
  return { negative, digits: mantissa * 5n ** BigInt(-exponent), scale: -exponent };
}

function scaledHalfEven(value, places) {
  if (!Number.isFinite(value)) throw new Error(`Cannot round non-finite value: ${value}`);
  const { negative, digits, scale } = exactParts(value);
  if (scale <= places) return { negative, units: digits * 10n ** BigInt(places - scale) };
  const divisor = 10n ** BigInt(scale - places);
  let units = digits / divisor;
  const twiceRemainder = (digits % divisor) * 2n;
  if (twiceRemainder > divisor || (twiceRemainder === divisor && units % 2n === 1n)) units += 1n;
  return { negative, units };
}

function decimalString(units, places) {
  const digits = units.toString().padStart(places + 1, "0");
  return places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
}

// Python f"{value:.{places}f}" with optional "+" and "," flags.
export function pyFixed(value, places, { sign = false, grouping = false } = {}) {
  const { negative, units } = scaledHalfEven(value, places);
  let [integer, fraction] = decimalString(units, places).split(".");
  if (grouping) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : sign ? "+" : ""}${integer}${fraction === undefined ? "" : `.${fraction}`}`;
}

// Python round(value) without ndigits: an int, half-to-even.
export function pyRoundInt(value) {
  const { negative, units } = scaledHalfEven(value, 0);
  return negative && units !== 0n ? -Number(units) : Number(units);
}

// Python round(value, places) for a float.
export function pyRound(value, places) {
  const { negative, units } = scaledHalfEven(value, places);
  return Number(`${negative ? "-" : ""}${decimalString(units, places)}`);
}

// Python 3.12+ sum() of floats uses Neumaier compensated summation.
function pySum(values) {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const next = total + value;
    compensation += Math.abs(total) >= Math.abs(value) ? (total - next) + value : (value - next) + total;
    total = next;
  }
  return compensation && Number.isFinite(compensation) ? total + compensation : total;
}

const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value));

function interp(ladder, target) {
  const points = Object.entries(ladder)
    .map(([price, probability]) => [Number(price), Number(probability)])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (!points.length) throw new Error("Empty probability ladder");
  if (target <= points[0][0]) return points[0][1];
  if (target >= points.at(-1)[0]) return points.at(-1)[1];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    if (x1 <= target && target <= x2) return y1 + (y2 - y1) * (target - x1) / (x2 - x1);
  }
  throw new Error("Probability ladder interpolation failed");
}

function level(score) {
  if (score >= 70) return ["red", "高风险"];
  if (score >= 55) return ["orange", "警戒"];
  if (score >= 40) return ["yellow", "中性"];
  return ["green", "偏多 / 低风险"];
}

const percent = (probability) => `${pyFixed(probability * 100, 0)}%`;

// Same output as btc_alert.py. One extension: sentiment may be null when the
// OKX news API is not configured; its term then contributes zero.
export function evaluateBtcRadar(input) {
  const price = input.price;
  const btc = input.btc_closes;
  const gold = input.gold_closes;
  const factors = [];

  const week = input.poly_week;
  const month = input.poly_month;
  const weekDown = interp(week.dips, price * 0.96);
  const weekUp = interp(week.reaches, price * 1.04);
  const monthDown = interp(month.dips, price * 0.92);
  const monthUp = interp(month.reaches, price * 1.08);
  let score = clamp(0.7 * (50 + (weekDown - weekUp) * 100) + 0.3 * (50 + (monthDown - monthUp) * 100));
  factors.push({
    key: "poly", name: "预测市场 Polymarket", weight: 25, score: pyRoundInt(score),
    metrics: [["本周跌 4%", percent(weekDown)], ["本周涨 4%", percent(weekUp)],
      ["本月跌 8%", percent(monthDown)], ["本月涨 8%", percent(monthUp)]],
    note: score >= 55 ? "下跌概率高于上涨" : score <= 42 ? "上涨概率高于下跌" : "涨跌概率接近"
  });

  const fed = input.fed;
  score = clamp(50 + 50 * (0.6 * (fed.p_hike_2026_any - fed.p_cut_2026_any) + 0.4 * (fed.p_hike_next - fed.p_cut_next)));
  factors.push({
    key: "fed", name: "美联储利率预期", weight: 20, score: pyRoundInt(score),
    metrics: [[`${fed.next_meeting}加息`, percent(fed.p_hike_next)], [`${fed.next_meeting}降息`, percent(fed.p_cut_next)],
      ["年内再加息", percent(fed.p_hike_2026_any)]],
    note: score >= 60 ? "市场押注加息，流动性收紧" : score < 40 ? "市场押注降息，流动性宽松" : "利率预期中性"
  });

  const treasury = input.treasury;
  const y10 = treasury[0].y10;
  const y2 = treasury[0].y2;
  const change10 = (y10 - treasury[Math.min(10, treasury.length - 1)].y10) * 100;
  score = clamp(50 + change10 + (y10 - 4.5) * 15);
  factors.push({
    key: "ust", name: "美债收益率", weight: 20, score: pyRoundInt(score),
    metrics: [["10年期", `${pyFixed(y10, 2)}%`], ["2年期", `${pyFixed(y2, 2)}%`],
      ["10年期 10日变化", `${pyFixed(change10, 0, { sign: true })}bp`], ["数据日期", treasury[0].date]],
    note: change10 > 10 ? "收益率快速上行，压制风险资产" : change10 < -10 ? "收益率下行，利好风险资产" : "收益率平稳"
  });

  const gold10 = (gold[0] / gold[Math.min(10, gold.length - 1)] - 1) * 100;
  const btc10 = (btc[0] / btc[Math.min(10, btc.length - 1)] - 1) * 100;
  score = clamp(50 - 5 * gold10);
  factors.push({
    key: "gold", name: "黄金 (XAUT)", weight: 10, score: pyRoundInt(score),
    metrics: [["金价", pyFixed(gold[0], 0, { grouping: true })], ["10日变化", `${pyFixed(gold10, 1, { sign: true })}%`],
      ["BTC 10日变化", `${pyFixed(btc10, 1, { sign: true })}%`]],
    note: gold10 < -2 ? "金价下跌，实际利率走高" : gold10 > 2 ? "金价走强，宽松预期升温" : "金价平稳"
  });

  const ma20 = pySum(btc.slice(0, 20)) / 20;
  const ma50 = pySum(btc.slice(0, 50)) / 50;
  const move7 = (btc[0] / btc[7] - 1) * 100;
  score = clamp(50 - 300 * (price / ma20 - 1) - 100 * (price / ma50 - 1) - 2 * move7);
  factors.push({
    key: "tech", name: "BTC 技术面", weight: 15, score: pyRoundInt(score),
    metrics: [["现价 / 20日均线", `${pyFixed((price / ma20 - 1) * 100, 1, { sign: true })}%`],
      ["现价 / 50日均线", `${pyFixed((price / ma50 - 1) * 100, 1, { sign: true })}%`],
      ["7日涨跌", `${pyFixed(move7, 1, { sign: true })}%`], ["20日均线", pyFixed(ma20, 0, { grouping: true })]],
    note: price < ma20 ? "跌破 20 日均线" : "站上 20 日均线"
  });

  const funding = pySum(input.funding) / input.funding.length * 10000;
  const openInterest = input.oi_7d_change_pct;
  const sentiment = input.sentiment;
  score = clamp(50 + (funding - 1) * 8 + openInterest + (sentiment ? (sentiment.bull - sentiment.bear - 0.3) * 30 : 0));
  factors.push({
    key: "deriv", name: "衍生品与情绪", weight: 10, score: pyRoundInt(score),
    metrics: [["资金费率均值", `${pyFixed(funding / 100, 4)}%`], ["持仓量 7日", `${pyFixed(openInterest, 1, { sign: true })}%`],
      ["舆情多 / 空", sentiment ? `${percent(sentiment.bull)} / ${percent(sentiment.bear)}` : "未接入"]],
    note: funding > 3 ? "多头拥挤" : openInterest < -3 ? "杠杆在出清" : "杠杆水平正常"
  });

  const total = factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0) / 100;
  const [riskLevel, levelName] = level(total);

  let position = null;
  if (input.position) {
    const held = input.position;
    const distance = (value) => (value / price - 1) * 100;
    const toStop = distance(held.sl);
    const [positionLevel, positionLevelName] = toStop > -3
      ? ["red", "接近止损"]
      : toStop > -5 ? ["orange", "离止损不远"] : ["green", "安全距离"];
    position = {
      ...held,
      d_sl: pyRound(toStop, 2),
      d_liq: pyRound(distance(held.liq), 2),
      d_tp: pyRound(distance(held.tp), 2),
      level: positionLevel,
      level_name: positionLevelName,
      p_sl_week: pyRound(interp(week.dips, held.sl), 3),
      p_tp_week: pyRound(interp(week.reaches, held.tp), 3)
    };
  }

  const top = [...factors].sort((left, right) => (-left.score * left.weight) - (-right.score * right.weight)).slice(0, 2);
  return {
    ts: input.ts,
    price,
    score: pyRound(total, 1),
    level: riskLevel,
    level_name: levelName,
    summary: `综合 ${pyFixed(total, 0)} 分（${levelName}）。主要压力来自${top[0].name}和${top[1].name}。`,
    factors,
    position,
    sources: input.sources || []
  };
}
