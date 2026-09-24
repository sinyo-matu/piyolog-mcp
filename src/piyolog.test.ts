import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FeedError, loadFeed } from "./piyolog.ts";
import type { FeedSnapshot, PiyoRecord } from "./types.ts";

const FEED_URL = "https://feed.example/v1/feed/28d/id/secret";

class MemoryKv {
  readonly values = new Map<string, string>();
  readonly ttl = new Map<string, number | undefined>();
  puts: string[] = [];

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push(key);
    this.values.set(key, value);
    this.ttl.set(key, options?.expirationTtl);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.ttl.delete(key);
  }
}

function record(id: string, datetime: string, ml = 120): PiyoRecord {
  return {
    event_id: id,
    datetime,
    type: "Formula",
    value: { value: ml, unit: "ml" },
  };
}

function feed(from: string, to: string, records: PiyoRecord[]): FeedSnapshot {
  return {
    schema_version: 1,
    generated_at: to,
    range: { from, to },
    records,
  };
}

function envFor(kv: MemoryKv): Env {
  return { OAUTH_KV: kv as unknown as KVNamespace, PIYOLOG_FEED_URL: FEED_URL } as Env;
}

function monthRecords(kv: MemoryKv, month: string): PiyoRecord[] {
  const raw = kv.values.get(`archive:month:${month}`);
  if (!raw) {
    return [];
  }
  return (JSON.parse(raw) as { records: PiyoRecord[] }).records;
}

