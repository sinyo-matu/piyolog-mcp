import {
  FEEDING_TYPES,
  TYPE_LABELS,
  type DashboardPayload,
  type DayFeeding,
  type FeedingEvent,
  type FeedSnapshot,
  type MemoItem,
  type PiyoRecord,
  type WeightPoint,
} from "./types";

export const TIMEZONE = "Asia/Tokyo";

const FEEDING_SET = new Set<string>(FEEDING_TYPES);

export function zonedParts(isoUtc: string, timeZone = TIMEZONE): { date: string; time: string } {
  const date = new Date(isoUtc);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
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

export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes === 0) {
    return `${rest}秒`;
  }
  if (rest === 0) {
    return `${minutes}分`;
  }
  return `${minutes}分${rest}秒`;
}

export function emptyDay(date: string): DayFeeding {
  return {
    date,
    formulaMl: 0,
    expressedMl: 0,
    breastMl: 0,
    pumpingMl: 0,
    drinkMl: 0,
    totalMilkMl: 0,
    breastSeconds: 0,
    breastCount: 0,
    formulaCount: 0,
    expressedCount: 0,
    pumpingCount: 0,
    solidCount: 0,
    snackCount: 0,
    mealCount: 0,
    drinkCount: 0,
    events: [],
  };
}

export function toFeedingEvent(record: PiyoRecord, timeZone = TIMEZONE): FeedingEvent | null {
  if (!FEEDING_SET.has(record.type)) {
    return null;
  }
  const local = zonedParts(record.datetime, timeZone);
  const volumeMl = typeof record.value?.value === "number" ? record.value.value : undefined;
  const event: FeedingEvent = {
    eventId: record.event_id,
    datetime: record.datetime,
    localDate: local.date,
    localTime: local.time,
    type: record.type,
    label: TYPE_LABELS[record.type] ?? record.type,
    memo: record.memo,
    volumeMl,
    leftSeconds: record.leftTime,
    rightSeconds: record.rightTime,
    lastSide: record.last,
    summary: "",
  };
  event.summary = summarizeFeeding(event);
  return event;
}

export function summarizeFeeding(event: FeedingEvent): string {
  const bits: string[] = [event.label];
  if (event.type === "BreastFeeding") {
    const sides: string[] = [];
    if (event.leftSeconds) {
      sides.push(`左${formatDuration(event.leftSeconds)}`);
    }
    if (event.rightSeconds) {
      sides.push(`右${formatDuration(event.rightSeconds)}`);
    }
    if (sides.length > 0) {
      bits.push(sides.join(" / "));
    }
    if (event.lastSide === "left") {
      bits.push("最後は左");
    } else if (event.lastSide === "right") {
      bits.push("最後は右");
    }
  }
  if (event.volumeMl != null) {
    bits.push(`${event.volumeMl}ml`);
  }
  if (event.memo) {
    bits.push(event.memo);
  }
  return bits.join(" · ");
}

function applyEvent(day: DayFeeding, event: FeedingEvent): void {
  day.events.push(event);
  switch (event.type) {
    case "Formula":
      day.formulaCount += 1;
      day.formulaMl += event.volumeMl ?? 0;
      break;
    case "ExpressedBreastMilk":
      day.expressedCount += 1;
      day.expressedMl += event.volumeMl ?? 0;
      break;
    case "BreastFeeding":
      day.breastCount += 1;
      day.breastMl += event.volumeMl ?? 0;
      day.breastSeconds += (event.leftSeconds ?? 0) + (event.rightSeconds ?? 0);
      break;
    case "Pumping":
      day.pumpingCount += 1;
      day.pumpingMl += event.volumeMl ?? 0;
      break;
    case "Solid":
      day.solidCount += 1;
      break;
    case "Snack":
      day.snackCount += 1;
      break;
    case "Meal":
      day.mealCount += 1;
      break;
    case "Drink":
      day.drinkCount += 1;
      day.drinkMl += event.volumeMl ?? 0;
      break;
    default:
      break;
  }
  day.totalMilkMl = day.formulaMl + day.expressedMl + day.breastMl;
}

