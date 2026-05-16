---
file: .planning/ios-contributor-current-brief.md
purpose: Single onboarding brief for the iOS contributor — current server state, conventions, locked contracts, what is live, what is coming in v1.4.30, what is still pending. Pass this verbatim to the iOS development assistant.
created: 2026-05-16
audience: iOS engineer + their automation
---

# HealthLog iOS contributor brief — current state

This document is the single-page orientation for anyone (engineer or
automation) working on the iOS native client at
`/Users/marc/Projects/healthlog-iOS/`. Read it once; it points at the
locked-contract pack for everything else.

## 1. The release model in one paragraph

The web app ships every functional change the iOS client depends on
incrementally in v1.4.x patches. **v1.5.0 is a version-bump-only
marker** the web tags on the day the iOS app clears Apple review.
There is no coordinated web+iOS sprint that ships together. Web and
iOS run in parallel: the web side lands a patch, deploys, and the iOS
client consumes the new surface as soon as its next TestFlight build
is ready. The web freezes after v1.4.33 (last planned patch); from
that point only hotfixes + dependency updates touch the web until iOS
launches.

## 2. Conventions every commit must honour

These apply to web AND iOS contributors, every artefact, every PR:

### Marc-Voice English

Every commit message, code comment, CHANGELOG line, in-app string,
release note, planning doc reads as the maintainer's authorship.
Terse, professional, no emojis, no marketing fluff, no personal
pronouns ("I" / "we" / "our"). When in doubt, drop one adjective and
re-read.

### Forbidden vocabulary

Banned anywhere except backticked file paths and identifiers:

- `AI`, `Claude`, `agent`, `marathon`, `wave`, `phase`, `session`,
  `subagent`, `Anthropic`

Substitute: `assistant`, `coach`, `automation`, `contributor`,
`round`, `pass`, `track`, `stream`.

Two documented exemptions live in the locale bundles only — the
provider-chooser dropdown values `settings.ai.providerOptions.anthropic`
and `settings.ai.activeProviderOptions.anthropic` render
`Anthropic (Claude)` across all six locales because the operator is
selecting the literal vendor product.

### No PII in user-facing artefacts

Maintainer name, real health figures, real target ranges, real
measurement counts do not appear in commit messages, CHANGELOG,
release notes, in-app copy, locale bundles, public docs, GitHub
releases. Use placeholders ("the maintainer", "a moderate delta",
"tens of thousands of rows") if you need to reference shape.

### iOS contract is additive only

Every server-side change must be additive to the iOS client. No
renames, no drops, no type changes on endpoints + DTO fields + Prisma
columns the iOS client reads. New columns + new endpoints are
welcome. The locked-contract reference is at
`.planning/v15-ios-handoff/08-locked-contracts.md` — read it before
touching any `/api/*` route or any Prisma model the iOS client
consumes.

### Branch + release discipline

- Commit to `develop`. Never `main` directly.
- Release via PR `develop → main`, squash on `main`, tag on `main`.
- GHCR multi-arch builds publish from `main`. The `develop`-to-`main`
  squash + tag pipeline is automated end-to-end except for the APNs
  `.p8` paste (operator action — see §6).
- No `Co-Authored-By: Claude` trailer.
- No `--no-verify`. No `--no-gpg-sign`.

## 3. What is live in production right now

Both production hosts (`healthlog.bombeck.io` and
`demo.healthlog.dev`) currently serve **v1.4.29.1**.

### Recent releases

| Tag | Headline | Notes |
|---|---|---|
| v1.4.27 | Mobile capability sweep — `<ResponsiveSheet>`, `<NativeSelect>`, `<CoachLaunchProvider>` | The mobile baseline |
| v1.4.28 | Bug-fix + scope-reduction follow-through | Retired the GLP-1 dashboard tile, the InsightAdvisorCard, the weekly-report code path. Locked-contract endpoints kept |
| v1.4.28.1 | Dashboard-save hotfix | Resolver filters retired widget ids from the saved layout on read |
| v1.4.29 | Dashboard performance + chart polish | aggregate=daily server path, AVG/SUM for cumulative HK types, pulse chart bounds, x-axis tick positions, mobile tile equal-height, drag-list compactness |
| v1.4.29.1 | Daily-step aggregation hotfix | Client-side daily aggregator branches on `CUMULATIVE_HK_TYPES` for sum vs average |

