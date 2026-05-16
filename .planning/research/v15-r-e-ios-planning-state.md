---
file: .planning/research/v15-r-e-ios-planning-state.md
purpose: iOS planning state audit — what's open in the v15 handoff pack and the iOS repo before v1.5 can ship
created: 2026-05-16
contributor: R-E
---

## Scope and method

This audit reads the 24-file `v15-ios-handoff/` pack at `/Users/marc/Projects/HealthLog/.planning/v15-ios-handoff/` end to end, walks the iOS repo at `/Users/marc/Projects/healthlog-iOS/HealthLogIOS/` Swift-file-by-Swift-file (184 files, 13 directories), cross-references the URL paths the iOS app actually calls against the live server route inventory at `/Users/marc/Projects/HealthLog/src/app/api/`, and reads the iOS-side roadmap + changelog through v0.4.1.1. The result is grouped by severity, each find carries a file-line citation on both sides where applicable, and the close-out path is concrete (one PR scope per find).

The iOS repo is far further along than the handoff pack assumes. Phases 0–7 in `.planning/ROADMAP.md` are all "in progress" or "partial", iOS CHANGELOG marks 0.4.1.1 as shipped, and the test suite reads 667 unit-and-UI tests under Swift-6 strict concurrency. The four big load-bearing pieces — login + bearer + refresh, the HealthKit → batch ingest pipeline, the SwiftData outbox + replay, and the AppContainer + APIClient + 401-bridge composition — all exist and have been audited in v0.2.x → v0.4.1.1. The gap to v1.5 is narrower than the handoff pack hinted at, and the gaps that remain cluster around three things: the Coach drawer (no native code at all), the standalone/paired pivot the v1.4.27 R1 research mandated (iOS half-built, server not started), and a handful of additive endpoint shapes the iOS code references but the server has either not yet exposed or has exposed under a different path.

## Severity counts

| Severity | Count |
|---|---|
| Critical (release-blocker) | 5 |
| High | 8 |
| Medium | 9 |
| Low | 6 |
| Total | 28 |

## Critical — release blockers

### C-1. Coach SSE drawer has zero native code

What's missing — the iOS app does not call `POST /api/insights/chat` anywhere. `grep -rn "Coach\|coach"` returns nine matches across the iOS source tree, every one of them either a deep-link route stub (`AppRouter.swift:55-58` parks `coach` on the Insights tab with a `// Coach hat noch kein eigenes Tab` note), a settings entry comment, or unrelated context (the GLP-1 PK files mention the word coach inside doc-strings only). The iOS changelog explicitly defers Coach to v0.5.0 ("Coach SSE conversational interface — XL scope + MDR-Class-IIa boundary risk requires deliberate review; v0.5.0", `HealthLogIOS/CHANGELOG.md` 0.4.0 "Deferred" section). The handoff pack treats the Coach as in-scope for v1.5 across `06-ios-responsibilities.md`, `14-coach-mental-model.md`, and `17-error-handling.md`; the marketing surface for v1.5 ("AI insights are the differentiator", `00-philosophy.md` Rule 3) is exactly the Coach.

iOS side — no `URLSession.bytes(for:)` AsyncThrowingStream client, no SSE-frame parser, no `CoachConversation` SwiftData model, no `CoachStreamEvent` decoder, no `provenance` → "What I'm looking at" disclosure, no GROUND-RULE-9-and-15 refusal-acceptance UI, no `coach.budget.exceeded` 429 surface. The Glp1 PK package has the MDR dialog primitive (`DesignSystem/MDRAcknowledgmentDialog.swift`) but no Coach screen uses it.

Server side — fully implemented at `/Users/marc/Projects/HealthLog/src/app/api/insights/chat/route.ts` plus the message-feedback endpoints. Locked contract documented in `08-locked-contracts.md` §1 (GROUND RULES) and `03-api-contracts.md` §Insights.

Close-out — one iOS slot, 3–4 days. Build `CoachService` actor over `URLSession.bytes`, the `CoachStreamEvent` AsyncThrowingStream, a SwiftData-backed `CoachConversation` cache for offline render of past turns, the streaming bubble view (Apple-Messages-style typing dots between frames), and the provenance disclosure. Reuse the existing `MDRAcknowledgmentDialog` for GROUND RULE 15 surface refusals. Add the `coach.*` locale keys to `Localizable.xcstrings`. Wire AppRouter to a real `.coach` TabIdentifier, drop the `// Coach hat noch kein eigenes Tab` short-circuit. The 5.1.2(i) Third-Party-AI consent gate (`AIConsentStore.swift` exists) already protects every LLM call site; reuse the same gate for Coach.

