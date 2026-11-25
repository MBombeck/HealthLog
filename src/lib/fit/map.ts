/**
 * A decoded activity FIT file → workout entries in the shape the workout
 * batch schema (`createWorkoutSchema`) accepts.
 *
 *   session (one per sport)    → one workout: sport, start, end, distance,
 *                                energy, average and peak heart rate, climb,
 *                                pause time
 *   record stream (about 1 Hz) → the workout's series: heart rate, speed,
 *                                power, cadence; averaged down to the series
 *                                cap when a session is longer than it
 *   record positions           → the GPS track, only when the account keeps
 *                                tracks, thinned like an Apple Health track
 *
 *   session + activity metrics → the watch's own figures for the session
 *                                (training effect, training load, recovery
 *                                time, sweat loss, running dynamics), into
 *                                `metadata` under the keys of
 *                                `src/lib/workouts/performance-metrics.ts`
 *
 * Beat-to-beat (`hrv`) messages are not read: nothing in HealthLog consumes
 * R-R intervals. Neither are lap details beyond their count, device serial
 * numbers, or anything a developer field carries.
 *
 * The decoded object is untrusted (its keys include developer field names
 * from the file), so every value is taken by name through an own-property
 * check, range-checked, and copied into a fresh object. Nothing is spread.
 * Out-of-range values are dropped rather than clamped: a heart rate of 255
 * is the protocol's "invalid", not a very hard effort.
 */
import { trackToRoute } from "@/lib/apple-health/route-import";
import { MAX_WORKOUT_HR_SAMPLES } from "@/lib/validations/workout";
import type { WorkoutSportType } from "@/lib/validations/workout";

import { FitImportError } from "./errors";
import type { DecodedFit } from "./parse";
import { mapFitSportType } from "./sport-map";
import { mean } from "@/lib/stats/central";
import {
  plausibleFigure,
  type WorkoutPerformanceKey,
} from "@/lib/workouts/performance-metrics";
import { ownValue } from "@/lib/own-key";

/** Sessions one file may describe (a multisport race has a handful). */
export const FIT_MAX_SESSIONS = 16;

/** The longest session believed: a multi-day expedition, not a broken clock. */
const MAX_SESSION_SECONDS = 7 * 24 * 60 * 60;

/** Instants before this are a device without a clock fix. */
const EARLIEST_INSTANT_MS = Date.UTC(2000, 0, 1);

/** The plausible range of each channel. Outside it the value is dropped. */
export const FIT_PLAUSIBLE = {
  heartRate: { min: 25, max: 250 },
  speedMs: { min: 0, max: 50 },
  power: { min: 0, max: 3000 },
  cadence: { min: 0, max: 400 },
  altitudeM: { min: -500, max: 9000 },
  distanceM: { min: 0, max: 1_000_000 },
  energyKcal: { min: 0, max: 50_000 },
  ascentM: { min: 0, max: 10_000 },
  steps: { min: 0, max: 200_000 },
} as const;

type Range = { min: number; max: number };

/** An own property of a decoded object; never an inherited one. */
function own(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  return ownValue(obj as Record<string, unknown>, key);
}

function list(obj: unknown, key: string): unknown[] {
  const v = own(obj, key);
  return Array.isArray(v) ? v : [];
}

function inRange(v: unknown, range: Range): number | null {
  return typeof v === "number" &&
    Number.isFinite(v) &&
    v >= range.min &&
    v <= range.max
    ? v
    : null;
}

function nonNegative(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** A profile name the decoder produced, or null for anything else. */
function profileName(v: unknown): string | null {
  return typeof v === "string" && /^[a-z0-9_]{1,48}$/.test(v) ? v : null;
}

function instantMs(v: unknown, nowMs: number): number | null {
  const ms =
    v instanceof Date
      ? v.getTime()
      : typeof v === "string"
        ? Date.parse(v)
        : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  if (ms < EARLIEST_INSTANT_MS || ms > nowMs + 24 * 60 * 60 * 1000) {
    return null;
  }
  return ms;
}

/** One record, reduced to the channels HealthLog keeps. */
interface RecordPoint {
  t: number;
  hr: number | null;
  speedMs: number | null;
  power: number | null;
  cadence: number | null;
  lat: number | null;
  lon: number | null;
  ele: number | null;
}

function readRecord(rec: unknown, nowMs: number): RecordPoint | null {
  const t = instantMs(own(rec, "timestamp"), nowMs);
  if (t === null) return null;
  const hrRaw = inRange(own(rec, "heart_rate"), FIT_PLAUSIBLE.heartRate);
  const speed =
    inRange(own(rec, "enhanced_speed"), FIT_PLAUSIBLE.speedMs) ??
    inRange(own(rec, "speed"), FIT_PLAUSIBLE.speedMs);
  const lat = inRange(own(rec, "position_lat"), { min: -90, max: 90 });
  const lon = inRange(own(rec, "position_long"), { min: -180, max: 180 });
  // (0, 0) is a receiver without a fix, not a run in the Gulf of Guinea.
  const hasFix = lat !== null && lon !== null && !(lat === 0 && lon === 0);
  return {
    t,
    hr: hrRaw === null ? null : Math.round(hrRaw),
    speedMs: speed,
    power: inRange(own(rec, "power"), FIT_PLAUSIBLE.power),
    cadence: inRange(own(rec, "cadence"), FIT_PLAUSIBLE.cadence),
    lat: hasFix ? lat : null,
    lon: hasFix ? lon : null,
    ele:
      inRange(own(rec, "enhanced_altitude"), FIT_PLAUSIBLE.altitudeM) ??
      inRange(own(rec, "altitude"), FIT_PLAUSIBLE.altitudeM),
  };
}

export interface FitSample {
  t: string;
  hr?: number;
  speedMs?: number;
  power?: number;
  cadence?: number;
}

/** The largest value, by a loop: a spread overflows the stack past ~120k. */
function maxOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let max = values[0]!;
  for (const v of values) if (v > max) max = v;
  return max;
}

