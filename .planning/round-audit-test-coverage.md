# Test Coverage Audit — 2026-05-16

## Executive summary

Coverage is thick on pure helpers and route-edge validation but thin where it
matters most: every long-running irreversible mutation (login by password,
password change with token wipe, password reset, Withings OAuth handshake,
Withings full-sync orchestration, Apple Health worker, force-logout) is either
unit-mocked or untested at the route level. Two known parallel-isolation
flakes (`apns-dispatch`, `integration-status`) still rely on
`fileParallelism: false`. There is no enforced perf assertion anywhere — the
v1.4.34.1 100k-row regression that triggered this round has no test that would
catch it tomorrow. No visual-regression suite exists; that gap is acceptable
for an audit-grounded layout, but should be acknowledged.

## Findings — prioritized

### F-1: `POST /api/auth/password` has zero route-level tests despite the new token-wipe codepath

**Severity**: critical
**Category**: critical-path gap
**File(s)**: `src/app/api/auth/password/route.ts:22-97` (no `__tests__/` sibling)
**What's wrong**: The password-change handler runs `destroyAllSessions(user.id)`
which deletes sessions + revokes API tokens + revokes refresh tokens in one
transaction (`src/lib/auth/session.ts:174-186`). This is the v1.4.34.3 fix.
No test asserts the transaction is invoked, no test asserts the
freshly-issued session survives the wipe, no test asserts the same-password
guard returns 422, and no test asserts the rate-limit short-circuits at six
attempts. The integration suite has nothing either — `auth-flow.test.ts`
covers `createSession`/`destroySession` only.
**Fix shape**: `tests/integration/auth-password-change.test.ts`
- POST with correct current password wipes every sibling session (+ revokes refresh tokens, + revokes API tokens) and the response cookie carries the new session
- POST with wrong current password leaves every session intact and returns 401
- POST with identical current+new returns 422 without touching the password hash
- Sixth call inside the 15-minute window returns 429
- Strength-checker rejection (weak password) returns 422 + does NOT wipe sessions

**Effort**: small

### F-2: No route test for `passkey/register-options`, `passkey/register-verify`, `passkey/login-options`, `auth/register`, `auth/refresh`

**Severity**: critical
**Category**: critical-path gap
**File(s)**:
- `src/app/api/auth/passkey/register-options/route.ts` (no test)
- `src/app/api/auth/passkey/register-verify/route.ts` (no test)
- `src/app/api/auth/passkey/login-options/route.ts` (no test)
- `src/app/api/auth/register/route.ts` (no test)
- `src/app/api/auth/refresh/route.ts` (no test — `src/lib/auth/__tests__/refresh-token.test.ts` covers only the helper)
**What's wrong**: Only `auth/passkey/login-verify/__tests__/native-token.test.ts`
and `auth/login/__tests__/native-token.test.ts` exist on the auth routes, and
both target the native-Bearer branch — the web-cookie branch is untested. The
WebAuthn ceremony is purely server-side; a regression in the challenge-store
roundtrip ships silently.
**Fix shape**: one integration file per route
- register-options issues a challenge, persists it in `auth_challenges`, refuses concurrent challenges for the same user
- register-verify rejects a stale challenge (>5 min), rejects an attestation that doesn't match the persisted challenge, persists the credential
- login-options refuses to enumerate credentials for an unknown username
- /api/auth/register: weak-password 422, duplicate-username 409, valid signup writes session cookie + emits audit
- /api/auth/refresh: expired refresh returns 401 + revokes parent, valid rotates and returns new access+refresh pair

**Effort**: medium

### F-3: Withings OAuth `exchangeCode` + `refreshAccessToken` + `/api/withings/callback` have no test