### C-2. iOS SyncMode + standalone-first pivot is half-built; server side is unstarted

What's missing — the v1.4.27 R1 research (handoff pack files `22-offline-first-architecture.md` and `22-standalone-and-server-pairing.md`) directs an architectural inversion: SwiftData becomes canonical, server becomes optional mirror, pairing is a user toggle. iOS has the foundation (`Stores/SyncModeStore.swift`, `Models/SyncMode.swift`, `Screens/Onboarding/ModeSelectionStep.swift`, "Standalone-mode foundation" line in 0.4.1 changelog). Server has none of the contract additions the handoff pack scopes for v1.4.28: `syncVersion Int @default(1)` on `Measurement`, `deletedAt DateTime?` soft-delete column, `/api/sync/state` endpoint, `/api/mood-entries/bulk` and `/api/medications/intake/bulk` bulk-backfill endpoints. `grep "syncVersion\|deletedAt"` returns zero hits across Prisma + server source.

iOS side — the `SyncMode` gate exists but is not honoured everywhere; the network repositories still hit the API in `.standalone` mode in many paths (the pairing flow stub uploads SwiftData rows but the everyday read paths have not been re-wired). The conflict-resolution columns the contract calls for (`syncIdentifier`, `syncVersion`, `deletedAt`) are not on the iOS `@Model` types.

Server side — the entire v1.4.28 server prep menu from `22-standalone-and-server-pairing.md` §6.2 is unstarted: column adds, the bulk endpoints, the sync-state endpoint. The locked-batch contract (`/api/measurements/batch`) will accept the iOS first-pair backfill today — but the row-level last-writer-wins semantics need server enforcement before v1.5 ships with multi-device sync claims.

Close-out — one server slot to land the Prisma migration + the two bulk endpoints + the sync-state endpoint (M effort, ~1.5 days), one iOS slot to extend `@Model` types with `syncVersion + deletedAt`, gate every repository call behind `SyncModeStore.isPaired`, build the actual pair / unpair sheet (M effort, ~2 days). Without C-2 we ship a v1.5 that markets standalone but breaks the moment the user pairs a second device.

### C-3. `/api/devices` endpoint exists server-side but only as a partial APNs surface; iOS expects a richer shape

What's missing — `Models/HealthKitSync.swift:83-113` defines `DeviceRegistration` with `token, bundleId, locale, appVersion, model, apnsToken?, apnsEnvironment?`, the contract documented in `05-auth-flows.md` §7 (Apple Health auth). The handoff pack scopes `POST /api/devices` plus `PATCH /api/devices/{id}` for APNs token rotation in `06-ios-responsibilities.md` §Domain 3. Server has `/api/devices/route.ts` and `/api/devices/[id]/route.ts` — but the v0.4.0 changelog notes "APNs-Push-Delivery gated auf Server-side `.p8` env-vars (KeyID `M9WAFLNC2U` + Team `S8WDX4W5KX` + Topic `dev.healthlog.app`)" and the v1.4.27 release notes do not confirm those secrets ever landed in Coolify. The iOS-side iOS PROJECT.md "Open Decisions / Blockers" lists APNs `.p8` as Marc-needs-to-supply.

iOS side — `Services/NotificationService.swift` + the `/api/devices` round-trip exists per 0.3.0 changelog "Wave 2b-A6 APNs + Deep Links" entry. Token hex-encoding done, env tag set, idempotency + 409-recovery wired.

Server side — code exists, but Coolify env vars (`APNS_KEY_PEM` or equivalent, plus `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`) are unconfirmed.

Close-out — Marc-action, not a code change: generate the `.p8` key in Apple Developer Portal, paste into Coolify, smoke-test from the production app. S effort, 1 hour total once the developer-portal capability is provisioned. Drops to High if there is evidence the secrets already landed.

### C-4. Refresh-token contract documents `tokenExpiresAt` as ISO-8601 with offset; iOS persists it but tests do not cover the wall-clock drift on midnight refreshes

