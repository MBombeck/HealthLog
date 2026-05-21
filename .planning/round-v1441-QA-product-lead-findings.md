# v1.4.41 Product-lead strategic findings

Reviewer: Product Lead (read-only, strategic).
Inputs: 6 v1.4.41 phase reports (W-INSIGHTS-HOT, W-SIMPLIFIER, W-FRONTEND-FACTORY,
W-ORG, W-IOS-COORD, W-PROCESS-DOCS), W-DELETED-2 closure (export +
doctor-report + gamification commits), v1.4.41 marathon handoff doc,
`round-v1441-QA-design-findings.md`, `round-v1440-QA-product-lead-findings.md`,
`v15-strategic-plan.md`, `CHANGELOG.md`, `git log 203373dc..develop` (27
commits on `develop`).

## Verdict

**APPROVE_WITH_FIXES** — the four release-endgame items below (version
bump, CHANGELOG entry, knip-flip decision, AP-2 status update in
release notes) must land before the tag is cut. None are code-shape
problems; they are the standard release-mechanics scaffold that the
handoff doc explicitly defers to "next session." Code, contracts, and
test posture are tag-ready.

## Strategic posture

v1.4.41 is the **iOS-handoff polish release** — the punch-list close
on top of v1.4.40's architecture-debt-close marathon. The shape is
deliberately smaller and tighter than v1.4.40 (27 commits vs 54), and
the changes cluster around three coherent themes:

1. **The only user-visible regression Marc reported daily from iOS
   v0.5.4 is gone** — W-INSIGHTS-HOT mirrors the bmi-status timeout-stub
   pattern into `/api/insights/blood-pressure-status` and `/api/insights/
   weight-status`. Subsequent-mount cost drops ~14 s → ~50 ms once the
   first daily stall has minted the stub. This is the headline of the
   release and is what Marc will feel within an hour of deploy.

2. **Soft-delete invisibility is now complete** — W-DELETED-2 closed
   the three read-only readers that W-DELETED (v1.4.40) explicitly
   punted on: export bundle reads (`a62b9498`), doctor-report PDF
   aggregator (`5296a612`), gamification achievement queries
   (`cb8f74e4`). The integration test (`d0bdc4b8`) now pins
   soft-delete invariance across every reader tier including the
   admin / regulatory surfaces. The iOS v0.5.4 `deletedAt` write
   path has zero leak paths into any user-visible surface.

3. **iOS onboarding contract is locked** — W-IOS-COORD shipped
   `/api/auth/check-user` with the four-branch discovery envelope
   (`not_found / passkey_only / email_fallback / exists`) iOS needs
   for the sign-in flow. Combined with the v1.4.40 SB-7 registration-
   status pin, the iOS onboarding screen now has a stable native
   surface; no further server release blocks the iOS sprint.

The supporting waves (W-ORG types consolidation, W-FRONTEND-FACTORY
queryKey factory expansion, W-PROCESS-DOCS ESLint custom rule, prompt
directory unification, dead-export trim, today-intake helper
extraction, unused `tx?` param drop, UNION discovery arm retirement)
all close v1.4.39 / v1.4.40 carry-over items. Zero new feature surface;
zero new API contract; zero new endpoint other than the iOS-targeted
discovery route.

The release stays inside the conservative-semver doctrine
(`feedback_semver_conservative.md`) — additive only, zero contract
breaks, **v1.4.41 patch bump** is the correct call. v1.5 remains
reserved for the iOS Swift sprint tag.

## Critical (must address before tag)

**None.** All shipped contracts hold; the integration tests pin the
soft-delete invariance; the timeout-stub fix carries 4 new test cases.
The handoff doc's two "known issues" (typecheck red on page.tsx,
dashboard-suspense regex) have been resolved on develop tip
(`f2a1e8ce` updates the regex; the page.tsx red was downstream of
W-ORG's AnalyticsData hoist + has been silently fixed in subsequent
commits — `pnpm typecheck` reports clean per the W-SIMPLIFIER quality
gate). Nothing blocks the tag from a code-shape perspective.

## High (should address before tag)

