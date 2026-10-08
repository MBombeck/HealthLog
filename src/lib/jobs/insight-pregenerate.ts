/**
 * v1.7.0 W6 — nightly insight pre-generation cron.
 *
 * Closes the gap the R-firstpaint audit surfaced: before this cron,
 * every daily briefing was generated lazily on the first `/insights`
 * mount after the 24 h cache expired, blocking that request on the
 * provider chain. This cron pre-generates the comprehensive insight
 * (which carries the `dailyBriefing` block) overnight so the mount-time
 * advisor POST is always a pure cache read, and the v1.7.0 dashboard
 * snapshot embeds a `briefingState: "ready"` block instead of
 * `"preparing"`.
 *
 * v1.8.0 — warm the per-metric assessment caches too, so the first
 * `/insights` mount of the morning is a cache read instead of one live
 * status generation per card.
 *
 * v1.16.8 — the warm is single-locale (the user's resolved locale) and
 * refill-only: every generator runs its own content-hash gate, so a card
 * whose underlying data did not change since its last real assessment
 * costs a cache-row refresh, not an LLM call. The comprehensive write no
 * longer evicts the per-status rows, so there is nothing to force-refill;
 * a second locale (e.g. an English iOS client against a German account)
 * warms lazily through the read-path enqueue on its first visit.
 *
 * Runs once nightly at 04:30 Europe/Berlin — inside the existing
 * 03:xx–04:xx maintenance window, after the feedback aggregator (04:00)
 * and the cumulative drain (03:30) so the late-night CPU profile stays
 * coherent.
 *
 * Budget gate (R-firstpaint §6 tertiary risk): a nightly fan-out across
 * every user could spike provider cost. Two layers guard it:
 *   1. A per-user rate-limit bucket (`insight-pregenerate:${userId}`,
 *      1 generation / 20 h) so the cron can never double-generate a
 *      user the on-demand route already refreshed today.
 *   2. A hard per-run batch cap (`PREGENERATE_BATCH_CAP`) so a single
 *      tick processes at most N users; the discovery query is ordered
 *      oldest-cache-first so the staleest users are served first and
 *      the long tail catches up over successive nights.
 *
 * The discovery query selects only users that are worth a generation:
 * coach surface enabled (`disableCoach = false`) AND a stale-or-missing
 * cache (`insightsCachedAt IS NULL OR < now - PREGENERATE_STALE_MS`,
 * see the constant for why that window is one hour). Whether the user
 * has a configured provider is confirmed inside
 * `generateComprehensiveInsight` (returns `skipped: no-provider`), so a
 * provider-less account costs one cheap chain-resolve and no LLM call.
 *
 * Recurring pg-boss task — never runs inside an HTTP request and never
 * shells out to `tsx` (CLAUDE.md DO-NOTs).
 */
import { createHash, randomUUID } from "node:crypto";
import pLimit from "p-limit";

import type { PrismaClient } from "@/generated/prisma/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { getAssistantFlags } from "@/lib/feature-flags";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { logCaught } from "@/lib/logging/signal";
import {
  reportJobRun,
  type JobRunCandidate,
  type JobRunOutcome,
} from "@/lib/jobs/job-run-report";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { userIdsWithModuleOff } from "@/lib/jobs/ai-job-candidates";
import type { SupportedLocale } from "@/lib/insights/status-shared";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import {
  generateComprehensiveInsight,
  type GenerateOutcome,
} from "@/lib/insights/comprehensive-generate";
import { generateStatusBatchForUser } from "@/lib/insights/status-batch";
import { withFeatureCacheScope } from "@/lib/insights/feature-cache";
import { generateMetricStatus } from "@/lib/insights/metric-status";
import {
  METRIC_STATUS_IDS,
  getMetricStatusMeta,
  type MetricStatusMetricId,
} from "@/lib/insights/metric-status-registry";
import { withTimeout } from "@/lib/insights/with-timeout";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { resolveEffectiveTimeoutMs } from "@/lib/ai/effective-timeout";
import {
  INSIGHT_PREGENERATE_QUEUE,
  enqueueForceWarm,
  enqueuePregenerateFailureRetry,
  type InsightPregeneratePayload,
} from "@/lib/jobs/insight-pregenerate-shared";

export { INSIGHT_PREGENERATE_QUEUE, enqueueForceWarm };
export type { InsightPregeneratePayload };

/**
 * 04:30 Europe/Berlin. Slots between the cumulative drain (03:30) and
 * the feedback aggregator (04:00) maintenance window's tail so the
 * LLM-bound pass doesn't contend with the SQL-bound nightly folds.
 */
export const INSIGHT_PREGENERATE_CRON = "30 4 * * *";

/** Stale-cache threshold for the nightly discovery pass.
 *
 * The cron runs every 24 h and the advisor cache lives 24 h — so ANY
 * cache not written within the last hour will expire before the next
 * nightly tick, i.e. at some point during the user's day. The previous
 * 20 h threshold structurally excluded every evening visitor: a visit
 * at ~19:50 stamps `insightsCachedAt`, the 04:30 run sees a ~9 h-old
 * cache and skips, and the cache then expires at ~19:50 the next day —
 * exactly when the user returns. That recreated the on-visit warm storm
 * (comprehensive feature extraction + the full per-card warm pass in
 * the request-serving process) every single evening, which is what the
 * nightly pass exists to prevent. One hour keeps the only sensible
 * skip: a cache the on-demand path generated minutes before the tick.
 */
export const PREGENERATE_STALE_MS = 60 * 60 * 1000;

/** Per-run cap on the number of users a single tick generates for. */
export const PREGENERATE_BATCH_CAP = 200;

/** Per-user budget bucket window — one pre-generation per 20 h. */
const PREGENERATE_BUDGET_WINDOW_MS = 20 * 60 * 60 * 1000;

/**
 * v1.16.8 — freshness re-check for the forced single-user warm. The
 * enqueue side already de-dupes via `singletonKey`, but a poll horizon
 * that outlives the singleton window can stack several force jobs back
 * to back; re-checking `insightsCachedAt` at job start collapses the
 * stack into one real warm.
 */
export const FORCE_WARM_FRESH_MS = 60 * 60 * 1000;

