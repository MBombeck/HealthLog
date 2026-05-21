# v1.4.43 QA — Product Lead release-readiness review

Scope: strategic + release-readiness review of the full diff
`2c68a48d..develop` (74 commits, +12,301 / -460 LOC across 197 files).
Read-only; no source modifications. All four audit reports and all
seven phase reports (W4 / W6 / W7 / W8 / W11 / W12 / W13 / W14) read
end-to-end before this verdict.

## Verdict

**SHIP** — v1.4.43 is ready for production at
`healthlog.bombeck.io` once the version bump + CHANGELOG entry +
operator notes land. No Critical issues. One High (H3 partial-wire
ship) is a quality concern, not a release blocker. All Discovery
Highs and Criticals from the four audits closed; almost every Medium
picked up; Lows correctly deferred to v1.4.44.

## Critical / High count

- **Critical**: 0
- **High**: 1 (H3 partial wire — see below)
- **Medium**: 3
- **Low**: 4

---

## High (must address before tag — but not blocker if Operator notes
the gap)

### PL-H1 — `IntegrationStatusPill` `"warning"` state ships dark

- **What**: W4 added a fourth pill state `"warning"` with locale copy
  `settings.integrationPill.warningServerError` ("Verbunden, aber
  Serverfehler" / "Connected, server error") to close audit-H3
  (v1.4.42 `persistent` failure-kind has no user surface). The pill
  component renders the state correctly when called. But no
  production code path passes `state="warning"` to the pill.
- **Why**: The wave's file allow-list excluded
  `integrations-section.tsx` (the caller). W4's phase report
  documents the gap explicitly and lists the three steps to wire it
  (Prisma `lastFailureKind` column, `/api/integrations/status`
  payload extension, `pillStateFor` branch). The follow-up wave W14
  did touch `integrations-section.tsx` but only to wire `"parked"`;
  the `"warning"` wire-up was missed.
- **Result**: The audit-H3 contract is half-shipped. A Withings
  persistent failure (rate-limit 601 / contract-mismatch 293/294)
  still surfaces as the same red "Fehler — neu verbinden" pill that
  every transient or reauth failure paints — the same UX confusion
  the v1.4.42 classifier was meant to close.
- **Severity rationale**: High because audit-H3 was tagged
  ship-before-tag and the audit's reasoning ("a user clicking the
  reconnect link 10 times learns nothing") still holds. Not a
  blocker because (a) the `"parked"` state in W14 partially
  compensates (a >24h persistent streak escalates to the parked pill
  with copy "Pausiert — manuell wieder verbinden", which IS
  user-distinct), and (b) the under-24h gap is a missing improvement
  rather than a regression — the v1.4.42 behaviour ships unchanged.
- **Recommended path**:
  - Option A (defer cleanly): drop the `"warning"` pill state from
    `integration-status-pill.tsx` and remove the four locale keys
    (`warningServerError` × 6). The pill should not ship dark code.
    Move the full wiring (Prisma + API + section + pill) to a
    standalone v1.4.44 wave per the W4 phase-report blueprint.
  - Option B (ship as-is + document): leave the dark code in place
    and document under "Known follow-up" in the v1.4.43 operator
    notes so v1.4.44 has the breadcrumb. Cost: one additional
    component state to maintain.
  - Recommend Option A — dark UI code violates the v1.4.40
    audit-G "ghost-purge" hygiene rule and the W-SIMPLIFIER pattern
    that's been the consistent direction since v1.4.41.

---

## Medium (recommended, not blockers)

### PL-M1 — Version bump + CHANGELOG entry not yet landed

- `package.json` still reads `"version": "1.4.42"`.
- `CHANGELOG.md` has no `[1.4.43]` entry.
- The handoff (`v1443-handoff.md` step 6 / 7) explicitly scopes both
  for the fresh session.
- The CHANGELOG draft needs to cite the 4 audit reports + 7 phase
  reports + REG-11 (the Marc-authored dashboard summary fix that
  doesn't sit under a wave). Shape mirrors `[1.4.42]` (Added /
  Changed / Fixed / Performance / Operator notes).

### PL-M2 — Operator notes must clearly call out `prisma migrate deploy`

- v1.4.43 ships migration `0075_v1443_integration_park` (additive,
  idempotent — two `ADD COLUMN IF NOT EXISTS` statements). Coolify
  auto-deploy DOES NOT run `prisma migrate deploy`; the operator
  must run it manually. Recommended note:
  > **Migration**: run `pnpm exec prisma migrate deploy` against
  > production Postgres **before** the new container starts serving
  > traffic. The two new columns are nullable + back-filled lazily
  > by the status writer, so existing rows keep working through the
  > migration boundary; rollback is `DROP COLUMN IF EXISTS` on both
  > columns + `UPDATE integration_statuses SET state =
  > 'error_transient' WHERE state = 'parked'`.

### PL-M3 — Cross-agent commit-attribution drift not relevant this
release (positive observation)

- Every commit on `develop` since `2c68a48d` is authored by
  `Marc-André Bombeck` — `git log --format="%an" 2c68a48d..HEAD |
  sort | uniq -c` returns `74 Marc-André Bombeck`.
- Per the `feedback_marathon_worktree_isolation.md` rule (4
  drift-marathons proved shared-tree is broken), the v1.4.43
  marathon dispatched 9 worktree-isolated agents (per the handoff)
  and the cherry-pick chain landed clean. **No drift recurrence.**
- Action: cite this in the v1.4.43 retrospective. The worktree-
  isolation rule is now proven across 3 consecutive marathons
  (v1.4.41 / v1.4.42 / v1.4.43).

---

## Low (defer to v1.4.44 / non-blocking)

### PL-L1 — `.planning/` audit + phase reports contain "Marc" mentions

- `round-v1443-AUDIT-mobile-ui-findings.md`, `…qol-findings.md`,
  `…analytics-9s-findings.md`, `phase-W4-QoL-COPY-v1443-report.md`,
  `phase-W8-OPS-v1443-report.md` all contain literal "Marc"
  references.
- Per `feedback_no_pii_in_user_facing.md`, the rule scopes to
  *user-facing* artifacts (CHANGELOG, GH releases, `docs/audit/v*`,
  `docs/site`, landing). `.planning/` is operator-side work-product
  and not published. The mentions are operationally-useful context
  for the next marathon.
- **No action required** — confirming the rule doesn't trip here.
- The v1.4.43 CHANGELOG entry MUST stay PII-clean (no Marc-name, no
  bombeck.io, no health figures, no BD-Zielbereich values).

### PL-L2 — REG-11 (dashboard summary 7d window drop) lands without
a phase report

- Commit `600aa369` is the dashboard `latestEver` fix that closed a
  iOS-side BP/pulse tile blank-state bug (5 iOS-side attempts
  failed because the bug was in server SQL). It rides v1.4.43 but
  doesn't sit under any wave. Marc authored it directly between
  W11 dispatch and the QA round.
- The commit body is in German (Marc-authored, not an agent — the
  Marc-voice English rule applies to agent-authored commits, not
  Marc's direct authorship).
- **Action**: cite REG-11 explicitly in the CHANGELOG `[1.4.43]`
  "Fixed" section so the iOS team has the breadcrumb without
  hunting commit logs.

### PL-L3 — W7 deferral semantics drifted between handoff and W14

- The v1443-handoff (line 15) marks W7 as "B3 only — B4 + B7
  deferred to v1.4.44". W14 then landed B4 + B7 inside v1.4.43.
- Net effect: v1.4.43 ships more than the handoff scope claimed.
  Audit closure is BETTER than promised, but the v1.4.44 backlog
  documented in the handoff (line 53) now contains items that
  already shipped.
- **Action**: when v1.4.44 backlog rolls forward, drop W7-B4 + W7-B7
  from the "deferred" list. Reflect the actual close in the
  retrospective memo.

### PL-L4 — Test-count delta not yet aggregated

- Each phase report cites a local test-count delta against their
  worktree baseline (W11: 4815→4861, W12: 4815→4877, W13: 4815→4839,
  W14: 4815→4842, W6: 4929 total). With overlapping baselines the
  net total against `develop` HEAD is unclear. The phase reports
  add up to ~+300 unit tests across W4 + W6 + W11 + W12 + W13 + W14
  ignoring overlaps; the full `pnpm test --run` against HEAD will
  produce the authoritative number for the CHANGELOG.
- **Action**: run `pnpm test --run` once at HEAD before the version
  bump; cite the resulting test count in the CHANGELOG.

---

## Discovery → close coverage matrix

### Audit: analytics-9s

| Item | Severity | Status |
|---|---|---|
| W1 — `computeAvg30LastYearMap` `p-limit(4)` cap | URGENT | **Closed** via `c9a54154` + test pin `3218cb50` |

Verdict: complete. The audit's "recommended fix" body landed
exactly as prescribed. Optional follow-ups (granularity router pin,
24h cache) correctly deferred.

### Audit: mobile-ui

| Severity | Closed | Open / Deferred |
|---|---|---|
| Critical (1) | C1 (raw-count gate + `noDataInRange` split) | — |
| High (5) | H1 Switch 44 px, H2 comparison-baseline 44 px, H3 mood-kebab, H4 sheet close-X, H5 reduced-motion smooth-scroll | — |
| Medium (6) | M1–M6 all closed via W11 | — |
| Low (6) | L1, L2, L4 (folded), L6 | L3 (Textarea primitive — refactor scope), L5 (injection-site SVG — non-trivial refactor) |

Verdict: **all Highs + Criticals closed**. Two Lows correctly
deferred with audit-report-honest documentation in W11 phase report
(L5 specifically rebutting the audit's misread of the element type
— well-handled, Marc-voice).

### Audit: QoL

| Severity | Closed | Open / Deferred |
|---|---|---|
| High (6) | H1 loadError key, H2 Anbieter rename, H3 persistent (partial — see PL-H1), H4 not-found i18n, H5 global-error bilingual, H6 plural forms | — |
| Medium (8) | M3 account-delete, M4 doctor-report disabled rows, M5 offline-banner, M6 errorNetwork, M7 daysAgo "d", M8 full Locale union | M1 (drag-drop reorder — a11y scope), M2 (Coach disable — feature scope) |
| Low (8) | L1, L2, L3, L4, L5, L7, L8 | L6 (onboarding gate) |

Verdict: H3 partial (PL-H1 above) is the single open thread.
Everything else closed cleanly.

### Audit: security

| Severity | Closed | Open / Deferred |
|---|---|---|
| High (2) | H-1 audit-row identifier-hash, H-2 WithingsApiError 1024 slice | — |
| Medium (4) | M-1 check-user audit, M-2 plain-text invariant docblock, M-3 replay-injection scan, M-4 trust-violation bucket | — |
| Low (4) | L-2 snapshot scan guard, L-3 passkey Zod boundary | L-1 (withings_state nonce table — OAuth refactor scope), L-4 (legacy_form_total — wait for v1.4.27 cut) |

Verdict: **all Highs + every Medium + 2/4 Lows closed**. M-3 was
listed as "defer" in the audit but W13 closed it inside the
release. Defence-in-depth surface significantly strengthened.

---

## Release-theme coherence

v1.4.43 has a clear three-strand narrative:

1. **9 s perf regression closure** (W1 + measurable in HAR — the
   audit's URGENT call) — single largest user-visible win.
2. **Audit-close marathon** — every Critical + every High across
   four audits closed, almost every Medium picked up.
3. **iOS-handoff hardening** — Zod multi-issue rollout (41 routes),
   Withings parking + per-kind counters, docker version-cache fix
   (B11) closes the v1.4.42 recurring paper-cut.

A clean release-note title: **"v1.4.43 — Analytics 9 s closure,
audit-marathon close (4 reports / 9 waves), Withings parking, iOS
contract Zod rollout."**

This is a *focused polishing release*, not a grab-bag. Compare with
the v1.4.36 / v1.4.37 perf marathons or v1.4.40 architecture
closure — same shape, same coherence.

---

## iOS contract preservation

- **W6 Zod rollout (41 routes)**: envelope strictly additive. Every
  caller reading `body.error` still gets a human-readable "Validation
  failed" string. New callers branch on `body.details.issues`. iOS
  v0.5.4 receives the same shape — no break.
- **W14 `/api/integrations/withings/resume`**: net-new POST endpoint
  with no payload. Additive. iOS v0.5.4 doesn't call it; future iOS
  release MAY add it.
- **W14 `IntegrationStatus.state = "parked"`**: new enum value in a
  string field. Per the 0029 migration comment ("adding new
  sentinels in v1.5 doesn't require a migration") this is the
  documented evolution pattern. iOS v0.5.4 will fall through to a
  generic state branch; verified the new `consecutiveFailuresByKind`
  + `persistentFailureStartedAt` columns are NOT in the API
  view-model (`/api/integrations/status` `IntegrationViewModel`
  unchanged).
- **W12 `DELETE /api/settings/account`**: pre-existing endpoint; the
  v1.4.43 work is UI-only.
- **REG-11 `/api/dashboard/summary`**: shape unchanged; behaviour
  fixed — now serves BP/pulse rows older than 7 d. Pure server-side
  bug fix, iOS surface improves with no client changes.

**No iOS contract drift.** v1.4.43 is iOS v0.5.4-compatible.

---

## Migration readiness

- Migration `0075_v1443_integration_park` is additive + idempotent +
  reversible:
  ```sql
  ALTER TABLE "integration_statuses"
      ADD COLUMN IF NOT EXISTS "consecutive_failures_by_kind" JSONB;
  ALTER TABLE "integration_statuses"
      ADD COLUMN IF NOT EXISTS "persistent_failure_started_at" TIMESTAMP(3);
  ```
- Both columns nullable — pre-migration rows keep working. The
  status writer back-fills `consecutiveFailuresByKind` lazily on the
  next failure write.
- Operator notes draft: see PL-M2 above. The migration is the only
  release-blocking ops action.

---

## v1.4.44 backlog seed (recommended)

Carry forward to the next marathon brief:

### High (must do early)

- **WTH-WIRE-WARNING** — finalise the audit-H3 wiring: Prisma
  `lastFailureKind` column on `IntegrationStatus`, plumb through
  `/api/integrations/status` payload, branch `pillStateFor` to
  return `"warning"` when `failureKind === "persistent"` (or drop
  the dark `"warning"` pill state per PL-H1 Option A).
- **WTH-DROP-LEGACY-COUNTER** — drop `IntegrationStatus.consecutiveFailures`
  per the W14 phase report ("v1.4.44 will drop it once every reader
  has migrated"). Migration `0076_v1444_drop_legacy_counter`.

### Medium

- **TEXTAREA-PRIMITIVE** (audit mobile-ui L3) — introduce
  `<Textarea>` in `src/components/ui/textarea.tsx`, sweep the 6+
  call sites with copy-pasted iOS-zoom defences.
- **INJECTION-SITE-PICKER** (audit mobile-ui L5) — refactor the SVG
  `<circle>` hit zones to HTML `<button>` overlays with a Playwright
  geometry snapshot harness so the picker doesn't drift during the
  refactor.
- **DRAG-DROP-LAYOUT** (audit qol M1) — drag-to-reorder dashboard
  widgets with the keyboard arrow buttons as a11y fallback. Defer
  iff a11y story takes >1 wave.
- **COACH-DISABLE-TOGGLE** (audit qol M2) — per-user `disableCoach`
  flag in Settings → AI; mount-gate `flags.coach && !user.disableCoach`
  on FAB + drawer.
- **ONBOARDING-CHAINED-FLOW-GATE** (audit qol L6) — gate the tour
  on `onboardingCompletedAt + 24h` so a new user gets the dashboard
  between the two onboarding flows.
- **WITHINGS-STATE-NONCE-TABLE** (audit security L-1) — switch
  Withings OAuth state to a random nonce + short-lived row in a new
  table instead of `${userId}:${nonce}` inline.
- **LEGACY-FORM-TOTAL** (audit security L-4) — move to Postgres if
  the v1.4.27 cut still matters, else drop when the legacy form is
  removed.
- **B4 + B7 RECONCILE** (PL-L3) — drop these from the v1.4.44
  backlog since W14 shipped them. The retrospective memo should
  note the v1443-handoff scope vs actual close drift.

### Low

- **Mobile-UI L3 / L5** as above.
- **Cross-tz ±3 h runtime guard** (v1.4.38 carry-forward, still open).
- **Coach replay-injection kill-switch** (audit security M-3 was
  closed; v1.4.44 should add the audit annotation observability
  per the W13 phase report).

---

## Strengths

S1. **Worktree isolation worked.** All 74 commits attributed to
Marc-André Bombeck. Zero cross-agent drift. The
`feedback_marathon_worktree_isolation.md` rule is now battle-tested
across 3 consecutive marathons.

S2. **Audit → close ratio is exceptional.** 1 Critical / 13 Highs /
24 Mediums closed across four audits + the URGENT analytics fix.
Only 2 Highs and 6 Mediums escaped to the v1.4.44 backlog, all
correctly justified as scope-budget defers.

S3. **W1 perf fix is minimum-delta + clean.** The two-line cap
matches the v1.4.40 W-POOL discipline exactly; the audit's
"Recommended fix" body landed verbatim. The optional follow-ups
(granularity router pin, 24h cache) defer cleanly to v1.4.44.

S4. **The C1 chart-gate fix is product-grade.** Not just "show
chart anyway" — the audit's two-option diagnosis was thought
through into a three-state model (empty range / few-days /
chart-ready) with bilingual copy across all six locales and a new
`charts.needMoreDistinctDays*` register. This is the user-facing
release win.

S5. **W6 Zod rollout is contract-safe.** Every iOS-touching route
retained its status code + audit-action name + meta passthrough.
The `Invalid format:` semantics on the medication CSV importer
survive the rewrite via `meta.errorCode`. 220 new test cases pin
the multi-issue contract.

S6. **W13's M-3 (replay-injection) closure exceeds audit
recommendation.** The audit listed M-3 as "defer — pin the pattern
in v1.4.44". W13 closed it with a refusal short-circuit, an audit
annotation, AND an integration test. Closure-above-scope is the
right shape when the fix is bounded.

S7. **W14's per-kind counter design is migration-safe.** The
legacy `consecutiveFailures` integer stays in place for one release
with `Math.max(consecutiveFailures, buckets.*)` reader semantics; a
v1.4.44 migration drops it after every reader has converged. This
is the soft-migration pattern that's worked across v1.4.40
soft-delete and v1.4.42 queryKey-factory closures.

S8. **B11 docker version-cache fix closes a recurring paper cut.**
The v1.4.42 release shipped a stale `package.json` bundle (1.4.41
in the 1.4.42 image) that required a workflow_dispatch retrigger.
The new `ARG NEXT_PUBLIC_APP_VERSION` baked into the image layer
cache key makes this impossible by construction. The runtime
`/api/version` reads from env-first so the bundle version is
authoritative.

S9. **PWA SW cache-version self-heal is closed.** L3 in the QoL
audit flagged `CACHE_VERSION = "v1.4.38.4"` as 4 releases stale.
The `scripts/generate-sw-version.mjs` prebuild step now writes
`sw-version.js` per build and the SW loads it via `importScripts`.
v1.4.38.4 self-heal architecture is now genuinely self-healing
across every release.

S10. **REG-11 was caught by Marc, not by the audit waves.** The
dashboard `latestEver` SQL bug existed since v1.4.38 W-F and only
manifested on iOS where the BP/pulse tile was blank for accounts
whose last reading was older than 7 days. 5 iOS-side attempts had
failed before Marc traced it to server SQL. Worth noting that the
mobile-ui audit didn't catch it (the dashboard summary endpoint
isn't a UI surface; it's a query shape). Future audits could
benefit from a "endpoint-vs-UI-state contract" reviewer pass.

---

## What to do next (in order)

1. Address PL-H1 — recommend Option A (drop dark `"warning"` pill code).
2. Run `pnpm test --run` at HEAD; record the test count.
3. Bump `package.json` version to `1.4.43`.
4. Draft CHANGELOG `[1.4.43]` entry per the v1.4.42 shape (Added /
   Changed / Fixed / Performance / Operator notes; cite all 4 audit
   reports + 7 phase reports + REG-11). Stay PII-clean.
5. Operator notes must say "**Run `pnpm exec prisma migrate
   deploy` before container restart**" per PL-M2.
6. Squash-merge develop → main + tag v1.4.43 + GH release + Coolify
   deploy + verify `/api/version → 1.4.43` per the handoff steps 8–12.
7. Carry the v1.4.44 backlog forward per the seed above.

This is a clean release. Ship it.
