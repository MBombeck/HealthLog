/**
 * v1.10.0 — computed scores (WX-E). Strain-score engine + persistence.
 *
 * The Strain score is a Banister-TRIMP cardio-load proxy from the
 * per-workout HR series + active energy. These tests pin:
 *   - the Banister gender-weighted exponential TRIMP math,
 *   - the saturating 0–100 map,
 *   - the TRIMP path + the active-energy fallback,
 *   - the per-day idempotency key + insufficient-data gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The post-mutation tail reads the real `@/lib/db` client, not the fake this
 * file injects, so a stored score opened a socket to a Postgres the unit job
 * does not run. The attempt failed a few hundred milliseconds later and logged
 * on the way out — after the test that started it had ended — which is how a
 * green file tore its worker's RPC channel down mid-write. Stubbed here;
 * `score-row.test.ts` asserts the wiring this stands for.
 */
vi.mock("@/lib/rollups/after-measurement-mutation", () => ({
  afterMeasurementMutation: vi.fn(async () => {}),
}));

import {
  strainDayKey,
  strainExternalId,
  strainMeasuredAt,
  tanakaHrMax,
  banisterTrimp,
  saturateToScore,
  percentile,
  resolvePersonalReference,
  persistStrainScore,
  STRAIN_SCORE_EXTERNAL_ID_PREFIX,
  STRAIN_TRIMP_REFERENCE,
  STRAIN_MIN_TRAINING_DAYS,
  STRAIN_PERSONAL_REF_FLOOR,
  STRAIN_PERSONAL_REF_PERCENTILE,
  STRAIN_EWMA_ALPHA,
} from "../strain-score";

const NOW = new Date("2026-06-02T08:30:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("strain-score helpers", () => {
  it("scores the PREVIOUS UTC day (cron fires in the small hours)", () => {
    // NOW is 2026-06-02 → the scored day is the just-completed 2026-06-01,
    // whose workouts + active-energy total are settled.
    expect(strainDayKey(NOW)).toBe("2026-06-01");
    expect(strainExternalId(NOW)).toBe(
      `${STRAIN_SCORE_EXTERNAL_ID_PREFIX}2026-06-01`,
    );
  });

  it("anchors the canonical timestamp at noon UTC on the scored (previous) day", () => {
    expect(strainMeasuredAt(NOW).toISOString()).toBe(
      "2026-06-01T12:00:00.000Z",
    );
  });

  it("uses the Tanaka HRmax formula", () => {
    expect(tanakaHrMax(40)).toBeCloseTo(208 - 0.7 * 40, 6); // 180
  });
});

describe("banisterTrimp", () => {
  const hrRest = 50;
  const hrMax = 190;
  const sex = "MALE" as const;

  it("returns 0 for a series with fewer than two usable HR samples", () => {
    expect(
      banisterTrimp([{ t: NOW.toISOString(), hr: 150 }], hrRest, hrMax, sex),
    ).toBe(0);
  });

  it("scores an unanswered or OTHER sex on the midpoint of both models, not on the male one", () => {
    // The published Banister weights cover two groups. Defaulting the rest
    // to the male pair scored people on an assumption they never made; the
    // neutral answer is the mean of the two models, matching every other
    // sex-split formula in the repo.
    const samples = [
      { t: "2026-06-02T08:00:00.000Z", hr: 150 },
      { t: "2026-06-02T09:00:00.000Z", hr: 150 },
    ];
    const male = banisterTrimp(samples, hrRest, hrMax, "MALE");
    const female = banisterTrimp(samples, hrRest, hrMax, "FEMALE");
    const other = banisterTrimp(samples, hrRest, hrMax, "OTHER");
    const unanswered = banisterTrimp(samples, hrRest, hrMax, null);
    expect(male).not.toBeCloseTo(female, 6);
    expect(other).toBeCloseTo((male + female) / 2, 10);
    expect(unanswered).toBeCloseTo(other, 10);
    expect(other).not.toBeCloseTo(male, 6);
  });

  it("accumulates a positive TRIMP for a sustained elevated series", () => {
    const samples = [
      { t: "2026-06-02T08:00:00.000Z", hr: 150 },
      { t: "2026-06-02T08:30:00.000Z", hr: 150 },
      { t: "2026-06-02T09:00:00.000Z", hr: 150 },
    ];
    const trimp = banisterTrimp(samples, hrRest, hrMax, sex);
    expect(trimp).toBeGreaterThan(0);
  });

  it("scores a harder hour above an easier hour", () => {
    const easy = [
      { t: "2026-06-02T08:00:00.000Z", hr: 100 },
      { t: "2026-06-02T09:00:00.000Z", hr: 100 },
    ];
    const hard = [
      { t: "2026-06-02T08:00:00.000Z", hr: 170 },
      { t: "2026-06-02T09:00:00.000Z", hr: 170 },
    ];
    expect(banisterTrimp(hard, hrRest, hrMax, sex)).toBeGreaterThan(
      banisterTrimp(easy, hrRest, hrMax, sex),
    );
  });

  it("ignores samples below resting HR (no negative impulse)", () => {
    const below = [
      { t: "2026-06-02T08:00:00.000Z", hr: 45 },
      { t: "2026-06-02T09:00:00.000Z", hr: 45 },
    ];
    expect(banisterTrimp(below, hrRest, hrMax, sex)).toBe(0);
  });

  it("returns 0 when HRmax <= HRrest (degenerate profile)", () => {
    const samples = [
      { t: "2026-06-02T08:00:00.000Z", hr: 100 },
      { t: "2026-06-02T09:00:00.000Z", hr: 100 },
    ];
    expect(banisterTrimp(samples, 190, 190, sex)).toBe(0);
  });
});

