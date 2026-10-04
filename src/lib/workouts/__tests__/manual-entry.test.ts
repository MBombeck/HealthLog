import { describe, expect, it } from "vitest";

import {
  buildManualWorkoutEntry,
  canLogWorkout,
  emptyManualWorkoutDraft,
  newManualWorkoutExternalId,
  wallClockNow,
  type ManualWorkoutContext,
  type ManualWorkoutDraft,
} from "@/lib/workouts/manual-entry";
import { createBatchWorkoutSchema } from "@/lib/validations/workout";

const NOW = new Date("2026-09-15T12:00:00Z");
const ID = "manual:5b0f3c1e-1111-4222-8333-444455556666";

const CTX: ManualWorkoutContext = {
  timezone: "Europe/Berlin",
  unitPreference: "metric",
  externalId: ID,
  now: NOW,
};

function draft(over: Partial<ManualWorkoutDraft> = {}): ManualWorkoutDraft {
  return {
    sportType: "running",
    // 08:00 in Berlin (UTC+2 in September) = 06:00Z.
    start: "2026-09-15T08:00",
    hours: "0",
    minutes: "45",
    distance: "",
    energyKcal: "",
    ...over,
  };
}

function errorsOf(over: Partial<ManualWorkoutDraft>, ctx = CTX) {
  const result = buildManualWorkoutEntry(draft(over), ctx);
  if (result.ok) throw new Error("expected the draft to be refused");
  return result.errors;
}

describe("buildManualWorkoutEntry — the payload", () => {
  it("builds exactly the batch entry: MANUAL, the form's external id, start + duration", () => {
    const result = buildManualWorkoutEntry(draft(), CTX);
    expect(result).toEqual({
      ok: true,
      entry: {
        sportType: "running",
        startedAt: "2026-09-15T06:00:00.000Z",
        endedAt: "2026-09-15T06:45:00.000Z",
        source: "MANUAL",
        externalId: ID,
      },
    });
  });

  it("sends the same external id on every submit of one form", () => {
    const a = buildManualWorkoutEntry(draft(), CTX);
    const b = buildManualWorkoutEntry(draft(), { ...CTX, now: new Date() });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.entry.externalId).toBe(b.entry.externalId);
  });

  it("is accepted by the batch route's own schema", () => {
    const result = buildManualWorkoutEntry(
      draft({ distance: "10,5", energyKcal: "640" }),
      CTX,
    );
    if (!result.ok) throw new Error("expected ok");
    const parsed = createBatchWorkoutSchema.safeParse({
      workouts: [result.entry],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.workouts[0]!.source).toBe("MANUAL");
  });

  it("reads the start in the profile zone, not the device's", () => {
    const result = buildManualWorkoutEntry(
      draft({ start: "2026-09-15T05:00" }),
      {
        ...CTX,
        timezone: "America/New_York",
      },
    );
    // 05:00 in New York (UTC-4 in September) = 09:00Z.
    expect(result.ok && result.entry.startedAt).toBe(
      "2026-09-15T09:00:00.000Z",
    );
  });

  it("stores a metric distance in metres and energy as typed", () => {
    const result = buildManualWorkoutEntry(
      draft({ distance: "5,25", energyKcal: "312.5" }),
      CTX,
    );
    expect(result.ok && result.entry.totalDistanceM).toBe(5250);
    expect(result.ok && result.entry.totalEnergyKcal).toBe(312.5);
  });

  it("converts an imperial distance from miles to metres", () => {
    const result = buildManualWorkoutEntry(draft({ distance: "3.1" }), {
      ...CTX,
      unitPreference: "imperial",
    });
    // 3.1 mi = 4988.97 m, stored to a tenth.
    expect(result.ok && result.entry.totalDistanceM).toBe(4989);
  });

  it("leaves distance and energy out when they were not entered", () => {
    const result = buildManualWorkoutEntry(draft(), CTX);
    expect(result.ok && "totalDistanceM" in result.entry).toBe(false);
    expect(result.ok && "totalEnergyKcal" in result.entry).toBe(false);
  });

  it("accepts a session of exactly 24 hours", () => {
    const result = buildManualWorkoutEntry(
      draft({ start: "2026-09-14T08:00", hours: "24", minutes: "" }),
      CTX,
    );
    expect(result.ok && result.entry.endedAt).toBe("2026-09-15T06:00:00.000Z");
  });
});

