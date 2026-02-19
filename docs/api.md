# API Reference

All endpoints return an envelope: `{ data, error, meta? }`.
Authentication: Session cookie (web) or Bearer token (external ingest).

---

## Health Check

### `GET /api/health`

Returns application health status.

---

## Auth

### `POST /api/auth/register`

Register a new user. Body: `{ username, password }`.

### `POST /api/auth/login`

Login with password. Body: `{ username, password }`.

### `POST /api/auth/logout`

Destroy current session.

### `GET /api/auth/me`

Get current user profile.

### `PUT /api/auth/profile`

Update profile. Body: `{ heightCm?, bpSysTargetLow?, bpSysTargetHigh?, bpDiaTargetLow?, bpDiaTargetHigh? }`.

### `POST /api/auth/passkey/register-options`

Get WebAuthn registration options (authenticated).

### `POST /api/auth/passkey/register-verify`

Verify passkey registration. Body: `{ challengeId, credential }`.

### `POST /api/auth/passkey/login-options`

Get WebAuthn authentication options. Body: `{ username }`.

### `POST /api/auth/passkey/login-verify`

Verify passkey authentication. Body: `{ challengeId, credential }`.

---

## Measurements

### `GET /api/measurements`

List measurements. Query: `type?`, `limit?`, `offset?`.

### `POST /api/measurements`

Create measurement. Body: `{ type, value, measuredAt, notes?, source? }`.

### `GET /api/measurements/[id]`

Get single measurement.

### `PUT /api/measurements/[id]`

Update measurement. Body: `{ value?, measuredAt?, notes? }`.

### `DELETE /api/measurements/[id]`

Delete measurement.

---

## Analytics

### `GET /api/analytics`

Get trend summaries for all measurement types. Returns moving averages, slopes, anomaly counts, BMI, BP target stats.

---

## Medications

### `GET /api/medications`

List all medications with schedules.

### `POST /api/medications`

Create medication. Body: `{ name, dose, schedules: [{ windowStart, windowEnd, label? }] }`.

### `PUT /api/medications/[id]`

Update medication. Body: `{ name?, dose?, active?, schedules? }`.

### `DELETE /api/medications/[id]`

Delete medication.

### `GET /api/medications/[id]/intake`

List last 50 intake events.

### `POST /api/medications/[id]/intake`

Record intake. Body: `{ takenAt?, skipped?, idempotencyKey? }`.

### `GET /api/medications/[id]/compliance`

Get 7-day and 30-day compliance stats (rate, streak, taken/skipped/missed).

---

## External Ingest

### `POST /api/ingest/medication`

External medication intake (e.g., from Shortcuts).
**Auth**: `Authorization: Bearer <token>`.
**Rate limit**: 60 req/min per IP.
Body: `{ medicationName, takenAt?, idempotencyKey }`.
Idempotent via `idempotencyKey`.

---

## API Tokens

### `GET /api/tokens`

List API tokens for current user.

### `POST /api/tokens`

Create API token. Body: `{ name, expiresInDays? }`.
Returns the raw token once — it cannot be retrieved again.

### `DELETE /api/tokens/[id]`

Revoke an API token.

---

## Withings

### `GET /api/withings/connect`

Redirect to Withings OAuth authorization.

### `GET /api/withings/callback`

OAuth callback — exchanges code for tokens, stores encrypted.

### `POST /api/withings/disconnect`

Disconnect Withings integration.

### `GET /api/withings/status`

Get connection status (connected, lastSyncedAt, tokenExpired).

### `POST /api/withings/sync`

Manually trigger a Withings data sync.

### `POST /api/withings/webhook`

Withings webhook notification receiver.

---

## Export

### `GET /api/export`

Download all user data.
Query: `format=json|csv`, `type=measurements|medications|intake|all`.

---

## Insights (Optional, OpenAI)

### `POST /api/insights/generate`

Generate AI-powered health insights. Requires OpenAI API key in user settings.
Rate limit: 2 per hour. Cached daily.
Body: `{ force?: boolean }` — set `force: true` to regenerate.

### `GET /api/insights/settings`

Get insights configuration (hasKey, privacyMode, lastInsightAt).

### `PUT /api/insights/settings`

Update insights settings. Body: `{ apiKey?, privacyMode?: "aggregated"|"raw" }`.
Set `apiKey: ""` to remove the key.

---

## Audit Log

### `GET /api/audit-log`

List audit log entries. Query: `limit?` (max 200), `offset?`.
