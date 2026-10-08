/**
 * The restore of one stored backup over its owner's record.
 *
 * After owner and schema validation, one transaction replaces every
 * serialized owner-scoped class: measurements, medication history including the
 * side effects recorded against a drug, mood and rated factors, cycle data,
 * labs/biomarkers, illness history, allergies, family history, workout
 * summaries, and inbound documents. Document content and summary ciphertext are
 * decoded from base64 and persisted verbatim.
 *
 * Metadata-only portable document exports are rejected before mutation; the
 * importer never fabricates content. Audit rows remain outside the wipe, and
 * cache invalidation runs only after the complete restore transaction.
 *
 * Everything above is scoped to ONE account. The instance-wide settings a
 * disaster-recovery payload also carries are not, and they are opt-in for that
 * reason: see the `restoreInstanceSettings` block below.
 *
 * This used to be the body of `POST /api/admin/backups/[id]/restore`. On an
 * account of 1.25 million readings it ran for about a minute and a half inside
 * that request, and a reverse proxy that cuts a request at 60 s showed the
 * operator an error for a restore that went on to finish. The route now checks
 * the copy opens, queues a `backup-restore` job and answers 202; the job
 * (`src/lib/jobs/backup-restore.ts`) calls `restoreBackup` and records what it
 * reports. Nothing about what a restore checks or writes changed in the move:
 * every refusal below still happens before the first delete, and the
 * replacement is still one transaction, so a failure part-way leaves the
 * account exactly as it was.
 */
import { DEFAULT_TIMEZONE, userDayKey, validTimezoneOr } from "@/lib/tz/format";
import {
  courseFromWindow,
  dateOfDayKey,
  projectCourseWindow,
} from "@/lib/medications/course-window";
import { Buffer } from "node:buffer";

import { DEFAULT_REASONING_MAX_EFFORT } from "@/lib/ai/reasoning/levels";
import { prisma, toJson } from "@/lib/db";
import { normaliseSourceInstance } from "@/lib/validations/inbound-documents";
import { auditLog } from "@/lib/auth/audit";
import {
  isStoredBackupReadError,
  openStoredBackup,
  storedBackupRefusal,
  type StoredBackupRef,
} from "@/lib/export/stored-backup";
import { takeRestoreLock } from "@/lib/export/restore-lock";
import {
  insertMeasurementRows,
  type MeasurementInsertRow,
} from "@/lib/export/measurement-bulk-insert";
import {
  readStreamedBackup,
  type BackupSource,
  type StreamedBackup,
} from "@/lib/export/streamed-backup";
import {
  assessBackupKeys,
  BACKUP_KEY_MISSING_CODE,
  describeBackupKeyProblem,
} from "@/lib/export/backup-key-ids";
import {
  assertNoNewForeignReferences,
  countForeignReferences,
  ForeignReferenceError,
  listTenantEdges,
} from "@/lib/export/tenant-boundary";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { sealForRestore } from "@/lib/export/sealed-text";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptContextToBytes } from "@/lib/labs/biomarker-store";
import { encryptNoteToBytes } from "@/lib/labs/store";
import { annotate } from "@/lib/logging/context";
import type { BackupMeasurement } from "@/lib/validations/backup";
import {
  isCompatibleSchemaVersion,
  summarizeBackup,
  type BackupSummary,
} from "@/lib/validations/backup-summary";
import { recomputeUserMoodRollups } from "@/lib/rollups/mood-rollups";
import {
  recomputeUserMedicationCompliance,
  MEDICATION_COMPLIANCE_BACKFILL_DAYS,
} from "@/lib/rollups/medication-compliance-rollups";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { restoreCycleData } from "@/lib/cycle/backup";
import {
  findMissingBackupSections,
  recordUnknownKeys,
  summarizeRestoreSkips,
  type RestoreSkipLog,
  type RestoreSkipSummary,
} from "@/lib/export/restore-skips";
import { restoreProfileData } from "@/lib/export/profile-backup";
import { restoreIntradayProfileData } from "@/lib/export/intraday-profile-backup";
import { restoreHealthScoreData } from "@/lib/export/health-score-backup";
import { restoreOnboardingData } from "@/lib/export/onboarding-backup";
import {
  restoreAccountSettings,
  type AccountSettingsRestoreResult,
} from "@/lib/export/account-settings-backup";
import { refreshTextsAfterUnitChange } from "@/lib/insights/unit-change-refresh";
import { restoreVisitsData } from "@/lib/export/visits-backup";
import { restoreVaccinationsData } from "@/lib/export/vaccinations-backup";
import { restoreSensitiveData } from "@/lib/export/sensitive-backup";
import {
  restoreCoachData,
  restoreCoachMemoryData,
} from "@/lib/export/coach-backup";
import { restoreRemindersData } from "@/lib/export/reminders-backup";
import { restoreDocumentFilingData } from "@/lib/export/document-filing-backup";
import { restoreAwardsData } from "@/lib/export/awards-backup";
import { restoreEnvironmentData } from "@/lib/export/environment-backup";
import { restoreEcgData } from "@/lib/export/ecg-backup";
import { restoreSymptomsData } from "@/lib/export/symptoms-backup";
import { restoreLifeEventsData } from "@/lib/export/life-events-backup";
import { restoredMedicationCreatedAt } from "@/lib/export/medication-created-at";
import {
  encryptCategoryLabel,
  mintCustomMedicationCategoryKey,
  setMedicationCategory,
} from "@/lib/medication-category";
import { invalidateUserData } from "@/lib/cache/invalidate";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import {
  FOLDED_TYPES,
  coveringStatsExternalId,
  isFoldedWindowCandidate,
} from "@/lib/measurements/folded-window";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";
import { stampSyncReset } from "@/lib/sync/reset";
import {
  classifyRestoreFailure,
  RESTORE_FAILURE_CAUSE_MESSAGES,
} from "@/lib/export/restore-failure-cause";
import { foldLegacyCoachAvailability } from "@/lib/modules/operator-availability";

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
  cleared: {
    measurements: number;
    medications: number;
    intakeEvents: number;
    moodEntries: number;
    notificationChannels: number;
    pushSubscriptions: number;
    telegramScheduledDeletions: number;
    cycles: number;
    cycleDayLogs: number;
    cycleProfile: number;
    labResults: number;
    biomarkers: number;
    nutrientDays: number;
    illnessEpisodes: number;
    allergies: number;
    familyHistory: number;
    workouts: number;
    documents: number;
    documentConditionLinks: number;
    extractedFacts: number;
    healthProfile: number;
    healthProfileFactRevisions: number;
    customMetrics: number;
    correlationPatterns: number;
    intradayProfiles: number;
    healthScoreRecords: number;
    onboardingRecords: number;
    practitioners: number;
    encounters: number;
    encounterLinks: number;
    vaccinations: number;
    vaccinationLinks: number;
    customVaccines: number;
    measurementReminders: number;
    measurementReminderEvents: number;
    coachConversations: number;
    coachMessages: number;
    coachConversationDocuments: number;
    coachFacts: number;
    coachPlans: number;
    coachReminders: number;
    mentalHealthAssessments: number;
    consentReceipts: number;
    personalRecords: number;
    userAchievements: number;
    environmentContexts: number;
    environmentTravelLocations: number;
    ecgRecordings: number;
    symptomDefinitions: number;
    lifeEvents: number;
  };
}

/**
 * How long the restore transaction may run, and with it every statement
 * inside it (`SET LOCAL statement_timeout`, see the transaction below).
 *
 * The work is deleting the readings the account holds now and writing the
 * ones the file carries. Both count: an account whose readings were folded
 * into hourly averages still holds the originals as deleted rows until the
 * nightly purge removes them, and the restore deletes and rewrites those too
 * (#1031). Writing is the slow half, since every reading goes into thirteen
 * indexes. The budget is two minutes, plus a second per 1 000 readings in the
 * file and per 10 000 in the account. A seeded account of 1.89 million
 * readings restored in 196 s on a fast host and in 19 min on a database held
 * to half a CPU and 40 MB/s of writes, where its transaction ran 16 min of a
 * 37 min budget.
 */
export function restoreTransactionTimeoutMs(
  fileMeasurements: number,
  currentMeasurements: number,
): number {
  return 120_000 + fileMeasurements + Math.ceil(currentMeasurements / 10);
}

function readingsPhrase(count: number): string {
  return `${count} ${count === 1 ? "reading" : "readings"}`;
}

function decodeEncryptedBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
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
 * The steps after the measurements that report as sections, in order. The
 * restore names each one as it starts it (`reportSection`), so the count the
 * status shows is the count the transaction walks.
 */
export const RESTORE_SECTION_STEPS = [
  "medications",
  "mood",
  "cycles",
  "profile",
  "labs",
  "illness",
  "allergies",
  "familyHistory",
  "documents",
  "reminders",
  "visits",
  "vaccinations",
  "coach",
  "sensitive",
  "awards",
  "ecg",
  "environment",
] as const;

/**
 * Why a restore did not happen, as a stable code. Every one of them is decided
 * before the first delete or rolls the whole transaction back, so each means
 * the account is unchanged.
 */
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

/**
 * Time kept free after the transaction for the rollup folds and the audit row,
 * when the restore checks it fits the caller's deadline.
 */
export const RESTORE_AFTER_TRANSACTION_ALLOWANCE_MS = 10 * 60 * 1000;

