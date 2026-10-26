import { prisma } from "@/lib/db";
import {
  getMedicationComplianceSystemPrompt,
  getMedicationComplianceUserPrompt,
} from "@/lib/ai/prompts/medication-compliance";
import {
  buildComplianceMedicationContext,
  COURSES_COMPLIANCE_SELECT,
  buildMedicationComplianceBundle,
  dailyComplianceRatesFromLedger,
  expectsDoses,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import { getMedicationCategories } from "@/lib/medication-category";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { getNoKeyMedicationComplianceStatusText } from "@/lib/insights/no-key-fallbacks";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import { buildGradedSeriesFromPoints } from "@/lib/insights/graded-series";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import {
  normalizeSummaryText,
  round,
  type SupportedLocale,
} from "@/lib/insights/status-shared";
import {
  readFreshStatusItems,
  refreshUnchangedStatusItems,
  writeStatusNote,
} from "@/lib/insights/status-cache";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
} from "@/lib/insights/status-card-generation";
import {
  coverageSpan,
  prepareStatusCard,
  type ServedBuild,
  type StatusCardBuild,
  type StatusCardContext,
  type StatusCardOptions,
  type StatusCardPlugin,
  type StatusNoteCodec,
} from "@/lib/insights/status-pipeline";
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
type MedicationComplianceResult = {
  hasProvider: boolean;
  summary: string | null;
  medications: MedicationSummaryItem[];
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  revalidating?: boolean;
};

/**
 * Public entry — unchanged signature. Prepares the card then runs ONE
 * completion through the shared single-card path when the LLM is still
 * needed (v1.18.7 HIGH-1).
 */
export async function generateMedicationComplianceStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<MedicationComplianceResult> {
  const prepared = await prepareMedicationComplianceStatusForUser(
    userId,
    options,
  );
  const result = await runPreparedStatusCard(prepared);
  return result as unknown as MedicationComplianceResult;
}

/**
 * Everything up to (not including) the provider call, through the shared
 * status pipeline (`status-pipeline.ts`). Carries the richer
 * `{ summary, medications }` result through its own note codec.
 */
export function prepareMedicationComplianceStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<PreparedStatusCard> {
  return prepareStatusCard(MEDICATION_COMPLIANCE_STATUS_CARD, userId, options);
}

/**
 * This card stores per-medication lines next to its summary, so it reads and
 * re-dates its note through the items variants of the shared readers, and
 * its result carries the lines as `medications`.
 */
const medicationComplianceCodec: StatusNoteCodec<
  MedicationComplianceResult,
  MedicationSummaryItem[]