**Severity**: critical
**Category**: critical-path gap
**File(s)**:
- `src/lib/withings/client.ts:131-156` (refreshAccessToken — no test in `client.test.ts`)
- `src/lib/withings/client.ts` (exchangeCode — same)
- `src/app/api/withings/callback/route.ts` (no `__tests__/` sibling)
- `src/app/api/withings/connect/route.ts` (no test)
- `src/app/api/withings/sync/route.ts` (no test)
- `src/app/api/withings/disconnect/route.ts` (no test)
**What's wrong**: `client.test.ts` is 378 lines exclusively on `MEASURE_TYPE_MAP`
+ scope helpers + `WITHINGS_NOTIFY_APPLIS`. The two functions that handle
the actual OAuth credentials (the only thing standing between a healthy
connection and a forever-broken integration) are not exercised. Webhook
delivery is tested; the credential lifecycle is not. CSRF state-cookie
comparison in `callback/route.ts:24-37` uses `timingSafeEqual` — that branch
is reachable only by the test that doesn't exist.
**Fix shape**: `src/lib/withings/__tests__/oauth.test.ts` + `tests/integration/withings-oauth.test.ts`
- exchangeCode: happy POST encodes credentials, persists encrypted, calls `subscribeWebhook`
- exchangeCode: Withings status≠0 throws + writes `recordSyncFailure`
- refreshAccessToken: rotates encrypted tokens in place, refresh failure parks integration via `parkIntegrationAtReauth`
- /api/withings/callback: state-mismatch returns 302 to `withings=error&reason=state`, valid code persists tokens
- /api/withings/disconnect: revokes credentials and writes audit row

**Effort**: medium

### F-4: Apple Health import worker untested end-to-end; `partial-failure` recovery has no fixture

**Severity**: high
**Category**: integration gap
**File(s)**: `src/lib/jobs/apple-health-import-worker.ts` (no `__tests__/` sibling),
`src/lib/measurements/__tests__/import-apple-health-export.test.ts:378` (memory ceiling but no kill-and-resume)
**What's wrong**: The parse helpers are well tested at the unit level, but the
pg-boss worker that wires extraction → parse → upsert into `ImportJob` rows
has no test. A worker crash mid-batch (the `phases: queued → unpacking →
parsing → upserting → done` state machine documented in
`.planning/research/v1434-r-1-xml-import.md`) is the documented failure mode;
the resume codepath was never exercised. The admin variant under
`src/app/api/admin/import-apple-health-export/__tests__/` covers route
validation but not the full pipe.
**Fix shape**: `tests/integration/apple-health-import-worker.test.ts`
- queue → unpacking → parsing → upserting → done with a 200-row fixture writes 200 measurement rows
- worker throws mid-`upserting` → re-running the same job ID resumes at last committed phase, ends in `done`, total inserts unchanged
- malformed XML transitions `ImportJob.status` to `failed` with diagnostic text, no half-written measurements remain

**Effort**: medium

### F-5: No perf assertion gate exists; 100k-row regression cannot be caught by the suite

**Severity**: high
**Category**: perf-test gap
**File(s)**: `tests/integration/insights-comprehensive-cache.test.ts`,
`tests/integration/analytics-bp-aggregate-paged.test.ts` (both only assert correctness),
`src/lib/insights/comprehensive-aggregator.ts` (the route under load)
**What's wrong**: `.planning/round-v1434-prod-slowness-investigation.md` traces
the original incident to pool starvation + per-route row-walks on dashboards
with multi-year histories. The fix (server-cache + pool-size config) is now
in place, but nothing in CI asserts the route stays under budget. A future
N+1 regression on `/api/analytics` will resurface in production the same way.
The memory-ceiling assertion in `import-apple-health-export.test.ts:378` is
the only quantitative guard in the suite.
**Fix shape**: `tests/integration/perf-budget.test.ts` (tagged `@slow`, opt-in via env)
- seed 100k measurements across 30 types for one user, cold-cache `/api/analytics` finishes < 1 s (assert via `performance.now()` median over 5 runs)
- warm-cache second hit < 50 ms (validates server-cache layer)
- `/api/insights/comprehensive` cold under same fixture < 1.5 s
- `/api/gamification/achievements` cold < 750 ms

