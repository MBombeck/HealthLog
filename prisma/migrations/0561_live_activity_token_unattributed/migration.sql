-- A Live Activity token the server cannot attribute to a dose.
--
-- iOS builds that register a relay-started Activity without its dose leave
-- the server to name the dose, and it named the device's latest start: with
-- two relay-started Activities running, both were labelled with the newer
-- dose. The server now runs at most one relay-started Activity per device and
-- attributes such a token only when its records show exactly one running;
-- otherwise it keeps the token without a dose, and the relay pass ends it.
--
-- Drops NOT NULL on one column of a table this release creates (0515): a
-- catalog change, no rewrite, harmless on replay. Reversibility: delete the
-- rows whose `medication_id` is null and set the column NOT NULL again.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "live_activity_tokens"
        ALTER COLUMN "medication_id" DROP NOT NULL;
END
$migration$;
