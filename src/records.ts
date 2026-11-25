import { TIMEZONE, zonedParts } from "./time.ts";
import { FEEDING_TYPES, TYPE_LABELS, type PiyoRecord } from "./types.ts";

type Amount = NonNullable<PiyoRecord["value"]>;

type RecordBase = {
  eventId: string;
  datetime: string;
  date: string;
  time: string;
  type: string;
  label: string;
  memo?: string;
  /** Amount as recorded. Units are passed through and nothing is estimated. */
  amount?: Amount;
  details?: Record<string, string>;
};

export type NormalizedRecord =
  | (RecordBase & { kind: "breast"; leftSeconds?: number; rightSeconds?: number; lastSide?: "left" | "right" })
  | (RecordBase & { kind: "milk" | "pumping" | "food" | "sleep" | "wake" | "diaper" | "measurement" | "event" })
  | (RecordBase & { kind: "unknown"; raw: PiyoRecord });

type PlainKind = Exclude<NormalizedRecord["kind"], "breast" | "unknown">;

const KINDS: Record<string, PlainKind> = {
  Formula: "milk",
  ExpressedBreastMilk: "milk",
  Pumping: "pumping",
  Solid: "food",
  Snack: "food",
  Meal: "food",
  Drink: "food",
  Sleep: "sleep",
  WakeUp: "wake",
  Pee: "diaper",
  Poop: "diaper",
  Temperature: "measurement",
  Height: "measurement",
  Weight: "measurement",
  Head: "measurement",
  Chest: "measurement",
  Foot: "measurement",
};

/** Null when the record has no usable id, type or datetime. */
export function normalizeRecord(record: PiyoRecord, timeZone = TIMEZONE): NormalizedRecord | null {
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.event_id !== "string" ||
    typeof record.type !== "string" ||
    typeof record.datetime !== "string" ||
    Number.isNaN(Date.parse(record.datetime))
  ) {
    return null;
  }
  const base: RecordBase = {
    eventId: record.event_id,
    datetime: record.datetime,
    ...zonedParts(record.datetime, timeZone),
    type: record.type,
    label: TYPE_LABELS[record.type] ?? record.type,
    memo: record.memo,
    amount: record.value,
    details: record.details,
  };
  if (record.type === "BreastFeeding") {
    return {
      ...base,
      kind: "breast",
      leftSeconds: record.leftTime,
      rightSeconds: record.rightTime,
      lastSide: record.last,
    };
  }
  const kind = KINDS[record.type];
  if (kind) {
    return { ...base, kind };
  }
  if (TYPE_LABELS[record.type]) {
    return { ...base, kind: "event" };
  }
  return { ...base, kind: "unknown", raw: record };
}

export const CATEGORIES: Record<string, readonly string[]> = {
  feeding: FEEDING_TYPES,
  sleep: ["Sleep", "WakeUp"],
  diaper: ["Pee", "Poop"],
  measurement: ["Temperature", "Height", "Weight", "Head", "Chest", "Foot"],
};

/** Expand categories. A name must be a known type, or a new one that the data actually has. */
export function resolveTypes(types: string[], present: Record<string, number>): Set<string> {
  const resolved = new Set<string>();
  const unknown: string[] = [];
  for (const type of types) {
    if (Object.hasOwn(CATEGORIES, type)) {
      for (const item of CATEGORIES[type] ?? []) resolved.add(item);
    } else if (Object.hasOwn(TYPE_LABELS, type) || Object.hasOwn(present, type)) {
      resolved.add(type);
    } else {
      unknown.push(type);
    }
  }
  if (unknown.length > 0) {
    const names = [...Object.keys(CATEGORIES), ...Object.keys(TYPE_LABELS)].join(", ");
    throw new Error(`types に知らない値があります: ${unknown.join(", ")}。使える値: ${names}`);
  }
  return resolved;
}

export type RecordQuery = {
  from: string;
  to: string;
  types?: string[];
  offset?: number;
  limit?: number;
};

export function queryRecords(records: PiyoRecord[], query: RecordQuery) {
  const inRange: NormalizedRecord[] = [];
  let skippedCount = 0;
  for (const record of records) {
    const normalized = normalizeRecord(record);
    if (!normalized) {
      skippedCount += 1;
    } else if (normalized.date >= query.from && normalized.date <= query.to) {
      inRange.push(normalized);
    }
  }
  inRange.sort(
    (left, right) =>
      Date.parse(left.datetime) - Date.parse(right.datetime) || left.eventId.localeCompare(right.eventId),
  );
  const typeCounts: Record<string, number> = {};
  for (const record of inRange) {
    typeCounts[record.type] = (typeCounts[record.type] ?? 0) + 1;
  }
  const allowed = query.types && query.types.length > 0 ? resolveTypes(query.types, typeCounts) : null;
  const matched = allowed ? inRange.filter((record) => allowed.has(record.type)) : inRange;
  const offset = query.offset ?? 0;
  const page = matched.slice(offset, offset + (query.limit ?? 500));
  const next = offset + page.length;
  return {
    timezone: TIMEZONE,
    from: query.from,
    to: query.to,
    /** Counts in the range before the type filter. */
    typeCounts,
    total: matched.length,
    skippedCount,
    nextOffset: next < matched.length ? next : null,
    records: page,
  };
}
