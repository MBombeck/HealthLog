/**
 * The restore of one stored backup over its owner's record.
 *
 * After owner and schema validation (`restore-preflight.ts`), one transaction
 * replaces every serialized owner-scoped class. The transaction is a list of
 * steps, one or a few per domain, run in dependency order
 * (`backup-domains.ts`); each domain's module holds its own restore beside
 * its export. Document content and summary ciphertext are decoded from base64
 * and persisted verbatim.
 *
 * Metadata-only portable document exports are rejected before mutation; the
 * importer never fabricates content. Audit rows remain outside the wipe, and
 * cache invalidation runs only after the complete restore transaction.
 *
 * Everything above is scoped to ONE account. The instance-wide settings a
 * disaster-recovery payload also carries are not, and they are opt-in for that
 * reason: see `app-settings-backup.ts`.
 *
 * This used to be the body of `POST /api/admin/backups/[id]/restore`. On an
 * account of 1.25 million readings it ran for about a minute and a half inside
 * that request, and a reverse proxy that cuts a request at 60 s showed the
 * operator an error for a restore that went on to finish. The route now checks
 * the copy opens, queues a `backup-restore` job and answers 202; the job
 * (`src/lib/jobs/backup-restore.ts`) calls `restoreBackup` and records what it
 * reports. Nothing about what a restore checks or writes changed in the move:
 * every refusal still happens before the first delete, and the replacement is
 * still one transaction, so a failure part-way leaves the account exactly as
 * it was.
 */
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserData } from "@/lib/cache/invalidate";
import { prisma } from "@/lib/db";
import type { AccountSettingsRestoreResult } from "@/lib/export/account-settings-restore";
import { isRetargetedUploadType } from "@/lib/export/backup-upload-type";
import {
  RESTORE_CLEAR_STEPS,
  RESTORE_STEPS,
} from "@/lib/export/backup-domains";
import { createMeasurementRestorePrepass } from "@/lib/export/measurements-restore";
import {
  emptyRestoreLinks,
  orderedCleared,
  RESTORE_SECTION_STEPS,
  type MeasurementRestorePrepass,
  type RestoreCleared,
  type RestoreContext,
  type RestoreSectionStep,
} from "@/lib/export/restore-context";
import {
  classifyRestoreFailure,
  RESTORE_FAILURE_CAUSE_MESSAGES,
  isPrimaryKeyConflict,
} from "@/lib/export/restore-failure-cause";
import { takeRestoreLock } from "@/lib/export/restore-lock";
import {
  checkBackupBeforeRestore,
  openAndReadBackup,
  RESTORE_AFTER_TRANSACTION_ALLOWANCE_MS,
  refused,
  type ReadBackup,
} from "@/lib/export/restore-preflight";
import {
  summarizeRestoreSkips,
  type RestoreSkipLog,
  type RestoreSkipSummary,
} from "@/lib/export/restore-skips";
import {
  isStoredBackupReadError,
  storedBackupRefusal,
  type StoredBackupRef,
} from "@/lib/export/stored-backup";
import {
  assertNoNewForeignReferences,
  countForeignReferences,
  ForeignReferenceError,
  listTenantEdges,
} from "@/lib/export/tenant-boundary";
import { refreshTextsAfterUnitChange } from "@/lib/insights/unit-change-refresh";
import { enqueueMeasurementFoldRepair } from "@/lib/jobs/measurement-fold-repair";
import { annotate } from "@/lib/logging/context";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { recomputeUserMoodRollups } from "@/lib/rollups/mood-rollups";
import { stampSyncReset } from "@/lib/sync/reset";
import {
  summarizeBackup,
  type BackupSummary,
} from "@/lib/validations/backup-summary";

export { RESTORE_SECTION_STEPS } from "@/lib/export/restore-context";
export {
  RESTORE_AFTER_TRANSACTION_ALLOWANCE_MS,
  restoreTransactionTimeoutMs,
} from "@/lib/export/restore-preflight";

export interface RestoreResponse {
  restored: true;
  summary: BackupSummary;
  /**
   * What the file carried that this instance could not resolve, named.
   *
   * `links: 0` with an empty list is the normal answer and says so: nothing
   * was dropped. Anything else has to reach the operator's screen, because a
   * restore that quietly loses links looks exactly like one that did not.
   */
  skipped: RestoreSkipSummary;
  cleared: RestoreCleared;
}

/** Where a running restore is. */
export type RestorePhase =
  "validating" | "clearing" | "measurements" | "sections" | "rebuilding";