/**
 * v1.16.8 — backoff after a failed / timed-out forced comprehensive.
 * While `insightsWarmFailedAt` is younger than this, the forced path
 * skips the comprehensive attempt instead of re-driving a broken
 * provider chain on every page-open. The nightly tick (its own budget
 * bucket) and the user's manual regenerate are unaffected.
 */
export const FORCE_WARM_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/**
 * v1.16.8 — daily cap on forced full warms. At most two forced
 * comprehensive attempts per user per rolling 24 h; the nightly tick
 * rides its own 20 h bucket, so a capped user still gets the overnight
 * refresh. Reuses the Postgres rate-limit bucket mechanism.
 */
export const FORCE_WARM_DAILY_LIMIT = 2;
const FORCE_WARM_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Concurrency for the per-user warm pass. The seven `*StatusForUser`
 * generators are independent (each writes its own cache row), so they run
 * a few at a time rather than strictly serially — a daily-weigher with
 * every card configured was paying ~7× one LLM round-trip per user back
 * to back. Capped low (3) so the warm pass cannot saturate the Prisma
 * pool or fan out an unbounded number of concurrent provider calls; the
 * per-user budget gate above still bounds total cost per night.
 */
const WARM_PASS_CONCURRENCY = 3;

/**
 * Bounded budget for one comprehensive generation inside a warm pass —
 * the forced single-user warm AND the nightly per-candidate loop. The
 * comprehensive insight is the single heaviest generation (full feature
 * extraction + a 1500-token completion) and a slow or stalled provider
 * could pin the whole warm for a minute-plus, after which the entire job
 * aborted with the per-status + generic-metric passes never run. Capping
 * it lets both paths abandon a slow comprehensive and still warm the
 * cheaper per-status (7) + generic-metric (~30) assessments, so the user's
 * cards are warm even when the briefing generation stalls. In the nightly
 * loop the cap also bounds head-of-line blocking: without it one stalled
 * provider pinned the whole batch behind a single candidate. Set a hair
 * below the queue's own retry horizon so a single tick stays bounded.
 *
 * v1.21.5 — raised from 45 s. The old cap sat BELOW the provider call's own
 * timeout (`AI_BUDGETS.comprehensive.timeoutMs`, now 120 s), so on a large
 * account the warm bound — not the provider — aborted the generation, and the
 * briefing never landed. The cap must sit just above the provider timeout so
 * the provider's own abort governs a genuine completion while this stays the
 * backstop against a wedged call. The per-user budget gate + the WARM_PASS
 * concurrency cap still bound total nightly cost.
 *
 * v1.25.3 — the cap is no longer a fixed constant. The per-user
 * `User.aiResponseTimeoutSeconds` setting (bounded 10–600 s at write-time) is
 * the operator's lever for slow self-hosted / local backends, and the AI
 * settings UI tells users to RAISE it for a model that loads slowly. The old
 * fixed 130 s cap sat below the upper end of that range, so any account whose
 * response timeout was ≥ ~130 s had every comprehensive warm clipped by the
 * warm bound — not the provider — before the generation could land, leaving the
 * briefing on its hard empty state. The warm budget now derives from the
 * resolved effective per-request timeout plus a fixed headroom for feature
 * extraction / prompt assembly / IO, so raising the response timeout actually
 * extends the warm/cron budget. A sane absolute ceiling (the 600 s write-time
 * maximum plus the same headroom) keeps a single wedged call from pinning the
 * worker forever, while staying ABOVE the largest value a user can configure.
 */

/**
 * Fixed slack added on top of the resolved upstream provider timeout when
 * sizing the warm/cron outer abort: bounded-feature extraction, prompt
 * assembly, and the cache write all run inside the warm wrapper but outside the
 * single provider round-trip the response-timeout governs.
 */
const COMPREHENSIVE_WARM_HEADROOM_MS = 30_000;

/**
 * Largest value `User.aiResponseTimeoutSeconds` accepts (see the 10–600 s
 * write-time bound in `POST /api/user/ai-provider`), in ms. The warm ceiling is
 * derived from it so the ceiling is always ABOVE the maximum a user can set.
 */
const AI_RESPONSE_TIMEOUT_MAX_MS = 600_000;

/**
 * Absolute backstop on the warm outer abort. A misconfigured 600 s response
 * timeout still cannot pin the worker beyond this; the ceiling sits above the
 * write-time maximum (by exactly the headroom) so a legitimate 600 s setting is
 * honoured rather than silently clipped.
 */
const COMPREHENSIVE_WARM_CEILING_MS =
  AI_RESPONSE_TIMEOUT_MAX_MS + COMPREHENSIVE_WARM_HEADROOM_MS;

/**
 * Outer-abort budget (ms) for one comprehensive warm, derived from the user's
 * resolved effective upstream timeout. `effectiveTimeoutMs + headroom`, clamped
 * to the absolute ceiling. A null/unset setting falls back to the comprehensive
 * surface budget (`AI_BUDGETS.comprehensive.timeoutMs`), so a default account
 * gets `120 s + headroom` rather than the old flat 130 s.
 */
export function comprehensiveWarmBudgetMs(
  aiResponseTimeoutSeconds: number | null | undefined,
): number {
  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
    aiResponseTimeoutSeconds,
    AI_BUDGETS.comprehensive.timeoutMs,
  );
  return Math.min(
    effectiveTimeoutMs + COMPREHENSIVE_WARM_HEADROOM_MS,
    COMPREHENSIVE_WARM_CEILING_MS,
  );
}

/**
 * Short, redaction-safe error description for the failure annotations
 * below. The central egress redaction (`redactSecrets` in the
 * WideEventBuilder) is the safety net; keeping the excerpt short bounds
 * the event size and avoids echoing whole provider bodies.
 */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "unknown");
  return message.slice(0, 240);
}

/** Per-user result of one forced full warm. */
export interface ForceWarmResult {
  /**
   * Outcome of the comprehensive-insight generation. `"timeout"` is
   * distinct from `"failed"`: the comprehensive step exceeded its own
   * bounded budget (see `comprehensiveWarmBudgetMs`) and was
   * abandoned so the per-status + generic-metric passes could still run.
   *
   * v1.16.8 — three pre-flight outcomes that never reach the generator:
   * `"fresh"` (the cache was warmed within `FORCE_WARM_FRESH_MS`),
   * `"backoff"` (a forced attempt failed within
   * `FORCE_WARM_FAILURE_BACKOFF_MS`), and `"capped"` (the per-user daily
   * forced-warm budget is exhausted). All three still run the refill-only
   * card warm below.
   */
  comprehensive:
    GenerateOutcome["status"] | "timeout" | "fresh" | "backoff" | "capped";
  /** Count of specialised per-status assessments written warm. */
  assessmentsWarmed: number;
  /** Count of generic per-HealthKit-metric assessments written warm. */
  metricAssessmentsWarmed: number;
}

