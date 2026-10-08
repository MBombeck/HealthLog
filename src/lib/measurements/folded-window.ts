/**
 * The `folded_window` ingest guard and the compaction-tombstone class (v1.42).
 *
 * The dense-intraday consolidation folds the raw samples of a DENSE type into one `stats:` row per local hour once they are older than
 * the retention window, and a MEAN type into one `stats:` row per local day
 * once the consolidation grace has passed. Since v1.42 the folded raw rows are
 * deleted outright rather than left as tombstones, so a client that re-uploads
 * an old sample after losing its anchor would put it back beside the hour or
 * day that already accounts for it. A raw (non-`stats:`) value of such a source
 * and type, old enough to have been folded, is therefore a duplicate when a
 * live `stats:` row covers its hour or day. The batch route and the ZIP import
 * apply the same rule.
 *
 * The same question, asked of a tombstone, names the compaction tombstones
 * ("class A"): a soft-deleted raw sample that was already old enough to fold
 * when it was deleted, and whose hour or day a live `stats:` row covers. The
 * backlog purge, the sync feed and the restore all classify through
 * {@link findCompactionTombstones}, so the three can never disagree about
 * which rows are compaction leftovers and which are a person's deletions.
 *
 * Which `stats:` row covers a sample is decided by its externalId, built from
 * the account's current timezone exactly as the fold builds it
 * (`stats:<HK>:<YYYY-MM-DD>T<HH>` for a dense hour, `stats:<HK>:<YYYY-MM-DD>`
 * for a mean day). A dense day still folded at the pre-v1.28.31 daily grain is
 * deliberately NOT covered: the one-shot hourly rebuild reads those days'
 * tombstones, so they are neither refused at ingest by this rule nor purged.
 * An account whose timezone changed after a fold may see an old day keyed in
 * the other zone; such a row is then simply not recognised, which is the
 * pre-v1.42 behaviour, never a wrong refusal.
 *
 * Health Connect folds its raw heart-rate history the same way under its own
 * source (the importer writes samples of the last 90 days raw, and the
 * nightly pass folds them once they age out), so the hour rule covers both
 * sources and a covering row is always looked up under the sample's own
 * source. The day rule stays Apple Health only: the nightly mean
 * consolidation reads no other source.
 */
import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
} from "@/generated/prisma/client";
import {
  HIGH_FREQUENCY_MEAN_TYPES,
  dailyStatsExternalId,
  hkIdentifierForType,
} from "@/lib/measurements/apple-health-mapping";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";
import {
  CONSOLIDATION_GRACE_CUTOFF_HOURS,
  dayKeyForUserTz,
  hourOfDayForUserTz,
} from "@/lib/measurements/consolidation-tz";
import {
  DENSE_INTRADAY_FOLD_SOURCES,
  DENSE_INTRADAY_RETENTION_DAYS,
  DENSE_INTRADAY_RETENTION_TYPES,
  hourlyStatsExternalId,
} from "@/lib/measurements/dense-intraday-retention";

/** The per-entry status reason the batch result carries for such a row. */
export type FoldedWindowReason = "folded_window";
export const FOLDED_WINDOW_REASON: FoldedWindowReason = "folded_window";

const HOUR_MS = 3_600_000;

/** Which sources and types fold into which window, and from what age. */
export const FOLDED_WINDOW_RULES = [
  {
    window: "hour",
    sources: DENSE_INTRADAY_FOLD_SOURCES,
    types: DENSE_INTRADAY_RETENTION_TYPES,
    foldedAfterMs: DENSE_INTRADAY_RETENTION_DAYS * 24 * HOUR_MS,
  },
  {
    window: "day",
    sources: ["APPLE_HEALTH"] as const,
    types: HIGH_FREQUENCY_MEAN_TYPES,
    foldedAfterMs: CONSOLIDATION_GRACE_CUTOFF_HOURS * HOUR_MS,
  },
] as const;

/** Every type either rule folds. */
export const FOLDED_TYPES: readonly MeasurementType[] = [
  ...DENSE_INTRADAY_RETENTION_TYPES,
  ...HIGH_FREQUENCY_MEAN_TYPES,
];

/** The fields of an incoming row the guard reads. */
export interface FoldedWindowCandidateRow {
  type: MeasurementType;
  source: MeasurementSource;
  externalId: string | null;
  measuredAt: Date;
}

/**
 * Whether a row is old enough, and of the right kind, for its hour or day to
 * have been folded already. Pure: whether a live `stats:` row actually covers
 * it is the lookup's question. `now` is the instant the age is measured at:
 * the request time for an upload, the deletion time for a tombstone.
 */
export function isFoldedWindowCandidate(
  row: FoldedWindowCandidateRow,
  now: Date = new Date(),
): boolean {
  if (row.externalId === null) return false;
  if (row.externalId.startsWith("stats:")) return false;
  // A collision retirement (`reconcile-external-measurement.ts`) parks the
  // losing row at the epoch under a `retired:` id. It is not a folded sample.
  if (row.externalId.startsWith("retired:")) return false;
  const age = now.getTime() - row.measuredAt.getTime();
  return FOLDED_WINDOW_RULES.some(
    (rule) =>
      (rule.sources as readonly MeasurementSource[]).includes(row.source) &&
      rule.types.has(row.type) &&
      age > rule.foldedAfterMs,
  );
}

