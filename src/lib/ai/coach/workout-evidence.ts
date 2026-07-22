/**
 * Per-workout evidence block for a Coach conversation launched from a
 * workout ("Ask why" on the workout-detail page, or `/coach?workout=<id>`).
 *
 * ── Why this block is NOT fenced ─────────────────────────────────────
 *
 * The stored-document path (`?doc=`) routes every turn through the hardened
 * fenced endpoint because document text is third-party prose transcribed out
 * of a PDF — an injection surface by construction. A workout row is not:
 * it is the user's own structured sensor record. This block therefore rides
 * the normal Coach prompt as one additional snapshot section.
 *
 * That reasoning only holds if the projection really is numbers-only, so the
 * closure is enforced here rather than assumed:
 *
 *   - Every emitted leaf is a NUMBER, a BOOLEAN, or a token drawn from a
 *     closed server-side vocabulary. `assertNumbersOnly()` walks the built
 *     object and throws on anything else, so a future field that smuggles a
 *     string in fails loudly at build time instead of silently reaching a
 *     prompt.
 *   - `sportType` is a TEXT column at the DB layer (see `Workout.sport_type`
 *     in `prisma/schema.prisma`). The write path constrains it to
 *     `workoutSportTypeEnum`, but the backup-restore path accepts
 *     `z.string().min(1)`, so a restored row can carry arbitrary text. It is
 *     therefore re-asserted against the closed enum here and folded to
 *     `"other"` on a miss — the same whitelist posture the raw-SQL splices
 *     use.
 *   - `metadata` is EXCLUDED wholesale. It carries device bundle ids and
 *     HKWorkoutEvent markers — free text with no numeric value to the
 *     narrative. Only the WHOOP zone durations are read out of it, and only
 *     through the narrow numeric Zod slice `parseWhoopZoneDurations()`.
 *   - `externalId` / `externalSourceVersion` are EXCLUDED — opaque
 *     device-assigned strings.
 *   - Route GEOMETRY is EXCLUDED. The per-point coordinate trace is the
 *     user's location history; the climb figure the narrative needs is
 *     already the numeric `elevationM` column.
 *
 * The conversation-level tenancy narrow (`{ id, userId }`) lives in the
 * explicit-dependency workout evidence builder; this module never widens it.
 */
import { workoutSportTypeEnum } from "@/lib/validations/workout";
import type { HrSeriesPoint } from "@/lib/workouts/hr-series";
import type { WorkoutZones } from "@/lib/workouts/zones";
import type { WorkoutSportContext } from "@/lib/workouts/sport-context";
import { userDayKey } from "@/lib/tz/format";

/**
 * Fold an arbitrary stored sport string onto the closed union.
 *
 * `sport_type` is a TEXT column, so this fold is load-bearing (see the
 * module docblock). `source`, by contrast, is a Postgres ENUM — the
 * database itself is the closed vocabulary there, so it is admitted as-is
 * rather than re-listed here. A hand-maintained copy of the source list
 * would only drift from `enum MeasurementSource`.
 */
export function closedSportType(raw: string): string {
  const parsed = workoutSportTypeEnum.safeParse(raw);
  return parsed.success ? parsed.data : "other";
}

export interface WorkoutEvidenceInput {
  sportType: string;
  source: string;
  startedAt: Date;
  timezone: string;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
  stepCount: number | null;
  elevationM: number | null;
  pauseDurationSec: number | null;
  /** Resolved server-side; all-numeric bands. */
  zones: WorkoutZones | null;
  /** The SAME series the detail route serves as `hrSeries`. */
  hrPoints: HrSeriesPoint[];
  /** The user's own last-180-days average for this sport. */
  sportContext: WorkoutSportContext | null;
}

/**
 * Deterministic HR-shape derivations. Nothing here is a verdict — they are
 * the numbers a narrative needs in order to describe the session's arc
 * instead of restating the averages the stats grid already shows.
 */
export interface WorkoutHrShape {
  peakBpm: number;
  /** Elapsed seconds at which the peak bucket sits. */
  peakAtSec: number;
  /**
   * Seconds from the peak until HR first falls back below the session mean.
   * `null` when it never does (the peak sits at or near the session end).
   */
  settleSec: number | null;
  /** Mean bpm across the first / second half of the session. */
  firstHalfMeanBpm: number;
  secondHalfMeanBpm: number;
  /** `secondHalfMeanBpm - firstHalfMeanBpm`, signed. Cardiac drift proxy. */
  driftBpm: number;
}

