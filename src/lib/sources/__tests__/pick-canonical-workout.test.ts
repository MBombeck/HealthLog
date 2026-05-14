import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKOUT_PROXIMITY_MINUTES,
  DEFAULT_WORKOUT_SOURCE_PRIORITY,
  pickCanonicalWorkout,
  type WorkoutPickerRow,
} from "../pick-canonical-workout";

/**
 * v1.4.25 W16a — `pickCanonicalWorkout` unit tests.
 *
 * Three primary fixtures match the W16a brief:
 *   (a) two sources record the SAME workout (within proximity, same
 *       sport) — picker keeps the canonical one.
 *   (b) two sources record DIFFERENT workouts close in time (within
 *       proximity but different sport types) — picker keeps both.
 *   (c) single source — pass-through.
 *
 * Edge fixtures verify the proximity-window boundary, the determinism
 * contract, and the empty-input fast path.
 */

const D = (iso: string): Date => new Date(iso);

const row = (
  id: string,
  source: WorkoutPickerRow["source"],
  startedAt: string,
  sportType: WorkoutPickerRow["sportType"] = "running",
): WorkoutPickerRow => ({
  id,
  source,
  startedAt: D(startedAt),
  sportType,
});

describe("DEFAULT_WORKOUT_SOURCE_PRIORITY", () => {
  it("places APPLE_HEALTH ahead of WITHINGS for cumulative workouts", () => {
    const apple = DEFAULT_WORKOUT_SOURCE_PRIORITY.indexOf("APPLE_HEALTH");
    const withings = DEFAULT_WORKOUT_SOURCE_PRIORITY.indexOf("WITHINGS");
    expect(apple).toBeGreaterThanOrEqual(0);
    expect(withings).toBeGreaterThan(apple);
  });

  it("places MANUAL ahead of IMPORT so user-typed entries beat bulk loads", () => {
    const manual = DEFAULT_WORKOUT_SOURCE_PRIORITY.indexOf("MANUAL");
    const importIdx = DEFAULT_WORKOUT_SOURCE_PRIORITY.indexOf("IMPORT");
    expect(importIdx).toBeGreaterThan(manual);
  });
});

describe("pickCanonicalWorkout — fixture (a) two-source same workout", () => {
  it("keeps the APPLE_HEALTH row when both sources record the same run", () => {
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      // Withings ingested the same workout 60 seconds later (typical
      // API-pull lag). Same sport, well within the 5-minute window.
      row("withings-1", "WITHINGS", "2026-05-14T07:31:00.000Z"),
    ]);
    expect(result.canonical).toHaveLength(1);
    expect(result.canonical[0].id).toBe("apple-1");
    expect(result.canonical[0].source).toBe("APPLE_HEALTH");
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].members).toHaveLength(2);
    expect(result.clusters[0].pickedSource).toBe("APPLE_HEALTH");
  });

  it("still picks APPLE_HEALTH when the Withings row arrives first", () => {
    const result = pickCanonicalWorkout([
      row("withings-1", "WITHINGS", "2026-05-14T07:30:00.000Z"),
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:31:30.000Z"),
    ]);
    expect(result.canonical.map((r) => r.id)).toEqual(["apple-1"]);
  });

  it("honours a per-user override that flips the ladder", () => {
    const result = pickCanonicalWorkout(
      [
        row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
        row("withings-1", "WITHINGS", "2026-05-14T07:31:00.000Z"),
      ],
      { sourcePriority: ["WITHINGS", "APPLE_HEALTH", "MANUAL", "IMPORT"] },
    );
    expect(result.canonical.map((r) => r.id)).toEqual(["withings-1"]);
  });
});

