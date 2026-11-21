-- The push relay: sealed envelopes for every device that registered a push
-- key, and the relay that carries them to the App Store app for a server
-- without its own APNs key.
--
-- `devices` gains the device's push key and envelope suites, the relay
-- consent record, the signed relay binding and its state, and the newest
-- envelope ids the device reports it opened. `live_activity_tokens` gains the
-- device's signed Live Activity statement, which reaches the relay only with
-- the end push. Three new tables: the registration of this instance at the
-- relay (present while the operator offers it), the sender keys envelopes are
-- sealed with, and the per-device delivery ledger that doubles as the retry
-- outbox.
--
-- Every column is nullable or has a default, so the previous image keeps
-- working after a rollback; the new tables are not read by it. One DO block,
-- every statement guarded, so a replay after a lock timeout changes nothing.
-- Reversibility: drop the three tables and the added columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "devices"
        ADD COLUMN IF NOT EXISTS "push_key_public" TEXT,
        ADD COLUMN IF NOT EXISTS "push_key_suites" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
        ADD COLUMN IF NOT EXISTS "relay_consent_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "relay_consent_version" TEXT,
        ADD COLUMN IF NOT EXISTS "relay_binding_key" TEXT,
        ADD COLUMN IF NOT EXISTS "relay_binding_statement" JSONB,
        ADD COLUMN IF NOT EXISTS "relay_binding_signature" TEXT,
        ADD COLUMN IF NOT EXISTS "relay_state" TEXT NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS "relay_bound_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "envelope_opened_alert_id" TEXT,
        ADD COLUMN IF NOT EXISTS "envelope_opened_silent_id" TEXT,
        ADD COLUMN IF NOT EXISTS "envelope_reported_at" TIMESTAMP(3);

    ALTER TABLE "live_activity_tokens"
        ADD COLUMN IF NOT EXISTS "activity_statement" JSONB,
        ADD COLUMN IF NOT EXISTS "activity_signature" TEXT;

    CREATE TABLE IF NOT EXISTS "push_relay_registrations" (
        "id" TEXT NOT NULL,
        "relay_host" TEXT NOT NULL,
        "instance_id" TEXT,
        "instance_key_encrypted" TEXT NOT NULL,
        "tier" TEXT,
        "state" TEXT NOT NULL DEFAULT 'pending',
        "state_reason" TEXT,
        "state_since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "circuit_failures" INTEGER NOT NULL DEFAULT 0,
        "circuit_opened_at" TIMESTAMP(3),
        "next_probe_at" TIMESTAMP(3),
        "paused_until" TIMESTAMP(3),
        "clock_offset_seconds" INTEGER NOT NULL DEFAULT 0,
        "notice_id" TEXT,
        "notice_level" TEXT,
        "unregistered_since" TIMESTAMP(3),
        "unregistered_count" INTEGER NOT NULL DEFAULT 0,
        "deletion_hold_until" TIMESTAMP(3),
        "receipts_sent_at" TIMESTAMP(3),
        "last_success_at" TIMESTAMP(3),
        "terms_version" TEXT NOT NULL,
        "household_confirmed_at" TIMESTAMP(3) NOT NULL,
        "enabled_by_user_id" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "push_relay_registrations_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "push_relay_registrations_relay_host_key"
        ON "push_relay_registrations" ("relay_host");

    CREATE TABLE IF NOT EXISTS "push_envelope_keys" (
        "id" TEXT NOT NULL DEFAULT 'singleton',
        "sender_key_encrypted" TEXT NOT NULL,
        "sender_public_key" TEXT NOT NULL,
        "sender_created_at" TIMESTAMP(3) NOT NULL,
        "previous_sender_public_key" TEXT,
        "previous_retired_at" TIMESTAMP(3),
        "collapse_secret_encrypted" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "push_envelope_keys_pkey" PRIMARY KEY ("id")
    );

    CREATE TABLE IF NOT EXISTS "push_relay_deliveries" (
        "id" TEXT NOT NULL,
        "device_id" TEXT NOT NULL,
        "ref" TEXT NOT NULL,
        "push_class" TEXT NOT NULL,
        "event_type" TEXT NOT NULL,
        "item" JSONB,
        "expires_at" TIMESTAMP(3) NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "reason" TEXT,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP(3),
        "accepted_at" TIMESTAMP(3),
        "confirmed_at" TIMESTAMP(3),
        "receipt_reported_at" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "push_relay_deliveries_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "push_relay_deliveries_device_id_fkey" FOREIGN KEY ("device_id")
            REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "push_relay_deliveries_device_id_ref_key"
        ON "push_relay_deliveries" ("device_id", "ref");
    CREATE INDEX IF NOT EXISTS "push_relay_deliveries_status_next_attempt_at_idx"
        ON "push_relay_deliveries" ("status", "next_attempt_at");
    CREATE INDEX IF NOT EXISTS "push_relay_deliveries_device_id_push_class_created_at_idx"
        ON "push_relay_deliveries" ("device_id", "push_class", "created_at");
END
$migration$;
