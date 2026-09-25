/**
 * Primary audience for a terminal queue failure. `account` queues already
 * have an affected-account status surface; `system` queues use the admin
 * failing-jobs card. An intentional `none` must point to an executable test or
 * tracked issue so a prose-only exemption cannot hide a new queue.
 */
export type SubsystemSurface =
  | { audience: "account"; reason?: never }
  | { audience: "system"; reason?: never }
  | {
      audience: "none";
      reason:
        | `#${number}`
        | `${string}.test.ts${string}`
        | `${string}.test.tsx${string}`;
    };

const subsystemSurface = {
  // register-integration-sync.ts
  "withings-fallback-sync": { audience: "account" },
  "withings-activity-sync": { audience: "account" },
  "withings-sleep-sync": { audience: "account" },
  "withings-ecg-sync": { audience: "account" },
  "withings-oauth-state-cleanup": { audience: "system" },
  "whoop-recovery-sync": { audience: "account" },
  "whoop-sleep-sync": { audience: "account" },
  "whoop-workout-sync": { audience: "account" },
  "whoop-cycle-sync": { audience: "account" },
  "whoop-backfill": { audience: "system" },
  "whoop-oauth-state-cleanup": { audience: "system" },
  "fitbit-sync": { audience: "account" },
  "fitbit-backfill": { audience: "system" },
  "fitbit-sleep-repair": { audience: "system" },
  "fitbit-oauth-state-cleanup": { audience: "system" },
  "google-health-sync": { audience: "account" },
  "google-health-backfill": { audience: "system" },
  "google-health-sleep-repair": { audience: "system" },
  "google-health-oauth-state-cleanup": { audience: "system" },
  "sleep-timeline-backfill": { audience: "system" },
  "lab-biomarker-backfill": { audience: "system" },
  "integration-backfill-admission": { audience: "system" },
  "nightscout-sync": { audience: "account" },
  "polar-sync": { audience: "account" },
  "oura-sync": { audience: "account" },
  "strava-sync": { audience: "account" },
  "strava-backfill": { audience: "system" },
  "oidc-native-handoff-cleanup": { audience: "system" },

  // register-status.ts
  "insights-general-status": { audience: "system" },
  "insights-blood-pressure-status": { audience: "system" },
  "insights-weight-status": { audience: "system" },
  "insights-pulse-status": { audience: "system" },
  "insights-bmi-status": { audience: "system" },
  "insights-mood-status": { audience: "system" },
  "insights-medication-compliance-status": { audience: "system" },
  "insight-pregenerate": { audience: "system" },
  "insight-status-generate": { audience: "system" },
  "morning-digest-refresh": { audience: "system" },
  "data-arrival": { audience: "system" },
  "reaction-line-generate": { audience: "system" },
  "workout-insight-generate": { audience: "system" },
  "recovery-score-compute": { audience: "system" },
  "stress-score-compute": { audience: "system" },
  "strain-score-compute": { audience: "system" },
  "period-narrative-warm": { audience: "system" },
  "coach-memory-refresh": { audience: "system" },
  "coach-nudge": { audience: "system" },
  "coach-reminder-sweep": { audience: "system" },
  "coach-plan-review": { audience: "system" },
  "medication-low-stock": { audience: "system" },
  "daily-briefing": { audience: "system" },

  // register-rollup.ts
  "rollup-recompute": { audience: "system" },
  "rollup-full-backfill": { audience: "system" },
  "mood-rollup-recompute": { audience: "system" },
  "mood-rollup-full-backfill": { audience: "system" },
  "medication-compliance-full-backfill": { audience: "system" },
  "step-consolidation": { audience: "system" },
  "step-consolidation-repair": { audience: "system" },
  "cumulative-pr-rederive": { audience: "system" },
  "mean-consolidation": { audience: "system" },
  "dense-intraday-retention": { audience: "system" },
  "dense-intraday-hourly-rebuild": { audience: "system" },
  "drain-per-sample-cumulative": { audience: "system" },

  // register-reminders.ts
  "medication-reminder-check": { audience: "system" },
  "mood-reminder-check": { audience: "system" },
  "cycle-reminder-check": { audience: "system" },
  "measurement-reminder-check": { audience: "system" },
  "reminder-satisfy": { audience: "system" },

  // register-maintenance.ts
  "environment-fetch": { audience: "account" },
  "data-backup": { audience: "system" },
  "rate-limit-cleanup": { audience: "system" },
  "idempotency-cleanup": { audience: "system" },
  "audit-log-cleanup": { audience: "system" },
  "step-up-elevation-cleanup": { audience: "system" },
  "data-backup-offhost": { audience: "system" },
  "data-restore-drill": { audience: "system" },
  "backup-restore": { audience: "system" },
  "host-metric-sample": { audience: "system" },
  "feedback-aggregator": { audience: "system" },
  "geo-backfill": { audience: "system" },
  "geolite2-fetch": { audience: "system" },
  "tls-pin-monitor": { audience: "system" },
  "pr-detection": { audience: "system" },
  "medication-inventory-expire": { audience: "system" },
  "intake-auto-skip": { audience: "system" },
  "apple-health-import-v2": { audience: "account" },
  "apple-health-import": { audience: "account" },
  "apple-health-import-reconcile": { audience: "account" },
  "medication-intake-import": { audience: "system" },
  "intake-slot-dedup": { audience: "system" },
  "mood-reminder-cleanup": { audience: "system" },
  "push-attempt-cleanup": { audience: "system" },
  "arrival-reaction-cleanup": { audience: "system" },
  "cycle-prediction-refresh": { audience: "system" },
  "mood-prognosis-refresh": { audience: "system" },
  "achievement-unlock-sweep": { audience: "system" },
  "measurement-tombstone-cleanup": { audience: "system" },
  "coach-message-cleanup": { audience: "system" },
  "note-encryption-backfill": { audience: "system" },
  "encryption-key-rotate": { audience: "system" },
  "mcp-token-cleanup": { audience: "system" },
  "med-notes-encryption-backfill": { audience: "system" },
  "document-tombstone-purge": { audience: "system" },
  // v1.37.19 (A7-4) — hourly heal of summary rows stuck on PENDING.
  "document-summary-reaper": { audience: "system" },
  "document-content-index-backfill": { audience: "account" },
  "document-index": { audience: "account" },
  "document-thumbnail": { audience: "account" },
  "document-thumbnail-backfill": { audience: "account" },
  "document-summary": { audience: "account" },
  "document-summary-catchup": { audience: "account" },
} as const satisfies Record<string, SubsystemSurface>;

/** The queue-name union follows the registrar-guarded registry, never a count. */
export type QueueName = keyof typeof subsystemSurface;

export const SUBSYSTEM_SURFACE: Record<QueueName, SubsystemSurface> =
  subsystemSurface;
