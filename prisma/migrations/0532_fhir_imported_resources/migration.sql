-- Which FHIR resources of an imported Bundle became which record row.
--
-- `fhir_imported_resources` holds one row per Condition, Immunization,
-- MedicationStatement or Encounter a FHIR Bundle import wrote, keyed by a
-- digest of the issuer, the resource type and the resource id, so the same
-- Bundle imported again writes nothing twice. A new, empty table: nothing is
-- copied. Reversibility: drop the table; a later import of an already
-- imported Bundle would then write its records again.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "fhir_imported_resources" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "resource_type" TEXT NOT NULL,
        "resource_key" TEXT NOT NULL,
        "record_id" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "fhir_imported_resources_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "fhir_imported_resources_user_id_resource_type_resource_key_key"
        ON "fhir_imported_resources" ("user_id", "resource_type", "resource_key");

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fhir_imported_resources_user_id_fkey'
    ) THEN
        ALTER TABLE "fhir_imported_resources"
            ADD CONSTRAINT "fhir_imported_resources_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