What's missing — handoff pack `05-auth-flows.md` §2.1 commits the iOS app to "Refresh ~5 min before" the `accessTokenExpiresAt` value. iOS implementation at `Services/AuthService.swift:280-307` (`refresh()`) is single-flight via `RefreshCoordinator` and persists the new pair correctly, but the actual scheduling — the part that fires the refresh 5 min before — does not appear in the search. No `Task.detached` for the proactive refresh, no `Timer.publish(every:)`, no scene-phase watcher that schedules the next refresh on background-to-foreground. The 401-bridge in `APIClient.swift:135-158` is in place as a reactive safety net, but Marc's MEMORY notes flag silent-logout-after-24h as a v0.2.x audit find that landed `RefreshCoordinator`; the proactive window is implied but not verified.

iOS side — `RefreshCoordinator` is described in CHANGELOG 0.3.0 as the "silent-logout 24h nach Login behoben" fix, but the implementation does not appear to schedule a proactive refresh — it answers in-flight 401s only.

Server side — no server change required; the contract is intact.

Close-out — one iOS slot, ~half a day. Add a `RefreshScheduler` that schedules a one-shot `Task` for `(accessTokenExpiresAt - 5min - now())`, cancels on logout, re-schedules on every successful refresh. Unit-test the timer with a `Clock` injection. Without this find we are likely shipping the same midnight-401 bug the 0.3.0 fix promised to close.

### C-5. iOS does not call `/api/auth/me/source-priority` anywhere

What's missing — `grep -rn "source-priority\|sourcePriority\|deviceTypePriority"` returns zero matches across the iOS Swift tree. `08-locked-contracts.md` §4 is unambiguous: the iOS Settings → Sources screen renders BOTH axes (per-metric ladder + per-device-type tiebreak), writes through `PUT /api/auth/me/source-priority` with the full new ladder. The two-axis resolver shipped server-side at v1.4.25 W8c and is documented across `02-server-architecture.md`, `06-ios-responsibilities.md`, and `08-locked-contracts.md`.

iOS side — `Screens/Settings/Sub/` has a `SourcesChipStrip` (mentioned in changelog 0.4.1 "B5"), but that surface is read-only — it labels which sources contributed to a chart. The full editor that POSTs the user's preferred ladder back to the server does not exist.

Server side — `/api/auth/me/source-priority/route.ts` exists; `04-data-model.md` §4.7 documents the JSON shape.

Close-out — one iOS slot, ~1.5 days. Settings → Sources & Geräte sheet, drag-reorder lists for each metric (weight, BP, pulse, body-fat, body-temp, SpO2, HRV, RHR, VO2-max, steps, calories, distance, flights, sleep), nested device-type picker per metric. PUT-the-whole-object on save (partial updates not supported per locked contract). One Swift `Codable` mirror of `srcLibValidationsSourcePriority`.

## High

### H-1. iOS does not call `/api/personal-records`; PersonalRecord deep-link route exists but routes to a non-existent screen

What's missing — `AppRouter.swift:75-78` carries a `PersonalRecordRoute` case. `grep -rn` confirms exactly one render path that uses it (`Stores/AppRouter.swift` + `Services/DeepLinkRouter.swift`) and zero callers that actually fetch from `/api/personal-records`. `06-ios-responsibilities.md` Domain 3 lists `PERSONAL_RECORD` APNs delivery (default OFF) as live, with the iOS responsibility to render the list. Server has the endpoint, schema, and pagination behaviour documented in `03-api-contracts.md` §Personal Records.

iOS file:line — `Stores/AppRouter.swift:75-78` (deep-link case), no fetch site.
Server file:line — `/Users/marc/Projects/HealthLog/src/app/api/personal-records/route.ts`.

Close-out — one iOS slot, ~1 day. Build `PersonalRecordsStore` + `PersonalRecordsRepository` over the existing `MetricInsightsRepository` pattern, paginated list screen, navigation push from a Dashboard "Records" link + APNs deep-link.

### H-2. iOS does not call `/api/workouts/batch`; v1.4.25 ships the Workout ingest contract iOS is meant to consume

