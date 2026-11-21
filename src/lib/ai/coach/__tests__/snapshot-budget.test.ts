import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  __resetCoachSnapshotCacheForTests,
  buildCoachSnapshot,
} from "../snapshot";
import { coachDataClusterEnum } from "@/lib/validations/coach-prefs";
import { coachScopeSourceSchema } from "../types";

// The per-type measurement read is raw SQL; serve it from the findMany mock.
vi.mock("@/lib/measurements/newest-per-type", async () =>
  (
    await import("@/__tests__/helpers/newest-per-type-mock")
  ).newestPerTypeMock(),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    workout: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    illnessEpisode: { findMany: vi.fn(async () => []) },
    symptomEvent: { groupBy: vi.fn(async () => []) },
    labResult: { findMany: vi.fn(async () => []) },
    encounter: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
  },
}));

vi.mock("@/lib/insights/features", () => ({
  extractFeatures: vi.fn(),
}));

// v1.18.0 — the snapshot now resolves the per-user module map; stub it so the
// default fixture is "all modules on" (legacy behaviour) without the real gate.
import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn(),
  // v1.18.0 — the coach cycle block gates through
  // `isCycleAvailableForUser` → `isModuleEnabled(userId, "cycle")`. Back it
  // with the same resolved map the tests drive via `resolveModuleMap`.
  isModuleEnabled: vi.fn(async (...args: [string, ModuleKey]) => {
    const key = args[1];
    const map = await (
      resolveModuleMap as unknown as () => Promise<Record<ModuleKey, boolean>>
    )();
    return map[key] !== false;
  }),
}));
import { resolveModuleMap } from "@/lib/modules/gate";
const resolveModuleMapMock = resolveModuleMap as unknown as ReturnType<
  typeof vi.fn
>;
const allModulesEnabled = (): Record<ModuleKey, boolean> =>
  Object.fromEntries(MODULE_KEYS.map((k) => [k, true])) as Record<
    ModuleKey,
    boolean
  >;

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
  // The snapshot's request-scoped read memoisation (`memoizePerRequest`) reads
  // the active event here; no request context in this unit test → null, so the
  // memoiser falls through to the factory and behaviour is unchanged.
  getEvent: () => null,
}));

// The energy-balance line is compact by construction; it rides the budget
// like any other registered block.
vi.mock("../energy-balance-snapshot", () => ({
  buildEnergyBalanceSnapshotBlock: vi.fn().mockResolvedValue({
    windowDays: 14,
    daysWithBalance: 12,
    meanIntakeKcal: 2100,
    meanExpenditureKcal: 2300,
    meanBalanceKcal: -200,
    restingEstimatedDays: 0,
    basis: "recorded intake minus resting and active energy",
  }),
}));

vi.mock("./glp1-snapshot", () => ({
  buildGlp1SnapshotBlock: vi.fn().mockResolvedValue(null),
}));

// v1.16.8 — the memory block carries durable personal facts (a stated
// allergy). The degrader may shed the bulky narrative recall but must
// keep the facts list; the mock pins both shapes in one block.
const MEMORY_FACT = {
  category: "condition",
  text: "Allergie: Erdnuss (eigene Angabe)",
};
vi.mock("../memory-snapshot", () => ({
  buildCoachMemoryBlock: vi.fn().mockResolvedValue({
    trendMemory: {},
    priorNarrative: { headline: "n".repeat(600), drivers: [] },
    facts: [
      {
        category: "condition",
        text: "Allergie: Erdnuss (eigene Angabe)",
      },
    ],
  }),
}));

import { prisma } from "@/lib/db";
import { extractFeatures } from "@/lib/insights/features";

