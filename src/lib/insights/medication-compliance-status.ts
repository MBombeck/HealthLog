import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import {
  getMedicationComplianceSystemPrompt,
  getMedicationComplianceUserPrompt,
} from "@/lib/ai/prompts/medication-compliance";
import { calculateCompliance } from "@/lib/analytics/compliance";
import { getMedicationCategories } from "@/lib/medication-category";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { getNoKeyMedicationComplianceStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { annotate } from "@/lib/logging/context";

// 360 daily days + 24 monthly windows ≈ 1080 days of intake history.
const COMPLIANCE_HISTORY_DAYS = 360 + 24 * 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const BERLIN_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type SupportedLocale = "de" | "en";

interface MedicationSummaryItem {
  medicationId: string;
  text: string;
}

function toBerlinDayKey(date: Date): string {
  const parts = BERLIN_DAY_FORMATTER.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Could not derive Berlin day key");
  }

  return `${year}-${month}-${day}`;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeSummaryText(value: string): string {
  return stripChartTokens(value).replace(/\s+/g, " ").trim();
}

function normalizeLocale(value: string | null | undefined): SupportedLocale {
  return value === "en" ? "en" : "de";
}

export async function generateMedicationComplianceStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  summary: string | null;
  medications: MedicationSummaryItem[];
  cached: boolean;
  updatedAt: string | null;
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const cacheAction = `insights.medication-compliance-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const provider = await resolveProvider(userId);
  if (provider.type === "none") {
    return {
      hasProvider: false,
      summary: getNoKeyMedicationComplianceStatusText(locale),
      medications: [],
      cached: true,
      updatedAt: null,
    };
  }

  const latestCache = await prisma.auditLog.findFirst({
    where: { userId, action: cacheAction },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });

  if (!force && latestCache?.details) {
    try {
      const parsed = JSON.parse(latestCache.details) as {
        dateKey?: string;
        summary?: string;
        medications?: MedicationSummaryItem[];
      };

      if (
        parsed.dateKey === todayKey &&
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
      updatedAt: latestCache?.createdAt.toISOString() ?? null,
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

  const medicationSnapshots = medications.map((medication) => {
    const events = medicationEvents.filter(
      (event) => event.medicationId === medication.id,
    );

    const compliance7 = calculateCompliance(
      events,
      medication.schedules,
      7,
      medication.createdAt,
    );
    const compliance30 = calculateCompliance(
      events,
      medication.schedules,
      30,
      medication.createdAt,
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

    const dailySeries = applyPayloadBudget(perDayRecords, { now });
    const latestDay = dailySeries.daily[0] ?? null;

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

  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: { payload_size_bytes: snapshotJson.length },
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

  const result = await provider.generateCompletion({
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

  const content = result.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(
      "AI returned empty content for medication-compliance-status",
    );
  }

  let summary = "";
  let medicationSummaries: MedicationSummaryItem[] = [];
  try {
    const parsed = JSON.parse(content) as {
      summary?: string;
      medications?: Array<{ medicationId?: string; summary?: string }>;
    };
    summary = typeof parsed.summary === "string" ? parsed.summary : content;

    const incomingMap = new Map<string, string>();
    for (const entry of parsed.medications ?? []) {
      if (
        typeof entry?.medicationId === "string" &&
        typeof entry?.summary === "string" &&
        entry.summary.trim().length > 0
      ) {
        incomingMap.set(entry.medicationId, entry.summary);
      }
    }

    medicationSummaries = medicationSnapshots.map((medication) => ({
      medicationId: medication.medicationId,
      text: normalizeSummaryText(
        incomingMap.get(medication.medicationId) ??
          (locale === "de"
            ? `${medication.name}: Es liegen noch nicht genügend konsistente Detaildaten für eine belastbare Kurzbewertung vor.`
            : `${medication.name}: There is currently not enough consistent detail data for a robust short assessment.`),
      ),
    }));
  } catch {
    summary = content;
    medicationSummaries = medicationSnapshots.map((medication) => ({
      medicationId: medication.medicationId,
      text:
        locale === "de"
          ? `${medication.name}: Die medikamentenspezifische Kurzbewertung konnte heute nicht separat aufbereitet werden.`
          : `${medication.name}: The medication-specific short assessment could not be prepared separately today.`,
    }));
  }

  summary = normalizeSummaryText(summary);
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
        providerType: provider.type,
        model: result.model ?? "unknown",
        tokensUsed: result.tokensUsed ?? null,
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
