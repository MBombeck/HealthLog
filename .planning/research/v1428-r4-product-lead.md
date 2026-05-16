---
file: .planning/research/v1428-r4-product-lead.md
purpose: R4 product-lead — strategic alignment, Marc-Voice, PII compliance, forbidden vocabulary across the v1.4.28 diff
created: 2026-05-16
contributor: R4 product-lead
---

# R4 product-lead review — v1.4.28

Read-only audit of the 30 commits between `948fcd93` (kickoff prompt) and the current `develop` tip (`5570971f`). Scope per the marathon kickoff: strategic alignment with the maintainer's directive, Marc-Voice in commit messages + new strings, PII compliance, forbidden-vocabulary check, CHANGELOG voice readiness, hand-off state to v1.4.29.

Net diff: 123 files, +3 808 / -8 227 lines. The directive "less scope, more depth than v1.4.27" landed as a net deletion — six "remove from code entirely" themes did land as clean delete commits, no half-measures. That part of the strategic brief is honoured.

The release artifacts that R5 owns (CHANGELOG section, version bump in `package.json`, `.planning/v1429-backlog.md`, `.planning/round-5-release-closure-report.md`, the consolidated `.planning/v1428-fix-plan.md` that R2 owns) are absent — `package.json` still reads `"1.4.27"`. R5 has not yet run; this review is taken as a pre-tag gate.

## Severity-grouped findings

### Critical — block the v1.4.28 tag until fixed

**P-CRIT-1 — Maintainer name leaks in commit `9a020f21` body.** Two PII violations in the body of `feat(insights): explain the HealthScore delta on tap`:

- "FB-I1 — Marc asked for a tappable `?` glyph next to the delta line"
- "Body copy is a three-sentence Marc-Voice read"

The "FB-I1 — Marc asked" line is the worst kind of PII leak — it surfaces the maintainer by first name in a commit body that ships to the public mirror the moment `develop` pushes. "Marc-Voice" as a self-referential phrase is the same category. Both must be scrubbed before the v1.4.28 tag.

Recommended replacement for the body's opening paragraph:

```
The "vs last week" delta line on the HealthScore card has been
shipping a digit without explaining what the comparison covers,
why the digit moved, or what the user can do next. FB-I1 — the
maintainer asked for a tappable `?` glyph next to the delta
line that opens a short read explaining the three things in
one shot.
```

And for the body-copy paragraph: replace "Marc-Voice read" with "maintainer-voice read" or simply "three-sentence read".

Fix shape: amend impossible (the kickoff forbids `--amend`), so the conventional path is a follow-up `docs(release): scrub PII from v1.4.28 commit bodies` commit that documents the violation in the closure report — or, the safer path, rewrite the offending commit body on a `release-prep` branch via `git filter-repo` before tag. Either way, the v1.4.28 release closure report must call out the slip so the v1.4.29 kickoff gates on a stricter pre-commit grep.

**P-CRIT-2 — Forbidden vocabulary in commit `cad53a68` body.** `chore(insights): retire the weekly-report surface` ships "the AI prompt rule + OUTPUT FORMAT block" in the body paragraph. "AI" is on the forbidden roots list with no documented exemption for commit prose. The same commit also introduces a new comment in the test file (`weekly-report-banner.test.tsx`):

```
+  // v1.4.28 retired the weekly-report path. The banner, the report
+  // route, the AI schema slot and the i18n keys are gone; the hero
+  // strip never paints the banner under any prop combination now.
```

Two violations from one commit. Recommended replacement for the body sentence: "the schema slot and OUTPUT FORMAT block" (the "AI" qualifier is redundant — the schema/format block already implies the assistant pipeline). The test-file comment should drop "AI" the same way: "the schema slot and the i18n keys are gone".

**P-CRIT-3 — Forbidden vocabulary in commit `8f7cbd49` new comment block.** `fix(insights): document the missing sleep status slot` introduces a 12-line JSX block comment that contains:

- "a written per-section AI assessment" (line 65) — "AI" forbidden
- "No per-section assessment yet — we render" (line 69) — "we" violates the kickoff's no "we / let me / unfortunately" rule

The recommended rewrite drops both:

```
v1.4.28 BK-UI-StatusSchlaf — the six sibling sub-pages all
mount `<InsightStatusCard>` underneath the chart so the user
gets a written per-section assessment. Sleep has no
`/api/insights/sleep-status` route yet (the v1.4.23 schema
landed the data but the assessment-generation pass was
deferred to the v1.5 iOS sprint where the Apple-Health sleep
snapshot will inform the prompt). The structural slot renders
so the surface stays parity with the siblings; the route +
hook key will wire in v1.5.
```