export interface PregenerateRunResult {
  total: number;
  generated: number;
  cached: number;
  /**
   * v1.16.8 — comprehensives whose content-hash gate found the feature
   * snapshot unchanged: timestamp refreshed, no provider call.
   */
  unchanged: number;
  skipped: number;
  failed: number;
  budgetBlocked: number;
  /** The job's time budget ran out before every candidate was reached. */
  stoppedEarly: boolean;
  /**
   * v1.42 — every candidate the run attempted failed (see `reportJobRun`).
   * Written into the job's facts as `all_failed`, which is how a completed
   * night with nothing generated still counts toward the repeated-failure
   * streak.
   */
  allFailed: boolean;
  /**
   * Count of per-metric assessment caches written warm across the whole
   * run. The comprehensive generator evicts the seven `*-status`
   * caches as part of its write (so a stale comprehensive insight can't
   * leave a stale per-metric card), but it does not re-fill them — so
   * without this warm pass the first morning visit after the cron runs
   * one live status generation per card. This counts the warm writes.
   */
  assessmentsWarmed: number;
  /**
   * v1.8.7.1 — count of generic per-HealthKit-metric assessment caches
   * written warm across the run (the ~30 metric pages, data-bearing
   * only). Tracked separately from `assessmentsWarmed` so the nightly
   * dashboard can see the generic-tier coverage independently of the
   * seven specialised cards.
   */
  metricAssessmentsWarmed: number;
}

/**
 * Signature for one per-metric status generator. The seven
 * `*StatusForUser` functions all share this shape: `(userId, { locale,
 * force }) => { hasProvider, text, cached, updatedAt }`. We only need to
 * know whether the call produced a fresh (non-cached, provider-backed)
 * assessment, so the warm-pass narrows to those two fields.
 */
type StatusGenerator = (
  userId: string,
  options: { locale: SupportedLocale; force?: boolean },
) => Promise<{ hasProvider: boolean; cached: boolean }>;

/**
 * Re-fill the per-metric assessment caches for one user. Refill-only
 * (`force: false`): a card already generated today short-circuits to its
 * cache row, and a cold card runs its generator — whose content-hash gate
 * (v1.16.8) skips the LLM and refreshes the row when the underlying data
 * did not change. Returns the count of fresh (provider-backed,
 * non-cached) assessments written. A generator that has no provider or
 * fails serves its fallback without persisting it, so it does not count
 * toward the warmed tally and never throws the batch loop off course.
 *
 * `locales` carries only the user's resolved locale (v1.16.8). The old
 * dual-locale warm existed because the comprehensive write evicted every
 * locale family at once; that eviction is gone, and a second locale the
 * user actually reads (e.g. an English client against a German account)
 * warms lazily through `resolveReadOnlyStatusMiss`'s enqueue on its
 * first cache-miss read.
 */
async function warmPerStatusCaches(
  userId: string,
  locales: ReadonlyArray<SupportedLocale>,
  generators: ReadonlyArray<StatusGenerator>,
): Promise<number> {
  const limit = pLimit(WARM_PASS_CONCURRENCY);
  const tasks = generators.flatMap((generate) =>
    locales.map((locale) =>
      limit(async () => {
        try {
          const outcome = await generate(userId, { locale, force: false });
          return outcome.hasProvider && !outcome.cached ? 1 : 0;
        } catch (err) {
          // A single card's generation failing must not abort the rest of
          // the warm pass for this user, nor the cron's user loop — but it
          // must not be invisible either: a warn line under one action, so a
          // failing card is diagnosable from one grep instead of a silent zero.
          logCaught("insights.pregenerate.warm_failed", err, {
            stage: "status-card",
            locale,
          });
          return 0;
        }
      }),
    ),
  );
  const results = await Promise.all(tasks);
  return results.reduce((sum: number, n) => sum + n, 0);
}

/**
 * v1.18.7 (HIGH-1) — the production warm for the seven specialised status
 * cards. `generateStatusBatchForUser` builds the seven per-metric snapshots
 * once and issues ONE provider call for the metrics still needing the LLM,
 * fanning the response back into the same per-metric cache rows the
 * standalone generators wrote. Replaces the prior seven independent warm
 * calls. Returns the count of metrics that got a fresh (batched or
 * fallback) assessment so the wide-event tally is comparable to the old
 * per-card count.
 *
 * Refill-only (`force: false`): a card already generated today and a card
 * whose content-hash is unchanged both resolve inside the batch as `served`
 * (no provider call). A single batch failure degrades each metric to its own
 * single-card path rather than aborting the warm.
 */
async function warmStatusBatch(
  userId: string,
  locales: ReadonlyArray<SupportedLocale>,
): Promise<number> {
  let warmed = 0;
  for (const locale of locales) {
    try {
      const result = await generateStatusBatchForUser(userId, {
        locale,
        force: false,
      });
      warmed += result.batched + result.fellBack;
    } catch (err) {
      // The batch must never throw the cron's user loop off course — but
      // a swallowed batch failure left ~7 cards cold with zero signal.
      logCaught("insights.pregenerate.warm_failed", err, {
        stage: "status-batch",
        locale,
      });
    }
  }
  return warmed;
}

/**
 * v1.8.7.1 — warm the generic per-HealthKit-metric assessment caches for
 * one user, but ONLY for metrics that have data. A single grouped count
 * answers "which metric types does this user have readings for?" in one
 * query, so the cron never burns a (cheap) per-metric count nor (costly)
 * an LLM call on a metric the user has never logged. The generic
 * generator's own empty-data guard is the second line of defence, but the
 * up-front filter keeps the cron from forcing ~30 metric generators per
 * user when most have no data.
 *
 * Returns the count of fresh provider-backed assessments written.
 */
