---
file: 17-error-handling.md
purpose: Error envelopes, 4xx/5xx semantics, Idempotency-Key for retries, rate-limit response shape (and the Postgres-anchored login limiter that survives restart), pg-boss DLQ behaviour, auditLog interpretation, safeRequestProp narrow-catch, recent fixes (Fix-J/K/M).
when_to_read: Before writing the iOS retry layer. Before parsing any non-200 response. Whenever a test sees an unexpected 500.
prerequisites: 05-auth-flows.md, 08-locked-contracts.md.
estimated_tokens: 3000
version_anchor: v1.4.25 / sha 49f71c92
---

# Error Handling — v1.4.25

> **TL;DR.** Every JSON response is `{ data, error, meta? }`. 4xx are
> client-correctable (validation, auth, idempotency replay, rate
> limit); 5xx mean server-side bug — retry with backoff. Login rate
> limiter is Postgres-anchored (survives restart), so iOS cannot
> defeat lockout by waiting for a deploy. `auditLog` rows surface
> every auth event.

---

## 1. Response envelope

```typescript
// from src/lib/api-response.ts:1
export function apiSuccess<T>(data: T, status = 200) {
  return NextResponse.json({ data, error: null }, { status });
}

export function apiError(message: string, status = 400, meta?: {
  errorCode?: string;
  headers?: Record<string, string>;
} & Record<string, unknown>) {
  // { data: null, error: <message>, meta?: { errorCode, ... } }
}
```

| Outcome | Shape |
| --- | --- |
| Success | `{ "data": <T>, "error": null }` |
| Failure | `{ "data": null, "error": "<message>", "meta"?: { "errorCode"?: "...", ... } }` |
| 429 (rate-limit) | failure shape + `X-RateLimit-Remaining` / `X-RateLimit-Reset` headers |

**Locked rule**: iOS reads `error` as the user-displayable string and
`meta.errorCode` as the translation key when present. The server's
English message is the fallback when `meta.errorCode` is missing.

---

## 2. Status-code semantics

| Status | Meaning | iOS action |
| --- | --- | --- |
| 200 | Success | Decode `data` |
| 200 (idempotency replay) | Cached response — see §3 | Treat identically to fresh success |
| 400 `Invalid JSON body` | Malformed JSON | Bug; fix DTO encoder |
| 401 | Unauthenticated / expired / refresh reuse | See `05-auth-flows.md` §6 |
| 403 | Insufficient scope or admin-only | Bug; iOS uses wildcard scope — should never see |
| 404 | Resource doesn't belong to user or doesn't exist | Surface "not found" UI |
| 409 | Conflict — onboarding-step race, duplicate Device.token, disclaimer version drift | Refetch state, redo write |
| 413 | Workout batch >5 MB | Paginate further |
| 415 | Wrong `Content-Type` | Bug; set `application/json` |
| 422 | Zod validation failure | Surface to user — never retry |
| 429 | Rate-limited | Backoff per `X-RateLimit-Reset` |
| 500 | Server bug | Retry with exponential backoff (max 3); report via Settings → Feedback |
| 502 / 503 | Coolify front layer | Retry with exponential backoff |

### 2.1 Error-code vocabulary (`meta.errorCode`)

| Code | Where | Meaning |
| --- | --- | --- |
| `measurement.batch.too_large` | `POST /api/measurements/batch` | Batch >500 entries |
| `credentials_rejected` | Settings → integrations | Withings creds invalid |
| `already_used` | `POST /api/auth/refresh` | Refresh token reuse — clear Keychain |
| `disclaimer_version_drift` | `POST /api/auth/me/research-mode` | Resubmit with current `currentDisclaimerVersion` |
| `inventory_state_conflict` | `PATCH /api/medications/[id]/inventory/[itemId]` | State-machine rejected transition — refetch and retry |

The list expands with every release. Treat unknown codes as "show
`error` text verbatim".

---

## 3. Idempotency-Key contract (retry safety)

```typescript
// from src/lib/idempotency.ts:1
// Mobile clients send `Idempotency-Key: <uuid>`. The first request runs
// the handler normally and the response (status + body) is cached. Any
// retry within the TTL (24h) for the same `(userId, key, method, path)`
// tuple returns the cached envelope as the original status — no second
// side-effect.

const TTL_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KEY_REGEX = /^[A-Za-z0-9_\-:.]{8,128}$/;
```

