/**
 * The read every surface that decides which workout is canonical goes through.
 *
 * `pickCanonicalWorkoutRows` clusters workouts of one sport by start time,
 * anchored on each cluster's first start (see `workoutDuplicateClusterKeys`).
 * That makes the cluster of a workout depend on the workouts around it: on
 * the twin a few minutes after it, which may lie past the end of the range a
 * surface asked for, and on the run of workouts before it, which decides where
 * the anchors fall. A surface that handed the picker only the rows inside its
 * own range got an answer that depended on the range: the list and the detail
 * of one workout disagreed about which row was canonical, and 09:58, 10:02 and
 * 10:06 were grouped one way by a read starting at 09:55 and another way by a
 * read starting at 10:00.
 *
 * `readWorkoutsAroundRange` reads the range plus one duplicate window after its
 * end, and before its start as far as it takes to reach, for every sport with a
 * row in the range, a workout that starts a full window after the one before
 * it. Such a workout is an anchor whatever comes before it, so from there on
 * the clusters are the ones a read of the whole history would produce. The
 * surfaces then pick over everything read and keep the rows that start inside
 * their range: a workout is canonical, or not, the same way on every surface.
 *
 * The reader is async and calls the callback before it first awaits, so in a
 * `Promise.all` it goes after the plain Prisma calls: an element before it
 * that threw while the array was being built would leave its rejection
 * unhandled.
 *
 * A read callback may still carry a row cap as a runaway guard. A capped read
 * that actually hits its cap has lost rows at one end and is outside this
 * guarantee; the caps sit far above any real account's volume.
 */
import {
  pickCanonicalWorkoutRows,
  WORKOUT_DUPLICATE_WINDOW_MS,
  workoutClusterGroup,
  workoutDuplicateClusterKeys,
  workoutSourceLadder,
  type WorkoutPickerRow,
} from "@/lib/measurements/pick-canonical-workout-rows";

/**
 * The columns a read needs for the canonical pick and nothing more: the
 * session identity (`sportType`, `startedAt`, `durationSec`), the source the
 * ladder ranks, and the id the windowed read orders by.
 */
export const WORKOUT_PICK_SELECT = {
  id: true,
  source: true,
  sportType: true,
  startedAt: true,
  durationSec: true,
} as const;

/** A row the windowed read can order deterministically. */
export type CanonicalReadRow = WorkoutPickerRow & { id: string };

/**
 * The range of starts a surface asks about. `null` leaves that side open.
 * `inclusiveEnd` makes `to` part of the range (`lte`), as the list's `until`
 * and the doctor report's end are.
 */
export interface WorkoutStartRange {
  from: Date | null;
  to: Date | null;
  inclusiveEnd?: boolean;
}

/** The `startedAt` bounds one read callback must apply. */
export interface WorkoutStartBounds {
  gte?: Date;
  lt?: Date;
}

/**
 * Reads the caller's workouts whose start lies inside `bounds`, with every
 * other filter (user, sport) the caller applies. Called more than once when
 * the read has to reach further back.
 */
export type WorkoutBoundedRead<T extends CanonicalReadRow> = (
  bounds: WorkoutStartBounds,
) => Promise<T[]>;

/**
 * Rows read for a range, in `startedAt ASC, id ASC` order, together with the
 * range they were read for. Only `readWorkoutsAroundRange` builds one, so a
 * picker call below cannot be handed rows that were read without the margin.
 */
export interface WindowedWorkouts<T extends CanonicalReadRow> {
  readonly rows: readonly T[];
  readonly range: WorkoutStartRange;
  readonly __windowed: true;
}

/**
 * How many times the read reaches further back before it stops. Each step
 * doubles the reach, so the last one covers more than a week of workouts
 * every one of which started less than five minutes after the previous one.
 */
const MAX_BACKWARD_STEPS = 12;

