/**
 * What a mood entry's day looked like in the modules that already own it.
 *
 * The rule this file exists to serve is the one the whole context feature
 * hangs off: one fact, one home. A mood entry shows what the other modules
 * already know and never asks for it a second time, and **nothing here is
 * copied onto the mood row** — every figure is resolved at read time from the
 * rows that own it, so correcting a sleep session corrects it here too, in the
 * same moment, with nothing to re-sync.
 *
 * Three consequences that are easy to get wrong and are therefore stated:
 *
 *   * **Absence is `{ present: false }`, never `0`.** A night nobody recorded
 *     and a night of no sleep are different facts, and a surface that renders
 *     the first as the second is lying about somebody's health record.
 *   * **A module that is switched off blanks its block.** It does not answer
 *     zero and it does not answer a filtered-down version of itself — the
 *     block is simply not there, the same way `snapshot.ts` blanks rather than
 *     filters. Turning a module off is a statement about what the person wants
 *     to see, not a filter over what they wanted to see.
 *   * **Which module owns which metric is asked, never assumed.** The first
 *     draft of this file hand-wrote the ownership: it called steps and active
 *     energy `workouts`, and it called resting heart rate and HRV core with no
 *     owner at all. Both were wrong in the two directions that matter — the
 *     first hid ambient movement behind a toggle the user never associated
 *     with it, the second served the `recovery` domain to an account that had
 *     switched it off, which made the release note's own promise false. The
 *     answer comes from `moduleForMeasurementType()` now, which is the one
 *     table the MCP wire, the correlations reader and the Coach snapshot all
 *     resolve through. A second copy of an ownership map is a copy that drifts.
 *
 * Cross-source de-dup runs on every measurement figure, through the same
 * `pickCanonicalSourceRows` ladder the crosstab and the doctor report use.
 * Without it, an account syncing a phone and a watch reads its steps doubled
 * on the mood sheet — the cumulative channels sum, and two sources reporting
 * the same day sum twice.
 *
 * The reads are bounded: one local day per entry, resolved through the day-key
 * helper that already carries the legacy-Berlin fallback for `tz IS NULL`
 * rows. There is no unbounded `findMany` here, and adding one would turn a
 * detail view into a table scan on an account with years of history.
 */
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/gate";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import type { ModuleKey } from "@/lib/modules/registry";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import {
  reconstructSleepNights,
  type SleepNight,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";

/** A figure that either exists or honestly does not. */
export type LinkedFigure =
  { present: false } | { present: true; value: number; unit: string };

/** A block that can also be absent because its module is switched off. */
export type LinkedBlock<T> =
  { available: false; reason: "module-disabled" } | ({ available: true } & T);

export interface LinkedSleep {
  /** Time asleep for the night the entry's local day woke up on. */
  asleep: LinkedFigure;
  /** Time in bed, when any writer recorded a bed window. */
  inBed: LinkedFigure;
}

/**
 * Ambient movement. Never gated: `workouts` gates workout SESSIONS, and steps
 * and active energy are on the ownership table's reviewed-unscoped list for
 * exactly that reason. The block carries an `available` flag anyway so every
 * block in the payload has one shape.
 */
export interface LinkedActivity {
  steps: LinkedFigure;
  activeEnergy: LinkedFigure;
}

export interface LinkedVitals {
  restingHeartRate: LinkedFigure;
  heartRateVariability: LinkedFigure;
}

export interface LinkedBody {
  /** Whether an illness day-log exists for this day at all. */
  logged: boolean;
  /** How much the day was limited, 0-3, as the illness module records it. */
  functionalImpact: LinkedFigure;
  /** Symptoms linked to that day-log, by their catalogue key. */
  symptoms: string[];
  /** The episode to open in the illness module, when there is one. */
  episodeId: string | null;
}

/**
 * The five linked figures of one day as plain numbers, for callers that need
 * a window of days rather than one day's blocks — the prognosis fit is the
 * only one so far. `null` is absence, and a module switched off makes its own
 * figures absent rather than zero.
 */