describe("pickCanonicalWorkout — fixture (b) two-source different workouts close in time", () => {
  it("keeps both rows when sport types differ within the proximity window", () => {
    const result = pickCanonicalWorkout([
      // 07:30 Walking + 07:32 Running — same wall-clock burst (user
      // tapped one workout, the watch logged a separate one) but
      // different sport types, so they must stay distinct rows.
      row("walk-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z", "walking"),
      row("run-1", "WITHINGS", "2026-05-14T07:32:00.000Z", "running"),
    ]);
    expect(result.canonical).toHaveLength(2);
    expect(result.canonical.map((r) => r.id).sort()).toEqual([
      "run-1",
      "walk-1",
    ]);
    expect(result.clusters).toHaveLength(2);
  });

  it("keeps both rows when the same sport occurs outside the proximity window", () => {
    const result = pickCanonicalWorkout([
      row("run-am", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      // 2 hours later — well past the 5-minute cluster window. A
      // morning run and an afternoon run on the same day must NOT
      // collapse into one canonical row.
      row("run-pm", "WITHINGS", "2026-05-14T09:30:00.000Z"),
    ]);
    expect(result.canonical).toHaveLength(2);
    expect(result.clusters).toHaveLength(2);
  });
});

describe("pickCanonicalWorkout — fixture (c) single source pass-through", () => {
  it("returns the only row unchanged when no other source contributed", () => {
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
    ]);
    expect(result.canonical).toHaveLength(1);
    expect(result.canonical[0].id).toBe("apple-1");
    expect(result.clusters[0].pickedSource).toBe("APPLE_HEALTH");
  });

  it("passes through a batch of disjoint single-source workouts", () => {
    const result = pickCanonicalWorkout([
      row("run-1", "APPLE_HEALTH", "2026-05-13T07:30:00.000Z"),
      row("run-2", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      row("run-3", "APPLE_HEALTH", "2026-05-15T07:30:00.000Z"),
    ]);
    expect(result.canonical.map((r) => r.id)).toEqual([
      "run-1",
      "run-2",
      "run-3",
    ]);
  });

  it("returns empty for empty input", () => {
    const result = pickCanonicalWorkout([]);
    expect(result.canonical).toHaveLength(0);
    expect(result.clusters).toHaveLength(0);
  });
});

describe("pickCanonicalWorkout — proximity-window boundary", () => {
  it("exposes the default proximity window as 5 minutes", () => {
    expect(DEFAULT_WORKOUT_PROXIMITY_MINUTES).toBe(5);
  });

  it("clusters two rows exactly at the proximity boundary", () => {
    // 5-minute gap — picker accepts the boundary as in-window so a
    // server's coarse cron tick (Withings hourly pull at HH:00 paired
    // with HKWorkout export at HH:05) still dedups cleanly.
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      row("withings-1", "WITHINGS", "2026-05-14T07:35:00.000Z"),
    ]);
    expect(result.canonical).toHaveLength(1);
  });

  it("keeps two rows just outside the proximity window", () => {
    // 5 minutes and 1 second — picker rejects, two clusters.
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      row("withings-1", "WITHINGS", "2026-05-14T07:35:01.000Z"),
    ]);
    expect(result.canonical).toHaveLength(2);
  });

  it("respects a custom proximity window", () => {
    // Same fixture as the same-workout case but with a 30-second
    // window — the 60-second-later Withings row falls outside and
    // both rows survive.
    const result = pickCanonicalWorkout(
      [
        row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
        row("withings-1", "WITHINGS", "2026-05-14T07:31:00.000Z"),
      ],
      { proximityMinutes: 0.5 },
    );
    expect(result.canonical).toHaveLength(2);
  });
});

describe("pickCanonicalWorkout — determinism", () => {
  it("returns the same canonical list regardless of input order", () => {
    const a = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      row("withings-1", "WITHINGS", "2026-05-14T07:31:00.000Z"),
      row("manual-1", "MANUAL", "2026-05-14T07:30:30.000Z"),
    ]);
    const b = pickCanonicalWorkout([
      row("manual-1", "MANUAL", "2026-05-14T07:30:30.000Z"),
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      row("withings-1", "WITHINGS", "2026-05-14T07:31:00.000Z"),
    ]);
    expect(a.canonical.map((r) => r.id)).toEqual(
      b.canonical.map((r) => r.id),
    );
  });

  it("breaks same-timestamp ties via id ordering", () => {
    const result = pickCanonicalWorkout([
      row("a-2", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      row("a-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
    ]);
    // Both rows are APPLE_HEALTH within the same cluster — the picker
    // keeps the lexicographically-earlier `id` so the choice is
    // independent of the caller's input order.
    expect(result.canonical).toHaveLength(1);
    expect(result.canonical[0].id).toBe("a-1");
  });
});
