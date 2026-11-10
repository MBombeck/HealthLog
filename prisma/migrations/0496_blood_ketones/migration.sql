-- Extend `measurement_type` with blood ketones (#1367):
--
--   BLOOD_KETONES  <- beta-hydroxybutyrate from a blood ketone meter (mmol/L)
--
-- Purely additive: no existing row carries the value, and nothing in this
-- file uses it, so the rule that a value added in a transaction cannot be used
-- in that same transaction never comes into play. IF NOT EXISTS keeps a replay
-- on a partially applied database harmless. Enum values cannot be dropped in
-- PostgreSQL, so there is no down path. The glucose-ketone index is computed
-- at read time and has no column.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BLOOD_KETONES';
