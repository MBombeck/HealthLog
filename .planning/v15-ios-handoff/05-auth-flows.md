---
file: 05-auth-flows.md
purpose: Native session + token flow for iOS. Cookie path for web, Bearer + rotating refresh for iOS. Withings 3-leg OAuth. Apple Health auth is iOS-native — server only takes ingest.
when_to_read: Before wiring login, refresh, logout, or any external connection. Before designing Keychain storage.
prerequisites: 04-data-model.md (User / Session / ApiToken / RefreshToken / Device).
estimated_tokens: 3400
version_anchor: v1.4.25 / sha 49f71c92
---

# Auth Flows — v1.4.25

> **TL;DR.** Login returns a 24h access token + 60d rotating refresh
> token when the caller looks native (`X-Client-Type: native` or UA
> prefix `HealthLog-iOS`); web keeps the 30-day session cookie. Every
> protected request sends `Authorization: Bearer hlk_...`. Refresh is
> one-time-use; reuse → 401 + force re-login. Apple Health auth is
> entirely client-side — the server only sees ingest.

---

## 1. Auth surfaces at a glance

| Surface | Web | iOS |
| --- | --- | --- |
| Login | `POST /api/auth/login` (password) or `/api/auth/passkey/*` | `POST /api/auth/login` with `X-Client-Type: native` |
| Session carrier | `healthlog_session` httpOnly cookie | `Authorization: Bearer hlk_<...>` header |
| Lifetime | 30 days, sliding (refreshed on every request if >1d remaining) | 24h access + 60d rotating refresh |
| Refresh | Server-side cookie update | `POST /api/auth/refresh` (one-time-use token rotation) |
| Logout | `POST /api/auth/logout` clears cookie + deletes session | `POST /api/auth/refresh` with `{ revoke: true }` + drop tokens |
| Admin elevation | Cookie only — **Bearer tokens never elevate** | Not available |

---

## 2. Native login flow (the iOS path)

```
┌──── iOS ────┐                                  ┌──── server ────┐
│             │   POST /api/auth/login           │                │
│             │   X-Client-Type: native          │                │
│             │   User-Agent: HealthLog-iOS/...  │                │
│             │   { email, password }            │                │
│             │ ───────────────────────────────▶ │                │
│             │                                  │ rate-limit:    │
│             │                                  │   5 / 15min/IP │
│             │                                  │ verifyPassword │
│             │                                  │ (argon2id)     │
│             │                                  │ createSession  │
│             │                                  │   (cookie too) │
│             │                                  │ issueAccess+   │
│             │                                  │   Refresh      │
│             │                                  │                │
│             │   200 { data: { token,           │                │
│             │     tokenExpiresAt,              │                │
│             │     refreshToken,                │                │
│             │     refreshTokenExpiresAt,       │                │
│             │     user: { id, username } } }   │                │
│             │ ◀─────────────────────────────── │                │
└─────────────┘                                  └────────────────┘
```

### 2.1 What the iOS client stores in Keychain

| Key | Value | Notes |
| --- | --- | --- |
| `accessToken` | `token` from the response (`hlk_<...>`) | Send as `Authorization: Bearer ...` |
| `accessTokenExpiresAt` | `tokenExpiresAt` (ISO-8601, UTC) | Refresh ~5 min before |
| `refreshToken` | `refreshToken` from the response | One-time-use |
| `refreshTokenExpiresAt` | `refreshTokenExpiresAt` (ISO-8601, UTC) | Hard re-login when past |
| `userId` | `user.id` | Cheap local guards (never trust client-side) |
| `username` | `user.username` | For the avatar / display layer |
| `deviceId` | UUID generated once per install | Sent as `X-Device-Id` header on every refresh |

**Do NOT** persist `refreshToken` outside the Keychain. iCloud-Keychain
sync is fine — the token is per-device-bound on rotation but the
initial pair is fungible. If `X-Device-Id` changes across rotations
the server allows it (revocation by deviceId is a separate operation).

### 2.2 Native UA / header detection

