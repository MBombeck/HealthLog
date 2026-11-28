-- The setup flow's pinned plan and the setup card's own hide (v1.50).
--
-- `onboarding_records.plan_json` holds the segments the person flow showed
-- when it started, so the step count does not change under the person.
-- `onboarding_records.card_dismissed_at` is the person's "Hide this card"
-- for the dashboard setup card, kept on the server so it holds on every
-- device and in the iPhone app.
--
-- Both nullable: NULL means "derive the plan from the answers" and "card
-- shown", which is what the previous image does anyway. Reversibility: drop
-- both columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "onboarding_records"
        ADD COLUMN IF NOT EXISTS "plan_json" JSONB;

    ALTER TABLE "onboarding_records"
        ADD COLUMN IF NOT EXISTS "card_dismissed_at" TIMESTAMP(3);
END
$migration$;
