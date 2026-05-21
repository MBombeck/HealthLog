# v1.4.42 Product-lead strategic findings

Reviewer: Product Lead (read-only, strategic).
Inputs: 6 v1.4.42 phase reports (W1-KNIP, W2-ZOD-MULTI-ISSUE,
W3-QUERYKEY-LONGTAIL, W4-ARCH-HYGIENE, W5-IOS-WORKOUTS-DEDUP +
DESIGN-POLISH, W6-WITHINGS-OFF + ENV-CHECK), the v1.4.41 product-lead
backlog seed (B1-B10), `CHANGELOG.md` for v1.4.40 + v1.4.41 baseline,
`v15-strategic-plan.md`, `.planning/v15-ios-handoff/03-api-contracts.md`
+ `08-locked-contracts.md`, `git log 67207d72..develop` (22 commits on
`develop` since the v1.4.41 release tag).

## Verdict

**APPROVE_WITH_FIXES** — code, contracts, and test posture are
tag-ready. The same three release-endgame items that gated v1.4.41
gate v1.4.42 (version bump, CHANGELOG entry, post-deploy verify
plan). They are mechanical, not code-shape; the handoff-to-next-
session pattern that worked for v1.4.41 applies cleanly here. None
of the six waves introduces iOS contract drift; the v1.5 Swift sprint
remains day-1-startable on top of the v1.4.42 deploy.

## Strategic posture

