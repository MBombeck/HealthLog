-- v1.4.25 W4d — GLP-1 full integration (research §5).
--
-- Adds the foundation for first-class GLP-1 receptor agonist support
-- (Mounjaro, Ozempic, Wegovy, Zepbound, Trulicity, Saxenda, Rybelsus,
-- compounded semaglutide/tirzepatide). Holistic landing — schema +
-- snapshot + Coach guardrails + UI variants — happens together so the
-- feature surfaces all at once instead of trickling in across releases.
--
-- Design principle: every change is additive. Existing medications keep
-- working untouched. The new columns default to NULL / GENERIC so the
-- previous read paths read the same shape they did before the migration.
--
-- Shapes:
--   - MedicationCategory enum (GENERIC default; GLP1 turns on the
--     specialist code paths). Future categories — INSULIN, BIOLOGIC,
--     FERTILITY — drop into this enum.
--   - Medication.treatment_class column with GENERIC default. The
--     existing `medication_categories` side-table (BLOOD_PRESSURE /
--     VITAMIN / ...) tracks the clinical taxonomy and stays put — it
--     is a different concept (clinical category) and the UI keeps
--     reading it under the existing `category` slot. The new column
--     models "medication kind that needs special handling" so the
--     GLP-1 surfaces (card variant, dashboard tile, Coach snapshot)
--     have a single boolean-ish discriminator.
--   - Medication.doses_per_unit — nullable integer; only meaningful for
--     pen / vial meds (Mounjaro KwikPen = 4 doses, Ozempic 0.25/0.5 mg
--     = 4 doses, Wegovy single-dose pen = 1 dose, compounded vials
--     vary). NULL = inventory tracking is off for this medication.
--   - MedicationDoseChange — append-only titration history. The
--     current dose is "latest row by effective_from". Existing
--     Medication.dose remains the convenience pointer; this table is
--     the history of record.
--   - InjectionSite enum (8 zones — front-of-body view: 4 abdomen
--     quadrants, 2 thighs, 2 upper arms). The body-map picker maps each
--     zone to a clickable region.
--   - MedicationIntakeEvent.injection_site — nullable; only populated
--     for GLP-1 intake events. Existing rows stay NULL and read
--     untouched.
--   - MedicationInventoryEvent — append-only inventory log. Positive
--     delta = stock added (purchase), negative = consumed (one per
--     intake event when doses_per_unit is set). Reason is a free-text
--     audit slot ("purchased", "consumed", "expired", "damaged").
--
-- Forward-only, additive, idempotent. No backfill: every new column
-- carries a sensible NULL/default, and the read paths handle the
-- pre-migration shape verbatim.

-- 1. MedicationCategory enum.
DO $$ BEGIN
  CREATE TYPE "medication_category" AS ENUM ('GENERIC', 'GLP1');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Medication.treatment_class + Medication.doses_per_unit columns.
ALTER TABLE "medications"
  ADD COLUMN IF NOT EXISTS "treatment_class" "medication_category" NOT NULL DEFAULT 'GENERIC';

ALTER TABLE "medications"
  ADD COLUMN IF NOT EXISTS "doses_per_unit" INTEGER;

CREATE INDEX IF NOT EXISTS "medications_treatment_class_idx" ON "medications" ("treatment_class");

-- 3. InjectionSite enum + MedicationIntakeEvent.injection_site column.
DO $$ BEGIN
  CREATE TYPE "injection_site" AS ENUM (
    'ABDOMEN_LEFT',
    'ABDOMEN_RIGHT',
    'ABDOMEN_UPPER_LEFT',
    'ABDOMEN_UPPER_RIGHT',
    'THIGH_LEFT',
    'THIGH_RIGHT',
    'UPPER_ARM_LEFT',
    'UPPER_ARM_RIGHT'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "medication_intake_events"
  ADD COLUMN IF NOT EXISTS "injection_site" "injection_site";

-- 4. MedicationDoseChange — titration history.
CREATE TABLE IF NOT EXISTS "medication_dose_changes" (
  "id" TEXT NOT NULL,
  "medication_id" TEXT NOT NULL,
  "effective_from" TIMESTAMP(3) NOT NULL,
  "dose_value" DOUBLE PRECISION NOT NULL,
  "dose_unit" TEXT NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "medication_dose_changes_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "medication_dose_changes"
    ADD CONSTRAINT "medication_dose_changes_medication_id_fkey"
    FOREIGN KEY ("medication_id") REFERENCES "medications"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "medication_dose_changes_medication_id_effective_from_idx"
  ON "medication_dose_changes" ("medication_id", "effective_from");

-- 5. MedicationInventoryEvent — append-only inventory ledger.
CREATE TABLE IF NOT EXISTS "medication_inventory_events" (
  "id" TEXT NOT NULL,
  "medication_id" TEXT NOT NULL,
  "delta" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "medication_inventory_events_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "medication_inventory_events"
    ADD CONSTRAINT "medication_inventory_events_medication_id_fkey"
    FOREIGN KEY ("medication_id") REFERENCES "medications"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "medication_inventory_events_medication_id_occurred_at_idx"
  ON "medication_inventory_events" ("medication_id", "occurred_at");
