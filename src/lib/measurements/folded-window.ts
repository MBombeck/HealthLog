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
 * "Folded" means the fold has been able to reach the sample's whole window.
 * The folds stop at the start of the local day the threshold ends in
 * (`foldBoundary` in `consolidation-tz.ts`), so a window counts as folded only
 * when its local day lies entirely before that boundary, read in the account's
 * zone at the instant in question. A sample of a day the fold has not finished
 * is never refused, even if a `stats:` row for the day exists (a day an older
 * release folded in part): refusing it would lose a genuine late sample.
 *
 * Which `stats:` row covers a sample is decided by its externalId, built from
 * the account's current timezone exactly as the fold builds it
 * (`stats:<HK>:<YYYY-MM-DD>T<HH>` for a dense hour, `stats:<HK>:<YYYY-MM-DD>`
 * for a mean day). A dense day still folded at the pre-v1.28.31 daily grain is
 * deliberately NOT covered: the one-shot hourly rebuild reads those days'
 * tombstones, so they are neither refused at ingest by this rule nor purged.
 *
 * An account whose timezone changed after a fold keys its old windows in the
 * other zone, so the externalId alone misses them and an old sample would
 * re-enter beside its own mean. The ingest guard therefore also counts a
 * window as covered when a live `stats:` row of the same source, type and
 * grain sits within reach of the sample: the anchor of the window containing
 * an instant is at most 13 hours from it for a day (local noon, a 25-hour DST
 * day included; the reach allows 14) and 30 minutes for an hour (HH:30), in
 * any zone. Near local midnight the reach of a day also takes in the
 * neighbouring day's row, so a sample there whose own day has no row but
 * whose neighbour has one is refused too; the price of a check that cannot
 * know the zone the fold ran in. The classifier
 * of tombstones does not use that reach; a tombstone it misses stays class B,
 * which keeps a row longer, never loses one.
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

/**
 * Which sources and types fold into which window, and from what age.
 * `reachMs` is how far from a sample the anchor of its window can sit in any
 * zone (see the module comment), for the timezone-change check.
 */
export const FOLDED_WINDOW_RULES = [
  {
    window: "hour",
    sources: DENSE_INTRADAY_FOLD_SOURCES,
    types: DENSE_INTRADAY_RETENTION_TYPES,
    foldedAfterMs: DENSE_INTRADAY_RETENTION_DAYS * 24 * HOUR_MS,
    reachMs: HOUR_MS / 2,
  },
  {
    window: "day",
    sources: ["APPLE_HEALTH"] as const,
    types: HIGH_FREQUENCY_MEAN_TYPES,
    foldedAfterMs: CONSOLIDATION_GRACE_CUTOFF_HOURS * HOUR_MS,
    reachMs: 14 * HOUR_MS,
  },
] as const;

type FoldedWindowRule = (typeof FOLDED_WINDOW_RULES)[number];

function ruleFor(
  row: Pick<FoldedWindowCandidateRow, "type" | "source">,
): FoldedWindowRule | null {
  return (
    FOLDED_WINDOW_RULES.find(
      (rule) =>
        (rule.sources as readonly MeasurementSource[]).includes(row.source) &&
        rule.types.has(row.type),
    ) ?? null
  );
}

/**
 * Whether the fold had reached a row's whole window at instant `at`: its
 * local day (in `tz`) lies entirely before the fold boundary of that instant.
 * Day keys compare as strings. Pure.
 */
