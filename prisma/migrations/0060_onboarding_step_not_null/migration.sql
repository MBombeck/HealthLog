-- v1.4.25 W21 Fix-O — Backfill `onboarding_step` and flip column to NOT NULL.
--
-- Migration 0057 shipped `onboarding_step INTEGER DEFAULT 0` — nullable on
-- purpose so the additive DDL didn't risk a long table-rewrite during the
-- W14b deploy. The wizard mount code (`src/app/onboarding/page.tsx`) treats
-- `null` as `0`, the POST route (`src/app/api/onboarding/step/route.ts`)
-- widens its conditional-update WHERE to `OR onboardingStep IS NULL` when
-- the caller is at step 0 — all defensive against the tri-state surface.
--
-- This migration closes that tri-state: every legacy pre-W14b row that
-- still carries a NULL is backfilled to 0 (the same value the read-path
-- already substitutes), then the column is flipped to NOT NULL. New
-- inserts continue to land at the DEFAULT 0 — schema.prisma now mirrors
-- the DB shape: `onboardingStep Int @default(0)` without the `?`.
--
-- Idempotent — re-running on a database that's already been flipped is a
-- no-op for the UPDATE (no rows match) and the ALTER COLUMN tolerates
-- SET NOT NULL on an already-NOT NULL column.

UPDATE "users"
  SET "onboarding_step" = 0
  WHERE "onboarding_step" IS NULL;

ALTER TABLE "users"
  ALTER COLUMN "onboarding_step" SET NOT NULL;
