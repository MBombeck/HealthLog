# v1.4.38 backlog

Seeded 2026-05-17 during the W10 reconcile-apply pass on develop. Each
bullet captures a finding the v1.4.37 reviewers surfaced but the
reconcile pass deliberately deferred — either too large for a pre-tag
fix or pre-existing pattern out of W10 scope. Reviewer-doc references
in parentheses so Marc can re-read the source rationale.

## High — fix before iOS broadens the user base past Berlin

### Cross-tz UTC bucket alignment in correlations fast-path
(`.planning/phase-W10-v1437-code-review-findings.md` H-3 +
`.planning/phase-W10-v1437-architecture-findings.md` M2)
- `readRollupBuckets` returns UTC-midnight `bucketStart`; the
  correlations fast-path keys them via `userDayKey(b.bucketStart,
  userTz)` and pairs against per-event mood / intake rows. For a user
  more than ~4 h from UTC the rollup-derived per-day-mean addresses
  the wrong calendar day relative to the live mood/intake stream, so
  pairing silently slips by a day and miscorrelates.
- Cheap path: runtime guard in `computeCorrelationHypothesesFastPath`
  that falls back to live for non-near-UTC zones.
- Proper iOS-sprint deliverable: thread `userTz` into
  `readRollupBuckets` and shift the read window so each row addresses
  the user's local day. Same fix shape as M-4 / M2 below.

### BP fast-path day-edges drift against the live path
(`.planning/phase-W10-v1437-code-review-findings.md` M-4 +
`.planning/phase-W10-v1437-architecture-findings.md` M1)
- `bp-in-target-fast-path` keys rollup rows on
  `d.toISOString().slice(0, 10)` (UTC slice) and compares them
  against `now - N*DAY_MS` boundaries. The rollup path includes /
  excludes the boundary day differently from the live path; the
  helper docstring's "±2 %" claim absorbs the noise for Berlin-only
  tenants but the v1.5 cross-tz spread will surface drift.
- Same fix shape as the correlations fast-path: align rollup-path
  windows with day edges in user tz, or runtime-fallback for
  non-near-UTC zones.

## Medium — code quality / robustness

### Geo-backfill per-row timeout chunking
(`.planning/phase-W10-v1437-code-review-findings.md` M-1)
- Worker loop processes up to 5000 rows sequentially with 3s online
  fallback each → worst-case 4 h run blocks the hourly cron. Chunk
  with `Promise.all` (16-row windows) or drop the cap to 500.

### Geo-backfill singleton-guard for multi-worker safety
(`.planning/phase-W10-v1437-security-findings.md` M-2)
- The cron has no per-process concurrency guard. A multi-container
  worker deploy would let two passes hit the third-party `ipwho.is`
  endpoint at 5000×N rows/h and risk getting the host IP blocked.
- Add `singletonKey` / advisory-lock around `handleGeoBackfill`.

### Drain queue: cutoff-hours constant lives only in the worker
(`.planning/phase-W10-v1437-architecture-findings.md` M5)
- `DRAIN_CUMULATIVE_CUTOFF_HOURS = 36` is a module-local in
  `reminder-worker.ts`. The admin route + CLI both default to
  `undefined`. Lift into the helper module as an exported constant
  shared across the three call sites.

### Drill-down `take: Math.min(limit, 1000)` silently overrides schema cap
(`.planning/phase-W10-v1437-architecture-findings.md` M3)
- Schema allows `limit ≤ 5000`; route caps the drill-down at 1000
  with no response signal. Move the 1000 cap into the validator
  refine on `(limit, dayKey)` so a 422 surfaces, or echo the
  effective cap as `meta.limit`.

### Analytics route's cached `daysAgo` ages with the cache TTL
(`.planning/phase-W10-v1437-code-review-findings.md` M-6)
- `lastSeenByType.daysAgo` is computed once and lives inside the 60s
  cached body; across a day boundary the cached `daysAgo` is off by
  one. Store `lastSeenAt` only and derive `daysAgo` per read.

### `ensureUserRollupsFresh` in cached envelope has no per-key dedup
(`.planning/phase-W10-v1437-code-review-findings.md` M-7)
- A cold-cache fan-out can kick off N parallel `recomputeUserRollups`
  invocations for the same user. Wrap the lookup in a per-key
  in-flight promise (same shape as `buildCoachSnapshot` dedup).

