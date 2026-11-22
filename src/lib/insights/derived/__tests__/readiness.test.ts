import { describe, it, expect, vi, beforeEach } from "vitest";

// Day-mean reads fold per-day aggregates in SQL; the fake folds the mocked
// `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

// Dense reads fold in SQL; the fake folds the rows the mocked `findMany` serves.
vi.mock("@/lib/measurements/dense-bucket-read", async () => {
  const { makeFakeDenseBucketRead } =
    await import("@/lib/measurements/__tests__/fake-dense-bucket-read");
  const { prisma } = await import("@/lib/db");
  return makeFakeDenseBucketRead((args) =>
    (prisma.measurement.findMany as (a: unknown) => never)(args),
  );
});
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    // The folded Sleep Score now reads the user's source priority for the
    // canonical writer-dedup ladder; default to no override.
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn().mockResolvedValue("UTC"),
}));

import { prisma } from "@/lib/db";
import {
  computeReadiness,
  blendReadinessComponents,
  scoreDeviation,
  READINESS_MIN_COMPONENTS,
  type ReadinessComponentKey,
} from "../readiness";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T08:00:00Z");
const measurementFindMany = prisma.measurement.findMany as ReturnType<
  typeof vi.fn
>;
const moodFindMany = prisma.moodEntry.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  measurementFindMany.mockResolvedValue([]);
  moodFindMany.mockResolvedValue([]);
});

describe("scoreDeviation", () => {
  it("scores 100 on or in the good direction (lower-better)", () => {
    expect(scoreDeviation(50, 60, 5, "lower-better")).toBe(100);
    expect(scoreDeviation(60, 60, 5, "lower-better")).toBe(100);
  });

  it("suppresses the score one spread worse (lower-better RHR elevated)", () => {
    expect(scoreDeviation(65, 60, 5, "lower-better")).toBe(50);
    expect(scoreDeviation(70, 60, 5, "lower-better")).toBe(0);
  });

  it("suppresses on an HRV drop (higher-better)", () => {
    expect(scoreDeviation(55, 60, 5, "higher-better")).toBe(50);
    expect(scoreDeviation(65, 60, 5, "higher-better")).toBe(100);
  });

  it("degrades gracefully when the spread is zero", () => {
    expect(scoreDeviation(61, 60, 0, "lower-better")).toBe(50);
    expect(scoreDeviation(59, 60, 0, "lower-better")).toBe(100);
  });
});

describe("blendReadinessComponents reweighting", () => {
  it("renormalises over present components and drops missing ones", () => {
    const raw: Record<ReadinessComponentKey, number | null> = {
      rhr: 80,
      hrv: 70,
      sleep: null,
      respiratory: null,
      mood: 60,
    };
    const { score, components } = blendReadinessComponents(raw);
    const sleep = components.find((c) => c.key === "sleep")!;
    expect(sleep.weight).toBe(0);
    const presentSum = components
      .filter((c) => c.value !== null)
      .reduce((s, c) => s + c.weight, 0);
    expect(presentSum).toBeCloseTo(1, 5);
    expect(score).toBeGreaterThan(0);
  });
});