- **H1 — Version bump + CHANGELOG entry for v1.4.41 is not in develop
  tip.** `package.json` still reports `1.4.40`. CHANGELOG.md has no
  `[1.4.41]` heading. The handoff doc explicitly notes this is the
  "next session" reconcile-and-release step, and the marathon dispatch
  pattern always lands the version bump + CHANGELOG entry in the
  release-tagging commit alongside the squash-to-main. Recommended
  path: write the CHANGELOG entry now using the wave reports as the
  source, run the release endgame (squash to main, tag, GH release,
  Coolify deploy). Marc-voice / English / no PII per the established
  doctrine. The CHANGELOG should call out (a) the timeout-stub fix as
  the headline, (b) the W-DELETED-2 closure as the soft-delete-
  completeness story, (c) the iOS-onboarding check-user endpoint, and
  (d) the structural cleanups (prompts dir, types dir, queryKey
  factory expansion, UNION arm retirement, today-intake helper, knip
  cleanup). The performance impact line (~14 s → ~50 ms recurring
  warm response) must be present so post-deploy verify has a target.

- **H2 — AP-2 status update in v1.4.41 release notes.** The handoff
  doc confirms `AP-2 APNs .p8 confirmed installed in Coolify env (5
  entries, byte-identical with ~/Downloads/AuthKey_M9WAFLNC2U.p8)`.
  This closes the v1.4.40 caveat that "SB-5 time-sensitive APNs is
  inert until the .p8 lands." The v1.4.41 release notes / CHANGELOG
  should explicitly record that the .p8 is now installed and the
  time-sensitive interruption-level is live as of this release. iOS
  team needs to know they can verify Focus-bypass behaviour against
  the live deploy. **Mitigation if missed:** the AP-2 caveat carries
  forward inaccurately, the iOS team chases a non-issue. Cheap to fix
  in the CHANGELOG draft.

- **H3 — knip exports/types gate flip — decide and ship the flag in
  this release.** W-SIMPLIFIER reduced unused exports from 48 → 35
  but did not drive to zero. W-PROCESS-DOCS staged the workflow flip
  but did not enable it because "W-SIMPLIFIER and W-INSIGHTS-HOT
  cleanup waves have not yet landed on develop." Both have now landed.
  The current state is 35 unused exports and 52 unused exported types
  remaining; W-SIMPLIFIER explicitly documents that most of the
  remainder are zod-schema / shadcn-surface-area / type-aliases-of-
  exported-typedefs that need a flag-by-flag audit and should stay.
  **Recommended path: do NOT flip the gate in v1.4.41.** Add the 35
  remaining unused exports to a `knip.json` ignore block with one-line
  rationale each (or accept them as the intentional surface), then
  flip in v1.4.42 once the ignore block has stabilised. Shipping the
  flip in v1.4.41 with 35 known offenders would force every push to
  main red on day one — exactly the failure mode W-PROCESS-DOCS warned
  about. Document the v1.4.42 ignore-block triage path in the v1.4.42
  backlog.

- **H4 — `/api/dashboard/widgets` 422 root-cause is iOS-side, but the
  v1.4.41 release notes should surface the diagnostic.** W-IOS-COORD's
  investigation traced the recurring 422 to one of three iOS payload
  candidates (unknown widget id e.g. `glp1`, out-of-range `order`,
  missing required field). Server validator is correct and additive-
  safe. **Strategic note:** the v1.4.41 release notes should include a
  one-line callout that the 422 is an iOS payload shape mismatch (not
  a server validator gap) so the iOS team picks up the investigation
  signal at the same moment they read the release notes for the
  check-user endpoint. Without that callout, the 422 stays in the
  category of "intermittent prod error" rather than "iOS-side fix
  needed in next iOS build." Cheap to add as an Operator note in the
  CHANGELOG.

## Medium (next-version backlog candidates)

- **M1 — `/api/dashboard/widgets` diagnostic improvement: return all
  Zod issues, not just the first.** W-IOS-COORD documents that the
  route returns 422 on `parsed.error.issues[0].message` which is
  unhelpful when multiple fields are wrong. Cheap follow-up (~5 LOC
  change), high-leverage for any future iOS contract debugging.
  Slot into v1.4.42.

