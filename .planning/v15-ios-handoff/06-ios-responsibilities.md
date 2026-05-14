---
file: 06-ios-responsibilities.md
purpose: Exhaustive list of what the native iOS app owns — everything the server cannot or will not do for the client.
when_to_read: First, before any iOS implementation. Defines the boundary so iOS Claude doesn't accidentally reinvent server features (see 07-server-responsibilities.md for the inverse).
prerequisites: 02-server-architecture.md, 04-data-model.md, 05-auth-flows.md
estimated_tokens: ~4500
version_anchor: v1.4.25 / sha 49f71c92
---

# iOS Responsibilities

## TL;DR

Five domains the iOS app owns end-to-end: (1) HealthKit ingestion + permissions, (2) Keychain storage of the bearer token + biometric unlock, (3) APNs registration + payload handling, (4) offline cache + sync queue, (5) deep linking into server-rendered pages. Everything else (AI, analytics, persistence, scheduling) goes through the server.

## STOP HERE IF

- You think iOS should run its own AI / analytics / persistence layer. It should not — see `07-server-responsibilities.md` for what's already done.
- You think iOS should encrypt anything beyond the bearer token + the offline-cache blob. It should not — the server already encrypts at rest.
- You think iOS should write its own measurement validation. It should not — `mapAppleHealthEntry()` server-side is authoritative.

## Domain 1 — HealthKit ingestion

This is the **single largest iOS-only responsibility**. The server has no access to HealthKit; the iOS app is the only path Apple Health → HealthLog.

### What iOS reads from HealthKit