const prismaMock = prisma as unknown as {
  measurement: { findMany: ReturnType<typeof vi.fn> };
  moodEntry: { findMany: ReturnType<typeof vi.fn> };
  medicationIntakeEvent: { findMany: ReturnType<typeof vi.fn> };
  medication: { findMany: ReturnType<typeof vi.fn> };
  workout: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  encounter: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
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
    resolveModuleMapMock.mockResolvedValue(allModulesEnabled());
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
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    // v1.16.9 — the compliance timeline derives from the band-engine
    // ledger now; the snapshot loads medications (schedules + window
    // events) instead of raw intake rows.
    // Branch on the caller: the GLP-1 block filters on
    // `treatmentClass: "GLP1"` (no GLP-1 therapy in this fixture); the
    // compliance loader reads every medication.
    const complianceMedRows = [
      {
        id: "med-1",
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        schedules: [
          {
            id: "sched-1",
            windowStart: "09:00",
            windowEnd: "09:00",
            daysOfWeek: null,
            timesOfDay: ["09:00"],
            reminderGraceMinutes: null,
            rrule: "FREQ=DAILY",
            rollingIntervalDays: null,
            scheduleType: "SCHEDULED",
            cyclicOnWeeks: null,
            cyclicOffWeeks: null,
            doseWindows: null,
          },
        ],
        scheduleRevisions: [],
        intakeEvents: Array.from({ length: 360 }, (_, i) => ({
          scheduledFor: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
          takenAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
          skipped: false,
          autoMissed: false,
          attributionSource: "AUTO",
        })),
      },
    ];
    prismaMock.medication.findMany.mockImplementation(
      (args: { where?: { treatmentClass?: string } }) =>
        Promise.resolve(
          args?.where?.treatmentClass === "GLP1" ? [] : complianceMedRows,
        ),
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

  it("honours a smaller cap a Coach budget sets", async () => {
    const full = await buildCoachSnapshot("user-1", {
      sources: ALL_SOURCES,
      window: "allTime",
    });
    const small = await buildCoachSnapshot(
      "user-1",
      { sources: ALL_SOURCES, window: "allTime" },
      { maxChars: 6_000 },
    );
    // A cache hit on the default-cap build would hand back the full one.
    expect(small.snapshotJson.length).toBeLessThan(full.snapshotJson.length);
    expect(small.snapshotJson.length).toBeLessThanOrEqual(6_500);
  });

  it("keeps more under a larger cap a Coach budget sets", async () => {
    const full = await buildCoachSnapshot("user-1", {
      sources: ALL_SOURCES,
      window: "allTime",
    });
    const large = await buildCoachSnapshot(
      "user-1",
      { sources: ALL_SOURCES, window: "allTime" },
      { maxChars: 120_000 },
    );
    expect(large.snapshotJson.length).toBeGreaterThan(full.snapshotJson.length);
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

  it("sheds the visits block among the first, before any clinical cluster", async () => {
    // A booked appointment three days out and a recent past visit put a visits
    // block on the snapshot. Null free text keeps the fixture decrypt-free.
    const day = 24 * 60 * 60 * 1000;
    prismaMock.encounter.findMany.mockResolvedValue([
      {
        occurredAt: new Date(Date.now() + 3 * day),
        kind: "SPECIALIST",
        reasonEncrypted: null,
        outcomeEncrypted: null,
        practitioner: { name: "Dr. Herz", specialty: "Cardiology" },
      },
    ]);
    prismaMock.encounter.findFirst.mockResolvedValue({
      occurredAt: new Date(Date.now() - 30 * day),
      kind: "ROUTINE",
      reasonEncrypted: null,
      outcomeEncrypted: null,
      practitioner: null,
    });

    const out = await buildCoachSnapshot("user-1", {
      sources: ALL_SOURCES,
      window: "allTime",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;
    // The clinical core keeps its detail …
    expect(
      (snapshot.compliance as { timeline?: { recent?: unknown } } | undefined)
        ?.timeline?.recent,
    ).toBeDefined();

    const truncated = annotateCalls.find(
      (c) => c.name === "coach.snapshot.truncated",
    );
    const droppedBlocks = (truncated?.meta?.droppedBlocks ?? []) as string[];
    const droppedClusters = (truncated?.meta?.droppedClusters ??
      []) as string[];
    // … while the visits block is registered on the lowest-priority cluster and
    // is shed under the cap, and never the medication core.
    expect(droppedClusters).toContain("environment");
    expect(droppedBlocks).toContain("visits");
    expect(droppedBlocks).not.toContain("compliance");
  });

  it("keeps the durable facts when the memory block is shed", async () => {
    const out = await buildCoachSnapshot("user-1", {
      sources: ALL_SOURCES,
      window: "allTime",
    });
    const truncated = annotateCalls.find(
      (c) => c.name === "coach.snapshot.truncated",
    );
    const droppedBlocks = (truncated?.meta?.droppedBlocks ?? []) as string[];
    // The memory block sits on the lowest-priority cluster and is shed
    // under this dense load …
    expect(droppedBlocks).toContain("memory");
    const snapshot = JSON.parse(out.snapshotJson) as {
      memory?: { facts?: unknown[]; priorNarrative?: unknown };
    };
    // … but the durable facts survive the drop while the bulky
    // narrative recall goes.
    expect(snapshot.memory?.facts).toEqual([MEMORY_FACT]);
    expect(snapshot.memory?.priorNarrative).toBeUndefined();
  });

  it("does not truncate a small default-scope snapshot", async () => {
    // A web-only account with no rows produces a tiny snapshot — the
    // degrader must be a no-op (no truncated annotation).
    prismaMock.measurement.findMany.mockResolvedValue([]);
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    prismaMock.medication.findMany.mockResolvedValue([]);
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

  it("carries the energy-balance line only while active energy is in scope", async () => {
    const { buildEnergyBalanceSnapshotBlock } =
      await import("../energy-balance-snapshot");
    const build = vi.mocked(buildEnergyBalanceSnapshotBlock);
    build.mockClear();
    const withEnergy = await buildCoachSnapshot("user-1", {
      sources: ["weight", "active_energy"],
      window: "last30days",
    });
    expect(
      (JSON.parse(withEnergy.snapshotJson) as Record<string, unknown>)
        .energyBalance,
    ).toMatchObject({ meanBalanceKcal: -200 });
    expect(build).toHaveBeenCalledTimes(1);

    build.mockClear();
    const without = await buildCoachSnapshot("user-1", {
      sources: ["weight"],
      window: "last30days",
    });
    expect(
      (JSON.parse(without.snapshotJson) as Record<string, unknown>)
        .energyBalance,
    ).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });
});
