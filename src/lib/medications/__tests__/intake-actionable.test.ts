/**
 * #1040 — a medication whose course has ended must not offer a dose.
 * The course bounds are calendar dates (UTC midnight of the date); only
 * `now` is read on the user's clock. A course that ends today stays
 * actionable for the whole local day, east and west of UTC.
 */
import { describe, expect, it } from "vitest";

import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";

import { resolveIntakeActionability } from "../intake-actionable";

const ZONES = [
  "America/Los_Angeles",
  "America/New_York",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Pacific/Auckland",
] as const;

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function at(tz: string, d: number, hour: number, minute = 0): Date {
  return zonedWallClockToUtc(
    { year: 2026, month: 9, day: d, hour, minute },
    tz,
  );
}

const base = {
  active: true,
  trackIntake: true,
  startsOn: day("2026-09-01"),
  endsOn: day("2026-09-20"),
  endedAt: null,
};

describe.each(ZONES)("course window in %s", (tz) => {
  it("is actionable on the last course day, from local midnight to 23:59", () => {
    for (const [h, m] of [
      [0, 0],
      [8, 0],
      [23, 59],
    ] as const) {
      const r = resolveIntakeActionability(base, at(tz, 20, h, m), tz);
      expect(r).toEqual({
        courseStatus: "CURRENT",
        intakeActionable: true,
        canEndCourse: true,
      });
    }
  });

  it("is ended from local midnight of the day after endsOn", () => {
    const r = resolveIntakeActionability(base, at(tz, 21, 0, 0), tz);
    expect(r).toEqual({
      courseStatus: "ENDED",
      intakeActionable: false,
      canEndCourse: false,
    });
  });

  it("is upcoming until local midnight of startsOn", () => {
    const med = { ...base, startsOn: day("2026-09-25"), endsOn: null };
    expect(resolveIntakeActionability(med, at(tz, 24, 23, 59), tz)).toEqual({
      courseStatus: "UPCOMING",
      intakeActionable: false,
      canEndCourse: false,
    });
    expect(resolveIntakeActionability(med, at(tz, 25, 0, 0), tz)).toEqual({
      courseStatus: "CURRENT",
      intakeActionable: true,
      canEndCourse: true,
    });
  });
});

describe("resolveIntakeActionability", () => {
  const tz = "Europe/Berlin";
  const now = at(tz, 10, 9);

  it("treats an open-ended course as current", () => {
    expect(
      resolveIntakeActionability(
        { ...base, startsOn: null, endsOn: null },
        now,
        tz,
      ).intakeActionable,
    ).toBe(true);
  });

  it("refuses a paused or archived medication inside its course", () => {
    const r = resolveIntakeActionability({ ...base, active: false }, now, tz);
    expect(r).toEqual({
      courseStatus: "CURRENT",
      intakeActionable: false,
      canEndCourse: true,
    });
  });

  it("refuses a record-only medication inside its course", () => {
    const r = resolveIntakeActionability(
      { ...base, trackIntake: false },
      now,
      tz,
    );
    expect(r).toEqual({
      courseStatus: "CURRENT",
      intakeActionable: false,
      canEndCourse: true,
    });
  });

  it("reports ENDED for a course that is also paused", () => {
    const r = resolveIntakeActionability(
      { ...base, active: false },
      at(tz, 22, 9),
      tz,
    );
    expect(r.courseStatus).toBe("ENDED");
  });
});

describe("a course ended with End course (#1280)", () => {
  const ended = {
    ...base,
    endsOn: day("2026-09-20"),
    endedAt: new Date("2026-09-20T10:00:00.000Z"),
  };

  it("is running until the instant and ended from it, not from midnight", () => {
    const before = resolveIntakeActionability(
      ended,
      new Date("2026-09-20T09:59:00.000Z"),
      "UTC",
    );
    expect(before).toEqual({
      courseStatus: "CURRENT",
      intakeActionable: true,
      canEndCourse: true,
    });
    const after = resolveIntakeActionability(
      ended,
      new Date("2026-09-20T10:00:00.000Z"),
      "UTC",
    );
    expect(after).toEqual({
      courseStatus: "ENDED",
      intakeActionable: false,
      canEndCourse: false,
    });
  });
});
