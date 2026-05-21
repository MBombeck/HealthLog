# v1.4.42 Code-review findings

W10 — read-only code review, scope: every commit in `9e775aa3..develop`
(i.e. everything after the v1.4.41 squash-merge `67207d72`). Phase reports
under `.planning/phase-W*-v1442-report.md` already documented their own
deltas; this review only flags items those reports did not already raise.

## Verdict

**APPROVE_WITH_FIXES** — code quality is high across all six waves and
the existing tests pin every contract worth pinning. Two release-closure
items (CHANGELOG + `package.json` version bump) are the only blockers
between develop and a clean v1.4.42 tag, and both are part of the standard
release-cut step rather than wave scope. No Critical-tier defects found.

## Critical (must fix before tag)

_None._

## High (should fix before tag)

### H-1 — `package.json` version + CHANGELOG.md not bumped for v1.4.42

- `/Users/marc/Projects/HealthLog/package.json:3` still reads
  `"version": "1.4.41"`.
- `/Users/marc/Projects/HealthLog/CHANGELOG.md` has no v1.4.42 section
  in the develop diff (`git diff 9e775aa3..develop -- CHANGELOG.md` is
  empty).
- Fix at release-cut time: bump `package.json`, add CHANGELOG section
  in Marc-voice English following v1.4.41's pattern. Without it the
  release-marathon's `NEXT_PUBLIC_APP_VERSION` build arg + the
  VersionPoller self-healing shell (memo
  `project_v1438_ios_coord_closure.md`) will mismatch the actual tag.

### H-2 — APNs result row label can mislead when only `APNS_KEY_FILE` is set

- `/Users/marc/Projects/HealthLog/scripts/check-env.ts:191` prints
  `[OK] APNS_KEY` even when the present variable is actually
  `APNS_KEY_FILE`. The `anyOf` lookup at line 132 satisfies the row,
  but the rendered name is the manifest's primary `name` field.
- Symptom — an operator scanning the output sees `[OK] APNS_KEY`,
  greps the Coolify env for `APNS_KEY`, finds nothing, files a
  ghost issue. Exactly the v1.4.40 AP-2 debug loop this script was
  meant to short-circuit.
- Fix: when an `anyOf` row passes, render the matched alternative
  name (e.g. `[OK] APNS_KEY_FILE (satisfies APNS_KEY)`) rather than
  the primary. Two-line patch in `renderResults`.

## Medium (recommended for tag)

### M-1 — `bucket-series.ts` still carries its own `BERLIN_DAY_FORMATTER`

- `/Users/marc/Projects/HealthLog/src/lib/insights/bucket-series.ts:19`
  declares a local `BERLIN_DAY_FORMATTER` identical to the one W4 hoisted
  into `tz/resolver.ts:53`.
- Different consumer (returns `{year, month, day}` numbers via
  `toBerlinYmd`, not the `YYYY-MM-DD` string `toBerlinDayKey` emits),
  so this is _not_ a literal dup, but the formatter constant could
  still be reused. The W4 phase report names "seven status helpers" —
  this eighth site escaped.
- Fix (Medium, mergeable next wave): export `BERLIN_DAY_FORMATTER`
  itself from `tz/resolver.ts` and have `bucket-series.ts` consume it
  for its own `toBerlinYmd`. Saves the duplicate `Intl.DateTimeFormat`
  allocation + keeps every Berlin-day surface keyed off one canonical
  formatter instance.

### M-2 — `medicationIntakeList` packs a plain params object at index 4

- `/Users/marc/Projects/HealthLog/src/lib/query-keys.ts:107` returns
  `["medications", id, "intake", "list", params]` where `params` is
  the same `{sortBy, sortDir, limit, offset, status}` object reference
  the caller passed.
- TanStack Query hashes by structural deep-equal, so the cache key is
  stable across re-renders **as long as the caller passes a stable
  reference or always rebuilds the object with the same field order**.
  The factory's own `chartData` entry (line 286) decomposes the params
  into a flat tuple precisely to avoid this risk; `adminAuditLogFiltered`
  (line 193) does the same.
- Inconsistency: two entries flatten, one entry packs an object. Either
  is correct in isolation, but the mixed pattern increases the chance a
  future refactor accidentally breaks deep-equal hashing on the packed
  entry (e.g. by reordering keys or adding a transient field). The
  pinned test at `query-keys.test.ts:133` only asserts the first four
  positions, not the index-4 shape.
- Fix (Medium): either flatten `medicationIntakeList` to match the
  rest, or document the deep-equal contract on the factory entry and
  pin index-4 shape in the test.

