import type { FeedSnapshot, PiyoRecord, StaleReason } from "./types";

const CACHE_KEY = "cache:piyolog-feed";
const CACHE_TTL_SECONDS = 900;
const ARCHIVE_INDEX_KEY = "archive:index";
const FALLBACK_TTL_SECONDS = 60;

type ArchiveIndex = {
  months: string[];
  generatedAt: string;
  rangeTo: string;
};

export class FeedError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "FeedError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSnapshot(data: unknown): FeedSnapshot {
  if (!isRecord(data)) {
    throw new FeedError("Unexpected feed payload", 502);
  }
  if (data.schema_version !== 1) {
    throw new FeedError(`Unsupported schema_version: ${String(data.schema_version)}`, 502);
  }
  if (!Array.isArray(data.records) || !isRecord(data.range)) {
    throw new FeedError("Feed JSON is missing records or range", 502);
  }
  return {
    schema_version: 1,
    generated_at: String(data.generated_at),
    range: {
      from: String(data.range.from),
      to: String(data.range.to),
    },
    records: data.records as PiyoRecord[],
  };
}

function parseCachedSnapshot(data: unknown): FeedSnapshot {
  const snapshot = parseSnapshot(data);
  const reason = isRecord(data) ? data.staleReason : undefined;
  if (reason === "request_failed" || reason === "empty_feed") {
    snapshot.staleReason = reason;
  }
  return snapshot;
}

function monthOf(datetime: string): string {
  const match = /^(\d{4}-\d{2})/.exec(datetime);
  return match?.[1] ?? "0000-00";
}

function monthStorageKey(month: string): string {
  return `archive:month:${month}`;
}

function sortRecords(records: PiyoRecord[]): PiyoRecord[] {
  return [...records].sort(
    (left, right) => left.datetime.localeCompare(right.datetime) || left.event_id.localeCompare(right.event_id),
  );
}

function groupByMonth(records: PiyoRecord[]): Map<string, PiyoRecord[]> {
  const groups = new Map<string, PiyoRecord[]>();
  for (const record of records) {
    const month = monthOf(record.datetime);
    const list = groups.get(month);
    if (list) {
      list.push(record);
    } else {
      groups.set(month, [record]);
    }
  }
  return groups;
}

/** Keep records older than the feed window. The feed replaces everything inside [from, to). */
export function mergeFeedArchive(stored: PiyoRecord[], feed: FeedSnapshot): PiyoRecord[] {
  const fromFeed = new Set(feed.records.map((record) => record.event_id));
  const older = stored.filter((record) => record.datetime < feed.range.from && !fromFeed.has(record.event_id));
  const merged = new Map<string, PiyoRecord>();
  for (const record of older) {
    merged.set(record.event_id, record);
  }
  for (const record of feed.records) {
    merged.set(record.event_id, record);
  }
  return sortRecords([...merged.values()]);
}

function snapshotFrom(records: PiyoRecord[], generatedAt: string, rangeTo: string, rangeFrom: string): FeedSnapshot {
  const sorted = sortRecords(records);
  return {
    schema_version: 1,
    generated_at: generatedAt,
    range: {
      from: sorted[0]?.datetime ?? rangeFrom,
      to: rangeTo,
    },
    records: sorted,
  };
}

type Archive = { index: ArchiveIndex; records: PiyoRecord[] };

async function readArchive(kv: KVNamespace, wanted?: (month: string) => boolean): Promise<Archive> {
  const raw = await kv.get(ARCHIVE_INDEX_KEY);
  if (!raw) {
    return { index: { months: [], generatedAt: "", rangeTo: "" }, records: [] };
  }
  let index: ArchiveIndex;
  try {
    index = JSON.parse(raw) as ArchiveIndex;
  } catch {
    throw new FeedError("保存済みの記録索引を読めません", 500);
  }
  if (!Array.isArray(index.months) || index.months.length === 0) {
    return { index: { months: [], generatedAt: index.generatedAt ?? "", rangeTo: index.rangeTo ?? "" }, records: [] };
  }
  const months = wanted ? index.months.filter(wanted) : index.months;
  const bodies = await Promise.all(months.map((month) => kv.get(monthStorageKey(month))));
  const records: PiyoRecord[] = [];
  for (const body of bodies) {
    if (!body) {
      throw new FeedError("保存済みの記録を読めません", 500);
    }
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.records)) {
      throw new FeedError("保存済みの記録を読めません", 500);
    }
    records.push(...(parsed.records as PiyoRecord[]));
  }
  return { index, records };
}

