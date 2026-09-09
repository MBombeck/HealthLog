/**
 * Server-side aggregator for doctor-report data.
 *
 * Single source of truth for the payload every output path reads: the PDF, the
 * FHIR document bundle, the package zip, the clinician share view, the FHIR
 * REST face and the MCP doctor-visit surfaces. A leaf excluded here is absent
 * from `measurements`, from `stats` and from the structured blocks, so every
 * renderer describes the same record by construction rather than by each one
 * remembering to apply the same filter.
 *
 * The third parameter is a REQUIRED, brand-typed {@link ReportSelection}. It
 * used to be optional and default to everything-on, which meant a new egress
 * path could be written without anyone answering "whose selection?". Now it
 * cannot compile without an answer.
 *
 * Pure data assembly — no auth, no rate limit, no audit. Idempotent.
 */
import { prisma } from "@/lib/db";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import {
  GLUCOSE_CONTEXT_BUCKETS,
  groupByGlucoseContext,
  resolveGlucoseUnit,
  thresholdMetricForContext,
} from "@/lib/glucose";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { buildCycleExportSummary } from "@/lib/cycle/export-data";
import { resolveModuleMap } from "@/lib/modules/gate";
import { SCHEDULE_COMPLIANCE_SELECT } from "@/lib/analytics/compliance";
import { MEASUREMENT_LEAF_IDS } from "@/lib/report-selection/catalogue";
import type { ReportSelection } from "@/lib/report-selection/selection";
import {
  WELLNESS_SCORE_REPORT_TYPES,
  type CollectDoctorReportOptions,
  type DoctorReportData,
  type DoctorReportMood,
  type DoctorReportRange,
  type DoctorReportStats,
} from "@/lib/doctor-report-types";
import {
  buildLedgerCompliance,
  collapseMeasurementsToCanonical,
  minMaxOf,
  sanitisePracticeName,
  summariseCanonicalRecovery,
} from "@/lib/doctor-report-helpers";
import {
  excludedMeasurementTypes,
  filterMeasurementKeys,
  resolveReportGate,
} from "./selection-gate";
import { loadDenseMeasurementBuckets } from "./dense-buckets";
import { summariseDenseBuckets } from "./measurement-series";
import { emptyGlucoseClinical } from "./glucose-panel";
import { buildAdministrationLedger, buildGlp1Block } from "./medications";
import {
  loadAllergies,
  loadAnamnesis,
  loadEmergency,
  loadFamilyHistory,
  loadIllnessEpisodes,
  loadImmunizations,
  loadVisits,
  loadLabResults,
} from "./clinical-records";

const DENSE_REPORT_RAW_WINDOW_DAYS = 90;

/** No medication row is read unless at least one medication leaf is admitted. */
const MEDICATION_LEAVES = [
  "MEDICATION_LIST",
  "MEDICATION_ADMINISTRATIONS",
  "MEDICATION_COMPLIANCE",
  "GLP1_THERAPY",
] as const;

