export const TIMEZONE = "Asia/Tokyo";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedParts(isoUtc: string, timeZone = TIMEZONE): { date: string; time: string } {
  const date = new Date(isoUtc);
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
  };
}

export function todayInZone(now = new Date(), timeZone = TIMEZONE): string {
  return zonedParts(now.toISOString(), timeZone).date;
}
