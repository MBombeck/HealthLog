-- Body site and side on conditions.
--
-- A condition (illness episode) can now carry the body site it sits on, in the
-- person's own words and encrypted at rest, plus an optional side. It reuses
-- the `laterality` type migration 0349 created for procedures, so "left knee"
-- on a condition and "left knee" on a procedure are the same pair of values.
-- The reasoning for free text and for searching after the decrypt is written
-- at `Encounter.bodySiteEncrypted` and `IllnessEpisode.bodySiteEncrypted`.
--
-- Purely additive: two nullable columns, no backfill, no row rewritten. An
-- existing condition keeps no site until the person adds one.
--
-- Reversibility: both columns can be dropped. The `laterality` type stays,
-- since `encounters.laterality` still uses it.
ALTER TABLE "illness_episodes"
  ADD COLUMN "body_site_encrypted" BYTEA,
  ADD COLUMN "laterality" "laterality";
