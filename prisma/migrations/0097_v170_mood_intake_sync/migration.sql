-- v1.7.0 sync — extend the offline-sync feed to mood + medication intakes.
--
-- Adds the same reconciliation columns the measurement feed already
-- carries (`sync_version` LWW counter + `deleted_at` soft-delete
-- tombstone) to `mood_entries` and `medication_intake_events`, plus an
-- `updated_at` column to `medication_intake_events` (which had none) so
-- the `/api/sync/changes` keyset feed can order on it. `mood_entries`
-- already has `updated_at`, so it only gains the two sync columns.
--
-- Conflict semantics mirror the per-domain rules in the iOS-coord
-- contract: mood is last-writer-wins by `sync_version`; an intake is an
-- immutable fact whose correction is a tombstone + re-insert, so its
-- `sync_version` only bumps on the soft-delete write.
--
-- Every add is additive + order-safe:
--   - `sync_version` defaults to 0 (constant) → metadata-only ADD COLUMN.
--   - `deleted_at` is nullable, no default → metadata-only.
--   - `updated_at` on intakes is NOT NULL with `DEFAULT now()` so the
--     ADD COLUMN backfills existing rows to their migration instant
--     without a table rewrite (constant-folded default on PG 11+). The
--     Prisma `@updatedAt` directive maintains it from the app layer on
--     every subsequent write; the DB default only seeds legacy rows.
--
-- Supporting keyset indexes match the measurement feed's
-- `(user_id, updated_at, id)` index from migration 0096 so the delta
-- drain reads straight off the index in order rather than sorting the
-- user's whole set per page.
--
-- Reversibility (down):
--   DROP INDEX IF EXISTS "medication_intake_events_user_id_updated_at_id_idx";
--   DROP INDEX IF EXISTS "mood_entries_user_id_updated_at_id_idx";
--   ALTER TABLE "medication_intake_events"
--     DROP COLUMN "deleted_at", DROP COLUMN "sync_version", DROP COLUMN "updated_at";
--   ALTER TABLE "mood_entries"
--     DROP COLUMN "deleted_at", DROP COLUMN "sync_version";

ALTER TABLE "mood_entries"
  ADD COLUMN "sync_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deleted_at" TIMESTAMP(3);

ALTER TABLE "medication_intake_events"
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "sync_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "mood_entries_user_id_updated_at_id_idx"
  ON "mood_entries" ("user_id", "updated_at", "id");

CREATE INDEX IF NOT EXISTS "medication_intake_events_user_id_updated_at_id_idx"
  ON "medication_intake_events" ("user_id", "updated_at", "id");