### Endpoints the iOS client may consume today (additive contracts)

Stable since their respective release tags. Every one is locked per
`.planning/v15-ios-handoff/03-api-contracts.md`.

- `POST /api/auth/login` + `POST /api/auth/login/native-token` — bearer auth flow
- `POST /api/auth/passkey/*` — passkey enrollment + login + native-token verify
- `POST /api/auth/refresh` — bearer refresh
- `GET /api/auth/me` + `PATCH /api/auth/me/*` (timezone, doctor-report-prefs, devices, source-priority, research-mode)
- `GET /api/measurements` + `POST /api/measurements` + `PATCH /api/measurements/{id}` (additive 409 on duplicate-timestamp since v1.4.28; new `from`/`to`/`aggregate=daily|weekly|monthly` query params since v1.4.28, server-side bug closed in v1.4.29)
- `GET /api/medications/[id]/intake` — read-only (FB-E1 web mount retired in v1.4.28, endpoint preserved)
- `GET /api/medications/[id]/glp1` — full DTO including `Glp1InventoryDTO` slot (FB-E2 web mount retired in v1.4.28, DTO preserved)
- `POST /api/insights/generate` — assistant regen path (FB-J2 advisor card retired in v1.4.28, endpoint preserved for iOS)
- `GET /api/insights/chat` (SSE) — Coach stream
- `GET /api/insights/cards`, `GET /api/insights/correlations`, `GET /api/insights/comprehensive`, `GET /api/insights/targets`
- `POST /api/workouts/batch` — batch ingest from HKWorkout (since v1.4.25 W8d; canonical-row picker added in v1.4.30 — see §4)
- `GET /api/version` — live build + `offlineGeoEnabled` flag
- 47 distinct paths total per the R-E iOS audit (`/Users/marc/Projects/HealthLog/.planning/research/v1428-r1-ios-contracts.md` enumerates them; mostly admin + monitoring routes not iOS-relevant)

### Server-side cumulative-type aggregation already in place

Since v1.4.29 the server's `GET /api/measurements?aggregate=daily|weekly|monthly`
path reduces with `SUM` for cumulative HealthKit types — see the
`CUMULATIVE_HK_TYPES` set in `src/lib/measurements/apple-health-mapping.ts`:

- `ACTIVITY_STEPS`
- `ACTIVE_ENERGY_BURNED`
- `FLIGHTS_CLIMBED`
- `WALKING_RUNNING_DISTANCE`
- `TIME_IN_DAYLIGHT`

Every other measurement type reduces with `AVG`. The client-side
daily aggregator in `health-chart.tsx` follows the same branch since
v1.4.29.1.

## 4. What is incoming in v1.4.30 (currently being implemented)

v1.4.30 is the iOS-coordinated foundation patch. Ships in 2-3 days.
Every change additive. Track the canonical scope at
`.planning/v15-strategic-plan.md` §2 "v1.4.30 — iOS-coordinated
foundation".

### Daily-Stats externalId — the cutover for cumulative HK types

The biggest single iOS-side coordination point. v1.4.30 ships:

- A new helper `dailyStatsExternalId(hkIdentifier, dateYYYYMMDD)`
  returning `"stats:<HKQuantityTypeIdentifier>:<YYYY-MM-DD>"` — locked
  in `.planning/v15-ios-handoff/08-locked-contracts.md`. The shape is
  the iOS-side contract for one-row-per-day-per-cumulative-type ingest.

- The server tolerates BOTH ingest shapes during the cutover: existing
  per-sample rows AND new daily-aggregated rows. The existing
  `@@unique([userId, type, measuredAt, source, sleepStage])` constraint
  keeps both shapes deduplicated.

