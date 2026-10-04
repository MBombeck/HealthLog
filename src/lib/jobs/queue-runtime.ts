/**
 * How long one job of each queue can run, and what keeps a long one safe.
 *
 * pg-boss gives every job an expiry, fifteen minutes unless the send says
 * otherwise. Past it pg-boss fails the job, fires its abort signal and retries
 * it, and it does not stop the handler, so a job that legitimately needs longer
 * ends up running twice beside itself. No queue policy prevents that: the
 * policies constrain job rows, and an expired row is no longer active. Every
 * queue bound with `createAndWork` is therefore declared here as one of:
 *
 *   - `short`: a job cannot come near fifteen minutes (one account's bounded
 *     window, one document, a forwarder, a bounded delete). It relies on the
 *     default expiry, and the reason says why that is enough.
 *   - `budgeted`: a pass over a long history that stops itself at three
 *     quarters of the default expiry (`jobBudget`) and hands the rest to its
 *     next run, so it ends before fifteen minutes by construction.
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
import { PERIOD_NARRATIVE_EXPIRE_SECONDS } from "@/lib/jobs/period-narrative-shared";
import { PR_DETECTION_EXPIRE_SECONDS } from "@/lib/jobs/pr-detection";
import { ENCRYPTION_KEY_ROTATE_EXPIRE_SECONDS } from "@/lib/jobs/encryption-key-rotate";
import { CONTENT_INDEX_BACKFILL_EXPIRE_SECONDS } from "@/lib/jobs/document-content-index-backfill";
import { DOCUMENT_AI_RUN_EXPIRE_SECONDS } from "@/lib/jobs/document-ai-run";
import { DATA_BACKUP_SEND_OPTIONS } from "@/lib/jobs/data-backup-policy";
import { OFFHOST_BACKUP_EXPIRE_SECONDS } from "@/lib/jobs/offhost-backup";
import { BACKUP_RESTORE_EXPIRE_SECONDS } from "@/lib/jobs/backup-restore";
import { APPLE_HEALTH_IMPORT_SEND_OPTIONS } from "@/lib/jobs/apple-health-import-worker";
import { MEDICATION_INTAKE_IMPORT_SEND_OPTIONS } from "@/lib/jobs/medication-intake-import";

/** pg-boss's default job expiry, in seconds. */
export const DEFAULT_JOB_EXPIRE_SECONDS = 15 * 60;

/** Where a check lives: `binding` is the `createAndWork` call itself. */
export type SourceSite = "binding" | { file: string; fn: string };

export type QueueRuntime =
  | { runtime: "short"; why: string }
  | { runtime: "budgeted"; budget: SourceSite; why: string }
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
       * What keeps a second run from working beside this one: `lockedPass`
       * at the binding, or a marker in the named function.
       */
      exclusive: "lockedPass" | { marker: string; at: SourceSite };
      why: string;
    };

const short = (why: string): QueueRuntime => ({ runtime: "short", why });

