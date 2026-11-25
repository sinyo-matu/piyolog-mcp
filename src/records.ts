import { TIMEZONE, zonedParts } from "./time.ts";
import type { PiyoRecord } from "./types.ts";

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

type KnownKind = Exclude<NormalizedRecord["kind"], "unknown">;

/** Every known PiyoLog type. Labels, kinds and categories all come from here. */
const RECORD_TYPES = new Map<string, { label: string; kind: KnownKind }>([
  ["BreastFeeding", { label: "母乳", kind: "breast" }],
  ["Formula", { label: "ミルク", kind: "milk" }],
  ["ExpressedBreastMilk", { label: "搾母乳", kind: "milk" }],
  ["Pumping", { label: "搾乳", kind: "pumping" }],
  ["Solid", { label: "離乳食", kind: "food" }],
  ["Snack", { label: "おやつ", kind: "food" }],
  ["Meal", { label: "ごはん", kind: "food" }],
  ["Drink", { label: "のみもの", kind: "food" }],
  ["Sleep", { label: "寝る", kind: "sleep" }],
  ["WakeUp", { label: "起きる", kind: "wake" }],
  ["Pee", { label: "おしっこ", kind: "diaper" }],
  ["Poop", { label: "うんち", kind: "diaper" }],
  ["Temperature", { label: "体温", kind: "measurement" }],
  ["Height", { label: "身長", kind: "measurement" }],
  ["Weight", { label: "体重", kind: "measurement" }],
  ["Head", { label: "頭囲", kind: "measurement" }],
  ["Chest", { label: "胸囲", kind: "measurement" }],
  ["Foot", { label: "足サイズ", kind: "measurement" }],
  ["Bath", { label: "お風呂", kind: "event" }],
  ["Medicine", { label: "くすり", kind: "event" }],
  ["Hospital", { label: "病院", kind: "event" }],
  ["Walking", { label: "さんぽ", kind: "event" }],
  ["Vaccine", { label: "予防接種", kind: "event" }],
  ["Milestone", { label: "できた", kind: "event" }],
  ["Other", { label: "その他", kind: "event" }],
  ["Memo", { label: "メモ", kind: "event" }],
]);

/** Categories that a caller can ask for, by kind. */
const CATEGORIES = new Map<string, readonly KnownKind[]>([
  ["feeding", ["breast", "milk", "pumping", "food"]],
  ["sleep", ["sleep", "wake"]],
  ["diaper", ["diaper"]],
  ["measurement", ["measurement"]],
]);

/** A feed the baby drank: breast, formula or expressed milk. */
export function isMilkFeed(record: NormalizedRecord): boolean {
  return record.kind === "breast" || record.kind === "milk";
}

function wholeSeconds(seconds: number | undefined): number | undefined {
  return typeof seconds === "number" ? Math.round(seconds) : undefined;
}

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
  const known = RECORD_TYPES.get(record.type);
  const base: RecordBase = {
    eventId: record.event_id,
    datetime: record.datetime,
    ...zonedParts(record.datetime, timeZone),
    type: record.type,
    label: known?.label ?? record.type,
    memo: record.memo,
    amount: record.value,
    details: record.details,
  };
  if (!known) {
    return { ...base, kind: "unknown", raw: record };
  }
  if (known.kind === "breast") {
    return {
      ...base,
      kind: known.kind,
      leftSeconds: wholeSeconds(record.leftTime),
      rightSeconds: wholeSeconds(record.rightTime),
      lastSide: record.last,
    };
  }
  return { ...base, kind: known.kind };
}

export function normalizeAll(records: PiyoRecord[]): NormalizedRecord[] {
  return records
    .map((record) => normalizeRecord(record))
    .filter((record): record is NormalizedRecord => record !== null)
    .sort((left, right) => Date.parse(left.datetime) - Date.parse(right.datetime));
}

/** Expand categories. A name must be a known type, or a new one that the data actually has. */
export function resolveTypes(types: string[], present: Record<string, number>): Set<string> {
  const resolved = new Set<string>();
  const unknown: string[] = [];
  for (const type of types) {
    const kinds = CATEGORIES.get(type);
    if (kinds) {
      for (const [name, { kind }] of RECORD_TYPES) {
        if (kinds.includes(kind)) resolved.add(name);
      }
    } else if (RECORD_TYPES.has(type) || Object.hasOwn(present, type)) {
      resolved.add(type);
    } else {
      unknown.push(type);
    }
  }
  if (unknown.length > 0) {
    const names = [...CATEGORIES.keys(), ...RECORD_TYPES.keys()].join(", ");
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
