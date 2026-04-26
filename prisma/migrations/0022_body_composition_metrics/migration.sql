-- v1.3: Add body-composition measurement types
--
-- Closes #89: total body water and bone mass as first-class measurement types.
-- Both are reported by Withings body-composition scales and can also be ingested
-- via the API by external pipelines (e.g. n8n + Health Connect).
--
-- Storage units (canonical):
--   TOTAL_BODY_WATER: percent of body weight (%)
--   BONE_MASS:        kilograms (kg)
--
-- Both are unconditional value types — no companion enum (unlike BLOOD_GLUCOSE,
-- which carries a glucose_context). The migration is purely additive.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'TOTAL_BODY_WATER';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BONE_MASS';
