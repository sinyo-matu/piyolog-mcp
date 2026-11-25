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