- **M2 — Long-tail queryKey factory migration (settings, medications,
  admin, integrations, hooks).** W-FRONTEND-FACTORY shipped the factory
  entries for every site but only migrated auth + notifications + about
  end-to-end. The rest of the surface (settings/account/advanced/ai/
  api/integrations/mood-reminder-card/notification-status-card/
  notifications/ntfy/telegram/thresholds-editor/sources/targets/
  medications/mood-list/measurement-list/insights/coach/admin/twelve-
  sections/onboarding/use-coach-prefs/use-feature-flags) is documented
  as deferred. Each is mechanical; the work fits a quiet v1.4.42 wave.
  Worth one full marathon wave to close.

- **M3 — ESLint `healthlog/queryKey-factory` allowlist expansion in
  lockstep with M2.** W-PROCESS-DOCS shipped the custom rule guarded
  on `src/components/charts/**`, `src/components/comparison/**`,
  `src/app/page.tsx`, `src/hooks/use-auth.ts`. Expand the guarded list
  to `src/components/admin/**`, `src/components/settings/**`,
  `src/components/medications/**`, `src/components/integrations/**` as
  M2 lands. Touch the same wave as M2.

- **M4 — `computeLongWindowSummary` still has no production consumer.**
  Carried over from v1.4.40; cheap to retain; expected to be wired by
  the v1.5 multi-year UI tile or Coach long-window prompt. No action
  in v1.4.41.

- **M5 — `ensureUserMedicationComplianceFresh` ambiguity from v1.4.40
  audit.** Still unresolved in v1.4.41 (no commit touches it). Trivial
  follow-up grep + decide whether to drop or wire. Slot into v1.4.42.

- **M6 — Cross-tz proper-fix still v1.5.** Unchanged from v1.4.40
  posture. Marc's tenant is Berlin; the runtime-guard with live SQL
  fallback continues to cover non-near-UTC tenants. Defers cleanly.

- **M7 — 35 remaining unused exports + 52 unused exported types.**
  Pair with H3 — pre-staging ignore-block triage so v1.4.42 can flip
  the gate cleanly.

## Low (defer)

- **L1 — Tile-strip Suspense placeholder lacks `min-h-[6rem]` for the
  all-suspend edge case** (per `round-v1441-QA-design-findings.md`
  L1). Today the tile bodies are synchronous and the placeholder
  never paints; future-proofing concern only. Slot into a v1.5
  RSC-migration wave if/when chart tiles actually start suspending.

- **L2 — Placeholder div omits cosmetic `flex min-w-0 flex-col`
  classes that the live trend-card carries** (per design findings
  L2). Documentation-completeness flag; the placeholder has no
  children, so the visual footprint is byte-identical for the user.
  Defer.

- **L3 — 422-response diagnostics on every Zod-validated route.**
  The pattern that M1 fixes for `/api/dashboard/widgets` is broader
  — every Zod route returns the first issue, not all of them. If
  M1 lands as a shared helper (`returnAllZodIssues()`), every
  Zod route flips on the helper switch. Out of scope for v1.4.41.

## v1.4.42 backlog seed

- **B1 — knip exports/types gate flip + ignore-block triage.** Move
  the H3 remediation forward; finalise the `knip.json` ignore block,
  one-line rationale per entry, then flip `--include` off in
  `.github/workflows/knip.yml`. Includes the W-INFRA Thread 4 cleanup
  of the 3 ignored barrel files (`e2e/setup/test-helpers.ts`,
  `compliance-line-chart.tsx`, `src/lib/logging/index.ts`) once their
  dedicated tests can also be removed.

- **B2 — `/api/dashboard/widgets` Zod-issue aggregation** (per M1).

- **B3 — Long-tail queryKey factory migration** (per M2) + matching
  ESLint allowlist expansion (per M3).

- **B4 — `ensureUserMedicationComplianceFresh` decision** (per M5).

- **B5 — `computeLongWindowSummary` production consumer** — if no
  v1.5 multi-year UI tile materialises by v1.4.42 cadence, drop the
  export.

- **B6 — `pickCanonicalWorkoutRows()` cross-source dedup helper for
  iOS Workouts ingest.** Anticipates the v1.5 sprint's HKWorkoutType
  read path landing against the existing `/api/workouts/batch` route.

- **B7 — Dashboard 422 multi-issue diagnostic logging in the worker
  audit ledger** so 422s have a permanent breadcrumb beyond the iOS
  dev console.

- **B8 — Pre-deploy Coolify env-var sanity check as a release-day
  gate.** Could have caught the v1.4.40 AP-2 gap pre-deploy; nice-to-
  have rather than required.

