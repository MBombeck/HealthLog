/**
 * v1.4.25 W16c — PersonalRecord detection worker.
 *
 * Scans a user's `Measurement` and `Workout` history and writes
 * `PersonalRecord` rows for every all-time best (per metric direction).
 * Runs on a pg-boss queue (`pr-detection`) wired in
 * `src/lib/jobs/reminder-worker.ts`. Ingest paths enqueue a job after
 * each batch insert — this module is the handler.
 *
 * Design choices:
 *   - Direction per metric comes from `pr-direction.ts` (W8d helper).
 *     Metrics with a `null` direction (BP, glucose, weight, sleep,
 *     temperature, pulse, oxygen, fat-free mass) never produce rows.
 *   - Warm-up gate: a metric needs at least 7 measurements before the
 *     worker writes its first record. Without this an Apple Health
 *     backfill that lands ten samples in two seconds would treat the
 *     first row as a "PR" and announce every subsequent improvement —
 *     not useful as a personal-record signal.
 *   - All-time scan rather than a rolling window. The
 *     `personal_records_user_metric_idx` index makes
 *     `ORDER BY value LIMIT 1` constant-time; reading the worst-case
 *     ~30k measurement rows per metric is ~50 ms with the typed
 *     `measurements_user_id_type_measured_at_idx` index.
 *   - Tie handling: an equal-value reading writes a row but the caller
 *     suppresses the push notification (the user matched, not beat
 *     their best). The notification suppression lives on the job
 *     payload (`silent` flag), not on the row — silence is a delivery
 *     concern, not a data concern.
 *   - Idempotency: the `(user, metric, slot, achievedAt)` unique index
 *     plus `createMany({ skipDuplicates: true })` makes re-running the
 *     same job a no-op.
 *
 * Workout PRs piggy-back on the same module so a single queue drain
 * covers both measurement and workout histories. The initial slot
 * vocabulary is intentionally small (longest_run_duration,
 * longest_distance_run, fastest_5km_time + cycling parallels) — the
 * detector stays open for more slots when v1.4.26 ships a wider workout
 * ingest surface.
 */
import { prisma as defaultPrisma } from "@/lib/db";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { getPRDirection, isPRTrackable } from "./pr-direction";
import {
  PersonalRecordDirection,
  type MeasurementType,
  type PrismaClient,
} from "@/generated/prisma/client";

/**
 * Minimum sample count per metric before the worker writes its first
 * row. Chosen so a one-off out-of-range sensor reading on day-one
 * cannot lock in as an "all-time" best. The threshold is uniform
 * across metrics — making it cadence-aware (per-day vs per-week)
 * adds complexity without changing the behaviour for the cold-start
 * case the gate exists to handle.
 */
export const PR_DETECTION_WARMUP_THRESHOLD = 7;

export interface DetectPersonalRecordsOptions {
  /**
   * Suppress push notifications for any record written in this run.
   * Set when a batch ingest crosses the historical-backfill threshold
   * — a multi-year Apple Health import shouldn't fire hundreds of
   * pushes during initial sync. The flag rides through to the
   * dispatcher; the row is still written, the badge still renders, the
   * doctor report still picks it up.
   */
  silent?: boolean;
  /**
   * Optional Prisma client injection for testing. Defaults to the
   * shared singleton so the production path stays free of plumbing.
   */
  prisma?: PrismaClient;
}

export interface DetectionResult {
  /** Newly inserted records (does not include rows the unique index absorbed). */
  inserted: number;
  /** Records written at a value equal to a prior best — push-suppressed. */
  ties: number;
  /** Metrics scanned and dropped without writing (warm-up gate, no improvement). */
  scanned: number;
  /** Whether push notifications were suppressed for this run. */
  silent: boolean;
}

interface MeasurementCandidate {
  id: string;
  value: number;
  unit: string;
  measuredAt: Date;
  source: string;
  externalId: string | null;
}

interface WorkoutCandidate {
  id: string;
  sportType: string;
  startedAt: Date;
  durationSec: number;
  totalDistanceM: number | null;
  source: string;
  externalId: string | null;
}

/**
 * Initial workout-PR slot vocabulary. Kept tight on purpose — wider
 * coverage (pace, elevation, swim, strength) lands once the v1.5
 * workout dashboards reveal which slots users actually look at.
 * Adding a slot here is one Zod refinement and one switch arm.
 */
type WorkoutSlotDefinition = {
  slot: string;
  sportType: "running" | "cycling";
  /** Direction matches the measurement convention: MAX = bigger wins, MIN = smaller wins. */
  direction: PersonalRecordDirection;
  /**
   * Which numeric column on the workout row is the PR candidate.
   * `durationSec` is in seconds; `totalDistanceM` in metres.
   */
  field: "durationSec" | "totalDistanceM";
  /** Optional minimum distance filter (metres). Used by the 5 km slot. */
  minDistanceM?: number;
  /** Unit string written to the PersonalRecord row. */
  unit: string;
  /**
   * Metric type used on the PR row. Workout PRs piggy-back on the
   * Measurement enum so the existing query path (filter by
   * `metricType`) keeps working — the `metricSlot` discriminator
   * tells the UI which sub-aspect to render.
   */
  metricType: MeasurementType;
};