export interface LinkedDayFigures {
  sleepAsleep: number | null;
  steps: number | null;
  activeEnergy: number | null;
  restingHeartRate: number | null;
  heartRateVariability: number | null;
}

export interface LinkedDayContext {
  /** The entry's local day, resolved through the entry's own `tz`. */
  day: string;
  sleep: LinkedBlock<LinkedSleep>;
  activity: LinkedBlock<LinkedActivity>;
  /**
   * Resting heart rate and HRV. Gated on `recovery`, which is the module the
   * ownership table has assigned both types since v1.30.22 — including the
   * RMSSD fallback, pinned there so a ring-only account cannot reach through
   * the fallback for what the primary type refuses.
   */
  vitals: LinkedBlock<LinkedVitals>;
  body: LinkedBlock<LinkedBody>;
}

const MODULE_OFF = { available: false, reason: "module-disabled" } as const;
const ABSENT: LinkedFigure = { present: false };

function figure(value: number | null | undefined, unit: string): LinkedFigure {
  // A stored zero is a real reading and stays one. Only a missing row is
  // absent, which is why this tests for null rather than for falsiness.
  return value === null || value === undefined
    ? ABSENT
    : { present: true, value, unit };
}

/** A measurement row as this resolver reads it. */
interface LinkedRow {
  type: MeasurementType;
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
  deviceType: string | null;
}

/**
 * One day's rows for one metric, collapsed to a single source.
 *
 * The picker walks the user's source ladder and then the device-type ladder,
 * so a day reported by both a phone and a watch keeps one stream. Everything
 * downstream — the sum, the latest — then describes one device rather than an
 * accidental union of two. A metric with no ladder key returns its rows
 * untouched, which is the picker's own pass-through and is correct for a type
 * no two sources compete over.
 */
export function canonicalRowsOfDay(
  rows: readonly LinkedRow[],
  type: MeasurementType,
  day: string,
  tz: string,
  priorityJson: unknown,
): LinkedRow[] {
  const matching = rows.filter((r) => r.type === type);
  if (matching.length === 0) return [];
  const metricKey = metricKeyForType(type);
  if (metricKey === null) return matching;
  // The rows are already narrowed to one local day, so the picker's day key
  // is constant here; it still goes through the real helper rather than a
  // constant, because the ladder resolution is what is wanted and the bucket
  // shape is the picker's business.
  const { canonicalRows } = pickCanonicalSourceRows(
    matching,
    metricKey,
    priorityJson,
    (d) => moodDateKey(d, tz),
  );
  return canonicalRows.length > 0 ? canonicalRows : matching;
}

/**
 * A cumulative metric's day total, over one source.
 *
 * No rows means absent, not zero: a day nobody's phone reported and a day
 * spent motionless are different facts.
 */
function sumOfDay(
  rows: readonly LinkedRow[],
  type: MeasurementType,
  unit: string,
  day: string,
  tz: string,
  priorityJson: unknown,
): LinkedFigure {
  const matching = canonicalRowsOfDay(rows, type, day, tz, priorityJson);
  if (matching.length === 0) return ABSENT;
  return {
    present: true,
    value: matching.reduce((sum, r) => sum + r.value, 0),
    unit,
  };
}

/** Latest reading of the day for a point-in-time metric, over one source. */
function latestOfDay(
  rows: readonly LinkedRow[],
  type: MeasurementType,
  unit: string,
  day: string,
  tz: string,
  priorityJson: unknown,
): LinkedFigure {
  const matching = canonicalRowsOfDay(rows, type, day, tz, priorityJson).sort(
    (a, b) => a.measuredAt.getTime() - b.measuredAt.getTime(),
  );
  if (matching.length === 0) return ABSENT;
  return { present: true, value: matching[matching.length - 1].value, unit };
}

