import { newYorkDate } from "./strategy-data.mjs";

export function rolloverRiskDay(state, nowMs = Date.now()) {
  const currentDate = newYorkDate(nowMs);
  const previousDate = state.date || null;
  if (previousDate === currentDate) {
    return { changed: false, previousDate, currentDate };
  }
  state.date = currentDate;
  state.realizedPnlUsdt = 0;
  state.realizedGrossPnlUsdt = 0;
  state.gasCostUsdt = 0;
  return { changed: true, previousDate, currentDate };
}
