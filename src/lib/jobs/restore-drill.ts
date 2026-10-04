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
 * This drill closes that gap once a month: fetch every backup object of
 * the most recent date (one per account), decrypt it, JSON-parse it,
 * sanity-check the payload shape, and open inner values under each
 * application key it needs. Each account is reported on its own. It deliberately performs NO database restore — the
 * drill validates the artefact, not the import path. The result is
 * surfaced through the wide-event meta on success and through
 * `reportWorkerError` (stderr + GlitchTip) on any failure, so a broken
 * backup chain pages the operator eleven months before it matters.
 *
 * Schedule: 04:11 on the 1st of each month (`11 4 1 * *`), after the
 * 02:30 nightly upload and the 03:xx cleanup window, on a minute slot
 * no other cron uses.
 *
 * The drill reads every account's object, so it runs as a long pass: an
 * explicit expiry (`RESTORE_DRILL_EXPIRE_SECONDS`), a stop between accounts
 * on the job's budget, a lock so two drills never overlap (`lockedPass` at
 * the binding), and no retry. A retry would re-read the same objects and
 * page the same failed accounts a second and third time; each account is
 * reported once per run, and the next drill is the retry.
 */
import type { Job } from "pg-boss";
import { BackupJsonError, scanBackupJson } from "@/lib/export/backup-json-scan";
import {
  assessBackupKeys,
  BackupKeyIdCollector,
  describeBackupKeyProblem,
} from "@/lib/export/backup-key-ids";
import {
  openBackupObject,
  offhostKeyRing,
  getS3Client,
  loadOffhostConfig,
  OffhostBackupNotConfiguredError,
  type S3Like,
} from "@/lib/jobs/offhost-backup";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { jobBudget } from "@/lib/jobs/job-budget";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";

export const RESTORE_DRILL_QUEUE = "data-restore-drill";
export const RESTORE_DRILL_CRON = "11 4 1 * *";

/**
 * Four hours, the off-host upload's own window: the drill downloads and
 * stream-parses every object that upload wrote in one night.
 */
export const RESTORE_DRILL_EXPIRE_SECONDS = 4 * 60 * 60;

/**
 * What the monthly schedule sends with: the expiry above and no retry
 * (`retryLimit: 0`, the maintenance schedules' `cronIsTheRetry`).
 */
export const RESTORE_DRILL_SEND_OPTIONS = {
  expireInSeconds: RESTORE_DRILL_EXPIRE_SECONDS,
  retryLimit: 0,
} as const;

/**
 * A drill run that finds the newest backup older than this is reported
 * as a failure even when decrypt + parse succeed: the nightly uploader
 * has evidently stopped producing fresh objects (or the lifecycle rule
 * is eating them faster than they are written).
 */
const MAX_BACKUP_AGE_DAYS = 3;

const BACKUP_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})\/user-.+\.json\.enc$/;

/** What the drill found for one account's object. */
export interface RestoreDrillAccount {
  objectKey: string;
  ok: boolean;
  /** Why the object could not be restored on this server; set when not ok. */
  error?: string;
  ciphertextBytes: number;
  plaintextBytes: number;
  /** Application key ids the object's inner ciphertext needs, each proven to open. */
  innerKeyIds: string[];
  recordCounts: {
    measurements: number;
    medications: number;
    intakeEvents: number;
    moodEntries: number;
  };
}

