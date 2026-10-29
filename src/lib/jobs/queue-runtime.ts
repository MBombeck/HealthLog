/**
 * How long one job of each queue can run, and what keeps a long one safe.
 *
 * pg-boss gives every job an expiry, fifteen minutes unless the send says
 * otherwise. Past it pg-boss fails the job, fires its abort signal and retries
 * it, and it does not stop the handler, so a job that legitimately needs longer
 * ends up running twice beside itself. No queue policy prevents that: the
 * policies constrain job rows, and an expired row is no longer active. Every
 * queue the worker registry declares is therefore declared here as one of:
 *
 *   - `short`: a job cannot come near fifteen minutes (one account's bounded
 *     window, one document, a forwarder, a bounded delete). It relies on the
 *     default expiry, and the reason says why that is enough.
 *   - `budgeted`: a pass over a long history that stops itself at three
 *     quarters of the default expiry (`jobBudget`) and hands the rest to its
 *     next run, so it ends before fifteen minutes by construction.
 *   - `bounded`: one unit of model work (one account's note, refresh or
 *     memory pass, a document summary) whose calls wait the person's
 *     response timeout each, up to ten minutes, which can outlast fifteen
 *     minutes. Every call carries its own abort and most sit behind an outer
 *     bound, so the job's longest run is known (`modelSeconds`, from
 *     `model-time.ts`); it carries an explicit
 *     `expireInSeconds` above that on every send, and no retry can start
 *     beside a run that is still going (#1274).
 *   - `long`: a job that may run for hours. It carries an explicit
 *     `expireInSeconds` on every send and schedule, stops itself before that
 *     expiry (`jobBudget` / `jobDeadline`), and holds something per identity
 *     that keeps a second run from working beside it: the lock `lockedPass`
 *     takes, a lock of its own, or a row it claims. The one exception is a
 *     one-shot job with `retryLimit: 0`, which pg-boss never retries and which
 *     cannot stop half-way without losing its input.
 *
 * `src/__tests__/job-queue-runtime-guard.test.ts` holds every binding, send
 * and schedule in the tree to this table.
 */
import { INTEGRATION_BACKFILL_EXPIRE_SECONDS } from "@/lib/jobs/integration-backfill-admission";
import { NIGHTLY_INSIGHT_PASS_EXPIRE_SECONDS } from "@/lib/jobs/reminder/registrar-shared";
import { INSIGHT_PREGENERATE_EXPIRE_SECONDS } from "@/lib/jobs/insight-pregenerate-shared";
import { PERIOD_NARRATIVE_EXPIRE_SECONDS } from "@/lib/jobs/period-narrative-queue";
import { PR_DETECTION_EXPIRE_SECONDS } from "@/lib/jobs/pr-detection";
import { ENCRYPTION_KEY_ROTATE_EXPIRE_SECONDS } from "@/lib/jobs/encryption-key-rotate";
import { CONTENT_INDEX_BACKFILL_EXPIRE_SECONDS } from "@/lib/jobs/document-content-index-backfill";
import { DOCUMENT_AI_RUN_EXPIRE_SECONDS } from "@/lib/jobs/document-ai-run";
import { DATA_BACKUP_SEND_OPTIONS } from "@/lib/jobs/data-backup-policy";
import { DATABASE_BACKUP_EXPIRE_SECONDS } from "@/lib/jobs/database-backup-queue";
import { OFFHOST_BACKUP_EXPIRE_SECONDS } from "@/lib/jobs/offhost-backup-queue";
import { BACKUP_RESTORE_EXPIRE_SECONDS } from "@/lib/jobs/backup-restore";
import { RESTORE_DRILL_EXPIRE_SECONDS } from "@/lib/jobs/restore-drill-queue";
import { APPLE_HEALTH_IMPORT_SEND_OPTIONS } from "@/lib/jobs/apple-health-import-worker";
import { MEDICATION_INTAKE_IMPORT_SEND_OPTIONS } from "@/lib/jobs/medication-intake-import";
import { HEALTH_CONNECT_IMPORT_SEND_OPTIONS } from "@/lib/jobs/health-connect-import-worker";
import { MEASUREMENT_MAINTENANCE_SEND_OPTIONS } from "@/lib/jobs/measurement-maintenance";
import { PULSE_DAY_MEAN_SEND_OPTIONS } from "@/lib/jobs/pulse-day-mean";
import { ROLLUP_FULL_BACKFILL_EXPIRE_SECONDS } from "@/lib/rollups/full-backfill";
import { MORNING_DIGEST_REFRESH_EXPIRE_SECONDS } from "@/lib/jobs/morning-digest-refresh-shared";
import { INSIGHT_STATUS_GENERATE_EXPIRE_SECONDS } from "@/lib/jobs/insight-status-generate-queue";
import { WORKOUT_INSIGHT_GENERATE_EXPIRE_SECONDS } from "@/lib/jobs/workout-insight-generate-shared";
import {
  COACH_MEMORY_MODEL_RUNS,
  COACH_MEMORY_REFRESH_EXPIRE_SECONDS,
} from "@/lib/ai/coach/coach-memory-shared";
import {
  COMPLETION_CEILING_MS,
  COMPREHENSIVE_WARM_CEILING_MS,
} from "@/lib/jobs/model-time";
import { DOCUMENT_INDEX_EXPIRE_SECONDS } from "@/lib/jobs/document-index-queue";
import { DOCUMENT_SUMMARY_EXPIRE_SECONDS } from "@/lib/jobs/document-summary-queue";

