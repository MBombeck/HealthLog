/**
 * v1.4.30 — cross-source canonical-row picker for `Workout` rows.
 *
 * Same intent as `pickCanonicalSourceRows()` in
 * `src/lib/analytics/source-priority.ts`, applied to workouts. A user
 * wearing an Apple Watch + a Withings ScanWatch records the same run
 * once via each integration; the dashboard "Recent workouts" tile
 * would otherwise show the run twice.
 *
 * Algorithm (v1.4.30 — matches the measurement ladder per R-F open
 * question #4):
 *   1. Cluster workouts per user and sport-type by start time: sorted by
 *      start, a workout joins the open cluster when it starts less than
 *      five minutes after the cluster's first workout, and opens a new
 *      one otherwise. Two HKWorkout entries for the same logical run
 *      start within a minute of each other on both sources; the window
 *      gives the cross-source matcher slack without collapsing distinct
 *      back-to-back workouts, and anchoring on the first start keeps a
 *      row of workouts a few minutes apart from chaining into one.
 *   2. For each bucket, walk the source ladder (`workoutSourceLadder`)
 *      and pick the FIRST source that has any row in that bucket. Keep
 *      every row from the winning source; drop the rest.
 *   3. Rows whose source isn't in the ladder pass through untouched
 *      (fallback intent — never silently drop signal).
 *
 * Determinism precondition: input rows MUST be in deterministic order
 * (typically `ORDER BY startedAt ASC, id ASC` from the caller's
 * Prisma read). The output preserves input order.
 *
 * This is the one workout picker. The reads use it, and so does the batch
 * write route before it inserts: a write-time picker with its own window
 * and a different default ladder kept or dropped a different row than the
 * list then showed.
 */
import type { MeasurementSource } from "@/generated/prisma/client";

import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";

/**
 * Minimum row shape — same posture as `SourcePickerRow`. The helper
 * only consults the three fields; downstream callers can read every
 * other column they fetched alongside.
 */
export interface WorkoutPickerRow {
  userId?: string;
  startedAt: Date;
  /**
   * Session length. Together with `sportType` + `startedAt` this is the
   * exact-session identity used to collapse repeated same-source sync rows.
   * Optional only so fixtures can omit it; every production call site MUST
   * select it, and `workout-canonical-identity-guard.test.ts` freezes that set.
   */
  durationSec?: number;
  sportType: string;
  source: MeasurementSource;
  avgHeartRate?: number | null;
  maxHeartRate?: number | null;
  metadata?: unknown;
}

/**
 * The one definition of "the same workout session", for the reads and the
 * writes alike: the same source, the same sport, the same start to the
 * millisecond and the same duration to the second. Two rows with the same key
 * are one session stored twice.
 *
 * The reads apply it to the winning source's rows of a duplicate cluster
 * (`deduplicateWinningRows`): HealthKit can resend a session with a new
 * external UUID, and an Apple Health export stores a session the phone
 * already synced under its own key, because the export carries no UUID
 * (#1414). The writes apply it before they store an export workout and after
 * they store a HealthKit one, so the pair is merged into one row
 * (`src/lib/workouts/export-healthkit-twins.ts`), and migration 0562 merged
 * the pairs stored before that with the same rule in SQL.
 *
 * The identity is `(sportType, startedAt, durationSec)` within one source.
 * `endedAt` was part of this key when the collapse first shipped and has been
 * dropped deliberately:
 *
 *   - It is not a free extra check. On a workout with pauses, `endedAt` is the
 *     wall-clock end while `durationSec` counts only moving time, so the two
 *     legitimately disagree, and a stored row can carry either convention. Two
 *     re-sends of one session can therefore differ in `endedAt` alone, and the
 *     stricter key let that duplicate through.
 *   - It bought nothing in exchange. Nobody starts a second workout of the
 *     same sport in the same instant with the same duration, so start plus
 *     duration already identifies the session uniquely.
 *   - Requiring it split the callers. Four of the five call sites select
 *     `durationSec` but not `endedAt`, so the collapse ran on the workout list
 *     and silently did nothing for the Coach narration, the per-sport baseline
 *     and the deep-link cluster. One list, one number, two answers.
 *
 * A row without `durationSec` cannot be identified and passes through
 * uncollapsed. That is a fixture-only path: every production call site selects
 * the field and `workout-canonical-identity-guard.test.ts` keeps it that way.
 */
export function workoutSessionKey(row: WorkoutPickerRow): string | null {
  if (row.durationSec == null) return null;
  return [
    row.source,
    row.sportType,
    row.startedAt.getTime(),
    row.durationSec,
  ].join(":");
}

function rowRichness(row: WorkoutPickerRow): number {
  return (
    (row.avgHeartRate != null ? 2 : 0) +
    (row.maxHeartRate != null ? 2 : 0) +
    (row.metadata != null ? 1 : 0)
  );
}

