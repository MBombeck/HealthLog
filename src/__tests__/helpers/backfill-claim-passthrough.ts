/**
 * Stand-in for `@/lib/jobs/integration-backfill-claim` in unit tests that
 * drive a backfill sender against a recording boss: every send goes out.
 * The one-waiting-job check needs pg-boss's tables, so the integration suite
 * covers it (`tests/integration/integration-backfill-one-waiting-job.test.ts`).
 *
 *   vi.mock("@/lib/jobs/integration-backfill-claim", () =>
 *     import("@/__tests__/helpers/backfill-claim-passthrough"));
 */
import {
  enqueueIntegrationBackfillAdmission,
  type IntegrationBackfillAdmissionPayload,
} from "@/lib/jobs/integration-backfill-admission";
import type { BackfillSendResult } from "@/lib/jobs/integration-backfill-claim";

export async function sendBackfillUnlessWaiting(
  boss: Parameters<typeof enqueueIntegrationBackfillAdmission>[0],
  payload: IntegrationBackfillAdmissionPayload,
  startAfterSeconds?: number,
): Promise<BackfillSendResult> {
  const id = await enqueueIntegrationBackfillAdmission(
    boss,
    payload,
    startAfterSeconds,
  );
  return id ? { kind: "sent", id } : { kind: "refused" };
}
