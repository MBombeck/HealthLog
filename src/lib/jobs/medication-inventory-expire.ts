/**
 * v1.4.25 W19b — pg-boss helper for the daily
 * `medication-inventory-expire` queue. The cron at 03:00 Europe/Berlin
 * (interleaved with the other 03:xx cleanup crons) sweeps every user
 * for IN_USE pens whose 30-day in-use window has lapsed and flips
 * their state to EXPIRED.
 *
 * The expire pass is idempotent — re-running it within the same day
 * only updates rows that the previous pass missed (because they hit
 * 30 days between the two runs). EXPIRED is a terminal-ish state in
 * the state machine; once flipped, a row stays EXPIRED until the
 * user explicitly deletes it or marks it USED_UP.
 *
 * Notification surface: opt-in only. The W19b scope deliberately
 * leaves the push notification disabled by default — Marc directive
 * "notifications saturate the lock screen on first sync" applies
 * here too. Users opt in via Settings → Notifications (a future
 * preference toggle); until then the job is silent and the user
 * sees the EXPIRED badge in the UI on next page-load.
 */

export const MEDICATION_INVENTORY_EXPIRE_QUEUE = "medication-inventory-expire";

/**
 * Cron schedule (Europe/Berlin) for the daily expire pass. 03:00
 * matches the idempotency-cleanup slot and lands inside the existing
 * 02:xx–03:xx maintenance window. Co-locating with the other cleanup
 * crons keeps the late-night CPU profile coherent.
 */
export const MEDICATION_INVENTORY_EXPIRE_CRON = "30 3 * * *";

export interface MedicationInventoryExpirePayload {
  triggeredAt: string;
}