v1.4.42 is the **backlog-close polish release** on top of v1.4.41's
iOS-handoff polish release. The release shape is even tighter than
v1.4.41 (22 commits vs 27 vs v1.4.40's 54), and the changes cluster
around three coherent themes:

1. **The v1.4.41 backlog seed (B1-B10) closes cleanly.** Six of the
   ten backlog items land in this release as discrete waves; three
   are confirmed already-done (no-op via grep verification in W4);
   one is correctly deferred to v1.4.43 (B10 worktree-isolation —
   the marathon was already mid-flight). This is the cleanest
   backlog-to-next-release conversion of the v1.4.39 / v1.4.40 /
   v1.4.41 sequence so far.

2. **The audit-ledger breadcrumb pattern is established.** W2's
   `/api/dashboard/widgets` PUT 422 now writes a
   `dashboard.widgets.validation-failed` audit row alongside the
   422 response. This is the structural foundation for moving 422
   diagnostics beyond the iOS dev console — when the v1.4.43 wave
   rolls the helper across the 41 remaining iOS-contract routes,
   every shape mismatch the iOS team encounters will have a
   permanent ledger breadcrumb without needing a separate logging
   ingest.

3. **iOS contract surface tightens without breaking.** W5's
   `pickCanonicalWorkoutRows()` lands the cross-source dedup helper
   that R-F open question #4 in the v1.5 plan anticipated; the iOS
   Workouts ingest path now drops duplicate Apple Watch × Withings
   ScanWatch rows server-side rather than relying on the iOS client
   to pre-merge. The dedup writes through the existing `duplicate`
   per-entry status enum so iOS clients that ride the v1.4.25
   workouts envelope keep working byte-identically.

The supporting waves (W1 knip gate flip, W3 long-tail factory
migration, W4 tree-hygiene 5 items, W6 Withings off-response
classification + pre-deploy env-check CLI) all close v1.4.41
carry-over items. **Zero new feature surface beyond W5's helper.
Zero new API contract beyond W2's additive `details.issues` field
on one route. Zero new endpoint.** No env-var change. No Prisma
migration. Same patch-bump-correctness posture as v1.4.41.

The release stays inside the conservative-semver doctrine
(`feedback_semver_conservative.md`) — additive only, zero contract
breaks, **v1.4.42 patch bump** is the correct call. v1.5 remains
reserved for the iOS Swift sprint tag.

## Critical (must address before tag)

**None.** All shipped contracts hold; W1's knip gate is now
enforcing, so no future push to main can sneak a dead export past
the CI; W2's envelope is strictly additive and the iOS handoff doc
at `03-api-contracts.md:1044` ("Surface the first issue from `error`
— Zod messages are user-readable") keeps working byte-identically
since `error` still carries the human-readable string. W3's factory
migration is mechanical — 43 files, all guarded by both the ESLint
rule and the test-walker so future regressions trip immediately.
W4's tree-hygiene is touch-disjoint with the perf surface. W5's
workouts dedup is write-time only and re-uses the existing
`duplicate` per-entry status. W6's classification preserves the
legacy regex consumers via fallback. Nothing blocks the tag from a
code-shape perspective.

## High (should address before tag)

- **H1 — Version bump + CHANGELOG entry for v1.4.42 is not in
  develop tip.** `package.json` still reports `1.4.41`. CHANGELOG.md
  has no `[1.4.42]` heading. Same shape as v1.4.41's H1 — the
  marathon dispatch pattern lands the version bump + CHANGELOG entry
  in the release-tagging commit alongside the squash-to-main. The
  CHANGELOG should call out:
  - **W1 knip gate flip** as the structural headline (35 dead
    exports → 0, 52 dead types → 0, CI enforcing on every push to
    main).
  - **W2 multi-issue 422 helper** + audit-ledger breadcrumb on
    `/api/dashboard/widgets` as the iOS contract diagnostic
    improvement (closes the v1.4.41 H4 carry-over).
  - **W3 long-tail factory migration** (43 files, settings +
    medications + admin + hooks now factory-only, ESLint guarded).
  - **W4 tree-hygiene** (BERLIN_DAY_FORMATTER 7-way dedup, Suspense
    double-comment, doctor-report binary-blob fix, pr-detection
    soft-delete filter, offhost-backup DR-intent comment).
  - **W5 workouts cross-source dedup helper** (anticipates the iOS
    Workouts ingest sprint) + tile-strip placeholder polish.
  - **W6 Withings off-response classification** + `pnpm check-env`
    CLI as the iOS-perf / ops-hardening pair.
  Marc-voice / English / no PII per the established doctrine. The
  release notes should explicitly state that v1.4.42 is the
  **backlog-close polish release** on top of the v1.4.41
  iOS-handoff polish release, with the iOS Swift sprint freeze
  marker now confirmed as v1.4.42.

- **H2 — `pnpm check-env` should run on the v1.4.42 deploy itself.**
  W6's manifest covers Core / Withings OAuth / APNs / Deploy webhook
  / Off-host backups. Running it pre-deploy against the live Coolify
  secret store would (a) catch any v1.4.40 AP-2 / .p8 regression
  before tagging, (b) prove the manifest's `anyOf [APNS_KEY,
  APNS_KEY_FILE]` rule against the real environment, (c) provide a
  baseline for the v1.4.43 CI integration. Cheap (one `pnpm
  check-env` invocation against the Coolify env-var dump) and exactly
  the use case the wave was designed for. **Mitigation if missed:**
  v1.4.40-shape regression slips again; the v1.4.43 CI integration
  catches it but only after the next release ships. Run it once
  pre-tag.

- **H3 — Post-deploy verify plan should pin the rollout-coverage
  invariant for the knip CI gate.** The gate is now enforcing on
  every push to main. The W1 report notes the `develop` tip is
  green with the documented ignore block; the very first push to
  main after the v1.4.42 tag will exercise the gate. Recommended
  path: run a dry-run `pnpm knip --reporter compact` on the
  squash-to-main commit before pushing; if it returns non-zero
  due to any reconciliation drift between W1 + W3 + W4 (the W1
  report explicitly calls out a "merge order" risk for the two
  re-exports `describeInjectionSite` + `listSupportedTimezones`),
  fix the residual drop before the push lands. The W1 report
  recommends "W1 last" as the merge order; the actual landed
  order was `876a545d` (W2) → `1ea0321d` + earlier (W4) →
  `e2018b2d` (W3) → `dce14fb4` + later (W1) so this should be
  green — verify once before tagging.

## Medium (next-version backlog candidates)

- **M1 — 41-route multi-issue 422 rollout.** W2's report enumerates
  every site at exact `file:line`. This is the v1.4.43 headline
  wave: take the helper W2 shipped and roll it across the 41
  remaining `parsed.error.issues[0].message` call sites, prioritised
  by iOS-contract proximity (measurements / medications / mood
  intake at the top). Bound to ~half a day of mechanical work;
  rolls in the audit-ledger breadcrumb on the iOS hot paths.

- **M2 — Withings sync-activity / sync-sleep catch-block migration
  to `err.classification` direct read.** Working today via the
  regex fallback in `classifyError`; the migration is code-cleanup
  only. Slot into v1.4.43 alongside M1 (both are mechanical) or
  defer to v1.4.44.

- **M3 — `parkIntegrationAtReauth` extension to cover persistent
  Withings failures > 24 h.** Today persistent failures stay at
  `state=error_transient` so the next sync runs; the 3-strike
  admin alert catches the burst either way. The actual behaviour
  Marc would want is: after 24 h of persistent failures, the
  integration parks at "reauth_required" so the user gets the
  in-app alert. Cheap (~30 LOC); v1.4.43 candidate.

- **M4 — CI integration for `pnpm check-env`.** W6 documents the
  skeleton; ship the GH Actions workflow + Coolify pre-deploy
  hook. Closes the operator-side gap that AP-2 originally
  exposed. v1.4.43 candidate.

- **M5 — `eslint-plugin-healthlog/queryKey-factory` expansion to
  remaining tree.** W3 closes the v1.4.41 M2 backlog item but
  the rule's `GUARDED_DIRECTORIES` still excludes `src/components/
  integrations/`, `src/app/**` (except the three specific files),
  and `src/components/insights/**`. Walk the remainder, add to
  the guarded list one chunk at a time. No urgency; pure surface
  cleanup. v1.4.44+ candidate.

- **M6 — Cross-tz proper-fix still v1.5.** Unchanged from
  v1.4.40 / v1.4.41. Marc's tenant is Berlin; runtime guard +
  live SQL fallback covers non-near-UTC tenants. Defers cleanly.

- **M7 — `pickCanonicalWorkoutRows()` ladder calibration.** W5's
  helper hardcodes the ladder `APPLE_HEALTH > WITHINGS > MANUAL >
  IMPORT`. Once iOS Workouts ingest goes live in v1.5 and Marc
  has real-world Apple Watch × Withings ScanWatch overlap data,
  the ladder order may need rebalancing (e.g. if Apple Watch
  routinely under-reports calories vs Withings). Surface as a
  v1.5.1 calibration item, not a v1.4.43 blocker.

## Low (defer)

- **L1 — knip exit-code semantics.** W1's gate flip means a future
  push to main carrying any new unused export trips CI red. The
  failure message points at the file + symbol but does not link
  to the `knip.json` ignore-block syntax. Future-paper-cut only;
  add a one-line README pointer in the next docs refresh.

- **L2 — JSDoc-block queryKey example formatting.** W3 reworded
  the `use-insights-analytics.ts` example to dodge the test-guard's
  line-comment-only regex. Test-guard could grow JSDoc-block regex
  support so the documentation intent doesn't need rewording. Pure
  hygiene; defer.

- **L3 — `WithingsApiError` prototype recovery in pg-boss serialised
  retries.** W6 covers this via the regex fallback in `classifyError`.
  Future-proofing concern: if pg-boss ever changes its serialisation
  format, the regex fallback could fail silently. Add a typed
  `serializedError` shape to the queue payload as a v1.5+ ops hardening
  item.

- **L4 — `workoutsRecentList` factory composite vs spread-and-append.**
  W3 replaced `[...queryKeys.workoutsRecent(), opts]` with a single
  factory entry. Future-paper-cut only: the composite pattern is the
  more correct factory shape; if any new code reaches for the
  spread-and-append shape it should be caught by ESLint immediately.
  No action.

## v1.4.43 backlog seed

- **C1 — 41-route multi-issue 422 rollout** (per M1). Take W2's
  helper across the iOS-contract hot paths (measurements / medications
  / mood intake / dashboard chart-overlay-prefs / integrations
  HealthKit / ingest medication / tokens / devices) first. Med-CRUD
  + auth/settings/admin/feedback/consent second. ~half a day of
  mechanical work; rolls in the audit-ledger breadcrumb pattern on
  every iOS hot path.

- **C2 — Withings classification consumer migration** (per M2).
  Drop the regex fallback in `sync-activity.ts` + `sync-sleep.ts`
  catch blocks; read `err.classification` directly.

- **C3 — `parkIntegrationAtReauth` for > 24 h persistent Withings
  failures** (per M3).

- **C4 — `pnpm check-env` CI integration** (per M4). GH Actions
  workflow against `.env.production.example`; Coolify pre-deploy
  hook against the live container.

- **C5 — Worktree isolation hard rule enforcement.** v1.4.42 was
  the second marathon since the rule landed in
  `~/.claude/skills/release-marathon/SKILL.md`. The W4 report shows
  one wave (`worktree-agent-ae49fe4059ee48d37`) ran without
  collision against W3 (`worktree-agent-a11813dd22a55cbf7`); the
  rule held. Future marathons must continue applying it. No action
  in v1.4.43 beyond "keep applying."

- **C6 — `eslint-plugin-healthlog/queryKey-factory` expansion**
  to remaining unguarded surfaces (per M5).

- **C7 — Long-window summary helper consumer (if missing).** W4
  reconfirmed that `computeLongWindowSummary` is already gone from
  the codebase (no matches). Carry-over item is closed. Drop the
  carry-over flag from the v1.4.43 backlog template.

- **C8 — `ensureUserMedicationComplianceFresh` decision.** Same
  shape as C7 — W4 reconfirmed already-gone. Drop from carry-over.

- **C9 — `pickCanonicalWorkoutRows()` ladder real-world
  calibration** (per M7) once iOS Workouts ingest deploys.

- **C10 — Tile-strip placeholder min-h verify on settled v1.5 RSC
  migration.** W5 added `min-h-[6rem]` matching live trend-card
  chrome. Once the RSC migration starts streaming tiles in v1.5+,
  verify that the placeholder holds the row open during real
  suspension (not just synthetic). No action in v1.4.43.

## v1.4.41 backlog (B1-B10) closure check

| # | Item | Status |
| --- | --- | --- |
| B1 | knip exports/types gate flip + ignore-block triage | **Closed** (W1 — gate enforcing, 0 unused exports, 0 unused types, ignore-block documented) |
| B2 | `/api/dashboard/widgets` Zod-issue aggregation | **Closed** (W2 — `returnAllZodIssues` helper + widgets PUT migrated + audit-ledger breadcrumb + 14 tests) |
| B3 | Long-tail queryKey factory migration | **Closed** (W3 — 43 files migrated, ESLint allowlist expanded, factory + tests pinned) |
| B4 | `ensureUserMedicationComplianceFresh` decision | **Closed** (W4 confirmed already-gone via grep) |
| B5 | `computeLongWindowSummary` production consumer | **Closed** (W4 confirmed already-gone via grep) |
| B6 | `pickCanonicalWorkoutRows()` cross-source dedup helper | **Closed** (W5 — helper + 12 test cases + wired at `/api/workouts/batch`) |
| B7 | Dashboard 422 multi-issue audit ledger breadcrumb | **Closed** (W2 — `dashboard.widgets.validation-failed` audit row writes; survives DB-write rejection per test) |
| B8 | Pre-deploy Coolify env-var sanity check | **Closed** (W6 — `pnpm check-env` CLI + manifest + 16 test cases + operator doc) |
| B9 | Withings off-response wave | **Closed** (W6 — classifier + typed `WithingsApiError` + 37 new tests + 3-state FailureKind extension) |
| B10 | `release-marathon` skill worktree-isolation enforcement | **Carried forward** (rule landed in v1.4.41 handoff; v1.4.42 was the second marathon to apply it; rule held, no commit drift reported) |

Items added beyond B1-B10:

- **W5 tile-strip placeholder polish** — design-findings L1 + L2
  from `round-v1441-QA-design-findings.md` (not in B1-B10), closed
  with `min-h-[6rem]` + chrome utility parity.

- **W4 BERLIN_DAY_FORMATTER 7-way dedup** + Suspense double-comment
  consolidate + doctor-report binary-blob escape + pr-detection
  soft-delete filter + offhost-backup DR-intent comment — none of
  these were in B1-B10. They are tree-hygiene wins surfaced by the
  W4 wave's own discovery; commendable scope discipline (no creep
  beyond what's mechanically cheap to close).

Items deferred:

- **B10** (worktree-isolation hard rule) — verified held this
  marathon; carries forward as ongoing process discipline, not as
  a v1.4.43 backlog item.

## v1.5 readiness check

**Green. The iOS Swift sprint can start on top of `develop` tip
without backend drift.**

The v1.5 strategic plan dated 2026-05-16 (`v15-strategic-plan.md`)
treats v1.5 web as a "version-bump-only marker." The iOS-handoff
items the plan called out for v1.4.30 / v1.4.31 / v1.4.32 have
already shipped under v1.4.39 / v1.4.40 / v1.4.41; the locked
contracts in `08-locked-contracts.md` hold.

**iOS contract status against `.planning/v15-ios-handoff/`:**

- **§ Workouts (POST /api/workouts/batch)** — W5 adds write-time
  cross-source dedup but preserves the per-entry envelope: dropped
  twins surface as `duplicate`, exactly the existing `EntryStatus`
  enum the iOS contract pins at `03-api-contracts.md:481` ("Response
  identical to measurements batch — per-entry status, race
  reconciliation"). Idempotency invariant `(userId, source,
  externalId)` composite unique index unchanged. iOS-side caller
  behaviour: zero diff. ✓ Additive-safe.

- **422 envelope shape** — W2 helper's response carries:
  ```json
  {
    "data": null,
    "error": "Validation failed",
    "details": { "issues": [{ "path", "code", "message" }, …] },
    "meta": { /* optional */ }
  }
  ```
  iOS handoff at `03-api-contracts.md:1044` says "Surface the first
  issue from `error` (Zod messages are user-readable)". The `error`
  field still carries a human-readable string. New iOS builds can
  branch on `body.details?.issues` for multi-field validation feedback
  but do not have to. ✓ Additive-safe; the locked-contracts §
  Zod-strict rule (no `.passthrough`) is untouched.

- **Withings sync surface** — W6 changes the typed `Error` shape
  thrown by client entrypoints, but the dispatched sync state +
  audit-row + admin-alert shape stays additive (`kind: "persistent"`
  is a new label inside the existing audit row; legacy `transient
  / reauth_required` consumers keep working). iOS does not interact
  with the Withings sync surface directly; the integration status
  endpoint (`/api/integrations/withings`) shape is preserved. ✓ No
  contract drift.

- **All other waves (W1 knip, W3 queryKey, W4 tree-hygiene)** —
  zero API surface. ✓

**Open items that gate iOS sprint kickoff:** none. Every required
backend surface is live or documented. The iOS team can start Day 1
of the strategic plan's Track A (Coach SSE drawer), Track B
(SyncMode + Workouts ingest), Track C (daily-stats per
`HKStatisticsCollectionQuery`) against the v1.4.42 deploy.

**Open items the iOS sprint will likely surface but are not
blockers:**

- 41-route multi-issue 422 rollout (M1 / C1). iOS dev console
  still sees single-issue messages on the 41 sibling routes; per
  the locked iOS handoff rule iOS surfaces `error` text verbatim,
  so this is a debug-time improvement only.
- `pickCanonicalWorkoutRows()` ladder calibration (M7 / C9) once
  Apple Watch + Withings ScanWatch overlap data lands. Iterate
  in v1.5.1.

**Web-freeze trigger update:** the v1.5 plan's freeze marker was
"v1.4.34 tag on main". Actual cadence: v1.4.39 + v1.4.40 + v1.4.41
+ v1.4.42 all shipped past that marker as iOS-handoff / polish
releases. **Recommended:** the v1.4.42 release notes should
explicitly state that v1.4.42 is the actual freeze marker. The
`v15-strategic-plan.md` document should be appended (not rewritten)
with a "Cadence reality" section that resets the freeze trigger
to v1.4.42. v1.4.43 (the 41-route rollout) should be the first
post-freeze emergency-style patch — small, mechanical, no new
surface.

**Net assessment:** the iOS Swift sprint is unblocked. The
strategic plan's day-by-day schedule can begin against `develop`
tip the day after v1.4.42 deploys. Confidence: high — the v1.4.42
wave-level discipline (no Prisma migration, no env-var change, no
new endpoint beyond W2's additive 422 envelope, every wave a small
atomic worktree) is exactly the pre-iOS-sprint shape the strategic
plan calls for.

## Strengths

- **Backlog-to-next-release conversion ratio is the cleanest yet.**
  Six of ten B1-B10 items close in this single release as discrete
  waves (B1 / B2 / B3 / B6 / B7 / B8 / B9). Two more (B4 / B5) are
  confirmed already-done via grep verification — discipline that
  prevents stale backlog drift. One (B10) is correctly classified
  as ongoing process. v1.4.41 → v1.4.42 is the proof that the
  marathon-handoff-doc → backlog-seed → next-release pattern
  scales. The release-marathon skill should reference this as the
  canonical example.

- **W1 knip gate flip is the structural payoff of 4 marathons.**
  v1.4.39 introduced the CI workflow staged. v1.4.40 enabled
  exports tier. v1.4.41 reduced exports 48 → 35 and types kept
  at 52. v1.4.42 drives both tiers to zero and flips the gate to
  enforcing. From this push forward, every PR to main carries an
  invariant: no dead exports or types reach the production tree.
  The ignore-block discipline (one-line rationale per entry, scoped
  to shadcn surface + zod-`infer` external API contract) keeps the
  gate from forcing artificial deletions.

- **W2 audit-ledger breadcrumb is the right shape for iOS
  diagnostics.** Writing a `dashboard.widgets.validation-failed`
  audit row alongside the 422 response means every shape mismatch
  carries a permanent server-side trace. The audit-row write is
  fire-and-forget — the 422 response is the contract, the audit
  row is debugging. Test pins both the success path and the
  audit-row-write-rejection survival. This is exactly how
  ledger-vs-contract separation should work.

- **W3 factory migration scope is responsibly bounded.** 43 files
  across settings + medications + admin + hooks + app pages.
  Every site routes through `queryKeys.<entry>()`. ESLint allowlist
  + test-walker `guardedRoots` updated in lockstep so future
  regressions trip immediately. The factory adds 9 new entries
  (medication-compliance / titration / cadence / glp1-details /
  intake-drug-level-chart / intake-list / withings-status /
  admin-audit-log-filtered / workouts-recent-list) with
  byte-stable shapes pinned by test. Conservative, mechanical,
  reversible.

- **W4 tree-hygiene closes 5 disjoint items in one wave.** The
  BERLIN_DAY_FORMATTER 7-way dedup (-101 / +32 LOC) is the
  highest-leverage item — every future tz formatter change touches
  one file instead of seven. The Suspense double-comment consolidate
  is pure documentation hygiene. The doctor-report binary-blob fix
  is a small but real readability win (git diff goes from "Binary
  files differ" to readable text). The pr-detection-worker
  soft-delete filter closes a small gap (deleted PR could block
  next-best promotion). The offhost-backup DR-intent comment
  documents the deliberate asymmetry. All atomic, all reversible,
  all in one wave.

- **W5 helper anticipates the iOS sprint without forcing
  premature optimisation.** `pickCanonicalWorkoutRows()` is the
  helper the v1.5 plan R-F open question #4 named. 12 test cases
  cover empty input / same-source dup / cross-source overlap /
  no-overlap pass-through / multi-user isolation / multi-activity
  isolation / 4 tie-breakers / boundary inclusivity / determinism
  / mutation-safety. Re-uses `DEFAULT_WORKOUT_SOURCE_PRIORITY`
  from the read-time picker so both write-time + read-time consult
  a single ladder constant — exactly the kind of cross-axis
  consistency a future ladder calibration needs.

- **W6 closes the AP-2 silent-disable root cause.** v1.4.40 AP-2
  cost three days of "iOS push isn't working" because a Coolify
  migration dropped three of four APNs env vars and the app booted
  cleanly. W6's `pnpm check-env` would have caught that pre-deploy.
  The manifest's `allOrNone` group catches the partial-set pattern
  exactly; the `anyOf [APNS_KEY, APNS_KEY_FILE]` rule handles the
  12-factor / filesystem variant cleanly. The classification of
  Withings off-responses into transient / reauth / persistent
  closes the long-standing "is this contract-breaking or upstream-
  outage" diagnostic ambiguity.

- **Conservative-semver call holds: patch bump (1.4.42) is correct.**
  Zero contract breaks; one new helper (`returnAllZodIssues`)
  with one consumer route migrated; one new helper
  (`pickCanonicalWorkoutRows`) wired into the existing workouts
  batch route; one new CLI (`pnpm check-env`) that does not affect
  runtime; structural refactors (knip flip, factory expansion,
  BERLIN_DAY_FORMATTER consolidation); Withings classification
  with full backward-compat fallback. Per
  `feedback_semver_conservative.md`, bugfix-heavy releases with
  additive-only features stay on patch. v1.5 stays reserved for
  iOS native launch.

- **The release is structurally smaller than v1.4.41 and that's
  the right shape.** v1.4.40 was 54 commits, v1.4.41 was 27,
  v1.4.42 is 22. Each release smaller, narrower, more reversible,
  closer to "the next polish wave" than "the next debt-close
  marathon." This is the exact cadence the v1.5 plan's freeze
  marker assumed; v1.4.42 should be the explicit freeze marker.

- **Six wave reports + one product-lead seed from the prior
  release — the audit trail keeps compounding.** A fresh session
  can pick up at the release endgame with full context in under
  an hour. The marathon handoff-doc → backlog-seed → wave-reports
  → next-marathon loop has now operated cleanly across five
  consecutive marathons (v1.4.38 / v1.4.39 / v1.4.40 / v1.4.41 /
  v1.4.42). The operational discipline is what makes the
  multi-marathon cadence sustainable past v1.5.
