/**
 * The time-series face of `GET /api/fhir/Observation`: every recorded reading
 * as its own Observation, newest first, paged in the database.
 *
 * The search route's default answer stays what it always was, a snapshot of
 * the record (one latest reading per type plus the derived panels, ids
 * `obs-N`). A client opts into the series by naming a `date` range, which is
 * what a FHIR client does when it wants readings over time; the snapshot has
 * no date range to filter, so the parameter never meant anything there
 * before. Additive by construction: no existing request changes its answer.
 *
 *   date=ge2026-01-01&date=lt2026-02-01   readings in January (UTC)
 *   code=http://loinc.org|80404-7         narrowed to SDNN (also in snapshot mode)
 *   _count / _offset                      paging, as on every search route
 *
 * Series ids are the row's own (`m-<id>` for a measurement, `w-<id>` for a
 * workout) so a reading keeps its id across pages and windows, and
 * `GET /Observation/{id}` reads it back.
 *
 * Scope is the snapshot's: the owner's saved report selection and module map
 * decide which types may appear (`resolveReportGate`), so the series can
 * never reach a type the snapshot would withhold. Memory is bounded by the
 * page: one id query (a UNION over measurements and workouts, ordered and
 * paged in SQL), one count, and a by-id read of at most `_count` rows.
 *
 * Every row as recorded. Two sources writing the same weighing are two
 * readings here; the snapshot is the de-duplicated view. Sleep is not in the
 * series: it is stored as per-stage segments, and a segment is not a night.
 */
import { Prisma } from "@/generated/prisma/client";
import type {
  GlucoseContext,
  MeasurementType,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  convertGlucose,
  resolveGlucoseUnit,
  type GlucoseUnit,
} from "@/lib/glucose";
import {
  BP_DIA_LOINC,
  BP_PANEL_LOINC,
  BP_SYS_LOINC,
  BP_UNIT,
  GLUCOSE_LOINC,
  HEALTHKIT_CODESYSTEM,
  LOINC_SYSTEM,
  MEASUREMENT_LOINC,
} from "@/lib/fhir/loinc-map";
import { ucumQuantity } from "@/lib/fhir/ucum";
import type {
  FhirObservation,
  FhirObservationComponent,
} from "@/lib/fhir/types";
import {
  categoryConcept,
  codeableFromMapping,
  patientRef,
} from "@/lib/fhir/resources/common";
import type { ReportGate } from "@/lib/doctor-report/selection-gate";
import { ownValue } from "@/lib/own-key";

// ── date parameter ──────────────────────────────────────────────────────

/** A half-open instant range; either end may be open. */
export interface SeriesRange {
  from: Date | null;
  to: Date | null;
}

