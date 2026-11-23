import type {
  GlucoseContext,
  MeasurementSource,
  MeasurementType,
  PrismaClient,
  SleepStage,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { BpInTargetEnvelope } from "@/lib/analytics/bp-in-target-fast-path";
import { collectBpPairs } from "@/lib/analytics/bp-in-target";
import {
  gradeBpScoreFromSeries,
  representativeBpFromSeries,
  type BpGrade,
} from "@/lib/analytics/bp-grade";
import type { BpTargets } from "@/lib/analytics/bp-targets";
import { resolveWeightTargetOverride } from "@/lib/analytics/effective-range";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { reconstructNights } from "@/lib/insights/derived/sleep-score";
import { pickCumulativeDaySum } from "@/lib/measurements/cumulative-day-sum";
import { ageInYears } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";
import { healthScoreNoticeItemKey } from "@/lib/daily/priority-item-key";
import { annotate, getEvent } from "@/lib/logging/context";

import { ACTIVITY_WINDOW_DAYS, activityWindowKeys } from "./activity";
import { SLEEP_WINDOW_DAYS } from "./sleep";
import { attachScoreDelta } from "./composite";
import {
  buildCompositionNotice,
  compositionNoticeKey,
  type StoredCompositionDay,
} from "./composition-notice";
import {
  resolveHealthScoreConfig,
  resolveScoreConfigured,
  scoreConfigBoundary,
} from "./config";
import { pillarsWithModuleData, type ScoreReaderModules } from "./modules";
import { computeHealthScore } from "./index";
import type { HealthScoreReport, PillarInputs, ScorePillarId } from "./types";
import { computeWeightGoal } from "./weight-goal";
import { pregnancyContextFor } from "@/lib/cycle/pregnancy-context";
import { DAY_MS, uniqueSources } from "./shared";
import type { DerivedProvenanceSource } from "@/lib/insights/derived/types";
import type { GlucoseUnit } from "@/lib/glucose";
import {
  SCREENER_INSTRUMENTS,
  isScreenerInstrument,
} from "@/lib/validations/mental-health";

const HISTORY_OFFSET_DAYS = 14;
const SCORE_READ_DAYS = 365 + HISTORY_OFFSET_DAYS;

export interface ScoreReaderProfile {
  dateOfBirth: Date | null;
  heightCm: number | null;
  timezone: string;
  sourcePriorityJson: unknown;
  thresholdsJson: unknown;
  /**
   * The record's glucose unit, for the glycaemia pillar's display labels.
   * Required: those labels are served as finished text (the app prints them
   * verbatim), and a caller that forgets the unit must not get mg/dL.
   */
  glucoseUnit: GlucoseUnit;
}

export interface UserHealthScoreInput {
  prisma?: PrismaClient;
  userId: string;
  now: Date;
  profile: ScoreReaderProfile;
  modules: ScoreReaderModules;
  /**
   * The raw `User.healthScoreConfigJson` blob. Required, and deliberately
   * not defaulted: a caller that forgets it would silently score the
   * account on someone else's recipe, and a plausible default is exactly
   * how that stays invisible. `null` is a real, meaningful value here —
   * it means the person never chose, and every pillar counts.
   */
  healthScoreConfigJson: unknown;
  bpTargets: BpTargets | null;
  bpEnvelope: BpInTargetEnvelope | null;
  bpEnvelopePriorWeek: BpInTargetEnvelope | null;
  bpEnvelopePriorTwoWeeks: BpInTargetEnvelope | null;
}

type MeasurementRow = {
  type: MeasurementType;
  value: number;
  unit: string;
  source: MeasurementSource;
  measuredAt: Date;
  deviceType: string | null;
  glucoseContext?: GlucoseContext | null;
  sleepStage?: SleepStage | null;
};

type Settled<T> = { ok: true; value: T } | { ok: false; value: T };

interface ActivityRead {
  days: Array<{ day: string; value: number }>;
  sources: string[];
  sourceDays: Array<{ day: string; source: string }>;
  path: "rollup" | "live";
}

interface ScoreBpEnvelope {
  path: "rollup" | "live" | undefined;
  last90Days: { pairs: number } | null;
  /**
   * v1.34.5 — score AND basis as one value, straight off the envelope
   * the route built. Never re-graded here: a second evaluation is how
   * the popover would end up explaining a different number.
   */
  graded: BpGrade | null;
  representative: { sys: number; dia: number } | null;
  last90EarliestAt: Date | null;
  last90LatestAt: Date | null;
  readFailed: boolean;
  target: BpTargets | null;
}

async function capture<T>(
  promise: Promise<T>,
  fallback: T,
  failure?:
    | ScorePillarId
    | "WEIGHT_GOAL"
    | "ALGORITHM_NOTICE"
    | "COMPOSITION_NOTICE"
    | ScorePillarId[],
): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch {
    const failures = Array.isArray(failure)
      ? failure
      : failure
        ? [failure]
        : [];
    if (failures.length > 0) {
      // `addMeta` replaces the whole `analytics` key wholesale (it does
      // not deep-merge), so writing `{ health_score: {...} }` directly
      // here would silently erase whatever `computeSummariesSlice` (or a
      // sibling pillar's own capture() failure) already wrote under
      // `meta.analytics` earlier in the same request. Read the event's
      // current `analytics` value first and merge into it instead.
      const existing = getEvent()?.toJSON().meta?.analytics;
      const existingHealthScore =
        existing &&
        typeof existing === "object" &&
        "health_score" in existing &&
        typeof existing.health_score === "object" &&
        existing.health_score !== null
          ? (existing.health_score as Record<string, string>)
          : {};
      annotate({
        meta: {
          analytics: {
            ...(existing && typeof existing === "object" ? existing : {}),
            health_score: {
              ...existingHealthScore,
              ...Object.fromEntries(
                failures.map((failed) => [failed, "read_failed"]),
              ),
            },
          },
        },
      });
    }
    return { ok: false, value: fallback };
  }
}

