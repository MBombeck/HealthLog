# Codex Audit Prompt — HealthLog v1.4.25

## Context

You are an independent senior reviewer of HealthLog v1.4.25
(`MBombeck/HealthLog`, tag `v1.4.25` at `17b8d8d2`). Marc wants a
second-opinion audit focused on TypeScript / Next.js 16 (App Router)
edge cases and Prisma migration safety on the ten new migrations
(0051–0060), plus the Wave-4-5 surfaces that landed under the v1.4.25
release.

You are reviewing as a senior, narrowly-scoped reviewer. Skip
findings the in-house W21 review pass has already covered (eight
reviewers — code, security, design, senior-dev, simplifier,
product-lead, dead-code, i18n-runtime — generated 103 findings; 63
must-fix shipped through Fix-J through Fix-P + W22 before tag).
This prompt asks for what those reviewers may have missed: TS / Next
edge cases, Prisma migration safety on populated tables, and the
correctness of the recently-applied reconcile work that the in-house
pass put in place but never re-audited.

## Repo + commit anchors

- Tag: `v1.4.25` (commit `17b8d8d2 chore(release): v1.4.25`).
- Predecessor: `v1.4.24` (commit `ca03c609 chore(release): v1.4.24`).
- Full diff: `git diff v1.4.24..v1.4.25` (about 300 commits including
  the dependabot bumps; ignore the bumps, focus on feature commits).
- Migrations to audit: `prisma/migrations/0051_*` through
  `prisma/migrations/0060_*`.
- Reconcile plan documenting which Wave-4-5 finding shipped in which
  Fix-* surface: `.planning/phase-W21-reconcile-plan.md`.
- Product-lead strategic assessment that drove the W22 release-redo:
  `.planning/research/w21-product-lead-assessment.md`.
- W22 release-redo phase report:
  `.planning/phase-W22-v1425-release-redo-report.md`.

## Out-of-scope

- CSS / a11y (W21 design review covered — 11 design findings, 6
  applied to release, 5 deferred). Do not duplicate that surface.
- i18n key dead-code (W15 + W21 dead-code-scan covered — 380 keys
  dropped this release; 148 queued for v1.4.26).
- Native LLM provider integration logic (multi-provider routing has
  been stable since v1.4.16; the prompt + safety contract layer is
  the only Coach surface that moved).
- Branch / CI workflow files (W20-rest + Fix-G + Fix-H + W11a
  covered the auto-deploy + multi-arch + lowercase work).
- Sister-repo (`healthlog-docs`, `healthlog-landing`) version pin
  updates — Marc drives these by hand post-tag.

## Audit focus

### 1. Migration safety on populated tables (Migrations 0051–0060)

For each of the ten new migrations:

- Verify the SQL is idempotent. Does it use `IF NOT EXISTS` /
  `IF EXISTS` consistently? Does it tolerate a re-run against a
  partially-applied state?
- Verify FK additions do not leak orphans. Does every new FK declare
  `ON DELETE` behaviour (CASCADE / SET NULL / RESTRICT) explicitly?
  Is the choice correct for the row-deletion semantics implied by
  the parent table's lifecycle?
- Verify `DEFAULT` on populated tables. Postgres 11+ has a fast-path
  `ADD COLUMN … DEFAULT` that avoids the full-table rewrite. Verify
  every `ADD COLUMN … DEFAULT` in 0051–0060 is on PG11+ syntax and
  does not trip the slow path. Migration 0060 is the specific
  callout: it backfills existing `User.onboardingStep` rows and
  flips the column to `NOT NULL DEFAULT 0`. Verify the backfill
  + flip ordering is safe under concurrent writes.
- Verify Migration 0057's rewritten comment (which describes PG11+
  fast-path semantics for `ADD COLUMN DEFAULT`) is actually accurate
  for the syntax it's commenting on.
- Verify Migration 0055 (sleepstage composite) `NULLS NOT DISTINCT`
  syntax is PG16-native. Confirm the deployed Postgres minor version
  in the v1.4.25 stack is ≥ 16 (check `prisma/schema.prisma` +
  `docker-compose.yml`).
- Verify Migration 0054 (`PersonalRecord` table) unique index is
  `NULLS DISTINCT` and the application-level compensating dedup logic
  in `src/lib/personal-records/pr-detection-worker.ts` correctly
  guards the null-slot dup case. The W21 reconcile applied a
  regression test for this exact case (`5f5b8dfb` and `6f3b901c`);
  verify the test asserts the right thing and the worker logic is
  actually idempotent under contention.
