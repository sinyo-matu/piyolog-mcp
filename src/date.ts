export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** Empty means today. Anything else must be a real YYYY-MM-DD date. */
export function resolveDate(date: string | undefined, today: string): string {
  const value = date?.trim();
  if (!value) {
    return today;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) {
      return value;
    }
  }
  throw new Error("date は実在する日付を YYYY-MM-DD で指定してください");
}

/**
 * Resolves an inclusive from..to range. Empty to means today; empty from means
 * defaultDays days ending at to (1 = just that day).
 */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  today: string,
  defaultDays = 1,
): { start: string; end: string } {
  const end = resolveDate(to, today);
  const start = resolveDate(from, addDays(end, 1 - defaultDays));
  if (start > end) {
    throw new Error("from は to 以前の日付にしてください");
  }
  return { start, end };
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive number of dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1;
}
