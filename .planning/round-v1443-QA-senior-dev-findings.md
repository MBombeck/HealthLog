# v1.4.43 QA Senior-Dev findings (W10-QA-SENIOR-DEV)

Scope: architectural + correctness review of `git diff 2c68a48d..develop`
covering 74 commits between v1.4.42 and the v1.4.43 release candidate.

Reviewer: W10-QA-SENIOR-DEV (read-only static review, no execution).

## Verdict

**APPROVE WITH 1 MEDIUM + 4 LOW** — ship as-is; address the bucket
back-fill off-by-one before v1.4.44 drops the legacy `consecutive_failures`
column.

No Critical / High findings. The five sentinel landings (W1-ANALYTICS,
W14-WITHINGS-PARK, W6-ZOD-ROLLOUT, W13-RATE-LIMIT-WRAPPER, W12-ACCOUNT-DELETE)
are architecturally sound. Cherry-pick aftermath commits (`32ca196e`,
`154e6fa7`) cleanly close branch-merge collateral, not deeper bugs.
Pre-existing `workout-batch-{create,race}` integration failures
confirmed pre-date this release (last touched in v1.4.25).

---

## Critical

None.

## High

None.

## Medium

### M-1 — Per-kind bucket back-fill is permanently 1 behind the legacy counter on the transition row
- **File**: `src/lib/integrations/status.ts:375-395` (back-fill branch
  inside `recordSyncFailure`).
- **Trace**: a v1.4.42 row at `consecutive_failures=3, ...byKind=null,
  state=error_reauth` receives a fresh `reauth_required` failure. The
  code path:
  1. `startingBuckets = null` (column predates migration).
  2. `buckets = backfillBuckets(3, "reauth_required")` →
     `{transient: 0, reauth_required: 3, persistent: 0}` — seeds the
     bucket with the **legacy count**, NOT `legacy + 1`.
  3. The increment branch at line 384 (`if (startingBuckets)`) does
     NOT fire because `startingBuckets` is still null in this scope.
  4. The fall-through `else if (!existing)` at line 387 does NOT fire
     because `existing` is truthy.
  5. Upsert writes `consecutive_failures: { increment: 1 }` → DB row
     becomes `consecutive_failures=4, consecutiveFailuresByKind.reauth_required=3`.

  After this write: legacy counter is 4, bucket is 3 — off by 1. On
  every subsequent failure the `startingBuckets` path increments by 1,
  so the gap persists forever. The docstring comment at line 391-395
  claims "back-fills to reauth_required: 4 and this 5th failure makes
  the legacy +1 path bring the bucket to 5" — but there is no separate
  `+1` path that runs on the back-fill branch. Either the comment or
  the code is wrong.
- **Operational impact today**: tolerable. The alert ladder at line 487
  reads `Math.max(row.consecutiveFailures, ...buckets)` so the legacy
  column still drives paging decisions; the audit `bucketCount` field
  reports the smaller bucket value while `attemptNumber` reports the
  correct higher legacy count, creating a 1-row diagnostic confusion
  but no functional miss. Operators who grep audit rows by
  `bucketCount >= 3` will under-count by exactly one streak.
- **Impact on v1.4.44**: the migration comment at the top of
  `0075_v1443_integration_park/migration.sql` says "the single-column
  `consecutive_failures` integer stays in place for one release as a
  fallback (callers reading the alert-ladder still use
  `Math.max(...buckets)`); it will be removed in v1.4.44 once every
  reader is migrated." When that drop lands, the alert ladder will lose
  the `Math.max(row.consecutiveFailures, …)` floor and start paging at
  bucket≥3 instead of legacy≥3 — every back-filled row will page one
  failure too late.
- **Recommended fix (one-line)**: in `backfillBuckets` change
  `buckets[currentKind] = Math.max(0, legacyCount)` →
  `buckets[currentKind] = Math.max(0, legacyCount) + 1`, and update the
  unit test at `src/lib/integrations/__tests__/status.test.ts:666` to
  expect `reauth_required: 4` instead of `3`. The "this failure IS
  counted in that seed" docstring then becomes accurate.
