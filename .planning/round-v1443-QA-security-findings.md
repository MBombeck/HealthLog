# v1.4.43 QA-Security findings (W10-QA-SECURITY)

Scope: read-only review of `git diff 2c68a48d..develop` covering 74
commits between v1.4.42 and the v1.4.43 release candidate.

Reviewer: W10-QA-SECURITY (static review, no execution).

## Verdict

**APPROVE** — ship as-is.

Every Critical / High / Medium / Low from the W-AUDIT-SECURITY round is
closed in code with regression tests, or explicitly documented as a
defence-in-depth invariant. No CORS / CSP regression; no migration
constraint relaxation; no PII leak in any new audit row; the
trust-violation tighter bucket lands across every IP-keyed auth surface;
the W6 Zod-rollout preserves every status code (sole 400 case is the
consent route, intentional and commented). The two new endpoints
(`/api/integrations/withings/resume` DELETE and
`/api/settings/account` DELETE) are user-scoped, rate-limited, and
session-invalidating where required.

## Critical (must fix before tag — vuln / data leak / auth bypass)

**None.**

## High (should fix before tag — defence-in-depth gap)

**None.** All H findings from the audit round closed:

- **H-1** (`auth.login.failed` raw identifier) — **CLOSED** in
  `b70cdcae`. `src/app/api/auth/login/route.ts:71-74` now writes only
  `{ reason: "user_not_found_or_no_password" }` — identifier field
  dropped entirely. Regression test in
  `src/app/api/auth/login/__tests__/route.test.ts:108-130` pins both
  the absence of an `identifier` key AND the literal email string in
  the serialised audit row.

- **H-2** (`WithingsApiError.message` un-capped) — **CLOSED** in
  `921d31b8`. `src/lib/withings/response-classifier.ts:252-255` caps
  the message at 1024 chars in the constructor, so every downstream
  audit / notification / pg-boss retry path inherits the bound.
  Regression test in
  `src/lib/withings/__tests__/response-classifier.test.ts:180-191`
  pins the cap for a 4000-char upstream while preserving the legacy
  `Withings <verb> error: <status>` prefix.

## Medium

**None blocking.** All M findings closed or pinned-as-invariant:

- **M-1** (`check-user` un-audited) — **CLOSED** in `7f84e950`.
  `src/app/api/auth/check-user/route.ts:109-137` now hashes the
  identifier via `hashToken` and persists every branch (`not_found`,
  `passkey_only`, `email_fallback`, `exists`) to `AuditLog`. Wide-event
  `annotate()` retained; audit row is durable + hashed.

- **M-2** (Telegram parseMode invariant) — **DOCUMENTED** in
  `8767f819`. `src/lib/integrations/status.ts:828-851` carries a
  SECURITY INVARIANT docblock explaining why the admin-alert path must
  not flip to `parseMode: "HTML"`. No code change; the existing plain-
  text rendering keeps the upstream-influenced string inert.

- **M-3** (Coach replay-injection on prior turns) — **CLOSED** in
  `81b1eeea`. `src/app/api/insights/chat/route.ts:198-233` re-runs
  `detectRefusal` against every user-role turn re-loaded from
  `coach_messages.encryptedContent` before building the transcript.
  On a hit, the SSE short-circuits with a refusal AND a durable
  `audit.coach.replay-injection` row carrying conversation id, turn
  index, and matched reason — never the message content. Integration
  test in `tests/integration/coach-chat.test.ts` (committed alongside)
  pins both the short-circuit and the audit-row shape.

- **M-4** (trust-chain misconfig → shared `"unknown"` bucket) —
  **CLOSED** in `d324d516`. `src/lib/rate-limit.ts:84-127` adds
  `checkAuthSurfaceRateLimit`, which consults
  `getClientIpOrTrustWarning` and, on `trustViolation === true`,
  routes the request to a shared global bucket
  `auth:anon:trust-violation` capped at 100/15min across every auth
  surface. Six routes converted (login, register, passkey login-
  options, passkey login-verify, refresh, check-user); `password` is
  per-user and stays on direct `checkRateLimit`. Test suite in
  `src/lib/__tests__/rate-limit-auth-surface.test.ts` covers all four
  pivot conditions (clean chain + IP, clean chain + null IP, violation
  + IP, violation + null IP) plus the cross-surface bucket-sharing
  property.

## Low

All L findings closed or documented:

- **L-2** (Coach `userPrompt` raw string concat) — pinned via
  `58f48413` regression-test guard
  (`src/lib/ai/coach/__tests__/snapshot.test.ts`).

- **L-3** (`passkey/login-verify` raw cast) — **CLOSED** in `ef7e1f03`.
  `src/lib/auth/passkey.ts:13-37` adds the
  `authenticationResponseSchema` Zod narrow + applies it inside
  `verifyAuthentication`; the SimpleWebAuthn cryptographic verifier
  retains downstream ownership. `.loose()` keeps forward-compat with
  WebAuthn extension fields.

- **L-1, L-4** — deferred to v1.4.44 per the audit round; verified no
  regression in this release.

## Strengths

