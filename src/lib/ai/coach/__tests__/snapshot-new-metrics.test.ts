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

import { prisma } from "@/lib/db";
import { extractFeatures } from "@/lib/insights/features";

const prismaMock = prisma as unknown as {
  measurement: { findMany: ReturnType<typeof vi.fn> };
  moodEntry: { findMany: ReturnType<typeof vi.fn> };
  medicationIntakeEvent: { findMany: ReturnType<typeof vi.fn> };
  medication: { findMany: ReturnType<typeof vi.fn> };
  workout: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};
const featuresMock = extractFeatures as unknown as ReturnType<typeof vi.fn>;

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

/**
 * v1.4.23 — pins the Apple Health timeline blocks the Coach
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
    resolveModuleMapMock.mockResolvedValue(allModulesEnabled());
    // No readings unless a case seeds its own; the case that only inspects
    // the query used to inherit whatever rows the case before it left.
    prismaMock.measurement.findMany.mockResolvedValue([]);
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    prismaMock.medication.findMany.mockResolvedValue([]);
    prismaMock.workout.findMany.mockResolvedValue([]);
    // v1.4.23 — snapshot now reads `User.coachPrefsJson`. Default
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

  // v1.30.4 (G4/HRV union) — Oura / Polar / WHOOP write nightly HRV as RMSSD
  // (`HRV_RMSSD`) only, never SDNN (`HEART_RATE_VARIABILITY`). Before this
  // fix the snapshot's `hrv` source only queried SDNN, so a ring/strap-only
  // account got a false empty hrv block even though the app's HRV sub-page
  // charts the RMSSD rows. Pin the RMSSD-only path resolving.
  it("emits the hrv block from HRV_RMSSD rows alone (ring/strap-only account)", async () => {
    const rows = [daysAgo(2, 38, "HRV_RMSSD"), daysAgo(5, 41, "HRV_RMSSD")];
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

  it("carries glucose in the user's display unit (mmol/L) — v1.16.16", async () => {
    // A mmol/L-preference user's Coach must read 5.5, not the stored 100.
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      glucoseUnit: "mmol/L",
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      { ...daysAgo(1, 100, "BLOOD_GLUCOSE"), glucoseContext: "FASTING" },
    ]);
    const out = await buildCoachSnapshot("user-1", {
      sources: ["glucose"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as {
      glucose?: {
        unit?: string;
        byContext?: Record<string, { recent?: Array<{ value: number }> }>;
      };
    };
    expect(snapshot.glucose?.unit).toBe("mmol/L");
    expect(snapshot.glucose?.byContext?.fasting?.recent?.[0]?.value).toBe(5.5);
  });

  it("keeps mg/dL glucose values byte-identical with a unit token — v1.16.16", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      glucoseUnit: "mg/dL",
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      { ...daysAgo(1, 100, "BLOOD_GLUCOSE"), glucoseContext: "FASTING" },
    ]);
    const out = await buildCoachSnapshot("user-1", {
      sources: ["glucose"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as {
      glucose?: {
        unit?: string;
        byContext?: Record<string, { recent?: Array<{ value: number }> }>;
      };
    };
    expect(snapshot.glucose?.unit).toBe("mg/dL");
    expect(snapshot.glucose?.byContext?.fasting?.recent?.[0]?.value).toBe(100);
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

  // v1.30.4 — `GET /api/workouts` collapses a dual-source recording of
  // the SAME session (e.g. Apple Watch + Withings both logging one run) with
  // `pickCanonicalWorkoutRows` before the UI ever counts it. The Coach
  // snapshot (and the `get_workouts` MCP tool, which re-exports this same
  // block) used to read `prisma.workout.findMany` raw with no read-time
  // collapse, so a dual-device user's Coach prompt double-counted the
  // session and inflated `perSport`/`totalInWindow` vs. the app. Pin the fix.
  it("collapses a same-session cross-source workout pair to one, matching the UI", async () => {
    // Inside the 30-day window: the block keeps only the sessions that
    // start in it.
    const sharedStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const workouts = [
      {
        id: "w-apple",
        sportType: "RUNNING",
        startedAt: sharedStart,
        durationSec: 1800,
        totalEnergyKcal: 400,
        totalDistanceM: 5000,
        avgHeartRate: 140,
        maxHeartRate: 175,
        source: "APPLE_HEALTH",
      },
      {
        id: "w-withings",
        sportType: "RUNNING",
        // 90 s apart — same 5-minute bucket the picker uses.
        startedAt: new Date(sharedStart.getTime() + 90_000),
        durationSec: 1780,
        totalEnergyKcal: 390,
        totalDistanceM: 4950,
        avgHeartRate: 138,
        maxHeartRate: 172,
        source: "WITHINGS",
      },
    ];
    prismaMock.workout.findMany.mockResolvedValue(workouts);
    const out = await buildCoachSnapshot("user-1", {
      sources: ["workouts"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as {
      workouts?: {
        recent?: Array<{ sport: string }>;
        perSport?: Array<{ sport: string; count: number }>;
        totalInWindow?: number;
      };
    };
    // Collapsed to the one Apple Health row (default ladder: Apple Health
    // outranks Withings) — never two.
    expect(snapshot.workouts?.totalInWindow).toBe(1);
    expect(snapshot.workouts?.recent?.length).toBe(1);
    expect(snapshot.workouts?.perSport).toEqual([
      {
        sport: "RUNNING",
        count: 1,
        totalDurationMin: 30,
        totalEnergyKcal: 400,
      },
    ]);
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

/**
 * v1.17.0 — WHOOP-native day strain (0–21) reaches the Coach snapshot as its
 * own `dayStrain` block, distinct from the computed `derived.STRAIN_SCORE`.
 * The read is a SEPARATE `where.type === "DAY_STRAIN"` query, so the fixtures
 * here discriminate the mock by type rather than returning one flat array.
 */