- **Severity rationale**: M, not High — the legacy column carries the
  load until v1.4.44; the fix is one line + one test expectation flip;
  no live production user is currently affected because the legacy
  counter still drives the alert ladder. Worth fixing before the
  v1.4.44 drop ships.

## Low

### L-1 — `verifyRegistration` still uses raw `as RegistrationResponseJSON` cast
- **File**: `src/lib/auth/passkey.ts:153`.
- **Trace**: W13 L-3 closed the cast on `verifyAuthentication` (line
  225-229 — explicit Zod parse via `authenticationResponseSchema`) but
  the symmetric `verifyRegistration` path at line 137-160 still does
  `response: response as RegistrationResponseJSON` without any prior
  shape validation. SimpleWebAuthn's `verifyRegistrationResponse`
  throws on schema mismatch, so the security posture is identical to
  the pre-W13 authentication path the wave deliberately closed. The
  W13 report does not document this as out-of-scope; it appears to be
  an oversight or an explicit scope-cap.
- **Recommended fix**: mirror the `authenticationResponseSchema` with
  `registrationResponseSchema` and apply the same `safeParse → throw on
  failure` pattern. Two-test addition: valid registration accepted,
  malformed body rejected before reaching the verifier.
- **Severity rationale**: L because the SimpleWebAuthn verifier does
  own the cryptographic validation downstream and the registration
  surface is gated by an authenticated requireAuth (lower attack
  surface than the un-authenticated login flow). Documenting it here
  so a v1.4.44 sweep closes the asymmetry.

### L-2 — Trust-violation tight bucket is global across the cluster, not isolated per process
- **File**: `src/lib/rate-limit.ts:82-127`.
- **Trace**: `TIGHT_ANON_KEY` is a single string `"auth:anon:trust-violation"`
  keyed into the Postgres `rate_limits` table, so a misconfigured
  deployment serving 20 anonymous callers across 5 pods will see them
  all share the same 100/15min cap (across the cluster, not per pod).
  The brief asked to verify "tight-global-bucket isolation per
  process" — confirmed it is NOT per-process; it is per-cluster, since
  the underlying `checkRateLimit` is Postgres-backed. The behaviour
  matches the existing `auth:login:<ip>` semantics (also cluster-wide
  via Postgres) so this is design-consistent rather than a bug.
- **Impact**: in a real trust-violation incident a single attacker
  could exhaust the 100/15min cap and lock every other anonymous
  caller out of every auth surface across the cluster until the
  operator fixes `TRUST_PROXY_HOPS`. The `console.warn` is once-per-
  process — so an N-pod cluster emits N warnings before the operator
  notices. The brief asked about "false positives when TRUST_PROXY_HOPS
  is correctly configured" — confirmed clean: a correct config never
  trips `trustViolation === true` and the per-IP bucket fires unchanged.
- **Recommended action**: none in v1.4.43. Document the cluster-wide
  scope in the docstring of `checkAuthSurfaceRateLimit` so the next
  operator doesn't expect per-pod isolation.

### L-3 — `recordSyncFailure` read-then-write is not transactional; concurrent failures can clobber bucket increments
- **File**: `src/lib/integrations/status.ts:347-455`.
- **Trace**: the function reads the existing row at line 347, computes
  the new bucket envelope in JS, then upserts with the full computed
  envelope. The integer `consecutiveFailures` uses atomic
  `{ increment: 1 }` (line 451), but `consecutiveFailuresByKind: buckets`
  (line 452) is a full overwrite from a stale read. If two concurrent
  failure callers race the read window, the second upsert clobbers
  the first's bucket increment. Net effect: bucket count is the
  pre-read value + 1, not the actual concurrent count.
- **Impact today**: minimal. The only callers are Withings + moodLog
  per-user sync routines, each of which holds a per-(user, integration)
  lock implicitly via pg-boss job singletons — concurrent failures for
  the same user on the same integration are not actually possible in
  the deployed topology. The legacy `{ increment: 1 }` column still
  drives the alert ladder so an under-count in the bucket doesn't
  affect paging.