/** pg-boss's default job expiry, in seconds. */
export const DEFAULT_JOB_EXPIRE_SECONDS = 15 * 60;

/** Where a check lives: a function (or const) in a file under `src/`. */
export type SourceSite = { file: string; fn: string };

export type QueueRuntime =
  | { runtime: "short"; why: string }
  | { runtime: "budgeted"; budget: SourceSite; why: string }
  | {
      runtime: "bounded";
      /**
       * The longest the job's model work runs at the largest response-timeout
       * setting, in seconds: the outer bounds in the code, not an estimate.
       */
      modelSeconds: number;
      expireInSeconds: number;
      /** As for `long`: identifiers that carry the expiry into a send. */
      expiryVia: readonly string[];
      why: string;
    }
  | {
      runtime: "long";
      expireInSeconds: number;
      /**
       * Identifiers that carry the expiry into a send or a schedule. A site
       * that names none of them must set `expireInSeconds` itself.
       */
      expiryVia: readonly string[];
      /** Where the handler stops on the job's budget, or `oneShot`. */
      stop: SourceSite | { oneShot: string };
      /**
       * What keeps a second run from working beside this one: the `lock`
       * its registry definition declares (`lockedPass`), or a marker in the
       * named function.
       */
      exclusive: "lockedPass" | { marker: string; at: SourceSite };
      why: string;
    };

const short = (why: string): QueueRuntime => ({ runtime: "short", why });

const cohortSync = (provider: string): QueueRuntime =>
  short(
    `${provider} sync: a recent window per connection (incremental since the last sync); a webhook job is one connection.`,
  );

const oauthStateCleanup = short("One DELETE of expired OAuth state rows.");

const forwarder = short(
  "Forwards each job to integration-backfill-admission; the import itself runs there.",
);

