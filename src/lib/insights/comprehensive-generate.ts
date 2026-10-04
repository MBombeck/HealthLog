/**
 * v1.7.0 W6 — shared comprehensive-insight generator.
 *
 * The on-demand `POST /api/insights/generate` route and the nightly
 * `insight-pregenerate` cron both need to run the same pipeline:
 * resolve the provider chain → extract + compact features → build the
 * strict prompt → run the completion with fallback → parse + cache the
 * result. This module is that single source of truth so the briefing
 * the cron pre-generates is byte-identical to what an on-demand
 * regenerate would have produced.
 *
 * The route keeps its request-specific concerns (rate-limit gate,
 * locale resolution from the request, audit-with-IP). The cron supplies
 * its own budget gate (a per-user rate-limit bucket so a nightly
 * fan-out across every user can never blow the LLM budget) before
 * calling `generateComprehensiveInsight`.
 *
 * NO synchronous request lifecycle: the cron path runs entirely on
 * pg-boss, never inside an HTTP handler.
 */
import pLimit from "p-limit";
import { prisma } from "@/lib/db";
import {
  extractFeatures,
  FeaturesPayloadTooLargeError,
  BRIEFING_FEATURE_WINDOW_DAYS,
  type SignalOfDay,
  type AggregatedFeatures,
} from "@/lib/insights/features";
import {
  findUngroundedBriefingNumbers,
  readBriefingBlock,
  buildBriefingGroundingCorrection,
} from "@/lib/ai/briefing-grounding";
import { screenInsightPayloadProse } from "@/lib/ai/safety/insight-payload-screen";
import { computeCitationCoverage } from "@/lib/ai/citation-coverage";
import { applyInsightsExcludeFilter } from "@/lib/insights/exclude-filter";
import { getCachedFeatures } from "@/lib/insights/feature-cache";
import {
  buildBriefingIllnessCycleContext,
  buildBriefingIllnessCyclePrompt,
} from "@/lib/insights/illness-cycle-briefing";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import { featuresInReaderUnits } from "@/lib/insights/features-units";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getReadingTransform,
  resolveUnitPreferences,
} from "@/lib/measurements/display-transform";
import {
  detectGlp1Plateau,
  buildGlp1PlateauPrompt,
} from "@/lib/insights/glp1-plateau";
import {
  buildUserPrompt,
  type ComparisonSnapshot,
} from "@/lib/ai/prompts/insight-system-prompt";
import {
  buildSystemPromptWithReferences,
  buildBriefingPersonalisationBlock,
} from "@/lib/ai/prompts/insight-generator";
import { buildRetryCorrectionMessage } from "@/lib/ai/retry-correction";
import {
  buildAboutMeInsightBlock,
  getSelfContextTextForUser,
} from "@/lib/ai/coach/about-me";
import { metricsFromPresentSections } from "@/lib/ai/medical-references";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  resolveDashboardLayout,
  type ComparisonBaseline,
} from "@/lib/dashboard-layout";
import type { MeasurementType, Prisma } from "@/generated/prisma/client";
import { Prisma as PrismaSql } from "@/generated/prisma/client";
import { dayWeightedRowsSql, windowMeanSql } from "@/lib/measurements/day-mean";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import { AllProvidersFailedError } from "@/lib/ai/provider-runner";
import {
  BriefingBudgetExceededError,
  runBriefingCompletion,
} from "@/lib/insights/briefing-provider";
import { aiCapabilityForRecord } from "@/lib/ai/capabilities/gate";
import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import {
  stripJsonFences,
  type SupportedLocale,
} from "@/lib/insights/status-shared";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { annotate } from "@/lib/logging/context";
import { AI_BUDGETS, resolveInsightsMaxTokens } from "@/lib/ai/ai-budgets";
import { resolveEffectiveTimeoutMs } from "@/lib/ai/effective-timeout";
import { recordBriefingFailure } from "@/lib/insights/briefing-failure-marker";
import { cachedPayloadCarriesBriefing } from "@/lib/insights/briefing-payload";

// Scope invalidation + refill moved to a sibling module; re-exported so
// every existing call site keeps importing from here.
export * from "@/lib/insights/status-invalidation";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_DOWNGRADE_TOKENS: ReadonlyArray<string> = [
  "anthropometrics",
  "medications",
  "compliance",
  "sleep",
  "steps",
  "hrv",
  "resting_hr",
];

export type GenerateOutcome =
  | { status: "cached" }
  | { status: "generated"; providerType: string }
  /**
   * v1.16.8 — the content-hash gate found the compacted feature snapshot
   * unchanged since the cached text was generated. No provider call was
   * made; only `insightsCachedAt` was refreshed so the freshness windows
   * (GET read, nightly discovery) treat the cache as current.
   */
  | { status: "unchanged" }
  /**
   * v1.18.7 — the snapshot was unchanged (findings byte-stable) but the
   * daily-briefing PARAGRAPH was re-rolled at a higher, seedless
   * temperature for phrasing variety. At most one re-roll per calendar day.
   */
  | { status: "rerolled"; providerType: string }
  /**
   * `budget` — the day's token ceiling refused the reservation, so no
   * provider was contacted. Grouped with the other `skipped` reasons rather
   * than with `failed` on purpose: there is no upstream fault to retry
   * against, so the caller must not enqueue the provider-failure retry.
   */
  /**
   * `scope-changed` — the guarded cache commit matched no User row. The guard
   * includes both privacy mode and the User `updatedAt` version, so a miss only
   * proves that some generation scope/version changed in flight. It cannot
   * safely name privacy mode, profile scope, or another User mutation as the
   * cause. No stale output is written.
   */
  | {
      status: "skipped";
      reason:
        /** The `briefing` capability is unavailable for another reason. */
        | "unavailable"
        | "no-provider"
        | "no-consent"
        | "budget"
        | "scope-changed"
        | "profile-scope-changed";
    }
  | { status: "failed"; reason: string };

/** Higher, seedless temperature for the daily-briefing phrasing re-roll. */
const BRIEFING_REROLL_TEMPERATURE = 0.6;

/** UTC YYYY-MM-DD calendar-day key gating the once-per-day briefing re-roll. */
function buildRerollDateKey(at: Date = new Date()): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: internal once-per-day re-roll gate key, never shown
  return at.toISOString().slice(0, 10);
}

/**
 * Re-roll ONLY the daily-briefing paragraph on a hash-unchanged hit.
 *
 * Runs the same comprehensive prompt at a higher, seedless temperature, then
 * keeps the cached payload verbatim and swaps in just the freshly-generated
 * `dailyBriefing.paragraph`. So the structured findings stay byte-stable
 * (reference assessments, monotony is fine) while the prose the user reads at
 * the top of /insights varies day-over-day. Returns null on any miss (no
 * provider success, invalid JSON, no cached/new paragraph) so the caller
 * falls back to the plain timestamp refresh.
 */
