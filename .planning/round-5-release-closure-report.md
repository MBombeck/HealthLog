---
file: .planning/round-5-release-closure-report.md
purpose: v1.4.28 release closure report — outcome, scope, verification, follow-ups
created: 2026-05-16
target_tag: v1.4.28
---

# v1.4.28 — release closure

Bug-fix and consistency follow-through after the v1.4.27 mobile sweep.
Eight Critical findings and twelve High findings from the maintainer
post-v1.4.27 walk-through resolved. Six "remove from code entirely"
directives landed as clean delete commits. The HealthScore card,
medications detail page, trends row, and Coach launch shape all
collapse to single contracts per maintainer directive. iOS contracts
intact; the only `/api/*` evolution is additive.

(The v1.4.27 closure report content has been folded into the commit
record at `86a20827`; this file now tracks the v1.4.28 cycle.)

## Outcome

- Tag: **v1.4.28**
- Final develop HEAD before merge: `883d1e2f`
- Squash commit on main: `2d111fcb24a9f820ede87c0a5d6738ce6660f646`
- Live: `healthlog.bombeck.io` + `demo.healthlog.dev` on `1.4.28`
- GitHub release: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.28 (marked latest)
- Tests: 3974 / 3975 passing, 1 skipped (pre-existing visual-regression
  placeholder)
- iOS contracts: byte-stable on the read path; additive
  `aggregate=monthly` grain on `/api/measurements`; new internal-only
  `/api/internal/web-vitals` beacon route (browser consumer only)

## Commits since v1.4.27

47 commits between `v1.4.27` and `v1.4.28` on develop, grouped:

### Bug fixes (R3a)
- `538b44f7` fix(api): return 409 on duplicate-timestamp measurement edit
- `b00be286` perf(charts): bound health-chart fetches to the active range window
- `0d591ac9` fix(insights): cap status-card provider calls at 20s with graceful fallback
- `ac80c099` fix(insights): unstick scroll on tab-strip and mother-page navigation
- `59ef95f2` fix(dashboard): align BD-Zielbereich tile with shared TrendCard primitive

### Scope reductions (R3b)
- `8e5f71b1` chore(dashboard): retire the GLP-1 tile
- `cad53a68` chore(insights): retire the weekly-report surface
- `52edf85f` chore(insights): retire the InsightAdvisorCard surface
- `8c81af10` chore(medications): drop the Dosis-Historie disclosure from GLP-1 detail
- `8c8d6dc2` chore(medications): drop the Bestand section from GLP-1 detail

### Consistency contracts (R3c)
- `6f6992c6` refactor(medications): unify medication-list row shape
- `7d38a54d` fix(medications): align side-effects card to the surface convention
- `88085615` fix(medications): shorten side-effects add CTA across locales
- `5109e930` refactor(medications): collapse detail-page chrome to one heading scale
- `155b529d` fix(insights): match HealthScore card height to the hero column
- `9a020f21` feat(insights): explain the HealthScore delta on tap
- `0e7c97c5` fix(insights): align briefing empty-state CTA variant (carries the trends-row contract)
- `4c6d8779` refactor(coach): consolidate launch button to inline + layout-FAB shape
- `1b0e81ae` fix(targets): make the coach launch an icon-only affordance
- `66e13845` refactor(coach): narrow launch-scope metric type to the source union
- `ca381957` fix(coach): align mobile sheet height to the responsive-sheet convention
- `235e52cb` refactor(charts): single HealthChartDynamic re-export (carries the MobileRailTray carve-out)
- `97680663` refactor(coach): unify launch glyph and propagate medication row shape

### Performance + simplification (R3d)
- `d286220b` perf(charts): wire chart-skeleton loading state across dynamic imports
- `8f3bfc37` refactor(charts): collapse health-chart dynamic imports onto re-export
- `8c89ddac` refactor(insights): consolidate sub-page data-fetch and empty state
- `8f7cbd49` fix(insights): document the missing sleep status slot
- `b0ef80dc` perf(notifications): cache the dispatch-localised user lookup
- `ebf83b1e` feat(perf): wire bundle analyzer and web-vitals beacon
- `75773ca0` i18n: add the lastYear coach window key

### R4 reconcile (correctness + a11y + hygiene)
- `5570971f` test(targets): update coach CTA assertion to the icon-only shape
- `0d256230` fix(api): aggregate measurements before applying the take limit
- `8144281d` fix(charts): keep all-time charts full-history via monthly aggregation
- `1920a763` fix(api): rate-limit and validate the web-vitals beacon
- `f91b4732` test(api): cover workout-edit duplicate-timestamp via measurements
- `cf8e7022` i18n: translate duplicate-timestamp and sleep description in fr/es/it/pl
- `b3f88026` fix(a11y): lift new icon buttons to the 44 px tap-target floor
- `025c8885` fix(a11y): wire the HealthScore delta explainer for screen readers
- `d8229c26` fix(insights): drop the residual border on the mood trend tile
- `786fbde6` fix(responsive): align medication-row and side-effects at narrow viewports
- `e5cb74b4` refactor(medications): lift DrugLevelChart onto MedicationDetailSection
- `29e9f958` refactor(charts): finish HealthChartDynamic migration on trends row
- `d46d0e7e` fix(medications): align detail-page spacing ladder
- `f0e3e055` chore(comments): scrub forbidden vocabulary from v1.4.28 code comments
- `b74851f9` chore(comments): scrub the health-figure example from the BD-tile note

### R5 release
- `ff4bfcfc` chore(release): v1.4.28
- `1b739eed` chore(merge): reconcile main into develop for v1.4.28 release

## What landed

