# v1.4.43 QA-Code-Reviewer findings (W10-QA-CODE-REVIEWER)

Scope: read-only cross-cutting review of `git diff 2c68a48d..develop`
covering 74 commits between v1.4.42 and the v1.4.43 release candidate.
+12 301 / -460 across 197 files. The individual wave closures were
already self-reviewed; this pass targets cross-wave drift, contract
preservation, migration safety, the two cherry-pick collision repair
commits, and Marc-voice/PII hygiene across commit subjects + bodies.

Reviewer: W10-QA-CODE-REVIEWER (static review, no execution, no source
changes).

## Verdict

**APPROVE_WITH_FIXES**

One Critical finding requires reconcile before tag — a third W4 i18n
collision was missed by the two existing repair commits (`32ca196e`
restored chart keys, `67434987` restored parked/resume keys, but the W4
`relativeMinutesAgoOne` / `*Other` / `relativeHoursAgo*` /
`relativeDaysAgo*` plural keys are still absent from the messages
bundle after `2390438e i18n: tighten 404 + global-error copy across
all locales` reverted them). The consumer
(`src/lib/i18n/relative-time.ts`) reads the missing keys, the i18n
fallback at `src/lib/i18n/context.tsx:105-107` returns the key string
itself on miss, so the Insights hero strip, Daily Briefing, and
Coach history rail will paint literal strings like
`"insights.relativeMinutesAgoOne"` across all six locales.

Everything else clears: migration is additive + idempotent, the W6
Zod rollout preserves status codes and the `error` field, the
`checkAuthSurfaceRateLimit` wrapper composes correctly across five
auth surfaces, the W14 `parked` state machine has no obvious livelock,
and no `Co-Authored-By: Claude` / Marc-by-name lines appear in any
commit subject or body across the 74 commits.

## Critical (must fix before tag)

### C-1 — formatRelativeTime renders i18n keys as literal strings across Insights surfaces

**Severity**: Critical — user-visible regression on three primary AI
features in six locales.

**Files**:
- `src/lib/i18n/relative-time.ts:28-29, 37-38, 45-46`
- `messages/de.json` / `en.json` / `es.json` / `fr.json` /
  `it.json` / `pl.json` — missing six keys each
- Consumers: `src/components/insights/hero-strip.tsx:135`,
  `src/components/insights/daily-briefing.tsx:323`,
  `src/components/insights/coach-panel/history-rail.tsx:146`

**What happened**:
- `b8ca1c74 i18n(relative-time): branch on count === 1 to render
  singular forms` correctly added `relativeMinutesAgoOne` /
  `relativeMinutesAgoOther` / `relativeHoursAgoOne` /
  `relativeHoursAgoOther` / `relativeDaysAgoOne` /
  `relativeDaysAgoOther` keys across all six locale bundles AND
  rewrote `formatRelativeTime` to branch on `count === 1` between the
  two variants.
- `2390438e i18n: tighten 404 + global-error copy across all locales`
  (landed on the same root branch) reverted the six locales back to a
  pre-W4 baseline that only has the legacy singular `relativeMinutesAgo`
  / `relativeHoursAgo` / `relativeDaysAgo` keys.
- The two earlier collision-repair commits (`32ca196e` for chart keys,
  `67434987` for parked/resume keys) did NOT pick up the W4 plural
  keys.

**Evidence**:
```bash
$ grep -rn "relativeMinutesAgoOne\|relativeMinutesAgoOther" \
    /Users/marc/Projects/HealthLog/messages \
    /Users/marc/Projects/HealthLog/src --include="*.json" \
    --include="*.ts" --include="*.tsx"
src/lib/i18n/relative-time.ts:28:        ? "insights.relativeMinutesAgoOne"
src/lib/i18n/relative-time.ts:29:        : "insights.relativeMinutesAgoOther",
```

i18n fallback chain at `src/lib/i18n/context.tsx:95-117` confirms a
missing key returns the literal key string. So `formatRelativeTime`
output becomes:
- Hero strip's `heroGenerated` interpolation:
  `"Generated insights.relativeMinutesAgoOther minutes ago"`
- Daily briefing's `time` slot: same shape
- Coach history rail row: literal `insights.relativeMinutesAgoOne`

**Why missed**:
- `src/lib/i18n/relative-time.ts` has no companion test
  (`src/lib/i18n/__tests__/relative-time*.test.ts` does not exist).
  `format-date-or-relative.test.ts` exercises a SEPARATE helper
  (`formatDateOrRelative` in `src/lib/format.ts`) that uses the
  legacy singular keys.
- The two earlier collision-repair commits targeted only the keys the
  failing tests pointed at; the W4 helper has no test so the regression
  is invisible to CI.

**Recommended fix** (a third collision-repair commit, same shape as
`32ca196e` / `67434987`):

