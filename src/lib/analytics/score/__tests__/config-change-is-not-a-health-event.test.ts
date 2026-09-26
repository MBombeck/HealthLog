/**
 * The named failure, driven end to end: someone opens the score
 * settings, changes which pillars count, and the app tells them their
 * health dropped.
 *
 * The bug is subtle enough that it survives any test which stops at one
 * end. All three comparison windows are computed in ONE request under
 * whatever recipe is in force at that moment, so both sides carry the
 * same composition, `sameComposition` agrees, and the subtraction looks
 * legitimate. What actually moved is the construct: the week-over-week
 * delta after a reconfiguration averages a different set of pillars
 * than the one before it, so a week that read as a couple of points can
 * read as fourteen the moment the person leaves the settings page.
 *
 * So this file refuses to hand a payload from one end to the other. It
 * drives the real chain, in the order a request does:
 *
 *   fixture rows
 *     → `computeUserHealthScore` (the real reader, real pillars)
 *     → `computeAndRecordUserHealthScore` (the real write path)
 *     → `buildDashboardSnapshot` (the real snapshot mapping)
 *     → `loadDailyDigest` → `buildDailyDigest` (the real morning line)
 *
 * The digest is the last stop before a person: the Today hero renders the
 * delta chip on `delta !== null && deltaReason === null` and the morning
 * push sends `line` verbatim, so those two fields are asserted rather than
 * any intermediate the renderer does not read.
 *
 * Only the IO around that chain is faked. A version of this test that
 * built a `DashboardSnapshot` literal by hand would have been green
 * through a release where the assembly between the two ends dropped the
 * field, which is a thing that has happened here.
 *
 * Every case runs twice with the same data: once with the recipe
 * changed inside the comparison window, once with it changed a month
 * before. The second run is not decoration. It is what proves the
 * fixture really does produce a ten-point-plus drop and that the first
 * run's silence is the guard doing work rather than an account with
 * nothing to say.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/generated/prisma/client";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-20T12:00:00.000Z");

/**
 * A steady, month-long decline in steps and sleep.
 *
 * Gradual on purpose. A cliff would blow up each pillar's own standard
 * deviation, the noise floor would rise with it, and `below_noise_floor`
 * would suppress the delta for a reason that has nothing to do with the
 * recipe — a test that passes because the number never moved proves
 * nothing about a guard that stops numbers from moving.
 */
const FIXTURE = vi.hoisted(() => {
  const DAY = 86_400_000;
  const AT = new Date("2026-08-20T12:00:00.000Z").getTime();
  const rows: Array<{
    type: string;
    value: number;
    unit: string;
    source: string;
    measuredAt: Date;
    deviceType: string | null;
    glucoseContext: string | null;
    sleepStage: string | null;
  }> = [];
  for (let back = 44; back >= 0; back -= 1) {
    const measuredAt = new Date(AT - back * DAY);
    rows.push({
      type: "ACTIVITY_STEPS",
      value: 4_200 + back * 260,
      unit: "steps",
      source: "MANUAL",
      measuredAt,
      deviceType: null,
      glucoseContext: null,
      sleepStage: null,
    });
    rows.push({
      type: "SLEEP_DURATION",
      value: 300 + back * 5,
      unit: "min",
      source: "MANUAL",
      measuredAt: new Date(new Date(measuredAt).setUTCHours(6, 0, 0, 0)),
      deviceType: null,
      glucoseContext: null,
      sleepStage: "ASLEEP",
    });
  }
  rows.push({
    type: "WAIST_TO_HEIGHT",
    value: 0.45,
    unit: "ratio",
    source: "MANUAL",
    measuredAt: new Date(AT - 20 * DAY),
    deviceType: null,
    glucoseContext: null,
    sleepStage: null,
  });
  return rows;
});

/**
 * One fake client behind BOTH `@/lib/db` and the snapshot builder's
 * injected client, so the reader's measurement reads, the score
 * record's insert and the digest's own light reads all see the same
 * account.
 */
const writtenRecords = vi.hoisted(() => [] as Array<Record<string, unknown>>);

/** The dismiss ledger, as a set of item keys the account has acknowledged. */
const dismissedKeys = vi.hoisted(() => new Set<string>());

