import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDate, resolveRange } from "./date.ts";

const TODAY = "2026-11-25";

describe("resolveDate", () => {
  it("returns today when the date is omitted or blank", () => {
    assert.equal(resolveDate(undefined, TODAY), TODAY);
    assert.equal(resolveDate("", TODAY), TODAY);
    assert.equal(resolveDate(" ", TODAY), TODAY);
  });

  it("returns a valid date including a leap day", () => {
    assert.equal(resolveDate("2026-11-20", TODAY), "2026-11-20");
    assert.equal(resolveDate("2028-02-29", TODAY), "2028-02-29");
  });

  for (const date of ["2026/11/20", "2026-1-2", "yesterday", "2026-02-29", "2026-02-31", "2026-13-01"]) {
    it(`rejects ${date}`, () => {
      assert.throws(() => resolveDate(date, TODAY), /YYYY-MM-DD/);
    });
  }
});

describe("resolveRange", () => {
  it("defaults to today only", () => {
    assert.deepEqual(resolveRange(undefined, undefined, TODAY), { start: TODAY, end: TODAY });
  });

  it("defaults from to a span ending at to", () => {
    assert.deepEqual(resolveRange(undefined, "2026-11-10", TODAY, 7), { start: "2026-11-04", end: "2026-11-10" });
  });

  it("keeps explicit dates", () => {
    assert.deepEqual(resolveRange("2026-11-01", "2026-11-03", TODAY, 7), { start: "2026-11-01", end: "2026-11-03" });
  });

  it("rejects from after to", () => {
    assert.throws(() => resolveRange("2026-11-05", "2026-11-04", TODAY), /from は to 以前/);
  });
});
