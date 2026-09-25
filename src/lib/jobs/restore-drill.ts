/**
 * Monthly off-host backup restore drill (v1.16.4).
 *
 * A backup that has never been read back is a hope, not a backup. The
 * off-host uploader (`offhost-backup.ts`) writes an encrypted snapshot
 * per user every night, but nothing on the write path proves the
 * objects are still fetchable, decryptable under the CURRENT
 * `BACKUP_ENCRYPTION_KEY`, and structurally parseable. A silent key
 * rotation mishap or a bucket-side corruption would only surface on
 * the day a real restore is needed.
 *
 * This drill closes that gap once a month: fetch the most recent
 * backup object, decrypt it, JSON-parse it, and sanity-check the
 * payload shape. It deliberately performs NO database restore — the
 * drill validates the artefact, not the import path. The result is
 * surfaced through the wide-event meta on success and through
 * `reportWorkerError` (stderr + GlitchTip) on any failure, so a broken
 * backup chain pages the operator eleven months before it matters.
 *
 * Schedule: 04:11 on the 1st of each month (`11 4 1 * *`), after the
 * 02:30 nightly upload and the 03:xx cleanup window, on a minute slot
 * no other cron uses.
 */
import type { Job } from "pg-boss";
import { BackupJsonError, scanBackupJson } from "@/lib/export/backup-json-scan";
import {
  openBackupObject,
  getS3Client,
  loadOffhostConfig,
  OffhostBackupNotConfiguredError,
  type S3Like,
} from "@/lib/jobs/offhost-backup";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";

export const RESTORE_DRILL_QUEUE = "data-restore-drill";
export const RESTORE_DRILL_CRON = "11 4 1 * *";

/**
 * A drill run that finds the newest backup older than this is reported
 * as a failure even when decrypt + parse succeed: the nightly uploader
 * has evidently stopped producing fresh objects (or the lifecycle rule
 * is eating them faster than they are written).
 */
const MAX_BACKUP_AGE_DAYS = 3;

const BACKUP_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})\/user-.+\.json\.enc$/;

