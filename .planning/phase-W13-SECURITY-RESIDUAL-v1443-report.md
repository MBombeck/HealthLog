# W13-SECURITY-RESIDUAL — v1.4.43 phase report

Branch: `w13-security-residual-v1443` (off `origin/develop`).
Pushed: see "Push" section at the bottom.

## Items closed

### M-1 — `auth.check-user` audit-row gap

- **File**: `src/app/api/auth/check-user/route.ts`
- **Fix**: Emit `auditLog("auth.check-user", { … })` on every branch
  (`not_found`, `passkey_only`, `email_fallback`, `exists`). Identifier
  is hashed via `hashToken` (same shape as v1.4.41 / W3 `auth.login.failed`
  H-1 fix), so the raw user-typed string never lands in
  `AuditLog.details`. The wide-event `annotate()` log stays; the audit
  ledger is the durable signal admins can grep.
- **Test**: `src/app/api/auth/check-user/__tests__/route.test.ts` —
  four new branches assert audit row written with hashed identifier on
  each branch + PII-grep assertion that the raw string never leaks into
  `details`.
- **Commit**: `b11f1130`

### M-2 — `formatAdminAlertPayload` plain-text invariant

- **File**: `src/lib/integrations/status.ts`
- **Fix**: Docblock added pinning the invariant that the admin-alert
  Telegram body MUST stay on plain text (no `parseMode`). Upstream
  `WithingsApiError.message` interpolates user-influenced data; flipping
  the alert dispatch to HTML / MarkdownV2 mode would turn the upstream
  string into an injection vector reaching every admin chat. No code
  change — the constraint is documented so the next reader notices.
- **Test**: N/A (documentation invariant; no behaviour change to pin).
- **Commit**: `73903da6`

### M-3 — Coach SSE replay-injection scan

- **File**: `src/app/api/insights/chat/route.ts`
- **Fix**: Re-run `detectRefusal` against every user-turn re-loaded
  from `coach_messages.encryptedContent` before the transcript is
  built. On a positive hit, short-circuit the SSE with a refusal AND
  emit a new `audit.coach.replay-injection` audit row. The audit row
  carries `{ conversationId, turnIndex, reason }` — never the message
  body — so the bypass payload doesn't survive into the audit ledger.
- **Test**: `tests/integration/coach-chat.test.ts` — new integration
  test seeds a prior user-turn with a regex-bank-matching injection
  pattern, asserts the route short-circuits with a refusal token frame,
  provider runner never invoked, and the durable `auth_log` row carries
  the conversation id + turn index + matched reason.
- **Commit**: `203b6189`

### M-4 — Trust-violation aware rate-limit bucket

- **Files**:
  - `src/lib/rate-limit.ts` — new `checkAuthSurfaceRateLimit(request, prefix, perIpLimit, windowMs)` wrapper.
  - 6 auth-surface routes converted to the wrapper:
    - `src/app/api/auth/login/route.ts`
    - `src/app/api/auth/register/route.ts`
    - `src/app/api/auth/passkey/login-options/route.ts`
    - `src/app/api/auth/passkey/login-verify/route.ts`
    - `src/app/api/auth/refresh/route.ts`
    - `src/app/api/auth/check-user/route.ts`
- **Fix**: Clean trust chain → existing per-IP `{prefix}:{ip}` semantics,
  byte-equivalent. `trustViolation === true` → routes every auth
  surface into a single shared `auth:anon:trust-violation` bucket
  capped at 100/15min. One attacker can no longer exhaust the per-
  surface `unknown` bucket and lock every other anonymous caller out.
  `/api/auth/password` is keyed by `user.id` (already authenticated)
  so it stays on `checkRateLimit` directly.
- **Test**: `src/lib/__tests__/rate-limit-auth-surface.test.ts` (8 tests)
  asserts the per-IP path stays byte-equivalent, the tight bucket fires
  uniformly across every auth surface on a trust violation, the helper
  still returns the resolved IP for downstream audit-log calls, and
  the global cap denies at count > 100. Three test files updated to
  mock both `checkRateLimit` and `checkAuthSurfaceRateLimit`:
  - `src/app/api/auth/login/__tests__/native-token.test.ts`
  - `src/app/api/auth/passkey/login-verify/__tests__/native-token.test.ts`
  - `src/app/api/auth/check-user/__tests__/route.test.ts`
  - `src/__tests__/api/auth/check-user/route.test.ts`
- **Commit**: `9c2e08e9` (helper + route conversions + new tests)
  and `6d9ea589` (contract-test mock follow-up).