| MeasurementType (server)        | HKQuantityTypeIdentifier (HealthKit)            | DB unit            | Aggregation |
| ------------------------------- | ----------------------------------------------- | ------------------ | ----------- |
| `WEIGHT`                        | `HKQuantityTypeIdentifierBodyMass`              | kg                 | latest      |
| `BODY_FAT`                      | `HKQuantityTypeIdentifierBodyFatPercentage`     | %                  | latest      |
| `BODY_TEMPERATURE`              | `HKQuantityTypeIdentifierBodyTemperature`       | celsius            | latest      |
| `BLOOD_PRESSURE_SYS`            | `HKQuantityTypeIdentifierBloodPressureSystolic` | mmHg               | latest pair |
| `BLOOD_PRESSURE_DIA`            | `HKQuantityTypeIdentifierBloodPressureDiastolic`| mmHg               | latest pair |
| `PULSE`                         | `HKQuantityTypeIdentifierHeartRate`             | bpm                | mean/latest |
| `RESTING_HEART_RATE`            | `HKQuantityTypeIdentifierRestingHeartRate`      | bpm                | latest      |
| `HEART_RATE_VARIABILITY`        | `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | ms              | latest      |
| `OXYGEN_SATURATION`             | `HKQuantityTypeIdentifierOxygenSaturation`      | % (×100 from HK)   | latest      |
| `BLOOD_GLUCOSE`                 | `HKQuantityTypeIdentifierBloodGlucose`          | mg/dL              | latest      |
| `ACTIVITY_STEPS`                | `HKQuantityTypeIdentifierStepCount`             | count              | sum         |
| `ACTIVE_ENERGY_BURNED`          | `HKQuantityTypeIdentifierActiveEnergyBurned`    | kcal               | sum         |
| `FLIGHTS_CLIMBED`               | `HKQuantityTypeIdentifierFlightsClimbed`        | count              | sum         |
| `WALKING_RUNNING_DISTANCE`      | `HKQuantityTypeIdentifierDistanceWalkingRunning`| metres             | sum         |
| `VO2_MAX`                       | `HKQuantityTypeIdentifierVO2Max`                | mL/(kg·min)        | latest      |
| `SLEEP_DURATION`                | `HKCategoryTypeIdentifierSleepAnalysis`         | minutes            | sum-by-stage |
| `AUDIO_EXPOSURE_ENV`            | `HKQuantityTypeIdentifierEnvironmentalAudioExposure` | dBA           | mean        |
| `AUDIO_EXPOSURE_HEADPHONE`      | `HKQuantityTypeIdentifierHeadphoneAudioExposure`| dBA                | mean        |
| `TIME_IN_DAYLIGHT`              | `HKQuantityTypeIdentifierTimeInDaylight` (iOS 17+) | minutes         | sum         |

Source-of-truth on the server side: `src/lib/measurements/apple-health-mapping.ts`. Add a row there if iOS starts sending a new identifier; do NOT silently start sending data for a type the server doesn't know — it will return `status: skipped` per entry.

### Unit conversion — iOS pre-multiplies before sending

Two HealthKit quantities ship as 0..1 fractions; the server expects them as percentages:

- `HKQuantityTypeIdentifierOxygenSaturation` → multiply by 100 before sending.
- `HKQuantityTypeIdentifierBodyFatPercentage` → multiply by 100 before sending.

For sleep:

- `HKCategoryTypeIdentifierSleepAnalysis` ships per-stage rows. The category value (HKCategoryValueSleepAnalysis) is an integer (`inBed = 0`, `asleepUnspecified = 1`, `asleepCore = 3`, `asleepDeep = 4`, `asleepREM = 5`, `awake = 2`). Send the integer in the batch as `sleepStage` and let the server look up the canonical enum via `APPLE_HEALTH_SLEEP_STAGE_MAP`.

### Permissions per metric type

`HKHealthStore.requestAuthorization(toShare:read:)` — the iOS app asks the user **per type**, never one bulk grant. Group the request by metric category in the onboarding UX (vitals / activity / sleep / mood / etc.) so the user sees logical permission screens.

```swift
// Per-type read permissions (sample subset; expand to match the table above)
let readTypes: Set<HKObjectType> = [
    HKObjectType.quantityType(forIdentifier: .bodyMass)!,
    HKObjectType.quantityType(forIdentifier: .heartRate)!,
    HKObjectType.quantityType(forIdentifier: .stepCount)!,
    // ...
]
healthStore.requestAuthorization(toShare: [], read: readTypes) { (success, error) in /* ... */ }
```

iOS **never writes back to HealthKit** in v1.5 — read-only flow. (Write-back is on the v1.6 backlog.)

### Sample-types iOS supports vs what the enum knows

The server enum `MeasurementType` is the contract. Migrations 0051-0053 prepped server-side. iOS supports the subset above. **When Apple adds a new HK identifier (e.g. iOS 18's hypothetical new metric), iOS does NOT silently start sending it** — file a server-side change first (one entry in `apple-health-mapping.ts`), then enable on iOS.

The server returns `{ status: "skipped", reason: "unknown_hk_identifier" }` per entry the mapper doesn't know. iOS uses this to decide whether to advance its sync cursor past the row (yes — never retry it).

### Observer pattern + sync cadence

```swift
let predicate = HKQuery.predicateForSamples(withStart: lastSyncDate, end: nil)
let query = HKObserverQuery(sampleType: type, predicate: predicate) { _, _, _ in
    self.drainQueue()
}
healthStore.execute(query)
healthStore.enableBackgroundDelivery(for: type, frequency: .immediate) { _, _ in }
```

`drainQueue()` accumulates pending samples and posts a batch to `POST /api/measurements/batch` up to **500 entries per batch** (server-enforced cap). Rate limit: 60 batches per user per minute (= 30 000 rows/min headroom).

When the batch crosses 50 entries the server fires PR detection in `silent: true` mode — backfills don't spam pushes.

### Sync conflict resolution — when HK and Withings disagree

The server's two-axis source-priority picker resolves conflicts. See `16-health-score-logic.md` and `07-server-responsibilities.md`. iOS does NOT pre-resolve.

When iOS sees the same physical reading both in HealthKit (synced from a Withings Withings Health Mate app) and via the Withings direct integration, both rows land in the DB. The picker keeps one per day for cumulative metrics; for point metrics the latest of the winning source wins.

**iOS responsibility:** tag each sample with the canonical source = `APPLE_HEALTH` (per the `MeasurementSource` enum spelling — NOT `HEALTHKIT`) and the `deviceType` ∈ `watch | band | ring | phone | scale | other | unknown` derived from `HKDevice.model` on the sample.

iOS does NOT pick a winner. The server does.

## Domain 2 — Keychain + biometric unlock

### Bearer token storage

The user signs in with username + password (or passkey) → server returns a bearer token via `/api/auth/login` or `/api/auth/passkey/login-verify`. iOS stores it in **Keychain** with:

- `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — token is unlocked only when the device is unlocked, never syncs to iCloud, never restored to a different device.
- `kSecAttrAccount` = user email (so multi-account is trivial).
- Optional `LAContext` biometric prompt on first read of the day (Face ID / Touch ID).

### Token refresh

Tokens have a server-enforced 30-day TTL (see `05-auth-flows.md`). The iOS app silently refreshes via `POST /api/auth/refresh` on every app foreground when the token is within 7 days of expiry. On a 401 response from any other endpoint, fall back to the full login flow.

### Codex / OAuth tokens

If the user has connected ChatGPT OAuth on the web, the OAuth tokens are server-side. iOS does NOT see them. The iOS app only sees its own bearer token.