async function warmGenericMetricCaches(
  prisma: PrismaClient,
  userId: string,
  locales: ReadonlyArray<SupportedLocale>,
): Promise<number> {
  // One distinct read: the set of MeasurementTypes the user has live
  // rows for. Best-effort — a read failure (or a worker prisma surface
  // without `measurement`) yields zero metrics rather than aborting the
  // user's whole pre-generation loop.
  let typesWithData: ReadonlySet<string>;
  try {
    // `groupBy` compiles to a server-side `GROUP BY` — Prisma's
    // `distinct` dedups in the client AFTER pulling every live row, which
    // on a dense multi-year account walks a six-figure row set nightly to
    // answer "which types exist?".
    const rows = await prisma.measurement.groupBy({
      by: ["type"],
      where: { userId, deletedAt: null },
      orderBy: { type: "asc" },
    });
    typesWithData = new Set(rows.map((r) => r.type));
  } catch (err) {
    // Best-effort discovery — but a silently-failing grouped read used to
    // zero out the whole generic warm with no trace.
    logCaught("insights.pregenerate.warm_failed", err, {
      stage: "metric-discovery",
    });
    return 0;
  }

  const metricsWithData = METRIC_STATUS_IDS.filter(
    (id: MetricStatusMetricId) => {
      const meta = getMetricStatusMeta(id);
      return meta !== null && typesWithData.has(meta.measurementType);
    },
  );
  if (metricsWithData.length === 0) return 0;

  const limit = pLimit(WARM_PASS_CONCURRENCY);
  const tasks = metricsWithData.flatMap((metric) =>
    locales.map((locale) =>
      limit(async () => {
        try {
          // Refill-only (see `warmPerStatusCaches`): a today-cached card is
          // a cheap read; a cold card runs the generator, whose content-hash
          // gate skips the LLM when its data did not change.
          const outcome = await generateMetricStatus({
            metric,
            userId,
            locale,
            force: false,
          });
          // `insufficient` never reaches here (we pre-filtered to
          // metrics with data), but guard anyway: count only a fresh
          // provider-backed assessment.
          return outcome.hasProvider &&
            !outcome.cached &&
            outcome.insufficient !== true
            ? 1
            : 0;
        } catch (err) {
          logCaught("insights.pregenerate.warm_failed", err, {
            stage: "metric-card",
            metric,
            locale,
          });
          return 0;
        }
      }),
    ),
  );
  const results = await Promise.all(tasks);
  return results.reduce((sum: number, n) => sum + n, 0);
}

/**
 * A stable, non-identifying key for one candidate on the run's log line: a
 * short hash of the account id, enough to follow one account across nights
 * without naming it.
 */
function candidateKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

interface PregenerateCandidate {
  id: string;
  locale: string | null;
  /**
   * v1.25.3 — per-user response-timeout (seconds), feeds the warm outer
   * abort so a raised setting is not clipped by a fixed cap. Null = the
   * comprehensive surface default.
   */
  aiResponseTimeoutSeconds: number | null;
}

/**
 * Discovery query — users with AI analysis on (the `insights` module) and a
 * stale or missing comprehensive-insight cache, oldest-cache-first so the
 * staleest users are served before the per-run cap bites. Hiding the Coach
 * no longer excludes anyone: it hides the Coach and nothing else. Exported
 * so the cron test can pin the WHERE shape without a live LLM.
 */
export async function findPregenerateCandidates(
  prisma: PrismaClient,
  now: Date,
  cap: number,
): Promise<PregenerateCandidate[]> {
  const staleBefore = new Date(now.getTime() - PREGENERATE_STALE_MS);
  const optedOut = await userIdsWithModuleOff(prisma, "insights");
  return prisma.user.findMany({
    where: {
      ...(optedOut.length > 0 ? { id: { notIn: optedOut } } : {}),
      OR: [
        { insightsCachedAt: null },
        { insightsCachedAt: { lt: staleBefore } },
      ],
    },
    // nulls-first is the default ascending order in Postgres, so
    // never-generated users sort ahead of merely-stale ones.
    orderBy: { insightsCachedAt: "asc" },
    take: cap,
    // v1.25.3 — carry the per-user response-timeout so the warm outer abort
    // scales with the operator's setting instead of a fixed cap.
    select: { id: true, locale: true, aiResponseTimeoutSeconds: true },
  });
}

/**
 * Run one pre-generation pass. Pure of pg-boss so the unit test can
 * drive it directly. The master assistant kill-switch short-circuits
 * the whole run (no candidate generation when the operator disabled the
 * coach surface globally). Per-user budget gate runs BEFORE the LLM
 * call so a no-op night costs only rate-limit upserts.
 */
