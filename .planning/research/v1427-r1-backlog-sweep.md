---
file: .planning/research/v1427-r1-backlog-sweep.md
purpose: R1.6 — v1.4.26 backlog triage for v1.4.27 inclusion
created: 2026-05-15
predecessor: .planning/v1426-backlog.md
companion: .planning/phase-W21-reconcile-plan.md (defer matrix lines 220-279)
---

# v1.4.27 R1.6 — backlog sweep

The v1.4.26 release shipped as a small hotfix that contained only the
privacy-policy page. Every backlog item the v1.4.25 marathon parked
under `.planning/v1426-backlog.md` is therefore still open — plus the
17 Medium-deferred entries from the W21 reconcile defer matrix and the
40 Low-deferred entries from the same plan.

Each entry below was verified against `develop @ c74a0c98`. Items that
were quietly closed by post-tag fixes (`v1.4.25..HEAD` = 47 commits)
are routed to the Rejected section with the resolving commit named.

## Summary

- Total items reviewed: **48** (16 from `v1426-backlog.md` after collapsing nested R1-R16/S1-S15 sub-entries, 17 Medium-deferred from W21 reconcile, 15 Low-deferred from W21 reconcile)
- Pulled into v1.4.27: **17**
- Deferred to v1.4.28: **20**
- Rejected as resolved or stale: **11**

---

## Pulled-into-v1.4.27 items

### Item — P1-1: 414 dead i18n keys cleanup
- Source: `.planning/v1426-backlog.md` line 27
- Why pull: W9e race risk closed (no concurrent locale-bundle edits planned in v1.4.27 fix-surfaces). Drops ~414 keys × 6 locales = ~2.5k strings from every client bundle. Catches dead-M8 (132 `insights.*Status*` strings, line 264) in the same pass.
- Touch surface: `messages/{de,en,fr,es,it,pl}.json`, locale-integrity test fixtures
- LOC estimate: -2 500 / +0 (deletions only); one-line test threshold update.
- Risk: low. Locale-integrity test fails on one-sided touches; spot-check `classifications.alerts.*` + `targets.*` survives the pass.

### Item — P1-2: `BASE_SYSTEM_PROMPT` / `INSIGHTS_SYSTEM_PROMPT` removal
- Source: `.planning/v1426-backlog.md` line 30
- Why pull: zero consumers verified (`grep` returns only locale-suffixed forms `_DE` / `_EN`). The bare symbols + `@deprecated` markers can drop in one commit.
- Touch surface: `src/lib/ai/prompts/base-system.ts`, `src/lib/insights/prompt.ts`, plus the matching test fixtures.
- LOC estimate: -20 / +0.
- Risk: trivial.

### Item — P1-3: W7d hardening
- Source: `.planning/v1426-backlog.md` line 33
- Why pull: `safeRequestProp` still catches-all (`src/lib/api-handler.ts:73-87`); two-line narrow plus a `console.warn` on every fallback. Co-locates with the `globals.css` `@source` path fix.
- Touch surface: `src/lib/api-handler.ts`, `src/app/globals.css`.
- LOC estimate: +15 / -8.
- Risk: low. Existing telemetry catches misfires.

### Item — P1-4: Cat-C stale-comment typo
- Source: `.planning/v1426-backlog.md` line 36
- Why pull: confirmed still present at `src/app/api/insights/targets/route.ts:807` — stray brace + half-quoted reference to a deleted route. Trivial.
- Touch surface: one file, one line.
- LOC estimate: -1 / +1.
- Risk: nil.

### Item — P2-3: Workout cross-source dedup
- Source: `.planning/v1426-backlog.md` line 49
- Why pull: `src/lib/sources/pick-canonical-workout.ts` already exists with a `pickCanonicalWorkout()` companion (verified line 126). Wiring the canonical-picker into the workout read path closes the M-3 TODO without waiting for observable dupes.
- Touch surface: `src/lib/sources/pick-canonical-workout.ts` (already present), the workouts list/read route, regression test for MANUAL + HK dupes.
- LOC estimate: +60 / -10 (wiring + test).
- Risk: low. Test surface bounded.

