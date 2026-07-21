-- Aggregate provenance makes the shared Apple Health `stats:*` identity
-- authority-aware. Existing rows cannot be classified safely from their stored
-- shape, so they remain repairable but are never promoted heuristically.
CREATE TYPE "measurement_aggregation_provenance" AS ENUM (
  'HEALTHKIT_STATISTICS',
  'EXPORT_XML_SOURCE_MAX',
  'LEGACY_UNKNOWN'
);

ALTER TABLE "measurements"
  ADD COLUMN "aggregation_provenance" "measurement_aggregation_provenance",
  ADD COLUMN "aggregation_contributor_count" INTEGER,
  ADD COLUMN "aggregation_selected_source_hash" TEXT;

UPDATE "measurements"
SET "aggregation_provenance" = 'LEGACY_UNKNOWN'
WHERE "source" = 'APPLE_HEALTH'
  AND "external_id" LIKE 'stats:%';

-- Revision 1 denotes rows created under the pre-authority parser. New binaries
-- write revision 2 explicitly; the default stays legacy-safe during rollouts.
ALTER TABLE "import_jobs"
  ADD COLUMN "parser_revision" INTEGER NOT NULL DEFAULT 1;

UPDATE "import_jobs"
SET "parser_revision" = 1;