export async function runInsightPregenerate(
  prisma: PrismaClient,
  options: {
    now?: Date;
    cap?: number;
    /** Injected for the test — defaults to the real generator. */
    generate?: (
      userId: string,
      opts: { locale: SupportedLocale; force?: boolean; signal?: AbortSignal },
    ) => Promise<GenerateOutcome>;
    /** Injected for the test — defaults to the seven real status generators. */
    statusGenerators?: ReadonlyArray<StatusGenerator>;
    /**
     * v1.8.7.1 — injected for the test. Defaults to the real generic
     * metric warm pass; the test stubs it to assert it runs only for
     * data-bearing metrics without a live LLM.
     */
    warmGenericMetrics?: (
      userId: string,
      locales: ReadonlyArray<SupportedLocale>,
    ) => Promise<number>;
    /**
     * v1.28.30 — injected for the test. Defaults to the real delayed
     * single-user retry enqueue; fired once per candidate whose
     * comprehensive warm failed so a transient nightly provider hiccup
     * heals within the day instead of waiting for the next tick.
     */
    enqueueRetry?: (payload: {
      userId: string;
      locale: SupportedLocale;
    }) => Promise<void>;
    /**
     * The job's time budget (`jobBudget`). Checked between candidates: a pass
     * of 200 provider calls can outlast its job, and the candidates it does
     * not reach are the stalest again tomorrow, so they lead the next pass.
     */
    shouldStop?: () => boolean;
    /** Injected for the test — defaults to the real run report. */
    reportRun?: typeof reportJobRun;
  } = {},
): Promise<PregenerateRunResult> {
  const now = options.now ?? new Date();
  const cap = options.cap ?? PREGENERATE_BATCH_CAP;
  const generate = options.generate ?? generateComprehensiveInsight;
  const enqueueRetry = options.enqueueRetry ?? enqueuePregenerateFailureRetry;
  const reportRun = options.reportRun ?? reportJobRun;
  // v1.18.7 (HIGH-1) — when the caller injects its own `statusGenerators`
  // (the unit tests do), keep the per-card warm so those assertions hold;
  // production injects nothing, so the seven warm calls collapse into ONE
  // batched generation. The injected per-card path stays the test seam.
  const injectedStatusGenerators = options.statusGenerators;
  const warmStatus = (
    userId: string,
    locales: ReadonlyArray<SupportedLocale>,
  ) =>
    injectedStatusGenerators
      ? warmPerStatusCaches(userId, locales, injectedStatusGenerators)
      : warmStatusBatch(userId, locales);
  const warmGenericMetrics =
    options.warmGenericMetrics ??
    ((userId: string, locales: ReadonlyArray<SupportedLocale>) =>
      warmGenericMetricCaches(prisma, userId, locales));

  const result: PregenerateRunResult = {
    total: 0,
    generated: 0,
    cached: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    budgetBlocked: 0,
    stoppedEarly: false,
    allFailed: false,
    assessmentsWarmed: 0,
    metricAssessmentsWarmed: 0,
  };

  // Master kill-switch — when the operator disabled the briefing
  // surface globally there is nothing to pre-generate.
  const flags = await getAssistantFlags();
  if (!flags.briefing) return result;

  const candidates = await findPregenerateCandidates(prisma, now, cap);
  result.total = candidates.length;

  // v1.42 — one outcome per candidate, reported together at the end of the
  // run (`reportJobRun`). Each candidate also runs inside its own wide event,
  // so what one account's generation annotates (the provider chain's hops,
  // the failure cause) lands on that account's line instead of overwriting
  // the run's: the run used to read `all-failed` whenever the LAST account
  // failed, on nights where the others had worked.
  const runId = randomUUID();
  const runOutcomes: JobRunCandidate[] = [];

  for (const [index, candidate] of candidates.entries()) {
    if (options.shouldStop?.()) {
      result.stoppedEarly = true;
      // The rest are the stalest again tomorrow; they lead the next pass.
      for (const rest of candidates.slice(index)) {
        runOutcomes.push({
          key: candidateKey(rest.id),
          outcome: "deferred",
          cause: "job_budget",
        });
      }
      break;
    }
    const key = candidateKey(candidate.id);
    const outcome = await withBackgroundEvent(
      "job.insight_pregenerate.candidate",
      (evt) =>
        withFeatureCacheScope(() => pregenerateCandidate(candidate, key, evt)),
    );
    runOutcomes.push(outcome);
  }

  // Wide-event tally so the nightly dashboard can track how many
  // comprehensive insights and per-metric assessments each tick wrote.
  annotate({
    action: { name: "insights.pregenerate.run" },
    meta: {
      total: result.total,
      generated: result.generated,
      cached: result.cached,
      unchanged: result.unchanged,
      skipped: result.skipped,
      failed: result.failed,
      budget_blocked: result.budgetBlocked,
      stopped_early: result.stoppedEarly,
      assessments_warmed: result.assessmentsWarmed,
      metric_assessments_warmed: result.metricAssessmentsWarmed,
    },
  });
  const verdict = await reportRun({
    queue: INSIGHT_PREGENERATE_QUEUE,
    runId,
    candidates: runOutcomes,
  });
  result.allFailed = verdict.allFailed;

  return result;

  /**
   * One candidate's whole pass: capabilities, the budget gate, the bounded
   * comprehensive generation and the refill-only card warm. Returns how the
   * candidate ended for the run report; never throws for a provider failure
   * (those are outcomes), only for something unexpected, which aborts the
   * run as it always did.
   */
  async function pregenerateCandidate(
    candidate: PregenerateCandidate,
    key: string,
    evt: { elevateLevel(level: "warn"): unknown },
  ): Promise<JobRunCandidate> {
    annotate({ meta: { candidate: key, run_id: runId } });
    const state: { outcome: JobRunOutcome; cause?: string } = {
      outcome: "ok",
    };
    const settle = (outcome: JobRunOutcome, cause?: string) => {
      state.outcome = outcome;
      state.cause = cause;
    };

    // The two capabilities this pass serves, resolved before any snapshot
    // or rate-limit write: the briefing for the comprehensive insight, the
    // status notes for the per-metric warm. Each half runs only when its
    // own capability is available; the chokepoints re-check at the wire.
    const [briefing, statusText] = await Promise.all([
      aiCapabilityForJob(candidate.id, "briefing"),
      aiCapabilityForJob(candidate.id, "statusText"),
    ]);
    if (!briefing.available && !statusText.available) {
      result.skipped++;
      annotate({
        action: { name: "insights.pregenerate.skipped" },
        meta: {
          briefing: briefing.reason,
          status_text: statusText.reason,
        },
      });
      return {
        key,
        outcome: "skipped",
        cause: briefing.reason ?? "unavailable",
      };
    }

    // Budget gate — one COMPREHENSIVE pre-generation per user per 20 h.
    // The route's on-demand path uses a different bucket
    // (`insights:${userId}`), so this never starves a user's manual
    // regenerate quota. The gate bounds the comprehensive cost only: a
    // blocked user still gets the refill-only status warm below, because
    // the 02:xx status crons already skipped every pregenerate candidate
    // on the assumption that THIS pass warms their cards — exiting early
    // here left those cards cold until the first on-visit generation.
    const budget = briefing.available
      ? await checkRateLimit(
          `insight-pregenerate:${candidate.id}`,
          1,
          PREGENERATE_BUDGET_WINDOW_MS,
        )
      : null;

    // The stored locale, then the operator default: a NULL column used to
    // resolve to English here, so a German-language instance warmed its
    // briefings in English every night.
    const locale = await resolveJobLocale(candidate.locale);
    if (budget === null) {
      result.skipped++;
      settle("skipped", briefing.reason ?? "briefing_unavailable");
      annotate({
        action: { name: "insights.pregenerate.skipped" },
        meta: { briefing: briefing.reason },
      });
    } else if (!budget.allowed) {
      result.budgetBlocked++;
      settle("skipped", "budget_blocked");
    } else {
      // Force a fresh generation: the discovery window (20 h) is shorter
      // than the generator's 24 h cache TTL, so without `force` a user
      // whose cache is 20–24 h old would be discovered, consume the
      // budget bucket, then short-circuit to `cached` with no actual
      // pre-generation — defeating the "warm the cache before the user's
      // morning visit" intent for the common case. The per-user budget
      // bucket (above) bounds attempts, and the generator's content-hash
      // gate (v1.16.8) turns a same-data force into a timestamp refresh
      // (`unchanged`) with no provider call.
      //
      // Bounded budget + abort (v1.16.1): one stalled provider must not
      // pin the whole batch behind a single candidate, and `withTimeout`
      // alone cannot cancel the detached generation — without the abort a
      // late resolve would still write a cache row + timestamp after the
      // loop moved on (the same race the forced single-user warm closes).
      const controller = new AbortController();
      // v1.25.3 — size the outer abort from the candidate's resolved
      // response-timeout so a raised setting extends the warm budget
      // instead of being clipped by a fixed cap.
      const warmBudgetMs = comprehensiveWarmBudgetMs(
        candidate.aiResponseTimeoutSeconds,
      );
      // Capture the rejection so the failure annotation can carry the
      // actual error text — `withTimeout` folds a rejection into a bare
      // `errored: true` envelope, which made the cause undiagnosable.
      let thrown: unknown = null;
      const bounded = await withTimeout(
        () =>
          generate(candidate.id, {
            locale,
            force: true,
            signal: controller.signal,
          }).catch((err: unknown) => {
            thrown = err;
            throw err;
          }),
        warmBudgetMs,
        null,
        () => controller.abort(),
      );
      if (bounded.timedOut || bounded.errored || bounded.value === null) {
        result.failed++;
        const boundCause = bounded.timedOut
          ? "timeout"
          : bounded.errored
            ? "error"
            : "null";
        settle("failed", boundCause);
        // v1.21.5 — make the warm failure queryable. The nightly loop used to
        // bump `failed` with no annotation, so a candidate whose comprehensive
        // generation timed out (e.g. the briefing clipped at the old 45 s
        // bound) left the cached block empty AND emitted nothing greppable.
        // v1.28.30 — carry the stage + error text so ONE grep on
        // `comprehensive_failed` names the failing catch and its cause.
        annotate({
          action: { name: "insights.pregenerate.comprehensive_failed" },
          meta: {
            locale,
            stage: "nightly.bound",
            cause: boundCause,
            budget_ms: warmBudgetMs,
            message: thrown === null ? null : describeError(thrown),
          },
        });
        // v1.28.30 — bounded intra-day retry: one delayed forced warm for
        // just this user, so a transient 04:30 provider hiccup heals
        // before the morning visit instead of waiting for the next night.
        await enqueueRetry({ userId: candidate.id, locale });
      } else {
        const generated = bounded.value;
        switch (generated.status) {
          case "generated":
          case "rerolled":
            result.generated++;
            break;
          case "cached":
            result.cached++;
            break;
          case "unchanged":
            result.unchanged++;
            break;
          case "skipped":
            result.skipped++;
            settle("skipped", generated.reason);
            break;
          case "failed":
            result.failed++;
            // v1.28.30 — THE previously-silent failure path. A generator
            // that resolves with `{ status: "failed" }` (features error,
            // oversize payload, invalid JSON after retry, abort) bumped
            // the tally with no annotation at all — the nightly summary
            // showed `failed: 1` and nothing else was greppable. Reuse
            // the `comprehensive_failed` shape with the generator's own
            // reason as the cause.
            annotate({
              action: { name: "insights.pregenerate.comprehensive_failed" },
              meta: {
                locale,
                stage: "nightly.generator",
                cause: `generator:${generated.reason}`,
                budget_ms: warmBudgetMs,
                message: null,
              },
            });
            if (generated.reason === "outbound-screened") {
              // v1.42 — the model answered and the safety screen withheld
              // it, after the generator's own repair. Asking the same model
              // again in 45 minutes is not a provider retry; it is the same
              // question, and it was screened eight times a night.
              settle("screened", generated.reason);
            } else if (generated.credentialExpired) {
              // v1.42 — a dead sign-in (a Codex refresh token the issuer
              // revoked) does not heal in 45 minutes either; the person has
              // to reconnect, and the ledger already tells them so.
              settle("auth_failed", generated.reason);
            } else {
              settle("failed", generated.reason);
              await enqueueRetry({ userId: candidate.id, locale });
            }
            break;
        }
      }
    }

    // Warm the per-metric assessment caches — refill-only, single locale
    // (v1.16.8). The comprehensive write no longer evicts the per-status
    // rows, so there is nothing to force-refill: a card already generated
    // today is a cheap cache read, a cold card runs its generator, and the
    // generator's content-hash gate turns a same-data regeneration into a
    // timestamp refresh with no provider call. The warm runs on every
    // comprehensive outcome (budget-blocked, failed, timed-out,
    // consent-skipped included) because the 02:xx status crons skip every
    // pregenerate candidate on the assumption that THIS pass covers them.
    //
    // Nothing to warm when the status notes themselves are unavailable.
    if (!statusText.available) {
      annotate({
        action: { name: "insights.pregenerate.status_skipped" },
        meta: { reason: statusText.reason },
      });
    } else {
      result.assessmentsWarmed += await warmStatus(candidate.id, [locale]);
      // v1.8.7.1 — warm the generic per-HealthKit-metric caches too, for
      // the user's data-bearing metrics only (the helper filters via one
      // grouped count, so an empty metric never reaches the provider).
      result.metricAssessmentsWarmed += await warmGenericMetrics(candidate.id, [
        locale,
      ]);
    }

    const final = state.outcome;
    if (final === "failed" || final === "auth_failed" || final === "screened") {
      evt.elevateLevel("warn");
    }
    annotate({
      meta: { outcome: final, ...(state.cause ? { cause: state.cause } : {}) },
    });
    return {
      key,
      outcome: final,
      ...(state.cause ? { cause: state.cause } : {}),
    };
  }
}

