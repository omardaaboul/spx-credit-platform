const ET_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function etWeekdayHourMinute(now: Date): { weekday: string; hour: number; minute: number } {
  const parts = ET_TIME_FMT.formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return {
    weekday,
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

export function isUsRthEt(now: Date): boolean {
  const { weekday, hour, minute } = etWeekdayHourMinute(now);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutesSinceMidnight = hour * 60 + minute;
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return minutesSinceMidnight >= open && minutesSinceMidnight < close;
}

export function selectChartInstrument(now: Date): "SPX" | "ES" {
  return isUsRthEt(now) ? "SPX" : "ES";
}

export function classifyProxyMode(lastBarAgeMs: number | null): "LIVE" | "DELAYED" {
  if (lastBarAgeMs == null) return "DELAYED";
  if (lastBarAgeMs <= 120_000) return "LIVE";
  return "DELAYED";
}

