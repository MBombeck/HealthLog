-- The identities of Health Records lab readings the person deleted, kept once
-- the reading's row is gone (#1400). A deleted reading remembers its identity
-- on its own tombstone; the nightly purge and deleting a whole marker remove
-- the row, and with it the only memory that the person deleted it, so the
-- next Apple Health export wrote the reading again. Those two now move the
-- identity here first. One row per (user, source, identity): the digest, no
-- lab content.
--
-- A new, empty table; nothing is rewritten. IF NOT EXISTS keeps a replay on a
-- database that already ran a build carrying it harmless. Reversibility:
-- dropping the table forgets the deletions it remembers; readings already
-- purged would be imported again on the next export.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    CREATE TABLE IF NOT EXISTS "lab_result_import_keys" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "source" TEXT NOT NULL,
        "external_id" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "lab_result_import_keys_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "lab_result_import_keys_user_id_fkey" FOREIGN KEY ("user_id")
            REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "lab_result_import_keys_user_id_source_external_id_key"
        ON "lab_result_import_keys" ("user_id", "source", "external_id");
END
$migration$;
