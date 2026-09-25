/**
 * v1.7.0 W6 — unit tests for `buildDashboardSnapshot`.
 *
 * The builder is tested in isolation with every sub-helper mocked so
 * the assertions pin the assembly contract without a live DB / LLM:
 *   - every above-the-fold tile field is present in the envelope;
 *   - the two-phase contract: `extras` is null on a rollup-coverage
 *     miss, populated when warm;
 *   - the briefingState matrix (ready / preparing / disabled /
 *     no-provider) plus the stale-briefing delivery contract;
 *   - NO LLM client is reachable from the builder (the provider chain
 *     is never imported by `snapshot.ts` — asserted structurally).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const computeSummariesSlice = vi.fn();
const probeRollupCoverage = vi.fn();
const isFullyCovered = vi.fn();
const readMoodDayRollups = vi.fn();
const ensureUserMoodRollupsFresh = vi.fn();
const computeBpInTargetFastPath = vi.fn();
const hasAnyConfiguredProvider = vi.fn();
const buildMedsTodayBlock = vi.fn();
const computeUserHealthScoreMock = vi.fn();

vi.mock("@/lib/analytics/summaries-slice", () => ({
  computeSummariesSlice: (...a: unknown[]) => computeSummariesSlice(...a),
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: (...a: unknown[]) => probeRollupCoverage(...a),
  isFullyCovered: (...a: unknown[]) => isFullyCovered(...a),
  // Every uncovered type asked about has readings inside the fold window, so
  // a miss here is a real miss. The pre-window case runs against Postgres in
  // `tests/integration/dashboard-snapshot-pre-window-types.test.ts`.
  typesWithReadingsInFoldWindow: async (_userId: string, types: string[]) =>
    new Set(types),
}));
vi.mock("@/lib/rollups/mood-rollups", () => ({
  readMoodDayRollups: (...a: unknown[]) => readMoodDayRollups(...a),
  ensureUserMoodRollupsFresh: (...a: unknown[]) =>
    ensureUserMoodRollupsFresh(...a),
}));
vi.mock("@/lib/analytics/bp-in-target-fast-path", () => ({
  computeBpInTargetFastPath: (...a: unknown[]) =>
    computeBpInTargetFastPath(...a),
}));
// The builder imports only the credential-PRESENCE check; mock it so the
// test never touches the real provider module (prisma / crypto imports).
vi.mock("@/lib/ai/provider", () => ({
  hasAnyConfiguredProvider: (...a: unknown[]) => hasAnyConfiguredProvider(...a),
}));
// Meds-today + health-score builders are tested in their own suites;
// here only the assembly contract (fast vs warm phase) is pinned.
vi.mock("@/lib/dashboard/meds-today", () => ({
  buildMedsTodayBlock: (...a: unknown[]) => buildMedsTodayBlock(...a),
}));
vi.mock("@/lib/analytics/score/reader", () => ({
  computeUserHealthScore: async (...a: unknown[]) => {
    const legacy = await computeUserHealthScoreMock(...a);
    const provenance = {
      inputs: [],
      source: "none" as const,
      windowDays: 0,
      computedAt: "2026-07-28T12:00:00.000Z",
    };
    const coverage = {
      requiredInputs: 3,
      presentInputs: legacy ? 3 : 0,
      historyDays: legacy ? 28 : 0,
      missing: legacy ? [] : ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
    };
    const composite = legacy
      ? {
          status: "ok" as const,
          value: {
            score: legacy.score,
            band: legacy.band,
            bandSetter: "BLOOD_PRESSURE" as const,
            composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"] as const,
            noiseFloor: 2,
            scoreVersion: SCORE_VERSION,
          },
          coverage,
          confidence: { score: 100, band: "high" as const },
          provenance,
        }
      : {
          status: "insufficient" as const,
          coverage,
          provenance,
          reason: "no_usable_data",
        };
    return {
      composite,
      pillars: [],
      delta: legacy?.delta ?? null,
      deltaReason: null,
      scoreVersion: SCORE_VERSION,
      weightGoal: {
        status: "insufficient" as const,
        coverage,
        provenance,
        reason: "no_personal_goal",
      },
      algorithmNotice: null,
    };
  },
}));
// v1.18.0 — module gate. Default-mocked all-on so the existing envelope
// tests keep their full tile set; the module-gating suite below passes
// an explicit map through the `modules` option instead.
const resolveModuleMap = vi.fn();
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: (...a: unknown[]) => resolveModuleMap(...a),
}));
// v1.27.7 — hero score rings. Mocked so the suite never touches the
// derived engines / compliance reads; the resolver has its own suite.
const buildScoreRingsBlock = vi.fn();
vi.mock("@/lib/dashboard/score-rings", () => ({
  buildScoreRingsBlock: (...a: unknown[]) => buildScoreRingsBlock(...a),
}));

/** Every toggleable key on, with optional per-key overrides. */
function moduleMap(
  overrides: Partial<Record<ModuleKey, boolean>> = {},
): Record<ModuleKey, boolean> {
  const base: Record<ModuleKey, boolean> = {
    cycle: true,
    mood: true,
    sleep: true,
    glucose: true,
    workouts: true,
    recovery: true,
    labs: true,
    illness: true,
    achievements: true,
    coach: true,
    insights: true,
    medications: true,
    doctorReport: true,
    environment: true,
    mcp: true,
    inboundDocuments: true,
    mentalHealth: true,
    nutrients: true,
    vaccinations: true,
  };
  return { ...base, ...overrides };
}

import {
  applyBriefingCapability,
  buildDashboardSnapshot,
  WIDGET_MODULE_BY_ID,
  SUMMARY_TYPE_MODULE,
  type SnapshotUserInput,
} from "../snapshot";
import type { ModuleKey } from "@/lib/modules/gate";
import { MODULE_KEYS } from "@/lib/modules/registry";
import { SCORE_VERSION } from "@/lib/analytics/score/types";
import {
  AI_AVAILABLE,
  aiUnavailable,
} from "@/__tests__/helpers/ai-capability-fixtures";

const emptySummary = {
  count: 0,
  latest: null,
  min: null,
  max: null,
  mean: null,
  avg7: null,
  avg30: null,
  slope7: null,
  slope30: null,
  anomalyCount: 0,
};

