import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  __resetCoachSnapshotCacheForTests,
  buildCoachSnapshot,
} from "../snapshot";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    workout: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/insights/features", () => ({
  extractFeatures: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { extractFeatures } from "@/lib/insights/features";

const prismaMock = prisma as unknown as {
  measurement: { findMany: ReturnType<typeof vi.fn> };
  moodEntry: { findMany: ReturnType<typeof vi.fn> };
  medicationIntakeEvent: { findMany: ReturnType<typeof vi.fn> };
  workout: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};
const featuresMock = extractFeatures as unknown as ReturnType<typeof vi.fn>;

/**
 * v1.4.23 W4 F6 — pins the Apple Health timeline blocks the Coach
 * snapshot must ship when the user has HealthKit data and explicitly
 * scopes the new sources.
 *
 * Defensive design: web-only accounts that omit the new scope tokens
 * keep paying zero extra SQL, and accounts that toggle the scope on
 * but have no rows still produce a `general` snapshot — the block is
 * only emitted when at least one row exists.
 */
function daysAgo(
  n: number,
  value: number,
  type: string,
): { type: string; value: number; measuredAt: Date } {
  const ms = Date.now() - n * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  d.setUTCHours(9, 0, 0, 0);
  return { type, value, measuredAt: d };
}

