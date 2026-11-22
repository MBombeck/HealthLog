/**
 * What a re-post of an Apple Health sample the server holds as deleted gets.
 *
 * The iPhone app reads Apple Health history in full after a reinstall or on
 * a new device, and an outbox it had not drained yet can still carry a sample
 * that was deleted since. A record deleted in HealthLog, or reported deleted
 * through `DELETE /api/<domain>/by-external-ids`, must not come back that
 * way. So every per-sample ingest refuses a re-post of a deleted sample id:
 * nothing is written, and the entry answers
 *
 *     { status: "duplicate", reason: "tombstoned" }
 *
 * `duplicate`, because every app build already treats it as final and moves
 * past the entry, which is exactly right: a build that does not know the
 * reason stops re-sending the sample instead of retrying it forever, and a
 * strictly decoded status set (the ECG answer) does not break on a new word.
 * `reason` tells the app why, for a build that wants to say so.
 *
 * The memory lasts as long as the deleted row or its ledger line does (the
 * soft-delete retention, `TOMBSTONE_RETENTION_DAYS`).
 *
 * The families and their rule are listed in {@link EXTERNAL_ID_TOMBSTONE_FAMILIES};
 * `src/__tests__/tombstone-repost-guard.test.ts` holds every
 * `by-external-ids` route to the list.
 */

/** The `reason` of a refused re-post of a deleted sample. */
export const TOMBSTONED_REASON = "tombstoned" as const;

/** The per-entry answer to a refused re-post, without the entry's own fields. */
export const TOMBSTONED_ENTRY = {
  status: "duplicate",
  reason: TOMBSTONED_REASON,
} as const;

/**
 * Every by-external-ids family, keyed by the route directory under
 * `src/app/api`, with how a re-post of a deleted id is answered and the file
 * whose ingest decides it.
 *
 * `refuse`: one row per sample; the re-post is refused per entry with
 * {@link TOMBSTONED_ENTRY}.
 * `revive-empty`: one row per day that many samples feed (a cycle day), so a
 * new sample for a deleted day writes the day again, starting from empty
 * fields: nothing the deleted day held comes back.
 */
export const EXTERNAL_ID_TOMBSTONE_FAMILIES = {
  "measurements/by-external-ids": {
    rule: "refuse",
    ingest: "lib/measurements/batch-ingest/write-measurements.ts",
  },
  "workouts/by-external-ids": {
    rule: "refuse",
    ingest: "lib/workouts/batch-ingest/ingest.ts",
  },
  "insights/ecg/by-external-ids": {
    rule: "refuse",
    ingest: "lib/ecg/persist-recording.ts",
  },
  "mood-entries/by-external-ids": {
    rule: "refuse",
    ingest: "lib/mood/bulk-ingest.ts",
  },
  "symptoms/events/by-external-ids": {
    rule: "refuse",
    ingest: "lib/symptoms/apple-health-ingest.ts",
  },
  "medications/intake/by-external-ids": {
    rule: "refuse",
    ingest: "lib/medications/intake-bulk/entry.ts",
  },
  "cycle/day-logs/by-external-ids": {
    rule: "revive-empty",
    ingest: "lib/cycle/day-log-write.ts",
  },
} as const;
