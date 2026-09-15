import { tradingDates } from "./strategy-data.mjs";

// Research daily calendar only. Live intraday session rules remain untouched.
// NYSE Rule 7.2; Juneteenth starts in 2022; Carter mourning closure 2025-01-09.
// https://www.nyse.com/markets/hours-calendars
const HISTORICAL_HOLIDAYS = new Set([
  "2020-01-01", "2020-01-20", "2020-02-17", "2020-04-10", "2020-05-25", "2020-07-03", "2020-09-07", "2020-11-26", "2020-12-25",
  "2021-01-01", "2021-01-18", "2021-02-15", "2021-04-02", "2021-05-31", "2021-07-05", "2021-09-06", "2021-11-25", "2021-12-24",
  "2022-01-17", "2022-02-21", "2022-04-15", "2022-05-30", "2022-06-20", "2022-07-04", "2022-09-05", "2022-11-24", "2022-12-26",
  "2023-01-02", "2023-01-16", "2023-02-20", "2023-04-07", "2023-05-29", "2023-06-19", "2023-07-04", "2023-09-04", "2023-11-23", "2023-12-25",
  "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25",
  "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"
]);

export function researchTradingDates(start, end) {
  if (start < "2020-01-01" || end > "2028-12-31" || start > end) throw new Error("Unsupported research calendar range");
  const dates = [];
  for (let timestamp = Date.parse(start); timestamp <= Math.min(Date.parse(end), Date.parse("2025-12-31")); timestamp += 86400000) {
    const date = new Date(timestamp).toISOString().slice(0, 10), day = new Date(timestamp).getUTCDay();
    if (day !== 0 && day !== 6 && !HISTORICAL_HOLIDAYS.has(date)) dates.push(date);
  }
  if (end >= "2026-01-01") dates.push(...tradingDates(start > "2026-01-01" ? start : "2026-01-01", end));
  return dates;
}
