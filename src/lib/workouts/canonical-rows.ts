/**
 * v1.4.42 W5 — write-time cross-source canonical-row picker for
 * incoming `Workout` ingest payloads.
 *
 * Why this exists alongside the read-time helper
 * ──────────────────────────────────────────────
 *
 * Two related-but-distinct dedup paths exist in the codebase:
 *
 *   - `pickCanonicalWorkoutRows()` in `src/lib/measurements/` (v1.4.30)
 *     — READ-time picker invoked by `GET /api/workouts` /
 *     `GET /api/workouts/[id]`. It walks DB rows, looks up the user's
 *     persisted `sourcePriorityJson`, buckets by 5-minute slot, and
 *     filters the read result so the dashboard tile shows one row per
 *     logical workout.
 *
 *   - This helper (`dedupeWorkoutBatch`, v1.4.42) — WRITE-time picker
 *     invoked by `POST /api/workouts/batch` BEFORE
 *     `prisma.workout.createMany`. The name intentionally diverges
 *     from the read-time picker to make the auto-completion path
 *     unambiguous (write-time payload-internal dedup vs. read-time
 *     cross-batch dedup with user-priority resolution).
 *     The v1.5 iOS sprint will ingest `HKWorkoutType` data in batches
 *     against `/api/workouts/batch`; Apple Watch + Withings ScanWatch
 *     paired to the same iPhone frequently capture the same workout
 *     simultaneously (e.g. a Sunday-morning run) and the iOS app may
 *     post both rows in one batch. Without write-time dedup, both
 *     rows would persist (their `externalId`s differ, so the
 *     `(userId, source, externalId)` unique index doesn't fire) and
 *     the read-time picker would carry the duplicate forward at every
 *     downstream read.
 *
 * The two pickers are layered, not redundant:
 *   - Write-time picker drops PAYLOAD-internal duplicates inside a
 *     single batch so we don't pay the storage cost.
 *   - Read-time picker still runs to collapse cross-batch duplicates
 *     (e.g. Apple Watch row from Monday's batch + ScanWatch row from
 *     Tuesday's backfill batch).
 *
 * Algorithm
 * ─────────
 *
 *   1. Group by `(userId, activityType, startedAt ± 90 s window)`.
 *      The 90-second window is tighter than the read-time picker's
 *      5-minute slot because a single batch from one iOS client has
 *      no cross-device clock skew to absorb — both rows are stamped
 *      with HealthKit's `startDate`, which Apple aggregates to the
 *      same instant across paired sensors. A 90-second cushion
 *      covers HK's documented ±60s smoothing plus a small buffer.
 *   2. Groups containing one source are not duplicates and remain
 *      unchanged. For a cross-source group, select the winning source
 *      in order `APPLE_HEALTH ≻ WITHINGS ≻ MANUAL ≻ IMPORT`, then keep
 *      every row from that source. The literal source ladder comes from
 *      `DEFAULT_WORKOUT_SOURCE_PRIORITY` so both pickers share one source
 *      of truth.
 *   3. When two sources share a priority tier, prefer the source whose
 *      best candidate has higher `caloriesKcal`, then earliest `createdAt`,
 *      then input order. These tie-breakers choose a source; they never
 *      collapse multiple workouts recorded by that winning source.
 *
 * Purity contract
 * ───────────────
 *
 * Zero Prisma imports, zero IO, zero user lookups. The helper takes
 * an array, returns an array. Testable in isolation; safely invoked
 * from a hot ingest path with no DB round-trip cost.
 *
 * Source-priority parity with the read-time picker
 * ────────────────────────────────────────────────
 *
 * CLOSED in v1.4.43 (W9-WORKOUTS-PRIORITY). The read-time picker
 * resolves the per-user `sourcePriorityJson` (from
 * `User.sourcePriorityJson`) for every read so a user who promoted
 * MANUAL above APPLE_HEALTH in Settings → Sources sees their Manual
 * rows surface above the Apple Watch ones. This helper now mirrors
 * that contract — the optional `userPriorityJson` argument feeds
 * through `parseSourcePriority()` + `getSourceLadder(..., "steps")`,
 * the same chain the read-time picker walks, so a customised user
 * keeps their preferred source at BOTH write- and read-time.
 *
 * When the argument is omitted (or null/undefined) the helper falls
 * back to the canonical `DEFAULT_WORKOUT_SOURCE_PRIORITY` ladder so
 * callers that don't yet have the user blob handy stay on the
 * v1.4.42 behaviour. The batch route at
 * `src/app/api/workouts/batch/route.ts` does one indexed
 * `User.sourcePriorityJson` lookup at the start of the handler and
 * passes the blob through here; the cost is a single `findUnique`
 * per batch, well under the cost of letting a customised user's
 * preferred row drop at write-time.
 */

