import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  __resetCoachSnapshotCacheForTests,
  buildCoachSnapshot,
} from "../snapshot";
import { coachDataClusterEnum } from "@/lib/validations/coach-prefs";
import { coachScopeSourceSchema } from "../types";

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

// Capture annotate calls so the budgeting assertions can prove the new
// observability events fire.
const annotateCalls: Array<{
  name?: string;
  meta?: Record<string, unknown>;
}> = [];
vi.mock("@/lib/logging/context", () => ({
  annotate: (fields: {
    action?: { name: string };
    meta?: Record<string, unknown>;
  }) => {
    annotateCalls.push({ name: fields.action?.name, meta: fields.meta });
  },
}));

vi.mock("./glp1-snapshot", () => ({
  buildGlp1SnapshotBlock: vi.fn().mockResolvedValue(null),
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

// Source → MeasurementType used by the snapshot builder. We only need
// the single-type members to manufacture dense rows.
const MEASUREMENT_TYPES = [
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "WEIGHT",
  "PULSE",
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "WALKING_HEART_RATE_AVERAGE",
  "RESPIRATORY_RATE",
  "OXYGEN_SATURATION",
  "PULSE_WAVE_VELOCITY",
  "VASCULAR_AGE",
  "BODY_FAT",
  "FAT_MASS",
  "FAT_FREE_MASS",
  "MUSCLE_MASS",
  "LEAN_BODY_MASS",
  "BONE_MASS",
  "TOTAL_BODY_WATER",
  "BODY_MASS_INDEX",
  "VISCERAL_FAT",
  "ACTIVITY_STEPS",
  "ACTIVE_ENERGY_BURNED",
  "FLIGHTS_CLIMBED",
  "WALKING_RUNNING_DISTANCE",
  "VO2_MAX",
  "SLEEP_DURATION",
  "BLOOD_GLUCOSE",
  "WALKING_STEADINESS",
  "WALKING_ASYMMETRY",
  "WALKING_DOUBLE_SUPPORT",
  "WALKING_STEP_LENGTH",
  "WALKING_SPEED",
  "AUDIO_EXPOSURE_ENV",
  "AUDIO_EXPOSURE_HEADPHONE",
  "AUDIO_EXPOSURE_EVENT",
  "TIME_IN_DAYLIGHT",
  "SKIN_TEMPERATURE",
  "BODY_TEMPERATURE",
];

/** Build a year of dense daily rows for every measurement type. */
function denseMeasurementRows() {
  const rows: Array<{
    type: string;
    value: number;
    measuredAt: Date;
    glucoseContext: string | null;
  }> = [];
  const day = 24 * 60 * 60 * 1000;
  for (const type of MEASUREMENT_TYPES) {
    for (let n = 1; n <= 360; n++) {
      const d = new Date(Date.now() - n * day);
      d.setUTCHours(9, 0, 0, 0);
      rows.push({
        type,
        value: 100 + (n % 17),
        measuredAt: d,
        glucoseContext: type === "BLOOD_GLUCOSE" ? "FASTING" : null,
      });
    }
  }
  return rows;
}

const ALL_SOURCES = coachScopeSourceSchema.options;

describe("buildCoachSnapshot — budgeting + progressive degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    annotateCalls.length = 0;
    __resetCoachSnapshotCacheForTests();
    const measurementRows = denseMeasurementRows();
    prismaMock.measurement.findMany.mockImplementation(
      (args: { where?: { type?: { in?: string[] } | string } }) => {
        const filter = args?.where?.type;
        if (typeof filter === "string") {
          return Promise.resolve(
            measurementRows.filter((r) => r.type === filter),
          );
        }
        const wanted = filter?.in;
        if (Array.isArray(wanted)) {
          return Promise.resolve(
            measurementRows.filter((r) => wanted.includes(r.type)),
          );
        }
        return Promise.resolve(measurementRows);
      },
    );
    prismaMock.moodEntry.findMany.mockResolvedValue(
      Array.from({ length: 360 }, (_, i) => ({
        moodLoggedAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
        score: 3 + (i % 3),
      })),
    );
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue(
      Array.from({ length: 360 }, (_, i) => ({
        scheduledFor: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
        takenAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
        skipped: false,
      })),
    );
    prismaMock.workout.findMany.mockResolvedValue(
      Array.from({ length: 80 }, (_, i) => ({
        sportType: i % 2 === 0 ? "RUNNING" : "CYCLING",
        startedAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
        durationSec: 1800 + i * 10,
        totalEnergyKcal: 400 + i,
        totalDistanceM: 5000 + i * 10,
        avgHeartRate: 140,
        maxHeartRate: 175,
      })),
    );
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: { dataClusters: coachDataClusterEnum.options },
      timezone: "Europe/Berlin",
    });
    featuresMock.mockResolvedValue({
      bloodPressure: { coverage: { count: 720 } },
      weight: { coverage: { count: 360 } },
      pulse: { coverage: { count: 360 } },
      mood: { coverage: { count: 360 } },
    });
  });

  it("keeps every-cluster / allTime under the soft char cap", async () => {
    const out = await buildCoachSnapshot("user-1", {
      sources: ALL_SOURCES,
      window: "allTime",
    });
    // ~4 chars/token; the cap is 24_000 chars. Allow a little headroom
    // because the degrader stops as soon as it fits (it may land just
    // under the cap, never far over it).
    expect(out.snapshotJson.length).toBeLessThanOrEqual(24_500);
  });

  it("fires coach.snapshot.truncated when the cap is exceeded", async () => {
    await buildCoachSnapshot("user-1", {
      sources: ALL_SOURCES,
      window: "allTime",
    });
    const truncated = annotateCalls.find(
      (c) => c.name === "coach.snapshot.truncated",
    );
    expect(truncated).toBeDefined();
    expect(Array.isArray(truncated?.meta?.droppedClusters)).toBe(true);
    expect(typeof truncated?.meta?.finalChars).toBe("number");
  });

  it("fires coach.clusters.resolved with the active set", async () => {
    await buildCoachSnapshot("user-1", {
      sources: ALL_SOURCES,
      window: "allTime",
    });
    const resolved = annotateCalls.find(
      (c) => c.name === "coach.clusters.resolved",
    );
    expect(resolved).toBeDefined();
    expect(Array.isArray(resolved?.meta?.active)).toBe(true);
    // multiClusterCap should be on with all 10 clusters active.
    expect(resolved?.meta?.multiClusterCap).toBe(true);
  });

  it("degrades the lowest-priority clusters first, keeping the clinical core", async () => {
    const out = await buildCoachSnapshot("user-1", {
      sources: ALL_SOURCES,
      window: "allTime",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<
      string,
      { timeline?: Record<string, unknown> }
    >;
    // The highest-priority cluster (medication) keeps its full detail
    // — its recent timeline survives even when every lower-priority
    // cluster has been collapsed to fit the budget. This is the
    // clinical-survival contract.
    expect(snapshot.compliance?.timeline?.recent).toBeDefined();

    const truncated = annotateCalls.find(
      (c) => c.name === "coach.snapshot.truncated",
    );
    const droppedBlocks = (truncated?.meta?.droppedBlocks ?? []) as string[];
    const droppedClusters = (truncated?.meta?.droppedClusters ??
      []) as string[];
    // Lowest-priority clusters are shed first.
    expect(droppedClusters).toContain("environment");
    // The lowest-priority environmental blocks are degraded before any
    // medication block: every environment block appears in the dropped
    // list, and the compliance block keeps its recent detail.
    expect(droppedBlocks).toContain("audioExposureEnvironment");
    expect(droppedBlocks).not.toContain("compliance");
  });

  it("does not truncate a small default-scope snapshot", async () => {
    // A web-only account with no rows produces a tiny snapshot — the
    // degrader must be a no-op (no truncated annotation).
    prismaMock.measurement.findMany.mockResolvedValue([]);
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    prismaMock.workout.findMany.mockResolvedValue([]);
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      timezone: "Europe/Berlin",
    });
    await buildCoachSnapshot("user-1");
    expect(
      annotateCalls.find((c) => c.name === "coach.snapshot.truncated"),
    ).toBeUndefined();
  });
});
