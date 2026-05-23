/**
 * v1.4.48 M1 — boot-time probe for legacy `IntegrationStatus` rows that
 * still carry `consecutiveFailuresByKind: NULL`.
 *
 * v1.4.47 W1 dropped the single-column `consecutiveFailures` integer in
 * favour of the per-kind JSON bucket. The alert-ladder reads
 * `Math.max(...Object.values(buckets))` against the threshold — but a
 * row that survives with the JSON column still NULL deterministically
 * counts as `max([1]) = 1` on its first failure (the fall-back signal
 * the writer emits when the row is absent), so the operator notices
 * two strikes later than they did pre-v1.4.47 where the legacy column
 * back-stopped the maths.
 *
 * Operator judgement ("every active row has been written under
 * v1.4.43+, so the column is non-null") is not a code invariant. This
 * probe is the runtime version of that invariant: one count query at
 * worker boot, a single Wide-Event warning if any such row survives.
 * Fire-and-forget — a probe failure must never block boot. Idempotent
 * across reboots.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { annotate, getEvent } from "@/lib/logging/context";

interface IntegrationStatusNullProbeResult {
  count: number;
}

type PrismaCountClient = Pick<PrismaClient, "$queryRaw">;

export async function probeIntegrationStatusNullBuckets(
  prisma: PrismaCountClient,
): Promise<IntegrationStatusNullProbeResult> {
  // Prisma's typed `count` rejects a literal `null` against a `Json?`
  // column without going through `Prisma.JsonNullValueFilter`. The raw
  // `IS NULL` is the simpler shape and matches the backlog spec.
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
      FROM integration_statuses
     WHERE consecutive_failures_by_kind IS NULL
  `;
  const count = Number(rows[0]?.count ?? 0);
  if (count > 0) {
    getEvent()?.addWarning(
      `[integration-status-null-probe] ${count} row(s) still carry consecutiveFailuresByKind=NULL; alert ladder will trip two strikes late until they are rewritten`,
    );
    annotate({ meta: { integration_status_null_buckets: count } });
  }
  return { count };
}
