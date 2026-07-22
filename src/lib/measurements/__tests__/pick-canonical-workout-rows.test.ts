import { describe, expect, it } from "vitest";

import { pickCanonicalWorkoutRows } from "../pick-canonical-workout-rows";

interface RowFixture {
  id: string;
  startedAt: Date;
  sportType: string;
  source: "APPLE_HEALTH" | "WHOOP" | "WITHINGS" | "MANUAL" | "IMPORT";
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

  it("collapses a WHOOP run and the same Apple-Health run to APPLE_HEALTH", () => {
    // The E-slice oracle for workouts (v1.11.0): a WHOOP strap and an Apple
    // Watch both log the same run within the 5-min clustering window. Apple
    // Watch GPS + HR is the richer record, so it leads the default workout
    // ladder; WHOOP ranks second. WHOOP's `start` typically differs from the
    // HealthKit `startDate` by seconds — well inside the window.
    const rows: RowFixture[] = [
      {
        id: "whoop",
        startedAt: new Date("2026-06-03T06:30:00Z"),
        sportType: "running",
        source: "WHOOP",
      },
      {
        id: "apple",
        startedAt: new Date("2026-06-03T06:30:40Z"), // 40 s apart — same slot
        sportType: "running",
        source: "APPLE_HEALTH",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["apple"]);
  });

  it("keeps the WHOOP run when no richer source logged the same session", () => {
    const rows: RowFixture[] = [
      {
        id: "whoop",
        startedAt: new Date("2026-06-03T06:30:00Z"),
        sportType: "running",
        source: "WHOOP",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["whoop"]);
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

  it("preserves same-source workouts inside one canonical slot", () => {
    const rows: RowFixture[] = [
      {
        id: "first",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "second",
        startedAt: new Date("2026-05-16T08:03:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
    ];

    expect(pickCanonicalWorkoutRows(rows).map((row) => row.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not chain neighbouring workouts across fixed canonical slots", () => {
    const rows: RowFixture[] = [
      {
        id: "first",
        startedAt: new Date("2026-05-16T08:04:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "middle",
        startedAt: new Date("2026-05-16T08:08:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
      {
        id: "last",
        startedAt: new Date("2026-05-16T08:12:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
    ];

    expect(pickCanonicalWorkoutRows(rows).map((row) => row.id)).toEqual([
      "first",
      "middle",
      "last",
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
    expect(
      pickCanonicalWorkoutRows(rows)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["cycle", "run"]);
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
    // can't classify. Since v1.16.11 the resolver reconciles every
    // stored ladder against the defaults, so ANY enum source is always
    // ranked — the only unrankable rows carry a source outside the
    // enum entirely (a future source reaching an old reader).
    const rows = [
      {
        id: "a",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "SOMETHING_NEW" as never,
      },
      {
        id: "b",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "running",
        source: "SOMETHING_ELSE" as never,
      },
    ] as RowFixture[];
    expect(
      pickCanonicalWorkoutRows(rows, null)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("a stored single-source ladder still resolves a canonical row (reconciled defaults rank the rest)", () => {
    // The pre-v1.16.11 contract for this input was "nothing ranked →
    // keep both"; reconciliation now appends the default ladder after
    // the stored entry, so the bucket resolves one canonical row like
    // every ranked pick.
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
    const picked = pickCanonicalWorkoutRows(rows, {
      metricPriority: { steps: ["IMPORT"] },
    }).map((r) => r.id);
    expect(picked).toHaveLength(1);
  });
});