/**
 * v1.8.7.1 — forced full warm for ONE user, on demand.
 *
 * Runs the same pipeline the nightly tick runs per candidate — the
 * comprehensive insight (which carries the daily briefing), the seven
 * specialised `*-status` assessments, and every data-bearing generic
 * `metric:<ID>` assessment — but for a single explicit `userId` and
 * WITHOUT the per-user 20 h budget bucket. The forced path carries its
 * own bounds instead (v1.16.8): a freshness re-check at job start, an
 * hour of backoff after a failed attempt, and a daily cap of
 * `FORCE_WARM_DAILY_LIMIT` forced comprehensive attempts — on top of the
 * enqueuing endpoint's short anti-spam rate-limit.
 *
 * Safety is preserved by the helpers it reuses, not by a budget gate:
 *   - The comprehensive generator no-ops to `{ status: "skipped" }` when
 *     no provider is configured (no LLM call).
 *   - `warmGenericMetricCaches` filters to metrics the user has rows for
 *     via one grouped read, so an empty metric never reaches the provider.
 *   - Each generator is idempotent — re-running it just rewrites the same
 *     cache row; concurrent enqueues collapse via the queue
 *     `singletonKey`, and the content-hash gates collapse a same-data
 *     re-run into a timestamp refresh.
 *
 * Like the nightly cron (v1.16.8), the forced path warms ONLY the
 * caller's resolved locale — the cross-locale per-status eviction that
 * once required dual-locale refills is gone, and a second locale a user
 * actually reads warms lazily through the read-path enqueue.
 *
 * The three sections are decoupled: the comprehensive step runs under its
 * own bounded budget (`comprehensiveWarmBudgetMs`) and its
 * failure / timeout / skip is non-fatal — the per-status (7) and
 * generic-metric (~30) warm passes ALWAYS run afterwards. The earlier
 * design short-circuited both passes on a non-`generated`/`cached`
 * comprehensive, so a single slow briefing generation left every card cold
 * and the user back on the lazy 30–60 s on-first-click path. The per-card
 * generators each resolve their own provider chain and bound their own
 * provider call, so a missing provider costs a cheap chain-resolve and a
 * degraded one is capped per card — running them after a failed
 * comprehensive can never multiply a stall. The result reports each
 * section's outcome independently so a partial warm is observable.
 */
