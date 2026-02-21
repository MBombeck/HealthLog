import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { calculateCompliance } from "@/lib/analytics/compliance";
import { getMedicationCategories } from "@/lib/medication-category";
import { getNoKeyMedicationComplianceStatusText } from "@/lib/insights/no-key-fallbacks";

const MEDICATION_COMPLIANCE_STATUS_MODEL = "gpt-4o-mini";
const MEDICATION_COMPLIANCE_STATUS_POINTS = 30;

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
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLocale(value: string | null | undefined): SupportedLocale {
  return value === "en" ? "en" : "de";
}

function getSystemPrompt(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "You are a health trend analyst for a private personal project.",
      "Generate medication adherence insights from the provided data only.",
      "Return one overall section summary with about 7 sentences and one per-medication summary with 3-4 sentences each.",
      "Use only the latest 30 daily points and prioritize the latest day for each medication.",
      "Account for medication name, category, dose strength, and adherence details in your interpretation.",
      "Weight findings by importance: persistent misses and low adherence should be emphasized much more than minor variance.",
      "If fewer than 5 data points exist, state that insufficient data is available for a qualified assessment. If data is sparse over a long period, still derive rough trends but note limited reliability. If the newest measurement is more than 7 days old, mention the data may not be current.",
      "Do not include warnings, disclaimers, or references to AI/model limitations.",
      'Return valid JSON only: {"summary":"...","medications":[{"medicationId":"...","summary":"..."}]}',
    ].join(" ");
  }

  return [
    "Du bist ein Gesundheits-Trendanalyst für ein privates Projekt.",
    "Erzeuge Einschätzungen zur Medikamenteneinnahmetreue ausschließlich aus den bereitgestellten Daten.",
    "Gib eine Gesamtzusammenfassung mit ungefähr 7 Sätzen und pro Medikament eine Zusammenfassung mit 3-4 Sätzen zurück.",
    "Nutze nur die letzten 30 Tagesmesspunkte und priorisiere je Medikament den neuesten Tag.",
    "Berücksichtige in der Interpretation Medikamentenname, Kategorie, Dosisstärke und Einnahmedetails.",
    "Gewichte Aussagen nach Wichtigkeit: dauerhafte Ausfälle und niedrige Treue sollen deutlich stärker betont werden als kleine Schwankungen.",
    "Wenn weniger als 5 Messpunkte vorliegen, sage dass noch nicht genügend Daten für eine fundierte Aussage vorhanden sind. Bei spärlichen Daten über einen langen Zeitraum leite trotzdem grobe Trends ab, weise aber auf eingeschränkte Belastbarkeit hin. Wenn die neueste Messung älter als 7 Tage ist, erwähne dass die Daten möglicherweise nicht aktuell sind.",
    "Keine Warnhinweise, keine Haftungsausschlüsse, keine Hinweise auf KI oder Modellgrenzen.",
    'Gib nur valides JSON zurück: {"summary":"...","medications":[{"medicationId":"...","summary":"..."}]}',
  ].join(" ");
}

function getUserPrompt(
  locale: SupportedLocale,
  snapshotJson: string,
  todayKey: string,
): string {
  if (locale === "en") {
    return [
      `Date: ${todayKey} (Europe/Berlin)`,
      `Use the latest ${MEDICATION_COMPLIANCE_STATUS_POINTS} daily points as provided per medication.`,
      "If a day contains multiple events, they are already aggregated.",
      "Generate one overall medication-compliance summary and one summary per medication.",
      "",
      snapshotJson,
    ].join("\n");
  }

  return [
    `Datum: ${todayKey} (Europe/Berlin)`,
    `Nutze die letzten ${MEDICATION_COMPLIANCE_STATUS_POINTS} Tagesmesspunkte pro Medikament wie bereitgestellt.`,
    "Mehrere Ereignisse pro Tag sind bereits aggregiert.",
    "Erzeuge eine Gesamtzusammenfassung zur Medikamentencompliance und je Medikament eine eigene Zusammenfassung.",
    "",
    snapshotJson,
  ].join("\n");
}