**P-CRIT-4 — Health-figure leak in commit `59ef95f2` body.** `fix(dashboard): align BD-Zielbereich tile with shared TrendCard primitive` ships "≈ 1.1 for a 33-point delta". A 33-point BP delta is plausibly a real reading from the maintainer's data set. The kickoff's PII rubric forbids "health figures, target ranges, measurement counts" in user-facing artifacts. The number is illustrative of the math but reads as concrete because the bug only manifests on a real account's data.

Safer replacement: "a small float (≈ 1.1 for a low-double-digit delta)" or simply "a small float that the TrendCard's downstream formatter pipeline rendered as a date-shaped artefact".

**P-CRIT-5 — Missing release artifacts.** Five Done-when criteria from the kickoff are absent at the time of this review:

- `package.json` still reads `"1.4.27"` (must bump to `1.4.28`)
- `.planning/v1428-fix-plan.md` (kickoff says R2 writes this; not present)
- `.planning/v1429-backlog.md` (Done-when criterion; not present)
- `.planning/round-5-release-closure-report.md` (Done-when criterion; not present)
- CHANGELOG.md section for `[1.4.28]` (not present)

R5 needs all five before the squash-merge into `main` and the tag. Until R5 ships them, the release is not tag-ready regardless of the other Critical findings.

### High — must address before R5 ships the CHANGELOG

**P-HIGH-1 — Forbidden "wave" leak in commit `5109e930`.** `refactor(medications): collapse detail-page chrome to one heading scale` introduces a new JSX comment "classes to match the surrounding wave-4b sections". "wave" is on the forbidden list. The same commit edits a pre-existing JSDoc that already mentions "wave-4b" twice — that pre-existing copy should be scrubbed in the same pass, not preserved. Recommended replacement: "the surrounding section chrome" (drop the version-marker qualifier entirely; the surrounding context already establishes what the chrome is).

This finding pairs with simplifier F-M7 from the v1.4.28 backlog ("stale v1.4.x version markers in code comments"). v1.4.28 had an explicit comment-scrub backlog item that did not land here.

**P-HIGH-2 — Eight commits ship without a body where v1.4.27 cadence would demand one.** The release-marathon convention from v1.4.20 onward is "subject + 2-4 paragraph body explaining the why and the iOS contract impact for any commit > 50 LOC". Eight v1.4.28 commits break this:

| Commit | Subject | LOC |
|---|---|---|
| 235e52cb | refactor(charts): single HealthChartDynamic re-export | +237 / -63 |
| 8c89ddac | refactor(insights): consolidate sub-page data-fetch and empty state | +277 / -186 |
| b0ef80dc | perf(notifications): cache the dispatch-localised user lookup | +225 / -9 |
| ebf83b1e | feat(perf): wire bundle analyzer and web-vitals beacon | +274 / -1 |
| d286220b | perf(charts): wire chart-skeleton loading state across dynamic imports | +76 / -9 |
| 8f3bfc37 | refactor(charts): collapse health-chart dynamic imports onto re-export | +54 / -73 |
| 75773ca0 | i18n: add the lastYear coach window key | +6 |
| 8f7cbd49 | fix(insights): document the missing sleep status slot | +12 |

The two i18n / small-diff commits (75773ca0, 8f7cbd49) are defensible terse; the other six are substantial work with no narrative. v1.4.27's commit cadence had every >50 LOC commit shipping the standard "what / why / iOS contract" three-paragraph body. R5 will lift these subjects into the CHANGELOG and discover they have no body context to crib from — the editorial pass will read thin.

Mitigation: R5 backfills the missing context from the diffs themselves when writing CHANGELOG bullets. Either reshape future contributors' brief to enforce the body convention, or accept that some commits are mechanical enough to carry only a subject and pin that decision in the next kickoff.

**P-HIGH-3 — No R1/R2/R3 round-report planning artifacts.** Per the kickoff, R1 (5 contributors) writes `.planning/research/v1428-r1-*.md`, R2 writes `.planning/v1428-fix-plan.md`, R3 contributors write `.planning/round-3-<bucket>-report.md`, R4 reviewers write `.planning/research/v1428-r4-*.md`. None of the R1/R2/R3 files exist. Only R4 (this file + sibling R4 outputs not yet visible) is mid-flight.