export interface RestoreDrillReport {
  dateKey: string;
  ageDays: number;
  stale: boolean;
  /** Every object of the newest date, in key order. */
  accounts: RestoreDrillAccount[];
  /** The accounts whose object did not pass. */
  failed: RestoreDrillAccount[];
  /** Objects of the newest date the run stopped before, on its budget. */
  unchecked: number;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

const EMPTY_COUNTS: RestoreDrillAccount["recordCounts"] = {
  measurements: 0,
  medications: 0,
  intakeEvents: 0,
  moodEntries: 0,
};

/**
 * Fetch → decrypt → parse → key-check one object. Throws on every failure
 * mode: fetch error, bad envelope / wrong key, malformed JSON, payload
 * missing its core fields, inner ciphertext this server cannot open.
 */
async function drillObject(
  s3: S3Like,
  cfg: NonNullable<ReturnType<typeof loadOffhostConfig>>,
  objectKey: string,
  account: RestoreDrillAccount,
): Promise<void> {
  const ciphertext = await s3.getObject(objectKey);
  account.ciphertextBytes = ciphertext.length;
  // Read as a stream, never as one string: the JSON of a large record is
  // longer than any string V8 can hold (#1031). The bulk tables are counted,
  // not kept.
  const source = openBackupObject(ciphertext, offhostKeyRing(cfg), objectKey);
  async function* counted() {
    for await (const chunk of source()) {
      account.plaintextBytes += chunk.byteLength;
      yield chunk;
    }
  }
  // The envelope opening proves the off-host key. It proves nothing about
  // the application keys the ciphertext INSIDE was written under, and that
  // is the half a key rotation breaks: a restore of this object writes those
  // values back verbatim. So every inner key id is collected, and values
  // under each key are actually decrypted.
  const keys = new BackupKeyIdCollector();
  let scanned;
  try {
    scanned = await scanBackupJson(counted(), {
      streamKeys: new Set(["measurements", "intakeEvents", "moodEntries"]),
      onElement: (key, element) => keys.visit(element, key),
    });
  } catch (err) {
    if (err instanceof BackupJsonError) {
      throw new Error(`decrypted but is not a JSON object: ${err.message}`);
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
      "parses but is missing core fields (exportedAt / userId / measurements).",
    );
  }
  account.recordCounts = {
    measurements: streamedCounts.measurements,
    medications: countArray(payload.medications),
    intakeEvents: streamedCounts.intakeEvents ?? 0,
    moodEntries: streamedCounts.moodEntries ?? 0,
  };

  keys.visit(payload);
  const keyVerdict = assessBackupKeys(keys, {
    ignoreSections: new Set(["appSettings"]),
  });
  account.innerKeyIds = keyVerdict.keyIds;
  const keyProblem = describeBackupKeyProblem(keyVerdict);
  if (keyProblem) {
    throw new Error(
      `opens, but its content could not be restored on this server. ${keyProblem}`,
    );
  }
}

/**
 * Fetch → decrypt → parse every off-host backup object of the newest date,
 * one account at a time.
 *
 * Read-only against the bucket (GetObject + ListObjects — both inside
 * the uploader's existing IAM grant). Throws when there is nothing to check
 * (not configured, empty bucket); a failure of one account's object is
 * recorded against that account and the others are still checked, so one
 * account cannot turn the drill red without being named, nor hide another.
 */
export async function runRestoreDrill(
  s3Override?: S3Like,
  now: Date = new Date(),
  shouldStop: () => boolean = () => false,
): Promise<RestoreDrillReport> {
  const cfg = loadOffhostConfig();
  if (!cfg) {
    throw new OffhostBackupNotConfiguredError(
      "Off-host backup not configured — restore drill has nothing to verify.",
    );
  }
  const s3 = s3Override ?? (await getS3Client(cfg));

  // Date-prefixed keys (`YYYY-MM-DD/user-<id>.json.enc`) sort
  // lexicographically in chronological order, so the newest date is the
  // date of the maximum matching key. `_healthcheck/` probes and any
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
  const dateKey = BACKUP_KEY_PATTERN.exec(
    backupKeys[backupKeys.length - 1],
  )![1];
  const newest = backupKeys.filter((k) => k.startsWith(`${dateKey}/`));

  const accounts: RestoreDrillAccount[] = [];
  for (const objectKey of newest) {
    // Between accounts, never inside one: the job's budget is spent.
    if (shouldStop()) break;
    const account: RestoreDrillAccount = {
      objectKey,
      ok: true,
      ciphertextBytes: 0,
      plaintextBytes: 0,
      innerKeyIds: [],
      recordCounts: { ...EMPTY_COUNTS },
    };
    try {
      await drillObject(s3, cfg, objectKey, account);
    } catch (err) {
      account.ok = false;
      account.error = `Restore drill: backup object "${objectKey}" ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    accounts.push(account);
  }

  const ageDays = Math.floor(
    // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: age of a UTC-dated off-host object key
    (now.getTime() - Date.parse(`${dateKey}T00:00:00Z`)) /
      (24 * 60 * 60 * 1000),
  );

  return {
    dateKey,
    ageDays,
    stale: ageDays > MAX_BACKUP_AGE_DAYS,
    accounts,
    failed: accounts.filter((a) => !a.ok),
    unchecked: newest.length - accounts.length,
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
  const shouldStop = jobBudget(jobs);
  return withBackgroundEvent("job.restore_drill", async (evt) => {
    try {
      const report = await runRestoreDrill(undefined, new Date(), shouldStop);
      const total = (pick: (a: RestoreDrillAccount) => number) =>
        report.accounts.reduce((sum, a) => sum + pick(a), 0);
      const meta = {
        restore_drill_date: report.dateKey,
        restore_drill_age_days: report.ageDays,
        restore_drill_accounts: report.accounts.length,
        restore_drill_accounts_failed: report.failed.length,
        restore_drill_ciphertext_bytes: total((a) => a.ciphertextBytes),
        restore_drill_plaintext_bytes: total((a) => a.plaintextBytes),
        restore_drill_measurements: total((a) => a.recordCounts.measurements),
        restore_drill_medications: total((a) => a.recordCounts.medications),
        restore_drill_intake_events: total((a) => a.recordCounts.intakeEvents),
        restore_drill_mood_entries: total((a) => a.recordCounts.moodEntries),
        restore_drill_stale: report.stale,
        restore_drill_unchecked: report.unchecked,
      };
      for (const [key, value] of Object.entries(meta)) evt.addMeta(key, value);
      evt.addMeta(
        "restore_drill_inner_key_ids",
        [...new Set(report.accounts.flatMap((a) => a.innerKeyIds))]
          .sort()
          .join(","),
      );
      // One page per account that did not pass, naming its object, so the
      // operator sees which account it is and that the others passed.
      for (const account of report.failed) {
        evt.addWarning(account.error ?? `${account.objectKey} failed`);
        await reportWorkerError(
          RESTORE_DRILL_QUEUE,
          new Error(account.error ?? `${account.objectKey} failed`),
          {
            objectKey: account.objectKey,
            accountsChecked: report.accounts.length,
            accountsFailed: report.failed.length,
          },
        );
      }
      if (report.stale) {
        await reportWorkerError(
          RESTORE_DRILL_QUEUE,
          new Error(
            `Newest off-host backup is ${report.ageDays} days old (threshold ${MAX_BACKUP_AGE_DAYS}) — the nightly upload chain has stalled.`,
          ),
          { dateKey: report.dateKey, ageDays: report.ageDays },
        );
      }
      if (report.unchecked > 0) {
        await reportWorkerError(
          RESTORE_DRILL_QUEUE,
          new Error(
            `Restore drill stopped on its time budget with ${report.unchecked} of ${report.accounts.length + report.unchecked} backup objects unchecked.`,
          ),
          { dateKey: report.dateKey, unchecked: report.unchecked },
        );
      }
      if (report.failed.length > 0) {
        // Already paged above, per account. The queue does not retry: a
        // retry reads the same objects and would page the same accounts again.
        return jobFailed(
          `restore drill: ${report.failed.length} of ${report.accounts.length} accounts failed`,
          new Error(report.failed.map((a) => a.objectKey).join(", ")),
          meta,
        );
      }
      // A stale chain is a verdict about the uploader, not a failure of the
      // drill: the artefacts were fetched, decrypted and parsed, and the page
      // above already reached the operator. Failing the job here would retry a
      // reading that cannot change until the next upload lands.
      return jobDone(meta);
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
