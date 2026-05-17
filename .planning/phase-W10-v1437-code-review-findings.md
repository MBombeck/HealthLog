# v1.4.37 — W10 code-review findings

Reviewer: code-correctness / contract-integrity lane (parallel to security,
UX/a11y, architecture, simplifier, i18n).
Scope: full `v1.4.36..HEAD` diff on `develop` (98 files, +8954/-1306, ~50
commits across W2–W8 + W-CI).

## Critical

### C-1. W7c nightly drain queue is scheduled but never created
- **File**: `src/lib/jobs/reminder-worker.ts:177` (constant), `:1502-1528`
  (`allQueues` list), `:1587` (schedule), `:1770` (worker bind).
- **Concern**: `DRAIN_CUMULATIVE_QUEUE = "drain-per-sample-cumulative"`
  was added in W7c. The worker boot block creates every queue via the
  `allQueues` array + `boss.createQueue(q)` loop. `DRAIN_CUMULATIVE_QUEUE`
  is NOT in that array (compare to `ROLLUP_FULL_BACKFILL_QUEUE` which is
  in `allQueues` at line 1527 AND scheduled / worked). The repo comment
  at line 1501 explicitly states "pg-boss v12 requires explicit queue
  creation before scheduling."
- **Impact**: At boot, `boss.schedule(DRAIN_CUMULATIVE_QUEUE, "45 3 * * *", …)`
  will either throw a "queue does not exist" error (aborting subsequent
  schedule registrations and worker binds in the same boot phase) or
  silently drop the schedule. Either way the nightly Apple-Health step
  consolidation NEVER runs in production. The whole W7c benefit (~50×
  row compression on power-user accounts) does not materialise; the
  on-demand `groupBy=day` synth still works for the list view but the
  underlying table stays bloated forever.
- **Fix**: add `DRAIN_CUMULATIVE_QUEUE,` to the `allQueues` array
  (alphabetical-ish placement near the other v1.4.37 entries, e.g.
  between `ROLLUP_FULL_BACKFILL_QUEUE` and the closing bracket).
- **Severity rationale**: silent failure of a release-headline feature
  + bottoms out the W7c performance promise + the post-deploy
  verification would not catch it (the list endpoint works because the
  collapse happens at read time, not at write time).

## High

### H-1. W7c drill-down day boundaries shift by 1 hour on DST transitions
- **File**: `src/app/api/measurements/route.ts:95-97`.
- **Concern**: The drill-down branch resolves a calendar day's UTC
  window as:
  ```
  const noonLocal = canonicalDailyTimestamp(dayKey, tz);
  const dayStart  = new Date(noonLocal.getTime() - 12 * 60 * 60 * 1000);
  const dayEnd    = new Date(noonLocal.getTime() + 12 * 60 * 60 * 1000);
  ```
  `canonicalDailyTimestamp` reads the tz offset for `12:00 UTC of the
  day` and shifts. On DST-transition days the actual local day is 23 or
  25 hours long, but `dayStart`/`dayEnd` always span exactly 24 h.
  - Spring-forward (Berlin Mar 30, 2025): `canonicalDailyTimestamp`
    returns the noon-CEST instant; `dayStart` lands 1 h BEFORE the true
    day boundary, so the previous-day's last hour leaks in.
  - Fall-back (Berlin Oct 26, 2025): `canonicalDailyTimestamp` returns
    noon-CET; `dayStart` lands 1 h AFTER the true day boundary, so the
    first hour of `today`'s samples is missed.
- **Impact**: Two days per year, the drill-down view either
  duplicates yesterday's last hour of steps or hides today's first
  hour. The user-visible bug is a step count that doesn't match the
  collapsed day total. Affects every cumulative HK type for every
  IANA zone that observes DST. Same logic applies whenever any callsite
  builds a "day window" from `canonicalDailyTimestamp ± 12h`.
- **Fix**: derive `dayStart` and `dayEnd` independently via the same
  `canonicalDailyTimestamp` trick but use the day BEFORE / day AFTER
  as anchors (e.g. compute `nextDayStart = canonicalDailyTimestamp(dayKey+1)`
  and use `nextDayStart` as the right bound). Or — simpler — compute
  dayStart by formatting `00:00 local-tz` directly through
  `Intl.DateTimeFormat`. Add a vitest case for `dayKey="2025-03-30"`
  with `tz="Europe/Berlin"` that asserts the resolved window matches
  the true 23-h CET→CEST span.

