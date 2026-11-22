/**
 * The two reads `POST /api/measurements/batch` makes up front about rows the
 * batch may already hold, one statement each for the whole batch.
 *
 * Samples: a re-sent sample used to cost one interactive reconciler
 * transaction (about ten round trips) only for the reconciler to answer
 * `duplicate`. One read over the batch's sample ids answers it for every row
 * at once (the route's exact-duplicate prefilter).
 *
 * `stats:` rows: the phone re-sends the same daily totals on every sync, and
 * each went through the reconciler only to write the same values back, then
 * counted as `updated`, which started the whole tail: the DAY refold, rollup
 * jobs, PR detection and a cache stale for the account. Such a row is still
 * reported `updated`, exactly as before, but nothing is written and it starts
 * nothing. "Unchanged" is the reconciler's own update with nothing to change:
 * a live row holds the entry's external key AND its natural identity (both
 * indexes are unique, so that row is the only candidate), already carries the
 * HealthKit-statistics provenance, and every column the update would write
 * already has the value it would write. The route applies it only where
 * neither key occurs a second time in the batch, and never to a value the
 * plausibility gate would refuse. A concurrent writer is no different from
 * one that ran a moment later: its write lands after this no-op either way.
 */
import type { PrismaClient } from "@/generated/prisma/client";

/** `type::source::externalId`, the external identity of a row. */
export function externalKeyOf(
  type: unknown,
  source: unknown,
  externalId: unknown,
): string {
  return `${type}::${source}::${externalId}`;
}

/** Stored rows (live or tombstoned) at the batch's sample ids. */
export async function readStoredSampleIdentities(
  db: Pick<PrismaClient, "measurement">,
  userId: string,
  externalIds: readonly string[],
): Promise<
  Map<string, { measuredAt: Date; sleepStage: unknown; deleted: boolean }>
> {
  const out = new Map<
    string,
    { measuredAt: Date; sleepStage: unknown; deleted: boolean }
  >();
  if (externalIds.length === 0) return out;
  const rows = await db.measurement.findMany({
    where: { userId, externalId: { in: [...externalIds] } },
    select: {
      type: true,
      source: true,
      externalId: true,
      measuredAt: true,
      sleepStage: true,
      deletedAt: true,
    },
  });
  for (const row of rows) {
    out.set(externalKeyOf(row.type, row.source, row.externalId), {
      measuredAt: row.measuredAt,
      sleepStage: row.sleepStage,
      deleted: row.deletedAt !== null,
    });
  }
  return out;
}

/** The columns the reconciler's update writes, besides the identity. */
const STATS_COLUMNS = [
  "value",
  "valueMin",
  "valueMax",
  "unit",
  "sleepStage",
  "externalSourceVersion",
  "glucoseContext",
  "rhythmClassification",
  "deviceType",
  "timeZone",
] as const;

export type StoredStatsRow = Record<
  (typeof STATS_COLUMNS)[number] | "aggregationProvenance",
  unknown
> & { measuredAt: Date };

/** Live stored rows at the batch's `stats:` ids, with every written column. */
export async function readStoredStatsRows(
  db: Pick<PrismaClient, "measurement">,
  userId: string,
  externalIds: readonly string[],
): Promise<Map<string, StoredStatsRow>> {
  const out = new Map<string, StoredStatsRow>();
  if (externalIds.length === 0) return out;
  const rows = await db.measurement.findMany({
    where: { userId, externalId: { in: [...externalIds] }, deletedAt: null },
    select: {
      type: true,
      source: true,
      externalId: true,
      measuredAt: true,
      aggregationProvenance: true,
      ...Object.fromEntries(STATS_COLUMNS.map((c) => [c, true])),
    },
  });
  for (const row of rows as unknown as Array<
    StoredStatsRow & { type: string; source: string; externalId: string }
  >) {
    out.set(externalKeyOf(row.type, row.source, row.externalId), row);
  }
  return out;
}

/**
 * Whether the update a `stats:` entry would make to `stored` writes nothing
 * new: same instant, the statistics provenance already, every column equal.
 */
export function statsWriteUnchanged(
  stored: StoredStatsRow | undefined,
  desired: Record<(typeof STATS_COLUMNS)[number], unknown> & {
    measuredAt: Date;
  },
): boolean {
  if (!stored || !(stored.measuredAt instanceof Date)) return false;
  if (stored.measuredAt.getTime() !== desired.measuredAt.getTime()) {
    return false;
  }
  if (stored.aggregationProvenance !== "HEALTHKIT_STATISTICS") return false;
  return STATS_COLUMNS.every(
    (column) => (stored[column] ?? null) === (desired[column] ?? null),
  );
}

/** The identity columns of one batch entry. */
export interface BatchKeyRow {
  type?: unknown;
  source?: unknown;
  externalId?: unknown;
  measuredAt?: unknown;
  sleepStage?: unknown;
}

/** `type::source::epochMs::sleepStage`, the natural identity of a row. */
export function naturalKeyOf(row: BatchKeyRow): string {
  return `${row.type}::${row.source}::${(row.measuredAt as Date).getTime()}::${row.sleepStage ?? "null"}`;
}

/**
 * Whether an entry's external key and natural identity each occur once in
 * its batch. Only such an entry may be decided ahead of the reconciler: an
 * earlier entry sharing either key could move or retire the stored row
 * before this one is reached.
 */
export function onceInBatch(
  rows: readonly BatchKeyRow[],
): (row: BatchKeyRow) => boolean {
  const external = new Map<string, number>();
  const natural = new Map<string, number>();
  for (const row of rows) {
    const e = externalKeyOf(row.type, row.source, row.externalId);
    external.set(e, (external.get(e) ?? 0) + 1);
    const n = naturalKeyOf(row);
    natural.set(n, (natural.get(n) ?? 0) + 1);
  }
  return (row) =>
    external.get(externalKeyOf(row.type, row.source, row.externalId)) === 1 &&
    natural.get(naturalKeyOf(row)) === 1;
}

/**
 * Whether a sample entry is an exact duplicate of `stored`, the row at its
 * external key: the same instant and sleep stage, which makes that row its
 * natural match too, the reconciler's `duplicate`.
 */
export function sampleIsStoredDuplicate(
  stored: { measuredAt: Date; sleepStage: unknown } | undefined,
  row: BatchKeyRow,
): boolean {
  return (
    stored !== undefined &&
    stored.measuredAt.getTime() === (row.measuredAt as Date).getTime() &&
    (stored.sleepStage ?? null) === (row.sleepStage ?? null)
  );
}
