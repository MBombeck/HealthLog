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
  extra: Partial<WorkoutPickerRow> = {},
): WorkoutPickerRow => ({
  id,
  source,
  startedAt: D(startedAt),
  sportType,
  ...extra,
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

  it("keeps every workout from the winning source in one cluster", () => {
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      row("withings-1", "WITHINGS", "2026-05-14T07:31:00.000Z"),
      row("apple-2", "APPLE_HEALTH", "2026-05-14T07:32:00.000Z"),
    ]);

    expect(result.canonical.map((item) => item.id)).toEqual([
      "apple-1",
      "apple-2",
    ]);
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

  it("anchors a cluster to its first row instead of chaining neighbours", () => {
    const result = pickCanonicalWorkout([
      row("anchor", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      row("neighbour", "WITHINGS", "2026-05-14T07:34:00.000Z"),
      row("chained", "WITHINGS", "2026-05-14T07:38:00.000Z"),
    ]);

    expect(result.clusters).toHaveLength(2);
    expect(result.canonical.map((item) => item.id)).toEqual([
      "anchor",
      "chained",
    ]);
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
    expect(a.canonical.map((r) => r.id)).toEqual(b.canonical.map((r) => r.id));
  });

  it("preserves same-source workouts at the same timestamp", () => {
    const result = pickCanonicalWorkout([
      row("a-2", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
      row("a-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z"),
    ]);

    expect(result.canonical.map((item) => item.id)).toEqual(["a-1", "a-2"]);
  });
});

describe("pickCanonicalWorkout — field-merge (v1.29.x, WHOOP HR-loss fix)", () => {
  it("backfills avgHeartRate/maxHeartRate from a lower-priority twin when the winner's is null", () => {
    // Regression fixture from the brief: a WHOOP cycling row carries live
    // HR; a higher-priority Apple Health twin for the SAME ride has no HR
    // (e.g. a manually-logged / GPS-only Apple entry). Before the merge,
    // the picker kept the Apple row whole and threw the WHOOP HR away.
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z", "cycling", {
        avgHeartRate: null,
        maxHeartRate: null,
      }),
      row("whoop-1", "WHOOP", "2026-05-14T07:31:00.000Z", "cycling", {
        avgHeartRate: 142,
        maxHeartRate: 168,
      }),
    ]);
    expect(result.canonical).toHaveLength(1);
    const winner = result.canonical[0];
    expect(winner.id).toBe("apple-1"); // ladder winner stays the base row
    expect(winner.avgHeartRate).toBe(142);
    expect(winner.maxHeartRate).toBe(168);
    expect(result.clusters[0].picked.avgHeartRate).toBe(142);
  });

  it("backfills a lower-priority donor only onto its nearest winning-source workout", () => {
    const fixtures = [
      row(
        "apple-earlier",
        "APPLE_HEALTH",
        "2026-05-14T07:30:00.000Z",
        "running",
        {
          avgHeartRate: null,
        },
      ),
      row(
        "apple-later",
        "APPLE_HEALTH",
        "2026-05-14T07:34:00.000Z",
        "running",
        {
          avgHeartRate: null,
        },
      ),
      row("whoop-later", "WHOOP", "2026-05-14T07:34:00.000Z", "running", {
        avgHeartRate: 151,
      }),
    ];

    for (const input of [fixtures, [...fixtures].reverse()]) {
      const result = pickCanonicalWorkout(input);

      expect(
        result.canonical.map(({ id, source, avgHeartRate }) => ({
          id,
          source,
          avgHeartRate,
        })),
      ).toEqual([
        {
          id: "apple-earlier",
          source: "APPLE_HEALTH",
          avgHeartRate: null,
        },
        {
          id: "apple-later",
          source: "APPLE_HEALTH",
          avgHeartRate: 151,
        },
      ]);
    }
  });

  it("never overwrites a field the base row already has", () => {
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z", "cycling", {
        avgHeartRate: 120,
      }),
      row("whoop-1", "WHOOP", "2026-05-14T07:31:00.000Z", "cycling", {
        avgHeartRate: 142,
      }),
    ]);
    expect(result.canonical[0].avgHeartRate).toBe(120);
  });

  it("backfills totalEnergyKcal, totalDistanceM, and elevationM independently", () => {
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z", "cycling", {
        totalEnergyKcal: null,
        totalDistanceM: 15000,
        elevationM: null,
      }),
      row("whoop-1", "WHOOP", "2026-05-14T07:31:00.000Z", "cycling", {
        totalEnergyKcal: 480,
        totalDistanceM: 14800,
        elevationM: 220,
      }),
    ]);
    const winner = result.canonical[0];
    expect(winner.totalEnergyKcal).toBe(480); // backfilled
    expect(winner.totalDistanceM).toBe(15000); // base row's own value kept
    expect(winner.elevationM).toBe(220); // backfilled
  });

  it("prefers the ladder-highest member that HAS a field over a lower one, when the base row lacks it", () => {
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z", "cycling", {
        avgHeartRate: null,
      }),
      row("whoop-1", "WHOOP", "2026-05-14T07:30:30.000Z", "cycling", {
        avgHeartRate: 142,
      }),
      row("withings-1", "WITHINGS", "2026-05-14T07:31:00.000Z", "cycling", {
        avgHeartRate: 99,
      }),
    ]);
    // WHOOP outranks WITHINGS on the default ladder — its HR wins the
    // backfill even though WITHINGS also had one.
    expect(result.canonical[0].avgHeartRate).toBe(142);
  });

  it("adopts a specific sport type from a member when the base row's own sportType is generic", () => {
    // The confirmed bug's downstream symptom: before the WHOOP sport-map
    // fix, a WHOOP cycling workout could carry sportType "other" (or a
    // non-canonical raw label) while a lower-priority twin correctly
    // tagged "cycling". The merge adopts the specific sport so the
    // cluster still surfaces as a bike ride.
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z", "other"),
      row("whoop-1", "WHOOP", "2026-05-14T07:31:00.000Z", "cycling"),
    ]);
    expect(result.canonical[0].sportType).toBe("cycling");
  });

  it("keeps the base row's own specific sportType even when a member disagrees", () => {
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z", "cycling"),
      row("whoop-1", "WHOOP", "2026-05-14T07:31:00.000Z", "cycling"),
    ]);
    expect(result.canonical[0].sportType).toBe("cycling");
  });

  it("does not run the merge on a single-element cluster", () => {
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z", "cycling", {
        avgHeartRate: null,
      }),
    ]);
    expect(result.canonical[0].avgHeartRate).toBeNull();
  });

  it("end-to-end: a WHOOP-cycling+HR row clustered with a generic no-HR twin yields a cycling canonical row WITH the HR", () => {
    const result = pickCanonicalWorkout([
      row("apple-1", "APPLE_HEALTH", "2026-05-14T07:30:00.000Z", "other", {
        avgHeartRate: null,
        totalEnergyKcal: null,
      }),
      row("whoop-1", "WHOOP", "2026-05-14T07:31:00.000Z", "cycling", {
        avgHeartRate: 145,
        totalEnergyKcal: 512,
      }),
    ]);
    expect(result.canonical).toHaveLength(1);
    const winner = result.canonical[0];
    expect(winner.source).toBe("APPLE_HEALTH"); // ladder still picks Apple as the base
    expect(winner.sportType).toBe("cycling"); // adopted from WHOOP
    expect(winner.avgHeartRate).toBe(145); // backfilled from WHOOP
    expect(winner.totalEnergyKcal).toBe(512); // backfilled from WHOOP
  });
});

