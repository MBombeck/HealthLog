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
  "push.relay",
  "medication.dose-state",
  "measurement.reading-timezone",
  "apple-health.types-2026-11",
  "medication.snooze-setting",
  "apple-health.effort-scores",
  "medication.intake-sync-version",
  "medication.current-dose-open-slot",
  "cycle.pregnancy-state",
  "profile.emergency-card",
  "push.data-changed",
  "push.healthkit-catch-up",
  "push.security-alert-relay",
  "push.live-activity-relay",
  "push.live-activity-started",
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
  "push.relay":
    "The server seals push envelopes and can use the push relay; /api/auth/me push.relay and push.device carry the state, POST /api/devices takes pushKey, relayConsent and relayBinding.",
  "medication.dose-state":
    "Today rows and complianceDisplay.currentDose carry the resolved state, takenLate, dueAt, overdueSince and slotInstant.",
  "measurement.reading-timezone":
    "POST /api/measurements/batch accepts an optional IANA timeZone per entry; the reading's own zone sets its day for sleep, the day view, list day groups and daily charts.",
  "medication.snooze-setting":
    "GET/PATCH /api/auth/me/notification-prefs carry medication.snoozeMinutes (5–240, default 30); a snooze without snoozedUntil and Telegram's Remind me later button defer by it.",
  "medication.intake-sync-version":
    "Today rows, the single take answers and every landed bulk entry carry the row's syncVersion, the value expectedSyncVersion compares.",
  "medication.current-dose-open-slot":
    "complianceDisplay.currentDose names the earliest slot still due or overdue, so a dose whose time has passed stays current until it is recorded or missed.",
  "apple-health.types-2026-11":
    "The batch ingest accepts the Apple Health cycling distance, rowing distance and speed, and running speed, power, ground contact time, vertical oscillation and stride length types.",
  "apple-health.effort-scores":
    "The batch ingest accepts HealthKit workoutEffortScore, estimatedWorkoutEffortScore and physicalEffort as WORKOUT_EFFORT_SCORE, ESTIMATED_WORKOUT_EFFORT_SCORE and PHYSICAL_EFFORT.",
  "cycle.pregnancy-state":
    "CycleProfileDTO and the cycle calendar carry pregnancy (CyclePregnancyDTO): PREGNANT or POSTPARTUM with its dates, the resolved week and predictionsPaused; PATCH /api/auth/me/cycle-prefs takes pregnancy. While paused the forecast is empty and the verdict is INSUFFICIENT_DATA.",
  "profile.emergency-card":
    "GET /api/emergency-card returns the emergency card; /api/emergency-card/link mints, reads and revokes its read-only hlm_ link, served at /e/{token} with only the fields the owner ticked.",
  "push.data-changed":
    "A device with a push key gets a sealed silent DATA_CHANGED (d.domains, d.changedAt) when a server-side sync stores readings; per device at most once per five minutes and three times an hour, never for a change the device started itself.",
  "push.healthkit-catch-up":
    "A device with a push key whose app registered in the last three days gets a sealed silent HEALTHKIT_CATCH_UP (d.requestedAt) when the account's Apple Health upload is six hours behind; at most three a day, four hours apart.",
  "push.security-alert-relay":
    "SECURITY_ALERT (new sign-in, passkey added or removed, token revoked, refresh-token reuse) reaches sealed and relay-bound devices with ui.level time-sensitive and d.securityKind.",
  "push.live-activity-relay":
    "POST /api/devices takes liveActivityConsent (hl-la-consent-v1), liveActivityWithdraw (hl-la-withdraw-v1), liveActivityStart (push-to-start token with hl-la-start-v1) and liveActivityTokens[].relayStart; the server starts and updates medication Live Activities over the relay with the closed content state while push.relay.liveActivity lists start and update (operator switch PUSH_RELAY_LIVE_ACTIVITY, off by default).",
  "push.live-activity-started":
    "push.device.liveActivityStarted on /api/auth/me and in the POST /api/devices answer names the dose ({ medicationId, slotInstant }) of the Live Activity the server started on the calling device; null once that slot is answered, its medication paused or ended, or nothing was started.",
};