const fakePrisma = {
  measurement: { findMany: vi.fn().mockResolvedValue([]) },
  moodEntry: { findMany: vi.fn().mockResolvedValue([]) },
  // v1.29 — the fluid-intake dashboard tile block reads this table.
  nutrientIntakeDay: { findMany: vi.fn().mockResolvedValue([]) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function baseUser(
  overrides: Partial<SnapshotUserInput> = {},
): SnapshotUserInput {
  return {
    id: "user-1",
    username: "tester",
    displayName: null,
    timezone: "Europe/Berlin",
    heightCm: 180,
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    gender: "MALE",
    glucoseUnit: "mg/dL",
    onboardingTourCompleted: true,
    insightsCachedText: null,
    insightsCachedAt: null,
    insightsCachedLocale: null,
    dashboardWidgetsJson: null,
    thresholdsJson: null,
    healthScoreConfigJson: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  computeSummariesSlice.mockResolvedValue({
    summaries: { WEIGHT: { ...emptySummary, count: 3, latest: 80 } },
    lastSeenByType: {
      WEIGHT: { lastSeenAt: new Date().toISOString() },
    },
    bmi: null,
  });
  readMoodDayRollups.mockResolvedValue([]);
  fakePrisma.measurement.findMany.mockResolvedValue([]);
  fakePrisma.moodEntry.findMany.mockResolvedValue([]);
  fakePrisma.nutrientIntakeDay.findMany.mockResolvedValue([]);
  hasAnyConfiguredProvider.mockResolvedValue(true);
  buildMedsTodayBlock.mockResolvedValue({
    activeCount: 1,
    scheduledToday: 2,
    takenToday: 1,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
  });
  computeUserHealthScoreMock.mockResolvedValue(null);
  resolveModuleMap.mockResolvedValue(moduleMap());
  buildScoreRingsBlock.mockResolvedValue([]);
});

describe("buildDashboardSnapshot — envelope shape", () => {
  it("assembles every above-the-fold field with warm coverage", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      last90Days: { pct: 80, pairs: 20 },
      last90EarliestAt: new Date("2026-03-01T00:00:00.000Z"),
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
    });

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    // user block
    expect(snap.user.username).toBe("tester");
    expect(snap.user.timezone).toBe("Europe/Berlin");
    expect(snap.user.heightCm).toBe(180);
    expect(snap.user.gender).toBe("MALE");
    // Inverted 2026-09: the builder used to compute a wall-clock hour for
    // the greeting that no client ever read, and that a stale-while-
    // revalidate serve could carry an hour past its bucket. The zone is
    // the resolved value; the hour belongs to whoever holds a live clock.
    expect(snap.user).not.toHaveProperty("greetingHour");

    // tiles (fast phase) always present
    expect(snap.tiles.summaries.WEIGHT.latest).toBe(80);
    expect(snap.tiles.lastSeenByType.WEIGHT).not.toBeNull();
    expect(snap.tiles.lastSeenByType.WEIGHT!.daysAgo).toBe(0);
    expect(snap.tiles.mood).toBeDefined();

    // extras (thick phase) present + populated when warm
    expect(snap.extras).not.toBeNull();
    expect(snap.extras!.bpInTargetPct).toBe(80);
    expect(snap.extras!.bpInTargetPct7d).toBe(70);
    expect(snap.extras!.bpInTargetPctPriorMonth).toBe(60);

    // layout + briefing slots
    expect(snap.layout).toBeDefined();
    expect(typeof snap.generatedAt).toBe("string");
  });

  it("probes rollup coverage once and threads it into the summaries slice (A5)", async () => {
    const coverageMap = new Map([["WEIGHT", true]]);
    probeRollupCoverage.mockResolvedValue(coverageMap);
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      last90Days: { pct: 80, pairs: 20 },
      last90EarliestAt: new Date("2026-03-01T00:00:00.000Z"),
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
    });

    await buildDashboardSnapshot(fakePrisma, baseUser());

    // The snapshot probes coverage exactly once up front — the slice no
    // longer re-runs the identical probe internally.
    expect(probeRollupCoverage).toHaveBeenCalledTimes(1);
    // The already-probed map is passed as the slice's second argument so
    // it reuses it instead of probing again.
    expect(computeSummariesSlice).toHaveBeenCalledWith("user-1", coverageMap);
  });
});

describe("buildDashboardSnapshot — weight trend judged against the stored target (#1006)", () => {
  // The summary mock serves WEIGHT latest 80 (no avg7), so the reference
  // weight is 80 kg in every case below.
  beforeEach(() => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", false]]));
    isFullyCovered.mockReturnValue(false);
  });

  it("below the target: a gain is progress", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({ thresholdsJson: { WEIGHT: { min: 85, max: 90 } } }),
    );
    expect(snap.tiles.weightTrend).toEqual({
      direction: "up-good",
      targetPosition: "below",
    });
  });

  it("inside the target: holding steady is progress", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({ thresholdsJson: { WEIGHT: { min: 75, max: 82 } } }),
    );
    expect(snap.tiles.weightTrend).toEqual({
      direction: "hold",
      targetPosition: "inside",
    });
  });

  it("above the target: a loss is progress", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({ thresholdsJson: { WEIGHT: { min: 70, max: 75 } } }),
    );
    expect(snap.tiles.weightTrend).toEqual({
      direction: "up-bad",
      targetPosition: "above",
    });
  });

  it("no stored target keeps today's reading, even with a height-derived band", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    // The WHO band from height still shades the chart…
    expect(snap.targetBands.weightRange).not.toBeNull();
    // …but nobody chose it, so it does not decide the direction.
    expect(snap.tiles.weightTrend).toEqual({
      direction: "up-bad",
      targetPosition: null,
    });
  });
});

describe("buildDashboardSnapshot — two-phase null extras", () => {
  it("returns extras: null on a rollup-coverage miss and never runs the thick read", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", false]]));
    isFullyCovered.mockReturnValue(false);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.extras).toBeNull();
    // The fast phase still resolved fully.
    expect(snap.tiles.summaries.WEIGHT.latest).toBe(80);
    // The thick BP read must NOT have fired — paint-together vs
    // slowest-wins mitigation.
    expect(computeBpInTargetFastPath).not.toHaveBeenCalled();
    // The glucose findMany (part of the thick read) must NOT have fired.
    expect(fakePrisma.measurement.findMany).not.toHaveBeenCalled();
  });
});