```
i18n: restore W4 relative-time plural keys swept by 2390438e

i18n: tighten 404 + global-error copy across all locales (2390438e)
reverted the W4 plural keys to a pre-fix baseline. formatRelativeTime
in src/lib/i18n/relative-time.ts reads relativeMinutesAgoOne / Other /
relativeHoursAgoOne / Other / relativeDaysAgoOne / Other but the bundle
only carries the legacy singular form, so the Insights hero strip,
Daily Briefing, and Coach history rail painted literal "insights.relative*"
keys across six locales. Restoring the six keys per locale with their
translations.

Add a regression test src/lib/i18n/__tests__/relative-time.test.ts that
exercises every branch (just-now / count=1 / count=2 for each bucket)
against the actual bundle so a future tighten can't repeat the sweep.
```

Per-locale strings to restore (from `b8ca1c74`):
- en: `"{count} minute ago"` / `"{count} minutes ago"`, etc.
- de: `"vor {count} Minute"` / `"vor {count} Minuten"`, etc.
- es / fr / it / pl: see `git show b8ca1c74 -- messages/`

## High (should fix before tag)

### H-1 — package.json version still reads 1.4.42 at HEAD

**Severity**: High — release-time invariant; not a defect in the diff,
but a checklist item the orchestrator/tagger must honour or every
post-deploy version reader will report stale.

**Files**:
- `package.json:2` — `"version": "1.4.42"`
- `scripts/generate-sw-version.mjs:27-28` reads `pkg.version` and bakes
  it into `public/sw-version.js` as `self.__APP_VERSION__`.
- `src/components/version-poller.tsx:38` reads
  `process.env.NEXT_PUBLIC_APP_VERSION` (build-arg path).

**What this means**:
- The Docker workflow (`docker-publish.yml:198-205`) now correctly
  injects `NEXT_PUBLIC_APP_VERSION=${{ github.ref_name }}` so
  `/api/version` and the version-poller's `SHELL_VERSION` will both
  read `v1.4.43` at runtime independently of `package.json`.
- BUT `scripts/generate-sw-version.mjs` reads ONLY from `package.json`,
  so the Service Worker's `CACHE_VERSION` will key as `v1.4.42` (the
  current `package.json` value) instead of `v1.4.43`.
- Practical impact is contained: the v1.4.38.4 self-healing flow
  (version-poller wipes ALL caches regardless of name) still fires
  correctly because it compares `SHELL_VERSION` against
  `/api/version`, both of which read the env var. The SW's own
  `activate`-step eviction becomes a no-op (same cache key before
  and after), but the destructive wipe still runs.

**Recommended fix**:
Bump `package.json` to `1.4.43` as part of the release commit (the
established pattern — see `324d4bb4 chore(release): v1.4.44 — REG-11`
on main for reference). The release tagger should verify all three
of these match before pushing the tag:
1. `package.json` `"version"` field
2. The pushed git tag (`v1.4.43`)
3. The Docker build-arg (auto-derived from `github.ref_name`)

Alternatively, update `scripts/generate-sw-version.mjs` to prefer
`process.env.NEXT_PUBLIC_APP_VERSION` over `pkg.version` (matches the
shape `/api/version` adopted in `c5d6029b`).

## Medium

### M-1 — Object.defineProperty discriminator on chart data is fragile

**Severity**: Medium — works today, will silently break if the array is
ever spread / cloned / `.map`'d.

**File**: `src/components/charts/health-chart.tsx:693-700, 706-710`

**Context**: W2-CHART-GATE stashes `rawCount` on the returned data array
as a non-enumerable property:
```ts
Object.defineProperty(allData, "rawCount", {
  value: rawMeasurementCount,
  enumerable: false,
  configurable: false,
  writable: false,
});
```
Then reads it via `(data as ChartDataPoint[] & { rawCount?: number })
.rawCount` at line 708.

This works today because the consumer reads `rawCount` directly from
the React Query result without spreading. A future refactor that does
`const cloned = [...data]` or `data.map(...)` loses the discriminator
silently and the empty-state copy reverts to the legacy phrasing.

**Recommended fix**: return `{ rows: ChartDataPoint[], rawCount: number }`
from the query and unpack both at the consumer. The current shape is
a tagged-array hack that hides the second return value behind a
nominally-typed property.

### M-2 — recordWithingsSyncFailure pattern silently widens the error envelope

**Severity**: Medium — code-quality / consistency. No runtime defect.

**Files**:
- `src/lib/withings/sync.ts` — new `recordWithingsSyncFailure(userId, err)`
  helper
- `src/lib/withings/sync-activity.ts:295-309` — calls it
- `src/lib/withings/sync-sleep.ts:240-244` — calls it