- A drain script `scripts/drain-per-sample-cumulative.ts` (CLI + admin
  endpoint `POST /api/admin/drain-per-sample-cumulative`) idempotently
  collapses existing per-sample APPLE_HEALTH cumulative rows into one
  daily row per type per user-calendar-day. Operator runs it once
  after the iOS TestFlight build cuts over.

### iOS-side responsibility (please implement in the next TestFlight build)

Build a `HealthKitStatisticsService.swift` per R-A §5:

- For every `CUMULATIVE_HK_TYPES` member, run
  `HKStatisticsCollectionQuery` with
  `intervalComponents: DateComponents(day: 1)` and
  `options: .cumulativeSum` (for steps / energy / flights / distance /
  daylight). Period: from each user's `firstSampleAt` or sensible
  bound (last 365 days for first install, anchored for incremental
  syncs).
- For each daily bucket, POST one row via the existing
  `POST /api/measurements` (or the batch endpoint) with:
  - `type` = mapped MeasurementType
  - `source` = `APPLE_HEALTH`
  - `value` = day total
  - `measuredAt` = midday UTC of the user's calendar day (matches the
    Withings activity-sync convention)
  - `externalId` = `"stats:<hkIdentifier>:<YYYY-MM-DD>"`
- Keep a per-day last-posted-value cache. On a late-watch-sync where
  the day's total changes after the row was first posted, send a
  `PATCH /api/measurements/{id}` (or re-POST with the same
  `externalId` to trigger an UPSERT) so the server row tracks the
  true total.
- Gate behind a build-flag `ENABLE_DAILY_STATS` — default ON for the
  cut-over TestFlight build. This stops sending per-sample rows for
  cumulative types simultaneously.

Spot metrics (BP, weight, pulse, mood, glucose, body fat, sleep)
stay per-sample as today.

### SyncMode foundation

For the standalone-first / paired-with-server / cloud-sync trio (see
`.planning/v15-ios-handoff/22-standalone-and-server-pairing.md`).
v1.4.30 ships:

- New columns: `Measurement.syncVersion Int @default(1)` +
  `Measurement.deletedAt DateTime?` (soft-delete)
- New columns: `User.lastSyncedAt DateTime?`
- New endpoint `GET /api/sync/state` — returns per-user current
  `syncVersion` and `lastSyncedAt` so iOS can decide whether to pull
  or push.
- New endpoints `POST /api/mood-entries/bulk` and
  `POST /api/medications/intake/bulk` — bulk-backfill paths for the
  pair-fresh-server flow.

### MoodEntry.note as a first-class column

Replaces the `tags: ["note:<text>"]` workaround. The iOS app currently
encodes mood notes as a tag prefix; in v1.4.30+ the iOS app should
send `note: string` directly on the mood-entry payload. Server-side
backfill collapses the prior `note:`-tag rows into the new column.

### Workout canonical-row picker

`pickCanonicalWorkoutRows()` lands in `src/lib/measurements/` to
dedup Apple Watch + Withings ScanWatch workouts that report the same
session. iOS-side workout ingest stays unchanged — the server picks
the canonical row.

### Categorisation overlay

`src/lib/measurements/categories.ts` is a TypeScript map of
MeasurementType → category (vitals / body / activity / sleep /
hearing / environment / cardiovascular / metabolic / mood /
medication). iOS HealthKit permission picker should derive its groups
from this map; the web Insights nav will too. iOS-side: read the map
on app launch (or build-time-codegen it from the server's OpenAPI
schema).

### Two new MeasurementType enums

- `WALKING_STEADINESS` (mapped from `HKQuantityTypeIdentifierAppleWalkingSteadiness`)
- `AUDIO_EXPOSURE_EVENT` (mapped from `HKCategoryTypeIdentifierAudioExposureEvent`)