| Rule | Value |
| --- | --- |
| Header name | `Idempotency-Key` |
| Key format | `[A-Za-z0-9_\-:.]{8,128}` — UUIDv4 (`8-4-4-4-12` = 36 chars) passes |
| TTL | 24 hours |
| Dedup tuple | `(userId, key, method, path)` |
| Methods | POST / PUT / PATCH / DELETE |
| Replay status | Original status (not always 200 — a 422 replay is still 422) |

**iOS pattern**:

1. Generate a `UUID().uuidString` for every state-changing call.
2. Persist it together with the request body **until** you see a
   terminal response (any 2xx, 4xx).
3. On a connectivity drop / 5xx, retry with the SAME key.
4. Drop the key once a non-replay response lands.

**Edge case**: if the user posts the same logical change twice (e.g.
two manual weight entries), they MUST be different idempotency keys.
Two distinct intents — two keys. Same intent — one key.

---

## 4. Rate-limiting

```typescript
// from src/lib/rate-limit.ts:21
// Atomic upsert via raw SQL — safe for concurrent requests.
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  // INSERT INTO rate_limits (...) ON CONFLICT (key) DO UPDATE ...
}
```

**Backed by `RateLimit` Postgres table.** Survives server restart —
this is the v1.4.26 backlog finding cited in the brief: a user who
tripped login lockout cannot wait for a Coolify deploy to clear it.
The atomic upsert keeps multi-instance Coolify deploys correct.

### 4.1 Limits the iOS app hits

| Key | Limit | Window | Failure |
| --- | --- | --- | --- |
| `auth:login:<ip>` | 5 | 15 min | 429 + headers |
| `auth:refresh:<ip>` | 60 | 15 min | 429 |
| `measurements:batch:<userId>` | 60 | 1 min | 429 |
| `workouts:batch:<userId>` | 60 | 1 min | 429 |
| `medication.glp1.update:<userId>` | 30 | 1 min | 429 (Fix-K) |

### 4.2 429 response shape

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 2026-05-14T12:34:56.000Z

{"data": null, "error": "Too many login attempts. Please try again later."}
```

**iOS contract**: parse `X-RateLimit-Reset` as ISO-8601, schedule the
retry at that instant (+ small jitter). Never poll until success;
respect the timestamp.

---

## 5. pg-boss DLQ behaviour

HealthLog uses `pg-boss` for background jobs (reminder dispatch,
withings sync, host metrics, PR detection, inventory expire). Jobs
that throw N times land in pg-boss's failure state — the in-DB
`pgboss.job` table carries `state = 'failed'` plus `output` (the
serialised error). There is **no separate DLQ table**.

| Job | Retry | Visible to iOS? |
| --- | --- | --- |
| `pr-detection` | 1 retry, 30s gap | No — enqueued by batch ingest, fallback cron picks up missed users every 30 min |
| `medication-inventory-expire` | None (daily idempotent batch) | No |
| `reminder-phase` | 3 retries | No — drives Telegram + push, not iOS-direct |
| `withings-sync` | 3 retries with backoff | No — the next sync picks up where the failed one stopped |

iOS does not enqueue pg-boss jobs directly. Every job runs server-
side; iOS only sees the **effects** (a new PR appears, an inventory
item flips to `EXPIRED`).

---

## 6. AuditLog rows — how iOS reads them

```prisma
model AuditLog {
  id        String   @id @default(cuid())
  userId    String?  @map("user_id")
  action    String   // e.g. "auth.login", "measurement.create"
  details   String?  // JSON string (no sensitive data)
  ipAddress String?
  location  String?  // "Berlin, DE" resolved from IP
  createdAt DateTime @default(now())
}
```

| `action` prefix | Surface |
| --- | --- |
| `auth.login.*` | Login attempts (password, passkey, codex) |
| `auth.token.*` | Bearer / refresh issue, rotation, revoke |
| `auth.bearer.*` | Per-request Bearer auth success / failure |
| `measurement.*` | Single + batch ingest, edit, delete |
| `medication.*` | CRUD, GLP-1 dose/inventory updates |
| `personal_records.*` | Detection-worker enqueues |
| `export.*` | CSV / doctor-report / full-backup |
| `withings.*` | Connect / disconnect / sync attempt |

**Geo enrichment**: only `auth.*` rows attempt `lookupIpLocation()` —
results land in `location` after a 3s race. Other rows leave
`location` NULL.

**iOS contract**: there is no iOS-side audit screen in v1.5.
`/api/auth/me/audit` is web-only. Operator audits run from Settings →
Activity (web).

---

## 7. The `safeRequestProp` narrow-catch — what gets swallowed

```typescript
// from src/lib/api-handler.ts:52
function isTolerableRequestProbeError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message ?? "";
  return (
    msg.includes("private member") ||
    msg.includes("private field") ||
    msg.includes("private name") ||
    /Cannot read propert(?:y|ies)\b.*\bof (?:undefined|null)\b/.test(msg)
  );
}

