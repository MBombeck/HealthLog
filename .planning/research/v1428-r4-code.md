---
file: .planning/research/v1428-r4-code.md
purpose: R4 code review of the v1.4.28 diff vs v1.4.27 — 30 commits, severity-grouped findings
created: 2026-05-16
contributor: R4 code-review
---

# v1.4.28 R4 — code review

Scope: 30 commits `948fcd93..HEAD` on `develop` (post-kickoff). Bug-fix sub-pass (FB-B1/C1/D2/D3), six retirements, consistency sweep, perf instrumentation. Review is read-only; findings are sorted by severity with a fix-shape suggestion per item.

## Critical

### R4-CODE-C1 — Aggregated `/api/measurements` truncates before bucketing
File: `src/app/api/measurements/route.ts:67-86` (commit `b00be286`)
The aggregation branch fetches `prisma.measurement.findMany({ take: limit, orderBy: { measuredAt: "asc" } })` then bucketises in memory. With `orderBy asc` the server returns the earliest `limit` rows in the window — for a Pulse-every-minute account selecting a 365-day window with `limit=5000`, only ~3.5 days of raw data feed the aggregator and the chart paints 3 daily buckets instead of 365. The whole point of FB-D2 is high-density data; the aggregation defeats itself on the exact accounts it targets.
Fix shape: drop `take`/`skip` from the aggregation branch (the bucket count is already bounded by the window length, never exceeds ~52 weekly or ~365 daily rows per type), or push aggregation into SQL via `date_trunc` + `GROUP BY`. Add a regression test that seeds 30 000 rows across a 365-day window and asserts the response bucket count equals the calendar-day count, not `min(limit, count)/grain`.

### R4-CODE-C2 — Aggregation auto-triggers on any wide window, breaking the documented iOS contract
File: `src/app/api/measurements/route.ts:56` + `src/lib/measurements/range-aggregation.ts:44-46` (commit `b00be286`)
The commit message asserts the aggregated branch fires only when "from + to are present AND the window is wide enough" — but the implementation fires on `from && to && pickAggregateGrain(...) !== "raw"`, and `pickAggregateGrain` auto-promotes to `daily` past 90 days even without an explicit `aggregate` param. iOS currently calls `/api/measurements?limit=400` without `from`/`to` and stays safe, but a future iOS update that adds date filtering for a > 90-day drill-down silently receives the aggregated wire shape (`{ type, value, measuredAt, count }`) instead of the locked `MeasurementWireDTO`. The `.planning/v15-ios-handoff/08-locked-contracts.md` shape for `GET /api/measurements` is `Measurement[]` with full row fields.
Fix shape: gate the aggregation branch on `aggregate !== undefined` (caller must opt in explicitly); keep the auto-grain promotion as a hint the chart applies client-side. Add an integration test that asserts `/api/measurements?from=…&to=…` without `aggregate` still returns the raw DTO shape regardless of window width.

### R4-CODE-C3 — Web-vitals beacon is an unauthenticated log-injection vector
File: `src/app/api/internal/web-vitals/route.ts:45-76` + `src/components/monitoring/web-vitals-reporter.tsx:21-49` (commit `ebf83b1e`)
The route accepts unauthenticated POSTs of arbitrary `{ name, value, rating, navigationType }` and forwards `name`/`rating`/`navigationType` strings verbatim into `annotate({ meta })`. The header comment claims "CSP + same-origin policy keep cross-site reporting out" — neither does. `sendBeacon` issues a simple POST with no CORS preflight; any external page can flood `/api/internal/web-vitals` with custom `name` payloads and pollute the wide-event log. There's also no rate limit ("deliberately none") and the route is publicly indexable.
Fix shape: restrict `name` to the documented web-vitals identifier set (`CLS|FCP|FID|LCP|TTFB|INP`); reject unknown names early; clamp `value` to a sane numeric range; add a session-cookie check or a same-origin Referer guard at the route boundary. Web Vitals don't need auth on a logged-in user — but they do need an attestation that the caller came from a HealthLog page.

## High