### Item — P3-2: Withings Sleep v2 routine — REFRAMED
- Source: `.planning/v1426-backlog.md` line 65
- Why pull: `syncUserSleep` already shipped (W17b/c). Backlog entry is now stale framing; the actionable remainder is the 403 scope-skip hardening's twin (`syncUserActivity` shipped 2026-05-14 at `fec02aa5`). Cover with parity test cleanup + i18n suffix on the reauth banner.
- Touch surface: `src/lib/withings/sync-sleep.ts` (verify scope-guard parity), parity test.
- LOC estimate: +30 / -5.
- Risk: low. The 403 hotfix already landed.

### Item — P4-2: Chart-x-axis-tick timezone audit
- Source: `.planning/v1426-backlog.md` line 78
- Why pull: cosmetic axis-label shift; `sleep-stage-stacked-bar.tsx:117` builds `new Date(y, m-1, d)` in SSR-server tz. Single-pass audit across chart tick helpers.
- Touch surface: `src/components/insights/sleep-stage-stacked-bar.tsx` + 4-6 sibling chart files.
- LOC estimate: +25 / -25 (replacements).
- Risk: low. Visual diff bounded.

### Item — P4-5: `__testables.WEEKDAY_KEYS` cleanup
- Source: `.planning/v1426-backlog.md` line 87
- Why pull: confirmed exported, zero consumers (`src/lib/ai/coach/glp1-snapshot.ts:72,415,420`). Trivial.
- Touch surface: one file, two lines.
- LOC estimate: -5.
- Risk: nil.

### Item — P4-6: `/api/audit-log` surface decision
- Source: `.planning/v1426-backlog.md` line 90
- Why pull: endpoint exists (`src/app/api/audit-log/route.ts:13`), zero UI consumer. v1.4.27 is the polishing release before iOS — clean dead surfaces before they ship in the OpenAPI spec.
- Touch surface: either the new settings page or delete the route + DTO + test fixture.
- LOC estimate: depending on direction; either side ≤ 80 LOC.
- Risk: low.

### Item — P4-8: i18n drift-guard for PR + Workout strings
- Source: `.planning/v1426-backlog.md` line 96
- Why pull: pairs naturally with P1-1 dead-key cleanup. Adds a single drift-guard assertion so newly-introduced PR/Workout strings stay in lockstep across six locales.
- Touch surface: `src/__tests__/i18n-drift-guard.test.ts` (or co-locate with locale-integrity).
- LOC estimate: +40.
- Risk: nil. Test-only.

### Item — P4-9: Design M7 + L1-L4 polish
- Source: `.planning/v1426-backlog.md` line 99
- Why pull: bounded polish surface. M7 (medication-form Dialog inline-control sweep), L1 (`motion-reduce:animate-none` consistency), L2 (Health Score disclaimer 10 px borderline), L3 (`<details>` `aria-controls`), L4 (therapy-timeline `<h4 class="sr-only">`). Co-locates with the v1.4.27 finding-13 symmetry audit.
- Touch surface: 6-8 component files.
- LOC estimate: +30 / -10.
- Risk: low.

### Item — P4-11 S1 / S10: simplifier apply-with-care
- Source: `.planning/v1426-backlog.md` line 105 + 108
- Why pull: **S1** (`metricPriorityObjectSchema` derive from `SOURCE_PRIORITY_METRIC_KEYS`) bounds a class of future drift. **S10** (shared `allMessages` + `resolveKey` between `lib/i18n/context.tsx` and `lib/i18n/server-translator.ts`) — already verified duplicated identically; extract into a shared file. S3 (reorderLadder) and S12 (useInsightStatus) and S9 (ContributingSource) already landed pre-tag — see Rejected section.
- Touch surface: `src/lib/validations/source-priority.ts`, `src/lib/i18n/{context.tsx,server-translator.ts,shared-resolve.ts}` (new).
- LOC estimate: +60 / -50 (net wash; eliminates 25 LOC of duplication).
- Risk: low. Both surfaces have unit coverage.