### M-3 — Withings sync-activity / sync-sleep catch-blocks still consult the regex helper

- `/Users/marc/Projects/HealthLog/src/lib/withings/sync-activity.ts` and
  `/Users/marc/Projects/HealthLog/src/lib/withings/sync-sleep.ts` now throw
  typed `WithingsApiError` (good), but their catch-blocks still call
  `extractWithingsStatus(message)` / `isWithingsRefreshReauthFailure`
  rather than `classifyError(err)`.
- Phase report W6 documents this as deferred to v1.4.43 (under
  "Sync-activity / sync-sleep catch-block migration"). Works today via
  the regex fallback inside `classifyError`, so this is **not a
  correctness defect** — it just leaves the migration partial.
- Fix already scheduled — Medium severity for traceability only; no
  v1.4.42 action required.

### M-4 — `audit.dashboard.widgets.validation-failed` audit ledger row carries no rate-limit guard

- `/Users/marc/Projects/HealthLog/src/app/api/dashboard/widgets/route.ts:147`
  best-effort writes one audit row per 422. A poorly-behaved iOS client
  in a tight retry loop could write thousands of audit rows in a minute.
  The widgets PUT does not appear to be rate-limited (no
  `checkRateLimit` call in scope) — the audit table grows fast on a
  client bug.
- Fix (Medium, defer to v1.4.43): either gate audit-row writes behind a
  60 s `(userId, action)` dedup, or add `checkRateLimit` to the widgets
  PUT itself. The widgets PUT is operator-facing settings traffic so
  the threshold can be generous (e.g. 30/min).

## Low (defer to v1.4.43)

### L-1 — `parseEnvFile` in `check-env.ts` does not handle dotenv backslash escapes

- `/Users/marc/Projects/HealthLog/scripts/check-env.ts:83` strips
  surrounding `"`/`'` quotes but does not unescape `\n`, `\t`, etc.
  inside double-quoted values. A `APNS_KEY="-----BEGIN\nPRIVATE..."`
  literal would be classified as `[OK]` but read as the raw escape
  sequence, not a newline.
- Coolify exports without backslash escapes today, so the regression
  is hypothetical. Documented constraint on the helper would be
  enough.

### L-2 — `check-env.ts --file` with no path argument silently falls back to `process.env`

- `/Users/marc/Projects/HealthLog/scripts/check-env.ts:218`:
  `if (fileFlagIdx !== -1 && args[fileFlagIdx + 1])`. If the operator
  passes `pnpm check-env --file` (forgot the path), the script reads
  `process.env` instead of erroring.
- Fix (Low): when `--file` is present but the next arg is missing,
  exit with code 2 + a "missing path" message.

### L-3 — Workouts canonical-row picker uses `<=` for the `±90 s` window — boundary inclusive

- `/Users/marc/Projects/HealthLog/src/lib/workouts/canonical-rows.ts:213`
  uses `Math.abs(...) <= WORKOUT_DEDUP_WINDOW_MS`. Documented contract
  in the JSDoc is `±90 s` — inclusive. Test
  (`canonical-rows.test.ts`) pins the inclusivity.
- No defect; flagged Low because a future tightening to `<` would
  break the pinned test silently if the test only checks "two rows at
  exactly 90 s apart collapse to one survivor" without also checking
  "two rows at 91 s apart stay distinct". Both directions are pinned
  in the test file under "±90 s boundary inclusivity" so this is
  defended.

### L-4 — `WithingsApiError` swallows `body.error` only when it's a string

- `/Users/marc/Projects/HealthLog/src/lib/withings/client.ts:133` (and
  the parallel sites in `refreshAccessToken`, `fetchMeasurements`,
  `subscribeWebhook`, `unsubscribeWebhook`, `sync-activity.ts`,
  `sync-sleep.ts`) read `typeof json?.error === "string" ? json.error : undefined`.
- If Withings ever returns `body.error` as an object (some endpoints
  do), the `upstreamError` slot stays empty and the audit-log line
  carries just `Withings <verb> error: <status>` without context.
- Low risk because every documented Withings error response uses a
  string `error`. Could be tightened by stringifying via JSON.stringify
  when not a string.

## Strengths

- **`returnAllZodIssues` envelope** (`src/lib/api-response.ts:47`) is
  additive, privacy-conscious (drops `issue.params`), and the
  companion `sanitiseZodIssues` correctly factors out the projection
  so the widgets-route's audit ledger row never echoes raw user input.
  7-case unit test + 4-case route test + 3-case integration test —
  the contract is over-pinned.

