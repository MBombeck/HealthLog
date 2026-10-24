/**
 * The housekeeping queues: backups (weekly in-database, nightly off-host),
 * the restore drill and restores, every ledger and retention cleanup, the
 * medication maintenance passes, the imports (Apple Health, Health Connect,
 * medication intake), the converging encryption backfills, the document vault
 * work, the environment and Dawarich context, the geo and TLS probes, PR
 * detection and the measurement table maintenance.
 *
 * `cronIsTheRetry` (no retries) marks the passes whose failure repeats: a bulk
 * DELETE or UPDATE that timed out will time out again on an immediate retry,
 * and the next tick arrives with the whole gap as backoff. The transient ones
 * (the TLS probe, the off-host upload, a provider fetch) keep the default
 * retries. The restore drill sends `retryLimit: 0` in its own options, because
 * it pages each failed account itself.
 *
 * Policies. The retention ticks are keyless, so they carry none. Deliberately
 * left at `standard`: the environment fetch (an explicit-range backfill sends
 * with no key so it always runs; a policy would merge two requested ranges),
 * and the imports, the backup and PR detection, whose runs are each distinct
 * work. The per-user converging backfills are `exclusive`; the per-document
 * jobs and the runs that queue their own follow-up while active are `short`.
 */
import type { Job } from "pg-boss";

