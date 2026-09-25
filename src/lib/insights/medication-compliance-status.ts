import { prisma } from "@/lib/db";
import {
  getMedicationComplianceSystemPrompt,
  getMedicationComplianceUserPrompt,
} from "@/lib/ai/prompts/medication-compliance";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import type { Locale } from "@/lib/i18n/config";
import {
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  dailyComplianceRatesFromLedger,
  expectsDoses,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";
import { getMedicationCategories } from "@/lib/medication-category";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { getNoKeyMedicationComplianceStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import {
  buildAssessmentContextBlock,
  pickVarietyLead,
} from "@/lib/insights/assessment-context";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import { buildGradedSeriesFromPoints } from "@/lib/insights/graded-series";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import { degradeStatusSnapshotToBudget } from "@/lib/insights/graded-series";
import {
  type SupportedLocale,
  finalizeStatusSummary,
  normalizeLocale,
  normalizeSummaryText,
  round,
} from "@/lib/insights/status-shared";
import {
  readFreshStatusItems,
  refreshUnchangedStatusItems,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
  writeStatusNote,
} from "@/lib/insights/status-cache";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
} from "@/lib/insights/status-card-generation";
import { annotate } from "@/lib/logging/context";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

// 360 daily days + 24 monthly windows ≈ 1080 days of intake history.
const COMPLIANCE_HISTORY_DAYS = 360 + 24 * 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface MedicationSummaryItem {
  medicationId: string;
  text: string;
}

/** The stored per-medication lines, keeping only well-formed entries. */
function parseMedicationItems(items: unknown[]): MedicationSummaryItem[] {
  return items.filter(
    (entry): entry is MedicationSummaryItem =>
      typeof (entry as MedicationSummaryItem | null)?.medicationId ===
        "string" &&
      typeof (entry as MedicationSummaryItem | null)?.text === "string" &&
      (entry as MedicationSummaryItem).text.trim().length > 0,
  );
}

/**
 * The richer compliance result envelope (`summary` + per-medication
 * `medications`) the cards read — distinct from the standard `text`-only
 * status result. It flows through the shared `PreparedStatusCard` union via
 * the open index signature on `StatusCardResult`.
 */
interface MedicationComplianceResult {
  hasProvider: boolean;
  summary: string | null;
  medications: MedicationSummaryItem[];
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  revalidating?: boolean;
}

/**
 * Public entry — unchanged signature. Prepares the card then runs ONE
 * completion through the shared single-card path when the LLM is still
 * needed (v1.18.7 HIGH-1).
 */
export async function generateMedicationComplianceStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    readOnly?: boolean;
  },
): Promise<MedicationComplianceResult> {
  const prepared = await prepareMedicationComplianceStatusForUser(
    userId,
    options,
  );
  const result = await runPreparedStatusCard(prepared);
  return result as unknown as MedicationComplianceResult;
}

/**
 * v1.18.7 (HIGH-1) — everything up to (not including) the provider call.
 * Carries the richer `{ summary, medications }` result through the shared
 * prepare/run/finalize contract. See `status-card-generation.ts`.
 */
