---
file: 03-api-contracts.md
purpose: Every HTTP endpoint iOS will call, with Zod schema excerpts, rate limits, error codes, and curl self-tests
when_to_read: Building any iOS feature that calls the server API
prerequisites: 05-auth-flows.md (for headers + token handling), 04-data-model.md (for enum value lists)
estimated_tokens: ~8000
version_anchor: v1.4.25 / sha 49f71c92
---

## TL;DR

All API routes are JSON-in / JSON-out with envelope `{ data, error, meta? }`. Auth is either cookie session OR `Authorization: Bearer hlk_<hex>`. Every mutation is wrapped in `apiHandler` (Wide-Event logging + error envelope) and most batched mutations honour `Idempotency-Key` headers for 24h replay. Rate-limit responses (429) carry `X-RateLimit-*` headers.

## Envelope contract

```
// Success
{ "data": <T>, "error": null }

// Error
{ "data": null, "error": "<message>", "meta": { "errorCode": "<stable.key>" } }
```

`apiSuccess(data, status?)` / `apiError(message, status, { errorCode, headers })` from `src/lib/api-response.ts`.

## Required headers

| Header | When | Example |
| --- | --- | --- |
| `Authorization: Bearer hlk_<hex>` | Every authenticated call from iOS | `Bearer hlk_a1b2c3…` |
| `Content-Type: application/json; charset=utf-8` | Every body-carrying request | — |
| `X-Client-Type: native` | iOS app on `/api/auth/login` and `/api/auth/passkey/login-verify` — triggers refresh-token issuance | — |
| `X-Device-Id: <stable-uuid>` | iOS auth flows — binds the refresh token to a device row | — |
| `User-Agent: HealthLog-iOS/1.5.0` | Recommended on every iOS call — Wide-Event logs it for forensics | — |
| `Idempotency-Key: <opaque>` | Every batched mutation (measurements, workouts, single measurement POST, intake POST) | UUIDv4 |
| `x-request-id` | Optional — propagated through Wide-Event logging | UUIDv4 |
| `Accept-Language` | Optional fallback for `resolveServerLocale()` when user has no saved locale | `en-US,en;q=0.9,de;q=0.8` |

## Auth scope contract

Auth precedence (cookie-first, never both):

1. Valid session cookie → cookie path (full user access)
2. No cookie + Bearer `hlk_*` → API-token path (scope-gated)
3. Neither → 401