describe("saturateToScore", () => {
  it("is 0 at zero load and rises monotonically toward 100", () => {
    expect(saturateToScore(0, 150)).toBe(0);
    const a = saturateToScore(50, 150);
    const b = saturateToScore(150, 150);
    const c = saturateToScore(600, 150);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThanOrEqual(100);
  });
});

function makePrisma(opts: {
  energy?: number[];
  workouts?: Array<{ id: string; samples: { samples: unknown } | null }>;
  rhr?: number | null;
  gender?: string;
  dateOfBirth?: Date | null;
  /** Cached training-day TRIMP history rows (newest day first). */
  cacheRows?: Array<{
    day: string;
    dayTrimp: number;
    refPersonal: number;
    trainingDays?: number;
  }>;
}) {
  const energyRows = (opts.energy ?? []).map((value, i) => ({
    value,
    id: `e${i}`,
  }));
  const measurementFindMany = vi.fn().mockResolvedValue(energyRows);
  const measurementFindFirst = vi
    .fn()
    .mockResolvedValue(opts.rhr == null ? null : { value: opts.rhr });
  const workoutFindMany = vi.fn().mockResolvedValue(opts.workouts ?? []);
  const upsert = vi.fn().mockResolvedValue({});
  const findUnique = vi.fn().mockResolvedValue({
    dateOfBirth:
      "dateOfBirth" in opts
        ? opts.dateOfBirth
        : new Date("1986-01-01T00:00:00Z"),
    gender: opts.gender ?? "MALE",
  });
  const cacheFindMany = vi.fn().mockResolvedValue(
    (opts.cacheRows ?? []).map((r) => ({
      // A cached row with TRIMP > 0 was a training day; default its window
      // training-day count to 1 so it reads as a warmed EWMA unless overridden.
      trainingDays: r.dayTrimp > 0 ? 1 : 0,
      ...r,
    })),
  );
  const cacheUpsert = vi.fn().mockResolvedValue({});
  return {
    prisma: {
      measurement: {
        findMany: measurementFindMany,
        findFirst: measurementFindFirst,
        upsert,
      },
      workout: { findMany: workoutFindMany },
      user: { findUnique },
      strainTrimpCache: { findMany: cacheFindMany, upsert: cacheUpsert },
    } as unknown as Parameters<typeof persistStrainScore>[0],
    upsert,
    cacheFindMany,
    cacheUpsert,
  };
}

describe("persistStrainScore", () => {
  it("stores a COMPUTED STRAIN_SCORE row via the TRIMP path", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      workouts: [
        {
          id: "w1",
          samples: {
            samples: [
              { t: "2026-06-02T08:00:00.000Z", hr: 150 },
              { t: "2026-06-02T08:30:00.000Z", hr: 155 },
              { t: "2026-06-02T09:00:00.000Z", hr: 150 },
            ],
          },
        },
      ],
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("stored");
    expect(result.reason).toBe("trimp");
    expect(result.score).toBeGreaterThan(0);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where.userId_type_source_externalId).toEqual({
      userId: "user-1",
      type: "STRAIN_SCORE",
      source: "COMPUTED",
      externalId: "strain:2026-06-01",
    });
    expect(arg.create).toMatchObject({
      type: "STRAIN_SCORE",
      source: "COMPUTED",
      unit: "score",
    });
  });

  it("falls back to the active-energy proxy when no HR series is usable", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      energy: [300, 250],
      workouts: [], // no workouts → no TRIMP
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("stored");
    expect(result.reason).toBe("active_energy_fallback");
    expect(result.score).toBeGreaterThan(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("gates when there is a workout but the profile yields no HRmax", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      dateOfBirth: null, // no age → no Tanaka HRmax
      workouts: [
        {
          id: "w1",
          samples: {
            samples: [
              { t: "2026-06-02T08:00:00.000Z", hr: 150 },
              { t: "2026-06-02T09:00:00.000Z", hr: 150 },
            ],
          },
        },
      ],
      energy: [], // no active-energy fallback either
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("insufficient");
    expect(result.reason).toBe("insufficient_profile");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("writes NOTHING when there is no usable input at all", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      workouts: [],
      energy: [],
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("insufficient");
    expect(result.reason).toBe("insufficient_inputs");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is idempotent per user per day — re-runs upsert the same key", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      energy: [400],
    });

    await persistStrainScore(prisma, "user-1", NOW);
    await persistStrainScore(prisma, "user-1", NOW);

    expect(upsert).toHaveBeenCalledTimes(2);
    const firstKey =
      upsert.mock.calls[0][0].where.userId_type_source_externalId;
    const secondKey =
      upsert.mock.calls[1][0].where.userId_type_source_externalId;
    expect(secondKey).toEqual(firstKey);
  });
});

