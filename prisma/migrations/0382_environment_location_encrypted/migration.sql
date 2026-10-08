-- Environment locations sealed at rest (#615).
--
-- The home location, each dated location period and the per-day resolved
-- location gain a sealed copy (lat, lon, label under AAD
-- `healthlog/environment-location/v1`). The free-text encryption backfill
-- fills it from the plaintext and then clears the plaintext; the plaintext
-- columns therefore become nullable here and drop in a later release, once
-- the backfill reports zero remaining rows everywhere.
--
-- The partial indexes serve the backfill's discovery ("rows still holding
-- plaintext") and empty themselves as it runs.
ALTER TABLE "users" ADD COLUMN "home_location_encrypted" BYTEA;

ALTER TABLE "environment_travel_locations"
    ADD COLUMN "location_encrypted" BYTEA,
    ALTER COLUMN "lat" DROP NOT NULL,
    ALTER COLUMN "lon" DROP NOT NULL,
    ALTER COLUMN "label" DROP NOT NULL;

ALTER TABLE "environment_contexts"
    ADD COLUMN "location_encrypted" BYTEA,
    ALTER COLUMN "lat" DROP NOT NULL,
    ALTER COLUMN "lon" DROP NOT NULL,
    ALTER COLUMN "location_label" DROP NOT NULL;

CREATE INDEX "users_home_location_plain_idx"
    ON "users"("id")
    WHERE "home_lat" IS NOT NULL;

CREATE INDEX "environment_travel_locations_plain_location_idx"
    ON "environment_travel_locations"("id")
    WHERE "lat" IS NOT NULL;

CREATE INDEX "environment_contexts_plain_location_idx"
    ON "environment_contexts"("id")
    WHERE "lat" IS NOT NULL;