The work in the diff is real; the planning paper-trail did not follow. For a v1.4.x release this is recoverable — the v1.4.27 closure report quoted commits directly to reconstruct what landed. But the kickoff's explicit Done-when "v1429-backlog.md exists with any items deferred to next cycle (with reason per item)" depends on R5 doing the synthesis from raw commit logs instead of from the round reports the convention assumes.

**P-HIGH-4 — Strategic alignment: 7 of 8 Critical feedback items dispatched, 1 deferred without note.** Cross-checking the v1.4.28 feedback Critical list against the diff:

| Feedback ID | Item | Status |
|---|---|---|
| FB-A1 | Retire Mounjaro / GLP-1 dashboard tile | Landed (`8e5f71b1`) |
| FB-A2 | Retire `DrugLevelChart` from dashboard | Landed (folded into `8e5f71b1`) |
| FB-B1 | Workout edit / save error | Partial — `538b44f7` fixes the 409 duplicate-timestamp path which the maintainer's reproduce likely hit, but no commit explicitly cites FB-B1 as the close-out |
| FB-C1 | BD-Zielbereich "1.1." rendering bug | Landed (`59ef95f2`) |
| FB-D1 | General perceived slowness | Partial — `b00be286`, `0d591ac9`, `b0ef80dc`, `d286220b`, `ebf83b1e` are all perf-related; no consolidated perf-summary commit ties them to FB-D1 |
| FB-D2 | `/insights/puls` chart hang | Landed (`b00be286` + `0d591ac9`) |
| FB-J1 | Retire `InsightAdvisorCard` | Landed (`52edf85f`) |
| FB-J2 | Retire "Insights aktualisieren" affordance | Partial — `52edf85f`'s body says "the InsightsTabStrip regenerate icon stays untouched as the sole power-user refresh affordance" which contradicts FB-J2's directive "the whole bottom area collapses" |

FB-J2 is the alignment break. The maintainer asked for the regeneration affordance to retire with the advisor card; the commit body explicitly keeps the tab-strip regenerate icon. This is either a misread of the feedback or a defensible scope-narrowing the maintainer would accept — but the closure report needs to call it out and surface it for v1.4.29 if it's the latter.

### Medium — fix in R5 editorial pass

**P-MED-1 — Voice slip in commit `b00be286` body uses upstream pagination metric "tens of thousands of rows per type per page navigation".** The phrase reads as marketing-leaning ("tens of thousands") where a flat figure ("the row count grew unbounded with no client-side cap") would carry the same information in Marc-Voice. Same shape in `0d591ac9`: "spun for up to 90 s before the user saw the cached fallback" — defensible because the 90 s is the deterministic upper bound (3 retries × 30 s React-Query default backoff + 20 s upstream timeout), but reads dramatic. R5 should soften both phrases when lifting into CHANGELOG bullets.

**P-MED-2 — Commit `cad53a68` body uses "Coach now owns the sole hero-row action" — clean Marc-Voice; flagged here only because R5 should mirror the phrasing in the CHANGELOG headline. Good shape to copy forward.

**P-MED-3 — "Marc-Voice" appears in commit `9a020f21` body as a method-marker (see P-CRIT-1). It also appears in `cad53a68`-adjacent code comments? No — confirmed only the one commit body. Scope of the scrub is bounded to that single commit.

**P-MED-4 — Subject-line voice consistency.** All 30 subjects are well-shaped (terse, English, conventional-commit prefix). One micro-nit: `i18n: add the lastYear coach window key` (`75773ca0`) drops the parenthetical scope where every other commit in the set uses `prefix(scope):`. Recommended: `i18n(coach): add the lastYear window key` for grep symmetry.

### Low — nice-to-have for v1.4.29 kickoff

**P-LOW-1 — Backlog file shape for v1.4.29.** R5 will write `.planning/v1429-backlog.md`. The v1.4.28 backlog (`v1428-backlog.md`) is the right shape to mirror: source-bucket grouping, severity-tagged items, verbatim deferral rationale. The v1.4.27-deferred items that did not land in v1.4.28 (six admin tables CF-77, DateTimeInput rewrite CF-78, RHF migration CF-79, six other CF-8x items, the eight design Mediums M5-M12, simplifier F-H1 / F-M-series, senior-dev MED-3 / MED-4 / drift cleanup) all roll forward to v1.4.29. R5 has the source files; the synthesis is mechanical.

**P-LOW-2 — Closure report should pin which Critical items were partial vs full close (FB-B1, FB-D1, FB-J2 above) so v1.4.29 starts with a clear remaining list.