/**
 * The series of a session, one entry per record that carries a channel. A
 * series longer than the cap is averaged over consecutive buckets of equal
 * size, each stamped with its first record's time, so a 30-hour race keeps
 * its shape instead of being cut off.
 */
export function buildFitSamples(
  points: readonly RecordPoint[],
  cap: number = MAX_WORKOUT_HR_SAMPLES,
): FitSample[] {
  const withSignal = points.filter(
    (p) =>
      p.hr !== null ||
      p.speedMs !== null ||
      p.power !== null ||
      p.cadence !== null,
  );
  const bucket = Math.max(1, Math.ceil(withSignal.length / cap));
  const out: FitSample[] = [];
  for (let i = 0; i < withSignal.length; i += bucket) {
    const slice = withSignal.slice(i, i + bucket);
    const pick = (f: (p: RecordPoint) => number | null) =>
      mean(slice.map(f).filter((v): v is number => v !== null));
    const hr = pick((p) => p.hr);
    const speedMs = pick((p) => p.speedMs);
    const power = pick((p) => p.power);
    const cadence = pick((p) => p.cadence);
    const sample: FitSample = { t: new Date(slice[0]!.t).toISOString() };
    if (hr !== null) sample.hr = Math.round(hr);
    if (speedMs !== null) sample.speedMs = Math.round(speedMs * 1000) / 1000;
    if (power !== null) sample.power = Math.round(power);
    if (cadence !== null) sample.cadence = Math.round(cadence);
    out.push(sample);
  }
  return out;
}

/** Foot sports, whose FIT stride count is half the step count. */
const STEP_SPORTS: ReadonlySet<WorkoutSportType> = new Set([
  "running",
  "walking",
  "hiking",
]);

/** A workout entry as `createWorkoutSchema` takes it, before validation. */
export interface FitWorkoutDraft {
  sportType: WorkoutSportType;
  startedAt: string;
  endedAt: string;
  externalId: string;
  totalEnergyKcal?: number;
  totalDistanceM?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  stepCount?: number;
  elevationM?: number;
  pauseDurationSec?: number;
  metadata: Record<string, string | number>;
  samples?: FitSample[];
  route?: {
    geometry: { type: "LineString"; coordinates: number[][] };
    sampleTimestamps?: Array<{ t: string }>;
  };
}

export interface FitMapOptions {
  /** The id each session is stored under, from its start (epoch ms). */
  externalIdFor: (sessionStartMs: number, sessionIndex: number) => string;
  /** The account keeps GPS tracks (`storeWorkoutRoutes`). */
  keepRoutes: boolean;
  now?: Date;
}

export interface FitMapResult {
  drafts: FitWorkoutDraft[];
  /** Sessions in the file that could not become a workout. */
  sessionsSkipped: number;
}

/** The file type from `file_id`, when the file names one. */
function fileType(decoded: DecodedFit): unknown {
  const ids = list(decoded, "file_ids");
  const first = ids[0] ?? own(decoded, "file_id");
  return own(first, "type");
}

function deviceMetadata(decoded: DecodedFit): Record<string, string | number> {
  const ids = list(decoded, "file_ids");
  const first = ids[0] ?? own(decoded, "file_id");
  const out: Record<string, string | number> = {};
  const manufacturer = own(first, "manufacturer");
  const product = own(first, "garmin_product") ?? own(first, "product");
  if (profileName(manufacturer)) out.fitManufacturer = manufacturer as string;
  if (profileName(product)) out.fitProduct = product as string;
  else if (
    typeof product === "number" &&
    Number.isInteger(product) &&
    product >= 0 &&
    product <= 0xffff
  ) {
    out.fitProduct = product;
  }
  return out;
}

