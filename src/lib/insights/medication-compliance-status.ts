import { prisma } from "@/lib/db";
import {
  getMedicationComplianceSystemPrompt,
  getMedicationComplianceUserPrompt,
} from "@/lib/ai/prompts/medication-compliance";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { getMedicationCategories } from "@/lib/medication-category";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { getNoKeyMedicationComplianceStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import { buildGradedSeriesFromPoints } from "@/lib/insights/graded-series";
import { degradeStatusSnapshotToBudget } from "@/lib/insights/graded-series";
import {
  type SupportedLocale,
  normalizeLocale,
  normalizeSummaryText,
  parseSummaryFromContent,
  round,
} from "@/lib/insights/status-shared";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import {
  isTimeoutStub,
  resolveReadOnlyStatusMiss,
} from "@/lib/insights/status-cache";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import { annotate } from "@/lib/logging/context";
import { toBerlinDayKey } from "@/lib/tz/resolver";

// 360 daily days + 24 monthly windows ≈ 1080 days of intake history.
const COMPLIANCE_HISTORY_DAYS = 360 + 24 * 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface MedicationSummaryItem {
  medicationId: string;
  text: string;
}

export async function generateMedicationComplianceStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /** v1.8.3 — read-only navigation path; see weight-status for the rationale. */
    readOnly?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  summary: string | null;
  medications: MedicationSummaryItem[];
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = `insights.medication-compliance-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  // This route carries a richer cached envelope (`summary` +
  // `medications`) than the standard `text`-only generators, so it
  // keeps its own cache-read — but it shares the stub-rejection
  // predicate so a timeout stub never sticks for the day.
  if (!force) {
    const latestCache = await prisma.auditLog.findFirst({
      where: { userId, action: cacheAction },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, details: true },
    });
    if (latestCache?.details) {
      try {
        const parsed = JSON.parse(latestCache.details) as {
          dateKey?: string;
          summary?: string;
          text?: string;
          model?: string;
          timeout?: boolean;
          medications?: MedicationSummaryItem[];
        };

        if (
          parsed.dateKey === todayKey &&
          !isTimeoutStub(parsed) &&
          typeof parsed.summary === "string" &&
          parsed.summary.trim().length > 0 &&
          Array.isArray(parsed.medications)
        ) {
          return {
            hasProvider: true,
            summary: parsed.summary,
            medications: parsed.medications.filter(
              (entry): entry is MedicationSummaryItem =>
                typeof entry?.medicationId === "string" &&
                typeof entry?.text === "string" &&
                entry.text.trim().length > 0,
            ),
            cached: true,
            updatedAt: latestCache.createdAt.toISOString(),
          };
        }
      } catch {
        // ignore invalid cache payload
      }
    }
  }

  // v1.8.3 — read-only navigation path: never block on the provider.
  // Enqueue generation out of band and return preparing / no-provider.
  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId,
      metric: "medication-compliance",
      locale,
    });
    if (outcome === "no-provider") {
      return {
        hasProvider: false,
        summary: getNoKeyMedicationComplianceStatusText(locale),
        medications: [],
        cached: true,
        updatedAt: null,
      };
    }
    return {
      hasProvider: true,
      summary: null,
      medications: [],
      cached: false,
      updatedAt: null,
      preparing: true,
    };
  }

  const medications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: { schedules: true },
    orderBy: { name: "asc" },
  });

  if (medications.length === 0) {
    return {
      hasProvider: true,
      summary:
        locale === "de"
          ? "Aktuell sind keine aktiven Medikamente hinterlegt."
          : "There are currently no active medications configured.",
      medications: [],
      cached: true,
      updatedAt: null,
    };
  }

  const categoryMap = await getMedicationCategories(
    medications.map((medication) => medication.id),
  );

  const now = new Date();
  // v1.4.6 widens the audit window to ~3 years so the bucketed payload
  // has both daily (last 360 days) and monthly (months 12-36) coverage.
  const rangeStart = new Date(
    now.getTime() - COMPLIANCE_HISTORY_DAYS * MS_PER_DAY,
  );

  const medicationEvents = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      // v1.7.0 sync — exclude tombstoned rows from compliance status.
      deletedAt: null,
      medicationId: { in: medications.map((medication) => medication.id) },
      scheduledFor: { gte: rangeStart },
    },
    orderBy: { scheduledFor: "asc" },
    select: {
      medicationId: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
    },
  });

  // v1.7.0 SB-SCHED-2 — resolve the user timezone once so the
  // compliance-pillar denominators route through the canonical engine.
  const userTz = await resolveUserTimezone(userId);

  const medicationSnapshots = medications.map((medication) => {
    const events = medicationEvents.filter(
      (event) => event.medicationId === medication.id,
    );

    const medicationContext = buildComplianceMedicationContext(
      medication,
      lastNonSkippedTakenAt(events),
      userTz,
    );
    const compliance7 = calculateCompliance(
      events,
      medication.schedules,
      7,
      medication.createdAt,
      { medicationContext },
    );
    const compliance30 = calculateCompliance(
      events,
      medication.schedules,
      30,
      medication.createdAt,
      { medicationContext },
    );

    // Collapse the events into one rate-per-day record, then run them
    // through the shared bucketing helper so the model receives the
    // canonical 360 daily + 24 monthly view per medication.
    const byDay = new Map<
      string,
      { expected: number; taken: number; skipped: number; date: Date }
    >();
    const expectedPerDay = Math.max(1, medication.schedules.length);

    for (const event of events) {
      const dayKey = toBerlinDayKey(event.scheduledFor);
      const bucket = byDay.get(dayKey) ?? {
        expected: medication.schedules.length,
        taken: 0,
        skipped: 0,
        date: event.scheduledFor,
      };
      if (event.takenAt && !event.skipped) bucket.taken += 1;
      if (event.skipped) bucket.skipped += 1;
      byDay.set(dayKey, bucket);
    }

    const perDayRecords = Array.from(byDay.values())
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((stats) => ({
        measuredAt: stats.date,
        value: round(Math.min(100, (stats.taken / expectedPerDay) * 100), 1),
      }));

    // `applyPayloadBudget` gives the latest-day focus; the compact
    // graded series is what reaches the prompt.
    const dailyBudgeted = applyPayloadBudget(perDayRecords, { now });
    const dailySeries = buildGradedSeriesFromPoints(perDayRecords, now);
    const latestDay = dailyBudgeted.daily[0] ?? null;

    return {
      medicationId: medication.id,
      name: sanitizeForPrompt(medication.name),
      dose: sanitizeForPrompt(medication.dose, 50),
      category: categoryMap[medication.id] ?? "OTHER",
      schedulesPerDay: medication.schedules.length,
      compliance7: compliance7.rate,
      compliance30: compliance30.rate,
      streak: compliance7.streak,
      taken7: compliance7.taken,
      skipped7: compliance7.skipped,
      missed7: compliance7.missed,
      dailySeries,
      latestDay,
    };
  });

  const avgCompliance30 =
    medicationSnapshots.length > 0
      ? round(
          medicationSnapshots.reduce(
            (sum, medication) => sum + medication.compliance30,
            0,
          ) / medicationSnapshots.length,
          1,
        )
      : null;

  const oldestEvent =
    medicationEvents.length > 0 ? medicationEvents[0].scheduledFor : null;
  const newestEvent =
    medicationEvents.length > 0
      ? medicationEvents[medicationEvents.length - 1].scheduledFor
      : null;
  const totalSpanDays =
    oldestEvent && newestEvent
      ? Math.round(
          (newestEvent.getTime() - oldestEvent.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestMeasurementDaysAgo = newestEvent
    ? Math.round((Date.now() - newestEvent.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: "medication_compliance",
    dataCoverage: {
      totalMeasurements: medicationEvents.length,
      totalSpanDays,
      newestMeasurementDaysAgo,
    },
    overall: {
      medicationCount: medicationSnapshots.length,
      averageCompliance30: avgCompliance30,
      averageCompliance7: round(
        medicationSnapshots.reduce(
          (sum, medication) => sum + medication.compliance7,
          0,
        ) / medicationSnapshots.length,
        1,
      ),
    },
    medications: medicationSnapshots,
  };

  const shed = degradeStatusSnapshotToBudget(
    snapshot as unknown as Record<string, unknown>,
  );
  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: {
      payload_size_bytes: snapshotJson.length,
      ...(shed.length > 0 ? { snapshot_shed: shed } : {}),
    },
  });

  const previousContext = await getPreviousInsightContext(
    userId,
    "medication-compliance-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  const outcome = await runStatusCompletion({
    userId,
    cacheAction,
    systemPrompt: getMedicationComplianceSystemPrompt(locale),
    userPrompt: getMedicationComplianceUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
    ),
    temperature: 0.3,
    maxTokens: 1000,
  });

  if (outcome.kind === "none") {
    return {
      hasProvider: false,
      summary: getNoKeyMedicationComplianceStatusText(locale),
      medications: [],
      cached: true,
      updatedAt: null,
    };
  }
  if (outcome.kind === "timeout" || outcome.kind === "error") {
    // Transient miss — serve the fallback for this render without
    // persisting it, so the next mount re-attempts a real generation.
    returnTimeoutFallback({
      cacheAction,
      reason: outcome.kind,
      userId,
      todayKey,
      stubText: getNoKeyMedicationComplianceStatusText(locale),
    });
    return {
      hasProvider: true,
      summary: getNoKeyMedicationComplianceStatusText(locale),
      medications: [],
      cached: true,
      updatedAt: null,
    };
  }

  // The compliance prompt returns a single `{ summary }` envelope — it
  // does not emit per-medication text. The per-medication cards carry a
  // placeholder so the UI surfaces a row per active medication; the
  // overall `summary` is the model-authored assessment.
  const summary = normalizeSummaryText(parseSummaryFromContent(outcome.content));
  const medicationSummaries: MedicationSummaryItem[] = medicationSnapshots.map(
    (medication) => ({
      medicationId: medication.medicationId,
      text: normalizeSummaryText(
        locale === "de"
          ? `${medication.name}: Es liegen noch nicht genügend konsistente Detaildaten für eine belastbare Kurzbewertung vor.`
          : `${medication.name}: There is currently not enough consistent detail data for a robust short assessment.`,
      ),
    }),
  );

  if (!summary) {
    throw new Error(
      "Medication-compliance-status summary was empty after normalization",
    );
  }

  const created = await prisma.auditLog.create({
    data: {
      userId,
      action: cacheAction,
      details: JSON.stringify({
        dateKey: todayKey,
        locale,
        summary,
        medications: medicationSummaries,
        providerType: outcome.providerType,
        model: outcome.model,
        tokensUsed: outcome.tokensUsed,
      }),
    },
    select: { createdAt: true },
  });

  return {
    hasProvider: true,
    summary,
    medications: medicationSummaries,
    cached: false,
    updatedAt: created.createdAt.toISOString(),
  };
}

export function resolveMedicationComplianceStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
