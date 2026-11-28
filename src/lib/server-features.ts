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
  "day.dose-offset",
  "push.device-diagnostics",
  "medication.resolved-slots",
  "medication.intake-reopened",
  "push.relay-operator-decision",
  "measurement.stats-computed-at",
  "push.live-activity-start-id",
  "documents.lab-values-extract",
  "documents.server-ocr",
  "care.treatment-series",
  "sleep.night-overlays",
  "profile.emergency-card-apple-wallet",
  "profile.emergency-card-apple-wallet-state",
  "profile.emergency-card-wallet-ready-push",
  "notifications.sync-stalled",
  "insights.same-time-daily-total",
  "push.live-activity-token-state",
  "insights.chart-context",
  "daily.morning",
  "measurements.series-kinds",
  "devices.ignored-fields",
  "insights.briefing-glucose",
  "medication.side-effect-headache",
  "medication.low-stock-trigger",
  "insights.score-origin",
  "account.dismissed-hints",
  "daily.asks",
  "daily.scores-short-labels",
  "dashboard.tile-comparison-bands",
] as const;

export type ServerFeature = (typeof SERVER_FEATURES)[number];

/** What each key promises, one line, kept beside the key. */
export const SERVER_FEATURE_DOCS: Record<ServerFeature, string> = {
  "medication.intake-recorded-push":
    "A take or skip recorded elsewhere sends MEDICATION_INTAKE_RECORDED to the owner's other iOS devices; since v1.49.0 so does its undo (outcome reopened), and every one carries asOf.",
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
    "Today rows carry the resolved state, takenLate, dueAt, overdueSince and slotInstant; complianceDisplay.currentDose carries the same state, takenLate, dueAt and overdueSince, with its slot as targetAt.",
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
    "A device with a push key gets a sealed silent DATA_CHANGED (d.domains, d.changedAt) when a server-side sync stores readings, and since v1.49.0 when doses or schedules change (domains intakes, medications); per device at most once per five minutes and three times an hour, within one silent budget shared with MEDICATION_INTAKE_SYNC, never for a change the device started itself.",
  "push.healthkit-catch-up":
    "A device with a push key whose app registered in the last three days gets a sealed silent HEALTHKIT_CATCH_UP (d.requestedAt) when the account's Apple Health upload is six hours behind; at most three a day, four hours apart.",
  "push.security-alert-relay":
    "SECURITY_ALERT (new sign-in, passkey added or removed, token revoked, refresh-token reuse, a device taken over by another account, a second factor due by a date) reaches sealed and relay-bound devices with ui.level time-sensitive and d.securityKind.",
  "push.live-activity-relay":
    "POST /api/devices takes liveActivityConsent (hl-la-consent-v1), liveActivityWithdraw (hl-la-withdraw-v1), liveActivityStart (push-to-start token with hl-la-start-v1) and liveActivityTokens[].relayStart; the server starts medication Live Activities over the relay and updates only those registered with relayStart, with the closed content state, while push.relay.liveActivity lists start and update (operator switch PUSH_RELAY_LIVE_ACTIVITY, off by default).",
  "push.live-activity-started":
    "push.device.liveActivityStarted on /api/auth/me and in the POST /api/devices answer names the dose ({ medicationId, slotInstant }) of the Live Activity the server started on the calling device; null once that slot is answered, its medication paused or ended, or nothing was started.",
  "day.dose-offset":
    "GET /api/day/{date} symptom events and every GET /api/symptoms/events occurrence carry doseOffset (intakeId, title, minutes) from one rule: the nearest dose taken at or before it on the same local day of the record's zone, else the nearest after it (negative minutes); absent without a timed dose that day or when medications are not readable.",
  "push.device-diagnostics":
    "GET /api/devices/me/push-diagnostics returns the X-Device-Id device's push state: transport, relay and binding state, the silent budget (windowMinutes, limit, wakeLimit, usedInWindow, wakesUsedInWindow, owedSyncs, nextFreeAt), the last delivery per kind, the last receipt and the masked APNs token; 404 for a device that is not the caller's.",
  "medication.resolved-slots":
    "GET /api/medications/resolved-slots?from=&to= returns every medication's resolved slots with their state for a window of at most 14 days (default two days back to eight ahead), from the same resolver as dose-history and the today list.",
  "medication.intake-reopened":
    'MEDICATION_INTAKE_RECORDED carries outcome "reopened" with takenAt and takenVia null when a dose is undone elsewhere, plus asOf (server time) in d and in plaintext; the today list answers with a HealthLog-As-Of header on 200 and 304.',
  "push.relay-operator-decision":
    "/api/auth/me carries push.relay.operatorDecision (undecided | on | off) and push.relay.canDecide; an admin answers the one-time relay question in the web admin (POST /api/admin/push-relay/decision is cookie-only).",
  "measurement.stats-computed-at":
    "POST /api/measurements/batch accepts an optional computedAt (ISO 8601) on stats: rows; a write older than the stored one answers skipped with reason stale, and without computedAt the last write wins.",
  "push.live-activity-start-id":
    "POST /api/devices takes liveActivityTokens[].startId, the s attribute of a relay-started HealthLogDoseAttributes Activity, and names its dose from that start; push.device.liveActivityStarts, always present (empty when none runs), lists every start that may still run by id with startedAt and state (pending from the moment the server records it, accepted once the relay took it; a refused or dropped start leaves it), and liveActivityStarted, when not null, is one of its entries; once a device reports one, it may run one relay-started Activity per dose (at most four Activities in all), and a new start ends no other.",
  "documents.lab-values-extract":
    "POST /api/documents/inbound/{id}/lab-values reads a stored lab report's values by rule, with no model and no AI capability, and stages them as PENDING OBSERVATION facts for the same review the AI extraction fills; a row the reader is unsure about carries needsReview.",
  "documents.server-ocr":
    "The server reads a scanned PDF or a photo by OCR when it indexes the document, in every app language, so its text is searchable and the model-free lab reader can read it; contentIndexSource is local-ocr, and a failed OCR run sets lastIndexOutcome ocr-failed.",
  "care.treatment-series":
    "GET/POST /api/treatment-series, GET/PATCH/DELETE /api/treatment-series/{id} and POST /api/treatment-series/{id}/restore group visits into treatment series (plannedSessions, validUntil, prescriber, performer, episode; a visit joins one through seriesId on POST /api/encounters), and the owner is reminded once before a series with sessions left runs out.",
  "sleep.night-overlays":
    "GET /api/sleep/night carries overlays (SleepNightOverlays: night metrics resolved and bucketed on the server, drawn as given over the main night's timeline; null without a main night or for a reconstructed one), and the sleepNight chart slot of the dashboard preferences stores overlayLines (at most two).",
  "profile.emergency-card-apple-wallet":
    "GET /api/emergency-card/wallet/apple (also emergencyCard.wallet.apple on /api/auth/me) says whether an Apple Wallet pass of the emergency card can be made, who signs it and the pass it has; GET /api/emergency-card/wallet/apple/pass serves the signed .pkpass to a cookie or a full-access token, and an installed pass is kept current. Making and withdrawing the pass are cookie-only.",
  "profile.emergency-card-apple-wallet-state":
    "emergencyCard.wallet.apple carries state (available | relay_off | relay_not_ready | not_configured | no_https_origin | api_disabled | not_allowed), relayAction (enable | ask_admin, only with relay_off, by the caller's own role) and relayHintDismissed; POST /api/emergency-card/wallet/apple/relay-hint records the caller's no. A server that signs with its own WALLET_APPLE_* never reads relay_off.",
  "profile.emergency-card-wallet-ready-push":
    "EMERGENCY_CARD_WALLET_READY is a notification event (default on): once per Wallet pass, at most twice per person, while the pass is live, emergencyCard.wallet.apple.state is available, no device registered the pass and the card shows something; never for a managed profile. Its category is the event name and its tap opens the add-pass sheet (web: /emergency-card#wallet). POST /api/emergency-card/wallet/apple/ready-push/dismiss records the person's no, per person, and it is never sent again; a tap that finds the pass no longer available is not a no.",
  "notifications.sync-stalled":
    "SYNC_STALLED is a notification category (default on, toggled per channel in the notification preferences): once per stall and in daytime, the owner is told that a daily source went quiet, among them an iPhone whose Apple Health upload stopped; GET /api/integrations/healthkit carries quietDevices (model, quietSince). The push names the source as a connection key (apple-health, garmin, google-health, nightscout, oura, polar, whoop, withings), and its deep link is always /settings/integrations#<source>, the source's card on the integrations page: a direct push carries it as url, a relay push carries only d.source and the client builds the same path.",
  "insights.same-time-daily-total":
    "SAME_TIME_BASELINE on GET /api/insights/derived carries mode: hourly is the hour-by-hour comparison, daily_total compares today's running total from a once-a-day source with the usual full day (dayRangeReached not_yet, within or above; gated reasons learning_usual_total and no_total_today).",
  "push.live-activity-token-state":
    "push.device on /api/auth/me and in the POST /api/devices answer carries liveActivityStartToken (the server holds a push-to-start token the relay still takes) and liveActivityPushToken (it holds the legacy Live Activity push token of the direct path), booleans only, so the app re-sends a token only when the server lacks it.",
  "insights.chart-context":
    "GET /api/insights/context returns the marks a metric chart draws: medications[] (start, stop, doseChange, pause, resume with date, name, dose, estimated, href), illnesses[] (acute episodes, start, end, label, href) and cyclePhases[] (phase, start, end inclusive), read from the timeline lanes, each empty when its module is off or its section not shared; optional from/to cut the window.",
  "account.dismissed-hints":
    "GET /api/auth/me carries dismissedHints, the ids of the one-time hints the account has closed (a family such as timeline-readiness, or family.member such as i18n-banner.fr); PATCH /api/auth/me/dismissed-hints with dismiss and/or restore changes it and answers the stored list. Restoring a family restores its members. Show a hint only while neither its id nor its family is listed.",
  "daily.morning":
    "GET /api/daily/morning returns the morning read: lead (rank 0 to 10, key, one sentence, language) chosen by fixed rules from the day's own readings, cards night and today_different with ring (score and band null unless fresh, asOfDay), up to three lines and sourceValues (device scores under the vendor's name and scale, no band), and scores.sleep / scores.readiness (ring, one line, href; null when the record has no such score) for the start page's score tiles beside DailyDigest.score.",
  "measurements.series-kinds":
    "GET /api/measurements/series takes kinds=a,b,c (at most 8, each once, the same days) in place of kind and answers { series: [...] }, one single-kind answer per kind in the order asked; kind alone keeps the single answer.",
  "devices.ignored-fields":
    "The POST /api/devices answer carries ignored: [{ field, code }] when it left an optional Live Activity field out instead of failing the registration: field is liveActivityPushToken, liveActivityStart, liveActivityTokens or liveActivityTokens[<index>]; code is devices.register.invalid_field for the shape, else the devices.push.<reason> a push-to-start statement was refused for. Absent when nothing was left out.",
  "insights.briefing-glucose":
    "The daily briefing's signalsOfDay and keyFindings rows may carry sourceMetric glucose (blood glucose), its figures and delta in the reader's glucose unit; before it the server dropped every such row.",
  "medication.side-effect-headache":
    "Medication side effects take entry HEADACHE (category COGNITIVE) on POST /api/medications/{id}/side-effects, and the list and the backup carry it.",
  "medication.low-stock-trigger":
    "GET /api/medications and GET /api/medications/{id} (and the create and edit answers) carry lowStockTriggerDays: max(lowStockRunwayDays, reorderLeadDays + one dose-interval) with the medication's own lead over the account default, null when the alert is off or nothing is consumed on a cadence; a row is low on stock when runwayDays <= lowStockTriggerDays.",
  "insights.score-origin":
    "RECOVERY_SCORE, STRESS_SCORE and STRAIN_SCORE values on GET /api/insights/derived carry origin (estimate | device | computed) and deviceSource (the measurement source of a device value, else null); the health score composite carries weights (one { id, weight } per counted pillar, summing to 1) and each snapshot healthScore.pillars row its weight (null when it did not count); every scored pillar carries its own band (green | yellow | red), resolved on the server: value.band on the score report's pillars (/api/analytics) and band on each snapshot healthScore.pillars row (null when it did not count).",
  "daily.asks":
    "GET /api/daily/digest carries asks: every row the start page asks today, often none (kind, tier safety | decision | due, itemKey, title, body, subject, exactly two actions with the primary first, learnMore), ranked on the server, never capped or folded; render as delivered, no card when empty. Later is dose.snooze:<medicationId> on a dose and ask.later:<dismissKey> on other reminders; the admin rows (push_relay, server_setup) come only to a browser session.",
  "daily.scores-short-labels":
    "Each start-page score carries shortLabel, its short name for a tile from the score registry, worded in the response language: GET /api/daily/morning scores.sleep and scores.readiness, and GET /api/daily/digest score (the Health score). Render it as is; the web shows the same words.",
  "dashboard.tile-comparison-bands":
    "GET /api/dashboard/snapshot carries tiles.comparison: per ranged tile (weight, bp, pulse when it shows the resting heart rate) avg7 and avg30 as { band: good | fair | low | null, side: above | below | null }, placed in targetBands by the same rule as tiles.attention (bp is the side further from its band), and line, the deviation line in the response language, non-null only while tiles.attention[id] is range (avg7's side, else avg30's). Colour the comparison lines and show the line as served.",
};