**Effort**: medium. Mark `[hotfix-ready]` only for the warm-cache assertion (< 1h once seeder helper lands).

### F-6: Cache-invalidation coverage limited to two write surfaces; 16 more write endpoints unverified

**Severity**: high
**Category**: integration gap
**File(s)**: `tests/integration/server-cache-routes.test.ts` (covers analytics
invalidation on measurement POST + medication-intake invalidation only),
write sites that call `invalidateUser*` and have no integration assertion:
- `src/app/api/measurements/[id]/route.ts` (PATCH + DELETE)
- `src/app/api/measurements/batch/route.ts`
- `src/app/api/measurements/by-external-ids/route.ts`
- `src/app/api/mood-entries/route.ts` (POST + DELETE branches)
- `src/app/api/mood-entries/bulk/route.ts`
- `src/app/api/mood-entries/[id]/route.ts`
- `src/app/api/medications/route.ts` (POST + PATCH)
- `src/app/api/medications/[id]/route.ts`
- `src/app/api/medications/[id]/intake/route.ts`
- `src/app/api/medications/[id]/intake/[eventId]/route.ts`
- `src/app/api/medications/intake/bulk/route.ts`
- `src/app/api/workouts/batch/route.ts`
- `src/app/api/dashboard/widgets/route.ts`
- `src/app/api/dashboard/chart-overlay-prefs/route.ts`
- `src/app/api/auth/me/timezone/route.ts` (covered by `timezone-per-user.test.ts`)
- `src/app/api/insights/comprehensive/route.ts` (PUT — covered by `insights-comprehensive-cache.test.ts`)

**What's wrong**: A single missed `invalidateUserMeasurements(userId)` on any
write path silently produces stale dashboard reads for up to the TTL (60 s).
The blueprint in `.planning/research/v1434-r-cache-aggregation.md` §3 names
every surface; the test suite covers two of them. The pattern is
copy-pasteable.
**Fix shape**: extend `server-cache-routes.test.ts` with one parametric block
- for each `[route, mutation, evicts]` triple, prime cache → mutate → re-read → assert MISS
- assert the cache key for a different user is NOT evicted (cross-user isolation)

**Effort**: small (one helper + 16 invocations)

### F-7: Provider-chain "no provider configured" fallback has no test

**Severity**: medium
**Category**: critical-path gap
**File(s)**: `src/lib/insights/no-key-fallbacks.ts:1-200` (no `__tests__/no-key-fallbacks.test.ts`)
**What's wrong**: When the provider chain exhausts (`AllProvidersFailedError`)
or a user has zero providers configured, the insight surface falls back to
the static localised body in `no-key-fallbacks.ts`. The file ships six
locales' worth of fallback text. The DE/EN router is one branch with two
arms; the EN-arm is what every FR/ES/IT/PL user actually sees today. No test
guards against a typo in a fallback string that would leak to production for
non-DE users on the most common "no key configured" path.
**Fix shape**: `src/lib/insights/__tests__/no-key-fallbacks.test.ts`
- each `getNoKey*Text(locale)` returns the DE body iff `locale === "de"`, EN body otherwise
- every exported helper returns a non-empty string for every shipped `Locale`
- assertion that EN body length > 80 chars (prevents accidentally shipping the DE body to EN users — same as the umlaute-required guard but inverted)

**Effort**: trivial `[hotfix-ready]`

### F-8: Parallel-isolation flakes are masked by `fileParallelism: false`, not fixed

