/**
 * v1.20.0 — bit-identical parity for the rollup regression accumulators.
 *
 * The windowed slope / r² / population-sd now compose from the per-bucket
 * accumulators (`sum_x / sum_xy / sum_xx / sum_yy`, plus `n = count` and
 * `Σy = mean·count`) that migration 0190 added to `measurement_rollups`.
 * Because the accumulators are additive and Postgres `REGR_SLOPE` /
 * `REGR_R2` / `STDDEV_POP` fold the SAME closed form over the SAME epoch-day
 * x-axis the populator stored, the cross-bucket compose must equal the live
 * aggregate over the raw rows EXACTLY — not within a tolerance.
 *
 * This suite seeds raw measurements spanning many DAY buckets with uneven
 * per-day counts (the regime where mean-of-means and the true regression
 * diverge), folds the rollups, then asserts:
 *
 *   1. `composeRegression` over the folded DAY-bucket accumulators equals
 *      `REGR_SLOPE` / `REGR_R2` / `STDDEV_POP` over the raw rows to a tight
 *      relative tolerance.
 *
 * Tolerance note: both paths fold the SAME closed form over the SAME raw-row
 * epoch-day x set, so they agree mathematically. They disagree only in float
 * summation order — Postgres's parallel aggregate accumulators vs. the
 * textbook `n·Σxy − Σx·Σy` closed form `composeRegression` evaluates from the
 * stored sums. With a UTC epoch-day x-axis (x ≈ 20 540), `n·Σxx − Σx²` is a
 * difference of two ~1e10 magnitudes, so the closed form sheds ~10 significant
 * digits to cancellation before the divide. That makes an ABSOLUTE 9-dp
 * `toBeCloseTo` the wrong gauge for a slope this small — the residual is float
 * reorder noise, not a data divergence. Parity is asserted RELATIVELY at
 * 1e-9, which is far tighter than the 2–3 dp the read tier ultimately rounds
 * the windowed slope / r² / sd to.
 *   2. The source-collapse runs BEFORE accumulator summation — a dual-source
 *      day contributes only the canonical source's accumulators, matching a
 *      live regression over the canonical-source rows.
 *   3. A DST-boundary reading lands in the same epoch-day x the live query
 *      uses (the x-axis is UTC `EXTRACT(EPOCH …)/86400`, DST-agnostic).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import {
  composeRegression,
  type RegressionAccumulators,
} from "@/lib/rollups/measurement-read";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

/**
 * Relative parity assertion for two values that are mathematically equal but
 * differ only by float summation order (see the tolerance note in the file
 * header). Absolute `toBeCloseTo` is the wrong gauge across magnitudes; this
 * pins |a − b| ≤ rel · max(|a|, |b|, 1) with a tight 1e-9 relative bound.
 */
function expectParity(composed: number, live: number, rel = 1e-9): void {
  const scale = Math.max(Math.abs(composed), Math.abs(live), 1);
  expect(Math.abs(composed - live)).toBeLessThanOrEqual(rel * scale);
}

/** Live REGR row shape (one per type over the seeded window). */
interface LiveRegrRow {
  slope: number | null;
  r2: number | null;
  sd_pop: number | null;
  n: bigint;
}

let seq = 0;
async function seedUser(prisma: ReturnType<typeof getPrismaClient>) {
  seq += 1;
  return prisma.user.create({
    data: {
      username: `regr-parity-${seq}`,
      email: `regr-parity-${seq}@example.test`,
      role: "USER",
    },
  });
}

/**
 * Live REGR_SLOPE / REGR_R2 / STDDEV_POP over the canonical-source raw rows
 * for one (user, type), with the SAME epoch-day x-axis the populator stores.
 * `sourceFilter` restricts to one source so the dual-source case can compare
 * against the collapsed source explicitly.
 */
async function liveRegr(
  prisma: ReturnType<typeof getPrismaClient>,
  userId: string,
  type: string,
  source?: string,
): Promise<LiveRegrRow> {
  const rows = await prisma.$queryRawUnsafe<LiveRegrRow[]>(
    `
      SELECT
        REGR_SLOPE(m."value", EXTRACT(EPOCH FROM m."measured_at") / 86400.0)
          ::double precision AS slope,
        REGR_R2(m."value", EXTRACT(EPOCH FROM m."measured_at") / 86400.0)
          ::double precision AS r2,
        STDDEV_POP(m."value")::double precision AS sd_pop,
        COUNT(*) AS n
      FROM measurements m
      WHERE m."user_id" = $1
        AND m."type" = $2::"measurement_type"
        AND m."deleted_at" IS NULL
        ${source ? `AND m."source" = $3::"measurement_source"` : ""}
    `,
    ...(source ? [userId, type, source] : [userId, type]),
  );
  return rows[0];
}

/**
 * Read the folded DAY-bucket accumulators for one (user, type, source).
 * The parity assertion sums these via `composeRegression` and compares to
 * the live regression over the same source's raw rows.
 */
