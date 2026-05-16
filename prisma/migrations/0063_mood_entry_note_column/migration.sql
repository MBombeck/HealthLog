-- v1.4.30 — MoodEntry.note column (R-E H-5)
--
-- Replaces the `tags: ["note:<text>"]` workaround the iOS app
-- shipped through v0.4.1.1. The prior shape contaminated the tags
-- axis with prose that the Coach evidence shelf misread as
-- taxonomic labels. The new column is a first-class free-text
-- field; the bulk-backfill migration script (run separately by the
-- operator) pulls existing `note:...` tag entries into this column.
--
-- Additive-only — the column is nullable, no existing row needs
-- updating for the schema migration itself to apply cleanly. The
-- `IF NOT EXISTS` guard keeps this idempotent against partial
-- historical runs (same posture as 0058 and 0061).

ALTER TABLE "mood_entries"
  ADD COLUMN IF NOT EXISTS "note" TEXT;