export function buildDashboard(snapshot: FeedSnapshot, timeZone = TIMEZONE, now = new Date()): DashboardPayload {
  const today = todayInZone(now, timeZone);
  const days = new Map<string, DayFeeding>();
  const weights: WeightPoint[] = [];
  const memos: MemoItem[] = [];

  for (const record of snapshot.records) {
    const local = zonedParts(record.datetime, timeZone);
    const feeding = toFeedingEvent(record, timeZone);
    if (feeding) {
      const day = days.get(feeding.localDate) ?? emptyDay(feeding.localDate);
      applyEvent(day, feeding);
      days.set(feeding.localDate, day);
    }
    if (record.type === "Weight" && typeof record.value?.value === "number") {
      weights.push({
        date: local.date,
        datetime: record.datetime,
        kg: record.value.value,
      });
    }
    if (record.memo && record.memo.trim() !== "") {
      memos.push({
        eventId: record.event_id,
        datetime: record.datetime,
        localDate: local.date,
        localTime: local.time,
        type: record.type,
        label: TYPE_LABELS[record.type] ?? record.type,
        memo: record.memo,
      });
    }
  }

  const dayList = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of dayList) {
    day.events.sort((a, b) => a.datetime.localeCompare(b.datetime));
  }

  const todayFeeding = days.get(today) ?? emptyDay(today);
  const lastFeeding =
    [...dayList].reverse().flatMap((day) => [...day.events].reverse())[0] ??
    null;

  return {
    timezone: timeZone,
    generatedAt: snapshot.generated_at,
    range: snapshot.range,
    today,
    todayFeeding,
    days: dayList,
    weights,
    memos: memos.slice(-30).reverse(),
    lastFeeding,
  };
}

export function getDay(dashboard: DashboardPayload, date: string): DayFeeding {
  return dashboard.days.find((item) => item.date === date) ?? emptyDay(date);
}

export function formatDayText(day: DayFeeding): string {
  const lines = [
    `## ${day.date} の食事`,
    `- ミルク合計: ${day.totalMilkMl}ml（粉ミルク ${day.formulaMl}ml / 搾母乳 ${day.expressedMl}ml / 母乳量入力 ${day.breastMl}ml）`,
    `- 母乳時間: ${formatDuration(day.breastSeconds)}（${day.breastCount}回）`,
    `- 粉ミルク: ${day.formulaCount}回`,
    `- 離乳食: ${day.solidCount} · ごはん: ${day.mealCount} · おやつ: ${day.snackCount}`,
    "",
    "### タイムライン",
  ];
  if (day.events.length === 0) {
    lines.push("記録なし");
    return lines.join("\n");
  }
  for (const event of day.events) {
    lines.push(`- ${event.localTime} ${event.summary}`);
  }
  return lines.join("\n");
}

export function formatRecordLine(record: PiyoRecord): string {
  const local = zonedParts(record.datetime);
  const label = TYPE_LABELS[record.type] ?? record.type;
  const bits: string[] = [`${local.time} ${label}`];
  if (record.type === "BreastFeeding") {
    const sides: string[] = [];
    if (record.leftTime) sides.push(`左${formatDuration(record.leftTime)}`);
    if (record.rightTime) sides.push(`右${formatDuration(record.rightTime)}`);
    if (sides.length > 0) bits.push(sides.join(" / "));
  }
  if (typeof record.value?.value === "number") {
    const unit = record.value.unit ?? (record.type === "Weight" ? "kg" : record.type === "Temperature" ? "℃" : "");
    bits.push(`${record.value.value}${unit}`);
  }
  if (record.memo) bits.push(record.memo);
  return `- ${bits.join(" · ")}`;
}

export function recordsOnDate(snapshot: FeedSnapshot, date: string): PiyoRecord[] {
  return snapshot.records
    .filter((record) => zonedParts(record.datetime).date === date)
    .sort((left, right) => left.datetime.localeCompare(right.datetime));
}

export function lastRecordOfTypes(snapshot: FeedSnapshot, types: string[]): PiyoRecord | null {
  let latest: PiyoRecord | null = null;
  for (const record of snapshot.records) {
    if (!types.includes(record.type)) continue;
    if (!latest || record.datetime > latest.datetime) latest = record;
  }
  return latest;
}

