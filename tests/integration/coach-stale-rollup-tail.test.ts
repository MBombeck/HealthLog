/**
 * REGRESSION — a rollup bucket must not narrate rows that no longer exist.
 *
 * The read-swap in `tiered-context.ts` falls back to live SQL only when a band
 * is EMPTY, so a bucket that is merely WRONG is served as though it were
 * current. The one staleness repair, `ensureUserRollupsFresh`, recomputes the
 * DAY tier over the trailing 90 days only, and keys off `Measurement.updatedAt`
 * — which a HARD delete does not bump. `src/lib/whoop/sync-body.ts` performs
 * exactly such a hard `measurement.deleteMany` on a WEIGHT row with no rollup
 * invalidation, so this reproduces that shape against a MONTH-band bucket.
 *
 * Before the fix the Coach snapshot carried two irreconcilable accounts of the
 * same record with nothing marking which to believe: `coarse.monthly` reported
 * the deleted value while `aggregate.allTimeMin/Max` beside it reported only
 * the surviving one, under an `asOf` stamped current because it is derived from
 * raw reading age and knows nothing about rollup age.
 *
 * `annotateSnapshotFreshness` now reconciles the two where they are assembled.
 * A bucket mean is an average of real rows, so it must lie within those rows'
 * all-time extremes; a mean outside them proves the bucket outlived its rows.
 * The disputed coarse tail is dropped and `asOf.coarseHistoryWithheld` records
 * that it was — narrating a ghost is worse than narrating less.
 *
 * `currentForTodayClaims` deliberately stays true here. It means "the freshest
 * READING is recent enough for present tense", and it is: the surviving rows
 * are from today. Suppressing it would silence a true statement to punish a
 * stale history band.
 *
 * The row on disk is still wrong. The deeper fix is to make the tier notice —
 * either compare a bucket's `computedAt` against the type's in-window
 * MAX(`updatedAt`), or invalidate on the hard-delete path — and that is a
 * larger change than this honesty repair.
 */ import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";

import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

const prisma = getPrismaClient();
const DAY = 24 * 60 * 60 * 1000;

/** The value only ever present in the rows we delete. */
const GHOST_KG = 95;
/** The value the record still holds afterwards. */
const LIVE_KG = 80;

interface WeightBlock {
  aggregate: { allTimeMin: number; allTimeMax: number };
  timeline: { coarse?: { monthly: Array<[string, number, number, number]> } };
  asOf: { currentForTodayClaims: boolean; coarseHistoryWithheld?: true };
}

describe("coach snapshot — a rollup bucket that outlived its rows", () => {
  beforeEach(async () => {
    await truncateAllTables(prisma);
  });

  it("withholds the coarse tail whose buckets the live record cannot account for", async () => {
    const user = await prisma.user.create({
      data: {
        email: "stale-rollup@example.test",
        username: "stale-rollup",
        passwordHash: "x",
      },
    });
    const userId = user.id;

    // Rows in the MONTH band (90 days to a year), plus recent rows so the
    // snapshot renders a weight block at all.
    await prisma.measurement.createMany({
      data: [
        ...Array.from({ length: 12 }, (_, i) => ({
          userId,
          type: "WEIGHT" as const,
          value: GHOST_KG,
          unit: "kg",
          source: "WHOOP" as const,
          externalId: `stale-${i}`,
          measuredAt: new Date(Date.now() - (200 + i) * DAY),
        })),
        ...Array.from({ length: 6 }, (_, i) => ({
          userId,
          type: "WEIGHT" as const,
          value: LIVE_KG,
          unit: "kg",
          measuredAt: new Date(Date.now() - i * DAY),
        })),
      ],
    });

    await recomputeUserRollups(userId);

    // The hard delete `whoop/sync-body.ts` performs — no rollup invalidation,
    // and no `updatedAt` bump for the freshness probe to notice.
    const deleted = await prisma.measurement.deleteMany({
      where: { userId, type: "WEIGHT", source: "WHOOP" },
    });
    expect(deleted.count).toBe(12);

    const remaining = await prisma.measurement.findMany({
      where: { userId, type: "WEIGHT" },
      select: { value: true },
    });
    expect(remaining.every((r) => r.value === LIVE_KG)).toBe(true);

    // The MONTH buckets are untouched by the delete.
    const buckets = await prisma.measurementRollup.findMany({
      where: { userId, type: "WEIGHT", granularity: "MONTH", source: "WHOOP" },
      select: { mean: true, count: true },
    });
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.every((b) => b.mean === GHOST_KG)).toBe(true);

    const snap = await buildCoachSnapshot(userId);
    const weight = (snap.sections as Record<string, unknown>)
      .weight as WeightBlock;

    // The all-time extremes, read live, know only the surviving value.
    expect(weight.aggregate.allTimeMin).toBe(LIVE_KG);
    expect(weight.aggregate.allTimeMax).toBe(LIVE_KG);

    // The coarse tail could not be reconciled with them, so it is gone…
    expect(weight.timeline.coarse).toBeUndefined();
    expect(weight.asOf.coarseHistoryWithheld).toBe(true);

    // …and the deleted value reaches no part of what the model is shown.
    expect(snap.snapshotJson).not.toContain(String(GHOST_KG));

    // The freshest reading is still from today, so present tense is still fair.
    expect(weight.asOf.currentForTodayClaims).toBe(true);
  });
});