What's missing — `grep -rn "Workout\|workout"` returns exactly one match — `Services/HealthKitService.swift` mentioning the word workout in a comment. No `WorkoutWireDTO`, no `WorkoutsRepository`, no `HKWorkoutTypeIdentifier` enumeration, no `HKWorkoutRouteQuery` wiring. The handoff pack treats this as iOS-side responsibility per `03-api-contracts.md` §Workouts and `04-data-model.md` §4.2; the server is fully ready (`/api/workouts/batch/route.ts`, 100-workouts-per-batch + 20k-points-per-LineString + 5MB body cap + composite-unique dedup).

iOS file:line — no implementation.
Server file:line — `/Users/marc/Projects/HealthLog/src/app/api/workouts/batch/route.ts`.

Close-out — one iOS slot, ~2 days. `HKWorkoutQuery` + `HKWorkoutRouteQuery` plumbing, `WorkoutBatchEntryDTO` mirror, route-LineString → GeoJSON encoder, batch uploader on the same throttle pattern as `MeasurementBatchUploader`. Defer the iOS Workout UI to v1.6 — the contract requires ingest only for v1.5.

### H-3. iOS calls `/api/medications/intake` legacy path but the per-medication subroutes are richer

What's missing — `MedicationsRepository.swift:31,53` calls `/api/medications/intake` (legacy top-level POST) and `/api/medications/{id}/intake`. Server now has a much richer per-medication surface: `intake`, `intake/[eventId]`, `intake/import`, `intake/purge`, `inventory`, `inventory/[itemId]`, `phase-config`, `side-effects`, `side-effects/[logId]`, `titration`, `glp1`, `cadence`, `compliance`, `api-endpoint`. iOS uses `glp1` (one call site at line 40) and nothing else. The v1.4.25 W19 inventory + side-effects work is on the server; iOS has no UI for either.

iOS file:line — `Repositories/MedicationsRepository.swift:25-58`.
Server file:line — `/Users/marc/Projects/HealthLog/src/app/api/medications/[id]/*`.

Close-out — one iOS slot, ~2 days. The MedicationDetailScreen exists per 0.4.0 changelog "Stream Delta", so the read paths can fan out the new sub-endpoints in there. The pen inventory tile, side-effects logbook, and reminder phase-config sheet are net-new UI but the screen frame is already there.

### H-4. iOS does not call `/api/auth/me/coach-prefs` or `/api/auth/me/doctor-report-prefs`

What's missing — both endpoints documented in `03-api-contracts.md` §Auth; iOS calls neither. `CoachPrefs` shape (`{tone, verbosity, excludeMetrics[], showEvidenceByDefault}`) is documented in `04-data-model.md` §6 as iOS read+write. `doctorReportPrefsJson` is documented as iOS read-only for v1.5 but iOS does not read it either. The Doctor Report screen has the PDF download but no preferences hand-off.

iOS file:line — no implementation.
Server file:line — `/Users/marc/Projects/HealthLog/src/app/api/auth/me/coach-prefs/route.ts`, `/Users/marc/Projects/HealthLog/src/app/api/auth/me/doctor-report-prefs/route.ts`.

Close-out — half a day; one Swift store per surface, settings sheet wiring. Becomes a clean dependency-resolve once C-1 (Coach) lands — CoachPrefs is what the Coach reads to configure tone + verbosity per turn.

### H-5. `mood-entries` POST shape — iOS sends `tags: ["note:<text>"]` instead of a proper `note` field

What's missing — `Models/Mood.swift:65` documents the workaround verbatim: *"Server hat kein dediziertes Note-Field — wir packen es als spezial-Tag `note:...`"*. The Coach SNAPSHOT and Insights generation parse mood tags; a note-as-tag entry contaminates the tag axis and the LLM sees it. Either the server adds a `note` column or iOS commits to the tag-prefix hack permanently.

iOS file:line — `Models/Mood.swift:62-67`.
Server file:line — `/Users/marc/Projects/HealthLog/src/app/api/mood-entries/route.ts`.

Close-out — one server slot, M effort, ~0.5 day. Add `note TEXT NULL` to `MoodEntry`, extend Zod, regenerate OpenAPI, iOS migrates the read+write paths in one PR. Until then this is a high-severity latent bug — the LLM is reading "note:Heute schlecht geschlafen" as a tag, not as prose.

### H-6. iOS does not call `/api/insights/comprehensive` daily-briefing `force=true` refresh consistently