### H-2. Cumulative day-sum type list duplicated across two modules
- **Files**: `src/lib/measurements/apple-health-mapping.ts:342-348`
  (`CUMULATIVE_HK_TYPES`) and `src/lib/measurements/cumulative-day-sum.ts:77-83`
  (`CUMULATIVE_DAY_SUM_TYPES`).
- **Concern**: Both constants enumerate the same five types
  (ACTIVITY_STEPS, ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED,
  WALKING_RUNNING_DISTANCE, TIME_IN_DAYLIGHT). The route + drain hot
  path reads `CUMULATIVE_HK_TYPES` (Set); the analytics route + insight
  rollup reads `isCumulativeDaySumType` which uses
  `CUMULATIVE_DAY_SUM_TYPES` (array). A future contributor adding a
  sixth cumulative type (e.g. SWIMMING_STROKES) only updates one list
  and the system silently misreports for that type: the list-view
  collapse will not fire, OR the analytics `pickCumulativeDaySum` will
  not fire — depending on which list they updated.
- **Impact**: latent correctness drift the moment any new cumulative
  type lands.
- **Fix**: collapse to one source of truth. Either make
  `CUMULATIVE_DAY_SUM_TYPES` derive from `Array.from(CUMULATIVE_HK_TYPES)`
  (with a runtime sort for stable ordering), or move the Set into
  `cumulative-day-sum.ts` and re-export from `apple-health-mapping.ts`.
  Add a vitest assertion that both lists are byte-identical.

### H-3. W2 correlations-fast-path rollup branch uses UTC-anchored bucket starts as user-tz day keys
- **File**: `src/lib/analytics/correlations-fast-path.ts:144-163`
  (the contributor flagged the same issue in the docstring).
- **Concern**: `readRollupBuckets` returns rows whose `bucketStart` is
  UTC midnight (Postgres `date_trunc('day', …)`). The fast-path then
  calls `userDayKey(b.bucketStart, userTz)` to bucket. For a Berlin
  user (UTC+1/+2) UTC-midnight lands at 01:00-02:00 Berlin same day,
  so `userDayKey` returns the expected calendar key. But for a Los
  Angeles user (UTC-7/-8) UTC-midnight is 16:00-17:00 PREVIOUS Berlin
  day, so `userDayKey` returns the previous calendar key.
  Meanwhile the mood + intake reads (still live) bucket on
  `userDayKey(row.actualWallClock, userTz)`, which for that LA user
  IS the user's local day. The pairing then matches the wrong-day
  rollup mean against the right-day mood/intake sample.
- **Impact**: silent miscorrelation for any user whose tz is more than
  ~4 hours from UTC. Today HealthLog is Berlin-centric so the in-prod
  blast radius is zero, but the v1.5 iOS sprint is expressly broadening
  the user base to Apple Health users globally. By tag the contract
  must hold for any IANA zone or the discrepancy lands in prod the day
  the first US/AU user signs up. The contributor's own
  `// A v1.5 follow-up could mint per-user-tz buckets` docstring
  acknowledges the issue — but no work is queued.
- **Fix**: either (a) make `readRollupBuckets` take an optional `userTz`
  param and adjust the read range so the per-day-mean addresses the
  user's local day (the bucket is still UTC, but the read window
  shifts), or (b) document in the function docstring that the rollup
  path is ONLY safe for users within ~3h of UTC and add a runtime
  guard in `computeCorrelationHypothesesFastPath` that falls back to
  live for non-near-UTC zones. The latter is cheaper for v1.4.37
  closure; the former is the proper iOS-sprint deliverable.

## Medium

### M-1. Geo-backfill worker has no per-row timeout; worst-case run > cron cadence
- **File**: `src/lib/jobs/geo-backfill.ts:86-129`.
- **Concern**: The loop processes up to `GEO_BACKFILL_BATCH_CAP = 5000`
  rows sequentially (`for (const row of rows)`). Each row awaits
  `Promise.all([lookupIpLocation(ip), Promise.resolve(lookupIpAsn(ip))])`.
  `lookupIpLocation` bounds with `AbortSignal.timeout(3000)` on the
  online fallback. Worst case: 5000 × 3s = 4.16 hours. The cron is
  hourly, scheduled with pg-boss `singletonKey` semantics — the next
  hour's job will be coalesced/blocked, so functionally the queue
  serialises, but a single bad batch can starve subsequent backfill
  passes for hours.
- **Impact**: not a correctness bug. The admin Standort cell stays
  stale longer than the operator's mental model would predict.