/**
 * Map a decoded activity. Throws `not_activity` for a FIT file of another
 * kind and `no_session` when no session yields a workout.
 */
export function mapFitActivity(
  decoded: DecodedFit,
  opts: FitMapOptions,
): FitMapResult {
  const nowMs = (opts.now ?? new Date()).getTime();
  const type = fileType(decoded);
  if (type !== undefined && type !== "activity" && type !== 4) {
    throw new FitImportError("not_activity", "the file is not an activity");
  }
  const sessions = list(decoded, "sessions");
  if (sessions.length === 0) {
    throw new FitImportError("no_session", "the file holds no session");
  }
  if (sessions.length > FIT_MAX_SESSIONS) {
    throw new FitImportError("too_complex", "too many sessions");
  }

  const points: RecordPoint[] = [];
  for (const rec of list(decoded, "records")) {
    const point = readRecord(rec, nowMs);
    if (point) points.push(point);
  }
  points.sort((a, b) => a.t - b.t);
  const laps = list(decoded, "laps")
    .map((lap) => instantMs(own(lap, "start_time"), nowMs))
    .filter((v): v is number => v !== null);
  const device = deviceMetadata(decoded);
  // `activity_metrics` describes the whole file, not one session, so it is
  // only read into a file that holds exactly one.
  const activityMetrics =
    sessions.length === 1
      ? (list(decoded, "activity_metrics")[0] ?? null)
      : null;

  const drafts: FitWorkoutDraft[] = [];
  let sessionsSkipped = 0;
  sessions.forEach((session, index) => {
    const draft = mapSession(session, index, sessions.length, {
      points,
      laps,
      device,
      activityMetrics,
      nowMs,
      opts,
    });
    if (draft) drafts.push(draft);
    else sessionsSkipped += 1;
  });
  if (drafts.length === 0) {
    throw new FitImportError("no_session", "no session could be read");
  }
  return { drafts, sessionsSkipped };
}