async function rerollBriefingParagraph(args: {
  userId: string;
  chain: Awaited<ReturnType<typeof resolveProviderChain>>;
  systemPrompt: string;
  userPrompt: string;
  cachedText: string;
  locale: SupportedLocale;
  /**
   * v1.18.10 (MEDIUM-3) — the pre-computed signals the briefing must match.
   * The reroll runs at a higher, seedless temperature for phrasing variety,
   * which is exactly the path most prone to drifting a restated number; the
   * fresh paragraph is rejected (caller keeps the cached one) when a number in
   * it does not trace to one of these figures.
   */
  signals: readonly SignalOfDay[] | null;
  /**
   * v1.22 (W6, W8 seam) — the full feature snapshot so the grounding gate also
   * admits numbers from the W8 aggregate blocks (glucose / labs / preventive-
   * care / workouts) the reroll may now cite.
   */
  features?: AggregatedFeatures | null;
  /**
   * The comparison snapshot the SAME `userPrompt` carries as its own section.
   * The gate walks it for authoritative figures too, so a rerolled paragraph
   * may narrate the comparison the prompt asked it to narrate.
   */
  comparison?: unknown;
  /**
   * The upstream provider timeout for this re-roll, resolved from the user's
   * response-timeout setting (falling back to the comprehensive budget). The
   * caller resolves it once and threads it in so the re-roll honours the same
   * slow-backend allowance the main generation does.
   */
  effectiveTimeoutMs: number;
}): Promise<{ text: string; providerType: string } | null> {
  let cached: Record<string, unknown>;
  try {
    cached = JSON.parse(args.cachedText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const cachedBriefing = cached.dailyBriefing;
  // Nothing to re-roll when the cached payload carries no briefing paragraph.
  if (
    cachedBriefing === null ||
    typeof cachedBriefing !== "object" ||
    typeof (cachedBriefing as { paragraph?: unknown }).paragraph !== "string"
  ) {
    return null;
  }

  let result;
  let providerType: string;
  try {
    const fallback = await runBriefingCompletion({
      userId: args.userId,
      chain: args.chain,
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      // Seedless on purpose: the seed would pin the same phrasing, which is
      // exactly what we are varying. Higher temperature for prose variety.
      temperature: BRIEFING_REROLL_TEMPERATURE,
      maxTokens: resolveInsightsMaxTokens(),
      // v1.21.5 — wider upstream budget so the reasoning-heavy briefing
      // generation is not clipped at the client's 60 s default mid-stream.
      // v1.25 — honours the per-user response-timeout setting (see caller).
      timeoutMs: args.effectiveTimeoutMs,
      stage: "reroll",
    });
    result = fallback.result;
    providerType = fallback.workingProvider.providerType;
  } catch {
    // Includes `BriefingBudgetExceededError`: a user at the day's ceiling
    // simply does not get the phrasing re-roll. The caller falls through to
    // the plain timestamp refresh and keeps the cached paragraph.
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonFences(result.content)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const freshBriefing = parsed.dailyBriefing;
  const freshParagraph =
    freshBriefing && typeof freshBriefing === "object"
      ? (freshBriefing as { paragraph?: unknown }).paragraph
      : undefined;
  if (
    typeof freshParagraph !== "string" ||
    freshParagraph.trim().length === 0
  ) {
    return null;
  }

  // v1.18.10 (MEDIUM-3) — grounding gate on the rerolled paragraph. The higher
  // seedless temperature can drift a restated figure ("+1.2 kg" → "+1.3 kg");
  // reject the reroll on any ungrounded number so the caller keeps the cached
  // (already-grounded) paragraph rather than swapping in a fabricated one.
  const rerollUngrounded = findUngroundedBriefingNumbers(
    { paragraph: freshParagraph },
    args.signals,
    args.features,
    args.comparison,
  );
  if (rerollUngrounded.length > 0) {
    return null;
  }

  // Keep the cached payload verbatim; swap in only the fresh paragraph.
  const mergedBriefing = {
    ...(cachedBriefing as Record<string, unknown>),
    paragraph: freshParagraph,
  };
  const merged = { ...cached, dailyBriefing: mergedBriefing };
  return { text: JSON.stringify(merged), providerType };
}

/**
 * Parse + (best-effort) validate a comprehensive provider reply. Returns the
 * parsed payload (validated when it matches `insightResultSchema`, else the
 * raw object so the richer optional blocks survive), or null when the reply
 * is not valid JSON even after fence-stripping. Null signals the caller to
 * run its one corrective retry.
 */
function parseComprehensiveResult(
  content: string,
): InsightResult | Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(content));
  } catch {
    return null;
  }
  const validated = insightResultSchema.safeParse(parsed);
  return validated.success
    ? validated.data
    : (parsed as Record<string, unknown>);
}

/**
 * The window average of an hourly-mean type (pulse, see `day-mean.ts`) for
 * the comparison snapshot: the mean of the user's local days in the window,
 * each the mean of its local hours' means, so the current-vs-baseline delta
 * compares the statistic the dashboard tile shows rather than a reading mean
 * a workout tips.
 */
export async function hourlyMeanWindowAverage(
  userId: string,
  type: MeasurementType,
  measuredAt: { gt: Date; lte?: Date },
): Promise<number | null> {
  const tz = await resolveUserTimezone(userId);
  const upper =
    measuredAt.lte === undefined
      ? PrismaSql.empty
      : PrismaSql.sql`AND m."measured_at" <= ${measuredAt.lte}`;
  const [row] = await prisma.$queryRaw<Array<{ mean: number | null }>>`
    WITH src AS (
      SELECT *
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."type" = ${type}::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" > ${measuredAt.gt}
        ${upper}
    )
    SELECT ${PrismaSql.raw(
      windowMeanSql({
        typeColumn: 'm."type"',
        value: 'm."value"',
        weight: "m.day_weight",
      }),
    )}::double precision AS mean
    FROM ${dayWeightedRowsSql("src", tz)} m
    GROUP BY m."type"
  `;
  return row?.mean === null || row?.mean === undefined
    ? null
    : Number(row.mean);
}

/**
 * Comparison-snapshot builder — shared with the on-demand route. Returns
 * null when the user's comparison toggle is off (most users), so the
 * prompt builder skips the context block entirely.
 */
