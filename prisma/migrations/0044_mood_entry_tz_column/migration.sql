-- v1.4.25 W7b — MoodEntry.tz column (proposal §7 Decision A).
--
-- HealthLog historically wrote `MoodEntry.date` (YYYY-MM-DD) under
-- the implicit Europe/Berlin assumption. Per-user timezone (Option B,
-- feature `feature-user-timezone.md`) makes that assumption wrong for
-- non-Berlin users — a 23:50 NZST reading would bucket into the
-- Berlin day, one day earlier than the user's own "today".
--
-- The fix is per-row tz attribution:
--
--   - New rows: writer captures `User.timezone` at write time, stores
--     it on the row, and computes `date` using that zone.
--   - Legacy rows: `tz IS NULL` is interpreted as "Europe/Berlin"
--     read-side. The historical bucketing stays consistent with the
--     numbers users have already seen.
--
-- Forward-only, additive, idempotent. No backfill is required because
-- the read-path treats `tz IS NULL` as Europe/Berlin (the value those
-- rows would carry if backfilled). Rollback is a manual DROP COLUMN.

ALTER TABLE "mood_entries"
  ADD COLUMN IF NOT EXISTS "tz" VARCHAR(64);