async function persistArchive(
  kv: KVNamespace,
  previousIndex: ArchiveIndex,
  previous: PiyoRecord[],
  next: PiyoRecord[],
  feed: FeedSnapshot,
): Promise<void> {
  const before = groupByMonth(sortRecords(previous));
  const after = groupByMonth(sortRecords(next));
  for (const list of before.values()) {
    sortRecords(list).forEach((record, index) => {
      list[index] = record;
    });
  }
  const puts: Promise<unknown>[] = [];
  const removed: string[] = [];
  const months = new Set([...before.keys(), ...after.keys()]);
  for (const month of months) {
    const left = before.get(month) ?? [];
    const right = after.get(month) ?? [];
    if (JSON.stringify(left) === JSON.stringify(right)) {
      continue;
    }
    if (right.length === 0) {
      removed.push(month);
      continue;
    }
    puts.push(kv.put(monthStorageKey(month), JSON.stringify({ records: right })));
  }
  const nextMonths = [...after.keys()].filter((month) => (after.get(month)?.length ?? 0) > 0).sort();
  const index: ArchiveIndex = {
    months: nextMonths,
    generatedAt: feed.generated_at,
    rangeTo: feed.range.to,
  };
  const indexSame =
    previousIndex.generatedAt === feed.generated_at &&
    JSON.stringify(nextMonths) === JSON.stringify([...before.keys()].sort()) &&
    puts.length === 0 &&
    removed.length === 0;
  if (indexSame) {
    return;
  }
  await Promise.all(puts);
  await kv.put(ARCHIVE_INDEX_KEY, JSON.stringify(index));
  await Promise.all(removed.map((month) => kv.delete(monthStorageKey(month))));
}

async function fetchLiveFeed(env: Env): Promise<FeedSnapshot> {
  const response = await fetch(env.PIYOLOG_FEED_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "piyo-mcp/1.0",
    },
  });

  if (!response.ok) {
    let code: string | undefined;
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") {
        code = body.error.code;
      }
    } catch {
      // Keep the HTTP status as the signal when the body is not JSON.
    }
    throw new FeedError("PiyoLog feed request failed", response.status, code);
  }

  return parseSnapshot(await response.json());
}

/** The live window, or an empty feed with staleReason when the archive is all there is. */
async function staleFeed(kv: KVNamespace, archive: Archive, staleReason: StaleReason): Promise<FeedSnapshot> {
  const feed = {
    ...snapshotFrom(
      [],
      archive.index.generatedAt || new Date().toISOString(),
      archive.index.rangeTo || archive.records.at(-1)?.datetime || new Date().toISOString(),
      archive.records[0]?.datetime ?? new Date().toISOString(),
    ),
    staleReason,
  };
  await kv.put(CACHE_KEY, JSON.stringify(feed), { expirationTtl: FALLBACK_TTL_SECONDS });
  return feed;
}

/** Refresh the archive at most once per cache period. Reads every month, because an edit can move a record out of an old one. */
async function syncFeed(env: Env): Promise<{ feed: FeedSnapshot; archive?: Archive }> {
  const cached = await env.OAUTH_KV.get(CACHE_KEY);
  if (cached) {
    return { feed: parseCachedSnapshot(JSON.parse(cached)) };
  }

  const archive = await readArchive(env.OAUTH_KV);
  let live: FeedSnapshot;
  try {
    live = await fetchLiveFeed(env);
  } catch (error) {
    if (archive.records.length === 0) {
      throw error;
    }
    return { feed: await staleFeed(env.OAUTH_KV, archive, "request_failed"), archive };
  }

  // An empty feed would delete every stored record in the window. Treat it as a feed fault.
  if (live.records.length === 0 && archive.records.some((record) => record.datetime >= live.range.from)) {
    return { feed: await staleFeed(env.OAUTH_KV, archive, "empty_feed"), archive };
  }

  const records = mergeFeedArchive(archive.records, live);
  await persistArchive(env.OAUTH_KV, archive.index, archive.records, records, live);
  await env.OAUTH_KV.put(CACHE_KEY, JSON.stringify(live), { expirationTtl: CACHE_TTL_SECONDS });
  return { feed: live, archive };
}

function combine(stored: PiyoRecord[], feed: FeedSnapshot): FeedSnapshot {
  const records = feed.staleReason ? stored : mergeFeedArchive(stored, feed);
  const snapshot = snapshotFrom(records, feed.generated_at, feed.range.to, feed.range.from);
  return feed.staleReason ? { ...snapshot, staleReason: feed.staleReason } : snapshot;
}

export async function loadFeed(env: Env): Promise<FeedSnapshot> {
  const { feed, archive } = await syncFeed(env);
  return combine((archive ?? (await readArchive(env.OAUTH_KV))).records, feed);
}

const DAY_MS = 86_400_000;

/**
 * Records covering the local dates from..to, reading only the months they need.
 * Neighbouring days may be included, so callers still filter by local date.
 */
export async function loadRange(env: Env, from: string, to: string): Promise<FeedSnapshot> {
  const { feed, archive } = await syncFeed(env);
  // Month keys are UTC and the dates are local, so widen by a day on each side.
  const start = Date.parse(`${from}T00:00:00.000Z`) - DAY_MS;
  const end = Date.parse(`${to}T00:00:00.000Z`) + 2 * DAY_MS;
  const firstMonth = monthOf(new Date(start).toISOString());
  const lastMonth = monthOf(new Date(end).toISOString());
  const wanted = (month: string) => month >= firstMonth && month <= lastMonth;

  let stored: PiyoRecord[] = [];
  if (feed.staleReason || start < Date.parse(feed.range.from)) {
    stored = archive
      ? archive.records.filter((record) => wanted(monthOf(record.datetime)))
      : (await readArchive(env.OAUTH_KV, wanted)).records;
  }
  const snapshot = combine(stored, feed);
  return {
    ...snapshot,
    range: { from, to },
    records: snapshot.records.filter((record) => {
      const time = Date.parse(record.datetime);
      return Number.isNaN(time) || (time >= start && time < end);
    }),
  };
}