export async function buildComparisonSnapshotForUser(
  userId: string,
): Promise<ComparisonSnapshot | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dashboardWidgetsJson: true,
      unitPreference: true,
      glucoseUnit: true,
    },
  });
  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  const baseline: ComparisonBaseline = layout.comparisonBaseline ?? "none";
  if (baseline === "none") return null;

  const typeToSnapshotKey: Record<string, string> = {
    WEIGHT: "weight",
    BLOOD_PRESSURE_SYS: "bloodPressureSys",
    BLOOD_PRESSURE_DIA: "bloodPressureDia",
    PULSE: "pulse",
    BODY_FAT: "bodyFat",
    SLEEP_DURATION: "sleep",
    ACTIVITY_STEPS: "steps",
  };
  // Weight is converted into the reader's mass unit below; the rest read the
  // same for everyone. Sleep comes off the night reconstruction in minutes.
  const typeUnits: Record<string, string> = {
    BLOOD_PRESSURE_SYS: "mmHg",
    BLOOD_PRESSURE_DIA: "mmHg",
    PULSE: "bpm",
    BODY_FAT: "%",
    SLEEP_DURATION: "min",
    ACTIVITY_STEPS: "",
  };
  const mass = getReadingTransform(
    "WEIGHT",
    resolveUnitPreferences({
      unitPreference: row?.unitPreference,
      glucoseUnit: row?.glucoseUnit,
    }),
  );
  const types = Object.keys(typeToSnapshotKey) as MeasurementType[];

  // The snapshot only ever reads two of summarize()'s means per call: avg30
  // (the "current" 30-day mean) and exactly ONE baseline mean — avg30LastMonth
  // (window [30, 60) days ago) or avg30LastYear (window [365, 395) days ago),
  // chosen by `baseline`. Rather than pull every raw row across a 400-day
  // window into JS and average there (tens of thousands of rows per dense type
  // on the page-blocking generate path AND the nightly pregenerate cron),
  // compute each mean as a DB-side AVG over the exact window the JS reducer
  // covered. The 2-dp rounding and the half-open window bounds are matched to
  // summarize()/meanOfWindow() byte-for-byte, so the emitted metrics are
  // numerically identical to the previous raw-scan implementation.
  //
  // SLEEP_DURATION stays on the raw path: it is stored ONE ROW PER STAGE per
  // night, so a bare SQL AVG would blend per-stage rows and double-count a
  // bare ASLEEP aggregate against its granular twin. Only the per-night dedup
  // reconstruction yields a meaningful nightly TIME-ASLEEP total.
  //
  // Anchor every window on ONE clock read so the aggregate reads and the sleep
  // reconstruction share an identical "now" (summarize() reads the clock once
  // too). Bounds mirror summarize(): avg30 keeps `now - measuredAt < 30d`
  // (measuredAt > now-30d, no upper bound); meanOfWindow(a,b) keeps
  // `a*DAY <= age < b*DAY` (measuredAt > now-b AND measuredAt <= now-a).
  const nowMs = Date.now();
  const DAY = 86_400_000;
  const currentWhere: { gt: Date } = { gt: new Date(nowMs - 30 * DAY) };
  const baselineWhere: { gt: Date; lte: Date } =
    baseline === "lastMonth"
      ? { gt: new Date(nowMs - 60 * DAY), lte: new Date(nowMs - 30 * DAY) }
      : { gt: new Date(nowMs - 395 * DAY), lte: new Date(nowMs - 365 * DAY) };

  // Rounded (2 dp) DB-side mean of `value` over one measured-at window, or null
  // when the window holds no live rows — matching summarize()'s avg30 /
  // meanOfWindow exactly (both round with Math.round(x * 100) / 100 and return
  // null on an empty slice).
  const avgOverWindow = async (
    type: MeasurementType,
    measuredAt: { gt: Date; lte?: Date },
  ): Promise<number | null> => {
    const avg = usesHourlyMeanDay(type)
      ? await hourlyMeanWindowAverage(userId, type, measuredAt)
      : (
          await prisma.measurement.aggregate({
            where: { userId, type, deletedAt: null, measuredAt },
            _avg: { value: true },
          })
        )._avg.value;
    return avg === null ? null : Math.round(avg * 100) / 100;
  };

  // Sleep still needs the raw 400-day window for the per-night reconstruction;
  // the widest baseline mean reaches into [365, 395) days, so a 5-day floor
  // over that boundary is the smallest safe bound.
  const sleepSinceMeasuredAt = new Date(nowMs - 400 * DAY);

  // Cap the type fan-out so a multi-metric account cannot open one DB
  // connection per type at once (mirrors the pLimit(4) discipline in
  // series-batch/route.ts).
  const limit = pLimit(4);

  const rows = await Promise.all(
    types.map((type) =>
      limit(async () => {
        let currentAvg: number | null;
        let baselineAvg: number | null;
        if (type === "SLEEP_DURATION") {
          const [sleepRows, sleepTz, sleepPriority] = await Promise.all([
            prisma.measurement.findMany({
              where: {
                userId,
                type,
                deletedAt: null,
                measuredAt: { gte: sleepSinceMeasuredAt },
              },
              orderBy: { measuredAt: "asc" },
              select: {
                measuredAt: true,
                value: true,
                sleepStage: true,
                source: true,
                // Writer-level collapse: two HealthKit apps behind one
                // source (watch stages vs phone in-bed) must not blend.
                deviceType: true,
              },
            }),
            resolveUserTimezone(userId),
            loadUserSourcePriority(userId),
          ]);
          const dataPoints: DataPoint[] = reconstructSleepNights(
            sleepRows as SleepStageRow[],
            sleepTz,
            sleepPriority,
          )
            .filter((n) => n.asleepMinutes > 0)
            .map((n) => ({ date: n.measuredAt, value: n.asleepMinutes }));
          const summary = summarize(dataPoints);
          currentAvg = summary.avg30 ?? null;
          baselineAvg =
            baseline === "lastMonth"
              ? (summary.avg30LastMonth ?? null)
              : (summary.avg30LastYear ?? null);
        } else {
          [currentAvg, baselineAvg] = await Promise.all([
            avgOverWindow(type, currentWhere),
            avgOverWindow(type, baselineWhere),
          ]);
        }
        const delta =
          currentAvg !== null && baselineAvg !== null
            ? Math.round((currentAvg - baselineAvg) * 100) / 100
            : null;
        const deltaPercent =
          delta !== null && baselineAvg !== null && baselineAvg !== 0
            ? Math.round((delta / Math.abs(baselineAvg)) * 100 * 10) / 10
            : null;
        if (type === "WEIGHT") {
          return {
            type: typeToSnapshotKey[type],
            currentAvg:
              currentAvg === null
                ? null
                : applyDisplayTransform(currentAvg, mass),
            baselineAvg:
              baselineAvg === null
                ? null
                : applyDisplayTransform(baselineAvg, mass),
            delta:
              delta === null ? null : applyDisplayTransformDelta(delta, mass),
            deltaPercent,
            unit: mass.displayUnit,
          };
        }
        return {
          type: typeToSnapshotKey[type] ?? type,
          currentAvg,
          baselineAvg,
          delta,
          deltaPercent,
          unit: typeUnits[type] ?? "",
        };
      }),
    ),
  );

  const metrics = rows.filter(
    (row) => row.currentAvg !== null || row.baselineAvg !== null,
  );

  return { baseline, metrics };
}

