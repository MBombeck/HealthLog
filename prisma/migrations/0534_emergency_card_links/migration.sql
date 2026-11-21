-- The emergency card's QR link: one table holding the read-only link a
-- record's owner hands out on a wallet card, and the enum of the items a link
-- may show.
--
-- Built like `care_calendar_feeds` (migration 0522). Only the HMAC of the raw
-- `hlm_` token is stored; the view is computed on every access and never
-- persisted. Revocation stamps `revoked_at` and never deletes, so "at most one
-- live link per record" is a partial index, which Prisma cannot express.
--
-- The foreign key cascades: deleting the record ends its link.
--
-- One DO block, so the file is one statement that rolls back whole and the
-- foreign key's lock wait on `users` is bounded. Every step is guarded, so a
-- replay after a lock timeout finishes what is missing. Only the new table and
-- the new type are created. Reversibility: drop the table and the type; a
-- scanned card answers 404 and the owner makes a new link.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'emergency_card_field'
    ) THEN
        CREATE TYPE "emergency_card_field" AS ENUM (
            'BLOOD_TYPE', 'ALLERGIES', 'CONDITIONS', 'MEDICATIONS', 'CONTACTS',
            'IMPLANTS', 'ADVANCE_DIRECTIVE', 'ORGAN_DONOR', 'NOTE',
            'DATE_OF_BIRTH', 'PREGNANCY'
        );
    END IF;

    CREATE TABLE IF NOT EXISTS "emergency_card_links" (
        "id"             TEXT NOT NULL,
        "user_id"        TEXT NOT NULL,
        "token_hash"     TEXT NOT NULL,
        "token_prefix"   TEXT NOT NULL,
        "fields"         "emergency_card_field"[] NOT NULL,
        "expires_at"     TIMESTAMP(3),
        "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "revoked_at"     TIMESTAMP(3),
        "last_access_at" TIMESTAMP(3),
        "access_count"   INTEGER NOT NULL DEFAULT 0,

        CONSTRAINT "emergency_card_links_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "emergency_card_links_token_hash_key"
        ON "emergency_card_links" ("token_hash");

    CREATE INDEX IF NOT EXISTS "emergency_card_links_user_id_created_at_idx"
        ON "emergency_card_links" ("user_id", "created_at" DESC);

    -- At most one live link per record. Revoked rows fall out of the index.
    CREATE UNIQUE INDEX IF NOT EXISTS "emergency_card_links_live_user_key"
        ON "emergency_card_links" ("user_id")
        WHERE "revoked_at" IS NULL;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'emergency_card_links_user_id_fkey'
    ) THEN
        ALTER TABLE "emergency_card_links"
            ADD CONSTRAINT "emergency_card_links_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
