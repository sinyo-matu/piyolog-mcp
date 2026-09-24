import type { FeedSnapshot, PiyoRecord } from "./types";

const CACHE_KEY = "cache:piyolog-history";
const CACHE_TTL_SECONDS = 900;
const ARCHIVE_INDEX_KEY = "archive:index";
const FALLBACK_TTL_SECONDS = 60;

type ArchiveIndex = {
  months: string[];
  generatedAt: string;
  rangeTo: string;
};

export class FeedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FeedError";
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

async function readArchive(kv: KVNamespace): Promise<{ index: ArchiveIndex; records: PiyoRecord[] }> {
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
  const bodies = await Promise.all(index.months.map((month) => kv.get(monthStorageKey(month))));
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

async function persistArchive(kv: KVNamespace, previous: PiyoRecord[], next: PiyoRecord[], feed: FeedSnapshot): Promise<void> {
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

export async function loadFeed(env: Env): Promise<FeedSnapshot> {
  const cached = await env.OAUTH_KV.get(CACHE_KEY);
  if (cached) {
    return parseSnapshot(JSON.parse(cached));
  }

  const archive = await readArchive(env.OAUTH_KV);
  let live: FeedSnapshot;
  try {
    live = await fetchLiveFeed(env);
  } catch (error) {
    if (archive.records.length === 0) {
      throw error;
    }
    const snapshot = snapshotFrom(
      archive.records,
      archive.index.generatedAt || new Date().toISOString(),
      archive.index.rangeTo || archive.records.at(-1)?.datetime || new Date().toISOString(),
      archive.records[0]?.datetime ?? new Date().toISOString(),
    );
    await env.OAUTH_KV.put(CACHE_KEY, JSON.stringify(snapshot), { expirationTtl: FALLBACK_TTL_SECONDS });
    return snapshot;
  }

  const records = mergeFeedArchive(archive.records, live);
  await persistArchive(env.OAUTH_KV, archive.records, records, live);
  const snapshot = snapshotFrom(records, live.generated_at, live.range.to, live.range.from);
  await env.OAUTH_KV.put(CACHE_KEY, JSON.stringify(snapshot), { expirationTtl: CACHE_TTL_SECONDS });
  return snapshot;
}