## Commit-by-commit voice + PII + forbidden-word check

Order chronological (oldest first). "Body" column flags missing-body where >50 LOC commits demand one per v1.4.27 cadence.

| # | Hash | Subject | Body? | Voice | PII | Forbidden | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | 538b44f7 | fix(api): return 409 on duplicate-timestamp measurement edit | yes | clean | clean | clean | OK |
| 2 | b00be286 | perf(charts): bound health-chart fetches to the active range window | yes | "tens of thousands" reads dramatic | clean | clean | OK — P-MED-1 |
| 3 | 0d591ac9 | fix(insights): cap status-card provider calls at 20s with graceful fallback | yes | "spun for up to 90s" reads dramatic | clean | clean | OK — P-MED-1 |
| 4 | ac80c099 | fix(insights): unstick scroll on tab-strip and mother-page navigation | yes | clean | clean | clean | OK |
| 5 | 59ef95f2 | fix(dashboard): align BD-Zielbereich tile with shared TrendCard primitive | yes | clean | **"33-point delta"** | clean | **P-CRIT-4** |
| 6 | 8e5f71b1 | chore(dashboard): retire the GLP-1 tile | yes | clean | clean | clean | OK |
| 7 | cad53a68 | chore(insights): retire the weekly-report surface | yes | clean | clean | **"AI prompt rule" + comment "AI schema slot"** | **P-CRIT-2** |
| 8 | 52edf85f | chore(insights): retire the InsightAdvisorCard surface | yes | clean | clean | clean | OK — but FB-J2 partial (P-HIGH-4) |
| 9 | 8c81af10 | chore(medications): drop the Dosis-Historie disclosure from GLP-1 detail | yes | clean | clean | clean | OK |
| 10 | 8c8d6dc2 | chore(medications): drop the Bestand section from GLP-1 detail | yes | clean | clean | clean | OK |
| 11 | 6f6992c6 | refactor(medications): unify medication-list row shape | yes | clean | clean | clean | OK |
| 12 | 155b529d | fix(insights): match HealthScore card height to the hero column | yes | clean | clean | clean | OK |
| 13 | 4c6d8779 | refactor(coach): consolidate launch button to inline + layout-FAB shape | yes | clean | clean | clean | OK |
| 14 | d286220b | perf(charts): wire chart-skeleton loading state across dynamic imports | **no** | terse-only | clean | clean | P-HIGH-2 |
| 15 | 1b0e81ae | fix(targets): make the coach launch an icon-only affordance | yes | clean | clean | clean | OK |
| 16 | 66e13845 | refactor(coach): narrow launch-scope metric type to the source union | yes | clean | clean | clean | OK |
| 17 | ca381957 | fix(coach): align mobile sheet height to the responsive-sheet convention | yes | clean | clean | clean | OK |
| 18 | 7d38a54d | fix(medications): align side-effects card to the surface convention | yes | clean | clean | clean | OK |
| 19 | 9a020f21 | feat(insights): explain the HealthScore delta on tap | yes | clean | **"Marc asked"; "Marc-Voice read"** | clean | **P-CRIT-1** |
| 20 | 88085615 | fix(medications): shorten side-effects add CTA across locales | yes | clean | clean | clean | OK |
| 21 | 235e52cb | refactor(charts): single HealthChartDynamic re-export | **no** | terse-only | clean | clean | P-HIGH-2 |
| 22 | 8f3bfc37 | refactor(charts): collapse health-chart dynamic imports onto re-export | **no** | terse-only | clean | clean | P-HIGH-2 (small enough to skirt) |
| 23 | 5109e930 | refactor(medications): collapse detail-page chrome to one heading scale | yes | clean | clean | **new "wave-4b" comment** | **P-HIGH-1** |
| 24 | 0e7c97c5 | fix(insights): align briefing empty-state CTA variant | yes | clean | clean | clean | OK |
| 25 | 8c89ddac | refactor(insights): consolidate sub-page data-fetch and empty state | **no** | terse-only | clean | clean | P-HIGH-2 |
| 26 | 8f7cbd49 | fix(insights): document the missing sleep status slot | no body | clean subject | clean | **comment "AI assessment" × 2 + "we render"** | **P-CRIT-3** |
| 27 | b0ef80dc | perf(notifications): cache the dispatch-localised user lookup | **no** | terse-only | clean | clean | P-HIGH-2 |
| 28 | ebf83b1e | feat(perf): wire bundle analyzer and web-vitals beacon | **no** | terse-only | clean | clean | P-HIGH-2 |
| 29 | 75773ca0 | i18n: add the lastYear coach window key | no body | minor scope-tag slip | clean | clean | OK — P-MED-4 |
| 30 | 5570971f | test(targets): update coach CTA assertion to the icon-only shape | yes | clean | clean | clean | OK |

