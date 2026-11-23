-- The pregnancy state is encrypted at rest.
--
-- Migration 0533 stored the state and its three calendar days as plaintext
-- columns on `cycle_profiles`. The reproductive-health data page promises
-- that the disclosure-sensitive cycle data is encrypted at rest, and whether
-- someone is pregnant, since when and when the birth was is the most
-- sensitive item of the category. The application now seals the state and
-- its days into one AES-256-GCM envelope, `pregnancy_encrypted`; no query
-- reads them, so nothing of them stays in plaintext.
--
-- On a host that updates from 1.48 the plaintext columns were added by 0533
-- in the same deploy and hold nothing, so dropping them loses nothing. A
-- host that ran a 1.49 pre-release may hold a state in them; SQL cannot seal
-- it with the application's key, so that state is cleared and the owner sets
-- it again. `postpartum_weeks` is a plain setting and stays.
--
-- One DO block, every step guarded, so a replay after a lock timeout finishes
-- what is missing.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "cycle_profiles"
        ADD COLUMN IF NOT EXISTS "pregnancy_encrypted" TEXT;

    ALTER TABLE "cycle_profiles"
        DROP CONSTRAINT IF EXISTS "cycle_profiles_pregnancy_start_date_day_key_shape",
        DROP CONSTRAINT IF EXISTS "cycle_profiles_pregnancy_due_date_day_key_shape",
        DROP CONSTRAINT IF EXISTS "cycle_profiles_delivery_date_day_key_shape",
        DROP COLUMN IF EXISTS "reproductive_state",
        DROP COLUMN IF EXISTS "pregnancy_start_date",
        DROP COLUMN IF EXISTS "pregnancy_due_date",
        DROP COLUMN IF EXISTS "delivery_date";

    DROP TYPE IF EXISTS "cycle_reproductive_state";
END
$migration$;