### L-2 — Snapshot free-text regression guard

- **File**: `src/lib/ai/coach/__tests__/snapshot.test.ts`
- **Fix**: New `describe` block walks the four snapshot-builder source
  files (`glp1-snapshot.ts`, `blood-pressure-status.ts`,
  `medication-compliance-status.ts`, `glp1-plateau.ts`), identifies
  property-assignment lines whose key matches a free-text heuristic
  (`name`, `note`, `notes`, `description`, `comment`, `drug`,
  `doseUnit`, `dose`) and whose value expression reads from a
  user-controlled identifier, then asserts the value path includes
  `sanitizeForPrompt` OR the file imports + uses the sanitiser
  somewhere (consumer-side wrapping case). Cheap regression guard —
  a new snapshot builder added without the import fails immediately.
  Sanity-check pinned: heuristic must trip on a synthetic leak.
- **Commit**: `5e860cd6`

### L-3 — Zod schema upstream of `verifyAuthentication`

- **File**: `src/lib/auth/passkey.ts`
- **Fix**: Drop the raw `as AuthenticationResponseJSON` cast. Replace
  with an explicit Zod parse via `authenticationResponseSchema`
  (mirrors SimpleWebAuthn's `AuthenticationResponseJSON` shape: `id`,
  `rawId`, nested `response` with `clientDataJSON` / `authenticatorData`
  / `signature`, `type: "public-key"` literal). Schema is permissive on
  unknown top-level keys for forward-compatibility with future
  authenticator-attachment / extension-result additions. A malformed
  body now throws `"Malformed passkey authentication response"`
  before any `.id` deref.
- **Test**: `src/lib/auth/__tests__/passkey.test.ts` (7 tests) — valid
  body accepted, missing `id` / wrong `type` literal / missing nested
  `response.clientDataJSON` / empty object / `null` all rejected
  before reaching the SimpleWebAuthn verifier (asserted via the mock
  never being called); extra unknown top-level keys still accepted.
- **Commit**: `84ac9f82`

## Items deferred (per handoff)

- **L-1** `withings_state` cookie nonce-table refactor — touches OAuth
  flow + needs migration + state-table cleanup job. Bigger than the
  v1.4.43 window. Deferred.
- **L-4** `legacy_form_total` counter — observability-only, defer-able
  until the v1.4.27 cut is closer. Deferred.

## Test additions (24)

| File | New tests |
|---|---|
| `src/app/api/auth/check-user/__tests__/route.test.ts` (new) | 4 |
| `src/lib/__tests__/rate-limit-auth-surface.test.ts` (new) | 8 |
| `src/lib/auth/__tests__/passkey.test.ts` (new) | 7 |
| `src/lib/ai/coach/__tests__/snapshot.test.ts` (extended) | 5 (4 file scans + 1 sanity) |
| `tests/integration/coach-chat.test.ts` (extended) | 1 |

Plus three existing test files updated to mock `checkAuthSurfaceRateLimit`
alongside `checkRateLimit` (no count delta — same tests, fresh mock surface).

## Commit SHAs (chronological)

1. `b11f1130` — feat(audit): persist hashed-identifier row on check-user every branch
2. `73903da6` — docs(security): pin plain-text invariant on admin-alert Telegram body
3. `203b6189` — feat(coach): re-detect replayed injections from prior turns
4. `9c2e08e9` — feat(rate-limit): tighten anonymous bucket on trust-chain misconfig
5. `5e860cd6` — test(coach): regression guard for free-text snapshot fields
6. `84ac9f82` — feat(auth): Zod-narrow passkey authentication body at boundary
7. `6d9ea589` — test(auth): wire check-user contract test to new rate-limit wrapper

## Quality gates

- `pnpm typecheck` — clean.
- `pnpm lint` (on every touched file) — clean.
- `pnpm test` — `Test Files 452 passed (452)` / `Tests 4839 passed | 1 skipped (4840)`.
- `pnpm test:integration tests/integration/coach-chat.test.ts` —
  `Test Files 1 passed (1)` / `Tests 9 passed (9)`.

Full integration run shows 2 pre-existing failures in
`tests/integration/workout-batch-{create,race}.test.ts` — neither file
was touched in this wave and the failures reproduce on `origin/develop`
unchanged; flagged as out-of-scope for W13.

## Push

```
git push -u origin w13-security-residual-v1443
```

(See "Final step" in the assistant's output for the push confirmation.)