### Item — P6-4: Coach `lastYear` window option
- Source: `.planning/v1426-backlog.md` line 142
- Why pull: W5 left the slot open; W7b timezone work settled. Enum extension + snapshot mapping is < 80 LOC including tests.
- Touch surface: `src/lib/ai/coach/types.ts`, `src/lib/ai/coach/snapshot.ts`, snapshot test.
- LOC estimate: +60 / -5.
- Risk: low.

### Item — P6-7: Locale-native date format ordering
- Source: `.planning/v1426-backlog.md` line 151
- Why pull: trivial. `format.dateShort` / `timeShort` / `dateTime` in `messages/{fr,es,it,pl}.json` swap to native ordering. Per locale: FR/ES/IT `{day}/{month}/{year}`; PL `{day}.{month}.{year}`.
- Touch surface: 4 JSON files, 3 keys each.
- LOC estimate: -12 / +12.
- Risk: nil.

### Item — P6-11: Mood verbal labels follow-up
- Source: `.planning/v1426-backlog.md` line 163
- Why pull: small carry-over from v1.4.25 polishing pass; co-locates with the symmetry audit in finding-13. `MOOD_LABEL_KEYS` already shipped (`src/components/mood/mood-list.tsx:75`), follow-up is i18n key audit + chart-label consistency.
- Touch surface: `src/components/charts/mood-chart.tsx`, `src/components/mood/mood-list.tsx`, locale bundles.
- LOC estimate: +20 / -10.
- Risk: low.

### Item — code-M3 (W21 defer): manual-workout route attach uses serial `findFirst`
- Source: `.planning/phase-W21-reconcile-plan.md` line 241
- Why pull: contract correctness for the workout-attach route. Even if no UI consumer exists today, the OpenAPI surface ships with v1.4.27 and the route is published as part of the iOS handshake foundation (finding-25). Single `findMany` collapses N round-trips.
- Touch surface: `src/app/api/workouts/[id]/route.ts` (or wherever the attach route lives).
- LOC estimate: +25 / -15.
- Risk: low.

### Item — simp-M10 / dead-M6: `glp1-pk.ts` unused exports (`shotPhaseAt` et al.)
- Source: `.planning/phase-W21-reconcile-plan.md` line 256, 261
- Why pull: maintainer decision was the gate. `shotPhaseAt` exists at `src/lib/medications/glp1-pk.ts:303`; the v1.4.27 GLP-1 dashboard tile work (finding-1, drug-level chart as secondary tile) will wire it. Treat as "internalise vs wire" → wire into the dashboard tile per finding-1 + GLP-1 R7 plan.
- Touch surface: `src/components/dashboard/glp1-card.tsx` (or equivalent), `src/lib/medications/glp1-pk.ts`.
- LOC estimate: +30 / -5.
- Risk: medium. Dashboard surface touched by finding-1 in parallel — coordinate via Round 2 file-touch matrix.

---

## Deferred-to-v1.4.28 items