function deduplicateWinningRows<T extends WorkoutPickerRow>(rows: T[]): T[] {
  const bySession = new Map<string, T>();
  const passthrough: T[] = [];
  for (const row of rows) {
    const key = workoutSessionKey(row);
    if (key == null) {
      passthrough.push(row);
      continue;
    }
    const existing = bySession.get(key);
    if (!existing || rowRichness(row) > rowRichness(existing)) {
      bySession.set(key, row);
    }
  }
  return [...passthrough, ...bySession.values()];
}

/**
 * The cross-source duplicate window. Two workouts of the same sport whose
 * starts lie less than five minutes apart are treated as the "same" workout
 * from different sources. iOS posts the HealthKit `startDate` rounded to the
 * second while Withings stamps its `startdate` independently; five minutes
 * gives both heads enough slack on a heavy-traffic morning sync without
 * crossing the "two back-to-back runs" boundary (a user does NOT do two
 * ten-minute runs five minutes apart in practice).
 *
 * This used to be a fixed five-minute clock slot (`floor(start / 5 min)`),
 * so two copies of one session thirty seconds apart that straddled a slot
 * boundary (08:04:50 and 08:05:20) were never compared. The window is now
 * measured from the cluster's first start. Where no two workouts of one sport
 * within the window straddle a slot boundary, the clusters are exactly the
 * old slots: every pair inside one slot is less than five minutes apart, and
 * a cluster cannot reach past its slot without such a pair.
 *
 * Because a cluster is anchored on its first start, which cluster a workout
 * lands in depends on the workouts before it. A reader that decides which row
 * is canonical therefore reads through `readWorkoutsAroundRange` in
 * `src/lib/workouts/canonical-read.ts`, which widens the read until the
 * clusters of the requested range no longer depend on where the read began.
 */
export const WORKOUT_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const DUPLICATE_WINDOW_MS = WORKOUT_DUPLICATE_WINDOW_MS;

/** Rows of different groups never share a duplicate cluster. */
export function workoutClusterGroup(row: WorkoutPickerRow): string {
  return `${row.userId ?? ""}:${row.sportType}`;
}

/**
 * The duplicate cluster of every row, aligned with `rows`. Rows of different
 * users or sports never share a cluster. Within one (user, sport), rows are
 * taken in start order (input order on equal starts) and a row joins the open
 * cluster while it starts less than {@link DUPLICATE_WINDOW_MS} after the
 * cluster's first row. The key names the cluster by that first row's start,
 * so it is stable for a given set of rows. Exported for the one reader that
 * has to look past the picked row: the strain engine, whose winner may carry
 * no heart-rate series while its dropped twin does.
 */
export function workoutDuplicateClusterKeys(
  rows: readonly WorkoutPickerRow[],
): string[] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const group = workoutClusterGroup(row);
    const list = groups.get(group);
    if (list) list.push(index);
    else groups.set(group, [index]);
  });
  const keys = new Array<string>(rows.length);
  for (const [group, indexes] of groups) {
    indexes.sort(
      (a, b) =>
        rows[a]!.startedAt.getTime() - rows[b]!.startedAt.getTime() || a - b,
    );
    let anchor = Number.NaN;
    for (const index of indexes) {
      const start = rows[index]!.startedAt.getTime();
      if (!(start - anchor < DUPLICATE_WINDOW_MS)) anchor = start;
      keys[index] = `${group}:${anchor}`;
    }
  }
  return keys;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const WHOOP_ZONE_DURATION_KEYS = [
  "zone_zero_milli",
  "zone_one_milli",
  "zone_two_milli",
  "zone_three_milli",
  "zone_four_milli",
  "zone_five_milli",
] as const;