/**
 * The externalId of the `stats:` row the fold writes for a sample's hour
 * (dense types) or day (mean types), in `tz`. Null for a type outside both
 * rules or without an HK identifier. Pure.
 */
export function coveringStatsExternalId(
  row: Pick<FoldedWindowCandidateRow, "type" | "measuredAt">,
  tz: string,
): string | null {
  const hk = hkIdentifierForType(row.type);
  if (!hk) return null;
  const dateKey = dayKeyForUserTz(row.measuredAt, tz);
  if (DENSE_INTRADAY_RETENTION_TYPES.has(row.type)) {
    return hourlyStatsExternalId(
      hk,
      dateKey,
      hourOfDayForUserTz(row.measuredAt, tz),
    );
  }
  if (HIGH_FREQUENCY_MEAN_TYPES.has(row.type)) {
    return dailyStatsExternalId(hk, dateKey);
  }
  return null;
}

type LookupClient = {
  measurement: Pick<Prisma.TransactionClient["measurement"], "findMany">;
  user: Pick<Prisma.TransactionClient["user"], "findUnique">;
};

/** The account's timezone, resolved the way the fold resolves it. */
export async function loadFoldTimezone(
  client: Pick<LookupClient, "user">,
  userId: string,
): Promise<string> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return resolveUserTimezone(user?.timezone ?? null);
}

/**
 * Indexes (into `rows`) whose covering `stats:` row is live under the row's
 * own source. One query per source present, each over the unique
 * `(user_id, type, source, external_id)` index for the whole set.
 */
async function coveredIndexes(
  client: Pick<LookupClient, "measurement">,
  userId: string,
  tz: string,
  rows: ReadonlyArray<{
    index: number;
    type: MeasurementType;
    source: MeasurementSource;
    measuredAt: Date;
  }>,
): Promise<Set<number>> {
  const covered = new Set<number>();
  if (rows.length === 0) return covered;
  const bySource = new Map<
    MeasurementSource,
    {
      keyOf: Map<number, string>;
      ids: Set<string>;
      types: Set<MeasurementType>;
    }
  >();
  for (const row of rows) {
    const id = coveringStatsExternalId(row, tz);
    if (!id) continue;
    let group = bySource.get(row.source);
    if (!group) {
      group = { keyOf: new Map(), ids: new Set(), types: new Set() };
      bySource.set(row.source, group);
    }
    group.keyOf.set(row.index, `${row.type}|${id}`);
    group.ids.add(id);
    group.types.add(row.type);
  }
  for (const [source, group] of bySource) {
    const live = await client.measurement.findMany({
      where: {
        userId,
        type: { in: [...group.types] },
        source,
        externalId: { in: [...group.ids] },
        deletedAt: null,
      },
      select: { type: true, externalId: true },
    });
    const liveKeys = new Set(
      live.map((row) => `${row.type}|${row.externalId}`),
    );
    for (const [index, key] of group.keyOf) {
      if (liveKeys.has(key)) covered.add(index);
    }
  }
  return covered;
}

/**
 * Indexes (into `rows`) of the incoming rows whose hour or day a live `stats:`
 * row already covers. Rows too young to have been folded are never looked up,
 * so a batch of current samples costs no query at all.
 */
export async function findFoldedWindowDuplicates(
  client: Pick<LookupClient, "measurement"> &
    Partial<Pick<LookupClient, "user">>,
  userId: string,
  rows: readonly FoldedWindowCandidateRow[],
  options: { now?: Date; tz?: string } = {},
): Promise<Set<number>> {
  const now = options.now ?? new Date();
  const candidates = rows.flatMap((row, index) =>
    isFoldedWindowCandidate(row, now)
      ? [
          {
            index,
            type: row.type,
            source: row.source,
            measuredAt: row.measuredAt,
          },
        ]
      : [],
  );
  if (candidates.length === 0) return new Set();
  let tz = options.tz;
  if (tz === undefined) {
    if (!client.user) throw new Error("folded_window lookup needs a timezone");
    tz = await loadFoldTimezone({ user: client.user }, userId);
  }
  return coveredIndexes(client, userId, tz, candidates);
}

/** A tombstone as the classifier reads it. */
export interface TombstoneCandidateRow extends FoldedWindowCandidateRow {
  deletedAt: Date | null;
}

/**
 * Indexes (into `rows`) of the compaction tombstones ("class A"): soft-deleted
 * raw samples of a folded source and type that were already past the fold
 * threshold when they were deleted, and whose hour or day a live `stats:` row
 * covers. Everything else, in particular a person's own deletions of recent
 * samples, is class B and keeps the 75-day tombstone retention.
 */
export async function findCompactionTombstones(
  client: Pick<LookupClient, "measurement">,
  userId: string,
  tz: string,
  rows: readonly TombstoneCandidateRow[],
): Promise<Set<number>> {
  const candidates = rows.flatMap((row, index) =>
    row.deletedAt !== null && isFoldedWindowCandidate(row, row.deletedAt)
      ? [
          {
            index,
            type: row.type,
            source: row.source,
            measuredAt: row.measuredAt,
          },
        ]
      : [],
  );
  return coveredIndexes(client, userId, tz, candidates);
}
