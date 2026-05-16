import { describe, expect, it } from "vitest";

import { pickCanonicalWorkoutRows } from "../pick-canonical-workout-rows";

interface RowFixture {
  id: string;
  startedAt: Date;
  sportType: string;
  source: "APPLE_HEALTH" | "WITHINGS" | "MANUAL" | "IMPORT";
}

describe("pickCanonicalWorkoutRows", () => {
  it("returns the empty list unchanged for an empty input", () => {
    expect(pickCanonicalWorkoutRows([])).toEqual([]);
  });

  it("keeps a single workout regardless of source", () => {
    const rows: RowFixture[] = [
      {
        id: "w-1",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["w-1"]);
  });

  it("prefers APPLE_HEALTH over WITHINGS when both source the same workout", () => {
    const rows: RowFixture[] = [
      {
        id: "apple",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "withings",
        startedAt: new Date("2026-05-16T08:01:30Z"), // 90 s apart — same 5-min slot
        sportType: "running",
        source: "WITHINGS",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["apple"]);
  });

  it("does NOT collapse two distinct runs whose starts are > 5 min apart", () => {
    const rows: RowFixture[] = [
      {
        id: "first",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "second",
        startedAt: new Date("2026-05-16T08:06:00Z"), // 6 min after start — separate bucket
        sportType: "running",
        source: "APPLE_HEALTH",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps workouts of different sports that start in the same minute", () => {
    const rows: RowFixture[] = [
      {
        id: "run",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "cycle",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "cycling",
        source: "APPLE_HEALTH",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id).sort()).toEqual([
      "cycle",
      "run",
    ]);
  });

  it("preserves input order on the output", () => {
    const rows: RowFixture[] = [
      {
        id: "morning",
        startedAt: new Date("2026-05-16T06:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "evening",
        startedAt: new Date("2026-05-16T18:00:00Z"),
        sportType: "cycling",
        source: "APPLE_HEALTH",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual([
      "morning",
      "evening",
    ]);
  });

  it("honours a user-supplied ladder that promotes WITHINGS over APPLE_HEALTH", () => {
    const rows: RowFixture[] = [
      {
        id: "apple",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "withings",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
    ];
    const userPriority = {
      metricPriority: {
        steps: ["WITHINGS", "APPLE_HEALTH", "MANUAL", "IMPORT"],
      },
    };
    expect(
      pickCanonicalWorkoutRows(rows, userPriority).map((r) => r.id),
    ).toEqual(["withings"]);
  });

  it("keeps the manual entry when no priority-ladder source claims the slot", () => {
    // Edge case: a user with both APPLE_HEALTH and WITHINGS still
    // manually recorded an "elliptical" workout the integrations
    // don't track. Manual wins by default (only entry in bucket).
    const rows: RowFixture[] = [
      {
        id: "manual",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "elliptical",
        source: "MANUAL",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["manual"]);
  });

  it("falls through to keeping every row when sources aren't on the ladder at all", () => {
    // Theoretical safety net — no real source emits a value outside
    // the canonical enum, but the picker MUST NEVER drop signal it
    // can't classify. Forcing a ladder of a single source the bucket
    // doesn't carry exercises the fallback path.
    const rows: RowFixture[] = [
      {
        id: "a",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "b",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
    ];
    const oddPriority = {
      metricPriority: {
        steps: ["IMPORT"],
      },
    };
    expect(
      pickCanonicalWorkoutRows(rows, oddPriority)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});
