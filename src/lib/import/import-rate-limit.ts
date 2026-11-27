/**
 * Spends the hourly bucket the buffered imports share. The ceiling, its
 * bounds and the 429 wording live in `import-rate-limit-policy.ts`.
 */
import {
  IMPORT_RATE_LIMIT_WINDOW_MS,
  importRateLimitMessage,
  resolveImportRateLimitPerHour,
} from "@/lib/import/import-rate-limit-policy";
import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";

export { importRateLimitMessage };

/** Spend one slot of the shared hourly import bucket for this account. */
export async function checkImportRateLimit(
  accountId: string,
): Promise<RateLimitResult & { limit: number }> {
  const limit = resolveImportRateLimitPerHour();
  const result = await checkRateLimit(
    `import:${accountId}`,
    limit,
    IMPORT_RATE_LIMIT_WINDOW_MS,
  );
  return { ...result, limit };
}