What's missing — `Stores/DailyBriefingStore.swift` per the 0.4.0 changelog "Stream Golf" entry lazy-generates via `POST /api/insights/generate` with a 24h SwiftData SWR cache + `force=true`. Inspection of the actual repository surface in the iOS code shows the `force=true` is wired into the regenerate button, but the cache-invalidation rule the handoff pack scopes ("fresh insight generation evicts stale; mutation invalidates every read query that touches the resource", `feedback_cache_invalidate_on_new`) is partially observed only — Insights cards do not invalidate when a Measurement is added.

iOS file:line — `Stores/DailyBriefingStore.swift`, `Cache/CacheInvalidator.swift`.
Server file:line — `/Users/marc/Projects/HealthLog/src/app/api/insights/generate/route.ts`.

Close-out — one iOS slot, S effort, ~0.5 day. Extend `CacheInvalidator` matrix with the cross-resource fan-out documented in `13-state-management.md` §3.

### H-7. iOS does not surface the Withings `hasActivityScope` reconnect banner

What's missing — `Screens/Settings/WithingsIntegrationScreen.swift` reads `/api/withings/status`; the response carries `hasActivityScope` per `03-api-contracts.md` §Withings. The legacy v1.4.24 connection scope (`user.metrics` only) shows up as `hasActivityScope: false` and iOS should surface the reconnect banner per `06-ios-responsibilities.md` § Withings.

iOS file:line — `Screens/Settings/WithingsIntegrationScreen.swift:128` (`WithingsStatus` mirror).
Server file:line — `/Users/marc/Projects/HealthLog/src/app/api/withings/status/route.ts`.

Close-out — one iOS slot, S effort, half a day. Read the field, render the banner, deep-link the user to the web OAuth flow in `SFSafariViewController`.

### H-8. iOS does not handle the v1.4.25 OpenAPI hard-flip gate at all

What's missing — the contract-diff loop documented in `09-recommended-flow.md` §2 is the iOS team's working pattern: regenerate Swift codegen from `docs/api/openapi.yaml`, rebuild, fix breaks. iOS today does not codegen — it hand-writes DTOs. The handoff pack says the codegen is the v1.5 target (`docs/api-contract.md` in iOS repo says verbatim "TODO Phase 1: DTO-Codegen via openapi-generator oder swift-openapi-generator verdrahten. Manuelle DTOs sind Zwischenstand"). Every drift bug enumerated in the 0.2.0 + 0.3.0 changelogs was a missed-codegen-step bug.

iOS file:line — `HealthLogIOS/docs/api-contract.md` line 12 (TODO).
Server file:line — `/Users/marc/Projects/HealthLog/docs/api/openapi.yaml` (regenerated via `pnpm openapi:generate`).

Close-out — one iOS slot, M effort, ~1 day. Wire `swift-openapi-generator` into XcodeGen + CI, regenerate all DTOs, port the hand-written shapes to the generated ones. The diff catches at least the next two drift bugs before they ship.

## Medium

### M-1. iOS Measurement enum knows 10 of 29 server-side measurement types

What's missing — `Models/MeasurementDTO.swift:45-56` `ServerMeasurementType` enumerates 10 values. Server-side at v1.4.25 the enum has 29 (`04-data-model.md` §2.1: WEIGHT, BLOOD_PRESSURE_SYS, BLOOD_PRESSURE_DIA, PULSE, BODY_FAT, SLEEP_DURATION, ACTIVITY_STEPS, BLOOD_GLUCOSE, TOTAL_BODY_WATER, BONE_MASS, OXYGEN_SATURATION, HEART_RATE_VARIABILITY, RESTING_HEART_RATE, ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED, WALKING_RUNNING_DISTANCE, VO2_MAX, BODY_TEMPERATURE, FAT_FREE_MASS, FAT_MASS, MUSCLE_MASS, SKIN_TEMPERATURE, PULSE_WAVE_VELOCITY, VASCULAR_AGE, VISCERAL_FAT, AUDIO_EXPOSURE_ENV, AUDIO_EXPOSURE_HEADPHONE, TIME_IN_DAYLIGHT).

The wire-converter (`Services/HealthKitWireConverter.swift`) handles 16 of 19 HK identifiers — so the iOS HK ingest path is fine. The gap is `MeasurementWireDTO.type` for read-back: 19 enum values that exist on the server today cannot be decoded by `JSONDecoder` without a 422 throw. The `MetricKind` domain enum extends to `.sleep` and `.steps` per 0.4.0 changelog A4 fix.