### R4-CODE-H1 — Mislabelled commit `0e7c97c5` bundles FB-K trend-row work under a CTA-variant subject
File: commit `0e7c97c5` body vs diff
The subject claims "align briefing empty-state CTA variant" and the body only describes the daily-briefing CTA. The diff actually rewrites `trends-row.tsx` (FB-K1/K2 equal-height contract), `mood-chart.tsx`, `trend-annotation.tsx` and two new test files — six files, 130 net additions. Atomic-commit hygiene violation; reviewers cannot bisect the FB-K contract from the FB-M2 CTA fix; future `git log -- trends-row.tsx` will mislead.
Fix shape: leave as-is for v1.4.28 (rewriting history before tag is destructive) but add a `Note: also lands FB-K1/K2 trend-row equal-height contract` postscript in the release notes; pin atomic-commit discipline in the v1.4.29 kickoff.

### R4-CODE-H2 — Mislabelled commit `235e52cb` ships Coach drawer + mobile rail tray under a charts subject
File: commit `235e52cb` body vs diff
Subject: "refactor(charts): single HealthChartDynamic re-export". Diff: 237 net additions across `coach-drawer.tsx`, the new `mobile-rail-tray.tsx`, and its test fixture. Zero chart files. The commit body is missing entirely. Worse atomic-hygiene violation than H1 — the subject is actively misleading.
Fix shape: same as H1 — note in release closure; the chart re-export work appears to live in `8f3bfc37` ("collapse health-chart dynamic imports onto re-export"), so the two commit subjects are swapped between two adjacent commits.