**Severity**: medium
**Category**: flaky test
**File(s)**:
- `tests/integration/apns-dispatch.test.ts:144-260` (three cases share Device + NotificationChannel state)
- `tests/integration/integration-status.test.ts:147-198` (the burst-dedup case shares an in-memory rate-limiter)
- `vitest.integration.config.mts:23-25` (`fileParallelism: false, isolate: false`)
**What's wrong**: The configured serial-fork run hides the underlying problem
— both files mutate process-level state (the `apnsSendMock`/`apnsShutdownMock`
factory and the alert-dedup window) that survives across `beforeEach`
truncations. A future contributor enabling parallelism (or moving to
`vitest@5` with isolation defaults flipped) will re-trigger the failures.
**Fix shape**:
- factor the APNs provider mock into a module-level factory keyed on
  `process.pid + test name` so each `vi.mock` resolves to a fresh stub
- replace `truncate users` reliance with explicit cleanup of
  `audit_logs` / `integration_statuses` so the dedup test starts from a known
  zero-row baseline
- once both green under `fileParallelism: true`, flip the config back

**Effort**: small

### F-9: e2e journey holes — no full "login → measurement → chart → mood → correlation → insight → review" path

**Severity**: medium
**Category**: e2e gap
**File(s)**: `e2e/measurement-flow.spec.ts:18-50` (mocks every fetch),
`e2e/dashboard.spec.ts:122-163` (renders empty fixtures),
`e2e/insights-generate.spec.ts:24-30` (mocked AI),
`e2e/onboarding-flicker.spec.ts:28-130` (still failing on main per the
v1.4.34 closure note)
**What's wrong**: The current e2e coverage is good at smoke-level
"does the surface render" but every spec stubs the API. There is no spec
that drives a real Postgres-backed journey from login through to an insight
review. The Withings + Apple Health connect/sync surfaces have NO e2e
coverage at all. Onboarding-flicker has been failing since v1.4.34 and
is referenced in user memory but not in the suite. Mobile-viewport
touch-target ≥ 44 × 44 has been failing for the same window.
**Fix shape**:
- one `e2e/full-journey.spec.ts` that runs against the seeded test user and
  hits real endpoints end-to-end: log mood → log measurement → open chart →
  trigger insight (mocked AI provider that returns a canned JSON) →
  open Coach (same provider) → open Doctor Report
- a real fix for `onboarding-flicker` rather than ignoring it (the spec
  asserts cookie-driven SSR; if the cookie wiring has changed, the spec needs
  a rewrite, not a skip)
- one `e2e/withings-connect.spec.ts` that stubs the Withings OAuth endpoint
  and asserts the callback handles the state-cookie path

**Effort**: medium

### F-10: Timezone coverage stops at one non-Berlin user; locale coverage is one spec

**Severity**: medium
**Category**: locale/tz gap
**File(s)**: `tests/integration/timezone-per-user.test.ts:1-300` (Pacific/Auckland only),
`tests/integration/analytics-weekday-tz.test.ts` (assumes Berlin),
`e2e/locale-switch.spec.ts:11-50` (asserts no raw-key bleed for EN+DE only)
**What's wrong**: Six locales ship (`de/en/es/fr/it/pl`) and `messages/de.json`
+ `messages/en.json` parity is unit-asserted, but the runtime "does the page
render in this locale" is checked for EN+DE only. The DST-crossover edge
(Auckland UTC+12 → UTC+13 happens in late September) is documented in the
test comment but not asserted; the test was authored in May. UTC users and
fractional-offset zones (Asia/Kolkata UTC+05:30) have no test. Every "today"
calculation in `src/lib/timezone.ts`, `src/lib/medications/scheduling/cadence.ts`,
`src/lib/insights/medication-compliance-status.ts` assumes the resolver
delivers a stable zone, but the resolver is only directly tested for one
user.
**Fix shape**:
- parameterise `analytics-weekday-tz.test.ts` over `["UTC", "Europe/Berlin", "Pacific/Auckland", "Asia/Kolkata", "America/Los_Angeles"]`
- extend `locale-switch.spec.ts` to all six locales (use a `for` loop, same shape)
- add a unit test in `src/lib/__tests__/timezone.test.ts` that pins the DST-crossover case (Auckland 2026-09-27 02:00 NZST → 03:00 NZDT)