export const QUEUE_RUNTIME: Readonly<Record<string, QueueRuntime>> = {
  // ── Integration sync ───────────────────────────────────────────────
  "integration-backfill-admission": {
    runtime: "long",
    expireInSeconds: INTEGRATION_BACKFILL_EXPIRE_SECONDS,
    expiryVia: ["integrationBackfillAdmissionSendOptions"],
    stop: {
      file: "lib/jobs/integration-backfill-drain.ts",
      fn: "drainIntegrationBackfillAdmission",
    },
    exclusive: {
      marker: "withIntegrationBackfillLock",
      at: {
        file: "lib/jobs/integration-backfill-drain.ts",
        fn: "drainIntegrationBackfillAdmission",
      },
    },
    why: "Full-history provider imports: thousands of pages on a dense account.",
  },
  "withings-fallback-sync": cohortSync("Withings"),
  "withings-activity-sync": cohortSync("Withings activity"),
  "withings-sleep-sync": cohortSync("Withings sleep"),
  "withings-ecg-sync": cohortSync("Withings ECG"),
  "withings-oauth-state-cleanup": oauthStateCleanup,
  "whoop-recovery-sync": cohortSync("WHOOP recovery"),
  "whoop-sleep-sync": cohortSync("WHOOP sleep"),
  "whoop-workout-sync": cohortSync("WHOOP workout"),
  "whoop-cycle-sync": cohortSync("WHOOP cycle"),
  "whoop-backfill": forwarder,
  "whoop-oauth-state-cleanup": oauthStateCleanup,
  "oidc-native-handoff-cleanup": short("One DELETE of expired handoff rows."),
  "fitbit-sync": cohortSync("Fitbit"),
  "fitbit-backfill": forwarder,
  "fitbit-sleep-repair": forwarder,
  "fitbit-oauth-state-cleanup": oauthStateCleanup,
  "google-health-sync": cohortSync("Google Health"),
  "google-health-backfill": forwarder,
  "google-health-sleep-repair": forwarder,
  "google-health-oauth-state-cleanup": oauthStateCleanup,
  "sleep-timeline-backfill": forwarder,
  "lab-biomarker-backfill": forwarder,
  "nightscout-sync": cohortSync("Nightscout"),
  "polar-sync": cohortSync("Polar"),
  "oura-sync": cohortSync("Oura"),
  "strava-sync": cohortSync("Strava"),
  "strava-backfill": forwarder,
  "oura-backfill": forwarder,

  // ── Status and insights ────────────────────────────────────────────
  "insights-general-status": {
    runtime: "long",
    expireInSeconds: NIGHTLY_INSIGHT_PASS_EXPIRE_SECONDS,
    expiryVia: ["nightlyInsightPassOptions"],
    stop: {
      file: "lib/jobs/reminder/insights-handlers.ts",
      fn: "handleGeneralStatusGenerate",
    },
    exclusive: "lockedPass",
    why: "Nightly status batch: one provider call per candidate account, serially, over the whole instance.",
  },
  "insight-pregenerate": {
    runtime: "long",
    expireInSeconds: INSIGHT_PREGENERATE_EXPIRE_SECONDS,
    expiryVia: ["INSIGHT_PREGENERATE_EXPIRE_SECONDS"],
    stop: {
      file: "lib/jobs/reminder/insights-handlers.ts",
      fn: "handleInsightPregenerateJob",
    },
    exclusive: "lockedPass",
    why: "Up to 200 accounts, a comprehensive generation each (up to five provider calls in a row, each bounded by the account's timeout of at most ten minutes) plus the status warm.",
  },
  "morning-digest-refresh": {
    runtime: "bounded",
    modelSeconds: COMPREHENSIVE_WARM_CEILING_MS / 1000,
    expireInSeconds: MORNING_DIGEST_REFRESH_EXPIRE_SECONDS,
    expiryVia: ["MORNING_DIGEST_REFRESH_EXPIRE_SECONDS"],
    why: "One account, one forced comprehensive generation: up to five calls in a row at the account's timeout, behind the warm's own bound.",
  },
  "insight-status-generate": {
    runtime: "bounded",
    modelSeconds: COMPLETION_CEILING_MS / 1000,
    expireInSeconds: INSIGHT_STATUS_GENERATE_EXPIRE_SECONDS,
    expiryVia: ["INSIGHT_STATUS_GENERATE_EXPIRE_SECONDS"],
    why: "One account, one note: one status run, the call and its one reasoning repeat at the account's timeout.",
  },
  "data-arrival": short("One arrival's reactions."),
  "reaction-line-generate": short("One provider call for one reaction line."),
  "workout-insight-generate": {
    runtime: "bounded",
    modelSeconds: COMPLETION_CEILING_MS / 1000,
    expireInSeconds: WORKOUT_INSIGHT_GENERATE_EXPIRE_SECONDS,
    expiryVia: ["WORKOUT_INSIGHT_GENERATE_EXPIRE_SECONDS"],
    why: "One workout's line: one status run at the account's timeout.",
  },
  "recovery-score-compute": short(
    "Arithmetic over a recent window, capped at 500 accounts; no provider call.",
  ),
  "stress-score-compute": short(
    "Arithmetic over a recent window, capped at 500 accounts; no provider call.",
  ),
  "strain-score-compute": short(
    "Arithmetic over a recent window, capped at 500 accounts; no provider call.",
  ),
  "period-narrative-warm": {
    runtime: "long",
    expireInSeconds: PERIOD_NARRATIVE_EXPIRE_SECONDS,
    expiryVia: ["PERIOD_NARRATIVE_EXPIRE_SECONDS"],
    stop: {
      file: "lib/jobs/reminder/status-handlers.ts",
      fn: "handlePeriodNarrative",
    },
    exclusive: "lockedPass",
    why: "On a boundary night up to 200 accounts with a provider call per period each; a single-account warm is short.",
  },
  "coach-memory-refresh": {
    runtime: "bounded",
    modelSeconds: (COACH_MEMORY_MODEL_RUNS * COMPLETION_CEILING_MS) / 1000,
    expireInSeconds: COACH_MEMORY_REFRESH_EXPIRE_SECONDS,
    expiryVia: ["COACH_MEMORY_REFRESH_EXPIRE_SECONDS"],
    why: "One conversation's summary, facts and plan proposals: three status runs in a row at the account's timeout.",
  },
  "coach-nudge": short(
    "Light deterministic checks per account; the provider part is capped at 25 calls and 90 seconds a tick.",
  ),
  "coach-reminder-sweep": short("Batches of 200 to 500 rows, no provider."),
  "coach-plan-review": short("A batch of 100 plans, folded in SQL."),
  "medication-low-stock": short("A light inventory check per account."),
  "daily-briefing": short("A light cohort scan every fifteen minutes."),

  // ── Rollups ────────────────────────────────────────────────────────
  "rollup-recompute": short(
    "One type at one granularity over one bucket or a run of adjacent buckets, inside the five-year fold window.",
  ),
  "rollup-full-backfill": {
    runtime: "long",
    expireInSeconds: ROLLUP_FULL_BACKFILL_EXPIRE_SECONDS,
    expiryVia: ["ROLLUP_FULL_BACKFILL_EXPIRE_SECONDS"],
    stop: {
      file: "lib/jobs/reminder/rollup-handlers.ts",
      fn: "handleRollupFullBackfill",
    },
    exclusive: "lockedPass",
    why: "One account's five-year fold, a calendar year at a time with every statement under its own five-minute limit; the run stops at its budget between windows and hands the remaining years to a follow-up.",
  },
  "mood-rollup-recompute": short("One bucket."),
  "mood-rollup-full-backfill": short(
    "One account's mood entries, a few a day.",
  ),
  "step-consolidation": short(
    "One account's legacy step rows, one transaction per day.",
  ),
  "step-consolidation-repair": short(
    "One account's tombstoned step rows inside the retention window.",
  ),
  "supplement-nutrient-recompute": short(
    "One account's taken doses of medications with a composition: a few thousand rows for years of a daily supplement.",
  ),
  "cumulative-pr-rederive": short(
    "One account's record detection; measured at 20 seconds for 1.25 million rows.",
  ),
  "mean-consolidation": {
    runtime: "budgeted",
    budget: {
      file: "lib/jobs/reminder/rollup-handlers.ts",
      fn: "handleMeanConsolidation",
    },
    why: "One account's whole history, a day at a time; stops at three quarters of the default expiry and resumes.",
  },
  "dense-intraday-retention": {
    runtime: "budgeted",
    budget: {
      file: "lib/jobs/reminder/rollup-handlers.ts",
      fn: "handleDenseIntradayRetention",
    },
    why: "A dense account's history, a day at a time; stops at three quarters of the default expiry and resumes.",
  },
  "dense-intraday-hourly-rebuild": {
    runtime: "budgeted",
    budget: {
      file: "lib/jobs/reminder/rollup-handlers.ts",
      fn: "handleDenseIntradayHourlyRebuild",
    },
    why: "A dense account's hourly rows, a day at a time; stops at three quarters of the default expiry and resumes.",
  },
  "drain-per-sample-cumulative": {
    runtime: "budgeted",
    budget: {
      file: "lib/jobs/reminder/rollup-handlers.ts",
      fn: "drainCumulativeHandler",
    },
    why: "Every account's per-sample drains; stops at three quarters of the default expiry and hands the rest to a continuation job.",
  },

  // ── Reminders ──────────────────────────────────────────────────────
  "medication-reminder-check": short("The due slots of the current minute."),
  "mood-reminder-check": short("Accounts whose local reminder hour is now."),
  "cycle-reminder-check": short("Accounts whose local reminder hour is now."),
  "measurement-reminder-check": short(
    "Accounts whose local reminder hour is now.",
  ),
  "reminder-satisfy": short("One account's open reminders."),

  // ── Maintenance ────────────────────────────────────────────────────
  "data-backup": {
    runtime: "long",
    expireInSeconds: DATA_BACKUP_SEND_OPTIONS.expireInSeconds,
    expiryVia: ["DATA_BACKUP_SEND_OPTIONS"],
    stop: {
      file: "lib/jobs/reminder/backup-handlers.ts",
      fn: "handleDataBackup",
    },
    exclusive: "lockedPass",
    why: "Serialises every account's whole record.",
  },
  "database-backup": {
    runtime: "long",
    expireInSeconds: DATABASE_BACKUP_EXPIRE_SECONDS,
    expiryVia: ["DATABASE_BACKUP_SEND_OPTIONS"],
    stop: {
      file: "lib/jobs/reminder/backup-handlers.ts",
      fn: "handleDatabaseBackup",
    },
    exclusive: "lockedPass",
    why: "Runs pg_dump over the whole database and uploads the dump off-host.",
  },
  "data-backup-offhost": {
    runtime: "long",
    expireInSeconds: OFFHOST_BACKUP_EXPIRE_SECONDS,
    expiryVia: ["OFFHOST_BACKUP_SEND_OPTIONS"],
    stop: {
      file: "lib/jobs/reminder/backup-handlers.ts",
      fn: "handleOffhostBackup",
    },
    exclusive: "lockedPass",
    why: "Uploads every account's record off-host.",
  },
  "data-restore-drill": {
    runtime: "long",
    expireInSeconds: RESTORE_DRILL_EXPIRE_SECONDS,
    expiryVia: ["RESTORE_DRILL_SEND_OPTIONS"],
    stop: { file: "lib/jobs/restore-drill.ts", fn: "handleRestoreDrill" },
    exclusive: "lockedPass",
    why: "Fetches and stream-parses every account's newest off-host object.",
  },
  "offhost-backup-purge": short("At most 200 delete requests per run."),
  "account-deletion-purge": short(
    "At most 50 account erasures per run, plus one DELETE of expired pre-wipe copies.",
  ),
  "backup-restore": {
    runtime: "long",
    expireInSeconds: BACKUP_RESTORE_EXPIRE_SECONDS,
    expiryVia: ["BACKUP_RESTORE_SEND_OPTIONS", "BACKUP_RESTORE_EXPIRE_SECONDS"],
    stop: { file: "lib/jobs/backup-restore.ts", fn: "handleBackupRestore" },
    exclusive: {
      marker: "restore_claimed",
      at: { file: "lib/jobs/backup-restore.ts", fn: "runBackupRestoreJob" },
    },
    why: "Restores a whole account in one transaction.",
  },
  "host-metric-sample": short("One host sample."),
  "feedback-aggregator": short("One aggregate over the feedback table."),
  "geo-backfill": short("At most 500 audit rows per pass."),
  "geolite2-fetch": short("One database download."),
  "tls-pin-monitor": short("One TLS handshake."),
  "recovery-readiness": short(
    "A few indexed reads, one row per account from two backup ledgers, and at most one notice per signal.",
  ),
  "integration-watchdog-hourly": short(
    "A few indexed reads per account with a connection and no provider call; a 14-day history count only for a silent source.",
  ),
  "integration-watchdog-daily": short(
    "The hourly pass plus one 14-day history count per standing silence flag.",
  ),
  "mood-reminder-cleanup": short("One retention DELETE."),
  "push-attempt-cleanup": short("One retention DELETE."),
  "arrival-reaction-cleanup": short("One retention DELETE."),
  "rate-limit-cleanup": short("One retention DELETE."),
  "idempotency-cleanup": short("One retention DELETE."),
  "step-up-elevation-cleanup": short("One retention DELETE."),
  "coach-message-cleanup": short("One retention DELETE."),
  "workout-insight-claim-cleanup": short("One retention DELETE."),
  "mcp-token-cleanup": short("One retention DELETE."),
  "audit-log-cleanup": short("At most 40 batches of 5 000 rows per leg."),
  "measurement-tombstone-cleanup": short(
    "At most 40 batches of 5 000 rows per leg.",
  ),
  "document-tombstone-purge": short("One deleteMany."),
  "soft-delete-purge": short(
    "At most 40 batches of 5 000 rows per table, over a few small tables.",
  ),
  "auth-ledger-cleanup": short("At most 40 batches of 5 000 rows per table."),
  "document-summary-reaper": short("One updateMany."),
  "cycle-prediction-refresh": short(
    "Arithmetic per eligible account, no provider call.",
  ),
  "mood-prognosis-refresh": short(
    "Arithmetic per eligible account, no provider call.",
  ),
  "achievement-unlock-sweep": short(
    "A bounded achievement read per account, no provider call.",
  ),
  "pr-detection": {
    runtime: "long",
    expireInSeconds: PR_DETECTION_EXPIRE_SECONDS,
    expiryVia: ["PR_DETECTION_EXPIRE_SECONDS"],
    stop: {
      file: "lib/jobs/reminder/ops-handlers.ts",
      fn: "handlePrDetection",
    },
    exclusive: "lockedPass",
    why: "The fallback cron scans every account's all-time history every thirty minutes; an ingest job is one account.",
  },
  "medication-inventory-expire": short("One updateMany."),
  "intake-auto-skip": short("One updateMany."),
  "intake-auto-take": short(
    "At most seven days of slots per opted-in medication, a few rows each.",
  ),
  "apple-health-import-v2": {
    runtime: "long",
    expireInSeconds: APPLE_HEALTH_IMPORT_SEND_OPTIONS.expireInSeconds,
    expiryVia: ["APPLE_HEALTH_IMPORT_SEND_OPTIONS"],
    stop: {
      oneShot:
        "The run consumes and unlinks its staged upload, so it can neither stop half-way nor be retried; the send sets retryLimit 0.",
    },
    exclusive: {
      marker: "retryLimit: 0",
      at: {
        file: "lib/jobs/apple-health-import-worker.ts",
        fn: "APPLE_HEALTH_IMPORT_SEND_OPTIONS",
      },
    },
    why: "Parses an export that can be several gigabytes.",
  },
  "apple-health-import": short(
    "The legacy queue: moves each job onto apple-health-import-v2.",
  ),
  "apple-health-import-reconcile": short("One updateMany."),
  "health-connect-import": {
    runtime: "long",
    expireInSeconds: HEALTH_CONNECT_IMPORT_SEND_OPTIONS.expireInSeconds,
    expiryVia: ["HEALTH_CONNECT_IMPORT_SEND_OPTIONS"],
    stop: {
      oneShot:
        "The run consumes and unlinks its staged upload, so it can neither stop half-way nor be retried; the send sets retryLimit 0.",
    },
    exclusive: {
      marker: "retryLimit: 0",
      at: {
        file: "lib/jobs/health-connect-import-worker.ts",
        fn: "HEALTH_CONNECT_IMPORT_SEND_OPTIONS",
      },
    },
    why: "Reads a Health Connect export database that can hold years of minute-level samples.",
  },
  "compaction-tombstone-purge": short(
    "At most 40 batches of 5 000 rows per run; the predicate is idempotent, so the next run resumes.",
  ),
  "measurement-fold-repair": {
    runtime: "budgeted",
    budget: {
      file: "lib/jobs/measurement-fold-repair.ts",
      fn: "handleMeasurementFoldRepair",
    },
    why: "One account's folded means, a day at a time; stops at three quarters of the default expiry and sends a follow-up that resumes at the next day.",
  },
  "measurement-maintenance": {
    runtime: "long",
    expireInSeconds: MEASUREMENT_MAINTENANCE_SEND_OPTIONS.expireInSeconds,
    expiryVia: ["MEASUREMENT_MAINTENANCE_SEND_OPTIONS"],
    stop: {
      oneShot:
        "VACUUM and REINDEX CONCURRENTLY cannot be resumed mid-statement; the send and the nightly tick set retryLimit 0, and the next night or the operator runs it again.",
    },
    exclusive: {
      marker: "retryLimit: 0",
      at: {
        file: "lib/jobs/measurement-maintenance.ts",
        fn: "MEASUREMENT_MAINTENANCE_SEND_OPTIONS",
      },
    },
    why: "The operator's run rebuilds every index of the largest table, one at a time; the nightly check is one VACUUM at most.",
  },
  "pulse-day-mean": {
    runtime: "long",
    expireInSeconds: PULSE_DAY_MEAN_SEND_OPTIONS.expireInSeconds,
    expiryVia: ["PULSE_DAY_MEAN_SEND_OPTIONS"],
    stop: {
      oneShot:
        "A dry run or rebuild that stops part way is started again by the operator; the send sets retryLimit 0.",
    },
    exclusive: {
      marker: "retryLimit: 0",
      at: {
        file: "lib/jobs/pulse-day-mean.ts",
        fn: "PULSE_DAY_MEAN_SEND_OPTIONS",
      },
    },
    why: "Walks every account's pulse history a window at a time, twice over for a dry run.",
  },
  "medication-intake-import": {
    runtime: "long",
    expireInSeconds: MEDICATION_INTAKE_IMPORT_SEND_OPTIONS.expireInSeconds,
    expiryVia: ["MEDICATION_INTAKE_IMPORT_SEND_OPTIONS"],
    stop: {
      file: "lib/jobs/medication-intake-import.ts",
      fn: "handleMedicationIntakeImport",
    },
    exclusive: {
      marker: "FOR UPDATE",
      at: {
        file: "lib/jobs/medication-intake-import.ts",
        fn: "processNextChunk",
      },
    },
    why: "Imports a dose-history file chunk by chunk; its length follows the file.",
  },
  "intake-slot-dedup": short("One account's duplicate dose slots."),
  "note-encryption-backfill": short(
    "Pages of 200 rows of one account's plaintext notes, light per row.",
  ),
  "med-notes-encryption-backfill": short(
    "Pages of 200 rows of one account's plaintext notes, light per row.",
  ),
  "free-text-encryption-backfill": short(
    "Pages of 200 rows of one account's plaintext fields, light per row.",
  ),
  "encryption-key-rotate": {
    runtime: "long",
    expireInSeconds: ENCRYPTION_KEY_ROTATE_EXPIRE_SECONDS,
    expiryVia: ["ENCRYPTION_KEY_ROTATE_EXPIRE_SECONDS"],
    stop: {
      file: "lib/jobs/encryption-key-rotate.ts",
      fn: "handleEncryptionKeyRotate",
    },
    exclusive: "lockedPass",
    why: "Re-encrypts every encrypted column on the instance.",
  },
  "document-content-index-backfill": {
    runtime: "long",
    expireInSeconds: CONTENT_INDEX_BACKFILL_EXPIRE_SECONDS,
    expiryVia: ["CONTENT_INDEX_BACKFILL_EXPIRE_SECONDS"],
    stop: {
      file: "lib/jobs/reminder/document-handlers.ts",
      fn: "handleContentIndexBackfill",
    },
    exclusive: "lockedPass",
    why: "Up to 200 documents of one account, a provider transcription each.",
  },
  "document-index": {
    runtime: "long",
    expireInSeconds: DOCUMENT_INDEX_EXPIRE_SECONDS,
    expiryVia: ["DOCUMENT_INDEX_EXPIRE_SECONDS"],
    stop: {
      file: "lib/jobs/reminder/document-handlers.ts",
      fn: "handleDocumentIndex",
    },
    exclusive: "lockedPass",
    why: "One document: the transcription, then a lab report's staging reads, as many as fit before the job's deadline at the person's timeout.",
  },
  "document-ai-run": {
    runtime: "long",
    expireInSeconds: DOCUMENT_AI_RUN_EXPIRE_SECONDS,
    expiryVia: ["DOCUMENT_AI_RUN_EXPIRE_SECONDS"],
    stop: {
      file: "lib/jobs/document-ai-run.ts",
      fn: "handleDocumentAiRunJobs",
    },
    exclusive: "lockedPass",
    why: "One person's document or lab scan, up to three model calls at their AI response time (up to ten minutes each).",
  },
  "document-ai-run-reaper": short(
    "Up to 500 conditional updates and one deleteMany.",
  ),
  "document-thumbnail": short("One document."),
  "document-summary": {
    runtime: "bounded",
    modelSeconds: COMPLETION_CEILING_MS / 1000,
    expireInSeconds: DOCUMENT_SUMMARY_EXPIRE_SECONDS,
    expiryVia: ["DOCUMENT_SUMMARY_EXPIRE_SECONDS"],
    why: "One document's summary: one call and its reasoning repeat at the person's timeout.",
  },
  "document-summary-catchup": short("Enqueues at most 200 documents."),
  "document-thumbnail-backfill": short("Enqueues at most 1 000 documents."),
  "environment-fetch": short(
    "A fan-out of sends, or one account's bounded archive range.",
  ),
  "dawarich-sync": short(
    "A fan-out of sends, or one account's range: one timeline request per 30 days (at most 13), one visits request and at most two residency requests.",
  ),
  "environment-aq-history": short(
    "A fan-out of sends, or one account's history run: at most eight ranges of up to 90 days, two requests each, then a follow-up.",
  ),
};
