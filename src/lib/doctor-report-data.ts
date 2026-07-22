/**
 * Server-side aggregator for doctor-report data.
 *
 * Single source of truth for the aggregated payload consumed by both
 * `/api/doctor-report` (JSON, client renders PDF) and
 * `/api/doctor-report/pdf` (server-rendered PDF). Keeps the two endpoints
 * structurally identical so visual parity between client- and server-rendered
 * PDFs is guaranteed by construction, not by drift-prone copy-paste.
 *
 * The data shapes live in `doctor-report-types.ts` and the pure helpers in
 * `doctor-report-helpers.ts`; both are re-exported here so call sites keep a
 * single import surface.
 */

import { prisma } from "@/lib/db";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import { resolveGlucoseUnit, thresholdMetricForContext } from "@/lib/glucose";
import {
  computeGlucoseClinicalMetrics,
  CV_INSTABILITY_THRESHOLD,
  estimatedA1c,
  gmi,
  type GlucoseClinicalMetrics,
} from "@/lib/analytics/glucose-metrics";
import type {
  GlucoseContext,
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import { readNote } from "@/lib/crypto/note-cipher";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  type DoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";
import { buildCycleExportSummary } from "@/lib/cycle/export-data";
import { resolveModuleMap, type ModuleKey } from "@/lib/modules/gate";
import { SCHEDULE_COMPLIANCE_SELECT } from "@/lib/analytics/compliance";
import {
  WELLNESS_SCORE_REPORT_TYPES,
  type CollectDoctorReportOptions,
  type DoctorReportData,
  type DoctorReportMood,
  type DoctorReportRange,
  type DoctorReportStats,
} from "./doctor-report-types";
import {
  buildLedgerCompliance,
  collapseMeasurementsToCanonical,
  decryptAllergyReaction,
  minMaxOf,
  resolveMaxMedicationAdministrations,
  sanitisePracticeName,
  summariseCanonicalRecovery,
} from "./doctor-report-helpers";

export * from "./doctor-report-types";
export * from "./doctor-report-helpers";

const GLUCOSE_CONTEXTS: GlucoseContext[] = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
];

const DENSE_REPORT_RAW_WINDOW_DAYS = 90;

interface DenseMeasurementBucket {
  bucketStart: Date;
  type: MeasurementType;
  source: MeasurementSource;
  deviceType: string | null;
  glucoseContext: GlucoseContext | null;
  count: number;
  sumValue: number;
  minValue: number;
  maxValue: number;
  latestAt: Date;
  latestValue: number;
  clinicalCount: number;
  clinicalSum: number | null;
  clinicalSumSquares: number | null;
  clinicalFirstAt: Date | null;
  clinicalLastAt: Date | null;
  clinicalTirCount: number;
  clinicalTbr1Count: number;
  clinicalTbr2Count: number;
  clinicalTar1Count: number;
  clinicalTar2Count: number;
  clinicalLowRiskSum: number | null;
  clinicalHighRiskSum: number | null;
}

interface DenseMeasurementSummary {
  byType: Record<string, Array<{ value: number; measuredAt: string }>>;
  stats: Record<string, DoctorReportStats>;
  glucoseStats: Record<string, DoctorReportStats>;
  glucoseClinical: GlucoseClinicalMetrics;
}

interface DenseStatsAccumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
  latestAt: Date;
  latest: number;
}

function emptyGlucoseClinical(windowDays: number): GlucoseClinicalMetrics {
  return {
    stillLearning: true,

    stillLearningReason: `No glucose readings in the last ${windowDays} days.`,
    windowDays,
    actualSpanDays: 0,
    readingCount: 0,
    meanMgdl: null,
    distribution: null,
    gmi: null,
    estimatedA1c: null,
    variability: null,
    advanced: null,
    isSpotEstimate: true,
  };
}

function glucoseClinicalFromBuckets(
  buckets: readonly DenseMeasurementBucket[],
  windowDays: number,
): GlucoseClinicalMetrics {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;
  let tir = 0;
  let tbr1 = 0;
  let tbr2 = 0;
  let tar1 = 0;
  let tar2 = 0;
  let lowRisk = 0;
  let highRisk = 0;

  for (const bucket of buckets) {
    if (bucket.type !== "BLOOD_GLUCOSE" || bucket.clinicalCount === 0) {
      continue;
    }
    count += bucket.clinicalCount;
    sum += bucket.clinicalSum ?? 0;
    sumSquares += bucket.clinicalSumSquares ?? 0;
    tir += bucket.clinicalTirCount;
    tbr1 += bucket.clinicalTbr1Count;
    tbr2 += bucket.clinicalTbr2Count;
    tar1 += bucket.clinicalTar1Count;
    tar2 += bucket.clinicalTar2Count;
    lowRisk += bucket.clinicalLowRiskSum ?? 0;
    highRisk += bucket.clinicalHighRiskSum ?? 0;
    if (
      bucket.clinicalFirstAt &&
      (!firstAt || bucket.clinicalFirstAt < firstAt)
    ) {
      firstAt = bucket.clinicalFirstAt;
    }
    if (bucket.clinicalLastAt && (!lastAt || bucket.clinicalLastAt > lastAt)) {
      lastAt = bucket.clinicalLastAt;
    }
  }

  if (count === 0 || !firstAt || !lastAt) {
    return emptyGlucoseClinical(windowDays);
  }

  const meanMgdl = sum / count;
  const actualSpanDays =
    (lastAt.getTime() - firstAt.getTime()) / (24 * 60 * 60 * 1000);
  const variance =
    count >= 2
      ? Math.max(0, (sumSquares - (sum * sum) / count) / (count - 1))
      : null;
  const sd = variance === null ? null : Math.sqrt(variance);
  const cv = sd === null || meanMgdl === 0 ? null : (sd / meanMgdl) * 100;
  const fraction = (n: number) => n / count;
  const minutes = (n: number) => fraction(n) * 1440;
  const roundedSpan = Math.max(0, Math.round(actualSpanDays));
  let stillLearningReason: string | null = null;
  if (count < 14) {
    stillLearningReason = `Still learning — ${count} reading${
      count === 1 ? "" : "s"
    } over ${roundedSpan} day${
      roundedSpan === 1 ? "" : "s"
    }; at least 14 are needed for a meaningful estimate.`;
  } else if (actualSpanDays < 7) {
    stillLearningReason = `Still learning — readings span only ${roundedSpan} day${
      roundedSpan === 1 ? "" : "s"
    }; at least 7 days of coverage are needed.`;
  }

  return {
    stillLearning: stillLearningReason !== null,
    stillLearningReason,
    windowDays,
    actualSpanDays,
    readingCount: count,
    meanMgdl,
    distribution: {
      tir: fraction(tir),
      tbrLevel1: fraction(tbr1),
      tbrLevel2: fraction(tbr2),
      tarLevel1: fraction(tar1),
      tarLevel2: fraction(tar2),
      minutesEquivalent: {
        tir: minutes(tir),
        tbrLevel1: minutes(tbr1),
        tbrLevel2: minutes(tbr2),
        tarLevel1: minutes(tar1),
        tarLevel2: minutes(tar2),
      },
    },
    gmi: gmi(meanMgdl),
    estimatedA1c: estimatedA1c(meanMgdl),
    variability:
      sd === null || cv === null
        ? null
        : { sd, cv, unstable: cv >= CV_INSTABILITY_THRESHOLD },
    advanced: {
      jIndex: sd === null ? null : 0.001 * (meanMgdl + sd) ** 2,
      lbgi: lowRisk / count,
      hbgi: highRisk / count,
    },
    isSpotEstimate: count / Math.max(actualSpanDays, 1) < 24,
  };
}