describe("buildDashboardSnapshot — per-type thick-phase gate", () => {
  // The thick phase gates ONLY on the types it reads through the
  // rollup tier (WEIGHT + BLOOD_PRESSURE_SYS/_DIA). An uncovered
  // UNRELATED type (a fresh wearable reading whose async fold hasn't
  // landed) must not null extras/healthScore — the all-types
  // `isFullyCovered` AND was the bug, not the per-type misses.
  it("an uncovered UNRELATED type no longer nulls extras + healthScore", async () => {
    probeRollupCoverage.mockResolvedValue(
      new Map([
        ["WEIGHT", true],
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
        // Fresh WHOOP recovery reading, no DAY bucket yet.
        ["RECOVERY_SCORE", false],
      ]),
    );
    // Pin that the builder no longer consults the all-types helper:
    // even an explicit `false` from it must not cold the phase.
    isFullyCovered.mockReturnValue(false);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      last90Days: { pct: 80, pairs: 20 },
      last90EarliestAt: new Date("2026-03-01T00:00:00.000Z"),
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
      gradedScore: 84,
    });
    computeUserHealthScoreMock.mockResolvedValue({
      score: 71,
      band: "yellow",
      delta: 3,
      components: {},
    });

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.extras).not.toBeNull();
    expect(snap.extras!.bpInTargetPct).toBe(80);
    // v1.18.1 — `restMode` is null when no illness episode is active (the
    // fail-soft resolver reads no active episodes off the fake prisma).
    expect(snap.healthScore).toEqual({
      score: 71,
      band: "yellow",
      delta: 3,
      restMode: null,
      confidence: { score: 100, band: "high" },
      composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      deltaReason: null,
      scoreVersion: SCORE_VERSION,
      bandSetter: "BLOOD_PRESSURE",
      // v1.21.2 (A5 / A6) — additive narrative fields, null absent a
      // disagreeing readiness set / a returned metric (the fake derived
      // engines resolve nothing here).
      tension: null,
      returnToBand: null,
    });
    // Current, prior-week, and prior-two-week windows support both the weekly
    // movement and the first-eligibility guard.
    expect(computeBpInTargetFastPath).toHaveBeenCalledTimes(3);
    expect(computeUserHealthScoreMock).toHaveBeenCalledTimes(1);
  });

  it("a fresh account with zero coverage entries stays null", async () => {
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.extras).toBeNull();
    expect(snap.healthScore).toBeNull();
    expect(computeBpInTargetFastPath).not.toHaveBeenCalled();
    expect(computeUserHealthScoreMock).not.toHaveBeenCalled();
  });

  it("a gated type ABSENT from the map (never logged) keeps the phase warm", async () => {
    // BP never logged at all — the BP helper's live fallback is an
    // empty read, so absence must not cold the phase.
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    isFullyCovered.mockReturnValue(false);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: null,
      last30Days: null,
      last90Days: null,
      allTime: null,
      priorMonth: null,
      priorYear: null,
      gradedScore: null,
    });
    computeUserHealthScoreMock.mockResolvedValue(null);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.extras).not.toBeNull();
  });

  it.each([["WEIGHT"], ["BLOOD_PRESSURE_SYS"], ["BLOOD_PRESSURE_DIA"]])(
    "an uncovered %s (rows without buckets) keeps the phase cold",
    async (uncoveredType) => {
      const coverage = new Map([
        ["WEIGHT", true],
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      coverage.set(uncoveredType, false);
      probeRollupCoverage.mockResolvedValue(coverage);
      isFullyCovered.mockReturnValue(false);

      const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

      // Rows without buckets on a gated type would route the helper
      // onto its multi-second live fallback — the snapshot must not
      // wait on it. Null is acceptable here; the all-types poison was
      // the bug.
      expect(snap.extras).toBeNull();
      expect(snap.healthScore).toBeNull();
      expect(computeBpInTargetFastPath).not.toHaveBeenCalled();
    },
  );
});

describe("buildDashboardSnapshot — medsToday (fast phase)", () => {
  it("rides the fast phase and is present even on a rollup-coverage miss", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", false]]));
    isFullyCovered.mockReturnValue(false);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.medsToday).toEqual({
      activeCount: 1,
      scheduledToday: 2,
      takenToday: 1,
      skippedToday: 0,
      nextDueAt: null,
      nextDueOverdue: false,
      nextDueMedicationName: null,
    });
    // Built from the user's id + timezone, not from any body field.
    expect(buildMedsTodayBlock).toHaveBeenCalledWith(
      fakePrisma,
      "user-1",
      "Europe/Berlin",
      expect.any(Date),
    );
  });
});

describe("buildDashboardSnapshot — healthScore (warm phase only)", () => {
  it("is null on a rollup-coverage miss and the fast path never runs", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", false]]));
    isFullyCovered.mockReturnValue(false);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.healthScore).toBeNull();
    expect(computeUserHealthScoreMock).not.toHaveBeenCalled();
  });

  it("serialises the additive score identity when warm", async () => {
    const coverageMap = new Map([["WEIGHT", true]]);
    probeRollupCoverage.mockResolvedValue(coverageMap);
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70, pairs: 6 },
      last30Days: { pct: 80, pairs: 12 },
      // v1.17 W1d — the BP pillar reads this 90-day window, NOT last30Days.
      // v1.17 W1b — `pairs` above the confidence floor so the pillar grades
      // the 90-day rate rather than falling back to all-time.
      last90Days: { pct: 77, pairs: 30 },
      last90EarliestAt: new Date("2026-01-01T00:00:00.000Z"),
      allTime: { pct: 75, pairs: 200 },
      priorMonth: { pct: 60, pairs: 10 },
      priorYear: { pct: 50, pairs: 40 },
      gradedScore: 88,
    });
    computeUserHealthScoreMock.mockResolvedValue({
      score: 72,
      band: "yellow",
      delta: -12,
      components: { bp: {}, weight: {}, mood: {}, compliance: {} },
    });

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    // Score + band + delta (+ the v1.18.1 value-free restMode annotation)
    // only — components never reach the wire. `restMode` is null with no
    // active illness episode.
    expect(snap.healthScore).toEqual({
      score: 72,
      band: "yellow",
      delta: -12,
      restMode: null,
      confidence: { score: 100, band: "high" },
      composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      deltaReason: null,
      scoreVersion: SCORE_VERSION,
      bandSetter: "BLOOD_PRESSURE",
      // v1.21.2 (A5 / A6) — additive narrative fields, null here.
      tension: null,
      returnToBand: null,
    });

    // The fast path reuses the BP windows + coverage map already
    // computed for `extras` (no re-probe, graded score threaded).
    expect(computeUserHealthScoreMock).toHaveBeenCalledTimes(1);
    const arg = computeUserHealthScoreMock.mock.calls[0][0] as {
      userId: string;
      bpEnvelope: { last90Days?: { pct: number } | null } | null;
      bpTargets: unknown;
      profile: { thresholdsJson: unknown };
      modules: { mentalHealth: boolean };
    };
    expect(arg.userId).toBe("user-1");
    expect(arg.bpEnvelope?.last90Days?.pct).toBe(77);
    expect(arg.bpTargets).not.toBeNull();
  });

  it("is null when warm but no pillar is computable (fast path returns null)", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: null,
      last30Days: null,
      last90Days: null,
      allTime: null,
      priorMonth: null,
      priorYear: null,
      gradedScore: null,
    });
    computeUserHealthScoreMock.mockResolvedValue(null);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.extras).not.toBeNull();
    expect(snap.healthScore).toBeNull();
  });
});

