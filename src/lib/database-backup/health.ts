/**
 * Whether the nightly whole-database dump is happening, as facts a page or an
 * alert can act on.
 *
 * Read from the ledger the job writes (`DatabaseBackupRun`), plus two facts of
 * this process: whether `DB_BACKUP_DIR` is writable here and survives the
 * container being replaced, and whether the off-host bucket is configured. A ledger row that says a copy went off-host
 * outranks this process's environment, for the reason the off-host card gives
 * (a split install can hand the bucket variables to the worker only).
 */
import { prisma } from "@/lib/db";
import { DATABASE_BACKUP_EXPIRE_SECONDS } from "@/lib/jobs/database-backup-queue";
import { offhostBackupConfigured } from "@/lib/jobs/offhost-backup";

import {
  backupDirectoryStatus,
  databaseBackupEnabled,
  resolveBackupDir,
  resolveDailyKeep,
  type BackupDirectoryStatus,
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
  /** This process can write there. */
  localDirWritable: boolean;
  /**
   * A dump written there survives an update: the directory is on a volume or
   * a bind mount, or the app does not run in a container. False means no dump
   * is kept on this server, whatever an older ledger row says, and dumps only
   * go off-host. `localReason` says why.
   */
  localPersistent: boolean;
  /**
   * `volume`, `host`, `container_layer` (the image's own directory, without
   * the volume mounted), `memory` (a tmpfs) or `not_writable`.
   */
  localReason: BackupDirectoryStatus["reason"];
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
  /**
   * The off-host leg on its own. A run that kept its dump on the server and
   * failed the upload is a good dump and a failed run at once; read only as
   * those two, it looked healthy while nothing reached the bucket.
   */
  offhost: {
    /** When the newest dump reached the bucket; null when none ever did. */
    lastUploadAt: string | null;
    /**
     * The newest dump that was taken but did not reach the bucket, when no
     * later one did. Null while the newest dump taken is in the bucket.
     */
    failure: { at: string; error: string } | null;
  };
}

/**
 * A run still `running` this long after it started was cut off by its
 * process: the job's expiry, past which pg-boss has failed it anyway.
 */
const ABANDONED_AFTER_MS = DATABASE_BACKUP_EXPIRE_SECONDS * 1000;

export async function getDatabaseBackupHealth(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
  directoryStatus: (
    dir: string,
  ) => BackupDirectoryStatus = backupDirectoryStatus,
): Promise<DatabaseBackupHealth> {
  const directory = resolveBackupDir(env);
  const local = directoryStatus(directory);
  // A dump recorded as written into a directory that does not survive the
  // container was lost with the container that wrote it: only a copy in the
  // bucket still counts.
  const keptWhere = local.persistent
    ? [{ localResult: "written" }, { offhostResult: "uploaded" }]
    : [{ offhostResult: "uploaded" }];
  const [lastGood, lastFailed, lastAbandoned, lastUploaded, lastNotUploaded] =
    await Promise.all([
      prisma.databaseBackupRun.findFirst({
        where: { fileName: { not: null }, OR: keptWhere },
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
      prisma.databaseBackupRun.findFirst({
        where: { offhostResult: "uploaded" },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, finishedAt: true },
      }),
      // A dump was taken (the file name is set only when the run finishes)
      // and its upload failed.
      prisma.databaseBackupRun.findFirst({
        where: { fileName: { not: null }, offhostResult: "failed" },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, finishedAt: true, error: true },
      }),
    ]);

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
    localDirWritable: local.writable,
    localPersistent: local.persistent,
    localReason: local.reason,
    offhostConfigured: offhostBackupConfigured() || lastUploaded !== null,
    lastGood: lastGood
      ? {
          at: (lastGood.finishedAt ?? lastGood.startedAt).toISOString(),
          fileName: lastGood.fileName ?? "",
          sizeBytes:
            lastGood.dumpBytes === null ? null : Number(lastGood.dumpBytes),
          local: local.persistent && lastGood.localResult === "written",
          offhost: lastGood.offhostResult === "uploaded",
        }
      : null,
    lastFailure: failures[0] ?? null,
    offhost: {
      lastUploadAt: lastUploaded ? runAt(lastUploaded) : null,
      failure:
        lastNotUploaded &&
        (lastUploaded === null ||
          lastNotUploaded.startedAt > lastUploaded.startedAt)
          ? {
              at: runAt(lastNotUploaded),
              error: lastNotUploaded.error ?? "the upload failed",
            }
          : null,
    },
  };
}

/** When a run ended, or began when it never ended. */
function runAt(run: { startedAt: Date; finishedAt: Date | null }): string {
  return (run.finishedAt ?? run.startedAt).toISOString();
}