import {
  ACHIEVEMENT_UNLOCK_SWEEP_CRON,
  ACHIEVEMENT_UNLOCK_SWEEP_QUEUE,
} from "@/lib/jobs/achievement-unlock-sweep-queue";
import {
  APPLE_HEALTH_IMPORT_CONCURRENCY,
  APPLE_HEALTH_IMPORT_LEGACY_QUEUE,
  APPLE_HEALTH_IMPORT_V2_QUEUE,
  IMPORT_JOB_RECONCILE_CRON,
  IMPORT_JOB_RECONCILE_QUEUE,
} from "@/lib/jobs/apple-health-import-queue";
import {
  AUTH_LEDGER_CLEANUP_CRON,
  AUTH_LEDGER_CLEANUP_QUEUE,
} from "@/lib/jobs/auth-ledger-cleanup";
import { BACKUP_RESTORE_QUEUE } from "@/lib/jobs/backup-restore-queue";
import { COMPACTION_TOMBSTONE_PURGE_QUEUE } from "@/lib/jobs/compaction-tombstone-purge-queue";
import {
  CYCLE_PREDICTION_REFRESH_CRON,
  CYCLE_PREDICTION_REFRESH_QUEUE,
} from "@/lib/jobs/cycle-prediction-refresh";
import {
  DATA_BACKUP_QUEUE,
  DATA_BACKUP_SEND_OPTIONS,
} from "@/lib/jobs/data-backup-policy";
import {
  DAWARICH_SYNC_CRON,
  DAWARICH_SYNC_QUEUE,
} from "@/lib/jobs/dawarich-sync-queue";
import {
  DOCUMENT_AI_RUN_CONCURRENCY,
  DOCUMENT_AI_RUN_QUEUE,
} from "@/lib/jobs/document-ai-run-queue";
import {
  DOCUMENT_AI_RUN_REAPER_CRON,
  DOCUMENT_AI_RUN_REAPER_QUEUE,
} from "@/lib/jobs/document-ai-run-reaper-queue";
import {
  CONTENT_INDEX_BACKFILL_CONCURRENCY,
  CONTENT_INDEX_BACKFILL_QUEUE,
} from "@/lib/jobs/document-content-index-backfill-queue";
import {
  DOCUMENT_INDEX_CONCURRENCY,
  DOCUMENT_INDEX_QUEUE,
} from "@/lib/jobs/document-index-queue";
import {
  DOCUMENT_PURGE_CRON,
  DOCUMENT_PURGE_QUEUE,
} from "@/lib/jobs/document-purge-queue";
import {
  DOCUMENT_SUMMARY_CATCHUP_CONCURRENCY,
  DOCUMENT_SUMMARY_CATCHUP_QUEUE,
} from "@/lib/jobs/document-summary-catchup-queue";
import {
  DOCUMENT_SUMMARY_CONCURRENCY,
  DOCUMENT_SUMMARY_QUEUE,
} from "@/lib/jobs/document-summary-queue";
import {
  DOCUMENT_SUMMARY_REAPER_CRON,
  DOCUMENT_SUMMARY_REAPER_QUEUE,
} from "@/lib/jobs/document-summary-reaper-queue";
import {
  DOCUMENT_THUMBNAIL_CONCURRENCY,
  DOCUMENT_THUMBNAIL_QUEUE,
} from "@/lib/jobs/document-thumbnail-queue";
import {
  DOCUMENT_THUMBNAIL_BACKFILL_CONCURRENCY,
  DOCUMENT_THUMBNAIL_BACKFILL_QUEUE,
} from "@/lib/jobs/document-thumbnail-backfill-queue";
import {
  ENCRYPTION_KEY_ROTATE_CONCURRENCY,
  ENCRYPTION_KEY_ROTATE_QUEUE,
} from "@/lib/jobs/encryption-key-rotate-queue";
import {
  ENVIRONMENT_AQ_HISTORY_CRON,
  ENVIRONMENT_AQ_HISTORY_QUEUE,
} from "@/lib/jobs/environment-air-quality-history";
import {
  ENVIRONMENT_FETCH_CONCURRENCY,
  ENVIRONMENT_FETCH_CRON,
  ENVIRONMENT_FETCH_QUEUE,
} from "@/lib/jobs/environment-fetch";
import {
  FREE_TEXT_ENCRYPTION_BACKFILL_CONCURRENCY,
  FREE_TEXT_ENCRYPTION_BACKFILL_QUEUE,
} from "@/lib/jobs/free-text-encryption-backfill";
import { GEO_BACKFILL_CRON, GEO_BACKFILL_QUEUE } from "@/lib/jobs/geo-backfill";
import {
  GEOLITE2_FETCH_CRON,
  GEOLITE2_FETCH_QUEUE,
} from "@/lib/jobs/geolite2-fetch";
import {
  HEALTH_CONNECT_IMPORT_CONCURRENCY,
  HEALTH_CONNECT_IMPORT_QUEUE,
} from "@/lib/jobs/health-connect-import-queue";
import {
  INTAKE_AUTO_SKIP_CRON,
  INTAKE_AUTO_SKIP_QUEUE,
} from "@/lib/jobs/intake-auto-skip-queue";
import {
  INTAKE_AUTO_TAKE_CRON,
  INTAKE_AUTO_TAKE_QUEUE,
} from "@/lib/jobs/intake-auto-take-queue";
import { WHOLE_PASS } from "@/lib/jobs/long-pass";
import {
  MED_NOTES_ENCRYPTION_BACKFILL_CONCURRENCY,
  MED_NOTES_ENCRYPTION_BACKFILL_QUEUE,
} from "@/lib/jobs/med-notes-encryption-backfill";
import { MEASUREMENT_FOLD_REPAIR_QUEUE } from "@/lib/jobs/measurement-fold-repair-queue";
import {
  MEASUREMENT_MAINTENANCE_CRON,
  MEASUREMENT_MAINTENANCE_QUEUE,
  MEASUREMENT_MAINTENANCE_SEND_OPTIONS,
} from "@/lib/jobs/measurement-maintenance";
import {
  MEDICATION_INTAKE_IMPORT_CONCURRENCY,
  MEDICATION_INTAKE_IMPORT_QUEUE,
} from "@/lib/jobs/medication-intake-import-queue";
import {
  MEDICATION_INVENTORY_EXPIRE_CRON,
  MEDICATION_INVENTORY_EXPIRE_QUEUE,
} from "@/lib/jobs/medication-inventory-expire";
import {
  MOOD_PROGNOSIS_REFRESH_CRON,
  MOOD_PROGNOSIS_REFRESH_QUEUE,
} from "@/lib/jobs/mood-prognosis-refresh-queue";
import {
  NOTE_ENCRYPTION_BACKFILL_CONCURRENCY,
  NOTE_ENCRYPTION_BACKFILL_QUEUE,
} from "@/lib/jobs/note-encryption-backfill";
import {
  OFFHOST_BACKUP_QUEUE,
  OFFHOST_BACKUP_SEND_OPTIONS,
} from "@/lib/jobs/offhost-backup-queue";
import {
  OFFHOST_PURGE_CRON,
  OFFHOST_PURGE_QUEUE,
} from "@/lib/jobs/offhost-purge-queue";
import {
  PR_DETECTION_CONCURRENCY,
  PR_DETECTION_EXPIRE_SECONDS,
  PR_DETECTION_FALLBACK_CRON,
  PR_DETECTION_QUEUE,
  type PrDetectionPayload,
} from "@/lib/jobs/pr-detection";
import { PULSE_DAY_MEAN_QUEUE } from "@/lib/jobs/pulse-day-mean";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import {
  RESTORE_DRILL_CRON,
  RESTORE_DRILL_QUEUE,
  RESTORE_DRILL_SEND_OPTIONS,
} from "@/lib/jobs/restore-drill-queue";
import {
  SOFT_DELETE_PURGE_CRON,
  SOFT_DELETE_PURGE_QUEUE,
} from "@/lib/jobs/soft-delete-purge";
import {
  TLS_PIN_MONITOR_CRON,
  TLS_PIN_MONITOR_QUEUE,
} from "@/lib/jobs/tls-pin-monitor-queue";
import {
  INTAKE_SLOT_DEDUP_CONCURRENCY,
  INTAKE_SLOT_DEDUP_QUEUE,
} from "@/lib/medications/intake-slot-dedup";