function summariseDenseBuckets(
  rows: readonly DenseMeasurementBucket[],
  timezone: string,
  sourcePriorityJson: unknown,
  windowDays: number,
): DenseMeasurementSummary {
  const canonical = collapseMeasurementsToCanonical(
    rows.map((row) => ({
      ...row,
      value: row.sumValue / row.count,
      measuredAt: row.bucketStart,
    })),
    timezone,
    sourcePriorityJson,
  );
  const byType: DenseMeasurementSummary["byType"] = {};
  const statsAcc = new Map<string, DenseStatsAccumulator>();
  const glucoseStatsAcc = new Map<string, DenseStatsAccumulator>();

  const byTypeDay = new Map<
    string,
    {
      type: string;
      bucketStart: Date;
      count: number;
      sum: number;
      min: number;
      max: number;
      latestAt: Date;
      latest: number;
    }
  >();
  for (const row of canonical) {
    const key = `${row.type}:${row.bucketStart.toISOString()}`;
    const current = byTypeDay.get(key);
    if (!current) {
      byTypeDay.set(key, {
        type: row.type,
        bucketStart: row.bucketStart,
        count: row.count,
        sum: row.sumValue,
        min: row.minValue,
        max: row.maxValue,
        latestAt: row.latestAt,
        latest: row.latestValue,
      });
      continue;
    }
    current.count += row.count;
    current.sum += row.sumValue;
    current.min = Math.min(current.min, row.minValue);
    current.max = Math.max(current.max, row.maxValue);
    if (row.latestAt > current.latestAt) {
      current.latestAt = row.latestAt;
      current.latest = row.latestValue;
    }
  }

  const accumulate = (
    target: Map<string, DenseStatsAccumulator>,
    key: string,
    row: DenseStatsAccumulator,
  ) => {
    const current = target.get(key);
    if (!current) {
      target.set(key, { ...row });
      return;
    }
    current.count += row.count;
    current.sum += row.sum;
    current.min = Math.min(current.min, row.min);
    current.max = Math.max(current.max, row.max);
    if (row.latestAt > current.latestAt) {
      current.latestAt = row.latestAt;
      current.latest = row.latest;
    }
  };

  for (const row of byTypeDay.values()) {
    (byType[row.type] ??= []).push({
      value: row.sum / row.count,
      measuredAt: row.bucketStart.toISOString(),
    });
    accumulate(statsAcc, row.type, row);
  }

  for (const row of canonical) {
    if (row.type !== "BLOOD_GLUCOSE" || !row.glucoseContext) continue;
    accumulate(glucoseStatsAcc, row.glucoseContext, {
      count: row.count,
      sum: row.sumValue,
      min: row.minValue,
      max: row.maxValue,
      latestAt: row.latestAt,
      latest: row.latestValue,
    });
  }

  for (const entries of Object.values(byType)) {
    entries.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  }
  const stats: DenseMeasurementSummary["stats"] = {};
  for (const [key, value] of statsAcc) {
    stats[key] = {
      count: value.count,
      avg: value.sum / value.count,
      min: value.min,
      max: value.max,
      latest: value.latest,
    };
  }
  const glucoseStats: DenseMeasurementSummary["glucoseStats"] = {};
  for (const [key, value] of glucoseStatsAcc) {
    glucoseStats[key] = {
      count: value.count,
      avg: value.sum / value.count,
      min: value.min,
      max: value.max,
      latest: value.latest,
    };
  }

  return {
    byType,
    stats,
    glucoseStats,
    glucoseClinical: glucoseClinicalFromBuckets(canonical, windowDays),
  };
}

/**
 * Aggregate the doctor-report payload for a user over a `[start, end]` range.
 * Pure data assembly — no auth, no rate-limit, no audit. Idempotent.
 *
 * `range` is validated via `normaliseDateRange()` upstream; this function
 * trusts it and uses both bounds in the Prisma `where` clause so a custom
 * window (not just "last N days") filters correctly.
 */
