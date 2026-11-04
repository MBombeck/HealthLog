/**
 * Indexes on `measurements` the schema no longer declares, which are dropped
 * when the migration that retired them could not. Each one's migration names
 * it; `IF EXISTS` makes the drop a no-op once it is gone.
 *
 * Plain ESM with no imports, because two processes read it: the measurement
 * maintenance job (`measurement-maintenance.ts`), and the boot step in
 * `scripts/db-app-role.mjs`, which drops them as the database owner when the
 * app itself connects as a role that may not (`DROP INDEX` belongs to the
 * table's owner, not to the MAINTAIN privilege).
 *
 * @type {readonly string[]}
 */
export const RETIRED_MEASUREMENT_INDEXES = Object.freeze([
  // 0416: a prefix of the unique key `(user_id, type, measured_at, source,
  // sleep_stage)`, which plans every query it served at the same cost.
  "measurements_user_id_type_measured_at_idx",
]);

/** Postgres's suffixes for the copies a concurrent rebuild leaves behind. */
export const CONCURRENT_COPY = /_ccnew\d*$|_ccold\d*$/;
