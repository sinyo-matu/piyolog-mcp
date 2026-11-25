import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDate } from "./date.ts";

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