export function formatDayOverviewText(snapshot: FeedSnapshot, dashboard: DashboardPayload, date: string): string {
  const day = getDay(dashboard, date);
  const records = recordsOnDate(snapshot, date);
  const lines = [formatDayText(day), "", "### 食事以外も含む全記録"];
  if (records.length === 0) {
    lines.push("記録なし");
    return lines.join("\n");
  }
  for (const record of records) {
    lines.push(formatRecordLine(record));
  }
  return lines.join("\n");
}

export function formatLatestText(snapshot: FeedSnapshot, dashboard: DashboardPayload, child = "Baby"): string {
  const day = dashboard.todayFeeding;
  const lastSleep = lastRecordOfTypes(snapshot, ["Sleep"]);
  const lastWake = lastRecordOfTypes(snapshot, ["WakeUp"]);
  const lastPee = lastRecordOfTypes(snapshot, ["Pee"]);
  const lastPoop = lastRecordOfTypes(snapshot, ["Poop"]);
  const lastWeight = dashboard.weights.at(-1);
  const lastFeeding = dashboard.lastFeeding;
  const lines = [
    `## ${child}の最新記録（${dashboard.today} JST）`,
    lastFeeding
      ? `- 最終授乳: ${lastFeeding.localDate} ${lastFeeding.localTime} ${lastFeeding.summary}`
      : "- 最終授乳: なし",
    `- 今日のミルク合計: ${day.totalMilkMl}ml（粉ミルク ${day.formulaMl}ml / 搾母乳 ${day.expressedMl}ml / 母乳量 ${day.breastMl}ml）`,
    `- 今日の母乳時間: ${formatDuration(day.breastSeconds)}（${day.breastCount}回）`,
    lastWeight ? `- 直近の体重: ${lastWeight.date} ${lastWeight.kg}kg` : "- 直近の体重: なし",
    lastSleep ? `- 直近の睡眠: ${zonedParts(lastSleep.datetime).date} ${formatRecordLine(lastSleep).slice(2)}` : "- 直近の睡眠: なし",
    lastWake ? `- 直近の起床: ${zonedParts(lastWake.datetime).date} ${formatRecordLine(lastWake).slice(2)}` : "- 直近の起床: なし",
    lastPee ? `- 直近のおしっこ: ${zonedParts(lastPee.datetime).date} ${formatRecordLine(lastPee).slice(2)}` : "- 直近のおしっこ: なし",
    lastPoop ? `- 直近のうんち: ${zonedParts(lastPoop.datetime).date} ${formatRecordLine(lastPoop).slice(2)}` : "- 直近のうんち: なし",
    "",
    "### 今日のタイムライン",
  ];
  const todayRecords = recordsOnDate(snapshot, dashboard.today);
  if (todayRecords.length === 0) {
    lines.push("記録なし");
  } else {
    for (const record of todayRecords) {
      lines.push(formatRecordLine(record));
    }
  }
  return lines.join("\n");
}

export function formatWeightText(dashboard: DashboardPayload): string {
  if (dashboard.weights.length === 0) {
    return "体重記録なし";
  }
  return ["## 体重推移", ...dashboard.weights.map((item) => `- ${item.date}: ${item.kg}kg`)].join("\n");
}

export function formatRecentText(events: FeedingEvent[]): string {
  if (events.length === 0) {
    return "直近の食事記録なし";
  }
  return ["## 直近の食事", ...events.map((event) => `- ${event.localDate} ${event.localTime} ${event.summary}`)].join("\n");
}

export function dailyStats(dashboard: DashboardPayload, from?: string, to?: string) {
  return dashboard.days.filter((day) => {
    if (from && day.date < from) return false;
    if (to && day.date > to) return false;
    return true;
  });
}

