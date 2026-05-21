/**
 * GET /api/insights/cards — iOS adapter over `/api/insights/comprehensive`.
 *
 * Reuses the same data sources (measurements, mood, intake events) and the
 * shared `generateAlerts()` rule engine, then re-shapes each `HealthAlert`
 * to the iOS Insight model (id, title, summary, severity, recommendations,
 * provider).
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import {
  generateAlerts,
  type HealthAlert,
} from "@/lib/analytics/classifications";
import { pairByTimestamp } from "@/lib/analytics/correlations";
import type { MeasurementType } from "@/generated/prisma/client";

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
  const { user } = await requireAuth();
  // v1.4.31 — the iOS cards adapter feeds the same per-metric
  // insight surfaces the web `<InsightStatusCard>` mounts on each
  // /insights/<metric> sub-page. Both share the operator gate.
  await requireAssistantSurface("insightStatus");
  annotate({ action: { name: "insights.cards" } });

  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);

  const [dbUser, allMeasurements, medications] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { heightCm: true, dateOfBirth: true, aiProvider: true },
    }),
    prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: {
          in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE"],
        },
        measuredAt: { gte: ninetyDaysAgo },
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
      select: { type: true, value: true, measuredAt: true },
    }),
    prisma.medication.findMany({
      where: { userId: user.id, active: true },
      include: { schedules: true },
    }),
  ]);

  const byType = (t: MeasurementType): DataPoint[] =>
    allMeasurements
      .filter((m) => m.type === t)
      .map((m) => ({ date: m.measuredAt, value: m.value }));

  const summaries: Partial<
    Record<MeasurementType, ReturnType<typeof summarize>>
  > = {};
  for (const t of [
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "PULSE",
  ] as MeasurementType[]) {
    const data = byType(t);
    if (data.length > 0) summaries[t] = summarize(data);
  }

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

  // Lightweight medication compliance for alert input.
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
        medicationId: { in: activeMeds.map((m) => m.id) },
        scheduledFor: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
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
    const cutoff7 = Date.now() - 7 * 86_400_000;
    for (const med of activeMeds) {
      const events = eventsByMed.get(med.id) ?? [];
      const takenLast7 = events.filter(
        (e) =>
          e.takenAt !== null &&
          !e.skipped &&
          e.scheduledFor.getTime() >= cutoff7,
      ).length;
      const taken30 = events.filter(
        (e) => e.takenAt !== null && !e.skipped,
      ).length;
      const expected7 = med.schedules.length * 7;
      const expected30 = med.schedules.length * 30;
      medicationCompliance.push({
        name: med.name,
        compliance7:
          expected7 > 0 ? Math.round((takenLast7 / expected7) * 100) : 0,
        compliance30:
          expected30 > 0 ? Math.round((taken30 / expected30) * 100) : 0,
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
    pulseAnomalyCount: summaries.PULSE?.anomalyCount,
    medications: medicationCompliance,
  });

  const provider = dbUser?.aiProvider?.toLowerCase() ?? "claude";
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