describe("buildDashboardSnapshot — briefingState matrix", () => {
  beforeEach(() => {
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);
  });

  it("ready — fresh cached briefing with a valid dailyBriefing block", async () => {
    const briefing = {
      greeting: "Hallo",
      paragraph: "Alles im grünen Bereich.",
      keyFindings: [],
    };
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({ dailyBriefing: briefing }),
      }),
    );
    expect(snap.briefingState).toBe("ready");
    expect(snap.briefing).not.toBeNull();
    expect(snap.briefing!.paragraph).toContain("grünen");
  });

  it("preparing — cache older than 24h still DELIVERS the stale briefing with briefingStale: true", async () => {
    const cachedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: cachedAt,
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
    expect(snap.briefingState).toBe("preparing");
    // v1.15.20 — the last good briefing rides along instead of a blank
    // tile; the stale flag + timestamp carry the honesty.
    expect(snap.briefing).not.toBeNull();
    expect(snap.briefingStale).toBe(true);
    expect(snap.briefingUpdatedAt).toBe(cachedAt.toISOString());
  });

  it("preparing — never generated (null cache)", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    expect(snap.briefingState).toBe("preparing");
    expect(snap.briefing).toBeNull();
    expect(snap.briefingStale).toBe(false);
  });

  it("no-provider — stale cache and no provider configured anywhere", async () => {
    hasAnyConfiguredProvider.mockResolvedValue(false);
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    expect(snap.briefingState).toBe("no-provider");
    expect(snap.briefing).toBeNull();
  });

  it("no-provider — still delivers a stale briefing when one exists", async () => {
    hasAnyConfiguredProvider.mockResolvedValue(false);
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
    expect(snap.briefingState).toBe("no-provider");
    expect(snap.briefing).not.toBeNull();
    expect(snap.briefingStale).toBe(true);
  });

  it("ready — the provider presence probe never runs on a fresh cache", async () => {
    await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
    expect(hasAnyConfiguredProvider).not.toHaveBeenCalled();
  });

  it("the builder lifts the cache and leaves the capability to the read", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
    expect(snap.briefingState).toBe("ready");
    expect(snap.briefing).not.toBeNull();
    expect(snap.briefingAi).toBeNull();
  });

  it("preparing — malformed cached briefing (invalid shape)", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({ dailyBriefing: { bogus: 1 } }),
      }),
    );
    expect(snap.briefingState).toBe("preparing");
    expect(snap.briefing).toBeNull();
  });
});

describe("applyBriefingCapability — the per-read briefing gate", () => {
  beforeEach(() => {
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);
  });

  async function readySnapshot() {
    return buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
  }

  it("keeps the briefing and publishes the state while available", async () => {
    const snap = applyBriefingCapability(await readySnapshot(), AI_AVAILABLE);
    expect(snap.briefing).not.toBeNull();
    expect(snap.briefingState).toBe("ready");
    expect(snap.briefingAi).toEqual(AI_AVAILABLE);
  });

  it.each([
    "operator_disabled",
    "user_disabled",
    "consent_required",
    "not_permitted_for_record",
    "check_failed",
  ] as const)(
    "hides the briefing, its recall and its timestamp for %s",
    async (reason) => {
      const snap = applyBriefingCapability(
        {
          ...(await readySnapshot()),
          briefingMemory: { recall: "r" } as never,
        },
        aiUnavailable(reason),
      );
      expect(snap.briefing).toBeNull();
      expect(snap.briefingMemory).toBeNull();
      expect(snap.briefingUpdatedAt).toBeNull();
      expect(snap.briefingStale).toBe(false);
      expect(snap.briefingState).toBe("disabled");
      expect(snap.briefingAi).toEqual(aiUnavailable(reason));
    },
  );

  it("keeps the published no-provider state for a missing provider", async () => {
    const snap = applyBriefingCapability(
      await readySnapshot(),
      aiUnavailable("no_provider"),
    );
    expect(snap.briefing).toBeNull();
    expect(snap.briefingState).toBe("no-provider");
  });
});

describe("buildDashboardSnapshot — briefing locale tag", () => {
  beforeEach(() => {
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);
  });

  const briefing = {
    greeting: "Hello",
    paragraph: "Everything is in the green.",
    keyFindings: [],
  };

  it("a cache tagged 'en' read by a 'de' reader serves NO prose and reports preparing", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({ dailyBriefing: briefing }),
        insightsCachedLocale: "en",
      }),
      { locale: "de" },
    );
    expect(snap.briefingState).toBe("preparing");
    expect(snap.briefing).toBeNull();
    expect(snap.briefingStale).toBe(false);
    expect(snap.briefingUpdatedAt).toBeNull();
  });

  it("a mismatched tag with no provider anywhere reports no-provider, still without prose", async () => {
    hasAnyConfiguredProvider.mockResolvedValue(false);
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({ dailyBriefing: briefing }),
        insightsCachedLocale: "en",
      }),
      { locale: "de" },
    );
    expect(snap.briefingState).toBe("no-provider");
    expect(snap.briefing).toBeNull();
  });

  it("an untagged cache (written before the tag existed) is served as before", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({ dailyBriefing: briefing }),
        insightsCachedLocale: null,
      }),
      { locale: "de" },
    );
    expect(snap.briefingState).toBe("ready");
    expect(snap.briefing?.paragraph).toBe(briefing.paragraph);
  });

  it("a matching tag is served", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({ dailyBriefing: briefing }),
        insightsCachedLocale: "de",
      }),
      { locale: "de" },
    );
    expect(snap.briefingState).toBe("ready");
    expect(snap.briefing?.paragraph).toBe(briefing.paragraph);
  });
});