- **B9 — Optional Withings off-response wave** carried over from
  v1.4.41 W-PERF-OPS that bailed (per handoff doc) — separate wave,
  not iOS-blocking.

- **B10 — `release-marathon` skill enforcement of git-worktree per
  agent.** Marathon worktree isolation hard rule landed in
  `~/.claude/skills/release-marathon/SKILL.md` per the handoff doc;
  v1.4.41 was already mid-flight and could not apply it, so commit
  attribution drift hit the 5th time (W-PROCESS-DOCS's eslint+knip
  absorbed into W-ORG's prompt commit). The next marathon (v1.4.42 or
  v1.5 sprint) must apply the rule as the load-bearing process change.

## v1.5 readiness check

**Green. The iOS Swift sprint can start on top of `develop` tip
without backend drift.**

The v1.5 strategic plan dated 2026-05-16 (`v15-strategic-plan.md`)
predates the v1.4.39 + v1.4.40 + v1.4.41 marathon sequence and the
explicit "v1.5 web is a version-bump-only marker" maintainer
directive. The plan's web work for v1.4.29 → v1.4.34 is in effect
already shipped under the v1.4.39 / v1.4.40 / v1.4.41 tags (rollup
tier, soft-delete invisibility, queryKey factory, Suspense
boundaries, consent receipts, AASA, time-sensitive APNs, privacy
page, types consolidation, prompt unification, iOS check-user
endpoint, daily-stats helper, drain script, MoodEntry.note, two
new MeasurementType enums per the locked-contracts file).

**iOS contract status (against `.planning/v15-ios-handoff/`):**

- SB-3 (privacy page) ✓ live since v1.4.40.
- SB-4 (AASA) ✓ live since v1.4.40.
- SB-5 (time-sensitive APNs) ✓ live since v1.4.40 + AP-2 .p8 key
  installed per handoff doc → effective as of v1.4.41 deploy.
- SB-6 (NotificationDispatch ledger) ✓ MOOD_REMINDER live; the 6
  other event types still surface `null` per v1.4.40 product-lead
  carry-over. iOS can build against the existing contract; expansion
  is additive.
- SB-7 (`/api/auth/registration-status` pin) ✓ live since v1.4.40.
- SB-7 follow-up (`/api/auth/check-user`) ✓ live as of v1.4.41 →
  this release is the unblocker.
- SB-8 (dashboard layout merge semantics) ✓ documented as
  investigation-only per W-IOS-COORD; new widgets ship migration-
  free via the resolver's append-on-read contract. No code change
  needed for iOS-side new-widget introduction.
- SB-9 (streak deprecation) ✓ already retired (no `/api/streak/*`
  surface in the codebase).
- SB-10 (consent receipts) ✓ live since v1.4.40; iOS Settings
  hook-up is the iOS-side wave's responsibility.
- AP-2 (.p8 install) ✓ closed per handoff doc.

**Open items that gate iOS sprint kickoff:** none. Every required
backend surface is live or documented. The iOS team can start Day 1
of the strategic plan's Track A (Coach SSE drawer), Track B
(SyncMode + Workouts ingest), Track C (daily-stats per
`HKStatisticsCollectionQuery`) against the v1.4.41 deploy.

**Open items that the iOS sprint will likely surface but are not
blockers:**

- Multi-issue Zod diagnostic on `/api/dashboard/widgets` (H4 / M1 /
  B2). The 422 is an iOS payload shape mismatch; iOS will narrow it
  in their dev console using the current single-issue response.
- `pickCanonicalWorkoutRows()` helper (B6) for cross-source dedup
  when Apple Watch + Withings ScanWatch overlap. The `/api/workouts/
  batch` route exists; the dedup helper is the cross-source picker
  the v1.5 plan calls out under R-F open Q #4. iOS can integrate
  against the existing endpoint and surface dedup needs from real
  data.
- Long-tail queryKey factory migration (M2). Web-side cleanup only;
  iOS does not interact with TanStack Query keys.

**Web-freeze trigger reframed:** the v1.5 plan dates the freeze
trigger to "v1.4.34 tag on main." The actual cadence shipped v1.4.40
+ v1.4.41 as iOS-handoff polish releases past the planned freeze
marker. The strategic plan should be updated post-tag to reflect
that v1.4.41 is the actual freeze marker (or v1.4.42 if the
backlog above lands as one more polish wave). Recommend: append a
section to `v15-strategic-plan.md` documenting the actual cadence
that landed and resetting the freeze trigger to v1.4.41 (or
v1.4.42).