Close-out — one iOS slot, M effort, ~half a day. Extend `ServerMeasurementType` to all 29 values, extend `MetricKind` map, add a `case .unknown(String)` fall-through so a future server enum value never breaks the read path. Solved cleanly by codegen (H-8).

### M-2. iOS lacks the seven new v1.4.25 measurement types in the HK wire converter unit-map

What's missing — `Services/HealthKitWireConverter.swift:124-196` covers most HK identifiers but does not enumerate `bodyTemperature` skin variant (`SKIN_TEMPERATURE`), `MUSCLE_MASS` (Withings-only, not HK), the `VISCERAL_FAT` "rating" unit. None of these flow via HK so the converter does not need to map them. M-1 close-out covers this.

Close-out — covered by M-1.

### M-3. The iOS `OxygenSaturation` × 100 pre-multiply lives in two places

What's missing — `Services/HealthKitWireConverter.swift:131-132,154-155` correctly maps both `bodyFatPercentage` and `oxygenSaturation` with `scale: 100`. `06-ios-responsibilities.md` §"Unit conversion" calls this out as iOS-required. Not a bug; flagged because the rule is duplicated in handoff pack documentation and could regress on the HK SDK changing its base unit.

Close-out — add a unit test that asserts `WireUnit.scale == 100` for both identifiers; flag as a regression sentinel.

### M-4. `iPad` → `phone` mapping in `deviceType` is documented but contradicts the server contract enumeration

What's missing — `HealthKitWireConverter.swift:101` maps iPad to `.phone` with the comment "iPads zählen wir zu phone". The server `deviceTypeEnum` per `04-data-model.md` §2.5 lists `watch | band | ring | phone | scale | other | unknown`. iPad is closer to `phone` than to `other` so the mapping is fine, but the handoff pack `06-ios-responsibilities.md` table does not commit to it. Server-side source-priority resolution treats `phone` as the lowest tier of point-measurement priority; an iPad-derived weight reading would lose to a watch-derived one as expected.

Close-out — add an entry to the handoff pack `06-ios-responsibilities.md` HK-device-mapping note. No code change.

### M-5. iOS `/api/integrations/healthkit` shape — `kind` is `String`, server emits raw HK identifiers; iOS swallows unknown values into `kind` verbatim per A4-fix

What's missing — handled cleanly by the 0.4.0 A4-Audit fix per CHANGELOG ("HealthKitSyncEntry.direction gains `.disabled` + raw HK-identifier `kind` strings"). The `kindDisplayName` extension handles 9 known kinds and renders unknown verbatim. Server-side route at `/api/integrations/healthkit/route.ts` enumerates more.

Close-out — extend the iOS `kindDisplayName` switch when the server adds a new default entry. Low maintenance burden.

### M-6. iOS does not render the v1.4.25 W19d side-effects logbook

What's missing — server has `/api/medications/[id]/side-effects` + `[logId]/route.ts`; iOS has no UI or store. H-3 close-out covers this.

Close-out — covered by H-3.

### M-7. iOS does not call `/api/auth/me/timezone` PUT

What's missing — `02-server-architecture.md` §"Per-user timezone" commits iOS to "reading `user.timezone` from `/api/auth/me`" and writing back via `PUT /api/auth/me/timezone`. iOS reads — `Models/User.swift:17` references the field — but does not write. A user who travels to a different timezone gets their server-side dailyBriefing anchored to the previous tz.

iOS file:line — no callsite.
Server file:line — `/api/auth/me/timezone/route.ts`.

Close-out — one iOS slot, S effort, ~2 hours. Listen to `NotificationCenter.NSSystemTimeZoneDidChange`, debounce, PUT.

### M-8. iOS does not surface `/api/insights/targets`

What's missing — server route at `/api/insights/targets/route.ts`; per-metric target ranges + current status + Coach handoff visibility flag. iOS has the "Zielwerte" page mentioned in the v1.4.21 feedback (Marc memory). No iOS callsite.

iOS file:line — no implementation.
Server file:line — `/api/insights/targets/route.ts`.

Close-out — one iOS slot, M effort, ~1 day. Wire a `TargetsRepository`, a "Zielwerte" screen on the Insights tab.

### M-9. iOS `glucoseContext` enum diverges from server's