describe("buildDashboardSnapshot — no LLM in the path", () => {
  it("the builder module never imports the provider chain", async () => {
    // Structural guard — the builder must assemble from rollup / mood /
    // widget reads only. If a future edit pulls a provider client in,
    // this assertion fails before it ships.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../snapshot.ts"),
      "utf8",
    );
    // Strip line + block comments so the guard checks executable code,
    // not the docstring that explicitly states the no-LLM contract.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/provider-runner|provider-chain|resolveProvider/);
    expect(code).not.toMatch(/runRawCompletion|extractFeatures/);
    expect(code).not.toMatch(/fetch\(\s*["'`][^"'`]*insights\/generate/);
  });
});

describe("buildDashboardSnapshot — metricStates (iOS cold-launch seed)", () => {
  beforeEach(() => {
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);
  });

  it("keys each entry by the iOS MetricKind raw value (incl. the non-obvious raws)", async () => {
    const now = new Date().toISOString();
    computeSummariesSlice.mockResolvedValue({
      summaries: {
        WEIGHT: { ...emptySummary, count: 1, latest: 80 },
        OXYGEN_SATURATION: { ...emptySummary, count: 1, latest: 98 },
        TOTAL_BODY_WATER: { ...emptySummary, count: 1, latest: 42 },
        HEART_RATE_VARIABILITY: { ...emptySummary, count: 1, latest: 55 },
        BODY_MASS_INDEX: { ...emptySummary, count: 1, latest: 24.5 },
        WALKING_ASYMMETRY: { ...emptySummary, count: 1, latest: 3 },
        WALKING_DOUBLE_SUPPORT: { ...emptySummary, count: 1, latest: 27 },
        AUDIO_EXPOSURE_ENV: { ...emptySummary, count: 1, latest: 72 },
        AUDIO_EXPOSURE_HEADPHONE: { ...emptySummary, count: 1, latest: 65 },
        ACTIVE_ENERGY_BURNED: { ...emptySummary, count: 1, latest: 540 },
      },
      lastSeenByType: {
        WEIGHT: { lastSeenAt: now },
        OXYGEN_SATURATION: { lastSeenAt: now },
        TOTAL_BODY_WATER: { lastSeenAt: now },
        HEART_RATE_VARIABILITY: { lastSeenAt: now },
        BODY_MASS_INDEX: { lastSeenAt: now },
        WALKING_ASYMMETRY: { lastSeenAt: now },
        WALKING_DOUBLE_SUPPORT: { lastSeenAt: now },
        AUDIO_EXPOSURE_ENV: { lastSeenAt: now },
        AUDIO_EXPOSURE_HEADPHONE: { lastSeenAt: now },
        ACTIVE_ENERGY_BURNED: { lastSeenAt: now },
      },
      bmi: null,
    });

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    const m = snap.metricStates;

    // Obvious raws.
    expect(m.weight).toEqual({ value: 80, measuredAt: now, unit: "kg" });
    // Non-obvious raws — the convergence-locks §4b mappings.
    expect(m.oxygenSaturation.value).toBe(98);
    expect(m.totalBodyWater.value).toBe(42);
    expect(m.heartRateVariability.value).toBe(55);
    expect(m.bodyMassIndex.value).toBe(24.5);
    expect(m.walkingAsymmetryPercentage.value).toBe(3);
    expect(m.walkingDoubleSupportPercentage.value).toBe(27);
    expect(m.environmentalAudioExposure.value).toBe(72);
    expect(m.headphoneAudioExposure.value).toBe(65);
    expect(m.activeEnergyBurned.value).toBe(540);

    // The raw enum keys must NOT leak — only MetricKind raw values.
    expect(m.OXYGEN_SATURATION).toBeUndefined();
    expect(m.WEIGHT).toBeUndefined();

    // Every entry carries value + measuredAt + unit.
    for (const state of Object.values(m)) {
      expect(typeof state.value).toBe("number");
      expect(typeof state.measuredAt).toBe("string");
      expect(typeof state.unit).toBe("string");
    }
  });

  it("omits metrics with no latest value or no timestamp", async () => {
    computeSummariesSlice.mockResolvedValue({
      summaries: {
        WEIGHT: { ...emptySummary, count: 0, latest: null },
        PULSE: { ...emptySummary, count: 1, latest: 60 },
      },
      lastSeenByType: {
        // WEIGHT has a latest of null → omitted.
        // PULSE has no lastSeen entry → omitted.
        WEIGHT: { lastSeenAt: new Date().toISOString() },
        PULSE: null,
      },
      bmi: null,
    });
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    expect(snap.metricStates.weight).toBeUndefined();
    expect(snap.metricStates.pulse).toBeUndefined();
  });
});

describe("buildDashboardSnapshot — layoutCatalogue (35-id round-trip)", () => {
  beforeEach(() => {
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);
  });

  it("emits all 42 catalogue ids with visibility + order", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    expect(snap.layoutCatalogue).toHaveLength(42);
    const ids = new Set(snap.layoutCatalogue.map((w) => w.id));
    expect(ids.size).toBe(42);
    // iOS-only ids appended default-invisible.
    const walkingSpeed = snap.layoutCatalogue.find(
      (w) => w.id === "walkingSpeed",
    );
    expect(walkingSpeed).toBeDefined();
    expect(walkingSpeed!.visible).toBe(false);
    for (const w of snap.layoutCatalogue) {
      expect(typeof w.visible).toBe("boolean");
      expect(typeof w.order).toBe("number");
    }
  });

  it("inherits the user's resolved visibility for server-known ids", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        dashboardWidgetsJson: {
          version: 1,
          widgets: [
            { id: "weight", visible: true, order: 0 },
            { id: "sleep", visible: false, order: 7 },
          ],
        },
      }),
    );
    const weight = snap.layoutCatalogue.find((w) => w.id === "weight");
    expect(weight!.visible).toBe(true);
  });
});

