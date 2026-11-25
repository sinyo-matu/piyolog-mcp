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

  it("expands a category and rejects an unknown type", () => {
    const result = queryRecords(records, { ...day, types: ["sleep"] });
    assert.deepEqual(result.records.map((item) => item.eventId), ["sleep"]);
    assert.throws(() => queryRecords(records, { ...day, types: ["Milk"] }), /Milk/);
  });

  it("accepts a new type that the data has", () => {
    const result = queryRecords([record("new", "2026-09-01T00:00:00.000Z", "NewType")], { ...day, types: ["NewType"] });
    assert.equal(result.total, 1);
  });

  it("pages through every record once", () => {
    const first = queryRecords(records, { ...day, limit: 2 });
    const second = queryRecords(records, { ...day, limit: 2, offset: first.nextOffset ?? 0 });
    assert.deepEqual([...first.records, ...second.records].map((item) => item.eventId), ["first", "sleep", "last"]);
    assert.equal(second.nextOffset, null);
  });
});

describe("record types", () => {
  const expected: Array<[type: string, label: string, kind: string, category: string | null]> = [
    ["BreastFeeding", "母乳", "breast", "feeding"],
    ["Formula", "ミルク", "milk", "feeding"],
    ["ExpressedBreastMilk", "搾母乳", "milk", "feeding"],
    ["Pumping", "搾乳", "pumping", "feeding"],
    ["Solid", "離乳食", "food", "feeding"],
    ["Snack", "おやつ", "food", "feeding"],
    ["Meal", "ごはん", "food", "feeding"],
    ["Drink", "のみもの", "food", "feeding"],
    ["Sleep", "寝る", "sleep", "sleep"],
    ["WakeUp", "起きる", "wake", "sleep"],
    ["Pee", "おしっこ", "diaper", "diaper"],
    ["Poop", "うんち", "diaper", "diaper"],
    ["Temperature", "体温", "measurement", "measurement"],
    ["Height", "身長", "measurement", "measurement"],
    ["Weight", "体重", "measurement", "measurement"],
    ["Head", "頭囲", "measurement", "measurement"],
    ["Chest", "胸囲", "measurement", "measurement"],
    ["Foot", "足サイズ", "measurement", "measurement"],
    ["Bath", "お風呂", "event", null],
    ["Medicine", "くすり", "event", null],
    ["Hospital", "病院", "event", null],
    ["Walking", "さんぽ", "event", null],
    ["Vaccine", "予防接種", "event", null],
    ["Milestone", "できた", "event", null],
    ["Other", "その他", "event", null],
    ["Memo", "メモ", "event", null],
  ];
  const all = expected.map(([type]) => record(type, "2026-09-01T00:00:00.000Z", type));

  for (const [type, label, kind] of expected) {
    it(`reads ${type} as ${label}`, () => {
      const result = normalizeRecord(record(type, "2026-09-01T00:00:00.000Z", type));
      assert.equal(result?.label, label);
      assert.equal(result?.kind, kind);
    });
  }

  for (const category of ["feeding", "sleep", "diaper", "measurement"]) {
    it(`expands ${category} to exactly its types`, () => {
      const result = queryRecords(all, { from: "2026-09-01", to: "2026-09-01", types: [category] });
      assert.deepEqual(
        result.records.map((item) => item.type).sort(),
        expected.filter((item) => item[3] === category).map(([type]) => type).sort(),
      );
    });
  }

  it("lists categories, then types in order, for an unknown name", () => {
    assert.throws(
      () => queryRecords(all, { from: "2026-09-01", to: "2026-09-01", types: ["Milk"] }),
      (error: Error) =>
        error.message.endsWith(
          ["feeding", "sleep", "diaper", "measurement", ...expected.map(([type]) => type)].join(", "),
        ),
    );
  });
});
