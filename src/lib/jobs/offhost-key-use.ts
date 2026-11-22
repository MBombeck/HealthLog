/**
 * The off-host key-use ledger: per key id, when an object needing it last
 * went into the bucket. The recovery readiness report reads it to say which
 * keys an off-host object still needs (`backup-key-needs.ts`).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";

/**
 * Note, per key id, that an object needing it went into the bucket now. Never
 * fails the account: the object is in the bucket whatever this row says. A
 * write that failed is counted for the run, because the recovery readiness
 * report reads this row to say which keys an off-host object still needs,
 * and a missing row would read as a key that can be retired.
 */
export async function recordOffhostKeyUse(
  prisma: PrismaClient,
  keyIds: readonly string[],
  at: Date,
): Promise<number> {
  let failed = 0;
  for (const keyId of keyIds) {
    try {
      await prisma.offhostBackupKeyUse.upsert({
        where: { keyId },
        create: { keyId, firstWrittenAt: at, lastWrittenAt: at },
        update: { lastWrittenAt: at },
      });
    } catch (err) {
      failed += 1;
      getEvent()?.addWarning(
        `offhost-backup key-use write failed: ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }
  return failed;
}