describe("buildDashboardSnapshot — additive proof", () => {
  it("leaves every existing top-level field present and unchanged in shape", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      last90Days: { pct: 80, pairs: 20 },
      last90EarliestAt: new Date("2026-03-01T00:00:00.000Z"),
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
    });

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    // The pre-v1.7.0 top-level keys must all still be present.
    const legacyKeys = [
      "user",
      "layout",
      "tiles",
      "extras",
      "briefing",
      "briefingState",
      "briefingUpdatedAt",
      "generatedAt",
    ];
    for (const key of legacyKeys) {
      expect(snap).toHaveProperty(key);
    }
    // The new additive blocks sit alongside, not in place of.
    expect(snap).toHaveProperty("metricStates");
    expect(snap).toHaveProperty("layoutCatalogue");
    expect(snap).toHaveProperty("briefingStale");
    expect(snap).toHaveProperty("medsToday");
    expect(snap).toHaveProperty("healthScore");

    // The web-consumed `layout` block is the resolved per-user layout —
    // NOT replaced by the 35-id catalogue.
    expect(snap.layout).toHaveProperty("version");
    expect(Array.isArray(snap.layout.widgets)).toBe(true);
    // Resolved layout still carries only server-known widget ids.
    expect(snap.layout.widgets.length).toBeLessThanOrEqual(29);

    // tiles shape unchanged.
    expect(snap.tiles).toHaveProperty("summaries");
    expect(snap.tiles).toHaveProperty("lastSeenByType");
    expect(snap.tiles).toHaveProperty("mood");
  });
});

describe("module gating maps — every toggleable-domain widget is mapped (v1.18.0)", () => {
  // The dashboard widget ids that belong to a toggleable module. A new
  // toggleable widget MUST be added here AND to `WIDGET_MODULE_BY_ID`, or
  // it would leak onto a disabled-module account's dashboard.
  const TOGGLEABLE_WIDGET_IDS = [
    "mood",
    "sleep",
    "glucose",
    "achievements",
    "recentWorkouts",
    // v1.18.1 (D3) — medications graduated from CORE to a toggleable module.
    "medications",
    "cardioRecovery",
    "sixMinuteWalk",
    "stairAscentSpeed",
    "stairDescentSpeed",
    "breathingDisturbances",
    // v1.29 — fluid-intake strip tile, nutrients-store-backed.
    "waterIntake",
  ] as const;

  it("every toggleable-domain widget id has a module mapping", () => {
    for (const id of TOGGLEABLE_WIDGET_IDS) {
      expect(
        WIDGET_MODULE_BY_ID[id],
        `widget "${id}" is missing a WIDGET_MODULE_BY_ID entry`,
      ).toBeDefined();
    }
  });

  it("every mapped widget value is a real ModuleKey", () => {
    for (const [id, key] of Object.entries(WIDGET_MODULE_BY_ID)) {
      expect(
        MODULE_KEYS.includes(key as ModuleKey),
        `widget "${id}" maps to unknown module "${key}"`,
      ).toBe(true);
    }
  });

  it("every summary-type mapping value is a real ModuleKey", () => {
    for (const [type, key] of Object.entries(SUMMARY_TYPE_MODULE)) {
      expect(
        MODULE_KEYS.includes(key as ModuleKey),
        `summary type "${type}" maps to unknown module "${key}"`,
      ).toBe(true);
    }
  });

  it("recovery-domain widgets resolve to the recovery module", () => {
    expect(WIDGET_MODULE_BY_ID.cardioRecovery).toBe("recovery");
    expect(WIDGET_MODULE_BY_ID.sixMinuteWalk).toBe("recovery");
    expect(WIDGET_MODULE_BY_ID.stairAscentSpeed).toBe("recovery");
    expect(WIDGET_MODULE_BY_ID.stairDescentSpeed).toBe("recovery");
    expect(SUMMARY_TYPE_MODULE.CARDIO_RECOVERY).toBe("recovery");
    expect(SUMMARY_TYPE_MODULE.SIX_MINUTE_WALK_DISTANCE).toBe("recovery");
    expect(SUMMARY_TYPE_MODULE.STAIR_ASCENT_SPEED).toBe("recovery");
    expect(SUMMARY_TYPE_MODULE.STAIR_DESCENT_SPEED).toBe("recovery");
  });

  it("breathing-disturbance widget + type resolve to the sleep module", () => {
    expect(WIDGET_MODULE_BY_ID.breathingDisturbances).toBe("sleep");
    expect(SUMMARY_TYPE_MODULE.BREATHING_DISTURBANCES).toBe("sleep");
  });

  it("fluid-intake widget + synthetic summary type resolve to the nutrients module (v1.29)", () => {
    expect(WIDGET_MODULE_BY_ID.waterIntake).toBe("nutrients");
    expect(SUMMARY_TYPE_MODULE.NUTRIENT_WATER).toBe("nutrients");
  });
});