const WORKOUT_SLOTS: WorkoutSlotDefinition[] = [
  {
    slot: "longest_run_duration",
    sportType: "running",
    direction: PersonalRecordDirection.MAX,
    field: "durationSec",
    unit: "s",
    metricType: "WALKING_RUNNING_DISTANCE",
  },
  {
    slot: "longest_distance_run",
    sportType: "running",
    direction: PersonalRecordDirection.MAX,
    field: "totalDistanceM",
    unit: "m",
    metricType: "WALKING_RUNNING_DISTANCE",
  },
  {
    slot: "fastest_5km_time",
    sportType: "running",
    direction: PersonalRecordDirection.MIN,
    field: "durationSec",
    minDistanceM: 5000,
    unit: "s",
    metricType: "WALKING_RUNNING_DISTANCE",
  },
  {
    slot: "longest_cycle_duration",
    sportType: "cycling",
    direction: PersonalRecordDirection.MAX,
    field: "durationSec",
    unit: "s",
    metricType: "WALKING_RUNNING_DISTANCE",
  },
  {
    slot: "longest_distance_cycle",
    sportType: "cycling",
    direction: PersonalRecordDirection.MAX,
    field: "totalDistanceM",
    unit: "m",
    metricType: "WALKING_RUNNING_DISTANCE",
  },
  {
    slot: "fastest_5km_cycle",
    sportType: "cycling",
    direction: PersonalRecordDirection.MIN,
    field: "durationSec",
    minDistanceM: 5000,
    unit: "s",
    metricType: "WALKING_RUNNING_DISTANCE",
  },
];

/**
 * Scan a single user's history and write `PersonalRecord` rows for
 * every all-time best across every PR-trackable metric and every
 * workout slot.
 *
 * Safe to re-run — the `(userId, metricType, metricSlot, achievedAt)`
 * unique index plus `skipDuplicates: true` makes repeated calls a
 * no-op once the records exist.
 */
export async function detectPersonalRecordsForUser(
  userId: string,
  options: DetectPersonalRecordsOptions = {},
): Promise<DetectionResult> {
  const prisma = options.prisma ?? defaultPrisma;
  const silent = options.silent ?? false;

  let inserted = 0;
  let ties = 0;
  let scanned = 0;

  // ── Measurement-driven PRs (metricSlot = null) ─────────────
  for (const type of measurementTypeEnum.options) {
    const metricType = type as MeasurementType;
    if (!isPRTrackable(metricType)) continue;
    scanned += 1;

    const direction = getPRDirection(metricType);
    if (direction === null) continue;

    // Warm-up gate. Cheap count first so we don't pull a 30k-row
    // scan on a brand-new account.
    const sampleCount = await prisma.measurement.count({
      where: { userId, type: metricType },
    });
    if (sampleCount < PR_DETECTION_WARMUP_THRESHOLD) continue;

    const best = await findBestMeasurement(
      prisma,
      userId,
      metricType,
      direction,
    );
    if (!best) continue;

    const currentPR = await prisma.personalRecord.findFirst({
      where: { userId, metricType, metricSlot: null },
      orderBy:
        direction === PersonalRecordDirection.MAX
          ? { value: "desc" }
          : { value: "asc" },
    });

    const outcome = compareToCurrentBest(best.value, currentPR?.value, direction);
    if (outcome === "no-improvement") continue;

    // Application-level idempotency. The DB unique index covers the
    // workout case (`metric_slot` non-null) but Postgres' default
    // NULLS-DISTINCT semantics mean `(userId, metric, NULL, ts)`
    // doesn't dedup at the index level — a second handler invocation
    // would otherwise write a second row at the same achievedAt. The
    // explicit pre-flight findFirst keeps both code paths safe.
    const existing = await prisma.personalRecord.findFirst({
      where: {
        userId,
        metricType,
        metricSlot: null,
        achievedAt: best.measuredAt,
      },
      select: { id: true },
    });
    if (existing) continue;

    const result = await prisma.personalRecord.createMany({
      data: [
        {
          userId,
          metricType,
          metricSlot: null,
          direction,
          value: best.value,
          unit: best.unit,
          achievedAt: best.measuredAt,
          sourceMeasurementId: best.id,
          source: best.source as never,
          externalId: best.externalId,
        },
      ],
      skipDuplicates: true,
    });
    if (result.count > 0) {
      if (outcome === "tie") {
        ties += 1;
      } else {
        inserted += 1;
      }
    }
  }

  // ── Workout-driven PRs (metricSlot != null) ───────────────
  // Workout ingest landed in W16b — we scan whatever rows are present.
  // Slots without enough samples sit out of the comparison the same
  // way the measurement warm-up gate handles cold-start metrics.
  for (const slot of WORKOUT_SLOTS) {
    scanned += 1;

    // MIN-direction slots sort ascending — the smallest value wins. A
    // zero-duration workout would always become "best" before any
    // legitimate row could compete. The schema gate on
    // `createWorkoutSchema` rejects endedAt <= startedAt at ingest
    // time, but the worker stays defensive: any historical row that
    // pre-dates the gate (or any future code path that bypasses the
    // schema) must not be allowed to lock in a zero-second PR. The
    // `durationSec > 0` clause is always present when `slot.field` is
    // durationSec; MIN-direction slots additionally enforce it
    // regardless of which field carries the PR value, so a hypothetical
    // future MIN slot on a distance field still rejects zero-duration
    // rows on principle.
    const baseWhere = {
      userId,
      sportType: slot.sportType,
      ...(slot.minDistanceM !== undefined
        ? { totalDistanceM: { gte: slot.minDistanceM } }
        : {}),
      ...(slot.direction === PersonalRecordDirection.MIN
        ? { durationSec: { gt: 0 } as { gt: number } }
        : {}),
      [slot.field]: { gt: 0 } as { gt: number },
    } as const;

    const sampleCount = await prisma.workout.count({
      where: baseWhere,
    });
    if (sampleCount < PR_DETECTION_WARMUP_THRESHOLD) continue;

    const best = await findBestWorkout(prisma, baseWhere, slot);
    if (!best) continue;

    const value =
      slot.field === "durationSec"
        ? best.durationSec
        : (best.totalDistanceM ?? 0);
    if (!Number.isFinite(value) || value <= 0) continue;

    const currentPR = await prisma.personalRecord.findFirst({
      where: { userId, metricType: slot.metricType, metricSlot: slot.slot },
      orderBy:
        slot.direction === PersonalRecordDirection.MAX
          ? { value: "desc" }
          : { value: "asc" },
    });

    const outcome = compareToCurrentBest(
      value,
      currentPR?.value,
      slot.direction,
    );
    if (outcome === "no-improvement") continue;

    const result = await prisma.personalRecord.createMany({
      data: [
        {
          userId,
          metricType: slot.metricType,
          metricSlot: slot.slot,
          direction: slot.direction,
          value,
          unit: slot.unit,
          achievedAt: best.startedAt,
          sourceMeasurementId: null,
          source: best.source as never,
          externalId: best.externalId,
        },
      ],
      skipDuplicates: true,
    });
    if (result.count > 0) {
      if (outcome === "tie") {
        ties += 1;
      } else {
        inserted += 1;
      }
    }
  }

  return { inserted, ties, scanned, silent };
}