const nightlyStatusPass = (fn: string): QueueRuntime => ({
  runtime: "long",
  expireInSeconds: NIGHTLY_INSIGHT_PASS_EXPIRE_SECONDS,
  expiryVia: ["nightlyInsightPassOptions"],
  stop: { file: "lib/jobs/reminder/insights-handlers.ts", fn },
  exclusive: "lockedPass",
  why: "Nightly status pass: one provider call per candidate account, serially, over the whole instance.",
});

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

  // ── Status and insights ────────────────────────────────────────────
  "insights-general-status": nightlyStatusPass("handleGeneralStatusGenerate"),
  "insights-blood-pressure-status": nightlyStatusPass(
    "handleBloodPressureStatusGenerate",
  ),
  "insights-weight-status": nightlyStatusPass("handleWeightStatusGenerate"),
  "insights-pulse-status": nightlyStatusPass("handlePulseStatusGenerate"),
  "insights-bmi-status": nightlyStatusPass("handleBmiStatusGenerate"),
  "insights-mood-status": nightlyStatusPass("handleMoodStatusGenerate"),
  "insights-medication-compliance-status": nightlyStatusPass(
    "handleMedicationComplianceStatusGenerate",
  ),
  "insight-pregenerate": {
    runtime: "long",
    expireInSeconds: INSIGHT_PREGENERATE_EXPIRE_SECONDS,
    expiryVia: ["INSIGHT_PREGENERATE_EXPIRE_SECONDS"],
    stop: {
      file: "lib/jobs/reminder/insights-handlers.ts",
      fn: "handleInsightPregenerateJob",
    },
    exclusive: "lockedPass",
    why: "Up to 200 accounts, a comprehensive generation each (a provider call bounded by the account's timeout, up to ten minutes) plus the status warm.",
  },
  "morning-digest-refresh": short(
    "One account, one comprehensive generation, bounded by the provider timeout.",
  ),
  "insight-status-generate": short(
    "One account, one metric, one provider call.",
  ),
  "data-arrival": short("One arrival's reactions."),
  "reaction-line-generate": short("One provider call for one reaction line."),
  "workout-insight-generate": short("One workout's insight."),
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
    stop: "binding",
    exclusive: "lockedPass",
    why: "On a boundary night up to 200 accounts with a provider call per period each; a single-account warm is short.",
  },
  "coach-memory-refresh": short("One conversation's summary and facts."),
  "coach-nudge": short(
    "Light deterministic checks per account; the provider part is capped at 25 calls and 90 seconds a tick.",
  ),
  "coach-reminder-sweep": short("Batches of 200 to 500 rows, no provider."),
  "coach-plan-review": short("A batch of 100 plans, folded in SQL."),
  "medication-low-stock": short("A light inventory check per account."),
  "daily-briefing": short("A light cohort scan every fifteen minutes."),

  // ── Rollups ────────────────────────────────────────────────────────
  "rollup-recompute": short("One bucket."),
  "rollup-full-backfill": short(
    "One account's rollup tiers: four aggregate statements, each held to the 60-second statement timeout.",
  ),
  "mood-rollup-recompute": short("One bucket."),
  "mood-rollup-full-backfill": short(
    "One account's mood entries, a few a day.",
  ),
  "medication-compliance-full-backfill": short(
    "One account's 90-day compliance window.",
  ),
  "step-consolidation": short(
    "One account's legacy step rows, one transaction per day.",
  ),
  "step-consolidation-repair": short(
    "One account's tombstoned step rows inside the retention window.",
  ),
  "cumulative-pr-rederive": short(
    "One account's record detection; measured at 20 seconds for 1.25 million rows.",
  ),
  "mean-consolidation": {
    runtime: "budgeted",
    budget: "binding",
    why: "One account's whole history, a day at a time; stops at three quarters of the default expiry and resumes.",
  },
  "dense-intraday-retention": {
    runtime: "budgeted",
    budget: "binding",
    why: "A dense account's history, a day at a time; stops at three quarters of the default expiry and resumes.",
  },
  "dense-intraday-hourly-rebuild": {
    runtime: "budgeted",
    budget: "binding",
    why: "A dense account's hourly rows, a day at a time; stops at three quarters of the default expiry and resumes.",
  },
  "drain-per-sample-cumulative": {
    runtime: "budgeted",
    budget: "binding",
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
  "data-restore-drill": short("Fetches and stream-parses one off-host object."),
  "offhost-backup-purge": short("At most 200 delete requests per run."),
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
    stop: "binding",
    exclusive: "lockedPass",
    why: "Up to 200 documents of one account, a provider transcription each.",
  },
  "document-index": short("One document."),
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
  "document-summary": short("One document."),
  "document-summary-catchup": short("Enqueues at most 200 documents."),
  "document-thumbnail-backfill": short("Enqueues at most 1 000 documents."),
  "environment-fetch": short(
    "A fan-out of sends, or one account's bounded archive range.",
  ),
};