export async function collectDoctorReportData(
  userId: string,
  range: DoctorReportRange,
  selection: ReportSelection,
  options: CollectDoctorReportOptions = {},
): Promise<DoctorReportData> {
  const { start, end, days } = range;

  // Resolve the per-user module map once. A disabled module wins over a
  // selected leaf; a deselected leaf wins over an enabled module. Injectable
  // for tests.
  const moduleMap = options.moduleMap ?? (await resolveModuleMap(userId));

  // v1.30.22 — fail-closed backstop on the aggregate's OWN module key.
  //
  // Everything below gates individual leaves, but nothing ever gated
  // `doctorReport` itself — the key that decides whether the whole-record
  // aggregate may be assembled at all. REFUSE, not omit: this is the
  // whole-record aggregate, so there is no honest partial answer. It throws
  // rather than returning an envelope because reaching here means a caller is
  // missing its gate — a bug to surface, not a flow to serve. Callers that can
  // degrade gracefully gate themselves BEFORE calling.
  if (moduleMap.doctorReport === false) {
    throw new Error(
      'collectDoctorReportData called with the "doctorReport" module ' +
        "disabled — the calling surface is missing its module gate",
    );
  }

  const gate = resolveReportGate(selection, moduleMap);

  // Types read BEFORE the output filter because something else is derived from
  // them. Weight feeds the BMI figure and the GLP-1 weight delta; the raw
  // glucose series feeds the clinical panel. Each derived block is gated by its
  // own leaf, so keeping the rows here widens nothing that leaves the function.
  const keepForDerived = new Set<MeasurementType>();
  if (gate.admits("BODY_MASS_INDEX") || gate.admits("GLP1_THERAPY")) {
    keepForDerived.add("WEIGHT");
  }
  if (gate.admits("GLUCOSE_PANEL")) keepForDerived.add("BLOOD_GLUCOSE");

  const excluded = excludedMeasurementTypes(
    gate,
    MEASUREMENT_LEAF_IDS,
    keepForDerived,
  );

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
  const densePulse = aggregateDenseTypes && !excluded.includes("PULSE");
  const denseGlucose =
    aggregateDenseTypes && !excluded.includes("BLOOD_GLUCOSE");
  const rawExcluded = [...excluded];
  if (densePulse) rawExcluded.push("PULSE");
  if (denseGlucose) rawExcluded.push("BLOOD_GLUCOSE");

  const wantsMedications = MEDICATION_LEAVES.some((leaf) => gate.admits(leaf));
  const wantsIntakeEvents =
    gate.admits("MEDICATION_ADMINISTRATIONS") ||
    gate.admits("MEDICATION_COMPLIANCE") ||
    gate.admits("GLP1_THERAPY");

  const [measurements, medications, intakeEvents, moodEntries, denseBuckets] =
    await Promise.all([
      prisma.measurement.findMany({
        // Soft-deleted rows never reach the report.
        where: {
          userId,
          measuredAt: { gte: start, lte: end },
          deletedAt: null,
          ...(rawExcluded.length > 0 ? { type: { notIn: rawExcluded } } : {}),
        },
        orderBy: { measuredAt: "asc" },
        // Narrow select: the collector reads exactly these seven fields.
        // The full-width read pulled every column — including the encrypted
        // notes — across up to 730 days of rows.
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
      wantsMedications
        ? prisma.medication.findMany({
            where: { userId, active: true },
            include: {
              schedules: {
                select: { ...SCHEDULE_COMPLIANCE_SELECT, label: true },
              },
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
              pauseEras: { select: { pausedAt: true, resumedAt: true } },
              doseChanges: { orderBy: { effectiveFrom: "asc" } },
              intakeEvents: {
                where: { takenAt: { not: null } },
                orderBy: { takenAt: "desc" },
                take: 1,
                select: { takenAt: true, injectionSite: true },
              },
            },
          })
        : Promise.resolve([]),
      wantsIntakeEvents
        ? prisma.medicationIntakeEvent.findMany({
            where: {
              userId,
              deletedAt: null,
              scheduledFor: { gte: start, lte: end },
            },
            include: {
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
          })
        : Promise.resolve([]),
      // Zero DB read when the mood leaf was not chosen: the payload reflects
      // "mood was never fetched", not "mood was fetched and then dropped".
      gate.admits("MOOD")
        ? prisma.moodEntry.findMany({
            where: {
              userId,
              deletedAt: null,
              moodLoggedAt: { gte: start, lte: end },
            },
            orderBy: { moodLoggedAt: "asc" },
            // Two fields: the score (summary + distribution) and the tags
            // (GLP-1 side-effect tallies). Never the note columns.
            select: { score: true, tags: true },
          })
        : Promise.resolve([]),
      loadDenseMeasurementBuckets({
        userId,
        start,
        end,
        reportTz,
        densePulse,
        denseGlucose,
      }),
    ]);

  const denseSummary = summariseDenseBuckets(
    denseBuckets,
    reportTz,
    userProfile?.sourcePriorityJson ?? null,
    days,
  );

  // Collapse each multi-source metric to its CANONICAL source before grouping,
  // so the per-type avg/min/max match the dashboard rather than blending
  // overlapping sources.
  const canonicalMeasurements = collapseMeasurementsToCanonical(
    measurements,
    reportTz,
    userProfile?.sourcePriorityJson ?? null,
  );

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
  for (const entries of Object.values(byType)) {
    entries.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  }

  // SLEEP_DURATION enters `byType` as RAW per-stage rows. Every other sleep
  // surface shows the per-night reconstructed asleep total, so route the
  // report's sleep value through the same engine — one number, one surface.
  const sleepRows = measurements.filter(
    (m) => m.type === "SLEEP_DURATION",
  ) as unknown as SleepStageRow[];
  if (sleepRows.length > 0) {
    const nights = reconstructSleepNights(
      sleepRows,
      reportTz,
      userProfile?.sourcePriorityJson ?? null,
    ).filter((n) => n.asleepMinutes > 0);
    if (nights.length > 0) {
      byType.SLEEP_DURATION = nights.map((n) => ({
        value: n.asleepMinutes,
        measuredAt: n.measuredAt.toISOString(),
      }));
    } else {
      delete byType.SLEEP_DURATION;
    }
  }

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

  // Medication compliance through the dose-ledger authority — the same engine
  // the detail page uses, not a raw-row tally. As-needed medications are
  // excluded: no schedule, no expected dose, no fabricated 100 % on a
  // clinical report. The medication itself stays on the list.
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

  const ledger = buildAdministrationLedger(medications, intakeEvents);

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

  // BMI from the latest weight and the profile height. Gated by its own leaf,
  // which is also the leaf that gates any recorded BODY_MASS_INDEX rows — one
  // control for the figure and the series alike.
  const weightStats = stats.WEIGHT;
  const bmiRaw =
    weightStats && userProfile?.heightCm
      ? weightStats.latest / (userProfile.heightCm / 100) ** 2
      : null;
  const bmi = bmiRaw !== null ? Math.round(bmiRaw * 10) / 10 : null;

  // Per-context glucose stats + effective ranges (canonical mg/dL). The whole
  // panel rides the GLUCOSE_PANEL leaf: stats, ranges and clinical metrics
  // collapse together, so the artefact never carries half of it.
  const glucosePanelOn = gate.admits("GLUCOSE_PANEL");
  const glucoseStats: Record<string, DoctorReportStats> =
    glucosePanelOn && denseGlucose ? { ...denseSummary.glucoseStats } : {};
  const glucoseRanges: Record<string, { min: number; max: number }> = {};
  const glucoseRows = glucosePanelOn
    ? measurements.filter((m) => m.type === "BLOOD_GLUCOSE")
    : [];
  const overrides = (userProfile?.thresholdsJson ??
    null) as ThresholdOverridesJson | null;
  const profileForRange = {
    heightCm: userProfile?.heightCm ?? null,
    dateOfBirth: userProfile?.dateOfBirth ?? null,
    gender: userProfile?.gender ?? null,
  };
  if (glucosePanelOn) {
    // #943 — the untagged bucket is a bucket. A report built from a meter
    // that records no meal-time context used to carry an empty glucose panel.
    const groupedGlucose = groupByGlucoseContext(
      glucoseRows,
      (m) => m.glucoseContext,
    );
    const glucoseBuckets = denseGlucose
      ? GLUCOSE_CONTEXT_BUCKETS
      : groupedGlucose.map(([bucket]) => bucket);
    for (const ctx of glucoseBuckets) {
      if (!denseGlucose) {
        const rows =
          groupedGlucose.find(([bucket]) => bucket === ctx)?.[1] ?? [];
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
        glucoseRanges[ctx] = {
          min: eff.range.greenMin,
          max: eff.range.greenMax,
        };
      }
    }
  }

  // The clinical panel over the whole report period, all contexts pooled.
  // `windowDays` is the report's own period so TIR / GMI / eA1C / CV% reflect
  // exactly the readings the rest of the report tabulates.
  const glucoseClinical = !glucosePanelOn
    ? emptyGlucoseClinical(days)
    : denseGlucose
      ? denseSummary.glucoseClinical
      : computeGlucoseClinicalMetrics(
          glucoseRows.map((r) => ({ measuredAt: r.measuredAt, mgdl: r.value })),
          { windowDays: days, now: end },
        );

  const practiceName = sanitisePracticeName(options.practiceName);

  // The output half of the query gate, reading the same gate object.
  const filteredByType = filterMeasurementKeys(byType, gate);
  const filteredStats = filterMeasurementKeys(stats, gate);

  const glp1 = gate.admits("GLP1_THERAPY")
    ? buildGlp1Block({
        medications,
        compliance,
        weightSeries: byType.WEIGHT ?? [],
        moodTagRows: moodEntries,
      })
    : null;

  // The wellness summary is filtered to the same score leaves the stats carry,
  // so it cannot disagree with them. RECOVERY_SCORE carries both the native row
  // and the computed proxy for one day; resolve to the canonical row so the PDF
  // reads the SAME value the tile shows.
  const wellnessScoreSummaries = WELLNESS_SCORE_REPORT_TYPES.flatMap((type) => {
    if (!gate.admits(type)) return [];
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

  // Each remaining structured block: read only when its leaf was chosen.
  const [
    cycle,
    labResults,
    illnessEpisodes,
    visits,
    immunizations,
    allergies,
    familyHistory,
    anamnesis,
    emergency,
  ] = await Promise.all([
    gate.admits("CYCLE")
      ? buildCycleExportSummary(userId, end.toISOString().slice(0, 10))
      : Promise.resolve(null),
    gate.admits("LAB_RESULTS")
      ? loadLabResults(userId, start, end)
      : Promise.resolve(null),
    gate.admits("ILLNESS_EPISODES")
      ? loadIllnessEpisodes(userId, start, end)
      : Promise.resolve(null),
    gate.admits("VISITS")
      ? loadVisits(userId, start, end)
      : Promise.resolve(null),
    // Reference data, not windowed — the immunization history is a lifetime
    // document, so the whole live set rides when the leaf and module admit it.
    gate.admits("IMMUNIZATIONS")
      ? loadImmunizations(userId)
      : Promise.resolve(null),
    gate.admits("ALLERGIES") ? loadAllergies(userId) : Promise.resolve(null),
    gate.admits("FAMILY_HISTORY")
      ? loadFamilyHistory(userId)
      : Promise.resolve(null),
    gate.admits("ANAMNESIS") ? loadAnamnesis(userId) : Promise.resolve(null),
    gate.admits("EMERGENCY") ? loadEmergency(userId) : Promise.resolve(null),
  ]);

  const identityOn = gate.admits("PATIENT_IDENTITY");
  const insuranceOn = gate.admits("INSURANCE");

  return {
    period: {
      days,
      // `since` mirrors `start`, preserved for in-flight clients.
      since: start.toISOString(),
      start: start.toISOString(),
      end: end.toISOString(),
    },
    patient: {
      username: identityOn ? (userProfile?.username ?? null) : null,
      dateOfBirth:
        identityOn && userProfile?.dateOfBirth
          ? userProfile.dateOfBirth.toISOString()
          : null,
      gender: identityOn ? (userProfile?.gender ?? null) : null,
      heightCm: identityOn ? (userProfile?.heightCm ?? null) : null,
      fullName: identityOn ? (userProfile?.fullName ?? null) : null,
      insurerName: insuranceOn ? (userProfile?.insurerName ?? null) : null,
      insurerIkNumber: insuranceOn
        ? (userProfile?.insurerIkNumber ?? null)
        : null,
    },
    practiceName,
    measurements: filteredByType,
    stats: filteredStats,
    glucoseStats,
    glucoseRanges,
    glucoseClinical,
    glucoseUnit: resolveGlucoseUnit(userProfile?.glucoseUnit ?? null),
    bmi: gate.admits("BODY_MASS_INDEX") ? bmi : null,
    compliance: gate.admits("MEDICATION_COMPLIANCE") ? compliance : {},
    medications: gate.admits("MEDICATION_LIST")
      ? medications.map((m) => ({
          name: m.name,
          dose: m.dose,
          atcCode: m.atcCode,
          rxNormCode: m.rxNormCode,
          schedules: m.schedules.map((s) => ({
            windowStart: s.windowStart,
            windowEnd: s.windowEnd,
            label: s.label,
          })),
        }))
      : [],
    medicationAdministrations: gate.admits("MEDICATION_ADMINISTRATIONS")
      ? ledger.administrations
      : [],
    medicationAdministrationsTruncation: gate.admits(
      "MEDICATION_ADMINISTRATIONS",
    )
      ? ledger.truncation
      : null,
    mood,
    glp1,
    wellnessScores,
    cycle,
    labResults,
    illnessEpisodes,
    visits,
    immunizations,
    allergies,
    familyHistory,
    anamnesis,
    emergency,
  };
}