/**
 * v1.28.30 — typed `failed` return for the pre-provider stages (feature
 * extraction / oversize payload). These paths used to return
 * `{ status: "failed" }` with NO annotation and NO failure marker: the
 * nightly cron counted them into its `failed` tally silently, and the
 * read path could not tell the user the last attempt failed. One helper
 * so every failure return is greppable under the same action name and
 * leaves a dated marker for the briefing card's honest empty state.
 */
function failBeforeProvider(
  userId: string,
  locale: SupportedLocale,
  reason: "payload-too-large" | "features-error" | "aborted",
  err?: unknown,
): GenerateOutcome {
  const message =
    err instanceof Error
      ? err.message.slice(0, 240)
      : err != null
        ? String(err).slice(0, 240)
        : null;
  annotate({
    action: { name: "insights.generate.comprehensive_failed" },
    meta: { locale, reason, provider_status: null, provider_message: message },
  });
  void recordBriefingFailure({ userId, reason, locale });
  return { status: "failed", reason };
}

type InsightCommitResult =
  | "committed"
  | "scope-changed"
  | "profile-scope-changed"
  | "no-consent"
  | "unavailable";

/**
 * The exact User columns (besides `insightsPrivacyMode`, guarded
 * separately) that feed the generation prompt built above. Captured at the
 * same `dbUser` read that starts the generation and required to still
 * match at commit time.
 */
type PromptScopeAtRead = {
  insightsExcludeMetrics: string[];
  gender: string | null;
  displayName: string | null;
};

/**
 * Recheck every user-controlled prompt scope immediately before a cache write.
 * The profile text identifies an authoritative profile-scope mismatch. The
 * guarded User columns below catch a privacy-mode / exclude-list / gender /
 * display-name change — the exact set of columns this generation's prompt
 * was built from — without keying on the broad `updatedAt` timestamp, which
 * a provider credential refresh (e.g. `resolveProviderChain()`'s token
 * maintenance) also advances and would otherwise false-positive here.
 *
 * The consent rule runs once more too, against the provider that answered
 * (`servedBy`, `null` for a timestamp-only stamp that writes no text), with a
 * fresh receipt read: a withdrawal that landed while the
 * call was in flight already purged the stored briefing, and this write would
 * bring it back.
 */
async function commitInsightUnderScope(
  userId: string,
  modeAtRead: string,
  selfContextAtRead: string | null,
  promptScopeAtRead: PromptScopeAtRead,
  locale: SupportedLocale,
  servedBy: string | null,
  data: Prisma.UserUpdateInput,
): Promise<InsightCommitResult> {
  if (servedBy !== null) {
    const late = await aiEgressRefusal("briefing", userId, [servedBy]);
    if (late) {
      return late.reason === "consent_required" ? "no-consent" : "unavailable";
    }
  }
  const currentSelfContext = await getSelfContextTextForUser(userId, locale);
  if (currentSelfContext !== selfContextAtRead) {
    return "profile-scope-changed";
  }
  const res = await prisma.user.updateMany({
    where: {
      id: userId,
      insightsPrivacyMode: modeAtRead,
      insightsExcludeMetrics: {
        equals: promptScopeAtRead.insightsExcludeMetrics,
      },
      gender: promptScopeAtRead.gender,
      displayName: promptScopeAtRead.displayName,
    },
    data,
  });
  return res.count > 0 ? "committed" : "scope-changed";
}

function scopeChangedSkip(
  result: InsightCommitResult,
  locale: SupportedLocale,
): GenerateOutcome | null {
  if (result === "committed") return null;
  annotate({
    action: { name: `insights.generate.${result.replaceAll("-", "_")}` },
    meta: { locale },
  });
  return { status: "skipped", reason: result };
}

interface GenerateOptions {
  /** Resolved UI locale for the prompt + cache row. */
  locale: SupportedLocale;
  /** Skip the 24 h cache short-circuit and force a fresh generation. */
  force?: boolean;
  /**
   * v1.9.0 — abort the generation when the caller has given up on it.
   *
   * The on-demand `forceWarmUser` path bounds the comprehensive step with a
   * timeout and then proceeds to warm the per-status caches itself. Without
   * this signal a comprehensive that resolves AFTER the timeout would still
   * write a cache row + timestamp the caller no longer expects. The signal
   * lets the caller cut the generation off before the cache write.
   */
  signal?: AbortSignal;
}

/**
 * Resolve + cache the comprehensive insight for one user. Pure
 * pipeline; no rate-limit / audit / request concerns. Returns a typed
 * outcome the caller (route or cron) can log + branch on.
 *
 * On a 24 h cache hit (and `!force`) returns `{ status: "cached" }`
 * without touching the provider chain. On a provider miss returns
 * `{ status: "skipped", reason: "no-provider" }`. Provider failures
 * map to `{ status: "failed" }` rather than throwing so a cron batch
 * loop continues to the next user.
 */