export async function collectDoctorReportData(
  userId: string,
  range: DoctorReportRange,
  options: CollectDoctorReportOptions = {},
): Promise<DoctorReportData> {
  const { start, end, days } = range;

  // Resolve section toggles up-front. Mood is privacy-sensitive: when
  // it's off we don't issue the `MoodEntry` findMany at all so the data
  // never lands in this process's memory. Other sections are queried
  // either way (the queries are cheap on indexed columns) and stripped
  // from the returned payload below — keeping a single source of
  // truth for the data shape regardless of toggle state.
  // v1.18.0 — resolve the per-user module map up-front (once per build). A
  // disabled module's section/resources are excluded from the export so the
  // PDF + FHIR bundle reflect only the modules the user keeps. The map is
  // ANDed over the user's per-report `sections` toggles: a disabled module
  // forces its section off even if the report toggle says on (you can't share
  // data for a module you turned off), while leaving the others untouched.
  // Core clinical sections (weight / BP / pulse / medications) have no module
  // key and stay unconditional. Injectable for tests.
  const moduleMap = options.moduleMap ?? (await resolveModuleMap(userId));

  // v1.30.22 — fail-closed backstop on the aggregate's OWN module key,
  // mirroring `loadFhirContext`.
  //
  // Everything below gates the per-domain SECTIONS (mood / sleep / glucose /
  // cycle / labs / recovery / workouts) but nothing ever gated `doctorReport`
  // itself — the key that decides whether the whole-record aggregate may be
  // assembled at all. That left it entirely to callers to remember, and the
  // MCP surface did not: `healthlog://report/doctor-visit`, its `{window}`
  // template, and the `doctor_visit_summary` prompt all assembled the full
  // record for an account with the module off, on the one wire that egresses
  // to a third-party assistant.
  //
  // REFUSE, not omit — the opposite of the per-domain reads. This is the
  // whole-record aggregate, so there is no honest partial answer to return;
  // `/api/export/health-record` already answers 403 for exactly this state
  // and this is the same payload. It throws rather than returning an envelope
  // because reaching here means a caller is missing its gate: a bug to
  // surface, not a flow to serve. Callers that can degrade gracefully gate
  // themselves BEFORE calling (see the MCP resources and the clinician share).
  if (moduleMap.doctorReport === false) {
    throw new Error(
      'collectDoctorReportData called with the "doctorReport" module ' +
        "disabled — the calling surface is missing its module gate",
    );
  }

  const sections: DoctorReportPrefs = {
    ...DEFAULT_DOCTOR_REPORT_PREFS,
    ...(options.sections ?? {}),
  };
  // Module gate: a disabled module wins over the report toggle. Each report
  // section maps to its owning module key; core sections (bp/weight/pulse/
  // bmi/compliance) carry no key and are never gated here.
  if (moduleMap.mood === false) sections.mood = false;
  if (moduleMap.sleep === false) sections.sleep = false;
  if (moduleMap.glucose === false) sections.glucose = false;
  if (moduleMap.cycle === false) sections.cycle = false;
  if (moduleMap.labs === false) sections.labs = false;
  // Module gates with no `sections` key — applied directly to the data slices
  // below (recovery/strain wellness scores, workout series). Glucose now
  // carries its own report section toggle, into which the module gate above
  // already folds — so the section flag is the single lever for the glucose
  // panel (stats + ranges + clinical metrics).
  const glucoseEnabled = sections.glucose !== false;
  const recoveryEnabled = moduleMap.recovery !== false;
  const workoutsEnabled = moduleMap.workouts !== false;

  // v1.28.25 — push the section / module gates INTO the measurement query.
  // `filterMeasurementKeys` below strips gated types from the returned
  // payload anyway, so rows of a disabled section / module were fetched only
  // to be dropped — pure dead weight, and the heaviest series (BLOOD_GLUCOSE
  // minute-grain CGM, gated by the glucose module) is exactly the one that
  // runs to six figures over a 730-day window. Excluding them at the query
  // is output-identical by construction.
  //
  // WEIGHT is deliberately NEVER excluded: the BMI figure (gated by
  // `sections.bmi`, not `sections.weight`) and the GLP-1 weight-delta both
  // read the PRE-filter `byType` / `stats` maps, so weight rows must be
  // present even when the weight section itself is toggled off. No other
  // gated type is read before the filter (each remaining pre-filter read —
  // sleep nights, glucose panel, recovery summary — sits behind the same
  // gate that drives its exclusion here).
  //
  // Every sparse type keeps the raw-row path. On long windows, the two
  // sample-dense types move to one SQL row per local day/source/device/context;
  // the canonical-source picker then works over that bounded intermediate set.
  const excludedMeasurementTypes: MeasurementType[] = [];
  if (sections.bp === false) {
    excludedMeasurementTypes.push("BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA");
  }
  if (sections.pulse === false) excludedMeasurementTypes.push("PULSE");
  if (sections.sleep === false) excludedMeasurementTypes.push("SLEEP_DURATION");
  if (sections.glucose === false)
    excludedMeasurementTypes.push("BLOOD_GLUCOSE");
  for (const [type, moduleKey] of Object.entries(MEASUREMENT_TYPE_MODULE)) {
    if (moduleMap[moduleKey] === false) {
      excludedMeasurementTypes.push(type as MeasurementType);
    }
  }

  const userProfile = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      username: true,
      dateOfBirth: true,
      gender: true,
      heightCm: true,
      glucoseUnit: true,
      thresholdsJson: true,
      timezone: true,
      sourcePriorityJson: true,
      fullName: true,
      insurerName: true,
      insurerIkNumber: true,
    },
  });
  const reportTz = userProfile?.timezone ?? "Europe/Berlin";
  const aggregateDenseTypes = days > DENSE_REPORT_RAW_WINDOW_DAYS;
  const densePulse =
    aggregateDenseTypes && !excludedMeasurementTypes.includes("PULSE");
  const denseGlucose =
    aggregateDenseTypes && !excludedMeasurementTypes.includes("BLOOD_GLUCOSE");
  const rawExcludedMeasurementTypes = [...excludedMeasurementTypes];
  if (densePulse) rawExcludedMeasurementTypes.push("PULSE");
  if (denseGlucose) rawExcludedMeasurementTypes.push("BLOOD_GLUCOSE");

  const [measurements, medications, intakeEvents, moodEntries, denseBuckets] =
    await Promise.all([
      prisma.measurement.findMany({
        // v1.4.41 W-DELETED-2 — exclude soft-deleted measurements from
        // the doctor-report aggregator so deleted rows never leak into
        // the JSON payload or the server-rendered PDF.
        where: {
          userId,
          measuredAt: { gte: start, lte: end },
          deletedAt: null,
          ...(rawExcludedMeasurementTypes.length > 0
            ? { type: { notIn: rawExcludedMeasurementTypes } }
            : {}),
        },
        orderBy: { measuredAt: "asc" },
        // v1.28.25 — narrow select. The collector reads exactly these seven
        // fields (canonical-source collapse: type / value / measuredAt /
        // source / deviceType; sleep-night reconstruction adds sleepStage;
        // the glucose panel adds glucoseContext). The full-width read pulled
        // every column — including the notesEncrypted Bytes — across up to
        // 730 days of rows, which on a CGM + per-sample-HR account is the
        // v1.28.2x six-figure-row incident class.
        select: {
          type: true,
          value: true,
          measuredAt: true,
          source: true,
          deviceType: true,
          sleepStage: true,
          glucoseContext: true,
        },
      }),
      prisma.medication.findMany({
        where: { userId, active: true },
        include: {
          // v1.15.20 — the shared compliance select (plus `label`, which the
          // FHIR schedule mapping below needs) so a future engine column added
          // to SCHEDULE_COMPLIANCE_SELECT reaches the doctor-report surface.
          schedules: { select: { ...SCHEDULE_COMPLIANCE_SELECT, label: true } },
          // v1.17 W1a — archived schedule eras so the ledger compliance
          // builder segments expected-slot expansion against the schedule
          // that was live on each past day (matches the detail page).
          scheduleRevisions: {
            orderBy: { validFrom: "asc" },
            select: {
              id: true,
              validFrom: true,
              validUntil: true,
              payload: true,
              supersededByRevisionId: true,
            },
          },
          // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
          pauseEras: { select: { pausedAt: true, resumedAt: true } },
          // v1.4.25 W4d — eager-load dose history + recent intake site
          // for any active medication. Generic meds carry empty arrays
          // so the legacy data path is byte-identical.
          doseChanges: { orderBy: { effectiveFrom: "asc" } },
          intakeEvents: {
            where: { takenAt: { not: null } },
            orderBy: { takenAt: "desc" },
            take: 1,
            select: { takenAt: true, injectionSite: true },
          },
        },
      }),
      prisma.medicationIntakeEvent.findMany({
        // v1.7.0 sync — exclude tombstoned rows from the doctor report.
        where: {
          userId,
          deletedAt: null,
          scheduledFor: { gte: start, lte: end },
        },
        include: {
          // v1.9.0 — carry the medication identity + codes + delivery
          // form so the FHIR MedicationAdministration builder can emit a
          // self-describing `medicationCodeableConcept` and a route.
          medication: {
            select: {
              id: true,
              name: true,
              dose: true,
              atcCode: true,
              rxNormCode: true,
              deliveryForm: true,
              asNeeded: true,
            },
          },
        },
        orderBy: { scheduledFor: "asc" },
      }),
      // Mood data: zero DB read when the user opted out. This is the
      // privacy-by-default contract — the JSON payload + audit log
      // both reflect "mood was never fetched", not "mood was fetched
      // and then dropped".
      sections.mood
        ? prisma.moodEntry.findMany({
            // v1.7.0 sync — exclude tombstoned rows from the doctor report.
            where: {
              userId,
              deletedAt: null,
              moodLoggedAt: { gte: start, lte: end },
            },
            orderBy: { moodLoggedAt: "asc" },
            // v1.28.46 perf (H1) — narrow select. The collector reads exactly
            // two fields off each mood row: `score` (the mood summary /
            // distribution) and `tags` (GLP-1 side-effect tag counts). The
            // full-width read pulled every column — including the encrypted
            // `noteEncrypted` Bytes and the plaintext `note` free text — across
            // the whole report window, none of which the report ever touches.
            select: { score: true, tags: true },
          })
        : Promise.resolve([]),
      densePulse || denseGlucose
        ? prisma.$queryRaw<DenseMeasurementBucket[]>`
            WITH localized AS (
              SELECT
                m."id",
                m."type",
                m."source",
                m."device_type",
                m."glucose_context",
                m."value",
                m."measured_at",
                date_trunc(
                  'day',
                  (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${reportTz}
                ) AS local_day
              FROM measurements m
              WHERE m."user_id" = ${userId}
                AND m."measured_at" >= ${start}
                AND m."measured_at" <= ${end}
                AND m."deleted_at" IS NULL
                AND (
                  (${densePulse} AND m."type" = 'PULSE'::"measurement_type")
                  OR
                  (${denseGlucose} AND m."type" = 'BLOOD_GLUCOSE'::"measurement_type")
                )
            ),
            scored AS (
              SELECT
                localized.*,
                CASE
                  WHEN "value" > 0
                  THEN 1.509 * (power(ln("value"), 1.084) - 5.381)
                  ELSE NULL
                END AS risk_transform
              FROM localized
            ),
            latest_rows AS (
              SELECT DISTINCT ON (
                local_day,
                "type",
                "source",
                "device_type",
                "glucose_context"
              )
                local_day,
                "type",
                "source",
                "device_type",
                "glucose_context",
                "measured_at" AS latest_at,
                "value" AS latest_value
              FROM localized
              ORDER BY
                local_day,
                "type",
                "source",
                "device_type",
                "glucose_context",
                "measured_at" DESC,
                "id" DESC
            ),
            grouped AS (
              SELECT
                local_day,
                "type",
                "source",
                "device_type",
                "glucose_context",
                COUNT(*)::int AS sample_count,
                SUM("value")::double precision AS sum_value,
                MIN("value")::double precision AS min_value,
                MAX("value")::double precision AS max_value,
                COUNT(*) FILTER (WHERE "value" > 0)::int AS clinical_count,
                SUM("value") FILTER (WHERE "value" > 0)::double precision
                  AS clinical_sum,
                SUM("value" * "value") FILTER (WHERE "value" > 0)::double precision
                  AS clinical_sum_squares,
                MIN("measured_at") FILTER (WHERE "value" > 0) AS clinical_first_at,
                MAX("measured_at") FILTER (WHERE "value" > 0) AS clinical_last_at,
                COUNT(*) FILTER (WHERE "value" BETWEEN 70 AND 180)::int
                  AS clinical_tir_count,
                COUNT(*) FILTER (WHERE "value" > 0 AND "value" < 70)::int
                  AS clinical_tbr1_count,
                COUNT(*) FILTER (WHERE "value" > 0 AND "value" < 54)::int
                  AS clinical_tbr2_count,
                COUNT(*) FILTER (WHERE "value" > 180)::int
                  AS clinical_tar1_count,
                COUNT(*) FILTER (WHERE "value" > 250)::int
                  AS clinical_tar2_count,
                SUM(
                  CASE
                    WHEN risk_transform < 0
                    THEN 10 * risk_transform * risk_transform
                    ELSE 0
                  END
                ) FILTER (WHERE risk_transform IS NOT NULL)::double precision
                  AS clinical_low_risk_sum,
                SUM(
                  CASE
                    WHEN risk_transform > 0
                    THEN 10 * risk_transform * risk_transform
                    ELSE 0
                  END
                ) FILTER (WHERE risk_transform IS NOT NULL)::double precision
                  AS clinical_high_risk_sum
              FROM scored
              GROUP BY
                local_day,
                "type",
                "source",
                "device_type",
                "glucose_context"
            )
            SELECT
              grouped.local_day AT TIME ZONE ${reportTz} AS "bucketStart",
              grouped."type",
              grouped."source",
              grouped."device_type" AS "deviceType",
              grouped."glucose_context" AS "glucoseContext",
              grouped.sample_count AS "count",
              grouped.sum_value AS "sumValue",
              grouped.min_value AS "minValue",
              grouped.max_value AS "maxValue",
              latest_rows.latest_at AS "latestAt",
              latest_rows.latest_value::double precision AS "latestValue",
              grouped.clinical_count AS "clinicalCount",
              grouped.clinical_sum AS "clinicalSum",
              grouped.clinical_sum_squares AS "clinicalSumSquares",
              grouped.clinical_first_at AS "clinicalFirstAt",
              grouped.clinical_last_at AS "clinicalLastAt",
              grouped.clinical_tir_count AS "clinicalTirCount",
              grouped.clinical_tbr1_count AS "clinicalTbr1Count",
              grouped.clinical_tbr2_count AS "clinicalTbr2Count",
              grouped.clinical_tar1_count AS "clinicalTar1Count",
              grouped.clinical_tar2_count AS "clinicalTar2Count",
              grouped.clinical_low_risk_sum AS "clinicalLowRiskSum",
              grouped.clinical_high_risk_sum AS "clinicalHighRiskSum"
            FROM grouped
            INNER JOIN latest_rows
              ON latest_rows.local_day = grouped.local_day
              AND latest_rows."type" = grouped."type"
              AND latest_rows."source" = grouped."source"
              AND latest_rows."device_type" IS NOT DISTINCT FROM grouped."device_type"
              AND latest_rows."glucose_context" IS NOT DISTINCT FROM grouped."glucose_context"
            ORDER BY "bucketStart" ASC, grouped."type" ASC
          `
        : Promise.resolve([]),
    ]);

  const denseSummary = summariseDenseBuckets(
    denseBuckets,
    reportTz,
    userProfile?.sourcePriorityJson ?? null,
    days,
  );

  // v1.18.0 — collapse each multi-source metric to its CANONICAL source before
  // grouping, so the report's per-type avg/min/max match the dashboard rather
  // than blending overlapping sources (e.g. WHOOP + Apple Watch resting-heart-
  // rate summed into one inflated mean). See `collapseMeasurementsToCanonical`.
  const canonicalMeasurements = collapseMeasurementsToCanonical(
    measurements,
    reportTz,
    userProfile?.sourcePriorityJson ?? null,
  );

  // Group measurements by type (canonical-source-collapsed).
  const byType: Record<
    string,
    Array<{ value: number; measuredAt: string }>
  > = {};
  for (const m of canonicalMeasurements) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push({
      value: m.value,
      measuredAt: m.measuredAt.toISOString(),
    });
  }
  for (const [type, entries] of Object.entries(denseSummary.byType)) {
    byType[type] = entries;
  }
  // measuredAt-ascending within each type so `latest` (last element) is the
  // most recent reading after the canonical collapse reorders by bucket.
  for (const entries of Object.values(byType)) {
    entries.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  }

  // v1.17.1 parity — SLEEP_DURATION enters `byType` as RAW per-stage rows (a
  // 40-min DEEP block, a 12-min AWAKE block, …). Every other sleep surface
  // (dashboard slim slice, /insights/sleep, /api/sleep/night, the iOS feed)
  // shows the per-night reconstructed asleep total via `summarizeSleepNights`,
  // and the v1.17.1 stamping fixes rewrite exactly those raw stage rows. Route
  // the report's sleep value through the same engine — one number, one surface
  // — exactly as RECOVERY_SCORE routes through `summariseCanonicalRecovery`.
  const sleepRows = measurements.filter(
    (m) => m.type === "SLEEP_DURATION",
  ) as unknown as SleepStageRow[];
  if (sleepRows.length > 0) {
    const nights = reconstructSleepNights(
      sleepRows,
      reportTz,
      userProfile?.sourcePriorityJson ?? null,
    ).filter((n) => n.asleepMinutes > 0);
    // Per-night asleep totals, ascending by night, replace the raw per-stage
    // rows so the clinical vitals table reads time-asleep hours, not stage-row
    // minutes. Empty (no scorable night) drops SLEEP_DURATION entirely.
    if (nights.length > 0) {
      byType.SLEEP_DURATION = nights.map((n) => ({
        value: n.asleepMinutes,
        measuredAt: n.measuredAt.toISOString(),
      }));
    } else {
      delete byType.SLEEP_DURATION;
    }
  }

  // Per-type stats.
  const stats: Record<string, DoctorReportStats> = {};
  for (const [type, entries] of Object.entries(byType)) {
    const values = entries.map((e) => e.value);
    stats[type] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      ...minMaxOf(values),
      count: values.length,
      latest: values[values.length - 1],
    };
  }
  Object.assign(stats, denseSummary.stats);

  // v1.17 W1a — medication compliance through the dose-ledger authority (the
  // same engine the detail page uses), NOT a raw-row tally. Routes each
  // scheduled medication's intake rows through the cadence-aware band minter
  // over the report window so the PDF / FHIR adherence % matches the app's
  // detail page (slot dedup, band timing, cadence honoured). As-needed / PRN
  // medications are excluded — no schedule, no expected dose, no fabricated
  // 100 % on a clinical report. The medication itself stays on the list.
  const compliance = buildLedgerCompliance(
    medications.map((m) => ({
      id: m.id,
      name: m.name,
      asNeeded: m.asNeeded,
      startsOn: m.startsOn,
      endsOn: m.endsOn,
      oneShot: m.oneShot,
      createdAt: m.createdAt,
      schedules: m.schedules,
      scheduleRevisions: m.scheduleRevisions,
      pauseEras: m.pauseEras,
    })),
    intakeEvents.map((e) => ({
      medicationId: e.medicationId,
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed ?? false,
      attributionSource: e.attributionSource ?? undefined,
    })),
    reportTz,
    start,
    end,
    end,
  );

  // v1.9.0 — MedicationAdministration source rows. One entry per acted
  // intake (taken OR explicitly skipped); pending / missed rows are
  // dropped so the FHIR export never asserts an administration that did
  // not happen, and tombstoned rows are already excluded by the query
  // `deletedAt: null` predicate. The structured `dose` is resolved from
  // the medication's `MedicationDoseChange` history — the latest change
  // effective at or before the administration instant — when one exists.
  //
  // Dose-change history is loaded on the `medications` array (active
  // meds only); a per-medicationId index lets the resolver run in O(1)
  // lookups + a short linear scan over the (typically small) change list.
  const doseChangesByMedId = new Map<
    string,
    Array<{ effectiveFrom: Date; doseValue: number; doseUnit: string }>
  >();
  for (const m of medications) {
    doseChangesByMedId.set(
      m.id,
      m.doseChanges.map((dc) => ({
        effectiveFrom: dc.effectiveFrom,
        doseValue: dc.doseValue,
        doseUnit: dc.doseUnit,
      })),
    );
  }
  const resolveDoseInEffect = (
    medicationId: string,
    at: Date,
  ): { value: number; unit: string } | null => {
    const changes = doseChangesByMedId.get(medicationId);
    if (!changes || changes.length === 0) return null;
    // `doseChanges` are loaded ordered by `effectiveFrom asc`; take the
    // last one whose effectiveFrom is <= the administration instant.
    let inEffect: { value: number; unit: string } | null = null;
    for (const c of changes) {
      if (c.effectiveFrom.getTime() <= at.getTime()) {
        inEffect = { value: c.doseValue, unit: c.doseUnit };
      } else {
        break;
      }
    }
    return inEffect;
  };

  const medicationAdministrations: NonNullable<
    DoctorReportData["medicationAdministrations"]
  > = [];
  for (const event of intakeEvents) {
    // Only acted rows: a taken dose (completed) or an explicit skip
    // (not-done). A scheduled-but-unconfirmed ("missed") slot is not an
    // administration event and is omitted entirely.
    const isTaken = event.takenAt !== null;
    if (!isTaken && !event.skipped) continue;
    const effectiveAt = isTaken ? (event.takenAt as Date) : event.scheduledFor;
    medicationAdministrations.push({
      medicationName: event.medication.name,
      effectiveAt: effectiveAt.toISOString(),
      status: isTaken ? "completed" : "not-done",
      doseText: event.medication.dose || null,
      // Structured dose only meaningful for a taken dose with a
      // dose-change history; a skip records no dose consumed.
      dose: isTaken
        ? resolveDoseInEffect(event.medication.id, effectiveAt)
        : null,
      injectionSite: event.injectionSite ?? null,
      atcCode: event.medication.atcCode ?? null,
      rxNormCode: event.medication.rxNormCode ?? null,
      deliveryForm: event.medication.deliveryForm ?? null,
    });
  }

  // v1.9.0 — bound the administration set. `intakeEvents` is ordered
  // `scheduledFor: asc`, so the most-recent acted rows are at the tail;
  // keep the last N and flag the trim so the FHIR narrative can disclose
  // it. The omitted rows are the OLDEST in the window — recent adherence
  // is preserved intact. The cap is a coarse safety ceiling (the report
  // window is the natural bound; this only guards a pathological
  // multi-year, many-medication export) — resolved per call from
  // `FHIR_MAX_MEDICATION_ADMINISTRATIONS` so an operator override takes
  // effect without a code change.
  const maxMedicationAdministrations = resolveMaxMedicationAdministrations(
    process.env.FHIR_MAX_MEDICATION_ADMINISTRATIONS,
  );
  const totalAdministrations = medicationAdministrations.length;
  const medicationAdministrationsTruncated =
    totalAdministrations > maxMedicationAdministrations;
  const cappedAdministrations = medicationAdministrationsTruncated
    ? medicationAdministrations.slice(
        totalAdministrations - maxMedicationAdministrations,
      )
    : medicationAdministrations;

  // Mood summary.
  const moodScores = moodEntries.map((e) => e.score);
  const mood: DoctorReportMood | null =
    moodScores.length > 0
      ? {
          avg: moodScores.reduce((a, b) => a + b, 0) / moodScores.length,
          min: minMaxOf(moodScores).min,
          max: minMaxOf(moodScores).max,
          count: moodScores.length,
          distribution: {
            1: moodScores.filter((s) => s === 1).length,
            2: moodScores.filter((s) => s === 2).length,
            3: moodScores.filter((s) => s === 3).length,
            4: moodScores.filter((s) => s === 4).length,
            5: moodScores.filter((s) => s === 5).length,
          },
        }
      : null;

  // BMI from latest weight + profile height.
  const weightStats = stats.WEIGHT;
  const bmiRaw =
    weightStats && userProfile?.heightCm
      ? weightStats.latest / (userProfile.heightCm / 100) ** 2
      : null;
  const bmi = bmiRaw !== null ? Math.round(bmiRaw * 10) / 10 : null;

  // Per-context glucose stats + effective ranges (canonical mg/dL).
  const glucoseStats: Record<string, DoctorReportStats> = denseGlucose
    ? { ...denseSummary.glucoseStats }
    : {};
  const glucoseRanges: Record<string, { min: number; max: number }> = {};
  // v1.18.0 — when the glucose module is disabled, no glucose row enters the
  // panel: stats, ranges, and the clinical metrics all collapse to empty so the
  // PDF + FHIR Observations carry no glucose for this user.
  const glucoseRows = glucoseEnabled
    ? measurements.filter((m) => m.type === "BLOOD_GLUCOSE")
    : [];
  const overrides = (userProfile?.thresholdsJson ??
    null) as ThresholdOverridesJson | null;
  const profileForRange = {
    heightCm: userProfile?.heightCm ?? null,
    dateOfBirth: userProfile?.dateOfBirth ?? null,
    gender: userProfile?.gender ?? null,
  };
  for (const ctx of GLUCOSE_CONTEXTS) {
    if (!denseGlucose) {
      const rows = glucoseRows.filter((m) => m.glucoseContext === ctx);
      if (rows.length === 0) continue;
      const values = rows.map((r) => r.value);
      glucoseStats[ctx] = {
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        ...minMaxOf(values),
        count: values.length,
        latest: values[values.length - 1],
      };
    } else if (!glucoseStats[ctx]) {
      continue;
    }
    const eff = getEffectiveRange(
      thresholdMetricForContext(ctx),
      profileForRange,
      overrides,
    );
    if (eff.range) {
      glucoseRanges[ctx] = { min: eff.range.greenMin, max: eff.range.greenMax };
    }
  }

  // v1.17.0 — clinical panel over the WHOLE report period (all contexts
  // pooled), computed by the one literature-locked engine the insights panel
  // and the coach also consume. `windowDays` is the report's own period so the
  // TIR / GMI / eA1C / CV% reflect exactly the readings the rest of the report
  // tabulates; `now: end` anchors the window to the report's upper bound. The
  // learning gate keeps a thin period from asserting a clinical AGP off spot
  // data. Values stay canonical mg/dL; the renderer converts with `glucoseUnit`.
  const glucoseClinical = denseGlucose
    ? denseSummary.glucoseClinical
    : computeGlucoseClinicalMetrics(
        glucoseRows.map((r) => ({ measuredAt: r.measuredAt, mgdl: r.value })),
        { windowDays: days, now: end },
      );

  // `practiceName` is sanitised to a single-line string with a hard length
  // cap. The PDF cover prints it verbatim — never let unbounded input land in
  // a layout-sensitive header.
  const practiceName = sanitisePracticeName(options.practiceName);

  // Apply section toggles. Removing the type's keys from `byType`,
  // `stats`, and `compliance` lets the PDF renderer treat "section
  // disabled" identically to "section had no rows" — both paths skip
  // the table. Mood is already null when disabled (we never queried).
  const filteredByType = filterMeasurementKeys(byType, sections, moduleMap);
  const filteredStats = filterMeasurementKeys(stats, sections, moduleMap);
  const filteredCompliance = sections.compliance ? compliance : {};
  const filteredBmi = sections.bmi ? bmi : null;

  // v1.4.25 W4d — GLP-1 therapy section. Only assembled when the user
  // has at least one active GLP-1 medication AND the compliance toggle
  // is on (per the privacy contract: a doctor-report dose history needs
  // the compliance section enabled to be useful). Generic accounts
  // get `glp1: null` which the PDF renderer skips entirely.
  const glp1Meds = medications.filter((m) => m.treatmentClass === "GLP1");
  let glp1: DoctorReportData["glp1"] = null;
  if (sections.compliance && glp1Meds.length > 0) {
    const weightSorted = (byType.WEIGHT ?? []).slice();
    const weightStartKg = weightSorted[0]?.value ?? null;
    const weightEndKg = weightSorted[weightSorted.length - 1]?.value ?? null;
    const weightDeltaKg =
      weightStartKg !== null && weightEndKg !== null
        ? Math.round((weightEndKg - weightStartKg) * 10) / 10
        : null;

    // Side-effect tag counts (only when mood section is enabled — we
    // already gated the moodEntries read on `sections.mood`, so this
    // collapses to "no tags" when the user opted out).
    const sideEffectTags = new Set([
      "nausea",
      "constipation",
      "diarrhea",
      "fatigue",
      "appetite-loss",
      "heartburn",
      "headache",
      "übelkeit",
      "verstopfung",
      "durchfall",
      "müdigkeit",
      "appetitlosigkeit",
      "sodbrennen",
      "kopfschmerzen",
    ]);
    const sideEffectCounts = new Map<string, number>();
    for (const mood of moodEntries) {
      const rawTags = mood.tags ?? "";
      let tags: string[];
      try {
        const parsed = JSON.parse(rawTags);
        tags = Array.isArray(parsed)
          ? parsed
              .map((v: unknown) => (typeof v === "string" ? v.trim() : ""))
              .filter(Boolean)
          : [];
      } catch {
        tags = rawTags
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
      }
      for (const tag of tags) {
        const lower = tag.toLowerCase();
        if (!sideEffectTags.has(lower)) continue;
        sideEffectCounts.set(lower, (sideEffectCounts.get(lower) ?? 0) + 1);
      }
    }

    glp1 = {
      medications: glp1Meds.map((m) => {
        const latest = m.doseChanges[m.doseChanges.length - 1] ?? null;
        const lastIntake = m.intakeEvents[0] ?? null;
        const comp = compliance[m.name] ?? {
          taken: 0,
          total: 0,
          skipped: 0,
          missed: 0,
        };
        return {
          name: m.name,
          currentDose: latest
            ? {
                value: latest.doseValue,
                unit: latest.doseUnit,
                since: latest.effectiveFrom.toISOString(),
              }
            : null,
          doseHistory: m.doseChanges.map((dc) => ({
            value: dc.doseValue,
            unit: dc.doseUnit,
            effectiveFrom: dc.effectiveFrom.toISOString(),
            note: readNote(dc.noteEncrypted, dc.note),
          })),
          lastInjection:
            lastIntake && lastIntake.takenAt
              ? {
                  date: lastIntake.takenAt.toISOString(),
                  site: lastIntake.injectionSite,
                }
              : null,
          compliance: { taken: comp.taken, total: comp.total },
        };
      }),
      weightStartKg,
      weightEndKg,
      weightDeltaKg,
      sideEffects: Array.from(sideEffectCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => ({ tag, count })),
    };
  }

  // v1.10.0 — wellness-score summary. The persisted `*_SCORE` rows are already
  // in `byType`/`stats` (they're only filtered out of the clinical vitals
  // table). Summarise each present score type for the separate "Wellness
  // summary" section. Empty array → null so the renderer + FHIR builder skip
  // the section entirely.
  //
  // RECOVERY_SCORE carries BOTH the WHOOP-native row and the COMPUTED proxy for
  // the same day; mixing them into one min/avg/max would blend two distinct
  // series. Resolve to the canonical row per day (WHOOP wins) so the PDF reads
  // the SAME value the tile + iOS feed show — one number, one engine.
  const wellnessScoreSummaries = WELLNESS_SCORE_REPORT_TYPES.flatMap((type) => {
    // v1.18.0 — module gate per score type. Recovery + stress are the
    // recovery/readiness signals (recovery module); strain is the
    // training-load signal derived from the workouts table (workouts module).
    // A disabled owning module drops the score from the wellness summary and,
    // since the FHIR exporter sources these Observations from
    // `data.wellnessScores`, from the bundle too.
    if (type === "STRAIN_SCORE" && !workoutsEnabled) return [];
    if (
      (type === "RECOVERY_SCORE" || type === "STRESS_SCORE") &&
      !recoveryEnabled
    ) {
      return [];
    }
    if (type === "RECOVERY_SCORE") {
      const summary = summariseCanonicalRecovery(measurements, reportTz);
      return summary ? [summary] : [];
    }
    const s = stats[type];
    const rows = byType[type];
    if (!s || !rows || rows.length === 0) return [];
    return [
      {
        type,
        latest: Math.round(s.latest),
        avg: Math.round(s.avg),
        min: Math.round(s.min),
        max: Math.round(s.max),
        count: s.count,
        latestAt: rows[rows.length - 1].measuredAt,
      },
    ];
  });
  const wellnessScores =
    wellnessScoreSummaries.length > 0 ? wellnessScoreSummaries : null;

  // v1.15.0 — cycle summary. Privacy default OFF: only read + assemble when
  // the `cycle` section toggle is explicitly ON. Statistics only — the
  // helper never touches `notesEncrypted`, so no plaintext free-text can
  // leak through this surface. `null` when disabled or no observed cycle.
  let cycle: DoctorReportData["cycle"] = null;
  if (sections.cycle) {
    cycle = await buildCycleExportSummary(
      userId,
      end.toISOString().slice(0, 10),
    );
  }

  // v1.17.1 — structured lab results over the window. ON by default; the
  // user recorded these specifically to share with a clinician, so the
  // privacy stance matches BP / weight, not mood / cycle. We reduce to the
  // latest reading per analyte (with a count) so the report is a concise
  // panel, not a raw dump; notes are never read here.
  let labResults: DoctorReportData["labResults"] = null;
  if (sections.labs) {
    const labRows = await prisma.labResult.findMany({
      where: { userId, takenAt: { gte: start, lte: end }, deletedAt: null },
      orderBy: { takenAt: "asc" },
      select: {
        panel: true,
        analyte: true,
        value: true,
        valueText: true,
        unit: true,
        referenceLow: true,
        referenceHigh: true,
        takenAt: true,
      },
    });
    // Latest-per-analyte, keyed case-insensitively so "LDL" / "ldl" fold
    // together; rows are ascending so the last seen wins as the latest.
    const byAnalyte = new Map<
      string,
      NonNullable<DoctorReportData["labResults"]>[number]
    >();
    for (const r of labRows) {
      const key = r.analyte.toLowerCase();
      const prev = byAnalyte.get(key);
      byAnalyte.set(key, {
        panel: r.panel,
        analyte: r.analyte,
        value: r.value,
        valueText: r.valueText,
        unit: r.unit,
        referenceLow: r.referenceLow,
        referenceHigh: r.referenceHigh,
        takenAt: r.takenAt.toISOString(),
        count: (prev?.count ?? 0) + 1,
      });
    }
    const collapsed = Array.from(byAnalyte.values());
    labResults = collapsed.length > 0 ? collapsed : null;
  }

  // v1.18.1 P4 — illness / condition episodes overlapping the window. Gated
  // on the illness module (default-on, opt-out): when off, no read, no section.
  // An episode overlaps when it began on or before the window end AND is
  // either still ongoing or resolved on or after the window start. Labels +
  // lifecycle + dates only — the encrypted note is never selected, so no
  // free-text leaks into the clinical export.
  let illnessEpisodes: DoctorReportData["illnessEpisodes"] = null;
  if (moduleMap.illness !== false) {
    const episodeRows = await prisma.illnessEpisode.findMany({
      where: {
        userId,
        deletedAt: null,
        onsetAt: { lte: end },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: start } }],
      },
      orderBy: { onsetAt: "asc" },
      select: {
        label: true,
        type: true,
        lifecycle: true,
        onsetAt: true,
        resolvedAt: true,
      },
    });
    const mapped = episodeRows.map((e) => ({
      label: e.label,
      type: e.type,
      lifecycle: e.lifecycle,
      onsetAt: e.onsetAt.toISOString(),
      resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null,
    }));
    illnessEpisodes = mapped.length > 0 ? mapped : null;
  }

  // v1.27.x — structured allergies + family history. Reference data, not
  // time-windowed (a penicillin allergy does not expire with the report
  // window), so no date filter. Riding the section toggles keeps the "you
  // can deselect any section" contract; both default ON — a clinical
  // report without an allergy section is the riskier default. The
  // reaction description decrypts fail-soft per row; the free-text notes
  // are never selected, matching the illness-journal stance.
  let allergies: DoctorReportData["allergies"] = null;
  if (sections.allergies) {
    const rows = await prisma.allergy.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        substance: true,
        category: true,
        type: true,
        severity: true,
        status: true,
        reactionEncrypted: true,
      },
    });
    const mapped = rows.map((r) => {
      const { reaction, reactionUnreadable } = decryptAllergyReaction(
        r.reactionEncrypted,
      );
      if (reactionUnreadable) {
        // A reaction WAS recorded but is undecryptable (key gap / GCM
        // corruption). It is flagged (not silently blanked) so the PDF renders
        // an honest "unreadable" marker; log the swallowed decrypt so a
        // systemic key-config failure is visible rather than masquerading as
        // "no reaction recorded" on a clinician-facing export.
        getEvent()?.addWarning(
          `doctor-report: allergy reaction decrypt failed for ${userId} (substance=${r.substance})`,
        );
      }
      return {
        substance: r.substance,
        category: r.category,
        type: r.type,
        severity: r.severity,
        status: r.status,
        reaction,
        reactionUnreadable,
      };
    });
    allergies = mapped.length > 0 ? mapped : null;
  }

  let familyHistory: DoctorReportData["familyHistory"] = null;
  if (sections.familyHistory) {
    const rows = await prisma.familyHistoryEntry.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { relationship: true, condition: true, ageAtOnset: true },
    });
    familyHistory = rows.length > 0 ? rows : null;
  }

  return {
    period: {
      days,
      // `since` is preserved for backwards compatibility with any in-flight
      // clients that read the old field name; mirrors `start`.
      since: start.toISOString(),
      start: start.toISOString(),
      end: end.toISOString(),
    },
    patient: {
      username: userProfile?.username ?? null,
      dateOfBirth: userProfile?.dateOfBirth
        ? userProfile.dateOfBirth.toISOString()
        : null,
      gender: userProfile?.gender ?? null,
      heightCm: userProfile?.heightCm ?? null,
      fullName: userProfile?.fullName ?? null,
      insurerName: userProfile?.insurerName ?? null,
      insurerIkNumber: userProfile?.insurerIkNumber ?? null,
    },
    practiceName,
    measurements: filteredByType,
    stats: filteredStats,
    glucoseStats,
    glucoseRanges,
    // Surfaced by the insights glucose views; the doctor-PDF / FHIR rendering of
    // these clinical metrics is staged for a later release, so no report
    // consumer reads this field yet — it is forward-populated, not dead.
    glucoseClinical,
    glucoseUnit: resolveGlucoseUnit(userProfile?.glucoseUnit ?? null),
    bmi: filteredBmi,
    compliance: filteredCompliance,
    medications: medications.map((m) => ({
      name: m.name,
      dose: m.dose,
      // v1.9.0 — drug-classification codes for the coded FHIR concept.
      atcCode: m.atcCode,
      rxNormCode: m.rxNormCode,
      schedules: m.schedules.map((s) => ({
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
      })),
    })),
    medicationAdministrations: cappedAdministrations,
    medicationAdministrationsTruncation: medicationAdministrationsTruncated
      ? { total: totalAdministrations, included: cappedAdministrations.length }
      : null,
    mood,
    glp1,
    wellnessScores,
    cycle,
    labResults,
    illnessEpisodes,
    allergies,
    familyHistory,
  };
}