export async function forceWarmUser(
  prisma: PrismaClient,
  userId: string,
  locale: SupportedLocale,
  options: {
    generate?: (
      userId: string,
      opts: { locale: SupportedLocale; force?: boolean; signal?: AbortSignal },
    ) => Promise<GenerateOutcome>;
    statusGenerators?: ReadonlyArray<StatusGenerator>;
    warmGenericMetrics?: (
      userId: string,
      locales: ReadonlyArray<SupportedLocale>,
    ) => Promise<number>;
    /** Injected for the test — defaults to `new Date()`. */
    now?: Date;
    /**
     * A briefing-for-today warm (`enqueueTodayBriefingWarm`): the
     * comprehensive briefing only, past the one-hour freshness gate. The
     * failure backoff, the daily forced-warm cap and the generation's own
     * content-hash gate still hold, so a warm with nothing new to read
     * costs no provider call.
     */
    today?: boolean;
  } = {},
): Promise<ForceWarmResult> {
  // v1.18.11 P3 — one feature-cache scope for the whole forced warm of this
  // user, so the comprehensive briefing's bounded feature read is computed
  // once and reused by any sibling consumer in the same warm.
  return withFeatureCacheScope(async () => {
    const generate = options.generate ?? generateComprehensiveInsight;
    // v1.18.7 (HIGH-1) — batch the seven status warms into ONE provider call
    // in production; keep the per-card path when a test injects generators.
    const injectedStatusGenerators = options.statusGenerators;
    const warmStatus = (
      userId: string,
      locales: ReadonlyArray<SupportedLocale>,
    ) =>
      injectedStatusGenerators
        ? warmPerStatusCaches(userId, locales, injectedStatusGenerators)
        : warmStatusBatch(userId, locales);
    const warmGenericMetrics =
      options.warmGenericMetrics ??
      ((id: string, locales: ReadonlyArray<SupportedLocale>) =>
        warmGenericMetricCaches(prisma, id, locales));
    const now = options.now ?? new Date();

    const result: ForceWarmResult = {
      comprehensive: "skipped",
      assessmentsWarmed: 0,
      metricAssessmentsWarmed: 0,
    };

    // Each section runs on its own capability, resolved for this user under
    // the job's authority: the comprehensive briefing on `briefing`, the
    // per-status and generic-metric notes on `statusText`. One unavailable
    // half never suppresses the other; both unavailable makes the job a
    // no-op before any snapshot is built.
    const [briefing, statusText] = await Promise.all([
      aiCapabilityForJob(userId, "briefing"),
      aiCapabilityForJob(userId, "statusText"),
    ]);
    if (!briefing.available && !statusText.available) {
      annotate({
        action: { name: "insights.pregenerate.force.skipped" },
        meta: { briefing: briefing.reason, status_text: statusText.reason },
      });
      return result;
    }

    // v1.16.8 — warm only the caller's resolved locale. The old dual-locale
    // warm compensated for the comprehensive write's cross-locale per-status
    // eviction; that eviction is gone, so the other locale family's rows
    // survive untouched and a client actually reading the second locale
    // warms it lazily through the read-path enqueue on its first miss.
    const locales: ReadonlyArray<SupportedLocale> = [locale];

    // The comprehensive step gets its own bounded budget and its failure is
    // non-fatal. A slow or stalled briefing generation must not short-circuit
    // the per-status + generic-metric passes — those are the ~37 cards the
    // user actually clicks first, and warming them is independent of the
    // comprehensive insight (each generator resolves its own provider chain
    // and writes its own cache row). A timeout / error / skipped comprehensive
    // falls through to the warm passes instead of aborting the whole job.
    //
    // On a timeout `withTimeout` cannot cancel the detached generation; without
    // a cut-off a late-resolving comprehensive would still write its cache row
    // + timestamp after the job moved on. Thread an AbortController so the
    // timeout aborts the generation before it can touch the cache.
    //
    // v1.16.8 — three pre-flight gates make the forced path idempotent and
    // bounded (the enqueue-side singleton alone cannot, because the client's
    // revalidation poll outlives any reasonable singleton window):
    //   1. freshness — a comprehensive warmed within the last hour is
    //      current; re-forcing it would at best re-discover an unchanged
    //      hash and at worst burn a generation on intra-day noise.
    //   2. failure backoff — a forced attempt that failed within the last
    //      hour stays failed for most causes (broken key, dead local
    //      endpoint); re-attempting on every page-open re-runs the full
    //      feature extraction + provider stall each time.
    //   3. daily cap — at most FORCE_WARM_DAILY_LIMIT forced attempts per
    //      rolling 24 h, so even a client bug that defeats 1+2 cannot turn
    //      the forced path into an unmetered generation loop.
    if (briefing.available) {
      let freshness: {
        insightsCachedAt: Date | null;
        insightsWarmFailedAt: Date | null;
        // v1.25.3 — feeds the warm outer abort (see comprehensiveWarmBudgetMs).
        aiResponseTimeoutSeconds: number | null;
      } | null = null;
      try {
        freshness = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            insightsCachedAt: true,
            insightsWarmFailedAt: true,
            aiResponseTimeoutSeconds: true,
          },
        });
      } catch (err) {
        logCaught("insights.pregenerate.force.preflight_failed", err);
        // Best-effort pre-flight — on a read failure fall through to the
        // budgeted generation attempt below.
      }

      const cachedAt = freshness?.insightsCachedAt ?? null;
      const failedAt = freshness?.insightsWarmFailedAt ?? null;
      const isFresh =
        !options.today &&
        cachedAt !== null &&
        now.getTime() - cachedAt.getTime() < FORCE_WARM_FRESH_MS;
      const inBackoff =
        !isFresh &&
        failedAt !== null &&
        now.getTime() - failedAt.getTime() < FORCE_WARM_FAILURE_BACKOFF_MS;

      if (isFresh) {
        result.comprehensive = "fresh";
        annotate({
          action: { name: "insights.pregenerate.force.fresh" },
          meta: { cached_at: cachedAt?.toISOString() ?? null },
        });
      } else if (inBackoff) {
        result.comprehensive = "backoff";
        annotate({
          action: { name: "insights.pregenerate.force.backoff" },
          meta: { failed_at: failedAt?.toISOString() ?? null },
        });
      } else {
        const budget = await checkRateLimit(
          `insight-pregenerate-daily:${userId}`,
          FORCE_WARM_DAILY_LIMIT,
          FORCE_WARM_DAILY_WINDOW_MS,
        );
        if (!budget.allowed) {
          result.comprehensive = "capped";
          annotate({
            action: { name: "insights.pregenerate.force.capped" },
            meta: { daily_limit: FORCE_WARM_DAILY_LIMIT },
          });
        } else {
          const controller = new AbortController();
          // v1.25.3 — size the outer abort from the user's resolved
          // response-timeout (read with the freshness gate above) so a raised
          // setting extends the warm budget instead of being clipped.
          const warmBudgetMs = comprehensiveWarmBudgetMs(
            freshness?.aiResponseTimeoutSeconds,
          );
          // v1.28.30 — capture the rejection for the failure annotation.
          let thrown: unknown = null;
          const comprehensive = await withTimeout(
            () =>
              generate(userId, {
                locale,
                force: true,
                signal: controller.signal,
              }).catch((err: unknown) => {
                thrown = err;
                throw err;
              }),
            warmBudgetMs,
            null,
            () => controller.abort(),
          );
          if (comprehensive.timedOut) {
            result.comprehensive = "timeout";
          } else if (comprehensive.errored || comprehensive.value === null) {
            result.comprehensive = "failed";
          } else {
            result.comprehensive = comprehensive.value.status;
          }
          // v1.28.30 — same queryable failure shape as the nightly loop, so
          // one grep on `comprehensive_failed` covers both entry points.
          if (
            result.comprehensive === "failed" ||
            result.comprehensive === "timeout"
          ) {
            annotate({
              action: { name: "insights.pregenerate.comprehensive_failed" },
              meta: {
                locale,
                stage: "force",
                cause: comprehensive.timedOut
                  ? "timeout"
                  : comprehensive.errored
                    ? "error"
                    : comprehensive.value === null
                      ? "null"
                      : `generator:${
                          comprehensive.value.status === "failed"
                            ? comprehensive.value.reason
                            : comprehensive.value.status
                        }`,
                budget_ms: warmBudgetMs,
                message: thrown === null ? null : describeError(thrown),
              },
            });
          }

          // Stamp / clear the failure marker for the backoff gate above. A
          // `skipped` outcome (no provider / no consent) is not a failure —
          // it costs nothing and should not delay a user who configures a
          // provider a minute later.
          const failed =
            result.comprehensive === "failed" ||
            result.comprehensive === "timeout";
          try {
            if (failed) {
              await prisma.user.update({
                where: { id: userId },
                data: { insightsWarmFailedAt: now },
              });
            } else if (failedAt !== null) {
              await prisma.user.update({
                where: { id: userId },
                data: { insightsWarmFailedAt: null },
              });
            }
          } catch (err) {
            logCaught("insights.pregenerate.force.marker_failed", err);
            // Marker maintenance is best-effort; never fail the warm on it.
          }
        }
      }
    }

    // Run the per-status + generic-metric warm passes whenever `statusText`
    // is available, regardless of the comprehensive
    // outcome. Each generator independently no-ops to its no-key fallback when
    // no provider is configured (no LLM call) and serves its fallback without
    // persisting on a per-card timeout, so running them after a failed
    // comprehensive is safe and bounded by their own per-card budgets. The only
    // outcome that has nothing to warm is a missing provider, and the
    // generators detect that themselves at near-zero cost.
    // A today warm is about the briefing alone; the cards refill through
    // their own read path when someone opens them.
    if (statusText.available && !options.today) {
      // Refill-only (v1.16.8): a card already generated today is a cheap
      // cache read; a cold card runs its generator, whose content-hash gate
      // skips the LLM when the underlying data did not change. There is no
      // force mode left to mirror — the comprehensive write no longer evicts
      // the per-status rows.
      result.assessmentsWarmed = await warmStatus(userId, locales);
      result.metricAssessmentsWarmed = await warmGenericMetrics(
        userId,
        locales,
      );
    }

    annotate({
      action: { name: "insights.pregenerate.force" },
      meta: {
        locale,
        comprehensive: result.comprehensive,
        assessments_warmed: result.assessmentsWarmed,
        metric_assessments_warmed: result.metricAssessmentsWarmed,
      },
    });

    return result;
  });
}
