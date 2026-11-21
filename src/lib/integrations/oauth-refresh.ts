import type { Prisma } from "@/generated/prisma/client";

export type SerializedRefreshProvider =
  | "whoop"
  | "withings"
  | "oura"
  | "strava"
  | "google-health"
  | "polar"
  | "codex"
  | "admin-codex";

/**
 * Provider refreshes hold a database transaction open around one bounded
 * external request. `maxWait` bounds pool acquisition and `timeout` bounds the
 * advisory-lock wait, provider call, and durable token replacement together.
 */
export const PROVIDER_REFRESH_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000,
} as const;

/**
 * Serialize one provider/user refresh attempt for the transaction lifetime.
 * Callers must re-read token state after this returns: a prior contender may
 * have committed a fresh token while this transaction waited for the lock.
 */
export async function acquireProviderTokenRefreshLock(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  provider: SerializedRefreshProvider,
  userId: string,
): Promise<void> {
  const key = `provider-token-refresh:${provider}:${userId}`;
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))
  `;
}