What's missing — `Models/MeasurementDTO.swift:67-72` has `fasting | beforeMeal | afterMeal | bedtime`; server-side at `04-data-model.md` §2.3 lists `FASTING | POSTPRANDIAL | RANDOM | BEDTIME`. iOS uses `beforeMeal`/`afterMeal` (presumably an earlier server enum) which the strict Zod parser rejects with 422.

iOS file:line — `Models/MeasurementDTO.swift:67-72`.
Server file:line — `prisma/schema.prisma` GlucoseContext enum.

Close-out — one iOS slot, S effort, ~1 hour. Update enum to `FASTING | POSTPRANDIAL | RANDOM | BEDTIME`, update glucose entry UI. H-8 codegen catches this.

## Low

### L-1. iOS auth-exempt list at `APIClient.swift:230-235` does not include `/api/auth/codex/*`

What's missing — Codex OAuth is web-only per `14-coach-mental-model.md`; iOS does not call those endpoints; the auth-exempt list correctly omits them. Flagging only because the list is a foot-gun if iOS ever adds the path.

Close-out — none required.

### L-2. iOS `tagging` for `mood-entries` source — iOS hardcodes `MANUAL` (`Models/Mood.swift:44`)

What's missing — server-side mood-entries source supports more values; iOS hardcodes `MANUAL`. Defensive; documented.

Close-out — none required for v1.5.

### L-3. iOS `MeasurementSource` parser does not understand `APPLE_HEALTH_BACKFILL` or similar nonexistent server values

What's missing — none, because the server does not emit any such value. Flagged because a server v1.5+ might split backfill out — codegen (H-8) catches the day this happens.

Close-out — covered by H-8.

### L-4. iOS has no in-app surface for the v1.4.25 OpenAPI hard-flip gate's drift result

What's missing — the iOS CI does not run `pnpm openapi:check` (it cannot — pnpm is the server's tool). The drift-protection lives on the server side. iOS depends on someone running the regeneration after a server PR lands.

Close-out — H-8 close-out adds an iOS CI step that downloads + diffs `docs/api/openapi.yaml` from the server repo on every iOS PR.

### L-5. iOS `Stores/AppRouter.swift:55-58` Coach deep-link parks on Insights tab

Close-out — covered by C-1.

### L-6. iOS Spezi adoption is documented but inactive

What's missing — `HealthLogIOS/CLAUDE.md` "Spezi adoption" table commits to SpeziHealthKit + SpeziAccessGuard + SpeziScheduler + SpeziMedication. `grep -rn "Spezi"` returns five matches, all in comments. None of the four packages are linked in `Package.swift` (which has zero `dependencies` declared). The HK service is still custom (`Services/HealthKitService.swift`); the BiometricGate is custom (`Services/BiometricGate.swift`).

Close-out — optional for v1.5. Defer to v1.6 unless the Spezi packages buy something v1.5 actually needs (`docs/spezi-migration-plan.md` says Phase A-E; the iOS team can ship v1.5 entirely on the custom stack).

## Effort estimate

iOS-side total: **L (Large)** — 5 Critical + 8 High + 9 Medium finds. Best-case ~12 working days of focused iOS work; realistic ~15 working days given the iOS team's track record of finding ancillary bugs during each marathon.

Web-side total: **M (Medium)** — primary work is C-2 server prep (sync-version column, soft-delete column, two bulk endpoints, one sync-state endpoint), H-5 mood-entries `note` field, plus the C-3 APNs secrets paste-in. Best-case ~3 working days; realistic ~5 working days.

## Recommended v1.5 sprint calendar

Rough working days, not weeks. Assumes Marc + parallel sub-agent dispatch per the marathon convention.

