-- Optional daily nutrient targets a person sets for themselves (#1402):
-- energy, protein and the other catalog codes, each a value in the code's
-- canonical unit and a direction (an amount to reach or one to stay under).
--
-- Nullable, no default, no backfill: null reads as "no target set", which is
-- every account's state today. IF NOT EXISTS keeps a replay on a database
-- that already ran a build carrying the column harmless. Reversibility:
-- dropping the column removes the targets; the charts fall back to the
-- dietary reference.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "nutrient_targets_json" JSONB;
END
$migration$;