import { MAINTENANCE_DISCOVERY } from "./maintenance-discovery";
import {
  defineJob,
  type JobDefinition,
  type JobGroup,
  type JobSpec,
} from "./define-job";

/** Weekly, Sunday 03:00. The send options carry the backup's long expiry. */
const DATA_BACKUP_CRON = "0 3 * * 0";
/** 02:30: after the audit and idempotency cleanups, before the weekly backup. */
const OFFHOST_BACKUP_CRON = "30 2 * * *";
const RATE_LIMIT_CLEANUP_QUEUE = "rate-limit-cleanup";
const RATE_LIMIT_CLEANUP_CRON = "*/5 * * * *";
const IDEMPOTENCY_CLEANUP_QUEUE = "idempotency-cleanup";
const IDEMPOTENCY_CLEANUP_CRON = "0 3 * * *";
/** An elevation lives five minutes; the sweep only keeps the table small. */
const STEP_UP_ELEVATION_CLEANUP_QUEUE = "step-up-elevation-cleanup";
const STEP_UP_ELEVATION_CLEANUP_CRON = "*/15 * * * *";
const AUDIT_LOG_CLEANUP_QUEUE = "audit-log-cleanup";
const AUDIT_LOG_CLEANUP_CRON = "15 3 * * *";
/** Daily duplicate dose-slot discovery; the empty payload is the fan-out. */
const INTAKE_SLOT_DEDUP_CRON = "28 3 * * *";
/** Every five minutes; the admin chart polls at the same interval. */
const HOST_METRIC_QUEUE = "host-metric-sample";
const HOST_METRIC_CRON = "*/5 * * * *";
/** After the cleanups, so the previous day's noise is gone. */
const FEEDBACK_AGGREGATOR_QUEUE = "feedback-aggregator";
const FEEDBACK_AGGREGATOR_CRON = "0 4 * * *";
const MOOD_REMINDER_CLEANUP_QUEUE = "mood-reminder-cleanup";
const MOOD_REMINDER_CLEANUP_CRON = "25 3 * * *";
const PUSH_ATTEMPT_CLEANUP_QUEUE = "push-attempt-cleanup";
const PUSH_ATTEMPT_CLEANUP_CRON = "35 3 * * *";
const ARRIVAL_REACTION_CLEANUP_QUEUE = "arrival-reaction-cleanup";
const ARRIVAL_REACTION_CLEANUP_CRON = "10 4 * * *";
const MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE = "measurement-tombstone-cleanup";
const MEASUREMENT_TOMBSTONE_CLEANUP_CRON = "40 3 * * *";
const COACH_MESSAGE_CLEANUP_QUEUE = "coach-message-cleanup";
const COACH_MESSAGE_CLEANUP_CRON = "50 3 * * *";
const WORKOUT_INSIGHT_CLAIM_CLEANUP_QUEUE = "workout-insight-claim-cleanup";
const WORKOUT_INSIGHT_CLAIM_CLEANUP_CRON = "52 3 * * *";
const NOTE_ENCRYPTION_BACKFILL_CRON = "55 3 * * *";
const MCP_TOKEN_CLEANUP_QUEUE = "mcp-token-cleanup";
const MCP_TOKEN_CLEANUP_CRON = "0 4 * * *";
const MED_NOTES_ENCRYPTION_BACKFILL_CRON = "5 4 * * *";
const FREE_TEXT_ENCRYPTION_BACKFILL_CRON = "7 4 * * *";

