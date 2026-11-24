-- Apple Wallet passes of the emergency card (v1.50).
--
-- A pass carries a QR code like the printed card, but its own link: the link
-- table gets a purpose (CARD, the printed card; WALLET, a pass), and "at most
-- one live link per record" becomes "per record and purpose", so revoking one
-- never ends the other. A WALLET link keeps its raw token sealed under the
-- instance key (`token_encrypted`), because every pass update draws the QR
-- code again; a CHECK holds every other link to the HMAC-only rule.
--
-- `wallet_passes` holds one row per pass (no card content: the pass is built
-- again on every fetch), `wallet_pass_registrations` the devices that asked
-- Apple Wallet's web service for updates, each push token sealed.
--
-- One DO block, so the file is one statement that rolls back whole and the
-- foreign keys' lock waits on `users` are bounded. Every step is guarded, so
-- a replay after a lock timeout finishes what is missing. The new live index
-- is built before the old one is dropped, so no moment allows two live CARD
-- links. Reversibility: delete the WALLET links, drop the two tables and the
-- three types, put `emergency_card_links_live_user_key` back, drop the two
-- columns. An installed pass then answers 401 and stays as it was; its QR
-- link answers 404.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'emergency_card_link_purpose'
    ) THEN
        CREATE TYPE "emergency_card_link_purpose" AS ENUM ('CARD', 'WALLET');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_signer') THEN
        CREATE TYPE "wallet_signer" AS ENUM ('RELAY', 'LOCAL');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'wallet_pass_void_reason'
    ) THEN
        CREATE TYPE "wallet_pass_void_reason" AS ENUM (
            'OWNER', 'CREDENTIAL_RESET', 'HANDOVER', 'GUARDIAN_LOST',
            'ACCOUNT_DELETION'
        );
    END IF;

    ALTER TABLE "emergency_card_links"
        ADD COLUMN IF NOT EXISTS "purpose" "emergency_card_link_purpose"
            NOT NULL DEFAULT 'CARD';
    ALTER TABLE "emergency_card_links"
        ADD COLUMN IF NOT EXISTS "token_encrypted" TEXT;

    -- A sealed raw token exactly on WALLET links. Added valid in one step:
    -- the table holds at most a few links per record, every existing row is
    -- a CARD link without a token, and a NOT VALID plus VALIDATE in the same
    -- transaction would scan under the same lock anyway.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'emergency_card_links_wallet_token_check'
    ) THEN
        ALTER TABLE "emergency_card_links"
            ADD CONSTRAINT "emergency_card_links_wallet_token_check"
            CHECK (("purpose" = 'WALLET') = ("token_encrypted" IS NOT NULL));
    END IF;

    -- At most one live link per record and purpose. Revoked rows fall out.
    CREATE UNIQUE INDEX IF NOT EXISTS "emergency_card_links_live_user_purpose_key"
        ON "emergency_card_links" ("user_id", "purpose")
        WHERE "revoked_at" IS NULL;
    DROP INDEX IF EXISTS "emergency_card_links_live_user_key";

    CREATE TABLE IF NOT EXISTS "wallet_passes" (
        "id"                   TEXT NOT NULL,
        "user_id"              TEXT NOT NULL,
        "created_by_id"        TEXT NOT NULL,
        "link_id"              TEXT NOT NULL,
        "signer"               "wallet_signer" NOT NULL,
        "pass_type_identifier" TEXT NOT NULL,
        "team_identifier"      TEXT NOT NULL,
        "serial_number"        TEXT NOT NULL,
        "web_service_origin"   TEXT NOT NULL,
        "content_hash"         TEXT NOT NULL,
        "content_changed_at"   TIMESTAMP(3) NOT NULL,
        "consent_text_version" TEXT NOT NULL,
        "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "voided_at"            TIMESTAMP(3),
        "void_reason"          "wallet_pass_void_reason",
        "last_fetched_at"      TIMESTAMP(3),

        CONSTRAINT "wallet_passes_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "wallet_passes_link_id_key"
        ON "wallet_passes" ("link_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "wallet_passes_serial_number_key"
        ON "wallet_passes" ("serial_number");
    CREATE INDEX IF NOT EXISTS "wallet_passes_user_id_created_at_idx"
        ON "wallet_passes" ("user_id", "created_at" DESC);
    CREATE INDEX IF NOT EXISTS "wallet_passes_created_by_id_idx"
        ON "wallet_passes" ("created_by_id");

    CREATE TABLE IF NOT EXISTS "wallet_pass_registrations" (
        "id"                     TEXT NOT NULL,
        "wallet_pass_id"         TEXT NOT NULL,
        "device_library_id_hash" TEXT NOT NULL,
        "push_token_encrypted"   TEXT NOT NULL,
        "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at"             TIMESTAMP(3) NOT NULL,
        "last_push_at"           TIMESTAMP(3),

        CONSTRAINT "wallet_pass_registrations_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS
        "wallet_pass_registrations_wallet_pass_id_device_library_id__key"
        ON "wallet_pass_registrations" ("wallet_pass_id", "device_library_id_hash");
    CREATE INDEX IF NOT EXISTS
        "wallet_pass_registrations_device_library_id_hash_idx"
        ON "wallet_pass_registrations" ("device_library_id_hash");

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'wallet_passes_user_id_fkey'
    ) THEN
        ALTER TABLE "wallet_passes"
            ADD CONSTRAINT "wallet_passes_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'wallet_passes_created_by_id_fkey'
    ) THEN
        ALTER TABLE "wallet_passes"
            ADD CONSTRAINT "wallet_passes_created_by_id_fkey"
            FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'wallet_passes_link_id_fkey'
    ) THEN
        ALTER TABLE "wallet_passes"
            ADD CONSTRAINT "wallet_passes_link_id_fkey"
            FOREIGN KEY ("link_id") REFERENCES "emergency_card_links"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'wallet_pass_registrations_wallet_pass_id_fkey'
    ) THEN
        ALTER TABLE "wallet_pass_registrations"
            ADD CONSTRAINT "wallet_pass_registrations_wallet_pass_id_fkey"
            FOREIGN KEY ("wallet_pass_id") REFERENCES "wallet_passes"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
