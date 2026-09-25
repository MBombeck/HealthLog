-- Procedure and surgery history on visits.
--
-- A visit can now be marked as a procedure or surgery (`PROCEDURE` kind) and
-- carry the body site it was done on: free text, encrypted at rest like the
-- visit's reason and outcome, plus an optional side. The reasoning for a kind
-- rather than a flag, and for searching the site by decrypting server-side
-- rather than storing a plaintext copy, is written at the `Encounter` model.
--
-- Purely additive. `ADD VALUE IF NOT EXISTS` makes a rerun safe, and the new
-- value is not used elsewhere in this migration, which is the one thing
-- Postgres forbids inside the transaction that adds it. No backfill: an
-- existing visit keeps its kind until the person switches it, which is an
-- ordinary edit. Both columns are nullable, so no row is rewritten.
--
-- Reversibility: Postgres cannot drop an enum value, so `PROCEDURE` would stay
-- (inert with no rows); the two columns and the `laterality` type can be
-- dropped.
ALTER TYPE "encounter_kind" ADD VALUE IF NOT EXISTS 'PROCEDURE';

CREATE TYPE "laterality" AS ENUM ('LEFT', 'RIGHT', 'BOTH');

ALTER TABLE "encounters"
  ADD COLUMN "body_site_encrypted" BYTEA,
  ADD COLUMN "laterality" "laterality";
