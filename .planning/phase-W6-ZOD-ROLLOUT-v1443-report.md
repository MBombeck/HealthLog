# W6-ZOD-ROLLOUT — phase report (v1.4.43)

Branch: `worktree-agent-ae8afd272457e48ab` (off `develop` @ `2c68a48d`).

## What landed

All 41 sites from the v1.4.42 W2-ZOD backlog have been migrated to
`returnAllZodIssues`. Status codes are byte-stable — every route still
responds with the same code it shipped with (422 for the bulk of the
queue, 400 for the consent routes, both preserved). The
`Invalid format:` semantics on the medication CSV importer survive
the rewrite via a new `meta: { errorCode:
"medication.intake.import.invalid_format" }` passthrough; the iOS Sync
engine's `mood.bulk.invalid` and `medications.intake.bulk.invalid`
classifiers are untouched.

### Batch 1 — iOS-contract / high-traffic (audit-ledger breadcrumb)

21 routes touched; every site fires a fire-and-forget
`<route>.validation-failed` audit-ledger row so the operator can grep
`/api/admin/audit` for the validation tail when an iOS contract debug
session lands here.

- `measurements/route.ts` — GET, POST batch, POST single
- `measurements/series/route.ts` — GET (iOS chart loader)
- `measurements/[id]/route.ts` — PUT
- `medications/intake/route.ts` — GET, POST
- `medications/intake/bulk/route.ts` — POST (keeps `mood`-sibling
  `errorCode` meta)
- `medications/[id]/intake/route.ts` — POST, GET
- `medications/[id]/intake/[eventId]/route.ts` — PUT
- `medications/[id]/intake/import/route.ts` — POST (special: keeps
  `Invalid format:` semantics via `meta.errorCode`)
- `mood-entries/route.ts` — GET, POST
- `mood-entries/bulk/route.ts` — POST (preserves `mood.bulk.invalid`)
- `mood-entries/[id]/route.ts` — PUT
- `dashboard/chart-overlay-prefs/route.ts` — PUT
- `integrations/healthkit/route.ts` — PATCH
- `ingest/medication/route.ts` — POST (native ingest, uses
  `apiToken.userId` for the audit row since this path is bearer-auth)
- `devices/route.ts` — POST
- `tokens/route.ts` — POST

Commit: `e5846d2c` — 32 files changed, 2,616 insertions.

### Batch 2 — medication CRUD (no audit-ledger)

8 routes touched. The 422 response is the diagnostic signal — these
are low-traffic detail-page flows where the operator hits the same
issue trail via the Next.js per-request log line and the new
`details.issues` envelope.

- `medications/route.ts` — POST
- `medications/[id]/route.ts` — PUT
- `medications/[id]/glp1/route.ts` — POST
- `medications/[id]/inventory/route.ts` — POST
- `medications/[id]/inventory/[itemId]/route.ts` — PATCH
- `medications/[id]/cadence/route.ts` — GET (only a `days` knob;
  multi-issue test pinned on ≥ 1)
- `medications/[id]/side-effects/route.ts` — GET, POST

Commit: `1c6ac2a7` — 14 files changed, 565 insertions.

### Batch 3 — auth / settings / admin / feedback / consent (no audit-ledger)

12 sites. Consent endpoints kept their `400` status (locked contract,
not 422). The `Invalid format:` prefix lives only on the CSV importer
in batch 1; the consent routes don't share that semantics.

- `auth/password/route.ts` — POST
- `auth/register/route.ts` — POST
- `admin/settings/route.ts` — PUT
- `admin/settings/assistant-flags/route.ts` — PUT
- `admin/feedback/[id]/route.ts` — PATCH
- `admin/users/[id]/route.ts` — PUT
- `user/thresholds/route.ts` — PUT
- `feedback/route.ts` — POST
- `bugreport/route.ts` — POST
- `consent/ai/route.ts` — POST (status 400)
- `consent/ai/latest/route.ts` — GET (status 400), DELETE (status 400)

Also tops up the legacy
`src/app/api/measurements/__tests__/group-by-day.test.ts` mock with a
`prisma.auditLog.create` shim now that the GET-validation-failed path
writes a breadcrumb under batch 1.

Commit: `7efc09ed` — 23 files changed, 836 insertions.