export function formatDailyStatsText(dashboard: DashboardPayload, from?: string, to?: string): string {
  const days = dailyStats(dashboard, from, to);
  if (days.length === 0) {
    return "集計できる日がありません";
  }
  const range = from || to ? `（${from ?? "開始"}〜${to ?? "終了"}）` : "";
  return [
    `## 日ごとの食事集計${range}`,
    ...days.map(
      (day) =>
        `- ${day.date}: ミルク合計 ${day.totalMilkMl}ml（粉 ${day.formulaMl} / 搾母乳 ${day.expressedMl} / 母乳量 ${day.breastMl}）· 母乳 ${formatDuration(day.breastSeconds)} ${day.breastCount}回 · 離乳食 ${day.solidCount} · ごはん ${day.mealCount} · おやつ ${day.snackCount}`,
    ),
  ].join("\n");
}

export function formatMemosText(memos: MemoItem[], query?: string): string {
  const heading = query ? `## メモ（「${query}」）` : "## メモ";
  if (memos.length === 0) {
    return `${heading}\n該当なし`;
  }
  return [heading, ...memos.map((item) => `- ${item.localDate} ${item.localTime} ${item.label}: ${item.memo}`)].join("\n");
}

export type AnalysisRecord = {
  eventId: string;
  datetime: string;
  date: string;
  time: string;
  type: string;
  label: string;
  memo?: string;
  lastSide?: "left" | "right";
  leftSeconds?: number;
  rightSeconds?: number;
  value?: PiyoRecord["value"];
  details?: Record<string, string>;
};

export function toAnalysisRecord(record: PiyoRecord, timeZone = TIMEZONE): AnalysisRecord {
  const local = zonedParts(record.datetime, timeZone);
  return {
    eventId: record.event_id,
    datetime: record.datetime,
    date: local.date,
    time: local.time,
    type: record.type,
    label: TYPE_LABELS[record.type] ?? record.type,
    memo: record.memo,
    lastSide: record.last,
    leftSeconds: record.leftTime,
    rightSeconds: record.rightTime,
    value: record.value,
    details: record.details,
  };
}

export function analysisBundle(
  snapshot: FeedSnapshot,
  options?: { date?: string; types?: string[] },
): {
  timezone: string;
  generatedAt: string;
  range: { from: string; to: string };
  today: string;
  recordCount: number;
  typeCounts: Record<string, number>;
  weights: WeightPoint[];
  dailyStats: Array<Omit<DayFeeding, "events">>;
  records: AnalysisRecord[];
} {
  const dashboard = buildDashboard(snapshot);
  let records = snapshot.records.map((record) => toAnalysisRecord(record));
  if (options?.date) {
    records = records.filter((item) => item.date === options.date);
  }
  if (options?.types && options.types.length > 0) {
    const allowed = new Set(options.types);
    records = records.filter((item) => allowed.has(item.type));
  }
  records.sort((left, right) => left.datetime.localeCompare(right.datetime));
  const typeCounts: Record<string, number> = {};
  for (const record of records) {
    typeCounts[record.type] = (typeCounts[record.type] ?? 0) + 1;
  }
  return {
    timezone: TIMEZONE,
    generatedAt: snapshot.generated_at,
    range: snapshot.range,
    today: dashboard.today,
    recordCount: records.length,
    typeCounts,
    weights: options?.date ? dashboard.weights.filter((item) => item.date === options.date) : dashboard.weights,
    dailyStats: dailyStats(dashboard, options?.date, options?.date).map(({ events: _events, ...rest }) => rest),
    records,
  };
}

export function formatAnalysisText(title: string, data: unknown): string {
  return `${title}\nこれは分析用の生データです。集計は呼び出し側で行ってください。母乳量は入力されたmlのみで、授乳時間からの推計はしません。\n${JSON.stringify(data)}`;
}

export function filterFeeding(snapshot: FeedSnapshot, options: { date?: string; types?: string[]; limit?: number }): FeedingEvent[] {
  const events: FeedingEvent[] = [];
  for (const record of snapshot.records) {
    const event = toFeedingEvent(record);
    if (!event) {
      continue;
    }
    if (options.date && event.localDate !== options.date) {
      continue;
    }
    if (options.types && options.types.length > 0 && !options.types.includes(event.type)) {
      continue;
    }
    events.push(event);
  }
  const limited = options.limit ? events.slice(-options.limit) : events;
  return limited;
}