const fakeDb = vi.hoisted(() => {
  const rows = FIXTURE;
  const written = writtenRecords;
  const none = async () => [];
  return {
    measurement: {
      // Both callers' `where` shapes: the score reader asks for a set of
      // types, the snapshot's glucose read asks for one.
      findMany: async (query: {
        where: {
          type: string | { in: string[] };
          measuredAt?: { gte: Date };
          glucoseContext?: string;
        };
      }) => {
        const wanted =
          typeof query.where.type === "string"
            ? [query.where.type]
            : query.where.type.in;
        const since = query.where.measuredAt?.gte ?? new Date(0);
        return rows.filter(
          (row) =>
            wanted.includes(row.type) &&
            row.measuredAt >= since &&
            (query.where.glucoseContext === undefined ||
              row.glucoseContext === query.where.glucoseContext),
        );
      },
    },
    mentalHealthAssessment: { findMany: none },
    labResult: { findMany: none },
    dismissedPriorityItem: {
      // Honours the composite key. A stub that ignored `where` would
      // make "dismissed once per recipe version" untestable: every key
      // would read as dismissed, or none would.
      findUnique: async (query: {
        where: { userId_itemKey: { userId: string; itemKey: string } };
      }) =>
        dismissedKeys.has(query.where.userId_itemKey.itemKey)
          ? { itemKey: query.where.userId_itemKey.itemKey }
          : null,
      findMany: none,
    },
    healthScoreRecord: {
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        written.push(...args.data);
        return { count: args.data.length };
      },
      // v1.38 — the composition note's read. These cases are about a
      // RECIPE change, which that note deliberately stays silent on, and
      // an account with no stored day has nothing to compare against
      // either way.
      findFirst: async () => null,
    },
    illnessEpisode: { findMany: none },
    moodEntry: { findMany: none },
    nutrientIntakeDay: { findMany: none },
    integrationStatus: { findMany: none },
    measurementReminder: { findMany: none },
    coachPlan: { findMany: none },
    ecgRecording: { findFirst: async () => null },
    personalRecord: { findMany: none },
    arrivalReaction: { findMany: none },
    encounter: { findMany: none },
    // The AI capability loader's consent read: no receipts.
    consentReceipt: { findMany: none },
  };
});

vi.mock("@/lib/db", () => ({ prisma: fakeDb }));

// ── Everything around the score, faked at its own seam ──────────────
const computeSummariesSlice = vi.fn();
const probeRollupCoverage = vi.fn();
const isFullyCovered = vi.fn();
const readMoodDayRollups = vi.fn();
const ensureUserMoodRollupsFresh = vi.fn();
const computeBpInTargetFastPath = vi.fn();
const getAssistantFlags = vi.fn();
const hasAnyConfiguredProvider = vi.fn();
const buildMedsTodayBlock = vi.fn();
const resolveModuleMap = vi.fn();
const buildScoreRingsBlock = vi.fn();
const readDashboardSnapshotCached = vi.fn();
const loadIntradayPulse = vi.fn();
const readDayMeanSeries = vi.fn();

vi.mock("@/lib/analytics/summaries-slice", () => ({
  computeSummariesSlice: (...a: unknown[]) => computeSummariesSlice(...a),
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: (...a: unknown[]) => probeRollupCoverage(...a),
  isFullyCovered: (...a: unknown[]) => isFullyCovered(...a),
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
vi.mock("@/lib/feature-flags", async () =>
  (
    await import("@/__tests__/helpers/assistant-switches-mock")
  ).mockAssistantSwitches(() => getAssistantFlags()),
);
vi.mock("@/lib/ai/provider", () => ({
  hasAnyConfiguredProvider: (...a: unknown[]) => hasAnyConfiguredProvider(...a),
  // The capability loader's presence probe: no provider on the record.
  probeProviderChain: async () => ({
    entries: [],
    localOcrEnabled: false,
    managedBy: null,
  }),
}));
vi.mock("@/lib/dashboard/meds-today", () => ({
  buildMedsTodayBlock: (...a: unknown[]) => buildMedsTodayBlock(...a),
}));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: (...a: unknown[]) => resolveModuleMap(...a),
  // The operator offers every module; the AI capability loader reads it.
  getOperatorModuleAvailability: async () => moduleMap(),
}));
vi.mock("@/lib/dashboard/score-rings", () => ({
  buildScoreRingsBlock: (...a: unknown[]) => buildScoreRingsBlock(...a),
}));
vi.mock("@/lib/dashboard/snapshot-read", () => ({
  readDashboardSnapshotCached: (...a: unknown[]) =>
    readDashboardSnapshotCached(...a),
}));
vi.mock("@/lib/analytics/intraday-pulse-io", () => ({
  loadIntradayPulse: (...a: unknown[]) => loadIntradayPulse(...a),
}));
vi.mock("@/lib/insights/derived/baseline", () => ({
  readDayMeanSeries: (...a: unknown[]) => readDayMeanSeries(...a),
}));

