import { prisma } from "@/lib/db";

/**
 * v1.4.37 / v1.4.41 — shared timeout-stub persist for InsightStatus routes.
 *
 * When the upstream provider call exceeds `STATUS_PROVIDER_TIMEOUT_MS`
 * the caller persists a sentinel `auditLog` row keyed to today's Berlin
 * day so the next mount short-circuits at the cache lookup instead of
 * re-racing the same 20 s provider call on every cold visit. Without
 * this, a single stall (provider hiccup, network blip, model warm-up)
 * leaves the user staring at the loading state on every reload until
 * the daily 02:20 pre-warm job runs.
 *
 * The persisted body is the deterministic no-key fallback the caller
 * would have returned in the bare-fallback shape, so the user-facing
 * UI is identical; only the re-fire frequency drops to zero for the
 * rest of the day.
 *
 * `meta.timeout` + `meta.model = "timeout-stub"` are set so the daily
 * pg-boss pre-warm worker (the same job that originally seeded the
 * cache) can recognise and overwrite the stub rather than respect it
 * as a real assessment.
 *
 * The write is best-effort — if it fails the caller still sees the
 * deterministic fallback text and the next mount falls back to the
 * (still expensive) race. We do not surface the error: the user does
 * not care that the cache write missed, only that the page rendered.
 */
export async function persistTimeoutStubAndReturn(input: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  locale: string;
  providerType: string;
  stubText: string;
}): Promise<{
  hasProvider: true;
  text: string;
  cached: true;
  updatedAt: string | null;
}> {
  const { userId, cacheAction, todayKey, locale, providerType, stubText } =
    input;
  let stubUpdatedAt: string | null = null;
  try {
    const stub = await prisma.auditLog.create({
      data: {
        userId,
        action: cacheAction,
        details: JSON.stringify({
          dateKey: todayKey,
          locale,
          text: stubText,
          providerType,
          model: "timeout-stub",
          tokensUsed: null,
          timeout: true,
        }),
      },
      select: { createdAt: true },
    });
    stubUpdatedAt = stub.createdAt.toISOString();
  } catch {
    // The persist is best-effort — silently swallow so the user-facing
    // payload still renders even when the row write missed.
  }
  return {
    hasProvider: true,
    text: stubText,
    cached: true,
    updatedAt: stubUpdatedAt,
  };
}