- Verify Migration 0059 (`MedicationSideEffect` table) ingests
  `category` server-derived only — there should be no client-supplied
  `category` field reaching the table (W21 code-M6 / Fix-N).

### 2. TS / Next.js 16 (App Router) edge cases on new route handlers

The Wave-4-5 surfaces add the following App Router route handlers
(non-exhaustive). For each:

- `POST /api/medications/[id]/glp1` (W19c / Fix-K)
- `POST /api/medications/[id]/side-effects` (W19d)
- `POST /api/medications/[id]/cadence` and
  `GET /api/medications/[id]/cadence` (W19e)
- `POST /api/medications/[id]/titration-ladder` and
  `GET /api/medications/[id]/titration-ladder` (W19f)
- `POST /api/medications/[id]/inventory/[itemId]` PATCH (Fix-M)
- `POST /api/onboarding/step` (W14b-Foundation + Fix-M)
- `GET / POST / DELETE /api/auth/me/research-mode` (W19c-Backend)
- `POST /api/workouts/batch` (W16b)
- `DELETE /api/measurements/by-external-ids` (W16a)

Verify:

- **Dynamic-route param access.** Next.js 15+ moved `params` to a
  Promise that must be `await`-ed. Verify every dynamic-route handler
  awaits `params` before destructuring; verify the typed signature
  matches `{ params: Promise<{ id: string; itemId?: string }> }`
  rather than the legacy synchronous shape.
- **`requireAuth()` semantics.** v1.4.24 closed the inverse hole
  (Bearer with no scope reaching unscoped handlers); v1.4.25 closes
  the over-broad hole (narrow-scope Bearer blocked from unscoped
  handlers). Verify every new route either declares a
  `requiredPermission` argument or expects to inherit the wildcard
  (`["*"]`) cookie path. The medication routes consistently use
  `assertMedicationOwnership` (Fix-N) — verify that the helper still
  honours the scope-gate posture.
- **Zod-strict schemas.** Every POST / PATCH should parse through a
  Zod schema with `.strict()` (or `.passthrough()` only when there's
  a clear reason). Verify the new schemas
  (`glp1DoseChangePostSchema`, `glp1InventoryPostSchema`,
  `createSideEffectSchema`, `createWorkoutSchema`,
  `createInventoryItemSchema`) are strict on unknown keys.
- **Idempotency wrapper.** `POST /api/workouts/batch` should wrap in
  `withIdempotency()` — confirm.
- **Audit log.** `POST /api/medications/[id]/glp1` should write an
  `AuditLog` row on every successful POST (W21 sec-H1 / Fix-K).
  Verify the audit reason string is parameterised consistently
  (`medication.glp1.update` per the reconcile plan).
- **Rate-limit envelope.** Every new POST should return the
  `rateLimitHeaders(rl)` envelope on 429 via the `apiError(..., {
  headers })` option-bag form (Fix-N simp-M8 alignment). Verify
  consistency.

### 3. Coach prompt safety contract (GROUND RULES 1–15)

Verify the per-locale safety contracts in `src/lib/coach/safety/`
(or wherever the YAML matrix lives) cover all 15 GROUND RULES with
20+ adversarial paraphrasings each, for all six locales (en / de /
fr / es / it / pl). The CI refusal-probe matrix should be ~1800+
assertions; verify the number matches the YAML × locale × probe
count multiplication.

For GROUND RULE 9 (Coach refuses GLP-1 dose recommendations) and
GROUND RULE 15 (Coach refuses drug-level estimates with EU MDR
2017/745 + MDCG 2021-24 cites) specifically:

