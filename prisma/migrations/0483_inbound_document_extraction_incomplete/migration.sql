-- Whether a document's staged facts may leave part of it out.
--
-- An extraction that read a long document in parts can end with a part cut
-- at the provider's output limit, a part never read, or more facts than one
-- review takes. That was told once, as a notice when the run finished; a
-- review opened later looked complete. The column keeps it on the document,
-- written with the facts every staging replaces.
--
-- Not null, default false: a document extracted before this release is read
-- as complete, which is what it has always been shown as.
-- Reversibility: dropping the column loses only the marker.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "inbound_documents"
        ADD COLUMN IF NOT EXISTS "extraction_incomplete" BOOLEAN NOT NULL DEFAULT false;
END
$migration$;
