-- Per-token Apple Health write-back (#1272).
--
-- `api_tokens.mirror_to_apple_health` is the person's choice for a
-- `measurements:write` token; `mirror_changed_at` is when it last changed and
-- keys the `measurementMirror` domain of `/api/sync/changes`. Rows written by
-- such a token keep their honest `EXTERNAL` source and point at the token
-- through `measurements.ingest_token_id`; the server resolves the row's
-- `appleHealthMirror` from the token when it answers it.
--
-- Each step is a `DO` block with a bounded lock wait, and each is safe to run
-- again, so the file is marked for the boot's lock-timeout retry:
--
--   1. the columns, and the foreign key added NOT VALID (no scan under the
--      table lock);
--   2. the backfill: an existing EXTERNAL row is linked only where the
--      account has exactly one measurement token (revoked ones counted) and
--      the row is no older than that token, because only then is the token
--      provably the one that carried it. Every other existing row stays
--      unlinked and is not mirrored. The statement sets nothing but
--      `ingest_token_id`, so `updated_at` and `sync_version` are untouched;
--   3. the foreign key validated, which scans without blocking writes.
--
-- The index the key and the feed walk use is built CONCURRENTLY in 0477, on
-- its own, because a concurrent build cannot share a file.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "api_tokens"
        ADD COLUMN IF NOT EXISTS "mirror_to_apple_health" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "mirror_changed_at" TIMESTAMP(3);
    ALTER TABLE "measurements"
        ADD COLUMN IF NOT EXISTS "ingest_token_id" TEXT;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'measurements_ingest_token_id_fkey'
    ) THEN
        ALTER TABLE "measurements"
            ADD CONSTRAINT "measurements_ingest_token_id_fkey"
            FOREIGN KEY ("ingest_token_id") REFERENCES "api_tokens"("id")
            ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
    END IF;
END
$migration$;

DO $migration$
DECLARE
    linked bigint;
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    WITH sole_token AS (
        SELECT t."user_id",
               (array_agg(t."id"))[1]         AS token_id,
               (array_agg(t."created_at"))[1] AS created_at
        FROM "api_tokens" t
        WHERE t."permissions" = ARRAY['measurements:write']::text[]
        GROUP BY t."user_id"
        HAVING count(*) = 1
    )
    UPDATE "measurements" m
    SET "ingest_token_id" = s.token_id
    FROM sole_token s
    WHERE m."user_id" = s."user_id"
      AND m."source" = 'EXTERNAL'
      AND m."ingest_token_id" IS NULL
      AND m."created_at" >= s.created_at;
    GET DIAGNOSTICS linked = ROW_COUNT;
    RAISE NOTICE '0476: linked % EXTERNAL readings to their sole measurement token', linked;
END
$migration$;

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "measurements"
        VALIDATE CONSTRAINT "measurements_ingest_token_id_fkey";
END
$migration$;
