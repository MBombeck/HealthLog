-- Air quality, pollen and UV per environment day (#615).
--
-- Twenty-two nullable columns filled from the Open-Meteo air-quality feed
-- (CAMS Europe / global). Nullable throughout: a partial feed stores what it
-- has, and a day the feed never covered stays NULL rather than zero.
-- `aq_fetched_at` NULL marks a day whose air-quality part has not been
-- fetched yet; the partial gap index serves the nightly fill's lookup.
--
-- `users.environment_air_quality_enabled` is the per-user switch, on by
-- default; the operator switch `ENVIRONMENT_AIR_QUALITY_DISABLED` wins.
ALTER TABLE "environment_contexts"
    ADD COLUMN "apparent_max" DOUBLE PRECISION,
    ADD COLUMN "pm25_mean" DOUBLE PRECISION,
    ADD COLUMN "pm25_max" DOUBLE PRECISION,
    ADD COLUMN "pm10_mean" DOUBLE PRECISION,
    ADD COLUMN "no2_mean" DOUBLE PRECISION,
    ADD COLUMN "so2_mean" DOUBLE PRECISION,
    ADD COLUMN "co_mean" DOUBLE PRECISION,
    ADD COLUMN "o3_max_8h" DOUBLE PRECISION,
    ADD COLUMN "eaqi_max" DOUBLE PRECISION,
    ADD COLUMN "usaqi_max" DOUBLE PRECISION,
    ADD COLUMN "uv_index_max" DOUBLE PRECISION,
    ADD COLUMN "dust_max" DOUBLE PRECISION,
    ADD COLUMN "aod_max" DOUBLE PRECISION,
    ADD COLUMN "pollen_alder_max" DOUBLE PRECISION,
    ADD COLUMN "pollen_birch_max" DOUBLE PRECISION,
    ADD COLUMN "pollen_grass_max" DOUBLE PRECISION,
    ADD COLUMN "pollen_mugwort_max" DOUBLE PRECISION,
    ADD COLUMN "pollen_olive_max" DOUBLE PRECISION,
    ADD COLUMN "pollen_ragweed_max" DOUBLE PRECISION,
    ADD COLUMN "aq_domain" TEXT,
    ADD COLUMN "aq_hours" INTEGER,
    ADD COLUMN "aq_fetched_at" TIMESTAMP(3);

CREATE INDEX "environment_contexts_aq_gap_idx"
    ON "environment_contexts"("user_id", "date")
    WHERE "aq_fetched_at" IS NULL;

ALTER TABLE "users"
    ADD COLUMN "environment_air_quality_enabled" BOOLEAN NOT NULL DEFAULT true;
