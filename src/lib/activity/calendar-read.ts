/**
 * Database side of the activity calendar (D1036): per local day, the step
 * total, the exercise minutes, the training load and the workouts, over the
 * window `periodBounds` asks for. The arithmetic lives in `calendar-math.ts`.
 *
 * Steps follow the same rule as the steps chart: each UTC day resolves to the
 * source the person's priority ladder picks (`seriesRowsFrom`, the helper the
 * series route reads through), and the picked rows are then cut at the
 * person's own midnight. A calendar day and the chart's day therefore show
 * the same number. Workouts go through the cross-source collapse the workout
 * list applies, so a session recorded by two devices counts once.
 *
 * Bounded: four aggregate queries returning at most one row per day of the
 * window (about 220 days for a month), plus the workouts of that window.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  canonicalWorkoutsInRange,
  readWorkoutsAroundRange,
} from "@/lib/workouts/canonical-read";
import { seriesRowsFrom } from "@/lib/measurements/series-canonical";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

import type { ActivityDayInput } from "./calendar-math";

/**
 * Training-load types in the order the calendar prefers them: a device's own
 * daily figure first (WHOOP day strain, Polar cardio load), HealthLog's
 * computed strain score last. The first type with any reading in the window
 * is the one shown; two scales are never mixed on one calendar.
 */
export const LOAD_TYPES: readonly MeasurementType[] = [
  "DAY_STRAIN",
  "CARDIO_LOAD",
  "STRAIN_SCORE",
];

interface DayAggregateRow {
  day: string;
  total: number;
  /** Readings that day; the load is their plain mean (one score a day, as a rule). */
  n: number;
}

async function dailyAggregate(
  userId: string,
  tz: string,
  priorityJson: unknown,
  type: MeasurementType,
  from: Date,
  to: Date,
): Promise<Map<string, DayAggregateRow>> {
  // `seriesRowsFrom` scopes its canonical pick to the window from a day
  // before `from`, so the edge day's source is picked from all of its
  // readings; the outer filter trims to the exact window.
  const rows = await prisma.$queryRawUnsafe<DayAggregateRow[]>(
    `
    SELECT
      to_char(
        date_trunc('day', (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE $2),
        'YYYY-MM-DD'
      )                               AS day,
      SUM(m."value")::double precision AS total,
      COUNT(*)::int                    AS n
    FROM ${seriesRowsFrom(priorityJson, type, from)}
    WHERE m."measured_at" >= $3
      AND m."measured_at" < $4
    GROUP BY 1
    `,
    userId,
    tz,
    from,
    to,
  );
  return new Map(rows.map((r) => [r.day, r]));
}

function meanOf(row: DayAggregateRow | undefined): number | null {
  return row && row.n > 0 ? row.total / row.n : null;
}

export interface ActivityReadResult {
  days: ActivityDayInput[];
  loadType: MeasurementType | null;
}

/**
 * Read `fromKey`..`toKey` (inclusive local days) for one account.
 * `today` caps the read: nothing after the person's today is fetched.
 */
export async function readActivityDays(args: {
  userId: string;
  tz: string;
  fromKey: string;
  toKey: string;
  includeWorkouts: boolean;
}): Promise<ActivityReadResult> {
  const { userId, tz, fromKey, toKey, includeWorkouts } = args;
  const from = startOfLocalDayKey(fromKey, tz);
  const to = startOfLocalDayKey(shiftDateKey(toKey, 1), tz);
  const priorityJson = await loadUserSourcePriority(userId);

  const [steps, exercise, loads, workoutRows] = await Promise.all([
    dailyAggregate(userId, tz, priorityJson, "ACTIVITY_STEPS", from, to),
    dailyAggregate(userId, tz, priorityJson, "EXERCISE_MINUTES", from, to),
    Promise.all(
      LOAD_TYPES.map((type) =>
        dailyAggregate(userId, tz, priorityJson, type, from, to),
      ),
    ),
    includeWorkouts
      ? readWorkoutsAroundRange({ from, to }, (bounds) =>
          prisma.workout.findMany({
            where: { userId, startedAt: bounds },
            select: {
              id: true,
              startedAt: true,
              durationSec: true,
              sportType: true,
              source: true,
              avgHeartRate: true,
              maxHeartRate: true,
              metadata: true,
            },
            orderBy: [{ startedAt: "asc" }, { id: "asc" }],
          }),
        )
      : Promise.resolve(null),
  ]);

  const loadIndex = loads.findIndex((m) => m.size > 0);
  const load = loadIndex >= 0 ? loads[loadIndex] : null;

  const workouts = workoutRows
    ? canonicalWorkoutsInRange(workoutRows, priorityJson)
    : [];
  const workoutsByDay = new Map<
    string,
    { minutes: number; count: number; bySport: Record<string, number> }
  >();
  for (const w of workouts) {
    const key = userDayKey(w.startedAt, tz);
    const slot = workoutsByDay.get(key) ?? {
      minutes: 0,
      count: 0,
      bySport: {},
    };
    slot.minutes += Math.max(0, w.durationSec) / 60;
    slot.count += 1;
    slot.bySport[w.sportType] = (slot.bySport[w.sportType] ?? 0) + 1;
    workoutsByDay.set(key, slot);
  }

  const keys = new Set<string>([
    ...steps.keys(),
    ...exercise.keys(),
    ...(load ? load.keys() : []),
    ...workoutsByDay.keys(),
  ]);
  const days: ActivityDayInput[] = [...keys]
    .filter((k) => k >= fromKey && k <= toKey)
    .sort()
    .map((date) => {
      const w = workoutsByDay.get(date);
      return {
        date,
        steps: steps.get(date)?.total ?? null,
        exerciseMinutes: exercise.get(date)?.total ?? null,
        workoutMinutes: w ? Math.round(w.minutes) : 0,
        workoutCount: w?.count ?? 0,
        workoutsBySport: w?.bySport ?? {},
        load: meanOf(load?.get(date)),
      };
    });

  return { days, loadType: loadIndex >= 0 ? LOAD_TYPES[loadIndex] : null };
}
