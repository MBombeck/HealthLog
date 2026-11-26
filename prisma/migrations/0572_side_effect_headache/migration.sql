-- HEADACHE as a medication side-effect entry (v1.50).
--
-- The entry list had no code for a headache, so a client filing one had to
-- pick the nearest other code. The value is appended, as every new entry is;
-- the picker order lives in the taxonomy module, not in the enum.
--
-- A file of its own: a value added with `ALTER TYPE ... ADD VALUE` cannot be
-- used inside the transaction that adds it, and nothing here uses it.
-- Reversibility: a Postgres enum value cannot be dropped; an older image
-- never writes it.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TYPE "medication_side_effect_entry" ADD VALUE IF NOT EXISTS 'HEADACHE';
END
$migration$;