- **Recommended action**: none in v1.4.43. Before v1.4.44 drops the
  legacy column, either wrap the read+upsert in `prisma.$transaction`
  with a row-level lock, or replace the bucket overwrite with a
  Postgres jsonb update that atomically increments only the matching
  bucket (`jsonb_set` + `(value::int + 1)::text::jsonb`).

### L-4 — Audit-dedup memo is per-process only on a multi-pod deployment
- **File**: `src/app/api/dashboard/widgets/route.ts:54-72`.
- **Trace**: the `auditDedupMemo` Map at module scope is in-process
  only — a cluster with 5 pods can write 5 identical audit rows per
  minute even under the dedup. The docstring acknowledges this: "Cluster
  deployments still get one row per process per minute, which is fine
  for the operator-grep use case the audit row exists for." Verified
  the docstring is accurate and the choice is intentional. The 512-entry
  opportunistic GC at line 66-69 is correct (drops entries older than
  the window) and cannot grow unbounded for any realistic load.
- **Note**: only `dashboard/widgets/route.ts` got the dedup; every other
  W6-rollout route writes one audit row per Zod miss with no dedup.
  Verified by `grep shouldEmitAuditRow` returning a single file. This
  is consistent with the W6 report's framing of widgets as the
  iOS-contract-loop-prone surface; other surfaces don't see the
  loop pattern often enough to justify the memo overhead.

---

## Strengths

1. **Schema migration soundness (W14 / `0075_v1443_integration_park`)**.
   - `ADD COLUMN IF NOT EXISTS` on both new columns — idempotent against
     reruns.
   - Both columns nullable with no DEFAULT, so existing rows stay
     compatible without a backfill UPDATE (the application-layer
     `backfillBuckets` handles per-row migration on next write — though
     see M-1).
   - The migration SQL header documents the reverse migration explicitly:
     `ALTER TABLE ... DROP COLUMN IF EXISTS` on both columns + an
     `UPDATE` clearing any `state = 'parked'` rows back to
     `error_transient`. Reversible.
   - `state` stays a free-form string column per the 0029 invariant —
     adding `"parked"` is a no-op at the SQL layer; the enum widening is
     application-owned. Consistent with the codebase's documented
     pattern.
   - Schema Prisma type updates added BOTH columns + the `"parked"` enum
     comment update in one commit (`bd538b02`). No drift between
     migration SQL and Prisma schema.

2. **`p-limit(4)` cap on `computeAvg30LastYearMap`** is correctly
   isolated.
   - The pin test at
     `src/lib/analytics/__tests__/summaries-slice.wmy-cap.test.ts` walks
     a 15-type fan-out with controllable resolvers and asserts in-flight
     count never exceeds 4 across the full drain cycle. Pinned at the
     module-level constant (`WMY_FANOUT_CONCURRENCY = 4`).
   - The cap composes additively with the thick-route's
     `ANALYTICS_TYPE_FETCH_CONCURRENCY = 4`: on a dashboard mount that
     fires both `?slice=summaries` and the default slice in parallel,
     the worst-case combined pool draw is `4 + 4 = 8` slots from
     analytics, well under the `pg.Pool max=20` v1.4.40 raised it to.
     No collision risk.
   - Verified zero behavioural delta in the rollup-tier read paths;
     this is purely a fan-out cap that defers work, not a result
     change.

3. **W6 Zod-rollout pattern**.
   - All 35 routes preserve the existing `{ data: null, error: <string>, ...}`
     envelope. Added `details.issues` is strictly additive — iOS v0.5.4
     clients reading `body.error` see the unchanged `"Validation failed"`
     string. Pinned by `src/lib/__tests__/api-response-zod.test.ts` +
     27 new route-level test files.
   - `sanitiseZodIssues` projection drops `issue.params` consistently —
     verified across all 35 callers; every route-level test asserts
     `Object.keys(issue).sort() === ["code", "message", "path"]`.
   - `safeJson` is called BEFORE the Zod parse on every POST/PUT/PATCH
     route — verified spot-check on `measurements/route.ts` (line 568),
     `dashboard/widgets/route.ts`, `medications/route.ts`. The
     content-type and JSON-parse failures still return their dedicated
     415/400 envelopes before any Zod work runs.
   - Audit-row writes use the fire-and-forget `.catch(() => {})` pattern
     consistently across every W6 site. Verified the audit-write-
     rejection survival case is pinned by tests on multiple routes.
   - The dedup memo (B2) is correctly scoped to widgets only — every
     other route writes one audit row per miss because their failure
     patterns don't loop.