/**
 * How far a running restore has got. Counts, never content.
 *
 * `measurementsTotal` is null until the first read of the file has counted
 * them; the other sections are small next to the measurements and are counted
 * as steps, `sectionsDone` of `sectionsTotal`.
 */
export interface RestoreProgress {
  measurementsChecked: number;
  measurementsTotal: number | null;
  measurementsWritten: number;
  sectionsDone: number;
  sectionsTotal: number;
}

/** Receives the phase and the counts as the restore moves. Cheap to call. */
export type RestoreProgressSink = (
  phase: RestorePhase,
  progress: RestoreProgress,
) => void;

/**
 * Why a restore did not happen, as a stable code. Every one of them is decided
 * before the first delete or rolls the whole transaction back, so each means
 * the account is unchanged.
 */
/** A retargeted copy whose rows another account already holds. */
const ROWS_EXIST_ELSEWHERE_CODE = "backup.restore.rows_exist_elsewhere";

export type RestoreFailureCode =
  | "backup_not_found"
  | "backup_changed"
  | "backup.payload.undecryptable"
  | "schema_invalid"
  | "incompatible_schema_version"
  | "owner_mismatch"
  | "owner_not_found"
  | "backup.section.missing"
  | "document_ciphertext_missing"
  | "backup.key.missing"
  | "backup.foreign_reference"
  | "backup.restore.rows_exist_elsewhere"
  | "time_budget"
  | "transaction_failed"
  | "interrupted"
  | "unexpected";

export interface RestoreBackupInput {
  /** The stored copy, as read from `data_backups` (`STORED_BACKUP_SELECT`). */
  backup: StoredBackupRef;
  /** The admin who asked for the restore; the audit rows name them. */
  actorUserId: string;
  /** Where the request came from, when there was one. */
  ipAddress: string | null;
  restoreInstanceSettings: boolean;
  progress?: RestoreProgressSink;
  /**
   * Awaited right after the transaction commits, before the rollup rebuild.
   * The caller records that the account now holds the restored data, so a
   * restore interrupted after this point is never run a second time.
   */
  onCommitted?: () => Promise<void>;
  /**
   * Epoch milliseconds by which the restore has to be over. When the
   * transaction's own time limit would run past it, the restore is refused
   * before anything is deleted rather than started and cut off.
   */
  deadline?: number;
}

export type RestoreBackupOutcome =
  | { ok: true; response: RestoreResponse }
  | {
      ok: false;
      /** The HTTP status the synchronous route used to answer with. */
      status: number;
      code: RestoreFailureCode;
      message: string;
      meta?: Record<string, unknown>;
    };

/** The phase and the counts, and the one way to report them. */
export interface RestoreProgressTracker {
  readonly progress: RestoreProgress;
  report(next?: RestorePhase, force?: boolean): void;
  reportSection(step: RestoreSectionStep): void;
}

function progressTracker(sink?: RestoreProgressSink): RestoreProgressTracker {
  const progress: RestoreProgress = {
    measurementsChecked: 0,
    measurementsTotal: null,
    measurementsWritten: 0,
    sectionsDone: 0,
    sectionsTotal: RESTORE_SECTION_STEPS.length,
  };
  let phase: RestorePhase = "validating";
  // Called once per measurement while the file is read, so a repeat of the
  // same phase is passed on at most four times a second; a new phase or a new
  // section always is.
  let lastReportAt = 0;
  const report = (next: RestorePhase = phase, force = false) => {
    const now = Date.now();
    if (next === phase && !force && now - lastReportAt < 250) return;
    phase = next;
    lastReportAt = now;
    sink?.(phase, { ...progress });
  };
  return {
    progress,
    report,
    reportSection(step) {
      progress.sectionsDone = RESTORE_SECTION_STEPS.indexOf(step);
      report("sections", true);
    },
  };
}

interface TransactionResult {
  cleared: RestoreCleared;
  skipped: RestoreSkipSummary;
  expiredTombstonesSkipped: number;
  foldRepairReset: boolean;
  accountSettings: AccountSettingsRestoreResult;
}

