import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRecord, queryRecords } from "./records.ts";
import type { PiyoRecord } from "./types.ts";

function record(id: string, datetime: string, type = "Formula"): PiyoRecord {
  return { event_id: id, datetime, type };
}

describe("normalizeRecord", () => {
  it("keeps recorded sides and units without computing a total", () => {
    const result = normalizeRecord({ ...record("p", "2026-09-01T00:00:00.000Z", "Pumping"), value: { left: 40, right: 50, unit: "ml" } });
    assert.equal(result?.kind, "pumping");
    assert.deepEqual(result?.amount, { left: 40, right: 50, unit: "ml" });
  });

  it("keeps an unknown type with its raw record", () => {
    const source = record("x", "2026-09-01T00:00:00.000Z", "NewType");
    const result = normalizeRecord(source);
    assert.equal(result?.kind, "unknown");
    assert.deepEqual(result?.kind === "unknown" ? result.raw : null, source);
  });

  it("returns null for an unusable datetime", () => {
    assert.equal(normalizeRecord(record("bad", "not a date")), null);
  });
});

describe("queryRecords", () => {
  const records = [
    record("before", "2026-08-31T14:59:00.000Z"),
    record("first", "2026-08-31T15:00:00.000Z"),
    record("sleep", "2026-09-01T03:00:00.000Z", "Sleep"),
    record("last", "2026-09-01T14:59:00.000Z"),
    record("after", "2026-09-01T15:00:00.000Z"),
    record("bad", "oops"),
  ];
  const day = { from: "2026-09-01", to: "2026-09-01" };

  it("filters by JST date and reports skipped records", () => {
    const result = queryRecords(records, day);
    assert.deepEqual(result.records.map((item) => item.eventId), ["first", "sleep", "last"]);
    assert.equal(result.skippedCount, 1);
  });

  it("filters by type but counts every type in the range", () => {
    const result = queryRecords(records, { ...day, types: ["Sleep"] });
    assert.deepEqual(result.records.map((item) => item.eventId), ["sleep"]);
    assert.deepEqual(result.typeCounts, { Formula: 2, Sleep: 1 });
  });

  it("pages through every record once", () => {
    const first = queryRecords(records, { ...day, limit: 2 });
    const second = queryRecords(records, { ...day, limit: 2, offset: first.nextOffset ?? 0 });
    assert.deepEqual([...first.records, ...second.records].map((item) => item.eventId), ["first", "sleep", "last"]);
    assert.equal(second.nextOffset, null);
  });
});