/**
 * Per-measurement-type → section-toggle mapping. Keys not listed here
 * (e.g., body fat, oxygen saturation) bypass the toggles — those sections
 * have no per-report flag. Glucose DOES carry a `glucose` section toggle,
 * but `BLOOD_GLUCOSE` is gated at query-exclusion time (mirroring sleep) and
 * its panel collapses via `glucoseEnabled`, so it does not ride this map.
 */
const MEASUREMENT_TYPE_SECTION: Record<string, keyof DoctorReportPrefs> = {
  BLOOD_PRESSURE_SYS: "bp",
  BLOOD_PRESSURE_DIA: "bp",
  WEIGHT: "weight",
  PULSE: "pulse",
  SLEEP_DURATION: "sleep",
};

/**
 * v1.18.0 — per-measurement-type → owning module mapping for the types that
 * carry no `sections` toggle but DO belong to a toggleable module. When the
 * module is disabled, the type is stripped from `measurements` + `stats` so the
 * series never reaches the PDF tables or a FHIR Observation.
 *
 *   - `workouts` owns the activity / movement series (steps, active energy,
 *     distance, flights, the walking-gait + stair metrics) and the
 *     training-load `STRAIN_SCORE`.
 *   - `recovery` owns the readiness signals `RECOVERY_SCORE` + `STRESS_SCORE`.
 *   - `glucose` owns the raw `BLOOD_GLUCOSE` series (the glucose panel itself is
 *     gated where it is assembled; this strips the raw rows too).
 *
 * Core clinical types (BP / weight / pulse / body-composition / vitals) carry
 * no module and are never gated here. `sleep` / `mood` / `cycle` / `labs` ride
 * the `sections` mechanism instead.
 */