**Observation**: the helper accepts `err: unknown` and uses an
`err instanceof Error ? err.message : String(err)` fallback inside.
`String(err)` on a non-Error object yields `"[object Object]"`, which
then lands in the encrypted `lastError` column AND the audit-row
`message` field. The pre-v1.4.43 paths did the same coercion, so this
is not a regression — but it now lives in a shared helper that's a
candidate for the v1.5 moodlog reuse, and a misuse there would
silently corrupt the audit ledger.

**Recommended fix**: tighten the helper signature to
`err: Error | WithingsApiError | string` so the caller has to deal
with the type at the call site rather than the helper papering over
it. Alternatively, log a wide-event warning when `err` is neither an
Error nor a string so we can spot the misuse in production.

### M-3 — Validation-failed audit rows use prisma.auditLog.create directly, bypassing the IP-geolocation backfill

**Severity**: Medium — operator-artefact-quality only.

**Files**: 41 routes from the W6 rollout. Sample:
- `src/app/api/measurements/route.ts` — both GET and POST paths
- `src/app/api/mood-entries/route.ts`
- `src/app/api/devices/route.ts:79-97`

**Observation**: every `.validation-failed` audit row goes through
`prisma.auditLog.create(...).catch(() => {})` directly instead of the
`auditLog()` helper from `src/lib/auth/audit.ts`. The helper does an
extra MaxMind geo-resolution + carrier backfill on the IP that the
direct path skips.

The result is that an operator filtering on `action LIKE
'%.validation-failed'` sees rows with `ipAddress = null` AND no
geo/carrier metadata, while a same-route business-logic audit row
through `auditLog()` carries the full geo enrichment.

The fire-and-forget shape is intentional (don't slow the 422 reply on
audit-write), but the helper version is also non-blocking and
preserves the enrichment side-channel.

**Recommended fix** (low effort, do as a follow-up if not in scope):
swap the direct create for `auditLog(...).catch(() => {})` in every
W6 route. Diff-stat scope: one import + one wrapper per route, no
behavioural change.

### M-4 — backfillBuckets path in recordSyncFailure double-counts the legacy integer

**Severity**: Medium — corner case affects exactly one transition per
user: the first failure after the v1.4.43 deploy on a user who already
had `consecutiveFailures > 0` from before.

**File**: `src/lib/integrations/status.ts:193-200, 375-395`

**Trace**:
- A user sitting at `consecutiveFailures: 4` and
  `consecutiveFailuresByKind: null` (pre-migration row) hits a 5th
  failure of kind `reauth_required`.
- `startingBuckets` resolves to `null` (the column is null).
- `existing` is set, so the helper goes through the `backfillBuckets`
  branch (line 378): `buckets = backfillBuckets(4, 'reauth_required')`
  → `{ transient: 0, reauth_required: 4, persistent: 0 }`.
- The increment branch at lines 384-395 SKIPS the increment for the
  back-fill path because the comment says the legacy `+1` carries it.
- Then line 451 does `consecutiveFailures: { increment: 1 }` so the
  legacy integer goes 4 → 5, while the bucket stays at 4.
- The next failure of the same kind increments the bucket to 5 (via
  the post-migration branch) and the integer to 6.

**Net effect**: the per-kind bucket undercounts the legacy integer by
exactly one for the first failure after the migration. The 24h park
decision keys off the bucket, but the alert ladder reads
`Math.max(consecutiveFailures, ...buckets)` (line 487-492) so the
ladder still pages at the right moment via the legacy integer.

The park decision uses `persistentStreakBefore === 0` (line 405) to
decide whether to stamp `persistentFailureStartedAt`. For a row whose
back-fill seeds `persistent: 4`, `persistentStreakBefore = 4` so the
stamp is NOT set on this transition — meaning the 24h park can never
fire for this row until either (a) a success resets the buckets to
zero, or (b) the persistent bucket goes back to zero via some other
path that doesn't exist yet.

In practice the moodlog + Withings reauth flow clears the bucket on
the next reconnect, so the corner case only matters for a row that
NEVER reconnects and stays in `reauth_required` indefinitely. That's
not a park-eligible scenario anyway.

**Recommended fix** (cleanup, no behaviour change today):
when back-filling on a `persistent` kind, also set
`persistentFailureStartedAt = now` so the 24h park clock starts at
the back-fill moment instead of waiting for a downstream zero-reset.
Add a test case to `status.test.ts` that pins the back-fill +
persistent transition.

## Low

### L-1 — auditLog() helper is missing on the W14 resume route