import { buildDashboardSnapshot } from "@/lib/dashboard/snapshot";
import type { SnapshotUserInput } from "@/lib/dashboard/snapshot";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import type { ModuleKey } from "@/lib/modules/gate";
import { MODULE_KEYS } from "@/lib/modules/registry";

import { healthScoreConfigFromSelection } from "../config";
import { computeUserHealthScore } from "../reader";
import { SCORE_PILLAR_IDS, SCORE_VERSION } from "../types";

/** The recipe as the settings write would have stored it. */
function recipe(changedAt: Date): unknown {
  return healthScoreConfigFromSelection({
    // The person keeps the four pillars they have data for and drops the
    // rest. The composition this resolves to is the same either way in
    // this fixture, which is exactly the case a composition comparison
    // cannot see.
    selection: SCORE_PILLAR_IDS.filter((id) => id !== "LIPIDS"),
    version: 3,
    changedAt,
  });
}

function moduleMap(): Record<ModuleKey, boolean> {
  return Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as Record<
    ModuleKey,
    boolean
  >;
}

function user(healthScoreConfigJson: unknown): SnapshotUserInput {
  return {
    id: "user-1",
    username: "tester",
    displayName: null,
    timezone: "UTC",
    heightCm: 180,
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    gender: "MALE",
    glucoseUnit: "mg/dL",
    onboardingTourCompleted: true,
    disableCoach: false,
    insightsCachedText: null,
    insightsCachedAt: null,
    insightsCachedLocale: null,
    dashboardWidgetsJson: null,
    thresholdsJson: null,
    healthScoreConfigJson,
  } as SnapshotUserInput;
}

/** The reader's own input, as the snapshot builder assembles it. */
function scoreInput(healthScoreConfigJson: unknown) {
  return {
    userId: "user-1",
    now: NOW,
    profile: {
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      gender: "MALE",
      heightCm: 180,
      timezone: "UTC",
      sourcePriorityJson: null,
      thresholdsJson: null,
    },
    modules: {
      glucose: true,
      labs: true,
      sleep: true,
      mentalHealth: true,
    },
    healthScoreConfigJson,
    bpTargets: null,
    bpEnvelope: null,
    bpEnvelopePriorWeek: null,
    bpEnvelopePriorTwoWeeks: null,
  };
}

/**
 * The whole chain for one account, from fixture rows to the sentence
 * that would ride a morning push.
 */
async function runChain(healthScoreConfigJson: unknown) {
  __resetAllCachesForTests();
  writtenRecords.length = 0;
  const snapshot = await buildDashboardSnapshot(
    fakeDb as never,
    user(healthScoreConfigJson),
  );
  readDashboardSnapshotCached.mockResolvedValue({
    body: {
      ...snapshot,
      layout: {
        ...snapshot.layout,
        enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS],
      },
    },
    locale: "en",
  });
  const digest = await loadDailyDigest(
    {
      id: "user-1",
      timezone: "UTC",
      morningDigestRefreshedOn: null,
    } as unknown as User,
    NOW,
  );
  return { snapshot, digest, record: writtenRecords[0] ?? null };
}