### Coach cascade SSR test under-coverage
(`.planning/phase-W10-v1437-code-review-findings.md` M-5)
- The `LayoutCoachMount` fixture's `proofWhenOn: ""` test is
  trivially satisfied because the drawer SSRs to nothing whether the
  gate fires or not. A contributor removing the gate from
  `layout-coach-mount.tsx` would not fail this test. Replace the
  substring grep with a spy / CSR render that exercises the gate.

### Coach cascade fixture cross-cut tests
(`.planning/phase-W10-v1437-architecture-findings.md` H4)
- The `COACH_SURFACES.length).toBe(6)` count covers in-band surfaces
  only and explicitly delegates two cross-cut gates (`/targets` page
  drawer, `TargetCard` CTA) to separate tests. A new sub-page Coach
  mount would not trip the count. Either absorb cross-cut gates into
  the same fixture or back the count with a grep-based test that
  enumerates every `flags.coach` short-circuit in the codebase.

### Coach API route gate inventory
(`.planning/phase-W10-v1437-architecture-findings.md` M6)
- `requireAssistantSurface("coach")` is wired on
  `/api/insights/{chat,comprehensive,generate}` — the only three
  Coach-scoped routes today. No invariant test asserts the set; a
  future Coach API addition could omit the gate. Add a discovery-
  style test that greps every route under `src/app/api/insights/**`
  for the gate or an explicit allowlist entry.

### Medication-card category-label drift guard
(`.planning/phase-W10-v1437-code-review-findings.md` L-6)
- `getMedicationCategoryLabel` falls back to `categoryOther` for
  unknown categories. The enum lives in three places (Prisma,
  validation, label map). Derive `MEDICATION_CATEGORY_KEYS` from
  the validation enum or vitest-assert
  `MEDICATION_CATEGORY_VALUES.every((v) => v in MEDICATION_CATEGORY_KEYS)`.

### Drain serial loop has no per-user completion checkpoint
(`.planning/phase-W10-v1437-code-review-findings.md` L-3)
- `drainPerSampleCumulative` serially walks users with no
  COMPLETE log line per user — only START. Add a
  `workerLog("info", "[drain-cumulative] user=… complete")` line.

### `recomputeBucketsForMeasurement` chases pg-boss serially
(`.planning/phase-W10-v1437-code-review-findings.md` L-5)
- Three `await enqueueRollupRecompute(...)` calls run in a `for-of`
  loop. Replace with `await Promise.all(ASYNC_GRANULARITIES.map(...))`
  to halve the measurement-write critical path.

### `looksLikeIp` regex matches structurally invalid IPs
(`.planning/phase-W10-v1437-code-review-findings.md` L-4)
- `/^[0-9a-fA-F.:]+$/` matches `:::` and `1.2`. The cf-connecting-ip
  flow trusts the header under the env flag, so a malformed value
  passes to the rate-limiter / audit log. Either keep as-is for
  cost or import `net.isIP` from `node:net` for strict validation.

### MedicationIntakeQuickAdd refetches `/api/medications`
(`.planning/phase-W10-v1437-security-findings.md` L-1)
- Every sheet open issues a fresh `/api/medications` GET even when
  the parent dashboard already holds the data via `queryKeys.
  medications()`. Behavioural — no security regression.

### Arztbericht hero card uses `credentials: "include"` on same-origin
(`.planning/phase-W10-v1437-security-findings.md` L-2)
- No-op for same-origin. Drop the redundant flag for consistency
  with the rest of the codebase or leave as defence-in-depth.

### Coach cascade `COACH_SURFACES.length` count rationale
(`.planning/phase-W10-v1437-code-review-findings.md` L-7)
- The fixture pins 6 surfaces; the codebase has 9+ `flags.coach`
  gate sites split between the fixture and cross-cut tests. Either
  parity-check the gate inventory in the test or document the full
  9-gate map in a sibling .md so the 6-count's intent is
  discoverable.

### BP fast-path 396-day window doesn't honour leap years
(`.planning/phase-W10-v1437-code-review-findings.md` L-8)
- `readSince = now - 396 * 24h` — for windows that span a leap year
  the constant is 1 day shy of the intended priorYear span. Below
  the n=20 surface gate it never matters; defer unless someone files
  a bug.