> = {
  async readFresh(ctx) {
    if (ctx.force) return null;
    const cached = await readFreshStatusItems({
      userId: ctx.userId,
      cacheAction: ctx.cacheAction,
      todayKey: ctx.todayKey,
    });
    if (!cached || !Array.isArray(cached.items)) return null;
    return {
      hasProvider: true,
      summary: cached.text,
      medications: parseMedicationItems(cached.items),
      cached: true,
      updatedAt: cached.updatedAt,
    };
  },
  async refreshUnchanged(ctx, snapshotHash) {
    const unchanged = await refreshUnchangedStatusItems({
      userId: ctx.userId,
      cacheAction: ctx.cacheAction,
      todayKey: ctx.todayKey,
      snapshotHash,
    });
    if (!unchanged || !Array.isArray(unchanged.items)) return null;
    return {
      hasProvider: true,
      summary: unchanged.text,
      medications: parseMedicationItems(unchanged.items),
      cached: true,
      updatedAt: unchanged.updatedAt,
    };
  },
  readOnly(outcome, unavailableText) {
    // Unavailable for any reason: the deterministic line, no enqueue.
    // `hasProvider` is provider presence only.
    if (outcome.kind === "unavailable") {
      return {
        hasProvider: outcome.hasProvider,
        summary: unavailableText,
        medications: [],
        cached: true,
        updatedAt: null,
      };
    }
    // Stale-while-revalidate: serve the last good narrative (if any) while
    // the worker re-warms; only show the empty preparing skeleton when none
    // was ever produced.
    return {
      hasProvider: true,
      summary: outcome.lastGood?.text ?? null,
      medications: [],
      cached: outcome.lastGood !== null,
      updatedAt: outcome.lastGood?.updatedAt ?? null,
      preparing: outcome.lastGood === null,
      revalidating: outcome.revalidating,
    };
  },
  noProvider(text) {
    return {
      hasProvider: false,
      summary: text,
      medications: [],
      cached: true,
      updatedAt: null,
    };
  },
  fallback(ctx, reason, stubText, medicationSummaries) {
    // Transient miss or a withheld reply — write the short-TTL negative stub
    // (so the read-only route does not re-enqueue while the provider is
    // degraded) and serve the fallback for this render without persisting an
    // assessment. A withheld reply still renders the per-medication rows.
    returnTimeoutFallback({
      cacheAction: ctx.cacheAction,
      reason,
      userId: ctx.userId,
      todayKey: ctx.todayKey,
      stubText,
    });
    return {
      hasProvider: true,
      summary: stubText,
      medications: reason === "screened" ? medicationSummaries : [],
      cached: true,
      updatedAt: null,
    };
  },
  async persist(ctx, summary, hashes, medicationSummaries) {
    // The compliance prompt returns a single `{ summary }` envelope — it
    // does not emit per-medication text. The per-medication cards carry a
    // placeholder so the UI surfaces a row per active medication; the
    // overall `summary` is the model-authored assessment.
    const generatedAt = await writeStatusNote({
      userId: ctx.userId,
      cacheAction: ctx.cacheAction,
      todayKey: ctx.todayKey,
      text: summary,
      items: medicationSummaries,
      snapshotHash: hashes.snapshotHash,
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

type ComplianceMedication = Awaited<
  ReturnType<typeof readComplianceMedications>
>[number];
type ComplianceIntakeEvent = {
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
};

/**
 * The adherence snapshot: one block per active, scheduled medication with
 * its compliance, streak and per-day series, and the overall averages.
 */
async function buildMedicationComplianceSnapshot(
  ctx: StatusCardContext,
): Promise<
  | StatusCardBuild<MedicationSummaryItem[]>
  | ServedBuild<MedicationComplianceResult>
> {
  const { userId, locale, userTz, todayKey } = ctx;
  const medications = await readComplianceMedications(userId);

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
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    select: {
      medicationId: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
    },
  });

  // v1.7.0 — the compliance-pillar denominators route through
  // the canonical engine on the user's own tz. `userTz` was already
  // resolved above for the cache day-key.

  const medicationSnapshots = medications.map((medication) =>
    medicationSnapshot({
      medication,
      medicationEvents,
      categoryMap,
      now,
      userTz,
      locale,
    }),
  );

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

  const { totalSpanDays, newestDaysAgo: newestMeasurementDaysAgo } =
    coverageSpan(
      medicationEvents.length > 0 ? medicationEvents[0].scheduledFor : null,
      medicationEvents.length > 0
        ? medicationEvents[medicationEvents.length - 1].scheduledFor
        : null,
    );

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

  return {
    snapshot,
    finish: () => ({
      // Adherence spans multiple medications with no single card-level graded
      // mean to band, so the steady-run signal is left to the previous-context
      // comparison (repeatCount 0) and there is no measurement discovery
      // channel (relations empty); the variety lead + data-strength carry the
      // rotation.
      context: {
        repeatCount: 0,
        points: medicationEvents.length,
        newestDaysAgo: newestMeasurementDaysAgo,
        relationsFor: null,
      },
      fallbackText: getNoKeyMedicationComplianceStatusText(locale),
      prompts: (snapshotJson, context) => ({
        systemPrompt: getMedicationComplianceSystemPrompt(locale),
        userPrompt: getMedicationComplianceUserPrompt(
          snapshotJson,
          todayKey,
          locale,
          context.previousContextBlock,
          context.assessmentContextBlock,
          context.openerHint,
        ),
      }),
      detail: medicationPlaceholderLines(medicationSnapshots, locale),
    }),
  };
}

/** The active, scheduled medications whose adherence the card reports. */
async function readComplianceMedications(userId: string) {
  const medicationRows = await prisma.medication.findMany({
    // v1.16.11 — as-needed (PRN) medications never surface a compliance
    // rate (no expected doses).
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    // v1.15.20 — schedules through the shared compliance select so the
    // configured per-dose windows reach this surface like every other.
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // v1.16.3 — archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: [{ validFrom: "asc" }, { id: "asc" }] },
      // v1.25 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
      // v1.40 (#1024) — the courses, so a gap between two expects nothing.
      courses: COURSES_COMPLIANCE_SELECT,
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });

  // A medication with no schedule expects no dose, and `calculateCompliance`
  // answers 100 % for that case. The `asNeeded: false` filter above catches
  // only the PRN arm; the empty schedule is reachable on a scheduled
  // medication and would otherwise report perfect adherence.
  return medicationRows.filter(expectsDoses);
}

/** One medication's block in the adherence snapshot. */
function medicationSnapshot(args: {
  medication: ComplianceMedication;
  medicationEvents: ComplianceIntakeEvent[];
  categoryMap: Record<string, string>;
  now: Date;
  userTz: string;
  locale: SupportedLocale;
}) {
  const { medication, medicationEvents, categoryMap, now, userTz, locale } =
    args;
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
  const dailySeries = buildGradedSeriesFromPoints(perDayRecords, now, userTz);
  const latestDay = dailyBudgeted.daily[0] ?? null;

  // v1.18.10 — the finished recent-vs-baseline adherence comparison
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
}

/**
 * The per-medication placeholder rows the UI surfaces alongside the
 * model-authored overall `summary`; the model's compliance prompt returns
 * only the single `{ summary }` envelope.
 */
function medicationPlaceholderLines(
  medicationSnapshots: ReadonlyArray<{ medicationId: string; name: string }>,
  locale: SupportedLocale,
): MedicationSummaryItem[] {
  return medicationSnapshots.map((medication) => ({
    medicationId: medication.medicationId,
    text: normalizeSummaryText(
      locale === "de"
        ? `${medication.name}: Es liegen noch nicht genügend konsistente Detaildaten für eine belastbare Kurzbewertung vor.`
        : `${medication.name}: There is currently not enough consistent detail data for a robust short assessment.`,
    ),
  }));
}

const MEDICATION_COMPLIANCE_STATUS_CARD: StatusCardPlugin<
  MedicationComplianceResult,
  MedicationSummaryItem[]
> = {
  scope: "medication-compliance",
  codec: medicationComplianceCodec,
  unavailableText: (locale) => getNoKeyMedicationComplianceStatusText(locale),
  emptyMessage:
    "Medication-compliance-status summary was empty after normalization",
  build: buildMedicationComplianceSnapshot,
};
