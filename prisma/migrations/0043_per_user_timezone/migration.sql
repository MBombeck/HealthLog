-- v1.4.25 W7 — per-user timezone feature (Option B from
-- `.planning/feature-user-timezone.md`).
--
-- HealthLog already ships a `users.timezone` column (default
-- 'Europe/Berlin', NOT NULL) from the original schema, so the
-- per-user side of this feature is non-additive at the storage
-- layer: the existing column is the canonical "display timezone"
-- that the resolver in `src/lib/tz/resolver.ts` reads. No change is
-- required on `users`.
--
-- The admin-managed default for *new* accounts is the only new
-- column. It lives on the singleton `app_settings` row and is
-- nullable so the resolver can fall back to "Europe/Berlin" when an
-- operator never touches the setting. Validated against
-- `Intl.supportedValuesOf('timeZone')` upstream — the column is just
-- a varchar(64) bag.
--
-- Forward-only / additive: ALTER TABLE ADD COLUMN with a nullable
-- type and no default. Existing rows are untouched. Rollback would
-- be a manual DROP COLUMN.

ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "default_user_timezone" VARCHAR(64);
