/**
 * The `morning-digest-refresh` worker.
 *
 * Runs ONE extra insight generation per user per local morning, event-driven
 * off the arrival of last night's sleep (never warm-on-mount, never per page
 * visit). It re-runs the SAME comprehensive pipeline the nightly
 * `insight-pregenerate` cron uses — forced so the 24 h cache short-circuit is
 * bypassed — then stamps `User.morningDigestRefreshedOn` so the daily digest
 * flips the day `provisional → final`.
 *
 * Cheap by construction: the generator's own content-hash gate turns a
 * no-change regeneration into an `unchanged` timestamp refresh with no provider
 * call, so a morning whose sleep did not actually move the feature snapshot
 * costs a hash compare, not an LLM round-trip. A real change — last night's
 * sleep now folded into the features — regenerates the briefing paragraph AND
 * warms the score's read path.
 *
 * Honest degradation (§E): on a hard generation failure the marker is NOT
 * stamped, so the day stays `provisional` and the digest keeps showing the
 * sleep-pending note. The generator already recorded the omit-reason via
 * `recordBriefingFailure` on its failure paths, and we re-enqueue the SAME
 * 45-minute bounded retry the nightly cron uses (`enqueuePregenerateFailureRetry`)
 * — no parallel freshness machinery is invented here.
 *
 * Idempotency: a second run for the same local morning no-ops on the marker
 * re-check. The enqueue-side `singletonKey` collapses the concurrent burst; the
 * marker is the durable "already done" guard the singleton cannot provide once
 * the first job has completed.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { annotate } from "@/lib/logging/context";
import {
  generateComprehensiveInsight,
  type GenerateOutcome,
} from "@/lib/insights/comprehensive-generate";
import { enqueuePregenerateFailureRetry } from "@/lib/jobs/insight-pregenerate-shared";
import { comprehensiveWarmBudgetMs } from "@/lib/jobs/model-time";
import { withTimeout } from "@/lib/insights/with-timeout";
import type { SupportedLocale } from "@/lib/insights/status-shared";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import {
  MORNING_DIGEST_REFRESH_QUEUE,
  type MorningDigestRefreshPayload,
} from "@/lib/jobs/morning-digest-refresh-shared";

export { MORNING_DIGEST_REFRESH_QUEUE };
export type { MorningDigestRefreshPayload };

export interface MorningDigestRefreshResult {
  status: "finalised" | "already-final" | "missing-user" | "failed";
  /** The comprehensive generator's own outcome, when it ran. */
  comprehensive?: GenerateOutcome["status"];
}

type GenerateFn = (
  userId: string,
  options: { locale: SupportedLocale; force?: boolean; signal?: AbortSignal },
) => Promise<GenerateOutcome>;

/**
 * Execute the morning refresh for one user. Pure of queue concerns — the boss
 * handler in `register-status.ts` wraps this in the background-event envelope.
 *
 * `deps` is injected by the tests: a fake generator + failure-retry so the
 * marker lifecycle and idempotency can be asserted without a provider or a
 * running boss.
 */
export async function runMorningDigestRefresh(
  prisma: PrismaClient,
  payload: MorningDigestRefreshPayload,
  deps: {
    generate?: GenerateFn;
    enqueueRetry?: (args: {
      userId: string;
      locale: SupportedLocale;
    }) => Promise<void>;
  } = {},
): Promise<MorningDigestRefreshResult> {
  const generate: GenerateFn = deps.generate ?? generateComprehensiveInsight;
  const enqueueRetry = deps.enqueueRetry ?? enqueuePregenerateFailureRetry;
  const { userId, localDate } = payload;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      locale: true,
      morningDigestRefreshedOn: true,
      aiResponseTimeoutSeconds: true,
    },
  });
  if (!user) {
    annotate({
      action: { name: "daily.morning_refresh.missing_user" },
      meta: { local_date: localDate },
    });
    return { status: "missing-user" };
  }

  // Idempotency: a re-fire for the same local morning is a no-op.
  if (user.morningDigestRefreshedOn === localDate) {
    annotate({
      action: { name: "daily.morning_refresh.already_final" },
      meta: { local_date: localDate },
    });
    return { status: "already-final" };
  }

  const locale = await resolveJobLocale(user.locale);
  // The same bound the nightly and forced warms use: every call of one
  // generation at the person's timeout, plus headroom. It is the worst case
  // the job's expiry (`MORNING_DIGEST_REFRESH_EXPIRE_SECONDS`) sits above, so
  // pg-boss never declares a working refresh dead and retries it beside
  // itself (#1274); a wedged generation is aborted here instead.
  const controller = new AbortController();
  let thrown: unknown = null;
  const bounded = await withTimeout(
    () =>
      generate(userId, {
        locale,
        force: true,
        signal: controller.signal,
      }).catch((err: unknown) => {
        thrown = err;
        throw err;
      }),
    comprehensiveWarmBudgetMs(user.aiResponseTimeoutSeconds),
    null,
    () => controller.abort(),
  );
  // A throw is transient (a pool or provider fault): the queue's own retry
  // re-runs the refresh, as it did before the bound.
  if (bounded.errored) throw thrown;
  const outcome = bounded.value;

  // A hard provider failure leaves the day provisional and hands recovery to
  // the existing 45-minute briefing-retry machinery. Every other outcome —
  // including `skipped` (no provider / no consent: there is no LLM briefing to
  // wait for, so the deterministic score + digest are as final as they get
  // once last night's sleep is in the record) — finalises the day.
  if (outcome === null || outcome.status === "failed") {
    const cause = outcome !== null ? `generator:${outcome.reason}` : "timeout";
    annotate({
      action: { name: "daily.morning_refresh.deferred" },
      meta: { local_date: localDate, cause },
    });
    await enqueueRetry({ userId, locale });
    return { status: "failed", comprehensive: "failed" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { morningDigestRefreshedOn: localDate },
  });
  annotate({
    action: { name: "daily.morning_refresh.finalised" },
    meta: { local_date: localDate, comprehensive: outcome.status },
  });
  return { status: "finalised", comprehensive: outcome.status };
}