describe("buildDashboardSnapshot — module gating (v1.18.0)", () => {
  const widget = (
    snap: {
      layout: {
        widgets: { id: string; visible: boolean; tileVisible?: boolean }[];
      };
    },
    id: string,
  ) => snap.layout.widgets.find((w) => w.id === id);
  const cat = (
    snap: { layoutCatalogue: { id: string; visible: boolean }[] },
    id: string,
  ) => snap.layoutCatalogue.find((w) => w.id === id);

  beforeEach(() => {
    // A warm, data-rich account so every toggleable surface would
    // otherwise render — the assertions then prove the disabled ones drop.
    probeRollupCoverage.mockResolvedValue(
      new Map([
        ["WEIGHT", true],
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]),
    );
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      last90Days: { pct: 80, pairs: 20 },
      last90EarliestAt: new Date("2026-03-01T00:00:00.000Z"),
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
    });
    computeSummariesSlice.mockResolvedValue({
      summaries: {
        WEIGHT: { ...emptySummary, count: 3, latest: 80 },
        SLEEP_DURATION: { ...emptySummary, count: 5, latest: 420 },
        BLOOD_GLUCOSE: { ...emptySummary, count: 9, latest: 95 },
      },
      lastSeenByType: {
        WEIGHT: { lastSeenAt: new Date().toISOString() },
        SLEEP_DURATION: { lastSeenAt: new Date().toISOString() },
        BLOOD_GLUCOSE: { lastSeenAt: new Date().toISOString() },
      },
      bmi: null,
    });
    // Glucose rows so `extras.glucoseByContext` + `glucoseClinical` populate.
    fakePrisma.measurement.findMany.mockResolvedValue([
      { value: 95, measuredAt: new Date(), glucoseContext: "FASTING" },
      { value: 110, measuredAt: new Date(), glucoseContext: "FASTING" },
    ]);
    // Mood entries so the tile would otherwise carry a summary.
    fakePrisma.moodEntry.findMany.mockResolvedValue([
      { date: new Date(), score: 4 },
    ]);
    // v1.29 — water rows so the fluid-intake tile would otherwise carry a
    // summary (proving the nutrients module actually strips it below).
    fakePrisma.nutrientIntakeDay.findMany.mockResolvedValue([
      { day: new Date().toISOString().slice(0, 10), amount: 1500 },
    ]);
  });

  it("all modules on: every toggleable tile + its data is present", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      modules: () => Promise.resolve(moduleMap()),
    });
    expect(widget(snap, "mood")!.visible).toBe(true);
    expect(widget(snap, "sleep")).toBeDefined();
    expect(widget(snap, "glucose")).toBeDefined();
    expect(widget(snap, "achievements")!.visible).toBe(true);
    expect(widget(snap, "recentWorkouts")!.visible).toBe(true);
    expect(snap.tiles.summaries.SLEEP_DURATION).toBeDefined();
    expect(snap.tiles.summaries.BLOOD_GLUCOSE).toBeDefined();
    expect(snap.tiles.mood.entries.length).toBeGreaterThan(0);
    expect(Object.keys(snap.extras!.glucoseByContext).length).toBeGreaterThan(
      0,
    );
  });

  it("mental assessments disabled: WELLBEING is omitted from the score", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      modules: () => Promise.resolve(moduleMap({ mentalHealth: false })),
    });
    // The independent mood tile is unaffected by the assessment-module gate.
    expect(widget(snap, "mood")!.visible).toBe(true);
    expect(snap.tiles.mood.entries.length).toBeGreaterThan(0);
    const scoreCall = computeUserHealthScoreMock.mock.calls.at(-1)?.[0] as
      { modules: { mentalHealth: boolean } } | undefined;
    expect(scoreCall?.modules.mentalHealth).toBe(false);
  });

  it("mental assessments enabled: the score admits WELLBEING", async () => {
    await buildDashboardSnapshot(fakePrisma, baseUser(), {
      modules: () => Promise.resolve(moduleMap()),
    });
    const scoreCall = computeUserHealthScoreMock.mock.calls.at(-1)?.[0] as
      { modules: { mentalHealth: boolean } } | undefined;
    expect(scoreCall?.modules.mentalHealth).toBe(true);
  });

  it("an explicit weight target reaches personal context and dashboard bands", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({ thresholdsJson: { WEIGHT: { min: 74, max: 78 } } }),
      { modules: () => Promise.resolve(moduleMap()) },
    );
    const scoreCall = computeUserHealthScoreMock.mock.calls.at(-1)?.[0] as
      { profile: { thresholdsJson: unknown } } | undefined;
    expect(scoreCall?.profile.thresholdsJson).toEqual({
      WEIGHT: { min: 74, max: 78 },
    });
    // The tile / chart band follows the same target.
    expect(snap.targetBands.weightRange?.greenMin).toBe(74);
    expect(snap.targetBands.weightRange?.greenMax).toBe(78);
  });

  it("sleep disabled: tile hidden + SLEEP_DURATION stripped from summaries", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      modules: () => Promise.resolve(moduleMap({ sleep: false })),
    });
    expect(widget(snap, "sleep")!.visible).toBe(false);
    expect(snap.tiles.summaries.SLEEP_DURATION).toBeUndefined();
    expect(snap.tiles.lastSeenByType.SLEEP_DURATION).toBeUndefined();
    expect(snap.metricStates.sleep).toBeUndefined();
    // Glucose untouched.
    expect(snap.tiles.summaries.BLOOD_GLUCOSE).toBeDefined();
  });

  it("glucose disabled: tile hidden + summary stripped + clinical panel cleared", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      modules: () => Promise.resolve(moduleMap({ glucose: false })),
    });
    expect(widget(snap, "glucose")!.visible).toBe(false);
    expect(snap.tiles.summaries.BLOOD_GLUCOSE).toBeUndefined();
    expect(snap.metricStates.bloodGlucose).toBeUndefined();
    expect(snap.extras!.glucoseByContext).toEqual({});
    // Sleep untouched.
    expect(snap.tiles.summaries.SLEEP_DURATION).toBeDefined();
  });

  it("workouts disabled: recent-workouts tile hidden", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      modules: () => Promise.resolve(moduleMap({ workouts: false })),
    });
    expect(widget(snap, "recentWorkouts")!.visible).toBe(false);
    expect(widget(snap, "recentWorkouts")!.tileVisible).toBe(false);
    expect(cat(snap, "recentWorkouts")!.visible).toBe(false);
  });

  it("achievements disabled: recent-unlocks tile hidden", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      modules: () => Promise.resolve(moduleMap({ achievements: false })),
    });
    expect(widget(snap, "achievements")!.visible).toBe(false);
  });

  it("nutrients on: fluid-intake tile widget carries the synthetic NUTRIENT_WATER summary (v1.29)", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      modules: () => Promise.resolve(moduleMap()),
    });
    expect(snap.tiles.summaries.NUTRIENT_WATER).toBeDefined();
    expect(snap.tiles.summaries.NUTRIENT_WATER!.latest).toBe(1500);
  });

  it("nutrients disabled: waterIntake tile hidden + NUTRIENT_WATER stripped from summaries (v1.29)", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      modules: () => Promise.resolve(moduleMap({ nutrients: false })),
    });
    expect(widget(snap, "waterIntake")!.visible).toBe(false);
    expect(widget(snap, "waterIntake")!.tileVisible).toBe(false);
    expect(cat(snap, "waterIntake")!.visible).toBe(false);
    expect(snap.tiles.summaries.NUTRIENT_WATER).toBeUndefined();
    expect(snap.tiles.lastSeenByType.NUTRIENT_WATER).toBeUndefined();
  });

  it("insights disabled: the builder no longer decides the briefing (the read applies the capability)", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedText: JSON.stringify({
          dailyBriefing: {
            headline: "x",
            body: "y",
            generatedAt: new Date().toISOString(),
          },
        }),
        insightsCachedAt: new Date(),
      }),
      { modules: () => Promise.resolve(moduleMap({ insights: false })) },
    );
    // The `insights` module is the AI analysis opt-out, folded into the
    // `briefing` capability that `applyBriefingCapability` applies per read.
    expect(snap.briefingAi).toBeNull();
  });

  it("defaults to resolveModuleMap when no override is injected", async () => {
    resolveModuleMap.mockResolvedValue(moduleMap({ mood: false }));
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    expect(resolveModuleMap).toHaveBeenCalledWith("user-1");
    expect(widget(snap, "mood")!.visible).toBe(false);
  });
});

