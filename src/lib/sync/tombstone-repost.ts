/**
 * What a re-post of an Apple Health sample the server holds as deleted gets.
 *
 * The iPhone app reads Apple Health history in full after a reinstall or on
 * a new device, and an outbox it had not drained yet can still carry a sample
 * that was deleted since. Who deleted it decides:
 *
 *   - **The person, in HealthLog** (web, app, MCP, any delete that is not the
 *     phone's report). The re-post is refused per entry: nothing is written,
 *     no stock is deducted, and the entry answers
 *
 *         { status: "skipped", reason: "deleted_in_healthlog" }
 *
 *   - **Apple Health**, reported by the phone through
 *     `DELETE /api/<domain>/by-external-ids`. The sample may come back: a
 *     re-post means it is in HealthKit again (a deletion report the phone
 *     got wrong, a sample restored through iCloud), so it is written like a
 *     new one, and the next deletion report removes it again if it is gone.
 *
 * `skipped`, because every bulk route already answers it for an entry it
 * will not store and documents it as final: a build that does not know the
 * reason stops re-sending the sample instead of retrying it forever, and a
 * strictly decoded status set does not break on a new word (each route's
 * status enum carries `skipped`). `reason` tells the app why.
 *
 * The origin lives on the tombstone itself: the by-external-ids deletes stamp
 * `appleHealthDeletedAt` with the same instant as `deletedAt`
 * ({@link appleHealthDeletion}). Every other delete leaves the two unequal,
 * and a revived row that is deleted again gets a new `deletedAt`, so no other
 * delete or revive path needs to know the column. A tombstone written before
 * the column existed reads as deleted in HealthLog: the safe side.
 *
 * The memory lasts as long as the tombstone does (the soft-delete retention,
 * `TOMBSTONE_RETENTION_DAYS`).
 *
 * The families and their rule are listed in {@link EXTERNAL_ID_TOMBSTONE_FAMILIES};
 * `src/__tests__/tombstone-repost-guard.test.ts` holds every
 * `by-external-ids` route to the list.
 */

/** The `reason` of a refused re-post of a sample deleted in HealthLog. */
export const DELETED_IN_HEALTHLOG_REASON = "deleted_in_healthlog" as const;

/** The per-entry answer to a refused re-post, without the entry's own fields. */
export const DELETED_IN_HEALTHLOG_ENTRY = {
  status: "skipped",
  reason: DELETED_IN_HEALTHLOG_REASON,
} as const;

/** The tombstone columns the rule reads. */
export interface TombstoneOrigin {
  deletedAt: Date | null;
  appleHealthDeletedAt: Date | null;
}

/**
 * The data a by-external-ids delete writes: the tombstone and its origin, the
 * same instant in both.
 */
export function appleHealthDeletion(now: Date = new Date()): {
  deletedAt: Date;
  appleHealthDeletedAt: Date;
} {
  return { deletedAt: now, appleHealthDeletedAt: now };
}

/**
 * The row is deleted and the deletion was not Apple Health's: a re-post of
 * its sample is refused. False for a live row.
 */
export function deletedInHealthLog(row: TombstoneOrigin): boolean {
  if (row.deletedAt == null) return false;
  return row.appleHealthDeletedAt?.getTime() !== row.deletedAt.getTime();
}

/**
 * Every by-external-ids family, keyed by the route directory under
 * `src/app/api`, with how a re-post of a deleted id is answered and the files
 * that decide it.
 *
 * `refuse`: one soft-deleted row per sample. The delete stamps the origin
 * (`delete`); the ingest refuses a re-post of a row deleted in HealthLog with
 * {@link DELETED_IN_HEALTHLOG_ENTRY} and writes one deleted in Apple Health again.
 * `revive-empty`: one row per day that many samples feed (a cycle day). A
 * day deleted in HealthLog is refused like a sample; a day deleted in Apple
 * Health is written again from empty fields, so nothing it held comes back.
 * `no-person-delete`: the rows are removed outright, and the person cannot
 * delete an Apple Health row of this family in HealthLog (`personDelete`
 * says how that is enforced), so every deletion is Apple Health's and a
 * re-post is written again.
 */
