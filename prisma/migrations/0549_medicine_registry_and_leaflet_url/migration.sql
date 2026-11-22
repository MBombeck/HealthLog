-- Official medication leaflets, step 1 (#1430): a link out to the national
-- registry's search, and a saved leaflet link per medication. Nothing here is
-- fetched by the server.
--
-- `users.medicine_registry`: which registry the "Find leaflet" link opens (an
-- ISO 3166 alpha-2 code, `EU`, or `NONE`). NULL means not settled yet; the
-- first account read derives it once and stores it, so there is nothing to
-- backfill here.
--
-- `medications.leaflet_url`: the leaflet link the person saved, NULL when
-- none.
--
-- Two nullable columns without a default: metadata-only, no rewrite. IF NOT
-- EXISTS keeps a replay harmless. Reversibility: drop both columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "medicine_registry" TEXT;

    ALTER TABLE "medications"
        ADD COLUMN IF NOT EXISTS "leaflet_url" TEXT;
END
$migration$;