export interface RestoreDrillReport {
  objectKey: string;
  dateKey: string;
  ageDays: number;
  stale: boolean;
  ciphertextBytes: number;
  plaintextBytes: number;
  recordCounts: {
    measurements: number;
    medications: number;
    intakeEvents: number;
    moodEntries: number;
  };
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Fetch → decrypt → parse the most recent off-host backup object.
 *
 * Read-only against the bucket (GetObject + ListObjects — both inside
 * the uploader's existing IAM grant). Throws on every failure mode:
 * not configured, empty bucket, fetch error, bad envelope / wrong key,
 * malformed JSON, payload missing its core fields.
 */
export async function runRestoreDrill(
  s3Override?: S3Like,
  now: Date = new Date(),
): Promise<RestoreDrillReport> {
  const cfg = loadOffhostConfig();
  if (!cfg) {
    throw new OffhostBackupNotConfiguredError(
      "Off-host backup not configured — restore drill has nothing to verify.",
    );
  }
  const s3 = s3Override ?? (await getS3Client(cfg));

  // Date-prefixed keys (`YYYY-MM-DD/user-<id>.json.enc`) sort
  // lexicographically in chronological order, so the newest object is
  // simply the maximum matching key. `_healthcheck/` probes and any
  // foreign objects in the bucket are filtered out by the pattern.
  const objects = await s3.listObjects("");
  const backupKeys = objects
    .map((o) => o.key)
    .filter((k) => BACKUP_KEY_PATTERN.test(k))
    .sort();
  if (backupKeys.length === 0) {
    throw new Error(
      `Restore drill found no backup objects in bucket "${cfg.bucket}" — the nightly off-host upload is not producing artefacts.`,
    );
  }
  const objectKey = backupKeys[backupKeys.length - 1];
  const dateKey = BACKUP_KEY_PATTERN.exec(objectKey)![1];

  const ciphertext = await s3.getObject(objectKey);
  // Read as a stream, never as one string: the JSON of a large record is
  // longer than any string V8 can hold (#1031). The bulk tables are counted,
  // not kept.
  const source = openBackupObject(ciphertext, cfg.encryptionKey);
  let plaintextBytes = 0;
  async function* counted() {
    for await (const chunk of source()) {
      plaintextBytes += chunk.byteLength;
      yield chunk;
    }
  }
  let scanned;
  try {
    scanned = await scanBackupJson(counted(), {
      streamKeys: new Set(["measurements", "intakeEvents", "moodEntries"]),
    });
  } catch (err) {
    if (err instanceof BackupJsonError) {
      throw new Error(
        `Restore drill: backup object "${objectKey}" decrypted but is not a JSON object: ${err.message}`,
      );
    }
    throw err;
  }
  const payload = scanned.document;
  const streamedCounts = scanned.streamedCounts;
  if (
    typeof payload.exportedAt !== "string" ||
    typeof payload.userId !== "string" ||
    streamedCounts.measurements === undefined
  ) {
    throw new Error(
      `Restore drill: backup object "${objectKey}" parses but is missing core fields (exportedAt / userId / measurements).`,
    );
  }

  const ageDays = Math.floor(
    (now.getTime() - Date.parse(`${dateKey}T00:00:00Z`)) /
      (24 * 60 * 60 * 1000),
  );

  return {
    objectKey,
    dateKey,
    ageDays,
    stale: ageDays > MAX_BACKUP_AGE_DAYS,
    ciphertextBytes: ciphertext.length,
    plaintextBytes,
    recordCounts: {
      measurements: streamedCounts.measurements,
      medications: countArray(payload.medications),
      intakeEvents: streamedCounts.intakeEvents ?? 0,
      moodEntries: streamedCounts.moodEntries ?? 0,
    },
  };
}

/**
 * pg-boss handler. Mirrors the off-host uploader's posture: a
 * not-configured deployment skips with a wide-event warning (most
 * self-hosters never set the S3 vars and must not see a monthly error
 * page); every other failure goes through `reportWorkerError` so the
 * operator hears about a rotting backup chain.
 */
export async function handleRestoreDrill(
  jobs: Job<object>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.restore_drill", async (evt) => {
    try {
      const report = await runRestoreDrill();
      evt.addMeta("restore_drill_object_key", report.objectKey);
      evt.addMeta("restore_drill_age_days", report.ageDays);
      evt.addMeta("restore_drill_ciphertext_bytes", report.ciphertextBytes);
      evt.addMeta("restore_drill_plaintext_bytes", report.plaintextBytes);
      evt.addMeta(
        "restore_drill_measurements",
        report.recordCounts.measurements,
      );
      evt.addMeta("restore_drill_medications", report.recordCounts.medications);
      evt.addMeta(
        "restore_drill_intake_events",
        report.recordCounts.intakeEvents,
      );
      evt.addMeta(
        "restore_drill_mood_entries",
        report.recordCounts.moodEntries,
      );
      evt.addMeta("restore_drill_stale", report.stale);
      if (report.stale) {
        await reportWorkerError(
          RESTORE_DRILL_QUEUE,
          new Error(
            `Newest off-host backup is ${report.ageDays} days old (threshold ${MAX_BACKUP_AGE_DAYS}) — the nightly upload chain has stalled.`,
          ),
          { objectKey: report.objectKey, ageDays: report.ageDays },
        );
      }
      // A stale chain is a verdict about the uploader, not a failure of the
      // drill: the artefact was fetched, decrypted and parsed, and the page
      // above already reached the operator. Failing the job here would retry a
      // reading that cannot change until the next upload lands.
      return jobDone({
        restore_drill_age_days: report.ageDays,
        restore_drill_ciphertext_bytes: report.ciphertextBytes,
        restore_drill_plaintext_bytes: report.plaintextBytes,
        restore_drill_measurements: report.recordCounts.measurements,
        restore_drill_medications: report.recordCounts.medications,
        restore_drill_intake_events: report.recordCounts.intakeEvents,
        restore_drill_mood_entries: report.recordCounts.moodEntries,
        restore_drill_stale: report.stale,
      });
    } catch (err) {
      if (err instanceof OffhostBackupNotConfiguredError) {
        evt.addWarning(`restore-drill skipped: ${err.message}`);
        // Most self-hosters never set the S3 vars. Nothing to verify is not a
        // failed verification, and a monthly failed job would be noise.
        return jobDone({ skipped: "offhost_backup_not_configured" });
      }
      evt.addWarning(`restore-drill failed: ${err}`);
      await reportWorkerError(RESTORE_DRILL_QUEUE, err);
      return jobFailed("restore drill failed", err);
    }
  });
}