**Net assessment:** the iOS Swift sprint is unblocked. The strategic
plan's day-by-day schedule can begin against `develop` tip the day
after v1.4.41 deploys.

## Strengths

- **Headline regression fixed surgically.** W-INSIGHTS-HOT mirrors a
  proven pattern (bmi-status timeout-stub since v1.4.37) verbatim
  into the two iOS-facing routes. Zero new surface area; 4 new test
  cases pin the contract; provider behaviour, response envelope,
  cache shape all unchanged. This is the right kind of fix for a
  user-visible regression Marc feels daily: pattern reuse, contract
  preservation, test coverage, no new failure modes introduced.

- **Soft-delete invisibility now end-to-end.** W-DELETED-2 closes the
  three readers v1.4.40 W-DELETED explicitly punted on. The integration
  test (`d0bdc4b8`) pins the invariant across every reader tier — there
  is no path by which a tombstoned row can surface on a user-facing
  surface (analytics, dashboard, rollups, insights, exports, doctor-
  report, gamification, Coach snapshot). For an iOS-write-deletedAt
  feature that's been live since 2026-05-11, this finally closes the
  contract.

- **iOS onboarding contract locked.** `/api/auth/check-user` ships
  the four-branch envelope iOS needs for sign-in flow without exposing
  any new enumeration surface beyond what `/api/auth/passkey/login-
  options` already discloses. 5 test cases pin all four branches plus
  the 422 required-identifier path. iOS can build the sign-in flow
  against a stable contract.

- **Structural cleanups are coherent and follow the v1.4.39 / v1.4.40
  org-audit recommendations.** W-ORG closes Rec #2 (types promotion)
  and Rec #3 (prompt unification). The three structurally-distinct
  `AnalyticsData` interfaces (mother page / dashboard / checklist /
  sub-page) now have four named exports with clear semantics, instead
  of three inline interfaces colliding on the same name. Prompts have
  one home (`src/lib/ai/prompts/`). queryKey factory expands by ~25
  entries. Each is a small, atomic, reversible refactor.

- **W-SIMPLIFIER's conservative posture is correct.** Cleaning 13
  dead exports while reverting 4 candidate narrowings that lint
  surfaced as "assigned but only used as a type" — exactly the right
  judgement. The 35 remaining unused exports are documented as needing
  a flag-by-flag audit (zod schemas, shadcn surface area, type-of-
  typedef aliases) rather than driven to zero artificially.

- **Marathon worktree-isolation hard rule established.** Per the
  handoff doc, the `release-marathon` skill now requires per-agent
  `git worktree` for any 3+ parallel-agent marathon. Commit
  attribution drift is the 5th recurring occurrence; the rule
  closes the process bug at its root. The next marathon will be the
  first to apply it from start.

- **Conservative-semver call holds: patch bump (1.4.41) is correct.**
  Zero contract breaks; one new endpoint (`/api/auth/check-user`),
  additive only; structural refactors (types dir, prompt dir,
  queryKey factory expansion); UNION arm retirement (post-convergence
  cleanup); 13 dead exports trimmed; perf fix on two routes (cache-
  short-circuit pattern). Per `feedback_semver_conservative.md`,
  bugfix-heavy releases with additive-only features stay on patch.
  v1.5 stays reserved for iOS native launch.

- **The release is structurally smaller than v1.4.40 and that's the
  right shape.** v1.4.40 was a 54-commit architecture-debt-close
  marathon. v1.4.41 is a 27-commit polish-and-iOS-handoff release.
  This is the right release-cadence shape on the way into the iOS
  sprint freeze: each release smaller, narrower, more reversible,
  closer to "the next polish wave" than "the next debt-close
  marathon."

- **Six wave reports, two prior QA findings (round-v1441 design),
  one handoff doc, one ESLint custom rule + plugin, one process-docs
  scaling guide — the marathon left behind enough breadcrumbs that a
  fresh session can land the release endgame in under 2-3 hours per
  the handoff estimate.** This is the operational discipline that
  makes the multi-marathon cadence sustainable.
