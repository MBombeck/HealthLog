/**
 * Whether the nightly whole-database dump is happening, as facts a page or an
 * alert can act on.
 *
 * Read from the ledger the job writes (`DatabaseBackupRun`), plus two facts of
 * this process: whether `DB_BACKUP_DIR` is writable here, and whether the
 * off-host bucket is configured. A ledger row that says a copy went off-host
 * outranks this process's environment, for the reason the off-host card gives
 * (a split install can hand the bucket variables to the worker only).
 */
import { prisma } from "@/lib/db";
import { DATABASE_BACKUP_EXPIRE_SECONDS } from "@/lib/jobs/database-backup-queue";
import { offhostBackupConfigured } from "@/lib/jobs/offhost-backup";

import {
  databaseBackupEnabled,
  isWritableDirectory,
  resolveBackupDir,
  resolveDailyKeep,
} from "./dump-core.mjs";

export interface DatabaseBackupHealth {
  /** `DB_BACKUP_ENABLED` is not off. */
  enabled: boolean;
  /** The directory dumps are kept in (`DB_BACKUP_DIR`). */
  directory: string;
  /**
   * Nightly dumps kept in that directory (`DB_BACKUP_KEEP`). Also how long a
   * deleted account stays in the dumps on this server, which the backups
   * page says.
   */
  keepNightly: number;
  /** This process can write there. False means dumps only go off-host. */
  localDirWritable: boolean;
  /** The off-host bucket is configured, or a dump has been uploaded to it. */
  offhostConfigured: boolean;
  /** The newest dump that was kept on the server or reached the bucket. */
  lastGood: {
    at: string;
    fileName: string;
    sizeBytes: number | null;
    local: boolean;
    offhost: boolean;
  } | null;
  /** The newest run that failed, or that a dying process left unfinished. */
  lastFailure: { at: string; error: string } | null;
}

/**
 * A run still `running` this long after it started was cut off by its
 * process: the job's expiry, past which pg-boss has failed it anyway.
 */
const ABANDONED_AFTER_MS = DATABASE_BACKUP_EXPIRE_SECONDS * 1000;

export async function getDatabaseBackupHealth(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseBackupHealth> {
  const directory = resolveBackupDir(env);
  const [lastGood, lastFailed, lastAbandoned, everUploaded] = await Promise.all(
    [
      prisma.databaseBackupRun.findFirst({
        where: {
          fileName: { not: null },
          OR: [{ localResult: "written" }, { offhostResult: "uploaded" }],
        },
        orderBy: { startedAt: "desc" },
        select: {
          startedAt: true,
          finishedAt: true,
          fileName: true,
          dumpBytes: true,
          localResult: true,
          offhostResult: true,
        },
      }),
      prisma.databaseBackupRun.findFirst({
        where: { status: "failed" },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, finishedAt: true, error: true },
      }),
      prisma.databaseBackupRun.findFirst({
        where: {
          status: "running",
          startedAt: { lt: new Date(now.getTime() - ABANDONED_AFTER_MS) },
        },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true },
      }),
      prisma.databaseBackupRun.count({ where: { offhostResult: "uploaded" } }),
    ],
  );

  const failures = [
    lastFailed && {
      at: (lastFailed.finishedAt ?? lastFailed.startedAt).toISOString(),
      error: lastFailed.error ?? "failed without a reason",
    },
    lastAbandoned && {
      at: lastAbandoned.startedAt.toISOString(),
      error: "the run did not finish (the process stopped under it)",
    },
  ]
    .filter((f): f is { at: string; error: string } => Boolean(f))
    .sort((a, b) => b.at.localeCompare(a.at));

  return {
    enabled: databaseBackupEnabled(env),
    directory,
    keepNightly: resolveDailyKeep(env),
    localDirWritable: isWritableDirectory(directory),
    offhostConfigured: offhostBackupConfigured() || everUploaded > 0,
    lastGood: lastGood
      ? {
          at: (lastGood.finishedAt ?? lastGood.startedAt).toISOString(),
          fileName: lastGood.fileName ?? "",
          sizeBytes:
            lastGood.dumpBytes === null ? null : Number(lastGood.dumpBytes),
          local: lastGood.localResult === "written",
          offhost: lastGood.offhostResult === "uploaded",
        }
      : null,
    lastFailure: failures[0] ?? null,
  };
}
