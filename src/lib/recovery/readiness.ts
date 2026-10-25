/**
 * Read every fact the recovery readiness model judges, and judge it.
 *
 * One reader for both consumers: the admin tile (`GET
 * /api/admin/recovery-readiness`) and the hourly evaluation that pushes state
 * changes to the admins. Each fact comes from where its own surface already
 * reads it, so the tile can never disagree with the backups page about a copy:
 *
 *   - the weekly copy: the `WEEKLY_AUTO` row per account, which never ages out
 *     of any retention window (pg-boss forgets a run after seven days);
 *   - the off-host copies: the per-account ledger the nightly run writes, and
 *     the same "configured" rule the backups page uses (the environment, or a
 *     ledger row as proof that an upload happened);
 *   - the bucket's lifecycle rule for `database/`: the same cached probe the
 *     backups page shows, asked only when a bucket is configured;
 *   - the drill: its persisted last outcome, with no time window;
 *   - the kit: the same assessment the kit card shows;
 *   - the dump: whatever the dump module reports, through a provider.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import {
  offhostBackupConfigured,
  probeOffhostLifecycle,
} from "@/lib/jobs/offhost-backup";
import {
  readDatabaseBackupHealth,
  type DatabaseBackupHealthProvider,
} from "@/lib/recovery/database-dump-health";
import { readRecoveryKit } from "@/lib/recovery/kit";
import {
  evaluateRecoveryReadiness,
  type ReadinessInputs,
  type RecoveryReadiness,
} from "@/lib/recovery/readiness-model";

/** The type the weekly worker writes; anything else was uploaded by hand. */
const SCHEDULED_BACKUP_TYPE = "WEEKLY_AUTO";

export interface ReadRecoveryReadinessOptions {
  now?: Date;
  dumpHealth?: DatabaseBackupHealthProvider;
}

export async function readReadinessInputs(
  options: ReadRecoveryReadinessOptions = {},
): Promise<ReadinessInputs> {
  const now = options.now ?? new Date();
  const dumpHealth = options.dumpHealth ?? readDatabaseBackupHealth;
  const [firstAdmin, accounts, drill, dumpNotice, dump, kit] =
    await Promise.all([
      prisma.user.findFirst({
        where: { role: "ADMIN" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      // The weekly and off-host passes skip an account pending deletion on
      // purpose, so its copies age without anything being wrong; counted
      // here, every deletion turned both signals red and pushed the admins.
      prisma.user.findMany({
        where: ACTIVE_ACCOUNT,
        select: {
          createdAt: true,
          dataBackups: {
            where: { type: SCHEDULED_BACKUP_TYPE },
            select: { createdAt: true },
          },
          offhostBackupState: {
            select: { lastAttemptAt: true, lastSuccessAt: true },
          },
        },
      }),
      prisma.restoreDrillOutcome.findUnique({ where: { id: "singleton" } }),
      prisma.recoveryReadinessNotice.findUnique({
        where: { signal: "database_dump" },
        select: { watchedSince: true },
      }),
      dumpHealth(now).catch(() => "unreadable" as const),
      readRecoveryKit(now),
    ]);

  // Evidence beats this process's environment, as on the backups page: a
  // ledger row is proof an upload happened, whichever process reads it.
  const configured =
    offhostBackupConfigured() ||
    accounts.some((account) => account.offhostBackupState !== null);
  // Never throws: a bucket that cannot be asked answers `unknown`.
  const databaseLifecycle = configured
    ? (await probeOffhostLifecycle()).database
    : null;

  return {
    now,
    firstAdminAt: firstAdmin?.createdAt ?? null,
    dump,
    dumpWatchedSince: dumpNotice?.watchedSince ?? null,
    weekly: {
      accounts: accounts.map((account) => ({
        createdAt: account.createdAt,
        lastCopyAt: account.dataBackups[0]?.createdAt ?? null,
      })),
    },
    offhost: {
      configured,
      databaseLifecycle,
      accounts: accounts.map((account) => ({
        lastAttemptAt: account.offhostBackupState?.lastAttemptAt ?? null,
        lastSuccessAt: account.offhostBackupState?.lastSuccessAt ?? null,
      })),
    },
    drill: drill
      ? {
          lastRunAt: drill.lastRunAt,
          lastSuccessAt: drill.lastSuccessAt,
          lastFailureAt: drill.lastFailureAt,
          lastFailureReason: drill.lastFailureReason,
          accountsChecked: drill.accountsChecked,
          accountsFailed: drill.accountsFailed,
        }
      : null,
    kit: {
      confirmedAt: kit.confirmedAt ? new Date(kit.confirmedAt) : null,
      unconfirmed: kit.unconfirmed,
    },
  };
}

export async function readRecoveryReadiness(
  options: ReadRecoveryReadinessOptions = {},
): Promise<RecoveryReadiness> {
  return evaluateRecoveryReadiness(await readReadinessInputs(options));
}