// ─── v1.10.3 personal-relative anchor ─────────────────────────

describe("percentile", () => {
  it("returns 0 for an empty sample and the single value for one", () => {
    expect(percentile([], 75)).toBe(0);
    expect(percentile([42], 75)).toBe(42);
  });

  it("interpolates between order statistics", () => {
    // P50 of {10,20,30,40} → rank 1.5 → 20 + 0.5·(30−20) = 25.
    expect(percentile([40, 10, 30, 20], 50)).toBeCloseTo(25, 6);
    // P75 of {10,20,30,40} → rank 2.25 → 30 + 0.25·(40−30) = 32.5.
    expect(percentile([10, 20, 30, 40], 75)).toBeCloseTo(32.5, 6);
  });
});

describe("resolvePersonalReference", () => {
  it("falls back to the population anchor below the cold-start floor", () => {
    // Only a handful of training days — under STRAIN_MIN_TRAINING_DAYS.
    const trimps = Array.from(
      { length: STRAIN_MIN_TRAINING_DAYS - 1 },
      () => 25,
    );
    const r = resolvePersonalReference({
      trainingDayTrimps: trimps,
      priorRefPersonal: null,
    });
    expect(r.anchor).toBe("population");
    expect(r.reference).toBe(STRAIN_TRIMP_REFERENCE);
    expect(r.trainingDays).toBe(STRAIN_MIN_TRAINING_DAYS - 1);
    // The EWMA still warms up so it is ready the night the user qualifies.
    expect(r.refPersonalToPersist).not.toBeNull();
  });

  it("uses the personal P75 anchor once the floor is met (seed run)", () => {
    // Eight identical-ish training days at ~25 TRIMP — a deconditioned user.
    const trimps = [20, 22, 24, 25, 25, 26, 28, 30];
    const r = resolvePersonalReference({
      trainingDayTrimps: trimps,
      priorRefPersonal: null,
    });
    expect(r.anchor).toBe("personal");
    expect(r.trainingDays).toBe(8);
    // Seed run (no prior EWMA) → reference is the window P75 of the trimps.
    const expectedP75 = percentile(trimps, STRAIN_PERSONAL_REF_PERCENTILE);
    expect(r.reference).toBeCloseTo(expectedP75, 6);
    // The deconditioned user's hard day (~30) now scores meaningfully high
    // instead of being pinned near 0 against the population 150.
    expect(saturateToScore(30, r.reference)).toBeGreaterThan(60);
    expect(saturateToScore(30, STRAIN_TRIMP_REFERENCE)).toBeLessThan(25);
  });

  it("EWMA-blends this window's P75 with the prior reference", () => {
    const trimps = [40, 45, 50, 55, 60, 65, 70, 80];
    const prior = 100;
    const r = resolvePersonalReference({
      trainingDayTrimps: trimps,
      priorRefPersonal: prior,
    });
    const windowP75 = percentile(trimps, STRAIN_PERSONAL_REF_PERCENTILE);
    const expected =
      STRAIN_EWMA_ALPHA * windowP75 + (1 - STRAIN_EWMA_ALPHA) * prior;
    expect(r.reference).toBeCloseTo(expected, 6);
    // Smoothing keeps the reference between the prior and the window value.
    expect(r.reference).toBeLessThan(prior);
    expect(r.reference).toBeGreaterThan(windowP75);
  });

  it("floors the personal reference so trivial days do not all score 100", () => {
    // All training days are very light — P75 would sit below the floor.
    const trimps = [2, 3, 3, 4, 4, 5, 5, 6];
    const r = resolvePersonalReference({
      trainingDayTrimps: trimps,
      priorRefPersonal: null,
    });
    expect(r.anchor).toBe("personal");
    expect(r.reference).toBe(STRAIN_PERSONAL_REF_FLOOR);
  });

  it("ignores rest-day zeros — distribution is training-days only", () => {
    // Zeros must never enter the percentile (they would crush the anchor).
    const withZeros = [0, 0, 0, 20, 22, 24, 25, 26, 28, 30];
    const r = resolvePersonalReference({
      trainingDayTrimps: withZeros,
      priorRefPersonal: null,
    });
    expect(r.trainingDays).toBe(7); // only the seven > 0 days count
    expect(r.reference).toBeCloseTo(
      percentile([20, 22, 24, 25, 26, 28, 30], STRAIN_PERSONAL_REF_PERCENTILE),
      6,
    );
  });
});

