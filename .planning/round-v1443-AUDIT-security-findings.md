# v1.4.43 Security audit findings

Scope: sweep of every security surface for the v1.4.43 release. `develop`
is at `7daff01a` (post v1.4.42 merge). Reviewer: W-AUDIT-SECURITY
(read-only, static review).

## Verdict
APPROVE_WITH_FIXES

The crypto, OAuth, encryption-at-rest, webhook-auth, rate-limit and
admin-gating surfaces are solid. No Critical / data-leak / auth-bypass
issues. Two High findings (PII in `auth.login.failed` audit row, audit
ledger writes carrying un-capped strings) should land before tag — they
are small, isolated fixes that close PII / log-growth gaps the
v1.4.20 retroactive directive explicitly forbids. Several Mediums are
defence-in-depth strengtheners; the Lows are deferable to v1.4.44.

## Critical (must fix before tag — vuln / data leak / auth bypass)

None.

## High (should fix before tag — defence-in-depth gap, log leak, error swallow)

### H-1 `auth.login.failed` persists the raw typed identifier in `AuditLog.details`
- **File**: `src/app/api/auth/login/route.ts:60-65`.
- **Attack vector**: When the user-lookup branch of `/api/auth/login`
  fails (no matching user OR no `passwordHash`), the handler writes
  `auditLog("auth.login.failed", { ipAddress: ip, details: { identifier, reason: "user_not_found_or_no_password" } })`.
  `identifier` is `parsed.data.email.trim()` — i.e. exactly what the
  caller typed. This persists the raw email or username string into
  `AuditLog.details` JSON forever (audit rows never expire by design).
  Three concerns:
  1. The v1.4.20 retroactive-cleanup directive forbids ALL user-facing
     PII in any operator-readable artefact, and `/api/admin/audit-log`
     surfaces this row to the admin. An admin scrolling the audit log
     sees every wrong-email a user typo'd at the login screen.
  2. A failed brute-force probe of a guessed email lands in the audit
     ledger with the guessed string, so an attacker who later compromises
     the audit table walks away with a list of valid + invalid email
     candidates each user-not-found row was probed against.
  3. The successful-login + invalid-password branches (lines 70-75) do
     NOT carry the identifier — they hash to a `userId` instead. The
     user-not-found branch is the only one that leaks because no
     `userId` exists at that point. Replace with a one-way hash of the
     identifier (the same `hashToken(identifier)` shape v1.4.41 L-2
     proposed for `check-user`) so the audit row still says "this IP
     tried email-X N times" without persisting the literal string.
- **Severity rationale**: H rather than Critical — the data is operator-
  read-only, not internet-reachable, and the brute-force surface is
  already throttled by `auth:login:<ip>` at `5/15min`. But the v1.4.20
  directive is a hard rule, the fix is one line, and shipping a release
  that breaks the rule retroactively requires another scrub pass.
- **Recommended fix**: drop the raw `identifier` from the details and
  replace with `identifier_hash: hashToken(identifier)` (or simply
  drop the field entirely — `reason: "user_not_found_or_no_password"`
  is the operationally interesting bit, the literal string is not).

### H-2 v1.4.42 L-1 still open — `WithingsApiError.message` lands un-capped in `AuditLog.details`
- **File**: `src/lib/integrations/status.ts:250-260` (audit-log call site),
  consumed by every `WithingsApiError` thrown from `src/lib/withings/client.ts:127-135, 170-178, 290-298, 374-382`.
- **Attack vector**: The classifier shipped in v1.4.42 builds
  `WithingsApiError.message` as `` `Withings <verb> error: <status> - <json.error>` `` where `json.error` is whatever Withings put in the
  response body. That message flows verbatim into the
  `auditLog("integrations.sync.failed", { details: { …, message, … } })`
  call. The encrypted `IntegrationStatus.lastError` column is sliced to
  1024 chars via `safeEncryptError`, but the audit-row JSON is NOT —
  Postgres TEXT can hold arbitrary length. A compromised or buggy
  Withings response could pump a large `error` string into every
  connected user's audit ledger.