| Item | Source (`v1426-backlog.md` or W21) | Why defer | Blocked-by |
|---|---|---|---|
| P0-1 OpenAPI drift-gate hard-fail flip | `v1426` line 14 | RESOLVED — see Rejected. | n/a |
| P0-2 Onboarding rebuild (M-L) | `v1426` line 17 | Multi-day effort. Marc-promoted from v1.5 but v1.4.27 is the QoS-pass release, not the onboarding-rebuild release. Park for v1.4.28 (post-iOS-foundation pass). | iOS native client handshake research (finding-25) lands first so onboarding can branch on "iOS-paired" vs "web-only" |
| P0-3 Native FR/ES/IT/PL Coach prompts (M per locale) | `v1426` line 20 | 4× ~500 LOC system prompts each requiring safety-contract re-validation. Out of QoS-pass scope. | translation hand-review (P6-9) ideally lands first so the native bodies do not duplicate translation drift |
| P2-1 Personal-record detection worker (sweep-on-insert + nightly cron) | `v1426` line 43 | Worker file exists at `src/lib/personal-records/pr-detection-worker.ts`; pg-boss queue lives. The remaining ask is sweep-on-insert + cron registration. Discuss-first: cron cadence + back-pressure policy. | finding-25 (iOS handshake) — back-pressure expectations differ once a fleet of native clients writes concurrently |
| P2-2 Workout ingest endpoint | `v1426` line 46 | RESOLVED — see Rejected. | n/a |
| P2-4 iOS-18 long-tail HK identifier mappings (M per wave) | `v1426` line 52 | The `HK_QUANTITY_TYPE_DEFERRED` set ships per-wave; v1.4.27 is the QoS-pass release, not an HK-coverage release. Next wave queued for v1.4.28 or whichever release pairs with the iOS app's first beta. | iOS Swift client release cadence |
| P2-5 VO2 max chart-row card | `v1426` line 55 | RESOLVED — see Rejected. | n/a |
| P3-1 Withings Activity sync routine | `v1426` line 62 | RESOLVED — see Rejected. | n/a |
| P4-1 Lazy-loaded locale JSON bundles (M) | `v1426` line 75 | Code-shape change; touches `src/lib/i18n/context.tsx:15-29` synchronous imports + hydration-flash mitigation. Risk + design pass before v1.4.28. | none, but pairs with onboarding rebuild (P0-2) since onboarding first-paint dominates the perceived hit |
| P4-4 `detectGlp1Plateau` direct test coverage | `v1426` line 84 | RESOLVED — see Rejected. | n/a |
| P4-7 `Measurement.deviceType` enum vs TEXT | `v1426` line 93 | Migration risk. v1.5 cleanup-pass note already in backlog; v1.4.27 keeps zero new migrations unless required. | v1.5 schema-cleanup pass |
| P4-12 simplifier discuss-first (S11/S14/S15) | `v1426` line 113 | All three require explicit maintainer decision (SSR-mismatch guard preserve, single-row fast-path drop, prisma guard removal). Discuss-first; not engineering. | maintainer decision per item |
| P5 GLP-1 component-test polish + `medication_schedules` consumer scrub | `v1426` line 125-126 | Integration tests for plateau-detection + therapy timeline + the `windowStart`/`windowEnd` consumer audit. Larger than QoS-pass touch. | none |
| P6-2 Sentinel parser observability for HealthKit envelopes | `v1426` line 136 | Pairs with PROMPT_VERSION 5.0.0 cut on the P3 schedule; not v1.4.27. | none |
| P6-3 Coolify auto-deploy maintainer toggle | `v1426` line 139 | The `vars.COOLIFY_AUTO_DEPLOY` toggle landed in v1.4.25 W11a (verified in `docker-publish.yml:251`). The remainder is operational (set the GitHub variable + secrets), not engineering. | maintainer action |
| P6-5 Coach prefill on health-score row tap | `v1426` line 145 | Callback plumbing through the hero strip. Health-score work in finding-8 (Health-Score card filling hero column) touches the same component; defer to v1.4.28 to avoid the collision. | finding-8 first |
| P6-6 Per-night sleep-stage stacked column chart (M) | `v1426` line 148 | New server endpoint required. Out of QoS-pass scope. | new analytics endpoint design pass |
| P6-9 Hand-review FR/ES/IT/PL prose on high-traffic surfaces (L per locale) | `v1426` line 157 | Translation-author work; outside engineering scope. Maintainership banner already discloses the structural-coverage state. | translator contributions (W21 i18n-M1) |
| P6-10 Cat-B endpoint triage (17 endpoints) | `v1426` line 160 | dead-M1/M2/M3/M4 below all cover subsets of this. v1.4.27 picks P4-6 (`/api/audit-log`) only; the rest park. | maintainer go/no-go per endpoint |
| simp-M2 (W21): three near-identical `async function advance()` | W21 line 248 | LOC > 50 across three callers; hook-extraction merits its own design pass. The three callers are settings-page sub-components Fix-L already touched at v1.4.25 tag — collision risk re-emerges if re-entered too soon. | design pass first |
| dead-M1/M2/M3/M4: orphan admin + monitoring endpoints | W21 line 257-260 | Five endpoints (`/api/admin/ai-settings`, `/api/admin/backup/test`, `/api/admin/status-overview`, `/api/monitoring/glitchtip/test`, `/api/monitoring/umami/test`) require maintainer decision per endpoint. Group into a v1.4.28 endpoint-triage commit. | maintainer go/no-go memo |
| dead-M5: `glp1-knowledge.ts` unused exports (10 symbols) | W21 line 261 | Module-surface narrowing; co-locates with the M5/M6/M7 cleanup phase. simp-M10/dead-M6 (`glp1-pk.ts`) ships in v1.4.27 via finding-1 wiring; the knowledge-layer narrowing follows. | finding-1 drug-level wiring (R3 of v1.4.27) |
| dead-M7: scheduling cadence + compliance unused type/helper exports | W21 line 263 | Module-surface narrowing; bundle with dead-M5. | none |
| simp-M6, simp-M7 (W21 Low-defer): pairDoses double-sort, escalationDue rename | W21 line 252-253 | Both already routed to v1.4.27 per the W21 reconcile defer matrix, but they are micro-polish / JSDoc-only — defer one more cycle in favour of the v1.4.27 fix-surface budget. Park for v1.4.28. | none |

