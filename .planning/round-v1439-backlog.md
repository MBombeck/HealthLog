# v1.4.39 backlog

Seeded 2026-05-17 during the v1.4.38 W-RX reconcile-apply. Items the
v1.4.38 reviewers surfaced but reconcile deliberately deferred —
either out of scope for the punch-list close, or unlocking value
better paired with the v1.4.39 wave. Reviewer-doc references in
parentheses so the next session can re-read the source rationale.

---

## High — wave-fit polish

### Named cached / enriched envelope split in analytics route
(`.planning/phase-W-QA1-v1438-code-review-findings.md` H-2)
- `src/app/api/analytics/route.ts:86-152` — extract a named
  `AnalyticsCachedBody` / `AnalyticsEnrichedBody` pair to pin the
  cached call site to the un-enriched shape and the API response to
  the enriched shape. Failing test: assert `caches.analytics` keys
  only hold `{ lastSeenAt }` (no `daysAgo`).
- Rationale: today the contract drift between cached and emitted body
  is policed by convention. A well-intentioned future "fix" that adds
  `daysAgo` into `buildAnalyticsResponse` lands it back into the cache
  and silently re-introduces the v1.4.38 W-B bug.

### `ensureUserRollupsFresh` same-microtask rejection retry safety
(`.planning/phase-W-QA1-v1438-code-review-findings.md` H-1)
- `src/lib/measurements/rollups.ts:608-633` — clear the in-flight
  dedup slot eagerly in `.then` / `.catch` instead of `.finally`, so
  a same-microtask retry on rejection starts a fresh slot rather than
  piggybacking on the already-rejected promise. Add a unit test that
  pins the racy case.

---

## Medium — correctness polish

### RX-3 — Coach client-side copy branch
- `src/components/coach/message-thread.tsx:78` (or its current
  equivalent) — branch on the Coach availability flag and surface a
  user-friendly disabled-state message instead of swallowing the
  click. Introduces `coach.assistantDisabledMessage` locale key
  across de/en/es/fr/it/pl.
- Background: the W-RX investigation flagged this as part of the
  cascade closure but it sits in client UI; the API gates are already
  fixed (W-C) so the route returns clean 403; only the local copy
  is missing.

### RX-7 — repo hygiene sweep
- `src/components/medication/medication-card.tsx` — three unused
  imports left after the W-D refactor pass; drop them.
- `src/lib/insights/comprehensive-aggregator.ts` — two orphan helpers
  (`legacy*` shapes) survive the W-F migration but are unreferenced;
  drop them after a final grep.
- `messages/*.json` — orphan-key scan across de/en/es/fr/it/pl. Find
  keys present in every locale but unreferenced in `src/`; emit a
  diff for manual confirmation before deletion.

### RX-8 — cumulative sparkline uses mean instead of sum
- `src/app/api/dashboard/summary/route.ts` (sparkline sub-query) —
  for cumulative metrics (`ACTIVITY_STEPS`, `ACTIVITY_FLIGHTS`,
  `ACTIVITY_DISTANCE`, water/intake totals) the W-F DAY-bucket read
  uses `r.mean`. The semantically correct read for cumulative metrics
  is `r.sum`. Mean is correct for the average-style metrics already
  on the card (BP, weight, HRV, etc.). Switch per-type at the
  partition step using the registry's `aggregation` field.

### QA-4 M-1 — Coach gate inventory walker file-ext closed set
(`.planning/phase-W-QA4-v1438-architecture-findings.md` MEDIUM-1)
- `src/app/api/insights/__tests__/coach-route-gate-inventory.test.ts:112`
  — walker hard-codes `entry !== "route.ts"`. Widen to
  `entry.startsWith("route.")` with an explicit
  `["route.ts", "route.tsx", "route.js", "route.jsx", "route.mjs", "route.mts"]`
  closed set so a future `route.tsx` insights handler doesn't escape
  the gate-presence audit.

### QA-4 M-3 — Dashboard sparkline live-fallback for empty rollup tail
(`.planning/phase-W-QA4-v1438-architecture-findings.md` MEDIUM-3)
- `src/app/api/dashboard/summary/route.ts:323-335` — if the DAY-bucket
  read returns `[]` for a brand-new account before the boot backfill
  catches up, fall through to a one-shot
  `date_trunc('day', measured_at) GROUP BY` against `measurements`.
  Degraded-not-broken today (the boot backfill closes within minutes);
  proper fix removes the brief flat-sparkline first-impression.

### QA-6 M-1 + M-2 — BP / pulse term unification (es, pl)
(`.planning/phase-W-QA6-v1438-i18n-parity-findings.md` M-1, M-2, M-3)
- es: 16 keys use `tensión arterial`, 11 use `presión arterial`.
  Unify on `presión arterial` (WHO Spanish guideline, dominant
  variant in the file).
- pl: 6 keys use `ciśnienie tętnicze` (clinical), 9 use
  `ciśnienie krwi` (lay). Unify on `ciśnienie tętnicze` in clinical
  contexts (doctor-report, classification headlines); keep
  `ciśnienie krwi` only if intentional in casual dashboard copy.
- pl: 11 remaining `puls` substrings — most are fallback strings,
  worth a sweep to unify on `tętno`.

