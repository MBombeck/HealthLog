/**
 * Coach availability probe — the discriminant behind "no data".
 *
 * A Coach retrieval tool reads the snapshot for a WINDOW. When the window read
 * comes back empty there are two entirely different situations, and until this
 * module existed both collapsed into one `reason: "no_data"`:
 *
 *   1. the record holds nothing for this domain, ever;
 *   2. the record holds a substantial history for this domain, all of it older
 *      than the window that was searched.
 *
 * The second one is not absence. Reported as absence, the Coach tells someone
 * their readings do not exist and then — having been told there is nothing
 * there — moves on to a metric it can talk about. So every `present: false`
 * that comes from an empty window read is checked here first, and the two
 * cases reach the model as different reason codes:
 *
 *   `no_data`        — the probe confirmed the record is empty for this domain.
 *   `outside_window` — rows exist; every one of them is older than the window
 *                      that was searched. `available` carries how many, over
 *                      what range, and (for measurement-backed domains) a
 *                      bounded aggregate of them.
 *   `unavailable_in_scope` — rows exist INSIDE the searched window and the
 *                      domain still produced no block: the owning module is off
 *                      for this account, or the block's own floor was not met.
 *                      Widening the window cannot help, and telling the person
 *                      the data does not exist would be false twice over.
 *   `no_data_unconfirmed` — the probe itself failed. The window read found
 *                      nothing and we could not establish whether older rows
 *                      exist, so the model is told exactly that rather than
 *                      being handed a confident absence it cannot verify.
 *   `outside_reach` — rows exist, every one of them older than the lookback
 *                      limit the person set for the Coach. Nothing about them
 *                      is reported, not a count, a date or a mean: the limit
 *                      says the Coach does not read them, and an aggregate is
 *                      a reading. The model says older readings lie beyond the
 *                      limit and can be opened in the Coach settings.
 *
 * Under a limit every probe below reads from inside it only, and
 * `reachableWithWindow` never names a window wider than the limit.
 *
 * Cost. One grouped aggregate over `Measurement` for every measurement-backed
 * subject in the batch (indexed by `(userId, type, measuredAt)`, no rows
 * materialised in JS), plus at most one `aggregate()` per non-measurement
 * subject kind actually asked for. It runs ONLY on the miss path, and only for
 * the domains that missed.
 *
 * Why an aggregate and not a wider window. The window cap exists because a
 * multi-year raw history does not fit a prompt budget — 1,597 CGM points cannot
 * go to the model. So the out-of-window range comes back as the six scalars SQL
 * can compute without materialising a row (count, first, last, mean, min, max
 * per series). That is bounded by construction, needs no rollup coverage, and
 * is enough for the Coach to answer the question instead of only naming it.
 */
