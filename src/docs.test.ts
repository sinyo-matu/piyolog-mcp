import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dayDocument, recordDocument, searchDocuments } from "./docs.ts";
import type { FeedSnapshot } from "./types.ts";

const ORIGIN = "https://example.test";
const snapshot: FeedSnapshot = {
  schema_version: 1,
  generated_at: "2026-09-03T00:00:00.000Z",
  range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-03T00:00:00.000Z" },
  records: [
    { event_id: "old", datetime: "2026-09-01T01:00:00.000Z", type: "Memo", memo: "はじめての Bath" },
    { event_id: "new", datetime: "2026-09-02T01:00:00.000Z", type: "Bath" },
    { event_id: "bad", datetime: "oops", type: "Bath" },
  ],
};
const ids = (query: string) => searchDocuments(snapshot, ORIGIN, query).map((item) => item.id);

describe("searchDocuments", () => {
  it("matches memo, label and type, newest first", () => {
    assert.deepEqual(ids("bath"), ["record:new", "record:old"]);
    assert.deepEqual(ids("お風呂"), ["record:new"]);
  });

  it("returns a day for a date that has records", () => {
    assert.deepEqual(ids("2026-09-01"), ["day:2026-09-01"]);
    assert.deepEqual(ids("2026-09-20"), []);
  });

  it("returns nothing for a blank or unmatched query", () => {
    assert.deepEqual(ids(" "), []);
    assert.deepEqual(ids("該当しない語"), []);
  });

  it("returns at most 20 results", () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      event_id: `r${index}`,
      datetime: "2026-09-01T01:00:00.000Z",
      type: "Pee",
    }));
    assert.equal(searchDocuments({ ...snapshot, records }, ORIGIN, "pee").length, 20);
  });
});

describe("documents", () => {
  it("fetches every record id that search returns", () => {
    for (const id of ids("bath")) {
      assert.equal(recordDocument(snapshot, ORIGIN, id)?.id, id);
    }
  });

  it("returns null for an unknown id", () => {
    assert.equal(recordDocument(snapshot, ORIGIN, "record:none"), null);
    assert.equal(recordDocument(snapshot, ORIGIN, "all"), null);
  });

  it("returns only the records of the day", () => {
    const body = JSON.parse(dayDocument(snapshot, ORIGIN, "2026-09-01").text) as { total: number };
    assert.equal(body.total, 1);
  });
});
