/**
 * One derived metric for one account, read through the per-user derived cache
 * with stale-while-revalidate.
 *
 * The single-metric route serves this, and the score-history route reads the
 * same cell for the newest point of readiness's course, so the chart and the
 * headline above it are one number from one place. Same bucket as the batch
 * grid, so the invalidation the batch relies on covers it unchanged
 * (measurement writes evict or mark the `${userId}|` prefix stale, mood writes
 * mark it stale).
 *
 * Server-only — reaches for the Prisma client.
 */
import { prisma } from "@/lib/db";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { annotate } from "@/lib/logging/context";

// Through the barrel, as the routes always imported these, so a test that
// stands in for the derived engine reaches this read too.
import {
  computeDerivedMetric,
  loadBaselineProfile,
  type DerivedMetricId,
} from "@/lib/insights/derived";

export function readDerivedSingle(args: {
  userId: string;
  metric: DerivedMetricId;
  type?: string | null;
  windowDays?: number;
}): Promise<Awaited<ReturnType<typeof computeDerivedMetric>>> {
  const type = args.type ?? null;
  return cachedSwr(
    caches.insightsDerived as ServerCache<
      Awaited<ReturnType<typeof computeDerivedMetric>>
    >,
    `${args.userId}|single|${args.metric}|${type ?? ""}|${args.windowDays ?? ""}`,
    async () =>
      computeDerivedMetric({
        metric: args.metric,
        userId: args.userId,
        profile: await loadBaselineProfile(prisma, args.userId),
        type,
        windowDays: args.windowDays,
      }),
    annotate,
  );
}