function refused(
  status: number,
  code: RestoreFailureCode,
  message: string,
  meta?: Record<string, unknown>,
): RestoreBackupOutcome {
  return { ok: false, status, code, message, ...(meta ? { meta } : {}) };
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
    input.progress?.(phase, { ...progress });
  };
  const reportSection = (step: (typeof RESTORE_SECTION_STEPS)[number]) => {
    progress.sectionsDone = RESTORE_SECTION_STEPS.indexOf(step);
    report("sections", true);
  };
  report("validating", true);

  // Opened, not unpacked: the JSON of a large record is longer than any
  // string V8 can hold (#1031), so it is read as a stream below. Opening
  // authenticates every stored piece first, and checks they add up to the
  // copy that was written, before anything is read or deleted.
  let source: BackupSource;
  try {
    source = await openStoredBackup(prisma, backup);
  } catch (err) {
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
        ownerId: backup.userId,
        reason: err instanceof Error ? err.message : "decrypt_failed",
      },
    });
    // Bad stored input, not a broken server: a copy written under a key the
    // operator has since dropped, or one whose bytes have changed. Refused
    // above the transaction, so nothing was touched.
    const refusal = storedBackupRefusal(err);
    return refused(refusal.status, refusal.code, refusal.message, {
      errorCode: refusal.code,
    });
  }

  // Parsed once and kept, because the schema's per-section `.default([])`
  // erases the difference between a section that is absent and one that is
  // empty — and that difference is what the completeness check below reads.
  //
  // The measurements are the exception: `readStreamedBackup` checks each one
  // against the element schema as it goes and keeps only their count, and
  // the transaction reads them a second time, in batches, as it writes them.
  // v1.42 — the live `stats:` ids of the folded types, gathered on the first
  // read, so the measurement pass can tell a compaction tombstone from a
  // person's deletion without a third read of the file.
  const liveFoldStatsIds = new Set<string>();
  const foldedTypes = new Set<string>(FOLDED_TYPES);
  const noteLiveFoldRow = (row: BackupMeasurement) => {
    if (
      row.deletedAt == null &&
      row.source === "APPLE_HEALTH" &&
      foldedTypes.has(row.type) &&
      row.externalId?.startsWith("stats:")
    ) {
      liveFoldStatsIds.add(`${row.type}|${row.externalId}`);
    }
  };
  let raw: unknown;
  let payload;
  let streamed: StreamedBackup;
  try {
    streamed = await readStreamedBackup(source, {
      onMeasurementChecked: (checked, row) => {
        progress.measurementsChecked = checked;
        report("validating");
        noteLiveFoldRow(row);
      },
    });
    progress.measurementsTotal = streamed.measurementCount;
    report("validating", true);
    raw = streamed.raw;
    // Loaded here, not at import: the schema is ~12 MB of heap and a server
    // that never validates a backup should not hold it (`backup-summary.ts`).
    const { parseBackupPayload } = await import("@/lib/validations/backup");
    payload = parseBackupPayload(raw);
  } catch (err) {
    const readFailure = isStoredBackupReadError(err);
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
        ownerId: backup.userId,
        reason: readFailure ? "read_failed" : "schema_invalid",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    if (readFailure) {
      // The copy changed after it was opened: replaced by the weekly run, or
      // altered. Nothing has been deleted yet.
      const refusal = storedBackupRefusal(err);
      return refused(refusal.status, refusal.code, refusal.message, {
        errorCode: refusal.code,
      });
    }
    return refused(
      422,
      "schema_invalid",
      "Backup payload failed schema validation",
    );
  }

  if (!isCompatibleSchemaVersion(payload.schemaVersion)) {
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
        ownerId: backup.userId,
        reason: "incompatible_schema_version",
        schemaVersion: payload.schemaVersion,
      },
    });
    return refused(
      422,
      "incompatible_schema_version",
      `Backup schema version '${payload.schemaVersion}' is not supported by this server`,
    );
  }

  // The payload declares its own owner, and the backup ROW records who the
  // backup was taken for. Those must agree. Taking the owner from the
  // payload alone means the restored-into account is whatever the blob
  // claims — so an admin who selects one user's backup could write into a
  // different account without the interface ever showing it. Both values are
  // already in hand here; refuse on mismatch rather than trusting the blob.
  if (payload.userId !== backup.userId) {
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
        ownerId: backup.userId,
        reason: "owner_mismatch",
        declaredOwnerId: payload.userId,
      },
    });
    return refused(
      409,
      "owner_mismatch",
      "Backup payload declares a different owner than the backup record",
    );
  }

  // The target of the restore is whoever the backup is for, NOT the
  // admin running the operation. Make sure that user still exists —
  // an upload referencing a since-deleted user would otherwise leave
  // the operation half-done.
  const ownerId = payload.userId;
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { id: true, username: true },
  });
  if (!owner) {
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
        ownerId,
        reason: "owner_not_found",
      },
    });
    return refused(
      422,
      "owner_not_found",
      `Backup owner '${ownerId}' no longer exists in this DB`,
    );
  }

  // The ciphertext inside the file is written back verbatim, so every key it
  // was written under has to be on this host, and has to be the key that
  // wrote it. A copy taken before a key rotation still needs the key the
  // rotation retired: the rotation re-seals the stored copy's envelope but
  // cannot reach inside it. Refused here, above the first delete, because the
  // alternative is an account whose notes, documents and coach history come
  // back as rows no reader can open. The instance settings count only when
  // the operator asked for them back.
  const keyVerdict = assessBackupKeys(streamed.keys, {
    ignoreSections: restoreInstanceSettings
      ? new Set<string>()
      : new Set(["appSettings"]),
  });
  const keyProblem = describeBackupKeyProblem(keyVerdict);
  if (keyProblem) {
    const keyIds = [...keyVerdict.missing, ...keyVerdict.unreadable];
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
        ownerId,
        reason: "key_missing",
        missingKeyIds: keyVerdict.missing,
        unreadableKeyIds: keyVerdict.unreadable,
        affectedValues: keyVerdict.affectedValues,
      },
    });
    return refused(422, BACKUP_KEY_MISSING_CODE, keyProblem, {
      errorCode: BACKUP_KEY_MISSING_CODE,
      keyIds,
    });
  }

  // Audit the *intent* before the transaction begins so the trail
  // describing "an admin is about to restore <user>" survives even
  // if the operation crashes midway.
  await auditLog("admin.backups.restore.start", {
    userId: input.actorUserId,
    ipAddress: input.ipAddress,
    details: {
      backupId: backup.id,
      ownerId,
      ownerUsername: owner.username,
      snapshotExportedAt: payload.exportedAt,
      restoreInstanceSettings,
    },
  });

  // A section the file's own manifest says it carries, and does not.
  //
  // The restore's first act is to delete the class it is about to rebuild, so
  // an absent section is not a gap in the file — it is an erasure of that part
  // of the account, reported as a success. #237: a portable file whose
  // document payload was gone emptied the vault and said nothing. The whole
  // file is refused instead, above the transaction, for the same reason the
  // metadata-only check below sits there.
  //
  // A DECLARED omission is not this. The portable export leaves the screener
  // administrations and the consent receipts out on purpose and says so in the
  // manifest; `findMissingBackupSections` reads the manifest and not the
  // emptiness of an array, so those files stay restorable. So does every file
  // written before the manifest existed, which declares nothing at all.
  const missingSections = findMissingBackupSections(raw);
  if (missingSections.length > 0) {
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
        ownerId,
        reason: "section_missing",
        sections: missingSections,
      },
    });
    return refused(
      422,
      "backup.section.missing",
      `Backup is missing ${missingSections.join(", ")} — the file's own manifest says it carries ${missingSections.length === 1 ? "that section" : "those sections"}. Nothing was changed. Use a disaster-recovery snapshot, or export the account again.`,
      { errorCode: "backup.section.missing", sections: missingSections },
    );
  }

  // Portable exports intentionally omit document ciphertext. They remain
  // valid upload/download artifacts, but cannot be used to manufacture an
  // InboundDocument row. A DR restore must fail before any delete rather
  // than inventing empty/plaintext content.
  const incompleteDocument = payload.documents.find(
    (document) =>
      document.contentEncrypted === undefined ||
      document.contentSha256 === undefined ||
      document.contentCodec === undefined ||
      document.providerType === undefined ||
      document.reportDate === undefined ||
      document.documentDate === undefined ||
      document.errorReason === undefined ||
      document.summaryEncrypted === undefined ||
      document.summaryGeneratedAt === undefined ||
      document.summaryState === undefined ||
      document.createdAt === undefined ||
      document.updatedAt === undefined,
  );
  if (incompleteDocument) {
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
        ownerId,
        reason: "document_ciphertext_missing",
        documentId: incompleteDocument.id,
      },
    });
    return refused(
      422,
      "document_ciphertext_missing",
      `Document '${incompleteDocument.id}' is metadata-only and cannot be restored`,
    );
  }

  // The transaction's own limit grows with the measurements. When a caller
  // has a deadline of its own (the background job's time budget) and that
  // limit would run past it, the restore is refused here, above the first
  // delete, rather than started and cut off by the queue.
  // Counted here, before the transaction, because the delete costs time in
  // proportion to what the account holds, deleted rows included.
  const currentMeasurements = await prisma.measurement.count({
    where: { userId: ownerId },
  });
  const transactionTimeoutMs = restoreTransactionTimeoutMs(
    streamed.measurementCount,
    currentMeasurements,
  );
  if (
    input.deadline !== undefined &&
    Date.now() + transactionTimeoutMs + RESTORE_AFTER_TRANSACTION_ALLOWANCE_MS >
      input.deadline
  ) {
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
        ownerId,
        reason: "time_budget",
        measurements: streamed.measurementCount,
        currentMeasurements,
      },
    });
    // Both counts, because both cost time: the account's readings are deleted
    // (removed ones included, until the nightly clean-up purges them) before
    // the file's are written.
    return refused(
      503,
      "time_budget",
      `Restoring ${readingsPhrase(streamed.measurementCount)} in the backup over the ${readingsPhrase(currentMeasurements)} this account holds now (removed readings count until the nightly clean-up) needs more time than the restore job allows. Nothing was changed.`,
    );
  }

  let outcome: {
    expiredTombstonesSkipped: number;
    cleared: RestoreResponse["cleared"];
    skipped: RestoreSkipSummary;
    accountSettings: AccountSettingsRestoreResult;
  };
  try {
    report("clearing");
    outcome = await prisma.$transaction(
      async (tx) => {
        // Every connection carries the request limits from `src/lib/db.ts`
        // (60 s per statement, 60 s idle inside a transaction). A restore is
        // not a request: deleting two million readings is one statement, and
        // on a slow disk it ran past 60 s, was cancelled, and the whole
        // restore rolled back in its clearing step (#1031). The transaction
        // has its own limit; SET LOCAL gives each statement the same one, and
        // ends with the transaction.
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(transactionTimeoutMs)}, true), set_config('idle_in_transaction_session_timeout', ${String(transactionTimeoutMs)}, true)`;
        // One restore of an account at a time, whatever let a second one
        // start: the job table admits one queued or running job per account,
        // and this lock holds even if a worker that was thought gone is
        // still writing. A second transaction waits here for the first to
        // commit or roll back, then replaces the account again from its own
        // file, which is what it was asked to do.
        //
        // The same lock orders the restore against the background passes that
        // rewrite readings a day at a time (`restore-lock.ts`): they hold it
        // shared for each day, so the delete below never meets a day half
        // folded, which is where the two used to deadlock.
        await takeRestoreLock(tx, ownerId);
        // Every reference this restore writes stays inside the account: the
        // references that leave it are counted now and again after the last
        // write, and any that grew rolls the whole transaction back
        // (`tenant-boundary.ts` says why the check is derived from the schema
        // rather than written per section).
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

        // Delete every serialized owner-scoped partition before rebuilding it
        // in the same transaction. Child rows either go first for counts or
        // cascade from their serialized parent.
        const intake = await tx.medicationIntakeEvent.deleteMany({
          where: { userId: ownerId },
        });
        const meds = await tx.medication.deleteMany({
          where: { userId: ownerId },
        });
        const measurements = await tx.measurement.deleteMany({
          where: { userId: ownerId },
        });
        const moods = await tx.moodEntry.deleteMany({
          where: { userId: ownerId },
        });
        // v1.4.39 W-MOOD — wipe the persisted mood rollup partition
        // for this owner so the next analytics read doesn't surface
        // pre-restore daily means. The fold below mints fresh rows
        // from the restored mood entries.
        await tx.moodEntryRollup.deleteMany({ where: { userId: ownerId } });
        // v1.4.39.1 — wipe the persisted measurement rollup partition
        // for the same reason. Pre-fix the partition kept the previous
        // owner's daily means even after the underlying measurements
        // were replaced — the chart's `source=rollup` fast-path could
        // surface a stale 30-day mean built from rows that no longer
        // existed. The fold below mints fresh rows from the restored
        // measurement set.
        await tx.measurementRollup.deleteMany({ where: { userId: ownerId } });
        const channels = await tx.notificationChannel.deleteMany({
          where: { userId: ownerId },
        });
        const subs = await tx.pushSubscription.deleteMany({
          where: { userId: ownerId },
        });
        const tgDel = await tx.telegramScheduledDeletion.deleteMany({
          where: { userId: ownerId },
        });
        const documents = await tx.inboundDocument.deleteMany({
          where: { userId: ownerId },
        });
        const workouts = await tx.workout.deleteMany({
          where: { userId: ownerId },
        });
        const familyHistory = await tx.familyHistoryEntry.deleteMany({
          where: { userId: ownerId },
        });
        const allergies = await tx.allergy.deleteMany({
          where: { userId: ownerId },
        });
        const illnessEpisodes = await tx.illnessEpisode.deleteMany({
          where: { userId: ownerId },
        });
        const labResults = await tx.labResult.deleteMany({
          where: { userId: ownerId },
        });
        const biomarkers = await tx.biomarker.deleteMany({
          where: { userId: ownerId },
        });
        // The export has written nutrient day totals since v1.29 and nothing
        // here ever read them back: water and vitamin history was carried in
        // the file, discarded on restore, and the restore reported success.
        const nutrientDays = await tx.nutrientIntakeDay.deleteMany({
          where: { userId: ownerId },
        });

        // The one section of the file that is not this account's.
        //
        // A disaster-recovery payload carries the singleton `app_settings`
        // row — registration, the MFA requirement, the default locale and
        // timezone, module availability, the notification and AI
        // configuration, the document size cap and quota. Writing it back as
        // a side effect of restoring ONE account reconfigures the host for
        // everybody on it, silently and hours or weeks out of date: an
        // operator putting a single record back on Wednesday has no reason to
        // expect Monday's registration switch and Monday's upload cap to come
        // with it. Rebuilding a host from a snapshot is a real case, so the
        // write stays available — as an answer the operator gives, not one
        // the account restore assumes.
        if (payload.appSettings && restoreInstanceSettings) {
          const settings = payload.appSettings;
          // A file from before 0343 carries the Coach's operator answer in
          // module availability; carry it into the Coach switch.
          const coachFold = foldLegacyCoachAvailability(
            settings.moduleAvailabilityJson,
            settings.assistantCoachEnabled,
          );
          const settingsData = {
            registrationEnabled: settings.registrationEnabled,
            mfaRequired: settings.mfaRequired,
            defaultLocale: settings.defaultLocale,
            telegramGlobal: settings.telegramGlobal,
            ntfyGlobal: settings.ntfyGlobal,
            webPushGlobal: settings.webPushGlobal,
            webPushVapidPublicKey: settings.webPushVapidPublicKey,
            webPushVapidPrivateKeyEncrypted:
              settings.webPushVapidPrivateKeyEncrypted,
            webPushVapidSubject: settings.webPushVapidSubject,
            apiGlobal: settings.apiGlobal,
            umamiEnabled: settings.umamiEnabled,
            umamiScriptUrl: settings.umamiScriptUrl,
            umamiWebsiteId: settings.umamiWebsiteId,
            glitchtipEnabled: settings.glitchtipEnabled,
            glitchtipDsn: settings.glitchtipDsn,
            glitchtipEnvironment: settings.glitchtipEnvironment,
            reminderLateMinutes: settings.reminderLateMinutes,
            reminderMissedMinutes: settings.reminderMissedMinutes,
            adminAiKeyEncrypted: settings.adminAiKeyEncrypted,
            adminAiModel: settings.adminAiModel,
            adminAiBaseUrl: settings.adminAiBaseUrl,
            adminCodexAccessTokenEncrypted:
              settings.adminCodexAccessTokenEncrypted,
            adminCodexRefreshTokenEncrypted:
              settings.adminCodexRefreshTokenEncrypted,
            adminCodexAccountIdEncrypted: settings.adminCodexAccountIdEncrypted,
            adminCodexTokenExpiresAt: settings.adminCodexTokenExpiresAt
              ? new Date(settings.adminCodexTokenExpiresAt)
              : null,
            adminCodexConnectedAt: settings.adminCodexConnectedAt
              ? new Date(settings.adminCodexConnectedAt)
              : null,
            adminCodexConnectionStatus: settings.adminCodexConnectionStatus,
            adminAiInsightsFeedbackSummary:
              settings.adminAiInsightsFeedbackSummary as never,
            defaultUserTimezone: settings.defaultUserTimezone,
            assistantEnabled: settings.assistantEnabled,
            assistantCoachEnabled: coachFold.assistantCoachEnabled,
            assistantBriefingEnabled: settings.assistantBriefingEnabled,
            assistantInsightStatusEnabled:
              settings.assistantInsightStatusEnabled,
            assistantDocumentAiEnabled:
              settings.assistantDocumentAiEnabled ?? true,
            // v1.41 — absent on a file written before the controls existed,
            // which restores them at their defaults: allowed, no cap.
            aiReasoningEnabled: settings.aiReasoningEnabled ?? true,
            aiReasoningMaxEffort:
              settings.aiReasoningMaxEffort ?? DEFAULT_REASONING_MAX_EFFORT,
            moduleAvailabilityJson: coachFold.moduleAvailabilityJson as never,
            documentMaxFileBytes: settings.documentMaxFileBytes,
            documentQuotaBytes: BigInt(settings.documentQuotaBytes),
          };
          await tx.appSettings.upsert({
            where: { id: settings.id },
            create: { id: settings.id, ...settingsData },
            update: settingsData,
          });
        }

        const toRestoredMeasurementData = (measurement: BackupMeasurement) => ({
          type: measurement.type,
          value: measurement.value,
          valueMin: measurement.valueMin ?? null,
          valueMax: measurement.valueMax ?? null,
          unit: measurement.unit,
          source: measurement.source ?? "MANUAL",
          measuredAt: new Date(measurement.measuredAt),
          notes: null,
          notesEncrypted:
            measurement.notesEncrypted == null
              ? encryptNote(measurement.notes ?? null)
              : decodeEncryptedBytes(measurement.notesEncrypted),
          externalId: measurement.externalId ?? null,
          externalSourceVersion: measurement.externalSourceVersion ?? null,
          // Authority of an Apple Health `stats:` aggregate. A backup
          // written before this field rode the payload carries nothing, and
          // restoring NULL would flatten the authority ladder: an export.xml
          // source-day estimate could then overwrite a native HealthKit
          // statistic, which is the ambiguity migration 0263 already
          // repaired once. Such a row is exactly the case LEGACY_UNKNOWN
          // exists for, so it comes back repairable instead of ambiguous.
          //
          // The gate is scoped exactly as 0263 scoped its backfill and as
          // the cumulative drain scopes its own LEGACY_UNKNOWN writes:
          // Apple Health rows only. Other providers mint `stats:` ids for
          // their cumulative dailies too (Fitbit, Google Health) and have
          // never carried provenance — marking those would invent a state
          // they were never in. Ordinary point rows keep NULL honestly.
          //
          // Only an ABSENT field is the old-backup case. A current backup
          // writes the field for every row, and an explicit null is the row's
          // real state: the nightly daily-mean fold writes Apple Health
          // `stats:` rows with no provenance. Treating that null as absent
          // turned every such row into LEGACY_UNKNOWN on restore (#1031).
          aggregationProvenance: (measurement.aggregationProvenance !==
          undefined
            ? measurement.aggregationProvenance
            : measurement.source === "APPLE_HEALTH" &&
                measurement.externalId?.startsWith("stats:")
              ? "LEGACY_UNKNOWN"
              : null) as never,
          glucoseContext: (measurement.glucoseContext ?? null) as never,
          sleepStage: (measurement.sleepStage ?? null) as never,
          rhythmClassification: (measurement.rhythmClassification ??
            null) as never,
          deviceType: measurement.deviceType ?? null,
          syncVersion: measurement.syncVersion ?? 1,
          deletedAt: measurement.deletedAt
            ? new Date(measurement.deletedAt)
            : null,
          ...(measurement.createdAt
            ? { createdAt: new Date(measurement.createdAt) }
            : {}),
          ...(measurement.updatedAt
            ? { updatedAt: new Date(measurement.updatedAt) }
            : {}),
        });

        // The measurements, a batch at a time from a second read of the
        // file, so the restore never holds more than one batch of them.
        //
        // Two later sections point INTO the measurements (a record's
        // `sourceMeasurementId`, an ECG strip's `measurementId`) and have
        // to know which of those ids this transaction actually wrote. They
        // used to be handed every written id; they only ever ask about the
        // ones they reference, so only those are collected.
        const referencedMeasurementIds = new Set<string>();
        for (const record of payload.personalRecords) {
          if (record.sourceMeasurementId) {
            referencedMeasurementIds.add(record.sourceMeasurementId);
          }
        }
        for (const recording of payload.ecgRecordings) {
          if (recording.measurementId) {
            referencedMeasurementIds.add(recording.measurementId);
          }
        }
        const writtenReferencedIds = new Set<string>();
        const measurementBatchSize = 1_000;
        // Deleted readings the file carries are restored as deleted rows
        // (tombstones), with one exception: a tombstone deleted longer ago
        // than `TOMBSTONE_RETENTION_DAYS` is not written at all.
        //
        // Such a row is exactly what the nightly tombstone purge
        // (`measurement-tombstone-cleanup.ts`) hard-deletes, so writing it
        // costs the restore a row in thirteen indexes for a row that is gone
        // by the next morning. Nothing reads it in between: the delta feed
        // answers `cursorExpired` for every cursor older than the same
        // horizon, so no client that would still be served this tombstone
        // exists; the step-consolidation repair and the hourly rebuild only
        // look inside the horizon; and the undo of a delete is offered for
        // what the purge has not removed yet, which this row would not
        // survive either.
        //
        // Younger tombstones are written. They still have readers: a paired
        // client that has not yet drained that deletion from the delta feed,
        // the undo of a recent delete, the consolidation repairs that rebuild
        // from folded samples, and the unique `(user, type, source,
        // externalId)` key that stops a device from uploading a folded
        // sample again. The backup file itself is unchanged and keeps every
        // row.
        const tombstoneHorizonMs =
          Date.now() - TOMBSTONE_RETENTION_DAYS * 86_400_000;
        //
        // v1.42 — nor is a compaction tombstone, whatever its age: a raw
        // Apple Health sample the folds soft-deleted before v1.42, whose hour
        // or day a live `stats:` row in the same file covers. The folds
        // delete those outright now and the backlog purge removes the old
        // ones, so writing one back would only hand the purge the same row
        // again; the `folded_window` ingest guard is what keeps the sample
        // from being uploaded again. Classified by the rule the purge and
        // the sync feed use (`folded-window.ts`), against the `stats:` ids
        // gathered on the file's first read and the zone the account will
        // have after the restore. Counted with the expired ones.
        const foldTz = resolveUserTimezone(
          payload.accountSettings?.timezone ??
            (
              await tx.user.findUnique({
                where: { id: ownerId },
                select: { timezone: true },
              })
            )?.timezone ??
            null,
        );
        const isCompactionTombstone = (measurement: BackupMeasurement) => {
          if (measurement.deletedAt == null) return false;
          const row = {
            type: measurement.type,
            source: measurement.source ?? "MANUAL",
            externalId: measurement.externalId ?? null,
            measuredAt: new Date(measurement.measuredAt),
          };
          if (!isFoldedWindowCandidate(row, new Date(measurement.deletedAt))) {
            return false;
          }
          const covering = coveringStatsExternalId(row, foldTz);
          return (
            covering !== null &&
            liveFoldStatsIds.has(`${measurement.type}|${covering}`)
          );
        };
        const isExpiredTombstone = (measurement: BackupMeasurement) =>
          measurement.deletedAt != null &&
          (new Date(measurement.deletedAt).getTime() < tombstoneHorizonMs ||
            isCompactionTombstone(measurement));
        let expiredTombstonesSkipped = 0;
        report("measurements");
        await streamed.forEachMeasurementBatch(
          measurementBatchSize,
          async (fileBatch) => {
            const batch = fileBatch.filter(
              (measurement) => !isExpiredTombstone(measurement),
            );
            expiredTombstonesSkipped += fileBatch.length - batch.length;
            const stableRows = batch.flatMap(
              (measurement): MeasurementInsertRow[] =>
                measurement.id
                  ? [
                      {
                        id: measurement.id,
                        userId: ownerId,
                        ...toRestoredMeasurementData(measurement),
                      },
                    ]
                  : [],
            );
            // One statement per batch, not `createMany`: see
            // `insertMeasurementRows` for what the latter cost here.
            await insertMeasurementRows(tx, stableRows);
            // Counted through the file, so the bar ends at the file's total.
            progress.measurementsWritten += fileBatch.length;
            report("measurements");
            for (const row of stableRows) {
              if (referencedMeasurementIds.has(row.id)) {
                writtenReferencedIds.add(row.id);
              }
            }

            // v1 payloads did not require stable ids. Preserve their
            // historical natural-key reconciliation without routing
            // canonical v2 rows through it.
            for (const measurement of batch) {
              if (measurement.id) continue;
              const restoredData = toRestoredMeasurementData(measurement);
              const existing = await tx.measurement.findFirst({
                where: {
                  userId: ownerId,
                  type: measurement.type,
                  source: restoredData.source,
                  measuredAt: restoredData.measuredAt,
                  sleepStage: restoredData.sleepStage,
                },
                select: { id: true },
              });
              if (existing) {
                await tx.measurement.update({
                  where: { id: existing.id, userId: ownerId },
                  data: restoredData,
                });
              } else {
                await tx.measurement.create({
                  data: { userId: ownerId, ...restoredData },
                });
              }
            }
          },
        );

        const medByName = new Map<string, string>();
        const restoredMedicationIds = new Set<string>();
        // The efficacy targets cannot ride inside the medication create
        // beside the schedules and the packs: `biomarkerId` is a foreign key
        // into a catalogue this transaction has not restored yet. They are
        // collected here against the id the drug ACTUALLY got and written in
        // a second pass once the biomarkers exist; the pass itself says why
        // hoisting the biomarker restore above the medications is the worse
        // of the two orderings.
        const pendingEfficacyTargets: Array<{
          medicationId: string;
          target: (typeof payload.medications)[number]["efficacyTargets"][number];
        }> = [];
        // Supersede pointers the file states and the restore cannot honour.
        // Reported as JSON paths into the file rather than as ids: the file
        // is where an operator has to go to see what the position meant, and
        // an id would be one the restore never wrote.
        const unresolvedRevisionLinks: string[] = [];
        // v1.40 (#1041) — the account's own medication categories, before
        // the medications that name them by key. Delete-then-recreate like
        // the medications themselves. A key held by another account on this
        // instance (a portable file from elsewhere) is re-minted, and the
        // medications below are mapped onto the new key.
        await tx.medicationCategoryLabel.deleteMany({
          where: { userId: ownerId },
        });
        const categoryKeyRemap = new Map<string, string>();
        for (const c of payload.customMedicationCategories) {
          const taken = await tx.medicationCategoryLabel.findUnique({
            where: { key: c.key },
            select: { id: true },
          });
          const key = taken ? mintCustomMedicationCategoryKey() : c.key;
          if (key !== c.key) categoryKeyRemap.set(c.key, key);
          await tx.medicationCategoryLabel.create({
            data: {
              userId: ownerId,
              key,
              labelEncrypted: encryptCategoryLabel(c.label),
              sortOrder: c.sortOrder,
              isActive: c.isActive,
              ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
            },
          });
        }

        // v1.40 (#1024) — the zone a derived course's creation day is read
        // in: the file's own account settings, else the account's stored one.
        const restoreTz = validTimezoneOr(
          payload.accountSettings?.timezone ??
            (
              await tx.user.findUnique({
                where: { id: ownerId },
                select: { timezone: true },
              })
            )?.timezone,
          DEFAULT_TIMEZONE,
        );
        let medicationIndex = 0;
        reportSection("medications");
        const restoreStartedAt = new Date();
        for (const m of payload.medications) {
          const created = await tx.medication.create({
            data: {
              ...(m.id ? { id: m.id } : {}),
              userId: ownerId,
              name: m.name,
              dose: m.dose,
              treatmentClass: m.treatmentClass ?? "GENERIC",
              dosesPerUnit: m.dosesPerUnit ?? null,
              unitsPerDose: m.unitsPerDose ?? "1",
              active: m.active ?? true,
              notificationsEnabled: m.notificationsEnabled ?? true,
              pausedAt: m.pausedAt ? new Date(m.pausedAt) : null,
              snoozedUntil: m.snoozedUntil ? new Date(m.snoozedUntil) : null,
              startsOn: m.startsOn ? new Date(m.startsOn) : null,
              endsOn: m.endsOn ? new Date(m.endsOn) : null,
              oneShot: m.oneShot ?? false,
              asNeeded: m.asNeeded ?? false,
              trackIntake: m.trackIntake ?? true,
              deliveryForm: m.deliveryForm ?? "ORAL",
              trackInjectionSites: m.trackInjectionSites ?? false,
              allowedInjectionSites: m.allowedInjectionSites ?? [],
              liveActivityEnabled: m.liveActivityEnabled ?? false,
              criticalAlarmEnabled: m.criticalAlarmEnabled ?? false,
              atcCode: m.atcCode ?? null,
              rxNormCode: m.rxNormCode ?? null,
              lowStockNotifiedAt: m.lowStockNotifiedAt
                ? new Date(m.lowStockNotifiedAt)
                : null,
              lowStockNotifiedThresholdDays:
                m.lowStockNotifiedThresholdDays ?? null,
              reorderLeadDays: m.reorderLeadDays ?? null,
              externalSource: m.externalSource ?? null,
              externalId: m.externalId ?? null,
              // A file from before v1.39.1 carries no creation date, and the
              // restore time would hide every dose-history miss before it.
              // The earliest thing the file records for the drug stands in.
              ...(() => {
                const createdAt = restoredMedicationCreatedAt(
                  m,
                  payload.intakeEvents,
                  restoreStartedAt,
                );
                return createdAt ? { createdAt } : {};
              })(),
              ...(m.updatedAt ? { updatedAt: new Date(m.updatedAt) } : {}),
              schedules: {
                create: m.schedules.map((s) => ({
                  ...(s.id ? { id: s.id } : {}),
                  windowStart: s.windowStart,
                  windowEnd: s.windowEnd,
                  label: s.label ?? null,
                  dose: s.dose ?? null,
                  // #219 — per-schedule units per dose. Prisma coerces the
                  // Decimal string; NULL / absent stays NULL (inherit).
                  unitsPerDose: s.unitsPerDose ?? null,
                  daysOfWeek: s.daysOfWeek ?? null,
                  timesOfDay: s.timesOfDay ?? [],
                  reminderGraceMinutes: s.reminderGraceMinutes ?? null,
                  rrule: s.rrule ?? null,
                  rollingIntervalDays: s.rollingIntervalDays ?? null,
                  scheduleType: s.scheduleType ?? "SCHEDULED",
                  cyclicOnWeeks: s.cyclicOnWeeks ?? null,
                  cyclicOffWeeks: s.cyclicOffWeeks ?? null,
                  doseWindows: (s.doseWindows ?? null) as never,
                })),
              },
              // Written in the same `create` as the drug, so the FK binds to
              // the id this row actually got. A canonical DR file preserves
              // the medication's id and a portable one mints a fresh cuid;
              // neither case needs the old `medicationId` from the file,
              // which is why the payload does not carry it. The note follows
              // the measurement contract next to it: ciphertext verbatim when
              // the file has it, legacy plaintext encrypted on the way in,
              // and the plaintext column left null either way.
              sideEffects: {
                create: m.sideEffects.map((s) => ({
                  ...(s.id ? { id: s.id } : {}),
                  userId: ownerId,
                  occurredAt: new Date(s.occurredAt),
                  category: s.category,
                  entry: s.entry,
                  severity: s.severity,
                  notes: null,
                  notesEncrypted:
                    s.notesEncrypted == null
                      ? encryptNote(s.notes ?? null)
                      : decodeEncryptedBytes(s.notesEncrypted),
                  ...(s.createdAt ? { createdAt: new Date(s.createdAt) } : {}),
                })),
              },
              // Nested for the same reason as the two above — the FK binds
              // to the id this drug actually got, so a portable file that
              // mints fresh ids needs no remap.
              //
              // `resumedAt` passes through as null when the era is open. It
              // is not defaulted to the restore time: a pause that was still
              // running when the backup was taken is still running after the
              // restore, and closing it here would silently convert an
              // ongoing decision into a historical one.
              pauseEras: {
                create: m.pauseEras.map((p) => ({
                  ...(p.id ? { id: p.id } : {}),
                  userId: ownerId,
                  pausedAt: new Date(p.pausedAt),
                  resumedAt: p.resumedAt ? new Date(p.resumedAt) : null,
                  ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}),
                })),
              },
              // The titration steps, nested for the same reason. The note
              // takes the measurement contract next to it: ciphertext when
              // the file has it, legacy plaintext encrypted on the way in,
              // and the plaintext column left null either way.
              doseChanges: {
                create: m.doseChanges.map((d) => ({
                  ...(d.id ? { id: d.id } : {}),
                  effectiveFrom: new Date(d.effectiveFrom),
                  doseValue: d.doseValue,
                  doseUnit: d.doseUnit,
                  note: null,
                  noteEncrypted:
                    d.noteEncrypted == null
                      ? encryptNote(d.note ?? null)
                      : decodeEncryptedBytes(d.noteEncrypted),
                  ...(d.createdAt ? { createdAt: new Date(d.createdAt) } : {}),
                })),
              },
              // The packs, and the ledger behind their counts. Nested for
              // the same reason as everything above it, and `unitsRemaining`
              // is written VERBATIM rather than recomputed from the events —
              // it is what the server had resolved and what the person was
              // shown, and recomputing here would silently correct a count
              // they may have adjusted by hand.
              inventoryItems: {
                create: m.inventoryItems.map((i) => ({
                  ...(i.id ? { id: i.id } : {}),
                  userId: ownerId,
                  state: (i.state ?? "ACTIVE") as never,
                  containerType: (i.containerType ?? "OTHER") as never,
                  unitsTotal: i.unitsTotal,
                  unitsRemaining: i.unitsRemaining,
                  firstUseAt: i.firstUseAt ? new Date(i.firstUseAt) : null,
                  expiresAt: i.expiresAt ? new Date(i.expiresAt) : null,
                  printedExpiry: i.printedExpiry
                    ? new Date(i.printedExpiry)
                    : null,
                  purchasedAt: i.purchasedAt ? new Date(i.purchasedAt) : null,
                  manufacturer: i.manufacturer ?? null,
                  doseStrength: i.doseStrength ?? null,
                  notes: null,
                  notesEncrypted:
                    i.notesEncrypted == null
                      ? encryptNote(i.notes ?? null)
                      : decodeEncryptedBytes(i.notesEncrypted),
                  ...(i.createdAt ? { createdAt: new Date(i.createdAt) } : {}),
                  ...(i.updatedAt ? { updatedAt: new Date(i.updatedAt) } : {}),
                })),
              },
              // One row or none, so `create` on the optional side rather
              // than a list. A file that says nothing leaves the drug
              // untuned, which is what it was.
              ...(m.phaseConfig
                ? {
                    phaseConfig: {
                      create: {
                        ...(m.phaseConfig.id ? { id: m.phaseConfig.id } : {}),
                        ...(m.phaseConfig.greenValue !== undefined
                          ? { greenValue: m.phaseConfig.greenValue }
                          : {}),
                        ...(m.phaseConfig.greenMode
                          ? { greenMode: m.phaseConfig.greenMode }
                          : {}),
                        ...(m.phaseConfig.yellowValue !== undefined
                          ? { yellowValue: m.phaseConfig.yellowValue }
                          : {}),
                        ...(m.phaseConfig.yellowMode
                          ? { yellowMode: m.phaseConfig.yellowMode }
                          : {}),
                        ...(m.phaseConfig.orangeValue !== undefined
                          ? { orangeValue: m.phaseConfig.orangeValue }
                          : {}),
                        ...(m.phaseConfig.orangeMode
                          ? { orangeMode: m.phaseConfig.orangeMode }
                          : {}),
                        ...(m.phaseConfig.redValue !== undefined
                          ? { redValue: m.phaseConfig.redValue }
                          : {}),
                        ...(m.phaseConfig.redMode
                          ? { redMode: m.phaseConfig.redMode }
                          : {}),
                      },
                    },
                  }
                : {}),
              inventoryEvents: {
                create: m.inventoryEvents.map((e) => ({
                  ...(e.id ? { id: e.id } : {}),
                  delta: e.delta,
                  reason: e.reason,
                  occurredAt: new Date(e.occurredAt),
                })),
              },
            },
          });
          restoredMedicationIds.add(created.id);
          if (!medByName.has(m.name)) medByName.set(m.name, created.id);
          // v1.39.4 — the clinical category lives in its own table keyed on the
          // medication id, so it is written after the row exists and inside the
          // same transaction. OTHER is what a missing row already reads as.
          if (m.category && m.category !== "OTHER") {
            await setMedicationCategory(
              created.id,
              categoryKeyRemap.get(m.category) ?? m.category,
              tx,
            );
          }

          // v1.40 (#1024) — the courses, then the window they project. A file
          // written before courses existed carries none; the medication's own
          // window then describes its one course, derived exactly as the
          // migration's backfill did (an end-only window runs from creation,
          // or from its end day when that lies earlier).
          const courseRows: Array<{
            startsOn: Date;
            endsOn: Date | null;
            note: string | null;
            createdAt?: Date;
          }> =
            m.courses !== undefined
              ? m.courses.map((c) => ({
                  startsOn: dateOfDayKey(c.startsOn),
                  endsOn: c.endsOn ? dateOfDayKey(c.endsOn) : null,
                  note: c.note ?? null,
                  ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
                }))
              : (() => {
                  const derived = courseFromWindow(
                    created.startsOn,
                    created.endsOn,
                    userDayKey(created.createdAt, restoreTz),
                  );
                  return derived ? [{ ...derived, note: null }] : [];
                })();
          if (courseRows.length > 0) {
            await tx.medicationCourse.createMany({
              data: courseRows.map((c) => ({
                medicationId: created.id,
                userId: ownerId,
                startsOn: c.startsOn,
                endsOn: c.endsOn,
                noteEncrypted: c.note ? encryptToBytes(c.note) : null,
                ...(c.createdAt ? { createdAt: c.createdAt } : {}),
              })),
            });
            const window = projectCourseWindow(courseRows);
            await tx.medication.update({
              where: { id: created.id },
              data: { startsOn: window.startsOn, endsOn: window.endsOn },
            });
          }

          // ── The archived schedule eras, in two passes ────────────────
          //
          // An era carries `supersededByRevisionId`, the pointer from a
          // corrected ARCHIVED row to the MANUAL one that replaced it. The
          // column has no `@relation`, so a value addressing nothing costs
          // no error — it just stops meaning anything, which is the more
          // dangerous shape here, because every era consumer SKIPS a row
          // that carries the pointer. Lose it and the superseded original
          // goes live again beside its own correction: two overlapping eras
          // for one window, and past days minted against a plan the account
          // had already corrected.
          //
          // A portable restore mints fresh ids, so the pointer cannot travel
          // as one. It travels as a POSITION in this drug's own ordered era
          // list, because that list is the only thing both ends agree on:
          // the builder sorts it totally (validFrom, then createdAt, then
          // id) so two eras sharing an instant cannot swap places between
          // two exports of the same account, and the pointer never crosses a
          // drug — every route that writes it scopes the update to one
          // medication — so the drug's own list is a complete address space.
          //
          // Pass one writes every era with the link NULL, because the row a
          // link addresses is as often written after the row addressing it
          // as before. Pass two patches the links once every position has an
          // id.
          const revisionIds: string[] = [];
          for (const revision of m.scheduleRevisions) {
            const row = await tx.medicationScheduleRevision.create({
              data: {
                ...(revision.id ? { id: revision.id } : {}),
                medicationId: created.id,
                validFrom: new Date(revision.validFrom),
                validUntil: new Date(revision.validUntil),
                payload: toJson(revision.payload),
                source: revision.source ?? "ARCHIVED",
                supersededByRevisionId: null,
                ...(revision.createdAt
                  ? { createdAt: new Date(revision.createdAt) }
                  : {}),
              },
              select: { id: true },
            });
            revisionIds.push(row.id);
          }
          for (const [index, revision] of m.scheduleRevisions.entries()) {
            const to = revision.supersededByIndex;
            if (to === null || to === undefined) continue;
            // A hand-edited file can name a position this drug does not
            // have, or the era's OWN position — and a row that supersedes
            // itself is skipped by every consumer, so the era would
            // disappear from the timeline while still sitting in the table.
            // Neither can be honoured and neither may be guessed at, so the
            // link stays NULL and the position is reported. The era still
            // restores: the window and the plan it held are the history, and
            // the correction pointer is the smaller loss.
            if (
              !Number.isInteger(to) ||
              to < 0 ||
              to >= revisionIds.length ||
              to === index
            ) {
              unresolvedRevisionLinks.push(
                `medications[${medicationIndex}].scheduleRevisions[${index}].supersededByIndex=${to}`,
              );
              continue;
            }
            await tx.medicationScheduleRevision.update({
              where: { id: revisionIds[index] },
              data: { supersededByRevisionId: revisionIds[to] },
            });
          }

          for (const target of m.efficacyTargets) {
            pendingEfficacyTargets.push({
              medicationId: created.id,
              target,
            });
          }
          medicationIndex += 1;
        }
        recordUnknownKeys(
          skips,
          "scheduleRevisionLink",
          [...new Set(unresolvedRevisionLinks)],
          unresolvedRevisionLinks,
        );

        if (payload.intakeEvents.length > 0) {
          // An event whose medication did not come back used to be mapped to
          // null and filtered away: the dose history came back short and the
          // restore reported success. That is the same silent-drop shape the
          // cycle symptom links had, and it gets the same answer — name the
          // unresolved reference and stop, so the operator learns from the
          // error rather than from a compliance rate that quietly moved.
          const unresolvedMedications = [
            ...new Set(
              payload.intakeEvents
                .filter(
                  (e) =>
                    !(
                      e.medicationId &&
                      restoredMedicationIds.has(e.medicationId)
                    ) && !medByName.has(e.medication),
                )
                .map((e) => e.medicationId ?? e.medication),
            ),
          ];
          if (unresolvedMedications.length > 0) {
            throw new Error(
              `Unknown medication references in intake events: ${unresolvedMedications.join(
                ", ",
              )}. The backup records doses against medications it does not carry.`,
            );
          }
          const rows = payload.intakeEvents
            .map((e) => {
              const medId =
                e.medicationId && restoredMedicationIds.has(e.medicationId)
                  ? e.medicationId
                  : medByName.get(e.medication);
              if (!medId) return null;
              return {
                ...(e.id ? { id: e.id } : {}),
                userId: ownerId,
                medicationId: medId,
                scheduledFor: new Date(e.scheduledFor),
                takenAt: e.takenAt ? new Date(e.takenAt) : null,
                skipped: e.skipped ?? false,
                autoMissed: e.autoMissed ?? false,
                attributionSource: e.attributionSource ?? "AUTO",
                source: e.source ?? "WEB",
                idempotencyKey: e.idempotencyKey ?? null,
                ...(e.createdAt ? { createdAt: new Date(e.createdAt) } : {}),
                injectionSite: e.injectionSite ?? null,
                doseTaken: e.doseTaken ?? null,
                inventoryConsumption: (e.inventoryConsumption ?? null) as never,
                externalId: e.externalId ?? null,
                ...(e.updatedAt ? { updatedAt: new Date(e.updatedAt) } : {}),
                syncVersion: e.syncVersion ?? 0,
                deletedAt: e.deletedAt ? new Date(e.deletedAt) : null,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
          if (rows.length > 0) {
            await tx.medicationIntakeEvent.createMany({ data: rows });
          }
        }

        reportSection("mood");
        // The account's own categories, tags and hidden set are written
        // whether or not the file carries a mood entry: an account that set
        // up its mood vocabulary before logging a single entry has them too,
        // and they used to be written only inside the entries branch.
        // The account's own CATEGORIES go in before its tags. A custom
        // tag's `categoryId` is a real foreign key, so writing the tag
        // first threw `mood_tags_category_id_fkey` and rolled the entire
        // restore back — an account that had grouped its own mood factors
        // could not be restored at all, and the failure named a constraint
        // rather than the thing that was missing.
        //
        // Upserted by key for the same reason the tags below are: `key` is
        // globally unique, so a seeded category that later claims the key
        // must be left alone rather than overwritten by a restore.
        // Labels this host's keys do not open, by file path.
        const unopenedMoodLabels: string[] = [];
        for (const category of payload.customMoodTagCategories) {
          await tx.moodTagCategory.upsert({
            where: { key: category.key },
            create: {
              id: category.id,
              userId: ownerId,
              key: category.key,
              labelKey: category.labelKey,
              icon: category.icon ?? null,
              sortOrder: category.sortOrder ?? 0,
              isActive: category.isActive ?? true,
              labelEncrypted: sealForRestore(
                category.labelEncrypted,
                category.label,
                `customMoodTagCategories.${category.key}.labelEncrypted`,
                unopenedMoodLabels,
              ),
            },
            update: {},
          });
        }

        // Re-create the account's own tag definitions first. The lookup
        // below used to ask only for the seeded catalogue (`userId: null`),
        // so a single custom rated tag made the whole restore throw
        // "Unknown mood factor keys" — the file was complete and unusable.
        for (const tag of payload.customMoodTags) {
          await tx.moodTag.upsert({
            where: { key: tag.key },
            create: {
              ...(tag.id ? { id: tag.id } : {}),
              userId: ownerId,
              key: tag.key,
              labelKey: tag.labelKey,
              categoryId: tag.categoryId,
              kind: tag.kind,
              isActive: tag.isActive,
              icon: tag.icon ?? null,
              sortOrder: tag.sortOrder,
              labelEncrypted: sealForRestore(
                tag.labelEncrypted,
                tag.label,
                `customMoodTags.${tag.key}.labelEncrypted`,
                unopenedMoodLabels,
              ),
              scaleMin: tag.scaleMin,
              scaleMax: tag.scaleMax,
              inverse: tag.inverse,
            },
            // `key` is globally unique, so a seeded key would collide.
            // Leave the catalogue row alone; the links resolve either way.
            update: {},
          });
        }
        recordUnknownKeys(
          skips,
          "moodLabelCiphertext",
          unopenedMoodLabels,
          unopenedMoodLabels,
        );

        // Which tags the account hid. Delete-then-recreate like every
        // other section, and resolved by KEY: what people hide is almost
        // always a seeded tag, whose id differs on every instance.
        //
        // A key this instance no longer knows costs one hidden row and is
        // REPORTED. Dropping it silently would un-hide a factor the person
        // had deliberately taken out of their mood editor, and they would
        // have no way to know why it came back.
        await tx.moodTagHidden.deleteMany({ where: { userId: ownerId } });
        if (payload.hiddenMoodTags.length > 0) {
          const hiddenKeys = payload.hiddenMoodTags.map((h) => h.key);
          const hiddenRows = await tx.moodTag.findMany({
            where: {
              key: { in: [...new Set(hiddenKeys)] },
              OR: [{ userId: null }, { userId: ownerId }],
            },
            select: { id: true, key: true },
          });
          const hiddenByKey = new Map(
            hiddenRows.map((row) => [row.key, row.id]),
          );
          const unresolvedHidden: string[] = [];
          const writableHidden = payload.hiddenMoodTags.filter((entry) => {
            if (hiddenByKey.has(entry.key)) return true;
            unresolvedHidden.push(entry.key);
            return false;
          });
          if (writableHidden.length > 0) {
            await tx.moodTagHidden.createMany({
              data: writableHidden.map((entry) => ({
                userId: ownerId,
                moodTagId: hiddenByKey.get(entry.key)!,
                ...(entry.createdAt
                  ? { createdAt: new Date(entry.createdAt) }
                  : {}),
              })),
              skipDuplicates: true,
            });
          }
          recordUnknownKeys(
            skips,
            "moodTag",
            [...new Set(unresolvedHidden)],
            unresolvedHidden,
          );
        }

        if (payload.moodEntries.length > 0) {
          const referencedFactorKeys = payload.moodEntries.flatMap((entry) =>
            entry.factors.map((factor) => factor.key),
          );
          const factorKeys = [...new Set(referencedFactorKeys)];
          const referencedTagKeys = payload.moodEntries.flatMap(
            (entry) => entry.structuredTags,
          );
          const tagKeys = [...new Set(referencedTagKeys)];
          const factorRows =
            factorKeys.length === 0
              ? []
              : await tx.moodTag.findMany({
                  where: {
                    key: { in: factorKeys },
                    kind: "RATED",
                    // The seeded catalogue OR this account's own tags.
                    OR: [{ userId: null }, { userId: ownerId }],
                  },
                  select: { id: true, key: true },
                });
          const factorByKey = new Map(
            factorRows.map((factor) => [factor.key, factor.id]),
          );
          // A rated tag this instance does not know costs the entry's link to
          // it, not the entry. The mood, the score, the date, the free tags —
          // everything the person logged — comes back; the one rating that
          // has nowhere to attach is dropped and named. Refusing the file
          // instead meant a renamed seeded tag made the whole account
          // unrecoverable.
          recordUnknownKeys(
            skips,
            "moodFactor",
            factorKeys.filter((key) => !factorByKey.has(key)),
            referencedFactorKeys,
          );

          // The BINARY half of the same taxonomy, looked up the same way and
          // reported the same way. It gets its own family because an
          // operator reading the report needs to know whether a rated
          // factor's score or a ticked tag went missing; they are different
          // losses on the same entry.
          const tagRows =
            tagKeys.length === 0
              ? []
              : await tx.moodTag.findMany({
                  where: {
                    key: { in: tagKeys },
                    kind: "BINARY",
                    OR: [{ userId: null }, { userId: ownerId }],
                  },
                  select: { id: true, key: true },
                });
          const tagByKey = new Map(tagRows.map((tag) => [tag.key, tag.id]));
          recordUnknownKeys(
            skips,
            "moodTag",
            tagKeys.filter((key) => !tagByKey.has(key)),
            referencedTagKeys,
          );

          for (const entry of payload.moodEntries) {
            const moodLoggedAt = new Date(entry.loggedAt);
            const restoredData = {
              date: entry.date,
              mood: entry.mood,
              score: entry.score,
              // The five level-A values, carried the same way `syncVersion`
              // is: absent in the file means the file predates the columns,
              // and an upsert whose update arm stated them would wipe live
              // answers off every matched row when an older backup is
              // restored over a going concern. A file that has them writes
              // them, including an explicit null; a file that does not says
              // nothing. Never derived — filling one in here would put a
              // number the person never gave into a restored row.
              ...(entry.a1 === undefined ? {} : { moodA1: entry.a1 }),
              ...(entry.a2 === undefined ? {} : { stressA2: entry.a2 }),
              ...(entry.a3 === undefined ? {} : { energyA3: entry.a3 }),
              ...(entry.a4 === undefined ? {} : { connectionA4: entry.a4 }),
              ...(entry.a5 === undefined ? {} : { stabilityA5: entry.a5 }),
              tags: entry.tags ?? null,
              // The note comes back the way every other dual-column note
              // does: ciphertext verbatim when the file carries it, and a
              // portable file's plaintext re-encrypted on the way in, with
              // the legacy column left null either way.
              note: null,
              noteEncrypted:
                entry.noteEncrypted == null
                  ? encryptNote(entry.note ?? null)
                  : decodeEncryptedBytes(entry.noteEncrypted),
              source: entry.source ?? "MOODLOG",
              externalId: entry.externalId ?? null,
              moodLoggedAt,
              // The zone the `date` string is anchored to. A file written
              // before this rode the payload carries nothing, and NULL is
              // what such a row meant anyway: the legacy Europe/Berlin
              // reading. So an old file keeps its old day boundaries and a
              // new one keeps the zone the person actually logged in.
              tz: entry.tz ?? null,
              // Mood reconciles last-writer-wins by `syncVersion`. Restoring
              // at the schema default would hand the next sync round to any
              // paired device still holding a higher number, and the device
              // would overwrite the recovered row with what it had — a
              // restore that loses to the client is worse than one that
              // fails. An old file carries nothing here and keeps the
              // default, which is the value those rows were written with.
              ...(entry.syncVersion === undefined
                ? {}
                : { syncVersion: entry.syncVersion }),
              deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
              ...(entry.syncedAt ? { syncedAt: new Date(entry.syncedAt) } : {}),
              ...(entry.createdAt
                ? { createdAt: new Date(entry.createdAt) }
                : {}),
              ...(entry.updatedAt
                ? { updatedAt: new Date(entry.updatedAt) }
                : {}),
            };
            const createData = { userId: ownerId, ...restoredData };
            const restored = entry.id
              ? await tx.moodEntry.upsert({
                  where: { id: entry.id, userId: ownerId },
                  create: { id: entry.id, ...createData },
                  update: restoredData,
                })
              : entry.externalId
                ? await tx.moodEntry.upsert({
                    where: {
                      userId_source_externalId: {
                        userId: ownerId,
                        source: restoredData.source,
                        externalId: entry.externalId,
                      },
                    },
                    create: createData,
                    update: restoredData,
                  })
                : await tx.moodEntry.upsert({
                    where: {
                      userId_date_moodLoggedAt: {
                        userId: ownerId,
                        date: entry.date,
                        moodLoggedAt,
                      },
                    },
                    create: createData,
                    update: restoredData,
                  });

            // The day context, rebuilt after the entry so it can bind to
            // whatever id that entry actually got. Delete-then-write rather
            // than an upsert with a preserve-when-absent arm: the file
            // states the whole context or states that there was none, and a
            // restored entry carrying half a file's context and half a live
            // row's would be a state neither of them describes.
            await tx.moodContext.deleteMany({
              where: { moodEntryId: restored.id },
            });
            if (entry.context) {
              const context = entry.context;
              await tx.moodContext.create({
                data: {
                  moodEntryId: restored.id,
                  userId: ownerId,
                  workStatus: context.workStatus ?? null,
                  workMinutes: context.workMinutes ?? null,
                  overtimeMinutes: context.overtimeMinutes ?? null,
                  workLoad: context.workLoad ?? null,
                  workSatisfaction: context.workSatisfaction ?? null,
                  contactCircles: context.contactCircles ?? null,
                  contactForm: context.contactForm ?? null,
                  contactExtent: context.contactExtent ?? null,
                  contactQuality: context.contactQuality ?? null,
                  contactSupport: context.contactSupport ?? null,
                  leisureCategories: context.leisureCategories ?? null,
                  leisureMinutes: context.leisureMinutes ?? null,
                  leisureJoy: context.leisureJoy ?? null,
                  leisureRecovery: context.leisureRecovery ?? null,
                  eventType: context.eventType ?? null,
                  eventValence: context.eventValence ?? null,
                  eventAt: context.eventAt ? new Date(context.eventAt) : null,
                  // The note comes back the way every other dual-column
                  // note does: ciphertext verbatim when the file carries
                  // it, a portable file's plain text re-encrypted on the
                  // way in.
                  notesEncrypted:
                    context.notesEncrypted == null
                      ? encryptNote(context.note ?? null)
                      : decodeEncryptedBytes(context.notesEncrypted),
                },
              });
            }

            await tx.moodEntryTagLink.deleteMany({
              where: { moodEntryId: restored.id },
            });
            const factorLinks = entry.factors.flatMap((factor) => {
              const moodTagId = factorByKey.get(factor.key);
              return moodTagId
                ? [
                    {
                      moodEntryId: restored.id,
                      moodTagId,
                      rating: factor.rating,
                    },
                  ]
                : [];
            });
            // The other arm. A BINARY link carries no score — the presence
            // of the row is the signal — so `rating` is NULL by definition,
            // which is exactly what the backup's old tag-link filter took to
            // mean "nothing here".
            const tagLinks = entry.structuredTags.flatMap((key) => {
              const moodTagId = tagByKey.get(key);
              return moodTagId
                ? [{ moodEntryId: restored.id, moodTagId, rating: null }]
                : [];
            });
            const links = [...factorLinks, ...tagLinks];
            if (links.length > 0) {
              await tx.moodEntryTagLink.createMany({ data: links });
            }
          }
        }

        // v1.15.0 — cycle tables (profile + observed spans + day-logs +
        // symptom links). Delete-then-recreate, mirroring the contract
        // above. `notesEncrypted` is restored as ciphertext verbatim.
        reportSection("cycles");
        const cycleCleared = await restoreCycleData(
          tx,
          ownerId,
          payload,
          skips,
        );

        // Durable self-context + user-defined metrics. Both ends of this pair
        // live in `src/lib/export/profile-backup.ts` beside its builder — a
        // grep of THIS file alone will not find them, exactly as it does not
        // find the cycle restore one line above.
        reportSection("profile");
        const profileCleared = await restoreProfileData(tx, ownerId, payload);

        // The hourly shape of a cumulative day. Both ends live in
        // `src/lib/export/intraday-profile-backup.ts` beside its builder, so
        // a grep of THIS file alone will not find them either.
        const intradayCleared = await restoreIntradayProfileData(
          tx,
          ownerId,
          payload,
        );

        // The score as it was shown on each local day. Both ends live in
        // `src/lib/export/health-score-backup.ts`, same as the two above.
        const healthScoreCleared = await restoreHealthScoreData(
          tx,
          ownerId,
          payload,
        );

        // The needs-based setup answers. Both ends live in
        // `src/lib/export/onboarding-backup.ts`, same as the three above.
        const onboardingCleared = await restoreOnboardingData(
          tx,
          ownerId,
          payload,
        );

        // The account's own settings, onto the account row, column by column.
        // Only what `USER_COLUMN_BACKUP_CLASS` calls a setting can be written;
        // identity, credentials and this host's bookkeeping on the row stay as
        // the receiving account has them. A value this host will not take is
        // left out and named in the skip report. Both ends live in
        // `src/lib/export/account-settings-backup.ts`.
        const accountSettingsResult = await restoreAccountSettings(
          tx,
          ownerId,
          payload,
        );
        for (const column of accountSettingsResult.refused) {
          skips.push({ catalogue: "accountSetting", key: column, links: 1 });
        }

        reportSection("labs");
        const biomarkerByName = new Map<string, string>();
        const restoredBiomarkerIds = new Set<string>();
        for (const biomarker of payload.biomarkers) {
          const created = await tx.biomarker.create({
            data: {
              ...(biomarker.id ? { id: biomarker.id } : {}),
              userId: ownerId,
              name: biomarker.name,
              unit: biomarker.unit,
              lowerBound: biomarker.lowerBound ?? null,
              upperBound: biomarker.upperBound ?? null,
              panel: biomarker.panel ?? null,
              hidden: biomarker.hidden ?? false,
              contextEncrypted:
                biomarker.context == null
                  ? null
                  : encryptContextToBytes(biomarker.context),
              ...(biomarker.createdAt
                ? { createdAt: new Date(biomarker.createdAt) }
                : {}),
              ...(biomarker.updatedAt
                ? { updatedAt: new Date(biomarker.updatedAt) }
                : {}),
            },
          });
          biomarkerByName.set(biomarker.name, created.id);
          restoredBiomarkerIds.add(created.id);
        }

        // Collected for the staged facts further down: an approved fact's
        // `committedRecordId` names the lab result it was committed to, and
        // that reference is resolved against the rows this loop writes.
        const restoredLabResultIds = new Set<string>();
        // What each drug was supposed to move, written now that both ends
        // exist. The drugs came back several hundred lines up and the
        // analytes only just now, and one of those two had to move for a
        // target to reach the database at all.
        //
        // The second pass wins over hoisting the biomarker restore above the
        // medications, for two reasons. `biomarkerByName` and
        // `restoredBiomarkerIds` are read by the lab-result loop directly
        // below, so moving the block would separate a map from its only
        // other consumer and leave a future edit free to re-order them back
        // without anything noticing. And the direction of the dependency
        // would read backwards: a pinned target is a leaf of the medication
        // tree, and letting a leaf dictate where the clinical record is
        // rebuilt inverts what the file is about. A second pass states the
        // constraint where it applies instead of hiding it in a line order.
        //
        // A named analyte the restore did not put back cannot be written:
        // `biomarkerId` is a real foreign key, so a dangling value would
        // fail the constraint and roll the entire account back over one
        // override. The row is dropped and NAMED. Dropping rather than
        // nulling is deliberate here: the override IS the reference, and a
        // row with neither arm set is what the resolver already reads as "no
        // override", so keeping it would restore something that means
        // nothing while still claiming the primary slot. A target that
        // carried no name in the first place is a genuine live state (the
        // analyte was deleted before the export) and comes back as written.
        const unresolvedTargetAnalytes: string[] = [];
        const writableTargets = pendingEfficacyTargets.filter((pending) => {
          const name = pending.target.biomarkerName;
          if (!name || biomarkerByName.has(name)) return true;
          unresolvedTargetAnalytes.push(name);
          return false;
        });
        if (writableTargets.length > 0) {
          await tx.medicationEfficacyTarget.createMany({
            data: writableTargets.map(({ medicationId, target }) => ({
              ...(target.id ? { id: target.id } : {}),
              medicationId,
              measurementType: target.measurementType ?? null,
              biomarkerId: target.biomarkerName
                ? (biomarkerByName.get(target.biomarkerName) ?? null)
                : null,
              primary: target.primary ?? true,
              ...(target.createdAt
                ? { createdAt: new Date(target.createdAt) }
                : {}),
              ...(target.updatedAt
                ? { updatedAt: new Date(target.updatedAt) }
                : {}),
            })),
          });
        }
        recordUnknownKeys(
          skips,
          "medicationTarget",
          [...new Set(unresolvedTargetAnalytes)],
          unresolvedTargetAnalytes,
        );

        for (const lab of payload.labResults) {
          const biomarkerId =
            lab.biomarkerId !== undefined
              ? lab.biomarkerId === null
                ? null
                : restoredBiomarkerIds.has(lab.biomarkerId)
                  ? lab.biomarkerId
                  : undefined
              : lab.biomarkerName
                ? biomarkerByName.get(lab.biomarkerName)
                : null;
          if (biomarkerId === undefined) {
            throw new Error(
              `Unknown biomarker reference: ${lab.biomarkerId ?? lab.biomarkerName}`,
            );
          }
          const createdLab = await tx.labResult.create({
            data: {
              ...(lab.id ? { id: lab.id } : {}),
              userId: ownerId,
              biomarkerId: biomarkerId ?? null,
              panel: lab.panel ?? null,
              analyte: lab.analyte,
              value: lab.value ?? null,
              valueText: lab.valueText ?? null,
              unit: lab.unit,
              referenceLow: lab.referenceLow ?? null,
              referenceHigh: lab.referenceHigh ?? null,
              sourceReferenceLow: lab.sourceReferenceLow ?? null,
              sourceReferenceHigh: lab.sourceReferenceHigh ?? null,
              sourceReferenceText: lab.sourceReferenceText ?? null,
              takenAt: new Date(lab.takenAt),
              source: lab.source,
              noteEncrypted:
                lab.noteEncrypted !== undefined
                  ? lab.noteEncrypted === null
                    ? null
                    : decodeEncryptedBytes(lab.noteEncrypted)
                  : lab.note == null
                    ? null
                    : encryptNoteToBytes(lab.note),
              deletedAt: lab.deletedAt ? new Date(lab.deletedAt) : null,
              ...(lab.createdAt ? { createdAt: new Date(lab.createdAt) } : {}),
              ...(lab.updatedAt ? { updatedAt: new Date(lab.updatedAt) } : {}),
            },
          });
          restoredLabResultIds.add(createdLab.id);
        }

        reportSection("illness");
        const episodeIds = new Set(
          payload.illnessEpisodes.map((episode) => episode.id),
        );
        for (const episode of payload.illnessEpisodes) {
          if (
            episode.parentConditionId &&
            !episodeIds.has(episode.parentConditionId)
          ) {
            throw new Error(
              `Unknown illness parent: ${episode.parentConditionId}`,
            );
          }
          await tx.illnessEpisode.create({
            data: {
              id: episode.id,
              userId: ownerId,
              label: episode.label,
              type: episode.type as never,
              lifecycle: episode.lifecycle as never,
              onsetAt: new Date(episode.onsetAt),
              resolvedAt: episode.resolvedAt
                ? new Date(episode.resolvedAt)
                : null,
              parentConditionId: null,
              noteEncrypted:
                episode.noteEncrypted !== undefined
                  ? episode.noteEncrypted === null
                    ? null
                    : decodeEncryptedBytes(episode.noteEncrypted)
                  : episode.note == null
                    ? null
                    : encryptToBytes(episode.note),
              // v1.39.2 — the same two-armed read as the note: ciphertext
              // verbatim from a disaster-recovery file, plaintext re-encrypted
              // from a portable one, nothing from a file older than the field.
              bodySiteEncrypted:
                episode.bodySiteEncrypted !== undefined &&
                episode.bodySiteEncrypted !== null
                  ? decodeEncryptedBytes(episode.bodySiteEncrypted)
                  : episode.bodySite?.trim()
                    ? encryptToBytes(episode.bodySite.trim())
                    : null,
              laterality: episode.laterality ?? null,
              deletedAt: episode.deletedAt ? new Date(episode.deletedAt) : null,
              ...(episode.createdAt
                ? { createdAt: new Date(episode.createdAt) }
                : {}),
              ...(episode.updatedAt
                ? { updatedAt: new Date(episode.updatedAt) }
                : {}),
            },
          });
        }
        for (const episode of payload.illnessEpisodes) {
          if (episode.parentConditionId) {
            await tx.illnessEpisode.update({
              where: { id: episode.id, userId: ownerId },
              data: { parentConditionId: episode.parentConditionId },
            });
          }
        }

        const referencedSymptomKeys = payload.illnessEpisodes.flatMap(
          (episode) =>
            episode.dayLogs.flatMap((dayLog) =>
              dayLog.symptoms.map((symptom) => symptom.key),
            ),
        );
        const symptomKeys = [...new Set(referencedSymptomKeys)];
        const symptomRows =
          symptomKeys.length === 0
            ? []
            : await tx.illnessSymptom.findMany({
                where: { key: { in: symptomKeys } },
                select: { id: true, key: true },
              });
        const symptomByKey = new Map(
          symptomRows.map((symptom) => [symptom.key, symptom.id]),
        );
        // `IllnessSymptom` has no `userId` column at all — it is a purely
        // seeded catalogue, so a key that will not resolve here can ONLY be
        // catalogue drift and never a definition the file failed to carry.
        // Which makes refusing the file over it the least defensible of the
        // three: the file was never able to supply the missing row.
        recordUnknownKeys(
          skips,
          "illnessSymptom",
          symptomKeys.filter((key) => !symptomByKey.has(key)),
          referencedSymptomKeys,
        );
        for (const episode of payload.illnessEpisodes) {
          for (const dayLog of episode.dayLogs) {
            const symptomLinks = dayLog.symptoms.flatMap((symptom) => {
              const symptomId = symptomByKey.get(symptom.key);
              return symptomId
                ? [{ symptomId, severity: symptom.severity ?? null }]
                : [];
            });
            await tx.illnessDayLog.create({
              data: {
                ...(dayLog.id ? { id: dayLog.id } : {}),
                userId: ownerId,
                episodeId: episode.id,
                date: dayLog.date,
                functionalImpact: dayLog.functionalImpact ?? null,
                feverC: dayLog.feverC ?? null,
                noteEncrypted:
                  dayLog.noteEncrypted !== undefined
                    ? dayLog.noteEncrypted === null
                      ? null
                      : decodeEncryptedBytes(dayLog.noteEncrypted)
                    : dayLog.note == null
                      ? null
                      : encryptToBytes(dayLog.note),
                tz: dayLog.tz ?? null,
                deletedAt: dayLog.deletedAt ? new Date(dayLog.deletedAt) : null,
                ...(dayLog.createdAt
                  ? { createdAt: new Date(dayLog.createdAt) }
                  : {}),
                ...(dayLog.updatedAt
                  ? { updatedAt: new Date(dayLog.updatedAt) }
                  : {}),
                ...(symptomLinks.length > 0
                  ? { symptomLinks: { create: symptomLinks } }
                  : {}),
              },
            });
          }
        }

        // The person's own symptoms and their occurrences. After the episodes,
        // because an occurrence may point at one; the id set is the one this
        // branch just wrote. Both ends live in
        // `src/lib/export/symptoms-backup.ts`.
        const symptomsCleared = await restoreSymptomsData(
          tx,
          ownerId,
          payload,
          episodeIds,
          skips,
        );

        // The person's life events (v1.42). They reference nothing but the
        // account, so they have no ordering constraint and sit beside the
        // other person-made rows. Both ends live in
        // `src/lib/export/life-events-backup.ts`.
        const lifeEventsCleared = await restoreLifeEventsData(
          tx,
          ownerId,
          payload,
        );

        reportSection("allergies");
        for (const allergy of payload.allergies) {
          await tx.allergy.create({
            data: {
              id: allergy.id,
              userId: ownerId,
              substance: allergy.substance,
              category: allergy.category as never,
              type: allergy.type as never,
              severity: (allergy.severity ?? null) as never,
              status: allergy.status as never,
              onsetAt: allergy.onsetAt ? new Date(allergy.onsetAt) : null,
              reactionEncrypted:
                allergy.reactionEncrypted !== undefined
                  ? allergy.reactionEncrypted === null
                    ? null
                    : decodeEncryptedBytes(allergy.reactionEncrypted)
                  : allergy.reaction == null
                    ? null
                    : encryptToBytes(allergy.reaction),
              notesEncrypted:
                allergy.notesEncrypted !== undefined
                  ? allergy.notesEncrypted === null
                    ? null
                    : decodeEncryptedBytes(allergy.notesEncrypted)
                  : allergy.note == null
                    ? null
                    : encryptToBytes(allergy.note),
              deletedAt: allergy.deletedAt ? new Date(allergy.deletedAt) : null,
              ...(allergy.createdAt
                ? { createdAt: new Date(allergy.createdAt) }
                : {}),
              ...(allergy.updatedAt
                ? { updatedAt: new Date(allergy.updatedAt) }
                : {}),
            },
          });
        }

        reportSection("familyHistory");
        for (const familyEntry of payload.familyHistory) {
          await tx.familyHistoryEntry.create({
            data: {
              id: familyEntry.id,
              userId: ownerId,
              relationship: familyEntry.relationship as never,
              condition: familyEntry.condition,
              ageAtOnset: familyEntry.ageAtOnset ?? null,
              notesEncrypted:
                familyEntry.note == null
                  ? null
                  : encryptToBytes(familyEntry.note),
              ...(familyEntry.createdAt
                ? { createdAt: new Date(familyEntry.createdAt) }
                : {}),
              ...(familyEntry.updatedAt
                ? { updatedAt: new Date(familyEntry.updatedAt) }
                : {}),
            },
          });
        }

        if (payload.workouts.length > 0) {
          await tx.workout.createMany({
            data: payload.workouts.map((workout) => ({
              ...(workout.id ? { id: workout.id } : {}),
              userId: ownerId,
              sportType: workout.sportType,
              startedAt: new Date(workout.startedAt),
              endedAt: new Date(workout.endedAt),
              durationSec: workout.durationSec,
              totalEnergyKcal: workout.totalEnergyKcal ?? null,
              totalDistanceM: workout.totalDistanceM ?? null,
              avgHeartRate: workout.avgHeartRate ?? null,
              maxHeartRate: workout.maxHeartRate ?? null,
              minHeartRate: workout.minHeartRate ?? null,
              stepCount: workout.stepCount ?? null,
              elevationM: workout.elevationM ?? null,
              pauseDurationSec: workout.pauseDurationSec ?? null,
              source: workout.source as never,
              externalId: workout.externalId ?? null,
              externalSourceVersion: workout.externalSourceVersion ?? null,
              ...(workout.metadata == null
                ? {}
                : { metadata: toJson(workout.metadata) }),
              ...(workout.createdAt
                ? { createdAt: new Date(workout.createdAt) }
                : {}),
              ...(workout.updatedAt
                ? { updatedAt: new Date(workout.updatedAt) }
                : {}),
            })),
          });
        }

        if (payload.nutrientDays.length > 0) {
          await tx.nutrientIntakeDay.createMany({
            data: payload.nutrientDays.map((n) => ({
              userId: ownerId,
              day: n.day,
              nutrient: n.nutrient,
              amount: n.amount,
              unit: n.unit,
              source: n.source,
              externalSourceVersion: n.externalSourceVersion ?? null,
              ...(n.createdAt ? { createdAt: new Date(n.createdAt) } : {}),
            })),
          });
        }

        if (payload.documents.length > 0) {
          await tx.inboundDocument.createMany({
            data: payload.documents.map((document) => ({
              id: document.id,
              userId: ownerId,
              kind: document.kind as never,
              title: document.title ?? null,
              filename: document.filename ?? null,
              mimeType: document.mimeType,
              byteSize: document.byteSize,
              contentEncrypted: decodeEncryptedBytes(
                document.contentEncrypted!,
              ),
              contentSha256: document.contentSha256 ?? null,
              contentCodec: document.contentCodec!,
              status: document.status as never,
              providerType: document.providerType ?? null,
              reportDate: document.reportDate
                ? new Date(document.reportDate)
                : null,
              documentDate: document.documentDate
                ? new Date(document.documentDate)
                : null,
              errorReason: document.errorReason ?? null,
              summaryEncrypted: document.summaryEncrypted
                ? decodeEncryptedBytes(document.summaryEncrypted)
                : null,
              summaryGeneratedAt: document.summaryGeneratedAt
                ? new Date(document.summaryGeneratedAt)
                : null,
              summaryState: document.summaryState as never,
              lastIndexAttemptAt: document.lastIndexAttemptAt
                ? new Date(document.lastIndexAttemptAt)
                : null,
              lastIndexOutcome: document.lastIndexOutcome ?? null,
              // An older file has no marker: those documents predate the
              // hold and restore as ordinary ones.
              aiReadDeferred: document.aiReadDeferred ?? false,
              sourceSystem: document.sourceSystem ?? null,
              sourceId: document.sourceSystem
                ? (document.sourceId ?? null)
                : null,
              // A file written before v1.39.3 has no instance: the key then
              // matches any instance of its system, as it did when stored.
              sourceInstance:
                document.sourceSystem && document.sourceId
                  ? document.sourceInstance
                    ? normaliseSourceInstance(document.sourceInstance)
                    : null
                  : null,
              createdAt: new Date(document.createdAt!),
              updatedAt: new Date(document.updatedAt!),
            })),
          });
        }

        // What the vault was filed against, and what was read out of it.
        // AFTER the documents and the condition episodes because both are
        // foreign keys here — a filing written before either exists does not
        // drop quietly, it violates a constraint and costs the operator the
        // whole restore. AFTER the lab results and the medications for a
        // second reason: an approved fact's `committedRecordId` is resolved
        // against the rows those branches wrote, and resolving before they
        // exist would null every commitment and still report success. Both
        // ends of this section live in
        // `src/lib/export/document-filing-backup.ts`.
        reportSection("documents");
        const documentFilingCleared = await restoreDocumentFilingData(
          tx,
          ownerId,
          payload,
          {
            documentIds: new Set(
              payload.documents.map((document) => document.id),
            ),
            episodeIds,
            committedRecordIds: new Set([
              ...restoredLabResultIds,
              ...episodeIds,
              ...restoredMedicationIds,
            ]),
          },
          skips,
        );

        // The Vorsorge reminders and their completion ledger (v1.37.20,
        // #223 / iOS #68), BEFORE the visits and the vaccinations: both of
        // those remap a `reminderId` against the reminders in the database,
        // so the reminders have to be in the database first or every
        // appointment and booster reference would read as unresolvable and
        // drop. Both ends of this section live in
        // `src/lib/export/reminders-backup.ts`.
        reportSection("reminders");
        const remindersCleared = await restoreRemindersData(
          tx,
          ownerId,
          payload,
          skips,
        );

        // Visits, the address book and the three link tables. After the
        // documents and the reminders on purpose: a link is written only
        // when both of its ends exist, and the encounter's reminder
        // reference remaps against the rows the branch above has just
        // written. Both ends of this section live in
        // `src/lib/export/visits-backup.ts`, so a grep of THIS file alone
        // will not find them — the same delegation as the cycle, profile,
        // intraday and score restores above.
        reportSection("visits");
        const visitsCleared = await restoreVisitsData(
          tx,
          ownerId,
          payload,
          skips,
        );

        // The immunization log, after the visits: a dose remaps its
        // practitioner, its encounter and its booster reminder against rows
        // the branches above have just written, and its document link needs
        // the documents that landed before that. Both ends of this section
        // live in `src/lib/export/vaccinations-backup.ts`.
        reportSection("vaccinations");
        const vaccinationsCleared = await restoreVaccinationsData(
          tx,
          ownerId,
          payload,
          skips,
        );

        // The Coach's threads, turns and document links. AFTER the
        // documents on purpose: an attachment carries a `documentId` that
        // is a foreign key against them, so running earlier would make
        // every attachment unresolvable and drop the provenance that makes
        // an old answer checkable. The id set is threaded in rather than
        // re-queried so the function stays a pure reader of this
        // transaction. Both ends of this section live in
        // `src/lib/export/coach-backup.ts`.
        reportSection("coach");
        const coachCleared = await restoreCoachData(
          tx,
          ownerId,
          payload,
          new Set(payload.documents.map((document) => document.id)),
          skips,
        );

        // What the Coach keeps between threads. AFTER the transcript,
        // because all three carry a `sourceConversationId` that is resolved
        // against the threads the branch above has just written — resolving
        // earlier would cut every fact loose from the conversation it came
        // out of and still report success.
        const coachMemoryCleared = await restoreCoachMemoryData(
          tx,
          ownerId,
          payload,
          new Set(payload.coachConversations.map((c) => c.id)),
          new Set(
            payload.coachConversations.flatMap((c) =>
              c.messages.map((m) => m.id),
            ),
          ),
          skips,
        );

        // The screener history and the consent record. Neither references
        // anything but the account, so the position here is free; it sits
        // last because that is where the section was added, not because
        // anything above it matters to these two.
        reportSection("sensitive");
        const sensitiveCleared = await restoreSensitiveData(
          tx,
          ownerId,
          payload,
        );

        // The bests and the badges. AFTER the measurements, and this one is
        // not a preference: `PersonalRecord.sourceMeasurementId` is a real
        // foreign key against `measurements` (migration 0054) even though
        // `prisma/schema.prisma` declares no relation for it, so a pointer
        // resolved before the measurements exist would not drop quietly.
        // Postgres would refuse the insert and roll the whole restore back
        // over one provenance column. The id set is the measurements this
        // transaction actually wrote with a stable id, threaded in rather
        // than re-queried so the function stays a pure reader of it. Both
        // ends of this section live in `src/lib/export/awards-backup.ts`.
        reportSection("awards");
        const awardsCleared = await restoreAwardsData(
          tx,
          ownerId,
          payload,
          writtenReferencedIds,
          skips,
        );

        // The ECG strips. AFTER the measurements on purpose: a recording
        // carries a `measurementId` that is a real foreign key against the
        // EVENT row it was filed with, so a reference written before that
        // row exists does not merely dangle — it violates the constraint
        // and rolls the whole restore back. The id set is the one the
        // measurement branch actually wrote, threaded in rather than
        // re-queried so the function stays a pure reader of this
        // transaction. Both ends of this section live in
        // `src/lib/export/ecg-backup.ts`.
        reportSection("ecg");
        const ecgCleared = await restoreEcgData(
          tx,
          ownerId,
          payload,
          writtenReferencedIds,
          skips,
        );

        // The per-day readings and the location periods that explain them.
        // Neither references anything but the account, so this section has
        // no ordering constraint against any other and sits here beside the
        // rest. What it does owe is atomicity WITH ITSELF, which is why one
        // function writes both: readings restored without their periods get
        // re-resolved to the home location and overwritten by the next
        // environment refresh. Both ends of this section live in
        // `src/lib/export/environment-backup.ts`.
        reportSection("environment");
        const environmentCleared = await restoreEnvironmentData(
          tx,
          ownerId,
          payload,
        );

        const cleared = {
          measurements: measurements.count,
          medications: meds.count,
          intakeEvents: intake.count,
          moodEntries: moods.count,
          notificationChannels: channels.count,
          pushSubscriptions: subs.count,
          telegramScheduledDeletions: tgDel.count,
          cycles: cycleCleared.cycles,
          cycleDayLogs: cycleCleared.cycleDayLogs,
          cycleProfile: cycleCleared.cycleProfile,
          labResults: labResults.count,
          biomarkers: biomarkers.count,
          nutrientDays: nutrientDays.count,
          illnessEpisodes: illnessEpisodes.count,
          allergies: allergies.count,
          familyHistory: familyHistory.count,
          workouts: workouts.count,
          documents: documents.count,
          documentConditionLinks: documentFilingCleared.documentConditionLinks,
          extractedFacts: documentFilingCleared.extractedFacts,
          healthProfile: profileCleared.healthProfile,
          healthProfileFactRevisions: profileCleared.healthProfileFactRevisions,
          customMetrics: profileCleared.customMetrics,
          correlationPatterns: profileCleared.correlationPatterns,
          intradayProfiles: intradayCleared.intradayProfiles,
          healthScoreRecords: healthScoreCleared.healthScoreRecords,
          onboardingRecords: onboardingCleared.onboardingRecords,
          practitioners: visitsCleared.practitioners,
          encounters: visitsCleared.encounters,
          encounterLinks: visitsCleared.encounterLinks,
          vaccinations: vaccinationsCleared.vaccinations,
          vaccinationLinks: vaccinationsCleared.vaccinationLinks,
          customVaccines: vaccinationsCleared.customVaccines,
          measurementReminders: remindersCleared.measurementReminders,
          measurementReminderEvents: remindersCleared.measurementReminderEvents,
          coachConversations: coachCleared.coachConversations,
          coachMessages: coachCleared.coachMessages,
          coachConversationDocuments: coachCleared.coachConversationDocuments,
          coachFacts: coachMemoryCleared.coachFacts,
          coachPlans: coachMemoryCleared.coachPlans,
          coachReminders: coachMemoryCleared.coachReminders,
          mentalHealthAssessments: sensitiveCleared.mentalHealthAssessments,
          consentReceipts: sensitiveCleared.consentReceipts,
          personalRecords: awardsCleared.personalRecords,
          userAchievements: awardsCleared.userAchievements,
          environmentContexts: environmentCleared.environmentContexts,
          environmentTravelLocations:
            environmentCleared.environmentTravelLocations,
          ecgRecordings: ecgCleared.ecgRecordings,
          symptomDefinitions: symptomsCleared.symptomDefinitions,
          lifeEvents: lifeEventsCleared.lifeEvents,
        };
        assertNoNewForeignReferences(
          foreignBefore,
          await countForeignReferences(tx, ownerId, tenantEdges),
        );
        // Paired clients' delta cursors are no longer valid (see
        // `User.syncResetAt`). Stamped as the last write, so it commits with
        // the data, and stamped again right after the commit below to cover
        // a cursor issued while this transaction was still running.
        await stampSyncReset(tx, ownerId);
        progress.sectionsDone = RESTORE_SECTION_STEPS.length;
        report("sections", true);
        return {
          cleared,
          skipped: summarizeRestoreSkips(skips),
          expiredTombstonesSkipped,
          accountSettings: accountSettingsResult,
        };
      },
      {
        maxWait: 10_000,
        timeout: transactionTimeoutMs,
      },
    );
  } catch (err) {
    // Scrub the raw Prisma / driver error from the wire response —
    // even on an admin endpoint, leaking column names, constraint
    // names or query fragments lowers the cost of a future supply-
    // chain attack against this surface. The verbose text still
    // lands in the audit row (admin-readable) and the Wide Event
    // (operator-readable), so root-cause investigation is unaffected.
    const verbose = err instanceof Error ? err.message : String(err);
    const classified = classifyRestoreFailure(err);
    await auditLog("admin.backups.restore.failed", {
      userId: input.actorUserId,
      ipAddress: input.ipAddress,
      details: {
        backupId: backup.id,
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
    if (isStoredBackupReadError(err)) {
      // The second read, inside the transaction, found the copy replaced or
      // altered. The transaction rolled back, so nothing was changed.
      const refusal = storedBackupRefusal(err);
      return refused(refusal.status, refusal.code, refusal.message, {
        errorCode: refusal.code,
      });
    }
    // The wide event and the audit row carry the whole error. The job's row
    // is read by whoever started the restore, so it names the cause, never
    // the database's message, which can quote the rows involved.
    return refused(
      500,
      "transaction_failed",
      RESTORE_FAILURE_CAUSE_MESSAGES[classified.cause],
      { cause: classified.cause },
    );
  }

  // A pull that started before the commit read the pre-restore rows and may
  // have been issued a cursor after the stamp inside the transaction. The
  // second stamp expires that one too; it can only expire more cursors, so a
  // failure here costs a client at most one extra incremental page.
  try {
    await stampSyncReset(prisma, ownerId);
  } catch (err) {
    annotate({
      meta: {
        restore_sync_reset_failed: true,
        restore_sync_reset_error:
          err instanceof Error ? err.message : String(err),
      },
    });
  }

  const { cleared, skipped, expiredTombstonesSkipped, accountSettings } =
    outcome;
  const measurementsRestored =
    streamed.measurementCount - expiredTombstonesSkipped;
  annotate({
    meta: { restore_expired_tombstones_skipped: expiredTombstonesSkipped },
  });
  report("rebuilding", true);
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

  // v1.4.39.1 — re-fold the persistent measurement rollup tier from
  // the just-restored measurements. Pre-fix the restore left the
  // rollup table empty for the owner, so the dashboard chart's
  // `source=rollup` fast-path silently returned zero buckets until
  // the next worker boot ran the backfill discovery — multi-hour
  // window of empty charts for the operator-restored account. Runs
  // outside the transaction (the 5-year fold would otherwise hold a
  // long write lock) and is best-effort so a populator hiccup never
  // undoes the restore. The boot-time backfill is the safety net.
  //
  // The fold covers five years of the account in a handful of statements,
  // right after the restore wrote every reading. On a slow disk one of them
  // ran past the per-request statement limit, the fold was dropped, and the
  // account's charts stayed empty until the next boot (#1031). It gets the
  // time the deadline check above keeps free for it instead.
  if (measurementsRestored > 0) {
    try {
      await recomputeUserRollups(ownerId, {
        statementTimeoutMs: RESTORE_AFTER_TRANSACTION_ALLOWANCE_MS,
      });
    } catch (err) {
      annotate({
        meta: {
          measurement_rollup_restore_failed: true,
          measurement_rollup_restore_error:
            err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // v1.4.39 W-MOOD — re-fold the mood rollup tier from the just-
  // restored entries. Runs outside the transaction so the (5-year)
  // fold can't hold a long write lock; best-effort so a populator
  // hiccup doesn't undo the restore. The boot-time backfill is the
  // safety net — if this fails the next worker boot mints the rows.
  if (payload.moodEntries.length > 0) {
    try {
      await recomputeUserMoodRollups(ownerId, { granularities: ["DAY"] });
    } catch (err) {
      annotate({
        meta: {
          mood_rollup_restore_failed: true,
          mood_rollup_restore_error:
            err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // v1.4.39 W-MED — re-fold the medication-compliance rollup tier
  // from the restored intake events. The medication delete inside the
  // transaction already cascaded the existing rollup partition for
  // this owner via the FK, so the fold mints fresh rows. Boot-time
  // backfill is the safety net if this best-effort call fails.
  if (payload.intakeEvents.length > 0) {
    try {
      const restoreUser = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { timezone: true },
      });
      await recomputeUserMedicationCompliance(
        ownerId,
        MEDICATION_COMPLIANCE_BACKFILL_DAYS,
        restoreUser?.timezone ?? null,
      );
    } catch (err) {
      annotate({
        meta: {
          medication_compliance_rollup_restore_failed: true,
          medication_compliance_rollup_restore_error:
            err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  const summary = {
    ...summarizeBackup(payload),
    measurements: measurementsRestored,
  };

  await auditLog("admin.backups.restore", {
    userId: input.actorUserId,
    ipAddress: input.ipAddress,
    details: {
      backupId: backup.id,
      ownerId,
      ownerUsername: owner.username,
      // Whether this restore also rewrote the host's own settings. The one
      // effect of a restore that reaches accounts other than `ownerId`, so
      // the trail has to be able to answer it later.
      restoreInstanceSettings,
      cleared,
      // How many of the account's own settings came back. The ones that did
      // not are named in `skipped` under `accountSetting`.
      accountSettingsApplied: accountSettings.applied,
      // The durable half of the report. The response reaches whoever was
      // looking at the screen; the audit row is still here next week when
      // someone asks why a day-log lost a symptom.
      skipped,
      restored: {
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
        customVaccines: summary.customVaccines,
        measurementReminders: summary.measurementReminders,
        measurementReminderEvents: summary.measurementReminderEvents,
      },
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

  const response: RestoreResponse = {
    restored: true,
    summary,
    skipped,
    cleared,
  };
  return { ok: true, response };
}
