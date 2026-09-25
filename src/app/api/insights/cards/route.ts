/**
 * GET /api/insights/cards — iOS adapter over `/api/insights/comprehensive`.
 *
 * Reuses the same data sources (measurements, mood, intake events) and the
 * shared `generateAlerts()` rule engine, then re-shapes each `HealthAlert`
 * to the iOS Insight model (id, title, summary, severity, recommendations,
 * provider).
 *
 * Every card is a rule alert: deterministic text from the threshold engine,
 * never model output. So the route carries no AI gate and no `insights`
 * module gate (the AI analysis opt-out), `summary` is never null, and
 * `provider` is `"rules"`. It used to echo the account's chosen AI provider
 * (or `"claude"`), which claimed a model wrote text that none did.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { readDayMeanSeries } from "@/lib/insights/derived/baseline";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import {
  generateAlerts,
  type HealthAlert,
} from "@/lib/analytics/classifications";
import { pairByTimestamp } from "@/lib/analytics/correlations";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import type { MeasurementType } from "@/generated/prisma/client";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

type Severity = "alert" | "caution" | "info" | "good";

function toSeverity(level: HealthAlert["level"]): Severity {
  switch (level) {
    case "danger":
      return "alert";
    case "warning":
      return "caution";
    case "success":
      return "good";
    default:
      return "info";
  }
}

interface InsightRecommendation {
  id: string;
  label: string;
  actionURL: string | null;
}

interface InsightCard {
  id: string;
  title: string;
  summary: string;
  body: string | null;
  severity: Severity;
  recommendations: InsightRecommendation[];
  generatedAt: string;
  provider: string;
}

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");
  annotate({ action: { name: "insights.cards" } });

  const NINETY_DAY_WINDOW = 90;
  const ninetyDaysAgo = new Date(Date.now() - NINETY_DAY_WINDOW * 86_400_000);

  const [dbUser, manualMeasurements, medications, rollupCoverage] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: user.id },
        select: { heightCm: true, dateOfBirth: true },
      }),
      // WEIGHT + BP are manual entries (low volume, and BP needs exact-
      // timestamp pairing below for `bpPctInTarget`), so a bounded raw read
      // stays cheap. PULSE is excluded here — a continuously-synced wearable
      // account can carry 100k+ raw rows in the window; it reads through the
      // rollup tier below instead.
      prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: { in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] },
          measuredAt: { gte: ninetyDaysAgo },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        select: { type: true, value: true, measuredAt: true },
      }),
      prisma.medication.findMany({
        // v1.16.11 — as-needed (PRN) medications never surface a compliance
        // rate (no expected doses).
        where: {
          userId: user.id,
          active: true,
          asNeeded: false,
          ...TRACKED_INTAKE_WHERE,
        },
        include: {
          // Schedules through the shared compliance select so the configured
          // per-dose windows reach the engine like every other surface.
          schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
          // v1.16.3 — archived schedule eras for era-aware expected counts.
          scheduleRevisions: { orderBy: { validFrom: "asc" } },
          // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
          pauseEras: { select: { pausedAt: true, resumedAt: true } },
        },
      }),
      probeRollupCoverage(user.id),
    ]);

  // v1.28 perf — PULSE reads the DAY-rollup tier (read-swap; falls back to a
  // bounded per-day-grouped live read on a coverage miss) instead of pulling
  // every raw sample into JS. `pulseAvg30` / `pulseAnomalyCount` derive from
  // the resulting day-mean series, so a dense wearable account's anomaly
  // count reflects daily outliers rather than every noisy raw sample.
  const { points: pulseDayMeans } = await readDayMeanSeries(
    user.id,
    "PULSE",
    NINETY_DAY_WINDOW,
    new Date(),
    rollupCoverage,
  );
  const pulseData: DataPoint[] = pulseDayMeans.map((p) => ({
    date: new Date(`${p.day}T00:00:00.000Z`),
    value: p.mean,
  }));

  const byType = (t: MeasurementType): DataPoint[] =>
    manualMeasurements
      .filter((m) => m.type === t)
      .map((m) => ({ date: m.measuredAt, value: m.value }));

  const summaries: Partial<
    Record<MeasurementType, ReturnType<typeof summarize>>
  > = {};
  for (const t of [
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
  ] as MeasurementType[]) {
    const data = byType(t);
    if (data.length > 0) summaries[t] = summarize(data);
  }
  if (pulseData.length > 0) summaries.PULSE = summarize(pulseData);

  let bmi: number | null = null;
  if (dbUser?.heightCm && summaries.WEIGHT?.latest) {
    const heightM = dbUser.heightCm / 100;
    bmi = Math.round((summaries.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
  }

  let bpPctInTarget: number | null = null;
  const bpTargets = getBpTargets(dbUser?.dateOfBirth ?? null);
  if (bpTargets) {
    const sysData = byType("BLOOD_PRESSURE_SYS");
    const diaData = byType("BLOOD_PRESSURE_DIA");
    const pairs = pairByTimestamp(sysData, diaData, 5 * 60_000);
    if (pairs.length > 0) {
      // v1.4.16 A2 — one-sided ceiling semantics with hypotension
      // floor. See lib/analytics/bp-in-target.ts.
      const inTarget = pairs.filter((p) =>
        isBpReadingInTarget(p.a, p.b, bpTargets),
      ).length;
      bpPctInTarget = Math.round((inTarget / pairs.length) * 100);
    }
  }

  // Medication compliance for alert input — routed through the canonical
  // cadence-aware engine (`calculateCompliance`), the same single source of
  // truth the comprehensive insights, dashboard pillar, Coach snapshot and
  // doctor report use. The naive `schedules.length × days` denominator was a
  // #214 regression that falsely flagged weekly injectables and paused meds
  // as low-adherence on this user-facing alert path.
  const medicationCompliance: Array<{
    name: string;
    compliance7: number;
    compliance30: number;
  }> = [];
  // Single batched query — bucket by medicationId in JS (fix N+1).
  const activeMeds = medications.filter((m) => m.schedules.length > 0);
  if (activeMeds.length > 0) {
    const allEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        // v1.7.0 sync — exclude tombstoned rows.
        deletedAt: null,
        medicationId: { in: activeMeds.map((m) => m.id) },
        // 90-day window: the rolling-cadence gap-walk re-anchors on prior
        // intakes outside the 30-day rate window.
        scheduledFor: { gte: ninetyDaysAgo },
      },
      orderBy: { scheduledFor: "desc" },
      select: {
        medicationId: true,
        takenAt: true,
        skipped: true,
        scheduledFor: true,
      },
    });
    const eventsByMed = new Map<string, typeof allEvents>();
    for (const e of allEvents) {
      const arr = eventsByMed.get(e.medicationId) ?? [];
      arr.push(e);
      eventsByMed.set(e.medicationId, arr);
    }
    const tz = user.timezone || "Europe/Berlin";
    for (const med of activeMeds) {
      const events = eventsByMed.get(med.id) ?? [];
      const mapped = events.map((e) => ({
        takenAt: e.takenAt,
        skipped: e.skipped,
        scheduledFor: e.scheduledFor,
      }));
      // v1.7.0 SB-SCHED-2 — engine-routed denominator.
      const medicationContext = buildComplianceMedicationContext(
        med,
        lastNonSkippedTakenAt(mapped),
        tz,
      );
      const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt, {
        medicationContext,
      });
      const c30 = calculateCompliance(
        mapped,
        med.schedules,
        30,
        med.createdAt,
        {
          medicationContext,
        },
      );
      medicationCompliance.push({
        name: med.name,
        compliance7: c7.rate,
        compliance30: c30.rate,
      });
    }
  }

  const alerts = generateAlerts({
    bmi,
    bpAvgSys: summaries.BLOOD_PRESSURE_SYS?.avg30 ?? null,
    bpAvgDia: summaries.BLOOD_PRESSURE_DIA?.avg30 ?? null,
    bpPctInTarget,
    weightSlope30: summaries.WEIGHT?.slope30?.slope ?? null,
    pulseAvg30: summaries.PULSE?.avg30 ?? null,
    pulseAnomalyCount: summaries.PULSE?.anomalyCount ?? 0,
    medications: medicationCompliance,
  });

  // The rule engine wrote these, not a model.
  const provider = "rules";
  const generatedAt = new Date().toISOString();

  const cards: InsightCard[] = alerts.map((alert, idx) => ({
    id: `alert-${idx + 1}`,
    title: alert.title,
    summary: alert.message,
    body: null,
    severity: toSeverity(alert.level),
    recommendations: [],
    generatedAt,
    provider,
  }));

  return apiSuccess(cards);
});