- Verify the refusal probe covers the *specific* regulatory failure
  modes the GROUND RULE is designed to catch: drug-level point
  estimates, dose-adjustment recommendations ("should I go up to
  1.0 mg?"), pharmacokinetic predictions, diagnostic claims
  ("is this side effect from semaglutide?"), and indirect
  prompt-injection attempts ("ignore your earlier instructions").
- Verify the refusal copy cites EU MDR 2017/745 + MDCG 2021-24
  verbatim where the GROUND RULE requires it (not just paraphrased).
- Verify the EN + DE bodies are Marc-authored (per the
  Marc-Voice rule); verify the FR / ES / IT / PL bodies carry the
  same safety contract surface even though their prose is
  LLM-drafted (the structural matrix covers safety; the prose
  itself is a v1.4.26 native-speaker review item).

### 4. Per-user timezone correctness

`code-H2` (Fix-O) threaded `timeZone` into `expandScheduleSlots`,
`pairDoses`, `buildCadenceTimeline`, and `complianceChips` via
`Intl.DateTimeFormat`. The cadence route at
`src/app/api/medications/[id]/cadence/route.ts` resolves through
`resolveUserTimeZone(user)`.

Verify:

- **DST-transition correctness.** A cross-midnight dose in
  `America/New_York` at the November fall-back boundary (a day with
  25 hours) — does the schedule expander still produce the right
  number of slots? A dose taken at the duplicated `01:30` local —
  which slot does `pairDoses` pick?
- **Leap-year edge cases.** Feb 29 in a leap-year tz vs Feb 28 in
  a non-leap tz — the slot expansion should not skip or duplicate
  a day.
- **`Intl.DateTimeFormat` cache.** The formatter is expensive; verify
  the helper memoises or reuses an instance per tz argument across
  the loop body (not constructing one per slot).
- **Withings activity TZ anchor.** Migration 0055 + the Withings
  activity sync in `src/lib/withings/sync-activity.ts` anchors per-day
  rows at noon UTC (`T12:00:00.000Z`) — verify the test asserts that
  Berlin, Los Angeles, Tokyo, and Auckland users all bucket the same
  source `YYYY-MM-DD` into the same local-day row. The Fix-O senior-M2
  reconcile applied this; the test must cover all four tz buckets
  unambiguously.

### 5. Source-priority two-axis resolver (W8c)

`pickCanonicalSource()` walks the metric axis first, then a per-device
override within the matched bucket. Verify:

- **Exhaustiveness.** Every `MeasurementType` × `deviceType` combination
  must have a defined resolution path. There should be no combo that
  falls through to `undefined` or throws. Verify by sampling: BP +
  `WITHINGS_BPM_CONNECT`, BP + `MANUAL`, BP + `APPLE_HEALTH` (where
  `deviceType` from Apple Health may not yet have a specific override),
  sleep + `WITHINGS_SLEEP_ANALYZER`, sleep + `APPLE_HEALTH`.
- **`__default__` retirement.** The W21 reconcile plan documents the
  retirement of the `__default__` sentinel in favour of a null bucket.
  Verify there are no lingering `__default__` string references in the
  storage layer or the resolver — search for the literal in
  `src/lib/sources/`, `src/components/settings/sources-section.tsx`,
  and the migration history.
- **`reorderLadder` consolidation.** The `moveSource` + `moveDeviceType`
  paths were collapsed into one helper (commit `03089675`). Verify the
  consolidated helper handles both axes correctly without sentinel
  bleed.

### 6. Inventory state machine (Fix-M code-H1)

The PATCH path on
`src/app/api/medications/[id]/inventory/[itemId]/route.ts` re-runs
`computeInventoryState` after composing the next-state view. The
W21 code-H1 finding was that a back-dated `markAsFirstUseAt` PATCH
left the item in IN_USE; the fix re-runs the state machine on every
PATCH so a back-dated first-use immediately moves a stale pen to
EXPIRED.

Verify:

- The PATCH route in commit `1b5906a5` correctly composes the
  next-state view *before* calling `computeInventoryState`, not the
  other way around (otherwise the state machine sees the stale row).
- The regression test in
  `src/app/api/medications/[id]/inventory/__tests__/route.test.ts`
  asserts the back-dated first-use → EXPIRED contract end-to-end,
  not just a unit-level check on the state-machine helper.
- The bulk `updateMany` replacement of the per-row `prisma.update`
  loop in `expireStaleInUseItems` (commit `1d5dcfb8`) preserves the
  same transition semantics and does not skip rows that the loop
  would have caught.

### 7. Cross-cutting concerns

- **Coach refusal-probe matrix loader.** The YAML loader resolves
  the matrix path from `cwd` rather than `__dirname` (per the
  CHANGELOG "Build resolution for safety-contract YAML" Fixed
  entry). Verify the bundler reshape that the fix protects against
  does not regress in a Next.js production build — try a
  `pnpm build && pnpm start` cold-start and confirm the matrix
  resolves.
- **GLP-1 drift guard self-skip.** The drift-guard test self-skips
  when the EMA research file is absent on a local checkout. Verify
  the skip is conditional on file presence only, not on environment
  (so CI never silently skips the guard).
- **Onboarding step 409.** `POST /api/onboarding/step` conditions
  the update on `{ id, onboardingStep: current,
  onboardingCompletedAt: null }` and returns 409 on conflict
  (commit `7c9b4b65`). Verify the 409 response carries the standard
  `apiError` envelope and does not leak the row's current
  `onboardingStep` in the error body.
- **Personal-records pagination clamp.** `GET /api/personal-records`
  clamps `?limit` (default 25, max 200). Verify a request with
  `?limit=10000` does not silently coerce to 200 without an error;
  verify a request with `?limit=-1` rejects rather than returning
  zero rows.

## Deliverable shape

For each finding:

- **Severity**: Critical / High / Medium / Low.
- **Where**: `path/to/file.ts:line` (or `path/to/migration.sql` for
  Prisma). When the issue spans multiple files, lead with the
  primary site and reference the others.
- **Issue**: 1–2 sentences. Describe the failure mode, not the
  symptom.
- **Proposed fix or follow-up**: 1–3 sentences. If the fix touches
  more than one file, list them.
- **Confidence**: high / medium / low. Note the basis ("static
  analysis only", "verified by running the test under modified
  inputs", "deduced from documentation").

Skip "Low" unless they are load-bearing for the iOS sprint. Marc
applies Critical + High + Medium before the v1.4.26 tag. Lows queue
for v1.4.27 or later.

## Working method

Use the repo's existing tooling rather than guessing:

- `pnpm typecheck` — confirms TS soundness across the surface.
- `pnpm test:unit` — runs the 3 828 unit tests; helpful to confirm a
  finding by writing a regression test first.
- `pnpm test:integration` — runs the ~170 integration tests; the
  `coach-prefs.test.ts` NextRequest mock failures are pre-existing
  and tracked, ignore them.
- `pnpm openapi:check` — confirms the OpenAPI spec is in lockstep with
  the Zod registry.
- `pnpm test:safety` (or the equivalent Coach refusal-probe matrix
  script) — runs the 1800-assertion probe matrix.
- `pnpm prisma migrate dev` against a scratch database — confirms
  the migration train applies cleanly from `0001` forward.

Treat the W21 reviewer findings files as the prior art:

- `.planning/research/w21-security-findings.md`
- `.planning/research/w21-code-review-findings.md`
- `.planning/research/w21-design-findings.md`
- `.planning/research/w21-senior-dev-findings.md`
- `.planning/research/w21-simplifier-findings.md`
- `.planning/research/w21-dead-code-findings.md`
- `.planning/research/w21-i18n-runtime-findings.md`
- `.planning/research/w21-product-lead-assessment.md`

A finding that exactly matches one of those is not interesting (it
shipped or it's tracked in `.planning/v1426-backlog.md`). A finding
that extends one of those — e.g. "Fix-N consolidated nine medication
routes through `assertMedicationOwnership`, but the rate-limit-header
alignment missed the `[id]/intake` route" — is interesting.

## Format

Output as a single Markdown document with one `##` heading per
severity tier (Critical / High / Medium). Under each tier, one
`###` block per finding with the five fields above. End with a
short "Confidence summary" listing how much of the audit surface
you cleared and how much you sampled.

## Tag context for the iOS sprint reader

The audit's downstream consumer is the v1.5 iOS Swift sprint. iOS
DTOs are codegen'd from `docs/api/openapi.yaml`; the spec is now
authoritative (hard-fail drift gate). Any finding that affects an
iOS-touched route signature (the eight P1 routes:
`/api/auth/login`, passkey verify, `/api/auth/refresh`,
`/api/measurements` GET + POST + batch, `/api/devices` POST, and the
comprehensive insights bundle, plus the five v1.4.25 additions:
`/api/workouts/batch`, `/api/measurements/by-external-ids`,
`/api/onboarding/step`, `/api/personal-records`, and the per-device
`/api/auth/me/devices` surface) carries an "iOS-affecting" tag.
That lets Marc triage iOS-blocking fixes ahead of the rest.