**Severity**: Low — audit row is written via `auditLog()` helper inside
`resumeIntegrationFromPark`, so the route handler itself is fine. No
gap; flagging for completeness only — was checking whether the
resume route uses the same direct-create pattern as W6 routes (it
doesn't, which is the correct choice for a stateful audit event).

### L-2 — Hard-coded 24h park threshold without env override

**File**: `src/lib/integrations/status.ts:125` — `const
PARK_PERSISTENT_FAILURE_AFTER_MS = 24 * 60 * 60 * 1000;`

The 3-strike alert threshold reads from
`INTEGRATION_FAILURE_ALERT_THRESHOLD` env. The 24h park threshold does
not. An operator who wants to dial the park window for a specific
upstream outage has to redeploy.

Defer to v1.4.44 backlog.

### L-3 — phase-W*-v1443-report.md files mention "Claude" in their bodies

The phase reports themselves include lines like "No `Co-Authored-By:
Claude`" as part of the Marc-voice / commit-discipline checklist. These
are INTERNAL planning artefacts under `.planning/`, not user-facing.
The directive bars Claude attribution from user-facing artefacts
(commits, CHANGELOG, GH releases, in-app copy, docs site, landing).

`.planning/` files are operator-internal and the mentions there
explicitly document the absence of Claude attribution. No fix needed;
flagging only because the audit checklist asks us to scan for
"`Co-Authored-By: Claude`, no Marc by name, English only".

Defer to v1.4.44 backlog as cleanup if desired (the planning docs
could be reworded to "no AI-assistant attribution" instead of "no
Claude").

## Strengths

- **Migration discipline (W14)**: `0075_v1443_integration_park` is two
  additive nullable columns with `IF NOT EXISTS` guards. Down
  migration is documented in the SQL header. The application code
  reads the column via a Zod-shape-guard
  (`isFailureBucketObject` at status.ts:152-164) and back-fills nulls
  on the next write, so an unmigrated row never crashes a reader.
- **W6 contract preservation**: `returnAllZodIssues` keeps the `error`
  field intact and adds `details.issues` additively. Status codes
  preserved (every migrated route stays on 422 except
  `/api/devices` which the audit reports already documented). The
  `sanitiseZodIssues` helper drops `issue.params` so user-typed
  rejection values never round-trip — the H-1 PII directive is
  respected at the envelope shape.
- **W13 M-4 trust-violation tighter bucket**: `checkAuthSurfaceRateLimit`
  composes correctly across five surfaces (login, register, check-user,
  passkey-login-options, passkey-login-verify, refresh). The
  per-surface bucket key is preserved for the happy path
  (`auth:login:{ip}`); the tighter bucket only kicks in when
  `getClientIpOrTrustWarning` flags a chain mismatch. The wrapper's
  test (`src/lib/__tests__/rate-limit-auth-surface.test.ts`, 213
  lines) covers both branches end-to-end.
- **W1 analytics fan-out cap**: the test
  (`summaries-slice.wmy-cap.test.ts:48-96`) actually observes the
  in-flight count via a controllable promise rather than just
  asserting on the call count. This is the same shape the v1.4.40
  W-POOL test used and is the only way to catch a regression that
  re-floods the pool on completion (not just on dispatch).
- **W14 state-machine docs**: the `IntegrationState` type union
  comment at `status.ts:71-89` enumerates every state + transition
  succinctly. The `formatAdminAlertPayload` security-invariant
  comment at `status.ts:829-848` is a model of what an "this MUST
  NOT change without re-doing the threat model" comment should look
  like — explicit about which fields are upstream-influenced + which
  Telegram parseMode is required.
- **Cherry-pick collision repair commits**: `32ca196e` and
  `67434987` are correctly diagnosed, scoped, and named. Each commit
  body explicitly calls out the collision pattern + the swept keys,
  so a future grep for "swept" surfaces both. (The C-1 finding above
  is that a THIRD collision was missed by the same pattern; the
  pattern itself is sound.)
- **Marc voice + PII**: clean across all 74 commits — no
  `Co-Authored-By: Claude`, no `Marc` by name, no first-person, all
  English, all conventional-commit form. Spot-check confirms no
  personal data in any commit body (no BD numbers, no measurement
  counts, no specific user emails / IPs).
- **No accidental files**: only the audit findings + phase reports
  landed under `.planning/`. The `.gitignore` extension for `*.har`
  closes the v1.4.42 post-deploy debugging artefact loophole. No HAR
  file in the tracked tree (`git ls-files | grep '\.har$'` returns
  empty); the `.planning/v1442-postdeploy-new1.har` lives untracked
  in the worktree which matches the rule.

## Out of scope (flagged for v1.4.44 backlog if desired)

- **L-1 → L-3**: defer per the spec.
- **M-3** (W6 audit-row helper inconsistency) is borderline — if the
  release cycle is already tight, the direct-create pattern is
  functionally correct, just less observable. Bundle the fix with
  any future audit-row enrichment work.
- **M-1** (chart rawCount discriminator) is a maintainability
  finding; works today, will break on a refactor years from now.
  Move to backlog.
