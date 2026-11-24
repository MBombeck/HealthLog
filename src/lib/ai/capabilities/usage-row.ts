/**
 * The caller's AI usage columns, kept from the request's own identity read.
 *
 * Every authenticated request resolves its caller through
 * `authenticateCaller` (`auth/guards/caller.ts`), whose row carries
 * `aiUsageLevel` and `deletionRequestedAt` (`SESSION_USER_SELECT`). The AI
 * capability of the caller's own record read both columns again, one
 * statement on every hot read that resolves an AI block: `/api/auth/me` and
 * the daily digest among them, whose budgets
 * `query-budget-hot-routes.test.ts` holds. The resolver keeps them here and
 * `loadRecordAiUsage` takes them from here.
 *
 * Only in a GET or HEAD request (`primePerRequest`), so a request that
 * writes the level never reads its own row from before the write. Imports
 * nothing heavy: the auth resolver loads it on every request.
 */
import { peekPerRequest, primePerRequest } from "@/lib/request-cache";

export type UsageRow = {
  aiUsageLevel: string | null;
  deletionRequestedAt: Date | null;
};

const usageRowKey = (recordId: string) => `ai-usage-row:${recordId}`;

export function keepRecordAiUsageRow(recordId: string, row: UsageRow): void {
  try {
    primePerRequest(usageRowKey(recordId), {
      aiUsageLevel: row.aiUsageLevel,
      deletionRequestedAt: row.deletionRequestedAt,
    });
  } catch {
    // No request context to keep it in; the record's read happens as before.
  }
}

export function keptUsageRow(recordId: string): Promise<UsageRow> | undefined {
  try {
    return peekPerRequest<UsageRow>(usageRowKey(recordId));
  } catch {
    return undefined;
  }
}