iOS-side: these will land in the iOS app's `MeasurementType` mirror
enum after the OpenAPI codegen wiring closes (R-E H-8). Until then,
iOS can ignore them or the manual enum-extension matches the server
addition.

## 5. What is incoming in v1.4.31 - v1.5.0

Plan reference: `.planning/v15-strategic-plan.md` §2. Every change
listed below is additive on the iOS contract unless explicitly
flagged otherwise — and nothing is flagged otherwise. By v1.5.0 every
endpoint + DTO + Prisma column listed here is live in production. The
iOS-side implementation can be written against the planned surfaces
in parallel, ready to consume each one as soon as the corresponding
web patch deploys.

### v1.4.31 — Operator toggles + insights tab-strip blocking + Coolify auto-deploy fix

**New API surface (iOS can consume from v1.4.31 onwards):**

- `GET /api/feature-flags` — public endpoint (auth-required but no
  admin gate). Response shape:
  ```json
  {
    "data": {
      "assistant": {
        "enabled": true,
        "coach": true,
        "briefing": true,
        "insightStatus": true,
        "correlations": true,
        "healthScoreExplainer": true
      }
    }
  }
  ```
  iOS calls this on app launch and caches per-session. When any flag
  is `false`, the relevant iOS surface should hide (Coach tab, daily
  briefing card, per-metric insight status, correlation card,
  delta-explainer `?`).

**Endpoints that may now return 403 with `errorCode: "assistant.disabled.<surface>"`:**

