import { addDays, daysBetween } from "./date.ts";
import { TIMEZONE, todayInZone } from "./time.ts";
import { normalizeAll, type NormalizedRecord } from "./records.ts";
import type { PiyoRecord } from "./types.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** A longer gap means a WakeUp or Sleep was probably not recorded. */
const MAX_SLEEP_MS = 14 * 60 * MINUTE_MS;
/** Feeds that start this close together count as one session. */
const FEEDING_SESSION_MS = 30 * MINUTE_MS;
const MILK_TYPES = new Set(["BreastFeeding", "Formula", "ExpressedBreastMilk"]);

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00+09:00`);
}

function emptyRow(date: string, today: string) {
  return {
    date,
    /** Today is still in progress and is left out of averages. */
    partial: date >= today,
    recordCount: 0,
    feedingSessions: 0,
    totalMilkMl: 0,
    breastCount: 0,
    breastSeconds: 0,
    breastMl: 0,
    formulaCount: 0,
    formulaMl: 0,
    expressedCount: 0,
    expressedMl: 0,
    pumpingCount: 0,
    pumpingMl: 0,
    solidCount: 0,
    mealCount: 0,
    snackCount: 0,
    drinkCount: 0,
    drinkMl: 0,
    peeCount: 0,
    poopCount: 0,
    sleepCount: 0,
    sleepMinutes: null as number | null,
    longestSleepMinutes: null as number | null,
    averageFeedingIntervalMinutes: null as number | null,
    longestFeedingIntervalMinutes: null as number | null,
    /** Sleep or WakeUp records that could not be paired, left out of sleepMinutes. */
    unpairedSleepRecords: 0,
    /** Amounts in a unit other than ml, left out of the ml totals. */
    unsummedAmounts: 0,
  };
}

export type DaySummary = ReturnType<typeof emptyRow>;

/** Recorded ml, or null when there is none. Breast milk is never estimated from time. */
function recordedMl(record: NormalizedRecord): { ml: number | null; unsummed: boolean } {
  const amount = record.amount;
  if (!amount) {
    return { ml: null, unsummed: false };
  }
  let value = typeof amount.value === "number" ? amount.value : null;
  if (value === null && record.type === "Pumping" && (typeof amount.left === "number" || typeof amount.right === "number")) {
    value = (amount.left ?? 0) + (amount.right ?? 0);
  }
  if (value === null) {
    return { ml: null, unsummed: false };
  }
  if (amount.unit && amount.unit.toLowerCase() !== "ml") {
    return { ml: null, unsummed: true };
  }
  return { ml: value, unsummed: false };
}

function addRecord(row: DaySummary, record: NormalizedRecord): void {
  row.recordCount += 1;
  if (record.type === "Pee") row.peeCount += 1;
  if (record.type === "Poop") row.poopCount += 1;
  if (!["breast", "milk", "pumping", "food"].includes(record.kind)) {
    return;
  }
  const { ml, unsummed } = recordedMl(record);
  switch (record.type) {
    case "BreastFeeding":
      row.breastCount += 1;
      row.breastMl += ml ?? 0;
      if (record.kind === "breast") {
        row.breastSeconds += (record.leftSeconds ?? 0) + (record.rightSeconds ?? 0);
      }
      break;
    case "Formula":
      row.formulaCount += 1;
      row.formulaMl += ml ?? 0;
      break;
    case "ExpressedBreastMilk":
      row.expressedCount += 1;
      row.expressedMl += ml ?? 0;
      break;
    case "Pumping":
      row.pumpingCount += 1;
      row.pumpingMl += ml ?? 0;
      break;
    case "Drink":
      row.drinkCount += 1;
      row.drinkMl += ml ?? 0;
      break;
    case "Solid":
      row.solidCount += 1;
      return;
    case "Meal":
      row.mealCount += 1;
      return;
    case "Snack":
      row.snackCount += 1;
      return;
  }
  row.unsummedAmounts += unsummed ? 1 : 0;
  row.totalMilkMl = row.breastMl + row.formulaMl + row.expressedMl;
}

export function pairSleep(sorted: NormalizedRecord[], now: number) {
  const sessions: Array<{ start: number; end: number; endDate: string }> = [];
  const unpaired: NormalizedRecord[] = [];
  let open: NormalizedRecord | null = null;
  for (const record of sorted) {
    const time = Date.parse(record.datetime);
    if (time > now) {
      continue;
    }
    if (record.kind === "sleep") {
      if (open) unpaired.push(open);
      open = record;
    } else if (record.kind === "wake") {
      const start: number = open ? Date.parse(open.datetime) : Number.NaN;
      if (open && time - start <= MAX_SLEEP_MS) {
        sessions.push({ start, end: time, endDate: record.date });
      } else {
        if (open) unpaired.push(open);
        unpaired.push(record);
      }
      open = null;
    }
  }
  if (open && now - Date.parse(open.datetime) <= MAX_SLEEP_MS) {
    return { sessions, unpaired, ongoing: open };
  }
  if (open) unpaired.push(open);
  return { sessions, unpaired, ongoing: null };
}

function feedingIntervals(sorted: NormalizedRecord[], now: number): Array<{ date: string; minutes: number | null }> {
  const sessions: Array<{ date: string; minutes: number | null }> = [];
  let previous: number | null = null;
  for (const record of sorted) {
    const time = Date.parse(record.datetime);
    if (!MILK_TYPES.has(record.type) || time > now) {
      continue;
    }
    if (previous !== null && time - previous < FEEDING_SESSION_MS) {
      continue;
    }
    sessions.push({ date: record.date, minutes: previous === null ? null : Math.round((time - previous) / MINUTE_MS) });
    previous = time;
  }
  return sessions;
}

/** Records should include the day before `from`, so sleep and intervals that cross midnight are found. */
export function summarizeDays(sorted: NormalizedRecord[], from: string, to: string, now = new Date()): DaySummary[] {
  const today = todayInZone(now);
  const rows = new Map<string, DaySummary>();
  for (let date = from; date <= to; date = addDays(date, 1)) {
    rows.set(date, emptyRow(date, today));
  }
  for (const record of sorted) {
    const row = rows.get(record.date);
    if (row) addRecord(row, record);
  }

  const { sessions, unpaired } = pairSleep(sorted, now.getTime());
  for (const session of sessions) {
    for (const row of rows.values()) {
      const start = dayStart(row.date);
      const overlap = Math.min(session.end, start + DAY_MS) - Math.max(session.start, start);
      if (overlap > 0) {
        row.sleepMinutes = (row.sleepMinutes ?? 0) + overlap / MINUTE_MS;
      }
    }
    const ended = rows.get(session.endDate);
    if (ended) {
      ended.sleepCount += 1;
      ended.longestSleepMinutes = Math.max(
        ended.longestSleepMinutes ?? 0,
        Math.round((session.end - session.start) / MINUTE_MS),
      );
    }
  }
  for (const record of unpaired) {
    const row = rows.get(record.date);
    if (row) row.unpairedSleepRecords += 1;
  }

  const intervals = new Map<string, number[]>();
  for (const session of feedingIntervals(sorted, now.getTime())) {
    const row = rows.get(session.date);
    if (!row) continue;
    row.feedingSessions += 1;
    if (session.minutes !== null) {
      intervals.set(session.date, [...(intervals.get(session.date) ?? []), session.minutes]);
    }
  }
  for (const row of rows.values()) {
    if (row.sleepMinutes !== null) row.sleepMinutes = Math.round(row.sleepMinutes);
    const list = intervals.get(row.date);
    if (list) {
      row.averageFeedingIntervalMinutes = Math.round(list.reduce((sum, item) => sum + item, 0) / list.length);
      row.longestFeedingIntervalMinutes = Math.max(...list);
    }
  }
  return [...rows.values()];
}

const AVERAGED = [
  "feedingSessions",
  "totalMilkMl",
  "breastCount",
  "breastSeconds",
  "formulaMl",
  "expressedMl",
  "pumpingMl",
  "solidCount",
  "mealCount",
  "peeCount",
  "poopCount",
  "sleepMinutes",
  "longestSleepMinutes",
  "averageFeedingIntervalMinutes",
] as const;

/** Per-day averages over finished days that have records. */
function summarizePeriod(rows: DaySummary[]) {
  const counted = rows.filter((row) => !row.partial && row.recordCount > 0);
  const averages: Record<string, number | null> = {};
  for (const key of AVERAGED) {
    const values = counted.map((row) => row[key]).filter((value): value is number => value !== null);
    averages[key] =
      values.length === 0 ? null : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
  }
  return {
    from: rows[0]?.date ?? "",
    to: rows.at(-1)?.date ?? "",
    dayCount: rows.length,
    averagedDays: counted.length,
    averages,
  };
}

export type SummaryQuery = { from: string; to: string; groupBy: "day" | "week"; compare: boolean };

export function previousRange(from: string, to: string): { from: string; to: string } {
  return { from: addDays(from, -daysBetween(from, to)), to: addDays(from, -1) };
}

export function buildSummary(records: PiyoRecord[], query: SummaryQuery, now = new Date()) {
  const sorted = normalizeAll(records);
  const rows = summarizeDays(sorted, query.from, query.to, now);
  const overall = summarizePeriod(rows);
  const weeks = [];
  for (let index = 0; index < rows.length; index += 7) {
    weeks.push(summarizePeriod(rows.slice(index, index + 7)));
  }
  const before = previousRange(query.from, query.to);
  const previous = query.compare ? summarizePeriod(summarizeDays(sorted, before.from, before.to, now)) : null;
  const change: Record<string, number | null> = {};
  if (previous) {
    for (const key of AVERAGED) {
      const current = overall.averages[key] ?? null;
      const base = previous.averages[key] ?? null;
      change[key] = current === null || base === null ? null : Math.round((current - base) * 10) / 10;
    }
  }
  return {
    timezone: TIMEZONE,
    overall,
    ...(query.groupBy === "week" ? { weeks } : { days: rows }),
    ...(previous ? { previous, change } : {}),
    measurements: sorted
      .filter((record) => record.kind === "measurement" && record.date >= query.from && record.date <= query.to)
      .map(({ eventId, date, time, type, label, amount }) => ({ eventId, date, time, type, label, amount })),
    notes: [
      "平均は記録のある完了した日だけを使い、今日を含めません。",
      "睡眠は日本時間0時で日に分けます。対がない、または14時間を超える記録は合計に入れず unpairedSleepRecords に数えます。",
      "最長睡眠と回数は起きた日に数えます。進行中の睡眠は含めません。",
      "授乳間隔は開始時刻どうしの間隔です。開始から30分未満の授乳は1回にまとめます。",
      "母乳mlは記録がある分だけです。授乳時間から推定していません。",
    ],
  };
}

const LATEST = {
  feeding: ["BreastFeeding", "Formula", "ExpressedBreastMilk"],
  breast: ["BreastFeeding"],
  formula: ["Formula"],
  sleep: ["Sleep"],
  wake: ["WakeUp"],
  pee: ["Pee"],
  poop: ["Poop"],
  bath: ["Bath"],
  medicine: ["Medicine"],
  temperature: ["Temperature"],
  weight: ["Weight"],
  height: ["Height"],
} as const;

export function buildLatest(records: PiyoRecord[], now = new Date()) {
  const past = normalizeAll(records).filter((record) => Date.parse(record.datetime) <= now.getTime());
  const latest: Record<string, (NormalizedRecord & { minutesAgo: number }) | null> = {};
  for (const [name, types] of Object.entries(LATEST)) {
    const record = past.findLast((item) => (types as readonly string[]).includes(item.type));
    latest[name] = record
      ? { ...record, minutesAgo: Math.floor((now.getTime() - Date.parse(record.datetime)) / MINUTE_MS) }
      : null;
  }
  const today = todayInZone(now);
  const ongoing = pairSleep(past, now.getTime()).ongoing;
  return {
    timezone: TIMEZONE,
    now: now.toISOString(),
    today,
    /** Set only when the last Sleep has no WakeUp yet. */
    sleepingSince: ongoing?.datetime ?? null,
    latest,
    todaySummary: summarizeDays(past, today, today, now)[0] ?? null,
  };
}