async function readMeasurements(
  db: PrismaClient,
  userId: string,
  types: MeasurementType[],
  since: Date,
  glucoseContext?: GlucoseContext,
): Promise<MeasurementRow[]> {
  return db.measurement.findMany({
    where: {
      userId,
      type: { in: types },
      measuredAt: { gte: since },
      deletedAt: null,
      ...(glucoseContext ? { glucoseContext } : {}),
    },
    orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
    select: {
      type: true,
      value: true,
      unit: true,
      source: true,
      measuredAt: true,
      deviceType: true,
      glucoseContext: true,
      sleepStage: true,
    },
  });
}
export function readFastingGlucoseMeasurements(
  db: PrismaClient,
  userId: string,
  now: Date,
): Promise<MeasurementRow[]> {
  return readMeasurements(
    db,
    userId,
    ["BLOOD_GLUCOSE"],
    new Date(now.getTime() - (90 + HISTORY_OFFSET_DAYS) * DAY_MS),
    "FASTING",
  );
}

export async function readActivityDays(args: {
  db: PrismaClient;
  userId: string;
  since: Date;
  priority: unknown;
  timezone: string;
  asOf: Date;
}): Promise<ActivityRead> {
  // DAY rollups are UTC buckets and have already summed all devices for a
  // source. Neither the user's local-day boundary nor Watch/phone
  // canonicalisation can be recovered from that aggregate, so score parity
  // requires the raw canonical path for every timezone.
  const rows = await readMeasurements(
    args.db,
    args.userId,
    ["ACTIVITY_STEPS"],
    args.since,
  );
  const canonical = pickCanonicalSourceRows(
    rows,
    "steps",
    args.priority,
    (date) => userDayKey(date, args.timezone),
  ).canonicalRows;
  return {
    days: pickCumulativeDaySum(canonical, (date) =>
      userDayKey(date, args.timezone),
    ).map((point) => ({
      day: userDayKey(point.date, args.timezone),
      value: point.value,
    })),
    sources: uniqueSources(
      canonical
        .filter((row) => {
          const day = userDayKey(row.measuredAt, args.timezone);
          const { startDay, endDay } = activityWindowKeys(
            args.asOf,
            args.timezone,
          );
          return day >= startDay && day <= endDay;
        })
        .map((row) => row.source),
    ),
    sourceDays: canonical.map((row) => ({
      day: userDayKey(row.measuredAt, args.timezone),
      source: row.source,
    })),
    path: "live",
  };
}

