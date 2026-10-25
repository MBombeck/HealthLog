/**
 * The accounts one off-host pass walks, and the ones a resumed run already
 * uploaded.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  ACTIVE_ACCOUNT,
  OWNED_BY_ACTIVE_ACCOUNT,
} from "@/lib/account-deletion/active-account";
import {
  orderInterruptedLast,
  readAccountsToTakeLast,
} from "@/lib/jobs/backup-pass-attempts";
import { OFFHOST_BACKUP_QUEUE } from "./offhost-backup-queue";

export async function readOffhostCohort(
  prisma: PrismaClient,
  runStartedAt: Date | undefined,
): Promise<{ users: Array<{ id: string }>; doneThisRun: Set<string> }> {
  // By id, with an account whose last walk never came back behind the rest:
  // a record that killed the process once would otherwise lead every retry
  // and keep every account after it out of the bucket. Behind them for one
  // run only, so a pass that stops on its budget still reaches it the run
  // after (`backup-pass-attempts.ts`). An account pending deletion is not
  // walked: its copies stay as they were until the purge erases them.
  const users = orderInterruptedLast(
    await prisma.user.findMany({
      where: ACTIVE_ACCOUNT,
      select: { id: true },
      orderBy: { id: "asc" },
    }),
    await readAccountsToTakeLast(prisma, OFFHOST_BACKUP_QUEUE),
  );
  const doneThisRun = new Set<string>();
  if (runStartedAt) {
    const done = await prisma.offhostBackupState.findMany({
      where: {
        lastSuccessAt: { gte: runStartedAt },
        ...OWNED_BY_ACTIVE_ACCOUNT,
      },
      select: { userId: true },
    });
    for (const row of done) doneThisRun.add(row.userId);
  }
  return { users, doneThisRun };
}
