/**
 * At most one waiting admission job per import.
 *
 * pg-boss's singleton key keeps one job per key, but one import travels
 * under several keys: a fresh offer (boot discovery, a connect) under its
 * bare identity, every follow-up under `<identity>|slice-N`. A slice that
 * met a provider outage waits up to six hours before it is sent again, and
 * a deploy inside that wait ran discovery, whose offer the singleton did not
 * recognise as the same import. Two chains then walked one progress note,
 * each making every provider call once more.
 *
 * So a fresh offer and a retry go out through {@link sendBackfillUnlessWaiting}:
 * under a transaction-scoped advisory lock on the import's identity it looks
 * for a job of the import that waits (`created` or `retry`) and sends only
 * when there is none. The lock makes check and send one step for every
 * sender on every instance; the job that waits carries the import on from
 * its progress note, so the sender has nothing left to do.
 *
 * A running (`active`) job does not count: after a crash its row stays
 * active until its expiry, and discovery must still be able to offer the
 * import at the next boot. The import lock keeps that offer from running
 * beside a live run.
 */
import type { PgBoss } from "pg-boss";

import { prisma } from "@/lib/db";
import {
  enqueueIntegrationBackfillAdmission,
  INTEGRATION_BACKFILL_ADMISSION_QUEUE,
  integrationBackfillIdentity,
  type IntegrationBackfillAdmissionPayload,
} from "@/lib/jobs/integration-backfill-admission";

export type BackfillSendResult =
  /** Sent; the new job's id. */
  | { kind: "sent"; id: string }
  /** Another job of the import waits and carries it on. */
  | { kind: "waiting" }
  /** pg-boss refused the send (its singleton held the key). */
  | { kind: "refused" };

type BossSender = Pick<PgBoss, "send">;

export async function sendBackfillUnlessWaiting(
  boss: BossSender,
  payload: IntegrationBackfillAdmissionPayload,
  startAfterSeconds: number = 0,
): Promise<BackfillSendResult> {
  const identity = integrationBackfillIdentity(payload);
  return prisma.$transaction(
    async (tx) => {
      // `pg_advisory_xact_lock` returns void, which the client cannot
      // deserialize; selecting FROM it yields a plain row.
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended(${`integration-backfill-send:${identity}`}, 0))
      `;
      // No pg-boss schema yet (a sender with a stand-in queue): nothing waits.
      const [schema] = await tx.$queryRaw<Array<{ present: boolean }>>`
        SELECT to_regclass('pgboss.job') IS NOT NULL AS present
      `;
      const [row] = !schema?.present
        ? [{ waiting: false }]
        : await tx.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pgboss.job
          WHERE name = ${INTEGRATION_BACKFILL_ADMISSION_QUEUE}
            AND state IN ('created', 'retry')
            AND (singleton_key = ${identity}
                 OR starts_with(singleton_key, ${`${identity}|slice-`}))
        ) AS waiting
      `;
      if (row?.waiting) return { kind: "waiting" } as const;
      // The send commits on pg-boss's own connection while the lock is
      // held, so the next sender's check sees it.
      const id = await enqueueIntegrationBackfillAdmission(
        boss,
        payload,
        startAfterSeconds,
      );
      return id
        ? ({ kind: "sent", id } as const)
        : ({ kind: "refused" } as const);
    },
    { timeout: 30_000 },
  );
}
