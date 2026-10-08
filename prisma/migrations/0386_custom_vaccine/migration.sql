-- User-defined vaccines (#1005).
--
-- A vaccine the user defines for a product the shipped catalogue does not
-- list, in the same shape a catalogue entry resolves to. A dose links to it
-- through `vaccination_records.custom_vaccine_id`; deleting the definition
-- sets the link to NULL and the dose stays on its `vaccine_name`.
CREATE TABLE "custom_vaccines" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "components" TEXT[],
    "typical_series_doses" INTEGER,
    "booster_interval_months" INTEGER,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_vaccines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_vaccines_user_id_name_key" ON "custom_vaccines"("user_id", "name");

ALTER TABLE "custom_vaccines" ADD CONSTRAINT "custom_vaccines_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vaccination_records" ADD COLUMN "custom_vaccine_id" TEXT;

CREATE INDEX "vaccination_records_custom_vaccine_id_idx" ON "vaccination_records"("custom_vaccine_id");

ALTER TABLE "vaccination_records" ADD CONSTRAINT "vaccination_records_custom_vaccine_id_fkey" FOREIGN KEY ("custom_vaccine_id") REFERENCES "custom_vaccines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