import { DEFAULT_WORKOUT_SOURCE_PRIORITY } from "@/lib/sources/pick-canonical-workout";
import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";
import type { MeasurementSource } from "@/generated/prisma/client";

/**
 * Minimum row shape consulted by the picker. Field names mirror the
 * batch-route's prepared `Prisma.WorkoutCreateManyInput` plus a
 * `createdAt` slot for the deterministic tie-breaker. Anything else
 * the caller carried alongside the row (route geometry, HR series,
 * metadata) survives untouched — the picker filters but never
 * mutates and is generic in `T` so call sites keep their own
 * carrier type.
 *
 * Naming aligned with the v1.5 iOS contract:
 *   - `activityType` — the sport type (`"running"`, `"cycling"`,
 *     ...). Matches `Workout.sportType` at the DB layer and
 *     `WorkoutSportType` at the validator layer; cross-source
 *     overlap requires identical sport so a "Walking" + "Running"
 *     pair at the same instant stays as two distinct rows.
 *   - `caloriesKcal` — the active-energy aggregate. The v1.5 iOS
 *     contract uses `caloriesKcal` for parity with HealthKit's
 *     `HKQuantityTypeIdentifierActiveEnergyBurned`; the server's
 *     write path maps it to `Workout.totalEnergyKcal`.
 *   - `createdAt` — when the row was minted. The batch path doesn't
 *     have this yet (it's set by Prisma's `@default(now())` at
 *     insert), so the helper falls back to insertion order via the
 *     `index` field when `createdAt` is undefined on every member.
 */
export interface WorkoutRow {
  userId: string;
  activityType: string;
  startedAt: Date;
  source: MeasurementSource;
  caloriesKcal?: number | null;
  /**
   * Optional row-mint timestamp. The write-time picker is called
   * BEFORE `createMany`, so prepared rows usually have no
   * `createdAt` yet — undefined falls through to the next
   * tie-breaker (insertion order via the `index` field).
   */
  createdAt?: Date | null;
  /**
   * Stable per-batch ordinal. Set by the caller (e.g. the position
   * of the entry in the inbound payload) so two rows with identical
   * priority + calories + createdAt still resolve deterministically.
   * Optional; defaults to 0 so single-row groups never need it.
   */
  index?: number;
}

/**
 * Cross-source dedup window. Within a single ingest batch from one
 * iOS client, two rows whose `startedAt` falls within ±90 s AND
 * share the same `activityType` AND belong to the same user are
 * treated as the same logical workout. The window is symmetric:
 * the comparison uses `|a.startedAt - b.startedAt| ≤ 90 000 ms`.
 */
export const WORKOUT_DEDUP_WINDOW_MS = 90 * 1000;

/**
 * Source-priority rank lookup. Lower rank = higher priority. A
 * source absent from the ladder gets a rank past the end of the
 * array — the picker still keeps that row when no ladder-listed
 * row competes for the slot (single-source group), but loses to
 * any ladder-listed competitor.
 *
 * The ladder is resolved per-call (from the user's
 * `sourcePriorityJson` or the canonical default), so the rank
 * function is parameterised on the ladder rather than reading a
 * module-level constant.
 */
function sourceRank(
  source: MeasurementSource,
  ladder: readonly MeasurementSource[],
): number {
  const idx = ladder.indexOf(source);
  return idx === -1 ? ladder.length : idx;
}

/**
 * Comparator: returns negative when `a` should win over `b`.
 * Priority order: source rank → higher calories → earliest
 * createdAt → earliest input index.
 */