function indexMonths(kv: MemoryKv): string[] {
  const raw = kv.values.get("archive:index");
  if (!raw) {
    return [];
  }
  return (JSON.parse(raw) as { months: string[] }).months;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFeed(status: number, body: unknown): void {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("feed archive updates", () => {
  it("writes a month key for each month when the archive is empty", async () => {
    const kv = new MemoryKv();
    const august = record("aug-28", "2026-08-28T00:00:00.000Z");
    const september = record("sep-24", "2026-09-24T00:00:00.000Z");
    stubFeed(200, feed("2026-08-27T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [september, august]));

    const snapshot = await loadFeed(envFor(kv));

    assert.deepEqual(
      snapshot.records.map((item) => item.event_id),
      ["aug-28", "sep-24"],
    );
    assert.deepEqual(indexMonths(kv), ["2026-08", "2026-09"]);
    assert.deepEqual(monthRecords(kv, "2026-08"), [august]);
    assert.deepEqual(monthRecords(kv, "2026-09"), [september]);
  });

  it("adds a record inside the feed window without rewriting older months", async () => {
    const kv = new MemoryKv();
    const august = record("aug-01", "2026-08-01T00:00:00.000Z");
    const september = record("sep-10", "2026-09-10T00:00:00.000Z");
    stubFeed(200, feed("2026-07-28T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [august, september]));
    await loadFeed(envFor(kv));
    kv.values.delete("cache:piyolog-history");
    kv.puts = [];
    const added = record("sep-24", "2026-09-24T01:00:00.000Z", 80);
    stubFeed(200, feed("2026-07-28T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [august, september, added]));

    const snapshot = await loadFeed(envFor(kv));

    assert.deepEqual(
      snapshot.records.map((item) => item.event_id),
      ["aug-01", "sep-10", "sep-24"],
    );
    assert.deepEqual(kv.puts, ["archive:month:2026-09", "archive:index", "cache:piyolog-history"]);
    assert.deepEqual(monthRecords(kv, "2026-08"), [august]);
  });

  it("replaces the stored value when the same record is edited inside the window", async () => {
    const kv = new MemoryKv();
    stubFeed(200, feed("2026-08-27T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [record("milk", "2026-09-24T01:00:00.000Z", 120)]));
    await loadFeed(envFor(kv));
    kv.values.delete("cache:piyolog-history");
    const edited = record("milk", "2026-09-24T01:00:00.000Z", 150);
    stubFeed(200, feed("2026-08-27T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [edited]));

    const snapshot = await loadFeed(envFor(kv));

    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0]?.event_id, "milk");
    assert.equal(snapshot.records[0]?.value?.value, 150);
    assert.deepEqual(monthRecords(kv, "2026-09"), [edited]);
  });

  it("drops a record that the feed no longer returns inside the window", async () => {
    const kv = new MemoryKv();
    const kept = record("kept", "2026-09-23T01:00:00.000Z");
    const removed = record("removed", "2026-09-24T01:00:00.000Z");
    stubFeed(200, feed("2026-08-27T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [kept, removed]));
    await loadFeed(envFor(kv));
    kv.values.delete("cache:piyolog-history");
    stubFeed(200, feed("2026-08-27T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [kept]));

    const snapshot = await loadFeed(envFor(kv));

    assert.deepEqual(
      snapshot.records.map((item) => item.event_id),
      ["kept"],
    );
    assert.deepEqual(monthRecords(kv, "2026-09"), [kept]);
  });

  it("keeps a record that has aged out of the feed window", async () => {
    const kv = new MemoryKv();
    const aged = record("aged", "2026-08-01T00:00:00.000Z");
    const current = record("current", "2026-09-10T00:00:00.000Z");
    stubFeed(200, feed("2026-07-28T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [aged, current]));
    await loadFeed(envFor(kv));
    kv.values.delete("cache:piyolog-history");
    kv.puts = [];
    stubFeed(200, feed("2026-09-01T00:00:00.000Z", "2026-09-28T03:00:00.000Z", [current]));

    const snapshot = await loadFeed(envFor(kv));

    assert.deepEqual(
      snapshot.records.map((item) => item.event_id),
      ["aged", "current"],
    );
    assert.deepEqual(monthRecords(kv, "2026-08"), [aged]);
    assert.equal(kv.puts.includes("archive:month:2026-08"), false);
  });

  it("keeps the stored amount when an aged-out record is edited in the app", async () => {
    const kv = new MemoryKv();
    const aged = record("aged", "2026-08-01T00:00:00.000Z", 120);
    stubFeed(200, feed("2026-07-28T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [aged]));
    await loadFeed(envFor(kv));
    kv.values.delete("cache:piyolog-history");
    stubFeed(200, feed("2026-09-01T00:00:00.000Z", "2026-09-28T03:00:00.000Z", []));

    const snapshot = await loadFeed(envFor(kv));

    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0]?.event_id, "aged");
    assert.equal(snapshot.records[0]?.value?.value, 120);
  });

  it("keeps an aged-out record when it is deleted in the app", async () => {
    const kv = new MemoryKv();
    const aged = record("aged", "2026-08-01T00:00:00.000Z");
    stubFeed(200, feed("2026-07-28T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [aged]));
    await loadFeed(envFor(kv));
    kv.values.delete("cache:piyolog-history");
    stubFeed(200, feed("2026-09-01T00:00:00.000Z", "2026-09-28T03:00:00.000Z", []));

    const snapshot = await loadFeed(envFor(kv));

    assert.deepEqual(monthRecords(kv, "2026-08"), [aged]);
    assert.deepEqual(
      snapshot.records.map((item) => item.event_id),
      ["aged"],
    );
  });

  it("keeps the feed copy when an old record's time moves into the window", async () => {
    const kv = new MemoryKv();
    stubFeed(200, feed("2026-07-28T00:00:00.000Z", "2026-09-24T03:00:00.000Z", [record("moved", "2026-08-23T00:00:00.000Z", 120)]));
    await loadFeed(envFor(kv));
    kv.values.delete("cache:piyolog-history");
    const moved = record("moved", "2026-10-01T00:00:00.000Z", 150);
    stubFeed(200, feed("2026-09-24T00:00:00.000Z", "2026-10-22T03:00:00.000Z", [moved]));

    const snapshot = await loadFeed(envFor(kv));

    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0]?.datetime, "2026-10-01T00:00:00.000Z");
    assert.equal(snapshot.records[0]?.value?.value, 150);
    assert.equal(kv.values.has("archive:month:2026-08"), false);
    assert.deepEqual(monthRecords(kv, "2026-10"), [moved]);
    assert.deepEqual(indexMonths(kv), ["2026-10"]);
  });

  it("returns the archive and caches it for 60 seconds when the feed request fails", async () => {
    const kv = new MemoryKv();
    const stored = record("stored", "2026-09-01T00:00:00.000Z", 90);
    stubFeed(200, feed("2026-08-04T00:00:00.000Z", "2026-09-01T03:00:00.000Z", [stored]));
    await loadFeed(envFor(kv));
    kv.values.delete("cache:piyolog-history");
    kv.puts = [];
    stubFeed(500, { error: { code: "feed_unavailable" } });

    const snapshot = await loadFeed(envFor(kv));

    assert.deepEqual(snapshot.records, [stored]);
    assert.deepEqual(kv.puts, ["cache:piyolog-history"]);
    assert.equal(kv.ttl.get("cache:piyolog-history"), 60);
    assert.deepEqual(monthRecords(kv, "2026-09"), [stored]);
  });

  it("throws when the feed request fails and the archive is empty", async () => {
    const kv = new MemoryKv();
    stubFeed(500, { error: { code: "feed_unavailable" } });

    await assert.rejects(loadFeed(envFor(kv)), (error: unknown) => {
      assert.ok(error instanceof FeedError);
      const feedError = error;
      assert.equal(feedError.status, 500);
      assert.equal(feedError.code, "feed_unavailable");
      return true;
    });
    assert.equal(kv.values.has("archive:index"), false);
  });
});
