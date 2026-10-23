// BTC pressure model. Non-Polymarket factor formulas retain the original port.
// Calendar touch contracts are quotes only, not future barrier probabilities.
// Rounding and
// number formatting reproduce Python exactly: round() and the "f" format spec
// round the exact binary value half-to-even, which toFixed() does not.

export const BTC_RADAR_LEVELS = Object.freeze(["green", "yellow", "orange", "red"]);
export const BTC_RADAR_MODEL_VERSION = "pressure-v2-no-touch-probability";

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

function level(score) {
  if (score >= 70) return ["red", "高风险"];
  if (score >= 55) return ["orange", "警戒"];
  if (score >= 40) return ["yellow", "中性"];
  return ["green", "下跌压力较低（未验证）"];
}

const percent = (probability) => `${pyFixed(probability * 100, 0)}%`;

export function evaluateRadarPosition(held, price) {
  const referencePrice = held.last_price > 0 ? held.last_price : price;
  const short = held.direction === "short";
  const stopPrice = held.sl_price_type === "mark" ? held.mark_price : referencePrice;
  const targetPrice = held.tp_price_type === "mark" ? held.mark_price : referencePrice;
  const distance = (value, reference) => value > 0 && reference > 0 ? pyRound((value / reference - 1) * 100, 2) : null;
  const toStop = (held.sl / stopPrice - 1) * 100;
  const adverseDistance = short ? -toStop : toStop;
  const markPrice = held.mark_price > 0 ? held.mark_price : referencePrice;
  const toLiquidation = held.liq > 0 && markPrice > 0 ? (short ? 1 - held.liq / markPrice : held.liq / markPrice - 1) * 100 : null;
  const liquidationFirst = held.liq > 0 && held.sl > 0 && (short ? held.sl >= held.liq : held.sl <= held.liq);
  const [positionLevel, positionLevelName, reason] = held.stale
    ? ["yellow", "持仓数据非最新", "STALE_POSITION"]
    : liquidationFirst ? ["red", "止损不先于强平", "LIQUIDATION_BEFORE_STOP"]
      : toLiquidation !== null && toLiquidation > -3 ? ["red", "接近强平", "NEAR_LIQUIDATION"]
        : !(held.sl > 0 && stopPrice > 0) ? ["yellow", "止损未确认", "STOP_UNKNOWN"]
          : adverseDistance > -3 ? ["red", "接近止损", "NEAR_STOP"]
            : toLiquidation !== null && toLiquidation > -5 ? ["orange", "离强平不远", "NEAR_LIQUIDATION"]
              : adverseDistance > -5 ? ["orange", "离止损不远", "NEAR_STOP"]
                : toLiquidation === null ? ["yellow", "强平价未确认", "LIQUIDATION_UNKNOWN"]
                  : ["green", "距止损至少 5%（仅距离参考）", "DISTANCE_ONLY"];
  return {
    ...held,
    ...(held.source ? { reference_price: referencePrice } : {}),
    d_sl: distance(held.sl, stopPrice), d_liq: distance(held.liq, held.mark_price > 0 ? held.mark_price : referencePrice), d_tp: distance(held.tp, targetPrice),
    level: positionLevel, level_name: positionLevelName, risk_reason: reason,
    p_sl_week: null, p_tp_week: null
  };
}

// Sentiment may be null when the OKX news API is not configured.
export function evaluateBtcRadar(input) {
  const price = input.price;
  const btc = input.btc_closes;
  const gold = input.gold_closes;
  const factors = [];

  const quote = (period, side, below) => {
    const points = Object.entries(period?.[side] || {}).map(([px, yes]) => [Number(px), Number(yes)])
      .filter(([px, yes]) => px > 0 && yes >= 0 && yes < 1 && (below ? px < price : px > price))
      .sort((a, b) => Math.abs(a[0] - price) - Math.abs(b[0] - price));
    return points.length ? `$${pyFixed(points[0][0], 0, { grouping: true })} · Yes ${pyFixed(points[0][1] * 100, 1)}¢` : "暂无有效报价";
  };
  factors.push({
    key: "poly", name: "预测市场 Polymarket", weight: 0, score: null,
    metrics: [["本周下沿触价盘", quote(input.poly_week, "dips", true)], ["本周上沿触价盘", quote(input.poly_week, "reaches", false)],
      ["本月下沿触价盘", quote(input.poly_month, "dips", true)], ["本月上沿触价盘", quote(input.poly_month, "reaches", false)]],
    note: "仅展示有效合约原始 Yes 报价，各自按合约约定区间结算；不是从现在起的触价概率，不插值、不计分。"
  });

  const fed = input.fed;
  let score = clamp(50 + 50 * (0.6 * (fed.p_hike_2026_any - fed.p_cut_2026_any) + 0.4 * (fed.p_hike_next - fed.p_cut_next)));
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

  const scored = factors.filter(factor => factor.weight > 0);
  const total = scored.reduce((sum, factor) => sum + factor.score * factor.weight, 0) / scored.reduce((sum, factor) => sum + factor.weight, 0);
  const [riskLevel, levelName] = level(total);

  const position = input.position ? evaluateRadarPosition(input.position, price) : null;

  const top = [...scored].sort((left, right) => (-left.score * left.weight) - (-right.score * right.weight)).slice(0, 2);
  return {
    ts: input.ts,
    modelVersion: BTC_RADAR_MODEL_VERSION,
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
