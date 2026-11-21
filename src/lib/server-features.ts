/**
 * The server behaviours a client may rely on, by key: the single source of
 * `features` on `GET /api/version`. A client checks for a key instead of
 * comparing version numbers. A key is listed only once its behaviour has
 * fully shipped; each one names the contract it stands for in
 * {@link SERVER_FEATURE_DOCS}. Keys are never renamed or removed while a
 * released client may read them.
 */
export const SERVER_FEATURES = [
  "medication.intake-recorded-push",
  "medication.already-taken",
  "medication.bulk-already-taken",
  "medication.undo-precondition",
  "sync.medications-last-updated",
  "medication.live-activity-tokens",
  "medication.dose-state",
] as const;

export type ServerFeature = (typeof SERVER_FEATURES)[number];

/** What each key promises, one line, kept beside the key. */
export const SERVER_FEATURE_DOCS: Record<ServerFeature, string> = {
  "medication.intake-recorded-push":
    "A take or skip recorded elsewhere sends MEDICATION_INTAKE_RECORDED to the owner's other iOS devices.",
  "medication.already-taken":
    "POST /api/medications/{id}/intake and POST /api/ingest/medication carry data.alreadyTaken; a take of a taken slot writes nothing.",
  "medication.bulk-already-taken":
    "POST /api/medications/intake/bulk answers status alreadyTaken per entry with intake, takenAt and takenVia.",
  "medication.undo-precondition":
    "DELETE /api/medications/{id}/intake/{eventId} honours expectedSyncVersion and expectedIdempotencyKey, 409 medications.intake.changedSinceSeen.",
  "sync.medications-last-updated":
    "GET /api/sync/state carries medications.lastUpdatedAt.",
  "medication.live-activity-tokens":
    "POST /api/devices takes liveActivityTokens; each Activity is ended by its own push once its dose is answered.",
  "medication.dose-state":
    "Today rows and complianceDisplay.currentDose carry the resolved state, takenLate, dueAt, overdueSince and slotInstant.",
};