const MEASUREMENT_TYPE_MODULE: Record<string, ModuleKey> = {
  ACTIVITY_STEPS: "workouts",
  ACTIVE_ENERGY_BURNED: "workouts",
  FLIGHTS_CLIMBED: "workouts",
  WALKING_RUNNING_DISTANCE: "workouts",
  WALKING_SPEED: "workouts",
  WALKING_ASYMMETRY: "workouts",
  WALKING_STEP_LENGTH: "workouts",
  WALKING_DOUBLE_SUPPORT: "workouts",
  SIX_MINUTE_WALK_DISTANCE: "workouts",
  STAIR_ASCENT_SPEED: "workouts",
  STAIR_DESCENT_SPEED: "workouts",
  STRAIN_SCORE: "workouts",
  RECOVERY_SCORE: "recovery",
  STRESS_SCORE: "recovery",
  BLOOD_GLUCOSE: "glucose",
  // v1.25.0 — the PHQ-9 / GAD-7 screener TOTALS ride the doctor-report / FHIR
  // export only when the opt-in mental-health module is on (default OFF →
  // excluded by default, privacy-by-default). Item-level answers are never a
  // Measurement, so they can never leak through this path regardless. The total
  // is the intended clinical artefact (total + band per clinical-instruments.md
  // §4); gating it on the module keeps the export consistent with how mood /
  // sleep / glucose are gated and avoids exporting a screener the account never
  // opted into.
  PHQ9_SCORE: "mentalHealth",
  GAD7_SCORE: "mentalHealth",
  // v1.27.9 — the WHO-5 / SCI totals ride the same module gate.
  WHO5_SCORE: "mentalHealth",
  SCI_SCORE: "mentalHealth",
};

function filterMeasurementKeys<T>(
  map: Record<string, T>,
  sections: DoctorReportPrefs,
  moduleMap: Record<ModuleKey, boolean>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [type, value] of Object.entries(map)) {
    const sectionKey = MEASUREMENT_TYPE_SECTION[type];
    if (sectionKey && sections[sectionKey] === false) continue;
    const moduleKey = MEASUREMENT_TYPE_MODULE[type];
    if (moduleKey && moduleMap[moduleKey] === false) continue;
    out[type] = value;
  }
  return out;
}
