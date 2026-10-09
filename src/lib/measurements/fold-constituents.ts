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
 * Which tombstones a fold left, as opposed to a person's deletions. Nothing
 * on a row records who deleted it: there is no origin column, the folds and
 * the person's paths both set `updatedAt` with `deletedAt`, and the audit
 * rows of the bulk and by-external-ids deletes carry counts, not ids. What
 * the rows do carry:
 *   - every path that deletes on a person's behalf (`DELETE
 *     /api/measurements/:id`, the bulk delete, the by-external-ids delete)
 *     raises `syncVersion`, so a tombstone with `syncVersion = 1` was never
 *     deleted by a person. The converse does not hold: a raw sample can be
 *     raised in place before a fold takes it (the collision merge in
 *     `reconcile-external-measurement.ts`, a changed value in the Health
 *     Connect import), and the fold then leaves it with `syncVersion > 1`;
 *   - a fold soft-deleted a day's samples in one statement, so its
 *     tombstones of one run share one `deletedAt` to the millisecond. A
 *     person's deletion lands on that instant only by coincidence;
 *   - a fold only took samples already past its threshold, so the sample was
 *     older than the threshold when it was deleted. A tombstone younger than
 *     that was never a fold's.
 * So {@link classifyFoldTombstones} reads a tombstone of the right age as a
 * fold leftover when it carries `syncVersion = 1`, or when it shares its
 * deletion instant with such a tombstone of the same day (a raised sample the
 * same run took). Anything else of that age is ambiguous: a person's
 * deletion, or a raised sample whose run left no `syncVersion = 1` row to
 * recognise it by. A window holding an ambiguous tombstone is never
 * recomputed, because whichever it is, the samples in hand are not provably
 * the samples the stored mean should be taken from.
 *
 * And a window whose leftovers all come from one run, with no live sample,
 * is never recomputed either ({@link foldWindowVerdict}): one run took the
 * whole window and its stored mean is that run's mean of all of it. Only a
 * window the record shows was taken in two parts, by fold runs at least
 * {@link FOLD_RUN_GAP_MS} apart, or by a run and the live samples that
 * reached it afterwards, can hold a mean of part of it.
 *
 * A collision retirement (`retired:` id) and a `stats:` row are never samples.
 *
 * This is deliberately wider than the class-A rule in `folded-window.ts`: a
 * day folded in two runs left the tombstones of its first run in a window
 * that was not yet complete, so they are class B (kept for the 75-day
 * retention) and still constituents of the day's mean. The age test is the
 * same one `isFoldedWindowCandidate` applies at the deletion instant, so every
 * class-A tombstone has the age of a fold leftover.
 *
 * The horizon. Tombstones are purged 75 days after they were written, so for
 * an older window the samples present may be a fragment: what a re-upload
 * after an anchor reset put back, the rows of one later run, nothing of the
 * samples the stored mean was taken from. A mean recomputed from those can be
 * far off a stored mean that was computed from the whole window. Every fold
 * tombstone of a day was written after `dayStart + foldedAfter` (the fold
 * only took samples older than its threshold), so when that instant is still
 * inside the retention, the retention cleanup has purged none of them.
 * {@link foldConstituentHorizon} is the earliest day start for which that
 * holds; a pass recomputes a stored mean only for a day starting at or after
 * it, and leaves an older one as it is. For the daily means that is the last
 * 75 days; for the dense hourly means, which are folded 90 days late, the 75
 * days before the raw window.
 *
 * The horizon holds only until the compaction-tombstone purge has run for the
 * account: the purge deletes class-A tombstones whatever their age, so inside
 * the horizon only class-B leftovers may remain. The purge waits for the
 * account's `MeasurementFoldRepair` row, and from then on nothing recomputes
 * a stored mean from leftovers: the folds' re-fold of a stored window checks
 * {@link hasFoldRepairRun} and leaves the window as it is. The purge takes
 * the fold lock for each account it deletes from, so a re-fold that read no
 * marker under that lock reads its samples before the purge can touch them.
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
 * How far apart two deletion instants must lie to count as two fold runs. One
 * run takes a day in one transaction, seconds at most; two runs of the
 * nightly folds are a day apart, and a boot-time run is still hours from the
 * nightly one.
 */
export const FOLD_RUN_GAP_MS = 3_600_000;

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

/** A tombstone of the right age, read as a fold leftover. */
export interface FoldLeftover extends FoldConstituent {
  deletedAt: Date;
}

/** The fields a row needs for {@link classifyFoldTombstones}. */
export interface FoldTombstoneCandidate extends FoldConstituent {
  externalId: string | null;
  deletedAt: Date | null;
  syncVersion: number;
}

/**
 * Whether a soft-deleted raw sample was old enough, when it was deleted, for
 * a fold to have taken it. Pure.
 */
export function hasFoldAge(
  row: Pick<FoldTombstoneCandidate, "externalId" | "measuredAt" | "deletedAt">,
  foldedAfterMs: number,
): boolean {
  if (row.deletedAt === null) return false;
  if (row.externalId === null) return false;
  if (row.externalId.startsWith("stats:")) return false;
  if (row.externalId.startsWith("retired:")) return false;
  return row.measuredAt.getTime() < row.deletedAt.getTime() - foldedAfterMs;
}

/**
 * Whether a tombstone is certainly a fold's: of fold age, and never touched by
 * a person's delete (`syncVersion = 1`). A day without one has no fold
 * leftover at all. Pure.
 */
export function isCertainFoldLeftover(
  row: Pick<
    FoldTombstoneCandidate,
    "externalId" | "measuredAt" | "deletedAt" | "syncVersion"
  >,
  foldedAfterMs: number,
): boolean {
  return row.syncVersion === 1 && hasFoldAge(row, foldedAfterMs);
}

/** The tombstones of one span, as {@link classifyFoldTombstones} reads them. */
export interface FoldTombstones {
  leftovers: FoldLeftover[];
  /** Tombstones of fold age that may be a person's deletion. */
  ambiguous: FoldConstituent[];
}

/**
 * Split the tombstones of one local day (one account, type and source) into
 * fold leftovers and ambiguous rows. See the header. Pure.
 */
export function classifyFoldTombstones(
  rows: readonly FoldTombstoneCandidate[],
  foldedAfterMs: number,
): FoldTombstones {
  const runInstants = new Set<number>();
  for (const row of rows) {
    if (isCertainFoldLeftover(row, foldedAfterMs) && row.deletedAt) {
      runInstants.add(row.deletedAt.getTime());
    }
  }
  const out: FoldTombstones = { leftovers: [], ambiguous: [] };
  for (const row of rows) {
    if (!row.deletedAt || !hasFoldAge(row, foldedAfterMs)) continue;
    const constituent = {
      id: row.id,
      value: row.value,
      measuredAt: row.measuredAt,
    };
    if (row.syncVersion === 1 || runInstants.has(row.deletedAt.getTime())) {
      out.leftovers.push({ ...constituent, deletedAt: row.deletedAt });
    } else {
      out.ambiguous.push(constituent);
    }
  }
  return out;
}

/** What a pass may do with one window's stored mean. */
export type FoldWindowVerdict =
  /** Taken in two parts: recompute it from every sample. */
  | "recompute"
  /** One run took all of it: the stored mean is already that mean. */
  | "single-run"
  /** A tombstone may be a person's deletion: leave it as stored. */
  | "ambiguous"
  /** No fold leftover: nothing records what the mean was taken from. */
  | "no-leftovers";

/**
 * Whether one window's stored mean may be recomputed from its live samples
 * and its leftovers. Pure; see the header.
 */
export function foldWindowVerdict(input: {
  leftovers: readonly Pick<FoldLeftover, "deletedAt">[];
  ambiguous: number;
  live: number;
}): FoldWindowVerdict {
  if (input.ambiguous > 0) return "ambiguous";
  if (input.leftovers.length === 0) return "no-leftovers";
  if (input.live > 0) return "recompute";
  const instants = input.leftovers
    .map((row) => row.deletedAt.getTime())
    .sort((a, b) => a - b);
  for (let i = 1; i < instants.length; i++) {
    if (instants[i] - instants[i - 1] >= FOLD_RUN_GAP_MS) return "recompute";
  }
  return "single-run";
}

/** Prisma filter for the tombstones {@link classifyFoldTombstones} reads. */
export function foldTombstoneWhere(input: {
  userId: string;
  type: MeasurementType;
  source: MeasurementSource;
}): Prisma.MeasurementWhereInput {
  return {
    userId: input.userId,
    type: input.type,
    source: input.source,
    deletedAt: { not: null },
    externalId: { not: null },
    NOT: [
      { externalId: { startsWith: "stats:" } },
      { externalId: { startsWith: "retired:" } },
    ],
  };
}

/**
 * The fold leftovers and ambiguous tombstones of one `[from, to)` span of one
 * account, type and source. The span is one local day, so the result is at
 * most a day of samples, and the run instants are read across the whole day.
 */
export async function loadFoldTombstones(
  client: Pick<Prisma.TransactionClient, "measurement">,
  input: {
    userId: string;
    type: MeasurementType;
    source: MeasurementSource;
    from: Date;
    to: Date;
    foldedAfterMs: number;
  },
): Promise<FoldTombstones> {
  const rows = await client.measurement.findMany({
    where: {
      ...foldTombstoneWhere(input),
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
  return classifyFoldTombstones(rows, input.foldedAfterMs);
}

/**
 * Whether the one-time fold repair has been through an account. From then on
 * the compaction-tombstone purge may have removed leftovers inside the
 * horizon, so no pass recomputes a stored mean from them (see the header).
 */
export async function hasFoldRepairRun(
  client: Pick<Prisma.TransactionClient, "measurementFoldRepair">,
  userId: string,
): Promise<boolean> {
  const row = await client.measurementFoldRepair.findUnique({
    where: { userId },
    select: { userId: true },
  });
  return row !== null;
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
 * recomputed, leaving them as fold leftovers (see the header): all of one
 * call share one deletion instant, which is how a raised sample among them is
 * still read as a leftover. Returns how many rows it took.
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
