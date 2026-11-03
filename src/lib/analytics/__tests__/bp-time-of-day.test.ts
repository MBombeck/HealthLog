import { describe, expect, it } from "vitest";

import {
  BP_PART_MIN_READINGS,
  bpPartOfDayForHour,
  computeBpTimeOfDay,
  type BpTimedReading,
} from "../bp-time-of-day";

const reading = (
  iso: string,
  systolic = 130,
  diastolic = 80,
  pulse: number | null = null,
): BpTimedReading => ({ at: new Date(iso), systolic, diastolic, pulse });

/** The part one reading lands in, in `tz`. */
function partOf(iso: string, tz: string) {
  const summary = computeBpTimeOfDay([reading(iso)], tz);
  return summary.parts.find((p) => p.readingCount === 1)?.part;
}

describe("bpPartOfDayForHour", () => {
  it("tiles the day at 04, 12 and 18 with evening wrapping midnight", () => {
    const parts = Array.from({ length: 24 }, (_, h) => bpPartOfDayForHour(h));
    expect(parts).toEqual([
      ...Array(4).fill("evening"), // 00..03
      ...Array(8).fill("morning"), // 04..11
      ...Array(6).fill("midday"), // 12..17
      ...Array(6).fill("evening"), // 18..23
    ]);
  });
});

describe("computeBpTimeOfDay — boundaries", () => {
  it.each([
    ["2026-06-01T03:59:59.999Z", "evening"],
    ["2026-06-01T04:00:00.000Z", "morning"],
    ["2026-06-01T11:59:59.999Z", "morning"],
    ["2026-06-01T12:00:00.000Z", "midday"],
    ["2026-06-01T17:59:59.999Z", "midday"],
    ["2026-06-01T18:00:00.000Z", "evening"],
    ["2026-06-01T00:00:00.000Z", "evening"],
  ])("%s is %s in UTC", (iso, part) => {
    expect(partOf(iso, "UTC")).toBe(part);
  });
});

describe("computeBpTimeOfDay — time zones", () => {
  it("reads the hour in the zone it is given", () => {
    const iso = "2026-06-01T09:00:00.000Z";
    expect(partOf(iso, "UTC")).toBe("morning");
    expect(partOf(iso, "America/New_York")).toBe("morning"); // 05:00
    expect(partOf(iso, "Asia/Tokyo")).toBe("evening"); // 18:00
    expect(partOf(iso, "Asia/Kolkata")).toBe("midday"); // 14:30
  });

  it("follows the autumn change: 02:00 UTC on 25 Oct is 03:00 in Berlin", () => {
    // A fixed summer offset (+2) would call this 04:00 and a morning reading.
    expect(partOf("2026-10-25T02:00:00.000Z", "Europe/Berlin")).toBe("evening");
    expect(partOf("2026-10-25T03:00:00.000Z", "Europe/Berlin")).toBe("morning");
    // Both 02:30s of the repeated hour are the same night's evening.
    expect(partOf("2026-10-25T00:30:00.000Z", "Europe/Berlin")).toBe("evening");
    expect(partOf("2026-10-25T01:30:00.000Z", "Europe/Berlin")).toBe("evening");
  });

  it("follows the spring change: 02:00 UTC on 29 Mar is 04:00 in Berlin", () => {
    // A fixed winter offset (+1) would call this 03:00 and an evening reading.
    expect(partOf("2026-03-29T02:00:00.000Z", "Europe/Berlin")).toBe("morning");
    expect(partOf("2026-03-29T01:59:00.000Z", "Europe/Berlin")).toBe("evening");
  });
});

describe("computeBpTimeOfDay — the reading floor and the difference", () => {
  const morning = (n: number, sys: number, dia: number, pulse?: number) =>
    Array.from({ length: n }, (_, i) =>
      reading(`2026-06-0${i + 1}T07:00:00.000Z`, sys, dia, pulse ?? null),
    );
  const evening = (n: number, sys: number, dia: number) =>
    Array.from({ length: n }, (_, i) =>
      reading(`2026-06-0${i + 1}T21:00:00.000Z`, sys, dia),
    );

  it("gives no mean below the floor, only the count", () => {
    const summary = computeBpTimeOfDay(
      morning(BP_PART_MIN_READINGS - 1, 140, 90),
      "UTC",
    );
    const part = summary.parts[0];
    expect(part).toMatchObject({
      part: "morning",
      readingCount: BP_PART_MIN_READINGS - 1,
      systolic: null,
      diastolic: null,
    });
    expect(summary.morningEveningDifference).toBeNull();
  });

  it("gives the mean at the floor", () => {
    const summary = computeBpTimeOfDay(
      morning(BP_PART_MIN_READINGS, 140, 90),
      "UTC",
    );
    expect(summary.parts[0]).toMatchObject({ systolic: 140, diastolic: 90 });
  });

  it("returns all three parts in order, empty ones included", () => {
    const summary = computeBpTimeOfDay([], "UTC");
    expect(summary.parts.map((p) => p.part)).toEqual([
      "morning",
      "midday",
      "evening",
    ]);
    expect(summary.readingCount).toBe(0);
    expect(summary.parts.every((p) => p.readingCount === 0)).toBe(true);
  });

  it("takes the difference from the two shown whole-mmHg means", () => {
    // Morning means 135.4 / 85.6 → 135 / 86; evening 128.6 / 80.4 → 129 / 80.
    const m = [
      reading("2026-06-01T07:00:00.000Z", 135, 85),
      reading("2026-06-02T07:00:00.000Z", 135, 86),
      reading("2026-06-03T07:00:00.000Z", 135, 86),
      reading("2026-06-04T07:00:00.000Z", 136, 85),
      reading("2026-06-05T07:00:00.000Z", 136, 86),
    ];
    const e = [
      reading("2026-06-01T21:00:00.000Z", 128, 80),
      reading("2026-06-02T21:00:00.000Z", 129, 80),
      reading("2026-06-03T21:00:00.000Z", 129, 81),
      reading("2026-06-04T21:00:00.000Z", 128, 80),
      reading("2026-06-05T21:00:00.000Z", 129, 81),
    ];
    const summary = computeBpTimeOfDay([...m, ...e], "UTC");
    const [mo, , ev] = summary.parts;
    expect([mo.systolic, mo.diastolic, ev.systolic, ev.diastolic]).toEqual([
      135, 86, 129, 80,
    ]);
    expect(summary.morningEveningDifference).toEqual({
      systolic: 6,
      diastolic: 6,
    });
  });

  it("is negative when the evening is higher", () => {
    const summary = computeBpTimeOfDay(
      [...morning(3, 120, 75), ...evening(3, 131, 79)],
      "UTC",
    );
    expect(summary.morningEveningDifference).toEqual({
      systolic: -11,
      diastolic: -4,
    });
  });

  it("averages the pulse only over readings that carried one, on the same floor", () => {
    const rows = [
      ...morning(2, 130, 80, 70),
      reading("2026-06-05T07:00:00.000Z", 130, 80, null),
    ];
    const below = computeBpTimeOfDay(rows, "UTC").parts[0];
    expect(below).toMatchObject({ pulseReadingCount: 2, pulse: null });
    const at = computeBpTimeOfDay(
      [...rows, reading("2026-06-06T07:00:00.000Z", 130, 80, 73)],
      "UTC",
    ).parts[0];
    expect(at).toMatchObject({ pulseReadingCount: 3, pulse: 71 });
  });
});