Tally: 30 commits / 4 Critical violations across 4 commits / 1 High forbidden-vocab violation in 1 commit / 6 commits missing the body cadence / 1 strategic alignment partial on FB-J2.

## Locale-string changes audit

Six locale bundles (`messages/{de,en,es,fr,it,pl}.json`) diffed against the kickoff baseline. Net: -546 / +72 lines. Substantial retirement footprint.

**Retired keys (clean closure of scope-reduction directives):**
- `dashboard.glp1.*` — entire block (11 keys × 6 locales = 66 strings) retired with FB-A1 / FB-A2
- `medications.intakeHistoryTitle`, `newIntake`, `editIntake`, `intakeScheduledFor`, `intakeTakenAt`, `intakeStatus`, `intakeSource`, `intakeStatusTaken`, `intakeStatusSkipped`, `intakeStatusMissed`, `intakeDeleteConfirm`, `intakeDeleteDescription`, `intakeCount` — retired with FB-E1
- `medications.glp1DoseHistory`, `glp1DoseHistoryEmpty`, `glp1DoseSince`, `glp1Inventory`, `glp1InventoryLow`, `medications.inventory.*` block — retired with FB-E1 / FB-E2
- `charts.avgAllTimeShort` — retired with the BD-Zielbereich rewrite (FB-C1 / FB-C2)
- `insights.advisorTitle`, `aiOverviewTitle` — retired with FB-J1
- `insights.heroActionWeeklyReport`, `insights.heroBanner.*`, `insights.report.*` block — retired with the weekly-report path retire (FB-H3 / FB-N)

**New keys (additions):**
- `measurements.duplicateTimestamp` — new 409 path message. Marc-Voice clean. Six locales.
- `insights.healthScore.deltaExplainer.{trigger,title,description,body}` — FB-I1 delta tooltip. Body copy ships native in all six locales (no English fallback). Marc-Voice clean. The body sentence is plain, professional, surfaces what the score combines + which window + what action raises it. No forbidden vocab. No PII.
- `insights.coach.window.lastYear` — completes the BK-i18n carry-over item from `v1428-backlog.md`. EN "year so far"; DE/FR/ES/IT/PL native. No forbidden vocab.
- `medications.sideEffects.addCta` — shortened from "Log side effect" to a single verb across all six locales ("Log" / "Erfassen" / "Consigner" / "Registrar" / "Registra" / "Dodaj"). Closes FB-F1.

**Forbidden-vocab scan on additions:** Zero violations in the new locale keys. The two earlier-documented exemptions (`settings.ai.providerOptions.anthropic` + `settings.ai.activeProviderOptions.anthropic`) are not touched in this diff and continue to apply.

**PII scan on additions:** Zero. The delta-explainer body uses generic copy ("BP, weight, mood and meds") without any maintainer-specific values.

**i18n compliance overall:** Clean. The locale changes alone are the cleanest part of the v1.4.28 diff.

## CHANGELOG voice notes for R5

When R5 lifts the 30 commits into a `[1.4.28]` section, lean on this pattern from v1.4.27's opening paragraph:

> Mobile capability + maintainer-finding cleanup. The headline is …

A v1.4.28 opening could read:

> Bug fixes + scope reduction. The headline is six "remove from
> code entirely" deletions across the dashboard, insights and
> medication-detail surfaces — the GLP-1 tile, the dashboard
> DrugLevelChart mount, the InsightAdvisorCard, the weekly-report
> path, and the Dosis-Historie + Bestand sections on the GLP-1
> medication card all retire in one cycle. Four Critical bugs
> close — the duplicate-timestamp 409, the BD-Zielbereich tile
> renumber, the pulse-insights chart hang, and the insights tab-
> strip scroll lock — alongside HealthScore card height parity
> with the hero column, an opt-in delta-explainer popover, a
> consolidated medication-list row shape and a single heading
> scale across the medications detail page. Performance
> instrumentation lands behind a `feat(perf)` commit that wires
> bundle-analyzer + a web-vitals beacon; no premature
> optimisations. iOS contracts untouched.

Use "the maintainer" not "Marc" in any CHANGELOG narrative. The "Marc-Voice" phrase belongs only in `.planning/` and never in shipped artifacts.