describe("buildCoachSnapshot — WHOOP-native day strain (v1.17.0)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCoachSnapshotCacheForTests();
    resolveModuleMapMock.mockResolvedValue(allModulesEnabled());
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    prismaMock.medication.findMany.mockResolvedValue([]);
    prismaMock.workout.findMany.mockResolvedValue([]);
    prismaMock.user.findUnique.mockResolvedValue({ coachPrefsJson: null });
    featuresMock.mockResolvedValue({
      bloodPressure: undefined,
      weight: undefined,
      pulse: undefined,
      mood: undefined,
    });
  });

  /** Route each findMany to rows matching its `where.type` filter. */
  function mockByType(byType: Record<string, ReturnType<typeof daysAgo>[]>) {
    prismaMock.measurement.findMany.mockImplementation((args: unknown) => {
      const where = (args as { where?: { type?: unknown } }).where;
      const t = where?.type;
      if (typeof t === "string") return Promise.resolve(byType[t] ?? []);
      if (t && typeof t === "object" && "in" in t) {
        const wanted = (t as { in: string[] }).in;
        return Promise.resolve(
          wanted.flatMap((typeName) => byType[typeName] ?? []),
        );
      }
      return Promise.resolve([]);
    });
  }

  it("emits a native dayStrain block on DAY_STRAIN rows for a WHOOP user", async () => {
    mockByType({
      HEART_RATE_VARIABILITY: [daysAgo(2, 64, "HEART_RATE_VARIABILITY")],
      // Ascending (oldest first), mirroring the `orderBy: measuredAt asc` read.
      DAY_STRAIN: [
        daysAgo(3, 11.8, "DAY_STRAIN"),
        daysAgo(1, 14.2, "DAY_STRAIN"),
      ],
    });

    const out = await buildCoachSnapshot("user-1", {
      sources: ["hrv"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;
    const dayStrain = snapshot.dayStrain as Record<string, unknown> | undefined;

    expect(dayStrain).toBeDefined();
    expect(dayStrain?.scale).toBe("0-21");
    expect(dayStrain?.latest).toBe(14.2);
    expect(dayStrain?.days).toBe(2);
  });

  it("omits dayStrain when the account has no DAY_STRAIN rows", async () => {
    mockByType({
      HEART_RATE_VARIABILITY: [daysAgo(2, 64, "HEART_RATE_VARIABILITY")],
    });

    const out = await buildCoachSnapshot("user-1", {
      sources: ["hrv"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;

    expect(snapshot.dayStrain).toBeUndefined();
  });
});