**Effort**: small `[hotfix-ready]` for the locale loop; small for the others

## Coverage matrix

| Critical path | Unit | Integration | e2e | Notes |
|--|--|--|--|--|
| Login (password, web cookie) | partial | yes (`auth-flow`) | yes (`login.spec`) | route covers native Bearer branch only (`auth/login/__tests__/native-token.test.ts`); password-credential validation untested at route |
| Login (passkey) | yes | gap | gap | only `login-verify/native-token.test.ts` exists; ceremony untested |
| Password change | gap | gap | gap | F-1 — route has no test, token wipe unverified |
| Password reset (admin) | gap | gap | gap | `admin/users/[id]/reset-password/route.ts` no test |
| Passkey register | gap | gap | gap | F-2 — no route tests |
| Session refresh | helper-only | gap | gap | F-2 — `/api/auth/refresh` no route test |
| Apple Health import upload | yes (helpers) | partial | gap | F-4 — worker untested, no kill-and-resume |
| Apple Health admin variant | partial | gap | gap | route validation only; pipe untested |
| Withings OAuth handshake | gap | gap | gap | F-3 — `callback`, `connect`, `disconnect`, `exchangeCode`, `refreshAccessToken` |
| Withings webhook | yes | gap | gap | both webhook surfaces well-tested at route level |
| Withings full + incremental sync | partial (mapping) | yes (sleep/activity slices) | gap | route `/api/withings/sync` untested |
| Measurement CRUD | yes | yes | partial (mocked) | strong coverage |
| Source-priority dedup | yes | yes | gap | best-covered area in the suite |
| Mood/medication intake | yes | yes | gap | bulk + idempotency well-tested |
| Compliance classifier | yes | gap | gap | classifier covered, route untested end-to-end |
| AI insights provider chain | yes | yes | gap | F-7 — no-key fallback strings untested |
| AI Coach chat | yes | yes | gap | sentinel parsing well-covered; 429 path tested |
| Doctor-report PDF | yes (core+data) | gap | yes (mocked) | section-toggle persistence covered at route level; no PII redaction toggle exists (only section toggles) |
| Admin user CRUD | yes | gap | gap | route tested at unit level only |
| Admin impersonation | n/a | n/a | n/a | feature does not exist in repo |
| Admin force-logout | gap | gap | gap | `/admin/users/[id]/force-logout` no test |
| Admin backup upload/restore | gap | yes | gap | integration tests cover happy + confirm-required + 404 |
| Admin backup run | gap | gap | gap | scheduled-run route untested |
| Cache invalidation per write | partial | partial | n/a | F-6 — 2 / 18 write surfaces verified |
| 100k-row analytics perf | gap | gap | gap | F-5 — no assertion budget anywhere |
| Time zones | partial | yes (one zone) | gap | F-10 — Auckland only, DST crossover unasserted |
| Locale e2e | n/a | n/a | partial (EN+DE) | F-10 — four locales never exercised at runtime |
| Visual regression | n/a | n/a | gap | no snapshot suite; acceptable given audit-grounded layout, but worth noting |

## Test discipline notes

- The integration suite's `fileParallelism: false` is a band-aid, not a fix
  (F-8). Plan to convert each shared-state file to per-test isolation.
- `e2e/v1427-public-pages.spec.ts` uses `test.fixme` on three otherwise-passing
  cases (`/about`, `/this-route-does-not-exist`, `/privacy`) — these should
  either be unblocked or removed; a fixme that never gets attention is dead code.
- `e2e/insights-scroll-restoration.spec.ts:27` uses `test.fixme` on the only
  meaningful assertion in the file — same disposition required.
- No snapshot testing of any kind. For an app where the value proposition is
  visual coherence (charts, tiles, hero card), a Playwright `toHaveScreenshot`
  pass on two breakpoints × three locales × five key pages would close the
  gap at low cost (one CI minute, no fixture seeding).