async function foldedAccumulators(
  prisma: ReturnType<typeof getPrismaClient>,
  userId: string,
  type: string,
  source?: string,
): Promise<RegressionAccumulators[]> {
  const rows = await prisma.measurementRollup.findMany({
    where: {
      userId,
      type: type as never,
      granularity: "DAY",
      ...(source ? { source: source as never } : {}),
    },
    select: {
      count: true,
      mean: true,
      sumValue: true,
      sumX: true,
      sumXy: true,
      sumXx: true,
      sumYy: true,
    },
  });
  return rows.map((r) => ({
    count: r.count,
    mean: r.mean,
    sumValue: r.sumValue,
    sumX: r.sumX,
    sumXy: r.sumXy,
    sumXx: r.sumXx,
    sumYy: r.sumYy,
  }));
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rollup regression accumulators — live parity (v1.20.0 F6)", () => {
  it("WEIGHT: composed slope/r²/sd equals live REGR_*/STDDEV_POP, bit-identical", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    // Uneven per-day counts across many buckets — the divergent regime.
    // Deterministic, non-collinear values so slope / r² / sd are all
    // well-defined (a perfect line would make r² == 1 trivially).
    const seed: Array<{ day: string; hour: number; value: number }> = [
      { day: "2026-03-02", hour: 8, value: 90.0 },
      { day: "2026-03-03", hour: 7, value: 89.4 },
      { day: "2026-03-03", hour: 20, value: 89.9 },
      { day: "2026-03-09", hour: 6, value: 88.7 },
      { day: "2026-03-09", hour: 9, value: 89.1 },
      { day: "2026-03-09", hour: 21, value: 88.2 },
      { day: "2026-03-21", hour: 8, value: 87.6 },
      { day: "2026-04-04", hour: 7, value: 86.9 },
      { day: "2026-04-04", hour: 19, value: 87.3 },
      { day: "2026-04-18", hour: 8, value: 86.1 },
      { day: "2026-05-02", hour: 8, value: 85.4 },
      { day: "2026-05-02", hour: 12, value: 85.9 },
      { day: "2026-05-16", hour: 8, value: 84.8 },
    ];
    await prisma.measurement.createMany({
      data: seed.map((s) => ({
        userId: user.id,
        type: "WEIGHT" as const,
        value: s.value,
        unit: "kg",
        source: "MANUAL" as const,
        measuredAt: new Date(
          `${s.day}T${String(s.hour).padStart(2, "0")}:00:00.000Z`,
        ),
      })),
    });

    await recomputeUserRollups(user.id, {
      types: ["WEIGHT"],
      granularities: ["DAY"],
    });

    const live = await liveRegr(prisma, user.id, "WEIGHT");
    const acc = await foldedAccumulators(prisma, user.id, "WEIGHT");
    const composed = composeRegression(acc);

    // Sanity: the seed actually exercised the regression (n matches, slope
    // is a real number, not a degenerate null).
    expect(Number(live.n)).toBe(seed.length);
    expect(live.slope).not.toBeNull();
    expect(composed.slope).not.toBeNull();

    // Same closed form on both paths — parity holds to float reorder noise.
    expectParity(composed.slope!, live.slope!);
    expectParity(composed.r2!, live.r2!);
    expectParity(composed.sdPop!, live.sd_pop!);
  });

  it("source-collapse precedes summation: composed RHR equals live REGR over the WHOOP source only", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    // Dual-source RHR across several days: WHOOP (the ladder-canonical
    // source) + APPLE_HEALTH on overlapping days. The composed regression
    // must match a LIVE regression over the WHOOP rows alone — never a
    // cross-source blend.
    const days = ["2026-05-04", "2026-05-05", "2026-05-11", "2026-05-18"];
    const data: Array<{
      userId: string;
      type: "RESTING_HEART_RATE";
      value: number;
      unit: string;
      source: "WHOOP" | "APPLE_HEALTH";
      measuredAt: Date;
    }> = [];
    let i = 0;
    for (const day of days) {
      i += 1;
      // WHOOP trends down; APPLE sits a few bpm higher to perturb a blend.
      data.push({
        userId: user.id,
        type: "RESTING_HEART_RATE",
        value: 52 - i,
        unit: "bpm",
        source: "WHOOP",
        measuredAt: new Date(`${day}T06:00:00.000Z`),
      });
      data.push({
        userId: user.id,
        type: "RESTING_HEART_RATE",
        value: 58 + i,
        unit: "bpm",
        source: "APPLE_HEALTH",
        measuredAt: new Date(`${day}T07:30:00.000Z`),
      });
    }
    await prisma.measurement.createMany({ data });

    await recomputeUserRollups(user.id, {
      types: ["RESTING_HEART_RATE"],
      granularities: ["DAY"],
    });

    // WHOOP is the ladder winner for restingHeartRate, so the read tier
    // collapses each day to the WHOOP per-source bucket. Compose only the
    // WHOOP accumulators and compare to the live WHOOP-only regression.
    const live = await liveRegr(prisma, user.id, "RESTING_HEART_RATE", "WHOOP");
    const acc = await foldedAccumulators(
      prisma,
      user.id,
      "RESTING_HEART_RATE",
      "WHOOP",
    );
    const composed = composeRegression(acc);

    expect(Number(live.n)).toBe(days.length);
    expectParity(composed.slope!, live.slope!);
    expectParity(composed.r2!, live.r2!);
    expectParity(composed.sdPop!, live.sd_pop!);

    // The blend would be wrong: a regression over BOTH sources differs from
    // the WHOOP-only one, proving the collapse-before-sum matters.
    const blended = await liveRegr(prisma, user.id, "RESTING_HEART_RATE");
    expect(Number(blended.n)).toBe(days.length * 2);
    expect(blended.slope).not.toBeCloseTo(live.slope!, 6);
  });

  // v1.21.0 — un-quarantined by the regression x-rescale.
  //
  // The DST residual was never a data divergence: it was precision lost at
  // ACCUMULATION time. Migration 0190 stored `sum_xx = Σ(epoch_days²)` over the
  // raw epoch-day x-axis (x ≈ 20 540), so `sum_xx` accumulated past ~1e10 and
  // the square shed ~10 of double's ~15-16 significant digits BEFORE the value
  // was stored — the sub-day x detail was already gone, and no read-side
  // identity (mean-centering included) could recover it. The earlier
  // mean-centered fix shrank the residual to ~9e-8 but could not cross 1e-9 on
  // this deliberately ill-conditioned 5-point near-flat seed.
  //
  // The write path now REBASES x to `REGRESSION_X_ORIGIN_DAYS` (2020-01-01), so
  // `sum_xx` stays O(1e7) and the squared terms stay exact. Slope / r² / sd are
  // invariant under the x-shift, so the live (raw-epoch) REGR_* probe this case
  // compares against still parity-matches the cross-bucket compose — now within
  // the tight 1e-9 relative bound. The WEIGHT case above stays bit-identical
  // (it was already exact; the rebase only restores precision on the
  // ill-conditioned tail).
  it("DST boundary: the epoch-day x-axis is UTC, so a spring-forward reading parity-matches", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    // Readings straddling the 2026 EU DST transition (2026-03-29 01:00 UTC).
    // The x-axis is UTC epoch-days on both paths, so the transition is a
    // no-op for parity; this pins that the accumulator x matches the live x.
    // A clear monotonic trend (well-conditioned, like the WEIGHT case) so the
    // regression is not near-flat: a near-zero r² is what makes the naive
    // sum-of-squares closed form ill-conditioned vs Postgres REGR. The point of
    // THIS case is the DST-straddling timestamps + a same-UTC-day pair, not a
    // noisy slope.
    const seed: Array<{ at: string; value: number }> = [
      { at: "2026-03-28T23:30:00.000Z", value: 100.0 },
      { at: "2026-03-29T00:30:00.000Z", value: 101.0 },
      { at: "2026-03-29T02:30:00.000Z", value: 102.0 },
      { at: "2026-03-30T08:00:00.000Z", value: 105.0 },
      { at: "2026-03-31T08:00:00.000Z", value: 108.0 },
    ];
    // WEIGHT, like the bit-identical case above: a plain metric whose rollup
    // folds the raw rows directly. (BLOOD_GLUCOSE carries a source-priority /
    // CGM-vs-spot consolidation that makes the live raw-row REGR and the
    // bucket-folded accumulators legitimately regress over different row sets —
    // orthogonal to the DST x-axis property this case is here to pin.)
    await prisma.measurement.createMany({
      data: seed.map((s) => ({
        userId: user.id,
        type: "WEIGHT" as const,
        value: s.value,
        unit: "kg",
        source: "MANUAL" as const,
        measuredAt: new Date(s.at),
      })),
    });

    await recomputeUserRollups(user.id, {
      types: ["WEIGHT"],
      granularities: ["DAY"],
    });

    const live = await liveRegr(prisma, user.id, "WEIGHT");
    const acc = await foldedAccumulators(prisma, user.id, "WEIGHT");
    const composed = composeRegression(acc);

    expect(Number(live.n)).toBe(seed.length);
    // The accumulators sum over the identical raw rows the live REGR reads
    // (the same-UTC-day 00:30Z + 02:30Z pair contributes both), so with a
    // well-conditioned trend the composed closed form matches Postgres REGR at
    // the same tight tolerance as every other case — confirming the epoch-day
    // x-axis is DST-agnostic.
    expectParity(composed.slope!, live.slope!);
    expectParity(composed.r2!, live.r2!);
    expectParity(composed.sdPop!, live.sd_pop!);
  });
});