const backups = () => import("@/lib/jobs/reminder/backup-handlers");
const cleanups = () => import("@/lib/jobs/reminder/cleanup-handlers");
const ops = () => import("@/lib/jobs/reminder/ops-handlers");
const medication = () => import("@/lib/jobs/reminder/medication-maintenance");
const maintenance = () => import("@/lib/jobs/reminder/maintenance-handlers");
const encryption = () =>
  import("@/lib/jobs/reminder/encryption-backfill-handlers");
const documents = () => import("@/lib/jobs/reminder/document-handlers");

/** A daily keyless prune: one bounded, idempotent delete, single-flight. */
function prune<J extends Job<unknown>>(
  queue: string,
  cron: string,
  load: JobSpec<J>["load"],
  options: { retry: "cron" | "default" } = { retry: "cron" },
): JobDefinition {
  return defineJob({
    queue,
    cron,
    ...(options.retry === "cron" ? { scheduleOptions: cronIsTheRetry } : {}),
    work: { localConcurrency: 1 },
    load,
  });
}

const perUserBackfill = (reason: string) =>
  ({ policy: "exclusive", reason }) as const;

const jobs: readonly JobDefinition[] = [
  defineJob({
    queue: ENVIRONMENT_FETCH_QUEUE,
    cron: ENVIRONMENT_FETCH_CRON,
    work: { localConcurrency: ENVIRONMENT_FETCH_CONCURRENCY },
    load: async ({ boss }) =>
      (await maintenance()).environmentFetchHandler(boss),
  }),
  // A run with work left sends its own follow-up while still active, which
  // `exclusive` would swallow.
  defineJob({
    queue: ENVIRONMENT_AQ_HISTORY_QUEUE,
    cron: ENVIRONMENT_AQ_HISTORY_CRON,
    policy: {
      policy: "short",
      reason:
        "Per-account singleton key; collapse queued duplicates only, so the active run can queue its own follow-up.",
    },
    work: { localConcurrency: 1 },
    load: async ({ boss }) =>
      (await maintenance()).environmentAqHistoryHandler(boss),
  }),
  // A failed run is an outage at the instance; the default retries apply.
  defineJob({
    queue: DAWARICH_SYNC_QUEUE,
    cron: DAWARICH_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async ({ boss }) => (await maintenance()).dawarichSyncHandler(boss),
  }),
  defineJob({
    queue: DATA_BACKUP_QUEUE,
    cron: DATA_BACKUP_CRON,
    scheduleOptions: DATA_BACKUP_SEND_OPTIONS,
    work: { localConcurrency: 1 },
    lock: () => WHOLE_PASS,
    lane: true,
    load: async () => (await backups()).handleDataBackup,
  }),
  prune(
    RATE_LIMIT_CLEANUP_QUEUE,
    RATE_LIMIT_CLEANUP_CRON,
    async () => (await cleanups()).handleRateLimitCleanup,
  ),
  prune(
    IDEMPOTENCY_CLEANUP_QUEUE,
    IDEMPOTENCY_CLEANUP_CRON,
    async () => (await cleanups()).handleIdempotencyCleanup,
  ),
  prune(
    AUDIT_LOG_CLEANUP_QUEUE,
    AUDIT_LOG_CLEANUP_CRON,
    async () => (await cleanups()).handleAuditLogCleanup,
    { retry: "default" },
  ),
  prune(
    STEP_UP_ELEVATION_CLEANUP_QUEUE,
    STEP_UP_ELEVATION_CLEANUP_CRON,
    async () => (await cleanups()).handleStepUpElevationCleanup,
  ),
  // Bound with metadata: a retry resumes from the job's creation time.
  defineJob({
    queue: OFFHOST_BACKUP_QUEUE,
    cron: OFFHOST_BACKUP_CRON,
    scheduleOptions: OFFHOST_BACKUP_SEND_OPTIONS,
    work: { localConcurrency: 1, includeMetadata: true },
    lock: () => WHOLE_PASS,
    lane: true,
    load: async () => (await backups()).handleOffhostBackup,
  }),
  // Locked: a drill that outlives a restart never reads the bucket beside
  // another one.
  defineJob({
    queue: RESTORE_DRILL_QUEUE,
    cron: RESTORE_DRILL_CRON,
    scheduleOptions: RESTORE_DRILL_SEND_OPTIONS,
    work: { localConcurrency: 1 },
    lock: () => WHOLE_PASS,
    lane: true,
    load: async () =>
      (await import("@/lib/jobs/restore-drill")).handleRestoreDrill,
  }),
  // The nightly backstop for the purge an account deletion kicks at once.
  prune(
    OFFHOST_PURGE_QUEUE,
    OFFHOST_PURGE_CRON,
    async () => (await import("@/lib/jobs/offhost-purge")).handleOffhostPurge,
  ),
  // One restore at a time: each holds a transaction over a whole account.
  defineJob({
    queue: BACKUP_RESTORE_QUEUE,
    work: { localConcurrency: 1 },
    lane: true,
    load: async () =>
      (await import("@/lib/jobs/backup-restore")).handleBackupRestore,
  }),
  prune(
    HOST_METRIC_QUEUE,
    HOST_METRIC_CRON,
    async () => (await ops()).handleHostMetricSample,
  ),
  prune(
    FEEDBACK_AGGREGATOR_QUEUE,
    FEEDBACK_AGGREGATOR_CRON,
    async () => (await ops()).handleFeedbackAggregator,
  ),
  // Hourly at :40, capped per pass, for audit rows that landed without a geo.
  prune(
    GEO_BACKFILL_QUEUE,
    GEO_BACKFILL_CRON,
    async () => (await ops()).handleGeoBackfill,
  ),
  // Monthly; a month is far too long to be the retry, so default retries.
  prune(
    GEOLITE2_FETCH_QUEUE,
    GEOLITE2_FETCH_CRON,
    async () => (await ops()).handleGeolite2Fetch,
    { retry: "default" },
  ),
  // Every six hours, inside the re-pin window the app's leaf pin needs.
  prune(
    TLS_PIN_MONITOR_QUEUE,
    TLS_PIN_MONITOR_CRON,
    async () => (await ops()).handleTlsPinMonitor,
    { retry: "default" },
  ),
  // An ingest job is one account; the fallback rescan every 30 minutes walks
  // every account, one run at a time.
  defineJob({
    queue: PR_DETECTION_QUEUE,
    cron: PR_DETECTION_FALLBACK_CRON,
    scheduleOptions: { expireInSeconds: PR_DETECTION_EXPIRE_SECONDS },
    work: { localConcurrency: PR_DETECTION_CONCURRENCY },
    lock: (job: Job<PrDetectionPayload>) => {
      const userId = (job.data as PrDetectionPayload | undefined)?.userId;
      return userId ? `user:${userId}` : WHOLE_PASS;
    },
    load: async () => (await ops()).handlePrDetection,
  }),
  prune(
    MEDICATION_INVENTORY_EXPIRE_QUEUE,
    MEDICATION_INVENTORY_EXPIRE_CRON,
    async () => (await medication()).handleMedicationInventoryExpire,
  ),
  prune(
    INTAKE_AUTO_SKIP_QUEUE,
    INTAKE_AUTO_SKIP_CRON,
    async () => (await medication()).handleIntakeAutoSkip,
  ),
  prune(
    INTAKE_AUTO_TAKE_QUEUE,
    INTAKE_AUTO_TAKE_CRON,
    async () => (await medication()).handleIntakeAutoTake,
  ),
  // CPU-bound parse of up to a gigabyte; a second at once would race the
  // first for memory.
  defineJob({
    queue: APPLE_HEALTH_IMPORT_V2_QUEUE,
    work: { localConcurrency: APPLE_HEALTH_IMPORT_CONCURRENCY },
    lane: true,
    load: async () => (await maintenance()).handleAppleHealthImportJobs,
  }),
  defineJob({
    queue: APPLE_HEALTH_IMPORT_LEGACY_QUEUE,
    work: { localConcurrency: APPLE_HEALTH_IMPORT_CONCURRENCY },
    load: async () => (await maintenance()).handleLegacyAppleHealthImportJobs,
  }),
  // Every 15 minutes: an import a crashed worker left mid-run converges to a
  // visible `failed` within two ticks.
  prune(
    IMPORT_JOB_RECONCILE_QUEUE,
    IMPORT_JOB_RECONCILE_CRON,
    async () =>
      (await import("@/lib/jobs/apple-health-import-worker"))
        .handleImportJobReconcileTick,
  ),
  defineJob({
    queue: MEDICATION_INTAKE_IMPORT_QUEUE,
    work: {
      localConcurrency: MEDICATION_INTAKE_IMPORT_CONCURRENCY,
      includeMetadata: true,
    },
    load: async () => (await maintenance()).handleMedicationIntakeImportJobs,
  }),
  defineJob({
    queue: HEALTH_CONNECT_IMPORT_QUEUE,
    work: { localConcurrency: HEALTH_CONNECT_IMPORT_CONCURRENCY },
    lane: true,
    load: async () =>
      (await import("@/lib/jobs/health-connect-import-worker"))
        .handleHealthConnectImport,
  }),
  // A run that stops early sends its own follow-up while still active, which
  // `exclusive` would swallow. Serial: each batch holds an account against a
  // concurrent restore.
  defineJob({
    queue: COMPACTION_TOMBSTONE_PURGE_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Fixed singleton key; collapse queued duplicates only, so the active run can queue its own follow-up.",
    },
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/compaction-tombstone-purge"))
        .handleCompactionTombstonePurge,
  }),
  defineJob({
    queue: MEASUREMENT_FOLD_REPAIR_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Per-account singleton key; collapse queued duplicates only, so the active run can queue its own follow-up.",
    },
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/measurement-fold-repair"))
        .handleMeasurementFoldRepair,
  }),
  // The nightly check vacuums when dead rows pile up; the same singleton key
  // as the operator's run, so the two collapse.
  defineJob({
    queue: MEASUREMENT_MAINTENANCE_QUEUE,
    cron: MEASUREMENT_MAINTENANCE_CRON,
    scheduleOptions: MEASUREMENT_MAINTENANCE_SEND_OPTIONS,
    policy: {
      policy: "exclusive",
      reason:
        "Fixed singleton key on the admin send and the nightly tick alike. Two maintenance passes would vacuum or rebuild side by side; the route reports a suppressed send back as enqueued: false.",
    },
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/measurement-maintenance"))
        .handleMeasurementMaintenance,
  }),
  defineJob({
    queue: PULSE_DAY_MEAN_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Fixed singleton key, admin-triggered. A dry run beside a rebuild would compare against rollups being rewritten; the route answers 409 busy instead.",
    },
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/pulse-day-mean")).handlePulseDayMean,
  }),
  defineJob({
    queue: INTAKE_SLOT_DEDUP_QUEUE,
    cron: INTAKE_SLOT_DEDUP_CRON,
    policy: perUserBackfill(
      "Per-user duplicate-slot cleanup; discovery drops the user once no colliding intake pair remains.",
    ),
    work: { localConcurrency: INTAKE_SLOT_DEDUP_CONCURRENCY },
    load: async () => (await maintenance()).handleIntakeSlotDedup,
  }),
  prune(
    MOOD_REMINDER_CLEANUP_QUEUE,
    MOOD_REMINDER_CLEANUP_CRON,
    async () => (await cleanups()).handleMoodReminderCleanup,
  ),
  prune(
    PUSH_ATTEMPT_CLEANUP_QUEUE,
    PUSH_ATTEMPT_CLEANUP_CRON,
    async () => (await cleanups()).handlePushAttemptCleanup,
  ),
  prune(
    ARRIVAL_REACTION_CLEANUP_QUEUE,
    ARRIVAL_REACTION_CLEANUP_CRON,
    async () => (await cleanups()).handleArrivalReactionCleanup,
  ),
  // The nightly refreshes: tomorrow's tick is the retry.
  prune(
    CYCLE_PREDICTION_REFRESH_QUEUE,
    CYCLE_PREDICTION_REFRESH_CRON,
    async () =>
      (await import("@/lib/jobs/cycle-prediction-refresh"))
        .handleCyclePredictionRefresh,
  ),
  prune(
    MOOD_PROGNOSIS_REFRESH_QUEUE,
    MOOD_PROGNOSIS_REFRESH_CRON,
    async () =>
      (await import("@/lib/jobs/mood-prognosis-refresh"))
        .handleMoodPrognosisRefresh,
  ),
  prune(
    ACHIEVEMENT_UNLOCK_SWEEP_QUEUE,
    ACHIEVEMENT_UNLOCK_SWEEP_CRON,
    async () =>
      (await import("@/lib/jobs/achievement-unlock-sweep"))
        .handleAchievementUnlockSweep,
  ),
  prune(
    MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE,
    MEASUREMENT_TOMBSTONE_CLEANUP_CRON,
    async () => (await cleanups()).handleMeasurementTombstoneCleanup,
    { retry: "default" },
  ),
  prune(
    COACH_MESSAGE_CLEANUP_QUEUE,
    COACH_MESSAGE_CLEANUP_CRON,
    async () => (await cleanups()).handleCoachMessageCleanup,
  ),
  prune(
    WORKOUT_INSIGHT_CLAIM_CLEANUP_QUEUE,
    WORKOUT_INSIGHT_CLAIM_CLEANUP_CRON,
    async () => (await cleanups()).handleWorkoutInsightClaimCleanup,
  ),
  // The converging encryption backfills: boot discovery plus a daily tick
  // whose empty payload fans out one job per account still holding a
  // readable value.
  defineJob({
    queue: NOTE_ENCRYPTION_BACKFILL_QUEUE,
    cron: NOTE_ENCRYPTION_BACKFILL_CRON,
    policy: perUserBackfill(
      "Per-user note-encryption backfill; discovery drops the user once no plaintext note remains.",
    ),
    work: { localConcurrency: NOTE_ENCRYPTION_BACKFILL_CONCURRENCY },
    load: async () => (await encryption()).handleNoteEncryptionBackfill,
  }),
  // Admin-triggered, one corpus rotation at a time.
  defineJob({
    queue: ENCRYPTION_KEY_ROTATE_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Fixed singleton key, admin-triggered. Two concurrent corpus rotations must never overlap; the route already reports a suppressed send back as alreadyQueued.",
    },
    work: { localConcurrency: ENCRYPTION_KEY_ROTATE_CONCURRENCY },
    lock: () => WHOLE_PASS,
    load: async () =>
      (await import("@/lib/jobs/encryption-key-rotate"))
        .handleEncryptionKeyRotate,
  }),
  prune(
    MCP_TOKEN_CLEANUP_QUEUE,
    MCP_TOKEN_CLEANUP_CRON,
    async () => (await cleanups()).handleMcpTokenCleanup,
  ),
  defineJob({
    queue: MED_NOTES_ENCRYPTION_BACKFILL_QUEUE,
    cron: MED_NOTES_ENCRYPTION_BACKFILL_CRON,
    policy: perUserBackfill(
      "Per-user medication-note encryption backfill; discovery drops the user once no plaintext note remains.",
    ),
    work: { localConcurrency: MED_NOTES_ENCRYPTION_BACKFILL_CONCURRENCY },
    load: async () => (await encryption()).handleMedNotesEncryptionBackfill,
  }),
  defineJob({
    queue: FREE_TEXT_ENCRYPTION_BACKFILL_QUEUE,
    cron: FREE_TEXT_ENCRYPTION_BACKFILL_CRON,
    policy: perUserBackfill(
      "Per-user encryption backfill (Coach title, custom-metric note, practitioner phone + address, workout GPS track); discovery drops the user once no readable value remains.",
    ),
    work: { localConcurrency: FREE_TEXT_ENCRYPTION_BACKFILL_CONCURRENCY },
    load: async () => (await encryption()).handleFreeTextEncryptionBackfill,
  }),
  // Physical purge of documents past the 30-day undo grace.
  prune(
    DOCUMENT_PURGE_QUEUE,
    DOCUMENT_PURGE_CRON,
    async () => (await import("@/lib/jobs/document-purge")).handleDocumentPurge,
  ),
  prune(
    SOFT_DELETE_PURGE_QUEUE,
    SOFT_DELETE_PURGE_CRON,
    async () =>
      (await import("@/lib/jobs/soft-delete-purge")).handleSoftDeletePurge,
  ),
  prune(
    AUTH_LEDGER_CLEANUP_QUEUE,
    AUTH_LEDGER_CLEANUP_CRON,
    async () =>
      (await import("@/lib/jobs/auth-ledger-cleanup")).handleAuthLedgerCleanup,
  ),
  // Hourly heal of summaries stuck on PENDING.
  prune(
    DOCUMENT_SUMMARY_REAPER_QUEUE,
    DOCUMENT_SUMMARY_REAPER_CRON,
    async () =>
      (await import("@/lib/jobs/document-summary-reaper"))
        .handleDocumentSummaryReaper,
  ),
  // Index-all for one account, idempotent: a second press while one runs is
  // correctly a no-op.
  defineJob({
    queue: CONTENT_INDEX_BACKFILL_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-user index-all run, triggered from the documents surface. Idempotent (it indexes only not-yet-indexed documents), so a second press while one runs is correctly a no-op.",
    },
    work: { localConcurrency: CONTENT_INDEX_BACKFILL_CONCURRENCY },
    lock: (job: Job<{ userId?: string }>) => `user:${job.data.userId ?? ""}`,
    load: async () => (await documents()).handleContentIndexBackfill,
  }),
  // Per-document jobs re-read the document when they start, so only queued
  // duplicates may collapse; nothing re-offers a dropped re-process.
  defineJob({
    queue: DOCUMENT_INDEX_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Per-document, no re-converging discovery pass. Collapse queued duplicates only, so a re-index after a content change is never dropped.",
    },
    work: { localConcurrency: DOCUMENT_INDEX_CONCURRENCY },
    // One index per document at a time: a delivery after the expiry finds the
    // reads still running and reports so instead of reading beside them.
    lock: (job: Job<{ documentId?: string }>) =>
      `document:${job.data.documentId ?? ""}`,
    load: async () => (await documents()).handleDocumentIndex,
  }),
  // One run per job under its run id's lock, so a redelivery never reads
  // beside the first delivery.
  defineJob({
    queue: DOCUMENT_AI_RUN_QUEUE,
    work: { localConcurrency: DOCUMENT_AI_RUN_CONCURRENCY },
    lock: (job: Job<{ runId?: string }>) => `run:${job.data.runId ?? ""}`,
    load: async () =>
      (await import("@/lib/jobs/document-ai-run")).handleDocumentAiRunJobs,
  }),
  prune(
    DOCUMENT_AI_RUN_REAPER_QUEUE,
    DOCUMENT_AI_RUN_REAPER_CRON,
    async () =>
      (await import("@/lib/jobs/document-ai-run-reaper"))
        .handleDocumentAiRunReaper,
  ),
  defineJob({
    queue: DOCUMENT_THUMBNAIL_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Per-document, no re-converging discovery pass. Collapse queued duplicates only.",
    },
    work: { localConcurrency: DOCUMENT_THUMBNAIL_CONCURRENCY },
    load: async () => (await documents()).handleDocumentThumbnail,
  }),
  defineJob({
    queue: DOCUMENT_THUMBNAIL_BACKFILL_QUEUE,
    policy: perUserBackfill(
      "Per-user thumbnail backfill; discovery drops the user once every thumbnailable document has a preview.",
    ),
    work: { localConcurrency: DOCUMENT_THUMBNAIL_BACKFILL_CONCURRENCY },
    load: async () => (await documents()).handleDocumentThumbnailBackfill,
  }),
  defineJob({
    queue: DOCUMENT_SUMMARY_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Per-document, no re-converging discovery pass. Collapse queued duplicates only.",
    },
    work: { localConcurrency: DOCUMENT_SUMMARY_CONCURRENCY },
    load: async () => (await documents()).handleDocumentSummary,
  }),
  defineJob({
    queue: DOCUMENT_SUMMARY_CATCHUP_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Per-user, keyed on the opt-in flip. Collapse a double toggle into one pass; the pass re-reads its candidate set when it starts.",
    },
    work: { localConcurrency: DOCUMENT_SUMMARY_CATCHUP_CONCURRENCY },
    load: async () => (await documents()).handleDocumentSummaryCatchUp,
  }),
];

/** A restore the previous process was running is picked up once its heartbeat is stale. */
async function sweepInterruptedRestores({
  boss,
}: {
  boss: Parameters<JobDefinition["load"]>[0]["boss"];
}): Promise<void> {
  await (
    await import("@/lib/jobs/backup-restore")
  ).enqueueBackupRestoreSweepAtBoot(boss);
}

export const MAINTENANCE_GROUP: JobGroup = {
  name: "maintenance",
  jobs,
  afterBind: sweepInterruptedRestores,
  discovery: MAINTENANCE_DISCOVERY,
};