export async function generateComprehensiveInsight(
  userId: string,
  options: GenerateOptions,
): Promise<GenerateOutcome> {
  const { locale } = options;
  const force = options.force === true;
  const signal = options.signal;

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsPrivacyMode: true,
      insightsCachedAt: true,
      insightsCachedText: true,
      insightsCachedLocale: true,
      insightsExcludeMetrics: true,
      insightsSnapshotHash: true,
      insightsBriefingRerollDate: true,
      // The comparison-baseline setting joins the snapshot fingerprint
      // (see the hash construction below), so it must be readable BEFORE
      // the gate — the comparison snapshot itself is only built after.
      dashboardWidgetsJson: true,
      // v1.18.11 P5 — gender feeds the cycle context block (phase contrast).
      gender: true,
      // v1.22 (W6) — first name for the sparse, hash-gated briefing opener.
      displayName: true,
      // v1.25 — per-user response-timeout (seconds). Threaded onto every
      // provider call below so a raised value for a slow self-hosted backend
      // actually applies to the briefing, not just to Coach.
      aiResponseTimeoutSeconds: true,
      // The reader's units: the feature set is converted into them before it
      // is hashed and serialised, so a unit switch regenerates the briefing.
      unitPreference: true,
      glucoseUnit: true,
    },
  });

  // Resolve the upstream provider timeout once from the user's setting,
  // falling back to the comprehensive budget. Every generation call in this
  // function (main, JSON retry, grounding retry, and the paragraph re-roll)
  // uses it so the whole briefing path honours the operator's allowance.
  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
    dbUser?.aiResponseTimeoutSeconds,
    AI_BUDGETS.comprehensive.timeoutMs,
  );

  // A cache written in another language is not this locale's cache: it
  // must not satisfy an unforced run, or a reader in the requested language
  // keeps being told the slot is warm while it holds someone else's prose.
  // An untagged row predates the tag and counts as matching.
  const cachedLocaleMatches =
    dbUser?.insightsCachedLocale == null ||
    dbUser.insightsCachedLocale === locale;
  if (
    !force &&
    dbUser?.insightsCachedAt &&
    dbUser.insightsCachedText &&
    cachedLocaleMatches &&
    Date.now() - dbUser.insightsCachedAt.getTime() < CACHE_TTL_MS
  ) {
    return { status: "cached" };
  }

  // The `briefing` capability at the wire, before the chain is resolved (a
  // Codex chain may refresh a token on resolve). Callers resolve it too (the
  // route before it enqueues, the nightly pass before this call); switches,
  // the AI analysis opt-out and consent can change in between.
  const capability = await aiCapabilityForRecord(userId, "briefing");
  if (!capability.available) {
    annotate({
      action: { name: "insights.comprehensive.unavailable" },
      meta: { reason: capability.reason },
    });
    return {
      status: "skipped",
      reason:
        capability.reason === "no_provider"
          ? "no-provider"
          : capability.reason === "consent_required"
            ? "no-consent"
            : "unavailable",
    };
  }

  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type === "none") {
      return { status: "skipped", reason: "no-provider" };
    }
    chain.push({ providerType: "admin-openai", instance: legacy });
  }

  // The wire re-check for exactly this chain (`aiEgressRefusal`): the
  // capability again, and the consent an operator-held entry needs. This
  // pipeline runs off-request (nightly cron + on-demand force-warm), so a
  // refusal is a typed `skipped` outcome rather than a throw — the cron batch
  // continues to the next user. A person's own key, their ChatGPT account or
  // a local model need no receipt.
  const refusal = await aiEgressRefusal(
    "briefing",
    userId,
    chain.map((entry) => entry.providerType),
  );
  if (refusal) {
    return {
      status: "skipped",
      reason:
        refusal.reason === "consent_required" ? "no-consent" : "unavailable",
    };
  }

  const includeRaw = dbUser?.insightsPrivacyMode === "raw";
  // v1.32.22 (M6) — capture the privacy-mode column value read here (a
  // non-nullable String defaulting to "aggregated"), so every cache commit
  // below can guard on it. A `PUT /api/insights/settings` flip that lands
  // between this read and a commit advances the column ("aggregated" ⇄ "raw");
  // the guarded write then matches zero rows and the generation is skipped
  // rather than stamping an old-scope payload over the cache the flip nulled.
  const modeAtRead = dbUser?.insightsPrivacyMode ?? "aggregated";
  // v1.18.11 P1 — bound the briefing's bulk feature read to a recent window
  // (all-time extremes are sourced separately, see features.ts). The downgrade
  // ladder below stays as the safety net for the rare oversize payload.
  const featureWindow = { sinceDays: BRIEFING_FEATURE_WINDOW_DAYS };
  let features: Awaited<ReturnType<typeof extractFeatures>>;
  try {
    // v1.18.11 P3 — compute-once-per-scope. Inside the nightly-tick scope (or
    // the on-demand route scope) the bounded feature read is shared, so the
    // downgrade-ladder re-reads below and any sibling consumer in the same
    // scope reuse this object instead of re-querying.
    features = await getCachedFeatures({
      userId,
      includeRaw,
      sinceDays: featureWindow.sinceDays,
      compute: () => extractFeatures(userId, includeRaw, featureWindow),
    });
  } catch (err) {
    if (err instanceof FeaturesPayloadTooLargeError) {
      try {
        features = await getCachedFeatures({
          userId,
          includeRaw: false,
          sinceDays: featureWindow.sinceDays,
          compute: () => extractFeatures(userId, false, featureWindow),
        });
      } catch (retryErr) {
        if (retryErr instanceof FeaturesPayloadTooLargeError) {
          try {
            const aggregated = await getCachedFeatures({
              userId,
              includeRaw: false,
              sinceDays: featureWindow.sinceDays,
              compute: () => extractFeatures(userId, false, featureWindow),
            });
            features = applyInsightsExcludeFilter(
              aggregated,
              MAX_DOWNGRADE_TOKENS,
            );
          } catch (finalErr) {
            return failBeforeProvider(
              userId,
              locale,
              "payload-too-large",
              finalErr,
            );
          }
        } else {
          return failBeforeProvider(userId, locale, "features-error", retryErr);
        }
      }
    } else {
      return failBeforeProvider(userId, locale, "features-error", err);
    }
  }

  const excludeList = dbUser?.insightsExcludeMetrics ?? [];
  // v1.34 — snapshot of the exact User columns that feed the prompt below
  // (besides `modeAtRead`, guarded separately), captured at this same
  // `dbUser` read and required to still match at every commit below. Keeps
  // the optimistic-concurrency guard immune to unrelated column writes
  // (e.g. `resolveProviderChain()`'s OAuth token-refresh update) that would
  // otherwise false-positive an `updatedAt`-keyed check.
  const promptScopeAtRead: PromptScopeAtRead = {
    insightsExcludeMetrics: excludeList,
    gender: dbUser?.gender ?? null,
    displayName: dbUser?.displayName ?? null,
  };
  features = applyInsightsExcludeFilter(features, excludeList);
  // Every figure below the canonical arithmetic is stated in the reader's
  // units: the prompt, the content hash and the grounding check all read the
  // converted set, so they agree with each other and with the reader.
  const units = resolveUnitPreferences({
    unitPreference: dbUser?.unitPreference,
    glucoseUnit: dbUser?.glucoseUnit,
  });
  features = featuresInReaderUnits(features, units);
  const compactFeatures = compactSections(
    features as unknown as Record<string, unknown>,
  );
  const featuresJson = JSON.stringify(compactFeatures, null, 2);

  // v1.16.8 — content-hash gate. When the compacted feature snapshot is
  // byte-equivalent (modulo clock-relative offsets, see snapshot-hash.ts)
  // to the one the cached text was generated from, nothing the prompt
  // sees has changed — refresh the cache timestamp and skip the provider
  // call. This runs on the forced paths too (nightly tick, on-demand
  // warm), which is exactly where the same-data regeneration waste lived.
  //
  // The user-authored "about me" self-description joins the fingerprint:
  // it is the one prompt input that can change with NO data change (the
  // Coach remember action, a Settings → AI edit), and excluding it would
  // pin the briefing to the pre-edit self-context until a measurement
  // happens to move. The plateau block stays out — it derives from the
  // same measurement rows the feature snapshot already fingerprints.
  // Fetched once here and reused for the prompt below.
  //
  // Two more prompt inputs that can flip with no data change join the
  // composite (the shape MUST stay identical to the POST route's hash
  // write in `generate/route.ts`, or every nightly force-regenerates):
  //   - `comparisonBaseline`: the user's comparison toggle. Switching it
  //     adds/removes the prior-period context block, so the cached text
  //     no longer matches what the prompt would produce.
  //   - `generationLocale`: the locale the briefing renders in. Hashing
  //     it means a locale switch regenerates ONCE — intended, the
  //     briefing language must follow the reader; afterwards the new
  //     locale's hash is the stored baseline and the gate holds again.
  //     The key is named `generationLocale` (not `locale`) on purpose:
  //     the canonicaliser in `snapshot-hash.ts` strips `locale` keys as
  //     volatile, which is right for the per-locale-keyed status caches
  //     but would silently drop the field from THIS composite.
  const aboutMe = await getSelfContextTextForUser(userId, locale);
  const comparisonBaseline: ComparisonBaseline =
    resolveDashboardLayout(dbUser?.dashboardWidgetsJson).comparisonBaseline ??
    "none";
  const snapshotHash = hashInsightSnapshot({
    features: compactFeatures,
    aboutMe: aboutMe ?? null,
    comparisonBaseline,
    generationLocale: locale,
  });
  // v1.12.7 (B5) — the curated SOURCES block for the metrics present, shared
  // by both the full generation below and the unchanged-data re-roll.
  const referenceMetrics = metricsFromPresentSections({
    bloodPressure: features.bloodPressure != null,
    weight: features.weight != null,
    pulse: features.pulse != null,
    mood: features.mood != null,
    medication: (features.medications?.length ?? 0) > 0,
  });

  const comparisonSnapshot = await buildComparisonSnapshotForUser(userId);
  const plateauContext = await detectGlp1Plateau(userId);
  let userPrompt = buildUserPrompt(
    featuresJson,
    dbUser?.insightsPrivacyMode ?? "aggregated",
    locale,
    comparisonSnapshot ?? undefined,
  );
  if (plateauContext) {
    userPrompt += buildGlp1PlateauPrompt(plateauContext, locale, units.system);
  }
  if (aboutMe) {
    userPrompt += buildAboutMeInsightBlock(aboutMe, locale);
  }
  // v1.18.11 P5 — illness + cycle context (same builders as the on-demand
  // route + the Coach). Module-gated; null for users without either module.
  const illnessCycleCtx = await buildBriefingIllnessCycleContext(
    userId,
    dbUser?.gender ?? null,
    await resolveUserTimezone(userId),
  );
  if (illnessCycleCtx) {
    userPrompt += buildBriefingIllnessCyclePrompt(illnessCycleCtx, locale);
  }
  // v1.22 (W6) — opener-archetype rotation + sparse first-name personalization.
  // Both are deterministic per (user, day): the opener hint varies the briefing
  // lead day-over-day, and the name appears on roughly one day in three (never a
  // rote daily "Good morning, <name>"). The whole block is omitted when no
  // display name is set, so unnamed / demo accounts are byte-identical.
  userPrompt += buildBriefingPersonalisationBlock(
    userId,
    dbUser?.displayName ?? null,
    locale,
    await resolveUserTimezone(userId),
  );
  const systemPrompt = buildSystemPromptWithReferences(
    locale,
    referenceMetrics,
  );

  // v1.28.30 — the unchanged short-circuit only holds when the cached
  // payload actually carries a briefing. A grounding-stripped (or model-
  // omitted) briefing left a briefingless payload WITH a stored hash;
  // on unchanged data every subsequent warm re-stamped the timestamp and
  // the briefing never came back — a permanent silent hole. Treating the
  // briefingless cache as "not unchanged" re-runs the full generation
  // (bounded by the nightly budget bucket + forced-warm caps).
  const cachedCarriesBriefing = cachedPayloadCarriesBriefing(
    dbUser?.insightsCachedText,
  );
  if (
    dbUser?.insightsCachedText &&
    dbUser.insightsSnapshotHash === snapshotHash &&
    !cachedCarriesBriefing
  ) {
    annotate({
      action: { name: "insights.generate.briefingless_cache_regenerate" },
      meta: { locale },
    });
  }
  if (
    dbUser?.insightsCachedText &&
    dbUser.insightsSnapshotHash === snapshotHash &&
    cachedCarriesBriefing
  ) {
    // v1.18.7 (MEDIUM-3) — findings are byte-stable, but re-roll the daily-
    // briefing PARAGRAPH once per calendar day so the prose reads fresh
    // day-over-day. Gated on `insightsBriefingRerollDate` so it costs at
    // most one extra call/day; the higher, seedless temperature varies the
    // phrasing while the structured findings are preserved verbatim from the
    // cached payload. Any miss falls through to the plain timestamp refresh.
    const todayKey = buildRerollDateKey();
    if (dbUser.insightsBriefingRerollDate !== todayKey) {
      const rerolled = await rerollBriefingParagraph({
        userId,
        chain,
        systemPrompt,
        userPrompt,
        cachedText: dbUser.insightsCachedText,
        locale,
        signals: features.signalsOfDay ?? null,
        features,
        comparison: comparisonSnapshot,
        effectiveTimeoutMs,
      });
      if (rerolled) {
        // The reroll rewrites content derived from the scope captured before
        // the provider call. Refuse it if either privacy mode or included
        // self-context changed in flight.
        const committed = await commitInsightUnderScope(
          userId,
          modeAtRead,
          aboutMe,
          promptScopeAtRead,
          locale,
          rerolled.providerType,
          {
            insightsCachedAt: new Date(),
            insightsCachedText: rerolled.text,
            insightsCachedLocale: locale,
            insightsBriefingRerollDate: todayKey,
          },
        );
        const skipped = scopeChangedSkip(committed, locale);
        if (skipped) return skipped;
        invalidateUserInsights(userId);
        annotate({
          action: { name: "insights.generate.briefing_rerolled" },
          meta: { locale, provider: rerolled.providerType },
        });
        return { status: "rerolled", providerType: rerolled.providerType };
      }
      // A re-roll miss still stamps the day so a persistently failing
      // provider cannot be re-driven on every page-open; the next day retries.
      // Even a timestamp-only stamp must not make a cache cleared by a scope
      // change look fresh again.
      const stamped = await commitInsightUnderScope(
        userId,
        modeAtRead,
        aboutMe,
        promptScopeAtRead,
        locale,
        null,
        {
          insightsCachedAt: new Date(),
          // The fingerprint covers the generation locale, so a matching hash
          // means the stored text is in `locale`; tag it (a pre-tag row gets
          // its label on its first unchanged night).
          insightsCachedLocale: locale,
          insightsBriefingRerollDate: todayKey,
        },
      );
      const skipped = scopeChangedSkip(stamped, locale);
      if (skipped) return skipped;
      annotate({
        action: { name: "insights.generate.skipped_unchanged" },
        meta: { locale, rerollAttempted: true },
      });
      return { status: "unchanged" };
    }
    const stamped = await commitInsightUnderScope(
      userId,
      modeAtRead,
      aboutMe,
      promptScopeAtRead,
      locale,
      null,
      {
        insightsCachedAt: new Date(),
        insightsCachedLocale: locale,
      },
    );
    const skipped = scopeChangedSkip(stamped, locale);
    if (skipped) return skipped;
    annotate({
      action: { name: "insights.generate.skipped_unchanged" },
      meta: { locale },
    });
    return { status: "unchanged" };
  }

  let result;
  let workingProviderType: string;
  try {
    const fallback = await runBriefingCompletion({
      userId,
      chain,
      systemPrompt,
      userPrompt,
      temperature: AI_BUDGETS.comprehensive.temperature,
      maxTokens: resolveInsightsMaxTokens(),
      // v1.21.5 — wider upstream budget so the reasoning-heavy briefing
      // generation is not clipped at the client's 60 s default mid-stream.
      // v1.25 — honours the per-user response-timeout setting.
      timeoutMs: effectiveTimeoutMs,
      stage: "generate",
    });
    result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
  } catch (e) {
    // Over the day's token ceiling — no provider was contacted. Typed as
    // `skipped`, not `failed`: there is no upstream fault to retry against,
    // so the caller must not enqueue the 45-minute provider-failure retry or
    // hold the day provisional waiting for a briefing that will not come
    // until the ledger rolls over. No failure marker either — the ceiling is
    // an accounting outcome, not a broken generation.
    if (e instanceof BriefingBudgetExceededError) {
      annotate({
        action: { name: "insights.generate.budget_exceeded" },
        meta: { locale, stage: e.stage, totalAfter: e.totalAfter },
      });
      return { status: "skipped", reason: "budget" };
    }
    // v1.21.5 — make the failed generation queryable. This path used to return
    // a `failed` outcome with NO annotation, so a provider that consistently
    // failed (e.g. a codex briefing aborted by the 60 s timeout on a large
    // account) left the cached block empty AND emitted nothing the operator
    // could grep — the briefing and the insights trend narrative that share
    // the block stayed blank with no signal. No cache row is written, so the
    // next warm / visit retries; the wider `timeoutMs` above is what lets that
    // retry actually land.
    const reason =
      e instanceof AllProvidersFailedError
        ? "all-providers-failed"
        : "provider-error";
    const err = e as { httpStatus?: number; message?: string };
    annotate({
      action: { name: "insights.generate.comprehensive_failed" },
      meta: {
        locale,
        reason,
        provider_status:
          typeof err.httpStatus === "number" ? err.httpStatus : null,
        provider_message: err.message?.slice(0, 240) ?? null,
      },
    });
    // v1.25 — record a dated failure marker so the read path can surface a
    // discreet "couldn't refresh" hint alongside the preserved last-good
    // briefing. No cache row is written here, so `insightsCachedText` (the
    // last good payload) stays intact and the surface never blanks.
    void recordBriefingFailure({
      userId,
      reason,
      locale,
      httpStatus: typeof err.httpStatus === "number" ? err.httpStatus : null,
    });
    return { status: "failed", reason };
  }

  // Anthropic + local have no native JSON mode, so a ```json-fenced or
  // sentence-prefixed reply would otherwise fail the whole generation.
  // Strip the fence before parsing; clean JSON passes through unchanged.
  let insights = parseComprehensiveResult(result.content);
  if (insights === null) {
    // v1.18.7 (MEDIUM-5) — one corrective retry before declaring failure,
    // reusing the same `buildRetryCorrectionMessage` the strict insight
    // wrapper uses next door. The comprehensive path previously failed cold
    // to `invalid-json` on a first-pass miss even though the recovery helper
    // sat right there. The retry appends the correction to the user prompt
    // and re-runs the chain once.
    annotate({
      action: { name: "insights.generate.json_retry" },
      meta: { locale },
    });
    try {
      const retry = await runBriefingCompletion({
        userId,
        chain,
        systemPrompt,
        userPrompt: `${userPrompt}\n\n${buildRetryCorrectionMessage(
          "Response was not valid JSON",
          "The previous reply could not be parsed as a JSON object.",
        )}`,
        temperature: AI_BUDGETS.comprehensive.temperature,
        maxTokens: resolveInsightsMaxTokens(),
        // v1.21.5 — wider upstream budget; see the first generation call.
        // v1.25 — honours the per-user response-timeout setting.
        timeoutMs: effectiveTimeoutMs,
        stage: "json-retry",
      });
      result = retry.result;
      workingProviderType = retry.workingProvider.providerType;
    } catch (retryErr) {
      // The first pass already landed and was charged; the correction pass is
      // what the ceiling refused. Same `skipped` treatment as the first call —
      // a budget refusal is not a provider fault to retry against.
      if (retryErr instanceof BriefingBudgetExceededError) {
        annotate({
          action: { name: "insights.generate.budget_exceeded" },
          meta: {
            locale,
            stage: retryErr.stage,
            totalAfter: retryErr.totalAfter,
          },
        });
        return { status: "skipped", reason: "budget" };
      }
      // v1.28.30 — annotate alongside the marker so an invalid-JSON night
      // is greppable under the same action as every other failure class.
      annotate({
        action: { name: "insights.generate.comprehensive_failed" },
        meta: {
          locale,
          reason: "invalid-json",
          provider_status: null,
          provider_message:
            retryErr instanceof Error
              ? retryErr.message.slice(0, 240)
              : "retry-transport-failed",
        },
      });
      void recordBriefingFailure({ userId, reason: "invalid-json", locale });
      return { status: "failed", reason: "invalid-json" };
    }
    insights = parseComprehensiveResult(result.content);
    if (insights === null) {
      annotate({
        action: { name: "insights.generate.comprehensive_failed" },
        meta: {
          locale,
          reason: "invalid-json",
          provider_status: null,
          // v1.28.28 truncation-aware: a `length` finish means the token
          // ceiling cut the JSON mid-string — a budget problem, not a
          // model-quality one.
          provider_message:
            result.finishReason === "length"
              ? "response-truncated-at-token-ceiling"
              : "unparseable-after-retry",
        },
      });
      void recordBriefingFailure({ userId, reason: "invalid-json", locale });
      return { status: "failed", reason: "invalid-json" };
    }
  }

  // v1.18.10 (HIGH-1) — daily-briefing number-grounding gate. The cron +
  // force-warm path produces the same briefing the POST route does, so it
  // enforces the same cross-check: every number the briefing restates must
  // trace to a `features.signalsOfDay` figure. One corrective retry, then strip
  // the briefing rather than persist a fabricated number.
  // v1.28.30 — true when the grounding gate stripped the briefing HARD (no
  // previous-cached fallback available). Persisted as a dated marker after
  // the cache write so the read path can render the honest "briefing
  // withheld" state instead of a silent generic empty card.
  let briefingStrippedHard = false;
  {
    const signals = features.signalsOfDay ?? null;
    let retryTransportFailed = false;
    let ungrounded = findUngroundedBriefingNumbers(
      readBriefingBlock(insights),
      signals,
      features,
      comparisonSnapshot,
    );
    if (ungrounded.length > 0) {
      annotate({
        action: { name: "insights.generate.briefing_grounding_retry" },
        meta: { locale, ungroundedCount: ungrounded.length },
      });
      try {
        const retry = await runBriefingCompletion({
          userId,
          chain,
          systemPrompt,
          userPrompt: `${userPrompt}\n\n${buildBriefingGroundingCorrection(ungrounded)}`,
          temperature: AI_BUDGETS.comprehensive.temperature,
          maxTokens: resolveInsightsMaxTokens(),
          // v1.21.5 — wider upstream budget; see the first generation call.
          // v1.25 — honours the per-user response-timeout setting.
          timeoutMs: effectiveTimeoutMs,
          stage: "grounding-retry",
        });
        const retryInsights = parseComprehensiveResult(retry.result.content);
        const retryUngrounded = findUngroundedBriefingNumbers(
          readBriefingBlock(retryInsights),
          signals,
          features,
          comparisonSnapshot,
        );
        if (retryInsights !== null && retryUngrounded.length === 0) {
          insights = retryInsights;
          result = retry.result;
          workingProviderType = retry.workingProvider.providerType;
          ungrounded = [];
        } else {
          ungrounded = retryUngrounded;
        }
      } catch {
        // Retry failed on TRANSPORT (provider outage / timeout) or on the
        // day's budget ceiling, rather than on content. Recorded for the
        // annotation only — the disposal below no longer forks on it.
        retryTransportFailed = true;
      }
    }
    if (ungrounded.length > 0 && insights && typeof insights === "object") {
      // The freshly generated briefing is DISCARDED either way — that is the
      // anti-fabrication guarantee and it is absolute. The only question left
      // is what stands in its place, and the answer does not depend on WHY the
      // retry failed.
      //
      // This used to fall back to the previous payload's briefing on a
      // transport failure but leave a hole on a content failure. The asymmetry
      // had no justification: the previous briefing passed this identical gate
      // when it was written, so it carries no fabricated figure in either
      // case, and the user never sees the rejected text either way. All the
      // hole did was cost the reader their paragraph, signals-of-day, key
      // findings and recommendations over one unverifiable number — while the
      // "briefing withheld" notice told them something had gone wrong without
      // giving them anything usable. A day-old grounded briefing beats a
      // vanished one on both paths, and the next successful run replaces it.
      let fallbackBriefing: unknown = null;
      if (dbUser?.insightsCachedText) {
        try {
          const prev = JSON.parse(dbUser.insightsCachedText) as Record<
            string,
            unknown
          >;
          fallbackBriefing = prev.dailyBriefing ?? null;
        } catch {
          // Unparseable previous payload — nothing safe to stand in.
        }
      }
      (insights as Record<string, unknown>).dailyBriefing = fallbackBriefing;
      briefingStrippedHard = fallbackBriefing == null;
      annotate({
        action: { name: "insights.generate.briefing_grounding_stripped" },
        meta: {
          locale,
          ungroundedCount: ungrounded.length,
          retryFailure: retryTransportFailed ? "transport" : "content",
          briefing_fallback:
            fallbackBriefing != null ? "previous-cached" : "stripped",
        },
      });
    }
  }

  // Citation coverage. This annotation is what the admin AI-quality dashboard
  // slices to track how many normative recommendations carry a curated
  // medical-reference id. It used to hang off a wrapper that had no production
  // caller, so the dashboard was reading a metric nothing emitted.
  // Observational only — an uncited normative rec is a logged warning, never a
  // reason to fail the generation.
  if (insights && typeof insights === "object") {
    const payload = insights as Record<string, unknown>;
    if (Array.isArray(payload.recommendations)) {
      // The recommendations are written in `locale`, so the normative-claim
      // bank has to be the reader's. Grading them against English alone
      // reported "no normative claims" for four of the six shipped languages.
      const coverage = computeCitationCoverage(
        { recommendations: payload.recommendations },
        locale,
      );
      annotate({
        action: { name: "insights.generate.citation_coverage" },
        meta: {
          locale,
          totalRecommendations: coverage.totalRecommendations,
          normativeRecommendations: coverage.normativeRecommendations,
          citedNormativeRecommendations: coverage.citedNormativeRecommendations,
          uncitedNormativeCount:
            coverage.uncitedNormativeRecommendationIds.length,
        },
      });
    }
  }

  // Outbound safety screen over the WHOLE prose surface.
  //
  // SURFACE POLICY — WITHHOLD. This payload is generated in the background and
  // persisted as the cached insight; nobody is waiting on the turn. Unlike the
  // number-grounding gate above, a safety violation cannot be surgically
  // stripped: a dose imperative may sit in `recommendations[]`, in `summary`,
  // or in the briefing, and deleting an arbitrary field would leave a payload
  // whose remaining prose still refers to it. So the whole generation fails and
  // persists NOTHING -- the previous cached payload stays, exactly as a
  // provider outage or an unparseable response already behaves. The next run
  // regenerates from scratch.
  const screened = screenInsightPayloadProse(insights, locale);
  if (screened) {
    annotate({
      action: { name: "insights.generate.outbound_blocked" },
      meta: { locale, reason: screened },
    });
    void recordBriefingFailure({ userId, reason: "outbound-screened", locale });
    return { status: "failed", reason: "outbound-screened" };
  }

  // v1.9.0 — the caller abandoned this generation (its bounded timeout
  // fired and it has moved on to warm the per-status caches itself). Bail
  // out before the cache write so a late-resolving comprehensive cannot
  // stamp a timestamp/text the caller no longer expects. The provider call
  // already cost what it cost; what we must NOT do now is touch the cache.
  if (signal?.aborted) {
    // v1.28.30 — annotated + marked like every other failure: an abandoned
    // generation is a real "no fresh briefing tonight" outcome, and the read
    // path needs the marker to render an honest state instead of silence.
    return failBeforeProvider(userId, locale, "aborted");
  }

  // The payload was built under the privacy and profile scope captured before
  // the provider call. Recheck both before the write so an inclusion change
  // cannot be overwritten by stale in-flight content.
  const committed = await commitInsightUnderScope(
    userId,
    modeAtRead,
    aboutMe,
    promptScopeAtRead,
    locale,
    workingProviderType,
    {
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(insights),
      insightsCachedLocale: locale,
      insightsSnapshotHash: snapshotHash,
    },
  );
  const skipped = scopeChangedSkip(committed, locale);
  if (skipped) return skipped;
  // v1.16.8 — no blanket per-status eviction here any more. The cards
  // track their own data through the ingest invalidator and their own
  // content-hash gates; a fresh comprehensive briefing does not change
  // what a per-metric card should say, and the old sweep was the reason
  // every warm had to regenerate ~45 cards across both locales.
  invalidateUserInsights(userId);

  // v1.28.30 — the generation SUCCEEDED but the grounding gate withheld the
  // briefing. Record the marker AFTER the cache write so it is newer than
  // `insightsCachedAt` and the read path surfaces "briefing withheld"
  // instead of a silent generic empty card until the next generation.
  if (briefingStrippedHard) {
    void recordBriefingFailure({
      userId,
      reason: "briefing-ungrounded",
      locale,
    });
  }

  return { status: "generated", providerType: workingProviderType };
}
