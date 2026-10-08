/**
 * The raw samples a folded hour or day was computed from, as far as they are
 * still in the table.
 *
 * A fold writes one `stats:` mean per local hour (dense types) or local day
 * (mean types). Before v1.42 it soft-deleted the samples it folded, and until
 * the fold boundary was aligned to the local day it could fold a day in two
 * runs, the second overwriting the stored mean with the mean of the later
 * part only. Recomputing such a mean correctly needs every sample of the
 * window: the ones still live and the ones a fold soft-deleted.
 *
 * Which tombstones a fold left, as opposed to a person's deletions:
 *   - every path that deletes on a person's behalf (`DELETE
 *     /api/measurements/:id`, the bulk delete, the by-external-ids delete)
 *     raises `syncVersion`; the folds never did, and a raw HealthKit or Health
 *     Connect sample is never updated in place, so a fold's tombstone carries
 *     `syncVersion = 1`;
 *   - a fold only took samples already past its threshold, so the sample was
 *     older than the threshold when it was deleted.
 * A collision retirement (`retired:` id) and a `stats:` row are never samples.
 *
 * This is deliberately wider than the class-A rule in `folded-window.ts`: a
 * day folded in two runs left the tombstones of its first run in a window
 * that was not yet complete, so they are class B (kept for the 75-day
 * retention) and still constituents of the day's mean.
 */
import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
} from "@/generated/prisma/client";

export interface FoldConstituent {
  id: string;
  value: number;
  measuredAt: Date;
}

/** The fields a row needs for {@link isFoldLeftover}. */
export interface FoldLeftoverCandidate {
  externalId: string | null;
  measuredAt: Date;
  deletedAt: Date | null;
  syncVersion: number;
}

/** Whether a soft-deleted row is a sample a fold removed. Pure. */
export function isFoldLeftover(
  row: FoldLeftoverCandidate,
  foldedAfterMs: number,
): boolean {
  if (row.deletedAt === null) return false;
  if (row.syncVersion !== 1) return false;
  if (row.externalId === null) return false;
  if (row.externalId.startsWith("stats:")) return false;
  if (row.externalId.startsWith("retired:")) return false;
  return row.measuredAt.getTime() < row.deletedAt.getTime() - foldedAfterMs;
}

/** Prisma filter for the rows {@link isFoldLeftover} then decides on. */
export function foldLeftoverWhere(input: {
  userId: string;
  type: MeasurementType;
  source: MeasurementSource;
}): Prisma.MeasurementWhereInput {
  return {
    userId: input.userId,
    type: input.type,
    source: input.source,
    deletedAt: { not: null },
    syncVersion: 1,
    externalId: { not: null },
    NOT: [
      { externalId: { startsWith: "stats:" } },
      { externalId: { startsWith: "retired:" } },
    ],
  };
}

/**
 * The fold leftovers of one `[from, to)` span of one account, type and source.
 * The span is one local day, so the result is at most a day of samples.
 */
export async function loadFoldLeftovers(
  client: Pick<Prisma.TransactionClient, "measurement">,
  input: {
    userId: string;
    type: MeasurementType;
    source: MeasurementSource;
    from: Date;
    to: Date;
    foldedAfterMs: number;
  },
): Promise<FoldConstituent[]> {
  const rows = await client.measurement.findMany({
    where: {
      ...foldLeftoverWhere(input),
      measuredAt: { gte: input.from, lt: input.to },
    },
    select: {
      id: true,
      value: true,
      measuredAt: true,
      externalId: true,
      deletedAt: true,
      syncVersion: true,
    },
  });
  return rows
    .filter((row) => isFoldLeftover(row, input.foldedAfterMs))
    .map((row) => ({
      id: row.id,
      value: row.value,
      measuredAt: row.measuredAt,
    }));
}

/** Arithmetic mean of a non-empty list of values. */
export function meanOf(values: readonly number[]): number {
  let acc = 0;
  for (const v of values) acc += v;
  return acc / values.length;
}

/** Whether a recomputed mean differs from the stored one beyond float noise. */
export function meanDiffers(stored: number, recomputed: number): boolean {
  return Math.abs(stored - recomputed) > 1e-9 * Math.max(1, Math.abs(stored));
}