```typescript
// from src/lib/auth/native-client.ts:32
const NATIVE_UA_PREFIXES = [
  "HealthLog-iOS",
  "HealthLog-iPad",
  "HealthLog-Watch",
  "n8n",
  "Health-Connect",
];

export function classifyClient(headers: Headers): ClientPolicy {
  const explicit = headers.get("x-client-type")?.toLowerCase();
  if (explicit === "native") return "native";
  if (explicit === "web") return "web";

  const ua = headers.get("user-agent") ?? "";
  if (ua.includes("Mozilla/")) return "web";
  for (const prefix of NATIVE_UA_PREFIXES) {
    if (ua.startsWith(prefix)) return "native";
  }
  return "native"; // unrecognised → safer (shorter) token
}
```

| Policy | Access token | Refresh token |
| --- | --- | --- |
| `web` | 90 days (legacy `ApiToken`) | none |
| `native` | 24 hours (1 day) | 60 days (rotating) |

**Recommendation**: set BOTH `X-Client-Type: native` AND `User-Agent:
HealthLog-iOS/<ver> (<device-model>; iOS <os>)`. The header is the
contract; the UA is the audit-log breadcrumb.

---

## 3. Token rotation

```
┌──── iOS ────┐                            ┌──── server ────┐
│             │   POST /api/auth/refresh   │                │
│             │   { refreshToken }         │                │
│             │ ─────────────────────────▶ │                │
│             │                            │ rate-limit:    │
│             │                            │ 60/15min/IP    │
│             │                            │ findTokenHash  │
│             │                            │ (HMAC-SHA-256) │
│             │                            │                │
│             │  ┌────── if reused ────────┴────────┐       │
│             │  │ ALL of user's refresh tokens     │       │
│             │  │ revoked + audit-log              │       │
│             │  │ 401 "already_used"               │       │
│             │  └──────────────────────────────────┘       │
│             │                            │                │
│             │   200 { token, tokenExpiresAt, │            │
│             │         refreshToken,          │            │
│             │         refreshTokenExpiresAt }│            │
│             │ ◀───────────────────────────────              │
└─────────────┘                            └────────────────┘
```

**Reuse-detection contract**: every refresh token is one-time-use. The
DB row carries `usedAt` (when it was redeemed) and `replacedById`
(pointer to the rotated successor). A second attempt to redeem the
same token is a hard 401 and triggers `revokeAllForUser` for that
user-device pair. Treat any 401 from `/api/auth/refresh` as
"clear Keychain + show login".

### 3.1 Race-safe iOS refresh strategy

1. Detect `accessTokenExpiresAt - now < 5 min` BEFORE the request.
2. Wrap refresh in a serial queue — never run two `POST /api/auth/refresh`
   concurrently from the same device. The server allows it (the second
   call gets a 401 "already_used") but you lose the user's session.
3. On `401 Invalid token` from any protected route, try refresh exactly
   once; if that 401s too, clear Keychain.

---

## 4. Withings OAuth (3-leg flow)

Web-only in v1.4.25. iOS users connect Withings from the web Settings
page; the resulting connection lives on `WithingsConnection` (1:1 with
User) and the iOS app then reads the synced measurements through the
same protected endpoints. There is no native iOS Withings flow.

```
┌──── web browser ────┐    ┌──── HealthLog ────┐    ┌──── Withings ────┐
│ GET /api/withings/  │                              │                  │
│  connect            │ ─▶                           │                  │
│ (session cookie)    │   Sets withings_state cookie │                  │
│                     │   + 302 to authorize URL ──▶ │                  │
│                     │                              │                  │
│  user logs in,      │                              │                  │
│  approves scopes    │                              │                  │
│  user.metrics +     │                              │                  │
│  user.activity      │                              │                  │
│                     │   302 ?code=...&state=... ◀─ │                  │
│ GET /api/withings/  │                              │                  │
│  callback?code&state│ ─▶ verify state cookie       │                  │
│                     │   exchangeCode (server→Withings)                │
│                     │ ─────────────────────────────▶                  │
│                     │   ◀──── access+refresh tokens                   │
│                     │   encrypt + upsert WithingsConnection           │
│                     │   scope = "user.metrics,user.activity"          │
│                     │   setupWebhook (path-segment secret)            │
│                     │   302 /settings/integrations?withings=success   │
└─────────────────────┘                              └──────────────────┘
```