function compareCandidates<T extends WorkoutRow>(
  a: T,
  b: T,
  ladder: readonly MeasurementSource[],
): number {
  const sourceDelta =
    sourceRank(a.source, ladder) - sourceRank(b.source, ladder);
  if (sourceDelta !== 0) return sourceDelta;

  // Tie-breaker 1 — higher caloriesKcal wins (more sensor data).
  // `null` / `undefined` calories sort below any numeric value.
  const aCal = a.caloriesKcal ?? -1;
  const bCal = b.caloriesKcal ?? -1;
  if (aCal !== bCal) return bCal - aCal;

  // Tie-breaker 2 — earliest `createdAt` wins (stable across
  // re-runs). Undefined sorts below any concrete date so a
  // pre-insert row (no createdAt yet) doesn't beat an already-
  // persisted row carrying a real timestamp.
  const aCreated = a.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bCreated = b.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aCreated !== bCreated) return aCreated - bCreated;

  // Tie-breaker 3 — input order. Guarantees determinism even when
  // every other field ties (rare; same source, same calories,
  // same / no createdAt). Default of 0 keeps single-row groups
  // untouched.
  return (a.index ?? 0) - (b.index ?? 0);
}

/**
 * Pick canonical rows across sources for an inbound ingest batch.
 *
 * Group by `(userId, activityType, startedAt ± 90 s)`; a group with
 * multiple sources keeps every row from its highest-priority source.
 * Single-source overlaps pass through unchanged. The returned
 * array preserves the input order of the surviving rows so a
 * caller that pre-sorted by `startedAt ASC` keeps that ordering
 * downstream.
 *
 * Implementation walks the input once with a union-find-style
 * pass: each row joins an existing group whose anchor falls
 * within the dedup window AND matches `(userId, activityType)`,
 * or seeds a new group. The anchor is the FIRST row that landed
 * in the group; subsequent rows compare against the anchor so the
 * window can't drift across an arbitrarily long chain of
 * within-window-of-neighbour rows. This is O(n²) worst case but
 * a typical batch is ≤ 100 entries so the constant is fine.
 */
export function dedupeWorkoutBatch<T extends WorkoutRow>(
  rows: readonly T[],
  userPriorityJson?: unknown,
): T[] {
  if (rows.length === 0) return [];

  // Resolve the source ladder from the user's persisted preference
  // when one was supplied. The read-time picker
  // (`pickCanonicalWorkoutRows`) keys workouts off the `steps` metric
  // ladder — the canonical-activity bucket — so both pickers consult
  // the same per-user configuration surface. When no preference is
  // supplied (legacy callers, tests that don't care, or a route that
  // hasn't been wired yet), fall back to the canonical default
  // ladder so behaviour matches the v1.4.42 baseline.
  const ladder: readonly MeasurementSource[] =
    userPriorityJson == null
      ? DEFAULT_WORKOUT_SOURCE_PRIORITY
      : getSourceLadder(parseSourcePriority(userPriorityJson), "steps");

  // Stamp each input with its original index so the comparator
  // has a stable tie-breaker without mutating the caller's row.
  type Tagged = { row: T; origIndex: number };
  const tagged: Tagged[] = rows.map((row, origIndex) => ({ row, origIndex }));

  // Group anchors: each group is a list of (row, origIndex). The
  // anchor row sets the window comparison reference.
  const groups: Tagged[][] = [];

  for (const entry of [...tagged].sort((a, b) => {
    const delta = a.row.startedAt.getTime() - b.row.startedAt.getTime();
    return delta || a.origIndex - b.origIndex;
  })) {
    let placed = false;
    for (const group of groups) {
      const anchor = group[0]!.row;
      if (
        anchor.userId === entry.row.userId &&
        anchor.activityType === entry.row.activityType &&
        Math.abs(anchor.startedAt.getTime() - entry.row.startedAt.getTime()) <=
          WORKOUT_DEDUP_WINDOW_MS
      ) {
        group.push(entry);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push([entry]);
    }
  }

  // Preserve single-source groups. For genuine cross-source overlaps,
  // select the winning source and retain every row it contributed.
  const survivors: Tagged[] = [];
  for (const group of groups) {
    if (group.length === 1) {
      survivors.push(group[0]!);
      continue;
    }
    const sources = new Set(group.map((entry) => entry.row.source));
    if (sources.size === 1) {
      survivors.push(...group);
      continue;
    }
    const annotated = group.map((entry) => ({
      ...entry,
      row: {
        ...entry.row,
        index: entry.row.index ?? entry.origIndex,
      } as T,
    }));
    annotated.sort((a, b) => compareCandidates(a.row, b.row, ladder));
    const winningSource = annotated[0]!.row.source;
    survivors.push(
      ...group.filter((entry) => entry.row.source === winningSource),
    );
  }

  survivors.sort((a, b) => a.origIndex - b.origIndex);
  return survivors.map((entry) => entry.row);
}