describe("buildManualWorkoutEntry — validation", () => {
  it("asks for a sport", () => {
    expect(errorsOf({ sportType: "" }).sportType).toBe(
      "insights.workouts.manual.errors.sportRequired",
    );
  });

  it("refuses a start in the future", () => {
    expect(errorsOf({ start: "2026-09-15T15:00" }).start).toBe(
      "insights.workouts.manual.errors.startInFuture",
    );
  });

  it("tolerates the minute the form was opened in", () => {
    // 13:15 Berlin + 45 min ends at 12:00Z, 30 s past `now`: inside the slack.
    const result = buildManualWorkoutEntry(
      draft({ start: "2026-09-15T13:15" }),
      {
        ...CTX,
        now: new Date("2026-09-15T11:59:30Z"),
      },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a workout that would end in the future", () => {
    // Logged at 14:00 Berlin with the start left at 13:30: 45 min ends 14:15.
    expect(errorsOf({ start: "2026-09-15T13:30" }).duration).toBe(
      "insights.workouts.manual.errors.endInFuture",
    );
  });

  it("refuses a start it cannot read", () => {
    expect(errorsOf({ start: "2026-09-15" }).start).toBe(
      "insights.workouts.manual.errors.startRequired",
    );
  });

  it("reads a blank start as now minus the duration (#1085)", () => {
    // NOW is 12:00Z; 45 minutes logged right after finishing.
    const result = buildManualWorkoutEntry(draft({ start: "" }), CTX);
    expect(result.ok).toBe(true);
    expect(result.ok && result.entry.startedAt).toBe(
      "2026-09-15T11:15:00.000Z",
    );
    expect(result.ok && result.entry.endedAt).toBe("2026-09-15T12:00:00.000Z");
  });

  it("never reports a blank start as ending in the future", () => {
    const result = buildManualWorkoutEntry(
      draft({ start: "", hours: "3", minutes: "0" }),
      CTX,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.entry.endedAt).toBe("2026-09-15T12:00:00.000Z");
  });

  it("refuses a zero duration", () => {
    expect(errorsOf({ hours: "", minutes: "" }).duration).toBe(
      "insights.workouts.manual.errors.durationRequired",
    );
    expect(errorsOf({ hours: "0", minutes: "0" }).duration).toBe(
      "insights.workouts.manual.errors.durationRequired",
    );
  });

  it("refuses more than 24 hours", () => {
    expect(errorsOf({ hours: "24", minutes: "1" }).duration).toBe(
      "insights.workouts.manual.errors.durationTooLong",
    );
  });

  it("refuses minutes past 59 and anything that is not a whole number", () => {
    for (const over of [
      { minutes: "60" },
      { minutes: "-5" },
      { hours: "1.5" },
      { hours: "abc" },
    ]) {
      expect(errorsOf(over).duration, JSON.stringify(over)).toBe(
        "insights.workouts.manual.errors.durationInvalid",
      );
    }
  });

  it("refuses a negative, garbled or impossible distance", () => {
    for (const distance of ["-1", "5km", "1000.1"]) {
      expect(errorsOf({ distance }).distance, distance).toBe(
        "insights.workouts.manual.errors.distanceInvalid",
      );
    }
    // The ceiling is in metres, so it binds in miles too.
    expect(
      errorsOf({ distance: "622" }, { ...CTX, unitPreference: "imperial" })
        .distance,
    ).toBe("insights.workouts.manual.errors.distanceInvalid");
  });

  it("accepts a zero distance", () => {
    const result = buildManualWorkoutEntry(draft({ distance: "0" }), CTX);
    expect(result.ok && result.entry.totalDistanceM).toBe(0);
  });

  it("refuses negative or implausible energy", () => {
    for (const energyKcal of ["-10", "20001", "lots"]) {
      expect(errorsOf({ energyKcal }).energyKcal, energyKcal).toBe(
        "insights.workouts.manual.errors.energyInvalid",
      );
    }
  });

  it("reports every refused field at once", () => {
    const errors = errorsOf({ sportType: "", minutes: "", hours: "" });
    expect(Object.keys(errors).sort()).toEqual(["duration", "sportType"]);
  });
});

describe("the form's defaults", () => {
  it("opens with a blank start; the field caps at the current minute", () => {
    expect(wallClockNow(NOW, "Europe/Berlin")).toBe("2026-09-15T14:00");
    expect(emptyManualWorkoutDraft()).toMatchObject({
      sportType: "",
      start: "",
      hours: "",
      minutes: "",
    });
  });

  it("mints a distinct, stable-shaped external id per form", () => {
    const a = newManualWorkoutExternalId();
    const b = newManualWorkoutExternalId();
    expect(a).toMatch(/^manual:[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

describe("canLogWorkout — who is offered the entry", () => {
  const OWN = { inSharedRecord: false };
  const SHARED = { inSharedRecord: true };

  it("offers it in one's own record with the workouts module on", () => {
    expect(canLogWorkout(OWN, { workouts: true })).toBe(true);
  });

  it("offers it while the module map is still loading", () => {
    expect(canLogWorkout(OWN, undefined)).toBe(true);
    expect(canLogWorkout(OWN, null)).toBe(true);
  });

  it("withholds it when the workouts module is off", () => {
    expect(canLogWorkout(OWN, { workouts: false })).toBe(false);
  });

  it("does not follow any other module", () => {
    expect(canLogWorkout(OWN, { mood: false, recovery: false })).toBe(true);
  });

  it("withholds it inside somebody else's record", () => {
    expect(canLogWorkout(SHARED, { workouts: true })).toBe(false);
  });
});
