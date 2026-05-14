-- v1.4.25 W4e — medication_schedules @map to snake_case (cosmetic +
-- convention).
--
-- Prior to this migration `medication_schedules.windowStart` and
-- `medication_schedules.windowEnd` were the only columns on the model
-- that still used the camelCase identifier from the original
-- 0001_init.sql — every other column on the table (medication_id,
-- days_of_week) already follows the snake_case convention enforced
-- everywhere else in the schema. The drift was harmless (Prisma's
-- generated client uses the TypeScript-side `windowStart` /
-- `windowEnd` names regardless of the SQL identifier), but the
-- inconsistency tripped reviewers and made `grep window_start
-- prisma/migrations/` return zero rows.
--
-- The rename is purely a rename — the data does not move, no indexes
-- change, no foreign keys are affected. We use IF EXISTS so a
-- replayed migration on a fresh-from-schema DB (Prisma's `db push`
-- against a brand-new local) doesn't blow up trying to rename a
-- column that the schema-pushed shape already named snake_case.
--
-- Forward-only; no DOWN migration.

ALTER TABLE "medication_schedules" RENAME COLUMN "windowStart" TO "window_start";
ALTER TABLE "medication_schedules" RENAME COLUMN "windowEnd" TO "window_end";