- **Day 1–2** — server-side foundation. Land the v1.4.28 prep menu C-2 + H-5: `syncVersion` + `deletedAt` columns, `/api/sync/state`, `/api/mood-entries/bulk`, `/api/medications/intake/bulk`, `MoodEntry.note`. Tag v1.4.28 on `main`. Coolify auto-deploy + verify.
- **Day 2** (parallel slot) — APNs secrets paste-in C-3. Generate `.p8`, drop into Coolify, smoke-test from staging build.
- **Day 3–5** — iOS Coach drawer C-1 (single slot, MDR-sensitive, full focus). Streaming SSE client, conversation cache, provenance disclosure, refusal acceptance, locale keys. Ends with a TestFlight build that runs against staging.
- **Day 3–5** (parallel slot) — iOS SyncMode polish C-2 + H-1 + H-2: gate every repo path behind `SyncModeStore.isPaired`, build the pair/unpair sheet, extend SwiftData models with `syncVersion + deletedAt`, build PersonalRecords store + screen, build Workouts ingest pipeline.
- **Day 6** — iOS C-4 refresh-scheduler + C-5 source-priority editor + H-7 Withings banner. Single iOS slot.
- **Day 7** — H-3 medication sub-routes (inventory, side-effects, phase-config) + H-4 prefs sheets.
- **Day 8** — H-6 cache-invalidation matrix + H-8 OpenAPI codegen wiring + M-1/M-9 enum fixes.
- **Day 9** — Medium-severity sweep (M-3 unit-test sentinel, M-6 side-effects UI, M-7 timezone PUT, M-8 targets screen).
- **Day 10** — TestFlight build + Apple submission prep. Run the existing 3× QA pass + senior-pass + simplify-pass that the iOS repo's `README.md` commits to.

Total: **~10 working days for a TestFlight-ready v1.5.0 build, assuming clean parallel dispatch and no Apple-review surprises.** Add 3–5 days buffer for Apple review (5.1.2(i) Third-Party-AI Consent surface is already wired per `AIConsentStore.swift`, but the Privacy Policy URL + AppStore Connect "Regulated medical device" form still need user-side completion per CHANGELOG 0.3.0 "Backlog deliberately deferred").

## Blocker that pre-empts v1.5 entirely

Single hard blocker — none. Every find above is addressable inside the proposed sprint. The Apple-side blockers (Marc must supply the Developer-Portal Team ID once, the APNs `.p8`, the App Store Connect submission form) are user-actions that gate TestFlight + Production submission, not v1.5 code completeness. If the user-actions slip, the v1.5 code lands on `main` + tag, but the binary cannot ship — same posture as v1.4.27's host-side-retag deployment fallback.

The closest thing to a hard blocker is C-1 (Coach drawer). If Coach is descoped from v1.5 ("AI insights are the differentiator" is the marketing promise but the actual differentiator is the Insights cards + Health Score + Daily Briefing, all of which already ship on iOS at 0.4.1.1), then v1.5 can ship without Coach and the calendar drops to ~6 working days. The recommendation is to keep Coach in scope and treat its absence as the release blocker — without it, v1.5 is materially a v0.4.2 iOS release, not the v1.5 the handoff pack scopes for.

## Cross-references

- iOS repo CLAUDE.md: `/Users/marc/Projects/healthlog-iOS/HealthLogIOS/CLAUDE.md` — tech-stack contract.
- iOS repo ROADMAP: `/Users/marc/Projects/healthlog-iOS/HealthLogIOS/.planning/ROADMAP.md` — phase 0–9 status.
- iOS repo CHANGELOG: `/Users/marc/Projects/healthlog-iOS/HealthLogIOS/CHANGELOG.md` — v0.1.0 → v0.4.1.1.
- iOS repo server-changes log: `/Users/marc/Projects/healthlog-iOS/HealthLogIOS/docs/server-changes.md` — applied-but-uncommitted-then-committed history.
- Server v1.4.27 release closure: `/Users/marc/Projects/HealthLog/.planning/v1427-release-closure-report.md`.
- Server v1.4.28 maintainer intake: `/Users/marc/Projects/HealthLog/.planning/v1428-maintainer-feedback-intake.md`.

## Summary

Severity counts: 5 Critical, 8 High, 9 Medium, 6 Low (28 total). Top 3 gaps: Coach drawer has no native code (C-1), SyncMode pivot is half-built and the server-side migration is unstarted (C-2), source-priority editor is missing entirely from the iOS UI (C-5). iOS-side effort estimate: **L (Large)** — ~12 focused working days. Web-side effort estimate: **M (Medium)** — ~3 working days for the v1.4.28 prep menu plus the mood-note column plus the APNs secrets. Recommended v1.5 sprint length: **10 working days** plus a 3-5 day Apple-review buffer. No single hard blocker pre-empts v1.5 entirely; the only release-blocking external dependency is the APNs `.p8` paste-in, which is a 1-hour Marc-action.
