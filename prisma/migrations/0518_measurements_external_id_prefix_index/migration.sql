-- The integration deletes and sweeps find an account's readings by the
-- prefix of their external id: a WHOOP resource deletion
-- (`<resource-id>:%`), the Oura and Garmin night re-syncs (`sleep:<day>:%`),
-- the stale sleep-segment sweep. Every one filters on `user_id`, `source`,
-- `deleted_at IS NULL` and `external_id LIKE '<prefix>%'`. No index served
-- the prefix: under a non-C collation a B-tree answers LIKE only with
-- `text_pattern_ops`, so each of these read every live reading the account
-- had and filtered them one by one. `measurements_external_id_idx` (0001)
-- serves equality only and does not lead on the account.
--
-- This index leads on the account and the source and holds the external id
-- in pattern order, live rows with an external id only; `text_pattern_ops`
-- serves the equality lookups (`= ANY`) as well. Built CONCURRENTLY so
-- writes to `measurements` carry on during the build; a concurrent build is
-- the only statement in its file, and the boot retries it on a lock timeout
-- without a marker (a failed build leaves only an INVALID index, dropped
-- before the next attempt). Partial and opclass-specific, so it lives here
-- and in a comment on the `Measurement` model, not as an `@@index`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "measurements_user_source_external_id_live_idx"
  ON "measurements" ("user_id", "source", "external_id" text_pattern_ops)
  WHERE "deleted_at" IS NULL AND "external_id" IS NOT NULL;