describe("pickCanonicalWorkout — Strava brick-workout regression", () => {
  // Legacy Strava labels ("Ride", "Run") are both generic to this picker,
  // so they share a cluster. The source is identical, however, which means
  // both legs are distinct records and must survive.
  it("preserves two same-source raw Strava workouts in one cluster", () => {
    const result = pickCanonicalWorkout([
      row("strava-ride", "STRAVA", "2026-06-01T15:00:00.000Z", "Ride"),
      row("strava-run", "STRAVA", "2026-06-01T15:03:00.000Z", "Run"),
    ]);

    expect(result.clusters).toHaveLength(1);
    expect(result.canonical.map((item) => item.id)).toEqual([
      "strava-ride",
      "strava-run",
    ]);
  });

  it("post-fix: a canonical Strava Ride + Run pair survives as two distinct rows", () => {
    // Same timing as the pre-fix fixture above, but with the sportType
    // values `mapActivity()` now writes (via `mapStravaSportType()`):
    // "Ride" → "cycling", "Run" → "running". Both are SPECIFIC canonical
    // buckets and differ from each other, so `isSpecificSportType()` no
    // longer treats them as sport-compatible and the brick session
    // survives as two workouts.
    const result = pickCanonicalWorkout([
      row("strava-ride", "STRAVA", "2026-06-01T15:00:00.000Z", "cycling"),
      row("strava-run", "STRAVA", "2026-06-01T15:03:00.000Z", "running"),
    ]);
    expect(result.clusters).toHaveLength(2);
    expect(result.canonical).toHaveLength(2);
    const sports = result.canonical.map((w) => w.sportType).sort();
    expect(sports).toEqual(["cycling", "running"]);
  });
});