4. **W13 `checkAuthSurfaceRateLimit` wrapper introduction**.
   - Signature backward-compat: the wrapper returns `RateLimitResult &
     { ip: string | null }`. Existing call sites picked the IP up from
     `getClientIp(request)` before; they now read `rl.ip ?? "unknown"`.
     The shape extension is additive — `result.allowed`,
     `result.remaining`, `result.resetAt` are byte-identical for the
     happy path.
   - Trust-violation tight bucket fires only when
     `getClientIpOrTrustWarning` reports `trustViolation === true` —
     verified the helper at `src/lib/api-response.ts:268-300`. A clean
     `TRUST_PROXY_HOPS=1` + single-XFF deployment never trips the tight
     bucket; pinned by
     `src/lib/__tests__/rate-limit-auth-surface.test.ts:75-87`.
   - Test coverage is comprehensive: 8 tests on the wrapper, three
     existing test files updated to mock both `checkRateLimit` and
     `checkAuthSurfaceRateLimit`. The `154e6fa7` cherry-pick aftermath
     commit closes the last test-mock gap (login + register) — verified
     this is a green-up commit, not a paper-over.

5. **W12 `/api/settings/account` DELETE cascade**.
   - User-scoped by `user.id` from `requireAuth()` — no admin-acting-as-user
     surface, no email/username lookup. Bounded delete.
   - `destroyAllSessions(userId)` runs BEFORE `prisma.user.delete` (line
     54) so concurrent sibling sessions can no longer authenticate by
     the time the cascade completes. The integration test at
     `tests/integration/settings-account-delete.test.ts:154-177` pins
     this against real Postgres.
   - Audit row is written BEFORE the delete at line 47-51 — the
     comment on line 44-46 acknowledges this and explains the
     intentional follow-up purge at line 62 for GDPR Art. 17 erasure
     completeness. The `annotate({ action: "settings.account.delete" })`
     wide-event at line 67-70 IS the durable operator-facing trail; the
     audit row gets created+purged inside the same logical operation by
     design. The trail is correct and explicit.
   - Last-admin guard at line 34-39 — single-admin instances can't
     foot-shoot themselves into an unmanaged install. Pinned by test
     at line 208-219.
   - 422 on missing/wrong confirmation, 401 on no session, 400 on
     last-admin guard — all preserved and pinned.

6. **W14 `parked` state machine**.
   - The state machine is sticky-correct: once parked, the row stays
     parked until `resumeIntegrationFromPark` clears it OR a success
     arrives (which can't happen because `isReauthRequired` returns
     `true` for both `error_reauth` and `parked`, short-circuiting the
     sync entry-point).
   - The 24h park threshold uses `persistentFailureStartedAt` (wall-
     clock anchor on the first persistent failure of a streak) +
     `PARK_PERSISTENT_FAILURE_AFTER_MS=24h`. The streak anchor is
     stamped on the first persistent failure and cleared on success —
     same idempotency semantics as the existing `alertedAt` field.
   - `persistentStreakBefore` snapshot at line 369 correctly reads the
     pre-increment bucket value so the "first persistent failure of a
     fresh streak" detection at line 405 works on a fresh streak +
     correctly NO-OPs on a continuing streak. Subtle but correct.
   - Park-event audit row at line 524-537 is written ONCE per transition
     (not per failure) by gating on `existing?.persistentFailureStartedAt`
     — the FIRST persistent failure that crosses 24h sees the anchor
     populated from the prior write, so the audit row fires exactly
     once. Verified by unit test "flips state to parked and writes an
     audit row once persistent streak > 24h".

