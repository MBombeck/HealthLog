-- "End course" ends a course at the moment it is pressed (#1280).
--
-- A course's `ends_on` is a calendar day and counts in full: the doses of
-- that day stay due, reminded and expected until local midnight. That is the
-- right reading for an end date written in the course editor ("the last day
-- of the pack"), and the wrong one for "End course", whose dialog promises
-- that nothing more is due. `ended_at` records the instant the course was
-- ended that way: it lies on the `ends_on` day, a dose slot at or after it
-- is not part of the course, and the course reads as ended from then on.
-- NULL keeps the full-day reading every existing course has.
--
-- `medications.ended_at` is the projection of the latest course's value,
-- written next to `starts_on` / `ends_on` by the one course writer, so the
-- engines that read the medication's window read it too.
--
-- Nullable, no default, no backfill: no existing course was ended this way.
-- Reversibility: dropping both columns restores the full-day reading.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "medication_courses"
        ADD COLUMN IF NOT EXISTS "ended_at" TIMESTAMPTZ(6);
    ALTER TABLE "medications"
        ADD COLUMN IF NOT EXISTS "ended_at" TIMESTAMPTZ(6);
END
$migration$;
