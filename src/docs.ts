import { resolveDate } from "./date.ts";
import { queryRecords, type NormalizedRecord } from "./records.ts";
import { normalizeAll, summarizeDays } from "./summary.ts";
import type { FeedSnapshot } from "./types.ts";

const MAX_RESULTS = 20;

export type SearchResult = {
  id: string;
  title: string;
  url: string;
};

export type FetchDocument = SearchResult & {
  text: string;
  metadata: Record<string, string>;
};

function docUrl(origin: string, id: string): string {
  return `${origin}/#${encodeURIComponent(id)}`;
}

function recordTitle(record: NormalizedRecord): string {
  const title = `${record.date} ${record.time} ${record.label}`;
  return record.memo ? `${title}: ${record.memo}` : title;
}

function isDate(value: string): boolean {
  try {
    return value !== "" && resolveDate(value, "") === value;
  } catch {
    return false;
  }
}

export function searchDocuments(snapshot: FeedSnapshot, origin: string, query: string): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const records = normalizeAll(snapshot.records);
  if (isDate(needle)) {
    const id = `day:${needle}`;
    return records.some((record) => record.date === needle)
      ? [{ id, title: `${needle} の記録`, url: docUrl(origin, id) }]
      : [];
  }
  return records
    .reverse()
    .filter((record) =>
      [record.memo, record.label, record.type, ...Object.values(record.details ?? {})].some(
        (text) => typeof text === "string" && text.toLowerCase().includes(needle),
      ),
    )
    .slice(0, MAX_RESULTS)
    .map((record) => {
      const id = `record:${record.eventId}`;
      return { id, title: recordTitle(record), url: docUrl(origin, id) };
    });
}

export function recordDocument(snapshot: FeedSnapshot, origin: string, id: string): FetchDocument | null {
  const eventId = /^record:(.+)$/.exec(id)?.[1];
  const record = eventId ? normalizeAll(snapshot.records).find((item) => item.eventId === eventId) : undefined;
  if (!record) {
    return null;
  }
  return {
    id,
    title: recordTitle(record),
    text: JSON.stringify(record),
    url: docUrl(origin, id),
    metadata: { kind: "record", date: record.date, type: record.type },
  };
}

/** The snapshot should include the day before, so sleep that crosses midnight is counted. */
export function dayDocument(snapshot: FeedSnapshot, origin: string, date: string): FetchDocument {
  const id = `day:${date}`;
  const { records, total, nextOffset } = queryRecords(snapshot.records, { from: date, to: date, limit: 1000 });
  const summary = summarizeDays(normalizeAll(snapshot.records), date, date)[0];
  return {
    id,
    title: `${date} の記録`,
    text: JSON.stringify({ summary, total, nextOffset, records }),
    url: docUrl(origin, id),
    metadata: { kind: "day", date },
  };
}
