-- v1.39 (C2) — retire the five-step wizard's two columns.
--
-- `onboarding_step` held the wizard's checkpoint (0..4) and `onboarding_goals`
-- the six goal slugs whose only durable effect was a one-time dashboard seed.
-- The needs-based flow keeps its state on `onboarding_records` and seeds the
-- dashboard from the answers there, so nothing reads or writes either column
-- any more. `onboarding_completed_at` stays: it is the first-run redirect's
-- gate and the needs flow keeps stamping it.
ALTER TABLE "users"
  DROP COLUMN IF EXISTS "onboarding_step",
  DROP COLUMN IF EXISTS "onboarding_goals";