The iOS app uses path 2 exclusively. Login issues a wildcard-scope `["*"]` access token + a refresh token. Routes that declare no `requiredPermission` accept ANY authenticated token (Since v1.4.25 W10 — the prior contract 403'd narrow-scope tokens on unscoped routes, which broke iOS-only endpoints like `/api/measurements/by-external-ids`, `/api/personal-records`, `/api/medications/[id]/glp1`, `/api/dashboard/glp1`).

`requireAdmin()` is cookie-only — no Bearer ever elevates. iOS never reaches admin routes.

---

# § Auth

## POST /api/auth/login

Password (or username) + password login.

```ts
// from src/lib/validations/auth.ts:31-34
export const loginPasswordSchema = z.object({
  email: z.string().trim().min(1, "Email or username required"),
  password: z.string().min(1),
});
```

| Field | Auth | Body | Rate limit | Idempotency |
| --- | --- | --- | --- | --- |
| Native (iOS) flow | None (creates token) | `{ email, password }` | 5 / 15 min / IP | — |

Headers (iOS):

- `X-Client-Type: native` → triggers refresh-token issuance
- `X-Device-Id: <stable-uuid>` → binds refresh token to a device row

Response (native, with refresh token):

```json
{
  "data": {
    "user": { "id": "usr_…", "username": "marc" },
    "token": "hlk_<hex>",
    "tokenExpiresAt": "2026-05-15T12:00:00.000Z",
    "refreshToken": "hlr_<hex>",
    "refreshTokenExpiresAt": "2026-07-14T12:00:00.000Z"
  },
  "error": null
}
```

Error codes: 401 `Invalid credentials`, 422 `Invalid credentials` (schema fail), 429 `Too many login attempts. Please try again later.`

Self-test:

```bash
curl -sS -X POST https://your-host/api/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Type: native' \
  -H 'X-Device-Id: 00000000-0000-0000-0000-000000000001' \
  -d '{"email":"marc@example.com","password":"…"}'
```

## POST /api/auth/refresh

Exchange a refresh token for a new access + refresh pair (refresh tokens are one-time-use, rotated on every call).

```ts
// Body — hand-rolled validation, two fields
{ refreshToken: string, revoke?: boolean }
```

| Auth | Rate limit |
| --- | --- |
| None (token-bearing) | 60 / 15 min / IP |

Response:

```json
{
  "data": {
    "token": "hlk_<hex>",
    "tokenExpiresAt": "2026-05-15T13:00:00.000Z",
    "refreshToken": "hlr_<hex>",
    "refreshTokenExpiresAt": "2026-07-14T13:00:00.000Z"
  },
  "error": null
}
```

Error codes: 401 `Invalid refresh token`, 401 `Refresh token reuse detected — please log in again.` (reuse = security event; force re-login), 422 `refreshToken required`, 429 `Too many refresh attempts. Please retry later.`

Body `{ refreshToken, revoke: true }` → logout-on-device. Returns `{ "revoked": true|false }`.

## POST /api/auth/logout

Cookie-only path. Clears the session cookie. For iOS use `POST /api/auth/refresh { refreshToken, revoke: true }` instead.

## POST /api/auth/register

```ts
// from src/lib/validations/auth.ts:6-29
export const registerSchema = z.object({
  email: z.email("Invalid email address"),
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(12),
  timezone: z.string().max(64).optional(),    // browser-detected
});
```

Send `X-Client-Type: native` + `X-Device-Id` to receive the same access + refresh token bundle on success.

## GET /api/auth/me

Returns the current user. Cookie OR Bearer.

```json
// Response data
{
  "id": "usr_…",
  "username": "marc",
  "email": "marc@example.com",
  "role": "USER",                  // "USER" | "ADMIN"
  "heightCm": 178,
  "dateOfBirth": "1990-01-15T00:00:00.000Z",
  "gender": "MALE",                // "MALE" | "FEMALE" | null
  "timezone": "Europe/Berlin",     // IANA
  "onboardingCompletedAt": "2026-04-12T18:22:00.000Z",
  "onboardingTourCompleted": true,
  "gravatarUrl": "https://www.gravatar.com/avatar/…",
  "glucoseUnit": "mg/dL",          // or "mmol/L"
  "lastReportPracticeName": "Dr. Schmidt"
}
```

## PUT /api/auth/profile

Body subset of:

```ts
// from src/lib/validations/auth.ts:36-41
export const profileSchema = z.object({
  email: z.email().nullable().optional(),
  heightCm: z.number().min(50).max(300).nullable().optional(),
  dateOfBirth: z.string().nullable().optional(),  // ISO date
  gender: z.enum(["MALE", "FEMALE"]).nullable().optional(),
});
```

## PUT /api/auth/me/timezone

```json
// Request
{ "timezone": "America/Los_Angeles" }
// Response
{ "data": { "timezone": "America/Los_Angeles" } }
```

422 when the string fails the runtime `Intl.DateTimeFormat` validity check.

## GET/PUT /api/auth/me/coach-prefs

Coach drawer preferences — `defaultWindow`, per-source toggles. Schema in `src/lib/validations/coach-prefs.ts`.

## GET/PUT /api/auth/me/doctor-report-prefs

Per-section toggles for the doctor report. Schema in `src/lib/validations/doctor-report-prefs.ts`. Mood defaults to off (clinical sensitivity).

## GET/PUT /api/auth/me/source-priority

Two-axis source-priority resolver state. Schema in `src/lib/validations/source-priority.ts`. PUT body example:

```json
{
  "metricPriority": {
    "weight": ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
    "bp_sys": ["WITHINGS", "APPLE_HEALTH", "MANUAL"]
  },
  "deviceTypePriority": {
    "weight": ["scale", "watch"],
    "default": ["watch", "phone"]
  }
}
```

## GET/POST/DELETE /api/auth/me/research-mode

Research Mode acknowledgment lifecycle (GLP-1 drug-level chart gate).

```json
// GET → current state
{
  "data": {
    "enabled": false,
    "acknowledgedAt": null,
    "acknowledgedVersion": null,
    "currentDisclaimerVersion": "1.0.0"
  }
}
// POST body
{ "acknowledged": true, "version": "1.0.0" }
// On stale version → 400 research-mode.version.stale
// On rate-limit → 429 (5/min/user)
// DELETE → idempotent disable; writes audit-log either way
```

iOS rule: always fetch `currentDisclaimerVersion` from GET first; never hardcode. When `acknowledgedVersion !== currentDisclaimerVersion`, force re-prompt.

## GET /api/auth/me/devices

List the registered devices (one row per `X-Device-Id`). Includes APNs token state, last refresh, last access.

## Passkey flow

| Endpoint | Body |
| --- | --- |
| `POST /api/auth/passkey/register-options` | `{ username }` → WebAuthn `PublicKeyCredentialCreationOptions` |
| `POST /api/auth/passkey/register-verify` | WebAuthn attestation → `{ credentialId }` |
| `POST /api/auth/passkey/login-options` | `{ }` → `PublicKeyCredentialRequestOptions` |
| `POST /api/auth/passkey/login-verify` | WebAuthn assertion → access + refresh token bundle (with native headers) |

Rate limits: 10 / 15 min on each — `auth:passkey-verify:{ip}`.

iOS note: passkeys are a sync-credential boundary — Apple Keychain ↔ iCloud Keychain. The iOS app prefers passkey > password where both are configured.

---

# § Tokens

## GET /api/tokens

List the caller's API tokens.

## POST /api/tokens

Create a token. Body `{ name: string, expiresInDays?: 1..365 }`. Response carries the raw token ONCE — never re-fetchable.

```ts
// from src/app/api/tokens/route.ts:11-14
const createTokenSchema = z.object({
  name: z.string().min(1, "Name required").max(100),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
```

403 when the admin has globally disabled the API. iOS uses the auto-issued token from login — operators may issue narrow-scope tokens through this endpoint for integrations.

## DELETE /api/tokens/[id]

Revoke a token (sets `revoked = true`; never deletes the row — audit trail intact).

---

# § Measurements

The single-row POST and the array-mode of `/api/measurements` share schemas with the iOS-oriented `/api/measurements/batch`. iOS uses **batch** for HealthKit and **single POST** only for the rare manual-entry path.

## GET /api/measurements

```ts
// from src/lib/validations/measurement.ts:244-261
export const listMeasurementsSchema = z.object({
  type: measurementTypeEnum.optional(),
  from: z.iso.datetime({ offset: true }).transform(s => new Date(s)).optional(),
  to:   z.iso.datetime({ offset: true }).transform(s => new Date(s)).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  sortBy: z.enum(["type", "value", "measuredAt", "source"]).optional().default("measuredAt"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});
```

Response `{ data: { measurements: Measurement[], meta: { total, limit, offset } } }`.

## POST /api/measurements

Single or batch (array). Batch sub-mode caps at **5 entries** — use `/api/measurements/batch` for anything bigger.

```ts
// from src/lib/validations/measurement.ts:198-229
export const createMeasurementSchema = z.object({
  type: measurementTypeEnum,
  value: z.number(),
  measuredAt: z.iso.datetime({ offset: true }).transform(s => new Date(s)),
  notes: z.string().max(25).optional(),
  source: measurementSourceEnum.optional().default("MANUAL"),
  glucoseContext: glucoseContextEnum.optional(),    // required for BLOOD_GLUCOSE only
  deviceType: z.string().min(1).max(32).nullable().optional(),
}).refine(...)
.refine(BLOOD_GLUCOSE ↔ glucoseContext invariant);

// Batch sub-mode (line 263)
export const createBatchMeasurementSchema = z.object({
  measurements: z.array(createMeasurementSchema).min(1).max(5),
});
```

`measurementTypeEnum` (29 values at v1.4.25): WEIGHT, BLOOD_PRESSURE_SYS, BLOOD_PRESSURE_DIA, PULSE, BODY_FAT, SLEEP_DURATION, ACTIVITY_STEPS, BLOOD_GLUCOSE, TOTAL_BODY_WATER, BONE_MASS, OXYGEN_SATURATION, HEART_RATE_VARIABILITY, RESTING_HEART_RATE, ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED, WALKING_RUNNING_DISTANCE, VO2_MAX, BODY_TEMPERATURE, FAT_FREE_MASS, FAT_MASS, MUSCLE_MASS, SKIN_TEMPERATURE, PULSE_WAVE_VELOCITY, VASCULAR_AGE, VISCERAL_FAT, AUDIO_EXPOSURE_ENV, AUDIO_EXPOSURE_HEADPHONE, TIME_IN_DAYLIGHT.

`measurementSourceEnum`: MANUAL, WITHINGS, IMPORT, APPLE_HEALTH.

## POST /api/measurements/batch

The primary HealthKit ingest path.

```ts
// from src/app/api/measurements/batch/route.ts:61-82
const batchEntrySchema = z.object({
  hkIdentifier: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.string().min(1).max(60),
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true }),
  sleepStage: z.number().int().min(0).max(20).optional(),
  externalId: z.string().min(1).max(120),
  externalSourceVersion: z.string().min(1).max(120).optional(),
  deviceType: deviceTypeEnum.nullable().optional(),   // watch|band|ring|phone|scale|other|unknown
});
const batchPayloadSchema = z.object({ entries: z.array(batchEntrySchema).min(1) });

// Caps
const MAX_BATCH_ENTRIES = 500;
const BATCH_RATE_LIMIT_MAX = 60;       // per minute per user
```

The server maps each entry through `mapAppleHealthEntry()`. Per-entry status `inserted | duplicate | skipped` so the iOS sync cursor advances accurately.

```json
// Response
{
  "data": {
    "processed": 142,
    "inserted": 138,
    "duplicates": 3,
    "skipped": [{ "index": 41, "reason": "unmappable_identifier" }],
    "entries": [
      { "index": 0, "status": "inserted" },
      { "index": 1, "status": "duplicate" },
      { "index": 2, "status": "skipped", "reason": "value_out_of_range" }
      // …
    ]
  }
}
```

iOS sync cursor: advance past both `inserted` and `duplicate`; surface `skipped` as a diagnostic but advance past it too (the entry will not become valid by retrying).

Race reconciliation: under contention the server downgrades enough `inserted` per-entry statuses to `duplicate` so the aggregate counts match the per-entry envelope. The DB row is identical either way (single-copy via the composite unique index).

Idempotency: HTTP-level via `Idempotency-Key` (24h replay) + per-entry via `(userId, type, source, externalId)`.

Error codes:
- 422 with `errorCode: "measurement.batch.too_large"` — batch > 500 entries
- 429 `Too many batch submissions, try again later` — per-user 60/min budget
- 401 Bearer expired / revoked

PR detection: enqueued after every successful batch. Batches > 50 entries pass `silent: true` so a historical backfill doesn't fire hundreds of pushes.

Self-test:

```bash
curl -sS -X POST https://your-host/api/measurements/batch \
  -H 'Authorization: Bearer hlk_…' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 00000000-0000-0000-0000-000000000001' \
  -d '{
    "entries": [{
      "hkIdentifier": "HKQuantityTypeIdentifierBodyMass",
      "value": 78.2,
      "unit": "kg",
      "startDate": "2026-05-14T08:00:00+02:00",
      "endDate":   "2026-05-14T08:00:00+02:00",
      "externalId": "1F2A3B4C-5D6E-7F8A-9B0C-1D2E3F4A5B6C",
      "deviceType": "scale"
    }]
  }'
```

## DELETE /api/measurements/by-external-ids

iOS deletion reconciliation. HealthKit gives no deleted-UUID stream, so the iOS app does a periodic 30-day window reconciliation: pulls the current HK sample UUIDs in the window and POSTs the `externalIds` the server has that are no longer present.

```ts
// from src/app/api/measurements/by-external-ids/route.ts:37-42
const payloadSchema = z.object({
  externalIds: z.array(z.string().min(1).max(120)).min(0).max(500),
});
```

Cross-user safety: `userId` predicate in the `deleteMany` — rows owned by another user are silently skipped (no 401). Empty arrays return `{ deletedCount: 0 }` with 200.

Response: `{ "data": { "deletedCount": 17 } }`.

## GET /api/measurements/[id]

Single-row read.

## PATCH /api/measurements/[id]

Update value / measuredAt / notes.

```ts
// from src/lib/validations/measurement.ts:231-242
export const updateMeasurementSchema = z.object({
  value: z.number().min(0).max(500000).optional(),
  measuredAt: z.iso.datetime({ offset: true }).transform(s => new Date(s)).optional(),
  notes: z.string().max(25).nullable().optional(),
});
```

## DELETE /api/measurements/[id]

Hard delete.

## GET /api/measurements/series

Time-bucketed series for a single type — used by chart components. Query `type=<MeasurementType>&from=<iso>&to=<iso>&bucket=day|week|month`.

---

# § Workouts (Since v1.4.25)

## POST /api/workouts/batch

```ts
// from src/lib/validations/workout.ts:21-42
export const workoutSportTypeEnum = z.enum([
  "walking","running","cycling","hiking","swimming","rowing","elliptical","stairClimber",
  "yoga","mindAndBody","strength","hiit","dance","golf","tennis","basketball","soccer",
  "crossTraining","mixedCardio","other"
]);
```

Each workout carries (see `createWorkoutSchema` in the same file): sportType, startedAt, endedAt, optional totalEnergyKcal / totalDistanceM / avgHR / maxHR / minHR / stepCount / elevationM / pauseDurationSec, source, optional externalId + externalSourceVersion, optional `metadata` JSONB (opaque — Coach never reads it), optional nested `route: { geometry: GeoJSON-LineString, sampleTimestamps?: [{ t, speedMs?, hr? }] }`.

Caps:
- **100 workouts per batch**
- **20 000 points per LineString**
- **5 MB request body** — 413 with `errorCode: "workout.batch.payload_too_large"` above this
- 60 batches / min / user

Response identical to measurements batch (per-entry status, race reconciliation).

Idempotency: `(userId, source, externalId)` composite unique index, NULL-distinct.

iOS sport-type mapping lives in the iOS-side companion to `apple-health-mapping.ts` — unknown HK workout types lower to `"other"`.

---

# § Medications

## GET /api/medications

List active medications with last-intake timestamps + today's event counts.

```json
// Per-row shape (excerpt)
{
  "id": "med_…",
  "name": "Ozempic",
  "dose": "0.5 mg",
  "treatmentClass": "GLP1",         // "GENERIC" | "GLP1"
  "dosesPerUnit": 4,                 // doses per pen/vial (GLP-1)
  "category": "HORMONE",             // BLOOD_PRESSURE | VITAMIN | … (clinical taxonomy)
  "active": true,
  "notificationsEnabled": true,
  "schedules": [{ "windowStart": "08:00", "windowEnd": "10:00", "label": "Morning", "dose": null, "daysOfWeek": [0,1,2,3,4,5,6] }],
  "lastTakenAt": "2026-05-13T07:42:18.000Z",
  "todayEventCount": 1
}
```

## POST /api/medications

```ts
// from src/lib/validations/medication.ts:39-48
export const createMedicationSchema = z.object({
  name: z.string().min(1).max(100),
  dose: z.string().min(1).max(50),
  category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
  treatmentClass: z.enum(["GENERIC","GLP1"]).optional(),
  dosesPerUnit: z.number().int().min(1).max(100).optional(),
  schedules: z.array(scheduleSchema).min(1),
});
```

`scheduleSchema` carries `windowStart`/`windowEnd` (HH:mm), optional `label`, `dose`, `daysOfWeek` (0-6, 0=Sunday), `intervalWeeks` (1-4 for weekly GLP-1).

## GET/PUT/DELETE /api/medications/[id]

PUT body in `updateMedicationSchema` (same fields, all optional).

## GET /api/medications/intake?scope=today

Today's intake events in the user's timezone.

```json
{
  "data": [
    {
      "id": "intake_…",
      "medicationId": "med_…",
      "scheduledAt": "2026-05-14T07:00:00.000Z",
      "takenAt": "2026-05-14T07:18:22.000Z",
      "status": "taken",                // "pending" | "taken" | "skipped" | "snoozed"
      "snoozedUntil": null
    }
  ]
}
```

## GET /api/medications/intake?scope=compliance&days=30

Per-day scheduled-vs-taken bucket totals. `days` defaults to 30, range 1-365.

```json
{ "data": [{ "date": "2026-04-15", "scheduled": 2, "taken": 2 }, …] }
```

## POST /api/medications/intake

Update a single intake event.

```ts
// from src/app/api/medications/intake/route.ts:33-44
const updateSchema = z.object({
  intakeId: z.string().min(1),
  status: z.enum(["taken","skipped","snoozed"]),
  takenAt: z.iso.datetime({ offset: true }).transform(s => new Date(s)).optional(),
  snoozedUntil: z.iso.datetime({ offset: true }).transform(s => new Date(s)).optional(),
});
```

`snoozed` default-snoozes for 30 minutes when `snoozedUntil` is omitted.

## POST /api/medications/[id]/intake

Create a new intake event (mostly used by reminder UI on the web).

```ts
// from src/lib/validations/medication.ts:61-73
export const intakeSchema = z.object({
  medicationId: z.string().min(1),
  scheduledFor: z.iso.datetime({ offset: true }).transform(s => new Date(s)).optional(),
  takenAt: z.iso.datetime({ offset: true }).transform(s => new Date(s)).optional(),
  skipped: z.boolean().optional().default(false),
  idempotencyKey: z.string().max(128).optional(),
});
```

Wraps `withIdempotency`. POST `/api/medications/[id]/intake/import` accepts an external-source intake (e.g. Telegram bot); `/api/medications/[id]/intake/purge` clears intake history.

## GET /api/medications/intake-summary

Aggregate compliance stats per medication for a window.

## GET /api/medications/[id]/cadence

GLP-1 cadence visualisation payload — schedule expansion + closest-intake pairing + compliance chips.

## GET/PUT/DELETE /api/medications/[id]/phase-config

Reminder phase tuning (early / on-time / late thresholds).

## GET /api/medications/[id]/compliance

Per-medication compliance bucket history.

## GET /api/medications/[id]/titration

GLP-1 titration ladder — current step + remaining ladder, framed as observational reference (GROUND RULE 15).

## GET /api/medications/[id]/glp1

GLP-1 dose-change history + EMA drug-knowledge enrichment.

## POST /api/medications/[id]/glp1

```ts
// from src/lib/validations/medication.ts:175-213
export const glp1DoseChangePostSchema = z.object({
  effectiveFrom: z.iso.datetime({ offset: true }).transform(s => new Date(s))
    .refine(d => d.getTime() >= MIN_EFFECTIVE_FROM.getTime())   // 2020-01-01
    .refine(d => d.getTime() <= Date.now() + FIVE_YEARS_MS),    // ±5y
  doseValue: z.number().finite().min(0).max(100),     // mg
  doseUnit: z.string().min(1).max(10),
  note: z.string().max(500).nullable().optional(),
});
export const glp1InventoryPostSchema = z.object({
  delta: z.number().int().finite().min(-100).max(100).refine(n => n !== 0),
  reason: z.string().min(1).max(200),
});
// Body must carry exactly one of doseChange | inventory
```

## GET/POST /api/medications/[id]/inventory

Pen-and-vial inventory (Since v1.4.25). Items move SEALED → IN_USE → EXPIRED. `markAsFirstUseAt` starts the 30-day clock; 03:30 cron flips expired rows in a single `updateMany`. Re-runs the state machine on every PATCH so a back-dated first-use immediately moves a stale pen to EXPIRED.

```ts
// from src/lib/validations/medication.ts:116-143
export const createInventoryItemSchema = z.object({
  dosesTotal: z.number().int().min(1).max(100),
  printedExpiry: z.iso.datetime({ offset: true }).transform(s => new Date(s)).nullable().optional(),
  purchasedAt: z.iso.datetime({ offset: true }).transform(s => new Date(s)).nullable().optional(),
  notes: z.string().max(200).nullable().optional(),
});
export const updateInventoryItemSchema = z.object({
  markAsFirstUseAt: z.iso.datetime({ offset: true }).transform(s => new Date(s)).optional(),
  markAsUsedUp: z.boolean().optional(),
  printedExpiry: z.iso.datetime({ offset: true }).transform(s => new Date(s)).nullable().optional(),
  notes: z.string().max(200).nullable().optional(),
});
```

## GET/POST /api/medications/[id]/side-effects

21-entry × 5-category taxonomy. Category derived server-side (no client-supplied category) so the taxonomy cannot drift between client and server. DELETE `/api/medications/[id]/side-effects/[logId]` removes an entry.

---

# § Insights

## GET /api/insights/cards

iOS-friendly composed insight cards.

```json
{
  "data": [
    {
      "id": "card_…",
      "title": "Blood pressure trending down",
      "summary": "Average systolic over the last 30 days fell by 4 mmHg.",
      "body": "Long-form prose with provenance…",
      "severity": "good",      // "alert" | "caution" | "info" | "good"
      "recommendations": [{ "id": "rec_…", "label": "Keep the morning routine", "actionURL": null }],
      "generatedAt": "2026-05-14T02:05:00.000Z",
      "provider": "anthropic"
    }
  ]
}
```

## POST /api/insights/generate

Force re-generation. Rate-limited (default 10/hour, env-tunable). Evicts per-status cache so the next status fetch re-runs against fresh data.

## GET /api/insights/comprehensive

Full insights payload (mother-page). Wraps the per-status cards + correlations + alerts + trend summaries.

## GET /api/insights/correlations

Currently returns `[]` — full correlations engine is part of `/comprehensive`. iOS uses this only for empty-state rendering.

## GET /api/insights/targets

Targets page payload — per-metric target ranges + current status + Coach handoff visibility flag.

## POST /api/insights/feedback

Thumbs + free-text feedback on an insight. Schema in `src/lib/validations/recommendation-feedback.ts`.

## GET/POST /api/insights/chat

The Coach. **Streaming SSE on POST.** GET is the conversation-list paginator.

### POST /api/insights/chat

```ts
// from src/lib/ai/coach/types.ts:87-93
export const coachChatRequestSchema = z.object({
  conversationId: z.string().min(1).max(64).optional(),
  message: z.string().min(1).max(4000),
  prefill: z.string().max(2000).optional(),
  locale: z.enum(["en","de"]).optional(),     // refusal copy locale; main locale resolved server-side
  scope: coachScopeSchema.optional(),         // { sources?: [...], window?: last7days|last30days|last90days|allTime }
});
```

Response is **`text/event-stream; charset=utf-8`**, one frame per JSON event:

```ts
// from src/lib/ai/coach/types.ts:103-110
type CoachStreamEvent =
  | { type: "token";     token: string }
  | { type: "provenance"; metricSource: CoachProvenance }
  | { type: "done";      conversationId: string; messageId: string }
  | { type: "error";     code: string; message: string };
```

SSE headers (server-set): `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

iOS uses an `URLSession` data task with delegate-based streaming, parses each `data: {...}\n\n` frame on `\n\n` boundaries. Status is ALWAYS 200 even on provider error — read the `error` frame inside the stream:

| Error code in `error` frame | Surface |
| --- | --- |
| `coach.provider.unavailable` | "All AI providers are temporarily unavailable. Try again in a minute." |
| `coach.provider.rate_limited` | Warning toast: "AI provider rate-limited. Try again in a minute." |
| `coach.provider.empty` | "Provider returned an empty response. Try again." |
| `coach.provider.none` | "No AI provider configured. Open Settings → AI Provider." |
| `coach.budget.exceeded` (HTTP 429) | "Daily Coach limit reached. Try again tomorrow." |
| `coach.conversation.notFound` (HTTP 404) | "That conversation was deleted. Start a new one." |
| `coach.request.invalid` (HTTP 422) | "Request validation failed. Update the app." |

Refusal short-circuit: when `detectRefusal()` matches (prompt-injection / off-topic / GROUND RULE 9 / GROUND RULE 15), the server emits ONE `token` frame with the localised refusal copy followed by `done`. No provider call, no spend recorded.

### GET /api/insights/chat?cursor=<id>&limit=<n>

Conversation-list paginator. Default limit 20, hard cap 50. Response `{ conversations: [{ id, title, createdAt, updatedAt, messageCount }], nextCursor }`.

### GET /api/insights/chat/[id]

Full conversation with messages decrypted. Each message carries `id, role, content, createdAt, metricSource (CoachProvenance), providerType, promptVersion`.

### DELETE /api/insights/chat/[id]

Delete a conversation (cascade-deletes messages).

### DELETE /api/insights/chat/messages/[id]

Delete a single message.

## GET /api/insights/glp1-timeline

Therapy timeline payload — titration history aligned with weight trace for the GLP-1 detail page.

## GET /api/insights/provider-chain

Read the user's saved provider chain configuration.

## GET/PUT /api/insights/settings

Coach + insights settings (locale override, default window, opt-in toggles).

---

# § Coach (alias of /api/insights/chat)

For convenience the iOS team often refers to "the Coach endpoint" — there is no `/api/coach/*` namespace. Every Coach call is `/api/insights/chat`. Coach prefs live at `/api/auth/me/coach-prefs`.

---

# § Dashboard

## GET /api/dashboard/summary

iOS-shaped dashboard payload — greeting, intake streaks, today's compliance, highlighted insight, per-metric latest + sparkline + trend.

```ts
// from src/app/api/dashboard/summary/route.ts:25-47
type MetricKind = "weight" | "bloodPressure" | "pulse" | "bodyFat" | "glucose"
                | "sleep" | "steps" | "totalBodyWater" | "boneMass" | "oxygenSaturation";

interface MetricCard {
  id: string;
  kind: MetricKind;
  title: string;
  latestValue: number | null;
  secondaryValue: number | null;
  unit: string;
  trend: "up" | "down" | "flat" | "unknown";
  sparkline: number[];      // last 7 days
  updatedAt: string | null;
}
```

`bloodPressure.latestValue` carries SYS; `secondaryValue` carries DIA.

## GET /api/dashboard/glp1

GLP-1 dashboard tile payload — next-injection schedule + week-over-week weight delta + active pen state. Returns `null` data when the user has no `treatmentClass = GLP1` medication.

## GET/PUT /api/dashboard/widgets

Per-user dashboard layout JSON.

## GET/PUT /api/dashboard/chart-overlay-prefs

Per-chart comparison-overlay preference.

---

# § Withings

## GET /api/withings/connect

302 redirect to Withings OAuth authorize URL. Sets `withings_state` httpOnly cookie for CSRF. **Browser-only** — iOS opens this URL in `SFSafariViewController` instead of a fetch.

## GET /api/withings/callback?code=…&state=…

OAuth callback — exchanges code, persists the connection (`WithingsConnection`), redirects to `/settings/integrations?withings=connected`.

## GET /api/withings/status

```json
{
  "data": {
    "connected": true,
    "configured": true,
    "lastSyncedAt": "2026-05-14T08:00:00.000Z",
    "connectedAt": "2026-04-01T12:00:00.000Z",
    "tokenExpired": false,
    "tokenRefreshFailed": false,
    "tokenExpiresAt": "2026-05-14T09:00:00.000Z",
    "scope": "user.metrics,user.activity,user.info",
    "hasActivityScope": true
  }
}
```

`hasActivityScope` is the pre-computed flag the Settings reconnect banner reads. Null `scope` → legacy v1.4.24 connection; the banner surfaces.

## POST /api/withings/sync

Force a sync. Body `{ kind: "measure" | "activity" | "sleep" }`.

## DELETE /api/withings/disconnect

Revoke the OAuth grant + drop the `WithingsConnection` row.

## GET/PUT /api/withings/credentials

Per-user Client ID + Client Secret (encrypted). 422 when shape invalid.

## POST /api/withings/webhook/[token]

Withings push delivery. Token-scoped (per-user). Not called by iOS.

---

# § Health Score

The health score is included in `/api/analytics`'s response. There is no standalone `/api/health-score` route.

## GET /api/analytics

Wraps trends + classifications + correlations + the four-component Personal Health Score. iOS reads `data.healthScore` for the score number and `data.healthScore.components[]` for the provenance accordion.

```json
{
  "data": {
    "healthScore": {
      "total": 78,
      "components": [
        { "key": "bp",         "score": 22, "asOf": "2026-05-13T07:30:00.000Z", "source": "WITHINGS" },
        { "key": "weight",     "score": 20, "asOf": "2026-05-14T06:18:00.000Z", "source": "WITHINGS" },
        { "key": "mood",       "score": 18, "asOf": "2026-05-13T21:00:00.000Z", "source": "MANUAL" },
        { "key": "compliance", "score": 18, "asOf": "2026-05-14T08:00:00.000Z", "source": "MANUAL" }
      ]
    },
    "trends": { … },
    "correlations": [ … ],
    "alerts": [ … ]
  }
}
```

---

# § Notifications

## GET /api/notifications/preferences

```json
{
  "data": {
    "channels": [
      { "id": "ch_…", "type": "APNS", "label": "Apple Push", "enabled": true, "globallyEnabled": true }
    ],
    "preferences": [
      { "channelId": "ch_…", "eventType": "MEDICATION_REMINDER", "enabled": true }
    ],
    "eventTypes": ["MEDICATION_REMINDER","INSIGHT_READY","PERSONAL_RECORD_ACHIEVED", …]
  }
}
```

## PUT /api/notifications/preferences

```ts
// from src/lib/validations/notifications.ts
{ channelId: string, eventType: string, enabled: boolean }
```

## GET /api/notifications/status

Aggregate notification health (per-channel last-success + last-error + retry-state).

## GET /api/notifications/vapid

Returns the server's VAPID public key for browser push enrolment. iOS reads it only if it ever wires a web-push fallback.

## POST/DELETE /api/notifications/web-push

Browser-push subscription register / unregister. iOS uses the `devices/` endpoint family with APNs tokens instead.

---

# § Onboarding (Since v1.4.25)

## POST /api/onboarding/step

```ts
// from src/app/api/onboarding/step/route.ts:43-45
const stepBodySchema = z.object({
  step: z.number().int().min(1).max(4),
});
```

State machine guards:
- Submitted step MUST equal `current + 1` (no skipping)
- Already-completed user (`onboardingCompletedAt != null`) → 409
- Concurrent advance → 409 (conditional `updateMany` with the WHERE re-asserting the precondition)
- Rate limit 30 writes / 10 min / user → 429

Response:

```json
{ "data": { "step": 3, "onboardingCompletedAt": null } }
```

Step 4 advance flips `onboardingCompletedAt` to NOW and clears the `hl_onboarding` proxy cookie.

## POST /api/onboarding/complete

Legacy v1.4.20 single-call completion. iOS uses `step: 4` on the new endpoint instead.

## POST /api/onboarding/tour

Mark the post-onboarding product tour as completed.

---

# § Personal Records (Since v1.4.25)

## GET /api/personal-records

Paginated. Default 25, max 200.

```json
{
  "data": {
    "records": [
      {
        "id": "pr_…",
        "metricType": "RESTING_HEART_RATE",
        "direction": "MIN",     // "MIN" | "MAX"
        "value": 52,
        "unit": "bpm",
        "achievedAt": "2026-05-13T07:00:00.000Z",
        "previousBest": 54
      }
    ],
    "meta": { "total": 12, "limit": 25, "offset": 0 }
  }
}
```

## DELETE /api/personal-records/[id]

Currently web-only (admin can scrub bad records). iOS shouldn't depend on this.

---

# § Health probe

## GET /api/health

```json
// Public (unauth)
{ "status": "ok" }
// Admin (cookie session)
{
  "status": "ok",
  "timestamp": "2026-05-14T08:00:00.000Z",
  "database": "connected",
  "worker": "running",
  "workerLastHeartbeat": "2026-05-14T07:59:55.000Z"
}
```

200 when DB + worker both healthy; 503 otherwise. iOS uses this only for the operator-facing "is the server up?" diagnostic in Settings.

## GET /api/version

Reports the deployed semver + git sha.

---

## Error envelope quick reference

| HTTP | Meaning | iOS handling |
| --- | --- | --- |
| 200 | Success | Read `data` |
| 201 | Created | Read `data` |
| 400 | Bad request (malformed body, stale-version) | Surface `error` text; do not retry |
| 401 | Not authenticated / invalid token / expired token | Refresh via `/api/auth/refresh`; on `reuse detected` force re-login |
| 403 | Insufficient permissions / API globally disabled / admin-only | Surface `error` text |
| 404 | Not found | Surface `error` text |
| 409 | Conflict (duplicate, out-of-order onboarding, concurrent write) | Refresh state and retry once |
| 413 | Payload too large | Halve batch size and retry |
| 415 | Wrong Content-Type | Code bug — always send `application/json` |
| 422 | Validation failed | Surface the first issue from `error` (Zod messages are user-readable) |
| 429 | Rate-limited / budget exceeded | Read `X-RateLimit-*` and back off |
| 500 | Server error | Retry with exponential backoff |

---

## STOP HERE if…

| If your task is… | …skip the rest and read… |
| --- | --- |
| "How do I refresh tokens?" | `05-auth-flows.md` |
| "What's in the DB tables I touch?" | `04-data-model.md` |
| "Why does the Coach refuse this prompt?" | `08-locked-contracts.md` § 1 (GROUND RULES) + `14-coach-mental-model.md` § Refusal |
| "How does PR detection actually work?" | `07-server-responsibilities.md` § Domain 4 |
