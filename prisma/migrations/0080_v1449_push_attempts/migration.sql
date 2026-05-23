-- v1.4.49 — per-attempt push-delivery ledger.
--
-- The /api/admin/notifications/diagnostic endpoint shipped in
-- v1.4.48 carries a `recentPushAttempts` shape but returned an empty
-- array because no persistent table backed the field. This migration
-- adds the table; the matching app-side changes wire fire-and-forget
-- writes from every sender (APNS, web-push, Telegram, NTFY) and swap
-- the diagnostic stub for a real query.
--
-- Schema design:
--   * `id` — cuid surrogate key. There is no natural deduplication
--     key — the same (user, channel, event-type) tuple can fire
--     multiple times legitimately (e.g. two MEDICATION_REMINDERs in
--     a day on different schedules).
--   * `channel`     — dispatcher `ChannelType` string ("APNS" |
--                     "WEB_PUSH" | "TELEGRAM" | "NTFY").
--   * `event_type`  — dispatcher payload `eventType` string. Stored
--                     as plain text so future event-type additions
--                     never require a follow-up migration.
--   * `result`      — "ok" | "error" | "skipped". `skipped` covers
--                     the soft "no recipient" / "config missing"
--                     cases the sender contracts surface today.
--   * `reason`      — sender-side reason on error/skip results,
--                     null on `ok`. For APNS this is Apple's reason
--                     code (`BadDeviceToken`, `Unregistered`, …).
--   * `created_at`  — DEFAULT now(); the diagnostic endpoint orders
--                     by this column DESC + maps to the response
--                     shape's `at` ISO string.
--
-- Index strategy: `(user_id, created_at DESC)` matches the only
-- documented read path — the diagnostic endpoint pulls the trailing
-- 20 rows per user ordered by recency. The PRIMARY KEY on `id` is
-- never queried by the application; it's there to give the row a
-- stable identity for the retention sweep's WHERE clause.
--
-- Retention: a daily pg-boss schedule (`push-attempt-cleanup` queue,
-- cron `35 3 * * *` Europe/Berlin) deletes rows older than 90 days.
-- The cutoff lines up with the mood-reminder dispatch ledger window
-- (v1.4.38.2) — both surfaces are behavioural footprints we keep
-- long enough to debug a duplicate-push report (~one billing cycle)
-- but no longer. See `handlePushAttemptCleanup` in
-- `src/lib/jobs/reminder-worker.ts`.
--
-- Idempotent guards (`IF NOT EXISTS` on the table + index, plus the
-- `DO $$ … duplicate_object` block on the FK) match the pattern used
-- by 0070 / 0071 / 0072 / 0074 / 0078 so reruns are safe in
-- environments where the migration has already been applied.
--
-- Reversibility: down migration is `DROP TABLE IF EXISTS
-- "push_attempts" CASCADE;`. The data is purely diagnostic — no
-- reader outside the admin endpoint queries it — so a roll-back
-- only loses observability, never user-visible state.

CREATE TABLE IF NOT EXISTS "push_attempts" (
    "id"         TEXT          NOT NULL,
    "user_id"    TEXT          NOT NULL,
    "channel"    TEXT          NOT NULL,
    "event_type" TEXT          NOT NULL,
    "result"     TEXT          NOT NULL,
    "reason"     TEXT,
    "created_at" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "push_attempts_user_id_created_at_desc_idx"
    ON "push_attempts" ("user_id", "created_at" DESC);

DO $$ BEGIN
    ALTER TABLE "push_attempts"
        ADD CONSTRAINT "push_attempts_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