1. **W3/W13 audit-row PII discipline is end-to-end.** Every new
   `auditLog` call in the diff writes either a `userId` (server-known),
   a hashed identifier (`hashToken`), a reason enum, or sanitised Zod
   issues (`sanitiseZodIssues` — path/code/message only, `issue.params`
   stripped). Searched the diff for `auditLog` + raw `identifier` /
   `email` / `password` — no hits in any new call site.

2. **W6 Zod-rollout preserves status codes byte-for-byte.** Spot-checked
   every new `returnAllZodIssues(parsed.error, ...)` call site against
   the prior `apiError(parsed.error.issues[0].message, ...)`: 36 sites
   stayed on 422; the 3 consent routes stayed on 400. Confirmed against
   `2c68a48d:src/app/api/consent/ai/route.ts` (the only 400 originator);
   `returnAllZodIssues(parsed.error, 400)` carries an inline comment
   pinning the intentional preservation. No accidental 422→400 swap or
   the reverse.

3. **`sanitiseZodIssues` privacy floor is tight.** `path`, `code`,
   `message` only — `issue.params` (which Zod uses to echo the rejected
   value for some issue codes) stays server-side
   (`src/lib/api-response.ts:37-45`). Verified across the full rollout.

4. **W14 resume endpoint is correctly scoped + rate-limited.**
   `/api/integrations/withings/resume` requires `requireAuth()`, then
   keys `checkRateLimit` by `withings-resume:{user.id}` (5/min). The
   downstream `resumeIntegrationFromPark(user.id, "withings")` queries
   and upserts on the `userId_integration` composite-unique — cross-
   user clobber impossible. Idempotent: a second call sees
   `existing?.state !== "parked"`, returns `wasParked: false` and
   writes no audit row. No CORS / CSP impact (no new origin or header).

5. **W12 account-delete cascade is bounded + GDPR-clean.**
   `/api/settings/account` DELETE requires `requireAuth()` + a literal
   `confirm: "DELETE_ACCOUNT"` string in the body (typed-as-string then
   strict-equality compared, not just truthy). Last-admin guard
   prevents lock-out. Sessions, API tokens, refresh tokens all revoked
   via `destroyAllSessions(userId)` in a single Prisma transaction —
   every revoke is `where: { userId }`. Feedback + AuditLog rows are
   purged for GDPR Art. 17 completeness BEFORE the final
   `user.delete()` (otherwise the cascade `SetNull`s them, leaving PII
   orphans). Audit row written BEFORE the deletion sweep; the row's
   own `userId` is purged in the subsequent `auditLog.deleteMany`.

6. **Migration 0075 (`integration_park`) is purely additive.** Two
   nullable columns (`consecutive_failures_by_kind jsonb`,
   `persistent_failure_started_at timestamp`) with `ADD COLUMN IF NOT
   EXISTS` guards. No NOT NULL, no FK change, no unique index touched.
   `state` column stays free-form string; `"parked"` is recognised at
   the application layer. `onDelete: Cascade` on the FK preserved.

7. **CSP / proxy unchanged.** `git diff 2c68a48d..develop -- src/proxy.ts`
   is empty. The HSTS, CSP-with-route-gated `connect-src`,
   `frame-ancestors`, `Referrer-Policy`, `Permissions-Policy` headers
   continue to ship from the same builder. No new endpoint declared
   its own headers / CORS shim. `grep "Access-Control-Allow" src/`
   returns clean.

8. **W3-SECURITY regression test is the right shape.**
   `login/__tests__/route.test.ts:108-130` asserts both the absence
   of the `identifier` key in `payload.details` and the literal
   typed-email string anywhere in the JSON serialisation. A future
   refactor that re-introduces the field under any new name still
   fails the second assertion. Same pattern lands the W13 M-1
   check-user audit-row test.

9. **W13 M-3 (Coach replay-injection) audit-row content is leak-free.**
   The new `audit.coach.replay-injection` row carries
   `conversationId`, `turnIndex`, and the matched `reason` enum —
   never the raw turn content. So an injection payload that surfaces
   the audit row doesn't survive into the audit ledger itself.

10. **Dashboard widgets audit-row dedup (B2) is process-local + safe-
    failure.** The in-process memo on `(userId, action)` keyed at 60 s
    drops at most one row per process per minute on a tight retry loop
    — far below the operator-grep threshold but eliminates the
    audit-flood DoS surface. Memo resets on process restart (one extra
    row per restart; tolerable). Cluster deploys keep one row per pod
    per minute, which is fine.

## Out-of-scope items observed (no action required)

- The Coach SSE `detectRefusal` regex bank is still the only injection
  barrier — same as v1.4.42. The W13 M-3 close adds replay-injection
  guard but does not strengthen the regex itself (deferred per the
  audit-round verdict).

- `getClientIpOrTrustWarning` still fires the `console.warn` only once
  per process. Operators relying on the warn for chain misconfig
  detection still need external alerting. The tight global bucket
  (W13 M-4) caps the blast radius regardless.

- The `withings_state` cookie still carries `userId:nonce` plaintext
  (L-1) — deferred to v1.4.44.

---

(verdict + critical/high count + filename)