export async function prepareMedicationComplianceStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /** v1.8.3 — read-only navigation path; see weight-status for the rationale. */
    readOnly?: boolean;
  },
): Promise<PreparedStatusCard> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = statusCacheAction("medication-compliance", locale);
  // v1.30.3 (QA F5) — resolve the user's own tz BEFORE the day-key so the
  // cache rolls over at the user's local midnight, not Berlin's. Has to
  // happen ahead of the cache read below (the earliest possible return
  // path), not just the later day-bucketing reads.
  const userTz = await resolveUserTimezone(userId);
  const todayKey = userDayKey(new Date(), userTz);

  // This card stores per-medication lines next to its summary, so it reads
  // its note through the items variant of the shared reader.
  if (!force) {
    const cached = await readFreshStatusItems({
      userId,
      cacheAction,
      todayKey,
    });
    if (cached && Array.isArray(cached.items)) {
      return {
        phase: "served",
        result: {
          hasProvider: true,
          summary: cached.text,
          medications: parseMedicationItems(cached.items),
          cached: true,
          updatedAt: cached.updatedAt,
        },
      };
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
    // Unavailable for any reason: the deterministic line, no enqueue.
    // `hasProvider` is provider presence only.
    if (outcome.kind === "unavailable") {
      return {
        phase: "served",
        result: {
          hasProvider: outcome.hasProvider,
          summary: getNoKeyMedicationComplianceStatusText(locale),
          medications: [],
          cached: true,
          updatedAt: null,
        },
      };
    }
    // v1.8.7 — stale-while-revalidate: serve the last good narrative (if
    // any) while the worker re-warms; only show the empty preparing
    // skeleton when none was ever produced.
    return {
      phase: "served",
      result: {
        hasProvider: true,
        summary: outcome.lastGood?.text ?? null,
        medications: [],
        cached: outcome.lastGood !== null,
        updatedAt: outcome.lastGood?.updatedAt ?? null,
        preparing: outcome.lastGood === null,
        revalidating: outcome.revalidating,
      },
    };
  }

  const medicationRows = await prisma.medication.findMany({
    // v1.16.11 — as-needed (PRN) medications never surface a compliance
    // rate (no expected doses).
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    // v1.15.20 — schedules through the shared compliance select so the
    // configured per-dose windows reach this surface like every other.
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // v1.16.3 — archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
    orderBy: { name: "asc" },
  });

  // A medication with no schedule expects no dose, and `calculateCompliance`
  // answers 100 % for that case. The `asNeeded: false` filter above catches
  // only the PRN arm; the empty schedule is reachable on a scheduled
  // medication and would otherwise report perfect adherence.
  const medications = medicationRows.filter(expectsDoses);

  if (medications.length === 0) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        summary:
          locale === "de"
            ? "Aktuell sind keine aktiven Medikamente hinterlegt."
            : "There are currently no active medications configured.",
        medications: [],
        cached: true,
        updatedAt: null,
      },
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

  // v1.7.0 SB-SCHED-2 — the compliance-pillar denominators route through
  // the canonical engine on the user's own tz. `userTz` was already
  // resolved above for the cache day-key.

  const medicationSnapshots = medications.map((medication) => {
    const events = medicationEvents.filter(
      (event) => event.medicationId === medication.id,
    );

    const medicationContext = buildComplianceMedicationContext(
      medication,
      lastNonSkippedTakenAt(events),
      userTz,
    );
    // v1.18.0 — one shared cadence-aware expansion pass yields BOTH the
    // canonical compliance7 / compliance30 (the values shown in this same
    // snapshot) AND the unified dose-history ledger the per-day series is
    // built from, so the series can never disagree with compliance30.
    const bundle = buildMedicationComplianceBundle(
      events,
      medication.schedules,
      medicationContext,
      now,
    );
    const compliance7 = bundle.compliance7;
    const compliance30 = bundle.compliance30;

    // v1.18.0 — the per-day series honours the medication's cadence
    // (daysOfWeek + intervalWeeks + rolling / RRULE / cyclic): only days the
    // schedule actually expected a dose produce a point, and each day's rate
    // uses the SAME taken / (taken + missed) tally as compliance30. The old
    // path divided every event-day by `schedules.length`, treating every
    // calendar day as fully dose-due — which made a weekly-cadence med's
    // per-day series contradict its own compliance30. Reusing the canonical
    // ledger fixes that by construction.
    const perDayRecords = dailyComplianceRatesFromLedger(
      bundle.ledgerRows,
      userTz,
    ).map((day) => ({
      measuredAt: day.date,
      value: round(day.rate, 1),
    }));

    // `applyPayloadBudget` gives the latest-day focus; the compact
    // graded series is what reaches the prompt.
    const dailyBudgeted = applyPayloadBudget(perDayRecords, {
      now,
      tz: userTz,
    });
    const dailySeries = buildGradedSeriesFromPoints(perDayRecords, now);
    const latestDay = dailyBudgeted.daily[0] ?? null;

    // v1.18.10 (HIGH-4) — the finished recent-vs-baseline adherence comparison
    // + normal-swing verdict, computed from the canonical per-day rate series
    // so the model states the trend rather than deriving it. The compliance %
    // itself stays server-computed (compliance7/30 above); this adds only the
    // trend signal. Adherence reads higher-better; the band is 0–100%.
    const signal = buildMetricSignal({
      metric:
        locale === "en"
          ? `adherence for ${sanitizeForPrompt(medication.name)}`
          : `Einnahmetreue für ${sanitizeForPrompt(medication.name)}`,
      unit: "%",
      direction: "higher-better",
      graded: dailySeries,
      // Recency is surfaced separately via dataCoverage.newestMeasurementDaysAgo
      // (computed after this map); the per-med signal leaves it null.
      newestDaysAgo: null,
    });

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
      ...(signal ? { signal } : {}),
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

  // Content-hash gate (v1.16.8): when the snapshot is unchanged since the
  // last real assessment, refresh the cache timestamp and skip the LLM.
  // This card stores per-medication lines next to the summary, so it uses
  // the items variant of the shared gate.
  const snapshotHash = hashInsightSnapshot(snapshot);
  const unchanged = await refreshUnchangedStatusItems({
    userId,
    cacheAction,
    todayKey,
    snapshotHash,
  });
  if (unchanged && Array.isArray(unchanged.items)) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        summary: unchanged.text,
        medications: parseMedicationItems(unchanged.items),
        cached: true,
        updatedAt: unchanged.updatedAt,
      },
    };
  }

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

  // v1.12.7 — diversity / anti-repetition block (see blood-pressure-status).
  // Adherence spans multiple medications with no single card-level graded
  // mean to band, so the steady-run signal is left to the previous-context
  // comparison (repeatCount 0) and there is no measurement discovery channel
  // (relations empty); the variety lead + data-strength carry the rotation.
  const varietyLead = pickVarietyLead(
    userId,
    "medication-compliance",
    todayKey,
  );
  const assessmentContextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: medicationEvents.length,
        newestDaysAgo: newestMeasurementDaysAgo,
      },
      repeatCount: 0,
      relations: [],
    },
    locale,
  );

  // The per-medication placeholder rows the UI surfaces alongside the
  // model-authored overall `summary`. Computed here so both `finalize`
  // (success) reuses them; the model's compliance prompt returns only the
  // single `{ summary }` envelope.
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

  // The provider call is deferred to the caller — single-card path runs ONE
  // completion; the batch path folds this prompt into one shared call.
  return {
    phase: "pending",
    metric: "medication-compliance",
    userId,
    cacheAction,
    systemPrompt: getMedicationComplianceSystemPrompt(locale),
    userPrompt: getMedicationComplianceUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
      assessmentContextBlock,
      // v1.28.40 — rotating opener hint, per (user, metric, day).
      openerArchetypeHint(
        `${userId}:medication-compliance:${todayKey}`,
        locale as Locale,
      ),
    ),
    snapshotHash,
    // v1.12.7 — match the archetype cards' 0.45.
    temperature: 0.45,
    noProvider: {
      hasProvider: false,
      summary: getNoKeyMedicationComplianceStatusText(locale),
      medications: [],
      cached: true,
      updatedAt: null,
    },
    timeout: (reason) => {
      // Transient miss — write the short-TTL negative stub (so the read-only
      // route does not re-enqueue while the provider is degraded) and serve
      // the fallback for this render without persisting an assessment.
      returnTimeoutFallback({
        cacheAction,
        reason,
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
    },
    finalize: async (outcome) => {
      // The compliance prompt returns a single `{ summary }` envelope — it
      // does not emit per-medication text. The per-medication cards carry a
      // placeholder so the UI surfaces a row per active medication; the
      // overall `summary` is the model-authored assessment.
      //
      // v1.32.20 — route the completion through the shared status chokepoint,
      // so this card enforces the exact contracts its seven siblings do rather
      // than only withholding unparseable envelopes. `finalizeStatusSummary`
      // parses the `{ summary }` envelope, scrubs chart tokens + whitespace,
      // then SCREENS the prose against `INSIGHTS_CONTRACTS` (dose / risk /
      // causal). This is the highest-leverage surface for the outbound screen —
      // a medication card is exactly where a dose-change imperative or a
      // fabricated figure lands. WITHHOLD on any block or unparseable envelope:
      // serve the deterministic no-key line, write a short negative stub, and
      // persist no model text. The per-medication rows still render.
      const finalized = finalizeStatusSummary(outcome.content, locale);
      if (!finalized.ok) {
        annotate({
          action: { name: "insights.status.outbound_blocked" },
          meta: { cacheAction, reason: finalized.reason },
        });
        returnTimeoutFallback({
          cacheAction,
          reason: "screened",
          userId,
          todayKey,
          stubText: getNoKeyMedicationComplianceStatusText(locale),
        });
        return {
          hasProvider: true,
          summary: getNoKeyMedicationComplianceStatusText(locale),
          medications: medicationSummaries,
          cached: true,
          updatedAt: null,
        };
      }
      const summary = finalized.text;
      if (!summary) {
        throw new Error(
          "Medication-compliance-status summary was empty after normalization",
        );
      }
      const generatedAt = await writeStatusNote({
        userId,
        cacheAction,
        todayKey,
        text: summary,
        items: medicationSummaries,
        snapshotHash,
      });
      return {
        hasProvider: true,
        summary,
        medications: medicationSummaries,
        cached: false,
        updatedAt: generatedAt.toISOString(),
      };
    },
  };
}

export function resolveMedicationComplianceStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