### What goes in iOS Keychain

| Item                          | When written              | Accessibility                                  |
| ----------------------------- | ------------------------- | ---------------------------------------------- |
| Bearer token                  | On login success          | `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` |
| Last-known refresh-token hint | On token refresh response | same                                           |
| User email                    | On login success          | same (or `UserDefaults` if you accept the leak; Keychain is safer) |
| Last HK sync cursor           | On batch sync success     | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (needed for background sync) |

What does NOT go in iOS Keychain:

- Any provider API key (Anthropic, OpenAI, etc.) — those live server-side.
- Any user health data — that lives server-side.
- The user's password — once they're signed in, the bearer token is all you keep.

## Domain 3 — APNs

The iOS app handles APNs registration + payload reception. Server-side scaffolding exists (`src/lib/notifications/senders/apns.ts`).

### Registration flow

1. App start → `UIApplication.registerForRemoteNotifications()`.
2. iOS callback → `application:didRegisterForRemoteNotificationsWithDeviceToken:` — receive an opaque `Data` blob.
3. Convert to hex string (Apple's spec — typically 64 chars).
4. POST to `/api/devices`:

```json
POST /api/devices
{
  "token": "<your-generic-device-token>",
  "bundleId": "com.healthlog.ios",
  "locale": "en",
  "appVersion": "1.5.0",
  "model": "iPhone15,3",
  "apnsToken": "<hex-encoded-apns-token>",
  "apnsEnvironment": "production"
}
```

The contract (Zod-validated):

```ts
// from src/app/api/devices/route.ts
deviceSchema = z.object({
  token: z.string().min(8).max(512).regex(/^[A-Za-z0-9+/=._:-]+$/),
  bundleId: z.string().min(1).max(128),
  locale: z.string().optional(),
  appVersion: z.string().optional(),
  model: z.string().optional(),
  apnsToken: z.string().regex(/^[A-Fa-f0-9]+$/).optional(),
  apnsEnvironment: z.enum(["sandbox", "production"]).optional(),
}).refine(/* apnsToken + apnsEnvironment supplied together or both omitted */);
```

Important:

- `apnsEnvironment` = `sandbox` for Debug builds (Xcode), `production` for TestFlight + Release. The iOS app picks — the server can't tell from the token alone.
- The composite uniqueness of `apnsToken` is enforced server-side. Re-registering a token under a different user → 409. APNs tokens are not secrets, but trusting wire input would let an attacker who learns one redirect another user's pushes.

### APNs payload schema

```json
{
  "aps": {
    "alert": { "title": "Personal Record", "body": "New all-time best: 8,420 steps" },
    "badge": 1,
    "sound": "default",
    "thread-id": "personal_record"
  },
  "eventType": "PERSONAL_RECORD",
  "metricType": "ACTIVITY_STEPS",
  "value": 8420,
  "deepLink": "healthlog://personal-records/cmp-2026-05-13-steps"
}
```

`eventType` ∈ `MEDICATION_REMINDER | MEASUREMENT_ANOMALY | COMPLIANCE_LOW | WITHINGS_SYNC_FAILED | SYSTEM_ALERT | PERSONAL_RECORD`.

`PERSONAL_RECORD` is OFF by default per user (`EVENT_DEFAULT_ENABLED.PERSONAL_RECORD = false`) — a multi-year HK backfill on first install would otherwise saturate the lock screen.

### When iOS handles tap

The `deepLink` in the payload (custom URL scheme `healthlog://`) routes the user to the relevant in-app page. For surfaces not yet on iOS, redirect to the web URL.

## Domain 4 — Offline cache + sync queue

iOS works offline-first. The HK observer fires whether or not the network is up; the iOS app queues pending batches in Core Data (or SQLite, designer's choice).

### Sync queue shape

```swift
struct PendingBatch {
    let id: UUID                    // Idempotency-Key candidate
    let entries: [BatchEntry]       // ≤ 500
    let queuedAt: Date
    let attempts: Int
    let lastError: String?
}
```

### Idempotency contract

Each batch POST carries an `Idempotency-Key` header. The server's idempotency middleware caches the response for 24 hours; an HTTP-level retry replays the cached response. iOS uses this when reconnecting after a flaky network.

```swift
var request = URLRequest(url: batchUrl)
request.setValue(batch.id.uuidString, forHTTPHeaderField: "Idempotency-Key")
// ...
```

Per-entry idempotency (server-enforced via the `(user_id, type, source, external_id)` composite unique index): two devices uploading the same HealthKit sample produce `status: "duplicate"` on the second post, not an error. The iOS client advances its sync cursor past both.

### Offline read cache

What iOS caches locally for offline display:

| Data                              | Storage         | TTL                |
| --------------------------------- | --------------- | ------------------ |
| Last `HealthScoreResult`          | UserDefaults / Core Data | until next sync   |
| Last `AIInsightResponse` per page | Core Data       | until next sync   |
| Recent measurements               | Core Data       | rolling 90 days   |
| Medications + intake schedule     | Core Data       | until next sync   |
| User profile (`User.timezone`, locale) | Keychain    | until next sign-in |

When offline, render from cache with a banner: "Showing last synced data — Tue 13 May, 14:22".

When the iOS app is online again, **the server is the source of truth** — re-fetch and replace cache, never merge.

## Domain 5 — Deep linking

The web app has rich URL structure (`/medications/[id]/history`, `/insights/blood-pressure`, `/settings/notifications`). The iOS app deep-links into these via:

1. **Native screens** — the iOS app has its own Swift versions of dashboard / Coach / Insights / Settings.
2. **Web embed** — for low-traffic settings pages the iOS team chooses not to port in v1.5, embed the web view with the bearer token forwarded via a one-time login URL.

The custom URL scheme `healthlog://` lets APNs payloads + share-sheet URLs route into specific screens.

### Recommended scheme

| URL                                              | Routes to (iOS)                          |
| ------------------------------------------------ | ---------------------------------------- |
| `healthlog://dashboard`                          | Dashboard tab                            |
| `healthlog://coach`                              | Coach tab                                |
| `healthlog://insights/blood-pressure`            | BP sub-page                              |
| `healthlog://medications/{id}`                   | Medication detail                        |
| `healthlog://medications/{id}/history`           | (v1.5: web embed; v1.6: native screen)   |
| `healthlog://personal-records/{recordId}`        | PR detail                                |
| `healthlog://settings/notifications`             | Notification preferences                 |

Universal Links (HTTPS) are a nice-to-have on top of the custom scheme but not required for v1.5.

## Settings / preferences sync

The server owns the user's preferences (CoachPrefs, locale, timezone, notification preferences). iOS reads + writes via:

- `GET /api/user/profile` — full user shape.
- `PATCH /api/user/profile` — partial update.
- `GET /api/insights/settings` — provider chain + Coach prefs.
- `PATCH /api/insights/settings` — same.
- `GET /api/notifications` — channel + event preferences.
- `PATCH /api/notifications` — same.

Local-only iOS settings (e.g. "use biometric on app open", "show HK sync progress indicator") live in `UserDefaults` and do NOT sync to the server.

## App-store metadata (out of scope for this doc)

- App ID, bundle ID, capabilities (HealthKit, Push, Background fetch).
- Privacy nutrition labels.
- ATS exception entries if any (none expected — server is HTTPS).
- TestFlight beta groups.

## Background tasks

iOS uses `BGAppRefreshTask` + `BGProcessingTask` for periodic sync:

```swift
// Register on app launch:
BGTaskScheduler.shared.register(forTaskWithIdentifier: "com.healthlog.sync", using: nil) { task in
    self.handleSync(task: task as! BGAppRefreshTask)
}

// Schedule on app background:
let request = BGAppRefreshTaskRequest(identifier: "com.healthlog.sync")
request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)  // 15 min
try? BGTaskScheduler.shared.submit(request)
```

The HK observer keeps fresh data flowing without explicit scheduling, but `BGProcessingTask` is the catch-net for offline-mode catch-up + cache refresh.

## What iOS does NOT do

| Concern                             | iOS does NOT                                | Server does                            |
| ----------------------------------- | ------------------------------------------- | -------------------------------------- |
| AI provider calls                   | Never (no SDK)                              | All Insight / Coach / Briefing         |
| Insight generation                  | Never                                       | `provider-runner.ts`                   |
| Prompt building                     | Never                                       | `src/lib/ai/coach/`, `src/lib/ai/prompts/` |
| Refusal heuristics                  | Never (server returns refused-prose)        | `src/lib/ai/coach/refusal.ts`          |
| Safety contract enforcement         | Never                                       | `safety-contracts.*.yaml`              |
| Source-priority resolution          | Never                                       | `src/lib/analytics/source-priority.ts` |
| Health-score math                   | Never (renders only)                        | `src/lib/analytics/health-score.ts`    |
| Withings sync                       | Never                                       | `src/lib/withings/`                    |
| PR detection                        | Never                                       | `src/lib/personal-records/`            |
| GLP-1 PK math                       | Never                                       | `src/lib/medications/glp1-pk.ts`       |
| Medication titration ladder         | Never                                       | server                                 |
| Audit log                           | Never                                       | `src/lib/auth/audit.ts`                |
| Rate limiting                       | Never (server enforces; iOS handles 429)    | `src/lib/rate-limit.ts`                |
| i18n translation                    | App-bundle only (sees `messages/<locale>.json` via SwiftGen or hand-port) | server-translator + flat files        |
| Personal Record detection           | Never                                       | `pr-detection-worker.ts`               |
| Notification dispatcher             | Never (iOS handles APNs payload only)       | `notifications/dispatcher.ts`          |

## MDR-critical iOS warnings

The iOS app could accidentally cross the MDR line by:

1. **Generating its own Coach reply / Insight** — if iOS calls Anthropic/OpenAI directly with the user's data, it bypasses every safety contract. **Don't.**
2. **Summarising Coach replies** — the MI tone + disclaimer + evidence block are the safety surface. A "smart summary" that drops them violates the contract. **Don't.**
3. **Drug-level chart in a widget / Siri shortcut** — the Research-mode AreaChart is gated by a disclaimer + acknowledgment dialog. A widget that surfaces the curve without the dialog crosses the line. **Don't.**
4. **iOS-side "regenerate" of a cached Insight without provider call** — if iOS shows a fabricated "regenerated" reply (e.g. randomly permuting findings), it's no longer evidence-grounded. **Don't.**
5. **iOS-side editing of medication doses** — the medication detail screen on iOS may ALLOW the user to log + edit their OWN entries, but it must NEVER offer recommendations or smart-fill "next dose" values. **Don't.**
6. **Apple Watch complication that shows a drug-level chip** — same line as #3. The phase chip is gated by Research Mode acknowledgment; a complication that shows it without the dialog is a violation. **Don't.**

When in doubt: **the iOS app is a thin client over server-rendered intelligence**. The server is the medical-information custodian; iOS is the presentation layer + the HK adapter.

## "Since v1.4.24" diff markers

- **NEW v1.4.25** — `MeasurementType` enum gained `AUDIO_EXPOSURE_ENV`, `AUDIO_EXPOSURE_HEADPHONE`, `TIME_IN_DAYLIGHT` for HK + Withings parity.
- **NEW v1.4.25 W8c** — `Measurement.deviceType` column; iOS now SHOULD send `deviceType` per row (optional, defaults to `null` = unknown).
- **NEW v1.4.25 W16c** — `PERSONAL_RECORD` event type for APNs; default OFF.
- **NEW v1.4.25 W10** — batch ingest rate limit 60/min per user (was unbounded).
- **NEW v1.4.25 W17b/c** — Withings now syncs Activity v2 + Sleep v2 — iOS should be aware that some HK metrics may arrive via the Withings path (no action required, but the source-priority picker now matters more).

## iOS implementation checklist

1. **HealthKit observer** for every supported sample type; pre-multiply OxygenSaturation and BodyFatPercentage by 100; tag `deviceType` from `HKDevice.model`.
2. **Batch sync** with `Idempotency-Key` header, ≤500 entries per batch, retry on network error.
3. **Keychain bearer** with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; biometric prompt optional.
4. **APNs register** on launch, post to `/api/devices` with `apnsToken` + `apnsEnvironment`.
5. **Offline cache** for Health Score + last Insight + recent measurements; render from cache when offline with banner.
6. **Deep link** custom scheme `healthlog://` for APNs taps + share-sheet URLs.
7. **No LLM SDK** in the iOS bundle. Period.
8. **No medication recommendation surface** anywhere in the iOS UI. Period.

## Self-test snippet

```bash
# Verify the iOS-batch-ingest contract from curl:
curl -X POST http://localhost:3000/api/measurements/batch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "entries": [{
      "hkIdentifier": "HKQuantityTypeIdentifierStepCount",
      "value": 8420, "unit": "count",
      "startDate": "2026-05-13T08:00:00Z",
      "endDate": "2026-05-13T20:00:00Z",
      "externalId": "uuid-from-HKSample-uuid",
      "deviceType": "watch"
    }]
  }'
# Expected: { "results": [{ "index": 0, "status": "inserted" }] }
```

## Cross-references

- **04-data-model.md** — `Measurement` table schema, `Device` table schema.
- **05-auth-flows.md** — bearer token lifecycle + refresh + passkey.
- **07-server-responsibilities.md** — the inverse — everything the server already does for you.
- **14-coach-mental-model.md** — Coach is server-resident; iOS is a streaming client.
- **08-locked-contracts.md** — exact request/response schemas.