function mapSession(
  session: unknown,
  index: number,
  sessionCount: number,
  ctx: {
    points: readonly RecordPoint[];
    laps: readonly number[];
    device: Record<string, string | number>;
    activityMetrics: unknown;
    nowMs: number;
    opts: FitMapOptions;
  },
): FitWorkoutDraft | null {
  const startMs = instantMs(own(session, "start_time"), ctx.nowMs);
  if (startMs === null) return null;
  const timer = nonNegative(own(session, "total_timer_time"));
  const lastMs = instantMs(own(session, "timestamp"), ctx.nowMs);
  const elapsed =
    nonNegative(own(session, "total_elapsed_time")) ??
    timer ??
    (lastMs !== null ? (lastMs - startMs) / 1000 : null);
  if (elapsed === null || elapsed <= 0 || elapsed > MAX_SESSION_SECONDS) {
    return null;
  }
  const endMs = startMs + Math.round(elapsed * 1000);

  const sport = own(session, "sport");
  const subSport = own(session, "sub_sport");
  const sportType = mapFitSportType(sport, subSport);

  // The records of this session: one second of slack on both ends for a
  // device that stamps its last record at the session's close.
  const points = ctx.points.filter(
    (p) => p.t >= startMs - 1000 && p.t <= endMs + 1000,
  );
  const samples = buildFitSamples(points);
  const heartRates = points
    .map((p) => p.hr)
    .filter((v): v is number => v !== null);

  const draft: FitWorkoutDraft = {
    sportType,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    externalId: ctx.opts.externalIdFor(startMs, index),
    metadata: {
      importFormat: "fit",
      ...ctx.device,
    },
  };
  const sportName = profileName(sport);
  const subSportName = profileName(subSport);
  if (sportName) draft.metadata.fitSport = sportName;
  if (subSportName) draft.metadata.fitSubSport = subSportName;
  if (sessionCount > 1) {
    draft.metadata.fitSession = index + 1;
    draft.metadata.fitSessions = sessionCount;
  }
  const lapCount = ctx.laps.filter((t) => t >= startMs && t < endMs).length;
  if (lapCount > 0) draft.metadata.fitLaps = lapCount;
  const avgPower = inRange(own(session, "avg_power"), FIT_PLAUSIBLE.power);
  if (avgPower !== null) draft.metadata.avgPowerW = Math.round(avgPower);
  const avgCadence = inRange(
    own(session, "avg_cadence"),
    FIT_PLAUSIBLE.cadence,
  );
  if (avgCadence !== null) draft.metadata.avgCadence = Math.round(avgCadence);
  Object.assign(
    draft.metadata,
    sessionPerformance(session, ctx.activityMetrics),
  );

  const kcal = inRange(
    own(session, "total_calories"),
    FIT_PLAUSIBLE.energyKcal,
  );
  if (kcal !== null) draft.totalEnergyKcal = Math.round(kcal);
  const distance = inRange(
    own(session, "total_distance"),
    FIT_PLAUSIBLE.distanceM,
  );
  if (distance !== null) draft.totalDistanceM = distance;
  const ascent = inRange(own(session, "total_ascent"), FIT_PLAUSIBLE.ascentM);
  if (ascent !== null) draft.elevationM = ascent;
  if (timer !== null && elapsed >= timer) {
    const pause = Math.round(elapsed - timer);
    if (pause <= 86_400) draft.pauseDurationSec = pause;
  }

  const avgHr =
    inRange(own(session, "avg_heart_rate"), FIT_PLAUSIBLE.heartRate) ??
    mean(heartRates);
  const maxHr =
    inRange(own(session, "max_heart_rate"), FIT_PLAUSIBLE.heartRate) ??
    maxOf(heartRates);
  if (avgHr !== null) draft.avgHeartRate = Math.round(avgHr);
  if (maxHr !== null) draft.maxHeartRate = Math.round(maxHr);
  if (heartRates.length > 0) {
    draft.minHeartRate = heartRates.reduce((a, b) => Math.min(a, b));
  }

  if (STEP_SPORTS.has(sportType)) {
    const strides = nonNegative(own(session, "total_strides"));
    const steps = strides === null ? null : Math.round(strides * 2);
    if (steps !== null && inRange(steps, FIT_PLAUSIBLE.steps) !== null) {
      draft.stepCount = steps;
    }
  }

  if (samples.length > 0) draft.samples = samples;

  // A virtual ride or run (Zwift, a trainer app) carries invented
  // coordinates; it is not a place the person was.
  if (ctx.opts.keepRoutes && subSportName !== "virtual_activity") {
    const fixed = points.filter((p) => p.lat !== null && p.lon !== null);
    const route = trackToRoute({
      lon: fixed.map((p) => p.lon!),
      lat: fixed.map((p) => p.lat!),
      ele: fixed.map((p) => p.ele ?? Number.NaN),
      time: fixed.map((p) => p.t),
    });
    if (route) {
      draft.route = {
        geometry: route.geometry,
        ...(route.sampleTimestamps
          ? { sampleTimestamps: route.sampleTimestamps }
          : {}),
      };
    }
  }
  return draft;
}

/**
 * The FIT field each performance figure is read from: the session's own
 * field first, then the file's `activity_metrics` message (Garmin writes
 * recovery time only there). Scales are the decoder's: training effect as
 * the 0–5 score, vertical oscillation and step data in millimetres, stance
 * time in milliseconds, sweat loss in millilitres, recovery time in minutes.
 */
const PERFORMANCE_FIELDS: ReadonlyArray<
  [WorkoutPerformanceKey, string | null, string | null]
> = [
  ["aerobicTrainingEffect", "total_training_effect", "aerobic_training_effect"],
  [
    "anaerobicTrainingEffect",
    "total_anaerobic_training_effect",
    "anaerobic_training_effect",
  ],
  ["trainingLoad", "training_load_peak", null],
  ["recoveryTimeMin", null, "recovery_time"],
  ["sweatLossMl", "est_sweat_loss", null],
  ["avgVerticalOscillationMm", "avg_vertical_oscillation", null],
  ["avgGroundContactTimeMs", "avg_stance_time", null],
  ["avgGroundContactBalancePct", "avg_stance_time_balance", null],
];

/** One decimal for the scores and the dynamics, whole numbers otherwise. */
const ONE_DECIMAL: ReadonlySet<WorkoutPerformanceKey> = new Set([
  "aerobicTrainingEffect",
  "anaerobicTrainingEffect",
  "trainingLoad",
  "avgVerticalOscillationMm",
  "avgGroundContactBalancePct",
]);

export function sessionPerformance(
  session: unknown,
  activityMetrics: unknown,
): Partial<Record<WorkoutPerformanceKey, number>> {
  const out: Partial<Record<WorkoutPerformanceKey, number>> = {};
  for (const [key, sessionField, metricsField] of PERFORMANCE_FIELDS) {
    const value =
      (sessionField
        ? plausibleFigure(key, own(session, sessionField))
        : null) ??
      (metricsField
        ? plausibleFigure(key, own(activityMetrics, metricsField))
        : null);
    if (value === null) continue;
    out[key] = ONE_DECIMAL.has(key)
      ? Math.round(value * 10) / 10
      : Math.round(value);
  }
  return out;
}