function normaliseAnalyte(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

const HBA1C_NAMES: Record<string, true> = {
  hba1c: true,
  hemoglobina1c: true,
  haemoglobina1c: true,
  glycatedhemoglobin: true,
  glycatedhaemoglobin: true,
};

const LIPID_NAMES: Record<string, true> = {
  ldl: true,
  ldlcholesterol: true,
  ldlc: true,
  hdl: true,
  hdlcholesterol: true,
  hdlc: true,
  triglycerides: true,
  triglyceride: true,
  totalcholesterol: true,
  cholesteroltotal: true,
  apob: true,
  apolipoproteinb: true,
};

function pickStableSourceRows<T extends { source: MeasurementSource }>(
  rows: T[],
  key: (row: T) => string,
): T[] {
  return Array.from(Map.groupBy(rows, key).values()).flatMap((group) => {
    const source = [...new Set(group.map((row) => row.source))].sort()[0];
    return group.filter((row) => row.source === source);
  });
}

function personalBpTarget(
  thresholdsJson: unknown,
  clinical: BpTargets | null,
): BpTargets | null {
  if (!clinical || !thresholdsJson || typeof thresholdsJson !== "object") {
    return null;
  }
  const thresholds = thresholdsJson as Record<string, unknown>;
  const readBand = (key: string): { min: number; max: number } | null => {
    const value = thresholds[key];
    if (!value || typeof value !== "object") return null;
    const { min, max } = value as { min?: unknown; max?: unknown };
    return typeof min === "number" &&
      Number.isFinite(min) &&
      typeof max === "number" &&
      Number.isFinite(max) &&
      min < max
      ? { min, max }
      : null;
  };
  const sys = readBand("BLOOD_PRESSURE_SYS");
  const dia = readBand("BLOOD_PRESSURE_DIA");
  if (!sys && !dia) return null;
  return {
    sysLow: sys?.min ?? clinical.sysLow,
    sysHigh: sys?.max ?? clinical.sysHigh,
    diaLow: dia?.min ?? clinical.diaLow,
    diaHigh: dia?.max ?? clinical.diaHigh,
  };
}

function canonicalBpRowsForWindow(
  rows: MeasurementRow[],
  input: UserHealthScoreInput,
  at: Date,
): MeasurementRow[] {
  const since = new Date(at.getTime() - 90 * DAY_MS);
  return pickCanonicalSourceRows(
    rows.filter((row) => row.measuredAt >= since && row.measuredAt <= at),
    "bloodPressure",
    input.profile.sourcePriorityJson,
    (date) => userDayKey(date, input.profile.timezone),
  ).canonicalRows;
}

function scoreBpEnvelope(args: {
  base: BpInTargetEnvelope | null;
  at: Date;
  input: UserHealthScoreInput;
  rows: Settled<MeasurementRow[]>;
}): { envelope: ScoreBpEnvelope; sources: string[] } {
  if (args.base) {
    return {
      envelope: {
        path: args.base.path,
        last90Days: args.base.last90Days,
        graded: args.base.graded,
        representative: args.base.representative,
        last90EarliestAt: args.base.last90EarliestAt,
        last90LatestAt: args.base.last90LatestAt,
        readFailed: false,
        target: args.input.bpTargets,
      },
      sources: args.rows.ok
        ? uniqueSources(
            canonicalBpRowsForWindow(args.rows.value, args.input, args.at).map(
              (row) => row.source,
            ),
          )
        : [args.base.path],
    };
  }

  const target = args.input.bpTargets;
  if (!args.rows.ok) {
    return {
      envelope: {
        path: undefined,
        last90Days: null,
        graded: null,
        representative: null,
        last90EarliestAt: null,
        last90LatestAt: null,
        readFailed: true,
        target,
      },
      sources: [],
    };
  }

  const canonical = canonicalBpRowsForWindow(
    args.rows.value,
    args.input,
    args.at,
  );
  const pairs = collectBpPairs(
    canonical
      .filter((row) => row.type === "BLOOD_PRESSURE_SYS")
      .map((row) => ({ measuredAt: row.measuredAt, value: row.value })),
    canonical
      .filter((row) => row.type === "BLOOD_PRESSURE_DIA")
      .map((row) => ({ measuredAt: row.measuredAt, value: row.value })),
    args.input.profile.timezone,
  ).filter(
    (pair) =>
      pair.at <= args.at &&
      pair.at >= new Date(args.at.getTime() - 90 * DAY_MS),
  );
  return {
    envelope: {
      path: "live",
      last90Days: { pairs: pairs.length },
      graded: target
        ? gradeBpScoreFromSeries({
            pairs,
            target,
            now: args.at,
          })
        : null,
      representative: representativeBpFromSeries({ pairs, now: args.at }),
      last90EarliestAt: pairs[0]?.at ?? null,
      last90LatestAt: pairs.at(-1)?.at ?? null,
      readFailed: false,
      target,
    },
    sources: uniqueSources(canonical.map((row) => row.source)),
  };
}

function scoreInputsFor(args: {
  asOf: Date;
  input: UserHealthScoreInput;
  bp: ScoreBpEnvelope;
  bpSources: string[];
  glucose: Settled<MeasurementRow[]>;
  activity: Settled<ActivityRead>;
  sleep: Settled<MeasurementRow[]>;
  adiposity: Settled<MeasurementRow[]>;
  assessments: Settled<
    Array<{
      instrument: "PHQ9" | "GAD7" | "WHO5" | "SCI";
      totalScore: number;
      item9Flagged: boolean;
      takenAt: Date;
    }>
  >;
  labs: Settled<
    Array<{
      analyte: string;
      value: number | null;
      unit: string;
      referenceLow: number | null;
      referenceHigh: number | null;
      panel: string | null;
      takenAt: Date;
      source: string;
      biomarker: {
        name: string;
        unit: string;
        lowerBound: number | null;
        upperBound: number | null;
      } | null;
    }>
  >;
}): PillarInputs {
  const { asOf, input } = args;
  const tz = input.profile.timezone;
  const ageYears = ageInYears(input.profile.dateOfBirth, tz);
  const asOfDay = userDayKey(asOf, tz);
  const activityWindow = activityWindowKeys(asOf, tz);
  const sleepSinceDay = userDayKey(
    new Date(asOf.getTime() - (SLEEP_WINDOW_DAYS - 1) * DAY_MS),
    tz,
  );
  const fastingCanonical = pickStableSourceRows(
    args.glucose.value.filter((row) => row.glucoseContext === "FASTING"),
    (row) => userDayKey(row.measuredAt, tz),
  );
  const sleepNights = reconstructNights(
    args.sleep.value.map((row) => ({
      value: row.value,
      measuredAt: row.measuredAt,
      sleepStage: row.sleepStage ?? null,
      source: row.source,
      deviceType: row.deviceType,
    })),
    tz,
    input.profile.sourcePriorityJson,
  );
  const hba1c = args.labs.value.filter((row) => {
    const name = normaliseAnalyte(row.biomarker?.name ?? row.analyte);
    return row.value != null && HBA1C_NAMES[name] === true;
  });
  const lipids = args.labs.value.filter((row) => {
    const name = normaliseAnalyte(row.biomarker?.name ?? row.analyte);
    return row.value != null && LIPID_NAMES[name] === true;
  });
  const adiposityCanonical = pickStableSourceRows(
    args.adiposity.value,
    (row) => `${row.type}|${userDayKey(row.measuredAt, tz)}`,
  );

  return {
    BLOOD_PRESSURE: {
      source: readSource(args.bp.path),
      readFailed: args.bp.readFailed,
      asOf,
      pairCount: args.bp.last90Days?.pairs ?? 0,
      graded: args.bp.graded,
      representative: args.bp.representative,
      oldestAt: args.bp.last90EarliestAt,
      latestAt: args.bp.last90LatestAt,
      target: args.bp.target,
      personalTarget: personalBpTarget(
        input.profile.thresholdsJson,
        args.bp.target,
      ),
      sources: args.bpSources,
    },
    GLYCAEMIA: {
      source: "live",
      glucoseUnit: input.profile.glucoseUnit,
      readFailed:
        (!input.modules.glucose || !args.glucose.ok) &&
        (!input.modules.labs || !args.labs.ok),
      asOf,
      hba1cReadFailed: input.modules.labs && !args.labs.ok,
      fastingReadFailed: input.modules.glucose && !args.glucose.ok,
      hba1c: input.modules.labs
        ? hba1c.map((row) => ({
            value: row.value!,
            unit: row.biomarker?.unit ?? row.unit,
            at: row.takenAt,
            source: row.source,
          }))
        : [],
      fastingGlucose: input.modules.glucose
        ? fastingCanonical.map((row) => ({
            value: row.value,
            at: row.measuredAt,
            source: row.source,
          }))
        : [],
    },
    ACTIVITY: {
      source: args.activity.ok ? readSource(args.activity.value.path) : "none",
      readFailed: !args.activity.ok,
      timezone: tz,
      asOf,
      ageYears,
      days: args.activity.value.days,
      sources: uniqueSources(
        args.activity.value.sourceDays
          .filter(
            (row) =>
              row.day >= activityWindow.startDay &&
              row.day <= activityWindow.endDay,
          )
          .map((row) => row.source),
      ),
    },
    SLEEP: {
      source: "live",
      readFailed: !args.sleep.ok,
      timezone: tz,
      asOf,
      ageYears,
      nights: sleepNights.map((night) => ({
        night: night.night,
        asleepMinutes: night.asleepMinutes,
        midpoint: night.midpoint,
      })),
      sources: uniqueSources(
        args.sleep.value
          .filter((row) => {
            const day = userDayKey(row.measuredAt, tz);
            return day >= sleepSinceDay && day <= asOfDay;
          })
          .map((row) => row.source),
      ),
    },
    ADIPOSITY: {
      source: "live",
      readFailed: !args.adiposity.ok,
      asOf,
      heightCm: input.profile.heightCm,
      rows: adiposityCanonical.map((row) => ({
        type: row.type as "WAIST_CIRCUMFERENCE" | "WAIST_TO_HEIGHT",
        value: row.value,
        unit: row.unit,
        at: row.measuredAt,
        source: row.source,
      })),
    },
    WELLBEING: {
      source: "live",
      readFailed: !args.assessments.ok,
      asOf,
      assessments: args.assessments.value
        .filter((row) => row.instrument !== "SCI")
        .map((row) => ({
          instrument: row.instrument as "PHQ9" | "GAD7" | "WHO5",
          totalScore: row.totalScore,
          item9Flagged: row.item9Flagged,
          at: row.takenAt,
        })),
    },
    LIPIDS: {
      source: "live",
      readFailed: !args.labs.ok,
      asOf,
      rows: lipids.map((row) => ({
        marker: row.biomarker?.name ?? row.analyte,
        value: row.value!,
        unit: row.unit || row.biomarker?.unit || "",
        referenceLow: row.referenceLow ?? row.biomarker?.lowerBound ?? null,
        referenceHigh: row.referenceHigh ?? row.biomarker?.upperBound ?? null,
        panel: row.panel,
        at: row.takenAt,
        source: row.source,
      })),
    },
  };
}

function readSource(
  path: "rollup" | "live" | undefined,
): DerivedProvenanceSource {
  if (path === "rollup") return "DAY";
  return path ?? "none";
}

export async function computeUserHealthScore(
  input: UserHealthScoreInput,
): Promise<HealthScoreReport> {
  const db = input.prisma ?? prisma;
  const since = new Date(input.now.getTime() - SCORE_READ_DAYS * DAY_MS);
  const activitySince = new Date(
    input.now.getTime() - (ACTIVITY_WINDOW_DAYS + HISTORY_OFFSET_DAYS) * DAY_MS,
  );
  const [
    glucose,
    activity,
    sleep,
    adiposity,
    assessments,
    labs,
    weights,
    bpRows,
  ] = await Promise.all([
    input.modules.glucose
      ? capture(
          readFastingGlucoseMeasurements(db, input.userId, input.now),
          [],
          "GLYCAEMIA",
        )
      : Promise.resolve({ ok: true as const, value: [] }),
    capture(
      readActivityDays({
        db,
        userId: input.userId,
        since: activitySince,
        priority: input.profile.sourcePriorityJson,
        asOf: input.now,
        timezone: input.profile.timezone,
      }),
      { days: [], sources: [], sourceDays: [], path: "live" as const },
      "ACTIVITY",
    ),
    input.modules.sleep
      ? capture(
          readMeasurements(db, input.userId, ["SLEEP_DURATION"], activitySince),
          [],
          "SLEEP",
        )
      : Promise.resolve({ ok: true as const, value: [] }),
    capture(
      readMeasurements(
        db,
        input.userId,
        ["WAIST_CIRCUMFERENCE", "WAIST_TO_HEIGHT"],
        since,
      ),
      [],
      "ADIPOSITY",
    ),
    input.modules.mentalHealth
      ? capture(
          db.mentalHealthAssessment
            .findMany({
              where: {
                userId: input.userId,
                takenAt: { gte: since },
                deletedAt: null,
                // The wellbeing screeners only. AUDIT-C shares the table for
                // its storage, but it belongs to the life circumstances, not
                // to this pillar.
                instrument: { in: [...SCREENER_INSTRUMENTS] },
              },
              orderBy: { takenAt: "asc" },
              select: {
                instrument: true,
                totalScore: true,
                item9Flagged: true,
                takenAt: true,
              },
            })
            .then((rows) =>
              rows.flatMap((row) =>
                isScreenerInstrument(row.instrument)
                  ? [{ ...row, instrument: row.instrument }]
                  : [],
              ),
            ),
          [],
          "WELLBEING",
        )
      : Promise.resolve({ ok: true as const, value: [] }),
    input.modules.labs
      ? capture(
          db.labResult.findMany({
            where: {
              userId: input.userId,
              takenAt: { gte: since },
              deletedAt: null,
              value: { not: null },
            },
            orderBy: { takenAt: "asc" },
            select: {
              analyte: true,
              value: true,
              unit: true,
              referenceLow: true,
              referenceHigh: true,
              panel: true,
              takenAt: true,
              source: true,
              // The catalog's range columns are `lowerBound` / `upperBound`
              // (`lower_bound` / `upper_bound`), not the LabResult's own
              // `reference*` names. Prisma rejects a select against names a
              // model does not have at query-validation time — before any
              // row is read — so getting this wrong fails EVERY labs read,
              // not just rows that use the catalog fallback.
              biomarker: {
                select: {
                  name: true,
                  unit: true,
                  lowerBound: true,
                  upperBound: true,
                },
              },
            },
          }),
          [],
          ["GLYCAEMIA", "LIPIDS"],
        )
      : Promise.resolve({ ok: true as const, value: [] }),
    capture(
      readMeasurements(db, input.userId, ["WEIGHT"], since),
      [],
      "WEIGHT_GOAL",
    ),
    capture(
      readMeasurements(
        db,
        input.userId,
        ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
        new Date(input.now.getTime() - 104 * DAY_MS),
      ),
      [],
      "BLOOD_PRESSURE",
    ),
  ]);

  // v1.35.0 — what counts is the person's choice, narrowed to what there
  // can be data for. Before this release the module switches decided the
  // composition on their own; now they only say whether a pillar's data
  // is being recorded, and the stored recipe says what counts. Two
  // things deciding one number is the defect this replaces, so the old
  // expression is gone rather than kept beside the new one.
  //
  // The promise on upgrade is that nobody's number moves, and it holds
  // by construction rather than by a backfill: an account that never
  // chose resolves to every pillar, and every pillar intersected with
  // module availability is precisely the set the ternaries built.
  //
  // A pillar the config selects but whose module is off drops out here
  // and therefore produces no row at all — not a score, not a "waiting
  // for data" line. Turning a module off is a deliberate act with its
  // own meaning, and asking someone for data they chose to stop
  // recording would be nagging in the voice of their own settings. The
  // place that pillar comes back is the modules screen.
  const config = resolveHealthScoreConfig(input.healthScoreConfigJson);
  const recordedPillars = pillarsWithModuleData(input.modules);
  const recorded = new Set(recordedPillars);
  const pregnant = await pregnancyContextFor(db, input);
  const availablePillars: ScorePillarId[] = config.pillars.filter(
    (id) => recorded.has(id) && !(pregnant && id === "ADIPOSITY"),
  );
  // v1.35.0 — the one place "this score is configured" is decided, from the
  // composition's own config and module map, never re-derived by a client.
  const configured = resolveScoreConfigured({ config, recordedPillars });
  const previousAt = new Date(input.now.getTime() - 7 * DAY_MS);
  const previousPreviousAt = new Date(input.now.getTime() - 14 * DAY_MS);
  const currentBp = scoreBpEnvelope({
    base: input.bpEnvelope,
    at: input.now,
    input,
    rows: bpRows,
  });
  const previousBp = scoreBpEnvelope({
    base: input.bpEnvelopePriorWeek,
    at: previousAt,
    input,
    rows: bpRows,
  });
  const previousPreviousBp = scoreBpEnvelope({
    base: input.bpEnvelopePriorTwoWeeks,
    at: previousPreviousAt,
    input,
    rows: bpRows,
  });
  const common = {
    input,
    bpSources: currentBp.sources,
    glucose,
    activity,
    sleep,
    adiposity,
    assessments,
    labs,
  };
  const canonicalWeights = pickCanonicalSourceRows(
    weights.value,
    "weight",
    input.profile.sourcePriorityJson,
    (date) => userDayKey(date, input.profile.timezone),
  ).canonicalRows;
  const target = resolveWeightTargetOverride(input.profile.thresholdsJson);
  const weightGoal = computeWeightGoal({
    rows: canonicalWeights.map((row) => ({
      value: row.value,
      at: row.measuredAt,
      source: row.source,
    })),
    target,
    source: weights.ok ? "live" : "none",
    readFailed: !weights.ok,
    asOf: input.now,
    pregnancyContext: pregnant,
  });
  const current = computeHealthScore({
    asOf: input.now,
    availablePillars,
    configured,
    pillars: scoreInputsFor({
      ...common,
      asOf: input.now,
      bp: currentBp.envelope,
    }),
    weightGoal,
  });
  const previous = computeHealthScore({
    asOf: previousAt,
    availablePillars,
    configured,
    pillars: scoreInputsFor({
      ...common,
      asOf: previousAt,
      bp: previousBp.envelope,
    }),
    weightGoal,
  });
  const previousPrevious = computeHealthScore({
    asOf: previousPreviousAt,
    availablePillars,
    configured,
    pillars: scoreInputsFor({
      ...common,
      asOf: previousPreviousAt,
      bp: previousPreviousBp.envelope,
    }),
    weightGoal,
  });
  // All three windows above were computed under the recipe in force
  // right now, which is exactly why the guard needs the recipe's own
  // dated identity: nothing in the three composites can show that last
  // Tuesday was scored on a different set. Resolved once, from the same
  // blob the composition came from, so the number and the boundary that
  // judges its movement can never describe two different recipes.
  const delta = attachScoreDelta(
    current.composite,
    previous.composite,
    previousPrevious.composite,
    input.now,
    scoreConfigBoundary(config),
    current.pillars,
    previous.pillars,
  );
  const itemKey = healthScoreNoticeItemKey(
    current.scoreVersion,
    config.version,
  );
  // v1.38 — the composition note's only input from the database, and the
  // first production read this table has ever had. It is filed under the
  // account's LOCAL day, and the row for today is excluded on purpose: the
  // write happens on the same request that computed the report, so
  // comparing against "the newest row" would find today's own composition
  // the second time the panel is opened and the note would vanish between
  // two loads of the same page.
  const todayKey = userDayKey(input.now, input.profile.timezone);
  const [dismissal, priorDay] = await Promise.all([
    capture(
      db.dismissedPriorityItem.findUnique({
        where: { userId_itemKey: { userId: input.userId, itemKey } },
        select: { itemKey: true },
      }),
      null,
      "ALGORITHM_NOTICE",
    ),
    capture(
      db.healthScoreRecord.findFirst({
        where: { userId: input.userId, dayKey: { lt: todayKey } },
        orderBy: { dayKey: "desc" },
        select: {
          composition: true,
          scoreVersion: true,
          configVersion: true,
        },
      }),
      null,
      "COMPOSITION_NOTICE",
    ),
  ]);
  const compositionNotice = await resolveCompositionNotice({
    db,
    userId: input.userId,
    scoreVersion: current.scoreVersion,
    configVersion: config.version,
    composition:
      current.composite.status === "ok"
        ? current.composite.value.composition
        : [],
    priorDay: priorDay.value,
  });
  return {
    ...current,
    ...delta,
    algorithmNotice: {
      itemKey,
      dismissed: dismissal.value != null,
    },
    compositionNotice,
  };
}

/**
 * Decide whether a pillar leaving or joining is worth saying, and look up
 * whether it has already been said.
 *
 * The decision itself is pure and lives in `./composition-notice`; this is
 * the seam that holds the one extra round trip, and it only spends it when
 * there is a note to raise. A read failure here resolves to no note rather
 * than to a thrown request: the score renders, and the wide event carries
 * the domain that could not be read.
 */
async function resolveCompositionNotice(args: {
  db: Pick<PrismaClient, "dismissedPriorityItem">;
  userId: string;
  scoreVersion: number;
  configVersion: number;
  composition: readonly ScorePillarId[];
  priorDay: StoredCompositionDay | null;
}): Promise<HealthScoreReport["compositionNotice"]> {
  const decision = {
    current: args.composition,
    previous: args.priorDay,
    scoreVersion: args.scoreVersion,
    configVersion: args.configVersion,
  };
  const key = compositionNoticeKey(decision);
  if (!key) return null;
  const seen = await capture(
    args.db.dismissedPriorityItem.findUnique({
      where: { userId_itemKey: { userId: args.userId, itemKey: key } },
      select: { itemKey: true },
    }),
    null,
    "COMPOSITION_NOTICE",
  );
  return buildCompositionNotice(decision, key, seen.value != null);
}