describe("computeReadiness gating", () => {
  it("returns insufficient below the minimum-components floor (no 1-of-N headline)", async () => {
    // No data at all → 0 components present.
    const result = await computeReadiness("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("insufficient_components");
      expect(result.coverage.presentInputs).toBeLessThan(
        READINESS_MIN_COMPONENTS,
      );
    }
  });

  it("produces a headline once ≥ 2 deviation components are present", async () => {
    // RHR + HRV baselines: ≥ 7 distinct days each, plus a latest reading.
    const days = (type: string, base: number) =>
      Array.from({ length: 10 }, (_, i) => ({
        value: base,
        // 10 distinct days within May (15..24) — all valid calendar days.
        measuredAt: new Date(
          `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
        ),
        type,
      }));
    measurementFindMany.mockImplementation(
      async (args: { where: { type: string } }) => {
        const type = args.where.type;
        if (type === "RESTING_HEART_RATE") return days(type, 58);
        if (type === "HEART_RATE_VARIABILITY") return days(type, 65);
        return [];
      },
    );
    const result = await computeReadiness("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const present = result.value.components.filter((c) => c.value !== null);
      expect(present.length).toBeGreaterThanOrEqual(READINESS_MIN_COMPONENTS);
      expect(result.value.score).toBeGreaterThanOrEqual(0);
      expect(result.value.score).toBeLessThanOrEqual(100);
    }
  });

  it("renormalises over the other components for an account whose only HRV is RMSSD", async () => {
    // Fitbit and Google Health file nightly HRV as `HRV_RMSSD` (migration
    // 0420). Readiness stays on SDNN by design, so such an account has no
    // HRV component: it must drop out with weight 0 and the rest carry the
    // score, never an error and never an RMSSD value read as SDNN.
    const days = (type: string, base: number) =>
      Array.from({ length: 10 }, (_, i) => ({
        value: base,
        measuredAt: new Date(
          `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
        ),
        type,
      }));
    measurementFindMany.mockImplementation(
      async (args: { where: { type: unknown } }) => {
        const type = args.where.type;
        if (type === "RESTING_HEART_RATE") return days(type, 58);
        if (type === "RESPIRATORY_RATE") return days(type, 14);
        if (type === "HRV_RMSSD") return days(type, 42);
        return [];
      },
    );
    const result = await computeReadiness("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const hrv = result.value.components.find((c) => c.key === "hrv");
    expect(hrv).toMatchObject({ value: null, weight: 0 });
    const present = result.value.components.filter((c) => c.value !== null);
    expect(present.map((c) => c.key).sort()).toEqual(["respiratory", "rhr"]);
    const total = present.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(Number.isFinite(result.value.score)).toBe(true);
  });

  it("reports confidence reflecting REAL history depth, not the constant window", async () => {
    // 10 distinct backing days on a 30-day window. Pre-fix `historyDays` was
    // pinned to `windowDays` so `historyFraction` was always 1 and confidence
    // hit the ceiling; post-fix it reflects the 10/30 depth and lands below a
    // full-history blend.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const days = (type: string, base: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        value: base,
        // i+1 days before NOW so each row lands on a distinct prior UTC day
        // inside the 30-day window (valid calendar dates across the month).
        measuredAt: new Date(NOW.getTime() - (i + 1) * DAY_MS),
        type,
      }));
    measurementFindMany.mockImplementation(
      async (args: { where: { type: string } }) => {
        const type = args.where.type;
        if (type === "RESTING_HEART_RATE") return days(type, 58, 10);
        if (type === "HEART_RATE_VARIABILITY") return days(type, 65, 10);
        return [];
      },
    );
    const shallow = await computeReadiness("u1", PROFILE, {
      now: NOW,
      windowDays: 30,
    });

    measurementFindMany.mockImplementation(
      async (args: { where: { type: string } }) => {
        const type = args.where.type;
        if (type === "RESTING_HEART_RATE") return days(type, 58, 30);
        if (type === "HEART_RATE_VARIABILITY") return days(type, 65, 30);
        return [];
      },
    );
    const deep = await computeReadiness("u1", PROFILE, {
      now: NOW,
      windowDays: 30,
    });

    expect(shallow.status).toBe("ok");
    expect(deep.status).toBe("ok");
    if (shallow.status === "ok" && deep.status === "ok") {
      expect(shallow.coverage.historyDays).toBe(10);
      expect(deep.coverage.historyDays).toBe(30);
      // A 10-day blend must report lower confidence than a 30-day one.
      expect(shallow.confidence.score).toBeLessThan(deep.confidence.score);
    }
  });

  it("emits null (not 0) for a vital with readings below the baseline floor (iOS F2)", async () => {
    // The user HAS recorded RHR + HRV + respiratory, but only on 2 distinct
    // days each — below the baseline-band history floor. The contributor must
    // be NULL (dropped → iOS hides it), never 0 (which would read as a real
    // worst-case sub-score). Mood + sleep carry the headline so the blend
    // still reaches the minimum-components floor.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const sparse = (type: string, base: number) =>
      Array.from({ length: 2 }, (_, i) => ({
        value: base,
        measuredAt: new Date(NOW.getTime() - (i + 1) * DAY_MS),
        type,
      }));
    moodFindMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        score: 4,
        moodLoggedAt: new Date(
          `2026-05-${String(20 + i).padStart(2, "0")}T20:00:00Z`,
        ),
      })),
    );
    measurementFindMany.mockImplementation(
      async (args: { where: { type: string } }) => {
        const type = args.where.type;
        if (type === "RESTING_HEART_RATE") return sparse(type, 58);
        if (type === "HEART_RATE_VARIABILITY") return sparse(type, 65);
        if (type === "RESPIRATORY_RATE") return sparse(type, 14);
        if (type === "SLEEP_DURATION") {
          return [
            {
              value: 420,
              measuredAt: new Date("2026-05-31T06:00:00Z"),
              sleepStage: "ASLEEP",
            },
            {
              value: 430,
              measuredAt: new Date("2026-06-01T06:10:00Z"),
              sleepStage: "ASLEEP",
            },
            {
              value: 410,
              measuredAt: new Date("2026-06-02T06:05:00Z"),
              sleepStage: "ASLEEP",
            },
          ];
        }
        return [];
      },
    );
    const result = await computeReadiness("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      for (const key of ["rhr", "hrv", "respiratory"] as const) {
        const c = result.value.components.find((x) => x.key === key)!;
        expect(c.value).toBeNull();
        expect(c.value).not.toBe(0);
      }
    }
  });

  it("provenance source is 'live' for a blend backed only by sleep + mood", async () => {
    // No vital readings (RHR/HRV/resp all gate). Mood entries present + a
    // scorable sleep night → the two present components are both live reads,
    // so the source chip must read 'live', never DAY.
    moodFindMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        score: 4,
        moodLoggedAt: new Date(
          `2026-05-${String(20 + i).padStart(2, "0")}T20:00:00Z`,
        ),
      })),
    );
    measurementFindMany.mockImplementation(
      async (args: { where: { type: string } }) => {
        const type = args.where.type;
        if (type === "SLEEP_DURATION") {
          // Three scorable nights so the sleep score lights up.
          return [
            {
              value: 420,
              measuredAt: new Date("2026-05-31T06:00:00Z"),
              sleepStage: "ASLEEP",
            },
            {
              value: 430,
              measuredAt: new Date("2026-06-01T06:10:00Z"),
              sleepStage: "ASLEEP",
            },
            {
              value: 410,
              measuredAt: new Date("2026-06-02T06:05:00Z"),
              sleepStage: "ASLEEP",
            },
          ];
        }
        return [];
      },
    );
    const result = await computeReadiness("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const present = result.value.components.filter((c) => c.value !== null);
      const keys = present.map((c) => c.key).sort();
      expect(keys).toEqual(["mood", "sleep"]);
      expect(result.provenance.source).toBe("live");
    }
  });
});
