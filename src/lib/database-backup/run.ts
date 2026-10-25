/**
 * One run of the nightly whole-database dump.
 *
 * The dump is the artifact that rebuilds a lost server: every account, every
 * login, every grant and managed profile, the job queue and the instance
 * settings, in one `pg_dump --format=custom` file with a manifest beside it
 * (`dump-core.mjs`). It is written to `DB_BACKUP_DIR` (a named volume in the
 * bundled compose file) and, when the off-host bucket is configured, uploaded
 * under `database/` in the same envelope the per-account copies use, sealed
 * with `BACKUP_ENCRYPTION_KEY`.
 *
 * Without a writable directory (an install that runs the image without the
 * volume) the dump is written to a temporary directory, uploaded and removed:
 * the off-host copy still happens, nothing is kept on the server, and the
 * ledger and the boot summary say so. With neither, the run is skipped and
 * recorded as such.
 *
 * Every run leaves one `DatabaseBackupRun` row: started, then finished with
 * what happened on each leg. `getDatabaseBackupHealth` reads them.
 */
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  getS3Client,
  loadOffhostConfig,
  uploadEncryptedBackup,
  type S3Like,
} from "@/lib/jobs/offhost-backup";
import { annotate } from "@/lib/logging/context";
import packageJson from "../../../package.json";

import {
  applyRetention,
  createDatabaseDump,
  databaseBackupEnabled,
  isWritableDirectory,
  offhostObjectKey,
  resolveBackupDir,
  resolveDailyKeep,
} from "./dump-core.mjs";

/** How long ledger rows are kept. A run a day; a year and a bit of history. */
const LEDGER_RETENTION_DAYS = 400;

export type DatabaseBackupLocalResult =
  "written" | "no_directory" | "failed" | "skipped";
export type DatabaseBackupOffhostResult =
  "uploaded" | "not_configured" | "failed" | "skipped";

export interface DatabaseBackupReport {
  status: "succeeded" | "failed" | "skipped";
  fileName: string | null;
  dumpBytes: number | null;
  local: DatabaseBackupLocalResult;
  offhost: DatabaseBackupOffhostResult;
  /** Dumps and manifests retention removed. */
  removed: number;
  error: string | null;
}

export interface RunDatabaseBackupOptions {
  now?: Date;
  /** Epoch ms at which `pg_dump` is stopped (`jobDeadline`). */
  deadline?: number;
  env?: NodeJS.ProcessEnv;
  /** A bucket double for tests; the configured bucket otherwise. */
  s3?: S3Like;
}

/** The running build's version, as `/api/version` answers it. */
function appVersion(env: NodeJS.ProcessEnv): string {
  return env.NEXT_PUBLIC_APP_VERSION?.trim() || packageJson.version;
}

/** An error as one line for the ledger and the admin page. */
function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Upload one local file as an off-host object, streamed. */
async function uploadFile(
  s3: S3Like,
  key: Buffer,
  path: string,
): Promise<number> {
  return uploadEncryptedBackup(
    s3,
    offhostObjectKey(`${basename(path)}.enc`),
    key,
    async (write) => {
      for await (const chunk of createReadStream(path)) {
        await write(chunk as Buffer);
      }
    },
  );
}

/**
 * Take tonight's dump, keep it, copy it off-host, prune the old ones, and
 * record what happened. Never throws: a failure is the report's `status`.
 */
export async function runDatabaseBackup(
  prisma: PrismaClient,
  options: RunDatabaseBackupOptions = {},
): Promise<DatabaseBackupReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const dir = resolveBackupDir(env);
  const localWritable = isWritableDirectory(dir);
  const offhostConfig = (() => {
    try {
      return loadOffhostConfig();
    } catch {
      // A malformed BACKUP_ENCRYPTION_KEY: the account copies fail on the
      // same value with their own message; here it reads as an upload error.
      return "invalid" as const;
    }
  })();

  // Each leg reads "failed" until it has succeeded, so a run the process died
  // under says so once its expiry has passed.
  const report: DatabaseBackupReport = {
    status: "failed",
    fileName: null,
    dumpBytes: null,
    local: localWritable ? "failed" : "no_directory",
    offhost: offhostConfig ? "failed" : "not_configured",
    removed: 0,
    error: null,
  };
  const run = await prisma.databaseBackupRun.create({
    data: {
      startedAt: now,
      status: "running",
      localResult: report.local,
      offhostResult: report.offhost,
    },
    select: { id: true },
  });

  let scratch: string | null = null;
  try {
    if (!databaseBackupEnabled(env)) {
      report.status = "skipped";
      report.local = "skipped";
      report.offhost = "skipped";
      report.error = "DB_BACKUP_ENABLED is false";
    } else if (!localWritable && !offhostConfig) {
      report.status = "skipped";
      report.error = `no writable backup directory (${dir}) and no off-host bucket configured`;
    } else {
      const target = localWritable
        ? dir
        : (scratch = await mkdtemp(join(tmpdir(), "healthlog-dump-")));
      const dump = await createDatabaseDump({
        databaseUrl: env.DATABASE_URL ?? "",
        dir: target,
        kind: "daily",
        now,
        env,
        appVersion: appVersion(env),
        buildSha: env.NEXT_PUBLIC_APP_BUILD_SHA?.trim() || null,
        deadline: options.deadline,
      });
      if (localWritable) report.local = "written";
      report.fileName = basename(dump.dumpPath);
      report.dumpBytes = dump.manifest.dump.bytes;

      let uploadError: string | null = null;
      if (offhostConfig === "invalid") {
        uploadError =
          "BACKUP_ENCRYPTION_KEY must be 64 hex characters or 32 bytes of base64";
      } else if (offhostConfig) {
        try {
          const s3 = options.s3 ?? (await getS3Client(offhostConfig));
          // The manifest goes up first: a dump object in the bucket always
          // has the manifest a restore checks it against.
          await uploadFile(s3, offhostConfig.encryptionKey, dump.manifestPath);
          await uploadFile(s3, offhostConfig.encryptionKey, dump.dumpPath);
          report.offhost = "uploaded";
        } catch (err) {
          uploadError = `off-host upload failed: ${reason(err)}`;
        }
      }

      if (localWritable) {
        const removed = await applyRetention(dir, {
          dailyKeep: resolveDailyKeep(env),
          now: now.getTime(),
        });
        report.removed = removed.length;
      }

      // Good when the dump exists somewhere it survives: on the volume, or in
      // the bucket. An upload that failed beside a kept dump still fails the
      // run, because the operator asked for both.
      report.status = uploadError ? "failed" : "succeeded";
      report.error = uploadError;
    }
  } catch (err) {
    report.status = "failed";
    report.error = reason(err);
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }

  await prisma.databaseBackupRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      status: report.status,
      fileName: report.fileName,
      dumpBytes: report.dumpBytes === null ? null : BigInt(report.dumpBytes),
      localResult: report.local,
      offhostResult: report.offhost,
      error: report.error,
    },
  });
  await prisma.databaseBackupRun.deleteMany({
    where: {
      startedAt: {
        lt: new Date(now.getTime() - LEDGER_RETENTION_DAYS * 86_400_000),
      },
    },
  });

  annotate({
    action: { name: "database.backup.run" },
    meta: {
      status: report.status,
      local: report.local,
      offhost: report.offhost,
      dump_bytes: report.dumpBytes ?? 0,
      removed: report.removed,
    },
  });
  return report;
}