export const EXTERNAL_ID_TOMBSTONE_FAMILIES = {
  "measurements/by-external-ids": {
    rule: "refuse",
    delete: "app/api/measurements/by-external-ids/route.ts",
    ingest: [
      "lib/measurements/batch-stored-rows.ts",
      "lib/measurements/reconcile-external-measurement.ts",
      "lib/measurements/batch-ingest/write-measurements.ts",
    ],
  },
  "mood-entries/by-external-ids": {
    rule: "refuse",
    delete: "lib/mood/delete-by-external-ids.ts",
    ingest: ["lib/mood/bulk-ingest.ts"],
  },
  "symptoms/events/by-external-ids": {
    rule: "refuse",
    delete: "app/api/symptoms/events/by-external-ids/route.ts",
    ingest: ["lib/symptoms/apple-health-ingest.ts"],
  },
  "medications/intake/by-external-ids": {
    rule: "refuse",
    delete: "lib/medications/delete-intakes-by-external-ids.ts",
    ingest: [
      "lib/medications/intake-bulk/ingest.ts",
      "lib/medications/intake-bulk/entry.ts",
    ],
  },
  "cycle/day-logs/by-external-ids": {
    rule: "revive-empty",
    delete: "lib/cycle/delete-by-external-ids.ts",
    ingest: [
      "lib/cycle/day-log-write.ts",
      "app/api/cycle/day-logs/bulk/route.ts",
    ],
  },
  "workouts/by-external-ids": {
    rule: "no-person-delete",
    personDelete: {
      file: "app/api/workouts/[id]/route.ts",
      refusal: "workout.delete.synced_source",
    },
  },
  "insights/ecg/by-external-ids": {
    rule: "no-person-delete",
    personDelete: { file: null, refusal: null },
  },
} as const;

/**
 * Every single create route whose body takes an `externalId`, outside the
 * by-external-ids families' bulk and batch routes, keyed by the route
 * directory under `src/app/api`, with what a re-post of an entry deleted in
 * HealthLog gets.
 *
 * `refuse`: nothing is written, and the request answers `410` with
 * `reason: "deleted_in_healthlog"` (`deletedInHealthLogRefusal` in
 * `tombstone-repost-response.ts`, called from one of `files`). A route that
 * meets a tombstone the phone reported deleted in Apple Health writes it back.
 * `exempt`: no re-post can meet an entry the person deleted, for the reason
 * given.
 *
 * `src/__tests__/single-route-tombstone-guard.test.ts` finds the routes and
 * holds them to this list. Before it, `POST /api/mood-entries` (the route the
 * app posts State of Mind samples through, one by one) rewrote the hidden row,
 * left it deleted and answered `201`; the sleep-stage arm of
 * `POST /api/measurements` answered `200 duplicate` with the deleted row; the
 * single cycle day revived a day the person had deleted; an AUDIT-C replay
 * answered a deleted entry as live.
 */
export const SINGLE_ROUTE_EXTERNAL_ID_RULES = {
  "mood-entries": {
    rule: "refuse",
    files: ["app/api/mood-entries/route.ts", "lib/mood/single-repost.ts"],
  },
  measurements: {
    rule: "refuse",
    files: ["lib/measurements/create/create-sleep-stage.ts"],
  },
  "cycle/day-logs": {
    rule: "refuse",
    files: ["app/api/cycle/day-logs/route.ts"],
  },
  "anamnesis/audit-c": {
    rule: "refuse",
    files: [
      "app/api/anamnesis/audit-c/route.ts",
      "lib/profile/life-circumstances.ts",
    ],
  },
  "cycle/period": {
    rule: "exempt",
    reason:
      "the person's own period tap (source MANUAL); writing the day again is a new entry by the person, which revives the day",
  },
  "mental-health/assessments": {
    rule: "exempt",
    reason:
      "a screener has no delete route, so the person cannot delete one; a replay answers the stored entry",
  },
  medications: {
    rule: "exempt",
    reason:
      "a mirrored medication is deleted outright, with no tombstone to remember it by; the next sync mirrors it again while it is in the Health medication list",
  },
  "notifications/action/[token]": {
    rule: "exempt",
    reason:
      "the server mints the id from the action token; no client sends one",
  },
} as const;