## Next-version readiness

State at review time:

- `develop` ahead of `main` by 30 commits + the 25 commits between v1.4.27 tag and the kickoff (the planning-doc lineage)
- `package.json` reads `1.4.27` — version bump pending
- `CHANGELOG.md` has no v1.4.28 section — editorial pending
- `.planning/v1428-fix-plan.md`, `.planning/v1429-backlog.md`, `.planning/round-5-release-closure-report.md` all missing
- Coolify deploy targets unchanged from v1.4.27 (apps01 `pg8wggwogo8c4gc4ks0kk4ss`, edge01 `ck8cs4osswg8w440gskw08w8`)
- iOS contracts intact per spot-check on the iOS-facing endpoints (the commit bodies that touch `/api/*` explicitly call out "iOS contract: additive" or "iOS contract: none")

Items v1.4.29 inherits regardless of this review:

- The v1.4.28 backlog items that did not land (most of `v1428-backlog.md` — six admin tables, DateTimeInput, RHF migration, FB-J2 regenerate-icon question, FB-I1 was the only Medium that closed, all 12 design Mediums M1-M12 with M2 being the only one closed via `0e7c97c5`)
- The closure report's "what landed vs deferred" matrix that this review pre-computed in P-HIGH-4

## Summary + go/no-go on the release tag

**No-go on v1.4.28 tag** until the four Critical findings close. The maintainer name in `9a020f21` is the highest-impact item — once on `develop` pushed to GitHub it is mirrored publicly and the PII directive's spirit ("Marc's name … must NOT appear in commits") is broken. The two forbidden-vocab "AI" mentions and the "33-point delta" health figure are second-tier but each violates a non-negotiable from the kickoff.

Go-path:

1. Decide between `git filter-repo`-based history rewrite on a `release-prep` branch (clean fix; force-push to `develop` requires maintainer sign-off, which the kickoff's "destructive operations" rule defers to the maintainer) versus a follow-up `docs(release): document v1.4.28 commit-body PII scrub` commit that logs the violation in the closure report and tightens the v1.4.29 pre-commit grep gate (recoverable but does not erase the leak).
2. Fix P-CRIT-3 in-place via a new commit that rewrites the sleep-status comment block (file content, not commit history — safe).
3. R5 writes the missing artifacts (CHANGELOG, version bump, closure report, v1429-backlog.md, fix-plan retroactive).
4. R5 PR `develop → main`, squash subject `chore(release): v1.4.28`, tag.

If the maintainer accepts a "log-and-tighten-gates-going-forward" close on P-CRIT-1 and P-CRIT-4 (the PII slips) and a follow-up code-comment scrub commit for P-CRIT-2 and P-CRIT-3 (the vocab slips), v1.4.28 can ship today. The convention violations land in the closure report as known leaks, and the v1.4.29 kickoff inherits a stricter pre-commit grep that prevents recurrence.

If the maintainer holds the line strictly, the four Critical findings demand a history rewrite before the tag — at which point the squash-merge into `main` produces a single clean release commit with the offending bodies pre-scrubbed, and the leaks never reach `main` or the GHCR-published image's git provenance.

The strategic alignment is otherwise strong: every "remove from code entirely" directive landed cleanly, 7 of 8 Critical feedback items dispatched, perf-foundation work (bundle-analyzer, web-vitals beacon, dispatch-cache, payload budgets) sets the stage for v1.4.29 to measure-then-act. The diff is exactly the "less scope, more depth" shape the kickoff asked for. Once the four Critical text-level violations close, the tag is ready.

---

**Five-line summary**

- Severity counts: 5 Critical / 4 High / 4 Medium / 2 Low (15 findings total across 30 commits)
- Top violation: maintainer-name PII leak in commit `9a020f21` body ("FB-I1 — Marc asked …" + "Marc-Voice read")
- Strategic alignment: 7 of 8 Critical feedback items closed; FB-J2 partial (tab-strip regenerate icon kept against the directive); six "remove from code" themes all landed
- Forbidden-vocab leaks: 3 commits ship "AI" / "we" / "wave" in commit body or new code comments; locale strings clean
- **No-go on the v1.4.28 tag** until the four Critical findings close (P-CRIT-1 maintainer name, P-CRIT-2 weekly-report retire vocab, P-CRIT-3 sleep-status comment vocab, P-CRIT-4 health-figure leak) plus P-CRIT-5 release artifacts (package.json bump + CHANGELOG + closure report + v1429-backlog.md)