### Multi-process dedup follow-up
(`.planning/phase-W-QA4-v1438-architecture-findings.md` MEDIUM-2)
- `src/lib/measurements/rollups.ts:582-624` — per-process `Map` is
  sufficient at single-container scale. Capture this in the v1.5
  capacity plan: if Next horizontally scales, each container
  duplicates the cold fan-out (N parallel recomputes, N = container
  count). No code change today.

---

## Low — observability polish

### `isNearUtc` silent fallback observability
(`.planning/phase-W-QA1-v1438-code-review-findings.md` M-1)
- `src/lib/tz/format.ts:96-100` — one-shot `console.warn` (mirror
  `warnTrustViolationOnce`) when an invalid tz is silently demoted to
  Berlin. Semantics unchanged, operator gains "are users storing
  junk" visibility.

### `bp-in-target-fast-path` cross-tz guard default
(`.planning/phase-W-QA1-v1438-code-review-findings.md` M-2)
- `src/lib/analytics/bp-in-target-fast-path.ts:147-163` — flip the
  omitted-`userTz` default from "near-UTC" to "force live", or make
  `userTz` required and audit-fix call sites in one commit.

### Comprehensive aggregator ORDER BY stable tiebreaker
(`.planning/phase-W-QA1-v1438-code-review-findings.md` M-3)
- `src/lib/insights/comprehensive-aggregator.ts:301-327` — extend the
  consolidated BP read's `orderBy` to `[{ measuredAt: 'asc' }, { id:
  'asc' }]` for postgres-stable ordering, then pin partition order
  with a unit test.

### Drain per-user log per-user-scoped struct
(`.planning/phase-W-QA1-v1438-code-review-findings.md` M-4)
- `src/lib/measurements/drain-per-sample-cumulative.ts:316-318,
  434-442` — replace snapshot-delta with a per-user struct
  accumulated inline, then summed into totals. Same numbers, no
  snapshot fragility.

### bp-in-target-fast-path immutable `readSince`
(`.planning/phase-W-QA1-v1438-code-review-findings.md` M-5)
- `src/lib/analytics/bp-in-target-fast-path.ts:189-197` — prefer
  the `Date.UTC(...)` constructor over `d.setUTCFullYear`/
  `setUTCDate` mutators. No mutation surface, future-maintainer
  trap removed.

### Coach gate inventory AST walker
(`.planning/phase-W-QA1-v1438-code-review-findings.md` M-6)
- `src/app/api/insights/__tests__/coach-route-gate-inventory.test.ts:79-87`
  — switch the line-mode comment skipper to a TypeScript AST walker
  (`ts.createSourceFile` + `CallExpression` matcher). The Vitest
  harness already loads the TS compiler.

### `health-score-fast-path` `bpInTargetPctPriorWeek` semantics JSDoc
(`.planning/phase-W-QA1-v1438-code-review-findings.md` L-1)
- `src/lib/analytics/health-score-fast-path.ts:140-143` — JSDoc note
  on the field: `undefined` = legacy compat (pin to current value),
  `null` = caller knows there is no prior-data (feed through). Unit
  test for both modes.

### Geo-backfill in-process singleton hot-reload guard
(`.planning/phase-W-QA1-v1438-code-review-findings.md` L-2)
- `src/lib/jobs/reminder-worker.ts:1208-1238` — module-scope flag is
  unprotected on Next.js hot-reload. Wrap in `globalThis`-cached
  shape, mirror the prisma client pattern used in `src/lib/db.ts`.

### IT longest-string clip-risk snapshot
(`.planning/phase-W-QA6-v1438-i18n-parity-findings.md` L-1)
- 320 px Playwright snapshot of `/insights` and `/measurements` in
  IT before next release. If clipping shows, shorten
  `insights.hrv.chartTitle` → `Variabilità FC` and consider
  abbreviation for `measurements.subtitle`.

### FR pending-label clip-risk
(`.planning/phase-W-QA6-v1438-i18n-parity-findings.md` L-2)
- `fr.insights.trendAnnotation.pendingLabel` is 46 chars vs DE 30.
  Shorten to `Commentaire en cours…`.

### EN file 166 untranslated DE strings
(`.planning/phase-W-QA6-v1438-i18n-parity-findings.md` L-5)
- 6.8% of `en.json` is identical to `de.json`. Mostly proper nouns
  (medication brand names, GLP-1 drug names). Pass to confirm none
  are genuine EN gaps.

### W-QA-3 unresolved tail (deferred P3 polish)
- Items P3-4 through P3-7 from the W-QA-3 UX/a11y report — micro
  polish where the perceived-quality lift is small relative to the
  rebuild risk. Land them in the next UX polish wave alongside any
  iOS-driven web-side adjustments.

---

## Strategic note (carry into v1.5)

- iOS Health-app integration is the v1.5 P1; the v1.4.38 backlog
  items above are all web-side polish that doesn't gate iOS work.
- Cross-tz proper fix (per-user-tz rollup bucket minting) remains
  v1.5 — the v1.4.38 cheap path (runtime guard with live fallback
  for non-near-UTC) is in place and battle-tested in the canonical
  Berlin tenant.
- The W-QA-6 T3 admin/settings/achievements coverage gap (149
  achievement keys × 4 locales) is the largest remaining
  user-facing localization debt. Worth a focused wave alongside the
  iOS launch when achievement copy gets a final review.