// v1.21.2 (A4 / A5 / A6) — the ambient-narrative wire. The Tension Verdict +
// return-to-baseline ride the warm-phase healthScore; the briefing recall +
// forward-look rides `briefingMemory`. The resolvers themselves are pinned in
// `score-narrative.test.ts`; here only the THREADING through the snapshot DTO is
// asserted, via the injectable builders.
describe("buildDashboardSnapshot — ambient narrative (A4/A5/A6)", () => {
  /** Warm coverage + a non-null health score so the narrative branch runs. */
  function warmScore() {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      last90Days: { pct: 80, pairs: 20 },
      last90EarliestAt: new Date("2026-03-01T00:00:00.000Z"),
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
    });
    computeUserHealthScoreMock.mockResolvedValue({
      score: 71,
      band: "yellow",
      delta: 3,
    });
  }

  it("folds tension + returnToBand onto the health score", async () => {
    warmScore();
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      scoreNarrative: vi.fn(async () => ({
        tension: {
          band: "yellow" as const,
          positive: ["sleep" as const],
          negative: ["rhr" as const],
        },
        returnToBand: {
          metricType: "RESTING_HEART_RATE" as const,
          daysInside: 4,
        },
      })),
    });
    expect(snap.healthScore!.tension).toEqual({
      band: "yellow",
      positive: ["sleep"],
      negative: ["rhr"],
    });
    expect(snap.healthScore!.returnToBand).toEqual({
      metricType: "RESTING_HEART_RATE",
      daysInside: 4,
    });
  });

  it("leaves tension + returnToBand null when the resolver yields nothing", async () => {
    warmScore();
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      scoreNarrative: vi.fn(async () => ({
        tension: null,
        returnToBand: null,
      })),
    });
    expect(snap.healthScore!.tension).toBeNull();
    expect(snap.healthScore!.returnToBand).toBeNull();
  });

  it("does NOT run the score narrative when no health score rendered", async () => {
    // No warm coverage → healthScore null → the narrative branch is skipped.
    probeRollupCoverage.mockResolvedValue(new Map());
    const scoreNarrative = vi.fn(async () => ({
      tension: null,
      returnToBand: null,
    }));
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser(), {
      scoreNarrative,
    });
    expect(snap.healthScore).toBeNull();
    expect(scoreNarrative).not.toHaveBeenCalled();
  });

  it("threads the briefing recall + forward-look through briefingMemory", async () => {
    warmScore();
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
      {
        locale: "en",
        coachMemory: vi.fn(async () => ({
          priorNarrative: {
            headline: "Your resting heart rate drifted up early last month.",
            drivers: [],
          },
          trendMemory: {
            RESTING_HEART_RATE: {
              priorBand: "in" as const,
              currentBand: "above" as const,
              priorPeriod: "month" as const,
            },
          },
        })),
      },
    );
    expect(snap.briefingMemory).not.toBeNull();
    expect(snap.briefingMemory!.recall).toContain("resting heart rate");
    // The forward-look points at the drifted metric (or a holding line); either
    // way it is a non-empty localised string.
    expect(snap.briefingMemory!.forward.length).toBeGreaterThan(0);
  });

  it("leaves briefingMemory null when no prior narrative is on file", async () => {
    warmScore();
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
      {
        coachMemory: vi.fn(async () => ({ trendMemory: {} })),
      },
    );
    expect(snap.briefingMemory).toBeNull();
  });
});

/**
 * v1.27.7 — hero score rings on the snapshot wire. The resolver itself
 * is pinned in `score-rings.test.ts`; here only the assembly contract:
 * the builder receives the RESOLVED `selectedScoreRings` preference +
 * the module map, its result rides `snapshot.scoreRings`, and a
 * rejection degrades to an empty row (never a sunk snapshot).
 */
describe("buildDashboardSnapshot — scoreRings wire", () => {
  it("threads the default selection (MED_COMPLIANCE) for a layout-less user", async () => {
    probeRollupCoverage.mockResolvedValue(new Map());
    buildScoreRingsBlock.mockResolvedValue([
      { id: "MED_COMPLIANCE", score: 92, band: "green" },
    ]);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(buildScoreRingsBlock).toHaveBeenCalledTimes(1);
    const [, userId, selected, modules, , medsToday] =
      buildScoreRingsBlock.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(selected).toEqual(["MED_COMPLIANCE"]);
    expect(modules).toEqual(moduleMap());
    // The dose ring reads the SAME medsToday block the snapshot ships —
    // one builder call, no second tally.
    expect(medsToday).toEqual(snap.medsToday);
    expect(snap.scoreRings).toEqual([
      { id: "MED_COMPLIANCE", score: 92, band: "green" },
    ]);
  });

  it("threads a saved multi-ring selection in order", async () => {
    probeRollupCoverage.mockResolvedValue(new Map());
    buildScoreRingsBlock.mockResolvedValue([]);

    await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        dashboardWidgetsJson: {
          version: 1,
          widgets: [{ id: "weight", visible: true, order: 0 }],
          selectedScoreRings: ["READINESS", "SLEEP_SCORE"],
        },
      }),
    );

    const [, , selected] = buildScoreRingsBlock.mock.calls[0];
    expect(selected).toEqual(["READINESS", "SLEEP_SCORE"]);
  });

  it("degrades a rejecting resolver to an empty ring row (fail-soft)", async () => {
    probeRollupCoverage.mockResolvedValue(new Map());
    buildScoreRingsBlock.mockRejectedValue(new Error("engine down"));

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.scoreRings).toEqual([]);
    // The rest of the envelope is untouched by the failure.
    expect(snap.tiles.summaries.WEIGHT).toBeDefined();
  });
});

describe("buildDashboardSnapshot — the wire carries the stored gender", () => {
  beforeEach(() => {
    // Prime only what the user block needs; this suite must not inherit
    // another test's mock state.
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);
    computeBpInTargetFastPath.mockResolvedValue(null);
  });

  it("emits OTHER rather than flattening it to no answer", async () => {
    // Narrowing to two values on the wire made an account that answered
    // OTHER indistinguishable from one that answered nothing, on every
    // client reading this payload.
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({ gender: "OTHER" }),
    );
    expect(snap.user.gender).toBe("OTHER");
  });

  it("still reports no answer as null", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({ gender: null }),
    );
    expect(snap.user.gender).toBeNull();
  });
});