/**
 * A UTC window guaranteed to contain one local day, whatever its zone.
 *
 * Generous on both sides on purpose: the exact boundaries are decided by
 * `moodDateKey` afterwards, and this only has to be sure it did not clip the
 * day off at either end. Doing the arithmetic here instead would mean
 * re-deriving a zone offset that the day-key helper already knows, and that
 * second derivation is where the DST hour goes missing.
 */
function localDayWindow(day: string): { from: Date; to: Date } {
  // Walk outwards from the naive UTC midnight and keep whatever the day-key
  // helper agrees belongs to this day. Cheaper and far safer than arithmetic
  // on `new Date(y, m, d)`, which slips by an hour twice a year and has
  // already been solved once in this codebase.
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: anchor of a superset window; rows are kept only when their own local day matches
  const naive = new Date(`${day}T00:00:00.000Z`);
  const from = new Date(naive.getTime() - 26 * 60 * 60 * 1000);
  const to = new Date(naive.getTime() + 50 * 60 * 60 * 1000);
  return { from, to };
}

/** Keep only the rows whose own local day is the one asked for. */
function onDay<T extends { measuredAt: Date }>(
  rows: readonly T[],
  day: string,
  tz: string,
): T[] {
  return rows.filter((r) => moodDateKey(r.measuredAt, tz) === day);
}

/** The measurement types the linked block reads. One query covers all five. */
const LINKED_MEASUREMENT_TYPES = [
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "ACTIVE_ENERGY_BURNED",
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
] as const satisfies readonly MeasurementType[];

/**
 * The modules that own anything this resolver reads, asked of the one
 * ownership table rather than restated here.
 *
 * `illness` is added by hand because it owns a table rather than a measurement
 * type, so the measurement-keyed table has nothing to say about it. Everything
 * else is derived, which is what stops this file from growing a second opinion
 * about who owns resting heart rate.
 */
const LINKED_MODULE_KEYS: readonly ModuleKey[] = Array.from(
  new Set<ModuleKey>([
    ...LINKED_MEASUREMENT_TYPES.map(moduleForMeasurementType).filter(
      (m): m is ModuleKey => m !== null,
    ),
    "illness",
  ]),
);

/** Whether the module owning `type` is on, for a resolved gate map. */
function typeAvailable(
  type: MeasurementType,
  enabled: ReadonlyMap<ModuleKey, boolean>,
): boolean {
  const owner = moduleForMeasurementType(type);
  // `null` means the ownership table has reviewed this type and assigned it no
  // module — ambient movement is the case here. Ungated is the answer, and it
  // is the same answer the Coach snapshot and the MCP wire give.
  return owner === null ? true : (enabled.get(owner) ?? true);
}

/**
 * Resolve the linked figures for one entry's local day.
 *
 * Takes the entry's own `date` and `tz` rather than re-deriving them, because
 * the row already decided which day it belongs to and a second derivation here
 * could disagree with it — which is precisely the class of bug the per-row
 * `tz` column was added to end.
 */