import { prisma } from "@/lib/db";
import { Prisma, type MeasurementType } from "@/generated/prisma/client";
import { dayWeightedRowsSql, windowMeanSql } from "@/lib/measurements/day-mean";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";
import { userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { annotate } from "@/lib/logging/context";
import type { CoachScopeSource, CoachScopeWindow } from "@/lib/ai/coach/types";
import type { CoachToolName } from "./definitions";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import { windowToDays } from "@/lib/ai/coach/snapshot-series";
import { DEFAULT_WINDOW } from "@/lib/ai/coach/snapshot-cache";
import {
  UNBOUNDED_REACH,
  exceedsReach,
  reachFloor,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";

/** Which table a domain's existence has to be checked against. */
export type CoachAvailabilitySubject =
  | { kind: "measurement"; types: readonly MeasurementType[] }
  | { kind: "mood" }
  | { kind: "workout" }
  | { kind: "intake" }
  | { kind: "lab" };

/** Per-series aggregate over the whole recorded history of one series. */
interface CoachAvailabilitySeries {
  /** The measurement type, verbatim — unambiguous for the model. */
  series: string;
  /** The unit every row of this series carries, when they all agree. */
  unit: string | null;
  count: number;
  mean: number;
  min: number;
  max: number;
}

/**
 * What the record holds for a domain, over its whole history. Model-facing
 * only: it is serialised into the tool-result turn and the DATA INVENTORY, and
 * never rendered to a person, so it carries no i18n strings.
 */
export interface CoachDomainAvailability {
  /** Rows the record holds for this domain, over its whole history. */
  count: number;
  /** `YYYY-MM-DD` of the earliest row, in the user's display timezone. */
  firstDate: string;
  /** `YYYY-MM-DD` of the latest row, in the user's display timezone. */
  lastDate: string;
  /**
   * Bounded aggregate per series. Present for measurement-backed domains whose
   * rows all share one unit; omitted when the history mixes units (a mean
   * across mg/dL and mmol/L rows would be a fabricated number) and for the
   * domains that carry no single value column (workouts, intakes, labs, mood).
   */
  series?: CoachAvailabilitySeries[];
  /**
   * The widest window that would reach `lastDate`, when one exists — the model
   * can re-call the tool with it and get the real series. `null` when the
   * history lies beyond every window's reach, which is when the honest sentence
   * is the whole answer.
   */
  reachableWithWindow: CoachScopeWindow | null;
}

/** The windows a tool call may ask for, widest last. */
const WINDOWS_WIDEST_LAST: readonly CoachScopeWindow[] = [
  "last7days",
  "last30days",
  "last90days",
  "lastYear",
  "allTime",
];

/**
 * The narrowest window whose cutoff still contains `lastDate`, or `null` when
 * even the widest one does not reach it. `allTime` is capped at a year like
 * `lastYear` (see `windowToDays`), so a history older than that is genuinely
 * unreachable by re-calling with a wider window — and saying so is the point.
 */
function reachableWindow(
  lastAt: Date,
  now: Date,
  reach: CoachHistoryReach,
): CoachScopeWindow | null {
  const ageDays = (now.getTime() - lastAt.getTime()) / 86_400_000;
  for (const window of WINDOWS_WIDEST_LAST) {
    if (exceedsReach(window, reach)) break;
    if (ageDays <= windowToDays(window)) return window;
  }
  return null;
}

interface RawBounds {
  count: number;
  firstAt: Date;
  lastAt: Date;
  series?: Array<{
    series: string;
    unit: string | null;
    count: number;
    mean: number;
    min: number;
    max: number;
  }>;
}

/**
 * One grouped aggregate over `Measurement` for every type in `types`, split by
 * unit so a mixed-unit history is detectable rather than averaged.
 */
async function readMeasurementBounds(
  userId: string,
  types: readonly MeasurementType[],
  floor: Date | null,
): Promise<Map<MeasurementType, RawBounds>> {
  const rows = await prisma.measurement.groupBy({
    by: ["type", "unit"],
    where: {
      userId,
      deletedAt: null,
      type: { in: [...types] },
      ...(floor ? { measuredAt: { gte: floor } } : {}),
    },
    _count: { _all: true },
    _min: { measuredAt: true, value: true },
    _max: { measuredAt: true, value: true },
    _avg: { value: true },
  });
  const dayMeans = await readHourlyMeanTypeMeans(userId, types, floor);
  const out = new Map<MeasurementType, RawBounds>();
  for (const row of rows) {
    const firstAt = row._min.measuredAt;
    const lastAt = row._max.measuredAt;
    const min = row._min.value;
    const max = row._max.value;
    // A pulse mean is the mean of its days, each the mean of its hours'
    // means, so a dense workout hour does not stand in for the history.
    const mean = usesHourlyMeanDay(row.type)
      ? (dayMeans.get(`${row.type}|${row.unit}`) ?? null)
      : row._avg.value;
    if (!firstAt || !lastAt) continue;
    const existing = out.get(row.type);
    const unitEntry =
      min !== null && max !== null && mean !== null
        ? {
            series: row.type as string,
            unit: row.unit,
            count: row._count._all,
            // One decimal, like every other mean the snapshot surfaces — a raw
            // float would invite the model to quote a precision the reading
            // never had.
            mean: Math.round(mean * 10) / 10,
            min,
            max,
          }
        : null;
    if (!existing) {
      out.set(row.type, {
        count: row._count._all,
        firstAt,
        lastAt,
        ...(unitEntry ? { series: [unitEntry] } : {}),
      });
      continue;
    }
    // A second unit for the same type: merge the bounds, and drop the value
    // aggregate entirely — the two units cannot be folded into one mean.
    existing.count += row._count._all;
    if (firstAt < existing.firstAt) existing.firstAt = firstAt;
    if (lastAt > existing.lastAt) existing.lastAt = lastAt;
    delete existing.series;
  }
  return out;
}

/**
 * The all-time mean per type and unit for the hourly-mean types among
 * `types` (pulse, see `day-mean.ts`): the mean of the user's local days, each
 * the mean of its local hours' means. Empty when none of `types` is one.
 */
async function readHourlyMeanTypeMeans(
  userId: string,
  types: readonly MeasurementType[],
  floor: Date | null,
): Promise<Map<string, number>> {
  const hourly = types.filter((t) => usesHourlyMeanDay(t));
  const out = new Map<string, number>();
  if (hourly.length === 0) return out;
  const tz = await resolveUserTimezone(userId);
  const rows = await prisma.$queryRaw<
    Array<{ type: string; unit: string | null; mean: number | null }>
  >`
    WITH src AS (
      SELECT *
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
        AND m."type" IN (${Prisma.join(
          hourly.map((t) => Prisma.sql`${t}::measurement_type`),
        )})
        ${floor ? Prisma.sql`AND m."measured_at" >= ${floor}` : Prisma.empty}
    )
    SELECT
      m."type"::text AS type,
      m."unit" AS unit,
      ${Prisma.raw(
        windowMeanSql({
          typeColumn: 'm."type"',
          value: 'm."value"',
          weight: "m.day_weight",
        }),
      )}::double precision AS mean
    FROM ${dayWeightedRowsSql("src", tz)} m
    GROUP BY m."type", m."unit"
  `;
  for (const r of rows) {
    if (r.mean !== null) out.set(`${r.type}|${r.unit}`, Number(r.mean));
  }
  return out;
}

/** One `aggregate()` per non-measurement subject kind. */
async function readTableBounds(
  userId: string,
  kind: Exclude<CoachAvailabilitySubject["kind"], "measurement">,
  floor: Date | null,
): Promise<RawBounds | null> {
  if (kind === "mood") {
    const row = await prisma.moodEntry.aggregate({
      where: {
        userId,
        deletedAt: null,
        ...(floor ? { moodLoggedAt: { gte: floor } } : {}),
      },
      _count: { _all: true },
      _min: { moodLoggedAt: true },
      _max: { moodLoggedAt: true },
    });
    return row._min.moodLoggedAt && row._max.moodLoggedAt
      ? {
          count: row._count._all,
          firstAt: row._min.moodLoggedAt,
          lastAt: row._max.moodLoggedAt,
        }
      : null;
  }
  if (kind === "workout") {
    // Workout deletes are hard deletes — there is no `deletedAt` to filter.
    const row = await prisma.workout.aggregate({
      where: { userId, ...(floor ? { startedAt: { gte: floor } } : {}) },
      _count: { _all: true },
      _min: { startedAt: true },
      _max: { startedAt: true },
    });
    return row._min.startedAt && row._max.startedAt
      ? {
          count: row._count._all,
          firstAt: row._min.startedAt,
          lastAt: row._max.startedAt,
        }
      : null;
  }
  if (kind === "intake") {
    const row = await prisma.medicationIntakeEvent.aggregate({
      where: {
        userId,
        deletedAt: null,
        ...(floor ? { scheduledFor: { gte: floor } } : {}),
      },
      _count: { _all: true },
      _min: { scheduledFor: true },
      _max: { scheduledFor: true },
    });
    return row._min.scheduledFor && row._max.scheduledFor
      ? {
          count: row._count._all,
          firstAt: row._min.scheduledFor,
          lastAt: row._max.scheduledFor,
        }
      : null;
  }
  const row = await prisma.labResult.aggregate({
    where: {
      userId,
      deletedAt: null,
      ...(floor ? { takenAt: { gte: floor } } : {}),
    },
    _count: { _all: true },
    _min: { takenAt: true },
    _max: { takenAt: true },
  });
  return row._min.takenAt && row._max.takenAt
    ? {
        count: row._count._all,
        firstAt: row._min.takenAt,
        lastAt: row._max.takenAt,
      }
    : null;
}

/** Merge several raw bounds (a domain can span two measurement types). */
function mergeBounds(parts: readonly RawBounds[]): RawBounds | null {
  const present = parts.filter((p) => p.count > 0);
  if (present.length === 0) return null;
  const merged: RawBounds = {
    count: present.reduce((sum, p) => sum + p.count, 0),
    firstAt: present.reduce(
      (min, p) => (p.firstAt < min ? p.firstAt : min),
      present[0].firstAt,
    ),
    lastAt: present.reduce(
      (max, p) => (p.lastAt > max ? p.lastAt : max),
      present[0].lastAt,
    ),
  };
  const series = present.flatMap((p) => p.series ?? []);
  if (series.length > 0) merged.series = series;
  return merged;
}

/**
 * Probe several domains in one batch. Returns an entry ONLY for a domain the
 * record actually holds rows for — an absent key means "confirmed empty", which
 * is exactly the distinction the caller needs.
 *
 * Throws only if every read fails; the caller treats a throw as
 * `no_data_unconfirmed` rather than as absence.
 */
export async function probeCoachAvailability(
  userId: string,
  subjects: ReadonlyMap<string, CoachAvailabilitySubject>,
  options?: { now?: Date; reach?: CoachHistoryReach },
): Promise<Map<string, CoachDomainAvailability>> {
  const out = new Map<string, CoachDomainAvailability>();
  if (subjects.size === 0) return out;
  const now = options?.now ?? new Date();
  const reach = options?.reach ?? UNBOUNDED_REACH;
  const floor = reachFloor(reach, now);

  const measurementTypes = new Set<MeasurementType>();
  const tableKinds = new Set<
    Exclude<CoachAvailabilitySubject["kind"], "measurement">
  >();
  for (const subject of subjects.values()) {
    if (subject.kind === "measurement") {
      for (const type of subject.types) measurementTypes.add(type);
    } else {
      tableKinds.add(subject.kind);
    }
  }

  const [tz, measurementBounds, ...tableRows] = await Promise.all([
    resolveUserTimezone(userId),
    measurementTypes.size > 0
      ? readMeasurementBounds(userId, [...measurementTypes], floor)
      : Promise.resolve(new Map<MeasurementType, RawBounds>()),
    ...[...tableKinds].map(async (kind) => ({
      kind,
      bounds: await readTableBounds(userId, kind, floor),
    })),
  ]);
  const byKind = new Map(tableRows.map((r) => [r.kind, r.bounds]));

  for (const [key, subject] of subjects) {
    const raw =
      subject.kind === "measurement"
        ? mergeBounds(
            subject.types
              .map((type) => measurementBounds.get(type))
              .filter((b): b is RawBounds => b !== undefined),
          )
        : (byKind.get(subject.kind) ?? null);
    if (!raw) continue;
    out.set(key, {
      count: raw.count,
      firstDate: userDayKey(raw.firstAt, tz),
      lastDate: userDayKey(raw.lastAt, tz),
      ...(raw.series && raw.series.length > 0 ? { series: raw.series } : {}),
      reachableWithWindow: reachableWindow(raw.lastAt, now, reach),
    });
  }
  return out;
}

/**
 * The subjects among `subjects` that hold rows older than the lookback limit.
 * Existence only, one `findFirst` per subject: what lies beyond the limit is
 * never counted or aggregated. Empty without a limit.
 */
export async function probeBeyondReach(
  userId: string,
  subjects: ReadonlyMap<string, CoachAvailabilitySubject>,
  reach: CoachHistoryReach,
  now: Date = new Date(),
): Promise<Set<string>> {
  const floor = reachFloor(reach, now);
  const out = new Set<string>();
  if (floor === null) return out;
  await Promise.all(
    [...subjects].map(async ([key, subject]) => {
      if (await holdsRowsBefore(userId, subject, floor)) out.add(key);
    }),
  );
  return out;
}

async function holdsRowsBefore(
  userId: string,
  subject: CoachAvailabilitySubject,
  floor: Date,
): Promise<boolean> {
  switch (subject.kind) {
    case "measurement":
      return (
        (await prisma.measurement.findFirst({
          where: {
            userId,
            deletedAt: null,
            type: { in: [...subject.types] },
            measuredAt: { lt: floor },
          },
          select: { id: true },
        })) !== null
      );
    case "mood":
      return (
        (await prisma.moodEntry.findFirst({
          where: { userId, deletedAt: null, moodLoggedAt: { lt: floor } },
          select: { id: true },
        })) !== null
      );
    case "workout":
      return (
        (await prisma.workout.findFirst({
          where: { userId, startedAt: { lt: floor } },
          select: { id: true },
        })) !== null
      );
    case "intake":
      return (
        (await prisma.medicationIntakeEvent.findFirst({
          where: { userId, deletedAt: null, scheduledFor: { lt: floor } },
          select: { id: true },
        })) !== null
      );
    case "lab":
      return (
        (await prisma.labResult.findFirst({
          where: { userId, deletedAt: null, takenAt: { lt: floor } },
          select: { id: true },
        })) !== null
      );
  }
}

/**
 * True when the record holds illness episodes that began before the lookback
 * floor. The illness domain has no row subject (its block is computed), so a
 * limited read that comes back empty asks this to tell "never recorded" from
 * "recorded, beyond the limit". Always false without a limit.
 */
export async function illnessBeyondReach(
  userId: string,
  reach: CoachHistoryReach,
  now: Date = new Date(),
): Promise<boolean> {
  const floor = reachFloor(reach, now);
  if (floor === null) return false;
  const row = await prisma.illnessEpisode.findFirst({
    where: { userId, deletedAt: null, onsetAt: { lt: floor } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * True when the record holds any logged cycle. Under a lookback limit the
 * cycle block is left out whole (it predicts from every cycle), so an
 * account with cycles is told they lie beyond the limit, and one without is
 * told there are none.
 */
export async function cycleRecorded(userId: string): Promise<boolean> {
  const row = await prisma.menstrualCycle.findFirst({
    where: { userId, deletedAt: null },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The reason codes a `present: false` tool result may carry when it came from
 * an empty window read. Frozen so a future reader (a test, a dashboard) can
 * assert the three states stay three.
 */
const EMPTY_READ_REASONS = {
  /** Probe confirmed: the record holds nothing for this domain, ever. */
  none: "no_data",
  /** Rows exist, all of them outside the window that was searched. */
  outsideWindow: "outside_window",
  /** Rows exist inside the searched window; the domain still produced none. */
  unavailableInScope: "unavailable_in_scope",
  /** The probe failed; absence could not be established either way. */
  unconfirmed: "no_data_unconfirmed",
  /** Rows exist, all of them older than the person's lookback limit. */
  outsideReach: "outside_reach",
} as const;

/** The reason a read gives for data that lies only beyond the lookback limit. */
export const OUTSIDE_REACH_REASON = EMPTY_READ_REASONS.outsideReach;

/**
 * Split a "rows exist" verdict into the two cases that differ in what the model
 * should do next.
 *
 * `reachableWithWindow` is the NARROWEST window that reaches the latest row, so
 * when it is no wider than the window already searched the rows were inside that
 * window and the miss is not a window artefact at all — re-calling wider would
 * change nothing.
 */
export function classifyAvailability(
  available: CoachDomainAvailability,
  searchedWindow: CoachScopeWindow | undefined,
):
  | typeof EMPTY_READ_REASONS.outsideWindow
  | typeof EMPTY_READ_REASONS.unavailableInScope {
  const reachable = available.reachableWithWindow;
  if (reachable === null) return EMPTY_READ_REASONS.outsideWindow;
  const searchedDays = windowToDays(searchedWindow ?? DEFAULT_WINDOW);
  return windowToDays(reachable) <= searchedDays
    ? EMPTY_READ_REASONS.unavailableInScope
    : EMPTY_READ_REASONS.outsideWindow;
}

/** A `present: false` result with the window/history discriminant resolved. */
interface EmptyReadResult {
  present: false;
  reason: string;
  /** The window the empty read searched, so the miss is self-describing. */
  searchedWindow?: string;
  available?: CoachDomainAvailability;
}

/**
 * Resolve ONE empty window read into the honest reason. Every `present: false`
 * that comes from "the snapshot section was absent" routes through here; a
 * bare `no_data` is never returned without the probe having confirmed it.
 */
export async function resolveEmptyRead(args: {
  userId: string;
  /** Stable key for logs — the tool or domain name. */
  domain: string;
  subject: CoachAvailabilitySubject | null;
  searchedWindow: CoachScopeWindow | undefined;
  now?: Date;
  /** The person's lookback limit; absent (MCP) is none. */
  reach?: CoachHistoryReach;
}): Promise<EmptyReadResult> {
  const { userId, domain, subject, searchedWindow } = args;
  const reach = args.reach ?? UNBOUNDED_REACH;
  const searched = searchedWindow ? { searchedWindow } : {};
  // A domain with no row-backed subject (illness, cycle, correlations) is not
  // window-filtered from a table of rows — its block is computed or gated, so
  // an absent block is an honest absence and there is nothing to probe.
  if (subject === null) {
    return { present: false, reason: EMPTY_READ_REASONS.none, ...searched };
  }
  let availability: Map<string, CoachDomainAvailability>;
  try {
    availability = await probeCoachAvailability(
      userId,
      new Map([[domain, subject]]),
      { ...(args.now ? { now: args.now } : {}), reach },
    );
    if (!availability.has(domain)) {
      const beyond = await probeBeyondReach(
        userId,
        new Map([[domain, subject]]),
        reach,
        args.now,
      );
      if (beyond.has(domain)) {
        annotate({
          action: { name: "coach.availability.resolved" },
          meta: { domain, reason: EMPTY_READ_REASONS.outsideReach },
        });
        return {
          present: false,
          reason: EMPTY_READ_REASONS.outsideReach,
          ...searched,
        };
      }
    }
  } catch (err) {
    annotate({
      action: { name: "coach.availability.probe_failed" },
      meta: {
        domain,
        reason: err instanceof Error ? err.name : "unknown",
      },
    });
    return {
      present: false,
      reason: EMPTY_READ_REASONS.unconfirmed,
      ...searched,
    };
  }
  const available = availability.get(domain);
  if (!available) {
    return { present: false, reason: EMPTY_READ_REASONS.none, ...searched };
  }
  const reason = classifyAvailability(available, searchedWindow);
  annotate({
    action: { name: "coach.availability.resolved" },
    meta: {
      domain,
      reason,
      count: available.count,
      reachable: available.reachableWithWindow ?? "none",
    },
  });
  return { present: false, reason, ...searched, available };
}

/**
 * The subject a `get_metric_series` metric is checked against. `mood` reads
 * MoodEntry; every other series-backed source reads `Measurement`.
 */
function subjectForMetricSource(
  metric: CoachScopeSource,
): CoachAvailabilitySubject | null {
  if (metric === "mood") return { kind: "mood" };
  if (metric === "workouts") return { kind: "workout" };
  if (metric === "compliance") return { kind: "intake" };
  const types = COACH_SOURCE_MEASUREMENT_TYPES[metric];
  if (!types || types.length === 0) return null;
  return { kind: "measurement", types };
}

/**
 * The one table mapping a tool to the rows its existence is checked against.
 * Used by BOTH the executor (per miss) and the DATA INVENTORY (per absent
 * domain), so the two can never disagree about what a domain is backed by.
 *
 * The switch is exhaustive over `CoachToolName`: adding a tool without deciding
 * what it is probed against fails to compile rather than silently inheriting the
 * lossy `no_data`. `null` is a deliberate answer — the three derived domains
 * (illness / cycle / correlations) are computed or gated rather than sliced out
 * of one table, so there is no row set whose date bounds would mean anything.
 */
export function subjectForTool(
  tool: CoachToolName,
  metric?: CoachScopeSource,
): CoachAvailabilitySubject | null {
  switch (tool) {
    case "get_metric_series":
    case "get_metric_table":
      return metric ? subjectForMetricSource(metric) : null;
    case "get_glucose_panel":
      return subjectForMetricSource("glucose");
    case "get_sleep":
      return subjectForMetricSource("sleep");
    case "get_medication_compliance":
      return { kind: "intake" };
    case "get_workouts":
      return { kind: "workout" };
    case "get_labs":
      return { kind: "lab" };
    case "get_illness_recovery":
    case "get_cycle":
    case "get_correlations":
    // v1.42 — the environment read probes its own table and reports its own
    // reason (module_disabled / no_data / outside_window).
    case "get_environment":
      return null;
  }
}