export function deriveHrShape(points: HrSeriesPoint[]): WorkoutHrShape | null {
  // Two points cannot describe an arc; the caller omits the shape entirely
  // rather than narrating a straight line as a "pattern".
  if (points.length < 4) return null;

  let peak = points[0];
  for (const p of points) {
    if (p.max > peak.max) peak = p;
  }

  const sessionMean =
    points.reduce((sum, p) => sum + p.mean, 0) / points.length;

  const peakIndex = points.indexOf(peak);
  let settleSec: number | null = null;
  for (let i = peakIndex + 1; i < points.length; i += 1) {
    if (points[i].mean < sessionMean) {
      settleSec = points[i].tSec - peak.tSec;
      break;
    }
  }

  const mid = Math.floor(points.length / 2);
  const meanOf = (slice: HrSeriesPoint[]) =>
    slice.reduce((sum, p) => sum + p.mean, 0) / slice.length;
  const firstHalfMeanBpm = Math.round(meanOf(points.slice(0, mid)));
  const secondHalfMeanBpm = Math.round(meanOf(points.slice(mid)));

  return {
    peakBpm: Math.round(peak.max),
    peakAtSec: peak.tSec,
    settleSec,
    firstHalfMeanBpm,
    secondHalfMeanBpm,
    driftBpm: secondHalfMeanBpm - firstHalfMeanBpm,
  };
}

/**
 * Recursive closure guard. Throws when any leaf is not a number, boolean,
 * or null — the invariant that lets this block skip the fence. Closed-
 * vocabulary tokens are passed in via `allowedStrings` so the guard stays
 * honest about exactly which strings were deliberately admitted.
 */
export function assertNumbersOnly(
  value: unknown,
  allowedStrings: ReadonlySet<string>,
  path = "$",
): void {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`workout evidence: non-finite number at ${path}`);
    }
    return;
  }
  if (typeof value === "string") {
    if (!allowedStrings.has(value)) {
      throw new Error(
        `workout evidence: free-text leaf at ${path} — only closed-vocabulary tokens may be emitted`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) =>
      assertNumbersOnly(v, allowedStrings, `${path}[${i}]`),
    );
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNumbersOnly(v, allowedStrings, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`workout evidence: unsupported leaf type at ${path}`);
}

/**
 * Build the one bounded evidence section pinned onto a workout-launched
 * conversation's snapshot. Returns a plain JSON-serialisable record.
 */
export function buildWorkoutEvidence(
  input: WorkoutEvidenceInput,
): Record<string, unknown> {
  const sport = closedSportType(input.sportType);
  const source = input.source;
  const shape = deriveHrShape(input.hrPoints);

  const evidence: Record<string, unknown> = {
    // Day granularity in the user's timezone. UTC slicing can move late-evening
    // workouts onto the following profile day.
    date: userDayKey(input.startedAt, input.timezone),
    sport,
    recordedBy: source,
    durationSec: input.durationSec,
    energyKcal: input.totalEnergyKcal,
    distanceM: input.totalDistanceM,
    avgHr: input.avgHeartRate,
    maxHr: input.maxHeartRate,
    minHr: input.minHeartRate,
    stepCount: input.stepCount,
    elevationM: input.elevationM,
    pauseDurationSec: input.pauseDurationSec,
    zones:
      input.zones != null
        ? {
            model: input.zones.model,
            hrMax: input.zones.hrMax,
            bands: input.zones.zones.map((z) => ({
              zone: z.zone,
              lowBpm: z.lowBpm,
              highBpm: z.highBpm,
              seconds: z.seconds,
            })),
          }
        : null,
    hrShape: shape,
    // Own-history only. Never a population band — the non-diagnostic
    // standard binds this block exactly as it binds the detail page.
    ownHistory: input.sportContext,
  };

  // The closure guard. Every admitted string is enumerated: the sport token,
  // the source token, the zone-model literal, and the ISO day key.
  const allowed = new Set<string>([
    sport,
    source,
    evidence.date as string,
    "whoop",
    "tanaka",
  ]);
  assertNumbersOnly(evidence, allowed);

  return evidence;
}
