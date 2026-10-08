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
 *
 * The horizon. Tombstones are purged 75 days after they were written, so for
 * an older window the samples present may be a fragment: what a re-upload
 * after an anchor reset put back, the rows of one later run, nothing of the
 * samples the stored mean was taken from. A mean recomputed from those can be
 * far off a stored mean that was computed from the whole window. Every fold
 * tombstone of a day was written after `dayStart + foldedAfter` (the fold
 * only took samples older than its threshold), so when that instant is still
 * inside the retention, none of them has been purged yet, and the live rows
 * plus the fold leftovers are the whole window. {@link foldConstituentHorizon}
 * is the earliest day start for which that holds; a pass recomputes a stored
 * mean only for a day starting at or after it, and leaves an older one as it
 * is. For the daily means that is the last 75 days; for the dense hourly
 * means, which are folded 90 days late, the 75 days before the raw window.
 *
 * A pass that takes a window's live samples into a stored mean it recomputed
 * soft-deletes them ({@link absorbIntoFold}) rather than deleting them, so they
 * stay fold leftovers: a second pass over the same window then computes the
 * same mean from the same samples instead of from the leftovers alone.
 */
import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
} from "@/generated/prisma/client";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";

const DAY_MS = 86_400_000;

/**
 * Slack on the horizon: a pass runs for minutes, and a tombstone right at the
 * edge of the retention must not be purged by the cleanup while it does.
 */
export const FOLD_HORIZON_MARGIN_MS = DAY_MS;

/**
 * The earliest day start whose fold leftovers are certainly all still in the
 * table, for a fold that takes samples `foldedAfterMs` after they were
 * measured. See the header. Pure.
 */
export function foldConstituentHorizon(now: Date, foldedAfterMs: number): Date {
  return new Date(
    now.getTime() -
      TOMBSTONE_RETENTION_DAYS * DAY_MS -
      foldedAfterMs +
      FOLD_HORIZON_MARGIN_MS,
  );
}

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

/**
 * The live raw samples of one `[from, to)` span of one account, type and
 * source: the rows a fold of that span would take. A `stats:` row and a
 * collision retirement are never samples.
 */
export async function loadLiveSamples(
  client: Pick<Prisma.TransactionClient, "measurement">,
  input: {
    userId: string;
    type: MeasurementType;
    source: MeasurementSource;
    from: Date;
    to: Date;
  },
): Promise<FoldConstituent[]> {
  return client.measurement.findMany({
    where: {
      userId: input.userId,
      type: input.type,
      source: input.source,
      deletedAt: null,
      externalId: { not: null },
      NOT: [
        { externalId: { startsWith: "stats:" } },
        { externalId: { startsWith: "retired:" } },
      ],
      measuredAt: { gte: input.from, lt: input.to },
    },
    select: { id: true, value: true, measuredAt: true },
  });
}

/**
 * Soft-delete live samples a pass has just taken into a stored mean it
 * recomputed, leaving them as fold leftovers (see the header). Raw HealthKit
 * and Health Connect samples are never updated in place, so they keep
 * `syncVersion = 1`, which {@link isFoldLeftover} reads. Returns how many rows
 * it took.
 */
export async function absorbIntoFold(
  tx: Pick<Prisma.TransactionClient, "measurement">,
  ids: readonly string[],
  at: Date = new Date(),
): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await tx.measurement.updateMany({
    where: { id: { in: [...ids] }, deletedAt: null },
    data: { deletedAt: at },
  });
  return res.count;
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
