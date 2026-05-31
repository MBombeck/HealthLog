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
 * cache (`insightsCachedAt IS NULL OR < now - 20h`). Whether the user
 * has a configured provider is confirmed inside
 * `generateComprehensiveInsight` (returns `skipped: no-provider`), so a
 * provider-less account costs one cheap chain-resolve and no LLM call.
 *
 * Recurring pg-boss task — never runs inside an HTTP request and never
 * shells out to `tsx` (CLAUDE.md DO-NOTs).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { getAssistantFlags } from "@/lib/feature-flags";
import {
  generateComprehensiveInsight,
  type GenerateOutcome,
} from "@/lib/insights/comprehensive-generate";

export const INSIGHT_PREGENERATE_QUEUE = "insight-pregenerate";

/**
 * 04:30 Europe/Berlin. Slots between the cumulative drain (03:30) and
 * the feedback aggregator (04:00) maintenance window's tail so the
 * LLM-bound pass doesn't contend with the SQL-bound nightly folds.
 */
export const INSIGHT_PREGENERATE_CRON = "30 4 * * *";

/** Stale-cache threshold — a hair under the 24 h advisor TTL so the
 * overnight run always refreshes a cache that will expire before the
 * user's next likely visit. */
export const PREGENERATE_STALE_MS = 20 * 60 * 60 * 1000;

/** Per-run cap on the number of users a single tick generates for. */
export const PREGENERATE_BATCH_CAP = 200;

/** Per-user budget bucket window — one pre-generation per 20 h. */
const PREGENERATE_BUDGET_WINDOW_MS = 20 * 60 * 60 * 1000;

export interface InsightPregeneratePayload {
  triggeredAt: string;
}

export interface PregenerateRunResult {
  total: number;
  generated: number;
  cached: number;
  skipped: number;
  failed: number;
  budgetBlocked: number;
}

interface PregenerateCandidate {
  id: string;
  locale: string | null;
}

/**
 * Discovery query — coach-enabled users with a stale or missing
 * comprehensive-insight cache, oldest-cache-first so the staleest users
 * are served before the per-run cap bites. Exported so the cron test
 * can pin the WHERE shape without a live LLM.
 */
export async function findPregenerateCandidates(
  prisma: PrismaClient,
  now: Date,
  cap: number,
): Promise<PregenerateCandidate[]> {
  const staleBefore = new Date(now.getTime() - PREGENERATE_STALE_MS);
  return prisma.user.findMany({
    where: {
      disableCoach: false,
      OR: [
        { insightsCachedAt: null },
        { insightsCachedAt: { lt: staleBefore } },
      ],
    },
    // nulls-first is the default ascending order in Postgres, so
    // never-generated users sort ahead of merely-stale ones.
    orderBy: { insightsCachedAt: "asc" },
    take: cap,
    select: { id: true, locale: true },
  });
}

function normalizeLocale(value: string | null): "de" | "en" {
  return value === "en" ? "en" : "de";
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
      opts: { locale: "de" | "en"; force?: boolean },
    ) => Promise<GenerateOutcome>;
  } = {},
): Promise<PregenerateRunResult> {
  const now = options.now ?? new Date();
  const cap = options.cap ?? PREGENERATE_BATCH_CAP;
  const generate = options.generate ?? generateComprehensiveInsight;

  const result: PregenerateRunResult = {
    total: 0,
    generated: 0,
    cached: 0,
    skipped: 0,
    failed: 0,
    budgetBlocked: 0,
  };

  // Master kill-switch — when the operator disabled the briefing
  // surface globally there is nothing to pre-generate.
  const flags = await getAssistantFlags();
  if (!flags.briefing) return result;

  const candidates = await findPregenerateCandidates(prisma, now, cap);
  result.total = candidates.length;

  for (const candidate of candidates) {
    // Budget gate — one pre-generation per user per 20 h. The route's
    // on-demand path uses a different bucket (`insights:${userId}`), so
    // this never starves a user's manual regenerate quota.
    const budget = await checkRateLimit(
      `insight-pregenerate:${candidate.id}`,
      1,
      PREGENERATE_BUDGET_WINDOW_MS,
    );
    if (!budget.allowed) {
      result.budgetBlocked++;
      continue;
    }

    // Force a fresh generation: the discovery window (20 h) is shorter
    // than the generator's 24 h cache TTL, so without `force` a user
    // whose cache is 20–24 h old would be discovered, consume the
    // budget bucket, then short-circuit to `cached` with no actual
    // pre-generation — defeating the "warm the cache before the user's
    // morning visit" intent for the common case. The per-user budget
    // bucket (above) is what bounds cost, not the TTL re-check.
    const outcome = await generate(candidate.id, {
      locale: normalizeLocale(candidate.locale),
      force: true,
    });
    switch (outcome.status) {
      case "generated":
        result.generated++;
        break;
      case "cached":
        result.cached++;
        break;
      case "skipped":
        result.skipped++;
        break;
      case "failed":
        result.failed++;
        break;
    }
  }

  return result;
}