---

## Rejected-as-resolved items

| Item | Source | What resolved it |
|---|---|---|
| P0-1 OpenAPI drift-gate hard-fail flip | `v1426` line 14 | Verified flipped in `.github/workflows/security.yml:44` — comment reads "hard-fail (flipped from warn-only in v1.4.25)". The hard-fail is live. Registry coverage completion remains a slow rollout but the gate itself is done. |
| P2-2 Workout ingest endpoint | `v1426` line 46 | Shipped pre-tag at `src/app/api/workouts/batch/route.ts` (`POST /api/workouts/batch`). Full test suite at `src/app/api/workouts/__tests__/batch-create.test.ts`. v1.4.25 W16b. |
| P2-5 VO2 max chart-row card | `v1426` line 55 | Shipped pre-tag at `src/app/insights/puls/page.tsx:65-121` ("v1.4.25 W16a — VO2 max chart-row consumes the same `/api/analytics`"). |
| P3-1 Withings Activity sync routine | `v1426` line 62 | `syncUserActivity()` shipped at `src/lib/withings/sync-activity.ts:192`, plus the 2026-05-14 403-scope-skip hardening (`fec02aa5`). Reconnect banner shipped W5d. The full sync routine is live. |
| P3-3 Withings webhook secret moved out of query string | `v1426` line 68 | Shipped pre-tag via W17a path-segment move (`src/lib/withings/sync.ts:25-47`). The header-form framing in the backlog was stale; path-segment + Fix-J `PATH_SECRET_PATHS` redaction closes the same hole. |
| P4-3 `coach.batch.too_large` errorCode rename | `v1426` line 81 | Verified `src/app/api/measurements/batch/route.ts:140` emits `measurement.batch.too_large` already. |
| P4-4 `detectGlp1Plateau` direct test coverage | `v1426` line 84 | Verified `src/lib/insights/__tests__/glp1-plateau.test.ts` exists with 8+ test cases covering window arithmetic, `meds[0]` pick, threshold comparison, plus security and timezone regressions. |
| P4-10 Pre-existing `hsl(var(--border))` anti-pattern | `v1426` line 102 | Verified zero remaining `hsl(...)` calls in `mood-chart.tsx` + `scatter-correlation-chart.tsx`. Cleaned during the Dracula-token sweep. |
| P4-11 S3 — `reorderLadder<T>()` helper | `v1426` line 106 | Verified at `src/components/settings/sources-section.tsx:183` ("the previous moveSource + moveDeviceType pair drifted apart twice"). Helper extracted and consumed by both movers. |
| P4-11 S9 — shared `ContributingSource` union | `v1426` line 107 | Verified at `src/lib/analytics/health-score.ts:52` as `export type ContributingSource` consumed by `src/app/api/analytics/route.ts` and the dashboard. |
| P4-11 S12 — `useInsightStatus(metricSlug)` hook | `v1426` line 109 | Verified at `src/hooks/use-insight-status.ts`; consumed by 10 insight sub-pages (BMI, Stimmung, Blutdruck, Schlaf, Puls, Gewicht, Medikamente, etc.). |
| P6-1 Pearson incomplete-beta replacement | `v1426` line 132 | Verified at `src/lib/insights/correlations.ts:166-178` ("v1.4.26 P6-1 — replaced the normal-approx fallback with a rigorous regularised-incomplete-beta evaluation"). Shipped at commit `c80e0a08` per the post-v1.4.25 log. |
| P6-8 GitHub translation-feedback issue template | `v1426` line 153 | Verified at `.github/ISSUE_TEMPLATE/translation.yml`; banner link at `src/components/i18n/maintainership-banner.tsx:42` resolves correctly. |
| product-lead-M2 (W21): `User.onboardingGoals` column | W21 line 232 | Rejected from v1.4.27 with no resolution — Marc decision deferred; the storage block was dropped in Fix-L (`code-M4` / `simp-M9`). The column itself was never added. Reframe as part of the v1.4.28 onboarding-rebuild surface (P0-2). |
| product-lead-M3 (W21): W11a multi-arch lowercase fix | W21 line 233 | Operational note, already resolved in Fix-H + W20-rest. The `vars.COOLIFY_AUTO_DEPLOY` toggle is the surfaced switch. No code action remains. |
| product-lead-M4 (W21): Session-1 W12/W13 deliverables | W21 line 234 | Operational, not engineering. Maintainer-driven post-tag list. Closed at v1.4.25 tag. |