Every Critical from the v1.4.28 feedback (FB-A1, FB-A2, FB-B1, FB-C1,
FB-D1, FB-D2, FB-J1, FB-J2) closed:

| ID | Item | Commit |
|---|---|---|
| FB-A1 | Retire the Mounjaro / GLP-1 dashboard tile | `8e5f71b1` |
| FB-A2 | Retire the `<DrugLevelChart>` dashboard mount | `8e5f71b1`, `e5cb74b4` |
| FB-B1 | Workout edit duplicate-timestamp 409 | `538b44f7`, `f91b4732` |
| FB-C1 | BD-Zielbereich tile renders numbers, not "1.1." | `59ef95f2` |
| FB-D1 | Performance baseline + improvements | `b00be286`, `d286220b`, `b0ef80dc`, `ebf83b1e` |
| FB-D2 | `/insights/puls` chart timeout fallback | `0d591ac9` |
| FB-J1 | Retire the `<InsightAdvisorCard>` surface | `52edf85f` |
| FB-J2 | Retire the "Insights aktualisieren" regeneration affordance | `52edf85f` |

Every High closed:

| ID | Item | Commit |
|---|---|---|
| FB-C2 | BD-Zielbereich tile parity with TrendCard | `59ef95f2` |
| FB-D3 | Scroll stuck on `/insights` tab-strip | `ac80c099` |
| FB-E1 | Retire the "Dosis-Historie" disclosure | `8c81af10` |
| FB-E2 | Retire the "Bestand" section | `8c8d6dc2` |
| FB-F1 | Side-effects CTA overflow | `7d38a54d`, `88085615`, `786fbde6` |
| FB-F3 | Medications detail page chrome unified | `5109e930` |
| FB-G1 | Medication-list row shape unified | `6f6992c6`, `97680663`, `786fbde6` |
| FB-H1 | HealthScore card height | `155b529d` |
| FB-H2 | HealthScore equal-height row contract | `155b529d` |
| FB-H3 | "Wochenbericht erstellen" button retired | `cad53a68` |
| FB-K1 | Trends row vertical alignment | `0e7c97c5`, `d8229c26` |
| FB-K2 | Trends row equal-height contract | `0e7c97c5`, `29e9f958` |

Every Medium that was in-scope closed:

| ID | Item | Commit |
|---|---|---|
| FB-F2 | Side-effects date-slot alignment | `5109e930`, `786fbde6` |
| FB-F4 | Medications detail page font scale | `5109e930` |
| FB-I1 | HealthScore "vs last week" delta explainer | `9a020f21`, `025c8885`, `b3f88026` |
| FB-L1 | Targets page Coach launch icon-only | `1b0e81ae`, `97680663` |
| FB-N | Weekly-report route retired | `cad53a68` |

## What deferred to v1.4.29

See `.planning/v1429-backlog.md`. Headline items:

- SD-H1 client wire-up (server machinery is in; client adapter pending)
- 11 dead-code orphans
- 5 simplifier Mediums + 8 design Mediums + 4 UI-conformity Mediums +
  7 senior-dev Mediums + 5 i18n Mediums
- Carry-forward set (CF-77 admin card-list fallback, the
  `<SectionCard>` primitive carve-out, the 18 Loader2 vocabulary
  sweep, etc.)

## Live-environment verification

| Surface | Expected | Actual | Status |
|---|---|---|---|
| `healthlog.bombeck.io/api/version` `version` | `"1.4.28"` | `"1.4.28"` | pass |
| `healthlog.bombeck.io/privacy` HTTP status | 200 | 200 | pass |
| `demo.healthlog.dev/api/version` `version` | `"1.4.28"` | `"1.4.28"` | pass |
| `demo.healthlog.dev/privacy` HTTP status | 200 | 200 | pass |

`offlineGeoEnabled: false` on both nodes — the v1.4.27 resilience layer
fired during the multi-arch build (the GeoLite2 fetch step emitted the
`.empty` marker, the runtime fell back to `ipwho.is` cleanly, and the
public version endpoint surfaces the flag). The fallback is the
documented behaviour; no regression.

## Known issues + follow-ups

- **Two mislabelled commits on develop.** `235e52cb` (actual content:
  `<MobileRailTray>` carve-out) and `0e7c97c5` (actual content:
  trends-row equal-height contract). Functional changes shipped under
  the wrong subject lines. The v1.4.28 squash on main carries the
  canonical headline so main's history is clean.

- **Two commit-body residues on develop.** `9a020f21` (maintainer's
  first name in the body) and `f0e3e055` (one instance of forbidden
  vocabulary while documenting the scrub itself). The v1.4.28 squash
  on main strips both — develop's history retains them.

- **SD-H1 client adapter.** The "All time" tab still defaults to a
  365-day window with no `aggregate` param; the server-side machinery
  is in place. Four-line client edit deferred to v1.4.29 with a small
  adapter to reconcile bucketed vs raw response shapes.

## Sister-repo bumps

- `healthlog-docs` — commit `8bc5ded` (`docs: bump image pins to
  v1.4.28`). Two files updated:
  `src/content/docs/self-hosting/scaling.mdx` (2 image pins) and
  `src/content/docs/self-hosting/updates.mdx` (1 pin). Pushed.
- `healthlog-landing` — commit `a159109` (`feat(seo): bump
  softwareVersion JSON-LD to 1.4.28`). One file updated:
  `src/app/layout.tsx`. Pushed.

## Forbidden-vocab check

`git log v1.4.27..HEAD --pretty=%s%n%b` over the 47 v1.4.28 commits:
two body residues noted above; commit subject lines all clean. The
CHANGELOG section, the GitHub release notes, the sister-repo bumps,
and the squash commit on main are all clean.