### 4.1 Scope contract

```typescript
// from src/lib/withings/client.ts:42
export const WITHINGS_OAUTH_SCOPE = "user.metrics,user.activity" as const;
```

Legacy v1.4.24- connections sit on `user.metrics` only — the v1.4.25
UI surfaces a reconnect banner inviting them to re-auth so the
activity/sleep endpoints unlock. The iOS app does NOT participate in
this flow; it reads the user's `WithingsConnection.scope` via
`GET /api/auth/me` if it needs to advertise "Withings activity:
available / not yet".

### 4.2 Webhook secret as path segment (v1.4.25 W17a)

The Withings webhook lives at `/api/withings/webhook/<secret>`. The
shared secret travels as a path segment, not `?secret=...`, so it
stays out of `query_string` access logs. Legacy `/api/withings/webhook?secret=...`
remains for one release cycle (removal target v1.4.27).

```typescript
// from src/app/api/withings/webhook/[token]/route.ts:29
async function verifyTokenSegment(token: string | undefined): Promise<boolean> {
  const expected = process.env.WITHINGS_WEBHOOK_SECRET;
  if (!expected) return false;
  if (!token) return false;
  return timingSafeStringEqual(expected, token);
}
```

iOS does NOT call this endpoint. Withings does. See `17-error-handling.md`
§4 (Fix-J: secret redaction in logs).

---

## 5. What `requireAuth()` actually checks

```typescript
// from src/lib/api-handler.ts:213
export async function requireAuth(
  requiredPermission?: string,
): Promise<AuthContext> {
  // 1. Session cookie — unchanged.
  const sessionData = await getSession();
  if (sessionData) return sessionData;

  // 2. Bearer-token path.
  const authHeader = await headers().then(h => h.get("authorization")).catch(() => null);
  if (authHeader?.startsWith("Bearer ")) {
    return authenticateBearer(authHeader.slice(7), requiredPermission);
  }

  // 3. No credentials.
  throw new HttpError(401, "Not authenticated");
}
```

**Auth precedence**:

1. Valid session cookie → cookie path (admin elevation possible).
2. `Authorization: Bearer hlk_<...>` → API token path.
3. Neither → 401.

`requireAuth()` never accepts BOTH paths simultaneously — cookie wins
when present.

### 5.1 Permission scopes

| Scope on `ApiToken.permissions` | Meaning |
| --- | --- |
| `["*"]` | Wildcard — passes every authenticated route, with or without `requiredPermission` |
| `["medication:ingest"]` | Narrow — only routes that declare this scope |
| `[]` | Empty — passes routes that declare no scope, fails any scoped route |

**v1.4.25 W10 fix (relevant for iOS)**: routes that don't declare a
`requiredPermission` now accept ANY authenticated token (narrow or
wildcard). Previously narrow-scope tokens 403'd routes like
`/api/personal-records`, `/api/medications/[id]/glp1`,
`/api/dashboard/glp1`. The iOS app ships with wildcard `["*"]` from
login, so it sees this fix only as fewer surprise 403s when the user
manually creates a narrow-scope token for n8n etc.

### 5.2 Admin-only

`requireAdmin()` is **cookie-only**. Bearer tokens never elevate, no
matter the scope. iOS app cannot reach admin surfaces, full stop.

---

## 6. 401 vs 403 — what each means and what iOS does

| Status | Server says | iOS client should |
| --- | --- | --- |
| 401 `Not authenticated` | No credentials at all | Show login; never auto-retry |
| 401 `Invalid token` | Bearer token unknown, revoked, or its user is gone | Try refresh exactly once; if that 401s, clear Keychain |
| 401 `Token expired` | Token's `expiresAt` is past | Refresh immediately |
| 401 `Refresh token reuse detected` | One-time-use violated | Clear Keychain; show login with a "logged you out for safety" toast |
| 403 `Insufficient permissions` | Token is valid but scope is wrong | Surface as bug — iOS only ever uses wildcard. Do not retry |
| 403 `Admin access required` | Bearer tried to hit admin route | Bug in client; do not retry |

All envelope shape: `{ "data": null, "error": "<string>", "meta"?: {...} }`.
Codes are in `meta.errorCode` when present; see `17-error-handling.md` §2.

