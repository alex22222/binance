const NYSE_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25"
]);

const NYSE_EARLY_CLOSES = new Set([
  "2026-11-27", "2026-12-24",
  "2027-11-26",
  "2028-07-03", "2028-11-24"
]);

const FOMC_ENTRY_BLACKOUT_START_MINUTE = 13 * 60 + 50;
const FOMC_ENTRY_BLACKOUT_END_MINUTE = 15 * 60 + 15;

function newYorkTimeParts(nowMs) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(nowMs)).map(({ type, value }) => [type, value])
  );
}

export function nyseSessionPlan(nowMs = Date.now()) {
  const parts = newYorkTimeParts(nowMs);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const year = Number(parts.year);
  if (year < 2026 || year > 2028) {
    return {
      calendarSupported: false,
      date,
      calendarDayType: "unsupported",
      regularOpen: false,
      openTime: null,
      closeTime: null
    };
  }
  if (["Sat", "Sun"].includes(parts.weekday)) {
    return {
      calendarSupported: true,
      date,
      calendarDayType: "weekend",
      regularOpen: false,
      openTime: null,
      closeTime: null
    };
  }
  if (NYSE_HOLIDAYS.has(date)) {
    return {
      calendarSupported: true,
      date,
      calendarDayType: "holiday",
      regularOpen: false,
      openTime: null,
      closeTime: null
    };
  }
  const earlyClose = NYSE_EARLY_CLOSES.has(date);
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  const closeMinute = earlyClose ? 13 * 60 : 16 * 60;
  return {
    calendarSupported: true,
    date,
    calendarDayType: earlyClose ? "early-close" : "regular-day",
    regularOpen: minuteOfDay >= 9 * 60 + 30 && minuteOfDay < closeMinute,
    openTime: "09:30",
    closeTime: earlyClose ? "13:00" : "16:00"
  };
}