| Endpoint | Flag |
|---|---|
| `GET /api/insights/chat` (SSE) | `coach` |
| `POST /api/insights/generate` | `coach` (regenerate is part of the Coach feature set) |
| `GET /api/insights/comprehensive` | `coach` |
| `GET /api/insights/briefing` (if exists; per v1.5 research) | `briefing` |
| `GET /api/insights/cards` per-metric status | `insightStatus` |
| `GET /api/insights/correlations` | `correlations` |
| (No endpoint for healthScoreExplainer — it's a pure client-side overlay) | `healthScoreExplainer` |

**iOS handling**: catch 403 + `errorCode: "assistant.disabled.<surface>"`,
render a neutral "Coach is disabled by your operator" / "Briefing is
disabled by your operator" view in the affected slot. No retry, no
backoff — wait for the user to navigate elsewhere.

**Other v1.4.31 items (not iOS-facing):**
- Insights tab-strip blocking fixes (web client only)
- Coolify auto-deploy investigation (ops only)

### v1.4.32 — HealthKit Tier 1 web surfaces wave A

The web surfaces for Workouts + 5 of the 10 invisible-but-stored
metrics land here. **No new endpoints**; iOS continues consuming the
existing endpoints. The contracts iOS plans against:

- `POST /api/workouts/batch` (live since v1.4.25 W8d) gains the
  server-side `pickCanonicalWorkoutRows()` dedup (landed in v1.4.30).
  iOS keeps its existing batch shape.
- `GET /api/workouts` (if not already live — check the route file in
  v1.4.30 verification) — list workouts. iOS can mirror the new web
  workout-list page.
- `GET /api/workouts/{id}` — workout detail with cross-source merged
  payload, route GPS optional, HR-zone samples optional. iOS-side
  workout detail screen consumes this shape.
- `GET /api/measurements?type=HRV` (and same for RestingHR, SpO2,
  BodyTemperature, ActiveEnergyBurned) — all already live since the
  type was added to the enum. iOS-side chart cards consume the same
  `/api/measurements` path it uses for every other type.

### v1.4.33 — HealthKit Tier 1 web surfaces wave B + web freeze marker

The breadth wave + the editor parity surfaces. iOS can consume:

**Existing endpoints with new MeasurementType values flowing through them:**

- `GET /api/measurements?type=FLIGHTS_CLIMBED` — daily-aggregated
  cumulative-type shape per R-A.
- Same for `WALKING_RUNNING_DISTANCE`, `AUDIO_EXPOSURE_ENV`,
  `AUDIO_EXPOSURE_HEADPHONE`, `TIME_IN_DAYLIGHT`.
- `GET /api/measurements?type=WALKING_STEADINESS` — new MeasurementType
  added in v1.4.30; iOS picks this up via the v1.4.30 codegen extension.
- `GET /api/measurements?type=AUDIO_EXPOSURE_EVENT` — same.

**Source-priority editor parity:**

- `GET /api/auth/me/source-priority` and `PUT /api/auth/me/source-priority`
  — both live and locked since v1.4.25 W8c. iOS implementation of the
  two-axis editor under Settings → Sources & Devices can be built
  against the existing API; the web-side editor that lands in v1.4.33
  is a reference shape iOS can mirror.

**HKStateOfMind round-trip:**

- `POST /api/measurements` with `type=MOOD` and `source=APPLE_HEALTH`
  — already live since the MOOD type exists. v1.4.33 wires
  `/insights/stimmung` to surface APPLE_HEALTH-sourced mood entries
  cleanly. iOS-side: write HKStateOfMind samples via the existing
  POST path; read back via `GET /api/measurements?type=MOOD`. The
  `HKMetadataKeyExternalUUID` round-trip filter (per R-F open Q #5)
  prevents iOS from re-uploading its own samples.

### v1.5.0 — version-bump-only marker

Tags when the iOS app clears Apple review. CHANGELOG entry: "iOS
native client now live on the App Store; web functionality unchanged
since v1.4.33." Triggers a GHCR rebuild so the running image's
`/api/version` sentinel matches the public tag. **No source diff,
no API change, no DTO change.** From this point every web change
coordinates with iOS.

## 5b. Forward state at v1.5.0 — what the iOS app can rely on

By the time v1.5.0 ships, every iOS-facing surface listed below is
live and locked. The iOS engineer can plan the full v1.5 feature
set against this state — there are no further additive contracts
planned for v1.4.x.

### Endpoints (locked + additive only)

| Path | Method | Status by v1.5.0 |
|---|---|---|
| `/api/auth/login` | POST | Stable since v1.4.x |
| `/api/auth/login/native-token` | POST | Stable since v1.4.23 |
| `/api/auth/passkey/enrolment/start` | POST | Stable |
| `/api/auth/passkey/enrolment/finish` | POST | Stable |
| `/api/auth/passkey/login-start` | POST | Stable |
| `/api/auth/passkey/login-verify` | POST | Stable |
| `/api/auth/refresh` | POST | Stable |
| `/api/auth/me` | GET, PATCH | Stable |
| `/api/auth/me/timezone` | PATCH | Stable |
| `/api/auth/me/source-priority` | GET, PUT | Locked v1.4.25 W8c |
| `/api/auth/me/research-mode` | GET, PATCH | Stable |
| `/api/auth/me/doctor-report-prefs` | GET, PATCH | Stable |
| `/api/auth/me/devices` | GET | Stable |
| `/api/auth/me/devices/{id}` | PATCH, DELETE | Stable |
| `/api/measurements` | GET, POST | Stable; `from`/`to`/`aggregate` query params live since v1.4.29 |
| `/api/measurements/{id}` | PATCH | Stable; 409 on duplicate-timestamp since v1.4.28 |
| `/api/measurements/by-external-ids` | DELETE | Stable; used by drain script + iOS sync |
| `/api/mood-entries` | GET, POST | Stable; `note` column lands in v1.4.30 |
| `/api/mood-entries/bulk` | POST | NEW in v1.4.30 |
| `/api/medications` | GET, POST | Stable |
| `/api/medications/{id}` | GET, PATCH, DELETE | Stable |
| `/api/medications/{id}/intake` | GET, POST | Stable; preserved per FB-E1 |
| `/api/medications/{id}/intake/{logId}` | PATCH, DELETE | Stable |
| `/api/medications/intake/bulk` | POST | NEW in v1.4.30 |
| `/api/medications/{id}/glp1` | GET | Stable; Glp1InventoryDTO preserved per FB-E2 |
| `/api/medications/{id}/inventory` | GET, POST | Stable |
| `/api/medications/{id}/side-effects` | GET, POST | Stable |
| `/api/medications/{id}/side-effects/{logId}` | PATCH, DELETE | Stable |
| `/api/medications/{id}/titration` | GET, PATCH | Stable |
| `/api/medications/{id}/cadence` | GET, PATCH | Stable |
| `/api/workouts` | GET | Verified in v1.4.32 |
| `/api/workouts/{id}` | GET | Verified in v1.4.32 |
| `/api/workouts/batch` | POST | Stable since v1.4.25 W8d; canonical-row picker server-side in v1.4.30 |
| `/api/personal-records` | GET | Stable |
| `/api/insights/chat` | GET (SSE) | Stable; 403 + assistant.disabled.coach possible from v1.4.31 |
| `/api/insights/generate` | POST | Stable; preserved per FB-J2; 403 from v1.4.31 |
| `/api/insights/comprehensive` | GET | Stable; 403 from v1.4.31 |
| `/api/insights/cards` | GET | Stable; 403 from v1.4.31 |
| `/api/insights/correlations` | GET | Stable; 403 from v1.4.31 |
| `/api/insights/targets` | GET | Stable |
| `/api/insights/briefing` | GET | Verified in v1.4.31; 403 from v1.4.31 |
| `/api/sync/state` | GET | NEW in v1.4.30 |
| `/api/feature-flags` | GET | NEW in v1.4.31 |
| `/api/dashboard/widgets` | GET, PUT, DELETE | Stable |
| `/api/dashboard/summary` | GET | Stable |
| `/api/dashboard/chart-overlay-prefs` | GET, PATCH | Stable |
| `/api/admin/drain-per-sample-cumulative` | POST | NEW in v1.4.30 (admin-gated) |
| `/api/version` | GET | Stable; `offlineGeoEnabled` flag + version sentinel |

### Prisma schema additions through v1.5.0

All additive. No iOS-breaking drops + no type changes.

| Column / enum | Patch | Notes |
|---|---|---|
| `Measurement.syncVersion Int @default(1)` | v1.4.30 | SyncMode foundation |
| `Measurement.deletedAt DateTime?` | v1.4.30 | Soft-delete column |
| `Measurement.externalId String?` (verify if already exists) | pre-existing | UPSERT key for daily-stats rows |
| `User.lastSyncedAt DateTime?` | v1.4.30 | SyncMode foundation |
| `MoodEntry.note TEXT NULL` | v1.4.30 | Replaces `tags: ["note:..."]` workaround |
| `AppSettings.assistantEnabled Boolean @default(true)` | v1.4.31 | Master feature flag |
| `AppSettings.coachEnabled Boolean @default(true)` | v1.4.31 | Sub-flag |
| `AppSettings.briefingEnabled Boolean @default(true)` | v1.4.31 | Sub-flag |
| `AppSettings.insightStatusEnabled Boolean @default(true)` | v1.4.31 | Sub-flag |
| `AppSettings.correlationsEnabled Boolean @default(true)` | v1.4.31 | Sub-flag |
| `AppSettings.healthScoreExplainerEnabled Boolean @default(true)` | v1.4.31 | Sub-flag |
| `enum MeasurementType { … WALKING_STEADINESS }` | v1.4.30 | New value, iOS picks up via codegen |
| `enum MeasurementType { … AUDIO_EXPOSURE_EVENT }` | v1.4.30 | New value |

### MeasurementType + categorisation overlay

By v1.5.0, the categorisation overlay at
`src/lib/measurements/categories.ts` is locked. iOS reads the map at
build-time via OpenAPI codegen (or mirrors it manually):

| Category | MeasurementType values |
|---|---|
| `vitals` | `BP_SYSTOLIC`, `BP_DIASTOLIC`, `PULSE`, `OXYGEN_SATURATION`, `BODY_TEMPERATURE` |
| `body` | `WEIGHT`, `BODY_FAT`, `TOTAL_BODY_WATER`, `BONE_MASS` |
| `activity` | `ACTIVITY_STEPS`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`, `WALKING_RUNNING_DISTANCE`, `WALKING_STEADINESS` |
| `cardiovascular` | `HRV`, `RESTING_HR`, `VO2_MAX` |
| `sleep` | `SLEEP_*` (per-stage rows) |
| `hearing` | `AUDIO_EXPOSURE_ENV`, `AUDIO_EXPOSURE_HEADPHONE`, `AUDIO_EXPOSURE_EVENT` |
| `environment` | `TIME_IN_DAYLIGHT` |
| `metabolic` | `BLOOD_GLUCOSE`, `BMI` |
| `mood` | `MOOD` |
| `medication` | (medications use a separate model — not a MeasurementType) |

The iOS HealthKit permission picker derives its groups from this
map.

### Daily-stats cumulative-type ingest (R-A Option A)

By v1.5.0 the iOS TestFlight build is posting one row per day per
cumulative type. The `CUMULATIVE_HK_TYPES` set is:

- `ACTIVITY_STEPS` ↔ `HKQuantityTypeIdentifierStepCount`
- `ACTIVE_ENERGY_BURNED` ↔ `HKQuantityTypeIdentifierActiveEnergyBurned`
- `FLIGHTS_CLIMBED` ↔ `HKQuantityTypeIdentifierFlightsClimbed`
- `WALKING_RUNNING_DISTANCE` ↔ `HKQuantityTypeIdentifierDistanceWalkingRunning`
- `TIME_IN_DAYLIGHT` ↔ `HKQuantityTypeIdentifierTimeInDaylight`

`externalId` shape: `"stats:<HKQuantityTypeIdentifier>:<YYYY-MM-DD>"`
locked in `.planning/v15-ios-handoff/08-locked-contracts.md`.

### SyncMode trio (standalone-first / paired-with-server / cloud-sync)

By v1.5.0 the iOS app supports all three modes. The web-side
endpoints are stable:

- `GET /api/sync/state` returns current server `syncVersion` +
  `lastSyncedAt`
- `POST /api/mood-entries/bulk` + `POST /api/medications/intake/bulk`
  let iOS push a backlog after pairing
- `Measurement.deletedAt` makes tombstoned-row sync straightforward

Mode-switching is iOS-local; the server has no concept of "this user
is in standalone mode". The server just answers whatever the iOS app
asks.

### Coach SSE — the v1.5 differentiator

By v1.5.0 the iOS Coach drawer is the native implementation of
`GET /api/insights/chat`. Reference web implementation in
`src/components/insights/coach-panel/`. Contract specifics:

- Server-Sent Events stream
- Token-by-token streaming text
- Provenance events embedded with each token chunk
- Refusal events per GROUND-RULE-9 / 15
- 429 `coach.budget.exceeded` on rate-limited paths
- 403 `assistant.disabled.coach` if the operator-side flag is off

### Push notifications (post-APNs `.p8` paste)

The APNs scaffolding exists server-side. After the operator pastes
the `.p8` key, server-issued push notifications start. The iOS-side
handler should already be wired per the v1.4.23 work — verify in the
iOS repo.

### What is explicitly NOT in v1.5

These defer to v1.5.x or v1.6:

- HealthKit Tier 2 categories (R-F T2): workout power metrics,
  workout-effort score, sleep apnea breathing disturbances, mindful
  sessions, six-minute walk, HR recovery
- HealthKit Tier 3 (R-F T3): FHIR clinical, ECG waveforms, atrial-fib
  burden, PHQ-9/GAD-7, reproductive, nutrition, Apple Watch
  independent app
- Apple Health XML import (`export.zip` ingest) — open question per
  v1.5 plan §6 #3
- Two-axis source-priority editor on iOS — endpoint exists; UI lands
  in v1.5.x
- C1 architectural lift on `/api/analytics` (split into dashboard +
  insights surfaces, SQL-side aggregation) — v1.5.x

## 6. iOS-side blockers and pending coordination

### APNs `.p8` paste (operator action, 1 hour)

The Apple Push Notification Service key has not been pasted into the
Coolify environment yet. Per the R-E C-3 finding, this is a 1-hour
operator action that gates server-issued push notifications. The
APNs scaffolding (server-side route + iOS-side handler) is partially
in place from the v1.4.23 work; the missing piece is the operator
pasting the `.p8` into the deployment environment.

**Status: pending — operator (Marc) has not yet pasted the key.**
This blocks push notifications only; everything else functions
without it.

### Coach SSE drawer iOS implementation

Per R-E C-1, the iOS Coach drawer has zero native code today. The
server-side SSE endpoint at `/api/insights/chat` is live and tested.
The v1.5 differentiator is the native Coach drawer. The iOS side is
the implementation:

- `CoachService` actor over `URLSession.bytes`
- `CoachStreamEvent` AsyncThrowingStream
- SwiftData-backed `CoachConversation` cache
- Streaming bubble view
- Provenance disclosure
- GROUND-RULE-9 / 15 refusal-acceptance UI
- `coach.budget.exceeded` 429 surface

Pattern reference: `src/components/insights/coach-panel/` (web
implementation) is the model. The iOS implementation should mirror
the user experience while consuming the same SSE stream.

### Source-priority editor

The endpoint `/api/auth/me/source-priority` has been locked since
v1.4.25 W8c. The iOS app does not call it anywhere today. v1.4.33
adds a web-side editor as a reference shape; iOS should mirror the
two-axis editor under Settings → Sources & Devices.

## 7. Reference paths

If the iOS contributor needs deep context:

| Doc | Purpose |
|---|---|
| `.planning/v15-ios-handoff/03-api-contracts.md` | Every endpoint + DTO shape |
| `.planning/v15-ios-handoff/04-data-model.md` | Prisma schema + invariants |
| `.planning/v15-ios-handoff/06-ios-responsibilities.md` | What iOS owns vs server |
| `.planning/v15-ios-handoff/07-server-responsibilities.md` | The mirror |
| `.planning/v15-ios-handoff/08-locked-contracts.md` | The do-not-touch list |
| `.planning/v15-ios-handoff/14-coach-mental-model.md` | Coach drawer architecture |
| `.planning/v15-ios-handoff/15-insights-architecture.md` | Insights pipeline |
| `.planning/v15-ios-handoff/16-health-score-logic.md` | HealthScore algorithm |
| `.planning/v15-ios-handoff/17-error-handling.md` | Server error contracts |
| `.planning/v15-ios-handoff/18-pattern-cookbook.md` | Common patterns |
| `.planning/v15-ios-handoff/22-offline-first-architecture.md` | Offline-first model |
| `.planning/v15-ios-handoff/22-standalone-and-server-pairing.md` | Pair / unpair flow |
| `.planning/v15-strategic-plan.md` | The full strategic plan |
| `.planning/research/v15-r-a-step-aggregation.md` | R-A daily-stats deep dive |
| `.planning/research/v15-r-e-ios-planning-state.md` | iOS gap audit (28 finds) |
| `.planning/research/v15-r-f-apple-health-depth.md` | HealthKit coverage roadmap |

## 8. Communication

The web side ships continuously. The iOS contributor should not block
on web releases — read this brief weekly (the maintainer can refresh
it after every patch), and pick up new server surfaces as soon as
they're documented in the CHANGELOG + `.planning/round-v14NN-closure-report.md`.

When the iOS-side needs a server change, the request goes through
the maintainer; if the request is additive on the iOS contract the
web ships the change in the next patch. If the request is breaking,
the maintainer either reshapes the request additively or coordinates
a paired release (which is currently out of scope until v1.5.x).

The next web release is v1.4.30 — wait for the closure report at
`.planning/round-v1430-closure-report.md` before adopting the
daily-stats path.