describe("persistStrainScore — personal anchor + cache", () => {
  const hardSeries = {
    samples: [
      { t: "2026-06-01T08:00:00.000Z", hr: 150 },
      { t: "2026-06-01T08:30:00.000Z", hr: 155 },
      { t: "2026-06-01T09:00:00.000Z", hr: 150 },
    ],
  };

  it("cold start (empty cache) scores against the population anchor + writes the cache row", async () => {
    const { prisma, cacheUpsert } = makePrisma({
      rhr: 50,
      workouts: [{ id: "w1", samples: hardSeries }],
      cacheRows: [], // no personal history yet
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("stored");
    expect(result.anchor).toBe("population");
    // The cache row is always written so the distribution fills forward.
    expect(cacheUpsert).toHaveBeenCalledTimes(1);
    const cacheArg = cacheUpsert.mock.calls[0][0];
    expect(cacheArg.where.userId_day).toEqual({
      userId: "user-1",
      day: "2026-06-01",
    });
    expect(cacheArg.create.dayTrimp).toBeGreaterThan(0);
    expect(cacheArg.create.anchor).toBe("population");
  });

  it("uses the personal anchor once the cache holds enough training days", async () => {
    // Seven prior training days of light load (~25 TRIMP) → with today's
    // session that is ≥ the cold-start floor, so the personal anchor fires.
    const cacheRows = Array.from({ length: 7 }, (_, i) => ({
      day: `2026-05-${String(25 - i).padStart(2, "0")}`,
      dayTrimp: 25,
      refPersonal: 25,
    }));
    const { prisma, cacheUpsert } = makePrisma({
      rhr: 50,
      workouts: [{ id: "w1", samples: hardSeries }],
      cacheRows,
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("stored");
    expect(result.anchor).toBe("personal");
    const cacheArg = cacheUpsert.mock.calls[0][0];
    expect(cacheArg.create.anchor).toBe("personal");
    // refPersonal is the EWMA-blended personal reference, not the population 150.
    expect(cacheArg.create.refPersonal).toBeLessThan(STRAIN_TRIMP_REFERENCE);
  });

  it("self-heals with no backfill — a re-run reads the prior EWMA, not its own write", async () => {
    // A prior cache row strictly before the scored day carries the prior EWMA.
    const cacheRows = [
      { day: "2026-05-31", dayTrimp: 40, refPersonal: 60 },
      ...Array.from({ length: 7 }, (_, i) => ({
        day: `2026-05-${String(24 - i).padStart(2, "0")}`,
        dayTrimp: 40,
        refPersonal: 60,
      })),
    ];
    const { prisma, cacheFindMany, cacheUpsert } = makePrisma({
      rhr: 50,
      workouts: [{ id: "w1", samples: hardSeries }],
      cacheRows,
    });

    await persistStrainScore(prisma, "user-1", NOW);

    // The history read excludes the scored day itself (lt: dayKey) so a
    // re-run never blends against its own write — the nightly idempotent
    // recompute converges instead of compounding.
    const findArg = cacheFindMany.mock.calls[0][0];
    expect(findArg.where.day.lt).toBe("2026-06-01");
    expect(cacheUpsert).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a pure energy-only seed row as the EWMA prior", async () => {
    // Seven prior training days (warm the personal anchor) plus an
    // energy-only placeholder row (trainingDays: 0, refPersonal: population)
    // that must NOT be blended in as the prior — it would stall activation.
    const cacheRows = [
      // newest is the energy-only placeholder.
      { day: "2026-05-31", dayTrimp: 0, refPersonal: STRAIN_TRIMP_REFERENCE },
      ...Array.from({ length: 7 }, (_, i) => ({
        day: `2026-05-${String(24 - i).padStart(2, "0")}`,
        dayTrimp: 25,
        refPersonal: 25,
      })),
    ];
    const { prisma, cacheUpsert } = makePrisma({
      rhr: 50,
      workouts: [{ id: "w1", samples: hardSeries }],
      cacheRows,
    });

    await persistStrainScore(prisma, "user-1", NOW);

    const cacheArg = cacheUpsert.mock.calls[0][0];
    expect(cacheArg.create.anchor).toBe("personal");
    // The blended reference rides the warmed ~25-TRIMP prior, NOT the
    // population 150 carried by the energy-only placeholder row.
    expect(cacheArg.create.refPersonal).toBeLessThan(80);
  });
});