export async function generateMedicationComplianceStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
  },
): Promise<{
  hasKey: boolean;
  summary: string | null;
  medications: MedicationSummaryItem[];
  cached: boolean;
  updatedAt: string | null;
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const cacheAction = `insights.medication-compliance-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      openaiKeyEncrypted: true,
    },
  });

  if (!user?.openaiKeyEncrypted) {
    return {
      hasKey: false,
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
          hasKey: true,
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
      hasKey: true,
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
  const rangeStart = new Date(
    now.getTime() - MEDICATION_COMPLIANCE_STATUS_POINTS * 24 * 60 * 60 * 1000,
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

    const byDay = new Map<
      string,
      { expected: number; taken: number; skipped: number }
    >();
    for (
      let dayOffset = 0;
      dayOffset < MEDICATION_COMPLIANCE_STATUS_POINTS;
      dayOffset++
    ) {
      const dayDate = new Date(
        now.getTime() -
          (MEDICATION_COMPLIANCE_STATUS_POINTS - 1 - dayOffset) *
            24 *
            60 *
            60 *
            1000,
      );
      const dayKey = toBerlinDayKey(dayDate);
      byDay.set(dayKey, {
        expected: medication.schedules.length,
        taken: 0,
        skipped: 0,
      });
    }

    for (const event of events) {
      const dayKey = toBerlinDayKey(event.scheduledFor);
      const bucket = byDay.get(dayKey);
      if (!bucket) continue;
      if (event.takenAt && !event.skipped) bucket.taken += 1;
      if (event.skipped) bucket.skipped += 1;
    }

    const dailySeries = Array.from(byDay.entries()).map(([day, stats]) => {
      const expected = Math.max(1, stats.expected);
      return {
        day,
        expected: stats.expected,
        taken: stats.taken,
        skipped: stats.skipped,
        missed: Math.max(0, stats.expected - stats.taken - stats.skipped),
        rate: round(Math.min(100, (stats.taken / expected) * 100), 1),
      };
    });

    return {
      medicationId: medication.id,
      name: medication.name,
      dose: medication.dose,
      category: categoryMap[medication.id] ?? "OTHER",
      schedulesPerDay: medication.schedules.length,
      compliance7: compliance7.rate,
      compliance30: compliance30.rate,
      streak: compliance7.streak,
      taken7: compliance7.taken,
      skipped7: compliance7.skipped,
      missed7: compliance7.missed,
      dailySeries,
      latestDay: dailySeries.at(-1) ?? null,
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
    medicationEvents.length > 0
      ? medicationEvents[0].scheduledFor
      : null;
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
    ? Math.round(
        (Date.now() - newestEvent.getTime()) / (24 * 60 * 60 * 1000),
      )
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
  const apiKey = decrypt(user.openaiKeyEncrypted);

  const openaiResponse = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MEDICATION_COMPLIANCE_STATUS_MODEL,
        messages: [
          { role: "system", content: getSystemPrompt(locale) },
          {
            role: "user",
            content: getUserPrompt(locale, snapshotJson, todayKey),
          },
        ],
        temperature: 0.3,
        max_tokens: 900,
        response_format: { type: "json_object" },
      }),
    },
  );

  if (!openaiResponse.ok) {
    const body = await openaiResponse.text();
    throw new Error(
      `OpenAI medication-compliance-status failed (${openaiResponse.status}): ${body}`,
    );
  }

  const openaiJson = await openaiResponse.json();
  const content = openaiJson.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(
      "OpenAI returned empty content for medication-compliance-status",
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
        model: MEDICATION_COMPLIANCE_STATUS_MODEL,
        pointsPerMetric: MEDICATION_COMPLIANCE_STATUS_POINTS,
        tokensUsed: openaiJson.usage?.total_tokens ?? null,
      }),
    },
    select: { createdAt: true },
  });

  return {
    hasKey: true,
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