7. **Cherry-pick aftermath quality**.
   - `32ca196e` (chart-i18n restore) — verified all 4 keys (W11 +
     W2 additions) restored across all 6 locales. The merge collision
     was W12's i18n tighten on the same `messages/*.json` root sweep
     wiping out sibling-wave additions; the restore is verbatim, not
     a behaviour change. Reversibility verified: green CI on the keyed
     locales, no orphan key warnings from `pnpm i18n:check`.
   - `154e6fa7` (auth-test mocks) — adds `checkAuthSurfaceRateLimit`
     mock to login + register test factories that already mocked the
     underlying `checkRateLimit`. The W13 wave wired the surface but
     missed the legacy test files; this commit closes a green-CI gap,
     it does not paper over a runtime regression. Verified the test
     factories already pre-existed; only the new mock function entry
     was added.

8. **Pre-existing failure attribution**.
   - `tests/integration/workout-batch-{create,race}.test.ts` last
     touched in v1.4.25 (`caf2371c` + `6ed925fe` + `17b8d8d2 chore(release): v1.4.25`).
     `git log 2c68a48d..HEAD -- tests/integration/workout-batch-*` returns
     EMPTY — no v1.4.43 commit touches either file. The W13 phase
     report's flag is correct: pre-existing, out-of-scope for v1.4.43.

9. **iOS v0.5.4 backward compatibility**.
   - 35 W6 routes preserve `body.error` as the human-readable string
     (verified via test: `expect(body.error).toBe("Validation failed")`).
   - The new `details.issues` field is additive — JSON decoders that
     don't model it skip it.
   - Status codes preserved across every conversion: every `apiError(...,
     422)` became `returnAllZodIssues(parsed.error, 422)` and every
     `apiError(..., 400)` became `returnAllZodIssues(parsed.error, 400)`.
   - DELETE `/api/settings/account` is a new endpoint, NOT a contract
     change to existing iOS surface — iOS v0.5.4 doesn't call it.
   - The new `parked` state is exposed via the existing integration-
     status response shape (the IntegrationStatusPill component reads
     `state` as a string); iOS doesn't currently surface this UI so
     the new sentinel is a no-op for v0.5.4 clients.
   - `auth.check-user` audit row is server-side only; the response
     shape (`{ branch, hasPasskey, hasPassword }`) is unchanged.

10. **Docker tag-baking (B11) closes the v1.4.42 stale-bundle paper-cut**.
    - `NEXT_PUBLIC_APP_VERSION` is passed via `--build-arg` from the
      docker-publish workflow, picked up as both `ARG` + `ENV` in the
      builder + runner stages of the Dockerfile, then read by
      `/api/version` at runtime with package.json fallback. The
      build-arg becomes part of the BuildKit layer cache key, so a
      release-tag bump invalidates every downstream layer that
      depends on it. The recurring "stale package.json version baked
      into the bundle" failure mode from the v1.4.42 retrigger is now
      structurally closed.

---

## Items verified clean — listed for the trail

- `pull_policy: always` (v1.4.34.2 fix) still in `docker-compose.yml`.
- `pg-boss` worker registry includes the `withings-resume` queue is N/A —
  the route is synchronous (no pg-boss work; just calls
  `resumeIntegrationFromPark` directly).
- No new `as X` type-narrowing casts past Zod boundaries except the
  documented `parsed.data as unknown as AuthenticationResponseJSON`
  double-cast (intentional: SimpleWebAuthn types don't admit Zod's
  `passthrough`-loose-shape).
- All 35 W6 routes still set `Content-Type: application/json` via the
  shared `apiError` / `returnAllZodIssues` helpers (NextResponse.json
  default).
- The `withings/resume` endpoint enforces `requireAuth()` → user-scoped
  by `user.id` → no cross-user resume possible.

## Sign-off

Verdict: **APPROVE WITH 1 MEDIUM + 4 LOW**. Recommend addressing M-1 in
v1.4.44 before the legacy `consecutive_failures` column drops. The four
Lows are deferable — none affect v1.4.43 production behaviour.

Critical / High count: **0**.