- **Withings classifier** (`src/lib/withings/response-classifier.ts`)
  walks the three failure shapes (HTTP 5xx, HTTP 200 + non-zero
  status, HTTP 200 + body.status === 0 + empty groups) in the
  right order, defends against the literal 293/294 PERSISTENT_CODES
  precedence over the 200..299 reauth range, and the
  `subscribeWebhook` 294 idempotency downgrade lives at the
  call-site (where it belongs) rather than mutating the classifier
  verdict. 27 + 8 + 2 new tests across three files.

- **Workouts write-time canonical-row picker**
  (`src/lib/workouts/canonical-rows.ts`) shares the
  `DEFAULT_WORKOUT_SOURCE_PRIORITY` ladder with the read-time picker
  (single source of truth, no duplication), is a pure function with
  zero IO, and the 12-case test covers the source ladder, the
  ±90 s boundary inclusivity, the calories tie-breaker, the
  createdAt tie-breaker, and the no-mutation invariant. The
  comparator's "annotated copy" trick at line 241 preserves the
  caller's row reference exactly — survivors carry through to the
  Prisma layer untouched.

- **`pickCanonicalWorkoutRows` integration into the batch route**
  (`src/app/api/workouts/batch/route.ts:273-340`) correctly hoists
  dedup BEFORE the existing externalId-based pre-flight, surfaces
  dropped twins as `duplicate` so iOS sync cursors advance
  identically, and the race-reconcile loop at line 513 was updated
  to walk `survivors` rather than `prepared` so write-dedup losers
  aren't double-counted toward the race-reconcile budget. Smart catch
  the phase report called out.

- **queryKey factory long-tail migration**
  (43 files + 9 factory entries + ESLint allowlist mirror + test-guard
  expansion) is methodical: every new entry has a JSDoc rationale,
  every consumer uses `setQueryData(queryKeys.X(), …)` symmetric with
  the read query, and the `ai-section.tsx` eight-call invalidation
  collapse via `replace_all` to `queryKeys.insightsRoot()` is a clean
  refactor. ESLint rule + test-guard regex both updated so the new
  scope can't drift back to bare literals.

- **Knip gate flip** (`.github/workflows/knip.yml:31` and `knip.json`)
  promotes exports + types tiers to enforcing with a precisely-scoped
  ignore-block (shadcn UI surface for library parity, validations for
  the iOS contract). Zero unused exports + zero unused types on the
  final commit. The reconcile-callout pattern — leave cross-wave dead
  re-exports to a follow-up cleanup commit (`dce14fb4`) before the
  gate flip — is the right merge-order discipline.

- **BERLIN_DAY_FORMATTER dedup** consolidates 7 × 20-LOC blocks into
  one `tz/resolver.ts` export with a JSDoc that correctly distinguishes
  Berlin-anchored cache keys from per-user `userDayKey(date, tz)`.
  Net −101 LOC and the test guard at
  `dashboard-suspense-boundaries.test.ts` confirms no behaviour drift.

- **doctor-report-data.ts control-byte fix** turns a "Binary files
  differ" diff into "Java source, Unicode text, UTF-8 text". Two
  characters changed, twelve months of diff-readability regained.

- **`offhost-backup.ts` DR-intent comment** documents the asymmetry
  between the disaster-recovery snapshot (includes soft-deleted) and
  the user-facing export (excludes soft-deleted) at the
  `prisma.measurement.findMany` call site, with a backreference to
  the symmetric exclusion in `/api/export/full-backup/route.ts`. The
  exact comment a future reviewer will need.

- **`pr-detection-worker.ts` soft-delete filter** is a two-line
  surgical fix (`deletedAt: null` added to two `where` clauses) that
  closes a real edge case (a deleted PR blocking promotion of the
  next-best row). 17 existing test cases still pass; no new tests
  needed because the existing soft-delete coverage already exercises
  the path.

- **Persistent classification** in `withings/sync.ts` +
  `integrations/status.ts` correctly maps `persistent` → state
  `error_transient` (so the next sync still runs) but carries
  `kind: "persistent"` into the audit row + admin-alert payload with
  a distinct "persistent error" label and "investigate the upstream
  contract" action line. Operators get the granular signal without
  the integration getting stuck on a one-off contract bug burst.

- **No commit drift** — every commit message in the v1.4.42 range is
  Marc-voice English, conventional-commit prefixed, no
  `Co-Authored-By: Claude`, no `--no-verify`, no `--no-gpg-sign`. The
  worktree-isolation hard rule
  (`feedback_marathon_worktree_isolation.md`) held across six parallel
  agents — fifth marathon in a row with this discipline now operational.