/**
 * The replacement itself: every step of every domain, in one transaction.
 *
 * Every connection carries the request limits from `src/lib/db.ts` (60 s per
 * statement, 60 s idle inside a transaction). A restore is not a request:
 * deleting two million readings is one statement, and on a slow disk it ran
 * past 60 s, was cancelled, and the whole restore rolled back in its clearing
 * step (#1031). The transaction has its own limit; SET LOCAL gives each
 * statement the same one, and ends with the transaction.
 *
 * One restore of an account at a time, whatever let a second one start: the
 * job table admits one queued or running job per account, and the restore
 * lock holds even if a worker that was thought gone is still writing. A
 * second transaction waits for the first to commit or roll back, then
 * replaces the account again from its own file. The same lock orders the
 * restore against the background passes that rewrite readings a day at a time
 * (`restore-lock.ts`): they hold it shared for each day, so the delete never
 * meets a day half folded, which is where the two used to deadlock.
 *
 * Every reference this restore writes stays inside the account: the
 * references that leave it are counted before the first step and again after
 * the last write, and any that grew rolls the whole transaction back
 * (`tenant-boundary.ts` says why the check is derived from the schema rather
 * than written per section).
 */
async function replaceAccount(
  read: ReadBackup,
  ownerId: string,
  restoreInstanceSettings: boolean,
  retargeted: boolean,
  transactionTimeoutMs: number,
  tracker: RestoreProgressTracker,
  prepass: MeasurementRestorePrepass,
): Promise<TransactionResult> {
  tracker.report("clearing");
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(transactionTimeoutMs)}, true), set_config('idle_in_transaction_session_timeout', ${String(transactionTimeoutMs)}, true)`;
      await takeRestoreLock(tx, ownerId);
      const tenantEdges = await listTenantEdges(tx);
      const foreignBefore = await countForeignReferences(
        tx,
        ownerId,
        tenantEdges,
      );
      // Declared INSIDE the transaction so a rollback takes the report with
      // it. An accumulator that outlived a failed attempt would carry drops
      // that never happened into the next one.
      const skips: RestoreSkipLog = [];
      const ctx: RestoreContext = {
        tx,
        ownerId,
        payload: read.payload,
        streamed: read.streamed,
        skips,
        restoreInstanceSettings,
        retargeted,
        measurementPrepass: prepass,
        links: emptyRestoreLinks(),
        outputs: {
          expiredTombstonesSkipped: 0,
          foldRepairReset: false,
          accountSettings: { applied: 0, refused: [], unitsChanged: false },
        },
        cleared: {},
        reportSection: tracker.reportSection,
        reportMeasurements(written) {
          tracker.progress.measurementsWritten += written;
          tracker.report("measurements");
        },
      };
      for (const step of RESTORE_CLEAR_STEPS) await step.run(ctx);
      for (const step of RESTORE_STEPS) await step.run(ctx);

      const cleared = orderedCleared(ctx.cleared);
      assertNoNewForeignReferences(
        foreignBefore,
        await countForeignReferences(tx, ownerId, tenantEdges),
      );
      // Paired clients' delta cursors are no longer valid (see
      // `User.syncResetAt`). Stamped as the last write, so it commits with
      // the data, and stamped again right after the commit to cover a cursor
      // issued while this transaction was still running.
      await stampSyncReset(tx, ownerId);
      tracker.progress.sectionsDone = RESTORE_SECTION_STEPS.length;
      tracker.report("sections", true);
      return {
        cleared,
        skipped: summarizeRestoreSkips(skips),
        expiredTombstonesSkipped: ctx.outputs.expiredTombstonesSkipped,
        foldRepairReset: ctx.outputs.foldRepairReset,
        accountSettings: ctx.outputs.accountSettings,
      };
    },
    {
      maxWait: 10_000,
      timeout: transactionTimeoutMs,
    },
  );
}

/**
 * Why the transaction failed, recorded and answered.
 *
 * The raw Prisma / driver error is scrubbed from the answer — even on an
 * admin endpoint, leaking column names, constraint names or query fragments
 * lowers the cost of a future supply-chain attack against this surface. The
 * verbose text still lands in the audit row (admin-readable) and the wide
 * event (operator-readable), so root-cause investigation is unaffected.
 */
async function transactionRefusal(
  input: RestoreBackupInput,
  ownerId: string,
  transactionTimeoutMs: number,
  retargeted: boolean,
  err: unknown,
): Promise<RestoreBackupOutcome> {
  const verbose = err instanceof Error ? err.message : String(err);
  const classified = classifyRestoreFailure(err);
  await auditLog("admin.backups.restore.failed", {
    userId: input.actorUserId,
    ipAddress: input.ipAddress,
    details: {
      backupId: input.backup.id,
      ownerId,
      reason: "transaction_failed",
      cause: classified.cause,
      code: classified.code,
      message: verbose,
    },
  });
  annotate({
    meta: {
      restoreFailReason: verbose,
      restoreFailCause: classified.cause,
      restoreFailCode: classified.code,
      restoreTransactionTimeoutMs: transactionTimeoutMs,
    },
  });
  if (err instanceof ForeignReferenceError) {
    return refused(422, "backup.foreign_reference", err.message, {
      errorCode: "backup.foreign_reference",
      references: err.edges,
    });
  }
  if (retargeted && isPrimaryKeyConflict(err)) {
    // Rows keep their ids from the file, so the copy of an erased account
    // can live in one account only. Rolled back, so nothing was changed.
    return refused(
      409,
      ROWS_EXIST_ELSEWHERE_CODE,
      "Records in this copy are already in this database, so the file was most likely already restored into another account. A file can be restored into one account only. Nothing was changed.",
      { errorCode: ROWS_EXIST_ELSEWHERE_CODE },
    );
  }
  if (isStoredBackupReadError(err)) {
    // The second read, inside the transaction, found the copy replaced or
    // altered. The transaction rolled back, so nothing was changed.
    const refusal = storedBackupRefusal(err);
    return refused(refusal.status, refusal.code, refusal.message, {
      errorCode: refusal.code,
    });
  }
  // The wide event and the audit row carry the whole error. The job's row is
  // read by whoever started the restore, so it names the cause, never the
  // database's message, which can quote the rows involved.
  return refused(
    500,
    "transaction_failed",
    RESTORE_FAILURE_CAUSE_MESSAGES[classified.cause],
    { cause: classified.cause },
  );
}

/** Best-effort work after the commit; a failure is noted, never thrown. */
async function bestEffort(
  work: () => Promise<unknown>,
  failed: string,
  error: string,
): Promise<void> {
  try {
    await work();
  } catch (err) {
    annotate({
      meta: {
        [failed]: true,
        [error]: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/** The counts the audit row lists under `restored`, in its order. */
function restoredCounts(summary: BackupSummary) {
  return {
    measurements: summary.measurements,
    medications: summary.medications,
    intakeEvents: summary.intakeEvents,
    moodEntries: summary.moodEntries,
    cycles: summary.cycles,
    cycleDayLogs: summary.cycleDayLogs,
    labResults: summary.labResults,
    biomarkers: summary.biomarkers,
    nutrientDays: summary.nutrientDays,
    illnessEpisodes: summary.illnessEpisodes,
    illnessDayLogs: summary.illnessDayLogs,
    allergies: summary.allergies,
    familyHistory: summary.familyHistory,
    workouts: summary.workouts,
    documents: summary.documents,
    healthProfile: summary.healthProfile,
    healthProfileFactRevisions: summary.healthProfileFactRevisions,
    customMetrics: summary.customMetrics,
    customMetricEntries: summary.customMetricEntries,
    correlationPatterns: summary.correlationPatterns,
    practitioners: summary.practitioners,
    encounters: summary.encounters,
    encounterLinks: summary.encounterLinks,
    vaccinations: summary.vaccinations,
    vaccinationLinks: summary.vaccinationLinks,
    relationLinks: summary.relationLinks,
    customVaccines: summary.customVaccines,
    measurementReminders: summary.measurementReminders,
    measurementReminderEvents: summary.measurementReminderEvents,
  };
}

/**
 * Everything after the commit: the second sync stamp, the queued repair, the
 * rollup rebuilds, the audit row and the cache. None of it can undo the
 * restore.
 */
async function afterCommit(
  input: RestoreBackupInput,
  read: ReadBackup,
  owner: { id: string; username: string },
  result: TransactionResult,
  tracker: RestoreProgressTracker,
): Promise<RestoreResponse> {
  const ownerId = owner.id;
  // A pull that started before the commit read the pre-restore rows and may
  // have been issued a cursor after the stamp inside the transaction. The
  // second stamp expires that one too; it can only expire more cursors, so a
  // failure here costs a client at most one extra incremental page.
  await bestEffort(
    () => stampSyncReset(prisma, ownerId),
    "restore_sync_reset_failed",
    "restore_sync_reset_error",
  );

  const { cleared, skipped, expiredTombstonesSkipped, accountSettings } =
    result;
  const measurementsRestored =
    read.streamed.measurementCount - expiredTombstonesSkipped;
  annotate({
    meta: { restore_expired_tombstones_skipped: expiredTombstonesSkipped },
  });
  tracker.report("rebuilding", true);
  await input.onCommitted?.();

  // Pinned shape, not free text: a dashboard can alert on
  // `restoreSkippedLinks > 0` and the key list says which catalogue drifted.
  annotate({
    meta: {
      restoreSkippedLinks: skipped.links,
      restoreSkippedKeys: skipped.catalogueKeys
        .map((entry) => `${entry.catalogue}:${entry.key}`)
        .join(","),
    },
  });

  // The restore took the fold repair marker away (see the measurement pass):
  // queue the repair now that the restored rows are committed. Best-effort;
  // the next boot's discovery queues it otherwise, and the purge waits
  // either way.
  if (result.foldRepairReset) {
    await bestEffort(
      () => enqueueMeasurementFoldRepair(ownerId),
      "fold_repair_enqueue_failed",
      "fold_repair_enqueue_error",
    );
  }

  // Re-fold the persistent measurement rollup tier from the just-restored
  // measurements, outside the transaction (the 5-year fold would otherwise
  // hold a long write lock) and best-effort so a populator hiccup never
  // undoes the restore; the boot-time backfill is the safety net. The fold
  // covers five years in a handful of statements, right after the restore
  // wrote every reading; on a slow disk one of them ran past the per-request
  // statement limit (#1031), so it gets the time the deadline check keeps
  // free for it.
  if (measurementsRestored > 0) {
    await bestEffort(
      () =>
        recomputeUserRollups(ownerId, {
          statementTimeoutMs: RESTORE_AFTER_TRANSACTION_ALLOWANCE_MS,
        }),
      "measurement_rollup_restore_failed",
      "measurement_rollup_restore_error",
    );
  }

  // The mood rollup tier, the same way.
  if (read.payload.moodEntries.length > 0) {
    await bestEffort(
      () => recomputeUserMoodRollups(ownerId, { granularities: ["DAY"] }),
      "mood_rollup_restore_failed",
      "mood_rollup_restore_error",
    );
  }

  const summary = {
    ...summarizeBackup(read.payload),
    measurements: measurementsRestored,
  };
  await auditLog("admin.backups.restore", {
    userId: input.actorUserId,
    ipAddress: input.ipAddress,
    details: {
      backupId: input.backup.id,
      ownerId,
      ownerUsername: owner.username,
      // Whether this restore also rewrote the host's own settings. The one
      // effect of a restore that reaches accounts other than `ownerId`, so
      // the trail has to be able to answer it later.
      restoreInstanceSettings: input.restoreInstanceSettings,
      cleared,
      // How many of the account's own settings came back. The ones that did
      // not are named in `skipped` under `accountSetting`.
      accountSettingsApplied: accountSettings.applied,
      // The durable half of the report. The response reaches whoever was
      // looking at the screen; the audit row is still here next week when
      // someone asks why a day-log lost a symptom.
      skipped,
      restored: restoredCounts(summary),
    },
  });

  // The complete transaction succeeded; only now evict owner-scoped caches.
  invalidateUserData(ownerId);

  // A restored unit preference leaves the stored status notes and period
  // narratives quoting the old unit, the same gap the settings routes close
  // on a unit change, closed the same way. Fire-and-forget: the restore has
  // committed and never fails over a re-warm.
  if (accountSettings.unitsChanged) {
    void refreshTextsAfterUnitChange(ownerId);
  }

  return { restored: true, summary, skipped, cleared };
}

/**
 * Restore one stored backup over its owner's record. Resolves with what the
 * transaction did, or with why nothing was done; throws only for a fault
 * outside the restore's own checks (the database gone, for instance).
 */
export async function restoreBackup(
  input: RestoreBackupInput,
): Promise<RestoreBackupOutcome> {
  const { backup, restoreInstanceSettings } = input;
  annotate({
    action: { name: "admin.backups.restore" },
    meta: { id: backup.id, restore_instance_settings: restoreInstanceSettings },
  });
  const tracker = progressTracker(input.progress);
  tracker.report("validating", true);

  const prepass = createMeasurementRestorePrepass();
  const opened = await openAndReadBackup(input, tracker, prepass);
  if (!opened.ok) return opened.outcome;
  const { read } = opened;
  const checked = await checkBackupBeforeRestore(input, read);
  if (!checked.ok) return checked.outcome;
  const { owner, transactionTimeoutMs } = checked;
  // Read from the row, not passed in, so no caller can leave it out.
  const stored = await prisma.dataBackup.findUnique({
    where: { id: backup.id },
    select: { type: true },
  });
  const retargeted = isRetargetedUploadType(stored?.type ?? "");

  let result: TransactionResult;
  try {
    result = await replaceAccount(
      read,
      owner.id,
      restoreInstanceSettings,
      retargeted,
      transactionTimeoutMs,
      tracker,
      prepass,
    );
  } catch (err) {
    return transactionRefusal(
      input,
      owner.id,
      transactionTimeoutMs,
      retargeted,
      err,
    );
  }

  const response = await afterCommit(input, read, owner, result, tracker);
  return { ok: true, response };
}