function sanitizedWhoopZoneDurations(
  metadata: unknown,
): Record<string, number> | null {
  const raw = jsonRecord(jsonRecord(metadata)?.zoneDurations);
  if (!raw) return null;

  const sanitized: Record<string, number> = {};
  for (const key of WHOOP_ZONE_DURATION_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return null;
    }
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function enrichFromWhoopTwin<T extends WorkoutPickerRow>(
  winner: T,
  donor: T,
): T {
  const winnerMetadata = jsonRecord(winner.metadata);
  const donorZones = sanitizedWhoopZoneDurations(donor.metadata);
  const needsZones =
    donorZones != null && winnerMetadata?.zoneDurations == null;
  const needsAvg = winner.avgHeartRate == null && donor.avgHeartRate != null;
  const needsMax = winner.maxHeartRate == null && donor.maxHeartRate != null;

  if (!needsAvg && !needsMax && !needsZones) return winner;

  return {
    ...winner,
    ...(needsAvg ? { avgHeartRate: donor.avgHeartRate } : {}),
    ...(needsMax ? { maxHeartRate: donor.maxHeartRate } : {}),
    ...(needsZones
      ? {
          metadata: {
            ...(winnerMetadata ?? {}),
            zoneDurations: donorZones,
          },
        }
      : {}),
  };
}

/**
 * Pair winners and WHOOP donors one-to-one by nearest start time. A single
 * donor can never enrich two same-source occurrences that happen to share a
 * duplicate cluster. Stable input indexes break equal-distance ties.
 */
function enrichWinnersFromWhoop<T extends WorkoutPickerRow>(
  winners: readonly T[],
  donors: readonly T[],
): T[] {
  if (winners.length === 0 || donors.length === 0) return [...winners];

  const candidates: Array<{
    winnerIndex: number;
    donorIndex: number;
    deltaMs: number;
  }> = [];
  winners.forEach((winner, winnerIndex) => {
    donors.forEach((donor, donorIndex) => {
      candidates.push({
        winnerIndex,
        donorIndex,
        deltaMs: Math.abs(
          winner.startedAt.getTime() - donor.startedAt.getTime(),
        ),
      });
    });
  });
  candidates.sort(
    (left, right) =>
      left.deltaMs - right.deltaMs ||
      left.winnerIndex - right.winnerIndex ||
      left.donorIndex - right.donorIndex,
  );

  const enriched = [...winners];
  const matchedWinners = new Set<number>();
  const matchedDonors = new Set<number>();
  for (const candidate of candidates) {
    if (
      matchedWinners.has(candidate.winnerIndex) ||
      matchedDonors.has(candidate.donorIndex)
    ) {
      continue;
    }
    enriched[candidate.winnerIndex] = enrichFromWhoopTwin(
      winners[candidate.winnerIndex],
      donors[candidate.donorIndex],
    );
    matchedWinners.add(candidate.winnerIndex);
    matchedDonors.add(candidate.donorIndex);
  }
  return enriched;
}

/**
 * The source order for workouts: the `steps` metric's ladder, the
 * canonical-activity bucket the Sources settings configure, falling back to
 * its default when the user saved none or it does not parse.
 */
export function workoutSourceLadder(
  userPriorityJson: unknown,
): readonly MeasurementSource[] {
  return getSourceLadder(parseSourcePriority(userPriorityJson), "steps");
}

/**
 * Pick canonical rows across sources for a user's workouts.
 *
 * @param rows               input rows (deterministic order required)
 * @param userPriorityJson   the user's `sourcePriorityJson` blob — same
 *                           shape the measurement picker consults.
 *                           Falls back to the canonical default ladder
 *                           when null / unparseable.
 * @returns the subset of input rows that survives the picker. Insertion
 *          order preserved.
 */
export function pickCanonicalWorkoutRows<T extends WorkoutPickerRow>(
  rows: readonly T[],
  userPriorityJson: unknown = null,
): T[] {
  if (rows.length === 0) return [];

  const sourceLadder = workoutSourceLadder(userPriorityJson);

  const buckets = new Map<
    string,
    {
      rows: T[];
      sources: Set<MeasurementSource>;
    }
  >();
  const clusterKeys = workoutDuplicateClusterKeys(rows);
  for (const [index, row] of rows.entries()) {
    const key = clusterKeys[index]!;
    const slot = buckets.get(key) ?? { rows: [], sources: new Set() };
    slot.rows.push(row);
    slot.sources.add(row.source);
    buckets.set(key, slot);
  }

  const canonical: T[] = [];
  for (const [, slot] of buckets) {
    if (slot.rows.length === 1) {
      // No cross-source overlap → keep the single row regardless of
      // ladder membership.
      canonical.push(slot.rows[0]);
      continue;
    }

    let picked: MeasurementSource | undefined;
    for (const source of sourceLadder) {
      if (slot.sources.has(source)) {
        picked = source;
        break;
      }
    }

    if (!picked) {
      // None of the bucket's sources are listed in the ladder — never
      // silently drop. Keep every row in the bucket; downstream
      // callers can choose to surface a "duplicate from unrecognised
      // sources" diagnostic.
      canonical.push(...slot.rows);
      continue;
    }

    const winners = deduplicateWinningRows(
      slot.rows.filter((row) => row.source === picked),
    );
    const whoopDonors =
      picked === "WHOOP"
        ? []
        : slot.rows.filter((row) => row.source === "WHOOP");
    canonical.push(...enrichWinnersFromWhoop(winners, whoopDonors));
  }

  // Re-sort to preserve input order — the bucket map iterates in
  // insertion order but the per-bucket fan-out can interleave rows
  // from later buckets ahead of earlier-bucket survivors. Caller
  // wants the same `startedAt ASC` order it passed in.
  canonical.sort((a, b) => {
    const delta = a.startedAt.getTime() - b.startedAt.getTime();
    if (delta !== 0) return delta;
    // Stable-tiebreak on sportType so the output is deterministic
    // even when two surviving rows share startedAt (rare; manual
    // entries on the same second).
    return a.sportType.localeCompare(b.sportType);
  });
  return canonical;
}
