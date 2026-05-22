-- v1.4.47 W3 — per-user Coach opt-out.
--
-- Privacy-leaning users want to hide the Coach surface even when the
-- operator has enabled the global `assistant.coach` feature flag. The
-- per-user `disable_coach` column is a hard client-side gate consulted
-- by every Coach mount point (`<LayoutCoachFab>`, `<LayoutCoachMount>`,
-- `<CoachLaunchButton>`, `/targets` page CTA, …) AFTER the
-- operator-level flag check — both must agree to render the affordance.
--
-- Default `false` keeps the existing posture: every user who has not
-- explicitly opted out continues to see the Coach button + drawer
-- exactly as before. The toggle lives in Settings → Insights as a
-- `<Switch>` labelled "Hide Coach" / "Coach ausblenden"; persisted via
-- `PATCH /api/auth/me/disable-coach`.
--
-- Idempotent guard (`IF NOT EXISTS`) matches the 0067 / 0070 / 0071 /
-- 0075 pattern so reruns are safe on prod where the migration has
-- already been applied.
--
-- Reversibility: down migration is `ALTER TABLE "users" DROP COLUMN
-- IF EXISTS "disable_coach";`. The column is `NOT NULL DEFAULT false`
-- so the down migration is lossy (every opted-out user reverts to
-- "Coach visible") but never crashes a roll-back. The application
-- layer treats a missing column the same as `false` (the auth/me
-- payload defaults the field) so a partial deploy where the schema
-- is rolled back ahead of the app code keeps working.

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "disable_coach" BOOLEAN NOT NULL DEFAULT false;