---

## Round-2 coordination notes

1. **finding-1 (GLP-1 drug-level tile)** and **simp-M10 wiring** touch the same dashboard component. Coordinate via Round 2 file-touch matrix; ideally one contributor owns both.
2. **finding-13 (symmetry audit)** overlaps with **P4-9 design polish** and **P6-11 mood verbal labels** on shared component files. Bundle into one fix-surface so the symmetry pass and the polish items land together.
3. **P1-1 dead i18n keys** must run before **P4-8 i18n drift-guard** — drift-guard asserts the new shape, so the cleanup needs to land first to avoid a chicken-and-egg test failure.
4. **simp-H1 readError**, **simp-H6 assertMedicationOwnership**, and the medication-detail wrapper extraction all shipped pre-tag in v1.4.25 W21 reconcile; do NOT re-litigate.
5. **P0-3 native Coach prompts** is deliberately not pulled. The v1.4.27 budget is a QoS-pass, not a prompt-system rewrite. The maintainership banner already discloses the structural-coverage state to FR/ES/IT/PL users.

## Open uncertainties

- **P4-6 `/api/audit-log` direction** — maintainer call needed: wire `/settings/audit-log` page (≤ 80 LOC) or delete the route. Either side ships clean; pick before Round 2.
- **P0-3 native prompts** — would benefit from a Round 1.6 follow-up commissioning a translation-side dry-run before engineering touches the system prompt. Out of v1.4.27 by maintainer directive; surfaced here so the v1.4.28 backlog inherits the framing rather than the stale v1426 wording.