export async function resolveLinkedDayContext(
  userId: string,
  entry: { date: string; tz: string | null },
): Promise<LinkedDayContext> {
  const tz = entry.tz ?? DEFAULT_TIMEZONE;
  const day = entry.date;
  const { from, to } = localDayWindow(day);

  // Every gate this resolver needs, resolved once against the modules the
  // ownership table names. Nothing here decides who owns what.
  const gateStates = await Promise.all(
    LINKED_MODULE_KEYS.map(
      async (key) => [key, await isModuleEnabled(userId, key)] as const,
    ),
  );
  const enabled = new Map<ModuleKey, boolean>(gateStates);
  const priority = await loadUserSourcePriority(userId);

  const measurements: LinkedRow[] = await prisma.measurement.findMany({
    where: {
      userId,
      deletedAt: null,
      type: { in: [...LINKED_MEASUREMENT_TYPES] },
      measuredAt: { gte: from, lte: to },
    },
    select: {
      type: true,
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
    // The canonical-source picker's determinism precondition: it keeps
    // insertion order inside a bucket, so a stable read order is what makes
    // its device-type tie-break reproducible rather than whatever the planner
    // returned this time.
    orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
  });

  const dayRows = onDay(measurements, day, tz);

  let sleep: LinkedBlock<LinkedSleep> = MODULE_OFF;
  if (typeAvailable("SLEEP_DURATION", enabled)) {
    // The stage rows of the whole window, not just the day's, and then the
    // night whose WAKE day is this one. A night starts the evening before, so
    // filtering the raw rows by day first would cut it in half — the
    // reconstruction is the thing that knows where a night begins. It runs its
    // own per-night source de-dup, which is why these rows do not go through
    // the day picker first.
    const stageRows = measurements.filter((r) => r.type === "SLEEP_DURATION");
    if (stageRows.length === 0) {
      sleep = { available: true, asleep: ABSENT, inBed: ABSENT };
    } else {
      const night = reconstructSleepNights(
        stageRows as unknown as SleepStageRow[],
        tz,
        priority,
      ).find((n) => n.night === day);
      sleep = {
        available: true,
        asleep: figure(night?.asleepMinutes ?? null, "min"),
        inBed: figure(night?.inBedMinutes ?? null, "min"),
      };
    }
  }

  // Ambient movement, ungated by the ownership table's own verdict. The
  // `typeAvailable` call is not decoration: it is what makes a future change
  // to that verdict reach this surface without an edit here.
  const activity: LinkedBlock<LinkedActivity> = typeAvailable(
    "ACTIVITY_STEPS",
    enabled,
  )
    ? {
        available: true,
        steps: sumOfDay(dayRows, "ACTIVITY_STEPS", "steps", day, tz, priority),
        activeEnergy: sumOfDay(
          dayRows,
          "ACTIVE_ENERGY_BURNED",
          "kcal",
          day,
          tz,
          priority,
        ),
      }
    : MODULE_OFF;

  const vitals: LinkedBlock<LinkedVitals> = typeAvailable(
    "RESTING_HEART_RATE",
    enabled,
  )
    ? {
        available: true,
        restingHeartRate: latestOfDay(
          dayRows,
          "RESTING_HEART_RATE",
          "bpm",
          day,
          tz,
          priority,
        ),
        heartRateVariability: latestOfDay(
          dayRows,
          "HEART_RATE_VARIABILITY",
          "ms",
          day,
          tz,
          priority,
        ),
      }
    : MODULE_OFF;

  const bodyBlock = await resolveBody(userId, day, enabled);

  return { day, sleep, activity, vitals, body: bodyBlock };
}

/** The illness day-log block, split out so the day loop above reads straight. */
async function resolveBody(
  userId: string,
  day: string,
  enabled: ReadonlyMap<ModuleKey, boolean>,
): Promise<LinkedBlock<LinkedBody>> {
  let body: LinkedBlock<LinkedBody> = MODULE_OFF;
  if (enabled.get("illness") ?? true) {
    // Read only. The illness module owns symptom capture and its severity
    // scale; the mood surface links into it and captures nothing, which is
    // what keeps the two from disagreeing about the same day.
    const dayLog = await prisma.illnessDayLog.findFirst({
      where: { userId, date: day, deletedAt: null },
      select: {
        episodeId: true,
        functionalImpact: true,
        symptomLinks: {
          select: { severity: true, symptom: { select: { key: true } } },
        },
      },
    });
    body = {
      available: true,
      logged: dayLog !== null,
      functionalImpact: figure(dayLog?.functionalImpact ?? null, "level"),
      symptoms: dayLog?.symptomLinks.map((l) => l.symptom.key) ?? [],
      episodeId: dayLog?.episodeId ?? null,
    };
  }
  return body;
}

/**
 * The five linked figures of one day, as plain numbers, for a whole window.
 *
 * The same figures the block above answers with, resolved for many days in
 * one query instead of one query per day. It exists because the prognosis fits
 * over a year of days and the per-day resolver would have run several hundred
 * round trips to build one matrix.
 *
 * It is the SAME engine, deliberately: the module gates come from
 * `moduleForMeasurementType` through `typeAvailable`, the cross-source de-dup
 * runs through `canonicalRowsOfDay`, the night reconstruction is the one in
 * `sleep-night.ts`, and the day totals are the same `sumOfDay` / `latestOfDay`
 * the single-day path uses. A second implementation of "what did this day look
 * like" would be a second answer, and the mood sheet and the model would start
 * disagreeing about the same Tuesday.
 *
 * A switched-off module answers `null` for its metrics, not zero and not a
 * value the owner declined to surface: the model must not learn from a module
 * whose figures the account asked not to see.
 */
export async function resolveLinkedDayFigures(
  userId: string,
  days: readonly string[],
  tz: string,
): Promise<Map<string, LinkedDayFigures>> {
  const out = new Map<string, LinkedDayFigures>();
  if (days.length === 0) return out;

  const sorted = [...days].sort();
  const { from } = localDayWindow(sorted[0]);
  const { to } = localDayWindow(sorted[sorted.length - 1]);

  const gateStates = await Promise.all(
    LINKED_MODULE_KEYS.map(
      async (key) => [key, await isModuleEnabled(userId, key)] as const,
    ),
  );
  const enabled = new Map<ModuleKey, boolean>(gateStates);
  const priority = await loadUserSourcePriority(userId);

  const measurements: LinkedRow[] = await prisma.measurement.findMany({
    where: {
      userId,
      deletedAt: null,
      type: { in: [...LINKED_MEASUREMENT_TYPES] },
      measuredAt: { gte: from, lte: to },
    },
    select: {
      type: true,
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
    // The canonical-source picker keeps insertion order inside a bucket, so a
    // stable read order is what makes its device-type tie-break reproducible
    // rather than whatever the planner returned this time.
    orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
  });

  // One pass to bucket by local day, rather than filtering the whole window
  // once per day: over a year of history that difference is the whole cost of
  // the fit's data preparation.
  const byDay = new Map<string, LinkedRow[]>();
  for (const row of measurements) {
    const key = moodDateKey(row.measuredAt, tz);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(row);
    else byDay.set(key, [row]);
  }

  const sleepAvailable = typeAvailable("SLEEP_DURATION", enabled);
  const activityAvailable = typeAvailable("ACTIVITY_STEPS", enabled);
  const vitalsAvailable = typeAvailable("RESTING_HEART_RATE", enabled);

  const nightByDay = new Map<string, number | null>();
  const inBedByDay = new Map<string, number | null>();
  if (sleepAvailable) {
    const stageRows = measurements.filter((r) => r.type === "SLEEP_DURATION");
    if (stageRows.length > 0) {
      for (const night of reconstructSleepNights(
        stageRows as unknown as SleepStageRow[],
        tz,
        priority,
      )) {
        nightByDay.set(night.night, night.asleepMinutes ?? null);
        inBedByDay.set(night.night, night.inBedMinutes ?? null);
      }
    }
  }

  for (const day of days) {
    const dayRows = byDay.get(day) ?? [];
    out.set(day, {
      sleepAsleep: sleepAvailable ? (nightByDay.get(day) ?? null) : null,
      steps: activityAvailable
        ? valueOf(
            sumOfDay(dayRows, "ACTIVITY_STEPS", "steps", day, tz, priority),
          )
        : null,
      activeEnergy: activityAvailable
        ? valueOf(
            sumOfDay(
              dayRows,
              "ACTIVE_ENERGY_BURNED",
              "kcal",
              day,
              tz,
              priority,
            ),
          )
        : null,
      restingHeartRate: vitalsAvailable
        ? valueOf(
            latestOfDay(
              dayRows,
              "RESTING_HEART_RATE",
              "bpm",
              day,
              tz,
              priority,
            ),
          )
        : null,
      heartRateVariability: vitalsAvailable
        ? valueOf(
            latestOfDay(
              dayRows,
              "HEART_RATE_VARIABILITY",
              "ms",
              day,
              tz,
              priority,
            ),
          )
        : null,
    });
  }
  return out;
}

/** A figure as a plain number, with absence staying absence. */
function valueOf(figure: LinkedFigure): number | null {
  return figure.present ? figure.value : null;
}

/** One canonical reading of a local day, as the day view reads it. */
export interface DayReadingRow extends LinkedRow {
  unit: string;
}

/** Every reading of one local day, one source per metric, and its night. */
export interface DayReadings {
  /** Canonical rows per type, oldest first; sleep stages are not here. */
  rowsByType: Map<MeasurementType, DayReadingRow[]>;
  /** The night that woke on this day, or null when none was recorded. */
  night: SleepNight | null;
  /** The source of the night's last stage row, the night's representative. */
  nightSource: MeasurementSource | null;
}

/**
 * v1.42 (#613) — the day view's readings, through the same engine as the
 * mood sheet's linked figures.
 *
 * The day view is the wider cousin of {@link resolveLinkedDayContext}: every
 * type rather than five, and every reading of the day rather than one figure
 * per block. It stays in this file so there is still one answer to "what did
 * this day hold": the cross-source de-dup is `canonicalRowsOfDay`, the night
 * is the `reconstructSleepNights` night whose wake day is this one, and the
 * night reads the same generous window the linked block reads, because a
 * night starts the evening before.
 *
 * The readings themselves are cut exactly: `[dayStart, dayEnd)` of the local
 * day in `tz`, which is 23, 24 or 25 hours long. A reading at 00:30 belongs
 * to the day it was taken on, never to the UTC day the rollups would file it
 * under. `typeVisible` is the caller's module (and section) mask; a type it
 * refuses is never read.
 */
export async function resolveDayReadings(
  userId: string,
  day: string,
  tz: string,
  window: { dayStart: Date; dayEnd: Date },
  typeVisible: (type: MeasurementType) => boolean,
  priorityJson?: unknown,
): Promise<DayReadings> {
  const sleepVisible = typeVisible("SLEEP_DURATION");
  const generous = localDayWindow(day);
  const [priority, rows, stageRows] = await Promise.all([
    priorityJson !== undefined
      ? Promise.resolve(priorityJson)
      : loadUserSourcePriority(userId),
    prisma.measurement.findMany({
      where: {
        userId,
        deletedAt: null,
        type: { not: "SLEEP_DURATION" },
        measuredAt: { gte: window.dayStart, lt: window.dayEnd },
      },
      select: {
        type: true,
        value: true,
        unit: true,
        measuredAt: true,
        source: true,
        deviceType: true,
      },
      // Same determinism precondition as the linked block above.
      orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
    }),
    sleepVisible
      ? prisma.measurement.findMany({
          where: {
            userId,
            deletedAt: null,
            type: "SLEEP_DURATION",
            measuredAt: { gte: generous.from, lte: generous.to },
          },
          select: {
            value: true,
            measuredAt: true,
            sleepStage: true,
            source: true,
            deviceType: true,
          },
          orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
        })
      : Promise.resolve([]),
  ]);

  const byType = new Map<MeasurementType, DayReadingRow[]>();
  for (const row of rows) {
    if (!typeVisible(row.type)) continue;
    const bucket = byType.get(row.type);
    if (bucket) bucket.push(row);
    else byType.set(row.type, [row]);
  }
  const rowsByType = new Map<MeasurementType, DayReadingRow[]>();
  for (const [type, typeRows] of byType) {
    const canonical = canonicalRowsOfDay(typeRows, type, day, tz, priority);
    rowsByType.set(type, canonical as DayReadingRow[]);
  }

  const night =
    stageRows.length === 0
      ? null
      : (reconstructSleepNights(
          stageRows as unknown as SleepStageRow[],
          tz,
          priority,
        ).find((n) => n.night === day) ?? null);
  const nightSource = night
    ? (stageRows.find(
        (r) => r.measuredAt.getTime() === night.measuredAt.getTime(),
      )?.source ?? null)
    : null;

  return { rowsByType, night, nightSource };
}