- **Severity rationale**: H, not Critical — Withings is the trusted
  upstream and the failure path runs at most 3 times per user before
  the 3-strike alert ladder fires. But the directive from v1.4.42 was
  explicit (L-1) that audit-row payload sizes must match the encrypted-
  error column behaviour and the gap is still open in v1.4.43. Closing
  it costs one `.slice(0, 1024)` in either the constructor or the call
  site.
- **Recommended fix**: apply `slice(0, 1024)` to `message` inside the
  `WithingsApiError` constructor (single owner) so every audit /
  notification path inherits the cap.

## Medium (recommended for tag)

### M-1 `auth.check-user` enumeration probe still un-audited
- **File**: `src/app/api/auth/check-user/route.ts:95-113`.
- **Attack vector**: v1.4.41 L-2 noted that `/api/auth/check-user`
  emits `annotate()` for the wide-event log but never calls
  `auditLog(...)`. The v1.4.41 H-1 fix landed the per-IP rate-limit
  but did NOT land the audit row. The route now correctly throttles a
  burst to 30/15min, but a throttled burst leaves no `auditLog`
  evidence; wide-events are sampled and retained shorter than audit
  rows. An admin investigating "did anyone enumerate accounts last
  week" has no row to grep.
- **Severity rationale**: M — the throttle closes the operationally
  important attack surface; the absent audit row is defence-in-depth.
  Adding it is one line; matches the depth pattern of every other
  /api/auth/* route.
- **Recommended fix**: emit
  `auditLog("auth.check-user", { ipAddress: ip, details: { branch, identifier_hash: hashToken(identifier) } })`
  on every branch. Hash the identifier rather than storing it raw —
  same reasoning as H-1.

### M-2 `dispatchNotification` formatting may carry an arbitrary upstream
  string to Telegram (the slice trims to 280, but the field is still
  read from user-influenced data)
- **File**: `src/lib/integrations/status.ts:505-547` (the
  `formatAdminAlertPayload` path is the unchanged Telegram alert body).
- **Attack vector**: Same pipeline as H-2. The `message` argument
  reaches `formatAdminAlertPayload`, which trims to 280 chars before
  pushing to Telegram. Bounded, so not a payload-size DoS. The concern
  is that an HTML / Markdown injection in `json.error` would land in
  the Telegram body unescaped — the existing alert body uses no
  parse_mode (verified by reading `sendTelegramMessage` callers from
  this file), so Telegram renders plain text and the injection is
  inert. Note for the next reader: if anyone flips the alert body to
  `parseMode: "HTML"` (which the medication-reminder paths use) the
  upstream string would suddenly become an HTML injection vector.
- **Severity rationale**: M — preventive, not exploitable today.
- **Recommended fix**: keep alerts on plain text (no `parseMode`).
  Document the constraint with a comment on `formatAdminAlertPayload`
  so a future contributor doesn't silently flip it.

### M-3 Coach SSE transcript replays prior assistant + user messages
  verbatim from DB without re-running `detectRefusal`
- **File**: `src/app/api/insights/chat/route.ts:193-244`.
- **Attack vector**: `detectRefusal` runs only on the inbound `message`
  per turn (line 164-177). Prior turns (`priorTurns`) are loaded
  straight from `coach_messages.encryptedContent` and concatenated
  into the `userPrompt` transcript at line 235-244. If an injection
  pattern slipped past the refusal once (false-negative on the regex
  bank), it is replayed verbatim on every subsequent turn of the same
  conversation. Today the same regex bank gates every new turn so the
  user cannot send a follow-up that adds new payload; but the
  ALREADY-PERSISTED payload keeps re-entering the prompt every turn,
  so the model sees it on every reply.
- **Severity rationale**: M — the refusal pass is the existing defence
  layer and the regex bank is conservative. The risk is "false-negative
  amplification" rather than a fresh bypass. The fix is to re-run
  `detectRefusal` against every turn re-loaded from DB and short-
  circuit the conversation when an injection re-surfaces (or to clamp
  per-turn content to a length that the provider's system-prompt
  precedence overrides).
- **Recommended fix**: defer — pin the pattern in v1.4.44 with a
  dedicated `replay_injection` audit annotation so the failure case is
  observable before adding the kill-switch.

### M-4 `getClientIp` falls back to a literal `"unknown"` string in
  every rate-limit caller — a misconfigured trust chain collapses
  every anonymous request into one shared bucket
- **File**: every `checkRateLimit(\`...:\${ip ?? "unknown"}\`, ...)` call
  site (e.g. `src/app/api/auth/login/route.ts:25-26`,
  `src/app/api/auth/register/route.ts:24-25`).
- **Attack vector**: The v1.4.37 trust-violation warning fires once
  per process and degrades the rate-limit precision silently
  afterwards (`api-response.ts:217-237` documents this exact concern).
  Anonymous traffic shares the `"unknown"` bucket → one attacker can
  exhaust the bucket for every legitimate caller. The
  `getClientIpOrTrustWarning` helper already returns a `trustViolation`
  flag (line 254-300) but no call site routes the request to a tighter
  global bucket when the flag is set; every caller still falls back to
  `?? "unknown"`.
- **Severity rationale**: M — requires misconfigured `TRUST_PROXY_HOPS`
  to trigger, but is exploitable in that misconfigured-but-still-running
  state. The warning fires once but the precision stays degraded for
  the rest of the process lifetime.
- **Recommended fix**: extend `checkRateLimit` (or wrap every auth-
  surface call site) so that `trustViolation === true` routes the
  request to a single global bucket with a much tighter limit (e.g.
  100/15min across the whole "unknown" pool). Defer to v1.4.44 if the
  v1.4.43 release window is tight.

## Low (defer to v1.4.44)

### L-1 `withings_state` cookie carries `userId:nonce` plaintext
- **File**: `src/app/api/withings/connect/route.ts:25-37`.
- **Attack vector**: The Withings OAuth `state` parameter is built as
  `${user.id}:${stateNonce}` and persisted both as the cookie value AND
  the URL state. The cookie is `httpOnly`, `Secure` (prod) and
  `sameSite: "lax"` so the XSS exfiltration surface is closed. But the
  user id is recoverable from a request log entry (where the cookie is
  not redacted) and from a network-traffic capture of the redirect.
  Cosmetic — knowing your own user id leaks nothing — but a future
  refactor that switches the cookie to a non-httpOnly variant would
  silently expose it. The state is also compared via constant-time
  string-equal (line 31), good.
- **Recommended fix** (defer): switch the state to a fully-random
  16-byte nonce and persist `(nonce → userId)` in a short-lived (10
  min) row; CSRF check then becomes "this nonce is in the table" rather
  than "this nonce includes the right userId".

### L-2 The Coach `userPrompt` is built via raw string concatenation
- **File**: `src/app/api/insights/chat/route.ts:235-244`.
- **Attack vector**: None today — the snapshot is server-built JSON
  (already sanitised at the source via `sanitizeForPrompt` for every
  free-text field — verified across `glp1-snapshot.ts:318-332`,
  `blood-pressure-status.ts:323-324`, `medication-compliance-status.ts:234-235`,
  `glp1-plateau.ts:128-129`). User messages are the only free-text;
  `detectRefusal` is the gate. Worth a note for the next reader so
  the boundary stays explicit: any new free-text field added to the
  snapshot MUST run through `sanitizeForPrompt` before landing in
  `snapshot.snapshotJson`.
- **Recommended fix** (defer): add a lint-style test in
  `src/lib/ai/coach/__tests__/snapshot.test.ts` that fails when a
  free-text field is added to the snapshot blob without the
  `sanitizeForPrompt` wrap. Cheap regression guard.

### L-3 `passkey/login-verify` uses raw `as AuthenticationResponseJSON` cast
- **File**: `src/lib/auth/passkey.ts:189`.
- **Attack vector**: The SimpleWebAuthn verifier owns shape validation
  immediately downstream (line 202-213) so an arbitrary-shaped body
  fails fast. But the cast bypasses TS's type-narrowing — a future
  refactor that reads `typedResponse.id` or another field BEFORE
  calling the verifier would crash on `undefined.id`. Note from
  v1.4.41 L-1's twin direction: explicit Zod parsing in front of the
  verifier closes this comprehensively.
- **Recommended fix** (defer): add a thin Zod schema upstream of
  `verifyAuthentication` so the cast becomes an explicit narrowing
  rather than an implicit one.

### L-4 `legacy_form_total` counter is in-memory only — useless in a
  multi-container deploy
- **File**: `src/app/api/withings/webhook/route.ts:45-64`.
- **Attack vector**: None — the counter is observability, not a
  security control. Note for the v1.4.27 removal cut: if the gate is
  "legacy form usage trending toward zero", a single-container reading
  of the counter undersells the actual traffic. Two containers each
  serving 30 % of legacy traffic each report ~30 % of total volume.
- **Recommended fix** (defer): move to Postgres if the v1.4.27 cut
  matters for the gate; otherwise drop the counter when the legacy
  form is removed.

## Strengths

1. **Encryption-at-rest is comprehensive + versioned.**
   - Withings access + refresh tokens (`WithingsConnection.{accessToken, refreshToken}`),
     Codex access + refresh tokens (`User.codex{Access,Refresh}TokenEncrypted`),
     Telegram bot token (`User.telegramBotToken`), Withings client secret
     (`User.withingsClientSecretEncrypted`), Anthropic API key
     (`User.aiAnthropicKeyEncrypted`), and Coach messages
     (`CoachMessage.encryptedContent`) all flow through `src/lib/crypto.ts`'s
     versioned AES-256-GCM envelope with a documented rotation CLI.
   - The legacy bare-base64 format refuses to decrypt under the active
     key without an explicit `v1` entry, preventing silent corruption
     during rotation.
   - APNs key, password hashes (argon2id), and API token hashes
     (HMAC-SHA256) cover the remaining sensitive columns.

2. **Webhook authentication is uniform + timing-safe.**
   - Withings webhook (path-segment + legacy query): `timingSafeStringEqual`
     wrapper around `node:crypto.timingSafeEqual`, length-pre-check
     guards leak-via-length-mismatch (`src/lib/withings/webhook-handler.ts:50-59`).
   - Telegram webhook: same shape with the `x-telegram-bot-api-secret-token`
     header (`src/app/api/telegram/webhook/route.ts:36-48`).
   - Withings OAuth callback `state` cookie: `timingSafeEqual` on
     length-matched buffers (`src/app/api/withings/callback/route.ts:27-31`).
   - Per-IP rate-limit applied BEFORE the secret check on every webhook
     so a brute-force probe of the secret is bounded.

3. **Per-IP rate-limit coverage on every public auth surface.**
   - `/api/auth/login` 5/15min, `/api/auth/register` 5/15min,
     `/api/auth/passkey/login-options` 10/15min,
     `/api/auth/passkey/login-verify` 10/15min,
     `/api/auth/refresh` 60/15min,
     `/api/auth/check-user` 30/15min (v1.4.41 H-1 close),
     `/api/auth/password` 5/15min (per-user, not per-IP),
     Withings webhook 30/min, Telegram webhook 120/min.
   - Routes that lack `checkRateLimit` were swept: the omissions are
     authenticated routes where the session cookie / Bearer token IS
     the rate gate (revoke + audit on every miss is sufficient — the
     attacker would have to compromise a valid token first).

4. **Encryption-key versioning + rotation refuses to fail silently.**
   - `decrypt()` on a legacy-format ciphertext without a `v1` key
     entry throws an explicit "restore the original ENCRYPTION_KEY or
     add a 'v1' entry" error (`src/lib/crypto.ts:230-241`) instead of
     trying the active key (which would either fail with an opaque GCM
     tag error or succeed silently with junk on a key collision).
   - The `envSignature()` cache invalidator (line 40-46) ensures a
     mid-process key reload reflects in the next decrypt; the test
     helper `_resetCryptoCacheForTests` is the only opening.
   - Production rejects short-padded dev keys at startup
     (`decodeKey:62-67`).

5. **Cookie security posture is correct.**
   - `healthlog_session`: `httpOnly`, `secure` (prod), `sameSite: "lax"`,
     `path: "/"`, 30-day max-age with 1-day sliding refresh
     (`src/lib/auth/session.ts:71-79, 130-141`).
   - `hl_onboarding`: `httpOnly: false` (UX hint), `secure` (prod),
     `sameSite: "strict"` (no cross-site flow depends on it), explicit
     documentation that the real gate is server-side.
   - `withings_state`: `httpOnly`, `secure` (prod), `sameSite: "lax"`,
     `maxAge: 600` (10 min — matches the OAuth state lifetime).
   - `codex_device`: `httpOnly`, `secure` (prod), `sameSite: "lax"`,
     `maxAge: 900` (15 min — matches Hydra's device-code lifetime).
     Payload is `encrypt(JSON.stringify({deviceAuthId, userCode}))` — even
     a stolen cookie cannot be decrypted without the active key.

6. **CSP + HSTS + frame-ancestors are baked into `src/proxy.ts`.**
   - The Next 16 file-convention rename `middleware.ts` → `proxy.ts`
     is correctly applied. The `Content-Security-Policy`,
     `Strict-Transport-Security`, `X-Frame-Options: DENY`,
     `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
     `Permissions-Policy` headers all ship from `src/proxy.ts:226-275`.
   - CSP `connect-src` is route-gated: `https://api.openai.com` and
     `https://chatgpt.com` are only added on `/settings/ai*`;
     `https://wbsapi.withings.net` only on `/settings/integrations/withings*`
     and `/api/withings/*`. A DOM-XSS on an unrelated page cannot
     exfiltrate to AI or Withings origins.
   - HSTS in prod carries `preload` so the first-visit MITM window on
     hostile networks is closed.
   - Nonce-based `script-src` with per-request 128-bit `crypto.getRandomValues`
     nonce.

7. **CORS is correctly absent.**
   - No `Access-Control-Allow-Origin: *` anywhere in `src/` (grep
     clean). iOS native uses the same-origin URL `https://healthlog.bombeck.io`
     so no preflight is required. A future cross-origin call would
     have to opt in explicitly.

8. **`check-env` CLI is operator-only + secret-clean.**
   - v1.4.42 W6 verdict still holds: `renderResults` (`scripts/check-env.ts:188-220`)
     emits only `[OK]` / `[MISSING-REQUIRED]` / `[missing-optional]`
     plus the variable NAME — no value substitution. `parseEnvFile`
     never echoes the value back to stdout.
   - `MANIFEST_PATH = resolve(__dirname, "env-manifest.json")` is
     module-frozen; `--file` controls only the env-source.
   - Run as `pnpm check-env` — operator-only, no network-attacker
     surface.

9. **Admin gating is uniform — every `/api/admin/**/route.ts` calls
   `requireAdmin()`.** Grep `find … -L "requireAdmin"` returned empty
   for the admin tree. Bearer-token authentication never elevates to
   admin (`src/lib/api-handler.ts:412-431` — `requireAdmin` is
   session-cookie-only by design).

10. **User-scope filtering is consistent on every owned-resource read.**
    Every route under `/api/measurements`, `/api/mood-entries`,
    `/api/medications`, `/api/workouts`, `/api/insights`, `/api/withings`,
    `/api/dashboard` filters by `userId: user.id` from the auth context
    in the WHERE clause. Forged IDs in JSON bodies are server-overridden
    (`src/app/api/workouts/batch/route.ts:228`). Soft-delete (`deletedAt: null`)
    is applied to every read tier consistently after the v1.4.40 W-DELETED
    sweep.

11. **Dashboard-widgets 422 audit-ledger writes are user-scoped + best-effort.**
    `prisma.auditLog.create({ data: { userId: user.id, action, details: JSON.stringify({ issues }) } })`
    uses the sanitised projection from `sanitiseZodIssues`, never raw
    `issue.params`. `.catch(() => {})` ensures a DB miss never 5xx's
    the 422 contract. Verified in v1.4.42 W2 review.

12. **`dedupeWorkoutBatch` is user-scoped + tamper-proof.** The
    group key includes `userId` so cross-user collapse is impossible;
    the batch route hard-overrides `userId: user.id` from the auth
    context (line 228) so a forged JSON `userId` is silently dropped.
    The duplicate envelope to iOS carries only `index` and `status` —
    no PII echo.

---

(56 words follow for the stdout summary)