/**
 * "tie" — equal-value: write row, suppress push.
 * "improvement" — strict improvement: write row, fire push (unless
 * the job carries `silent: true`).
 * "no-improvement" — nothing to do.
 */
type ComparisonOutcome = "improvement" | "tie" | "no-improvement";

function compareToCurrentBest(
  candidate: number,
  currentBest: number | undefined,
  direction: PersonalRecordDirection,
): ComparisonOutcome {
  if (currentBest === undefined) return "improvement";
  if (candidate === currentBest) return "tie";
  if (direction === PersonalRecordDirection.MAX) {
    return candidate > currentBest ? "improvement" : "no-improvement";
  }
  return candidate < currentBest ? "improvement" : "no-improvement";
}

async function findBestMeasurement(
  prisma: PrismaClient,
  userId: string,
  type: MeasurementType,
  direction: PersonalRecordDirection,
): Promise<MeasurementCandidate | null> {
  const row = await prisma.measurement.findFirst({
    where: { userId, type },
    orderBy:
      direction === PersonalRecordDirection.MAX
        ? { value: "desc" }
        : { value: "asc" },
    select: {
      id: true,
      value: true,
      unit: true,
      measuredAt: true,
      source: true,
      externalId: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    value: row.value,
    unit: row.unit,
    measuredAt: row.measuredAt,
    source: row.source,
    externalId: row.externalId,
  };
}

async function findBestWorkout(
  prisma: PrismaClient,
  where: Record<string, unknown>,
  slot: WorkoutSlotDefinition,
): Promise<WorkoutCandidate | null> {
  const row = await prisma.workout.findFirst({
    where: where as never,
    orderBy:
      slot.direction === PersonalRecordDirection.MAX
        ? ({ [slot.field]: "desc" } as never)
        : ({ [slot.field]: "asc" } as never),
    select: {
      id: true,
      sportType: true,
      startedAt: true,
      durationSec: true,
      totalDistanceM: true,
      source: true,
      externalId: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    sportType: row.sportType,
    startedAt: row.startedAt,
    durationSec: row.durationSec,
    totalDistanceM: row.totalDistanceM,
    source: row.source,
    externalId: row.externalId,
  };
}

/** Exposed for tests + the integration harness. */
export const __test__ = {
  WORKOUT_SLOTS,
  compareToCurrentBest,
};