function safeRequestProp<R>(request: unknown, read: (req: NextRequest) => R, fallback: R): R {
  try {
    return read(request as NextRequest);
  } catch (err) {
    if (isTolerableRequestProbeError(err)) return fallback;
    throw err;
  }
}
```

**What it tolerates**: V8 private-field TypeErrors (`NextRequest`
proxy `#state` access) + "Cannot read property X of undefined/null"
(vitest direct-invoke or Next.js force-static placeholder reduced to
`undefined`).

**What it does NOT tolerate**: any other TypeError, any other Error
class. Those re-throw — `apiHandler` catches them and returns 500
with GlitchTip reporting.

**For iOS**: this is invisible to you. It exists so server-side tests
can invoke route handlers as `GET()` without a NextRequest argument.
Mention it only when reviewing a server PR — never special-case it
in client code.

---

## 8. Recent fixes — what they mean for iOS

### 8.1 Fix-J — Withings webhook secret redaction (sec-C1)

Pre-fix: `WITHINGS_WEBHOOK_SECRET` landed in `http.path` of every
Wide Event (stdout, in-memory ring buffer, Loki). Post-fix: the
redactor in `src/lib/logging/redact.ts` strips path-segment secrets
matching the webhook path pattern.

**iOS impact**: none directly. If an operator hands you a log dump
for triage, the secret will already be redacted — don't try to use
it.

### 8.2 Fix-K — GLP-1 endpoint hardening (sec-H1)

Pre-fix: `POST /api/medications/[id]/glp1` skipped Zod, audit-log,
and rate-limit. Post-fix:

- Bounded Zod schemas (`glp1DoseChangePostSchema`,
  `glp1InventoryPostSchema`) — unknown fields → 422.
- `auditLog("medication.glp1.update", ...)` on every call.
- 30/min/user rate limit (sibling-route parity).

**iOS impact**: validate your DTO before posting. Bad fields used to
silently land in `MedicationDoseChange.note` (parsing escape hatch);
now they're rejected with 422.

### 8.3 Fix-M — Inventory state-machine + workout schema gate

| Sub-fix | What broke | What changed |
| --- | --- | --- |
| code-H1 | Inventory PATCH bypassed state machine on `markAsFirstUseAt` | Re-runs `computeInventoryState()` after composing next-state view |
| code-H3 | `expireStaleInUseItems` looped `prisma.update` per row | One `updateMany` |
| code-M2 | `createWorkoutSchema` accepted `endedAt < startedAt` | `.superRefine` gate — 422 on inversion; PR detector zero-duration guard |
| code-M7 | Onboarding step write was fetch-then-update (race) | Conditional update on `{ id, onboardingStep: current, onboardingCompletedAt: null }` returns 409 |

**iOS impact**:

1. Workout ingest — never let `endedAt - startedAt = 0` slip through.
2. Onboarding step writes — handle 409 by GETting the latest state
   and retrying with the fresh `current` value.

---

## 9. Self-test snippet — minimum viable retry layer

```text
function send(req):
  key = req.idempotencyKey            # generate once, persist alongside body
  attempt = 0
  loop:
    response = http.post(req, header "Idempotency-Key" = key)
    case response.status:
      200..299: return response
      400, 415, 422: return response   # client bug — surface immediately
      401:
        if !triedRefresh: refresh(); triedRefresh = true; continue
        else: clearKeychain(); navigateLogin(); return
      403: return response             # bug; report
      409: state = refetch(); merge(state, req); continue
      429:
        delay = (X-RateLimit-Reset) - now + jitter
        wait delay; continue
      500..599:
        attempt += 1
        if attempt > 3: return response
        wait min(60s, 2^attempt) + jitter
        continue
```

---

## 10. What is NOT in this file

- **Auth flows + token lifetimes** → `05-auth-flows.md`
- **Coach refusal copy and parsing** → `08-locked-contracts.md` §1, `14-coach-mental-model.md` § Refusal
- **Glossary (Wide Event, GlitchTip, pg-boss, DLQ)** → `20-glossary.md`