### R4-CODE-H3 — Test-then-fix split across commits leaves intermediate `develop` red
File: `1b0e81ae` (icon-only coach launch) → `5570971f` (test update, 23 min later)
`1b0e81ae` rewrites `target-coach-button.tsx` to render an icon-only affordance but leaves `targets-responsive.test.tsx` asserting the old `w-full sm:w-auto` text-bearing wrapper. The per-commit gate (`pnpm typecheck` + `pnpm lint` + relevant tests) listed in the kickoff would have flagged the failure. Either the gate did not run, or the test was skipped; either way `develop` between `1b0e81ae` and `5570971f` failed the suite.
Fix shape: amend the kickoff convention to "tests update inside the same commit that ships the behaviour change"; cap the time-between-commits monitoring (a 23-minute red `develop` window blocks any concurrent contributor's pre-push hook).

### R4-CODE-H4 — Forbidden vocabulary "wave-4b" reintroduced into code comments
File: `src/components/medications/medication-detail-section.tsx:7` + `src/components/medications/DrugLevelChart.tsx:253` (commit `5109e930`)
Both comments use "wave-4b" as a historical bucket identifier. The kickoff explicitly lists `wave` in the forbidden vocabulary. The original v1.4.25 W21 comment ("The four wave-4b sections") was carried forward verbatim during the chrome rewrite; a clean rewrite should have neutralised the bucket name.
Fix shape: replace "wave-4b" with the neutral identifier "v1.4.25 W21 medication-detail section family" or drop the bucket reference entirely. Same scan should pass on the rest of the file (no other `wave` matches).

### R4-CODE-H5 — Forbidden vocabulary "AI" used in new code comments
File: `src/app/insights/schlaf/page.tsx:62-72` (commit `8f7cbd49`); `src/components/insights/__tests__/hero-strip.test.tsx:196` (commit `cad53a68`)
The kickoff bans the substring `AI`. The schlaf comment ("written per-section AI assessment") and the hero-strip test comment ("the AI schema slot ... are gone") both add the forbidden word in lines that this release authored. Pre-existing `/lib/ai/*` path references are allowed (path identifier exception); free-form comment strings are not.
Fix shape: rewrite to "written per-section assessment" / "the assistant schema slot". The same scan should grep `git diff v1.4.27..HEAD` for `\bAI\b` in non-path lines as a release-gate.

### R4-CODE-H6 — Maintainer first-name reference in commit body breaks the no-PII rule
File: commit `9a020f21` body ("FB-I1 — Marc asked for a tappable `?` glyph...")
Commit messages on `develop` become the public squash-merge subject + body on `main` and are visible in the GitHub UI for any browser of the repo. The kickoff bans the maintainer's name in user-facing artifacts; the public commit log is user-facing. Compare with `538b44f7`'s test fixture (`username: "marc"`) which is internal test code — different exposure surface.
Fix shape: drop the first-name reference, rewrite as "FB-I1 — the maintainer asked for a tappable `?` glyph" or "FB-I1 — surface a tappable `?` glyph". The squash-merge subject + body is the primary touch-point; one-line scrub is enough.

## Medium

### R4-CODE-M1 — Aggregated DTO ships `count` field that's not declared anywhere
File: `src/app/api/measurements/route.ts:80-86`
The aggregated branch invents an inline DTO `{ type, value, measuredAt, count }` directly inside the route — no Zod schema, no `MeasurementAggregateWireDTO` type, no entry in `.planning/v15-ios-handoff/08-locked-contracts.md`. Consumers (the chart, any future iOS update, OpenAPI generator) have nothing to import. The `count` field is forwarded but never spec'd.
Fix shape: lift the inline shape to `src/lib/validations/measurement.ts` as `aggregatedMeasurementSchema`; export the TS type; add an `aggregateRow` Zod schema for OpenAPI emission. Document the new shape in `08-locked-contracts.md` before the iOS team consumes it.

### R4-CODE-M2 — `limit` cap loosened from 500 to 5000 without bumping the locked-contract doc
File: `src/lib/validations/measurement.ts:249`
The locked-contract excerpt in `.planning/v15-ios-handoff/03-api-contracts.md:305` says `limit: z.coerce.number().int().min(1).max(500)`. The v1.4.28 schema now reads `.max(5000)`. Backwards-compatible for existing callers but a contract drift; the iOS team's `MeasurementListWireResponse` may carry the documented cap.
Fix shape: bump the locked-contract doc in lockstep; surface the change in the release notes under "API contract additions".

### R4-CODE-M3 — Several commits ship without bodies
Files: `75773ca0`, `ebf83b1e`, `b0ef80dc`, `8c89ddac`, `8f3bfc37`, `235e52cb`, `d286220b`
The kickoff says "Atomic commits per logical sub-task. No 'WIP', 'various improvements', 'end-of-day commit'." — implicitly the body explains the "why" for non-trivial subjects. `ebf83b1e` (274-line bundle-analyzer + web-vitals wire-up) and `8c89ddac` (277-line insights-sub-page consolidation, six pages touched) both ship body-less. `b0ef80dc` (225-line locale cache) is forgiven because the rationale lives in the file header.
Fix shape: enforce a per-commit hook that requires a body for diffs over a 40-line / 3-file threshold. Retroactive for v1.4.28 is moot; the release-notes pass can backfill the "why" for the heavier commits.

### R4-CODE-M4 — FB-E3 (opt-in GLP-1 dashboard widget) silently deferred
File: `.planning/v1428-feedback-2026-05-15.md:66` vs. the 30-commit diff
FB-E3 is Medium severity in the feedback doc. Two retirement commits (`8e5f71b1`, `8c81af10`, `8c8d6dc2`) reference "an opt-in dashboard widget that surfaces the same level chart will land later in this cycle" — the cycle is v1.4.28, and the widget has not landed. No entry in a v1.4.29 backlog (file does not exist).
Fix shape: create `.planning/v1429-backlog.md` and seed FB-E3 with the explicit rationale ("Medium polish item, scope-reduction sub-pass took precedence in v1.4.28"); soften the commit-message wording in the release-notes editorial pass.

### R4-CODE-M5 — Typed-error pattern repeated inline rather than extracted
File: `src/components/measurements/measurement-list.tsx:248-260` (commit `538b44f7`)
The mutation casts `as Error & { errorCode?: string; status?: number }` in three places (response parse, throw, onError handler). The same pattern will recur on every mutation that handles a 409 with a structured error code; v1.4.28 sets the first instance. A `class HttpError extends Error { errorCode?: string; status?: number }` (or a `parseApiError` helper) would carry the contract instead of re-casting at every callsite.
Fix shape: extract `HttpError` into `src/lib/http-error.ts`; migrate the measurement-list call-site as the first consumer; queue the rest under a v1.4.29 polish item.

### R4-CODE-M6 — `useMemo` for `fetchWindow` recomputes `new Date()` only on dep change
File: `src/components/charts/health-chart.tsx:518-532` (commit `b00be286`)
`fetchWindow` calls `new Date()` inside a `useMemo` keyed on `[rangePoints, effectiveCompareBaseline]`. Within a long-lived session (a user leaves the page open for hours), the `to` boundary never advances — the chart paints data up to the time of last range-tab flip, not "now". For most users it's invisible; for a power user staring at the live pulse chart, the right edge slowly stalls.
Fix shape: re-key the memo on a 60-second-rounded timestamp (`Math.floor(Date.now() / 60_000)`) so the window snaps to "now" each minute without churning the cache key on every render.

## Low

### R4-CODE-L1 — `i18n: add the lastYear coach window key` commit drops the conventional-commit scope parens
File: commit `75773ca0` subject
Subject reads `i18n: add the lastYear coach window key`. Every other commit in the v1.4.28 range uses `type(scope): subject` (`fix(api)`, `feat(insights)`, `chore(medications)`). The plain `i18n:` form drops `(scope)`. Mild format drift, not a blocker.
Fix shape: pin `(i18n)` as the scope label for future locale-only commits; or treat it as the scope itself with a body subject (`feat(i18n): add the lastYear coach window key`).

### R4-CODE-L2 — Test mock fixture uses the maintainer's first name
File: `src/app/api/measurements/__tests__/put-duplicate-timestamp.test.ts:39`
`username: "marc"` in a mock session fixture. Internal-only (test fixture, never serialised to the client) — the no-PII rule arguably stops at user-facing artifacts. Carried forward from v1.4.27 fixtures.
Fix shape: rename to a neutral fixture name (`test-user`) at the next refactor pass; not worth a v1.4.28 follow-up commit.

### R4-CODE-L3 — Empty body on the perf+web-vitals commit obscures the cumulative LOC impact
File: commit `ebf83b1e` body (empty)
274-line addition (Next config wrapper + `@next/bundle-analyzer` dep + new internal route + the client reporter). The intent is clear from the subject but the body could carry the "why" (perf-baseline plumbing for the v1.4.29 measure-then-act pass).
Fix shape: backfill the body in the release-notes editorial; not actionable on the commit itself without a rewrite.

---

## Per-commit notes

| Commit | Subject | R4 verdict |
|---|---|---|
| `538b44f7` | fix(api): return 409 on duplicate-timestamp measurement edit | Clean; failing-test-first; iOS-safe |
| `b00be286` | perf(charts): bound health-chart fetches to the active range window | **C1, C2, M1, M2, M6** — needs server-side aggregation fix + iOS gate |
| `0d591ac9` | fix(insights): cap status-card provider calls at 20s with graceful fallback | Clean; coverage at `pulse-status-timeout.test.ts` |
| `ac80c099` | fix(insights): unstick scroll on tab-strip and mother-page navigation | Clean; e2e spec covers both regressions |
| `59ef95f2` | fix(dashboard): align BD-Zielbereich tile with shared TrendCard primitive | Clean; failing-test-first locks the date-shape regression |
| `8e5f71b1` | chore(dashboard): retire the GLP-1 tile | Clean delete; drift-guard updated; iOS audit clean |
| `cad53a68` | chore(insights): retire the weekly-report surface | Clean delete; one "AI" remnant cleaned elsewhere |
| `52edf85f` | chore(insights): retire the InsightAdvisorCard surface | Clean delete |
| `8c81af10` | chore(medications): drop the Dosis-Historie disclosure from GLP-1 detail | Clean delete; iOS DTO byte-stable |
| `8c8d6dc2` | chore(medications): drop the Bestand section from GLP-1 detail | Clean delete; iOS DTO byte-stable |
| `6f6992c6` | refactor(medications): unify medication-list row shape | Clean; primitive carved out |
| `155b529d` | fix(insights): match HealthScore card height to the hero column | Clean; DOM-class assertions, no pixel checks |
| `4c6d8779` | refactor(coach): consolidate launch button to inline + layout-FAB shape | Clean; fixes duplicate-FAB a11y issue |
| `d286220b` | perf(charts): wire chart-skeleton loading state across dynamic imports | Body empty (**M3**); clean diff |
| `1b0e81ae` | fix(targets): make the coach launch an icon-only affordance | **H3** — test update split into a separate commit |
| `66e13845` | refactor(coach): narrow launch-scope metric type to the source union | Clean; type-safety win |
| `ca381957` | fix(coach): align mobile sheet height to the responsive-sheet convention | Clean |
| `7d38a54d` | fix(medications): align side-effects card to the surface convention | Clean (test-only update, paired with `88085615`) |
| `9a020f21` | feat(insights): explain the HealthScore delta on tap | **H6** — Marc-name in commit body |
| `88085615` | fix(medications): shorten side-effects add CTA across locales | Clean (locale half of FB-F1) |
| `235e52cb` | refactor(charts): single HealthChartDynamic re-export | **H2** — content is Coach drawer + mobile rail tray, NOT charts |
| `8f3bfc37` | refactor(charts): collapse health-chart dynamic imports onto re-export | Body empty (**M3**); likely the actual charts-rewrite the H2 subject claims |
| `5109e930` | refactor(medications): collapse detail-page chrome to one heading scale | **H4** — "wave-4b" comment carried forward |
| `0e7c97c5` | fix(insights): align briefing empty-state CTA variant | **H1** — body claims only CTA variant; diff lands FB-K1/K2 trend-row |
| `8c89ddac` | refactor(insights): consolidate sub-page data-fetch and empty state | Body empty (**M3**); clean shared hook |
| `8f7cbd49` | fix(insights): document the missing sleep status slot | **H5** — "AI assessment" in new comment |
| `b0ef80dc` | perf(notifications): cache the dispatch-localised user lookup | Body empty (**M3**) but file header carries rationale; clean LRU + 5 tests |
| `ebf83b1e` | feat(perf): wire bundle analyzer and web-vitals beacon | **C3, M3, L3** — unauthenticated beacon, empty body |
| `75773ca0` | i18n: add the lastYear coach window key | **L1** — scope parens dropped |
| `5570971f` | test(targets): update coach CTA assertion to the icon-only shape | Clean test-only follow-up |

---

## Summary

| Severity | Count |
|---|---|
| Critical | 3 |
| High | 6 |
| Medium | 6 |
| Low | 3 |

### Top-3 fix recommendations (must clear before the v1.4.28 tag)

1. **R4-CODE-C1** — drop `take: limit` from the `/api/measurements` aggregation branch (or push aggregation into SQL). The chart silently truncates high-density data on > 90-day windows; FB-D2 is half-fixed without it. Add a 30 000-row regression seed.
2. **R4-CODE-C2** — gate the aggregation branch on an explicit `aggregate` param. Without it, any future iOS update that adds date filtering on a > 90-day drill-down silently breaks the locked-contract response shape.
3. **R4-CODE-C3** — restrict the web-vitals beacon to known metric names + add a same-origin Referer guard. Currently any external page can pollute the wide-event log with arbitrary strings.

### Go / no-go

**No-go on the v1.4.28 tag** until the three Critical findings are addressed. R4-CODE-C1 alone is a regression on the exact perf surface FB-D2 was meant to fix — shipping it would leave the maintainer with a chart that paints fewer points than v1.4.27 on the > 90-day range. R4-CODE-C2 and R4-CODE-C3 are smaller in user-visible blast radius but R4-CODE-C2 violates the v1.5 iOS-safety underlying premise that the kickoff calls out explicitly.

The High-severity items (H1, H2 mislabelled commits; H3 test-then-fix split; H4-H5 forbidden vocabulary; H6 PII) do not block the tag individually but each warrants a touch-up commit before merge: the vocab + PII items via a `chore(docs): release-notes editorial scrub` pass over commit messages and code comments, and a `Note:` in the release closure noting the H1/H2 subject swap so the v1.4.27 → v1.4.28 changelog reflects what landed where.