beforeEach(() => {
  // `buildDashboardSnapshot` reads its own clock — it takes no `now`.
  // Without a pinned system clock the fixture's dates would sit in the
  // future relative to the real one, every window would miss, and the
  // suite would go green on an account that has no comparable window
  // rather than on a suppressed one. Only `Date` is faked; the SWR cells
  // inside the digest loader still need working timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  __resetAllCachesForTests();
  dismissedKeys.clear();
  computeSummariesSlice.mockResolvedValue({
    summaries: {},
    lastSeenByType: {},
    bmi: null,
  });
  probeRollupCoverage.mockResolvedValue(
    new Map([
      ["WEIGHT", true],
      ["BLOOD_PRESSURE_SYS", true],
      ["BLOOD_PRESSURE_DIA", true],
    ]),
  );
  isFullyCovered.mockReturnValue(true);
  readMoodDayRollups.mockResolvedValue([]);
  // No blood pressure in the fixture: the envelope resolves with empty
  // windows rather than absent, which is what the builder expects and
  // what keeps BLOOD_PRESSURE honestly unscored.
  computeBpInTargetFastPath.mockResolvedValue({
    path: "live",
    last7Days: null,
    last30Days: null,
    last90Days: null,
    last90EarliestAt: null,
    last90LatestAt: null,
    allTime: null,
    priorMonth: null,
    priorYear: null,
    graded: null,
    representative: null,
  });
  getAssistantFlags.mockResolvedValue({
    enabled: false,
    coach: false,
    briefing: false,
    insightStatus: false,
    documentAi: false,
  });
  hasAnyConfiguredProvider.mockResolvedValue(false);
  buildMedsTodayBlock.mockResolvedValue({
    activeCount: 0,
    scheduledToday: 0,
    takenToday: 0,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
  });
  resolveModuleMap.mockResolvedValue(moduleMap());
  buildScoreRingsBlock.mockResolvedValue([]);
  loadIntradayPulse.mockResolvedValue({ tension: null });
  readDayMeanSeries.mockResolvedValue({ points: [], source: "none" });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The control. Same rows, same recipe, changed a month ago — outside
 * every comparison window — so nothing suppresses and the account's
 * genuine decline is narrated in full.
 */
const SETTLED = recipe(new Date(NOW.getTime() - 30 * DAY_MS));
/** The act: the recipe changed three days ago. */
const JUST_CHANGED = recipe(new Date(NOW.getTime() - 3 * DAY_MS));

describe("a settings change is never narrated as a health event", () => {
  it("shows a real ten-point-plus drop when no recipe changed in the window", async () => {
    const { snapshot, digest } = await runChain(SETTLED);

    // If this ever stops holding, every assertion in the next test is
    // vacuous: an account with no drop to suppress would pass it while
    // the guard did nothing at all.
    expect(snapshot.healthScore).not.toBeNull();
    expect(snapshot.healthScore!.deltaReason).toBeNull();
    expect(snapshot.healthScore!.delta).not.toBeNull();
    expect(snapshot.healthScore!.delta!).toBeLessThanOrEqual(-10);
    // And it survives the assembly to the field the hero reads, at the
    // full size — a drop that arrived rounded to nothing would leave the
    // suppression below with nothing to prove.
    expect(digest.score?.deltaReason).toBeNull();
    expect(digest.score?.delta).toBe(snapshot.healthScore!.delta);
    expect(digest.score!.delta!).toBeLessThanOrEqual(-10);
    // The fixture's AI is off because the operator switched it off, and the
    // capability loader actually ran to say so. `check_failed` here would mean
    // a mock starved the loader and the digest was assembled on a failure
    // path nobody meant to test.
    expect(digest.ai.coach.reason).toBe("operator_disabled");
    expect(digest.ai.reactionLines.reason).toBe("operator_disabled");
  });

  it("renders no delta chip when the recipe changed inside the window", async () => {
    // The chip first and on its own line: the hero paints it on
    // `delta !== null && deltaReason === null`, so that pair is what a
    // person actually sees and what has to go red when the guard goes
    // missing. Asserting the reason before it would fail one step
    // earlier and never exercise the render condition at all.
    const { digest } = await runChain(JUST_CHANGED);

    expect(
      digest.score !== null &&
        digest.score.delta !== null &&
        digest.score.deltaReason === null,
    ).toBe(false);
  });

  it("suppresses the delta with the reason that names the act", async () => {
    const { snapshot } = await runChain(JUST_CHANGED);

    expect(snapshot.healthScore).not.toBeNull();
    expect(snapshot.healthScore!.deltaReason).toBe("config_changed");
    expect(snapshot.healthScore!.delta).toBeNull();
  });

  it("carries no unexplained drop on the morning line", async () => {
    // The digest is the push's only source of words. A delta that
    // reached it without its reason is a drop nothing can explain: the
    // hero renders the chip on `deltaReason === null` alone.
    const { snapshot, digest } = await runChain(JUST_CHANGED);

    expect(digest.score).not.toBeNull();
    expect(digest.score!.delta).toBeNull();
    expect(digest.score!.deltaReason).toBe("config_changed");
    // The push body is `digest.line` verbatim. It states today's number
    // and nothing about its movement, which is the only honest sentence
    // available across a recipe change.
    expect(digest.line).toBe(
      `Your health score today is ${snapshot.healthScore!.score}.`,
    );
    expect(digest.line).not.toMatch(/[-−]\s?\d/);
    // The rail is the other place a drop could reach a person. Nothing
    // in it may be narrating the score either.
    expect(digest.worthALook.map((item) => item.kind)).not.toContain(
      "score_drop",
    );
  });

  it("still shows the number itself, only never its movement", async () => {
    // Suppressing the delta must not suppress the score. A person who
    // changed what counts should see what the new recipe says today;
    // what they must not see is a subtraction across the change.
    const { snapshot, digest } = await runChain(JUST_CHANGED);

    expect(snapshot.healthScore!.score).toBeGreaterThan(0);
    expect(digest.score!.value).toBe(snapshot.healthScore!.score);
  });

  it("writes the recipe that produced the day onto the stored record", async () => {
    // The supply half of the same change. The row is written by the real
    // path inside the same request the assertions above read from, so a
    // version that never reached the writer would show up here rather
    // than a release later when the seam turns out to be underivable.
    const { record } = await runChain(JUST_CHANGED);

    expect(record).not.toBeNull();
    expect(record!.configVersion).toBe(3);
    expect(record!.configChangedAt).toEqual(
      new Date(NOW.getTime() - 3 * DAY_MS),
    );
  });

  it("raises the recipe notice once, under a key the person can dismiss once", async () => {
    // The reader is driven directly here because the notice never
    // reaches the dashboard snapshot — it rides the analytics report.
    // Same account, same fixture, same request path the chain above
    // used, so the key asserted is the key the ledger will be asked for.
    const configured = await computeUserHealthScore(scoreInput(JUST_CHANGED));
    const unconfigured = await computeUserHealthScore(scoreInput(null));

    expect(configured.algorithmNotice!.itemKey).toBe(
      `health_score_algorithm:${SCORE_VERSION}:config:3`,
    );
    expect(configured.algorithmNotice!.dismissed).toBe(false);
    // An account that never chose keeps the bare method key, with no
    // recipe suffix on it.
    expect(unconfigured.algorithmNotice!.itemKey).toBe(
      `health_score_algorithm:${SCORE_VERSION}`,
    );

    dismissedKeys.add(`health_score_algorithm:${SCORE_VERSION}:config:3`);
    expect(
      (await computeUserHealthScore(scoreInput(JUST_CHANGED))).algorithmNotice!
        .dismissed,
    ).toBe(true);

    // The next recipe change raises it again, on its own key, and the
    // earlier dismissal does not carry over.
    const next = await computeUserHealthScore(
      scoreInput(
        healthScoreConfigFromSelection({
          selection: SCORE_PILLAR_IDS.filter((id) => id !== "LIPIDS"),
          version: 4,
          changedAt: new Date(NOW.getTime() - DAY_MS),
        }),
      ),
    );
    expect(next.algorithmNotice!.itemKey).toBe(
      `health_score_algorithm:${SCORE_VERSION}:config:4`,
    );
    expect(next.algorithmNotice!.dismissed).toBe(false);
  });

  it("stamps an honest zero when the account never chose", async () => {
    // Not an absence. The first authored recipe has to be recognisable
    // as a move from something, and 0 is what it moves from.
    const { record } = await runChain(null);

    expect(record).not.toBeNull();
    expect(record!.configVersion).toBe(0);
    expect(record!.configChangedAt).toBeNull();
  });
});
