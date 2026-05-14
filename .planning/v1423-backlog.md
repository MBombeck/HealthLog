# v1.4.23 backlog — items deferred during the W6 reconcile

Captured at the close of Wave 6 (2026-05-11). Each line points at the
review brief that surfaced it so the v1.4.24 marathon can pick up
without re-reading the full review pack.

## Design

- **Settings-cog vs per-message-controls debate** — Design pushback
  during W6 raised concern that the v1.4.23 dual surface (per-message
  thumbs in `<MessageThread>` AND a global tone/verbosity sheet behind
  the settings cog) duplicates intent. Defer to v1.4.24 once W5 H7
  surfaces enough thumbs data to know whether per-user prompt prefs
  drift from per-message ratings. Source: `phase-W6-v1423-design-review.md`
  - `phase-W6-v1423-product-lead-review.md`.

## Statistics

- **Pearson rigorous incomplete-beta replacement** — the v1.4.23 patch
  raised `MIN_PAIRED_N` from 14 → 20 (W5 H6) as a conservative
  surfacing-gate fix. The full normal-approx → incomplete-beta
  replacement still wants doing; data is at the precision limit for
  small-sample correlations. Source: `phase-W6-v1423-senior-dev-review.md`.

## Security MEDs not applied in commit 1

- **MED-1** — `apns_token` partial UNIQUE index. App-layer guard works
  today; defence-in-depth at the DB layer wants a follow-up migration
  with a `CREATE UNIQUE INDEX … WHERE apns_token IS NOT NULL`. Source:
  `phase-W6-v1423-security-review.md` MED-1.

## LOWs (all 4 reviews, deferred)

- **Sec-LOW-1** — intra-batch duplicates report `inserted` for both
  rows (only 1 actually persists). Self-inflicted accuracy bug, no
  cross-user impact. Fix: dedupe `prepared[]` by `${type}::${externalId}`
  before the `existing` lookup; add regression test in
  `tests/integration/measurements-batch.test.ts`.
- **Sec-LOW-2** — `withIdempotency` caches the 422 "batch too large".
  Documented contract; surface a "retry with fresh key" hint in the
  error message + OpenAPI 422 description.
- **Sec-LOW-3** — APNs key-file read failure leaks the absolute path
  into the wide-event payload. Replace `${message}` with redacted
  `meta: { errno: err.code }`.
- **Sec-LOW-4** — `auth.token.refresh.failed` audit row omits `userId`
  even when resolvable (`already_used`/`expired`/`revoked` paths know
  the row). Extend `RotationResult.failure` to carry the resolved
  userId.
- **Code-review LOWs** — see `phase-W6-v1423-code-review.md` for the
  full list (style nits, missing JSDoc on 2 helpers, unused import in
  `coach-drawer.tsx`).
- **Senior-dev LOWs** — see `phase-W6-v1423-senior-dev-review.md`.
- **Design LOWs** — see `phase-W6-v1423-design-review.md`.
- **Product-Lead LOWs** — see `phase-W6-v1423-product-lead-review.md`.

## Simplify deferrals

- **S-05** — deferred from Session B; see Session B notes in
  `phase-W6-v1423-reconcile-report.md` for rationale (touched too many
  call sites for a v1.4.23 reconcile commit).

## Test infrastructure

- **`coach-prefs.test.ts` integration NextRequest URL mock issue** —
  pre-existing failure flagged by Session A. Re-running with the
  reconcile changes stashed reproduces the same failure, so the cause
  predates v1.4.23. Needs investigation into how `NextRequest`'s URL
  parsing interacts with the test harness's mocked `cookies()`.

## Tooling / harness

- **Sandbox `git commit` silent no-op** — Session H7 agent observed
  `git commit` returning success without a SHA in sandboxed mode under
  certain hook configurations. Candidate for a `.claude/settings.json`
  permission tweak (allow `git commit` unconditionally OR add a
  pre-flight `git status --porcelain=v1 -z` confirmation step).