- **Fix**: either chunk the for-loop with `Promise.all` for, say,
  16-row windows, OR drop the per-call cap to 500 so the worst-case
  run is 25 minutes. The 5000 cap is a 5× safety margin over what the
  cron can chew through in an hour; the helper would still backfill
  the entire 30-day window inside a few hourly passes.

### M-2. Dashboard medication-intake quick-add lets user edit "Dose" but ignores it on POST
- **File**: `src/components/dashboard/medication-intake-quick-add.tsx:210-220,
  223-265,384-404`.
- **Concern**: The "Dose" field is pre-filled from the selected
  medication's catalogue dose AND `<Input>` is editable
  (`onChange={(e) => setDoseOverride(e.target.value)}`). When the user
  types a different value (e.g. "5 mg" for a half-pill day), the
  `handleSubmit` body discards `dose` entirely and POSTs
  `{ takenAt, skipped: false }`. The `intakeSchema` has no `dose`
  field, so the user's override is silently dropped. The hint copy
  `t("dashboard.medicationIntakeQuickAdd.doseHint")` does NOT warn
  the user.
- **Impact**: a user adjusts the dose to record a non-standard intake,
  the backend records the catalogue dose, the user's mental model and
  the persisted data diverge. The docstring (lines 50-58) acknowledges
  the trade-off but offers no UX mitigation.
- **Fix**: either (a) make the Dose input `readOnly` until the
  intakeSchema grows a `doseOverride` field — the cheap fix for
  v1.4.37; or (b) add hint copy "Diese Dosis wird nur angezeigt, nicht
  gespeichert" so the user knows the edit is cosmetic. Long-term, the
  schema should grow `doseOverride: string | null` and the intake POST
  should accept it.

