import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAll } from "./records.ts";
import { buildLatest, buildSummary, summarizeDays } from "./summary.ts";
import type { PiyoRecord } from "./types.ts";

const NOW = new Date("2026-09-10T03:00:00.000Z");
let id = 0;

/** `at` is JST. */
function record(at: string, type: string, extra: Partial<PiyoRecord> = {}): PiyoRecord {
  id += 1;
  return { event_id: `r${id}`, datetime: new Date(`${at}:00+09:00`).toISOString(), type, ...extra };
}

function days(records: PiyoRecord[], from: string, to: string) {
  return summarizeDays(normalizeAll(records), from, to, NOW);
}

describe("sleep", () => {
  it("splits sleep at JST midnight and credits the longest sleep to the wake date", () => {
    const [first, second] = days([record("2026-09-01T22:00", "Sleep"), record("2026-09-02T04:00", "WakeUp")], "2026-09-01", "2026-09-02");
    assert.equal(first?.sleepMinutes, 120);
    assert.equal(first?.longestSleepMinutes, null);
    assert.equal(second?.sleepMinutes, 240);
    assert.equal(second?.longestSleepMinutes, 360);
  });

  it("counts sleep that started the day before the range", () => {
    const [row] = days([record("2026-09-01T22:00", "Sleep"), record("2026-09-02T04:00", "WakeUp")], "2026-09-02", "2026-09-02");
    assert.equal(row?.sleepMinutes, 240);
  });

  it("leaves unpaired records out of the total", () => {
    const [row] = days(
      [
        record("2026-09-01T01:00", "WakeUp"),
        record("2026-09-01T09:00", "Sleep"),
        record("2026-09-01T10:00", "Sleep"),
        record("2026-09-01T11:00", "WakeUp"),
      ],
      "2026-09-01",
      "2026-09-01",
    );
    assert.equal(row?.sleepMinutes, 60);
    assert.equal(row?.unpairedSleepRecords, 2);
  });

  it("accepts 14 hours and rejects a longer pair", () => {
    const [ok] = days([record("2026-09-01T01:00", "Sleep"), record("2026-09-01T15:00", "WakeUp")], "2026-09-01", "2026-09-01");
    const [long] = days([record("2026-09-01T01:00", "Sleep"), record("2026-09-01T15:01", "WakeUp")], "2026-09-01", "2026-09-01");
    assert.equal(ok?.sleepMinutes, 840);
    assert.equal(long?.sleepMinutes, null);
    assert.equal(long?.unpairedSleepRecords, 2);
  });
});

describe("feeding", () => {
  it("joins feeds within 30 minutes and measures from the previous day", () => {
    const [row] = days(
      [
        record("2026-08-31T23:00", "Formula"),
        record("2026-09-01T02:00", "BreastFeeding"),
        record("2026-09-01T02:29", "Formula"),
        record("2026-09-01T06:00", "Formula"),
      ],
      "2026-09-01",
      "2026-09-01",
    );
    assert.equal(row?.feedingSessions, 2);
    assert.equal(row?.averageFeedingIntervalMinutes, 210);
    assert.equal(row?.longestFeedingIntervalMinutes, 240);
  });

  it("sums only recorded ml and pumping sides", () => {
    const [row] = days(
      [
        record("2026-09-01T01:00", "BreastFeeding", { leftTime: 600 }),
        record("2026-09-01T02:00", "Formula", { value: { value: 100, unit: "ml" } }),
        record("2026-09-01T03:00", "Formula", { value: { value: 3, unit: "oz" } }),
        record("2026-09-01T04:00", "Pumping", { value: { left: 40, right: 50, unit: "ml" } }),
      ],
      "2026-09-01",
      "2026-09-01",
    );
    assert.equal(row?.breastMl, 0);
    assert.equal(row?.totalMilkMl, 100);
    assert.equal(row?.pumpingMl, 90);
    assert.equal(row?.unsummedAmounts, 1);
  });
});

describe("other records", () => {
  it("does not count measurements or events as unsummed feeding amounts", () => {
    const [row] = days(
      [
        record("2026-09-01T01:00", "Weight", { value: { value: 6.1, unit: "kg" } }),
        record("2026-09-01T02:00", "Temperature", { value: { value: 36.8, unit: "℃" } }),
        record("2026-09-01T03:00", "Medicine", { value: { value: 1, unit: "包" } }),
        record("2026-09-01T04:00", "Solid", { value: { value: 80, unit: "g" } }),
      ],
      "2026-09-01",
      "2026-09-01",
    );
    assert.equal(row?.recordCount, 4);
    assert.equal(row?.unsummedAmounts, 0);
  });
});

describe("buildSummary", () => {
  const query = { from: "2026-09-08", to: "2026-09-10", groupBy: "day" as const, compare: false };

  it("leaves today and days without records out of averages", () => {
    const result = buildSummary(
      [record("2026-09-08T01:00", "Pee"), record("2026-09-08T02:00", "Pee"), record("2026-09-10T01:00", "Pee")],
      query,
      NOW,
    );
    assert.equal(result.overall.averagedDays, 1);
    assert.equal(result.overall.averages.peeCount, 2);
    assert.equal(result.overall.averages.sleepMinutes, null);
  });

  it("compares with the previous period of the same length", () => {
    const result = buildSummary(
      [record("2026-09-05T01:00", "Pee"), record("2026-09-08T01:00", "Pee"), record("2026-09-08T02:00", "Pee")],
      { ...query, compare: true },
      NOW,
    );
    assert.equal(result.previous?.from, "2026-09-05");
    assert.equal(result.previous?.to, "2026-09-07");
    assert.equal(result.change?.peeCount, 1);
    assert.equal(result.change?.sleepMinutes, null);
  });
});

describe("buildLatest", () => {
  it("returns elapsed minutes and ignores future records", () => {
    const result = buildLatest(
      [record("2026-09-10T11:00", "Formula"), record("2026-09-10T13:00", "Formula"), record("2026-09-10T11:30", "Sleep")],
      NOW,
    );
    assert.equal(result.latest.feeding?.minutesAgo, 60);
    assert.equal(result.sleepingSince, "2026-09-10T02:30:00.000Z");
    assert.equal(result.latest.weight, null);
    assert.equal(result.todaySummary?.formulaCount, 1);
  });

  it("is not sleeping after a WakeUp", () => {
    const result = buildLatest([record("2026-09-10T10:00", "Sleep"), record("2026-09-10T11:00", "WakeUp")], NOW);
    assert.equal(result.sleepingSince, null);
  });
});