describe("buildCoachSnapshot — Apple Health additive metrics (v1.4.23)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // v1.4.33 — `buildCoachSnapshot` now memoises results in-process
    // for 60 s; reset between tests so each fixture is read fresh.
    __resetCoachSnapshotCacheForTests();
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    prismaMock.workout.findMany.mockResolvedValue([]);
    // v1.4.23 H4 — snapshot now reads `User.coachPrefsJson`. Default
    // null = legacy defaults so the existing test fixtures stay
    // representative of the v1.4.22 behaviour.
    prismaMock.user.findUnique.mockResolvedValue({ coachPrefsJson: null });
    featuresMock.mockResolvedValue({
      bloodPressure: undefined,
      weight: undefined,
      pulse: undefined,
      mood: undefined,
    });
  });

  it("emits an hrv timeline block when scope.sources includes 'hrv' and rows exist", async () => {
    const rows = [
      daysAgo(2, 64, "HEART_RATE_VARIABILITY"),
      daysAgo(5, 71, "HEART_RATE_VARIABILITY"),
    ];
    prismaMock.measurement.findMany.mockResolvedValue(rows);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["hrv"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;

    expect(snapshot.heartRateVariability).toBeDefined();
    expect(out.provenance.metrics).toContain("hrv");
    expect(out.provenance.counts?.hrv).toBe(2);
  });

  it("emits a sleep timeline block on SLEEP_DURATION rows", async () => {
    const rows = [
      daysAgo(1, 420, "SLEEP_DURATION"),
      daysAgo(3, 510, "SLEEP_DURATION"),
      daysAgo(7, 480, "SLEEP_DURATION"),
    ];
    prismaMock.measurement.findMany.mockResolvedValue(rows);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["sleep"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;

    expect(snapshot.sleep).toBeDefined();
    expect(out.provenance.metrics).toContain("sleep");
    expect(out.provenance.counts?.sleep).toBe(3);
  });

  it("emits both hrv + sleep blocks when scope toggles both", async () => {
    const rows = [
      daysAgo(2, 64, "HEART_RATE_VARIABILITY"),
      daysAgo(3, 510, "SLEEP_DURATION"),
    ];
    prismaMock.measurement.findMany.mockResolvedValue(rows);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["hrv", "sleep"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;

    expect(snapshot.heartRateVariability).toBeDefined();
    expect(snapshot.sleep).toBeDefined();
    expect(out.provenance.metrics).toEqual(
      expect.arrayContaining(["hrv", "sleep"]),
    );
  });

  it("omits the apple-health block entirely when rows are absent", async () => {
    // Scope says we want HRV, but the SQL fetch returned nothing.
    prismaMock.measurement.findMany.mockResolvedValue([]);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["hrv"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;

    expect(snapshot.heartRateVariability).toBeUndefined();
    // Empty snapshot folds back to the `general` sentinel so the
    // Coach surface stays useful for an iOS user mid-onboarding.
    expect(out.provenance.metrics).toContain("general");
  });

  it("does not query OFF-cluster types under the default scope", async () => {
    // v1.7.0 — the default clusters are cardio + body + mood +
    // medication. The cardio cluster now carries HRV / resting HR, and
    // body carries the composition types, so those ARE queried (still
    // a single `type IN (…)` round-trip; web-only accounts simply have
    // no rows and emit no block). What stays OFF by default: the
    // activity, sleep, glucose, workouts, mobility, and environment
    // clusters — none of their types should appear in the query.
    await buildCoachSnapshot("user-1");

    const callArgs = prismaMock.measurement.findMany.mock.calls[0]?.[0];
    const types = (callArgs?.where?.type?.in ?? []) as string[];
    // OFF clusters — not queried.
    expect(types).not.toContain("SLEEP_DURATION");
    expect(types).not.toContain("ACTIVE_ENERGY_BURNED");
    expect(types).not.toContain("ACTIVITY_STEPS");
    expect(types).not.toContain("BLOOD_GLUCOSE");
    expect(types).not.toContain("WALKING_STEADINESS");
    expect(types).not.toContain("AUDIO_EXPOSURE_ENV");
    // ON-by-default cardio + body members ARE queried.
    expect(types).toContain("HEART_RATE_VARIABILITY");
    expect(types).toContain("BODY_FAT");
  });

  // ── v1.7.0 new clustered blocks ──

  it("emits body-composition blocks per scoped source", async () => {
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(1, 22.4, "BODY_FAT"),
      daysAgo(2, 38.1, "MUSCLE_MASS"),
      daysAgo(3, 9, "VISCERAL_FAT"),
    ]);
    const out = await buildCoachSnapshot("user-1", {
      sources: ["body_fat", "muscle_mass", "visceral_fat"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;
    expect(snapshot.bodyFat).toBeDefined();
    expect(snapshot.muscleMass).toBeDefined();
    expect(snapshot.visceralFat).toBeDefined();
    expect(out.provenance.metrics).toEqual(
      expect.arrayContaining(["body_fat", "muscle_mass", "visceral_fat"]),
    );
  });

  it("emits mobility + environment blocks per scoped source", async () => {
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(1, 87, "WALKING_STEADINESS"),
      daysAgo(2, 1.3, "WALKING_SPEED"),
      daysAgo(1, 62, "AUDIO_EXPOSURE_ENV"),
      daysAgo(2, 41, "TIME_IN_DAYLIGHT"),
    ]);
    const out = await buildCoachSnapshot("user-1", {
      sources: ["walking_steadiness", "walking_speed", "audio_env", "daylight"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;
    expect(snapshot.walkingSteadiness).toBeDefined();
    expect(snapshot.walkingSpeed).toBeDefined();
    expect(snapshot.audioExposureEnvironment).toBeDefined();
    expect(snapshot.timeInDaylight).toBeDefined();
  });

  it("summarises glucose per context (fasting vs postprandial)", async () => {
    const glucoseRow = (n: number, value: number, ctx: string | null) => ({
      ...daysAgo(n, value, "BLOOD_GLUCOSE"),
      glucoseContext: ctx,
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      glucoseRow(1, 95, "FASTING"),
      glucoseRow(1, 140, "POSTPRANDIAL"),
      glucoseRow(2, 92, "FASTING"),
    ]);
    const out = await buildCoachSnapshot("user-1", {
      sources: ["glucose"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as {
      glucose?: { byContext?: Record<string, unknown> };
    };
    expect(snapshot.glucose?.byContext).toBeDefined();
    expect(Object.keys(snapshot.glucose?.byContext ?? {})).toEqual(
      expect.arrayContaining(["fasting", "postprandial"]),
    );
    expect(out.provenance.metrics).toContain("glucose");
  });

  it("caps the workouts block and rolls up per sport", async () => {
    const workouts = Array.from({ length: 25 }, (_, i) => ({
      sportType: i % 2 === 0 ? "RUNNING" : "CYCLING",
      startedAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
      durationSec: 1800,
      totalEnergyKcal: 400,
      totalDistanceM: 5000,
      avgHeartRate: 140,
      maxHeartRate: 175,
    }));
    prismaMock.workout.findMany.mockResolvedValue(workouts);
    const out = await buildCoachSnapshot("user-1", {
      sources: ["workouts"],
      window: "lastYear",
    });
    const snapshot = JSON.parse(out.snapshotJson) as {
      workouts?: {
        recent?: unknown[];
        perSport?: unknown[];
        totalInWindow?: number;
      };
    };
    // Recent list is capped; the per-sport rollup + total cover the tail.
    expect(snapshot.workouts?.recent?.length).toBeLessThanOrEqual(15);
    expect(snapshot.workouts?.totalInWindow).toBe(25);
    expect(snapshot.workouts?.perSport?.length).toBe(2);
    expect(out.provenance.metrics).toContain("workouts");
  });

  it("subtracts an excluded metric inside an otherwise-enabled cluster", async () => {
    // The user enabled the body cluster (default) but excluded weight.
    // Weight rows must not produce a block even though the cluster is on.
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: { excludeMetrics: ["weight"] },
      timezone: "Europe/Berlin",
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(1, 80, "WEIGHT"),
      daysAgo(2, 22, "BODY_FAT"),
    ]);
    featuresMock.mockResolvedValue({
      weight: { coverage: { count: 2 } },
    });
    const out = await buildCoachSnapshot("user-1", {
      sources: ["weight", "body_fat"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;
    expect(snapshot.weight).toBeUndefined();
    expect(snapshot.bodyFat).toBeDefined();
  });
});