### M-3. `cumulativeMetricKey` route helper duplicates a mapping the source-priority module already owns
- **File**: `src/app/api/analytics/route.ts:36-51`.
- **Concern**: The route maps `MeasurementType → SourcePriorityMetricKey`
  inline. The `SourcePriorityMetricKey` enum lives in
  `src/lib/validations/source-priority.ts`; whenever a new cumulative
  type lands the contributor must update BOTH this inline switch AND
  the enum (and ideally the picker's per-metric defaults). Same
  drift-risk shape as H-2.
- **Impact**: latent correctness drift on enum expansion.
- **Fix**: hoist the lookup into
  `src/lib/measurements/cumulative-day-sum.ts` (right next to
  `CUMULATIVE_DAY_SUM_TYPES`) so adding a type lands one mapping in
  one place. Tag the existing function with a `// see also …` pointer
  if you keep the route-level wrapper.

### M-4. `bp-in-target-fast-path` pairs by UTC day-key while the live path pairs per-event
- **File**: `src/lib/analytics/bp-in-target-fast-path.ts:194-211, 295-298`.
- **Concern**: The rollup branch pairs `sysByDay.set(dayKey(r.bucketStart), …)`
  where `dayKey` is `d.toISOString().slice(0, 10)` — UTC slice. Combined
  with H-3, the day pairing is canonical-UTC, but a US user's
  measurements live on local-day boundaries. SYS and DIA from the same
  reading get bucketed correctly together (both UTC-aligned), but the
  windowed % is bucketed against `now`-relative `sevenDaysAgo` /
  `thirtyDaysAgo` deltas measured in **server time**, not user-local
  days. The contributor flagged the bp-in-target approximation in the
  module docstring; the day-key semantics issue is orthogonal and
  unflagged.
- **Impact**: same as H-3 — a Berlin-only release is unaffected; the
  v1.5 cross-tz user onboarding will surface drift.
- **Fix**: thread `userTz` into the helper input and use
  `userDayKey(bucketStart, userTz)` for pairing. Same shape as the
  correlations-fast-path fix in H-3.

### M-5. CoachLaunchButton SSR proof skipped under flag-on test — positive contract under-covered
- **File**: `src/lib/feature-flags/__tests__/coach-cascade.test.tsx:139,
  148, 160, 173-180`.
- **Concern**: The fixture's `proofWhenOn` for `CoachLaunchButton`
  expects `'data-slot="coach-launch-inline"'` to appear. The component
  at `src/components/insights/coach-launch-button.tsx:65` does emit
  that slot — good. But the `LayoutCoachMount` surface has
  `proofWhenOn: ""` and the positive check is skipped entirely. The
  comment justifies this as "drawer is lazy-loaded via next/dynamic
  and SSRs to nothing even when the flag is on" — true, but the
  invariant the fixture pins is "renders nothing measurable in the
  SSR output when the Coach flag is off"; that contract is already
  trivially satisfied by an empty-SSR component regardless of the gate.
  The test thus does not detect a regression where the gate is
  REMOVED from `LayoutCoachMount` (lazy-load would still SSR to
  nothing).
- **Impact**: false security around the "every Coach surface is
  gated" claim. A contributor who deletes the `if (!flags.coach) return
  null;` guard in `layout-coach-mount.tsx` would not fail this test.
- **Fix**: keep the SSR no-op contract but ALSO call the component's
  underlying `useFeatureFlags` mock to assert the gate fired. A
  spy-based assertion or a CSR-style `@testing-library/react` render
  that walks the actual return value would cover the contract better
  than the substring-grep approach.

### M-6. Analytics route's cached `lastSeenByType.daysAgo` ages with the cache TTL
- **File**: `src/app/api/analytics/route.ts:107-114, 188-216, 422-438`.
- **Concern**: `lastSeenByType.daysAgo` is computed once and stored
  inside the response body, which is cached for 60s under
  `${user.id}|default`. Dashboard tile staleness caption pulls
  `daysAgo` from the cached body — within the 60s window the value
  doesn't update. Across a day boundary (user opens dashboard at
  23:59, comes back at 00:01) the cached `daysAgo` is off by 1.
  Minor for the daysAgo bucket but cumulative for callers that branch
  on "< 7 days" thresholds (e.g. trend-card "Letzter Wert vor Xd"
  caption).
- **Impact**: cosmetic; staleness caption flickers from "vor 6T" to
  "vor 7T" 60s after midnight rather than at midnight itself.
- **Fix**: store `lastSeenAt` only in the cached body; derive
  `daysAgo` on the client (or in an outer un-cached wrapper) so each
  read gets the current floor. The lastSeenAt ISO string is stable
  inside the cache window.

### M-7. `ensureUserRollupsFresh` warm-up inside the analytics cached body double-charges cold misses
- **File**: `src/app/api/analytics/route.ts:109-114, 137-145`.
- **Concern**: `cached(caches.analytics, ..., () => buildAnalyticsResponse(user))`
  wraps the body, but `buildAnalyticsResponse` calls
  `ensureUserRollupsFresh(user.id)` as its first step. On a cache miss
  the user pays the rollup warm-up cost AND the analytics build; on a
  cache hit they pay nothing. So the design is right — but the
  warm-up's worst-case cost (90-day backfill = `recomputeUserRollups({
  granularities: ["DAY"], from: 90d, to: now })`) lands inside the
  `cached()` envelope. For a single user with millions of rows the
  cache miss could legitimately block for tens of seconds while every
  other downstream call waits, and the `cached()` wrapper does NOT
  carry a per-key concurrency limit — so a dashboard navigation race
  during cold cache can fan out N parallel warm-ups for the same user
  (one per route entry until one of them wins and warms the cache).
- **Impact**: under load (e.g. a fresh deploy that empties every
  process's in-mem cache simultaneously) every concurrent dashboard
  hit for the same user kicks off its own `recomputeUserRollups`
  invocation. Postgres is the bottleneck; the per-user-tier blast
  radius is the deciding factor.
- **Fix**: wrap the cache lookup in a per-key in-flight promise (an
  `inFlight = new Map<string, Promise<T>>()` deduper around `cached()`)
  so concurrent calls for the same `(user.id, slice)` share one
  builder execution. The shape matches the v1.4.33 snapshot LRU's
  `buildCoachSnapshot` → `buildCoachSnapshotImpl` deduper that already
  exists in the codebase.

## Low / nitpick

### L-1. `medication-intake-quick-add.tsx:131-143` calls `reduceCurrentWindowStatus` without `lateMinutes`/`missedMinutes` from the user's actual reminder thresholds
- **Concern**: The picker uses the hard-coded `{ lateMinutes: 120,
  missedMinutes: 240 }` default. The generic + GLP-1 cards on the
  medications page pull these from
  `/api/settings/reminder-thresholds` so the user's customised
  thresholds are honoured. The quick-add picker doesn't, so the
  auto-pick "due now" branch can disagree with what the cards say is
  due.
- **Fix**: fetch `/api/settings/reminder-thresholds` and pass through.
  Cheap polish; not user-blocking.

### L-2. `intake-history-list-v2.tsx:248-249` derives status from data shape but the server filter is already pinned
- **Concern**: Defence-in-depth comment notes "we derive the branch
  from the data itself rather than trusting a single `skipped` flag";
  fine. But the `else` arm (`null` chip) is unreachable given the
  server's `status:"completed"` filter (the filter literally rejects
  rows where `takenAt IS NULL AND skipped = false`). A row that
  satisfies neither `isTaken` nor `isSkipped` can only arrive if the
  server returned a row that violates the filter contract.
- **Fix**: either keep the dead branch as a forward-compat guard with
  a comment (current state — fine) or drop the ternary's tail entirely
  and have the test assert the server filter holds. The current code
  is correct; the only finding is "this branch is provably
  unreachable, mention it in the comment so a future reader doesn't
  hunt for the path."

### L-3. `drainPerSampleCumulative` per-user serial loop has no progress checkpoint
- **File**: `src/lib/measurements/drain-per-sample-cumulative.ts:236-347`.
- **Concern**: A full drain across the whole user base runs serial
  (`for (const user of users)`). On Marc's 300k-row account inside
  the nightly window this is fine; once the user base grows, the
  cron tick could exceed the next-tick interval. The pg-boss
  retry/backoff handles the queue-side, but there's no progress
  log between users — the operator can't tell whether the drain is
  stuck on user X or has just been processing for hours.
- **Fix**: emit `workerLog("info", "[drain-cumulative] user=… complete")`
  after each user finishes (mirrors the per-user log line already at
  line 238 which fires on START not on COMPLETE).

### L-4. `looksLikeIp` regex `/^[0-9a-fA-F.:]+$/` would match `:::` or `1.2`
- **File**: `src/lib/api-response.ts:89-91`.
- **Concern**: The regex is forgiving — it filters out the obvious
  garbage (`<<not-an-ip>>` style values) but matches structurally
  invalid IPs. For the cf-connecting-ip flow the `cf-connecting-ip`
  header is operator-trust under the flag, so a malformed value would
  pass through to downstream rate-limiters and audit logs.
- **Fix**: keep as-is for cost-effectiveness, OR import `net.isIP`
  from `node:net` and validate strictly. Cross-cutting with the
  security review lane — surface there too.

### L-5. `recomputeBucketsForMeasurement` chases pg-boss enqueues serially in a `for` loop
- **File**: `src/lib/measurements/rollups.ts:202-211`.
- **Concern**: Three `await enqueueRollupRecompute(…)` calls in a
  sequential for-of. Each is a small `boss.send`; total cost is
  bounded but unnecessarily serialised. `Promise.all` would cut the
  measurement-write critical path by ~2× per row.
- **Fix**: replace the for-of with `await Promise.all(ASYNC_GRANULARITIES.map(…))`.

### L-6. W4b `getMedicationCategoryLabel` falls back to `"medications.categoryOther"` for unknown categories
- **File**: `src/lib/medications/category-label.ts:39-40`.
- **Concern**: A new category landing in the Prisma enum without a
  matching i18n key would silently label as "Other." The category
  enum is owned by `MEDICATION_CATEGORY_VALUES` in
  `src/lib/validations/medication.ts`; the map in `category-label.ts`
  is the third source of truth (enum + i18n keys + label map). Same
  drift risk as H-2 / M-3.
- **Fix**: derive `MEDICATION_CATEGORY_KEYS` from the validation
  enum directly so adding a category to the enum forces a TS error
  if the key map is missed. Or vitest-assert
  `MEDICATION_CATEGORY_VALUES.every((v) => v in MEDICATION_CATEGORY_KEYS)`.

### L-7. Coach cascade fixture pins `COACH_SURFACES.length).toBe(6)` but doesn't enumerate all gates the codebase carries
- **File**: `src/lib/feature-flags/__tests__/coach-cascade.test.tsx:205-215`.
- **Concern**: The codebase has 9+ `flags.coach` gate sites
  (`app/targets/page.tsx`, `layout-coach-mount.tsx`,
  `layout-coach-fab.tsx`, `suggested-prompts.tsx`, `hero-strip.tsx`,
  `coach-launch-button.tsx`, `target-card.tsx`, and the implicit
  ones inside coach-panel/*). The fixture pins 6 surfaces and the
  comment correctly notes that cross-cut gates are owned by other
  invariants — but a contributor adding the 7th DIRECTLY-MOUNTED
  Coach surface (not a sub-page) won't be reminded by this test to
  also extend `targets-coach-mount.test.tsx` or `target-card.test.tsx`.
- **Fix**: either keep the count fixture and add a check that walks
  the file tree for `flags.coach` occurrences (a glob inside the
  test that asserts known-gate-sites set parity), OR document the
  full gate inventory in a sibling .md so the count's intent is
  discoverable. The cheap fix is to bump the comment to enumerate
  which 9+ gates exist and which 6 the fixture covers.

### L-8. Analytics route's hard-coded UTC-tz fallback in `bp-in-target-fast-path` 396-day window doesn't honour leap years
- **File**: `src/lib/analytics/bp-in-target-fast-path.ts:149-151`.
- **Concern**: `readSince = now - 396 * 24h`. For windows that span
  a leap year, 396 days is 1 day shy of the intended priorYear span.
  Trivia; below the n=20 surface gate it never matters.
- **Fix**: ignore unless someone files a bug.

## Confirmed clean

- **W2 fast-path helpers** (`bp-in-target-fast-path.ts`,
  `correlations-fast-path.ts`, `health-score-fast-path.ts`) — well
  factored, each carries a dedicated unit test, the path-selection
  contract is symmetrical across the three, the annotate emissions
  let prod logs prove the branch selection. Cross-checked the
  `isFullyCovered` gating + the per-type membership check; both fire
  correctly. Modulo the cross-tz finding (H-3, M-4) the helpers are
  ready to ship.
- **W3 intake-history fix** — server-side `status` filter + the V2
  list's `STATUS_FILTER = "completed"` pinning are coherent, the
  status enum on the validator is bounded, the cache key includes
  the filter so two consumers asking for different filters don't
  collide. Empty-state copy ("Noch keine Einnahmen erfasst" / "Open
  daily intake") reads correctly even for a medication that has only
  planned-not-taken rows — those are precisely what `completed`
  excludes, and the CTA routes back to `/medications` which is the
  surface where the user logs the missing intakes.
- **W4b symmetry** — the shared `window-status.ts` +
  `category-label.ts` helpers carry well-shaped generic constraints
  (`Schedule extends ScheduleWindowInput`) so any schedule shape
  with the three minimal fields rides the same logic. Test pin in
  `medication-card-symmetry.test.tsx` checks both card variants
  emit the same status pill + label across the GLP-1 and generic
  surface. No semantic drift between the two callers after the lift.
- **W5 coach cascade** — every directly-mounted Coach surface in
  `HeroStrip`, `SuggestedPrompts`, `CoachLaunchButton`,
  `LayoutCoachFab`, `LayoutCoachMount`, `/targets` page,
  `TargetCard` carries an explicit `flags.coach` short-circuit
  before any DOM emission. The fixture's contract (no `data-slot=
  "coach-*"` paint when the flag is off) is enforced via a regex
  grep over the SSR output that's narrow enough to flag a regression
  but generic enough to catch any new `coach-*` mount.
- **W6 cf-connecting-ip env flag** — `TRUST_CF_CONNECTING_IP=1`
  default-off is the correct fail-closed posture for a self-hosted
  deployment without Cloudflare. The first request after a deploy
  before the env is wired returns `null` (when no XFF / x-real-ip
  is present) and the IP-keyed callers fall back to the literal
  `"unknown"` bucket — same shape as the pre-v1.4.37 behaviour.
  No regression risk.
- **W7a Arztbericht hero card** — clean lift, the
  `DoctorReportDialog` mount + submit flow is unchanged, the new
  visual treatment matches the Insights hero strip token-for-token.
- **W7b medication-intake quick-add** — solid `ResponsiveSheet`
  wiring with the footer-portal pattern shared with `MoodForm` /
  `MeasurementForm`. Only callout is the dose-input UX (M-2).
- **W7c list-view groupBy / drill-down API contract** — except for
  H-1 (DST window math) the route surface, the validation schema,
  and the synthetic `id: "day:…"` row IDs are coherent. The
  per-sample `dayKey=…` branch round-trips with the collapsed-row
  `dayKey` field so the chevron disclosure target is unambiguous.
- **W-CI** — vitest timeout signature fix, integration mock isolation,
  e2e 40→44px touch-target updates, and the onboarding-checklist
  toggle 44px floor are all correct and the underlying touch-target
  audit assertions remain valid.
- **rollup-coverage probe** + `isFullyCovered` + the per-type
  `coverage.get(type)` checks across the three fast-path helpers —
  the single-probe-per-request fan-out is the right pattern and
  the helpers all read from the same map shape.
