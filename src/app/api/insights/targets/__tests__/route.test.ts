/**
 * v1.4.40 — `/api/insights/targets` mood-rollup tier swap.
 *
 * Audit Critical Finding #2 (`.planning/round-v1439-arch-qa-infra-db.md`)
 * flagged the unbounded `prisma.moodEntry.findMany({ where: { userId } })`
 * at the bottom of the route as one of the six unbounded mood walks
 * that paint the Insights surface 12 s cold on a power-user account.
 * This file pins:
 *
 *   1. **The mood-rollup DAY tier replaces the raw findMany when
 *      populated.** Mood targets (`MOOD_SCORE`, `MOOD_STABILITY`)
 *      compute their `current` / `average30` / `consistency7d` from
 *      the rollup row set; `prisma.moodEntry.findMany` is never
 *      called on the fast path. A single `findFirst` reads the
 *      latest score (one bounded row).
 *
 *   2. **The coverage-fallback runs the live walk once when the
 *      rollup tier is empty but raw entries exist** (legacy account
 *      before the boot-time backfill has caught up). Bounded by the
 *      trailing 30-day window so the fallback never repeats the
 *      legacy unbounded scan.
 *
 *   3. **The `findMany distinct(["type"])` "latest ever per type"
 *      query carries a `measuredAt: { gte: oneYearAgo }` floor**
 *      (audit High finding 3). Without the floor Postgres still has
 *      to sort the full 347 k-row tenant before applying DISTINCT ON
 *      because Prisma's `distinct` does not compile to PG's
 *      `DISTINCT ON`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The glucose and heart-rate streams fold in SQL; this file pins the route's
// composition over Prisma mocks, so both readers are mocked at the module.
vi.mock("@/lib/targets/glucose-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/targets/glucose-read")>()),
  readGlucoseTargetSummaries: vi.fn(),
}));
vi.mock("@/lib/analytics/resting-pulse-read", () => ({
  readRestingPulseProxy: vi.fn(),
}));
// The verdict's basis: the dashboard's seven-day means. Empty here, so every
// item is placed with its newest reading, else its own value.
vi.mock("@/lib/analytics/summaries-slice", () => ({
  readSevenDayMeans: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn(), findFirst: vi.fn() },
    moodEntryRollup: { findMany: vi.fn(), findFirst: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// Stub the warm-up so test runs don't fire the real
// `recomputeUserMoodRollups` aggregate. The warm-up is fire-and-forget
// on the route so its return value is irrelevant for parity.
vi.mock("@/lib/rollups/mood-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/mood-rollups")
  >("@/lib/rollups/mood-rollups");
  return {
    ...actual,
    ensureUserMoodRollupsFresh: vi
      .fn()
      .mockResolvedValue({ recomputed: false }),
  };
});

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import {
  foldGlucoseTargetRows,
  readGlucoseTargetSummaries,
} from "@/lib/targets/glucose-read";
import { readRestingPulseProxy } from "@/lib/analytics/resting-pulse-read";

const SESSION_USER = {
  id: "user-targets-1",
  username: "testuser",
  role: "USER" as const,
  timezone: "Europe/Berlin",
  heightCm: 180,
  dateOfBirth: new Date("1985-01-01"),
  locale: "en",
};

const SESSION_OK = {
  session: {
    id: "sess-1",
    expiresAt: new Date(Date.now() + 3_600_000),
    actingAsUserId: null,
    recordEpoch: 0,
  },
  user: SESSION_USER as never,
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/targets");
}

interface TargetsBody {
  data: {
    targets: Array<{
      type: string;
      current: number | null;
      average30: number | null;
      daysInRange7d: number;
      daysLogged7d: number;
      insufficientData: boolean;
    }>;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetAllCachesForTests();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK);
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    heightCm: 180,
    dateOfBirth: new Date("1985-01-01"),
    gender: "MALE",
    glucoseUnit: "mg/dL",
    thresholdsJson: null,
  });
  (prisma.measurement.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
  (prisma.medication.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
  (
    prisma.medicationIntakeEvent.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.moodEntry.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
    null,
  );
  (
    prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // The latest-ever-per-type read (`readLatestEver`).
  (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  vi.mocked(readGlucoseTargetSummaries).mockResolvedValue([]);
  vi.mocked(readRestingPulseProxy).mockResolvedValue([]);
});

describe("GET /api/insights/targets — mood-rollup tier swap", () => {
  it("returns a mood target driven by the rollup DAY tier without touching the raw findMany", async () => {
    // Five DAY-rollup rows over the trailing 30 days. The route reads
    // them directly to drive `MOOD_SCORE.current/average30/consistency`
    // — no raw `moodEntry.findMany` on the fast path.
    const today = new Date();
    const day = (offset: number) => {
      const d = new Date(today);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - offset);
      return d;
    };
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        userId: SESSION_USER.id,
        granularity: "DAY",
        bucketStart: day(0),
        count: 1,
        mean: 4,
        minScore: 4,
        maxScore: 4,
        sd: null,
        computedAt: new Date(),
      },
      {
        userId: SESSION_USER.id,
        granularity: "DAY",
        bucketStart: day(1),
        count: 1,
        mean: 4,
        minScore: 4,
        maxScore: 4,
        sd: null,
        computedAt: new Date(),
      },
      {
        userId: SESSION_USER.id,
        granularity: "DAY",
        bucketStart: day(2),
        count: 1,
        mean: 5,
        minScore: 5,
        maxScore: 5,
        sd: null,
        computedAt: new Date(),
      },
      {
        userId: SESSION_USER.id,
        granularity: "DAY",
        bucketStart: day(3),
        count: 1,
        mean: 4,
        minScore: 4,
        maxScore: 4,
        sd: null,
        computedAt: new Date(),
      },
      {
        userId: SESSION_USER.id,
        granularity: "DAY",
        bucketStart: day(4),
        count: 1,
        mean: 4.5,
        minScore: 4,
        maxScore: 5,
        sd: 0.5,
        computedAt: new Date(),
      },
    ]);
    // Latest score read — one bounded row.
    (prisma.moodEntry.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      score: 4,
      moodLoggedAt: day(0),
    });

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);

    // The unbounded raw `moodEntry.findMany` must not fire on the
    // rollup-tier fast path.
    expect(prisma.moodEntry.findMany).not.toHaveBeenCalled();

    const body = (await res.json()) as TargetsBody;
    const moodTarget = body.data.targets.find((t) => t.type === "MOOD_SCORE");
    expect(moodTarget).toBeDefined();
    expect(moodTarget?.current).toBe(4);
    // Average over 5 daily means: (4+4+5+4+4.5)/5 = 4.3
    expect(moodTarget?.average30).toBeCloseTo(4.3, 1);
  });

  it("falls back to the bounded raw walk when the rollup tier is empty but raw mood entries exist", async () => {
    // Rollup empty → coverage-fallback fires the legacy live walk
    // once. The fallback is bounded by the 30-day window — not the
    // legacy unbounded scan over every mood the user ever wrote.
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);
    const today = new Date();
    (prisma.moodEntry.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      score: 4,
      moodLoggedAt: today,
    });
    (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { score: 4, moodLoggedAt: new Date(today.getTime() - 2 * 86_400_000) },
      { score: 5, moodLoggedAt: new Date(today.getTime() - 1 * 86_400_000) },
      { score: 4, moodLoggedAt: today },
    ]);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);

    // Live fallback fired exactly once. The fallback `findMany` call
    // must carry a 30-day `moodLoggedAt: { gte: ... }` floor — i.e. a
    // `where` clause with a timestamp filter, not the legacy
    // unbounded `where: { userId }` shape.
    expect(prisma.moodEntry.findMany).toHaveBeenCalledTimes(1);
    const fallbackCall = (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(fallbackCall.where).toHaveProperty("moodLoggedAt");
    expect(fallbackCall.where.moodLoggedAt).toHaveProperty("gte");

    const body = (await res.json()) as TargetsBody;
    const moodTarget = body.data.targets.find((t) => t.type === "MOOD_SCORE");
    expect(moodTarget).toBeDefined();
    expect(moodTarget?.current).toBe(4);
  });

  it("emits no mood target when neither rollup nor raw entries exist", async () => {
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);
    (prisma.moodEntry.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as TargetsBody;
    const moodTarget = body.data.targets.find((t) => t.type === "MOOD_SCORE");
    expect(moodTarget).toBeUndefined();
  });

  it("reads latest-ever-per-type one index probe per type, floored at one year", async () => {
    // The read is floored at 365 days. It is the shared `readLatestEver`:
    // driven from the type list, one LIMIT 1 probe
    // per type, so a dense type never sorts a year of raw rows to keep one.
    await callGet(makeReq());

    const rawCalls = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls;
    const latestCall = rawCalls.find(
      (c) =>
        Array.isArray(c[0]) &&
        (c[0] as string[]).join("?").includes("CROSS JOIN LATERAL"),
    );
    expect(latestCall).toBeDefined();
    const [strings, ...values] = latestCall as [string[], ...unknown[]];
    expect(strings.join("?")).not.toContain("DISTINCT ON");
    expect(values).toContain("user-targets-1");
    const floor = values.find(
      (v): v is { values: unknown[] } =>
        typeof v === "object" && v !== null && !Array.isArray(v),
    );
    const flooredAt = floor?.values[0];
    expect(flooredAt).toBeInstanceOf(Date);
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const ageMs = Date.now() - (flooredAt as Date).getTime();
    // Floor is somewhere around one year ago — give a ±1-hour window
    // for clock drift between the route's `Date.now()` and the test
    // assertion.
    expect(ageMs).toBeGreaterThan(oneYearMs - 3_600_000);
    expect(ageMs).toBeLessThan(oneYearMs + 3_600_000);
  });

  it("bounds the glucose read with the same one-year floor (v1.16.8)", async () => {
    // The glucose section used to scan the user's entire BLOOD_GLUCOSE
    // history on every cold build (no `measuredAt` filter at all) just
    // to read the latest value per context. It now folds in SQL, newest
    // per context over a year and per day over thirty days, and no glucose
    // or heart-rate reading is read as a row.
    await callGet(makeReq());

    const calls = (
      prisma.measurement.findMany as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0]);
    expect(
      calls.find((c) => c?.where?.type === "BLOOD_GLUCOSE"),
    ).toBeUndefined();
    expect(
      calls.filter((c) => c?.where?.type?.in?.includes?.("PULSE")),
    ).toEqual([]);
    const [args] = vi.mocked(readGlucoseTargetSummaries).mock.calls[0];
    const day = 86_400_000;
    expect(Date.now() - args.since.getTime()).toBeGreaterThan(364 * day);
    expect(Date.now() - args.since.getTime()).toBeLessThan(366 * day);
    expect(Date.now() - args.recentSince.getTime()).toBeGreaterThan(29 * day);
    expect(Date.now() - args.recentSince.getTime()).toBeLessThan(31 * day);
  });

  it("pins the complete ordered public response for representative populated data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));

    try {
      const atNoon = (day: number) =>
        new Date(`2026-07-${String(day).padStart(2, "0")}T12:00:00.000Z`);
      const genericRows = [
        ...[18, 19, 20, 21].map((day) => ({
          type: "WEIGHT",
          value: 70,
          measuredAt: atNoon(day),
        })),
        ...[18, 19, 20, 21].flatMap((day) => [
          {
            type: "BLOOD_PRESSURE_SYS",
            value: 125,
            measuredAt: atNoon(day),
          },
          {
            type: "BLOOD_PRESSURE_DIA",
            value: 75,
            measuredAt: atNoon(day),
          },
        ]),
        ...[18, 19, 20, 21].map((day) => ({
          type: "RESTING_HEART_RATE",
          value: 60,
          measuredAt: atNoon(day),
        })),
        ...[18, 19, 20, 21].map((day) => ({
          type: "BODY_FAT",
          value: 18,
          measuredAt: atNoon(day),
        })),
        ...[18, 19, 20, 21].map((day) => ({
          type: "ACTIVITY_STEPS",
          value: 10_000,
          measuredAt: atNoon(day),
        })),
      ];
      const sleepRows = [18, 19, 20, 21].map((day) => ({
        value: 480,
        measuredAt: atNoon(day),
        sleepStage: null,
        source: "MANUAL",
        deviceType: null,
      }));
      const glucoseRows = [19, 20, 21].map((day) => ({
        value: 90,
        measuredAt: atNoon(day),
        glucoseContext: "FASTING",
      }));
      (
        prisma.measurement.findMany as ReturnType<typeof vi.fn>
      ).mockImplementation(
        async (args: { where?: { type?: string | { in: string[] } } }) => {
          if (args.where?.type === "SLEEP_DURATION") return sleepRows;
          return genericRows;
        },
      );
      vi.mocked(readGlucoseTargetSummaries).mockImplementation(
        async ({ recentSince, timeZone }) =>
          foldGlucoseTargetRows(
            glucoseRows.map((row) => ({
              ...row,
              glucoseContext: row.glucoseContext as "FASTING",
            })),
            recentSince,
            timeZone,
          ),
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        { type: "WEIGHT", value: 70 },
        { type: "BLOOD_PRESSURE_SYS", value: 125 },
        { type: "BLOOD_PRESSURE_DIA", value: 75 },
        { type: "RESTING_HEART_RATE", value: 60 },
        { type: "BODY_FAT", value: 18 },
        { type: "ACTIVITY_STEPS", value: 10_000 },
      ]);
      (
        prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue(
        [17, 18, 19, 20, 21].map((day) => ({
          userId: SESSION_USER.id,
          granularity: "DAY",
          bucketStart: atNoon(day),
          count: 1,
          mean: 4,
          minScore: 4,
          maxScore: 4,
          sd: null,
          computedAt: atNoon(day),
        })),
      );
      (
        prisma.moodEntry.findFirst as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        score: 4,
        moodLoggedAt: atNoon(21),
      });
      (
        prisma.medication.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          id: "med-1",
          name: "Vitamin D",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          startsOn: null,
          endsOn: null,
          oneShot: false,
          schedules: [],
          scheduleRevisions: [],
          pauseEras: [],
        },
      ]);

      const res = await callGet(makeReq());
      expect(res.status).toBe(200);
      const body = await res.json();

      const fourDaysInRange = {
        daysInRange7d: 4,
        daysLogged7d: 4,
        daysInRange30d: 4,
        daysLogged30d: 4,
        lastMetGoalAt: "2026-07-21",
        streakDays: 4,
        insufficientData: false,
        consistency7d: [null, null, null, "in", "in", "in", "in"],
      };
      const fiveDaysInRange = {
        daysInRange7d: 5,
        daysLogged7d: 5,
        daysInRange30d: 5,
        daysLogged30d: 5,
        lastMetGoalAt: "2026-07-21",
        streakDays: 5,
        insufficientData: false,
        consistency7d: [null, null, "in", "in", "in", "in", "in"],
      };
      expect(body.data).toEqual({
        targets: [
          {
            type: "WEIGHT",
            label: "Weight",
            current: 70,
            average30: 70,
            trend: "stable",
            unit: "kg",
            range: { min: 59.9, max: 80.7 },
            classification: {
              category: "Normal",
              color: "var(--success)",
            },
            source: "WHO BMI",
            direction: {
              direction: "up-bad",
              targetPosition: null,
              basis: "metric_default",
            },
            trendSentiment: "neutral",
            ...fourDaysInRange,
          },
          {
            type: "BLOOD_PRESSURE",
            label: "Blood pressure",
            current: 125,
            average30: 125,
            trend: "stable",
            unit: "mmHg",
            range: { min: 120, max: 129 },
            classification: {
              category: "Normal",
              color: "var(--info)",
            },
            source: "ESH 2023",
            direction: {
              direction: "hold",
              targetPosition: "inside",
              basis: "profile_default",
            },
            trendSentiment: "positive",
            ...fourDaysInRange,
          },
          {
            type: "BLOOD_PRESSURE_IN_TARGET",
            label: "Blood pressure on target",
            current: 100,
            average30: 100,
            trend: null,
            unit: "%",
            range: { min: 70, max: 100 },
            classification: {
              category: "Good",
              color: "var(--success)",
            },
            source: "ESH 2023",
            direction: {
              direction: "up-good",
              targetPosition: null,
              basis: "metric_default",
            },
            trendSentiment: "neutral",
            ...fourDaysInRange,
          },
          {
            type: "PULSE",
            label: "Resting pulse",
            current: 60,
            average30: 60,
            trend: "stable",
            unit: "bpm",
            range: { min: 61, max: 77 },
            classification: {
              category: "Slightly low",
              color: "var(--warning)",
            },
            source: "CDC/NCHS",
            // Below a default band nobody chose, a resting pulse holds: its
            // lower edge is a convention, not a goal to climb back to, so a
            // steady reading is the good news and no move is a setback.
            direction: {
              direction: "hold",
              targetPosition: "below",
              basis: "profile_default",
            },
            trendSentiment: "positive",
            daysInRange7d: 0,
            daysLogged7d: 4,
            daysInRange30d: 0,
            daysLogged30d: 4,
            lastMetGoalAt: null,
            streakDays: 0,
            insufficientData: false,
            consistency7d: [null, null, null, "near", "near", "near", "near"],
          },
          {
            type: "SLEEP_DURATION",
            label: "Sleep duration",
            current: 8,
            average30: 8,
            trend: "stable",
            unit: "h",
            range: { min: 7, max: 9 },
            classification: {
              category: "On target",
              color: "var(--success)",
            },
            source: "AASM/SRS",
            direction: {
              direction: "up-good",
              targetPosition: null,
              basis: "metric_default",
            },
            trendSentiment: "neutral",
            ...fourDaysInRange,
          },
          {
            type: "BMI",
            label: "BMI",
            current: 21.6,
            average30: 21.6,
            trend: "stable",
            unit: "kg/m²",
            range: { min: 18.5, max: 24.9 },
            classification: {
              category: "Normal",
              color: "var(--success)",
            },
            source: "WHO",
            direction: {
              direction: "up-bad",
              targetPosition: null,
              basis: "metric_default",
            },
            trendSentiment: "neutral",
            ...fourDaysInRange,
          },
          {
            type: "BODY_FAT",
            label: "Body fat",
            current: 18,
            average30: 18,
            trend: "stable",
            unit: "%",
            range: { min: 14, max: 24 },
            classification: {
              category: "Acceptable",
              color: "var(--warning)",
            },
            source: "ACE",
            direction: {
              direction: "hold",
              targetPosition: "inside",
              basis: "profile_default",
            },
            trendSentiment: "positive",
            ...fourDaysInRange,
          },
          {
            type: "ACTIVITY_STEPS",
            label: "Steps/day",
            current: 10_000,
            average30: 10_000,
            trend: "stable",
            unit: "steps",
            range: { min: 8_000, max: 15_000 },
            classification: {
              category: "Very active",
              color: "var(--success)",
            },
            source: "Saint-Maurice JAMA 2020",
            direction: {
              direction: "up-good",
              targetPosition: null,
              basis: "metric_default",
            },
            trendSentiment: "neutral",
            ...fourDaysInRange,
          },
          {
            type: "MEDICATION_COMPLIANCE",
            label: "Medication compliance",
            current: null,
            average30: null,
            trend: null,
            unit: "%",
            range: { min: 90, max: 100 },
            classification: null,
            source: "7-day",
            direction: {
              direction: "up-good",
              targetPosition: null,
              basis: "metric_default",
            },
            trendSentiment: "neutral",
            details: {
              medications: [
                {
                  name: "Vitamin D",
                  compliance7: 100,
                  compliance30: 100,
                },
              ],
            },
            daysInRange7d: 0,
            daysLogged7d: 0,
            daysInRange30d: 0,
            daysLogged30d: 0,
            lastMetGoalAt: null,
            streakDays: 0,
            insufficientData: true,
            consistency7d: [null, null, null, null, null, null, null],
          },
          {
            type: "MOOD_SCORE",
            label: "Mood",
            current: 4,
            average30: 4,
            trend: "stable",
            unit: "/ 5",
            range: { min: 3.5, max: 5 },
            classification: {
              category: "Good",
              color: "var(--success)",
            },
            source: "Mood entries",
            direction: {
              direction: "up-good",
              targetPosition: null,
              basis: "metric_default",
            },
            trendSentiment: "neutral",
            ...fiveDaysInRange,
          },
          {
            type: "MOOD_STABILITY",
            label: "Mood stability",
            current: 0,
            average30: 0,
            trend: null,
            unit: "σ",
            range: { min: 0, max: 0.5 },
            classification: {
              category: "Very stable",
              color: "var(--success)",
            },
            source: "Mood entries",
            direction: {
              direction: "neutral",
              targetPosition: null,
              basis: "metric_default",
            },
            trendSentiment: "neutral",
            ...fiveDaysInRange,
          },
          {
            type: "BLOOD_GLUCOSE_FASTING",
            label: "targets.glucoseFasting",
            current: 90,
            average30: 90,
            trend: null,
            unit: "mg/dL",
            range: { min: 70, max: 99 },
            classification: {
              category: "Optimal",
              color: "var(--success)",
            },
            source: "ADA 2024 / DDG",
            direction: {
              direction: "neutral",
              targetPosition: null,
              basis: "metric_default",
            },
            trendSentiment: "neutral",
            daysInRange7d: 3,
            daysLogged7d: 3,
            daysInRange30d: 3,
            daysLogged30d: 3,
            lastMetGoalAt: "2026-07-21",
            streakDays: 3,
            insufficientData: false,
            consistency7d: [null, null, null, null, "in", "in", "in"],
          },
        ],
        pageSummary: {
          targetsMetThisWeek: 9,
          totalTargets: 12,
          streakHighlight: { metric: "MOOD_SCORE", days: 5 },
        },
        bpDiastolic: {
          current: 75,
          average30: 75,
          range: { min: 70, max: 79 },
        },
        profile: {
          heightCm: 180,
          age: 41,
          gender: "MALE",
          glucoseUnit: "mg/dL",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves a warm repeat from the server cache without re-querying (v1.16.8)", async () => {
    const first = await callGet(makeReq());
    expect(first.status).toBe(200);
    const queriesAfterFirst = (
      prisma.measurement.findMany as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    expect(queriesAfterFirst).toBeGreaterThan(0);

    const second = await callGet(makeReq());
    expect(second.status).toBe(200);
    // Same user, warm cell — the SWR read serves the cached body and
    // issues no further measurement queries inside the fresh TTL.
    expect(
      (prisma.measurement.findMany as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(queriesAfterFirst);
  });
});