function compareRows(a: CanonicalReadRow, b: CanonicalReadRow): number {
  const delta = a.startedAt.getTime() - b.startedAt.getTime();
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The earliest start that is not yet known to be an anchor, among the sports
 * that have a row at or after `from`. A sport's earliest row read is an anchor
 * once the read reaches a full window before it (nothing of that sport starts
 * inside that window, or the read would hold it). `null` when every sport is
 * settled.
 */
function earliestUnsettledStart(
  rows: readonly CanonicalReadRow[],
  from: Date,
  lowerMs: number,
): number | null {
  const earliest = new Map<string, number>();
  const relevant = new Set<string>();
  for (const row of rows) {
    const group = workoutClusterGroup(row);
    const start = row.startedAt.getTime();
    const known = earliest.get(group);
    if (known === undefined || start < known) earliest.set(group, start);
    if (start >= from.getTime()) relevant.add(group);
  }
  let unsettled: number | null = null;
  for (const group of relevant) {
    const start = earliest.get(group)!;
    if (start - WORKOUT_DUPLICATE_WINDOW_MS < lowerMs) {
      unsettled = unsettled === null ? start : Math.min(unsettled, start);
    }
  }
  return unsettled;
}

export async function readWorkoutsAroundRange<T extends CanonicalReadRow>(
  range: WorkoutStartRange,
  read: WorkoutBoundedRead<T>,
): Promise<WindowedWorkouts<T>> {
  const window = WORKOUT_DUPLICATE_WINDOW_MS;
  // A cluster is never wider than one window from its anchor, and an anchor
  // of the range starts no later than the range's end.
  const upper = range.to ? new Date(range.to.getTime() + window) : undefined;
  const from = range.from;
  let lowerMs = from ? from.getTime() - window : null;

  const rows: T[] = [
    ...(await read({
      gte: lowerMs === null ? undefined : new Date(lowerMs),
      lt: upper,
    })),
  ];

  if (from && lowerMs !== null) {
    for (let step = 0; step < MAX_BACKWARD_STEPS; step += 1) {
      const unsettled = earliestUnsettledStart(rows, from, lowerMs);
      if (unsettled === null) break;
      const nextMs: number = Math.min(
        unsettled - window,
        lowerMs - window * 2 ** step,
      );
      const earlier = await read({
        gte: new Date(nextMs),
        lt: new Date(lowerMs),
      });
      lowerMs = nextMs;
      // Nothing between the new and the old bound: every unsettled sport now
      // has a full window of nothing before its earliest row.
      if (earlier.length === 0) break;
      rows.push(...earlier);
    }
  }

  rows.sort(compareRows);
  return { rows, range, __windowed: true };
}

/** Whether a start lies inside the range a surface asked about. */
export function startsInRange(range: WorkoutStartRange, at: Date): boolean {
  const t = at.getTime();
  if (range.from && t < range.from.getTime()) return false;
  if (range.to) {
    const end = range.to.getTime();
    if (range.inclusiveEnd ? t > end : t >= end) return false;
  }
  return true;
}

/** The rows read that start inside the requested range. */
export function rowsInRange<T extends CanonicalReadRow>(
  windowed: WindowedWorkouts<T>,
): T[] {
  return windowed.rows.filter((row) =>
    startsInRange(windowed.range, row.startedAt),
  );
}

function clusterKeyById<T extends CanonicalReadRow>(
  windowed: WindowedWorkouts<T>,
): Map<string, string> {
  const keys = workoutDuplicateClusterKeys(windowed.rows);
  return new Map(windowed.rows.map((row, index) => [row.id, keys[index]!]));
}

/**
 * The canonical workouts that start inside the range, oldest first.
 *
 * `excludeClusterOf` leaves out the cluster of one workout: a baseline that
 * compares a session against the others of its sport must drop the session's
 * twins along with the session itself. Removing the row from the read instead
 * left its twin behind as a second session, and moved the cluster anchors of
 * whatever followed.
 */
export function canonicalWorkoutsInRange<T extends CanonicalReadRow>(
  windowed: WindowedWorkouts<T>,
  priorityJson: unknown,
  options: { excludeClusterOf?: string } = {},
): T[] {
  const picked = pickCanonicalWorkoutRows(windowed.rows, priorityJson).filter(
    (row) => startsInRange(windowed.range, row.startedAt),
  );
  if (!options.excludeClusterOf) return picked;
  const keyById = clusterKeyById(windowed);
  const excluded = keyById.get(options.excludeClusterOf);
  if (excluded === undefined) return picked;
  return picked.filter((row) => keyById.get(row.id) !== excluded);
}

/**
 * The duplicate cluster of one workout: its rows in start order, and the
 * canonical ones among them, nearest to the workout's own start first. `null`
 * when the workout is not among the rows read.
 */
export function canonicalClusterOf<T extends CanonicalReadRow>(
  windowed: WindowedWorkouts<T>,
  workoutId: string,
  priorityJson: unknown,
): { members: T[]; canonical: T[] } | null {
  const self = windowed.rows.find((row) => row.id === workoutId);
  if (!self) return null;
  const keyById = clusterKeyById(windowed);
  const key = keyById.get(workoutId);
  const members = windowed.rows.filter((row) => keyById.get(row.id) === key);
  const at = self.startedAt.getTime();
  const canonical = pickCanonicalWorkoutRows(members, priorityJson).sort(
    (a, b) =>
      Number(b.id === workoutId) - Number(a.id === workoutId) ||
      Math.abs(a.startedAt.getTime() - at) -
        Math.abs(b.startedAt.getTime() - at) ||
      compareRows(a, b),
  );
  return { members, canonical };
}

/**
 * The write-time pick of the batch route. The incoming rows are clustered
 * together with the stored workouts around them, so a cluster boundary falls
 * where every read will later draw it. An incoming row is dropped only when
 * another incoming row of its cluster is the one kept: a row that loses to a
 * stored workout is still written (the reads hide it), as before.
 *
 * Returns the incoming rows to keep, in their input order.
 */
export function incomingWorkoutsToKeep<
  S extends CanonicalReadRow,
  I extends WorkoutPickerRow,
>(
  stored: WindowedWorkouts<S>,
  incoming: readonly I[],
  priorityJson: unknown,
): I[] {
  type Tagged = WorkoutPickerRow & { tag: number };
  // Stored rows first on an equal start, which is where a read that orders by
  // start finds them relative to rows written after them.
  const union: Tagged[] = [
    ...stored.rows.map((row) => ({ ...row, tag: -1 })),
    ...incoming.map((row, index) => ({ ...row, tag: index })),
  ].sort(
    (a, b) =>
      a.startedAt.getTime() - b.startedAt.getTime() ||
      Number(a.tag >= 0) - Number(b.tag >= 0) ||
      a.tag - b.tag,
  );
  const keys = workoutDuplicateClusterKeys(union);
  const keyByTag = new Map<number, string>();
  union.forEach((row, index) => {
    if (row.tag >= 0) keyByTag.set(row.tag, keys[index]!);
  });
  const keptTags = new Set(
    pickCanonicalWorkoutRows(union, priorityJson)
      .map((row) => row.tag)
      .filter((tag) => tag >= 0),
  );
  const clustersWithIncomingWinner = new Set(
    [...keptTags].map((tag) => keyByTag.get(tag)!),
  );
  return incoming.filter(
    (_, index) =>
      keptTags.has(index) ||
      !clustersWithIncomingWinner.has(keyByTag.get(index)!),
  );
}

/**
 * The stored workout an incoming one duplicates: the canonical stored row of
 * the incoming row's cluster, nearest start first, clustered with the stored
 * rows around it exactly as `incomingWorkoutsToKeep` clusters a batch. When
 * none of the cluster's stored sources is on the ladder (every one is kept),
 * the nearest of them. `null` when the incoming row shares its cluster with
 * no stored row. A file importer uses it to hand the file's series to the
 * workout the list shows instead of storing a second copy.
 */
export function storedTwinOf<S extends CanonicalReadRow>(
  stored: WindowedWorkouts<S>,
  incoming: WorkoutPickerRow,
  priorityJson: unknown,
): S | null {
  type Tagged = WorkoutPickerRow & { row: S | null };
  const union: Tagged[] = [
    ...stored.rows.map((row) => ({ ...row, row })),
    { ...incoming, row: null },
  ].sort(
    (a, b) =>
      a.startedAt.getTime() - b.startedAt.getTime() ||
      Number(a.row === null) - Number(b.row === null),
  );
  const keys = workoutDuplicateClusterKeys(union);
  const ownKey = keys[union.findIndex((t) => t.row === null)];
  const members = union
    .filter((t, i) => t.row !== null && keys[i] === ownKey)
    .map((t) => t.row!);
  if (members.length === 0) return null;
  const at = incoming.startedAt.getTime();
  const picked = pickCanonicalWorkoutRows(members, priorityJson);
  const pickedIds = new Set(picked.map((row) => row.id));
  const pool = members.filter((row) => pickedIds.has(row.id));
  return [...(pool.length > 0 ? pool : members)].sort(
    (a, b) =>
      Math.abs(a.startedAt.getTime() - at) -
        Math.abs(b.startedAt.getTime() - at) || compareRows(a, b),
  )[0]!;
}

/**
 * One training impulse per workout SESSION, not per stored row.
 *
 * The same session can be stored more than once: the watch writes it to Apple
 * Health and a second service (Strava, WHOOP, a ring) syncs it again, or
 * HealthKit re-sends it under a new identifier. The workout list collapses
 * those through `pickCanonicalWorkoutRows`; summing every row here counted the
 * session twice in the day's TRIMP while the list showed it once.
 *
 * The picker chooses the row by source order, which says nothing about heart
 * rate: the winning row can be one without a series while its dropped twin
 * carries one. So the impulse of a slot is the sum over its picked rows, and
 * only when that is zero the largest impulse among the slot's dropped rows.
 *
 * The picker keeps every row of a slot none of whose sources is on the
 * ladder, so the picked rows of one slot can come from several sources. Only
 * one source's rows count: the best-ranked on the ladder, a source off the
 * ladder ranking below every listed one, and among sources off the ladder
 * the one with the largest impulse. Rows of that one source still add up
 * (two distinct sessions of the same sport in one duplicate cluster).
 *
 * `belongs` keeps the sessions of the scored range: the rows come from a
 * windowed read that reaches past the day on both sides, and a session counts
 * on the day its earliest picked row starts, the day the list shows it on.
 * Returns the positive impulses, one per session. Pure; the strain
 * engine's day TRIMP sums it, and the tests call it directly.
 */
export function canonicalWorkoutTrimps<
  T extends WorkoutPickerRow & { id: string },
>(
  rows: readonly T[],
  priorityJson: unknown,
  trimpOf: (row: T) => number,
  belongs: (startedAt: Date) => boolean = () => true,
): number[] {
  // By id: the picker may hand back a copy of a row (it fills a missing heart
  // rate from a WHOOP twin).
  const picked = new Set(
    pickCanonicalWorkoutRows(rows, priorityJson).map((row) => row.id),
  );
  const ladder = workoutSourceLadder(priorityJson);
  const rankOf = (source: string) => {
    const index = ladder.indexOf(source as (typeof ladder)[number]);
    return index === -1 ? ladder.length : index;
  };
  const slots = new Map<
    string,
    {
      picked: Map<string, number>;
      dropped: number;
      firstPickedAt: Date | null;
    }
  >();
  const keys = workoutDuplicateClusterKeys(rows);
  for (const [index, row] of rows.entries()) {
    const slot = slots.get(keys[index]!) ?? {
      picked: new Map(),
      dropped: 0,
      firstPickedAt: null,
    };
    if (
      picked.has(row.id) &&
      (slot.firstPickedAt === null || row.startedAt < slot.firstPickedAt)
    ) {
      slot.firstPickedAt = row.startedAt;
    }
    const trimp = trimpOf(row);
    if (trimp > 0) {
      if (picked.has(row.id)) {
        slot.picked.set(row.source, (slot.picked.get(row.source) ?? 0) + trimp);
      } else {
        slot.dropped = Math.max(slot.dropped, trimp);
      }
    }
    slots.set(keys[index]!, slot);
  }
  const out: number[] = [];
  for (const slot of slots.values()) {
    if (slot.firstPickedAt === null || !belongs(slot.firstPickedAt)) continue;
    let best: { rank: number; trimp: number } | null = null;
    for (const [source, trimp] of slot.picked) {
      const rank = rankOf(source);
      if (
        best === null ||
        rank < best.rank ||
        (rank === best.rank && trimp > best.trimp)
      ) {
        best = { rank, trimp };
      }
    }
    const trimp = best !== null ? best.trimp : slot.dropped;
    if (trimp > 0) out.push(trimp);
  }
  return out;
}