---

## 7. Apple Health auth — iOS-native, server is passive

Apple Health authorisation is **entirely client-side**. The user
grants HealthKit read permissions to the HealthLog app via the iOS
HealthKit consent sheet. The server never sees Apple credentials,
never holds an OAuth token, never knows which permissions were
granted.

What the server DOES need back:

| Signal | Server column | Why |
| --- | --- | --- |
| First successful ingest | `User.healthKitLastSyncedAt` | Settings UI surfaces "last synced N min ago" |
| Per-metric enable/disable | `User.healthKitConfigJson.entries[]` | UI lets the user toggle which HK metrics to sync; server doesn't enforce anything but renders the list |
| Device APNs token | `Device.apnsToken` (POST `/api/devices`) | Background-sync push (medication reminder, weekly briefing) |

**Push tokens**: a single iOS device registers in two steps:

1. `POST /api/devices` with `{ platform: "ios", token: <bundleToken>, bundleId, locale, appVersion, model }`.
2. After `application:didRegisterForRemoteNotificationsWithDeviceToken:`,
   `PATCH /api/devices/{id}` with `{ apnsToken, apnsEnvironment: "sandbox" | "production" }`.

The `Device.token` is unique across users; re-registering on a
different account is a 409 (cross-user-hijack guard).

---

## 8. Logout / device revocation

### 8.1 Single-device logout

```
POST /api/auth/refresh
Content-Type: application/json

{ "refreshToken": "<current>", "revoke": true }
```

Returns `200 { revoked: true | false }` and revokes the row server-
side. Drop both tokens from Keychain.

### 8.2 "Log out everywhere"

There is no single endpoint in v1.4.25 — the web surface uses
`destroyAllSessions(userId)` which kills sessions but not API tokens.
For iOS, the user must revoke each device from web Settings → Devices.
v1.5 backlog item: a `POST /api/auth/me/revoke-all` that nukes every
Session + RefreshToken + Device for the user.

---

## 9. Self-test snippet — the contract every iOS auth call honours

```typescript
// Pseudo-Swift — what every protected request looks like:
var req = URLRequest(url: u)
req.setValue("Bearer \(keychain.accessToken)", forHTTPHeaderField: "Authorization")
req.setValue("native", forHTTPHeaderField: "X-Client-Type")
req.setValue("HealthLog-iOS/1.0 (iPhone 15; iOS 18.2)", forHTTPHeaderField: "User-Agent")
req.setValue(keychain.deviceId, forHTTPHeaderField: "X-Device-Id")  // refresh only
req.setValue(idempotencyKey.uuidString, forHTTPHeaderField: "Idempotency-Key")  // POSTs only
```

| Header | Required | Where |
| --- | --- | --- |
| `Authorization: Bearer hlk_<...>` | yes (except login + refresh + Withings webhook) | Every protected route |
| `X-Client-Type: native` | recommended | Every request; locks the 24h+60d policy |
| `User-Agent: HealthLog-iOS/...` | yes | Audit-log breadcrumb + `Mozilla/` detection guard |
| `X-Device-Id: <uuid>` | refresh-time | Per-device refresh-token rotation + revocation pivot |
| `Idempotency-Key: <uuid>` | yes on POST/PUT/PATCH/DELETE | Replay protection — see `17-error-handling.md` §3 |
| `Content-Type: application/json` | yes on every body-carrying call | `safeJson()` rejects anything else with 415 |

---

## 10. What is NOT in this file

- **Error envelopes, rate-limit response shape** → `17-error-handling.md`
- **Cookie names + their UX purpose** → web docs (web devs, not iOS)
- **Codex / ChatGPT OAuth** → `14-coach-mental-model.md` § Provider routing — iOS does not participate

**Cookies the iOS app may observe but never sets**:

| Cookie | Purpose |
| --- | --- |
| `healthlog_session` | Web session id (httpOnly, lax) |
| `healthlog-locale` | UI locale preference (not httpOnly) |
| `hl_onboarding` | UX hint "pending" while `onboardingCompletedAt IS NULL` — proxy uses it to short-circuit redirect |
| `withings_state` | CSRF nonce for the OAuth callback only |
