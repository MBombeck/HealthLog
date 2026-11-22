-- What the relay really said, kept where the server reads it (1.49).
--
-- `devices.la_start_ref`: the outbox ref of the device's last Live Activity
-- start. The dose it was for (`la_started_*`) is held while the start is in
-- flight, so the next pass does not start it twice; `la_started_at` is set
-- only once the relay accepted it, and a start that failed for good clears
-- the dose again, so it is retried.
--
-- `devices.relay_conflict_at`: when the relay answered the device's binding
-- with `409 binding_conflict`. A conflict the app has not settled after
-- 30 minutes turns into `rebind_needed`. A device in conflict now is stamped
-- with the time of this migration, so it gets the full 30 minutes.
--
-- `push_relay_registrations.bad_signature_count`: consecutive answers in
-- which the relay refused this server's signature; three make the relay state
-- `degraded` with the reason `bad_signature`.
--
-- `push_relay_registrations.status_checked_at` and `relay_status`: the hourly
-- signed `GET /v1/status`, when it was last asked and what the relay last
-- answered (its state, registration mode, device counts, key rotation day).
--
-- Nullable columns and one with a constant default: no rewrite. IF NOT
-- EXISTS and the NULL guard keep a replay harmless. Reversibility: drop the
-- five columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "devices"
        ADD COLUMN IF NOT EXISTS "la_start_ref" TEXT,
        ADD COLUMN IF NOT EXISTS "relay_conflict_at" TIMESTAMP(3);

    ALTER TABLE "push_relay_registrations"
        ADD COLUMN IF NOT EXISTS "bad_signature_count" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "status_checked_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "relay_status" JSONB;

    UPDATE "devices"
        SET "relay_conflict_at" = (now() AT TIME ZONE 'UTC')
        WHERE "relay_state" = 'conflict'
          AND "relay_conflict_at" IS NULL;
END
$migration$;