export function isWindowFoldedAt(
  row: Pick<FoldedWindowCandidateRow, "type" | "source" | "measuredAt">,
  at: Date,
  tz: string,
): boolean {
  const rule = ruleFor(row);
  if (!rule) return false;
  const firstOpenDay = dayKeyForUserTz(
    new Date(at.getTime() - rule.foldedAfterMs),
    tz,
  );
  return dayKeyForUserTz(row.measuredAt, tz) < firstOpenDay;
}

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
 * Whether a row is old enough, and of the right kind, for its hour or day
 * possibly to have been folded already. A cheap prefilter that needs no
 * timezone: every row {@link isWindowFoldedAt} accepts passes it, because a
 * day before the boundary ended before `now - threshold`. Pure: the aligned
 * check and whether a live `stats:` row actually covers the row are the
 * lookup's questions. `now` is the instant the age is measured at:
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
  const rule = ruleFor(row);
  return (
    rule !== null &&
    now.getTime() - row.measuredAt.getTime() > rule.foldedAfterMs
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

/** A live `stats:` row the coverage check reads. */
type LiveStatsRow = {
  type: MeasurementType;
  externalId: string | null;
  measuredAt: Date;
};

const HOURLY_KEY_RE = /:\d{4}-\d{2}-\d{2}T\d{2}$/;
const DAILY_KEY_RE = /:\d{4}-\d{2}-\d{2}$/;

/** Whether a `stats:` id is the grain the rule folds into, for that type. */
function isRuleGrain(
  rule: FoldedWindowRule,
  type: MeasurementType,
  externalId: string | null,
): boolean {
  const hk = hkIdentifierForType(type);
  if (!hk || externalId === null) return false;
  if (!externalId.startsWith(`stats:${hk}:`)) return false;
  return rule.window === "hour"
    ? HOURLY_KEY_RE.test(externalId)
    : DAILY_KEY_RE.test(externalId);
}

/** Candidates whose time span per query stays within this many days. */
const REACH_QUERY_SPAN_MS = 31 * 24 * HOUR_MS;

/**
 * Indexes (into `rows`) whose covering `stats:` row is live under the row's
 * own source. One query per source present, each over the unique
 * `(user_id, type, source, external_id)` index for the whole set. With
 * `reach`, a row is also covered by a live `stats:` row of the same source,
 * type and grain anchored within the rule's reach of it (the timezone-change
 * check), read in spans of at most a month so the read stays bounded.
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
  options: { reach: boolean },
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
  if (!options.reach) return covered;

  // The timezone-change check, for the rows the externalId did not cover.
  const open = rows
    .filter((row) => !covered.has(row.index) && ruleFor(row) !== null)
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  const bySourceOpen = new Map<MeasurementSource, typeof open>();
  for (const row of open) {
    const list = bySourceOpen.get(row.source) ?? [];
    list.push(row);
    bySourceOpen.set(row.source, list);
  }
  const maxReach = Math.max(...FOLDED_WINDOW_RULES.map((r) => r.reachMs));
  for (const [source, list] of bySourceOpen) {
    let start = 0;
    while (start < list.length) {
      const spanStart = list[start].measuredAt.getTime();
      let end = start;
      while (
        end + 1 < list.length &&
        list[end + 1].measuredAt.getTime() - spanStart <= REACH_QUERY_SPAN_MS
      ) {
        end += 1;
      }
      const span = list.slice(start, end + 1);
      start = end + 1;
      const types = [...new Set(span.map((row) => row.type))];
      const nearby: LiveStatsRow[] = await client.measurement.findMany({
        where: {
          userId,
          type: { in: types },
          source,
          externalId: { startsWith: "stats:" },
          deletedAt: null,
          measuredAt: {
            gte: new Date(spanStart - maxReach),
            lte: new Date(
              span[span.length - 1].measuredAt.getTime() + maxReach,
            ),
          },
        },
        select: { type: true, externalId: true, measuredAt: true },
        orderBy: { measuredAt: "asc" },
      });
      for (const row of span) {
        const rule = ruleFor(row);
        if (!rule) continue;
        const t = row.measuredAt.getTime();
        const hit = nearby.some(
          (stats) =>
            stats.type === row.type &&
            isRuleGrain(rule, row.type, stats.externalId) &&
            Math.abs(stats.measuredAt.getTime() - t) <= rule.reachMs,
        );
        if (hit) covered.add(row.index);
      }
    }
  }
  return covered;
}

/**
 * Indexes (into `rows`) of the incoming rows whose hour or day the fold has
 * finished and a live `stats:` row covers (by its externalId, or within reach
 * after a timezone change). Rows too young to have been folded are never
 * looked up, so a batch of current samples costs no query at all.
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
  const zone = tz;
  return coveredIndexes(
    client,
    userId,
    zone,
    candidates.filter((row) => isWindowFoldedAt(row, now, zone)),
    { reach: true },
  );
}

/** A tombstone as the classifier reads it. */
export interface TombstoneCandidateRow extends FoldedWindowCandidateRow {
  deletedAt: Date | null;
}

/**
 * The covering `stats:` id of a tombstone that has the shape of a compaction
 * tombstone, or null: a soft-deleted raw sample of a folded source and type
 * whose whole window the fold had reached when it was deleted. Whether that
 * `stats:` row is live is the caller's question. Pure; the restore asks it of
 * a backup file's rows.
 *
 * The window must have been complete at deletion, not merely the sample old
 * enough: an older release folded a day in two runs, and a person who
 * deleted a sample of such a half-folded day deleted something the fold had
 * not taken. That deletion is class B.
 */
export function compactionTombstoneCoverId(
  row: TombstoneCandidateRow,
  tz: string,
): string | null {
  if (row.deletedAt === null) return null;
  if (!isFoldedWindowCandidate(row, row.deletedAt)) return null;
  if (!isWindowFoldedAt(row, row.deletedAt, tz)) return null;
  return coveringStatsExternalId(row, tz);
}

/**
 * Indexes (into `rows`) of the compaction tombstones ("class A"): rows that
 * {@link compactionTombstoneCoverId} accepts and whose covering `stats:` row
 * is live under the row's own source. Everything else, in particular a
 * person's own deletions, is class B and keeps the 75-day tombstone retention.
 */
export async function findCompactionTombstones(
  client: Pick<LookupClient, "measurement">,
  userId: string,
  tz: string,
  rows: readonly TombstoneCandidateRow[],
): Promise<Set<number>> {
  const candidates = rows.flatMap((row, index) =>
    compactionTombstoneCoverId(row, tz) !== null
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
  return coveredIndexes(client, userId, tz, candidates, { reach: false });
}