const DATE_RE =
  /^(eq|gt|ge|lt|le)?(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

/**
 * The instant span one FHIR date value covers: a year, a month, a day, a
 * minute or a second. A value without an offset is read as UTC.
 */
function dateSpan(match: RegExpMatchArray): { start: Date; end: Date } | null {
  const [, , y, mo, d, h, mi, s, tz] = match;
  const year = Number(y);
  if (mo === undefined) {
    return {
      start: new Date(Date.UTC(year, 0, 1)),
      end: new Date(Date.UTC(year + 1, 0, 1)),
    };
  }
  const month = Number(mo) - 1;
  if (month < 0 || month > 11) return null;
  if (d === undefined) {
    return {
      start: new Date(Date.UTC(year, month, 1)),
      end: new Date(Date.UTC(year, month + 1, 1)),
    };
  }
  const day = Number(d);
  const dayStart = new Date(Date.UTC(year, month, day));
  if (dayStart.getUTCMonth() !== month || dayStart.getUTCDate() !== day) {
    return null;
  }
  if (h === undefined) {
    return { start: dayStart, end: new Date(dayStart.getTime() + 86_400_000) };
  }
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}${tz ?? "Z"}`;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + (s ? 1000 : 60_000)) };
}

/**
 * Parse every `date` value into one range (their intersection). Returns null
 * when no `date` parameter was sent, and an error string for a value the
 * server cannot read — a 400, never a silently ignored filter.
 */
export function parseDateParams(
  values: readonly string[],
): SeriesRange | { error: string } | null {
  if (values.length === 0) return null;
  let from: Date | null = null;
  let to: Date | null = null;
  const later = (a: Date | null, b: Date) => (a && a > b ? a : b);
  const earlier = (a: Date | null, b: Date) => (a && a < b ? a : b);
  for (const raw of values) {
    for (const value of raw.split(",")) {
      const match = value.trim().match(DATE_RE);
      const span = match ? dateSpan(match) : null;
      if (!match || !span) {
        return { error: `Unsupported date value: ${value.slice(0, 40)}` };
      }
      switch (match[1] ?? "eq") {
        case "eq":
          from = later(from, span.start);
          to = earlier(to, span.end);
          break;
        case "ge":
          from = later(from, span.start);
          break;
        case "gt":
          from = later(from, span.end);
          break;
        case "le":
          to = earlier(to, span.end);
          break;
        case "lt":
          to = earlier(to, span.start);
          break;
      }
    }
  }
  return { from, to };
}

// ── code parameter ──────────────────────────────────────────────────────

/** Exercise activity — the LOINC a workout Observation is coded with. */
export const EXERCISE_ACTIVITY_LOINC = "73985-4";
/** Exercise duration (min). */
export const EXERCISE_DURATION_LOINC = "55411-3";
/** Calories burned (kcal). */
export const CALORIES_BURNED_LOINC = "41981-2";
/** Local CodeSystem for the canonical workout sport keys. */
export const WORKOUT_SPORT_CODESYSTEM =
  "https://healthlog.dev/fhir/CodeSystem/workout-sport";

/** What a set of codes selects from the series. */
export interface SeriesCodeFilter {
  types: Set<MeasurementType>;
  /** Glucose contexts a glucose code narrows to; null keeps every context. */
  glucoseContexts: Set<GlucoseContext | "NONE"> | null;
  workouts: boolean;
}

const GLUCOSE_CONTEXT_OF: Record<string, GlucoseContext | "NONE"> = {
  FASTING: "FASTING",
  POSTPRANDIAL: "POSTPRANDIAL",
  RANDOM: "RANDOM",
  BEDTIME: "BEDTIME",
  UNSPECIFIED: "NONE",
};

/**
 * Resolve `code` tokens (`system|code` or a bare code, comma-separated, any
 * number of parameters) to the types they select. Returns null when no
 * `code` was sent. An unknown code selects nothing — an empty Bundle, which
 * is FHIR's answer to a search that matches nothing.
 */
export function parseCodeParams(
  values: readonly string[],
): SeriesCodeFilter | null {
  if (values.length === 0) return null;
  const filter: SeriesCodeFilter = {
    types: new Set(),
    glucoseContexts: null,
    workouts: false,
  };
  let glucoseContexts: Set<GlucoseContext | "NONE"> | null = null;
  for (const raw of values) {
    for (const token of raw.split(",")) {
      const bar = token.indexOf("|");
      const system = bar >= 0 ? token.slice(0, bar) : null;
      const code = (bar >= 0 ? token.slice(bar + 1) : token).trim();
      if (!code) continue;
      const loinc = system === null || system === "" || system === LOINC_SYSTEM;
      const healthkit = system === null || system === HEALTHKIT_CODESYSTEM;
      if (loinc && code === EXERCISE_ACTIVITY_LOINC) filter.workouts = true;
      if (
        loinc &&
        (code === BP_PANEL_LOINC ||
          code === BP_SYS_LOINC ||
          code === BP_DIA_LOINC)
      ) {
        filter.types.add("BLOOD_PRESSURE_SYS");
        filter.types.add("BLOOD_PRESSURE_DIA");
      }
      if (loinc) {
        for (const [ctx, map] of Object.entries(GLUCOSE_LOINC)) {
          if (map.loinc !== code) continue;
          filter.types.add("BLOOD_GLUCOSE");
          const context = ownValue(GLUCOSE_CONTEXT_OF, ctx);
          if (!context) continue;
          glucoseContexts ??= new Set();
          glucoseContexts.add(context);
        }
      }
      for (const [type, mapping] of Object.entries(MEASUREMENT_LOINC)) {
        if (mapping.loinc !== code) continue;
        const isHk = mapping.loinc.startsWith("HKQuantityTypeIdentifier");
        if ((isHk && healthkit) || (!isHk && loinc)) {
          filter.types.add(type as MeasurementType);
        }
      }
    }
  }
  filter.glucoseContexts = glucoseContexts;
  return filter;
}

// ── scope ───────────────────────────────────────────────────────────────

/** Types the series can carry: every single-value coding, BP and glucose. Never sleep. */
export function seriesCandidateTypes(): MeasurementType[] {
  const types = Object.keys(MEASUREMENT_LOINC).filter(
    (t) => t !== "SLEEP_DURATION",
  ) as MeasurementType[];
  return [
    ...types,
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "BLOOD_GLUCOSE",
  ];
}

export interface SeriesScope {
  types: MeasurementType[];
  /** Pair diastolic onto systolic (both admitted): the BP panel. */
  pairBloodPressure: boolean;
  glucoseContexts: Set<GlucoseContext | "NONE"> | null;
  workouts: boolean;
}

/** The gate's answer, narrowed by an optional code filter. */
export function resolveSeriesScope(
  gate: Pick<ReportGate, "admits">,
  codes: SeriesCodeFilter | null,
): SeriesScope {
  const types = seriesCandidateTypes().filter(
    (t) => gate.admits(t) && (codes === null || codes.types.has(t)),
  );
  return {
    types,
    pairBloodPressure:
      types.includes("BLOOD_PRESSURE_SYS") &&
      types.includes("BLOOD_PRESSURE_DIA"),
    glucoseContexts: codes?.glucoseContexts ?? null,
    workouts: gate.admits("WORKOUTS") && (codes === null || codes.workouts),
  };
}

// ── query ───────────────────────────────────────────────────────────────

/** One page of series row references, newest first. */
interface SeriesRef {
  kind: "m" | "w";
  id: string;
}

function rangeSql(column: string, range: SeriesRange): Prisma.Sql {
  const col = Prisma.raw(column);
  return Prisma.sql`${
    range.from ? Prisma.sql`AND ${col} >= ${range.from}` : Prisma.empty
  } ${range.to ? Prisma.sql`AND ${col} < ${range.to}` : Prisma.empty}`;
}

/**
 * The UNION the page and the count share. Every value is a bound parameter;
 * the only spliced text is the closed column names above.
 */
function seriesUnion(
  userId: string,
  scope: SeriesScope,
  range: SeriesRange,
): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];
  if (scope.types.length > 0) {
    const contexts = scope.glucoseContexts;
    const glucoseFilter =
      contexts === null
        ? Prisma.empty
        : Prisma.sql`AND (m."type" <> 'BLOOD_GLUCOSE'::"measurement_type" OR m."glucose_context"::text = ANY(${[
            ...contexts,
          ].filter((c) => c !== "NONE")}::text[]) OR (${contexts.has(
            "NONE",
          )}::boolean AND m."glucose_context" IS NULL))`;
    // A diastolic reading that has its systolic partner rides inside the
    // systolic row's panel, never as a second entry.
    const pairFilter = scope.pairBloodPressure
      ? Prisma.sql`AND NOT (m."type" = 'BLOOD_PRESSURE_DIA'::"measurement_type" AND EXISTS (
            SELECT 1 FROM measurements s
            WHERE s."user_id" = m."user_id"
              AND s."type" = 'BLOOD_PRESSURE_SYS'::"measurement_type"
              AND s."measured_at" = m."measured_at"
              AND s."deleted_at" IS NULL))`
      : Prisma.empty;
    parts.push(Prisma.sql`
      SELECT 'm' AS kind, m."id" AS id, m."measured_at" AS at
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
        AND m."type"::text = ANY(${scope.types}::text[])
        ${rangeSql('m."measured_at"', range)}
        ${glucoseFilter}
        ${pairFilter}`);
  }
  if (scope.workouts) {
    parts.push(Prisma.sql`
      SELECT 'w' AS kind, w."id" AS id, w."started_at" AS at
      FROM workouts w
      WHERE w."user_id" = ${userId}
        ${rangeSql('w."started_at"', range)}`);
  }
  if (parts.length === 0) return null;
  return Prisma.join(parts, " UNION ALL ");
}

/** The total match count and one page of references, newest first. */
export async function querySeriesPage(params: {
  userId: string;
  scope: SeriesScope;
  range: SeriesRange;
  count: number;
  offset: number;
}): Promise<{ total: number; refs: SeriesRef[] }> {
  const { userId, scope, range, count, offset } = params;
  const union = seriesUnion(userId, scope, range);
  if (!union) return { total: 0, refs: [] };
  const [totals, refs] = await Promise.all([
    prisma.$queryRaw<Array<{ total: bigint | number }>>`
      SELECT COUNT(*) AS total FROM (${union}) AS series`,
    prisma.$queryRaw<SeriesRef[]>`
      SELECT kind, id FROM (${union}) AS series
      ORDER BY at DESC, id DESC
      LIMIT ${count} OFFSET ${offset}`,
  ]);
  return { total: Number(totals[0]?.total ?? 0), refs };
}

// ── emit ────────────────────────────────────────────────────────────────

const MEASUREMENT_SELECT = {
  id: true,
  type: true,
  value: true,
  valueMin: true,
  valueMax: true,
  measuredAt: true,
  glucoseContext: true,
} as const;

type SeriesMeasurementRow = {
  id: string;
  type: MeasurementType;
  value: number;
  valueMin: number | null;
  valueMax: number | null;
  measuredAt: Date;
  glucoseContext: GlucoseContext | null;
};

type SeriesWorkoutRow = {
  id: string;
  sportType: string;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalDistanceM: number | null;
  totalEnergyKcal: number | null;
  avgHeartRate: number | null;
};

const WORKOUT_SELECT = {
  id: true,
  sportType: true,
  startedAt: true,
  endedAt: true,
  durationSec: true,
  totalDistanceM: true,
  totalEnergyKcal: true,
  avgHeartRate: true,
} as const;

function bpComponent(
  code: string,
  display: string,
  value: number,
): FhirObservationComponent {
  return {
    code: { coding: [{ system: LOINC_SYSTEM, code, display }] },
    valueQuantity: ucumQuantity(value, BP_UNIT),
  };
}

const HOUR_MS = 60 * 60 * 1000;

/** One measurement row as an Observation; null for a type the series does not code. */
export function measurementSeriesObservation(
  row: SeriesMeasurementRow,
  glucoseUnit: GlucoseUnit,
  diastolic: number | null,
): FhirObservation | null {
  const id = `m-${row.id}`;
  const at = row.measuredAt.toISOString();
  if (row.type === "BLOOD_PRESSURE_SYS" || row.type === "BLOOD_PRESSURE_DIA") {
    const sys = row.type === "BLOOD_PRESSURE_SYS";
    if (sys && diastolic !== null) {
      return {
        resourceType: "Observation",
        id,
        status: "final",
        category: [categoryConcept("vital-signs")],
        code: {
          coding: [
            {
              system: LOINC_SYSTEM,
              code: BP_PANEL_LOINC,
              display: "Blood pressure panel with all children optional",
            },
          ],
          text: "Blood pressure",
        },
        subject: patientRef,
        effectiveDateTime: at,
        component: [
          bpComponent(BP_SYS_LOINC, "Systolic blood pressure", row.value),
          bpComponent(BP_DIA_LOINC, "Diastolic blood pressure", diastolic),
        ],
      };
    }
    // A lone component (its partner withheld or never recorded) is still a
    // reading, coded with its own LOINC. It carries no vital-signs category:
    // the R4 blood-pressure profile wants both components, and a category
    // that promises the profile would be a claim the resource cannot keep.
    return {
      resourceType: "Observation",
      id,
      status: "final",
      code: {
        coding: [
          sys
            ? {
                system: LOINC_SYSTEM,
                code: BP_SYS_LOINC,
                display: "Systolic blood pressure",
              }
            : {
                system: LOINC_SYSTEM,
                code: BP_DIA_LOINC,
                display: "Diastolic blood pressure",
              },
        ],
        text: sys ? "Systolic blood pressure" : "Diastolic blood pressure",
      },
      subject: patientRef,
      effectiveDateTime: at,
      valueQuantity: ucumQuantity(row.value, BP_UNIT),
    };
  }
  if (row.type === "BLOOD_GLUCOSE") {
    const map = GLUCOSE_LOINC[row.glucoseContext ?? "UNSPECIFIED"];
    if (!map) return null;
    return {
      resourceType: "Observation",
      id,
      status: "final",
      category: [categoryConcept("laboratory")],
      code: {
        coding: [
          { system: LOINC_SYSTEM, code: map.loinc, display: map.display },
        ],
        text: map.display,
      },
      subject: patientRef,
      effectiveDateTime: at,
      valueQuantity: ucumQuantity(
        convertGlucose(row.value, glucoseUnit),
        glucoseUnit,
      ),
    };
  }
  const mapping = MEASUREMENT_LOINC[row.type];
  if (!mapping || row.type === "SLEEP_DURATION") return null;
  // An hourly heart-rate bucket (min and max stored beside the mean) is a
  // mean over its hour, not a reading at its first instant.
  const hourly = row.valueMin !== null && row.valueMax !== null;
  return {
    resourceType: "Observation",
    id,
    status: "final",
    category: [categoryConcept(mapping.category)],
    code: codeableFromMapping(mapping),
    subject: patientRef,
    ...(hourly
      ? {
          effectivePeriod: {
            start: at,
            end: new Date(row.measuredAt.getTime() + HOUR_MS).toISOString(),
          },
          note: [
            {
              text: `Mean over the hour; range ${row.valueMin} to ${row.valueMax} ${mapping.unit}.`,
            },
          ],
        }
      : { effectiveDateTime: at }),
    valueQuantity: ucumQuantity(row.value, mapping.unit),
  };
}

/** The sport key in words, for `valueCodeableConcept.text`. */
function sportText(sportType: string): string {
  return sportType
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

/**
 * A workout as an Observation, after the HL7 Physical Activity IG: the
 * session is an `activity` Observation coded 73985-4 (Exercise activity) whose
 * value is the kind of exercise, over the session's period, with duration and
 * energy as LOINC-coded components. Not a Procedure: R4 reserves Procedure
 * for something done to or for the patient by a care process, and a run is a
 * measured behaviour.
 */
export function workoutSeriesObservation(
  row: SeriesWorkoutRow,
): FhirObservation {
  const component: FhirObservationComponent[] = [
    {
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: EXERCISE_DURATION_LOINC,
            display: "Exercise duration",
          },
        ],
      },
      valueQuantity: ucumQuantity(
        Math.round((row.durationSec / 60) * 100) / 100,
        "min",
      ),
    },
  ];
  if (row.totalEnergyKcal !== null && row.totalEnergyKcal > 0) {
    component.push({
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: CALORIES_BURNED_LOINC,
            display: "Calories burned",
          },
        ],
      },
      valueQuantity: ucumQuantity(row.totalEnergyKcal, "kcal"),
    });
  }
  if (row.totalDistanceM !== null && row.totalDistanceM > 0) {
    component.push({
      code: { text: "Distance" },
      valueQuantity: ucumQuantity(row.totalDistanceM, "m"),
    });
  }
  if (row.avgHeartRate !== null && row.avgHeartRate > 0) {
    component.push({
      code: { text: "Average heart rate during exercise" },
      valueQuantity: ucumQuantity(row.avgHeartRate, "/min"),
    });
  }
  return {
    resourceType: "Observation",
    id: `w-${row.id}`,
    status: "final",
    category: [categoryConcept("activity")],
    code: {
      coding: [
        {
          system: LOINC_SYSTEM,
          code: EXERCISE_ACTIVITY_LOINC,
          display: "Exercise activity",
        },
      ],
      text: "Exercise activity",
    },
    subject: patientRef,
    effectivePeriod: {
      start: row.startedAt.toISOString(),
      end: row.endedAt.toISOString(),
    },
    valueCodeableConcept: {
      coding: [{ system: WORKOUT_SPORT_CODESYSTEM, code: row.sportType }],
      text: sportText(row.sportType),
    },
    component,
  };
}

/** The diastolic value recorded at the same instant as each systolic row. */
async function diastolicPartners(
  userId: string,
  systolicAt: Date[],
): Promise<Map<number, number>> {
  if (systolicAt.length === 0) return new Map();
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "BLOOD_PRESSURE_DIA",
      deletedAt: null,
      measuredAt: { in: systolicAt },
    },
    select: { value: true, measuredAt: true },
  });
  return new Map(rows.map((r) => [r.measuredAt.getTime(), r.value]));
}

/** Load and emit one page of references, keeping their order. */
export async function emitSeriesPage(params: {
  userId: string;
  refs: readonly SeriesRef[];
  scope: SeriesScope;
  glucoseUnit: GlucoseUnit;
}): Promise<FhirObservation[]> {
  const { userId, refs, scope, glucoseUnit } = params;
  const mIds = refs.filter((r) => r.kind === "m").map((r) => r.id);
  const wIds = refs.filter((r) => r.kind === "w").map((r) => r.id);
  const [measurements, workouts] = await Promise.all([
    mIds.length > 0
      ? prisma.measurement.findMany({
          where: { userId, id: { in: mIds }, deletedAt: null },
          select: MEASUREMENT_SELECT,
        })
      : Promise.resolve([]),
    wIds.length > 0
      ? prisma.workout.findMany({
          where: { userId, id: { in: wIds } },
          select: WORKOUT_SELECT,
        })
      : Promise.resolve([]),
  ]);
  const partners = scope.pairBloodPressure
    ? await diastolicPartners(
        userId,
        measurements
          .filter((m) => m.type === "BLOOD_PRESSURE_SYS")
          .map((m) => m.measuredAt),
      )
    : new Map<number, number>();
  const byM = new Map(measurements.map((m) => [m.id, m]));
  const byW = new Map(workouts.map((w) => [w.id, w]));
  const out: FhirObservation[] = [];
  for (const ref of refs) {
    if (ref.kind === "w") {
      const w = byW.get(ref.id);
      if (w) out.push(workoutSeriesObservation(w));
      continue;
    }
    const m = byM.get(ref.id);
    if (!m) continue;
    const obs = measurementSeriesObservation(
      m,
      glucoseUnit,
      m.type === "BLOOD_PRESSURE_SYS"
        ? (partners.get(m.measuredAt.getTime()) ?? null)
        : null,
    );
    if (obs) out.push(obs);
  }
  return out;
}

/**
 * Read one series Observation by its id (`m-…` / `w-…`), inside the same
 * scope the search applies. Null for an id outside the caller's record or
 * scope — the route answers both with the same `not-found`.
 */
export async function readSeriesObservation(params: {
  userId: string;
  id: string;
  scope: SeriesScope;
  glucoseUnit: GlucoseUnit;
}): Promise<FhirObservation | null> {
  const { userId, id, scope, glucoseUnit } = params;
  if (id.startsWith("w-")) {
    if (!scope.workouts) return null;
    const w = await prisma.workout.findFirst({
      where: { userId, id: id.slice(2) },
      select: WORKOUT_SELECT,
    });
    return w ? workoutSeriesObservation(w) : null;
  }
  if (!id.startsWith("m-")) return null;
  const m = await prisma.measurement.findFirst({
    where: { userId, id: id.slice(2), deletedAt: null },
    select: MEASUREMENT_SELECT,
  });
  if (!m || !scope.types.includes(m.type)) return null;
  const partners =
    scope.pairBloodPressure && m.type === "BLOOD_PRESSURE_SYS"
      ? await diastolicPartners(userId, [m.measuredAt])
      : new Map<number, number>();
  return measurementSeriesObservation(
    m,
    glucoseUnit,
    partners.get(m.measuredAt.getTime()) ?? null,
  );
}

/** The owner's display glucose unit, for series values. */
export async function seriesGlucoseUnit(userId: string): Promise<GlucoseUnit> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { glucoseUnit: true },
  });
  return resolveGlucoseUnit(user?.glucoseUnit ?? null);
}

/**
 * Snapshot-mode `code` filter: keep the Observations whose `code` carries one
 * of the tokens (`system|code`, or a bare code matching any system).
 */
export function matchesCodeTokens(
  observation: FhirObservation,
  values: readonly string[],
): boolean {
  const tokens = values.flatMap((v) => v.split(",")).map((t) => t.trim());
  const codings = observation.code.coding ?? [];
  return tokens.some((token) => {
    if (!token) return false;
    const bar = token.indexOf("|");
    const system = bar >= 0 ? token.slice(0, bar) : null;
    const code = bar >= 0 ? token.slice(bar + 1) : token;
    return codings.some(
      (c) =>
        c.code === code &&
        (system === null || system === "" || c.system === system),
    );
  });
}