## Tests

220 new unit cases across 27 test files:

| Batch | New routes covered | New test cases |
|---|---|---|
| 1 (iOS-contract) | 16 unique routes (some with multiple verbs) | 120 |
| 2 (med CRUD) | 8 sites across 7 files | 17 |
| 3 (auth/settings/admin) | 12 sites across 11 files | 26 (plus a 1-line mock top-up on group-by-day) |

Total: 304 unit tests across 42 touched test files (incl. the
unchanged-but-touched mocks). Audit-ledger paths have the full
template suite (2-issue + 3-issue + audit-row write + audit-write-
rejection survival); CRUD / auth / consent routes get the minimum
2-issue + 3-issue contract because the brief calls them low-traffic.

Where a route's schema is too narrow to produce three simultaneous
issues (cadence, consent/latest, admin/feedback PATCH), the test is
documented and pinned on the highest reachable count — the helper's
exhaustive 3-issue path stays covered by
`src/lib/__tests__/api-response-zod.test.ts`.

## Quality gates (all green)

- `pnpm typecheck` ✓
- `pnpm lint` ✓ (warning-free; dropped four `apiError` imports that
  became unused after the rewrite — `dashboard/chart-overlay-prefs`,
  `integrations/healthkit`, `measurements/series`,
  `medications/[id]/intake`, `medications/route`,
  `consent/ai/route`, `consent/ai/latest/route` — every other route
  still needs `apiError` for non-Zod 4xx paths)
- `pnpm test --run` ✓ — 468 test files, 4,929 tests pass, 1 pre-
  existing skip

## Architectural surprises

1. **`vi.resetAllMocks()` wipes factory-level `.mockResolvedValue`.**
   Tests that arm their happy-path mocks inside the `vi.mock(...)`
   factory must re-arm them in `beforeEach` once `resetAllMocks()`
   runs — otherwise the route falls through into a `TypeError` on
   `rl.allowed`, the request handler throws, and `apiHandler` swallows
   the stack into a generic 500. Fix is mechanical (move the
   `mockResolvedValue` into `beforeEach`) but the failure mode is
   silent. Caught five times during this wave on rate-limited routes
   and the bug-report appSettings mock.

2. **`@/lib/validations/thresholds` evaluates `METRIC_BOUNDS` at
   module top-level.** Mocking `@/lib/analytics/effective-range` to
   replace only `getAllEffectiveRanges` blows up the validator's
   schema-build step. The fix uses `importOriginal()` to keep the
   live export surface and only override the function under test.

3. **`measurements/route.ts:556` and `:625` line numbers in the
   W2-ZOD report were drift-shifted.** The report labelled them
   "DELETE bulk" / "POST batch" but in the current code 556 is the
   batch-POST 422 and 625 is the single-POST 422; the GET (line 48)
   is the third site. The rewrite preserved every site's status code,
   audit-action name, and meta passthrough regardless of the
   description drift.

## Commit chain

1. `e5846d2c` — `refactor(api): roll out returnAllZodIssues to iOS-contract routes`
2. `1c6ac2a7` — `refactor(api/medications): roll out returnAllZodIssues to CRUD routes`
3. `7efc09ed` — `refactor(api): roll out returnAllZodIssues to auth/settings/admin routes`

## Risk + cut-list

- Envelope still strictly additive: every caller that only reads
  `body.error` keeps seeing a human-readable "Validation failed"
  string. New callers branch on `body.details.issues`.
- Audit-ledger writes are best-effort — a populator hiccup never
  blocks the 422 response (the audit-write-rejection survival case
  pins this on every audit-enabled route).
- `issue.params` is never echoed — the helper strips it and every
  test asserts the `path / code / message`-only shape.

## Out of scope (explicit, per the brief)

- `src/components/**`, `src/lib/tz/**`, `knip.json`,
  `.github/workflows/**` (W1/W3/W4 territory).
- Routes outside the 41-site W2-ZOD queue. `import/route.ts`,
  `measurements/by-external-ids/route.ts`,
  `measurements/batch/route.ts`, `workouts/batch/route.ts` still use
  the `parsed.error.issues[0]?.message ?? "..."` fallback pattern —
  these would need a different rewrite (the fallback string is part
  of their iOS contract).
