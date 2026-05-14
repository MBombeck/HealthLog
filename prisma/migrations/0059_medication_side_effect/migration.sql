-- v1.4.25 W19d — MedicationSideEffect logbook.
--
-- 21-entry × 5-category structured side-effect taxonomy derived from
-- EMA EPAR §4.8 ("Undesirable effects") clustered into the five
-- surfaces the HealthLog UI renders. 1-5 Likert severity (finer
-- granularity than the EMA 3-level reporting convention; the UI maps
-- each integer to a translated semantic label).
--
-- Daily capture, not per-shot — delayed-onset symptoms (nausea on
-- day 4 post-tirzepatide is common) keep their actual onset time.
-- The Coach reads these against MedicationDoseChange +
-- MedicationIntakeEvent to surface patterns without making a clinical
-- claim.
--
-- Composite index (user_id, medication_id, occurred_at) is the
-- dominant read path: "last N entries for this medication on the
-- detail page". A second per-user (user_id, occurred_at) index serves
-- the Coach snapshot aggregation, which correlates across medications.
--
-- Severity is bounded with a CHECK constraint at the DB level —
-- defence in depth against client-side Zod drift. Notes are unbounded
-- TEXT, application-layer capped to 280 chars in the Zod schema.

CREATE TYPE "medication_side_effect_category" AS ENUM (
  'GI',
  'METABOLIC',
  'INJECTION_SITE',
  'COGNITIVE',
  'GLP1_SPECIFIC'
);

CREATE TYPE "medication_side_effect_entry" AS ENUM (
  -- GI (5)
  'NAUSEA',
  'VOMITING',
  'DIARRHEA',
  'CONSTIPATION',
  'ABDOMINAL_PAIN',
  -- Metabolic (4)
  'HYPOGLYCEMIA_SYMPTOMS',
  'DEHYDRATION',
  'ANOREXIA',
  'ELECTROLYTE_FATIGUE',
  -- Injection-site (4)
  'INJECTION_REDNESS',
  'INJECTION_SWELLING',
  'INJECTION_BRUISING',
  'INJECTION_INDURATION',
  -- Cognitive (4)
  'BRAIN_FOG',
  'DIZZINESS',
  'LOW_MOOD',
  'LOW_ENERGY',
  -- GLP-1 specific (4)
  'EARLY_SATIETY',
  'GASTROPARESIS_LIKE',
  'DYSGEUSIA',
  'GALLBLADDER_DISCOMFORT'
);

CREATE TABLE "medication_side_effects" (
  "id"            TEXT PRIMARY KEY,
  "user_id"       TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "medication_id" TEXT NOT NULL REFERENCES "medications"("id") ON DELETE CASCADE,
  "occurred_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "category"      "medication_side_effect_category" NOT NULL,
  "entry"         "medication_side_effect_entry"    NOT NULL,
  "severity"      INTEGER NOT NULL,
  "notes"         TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "medication_side_effects_severity_range_chk"
    CHECK ("severity" >= 1 AND "severity" <= 5)
);

CREATE INDEX "medication_side_effects_user_med_occurred_idx"
  ON "medication_side_effects" ("user_id", "medication_id", "occurred_at");

CREATE INDEX "medication_side_effects_user_occurred_idx"
  ON "medication_side_effects" ("user_id", "occurred_at");