### Private `dayKey` helper in `bp-in-target-fast-path` shadows `userDayKey`
(`.planning/phase-W10-v1437-architecture-findings.md` L4)
- Helper uses `d.toISOString().slice(0, 10)` (UTC slice) but is
  named generically. Rename to `bucketDayKey()` with a docstring
  warning against accidental replacement by `userDayKey`.

### `CORRELATION_WINDOW_DAYS = 28` not in OpenAPI
(`.planning/phase-W10-v1437-architecture-findings.md` L1)
- Constant is exported on the meta dict but absent from
  `docs/api/openapi.yaml`. Add `correlations.windowDays` to the
  analytics response schema so iOS / docs site can quote it without
  scraping the meta payload.

### `degraded: false` sentinel always-false on correlations
(`.planning/phase-W10-v1437-architecture-findings.md` L2)
- Forward-looking field; no path sets it true today. Add a TODO
  comment and reserve in the release notes, or remove until the
  load-shedding branch lands.

### Health-score `bpInTargetPct` shared across current+previous windows
(`.planning/phase-W10-v1437-architecture-findings.md` L3)
- Pre-existing — the week-over-week delta reflects three pillars
  (weight, mood, compliance) and zero for BP because the helper
  uses the same `bpInTargetPct` on both windows. Compute the prior-
  week BP using the rollup path once the fast-path matures.

## UX / a11y — P1 polish (already documented; non-blocking for tag)

(`.planning/phase-W10-v1437-ux-a11y-findings.md` P1-1, P1-3, P1-4,
P1-5, P1-6)
- P1-1 drill-down chevron needs `aria-controls` thread to the
  `<DayDrillDown>` container (NVDA / VoiceOver jump beat).
- P1-3 Hinzufügen menu can overflow at 320 px without
  `max-w-[calc(100vw-2rem)]` on `<DropdownMenuContent>` — consider
  shortening "Medikamenteneinnahme erfassen" → "Einnahme erfassen".
- P1-4 `quick-add-labels` collision guard runs on en + de only;
  extend the `it.each` table to all six locales so the guard scales
  with future translations.
- P1-5 (optional) tighter `gap-3 md:gap-4` on target-card may feel
  cramped on long status-pill metrics — measure
  `MEDICATION_COMPLIANCE` and `MOOD_STABILITY` cards.
- P1-6 (optional) chevron parity in `select.tsx` matches Chromium
  Material but lags Safari / legacy by ~4 px — bump trigger to
  `pr-2` if Marc reports the gutters feel off.

## UX / a11y — P0 i18n English-fallback (pre-existing pattern)

(`.planning/phase-W10-v1437-ux-a11y-findings.md` P0-1 + P0-2 +
`.planning/phase-W10-v1437-i18n-findings.md`)
- es/fr/it/pl currently ship as 72–73 % EN-fallback (the
  `MaintainershipBanner` covers the gap). The W7b
  `medication-intake-quick-add.*` block and the W7c
  `measurements.{dailyTotalCaption,expandDay,collapseDay}` keys ship
  in English in those four locales; they follow the established
  pattern. Marc to decide whether to invest in full localisation
  ahead of the v1.5 iOS sprint.

## UX / a11y — P2 / P3 polish

(`.planning/phase-W10-v1437-ux-a11y-findings.md` P2-1 through P2-5,
P3-1 through P3-7)
- P2-1 medication-intake empty-state footer reads unbalanced —
  promote in-body CTA into the footer slot.
- P2-2 BMI structured-skeleton success card lacks `aria-live` on
  the swap.
- P2-3 GLP-1 take-now pill colour-only — add icon for colour-blind
  users.
- P2-4 Health-score grid `1fr` slack distribution OK as designed.
- P2-5 Dashboard "Hinzufügen" `items-center` vs `items-start`
  preference.
- P3-1 through P3-7 — documentation-only or low-priority polish.

## Architecture / cross-cut (pre-existing)

- All six-axis low-priority polish items from
  `.planning/phase-W10-v1437-architecture-findings.md` Low / Medium
  not surfaced above.
- All pre-existing i18n EN-fallback patterns from
  `.planning/phase-W10-v1437-i18n-findings.md` Medium / Low — not
  v1.4.37 regressions.
