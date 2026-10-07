// BTC trend state from completed UTC daily closes. A close more than the band
// above its 200-day average starts a long environment; more than the band below
// starts an avoid environment (hold no long exposure — not a short signal);
// inside the band the previous state holds. scripts/btc-signal-study/robust.mjs
// backtests this same function; see docs/2026-10-06-btc-strong-signal-research.md.

export const BTC_TREND_DAYS = 200;
export const BTC_TREND_BAND = 0.03;
export const BTC_TREND_LABELS = Object.freeze({ LONG: "多头环境", AVOID: "回避环境" });

// `closes` is [{ date: "YYYY-MM-DD", close }] oldest first. Returns one row per
// day with a full average; `state` stays null until the first close outside
// the band.
export function btcTrendHistory(closes, { days = BTC_TREND_DAYS, band = BTC_TREND_BAND } = {}) {
  const rows = [];
  let state = null;
  for (let index = days - 1; index < closes.length; index += 1) {
    const average = closes.slice(index - days + 1, index + 1).reduce((sum, { close }) => sum + close, 0) / days;
    const { date, close } = closes[index];
    if (close > average * (1 + band)) state = "LONG";
    else if (close < average * (1 - band)) state = "AVOID";
    rows.push({ date, close, average, state });
  }
  return rows;
}

// The latest state and when it began. `since` and `previous` are null when no
// switch between the two states appears in the supplied closes.
export function btcTrendSummary(closes, { days = BTC_TREND_DAYS, band = BTC_TREND_BAND } = {}) {
  const rows = btcTrendHistory(closes, { days, band });
  if (!rows.length) return null;
  const last = rows.at(-1);
  let start = rows.length - 1;
  while (start > 0 && rows[start - 1].state === last.state) start -= 1;
  const previous = start > 0 && last.state ? rows[start - 1].state : null;
  return {
    date: last.date,
    close: last.close,
    average: Number(last.average.toFixed(2)),
    distance: Number((last.close / last.average - 1).toFixed(5)),
    band,
    state: last.state,
    since: previous ? rows[start].date : null,
    previous
  };
}
