# Changelog

## [1.4.34.1] — 2026-05-16 — Insights cold-mount perf hotfix + scatter-card sizing

Hotfix on top of v1.4.34. The Insights page mount was paying ~29 s on
every cold load against accounts populated by the v1.4.34 Apple Health
importer. Root cause: `/api/insights/comprehensive` walked the unbounded
90-day measurement set into JS, then ran per-type `summarize()`, BMI,
blood-pressure classification, target adherence, and four Pearson
correlations from the same pile of rows. On a 100 000+ row account the
route consumed one of the 20 pool connections for the whole 29 s, which
cascaded sibling endpoints into Cloudflare "no available server" 503s.
The scatter-correlation card also surfaced a `width(-1)/height(-1)`
Recharts warning on first paint because its dynamic-mount lacked a
non-zero floor before aspect-ratio resolved.

### Changed

- `/api/insights/comprehensive` now reads through a SQL-side aggregator
  (`src/lib/insights/comprehensive-aggregator.ts`) that groups by metric
  type with Postgres-native `AVG` / `MIN` / `MAX` / `REGR_SLOPE` /
  `REGR_R2` on the `measurements (user_id, type, measured_at)` index
  path. Returns the same `DataSummary`-shaped per-type bundle the legacy
  route stitched together; the medication-compliance block keeps its
  bounded Prisma reads — those were already on the safe path. The route
  is wired through the server cache keyed on `${userId}|comprehensive`
  (60 s TTL) so the second consumer inside the window resolves on a
  `Map.get()` instead of re-running the aggregate. Witnessed wall-time:
  the cold path drops from ~29 s to a few hundred milliseconds against
  a fixture matching the production volume that triggered the bug; the
  warm path resolves in single-digit milliseconds.
- Cache-wrap the five remaining read routes the v1.4.34 server-cache
  blueprint left staged but unwired: `/api/mood/analytics`,
  `/api/workouts`, `/api/bugreport/status`, `/api/medications`,
  `/api/dashboard/widgets`. All five sit on `caches.*` instances already
  provisioned by the v1.4.34 IW-G primitive; each handler now reads
  through `cached(...)` and benefits from the existing per-user
  invalidation matrix (`invalidateUserMeasurements`,
  `invalidateUserMood`, `invalidateUserMedications`,
  `invalidateUserDashboardWidgets`, `invalidateAppSettings`). The
  Cloudflare 503 cascade on `/api/measurements?aggregate=daily` resolves
  as a downstream consequence — once the comprehensive route stops
  monopolising the pool, the origin accepts new connections fast enough
  that Cloudflare's origin-fail circuit-breaker no longer trips.

### Fixed

- Scatter-correlation card no longer logs the Recharts
  `The width(-1) and height(-1) of chart should be greater than 0`
  warning on first mount. The wrapper now carries a `min-h-[180px]`
  floor that matches the loading skeleton so `ResponsiveContainer`
  always measures a non-zero parent before aspect-ratio settles.

## [1.4.34] — 2026-05-17 — Apple Health import + reliability + web freeze

The final functional web release before the iOS native client lands.
Headline work: a streaming Apple Health `export.zip` importer for
prospective iOS-migrating accounts, a server-side aggregation cache
that collapses the three hottest dashboard reads onto in-process LRU
slots with single-flight coalescing and per-user invalidation, a
broader compliance classifier with a dedicated `early` bucket so
ahead-of-window doses count as compliant, the Coach launch surface
hoisted onto every authed page with a dashboard-hero CTA, and a
trimmer Settings shelf that folds Sources into Targets. The release
also lights up the `cache.<name>.outcome` annotation on the active
wide event so production logs carry the cache hit-ratio signal
without leaking userIds.

### Added

- **Server-side aggregation cache.** A new `ServerCache<T>` primitive
  (`src/lib/cache/server-cache.ts`) extends the v1.4.33 Coach snapshot
  LRU shape into a reusable per-route layer with TTL expiry,
  capacity-bounded LRU eviction, single-flight read coalescing, and
  per-instance hit / miss / eviction / stampede counters. Wires the
  three hottest dashboard reads — `/api/analytics` (slim + default),
  `/api/gamification/achievements`, `/api/medications/intake?scope=compliance`
  — and bolts per-user invalidation onto every measurement / mood /
  medication / workout / dashboard-widget write endpoint so the next
  read paints fresh data instead of waiting out the TTL. Every cache
  hit / miss surfaces on the active wide event as
  `cache.<name>.outcome` + `cache.<name>.key_hash` so production logs
  carry the hit-ratio signal without leaking userIds.
- **Apple Health `export.zip` import.** New endpoint
  `POST /api/import/apple-health-export` (synchronous multipart
  upload, asynchronous ingest via a dedicated pg-boss
  `apple-health-import` worker, per-`MeasurementType` ingestion
  stats). Streams the upload straight to disk so a multi-gigabyte
  export never lands in V8 heap, hashes the bytes inline for
  content-based idempotency, and unpacks `apple_health_export/export.xml`
  with a hand-rolled ZIP central-directory walker that handles Zip64
  for archives past the 4 GB barrier. The parser folds every
  `<Record>`, `<Workout>`, `<Correlation>`, and `<ClinicalRecord>`
  into the existing `Measurement` and `Workout` row shapes — spot
  rows keyed by `HKMetadataKeyExternalUUID` (or a deterministic
  `sample:<sha256>` fallback), cumulative HK types collapsed into
  one `stats:<HKType>:<YYYY-MM-DD>` row per user-local day to match
  the iOS daily-aggregation convention. Live per-stage progress
  surfaces through `GET /api/import/apple-health-export/{jobId}/status`.
  An admin variant at `POST /api/admin/import-apple-health-export`
  imports on behalf of a target user (cookie-only `requireAdmin()`
  gate; Bearer tokens never elevate).
- **`ImportJob` schema model + migration.** New Prisma model captures
  the per-upload state machine (`queued | unpacking | parsing |
  upserting | done | failed`), the content-hash for idempotency
  short-circuits, and the per-`MeasurementType` ingestion counters
  the status route surfaces back to the client.
- **`lastSeenByType` on `/api/analytics`.** Both the slim
  (`?slice=summaries`) and default slices return a per-type
  `{ lastSeenAt, daysAgo }` map. The dashboard trend tiles wire 12
  mounts to a new `tileStaleDays()` helper so an "X days / weeks /
  months ago" hint paints under any per-metric tile whose last
  sample crosses the 7-day floor. Six locales gained additive
  week / month plural keys; Polish uses the genitive-plural form
  that covers every non-1 count the bucket math can produce.
- **Dashboard "Ask the coach" hero CTA.** A new pill next to the
  existing "Hinzufügen" / "Add" launches the Coach drawer directly
  from the dashboard hero. The `<CoachLaunchProvider>` hoisted from
  the insights layout to the auth shell so the drawer is reachable
  from every authed route; the floating action button stays scoped
  to `/insights/**` so it cannot distract on the dashboard.
- **Shared achievements query hook.** `useAchievementsQuery()`
  centralises the three previous consumers — recent-achievements
  card, the `/achievements` mother page, and the unlock notifier —
  onto one TanStack queryKey + cache slot so dashboard cold mount
  fires the endpoint once instead of twice.
- **Typed authed Cache-Control presets.** New
  `src/lib/http/cache-headers.ts` module exports
  `NO_STORE_BUT_BFCACHE = "private, max-age=0, must-revalidate"`,
  `SHORT_LIVED_PUBLIC`, and an `applyAuthedHeaders()` helper. The
  presets land at the framework level via a `next.config.ts`
  `headers()` rule that stamps the bfcache-friendly directive on
  every authed HTML response, restoring Chromium bfcache eligibility
  for in-app back / forward navigation.
- **`scripts/print-bundle-report.mjs`.** Restores the at-a-glance
  "top client chunks by parsed size" signal Turbopack dropped from
  `next build`; reads `.next/analyze/client.json` (written by
  `@next/bundle-analyzer` when `pnpm analyze` runs with `ANALYZE=1`)
  and prints a sorted table plus totals.

### Changed

- **Settings sidebar: "Sources" folded into "Targets & Sources".**
  Per-metric threshold ranges and per-metric source priority now
  share one `/settings/thresholds` page so the same metric's
  threshold and device-source preference sit together instead of
  one sidebar entry away. `/settings/sources` keeps a
  `permanentRedirect` so external bookmarks and docs links follow
  through unchanged. Section count: 11 → 10.
- **Insights tab strip: vital pills collapse under a "Vitals"
  parent.** Five vital pills (HRV, Resting HR, Oxygen, Body
  Temperature, Active Energy) hide behind one parent pill that
  opens a popover sub-list. Parent-pill active state mirrors the
  URL so spatial orientation survives the collapse; each sub-page
  keeps its own URL and bookmark resolves unchanged. Strip
  footprint: 14 → 10 entries when every metric has data.
- **Coolify env-var audit.** `mcp__coolify-apps01__env_vars`
  inspection captured the section-1 / section-2 duplicates that
  have accumulated under apps-01 since v1.3.1. Audit pinned at
  `.planning/round-v1434-iwa-coolify-env-audit.md`; no env-var
  deletes performed (operator action).

### Fixed

- **Compliance classifier: early intakes count as compliant.** The
  classifier picked up a dedicated `early` bucket (window-start
  minus three hours through window-start), the `on_time` post-window
  tolerance widened from one hour to three hours, and the `late`
  band sits between the new `on_time` ceiling and the configurable
  `lateMinutes` knob. Heatmap consumers route the new bucket
  through the compliant path; the dedicated `early` counter rides
  on `DailyComplianceEntry` for downstream consumers that want to
  distinguish ahead-of-window from on-window intakes.
- **Compliance heatmap fallback retired.** The v1.4.33 defensive
  `looksClassifierBug` fallthrough is gone now that the underlying
  classifier widening removes the every-dose-very-late mode the
  fallback covered.

### Performance

- **`/api/gamification/achievements` consumer collapse.** Two of
  three previous consumers shared the same TanStack queryKey
  literal; the third carried a per-user discriminator so the cache
  treated it as a fresh slot. Dashboard cold mount fired the
  endpoint twice. Collapsing onto the shared hook trims that to a
  single request; with the new server-side cache slot warm, the
  duplicate-mount worst case rides single-flight coalescing.
- **GHCR build fires once per release tag.** The
  `docker-publish.yml` workflow lost its `push.branches: [main]`
  trigger; the `:latest` raw-tag enable rule moved onto the tag
  ref so each release produces exactly one multi-arch build that
  refreshes both the semver tags and the `:latest` alias.
- **NFT-trace warnings silenced.** `next.config.ts` gained an
  `outputFileTracingExcludes` block that narrows the Turbopack
  tracer away from the `MAXMIND_LICENSE_KEY` env-access path so
  the trace-report no longer warns on every dependent route file.

### Refactor

- **Dashboard analytics consumers.** The two cards that previously
  decided their own freshness copy now lean on the typed
  `tileStaleDays()` helper and the additive `lastSeenByType` field
  on the analytics response. Mood and BD-Zielbereich tiles keep the
  default `null` because they have no underlying per-type freshness
  signal.

### Accessibility

- **Dashboard hero CTA hits the WCAG 2.5.5 touch-target floor.**
  The new "Ask the coach" pill carries `min-h-11` on mobile and
  the matching `sm:min-h-9` desktop floor so the touch target
  stays above 44 px on the Pixel 5 boundary.
- **Insights tab-strip Vitals parent reads correctly to assistive
  tech.** Parent pill carries `aria-current="page"` whenever the
  current URL matches one of its child vital sub-pages, plus a
  `data-slot="insights-tab-strip-group"` hook for visual-regression
  testing.

### Internal

- **Two e2e flake windows tightened.** `onboarding-flicker` swapped
  its 12-sample 50 ms poll loop for a single Playwright
  auto-retrying `toBeHidden({ timeout: 700 })` assertion so the
  1-2 ms race window between the analytics-pending shell and
  `useAuth().user` resolving collapses to a single retry slot.
  `mobile-viewport` dropped `nav a[href]` from the touch-target
  sweep (the bottom-nav owns its own WCAG spec) and gated the
  44-px floor on `matchMedia('(min-width: 640px)').matches === false`
  so the Pixel 5 viewport never tripped into the `sm:` tier during
  WebKit render commits.
- **Server-cache observability.** Every `cached()` invocation passes
  an `annotate` callback that lands two keys on the wide event:
  `cache.<name>.outcome` ∈ `{ hit | miss | stampede }` and
  `cache.<name>.key_hash` (non-reversible djb2 32-bit hash). Ops
  can grep `cache.analytics.outcome` over any time window to
  compute the hit ratio per deployment.
- **AASA followups verified.** The v1.4.33 `/.well-known/apple-app-site-association`
  handler serves a direct 200 on every fronting origin; Apple's
  CDN has ingested matching bodies for all three domains.

### Web freeze

v1.4.34 marks the last functional release of the web codebase before
the iOS native client launches. Subsequent v1.4.x tags carry security
fixes, dependency bumps, and hotfix-only corrections. New feature work
is paused until the iOS app clears Apple review, at which point a
v1.5.0 version-bump-only release tags the milestone. The Prisma
schema head comment and `.planning/v15-strategic-plan.md` §5
decision-log row pin the freeze trigger in-tree.

## [1.4.33] — 2026-05-17 — Polish and reliability

Quality-leap release between two HealthKit milestones. The headline is
a P0 hotfix for the `/api/analytics` 500 that broke the Insights
mother page for any account with more than a few thousand
measurements: the six per-metric status helpers were spreading
the entire numeric history into `Math.min` / `Math.max`, which
trips a stack overflow once a single argument list exceeds the V8
spread cap. Both the surfaced symptom and the latent risk in five
sibling helpers were folded onto a reduce-based min/max path.
Around that hotfix landed a deep polish pass: the Insights mother
page now defers three below-the-fold blocks behind `next/dynamic`
to trim the cold mount cost, the analytics endpoint gained a
`?slice=summaries` slim slice that the per-metric sub-pages now
ride, the Coach snapshot builder picked up a 60 s LRU keyed on
`(userId, scope)`, the Settings shell consolidated three
duplicate copies of the about / notifications / about-dropdown
surfaces, the navigation strip dropped a redundant "Home" group
label and a colliding "Notifications" sibling, every icon-only
button on the medications and admin surfaces gained an accessible
name, every Progress bar gained one too, three pages had their
heading hierarchy repaired to a sequential `h1 → h2 → h3`, the
mobile Coach FAB now hides while a chart tooltip is open so it
cannot occlude the read-out, and the auth shell normalised every
authenticated route to a single `max-w-screen-xl` container. The
release closes nineteen issues from a five-surface audit + a
runtime bug-hunt pass, plus six follow-up tracks of polish across
the affected surfaces.

### Added

- **Slim `/api/analytics?slice=summaries` slice.** Per-metric
  sub-pages opt into a payload that drops `correlations` +
  `healthScore` + `medications` blocks, cutting the cold-mount
  response on those routes by roughly half. The mother page stays
  on the default thick slice so the correlation row + health
  score badge still resolve from the same cache key.
- **`useScrollResetOnRoute()` hook.** Single source of truth for
  the route-change scroll-to-top behaviour, replacing per-page
  `useEffect` duplicates across seven mounted surfaces.
- **`<SettingsCardHeader>` primitive.** Extracted from three
  near-duplicate copies inside the Settings shell so future
  section additions inherit the icon / title / description
  treatment without redeclaring the markup.
- **Apple App Site Association handler.** `/.well-known/apple-app-site-association`
  now answers 200 with `application/json` on every host that fronts
  the app, advertising the iOS bundle's App ID prefix
  (`S8WDX4W5KX.dev.healthlog.app`) under `webcredentials.apps` so the
  passkey ceremony shares cleanly between the web origin and the iOS
  app. The proxy gained a `/.well-known/` public-prefix entry so the
  Apple CDN fetch lands on the asset instead of the auth gate.

### Changed

- **Insights mother page deferred below-the-fold blocks.** Daily
  briefing, correlation row, and trends row now resolve through
  `next/dynamic` with skeleton fallbacks that match the existing
  loading shape. Above-the-fold hero stays an eager import so the
  initial paint shows the greeting + health-score badge without
  a flash.
- **Settings section renamed.** "Notifications" became
  "Notification channels" (German: "Benachrichtigungs-Kanäle") so
  it no longer collides with the inbox at `/notifications`
  ("Notification Center" / "Benachrichtigungs-Center").
- **Settings Auswertungen section renamed.** The German label
  "KI-Auswertungen" became "Auswertungen" in user-facing copy
  per the long-standing rule that user-facing surfaces drop the
  model-vendor prefix.
- **Insights tab strip regrouped by metric category.** Pills now
  cluster vitals / cardiovascular / activity / wellbeing so
  long-strip scrolling lands on a related neighbour.
- **About section folded into the user-card dropdown.** The
  in-shell Settings nav no longer surfaces an "About" entry; the
  sidebar user-card dropdown now owns the "About HealthLog" link.
  Route `/settings/about` still resolves for direct links.
- **Auth shell container width normalised.** Every authenticated
  route now renders inside a single `max-w-screen-xl` container,
  retiring three competing widths that drifted across the
  Insights / Settings / Dashboard surfaces.
- **Card defaults normalised.** Every card now defaults to
  `p-4 md:p-6` padding so mobile + desktop spacing stay in lock
  step without per-instance overrides.

### Fixed

- **`/api/analytics` 500 (P0).** Stack overflow from
  `Math.min(...values)` / `Math.max(...values)` spreads on long
  histories. Hotfixed on the surfaced helper and folded across
  the six sibling status helpers.
- **Spotlight onboarding tour intercepted dashboard clicks.**
  Overlay z-index + pointer-events combination meant the first
  post-completion tap landed on the dimmed overlay instead of
  the tile underneath.
- **BP chart Y-axis unit.** Read "Hg" instead of "mmHg".
- **Bottom nav viewport overlap.** Hardened against the
  last-line clip on shorter viewports.
- **`/insights/puls` subtitle.** Read "Ruhepuls" instead of
  "Puls".
- **Weight chart duplicate Y-axis ticks.** Tick generator emitted
  the same value twice on narrow domains.
- **Web-vitals beacon self-throttling.** Beacon was sampling at
  full rate and tripping its own queue cap; sample rate dropped
  to 10% so RUM telemetry actually reports.
- **Medication compliance classifier flushing every dose to
  `very_late`.** Defensive fallback when the dose-window
  estimator can't resolve a window.
- **`/api/insights/generate` POST gating.** Endpoint now refuses
  on a disabled assistant master flag instead of returning a
  500.
- **Mood Log overflow on narrow viewports.** Cards no longer
  shred their internal grid below 360 CSS px.
- **F13 username readability.** Header username now respects
  contrast tokens on the dark theme.
- **F14 mobile bottom-nav padding.** Bottom nav no longer
  vertically clips its second row on the smallest mobile
  viewport.
- **F17 threshold toggle parity.** Settings threshold toggles
  now reflect their server-side enabled state on mount instead
  of always opening on.
- **Notifications section redundancy.** Three near-duplicate
  status surfaces collapsed onto one.
- **Insights coach-rail labels.** Promoted to semantic `<h3>`
  headings so the accessible-name tree resolves consistently.
- **Heading hierarchy on three surfaces.** Repaired non-sequential
  `h1 → h3` jumps so the accessible-name tree resolves with the
  expected nesting.
- **Icon-only buttons on the medications page.** Every icon
  button gained an accessible name; same sweep on the admin
  feedback inbox and reminders surface.
- **Progress-bar accessibility.** Every `<Progress>` instance now
  carries an accessible name so a screen-reader pass reads the
  metric label rather than a bare percentage.
- **Button loader CLS.** Buttons now reserve space for the
  in-flight loader so the surrounding layout doesn't shift when
  a request lands.
- **Mobile Coach FAB occlusion.** FAB auto-hides while any chart
  tooltip is open so it cannot cover the read-out.
- **Settings mobile section strip.** Scroll-snap on the
  horizontally scrollable strip so the active pill always lands
  on the leading edge.
- **Passkey breakpoint.** Passkey card no longer clips its
  internal grid on the tablet breakpoint.
- **Settings tile padding parity.** Every settings tile reads
  `p-4 md:p-6` after the card-default normalisation.
- **Sidebar "Home" group label.** Redundant collapsible label
  dropped from the desktop sidebar; the four nav entries now
  live at the top level.
- **Legal-page narrow column convention.** Pinned in code
  comments so a future refactor doesn't widen the privacy /
  imprint / terms pages back out.

### Performance

- **Coach snapshot builder LRU cache.** 60 s TTL keyed on
  `(userId, scope)` keeps repeat Coach drawer opens within a
  short window off the snapshot-build path.
- **Assistant flags memoised per request.** Resolver lookup was
  re-running per surface mount on the Insights cold path.
- **Web-vitals sample rate dropped to 10%.** Stops the beacon
  from self-throttling under high-traffic load.

### Refactor

- **`Math.min` / `Math.max` spread folds.** Six per-metric status
  helpers now reduce instead of spread, retiring the latent stack
  overflow path that surfaced as the P0 above.
- **Scroll-reset consolidated.** Seven per-page `useEffect`
  duplicates retired behind `useScrollResetOnRoute()`.
- **Settings card header consolidated.** Three near-duplicate
  header markups retired behind `<SettingsCardHeader>`.

### Accessibility

- **Icon-only buttons named** on the medications page + admin
  feedback inbox + admin reminders surface.
- **Progress bars named** across the app so the accessible-name
  tree exposes the metric label.
- **Heading order repaired** on three surfaces so the
  accessible-name tree nests correctly.
- **Coach rail labels** promoted to semantic `<h3>` headings.

### Internal

- **Retired** the now-orphan `settings.kiInsights` locale key
  after the Auswertungen section rename, the
  `AssistantDisabledNotice` component, and the dead
  `settings.placeholder` locale entries left behind by earlier
  releases.
- **Test fixtures** aligned with the renamed Insights /
  Notifications / Settings surfaces; the import-string scan on
  the Insights mother page now accepts both eager and
  `next/dynamic` spellings.

## [1.4.32] — 2026-05-17 — HealthKit Tier 1 wave A

First public surface wave for the HealthKit Tier 1 metrics that
the iOS contributor brief locked in for v1.5. The headline item
is a workouts flow that lands end-to-end on the web: a list page
at `/insights/workouts`, a detail page with route preview and
summary stats, and a dashboard tile that surfaces the three most
recent sessions. Alongside the workouts surface arrives a family
of five new metric sub-pages — HRV, resting heart rate, blood
oxygen, body temperature, and active energy — each carried by a
shared scaffold so adding the next HealthKit metric is a four-line
page module. The release also cleans up two latent issues uncovered
during the wave-A audit: the workouts list endpoint had a Prisma
field-name bug that would have produced a 500 the moment a real
client called it, and HRV plus resting heart rate were sitting
in the `vitals` insight bucket where they did not belong.

### Added

- **Workouts API.** `GET /api/workouts` returns a paginated list
  shaped to the iOS contract (`distanceM`, `activeEnergyKcal`,
  `avgHr`, `maxHr`) using the v1.4.30 canonical-row picker;
  `GET /api/workouts/{id}` returns a single workout with the same
  field shape. Both endpoints honour `requireAuth()` and respect
  the existing per-user isolation guarantees.
- **`/insights/workouts` list page.** Browsable workout archive
  with newest-first ordering, type-filter pills, and an
  Apple-Health-onboarding hint when the list is empty.
- **`/insights/workouts/[id]` detail page.** Per-workout view
  with summary tiles (duration, distance, energy, average and
  max heart rate), an inline-SVG route preview when GPS samples
  are present, and a graceful-unavailable notice for per-second
  HR samples.
- **Dashboard recent-workouts tile.** New widget id
  `recentWorkouts` defaults to visible and surfaces the three
  most recent sessions on the home page. Self-gates on a
  non-empty list and renders an Apple-Health-onboarding hint
  otherwise.
- **Five HealthKit metric sub-pages.** New pages at
  `/insights/hrv`, `/insights/ruhepuls`, `/insights/sauerstoffsaettigung`,
  `/insights/koerpertemperatur`, and `/insights/aktive-energie`,
  each rendered through the shared `<HealthKitMetricPage>`
  scaffold with its own chart-cog popover state slot. Body
  temperature surfaces the existing manual-entry CTA; the other
  four intentionally render their empty state without a primary
  action because the Apple Health / Withings ingest is the only
  path for those metrics.
- **Insights tab-strip pills.** Six new pills (workouts plus the
  five HealthKit metrics) join the strip and self-gate on data
  presence, so brand-new accounts still see the seven pre-existing
  pills only.

### Changed

- **HRV + resting HR realigned to the cardiovascular bucket.**
  Both metrics moved out of `vitals` into `cardiovascular` to
  match the iOS handoff brief's category table. The insight
  bucket map, the per-metric status card grouping, and the
  comprehensive narration all read the new placement; no client
  contract changes because the bucket only drives in-app
  grouping.

### Fixed

- **Latent 500 on workouts list endpoint.** The list query
  referenced two non-existent Prisma columns (`distanceMeters`
  and `energyKcal`); tests mocked Prisma with `as never` so the
  bug never surfaced in CI. The endpoint now uses the v1.4.30
  `pickCanonicalWorkoutRows()` helper and projects the iOS
  contract field shape end-to-end.

## [1.4.31] — 2026-05-16 — Operator toggles + insights tab-strip + Coolify auto-deploy fix

Three orthogonal patches in one release. The biggest item is a
per-surface operator toggle matrix that lets the maintainer carve
which model-driven surfaces stay visible without removing the
provider configuration — Coach, Daily Briefing, per-metric status
cards, correlations, and the Health-Score delta explainer each
get an admin switch, plus a master kill-switch above them all.
Alongside that lands the root-cause fix for the /insights
tab-strip blocking on mobile: an abort timeout on the advisor
fetch, a `React.memo` on the strip with its `availability` prop
memoised in the layout shell, and a lazy-loaded Coach drawer
collapse the worst-case tap-block window from the LLM-completion
tail down to the bounded parallel-fetch window. The release also
closes the long-standing Coolify auto-deploy race: five releases
in a row the webhook reported "finished" but Coolify still
pulled the prior `:latest` digest because the publish workflow
fired the webhook inside GHCR's CDN propagation window; a 90 s
sleep before the trigger step lands inside the existing
`continue-on-error: true` envelope.

### Added

- **Assistant-surface operator toggles.** Six boolean columns on
  `AppSettings` (`assistantEnabled` + five sub-flags) carve the
  visibility cut for every model-driven surface. Master forces
  every sub-flag false in the resolver, so a single flip kills
  the whole assistant. New admin panel at
  `/admin/assistant` (slug between `ai-quality` and
  `coach-feedback`) renders the six toggles; sub-toggles grey out
  when the master is off. Defaults preserve the v1.4.30 behaviour
  (every surface visible) so upgrades require no admin action.
- **`GET /api/feature-flags`.** Projects the matrix over HTTP for
  every client — web React tree + iOS native. `requireAuth()`
  gates the route, `Cache-Control: private, max-age=60` caps the
  read cost on the hot /insights mount path.
- **`PUT /api/admin/settings/assistant-flags`.** Dedicated admin
  write surface that echoes both the raw column values and the
  resolved (master-killed) shape. Optimistic UI on the admin
  panel; the runtime feature-flag cache invalidates on every
  write so toggled surfaces react within the same operator
  session.
- **`<AssistantDisabledNotice>` component.** Small inline notice
  for callers that resolve a 403 +
  `errorCode: "assistant.disabled.<surface>"` from the server.
  Localised in all six locales.
- **`useFeatureFlags()` hook.** Fails open — any network error
  or absent `<QueryClientProvider>` returns the all-on default so
  the user never loses an affordance to an instrumentation gap.

### Fixed

- **Insights tab-strip blocking on mobile.** Three orthogonal
  client-side fixes per
  `.planning/research/v15-insights-blocking-bug.md`:
  - `fetchAdvisor` gets an 8 s `AbortController`; `AbortError`
    falls through to the existing graceful-null return path so the
    UI surfaces the regen CTA instead of pinning the query in
    `isFetching: true` for the LLM tail.
  - `<InsightsTabStrip>` is `React.memo`'d, the inner `buildTabs`
    call is `useMemo`'d on `availability`, and the layout shell
    memoises the `availability` prop on its three leaf inputs.
    Together they collapse the
    "shell re-renders → strip re-renders → 8 pills re-render"
    cascade on every cache-write of analytics or comprehensive.
  - `<CoachDrawer>` is now lazy-loaded via `next/dynamic` so the
    SSE machinery, chat reader, suggested-prompts rail, and
    settings sheet don't initialise on every cold /insights mount.

### Changed

- **Server-side gating of assistant endpoints.** Every
  LLM-driven endpoint now reads the operator flag set near the
  top of the handler and throws a typed `AssistantDisabledError`
  when the relevant surface is off. The api-handler catches the
  error and returns 403 +
  `meta.errorCode: "assistant.disabled.<surface>"`. Older
  clients without the errorCode see a generic 403; v1.4.31+
  clients render the `<AssistantDisabledNotice>` empty state.
  Gated endpoints:
  `/api/insights/chat` (coach),
  `/api/insights/generate` (coach),
  `/api/insights/comprehensive` (coach),
  `/api/insights/cards` (insightStatus),
  `/api/insights/correlations` (correlations),
  and the six `*-status` per-metric routes (insightStatus).

### CI

- **Coolify auto-deploy race fix.** `Trigger Coolify deploy`
  step in `.github/workflows/docker-publish.yml` now sleeps 90 s
  before firing so GHCR's CDN edges have time to propagate the
  fresh `:latest` digest. The webhook lands after the edge read
  catches up, Coolify pulls the new digest, and the running
  container recreates cleanly. Full root-cause + hypothesis
  matrix in
  `.planning/round-coolify-auto-deploy-fix-2026-05-16.md`.
- **OpenAPI pre-commit hook.** New `.githooks/pre-commit` runs
  `pnpm openapi:check` when the staged diff touches Zod schemas
  or API routes; on drift it regenerates the spec, re-stages the
  file, and continues the commit. Activated via the new
  `scripts/install-hooks.sh`. Skips in CI so the existing
  `security.yml` server-side gate stays authoritative.

### iOS contract

Every change is additive on the wire.

- `GET /api/feature-flags` is net-new. iOS clients that predate
  it never call the endpoint and see the all-on default
  implicitly.
- The six `AppSettings.assistant*` columns default to `true` in
  the migration so existing rows pick the defaults up without
  data movement.
- The 403 +
  `meta.errorCode: "assistant.disabled.<surface>"` envelope is
  additive — pre-v1.4.31 iOS reads the 403 as a generic auth
  error and degrades gracefully through its existing 403
  handler. v1.4.31+ iOS reads the `errorCode` to render the
  surface-specific empty state.
- The locked-contract entry at
  `.planning/v15-ios-handoff/08-locked-contracts.md` §14
  documents the rule that the flag matrix gates BOTH
  server-routed AND on-device assistant surfaces. Apple
  Foundation Models on-device Coach + Briefing flows in the
  v0.6.0 iOS path honour the same flag matrix as the
  server-routed surfaces.

## [1.4.30.1] — 2026-05-16 — Categories endpoint + conflict-resolution lock

A two-item follow-up to v1.4.30. The categorisation overlay shipped
yesterday as a TypeScript map; the new `GET /api/measurement-categories`
endpoint projects it over HTTP so the iOS-side picker can fetch the
canonical shape rather than carry a hard-coded mirror — the
unblocker the iOS team flagged as the one missing piece. In parallel
the SyncMode conflict-resolution policy that the v0.6.0
standalone-first track depends on lands as §13 of
`08-locked-contracts.md`.

### Added

- **`GET /api/measurement-categories`.** Thin projection of
  `src/lib/measurements/categories.ts` over HTTP. Response carries
  `version: 1`, an ordered `categories` array with `labelKey`
  translation keys, and the `assignments` map keyed on
  `MeasurementType`. `requireAuth()` gates the route — any logged-in
  user passes — and `Cache-Control: public, max-age=600` enables a
  10-minute edge cache. Locked per
  `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R1.

### Documented

- **SyncMode conflict-resolution policy.**
  `.planning/v15-ios-handoff/08-locked-contracts.md` gains §13 per
  R9 of the iOS-team response doc. Hard-spec covers bulk-backfill,
  steady-state bidirectional sync via `(updatedAt, syncVersion)`
  optimistic concurrency, the 409 write-conflict + 410 Gone
  delete-conflict envelope shapes, the LWW-by-`updatedAt` resolution
  with server-wins on millisecond tie, and the
  `GET /api/sync/state` response. The "What is NOT in this file"
  stub renumbers to §14.
- **iOS contributor brief.** §3 bumps the live-production marker to
  v1.4.30 and adds the four v1.4.30 endpoints plus the new
  v1.4.30.1 endpoint to the iOS-consumable list. §5b / §6 reframe
  the Coach SSE story per R6 — the server endpoint stays live; the
  iOS native server-Coach drawer is deferred pending MDR Class-IIa
  pre-review. v1.5.0 iOS ships Apple Foundation Models on-device
  Daily Briefing + Trend Observations as the primary assistant
  surface.
- **v1.5 strategic plan.** §2 slots Apple Health XML import as
  v1.4.34 immediately before the web-freeze marker (per R2),
  detailing the multipart endpoint, the streaming XML parser, the
  async job model, the per-MeasurementType ingestion stats, the
  idempotent UPSERT on `externalId`, and the admin endpoint
  variant. Effort L (~3-4 days). The freeze trigger renumbers from
  v1.4.33 to v1.4.34; the decision-log row "Apple Health XML
  import slot" lands; the §4 deferred row and §6 open question #3
  close out.

## [1.4.30] — 2026-05-16 — iOS-coordinated foundation (Daily-Stats + SyncMode)

Server-side prep for the next iOS TestFlight build. Five surfaces
land together so the iOS engineer can pick them up in one cut-over:
a locked `externalId` shape for daily-aggregated cumulative
HealthKit rows, the SyncMode foundation columns + handshake +
bulk-backfill endpoints, a first-class `MoodEntry.note` column that
replaces the legacy `tags: ["note:<text>"]` workaround, a
cross-source workout dedup helper, and two new MeasurementType
enums (`WALKING_STEADINESS`, `AUDIO_EXPOSURE_EVENT`) plus the
shared `MEASUREMENT_CATEGORIES` overlay that drives the iOS
permission picker and the future Insights nav.

### Added

- **Daily-stats `externalId` helper.** `dailyStatsExternalId(hkId,
  date)` mints `"stats:<HKQuantityTypeIdentifier>:<YYYY-MM-DD>"`
  alongside the v1.4.29 `CUMULATIVE_HK_TYPES` set. The shape is
  locked in `.planning/v15-ios-handoff/08-locked-contracts.md` §12
  and `.planning/v15-ios-handoff/06-ios-responsibilities.md`. iOS
  emits one row per day per cumulative type via
  `HKStatisticsCollectionQuery`; the unique index collapses
  re-syncs idempotently, and a future PATCH-on-divergence call
  updates a late-watch-sync revision without inserting a second
  row.
- **Drain script + admin endpoint** at
  `scripts/drain-per-sample-cumulative.ts` and
  `POST /api/admin/drain-per-sample-cumulative` (gated by
  `requireAdmin()`, default `dryRun: true`). Collapses pre-Option-A
  per-sample APPLE_HEALTH cumulative rows into one row per day per
  type. Idempotent — re-running on a fully-collapsed account
  reports zero buckets touched.
- **SyncMode foundation.** Migration 0062 adds
  `Measurement.sync_version` (Int, default 1),
  `Measurement.deleted_at` (Timestamp, nullable) for soft-deletes,
  and `User.last_synced_at` (Timestamp, nullable). The new
  `GET /api/sync/state` returns the handshake response (lastSyncedAt,
  server clock, live + tombstoned counters); the call also bumps the
  checkpoint so iOS reads the OLD value then trusts subsequent
  writes via the standard read paths.
- **Bulk backfill endpoints.** `POST /api/mood-entries/bulk` and
  `POST /api/medications/intake/bulk` accept up to 500 entries per
  call with the same response envelope as the measurements + workouts
  batch. Probe-then-upsert distinguishes inserted vs duplicate on the
  mood path; idempotency-key collision yields duplicate on the
  intake path. Both rate-limited at 60/min/user.
- **`MoodEntry.note` column** (migration 0063). The bulk + single
  POST + PUT routes thread the new field through; the existing
  `tags: ["note:<text>"]` workaround backfills via
  `scripts/backfill-mood-note-column.ts` (CLI dry-run by default,
  `--confirm` commits).
- **`pickCanonicalWorkoutRows()`** at
  `src/lib/measurements/pick-canonical-workout-rows.ts`. Cross-source
  workout dedup symmetric to `pickCanonicalSourceRows()`. Buckets
  rows by 5-minute startedAt slot + sportType and walks the
  existing measurement source ladder; metric-aware tunes (route →
  Apple wins, HR zones → Withings wins) defer to v1.5.x.
- **`MEASUREMENT_CATEGORIES` overlay** at
  `src/lib/measurements/categories.ts`. UI-only category map
  (vitals / body / activity / sleep / hearing / environment /
  cardiovascular / metabolic) that drives the iOS HealthKit
  permission picker, the post-v1.5 web Insights nav, and the Coach
  evidence shelf chip-grouping. Completeness wall in the test suite
  catches a new MeasurementType lacking a category assignment.
- **Two MeasurementType enums** (migration 0064) —
  `WALKING_STEADINESS` (iOS 15+ Mobility daily rollup, ×100 scaled
  from Apple's 0..1 fraction) and `AUDIO_EXPOSURE_EVENT` (iOS 13+
  category flag fired when the rolling 7-day average crosses the
  WHO 80-dBA threshold; environmental + headphone events share the
  same enum value). The wiring registries (`apple-health-mapping`,
  `categories`, `pr-direction`, `chart-tokens`, six locale files)
  pick them up in the same release.

### Changed

- **Real-Postgres integration coverage expanded.** Every new
  endpoint introduced in v1.4.30 rides the v1.4.29 testcontainer
  fixture: the drain helper, the admin endpoint, the sync-state
  handshake, the mood-entries bulk upsert, the medication-intake
  bulk insert + idempotency-key collision, the mood-note column
  round-trip. Full integration suite at 47 files / 190 specs.
- **`HK_QUANTITY_TYPE_DEFERRED` trimmed.** Three identifiers move
  out of the deferred set into the mapping table:
  `HKQuantityTypeIdentifierAppleWalkingSteadiness`,
  `HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent`,
  `HKCategoryTypeIdentifierHeadphoneAudioExposureEvent`.

### iOS contract

Every API change is additive. The new endpoints
(`/api/sync/state`, `/api/mood-entries/bulk`,
`/api/medications/intake/bulk`,
`/api/admin/drain-per-sample-cumulative`) are net-new — no iOS
consumer yet. The SyncMode columns carry defaults so existing iOS
POSTs round-trip unchanged. The two new MeasurementType enums are
net-new values; iOS clients that predate the codegen pass will not
encounter them in read paths because no source writes them yet, and
the codegen path will pick them up on the next iOS regeneration.

**Cutover sequence.** v1.4.30 ships with the helper + drain script
+ server tolerance for both shapes. The next iOS TestFlight build
adopts `HealthKitStatisticsService.swift` and starts posting daily-
aggregated rows for the five cumulative types. Operator runs the
drain script once after the new TestFlight cuts over; per-sample
row pressure on `Measurement` drops 50-200× for cumulative types.

## [1.4.29.1] — 2026-05-16 — Daily-step aggregation hotfix

A one-line follow-up to v1.4.29. The dashboard 7-day step chart now
renders daily totals (sums in the thousands), not per-sample averages
(hundreds), matching the server-side `aggregate=daily` contract that
landed earlier today.

### Fixed

- **Client-side daily aggregator.** `health-chart.tsx` reduced every
  HealthKit type with `sum / count` regardless of whether the
  metric is cumulative or spot. The branch now consults
  `CUMULATIVE_HK_TYPES` and picks `sum` for steps, active energy,
  flights climbed, walking + running distance, and time in
  daylight, while the spot metrics (BP, weight, pulse, BG, body
  fat, mood, sleep) keep the mean.

### Tests

- The existing chart suite (137 specs) continues to pass; the
  one-line branch is exercised by the v1.4.29 server-side
  aggregation tests and needs no additional coverage.

## [1.4.29] — 2026-05-16 — Dashboard performance + chart polish

A targeted performance + polish patch. The headline is a faster
dashboard on data-rich accounts: the pulse chart drops up to ~5 000
raw rows per range tab in favour of one row per day, the duplicate
`/api/dashboard/widgets` fetch on every mount collapses to one, and
three long-running analytics reads are bounded to the trailing
window the tile path actually needs. Two production regressions
close — the `aggregate=daily|weekly|monthly` path on
`/api/measurements` 500'd for every grain, and the same path
averaged cumulative step counts instead of summing. Mobile chrome
gets a tighter rhythm: dashboard tiles pin to a single 140-px
contract at `<sm` and the Settings → Dashboard drag-list rows drop
from ~116 px to 48 px. X-axis tick density on numeric pulse + mood
charts comes back after Recharts was silently ignoring the legacy
`interval` policy on `type="number"` axes.

### Fixed

- **`aggregate=daily|weekly|monthly` on `/api/measurements`.** The
  endpoint returned HTTP 500 for every grain in production. Two
  root causes the mocked-`$queryRaw` suite hid end-to-end: the
  Postgres `date_trunc` unit was passed as a bound parameter
  (the function requires a SQL literal), and the `weekly` /
  `monthly` forms weren't mapped to the singular Postgres units
  (`week` / `month`). A new real-Postgres integration suite
  pins the contract.
- **Cumulative-type aggregation.** The same path averaged step
  counts instead of summing — five 1 000-step rows on the same
  day reported 1 000, not 5 000. `CUMULATIVE_HK_TYPES` covers
  `ACTIVITY_STEPS`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
  `WALKING_RUNNING_DISTANCE`, and `TIME_IN_DAYLIGHT`; the SQL
  picks `SUM(value)` for those and keeps `AVG(value)` for spot
  metrics (BP, weight, pulse, BG, body fat, mood, sleep).
- **Duplicate dashboard-widgets fetch on every dashboard mount.**
  `useChartOverlayPrefs` keyed under `["dashboard-layout"]`
  while the page + Settings + the rest of the codebase used
  `queryKeys.dashboardWidgets()`. Two cache slots, one endpoint,
  two requests per mount. Unified onto the shared key.
- **Numeric x-axis tick density.** Recharts ignores `interval`
  on `type="number"` axes. Pulse + mood charts silently lost the
  day-aware density policy after the v1.4.25 numeric-axis
  switch. A new `computeTickPositions` helper translates the
  legacy skip count into explicit `ticks` indices and clamps to
  a 3-12 visible-label range.
- **Mobile dashboard tile heights drift between siblings.** At
  `<sm` each tile took content height, so callout-on tiles grew
  taller than callout-off neighbours (glucose tiles especially).
  Pin a 140-px floor via the `--tile-h` CSS custom property at
  `<sm` and release back to `auto` from `sm:` upwards. The
  comparison-delta callout clamps to a single line; the sub-row
  pair switches to `flex-nowrap overflow-hidden` so a narrow
  tile cannot grow vertically.

### Changed

- **Settings → Dashboard drag-list rhythm.** The vertical 44 + 44 px
  arrow stack on each widget row dropped row height to ~116 px,
  three times the height of every neighbour on the Settings page.
  A horizontal arrow pair on the trailing edge (`size-11` on
  mobile preserves the 44-px tap target, `sm:size-9` on desktop)
  with `min-h-12` as the floor cuts each row to 48 px — 2.4×
  tighter. The widget label gains `truncate` + `title` so long
  names stay on a single line.

### Performance

- **Pulse chart payload.** Windows beyond seven days now ask the
  server for `aggregate=daily`. A 30-day pulse view drops from
  up to ~5 000 raw rows to at most 30 daily buckets; Recharts
  paint cost drops accordingly on continuous-monitoring accounts.
  Short windows (7 days) keep raw fetching so hour-by-hour detail
  stays visible.
- **`/api/analytics` read bounds.** The per-context glucose
  summaries walked every persisted `BLOOD_GLUCOSE` row a multi-
  year user had written. Bounded to the trailing 30 days the
  tile path consumes. Same shape for the BP-in-target chunked
  walk — passed no `since` bound even though
  `computeBpInTargetWindows`'s longest sub-window is `priorYear`.
  Bounded to the trailing 365 days.
- **Inline dashboard queries default staleness.** The three
  inline `useQuery` blocks on `/` shared no `staleTime` or
  `refetchOnWindowFocus` setting, so a tab-focus-and-return
  triggered an immediate refetch storm. A shared
  `DASHBOARD_QUERY_OPTS` lifts them to the 1-minute staleness
  cadence the chart queries already use, with
  `refetchOnWindowFocus: false`.

### Tests

- New integration suite
  `tests/integration/measurements-aggregate-daily.test.ts` hits
  the route against a real Postgres so every grain compiles +
  executes end-to-end. The mocked unit suite stays for the
  route-shape contracts.
- `computeTickPositions` gains six cases in
  `x-axis-density.test.ts`: sparse data emits every index, dense
  data clamps to 3-12 ticks, empty / single-point edge cases.
- `<HealthChart>` range test asserts the default 30-day window
  asks for `aggregate=daily` and the `windowOverride="last7days"`
  mini-chart does not.
- `<TrendCard>` mobile-tile-height contract pinned via a new
  snapshot test (`trend-card-tile-height.test.tsx`).

## [1.4.28.1] — 2026-05-16 — Dashboard-save hotfix

"Speichern" on the Dashboard works again for every account whose
layout was last persisted before v1.4.28. The v1.4.28 retire of the
`glp1` widget id left an orphan entry in `dashboardWidgetsJson` for
legacy users, which made the save validator reject the payload; the
resolver now filters unknown widget ids on read.

### Fixed

- **Dashboard save against legacy layouts.**
  `resolveDashboardLayout` in `src/lib/dashboard-layout.ts` drops
  widget ids that are no longer in the registry before returning
  the layout, so the `dashboardWidgetsJson` round-trip
  (`GET /api/me/dashboard` → user edit → `PUT /api/me/dashboard`)
  succeeds even when the persisted JSON still names `glp1` or any
  other retired widget.

### Tests

- `src/lib/__tests__/dashboard-layout.test.ts` gains a case for the
  retired-id filter (19/19 green).

## [1.4.28] — 2026-05-16

Bug-fix and consistency follow-through after the v1.4.27 mobile sweep.
The headline is a tighter dashboard and insights surface: six widgets
retire from code entirely (GLP-1 tile, dashboard `<DrugLevelChart>`
mount, GLP-1 detail-page intake history + inventory, the
`<InsightAdvisorCard>` block and its regeneration affordance, the
weekly-report route), four broken edges close (workout-edit duplicate-
timestamp 409, BD-Zielbereich tile rebuilt on the shared
`<TrendCard>` primitive, `/insights/puls` chart timeout fallback,
sticky tab-strip scroll lock), and one consistency contract lands per
maintainer directive: every medication-list row, every medication-
detail section header, every trend tile, every Coach launch glyph,
every chart-height contract reads on one shape. The HealthScore card
grows to fill its column, gains an accessible `?` tooltip explaining
the delta, and drops the placeholder "Wochenbericht erstellen"
button. iOS contracts are intact; the only `/api/*` evolution is
additive (the `aggregate=monthly` grain on `/api/measurements` and an
internal-only `/api/internal/web-vitals` beacon route).

### Removed

- **GLP-1 dashboard tile.** `src/components/dashboard/glp1-tile.tsx`
  and every reference (`dashboard-layout.ts` entry, the
  `dashboard.glp1.*` i18n keys, the test fixtures) retire. The tile
  is gone from `/`; the recovered vertical real estate flows to the
  trends row + HealthScore column.
- **Dashboard `<DrugLevelChart>` mount.** The standalone Drug-Level
  pane retired from `/`. The component itself stays — it serves the
  `/medications/[id]/history` page exclusively. The `compact` mode
  and `windowHoursBefore` override drop with the dashboard mount; the
  history-page recipe paints the chart inside
  `<MedicationDetailSection>` on the same heading scale as every
  other section on the page.
- **`<InsightAdvisorCard>` surface.** The "Persönlicher Berater"
  card at the bottom of `/insights` and its "Insights aktualisieren"
  regeneration button retire. The Coach drawer is the single
  assistant entry point. Component, mounts, test fixtures, i18n
  keys, and the cached-advisor query all retire together.
- **Weekly-report route.** `/insights/report/[week]` and the
  `<WeeklyReportBanner>` mount on the hero retire. No remaining
  consumer; the Coach drawer covers the equivalent ask.
- **GLP-1 detail-page intake history + inventory.** The "Dosis-
  Historie" disclosure and "Bestand" section retire from the GLP-1
  medication detail page. The page now collapses to header,
  schedule, dose-titration ladder, and side-effects — every section
  the maintainer flagged as wanted; every section flagged as
  unwanted is gone. Inventory tracking remains opt-in for a future
  release.
- **Hero "Wochenbericht erstellen" button.** The placeholder
  affordance retires from the `/insights` action row. The row now
  carries a single "Coach fragen" button so the HealthScore card on
  the opposite column has the height to reach the last suggested
  prompt.

### Fixed

- **Workout edit raised a 500 on duplicate timestamps.** The save
  path on `PUT /api/measurements/[id]` returned a generic 500 when a
  sport-typed sample (`ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
  `WALKING_RUNNING_DISTANCE`, `EXERCISE_TIME`) collided with an
  existing row on the same `(type, measuredAt)` natural key. Returns
  409 with a `measurements.duplicateTimestamp` translation key now;
  the iOS native client and the web measurement-form both surface
  the conflict to the user instead of a generic toast.
- **BD-Zielbereich tile rendered "1.1." instead of numbers.** The
  tile's bespoke rendering path read the schedule date through
  `Intl.DateTimeFormat` and missed the underlying value. Tile
  rebuilt on the shared `<TrendCard>` primitive so the chrome, the
  state shape, the prop API, and the fallback behaviour match the
  Weight and BP siblings. The divergence has been the open finding
  across v1.4.22, v1.4.25, v1.4.26 patches — this release rewrites
  the tile instead of patching.
- **`/insights/puls` hung waiting on the assessment provider.** The
  pulse status card called the language-model provider with no
  client-side timeout. A timeout helper (`with-timeout.ts`) caps
  every status-card provider call at 20 s and returns the rule-based
  fallback string on timeout; the page renders the chart immediately
  and the assessment line resolves async.
- **Scroll stuck on `/insights` mother-page navigation.** The sticky
  tab-strip's intersection-observer was fighting the focus-on-mount
  logic so the page sometimes refused to scroll past the tab row.
  The observer rebinds on route change and the focus-on-mount
  effect now waits for the next animation frame so the scroll
  position is locked in before the observer fires.
- **`<DrugLevelChart>` paint exceeded the active range window.** The
  chart fetched every dose-event in history regardless of the
  selected range. Now bounded to the active range — 30 days / 90
  days / all-time — so the wire payload and the recharts render
  scale linearly with the visible window.
- **Mood trend tile painted a residual `rounded-xl` border.** The
  shadcn `<Card>` default paints `rounded-xl` while the trends row
  needs `rounded-md` to match the `<HealthChart mini>` shape. Mini-
  mode override adds `rounded-md`; the visual rhythm of the row
  reads on one envelope.
- **Side-effects card overflowed at 320 px.** The "Nebenwirkungen
  erfassen" CTA chip ran past the section header. The qualifier
  drops from every locale ("Erfassen" / "Log" / "Consigner" /
  "Registrar" / "Registra" / "Dodaj"); the section title carries
  the context. The date column on the entry rows narrows from 88 px
  to 56 px so the free-text slot recovers 32 px of wrap headroom.
- **Medication-list row shape diverged for GLP-1 entries.** The
  GLP-1 row painted with a brand icon and a middle-dot separator;
  every other row painted two-line without an icon. Both routes
  through a shared `<MedicationCardHeader>` now — line 1 is `{name}
  {dose}`, line 2 is the class label plus state badges. The GLP-1
  outlier shape is gone.
- **HealthScore card came up short below the action+prompts column.**
  The card now opts into `flex h-full flex-col` with the disclaimer
  footer pinned via `mt-auto`; the hero row switches to
  `md:items-stretch` on `md+` so the score column reaches the
  bottom of the suggested-prompt rail. Equal-height contract across
  the hero strip.
- **`/measurements` aggregation truncated long-window queries.** The
  `take` cap applied before bucketising, so a 365-day daily-grain
  query returned only the first N raw rows. Aggregation now runs
  as a Postgres `date_trunc` GROUP BY and the cap applies to the
  bucketised result; a 1-year window returns up to 365 daily
  buckets. The all-time chart range resolves to monthly grain (24-
  bucket ceiling) or weekly when history is under two years.
- **Schlaf sub-page missed the per-section assessment slot.** Six of
  seven insights sub-pages mount `<InsightStatusCard>` underneath
  the chart; Sleep did not. Documented as the intentional skip
  with a `// no per-section assessment yet` marker so future
  contributors do not re-flag it.
- **Insights-targets locale strings missed on FR / ES / IT / PL.**
  `measurements.duplicateTimestamp` and `insights.sleep.description`
  now carry native translations in every locale.

### Changed

- **BD-Zielbereich tile aligned to `<TrendCard>`.** Tile chrome,
  state shape, prop API, and fallback states all match Weight and
  BP. The Z-value rounds to one decimal at the boundary, the legend
  carries the same micro labels across siblings, the empty state
  reads the same copy with the same CTA shape.
- **Medication-list rows route through `<MedicationCardHeader>`.**
  GLP-1 and standard rows both render `{name} {dose}` on line 1 and
  class label plus state badges on line 2. State badges break onto
  their own row at 320 px so the two-line shape holds.
- **Medications detail-page chrome collapsed to one heading scale.**
  Every section on `/medications/[id]` mounts through
  `<MedicationDetailSection>` (`text-base font-semibold leading-6
  tracking-tight`). DrugLevelChart's standalone header migrates to
  `<h2>` with the same classes. Micro labels lift from
  `text-[10px]` / `text-[11px]` to `text-xs` across Scheduling,
  Titration, SideEffects. Three scales survive the page: heading,
  body (`text-sm`), micro (`text-xs`).
- **Coach launch shape consolidated to three primitives.** A single
  `<LayoutCoachFab>` mounts once per Insights surface (FAB on `<lg`,
  hidden on `lg+`); `<CoachLaunchButton>` paints the inline desktop
  ghost button only; `<TargetCoachButton>` paints the per-card
  icon-only chat-bubble. The five-shape inventory collapses to
  three. Every Coach launch glyph reads on one vocabulary
  (`Sparkles`); the suggested-prompt chips stay their own visual
  class because the pre-fill flow is conceptually distinct.
- **Targets page Coach launch is icon-only.** The bottom-left "Coach
  fragen" pill on `/insights/zielwerte` collapses to a 44 px
  icon-only affordance. The visible label drops; the same string
  carries through `aria-label` + `title` so screen readers still
  announce the action.
- **HealthScore delta gains a `?` explainer.** Tap or hover on the
  icon next to the "-3 vs last week" line opens a popover on `md+`
  and a `<ResponsiveSheet>` bottom-sheet on phone viewports.
  Three-sentence body per locale: which components contribute, what
  window, what the user can do to nudge it.
- **Trends row pins to an equal-height contract.** The
  `auto-rows-fr` rule lifts from `md:` to every breakpoint; each
  chart wraps in a `trends-row-chart-slot` div with `shrink-0` so
  the slot is the load-bearing height anchor. `<MoodChart>` mini
  envelope tightens to match `<HealthChart mini>`. Captions clamp
  at three lines.
- **`<CoachLaunchScope>.metric` narrows to `CoachScopeSource`.** The
  type is forward-looking — no call site passes the parameter yet —
  but the union now mirrors what the iOS client speaks. The
  v1.4.28 narrowing closes the open type-system note from
  v1.4.27.
- **Coach mobile sheet caps at 90 dvh.** The Coach drawer's bottom-
  sheet branch on phones now matches the `<ResponsiveSheet>`
  convention (the v1.4.27 release picked 95 dvh; this release
  aligns the cap).
- **Insights sub-pages share one data-fetch hook.** The seven sub-
  pages duplicated the same React-Query analytics fetch plus the
  empty-state branch; both now route through `useInsightsAnalytics`
  and `<MetricEmptyState>`. Adding a future metric sub-page is a
  one-file change.
- **Chart dynamic imports consolidate on `<HealthChartDynamic>`.**
  Six `dynamic(() => import("@/components/charts/health-chart"))`
  call sites collapse to one re-export. Every dynamic chart slot
  ships a layout-stable `<ChartSkeleton>` loading state so the
  page does not jump as the bundle resolves.
- **Side-effects add CTA shortens across all six locales.** "Log",
  "Erfassen", "Consigner", "Registrar", "Registra", "Dodaj" — the
  qualifier drops; the section title carries the context.
- **`/api/measurements` aggregate branch flips to GROUP BY.** The
  Postgres `date_trunc` path resolves daily / weekly / monthly
  grain server-side; the `BUCKET_CAP` keeps the response bounded.
  iOS callers that pass `limit` only land in the unchanged raw
  branch (byte-stable against v1.4.27).
- **`/medications/[id]/history` page wrapper stride.**
  `space-y-4 → space-y-6` so the section stride matches
  `/insights/*`.

### Added

- **`useInsightsAnalytics()` hook + `<MetricEmptyState>` primitive.**
  Shared data-fetch + empty-state scaffolding across the insights
  sub-pages. Adding a new metric route reads on one fetcher and one
  empty-state recipe. `AnalyticsData` hoists to
  `src/types/analytics.ts` as `SubPageAnalyticsData`.
- **`<HealthChartDynamic>` re-export.** Single canonical lazy-loaded
  health-chart entry consumed by the dashboard, the five `/insights`
  metric pages, the trends row, and the VO2 max chart row.
- **`<ChartSkeleton>` loading state across every dynamic chart.**
  Layout-stable placeholder pinned at the same height the chart
  paints when loaded. Nine `next/dynamic` chart call sites lift onto
  the shared primitive.
- **`with-timeout.ts` envelope helper.** Wraps any provider call in
  a 20 s timeout and returns a structured `TimeoutEnvelope<T>`
  (`{ ok: true, value } | { ok: false, error }`). Adopted by the
  insights status cards; the user-visible chart paints immediately
  while the language-model assessment resolves async.
- **`HealthScoreDeltaExplainer`.** New
  `src/components/insights/health-score-delta-explainer.tsx`
  surfaces the `?` icon next to the delta line; tap opens a
  popover on `md+` and a `<ResponsiveSheet>` on phone viewports.
  Three-sentence body per locale. The trigger paints
  `aria-expanded` + `aria-controls`; the body owns an `id` matched
  by `aria-describedby` on the delta `<span>`.
- **`<LayoutCoachFab>` mount.** Floating Coach affordance lifts out
  of `<CoachLaunchButton>` and mounts once per Insights layout. The
  duplicate-FAB nodes (one per sub-page) collapse to one node in the
  a11y tree.
- **`<MobileRailTray>` carve-out.** The two `<Sheet>` mounts that
  wrap the Coach history rail and sources rail lift out of
  `<CoachDrawer>` into their own ~80 LOC primitive. Pure refactor:
  every `data-slot` identifier and breakpoint class survives intact.
- **`useReportWebVitals` beacon + bundle analyzer.** `pnpm analyze`
  runs `next build` with `@next/bundle-analyzer` enabled (reports
  land in `.next/analyze/`). The beacon POSTs CLS / LCP / INP / FCP
  / TTFB / INP to `/api/internal/web-vitals` via
  `navigator.sendBeacon` with a `fetch({ keepalive: true })`
  fallback. The route validates the payload with Zod, rate-limits
  to 60 / min per IP, requires same-origin Referer (when
  `NEXT_PUBLIC_APP_URL` is set), and forwards the metric name +
  value + rating to the wide-event logger via `annotate({ meta })`.
- **`aggregate=monthly` grain on `/api/measurements`.** Additive
  enum value resolving 30-day buckets. All-time chart range now
  resolves to monthly aggregation when full history ≥ 2 years,
  weekly when shorter. The 24-bucket ceiling keeps the response
  bounded. Schema is iOS-additive.
- **`dispatchLocalisedNotification` user-lookup cache.** 30 s TTL
  LRU keyed on `userId`; repeat dispatches inside the window share
  one Prisma query. Capped at 1 000 entries with FIFO eviction.
  For a burst of admin alerts to the same recipient the cache
  collapses N round-trips to 1.
- **`insights.coach.window.lastYear` key across six locales.** The
  enum value shipped in v1.4.27; the strings now carry native
  copy in every locale ("year so far", "Jahresrückblick", "depuis
  le début de l'année", "lo que va de año", "anno in corso",
  "od początku roku").

### Performance

- **Health-chart fetches bound to the active range window.** The
  client now passes the resolved `from`/`to` for the selected range
  instead of pulling the full history every time; the wire payload
  and the Recharts render scale linearly with the visible window.
- **Insights status-card provider call capped at 20 s.** Hung
  assessments resolve to the rule-based fallback instead of blocking
  the chart paint. The chart is rendered from local analytics on
  first paint; the assessment line streams in when (and if) the
  provider returns.
- **Dispatch-localised notification user lookup cached.** See the
  Added entry — same line item, performance impact is the
  collapsed Prisma round-trips on burst dispatches.
- **Dynamic chart imports collapsed onto one re-export.** Six
  duplicate `next/dynamic` call sites reduce to one; chart
  skeletons pin layout across the dynamic resolve so the user
  never sees a height jump.

### Tests

- **17 new Vitest cases for the range-aggregation route.** Cover
  the iOS gate (raw branch byte-stable when `aggregate` is omitted),
  the daily 365-bucket assertion, the monthly cap, the all-time
  monthly path, the all-time weekly fallback, and the per-grain
  threshold.
- **8 new cases on the web-vitals beacon route.** Happy 204, three
  schema rejections, malformed JSON, 429 under rate limit,
  cross-origin drop, same-origin accept.
- **5 new cases on the dispatch-localised cache.** Cache hit, TTL
  expiry, just-inside-TTL, reset helper, per-user isolation.
- **11 new tests across the medication, insights, and target
  surfaces.** Three on `<MedicationCardHeader>`, one on the side-
  effects narrow-viewport responsive shape, four on the HealthScore
  delta explainer (size, screen-reader wiring, trigger label,
  closed-by-default), one on the mood-tile radius, one on the
  trends-row equal-height contract, one on the targets-page Coach
  icon affordance.
- **5 new cases on `<MobileRailTray>`.** Slot identifiers,
  breakpoint hides, rail content forwarding, localised titles,
  closed-state gating.
- **1 new case on the workout edit duplicate-timestamp path.** The
  `ACTIVE_ENERGY_BURNED` sport-typed row pins the 409 response
  shape and the `measurements.duplicateTimestamp` key resolves to
  native translations on every locale.
- **Test totals: 3953 → 3974 passing across the broad sweep, with
  546 / 546 green on the touched surfaces.**

### Deferred

- **SD-H1 client wire-up.** The server machinery lands in
  `8144281d`; the client still defaults the "All time" tab to a
  365-day window with no `aggregate` param. Flipping the client to
  pass `aggregate=monthly` plus the user's earliest measurement as
  `from` is a four-line edit deferred to v1.4.29 — the bucketed
  rows carry a divergent shape and the chart adapter needs a small
  helper to merge bucketed vs raw inputs.
- **R4 Medium-tier findings.** The simplifier, design, UI-conformity,
  i18n, and senior-dev reviewers each surfaced a Medium-tier
  backlog. Closed only the high-impact items in this release;
  Medium-tier items (8 design, 4 UI-conformity, 5 i18n, 7 senior-
  dev, plus the `<ResponsiveSheet>` footer-slot wiring and the 5
  `<Dialog>` consumers still to migrate) defer to v1.4.29 per the
  scope-discipline directive ("less scope, more depth").
- **Five admin / monitoring orphan endpoints.** Unchanged from
  v1.4.27. The wire-or-remove decision still pends — each is
  documented in README but has no runtime consumer. Carry forward
  to v1.4.29.

## [1.4.27] — 2026-05-15

Mobile capability + maintainer-finding cleanup. The headline is a new
`<ResponsiveSheet>` primitive that switches between a bottom-sheet on
narrow viewports and a centred dialog on desktop; every primary form
entry mounts through it with sticky-pinned Save / Cancel above the soft
keyboard. Tap targets across `Button`, `Input`, `Select`,
`DropdownMenu` and the new shared `PasswordInput` lift to the WCAG
2.5.5 floor, and `inputMode` / `enterKeyHint` / `autoComplete` /
`aria-invalid` / `aria-describedby` are wired across every form. The
Coach drawer mount moves up to the `/insights` layout so every
sub-page can launch the panel, and flips to a bottom-sheet branch on
narrow viewports. The dashboard GLP-1 tile gains a two-tab pane with a
range strip; the seven insights sub-pages gate on metric data
availability with empty-state CTAs that route into a self-opening
measurement form. Login overview surfaces an offline-resolved carrier
chip via bundled MaxMind GeoLite2-City + GeoLite2-ASN MMDBs. A new
`<NativeSelect>` primitive replaces five raw selects across settings
and admin. 26 of the 27 maintainer findings landed; the weekly-report
dead-click ask defers to v1.4.28 pending a screenshot. Migration 0061
is additive, `IF NOT EXISTS`-guarded, and forward-only.

### Added

- **`<ResponsiveSheet>` primitive.** New surface at
  `src/components/ui/responsive-sheet.tsx` plus a typed `useIsMobile`
  hook at `src/hooks/use-is-mobile.ts`. Renders a Radix `<Sheet>` with
  a `side="bottom"` branch below `md` (768 px), a centred `<Dialog>`
  branch on `md+`, and a `data-variant="dialog" | "sheet"` hook for
  tests and downstream styling. The Sheet branch sticky-pins the
  footer slot at the bottom edge with a backdrop-blur background; the
  Dialog branch flows the footer normally. SSR-safe — seeded from
  `useSyncExternalStore` so the first client render reads
  `window.matchMedia` synchronously rather than waiting an effect
  tick.
- **`<NativeSelect>` primitive** at `src/components/ui/native-select.tsx`,
  consumed by `account-section.tsx`, `timezone-picker.tsx`,
  `general-settings-section.tsx` and the five remaining raw selects on
  `ai-section.tsx`.
- **`<CoachLaunchProvider>` and `LayoutCoachMount` for `/insights`.**
  The drawer mount moves up to `src/app/insights/layout.tsx` so every
  routed sub-page can call `useCoachLaunch()` and open the panel.
  Each of the seven sub-pages mounts a `<CoachLaunchButton>` — sticky
  FAB on `<lg`, inline action on `lg+`. `askCoach(prefill, scope)`
  accepts a reserved `scope` argument for per-metric Coach narrowing
  (parameter is wired through the context but the sources rail does
  not yet pre-narrow; consumed in v1.4.28).
- **Dashboard GLP-1 tile — two-tab pane plus range strip.** The tile
  pairs a Weight tab with a new Drug-Level tab (default Drug-Level)
  driven by `<DrugLevelChart>` in its `compact` mode. A
  7-day / 30-day / 90-day / all-time radiogroup picks the chart range.
  Schedule dates promote to a header pill row; the previous green seam
  is gone.
- **Insights sub-page availability gating.** New helper
  `src/lib/insights/metric-availability.ts` exposes `hasMetricData()`
  as a single decision point. `<InsightsTabStrip>`,
  `<InsightsLayoutShell>` and the seven sub-page routes gate the tab
  pill, the layout mount and the sub-page body on whether the
  underlying metric has data; missing metrics drop cleanly rather than
  rendering an empty chart.
- **Insights empty-state CTAs.** Each sub-page renders the shared
  `<EmptyState>` with a metric-specific title, description and CTA.
  BP / weight / pulse / BMI route into `/measurements?add=<TYPE>`,
  which auto-opens the `<ResponsiveSheet>` add-form with `defaultType`
  set and `router.replace`s the query so the back button returns to a
  clean URL. Mood / medication / sleep route to their dedicated pages.
  Every empty-state offers a Coach launch as a secondary path.
- **Offline geo-IP + ASN-to-carrier lookups.** New
  `scripts/fetch-geolite2.sh` downloads `GeoLite2-City.mmdb` +
  `GeoLite2-ASN.mmdb` into `assets/geolite2/` at build time using the
  `MAXMIND_LICENSE_KEY` repo secret. The runtime resolver in
  `src/lib/geo.ts` reads `GEOLITE2_DIR` (defaults to
  `/opt/geolite2`) and silently skips the offline tier when the files
  are absent so local-dev workflows without the license key continue
  to fall back to `ipwho.is`. The MMDB files are not vendored in git;
  `.gitignore` excludes `assets/geolite2/*.mmdb`. The fetch script
  prints the SHA256 of each MMDB to stderr after download. The
  GHCR build step fails fast with an `::error::` line when the secret
  is unset.
- **`AuditLog.asn` + `AuditLog.carrier` columns.** Migration `0061`
  adds two additive, `IF NOT EXISTS`-guarded columns to `AuditLog`,
  plus a `geo-backfill` pg-boss job that re-resolves carrier on
  historical rows. The admin login overview surfaces the carrier as
  a chip under the auth-provider column, with a case-insensitive
  short-label heuristic that collapses verbose org strings
  (e.g. `Telefonica O2 Deutschland` → `O2`).
- **`/about` page.** New public route at `src/app/about/page.tsx`
  carrying the MaxMind GeoLite2 CC BY-SA 4.0 attribution alongside the
  existing project credits. Joins `proxy.ts` and `auth-shell.tsx`
  `PUBLIC_PATHS` so the page reaches an unauthenticated visitor with
  its own edge-to-edge header and footer (same shape as `/privacy`).
- **Coach polish — info-icon popover for the composer hint.** The
  verbose hint span at the bottom of the composer collapses to an
  `Info` icon wrapped in a new shadcn `<Popover>` (mirroring the
  existing `<Tooltip>` shape). The trigger carries an `aria-label`
  with the same hint copy so screen readers still announce it on
  focus; the popover body shows the long-form hint on tap or hover.
- **Soft-keyboard re-pin on the message thread.**
  `src/components/insights/coach-panel/message-thread.tsx` adds a
  `window.visualViewport.resize` listener with the same `wasPinned`
  guard as the existing message-arrival effect. When the soft
  keyboard slides in, the thread re-pins to the bottom so the tail
  stays visible.
- **`parkIntegrationAtReauth` helper.** New
  `src/lib/integrations/status.ts` export that flips an integration
  row to `state=error_reauth` without incrementing
  `consecutiveFailures`, without calling `recordSyncFailure`, and
  without entering the 3-strike admin-alert ladder. Writes one
  idempotent `integrations.reauth_required` audit row. Replaces the
  scope-skip branch in `withings/sync-activity.ts` and
  `withings/sync-sleep.ts`; the defence-in-depth 403 catch block
  stays on `recordSyncFailure`.
- **`dispatchLocalisedNotification` helper.** New
  `src/lib/notifications/dispatch-localised.ts` resolves the
  recipient's `User.locale`, calls
  `getServerTranslator(locale).t(titleKey, params)` /
  `.t(messageKey, params)`, and delegates to the base
  `dispatchNotification` with composed strings. Wired into the deploy
  webhook, the admin "test notification" button, the user "test
  Telegram" button, and the admin reminder-check diagnostic. Nine
  new notification keys land in all six locale bundles.
- **Locale-native date format ordering for FR / ES / IT / PL.** A new
  `format.*` namespace documents `dateShort`, `timeShort`, and
  `dateTime` per locale — FR / ES / IT use `{day}/{month}/{year}`
  slashes, PL uses `{day}.{month}.{year}` dots, DE keeps dots, EN
  keeps slashes. The keys are forward-looking; runtime formatting
  still routes through `Intl.DateTimeFormat` via
  `src/lib/format-locale.ts`, but downstream surfaces that render
  outside a React context (PDF, CSV, email) can read the ordering
  hint without spinning up `Intl`.
- **`coachScopeWindowSchema.lastYear`.** The Coach snapshot window
  enum gains a `lastYear` value (365 days) between `last90days` and
  `allTime`. `<SourceChips>` surfaces the year-in-review chip when
  the resolved scope window matches.
- **Workouts read route.** New `GET /api/workouts` paginated route
  that runs every fetch through `pickCanonicalWorkout()` with
  `DEFAULT_WORKOUT_SOURCE_PRIORITY` and the 5-min cluster window.
  Pagination corrects against canonical dedup — the route pulls the
  full filtered set, dedupes once, then slices, so `meta.total`
  reports the deduped count rather than the per-window
  `canonical.length`.
- **iOS handoff addendum.** New
  `.planning/v15-ios-handoff/22-standalone-and-server-pairing.md`
  documents the standalone-then-pair pattern for the iOS native
  client. Sibling of the existing `22-offline-first-architecture.md`;
  same research input, neutral framing per the v1.4.27 convention
  directive.

### Changed

- **Tap-target floor lifted across the primitives.** `Button` default
  `h-9 → h-10`, `lg` `h-10 → h-11`, `icon` `size-9 → size-10`,
  `icon-lg` `size-10 → size-11`; `Input` `h-9 → h-10`; `Select`
  trigger `h-9 → h-10`; `DropdownMenuItem` gains `min-h-11 py-2`.
  `Dialog` close-X grew from 24 px to `min-h-9 min-w-9` (36 px,
  WCAG 2.5.8) — intentional compromise so the close affordance does
  not crowd a dialog header.
- **`PasswordInput` lifted to the shared UI layer.** Moved from
  `src/components/settings/password-input.tsx` to
  `src/components/ui/password-input.tsx`; the toggle button grew to a
  44 px hit area, the input gets `pr-12` so user input never collides
  with the toggle. Five settings + admin consumers re-import.
- **Coach drawer mount move.** The drawer no longer mounts inline on
  `/insights/page.tsx`; the layout owns it. Sub-pages call
  `useCoachLaunch()` to open the panel.
- **Coach drawer bottom-sheet on `<sm`.** The drawer reads
  `useIsMobile("sm")` and switches `side="right"` → `side="bottom"`
  below 640 px. The window-pill `<Select>` in the header hides on
  phone viewports — the sources-rail picker covers the same override.
  `<SheetTitle>` pins `min-w-0 truncate` so long titles always clip.
- **Coach evidence disclosure.** The `<details>` block on each Coach
  reply is now controlled via `useState` with an accurate
  `aria-expanded` driven from that state. The `showEvidenceByDefault`
  Coach pref retires from the settings sheet (the persisted field
  stays on the Zod schema for backward compatibility; v1.5 can drop
  it via a forward-compat migration).
- **Coach sources-rail toggle.** Swapped from a raw
  `<input type="checkbox">` to the new shadcn `<Checkbox>` primitive
  at `src/components/ui/checkbox.tsx`. Keyboard contract (Space
  toggles, Tab moves), focus ring, touch-friendly hit target. The
  existing `data-slot="coach-sources-checkbox"` marker is preserved.
- **Coach settings-sheet close affordance.** Retired the primitive's
  absolutely-positioned close-X (`showCloseButton={false}`) in favour
  of an inline `<SheetClose>` in the header, matching the coach-drawer
  pattern and clearing 44 px.
- **Coach rail-tray triggers.** The history and sources triggers lift
  out of the absolute overlay into a sub-header strip
  (`xl:hidden` / `lg:hidden`); both buttons sit at `min-h-11`. The
  per-row delete on `history-rail.tsx` drops the
  `opacity-0 group-hover:opacity-100` reveal and is always visible at
  `size-11`.
- **Token-leak hardening at insight-status producers and consumer.**
  `normalizeSummaryText` on the seven `*-status.ts` helpers
  (`pulse`, `weight`, `bmi`, `mood`, `blood-pressure`,
  `medication-compliance`, `general`) now calls `stripChartTokens()`
  before whitespace collapse; `<InsightStatusCard>` wraps `text` with
  the same call at the render site as defence-in-depth for cached
  rows. The colon-form, capitalised-Metric and orphan-enum tokens
  are now scrubbed at both layers.
- **Settings — date-of-birth paired with language in one grid row.**
  `account-section.tsx` collapses the v1.4.19 split. The
  `TimezonePicker` inner gap lifts to `gap-3` so the select and the
  detect button breathe at the same rhythm as the rest of the form.
- **Settings + admin shells reserve a minimum main-column height.**
  Both shells pick up
  `<main className="min-h-[calc(100dvh-12rem)] min-w-0">` so short
  sub-pages no longer trigger a click-to-shift as the layout
  collapses inwards.
- **Thresholds + Sources skeleton rows replace the single spinner.**
  The two settings sections render a row-shaped placeholder list
  while loading; the skeletons map over the same metric ordering as
  the live UI so the layout stays put across the loading-to-loaded
  transition.
- **Heading weight + card cadence + label-input gap.** Standardised
  to `font-semibold` across every divergent `<h2>` / `<h3>` in
  settings and admin sections; card-internal vertical rhythm pins to
  `space-y-4`; the password-change dialog at `account-section.tsx`
  lifts `space-y-1.5 → space-y-2` across its three label-input pairs.
- **Health Score column rebalanced.** The hero strip splits to a
  tablet-friendly `md:flex-row`; the Health Score card pins a
  `basis-` width so the column does not stretch past its content.
  The L2 disclaimer text bumps from `text-[10px]` to `text-[11px]`
  to clear the 12 px mobile floor concern. The retired inline
  ask-Coach button drops; the `onAskCoach` prop stays for backward
  compatibility (destructure-and-ignore).
- **Daily Briefing trim.** The duplicate paragraph slot drops; the
  card renders a single insight line and the matching insights
  sub-page link.
- **`/api/version` carrier surface.** The login overview CSV adopts
  carrier as a column and the per-row chip surfaces under the
  provider cell. Empty carrier renders as no chip rather than a
  placeholder label.
- **CoachLaunch `scope` parameter.** Reserved on the
  `useCoachLaunch().askCoach(prefill, scope)` signature for v1.4.28's
  per-metric narrowing; currently a no-op on the sources rail.
- **CSV / pagination chrome out of the admin scroll wrappers.**
  `login-overview-section.tsx` and `app-log-preview-section.tsx` now
  render the pagination controls and the summary line as siblings of
  the `overflow-x-auto` table wrapper. The CSV export button was
  already in the toolbar row above the table.
- **`measurement-list.tsx` filter row stacks on `<sm`.** The
  measurement-type filter `SelectTrigger` widens to `w-full sm:w-48`
  and stacks above the controls below the small breakpoint.
- **Chart-height as a CSS variable.** `HealthChart`, `MoodChart` and
  `MedicationComplianceChart` expose `--chart-height` /
  `--chart-height-md` so the height shifts on `md+` without a
  re-render. `MoodChart` 280 → 240 to match the rest of the trend
  strip; a shared `CHART_HEIGHT_PX` constant lives at
  `src/components/charts/constants.ts`.
- **Compliance heatmap tap-pin + cell floor.** The heatmap tooltip
  pins on tap on touch surfaces (previously hover-only); each cell
  pins a 14 px floor; the heatmap overflows the parent on `<sm`
  rather than crushing to one row.
- **Withings sync — scope-skip path silences the admin alert.**
  Calls to `recordSyncFailure` in `sync-activity.ts` and
  `sync-sleep.ts` swap to `parkIntegrationAtReauth` on the
  deliberate scope-skip branch; the defence-in-depth 403 catch path
  keeps the loud `recordSyncFailure`. The false-positive 3-strike
  admin Telegram for re-auth scope deltas is gone.
- **i18n bundles — 154 dead keys retired.** A repository-wide scan
  retires keys that no surface reads (the legacy insights status
  trio, the `aiInsights` / `generate*` / `noApiKey` set retired with
  the briefing rebuild, the `onboarding.v2.*` stub set, ten dead
  medication keys, four dead chart keys, the `insightsPreview` /
  `bloodPressureDia` / `bloodPressureSys` dashboard keys, two dead
  notification keys, two dead admin-provider labels). 228 new
  strings land across the same 38 unique paths for the GLP-1 tile,
  the admin carrier chip, the insights empty states and the
  notifications dispatcher.
- **Shared mood label module.** New `src/lib/mood/labels.ts` exposes
  `MOOD_ENUM_VALUES`, `MOOD_SCORE_BY_ENUM`, `MOOD_ENUM_BY_SCORE`,
  `MOOD_LABEL_KEYS`, and `moodLabelKeyForScore()`. `mood-list.tsx`
  and `mood-chart.tsx` import the canonical key map from this
  module; the five inline `t("charts.moodLabel${n}")` calls retire
  in favour of the canonical `mood.level*` set.
- **Shared `allMessages` + `resolveKey` extract.** Both
  `lib/i18n/context.tsx` and `lib/i18n/server-translator.ts` now
  import from the new `lib/i18n/shared-resolve.ts`; the two
  duplicate copies are gone (net 61 / -66 LOC).
- **`metricPriorityObjectSchema` derives from
  `SOURCE_PRIORITY_METRIC_KEYS`.** Adding a metric class is a
  single-line constant edit instead of three parallel listings.
- **Workouts attach route collapses 1+N to a single `findMany`.**
  `POST /api/workouts/batch` swaps the
  `Promise.all(withoutExternal.map(p => tx.workout.findFirst(...)))`
  loop for one batched `tx.workout.findMany` with a per-entry `OR`
  clause; per-batch round-trip count drops from 1+N to 2 for a
  100-row batch. The createdAt-DESC tie-break is preserved via
  in-memory grouping.
- **Form input attributes wired across the surface.** Measurement,
  medication, mood, settings, admin and auth forms pick up
  `inputMode` / `enterKeyHint` / `autoComplete` / `autoCapitalize` /
  `aria-required` / `aria-invalid` / `aria-describedby`. The Input
  primitive derives `inputMode` from the `type` prop when the caller
  does not pass one (`number → decimal`, `tel → tel`,
  `email → email`, `url → url`, `search → search`). Integer-only
  call sites still pass `inputMode="numeric"` explicitly.
- **Schedule day-of-week grid widens on narrow viewports.**
  `medication-form.tsx` stacks the Daily pill above a fixed
  `grid grid-cols-7` so every weekday keeps the 44 px tap-target
  floor regardless of container width.
- **Public-page polish.** `/about` and `/privacy` sticky headers
  pick up `pt-[env(safe-area-inset-top)]` so the brand row clears
  the iOS notch. `/privacy` mounts a default-closed `<details>`
  Contents TOC above the body with anchor links to every numbered
  section; the 19 HealthKit identifier `<code>` elements gain
  `break-all` so the longest camelCase entries wrap.

### Fixed

- **Stray-brace typo at the insights-targets route.** The trailing
  comment block at `src/app/api/insights/targets/route.ts:807`
  carried a stray `}` that the v1.4.25 polish pass missed; cleaned
  up alongside the prompt-side audit.
- **Chart-tick timezone audit.** `compliance-heatmap.tsx` parsed the
  day-key against local tz (`new Date(dateStr + "T00:00:00")`) and
  read `getDay()` / `getMonth()` (server-tz) while the dateKey was
  UTC-anchored via `toISOString().slice(0, 10)`. Pinned to
  `T00:00:00Z` + `getUTC*` accessors so the Monday-alignment and
  month-marker placement stay correct under an SSR pass on a
  non-Berlin host. The five sibling chart files
  (`sleep-stage-stacked-bar`, `mood-chart`, `health-chart`,
  `medication-compliance-chart`, plus the broader insights surface)
  audit clean.
- **`/about` returned 401 to unauthenticated visitors.** `/about`
  joined `proxy.ts` `PUBLIC_PATHS` in B3 but the client-side
  `auth-shell.tsx` `PUBLIC_PATHS` list was missing the entry, so
  the route surfaced the redirect-to-login screen instead of the
  credits. `isStandalonePublicPage` also matches `/about` so the
  route renders edge-to-edge.
- **Insights empty-state CTAs hit a 404.** The CTAs targeted
  `/measurements/new`, which is not a route. Swapped to
  `/measurements?add=<TYPE>` with a `MEASUREMENT_TYPES` allow-list
  on the consumer side; the measurements page reads the query
  param, opens the form with `defaultType` set, then
  `router.replace`s to a clean URL.
- **`/api/version` register button below the tap floor.** The
  `/auth/register` submit button promotes to `size="lg" min-h-11
  w-full` so the primary action stays finger-tap reachable on
  narrow viewports.
- **Workouts pagination broken under canonical dedup.** Pulling the
  full filtered set and slicing post-dedup yields the correct
  `meta.total` and a no-overlap, no-gap descending order across
  pages. New regression test paginates eight twin clusters across
  two pages.
- **`useIsMobile` first-paint desktop flash.** The hook now reads
  through `useSyncExternalStore` with `getServerSnapshot() => false`
  and `getClientSnapshot()` reading
  `window.matchMedia(query).matches` synchronously. SSR still
  resolves to `false`; the first client render reads the live
  media-query state without waiting an effect tick.
- **`Sheet` close-X tap target.** Widened to match the `Dialog`
  primitive's 36 px floor.
- **`/about` and `/privacy` anchors occluded by the sticky header.**
  `scroll-mt` widened so the section start lands below the sticky
  header rather than behind it.
- **`MedicationComplianceChart.compareBaseline` prop intent.** The
  prop was carried by 24 call sites uniformly but was never
  consumed; explicitly destructured with `void compareBaseline;` so
  the type contract is preserved and the dead-prop signal clears.
- **DrugLevelChart dead axis labels.** Dropped the empty `<text>`
  child of `<XAxis>` (an invisible SVG node beneath the x-axis) and
  the duplicate Recharts `label={…}` prop on `<YAxis>` that tried to
  paint the unit-less caption inside a 1 px-wide axis where it
  could never be read. The external `<p>` above the chart remains
  the single source of truth.
- **`not-found.tsx` missing.** New branded 404 page with the
  `<Logo>`, the 404 eyebrow, the headline and a single
  back-to-dashboard `<Link>`. `min-h-dvh` follows the dynamic
  viewport on iOS Safari; `pt-[calc(env(safe-area-inset-top)+3rem)]`
  keeps the headline clear of the notch.

### Removed

- **Orphan `/api/audit-log` route.** The route file (1 281 B) had no
  callers, no test fixture and no DTO. Five admin / monitoring
  endpoints (`/api/admin/ai-settings`, `/api/admin/backup/test`,
  `/api/admin/status-overview`, `/api/monitoring/glitchtip/test`,
  `/api/monitoring/umami/test`) defer to v1.4.28 because each is
  referenced by README or CHANGELOG — a wire-or-remove decision the
  maintainer owns.
- **`<InsightsCardPreview>` surface.** The standalone dashboard
  preview retired alongside the layout-test contract flip;
  `dashboard-layout.test.ts` now guards against accidental
  reintroduction.
- **14 dead exports across `glp1-knowledge.ts`, `scheduling/cadence.ts`
  and `glp1-snapshot.ts`.** Eight type symbols on
  `glp1-knowledge.ts` drop to internal types; `ExpectedDose` drops
  its `export` keyword; `__testables.WEEKDAY_KEYS` retires with zero
  callers. `routeForBrand` and `GLP1_DRUG_IDS` stay exported because
  the test suites read them.
- **`BASE_SYSTEM_PROMPT` + `INSIGHTS_SYSTEM_PROMPT` bare-symbol
  exports.** Verified clean — only locale-suffixed `_DE` / `_EN`
  forms remain.
- **Stale legacy insights-prompt module.** Pruned alongside the
  v1.4.25 native-locale rebuild that displaced it.
- **Three dead Coach prefs.** `showEvidenceByDefault` UI retires
  from the Coach settings sheet; the persisted Zod field stays for
  backward compatibility.

### Infrastructure

- **`MAXMIND_LICENSE_KEY` wired into the GHCR build workflow.** A
  new `Fetch GeoLite2 databases` step in
  `.github/workflows/docker-publish.yml` between the metadata-action
  and the buildx build-push exports the secret from repo secrets.
  Offline GeoLite2 is **optional** in this release: when the secret
  is unset the workflow emits a `::warning::`, drops an `.empty`
  marker into `assets/geolite2/`, and continues so the Dockerfile
  `COPY` still has a non-empty source. The runtime resolver in
  `src/lib/geo.ts` detects the marker on first lookup, falls back
  to the existing `ipwho.is` provider, and sends a one-shot admin
  notification (`notifications.admin.offlineGeoUnavailable*`) with
  a pointer to the GitHub Actions secrets page so the maintainer
  hears about the gap from the running app. The `/api/version`
  endpoint exposes `offlineGeoEnabled: boolean`; the `/admin`
  overview snapshot and the full `/admin/system-status` page render
  a green / yellow chip from that flag. Setting the secret and
  redeploying lights the feature up without code changes.
- **Migration `0061_audit_log_carrier`.** Additive,
  `IF NOT EXISTS`-guarded, forward-only. Adds two columns to
  `AuditLog`: `asn` (`bigint`) + `carrier` (`text`). Safe to
  re-apply on the demo server.

### Tests

- **`pnpm test --run` — 4004 / 4005 passing, 1 skipped.** Across
  357 files. The skipped test is a pre-existing
  visual-regression placeholder.
- **6 new `responsive-sheet.test.tsx` smoke tests** pin the
  dialog-vs-sheet branch, the `data-variant` hook, the footer-slot
  contract and the SSR `useIsMobile` first-paint.
- **16 new `metric-availability.test.ts` cases** cover each metric ×
  `{has data, no data, undefined summaries, missing summary entry,
  BMI-from-WEIGHT derivation, sys-vs-dia independence,
  mood/medication overrides}`.
- **6 new `insights-tab-strip.test.tsx` cases** assert
  backward-compat without `availability`, pill-drop when data is
  missing, overview pill always renders, mood + medication
  light-up, BMI-from-WEIGHT derivation.
- **Drift-guard test at `src/__tests__/i18n-drift-guard.test.ts`**
  (16 cases) anchors the GLP-1 tile keys, the carrier keys, the
  insights empty-state keys, the notification dispatcher keys and
  the personal-record namespace across all six locales.
- **Locale-native date format test** at
  `src/lib/i18n/__tests__/format-locale-order.test.ts` (7 cases)
  asserts ordering per locale.
- **`canonical-dedup.test.ts`** (4 cases) plus the new
  pagination regression covers the workouts read route.
- **Auth + audit suites extended** for the new ASN + carrier
  columns and the carrier short-label heuristic (14 cases under
  `geo-asn.test.ts`, 5 new cases under `audit.test.ts`, 8 new
  under `login-overview-csv.test.ts`).
- **`coach-launch-context.test.tsx`** (3 cases) pins the new
  Coach launch context hook shape, the provider mount, and the
  null fallback outside the provider.

## [1.4.26] — 2026-05-15

Hotfix release. Adds a public, unauthenticated privacy-policy page at
`/privacy` so the iOS native application can register a reachable URL
in App Store Connect. The policy enumerates every Apple HealthKit
identifier the iOS app reads, lists every active third-party sub-
processor with its data-protection policy, restates the EU MDR
medical-device boundary that scopes the AI Coach surface, and walks
through the GDPR Art. 15-22 / DSGVO data-subject rights with concrete
in-app routes the user can hit. The page bypasses the standard
auth-shell so an App-Store reviewer or a first-time visitor sees the
full document immediately. The conservative-semver pattern still
applies: this could have been versioned `1.4.25.1` for symmetry with
the iOS hotfix track, but 4-part versions break the strict-semver
guard in `/api/version` so we incremented to the next clean patch
instead.

### Added

- Public privacy policy at `/privacy` with full HealthKit quantity-type
  enumeration (18 identifiers plus `sleepAnalysis`), Withings
  measurement-family list, sub-processor table (Anthropic, OpenAI,
  Withings, Apple, Telegram, GitHub, Cloudflare, Hetzner), Apple
  privacy-nutrition-label mapping, and a verbatim EU MDR 2017/745 +
  MDCG 2021-24 medical-device-boundary statement.
- `auth.privacyPolicy` translation key in all six locales (English in
  EN, German in DE, native translations for FR / ES / IT / PL).

### Changed

- The unauthenticated login page links out to `/privacy` below the
  sign-in card so a first-time visitor can review the policy before
  signing up, matching GDPR Art. 13 pre-signup expectations.
- The auth shell now treats `/privacy` as a standalone public page —
  long-form legal content renders edge-to-edge instead of being squeezed
  into the centered login-card layout.

## [1.4.25] — 2026-05-14

Largest feature delta in the v1.4.x line. Insights expands from one
page into seven dedicated metric routes; GLP-1 medication tracking
lands end-to-end across injection picker, dashboard tile, weight-chart
markers, therapy timeline, plateau detection, drug-level chart with a
Research-Mode acknowledgment gate, EMA-sourced drug knowledge, EMA
titration ladder, cadence visualisation, compliance chips, side-effect
taxonomy, pen-and-vial inventory with a 30-day in-use clock, and a
dedicated doctor-report section; cross-source priority becomes a
two-axis resolver with a per-user Settings surface; per-user timezone
threads through ten analytics and presentation surfaces; Withings
coverage doubles with twelve new measurement types, webhook-driven
BP / temperature ingestion, plus Activity (steps + distance +
active-energy) and Sleep v2 (stage-level segments) syncs; the
onboarding flow is rebuilt as a nested-route wizard with welcome
carousel, goals chip-picker, source selection grid, baseline form,
and a welcome-back resume banner; Personal Records ship end-to-end
with a detection worker, push opt-in, and a metric-trend badge;
Health Score gains a per-component provenance accordion; the Coach
runs on native first-party prompts across all six locales with a
1800-assertion refusal-probe matrix; the OpenAPI drift gate flips to
hard-fail; the GHCR image is multi-arch so Apple Silicon Macs and
arm64 clouds pull native. Migrations 0043–0060 are additive and
forward-only. `PROMPT_VERSION` 4.24.0 → 4.25.0 with GROUND RULE 9
(Coach refuses GLP-1 dose recommendations) and GROUND RULE 15 (Coach
refuses drug-level estimates with MDR + MDCG 2021-24 cites).

### Added

- **Insights sub-pages — seven dedicated metric routes with a shared
  tab strip.** `/insights/blutdruck`, `/insights/gewicht`,
  `/insights/puls`, `/insights/stimmung`, `/insights/medikamente`,
  `/insights/bmi` and `/insights/schlaf` each render the metric's
  full chart, range bands, trend annotations and correlation rows
  beneath the mother-page hero. Tab strip lifts the metric switcher
  above each chart for cross-metric scanning; the mother page slims
  to general status and the Coach hero.
- **Sleep sub-page with per-night stacked-bar of sleep stages.**
  `/insights/schlaf` renders awake / REM / core / deep as stacked
  columns over the last 7 / 14 / 30 nights, sourced from the
  `sleepStage` column on `Measurement`.
- **Targets (`/insights/zielwerte`) redesigned with a conditional
  Coach-handoff card.** New `<TargetCard>` primitive replaces the
  v1.4.22 layout. Page-level consistency strip pins meta context
  above the cards. The Coach-handoff card only renders when a
  language-model provider is configured; rule-based mode hides it
  cleanly. Mobile-first three-column grid; per-card cog for
  visibility toggles.
- **GLP-1 medication tracking — full integration across ten
  surfaces.** New `Medication.treatmentClass` enum (`GLP1`,
  `STANDARD`); `MedicationDoseChange` history table; `InjectionSite`
  enum with eight site values. A new body-map picker proposes the
  next rotation site based on the last fourteen days of injections.
  Medication-card grows a `glp1` variant (text-rich, no inline
  chart per directive — chart lives on the dashboard tile and
  `/insights/medikamente` therapy timeline). Dashboard tile shows
  next-injection schedule + week-over-week weight delta. Weight
  chart gains vertical injection markers. Therapy timeline on the
  insights sub-page plots titration alongside weight trace. Plateau-
  detection rule in `/api/insights/briefing` flags four-week stalls
  with referral framing. Doctor-report PDF carries a dedicated GLP-1
  section. Migration 0046.
- **Doctor-report per-section toggles + mood default-off.** New
  `User.doctorReportPrefsJson` column (Migration 0045) +
  `PUT /api/auth/me/doctor-report-prefs`. Each section (mood,
  achievements, GLP-1, etc.) gets a per-user toggle in Settings →
  Reports. Mood defaults to off (clinical-sensitivity); empty
  sections hide rather than render a "no data" stub.
- **Cross-source priority resolution — two-axis architecture.**
  New `User.sourcePriorityJson` column (Migration 0048) stores a
  per-user resolver: a single-axis ladder by metric type plus an
  optional per-device-type override. `pickCanonicalSource()` walks
  the metric axis first; a per-device override (e.g. "BP from
  Withings BPM Connect, weight from Withings Body+") wins within
  that ladder. Defaults: cumulative + sleep + HRV + RHR favour
  Apple Health → Withings → manual; point measurements favour
  Withings → Apple Health → manual. The `__default__` sentinel is
  retired in favour of a null bucket.
- **Settings → Sources screen for per-user priority configuration.**
  Drag-and-reorder list per metric, per-device override picker,
  reset-to-defaults action. Audit-log entry on every write.
- **Per-user timezone — Option B threaded through ten surfaces.**
  New `User.timezone` column (defaults to `Europe/Berlin`). The
  CSV exporter emits ISO-8601 with offset; formatters honour the
  user's tz; Profile picker covers all IANA zones; admin sets the
  default for new accounts; signup detects the browser tz; the
  doctor-report PDF dates use the user's tz; chart x-axes take a
  `timezone` prop; Coach snapshot timestamps land in the user's
  tz; `MoodEntry.tz` records local-day grouping for weekday
  correlation (Migration 0044); the weight-weekday correlator
  buckets days in the user's tz.
- **Health Score provenance accordion.** Each of the four scoring
  components (BP, weight, mood, compliance) gets an inline
  disclosure listing the canonical source (Withings / Apple
  Health / manual) and `asOf` timestamp behind the score number.
  `aria-labelledby` panel pairing for screen readers.
- **Four additional locales — French, Spanish, Italian, Polish.**
  First-party translation bundles cover the full string surface
  with a `<MaintainershipBanner>` flagging the locale as
  community-maintained and pointing at the translation-feedback
  issue template. Coach + insights system prompts ship as native
  per-locale bodies (no `REPLY LANGUAGE` footer indirection) with
  the full safety-contract matrix in YAML per locale + structural
  refusal-probe coverage in CI (see Tests). EN + DE stay
  Marc-maintained. Locale picker covers all six; signup
  browser-detect maps `fr|es|it|pl` to the corresponding bundle.
- **Coach — native first-party system prompts across six locales.**
  Coach + insights system prompts move from EN body + `REPLY
  LANGUAGE` footer to native per-locale bodies; the safety contract
  matrix lives as YAML per locale (single source of truth across
  drafting + tests). The refusal-probe matrix in CI catches
  cross-locale prompt regressions before they reach the dispatch
  surface.
- **VO2 max dashboard trend tile (opt-in).** Secondary-metric
  pattern — default-invisible, surfaces only when the user has
  VO2 max data from Apple Health.
- **Personal Records end-to-end — schema, detection worker, badge,
  push opt-in.** Migration 0054 introduces the `PersonalRecord`
  table + `PersonalRecordDirection` helper; `GET
  /api/personal-records` is paginated (default twenty-five, max two
  hundred). A pg-boss worker sweeps MAX / MIN per metric and the
  workout slots on every batch-ingest + a thirty-minute fallback
  cron (concurrency five, warmup gate so the very first datapoint
  per metric does not promote itself). Metric trend tiles render a
  PR badge when the record landed in the last thirty days, with
  WCAG-AA contrast in dark mode. A per-user push opt-in toggle
  (default off) wires into the existing dispatcher cascade.
- **Workouts — schema + typed batch-ingest endpoint.** Migration
  0053 introduces the `Workout` + `WorkoutRoute` tables; the Zod
  boundary in `src/lib/validations/workout.ts` covers a
  twenty-member sport-type union and a `GeoJSON LineString` route
  column in JSONB. `POST /api/workouts/batch` accepts up to five
  hundred rows per call, wraps `withIdempotency()`, returns the
  same `inserted | duplicate | skipped` envelope as the
  measurements batch, and reconciles inserted vs duplicate counts
  correctly under contention. Rate-limited and size-capped.
- **Onboarding rebuilt as a nested-route wizard.** The legacy
  v1.4.20 onboarding ships as a six-step wizard at
  `/onboarding/[step]` powered by a new `<OnboardingShell>`
  primitive: welcome carousel with value-prop slides, goals
  chip-picker, source selection 4-card grid (with Apple Health
  marked coming-soon), baseline form, source-connect step, and a
  done step. `User.onboardingStep` (Migration 0057, with
  Migration 0060 backfilling and flipping the column to
  `NOT NULL DEFAULT 0`) drives resume-state; a welcome-back banner
  surfaces on the entry page when an in-progress wizard is
  detected. `POST /api/onboarding/step` advances the wizard with
  rate-limit + audit, returns 409 on a concurrent advance to close
  the read-then-write race. The marketing entry-point swaps from
  the v1.4.20 single-page flow to the new wizard. Five locales
  carry the shell key surface (six total).
- **GLP-1 — EMA drug knowledge layer.** A first-party drug-knowledge
  module covers five GLP-1 / GIP-GLP-1 drugs with EPAR-sourced
  half-life, recommended titration step, brand-name table, and a
  brand-to-id lookup. A drift-guard test pins the values against
  the EPAR + Psp 4.13099 references on disk so the module cannot
  silently drift.
- **GLP-1 — Research Mode with estimated drug-level chart, MDR
  acknowledgment dialog, and Settings toggle.** A pure
  one-compartment pharmacokinetic helper produces qualitative
  drug-level traces from the user's injection history (steady-state
  approximation, observational use only). The chart renders on the
  GLP-1 medication detail page behind a Research-Mode gate:
  `User.researchModeAck*` columns (Migration 0058) record the
  acknowledgment version + timestamp; a dialog explains the
  EU MDR 2017/745 + MDCG 2021-24 context and cites EMA EPAR plus
  Schneck / Urva 2024 before the user can opt in.
  `GET / POST / DELETE /api/auth/me/research-mode` carries the
  acknowledgment lifecycle. A Settings → Advanced toggle exposes
  the opt-in plus a re-prompt banner whenever the acknowledgment
  version bumps.
- **GLP-1 — side-effect logging with a 21-entry × 5-category
  taxonomy.** Migration 0059 introduces the `MedicationSideEffect`
  table; pure helpers produce the taxonomy + a five-point Likert
  severity scale; a section on the GLP-1 detail page lets the user
  log entries with category + severity + free-text notes. Category
  is derived server-side from the entry (no client-supplied
  category) so the taxonomy cannot drift between client and server.
- **GLP-1 — cadence visualisation + compliance chips.** Pure
  helpers expand a medication's schedule into expected slots,
  pair each slot with the closest actual intake, and produce a
  cadence timeline + compliance chip strip on the detail page.
  `GET /api/medications/[id]/cadence` returns the structured
  payload; the helpers honour per-user timezone so cross-midnight
  doses bucket correctly regardless of locale.
- **GLP-1 — EMA titration ladder display.** Pure helpers walk the
  EMA-sourced titration schedule from the knowledge layer; the
  GLP-1 detail page renders the user's current step + remaining
  ladder as observational reference, framed as reference-not-advice
  and bound by GROUND RULE 15. `GET
  /api/medications/[id]/titration-ladder` returns the structured
  ladder + current step.
- **GLP-1 — pen-and-vial inventory with a 30-day in-use clock.**
  Migration 0056 introduces the `MedicationInventoryItem` table +
  a pure state machine (SEALED → IN_USE → EXPIRED) with a 30-day
  in-use clock from `markAsFirstUseAt`. An inventory card on the
  medication detail page surfaces the active pen, days remaining,
  and SEALED stock; intake events decrement the dose count, and a
  daily 03:00 cron flips expired in-use items in a single
  `updateMany`. Re-runs the state machine on every PATCH so a
  back-dated first-use immediately moves a stale pen to EXPIRED.
- **Apple Health identifier mapping (server-side).** Ports the
  identifier table from `k0rventen/apple-health-grafana` and
  `dogsheep/healthkit-to-sqlite` with MIT and Apache-2.0
  attribution recorded in source headers and `NOTICE`. Covers
  the v1.4.25 ingest surface; iOS-18 long-tail mappings (sleep
  apnea, GAD-7, paddle/row sports, FHIR clinical) carry inline
  release-window comments.
- **Audio-exposure and time-in-daylight measurement types.**
  Migration 0052 adds `ENVIRONMENT_AUDIO_EXPOSURE`,
  `HEADPHONE_AUDIO_EXPOSURE` and `TIME_IN_DAYLIGHT` to the
  `MeasurementType` enum. Doctor report mentions them when
  populated; no dedicated chart yet.
- **Withings expanded coverage — twelve new measurement types and
  the BP / temperature webhook subscription.** Migration 0049
  adds HRV, body temperature, SpO2 v2, VO2 max, fat-free mass,
  fat mass, muscle mass, skin temperature, pulse-wave velocity,
  vascular age and visceral fat as `MeasurementType` values.
  Withings webhook coverage extended to BP and temperature so
  the latency goes from ~1 h polling to seconds. OAuth scope
  upgraded to include `user.activity` and an in-app banner
  prompts existing users to reconnect once.
- **Withings — Activity sync (steps + distance + active-energy).**
  Calls `getactivity`, ingests one row per day, anchors at noon UTC
  so positive-offset users bucket cleanly into their local day.
  Backed by a pg-boss `activity-sync` queue plus a webhook enqueue
  hook on the new subscription channel.
- **Withings — Sleep v2 sync (stage-level segments).** Calls
  `sleepv2_get` and writes per-night stage segments through the new
  `sleepStage` composite (Migration 0055 widens the Measurement
  unique index to include `sleep_stage` with `NULLS NOT DISTINCT`).
  Backed by a pg-boss `sleep-v2-sync` queue plus webhook enqueue.
  The sleep sub-page's stacked-bar chart renders the segments
  directly.
- **Withings — webhook subscriptions expanded to activity + sleep
  v2.** Subscription registration plus webhook delivery routing for
  the two new event types.
- **Admin Login overview — location, provider and CSV polish.**
  Adds a location column derived from the audit IP; adds a
  provider column distinguishing passkey, password, API-token
  and OAuth login paths; the CSV export drops two unused columns
  and the per-row collapse affordance comes off.
- **DELETE `/api/measurements/by-external-ids` for iOS deletion
  sync.** Idempotent batch delete keyed on `(user, source,
  externalId)` tuples; rate-limited the same way as the batch
  ingest endpoint.
- **Multi-arch Docker image.** GHCR publish workflow builds
  `linux/amd64` on `ubuntu-latest` plus `linux/arm64` on
  `ubuntu-24.04-arm` and merges the manifest. Apple Silicon
  Macs and arm64 clouds now pull native; the previously-stale
  README claim is accurate again.
- **GLP-1 endpoint hardening.** `POST
  /api/medications/[id]/glp1` now parses through bounded Zod
  schemas (`glp1DoseChangePostSchema`, `glp1InventoryPostSchema`)
  with length-capped notes, finite-number guards on dose value,
  and bounded `effectiveFrom`. Every write produces an audit-log
  row and the route inherits the 30-per-minute-per-user rate
  limit from the rest of the medication surface.
- **Translation-feedback issue template.** GitHub issue template
  for community translation corrections, paired with the
  maintainership banner copy on FR / ES / IT / PL surfaces.
- **Repository polish.** README hero rewrite (what / who / try
  the demo, thirty-second read). Topics expanded 10 → 18.
  Branch protection v2 with conversation-resolution. GitHub
  Discussions enabled. Issue template + PR template carry-over
  from v1.4.20 preserved.

### Changed

- **Insights mother page slimmed; metric depth moved to sub-pages.**
  `/insights` becomes a navigation hub with hero strip + Daily
  Briefing + correlations + trends row; per-metric depth lives
  one click away on the dedicated sub-pages.
- **Targets page-shell unified with the rest of Insights.**
  Single consistency strip + Coach handoff + per-card actions
  rather than the v1.4.22 sparkline-everywhere layout.
- **Coach default-window preference plus chip-order rationalised.**
  The window picker now persists per-user (last seven / thirty /
  ninety days); suggested-prompt chips reorder so health-focus
  chips lead and meta-discovery chips trail. Composer auto-grows
  on multi-line input. Distinct error UX for daily-limit hit vs
  provider rate-limit. Microphone affordance retired (was a
  placeholder).
- **Dashboard global comparison-overlay default removed.** Per-chart
  preference from v1.4.22 is the only knob now; the dashboard-level
  default is gone.
- **`medication_schedules.*` columns mapped to snake_case via
  Prisma `@map`.** Migration 0047 — cosmetic rename only,
  convention parity with the rest of the schema. Resolves the
  v1.4.24 demo-deploy schema-drift finding.
- **Top-page padding parity across `AuthShell`, Settings and Admin
  shells.** Cross-page rhythm matches; the previous one-off
  paddings on Admin and Settings asymmetric to Insights are gone.
- **Settings icon + heading convention uniform across all twenty-
  three sections.** Every section header pairs an icon with a
  heading; the v1.4.24-era split (icon-only on some, heading-only
  on others) is gone.
- **`PROMPT_VERSION` 4.24.0 → 4.25.0** carries two new safety
  ground rules across all six locales: GROUND RULE 9 forbids GLP-1
  dose recommendations (Coach falls back to a clinical-referral
  framing on any dose question); GROUND RULE 15 forbids drug-level
  estimates and cites EU MDR 2017/745 + MDCG 2021-24 in the
  refusal copy. Coach + insights system prompts ship as native
  bodies per locale rather than the legacy `REPLY LANGUAGE`
  footer.
- **Dashboard top-tile polish.** Tile headings collapse to a
  single line per locale (BP / BF abbreviations land in EN + DE +
  the four Romance locales); the trend arrow moves inline next to
  the headline value; the value row baseline-aligns across tiles
  regardless of font fallback. Regression guard pins the baseline
  contract.
- **OpenAPI drift gate flips to hard-fail.** `pnpm openapi:check`
  CI step now red-bars a PR on any drift between the Zod registry
  and `docs/api/openapi.yaml`. The v1.4.23 warn-only window
  closes; iOS DTO codegen can rely on the spec being authoritative.
- **Coolify auto-deploy gate exposed as an explicit
  maintainer-toggleable repo variable.** `vars.COOLIFY_AUTO_DEPLOY`
  is now a `true | false` switch in the deploy workflow instead of
  the implicit secret-presence gate that silently no-op'd in
  v1.4.21-23.
- **Settings → Sources sentinel cleanup.** The `__default__`
  device-type bucket sentinel is retired in favour of a null
  bucket at the storage layer; the Settings UI reads cleaner and
  the reorder helpers (`reorderLadder`) collapse the two
  `moveSource` + `moveDeviceType` paths into one.
- **Section wrapper for medication detail.** A new
  `<MedicationDetailSection>` wraps the three medication-detail
  shells (titration, scheduling, side-effects) plus the inventory
  disclosure top so cross-section chrome stays consistent and
  future sections drop in without copy-paste.
- **Shared route ownership helper.** Nine medication routes
  (`titration`, `side-effects`, `inventory`, `cadence`, `intake`,
  `compliance`, `phase-config`, `api-endpoint`, plus the GLP-1
  convenience route) now call `assertMedicationOwnership` from
  `src/lib/medications/route-guards.ts` rather than open-coding
  the lookup; rate-limit headers across the same surface align
  on the option-bag form `apiError(..., { headers:
  rateLimitHeaders(rl) })`.

### Fixed

- **Settings save regression on Zod v4 record semantics.**
  `z.record(z.string(), …)` switched to `z.partialRecord(…)` on
  the dashboard-prefs schema so optional keys round-trip cleanly
  through the PUT. The save-then-blank-load bug from v1.4.24 is
  gone.
- **Comparison-shift baseline regression.** Comparison overlay
  was subtracting the wrong-period baseline on several charts;
  baseline lookups now match the caption window. Three regression
  guards.
- **Raw metric-token leaks in generated prose** — `metric:<TYPE>`
  identifiers surfaced in three surfaces that escaped the v1.4.22
  sweep (`<RecommendationCard>` fallback path, briefing
  `keyFinding` helper, and Coach in-flight bubble).
  `stripChartTokens()` regex widened to cover lowercase prose
  remnants; prompt-side GROUND RULES 8 and 13 reaffirm the
  constraint. PROMPT_VERSION 4.23.0 → 4.24.0 carried the prompt
  change; 4.25.0 inherits.
- **Withings BP and temperature webhook latency.** Webhook
  subscription now covers BP and temperature endpoints, so the
  earliest a measurement reaches the user drops from ~1 h to
  seconds.
- **Dev-server crash on Tailwind v4 `color-mix` parser + Next 16
  api-handler private-field.** Two unrelated dev-time crashes
  surfaced together: Tailwind v4 choked on a `color-mix()`
  invocation in a chart token; Next 16 + Webpack fallback hit a
  private-field access on a force-static route handler.
  `color-mix` invocation replaced; api-handler guards the field
  access. Production unaffected — these surfaced only under the
  dev compile path.
- **Insights duplicate `StatusCard`.** The mother page rendered
  two copies of the BP status card at certain viewports due to
  a hero-strip ↔ correlation-row overlap. Card hoisted to the
  single canonical location.
- **Coach-feedback admin header layout shift.** Sticky-header
  contract mismatch — the section's `<header>` carried a different
  top padding than its siblings, so navigating into the section
  visibly shifted the chrome. Padding parity restored across all
  admin sections.
- **Notification-status-card heading icon parity.** Was the one
  section without an icon next to its heading; aligns with the
  cross-section convention now.
- **WCAG 2.5.5 touch-target floor across the top bar, section
  strips and the injection-site picker.** Several pill chips and
  the injection-picker dots sat below the 44-px floor; all hit
  the floor now without changing the visual density at typical
  rendering sizes.
- **Sleep-stage chart strokes resolve through Dracula tokens.**
  The chart was using the legacy `hsl(var(--border))` form which
  Tailwind v4 rejects; switched to the resolved token.
- **"Per night" hardcoded German in four locales.** The
  sleep-page subtitle suffix was hardcoded `pro Nacht` and
  rendered as raw German across FR / ES / IT / PL. Translated
  in all six locales; an i18n drift-guard covers the contract.
- **Cross-page top-padding asymmetry.** AuthShell, Settings,
  Admin all carry the same top padding now (see Changed).
- **`berlinIsoWeekday()` timezone hard-code.** The weekday helper
  hardcoded Europe/Berlin; now takes a `timezone` argument and
  threads through the weight-weekday correlator.
- **Batch-ingest race reconciliation under contention.** Two
  concurrent batches with overlapping `externalId` sets returned
  inconsistent `inserted` / `duplicate` counts because the
  reconciliation pass was logically inverted (no-op when the
  catch fired). Fixed; replay regression test seeds the race.
- **`requireAuth()` blocks narrow-scope iOS Bearer tokens on
  unscoped routes.** v1.4.24 closed the inverse hole (Bearer
  with no scope reaching unscoped handlers); this release closes
  the over-broad version — a token scoped exclusively to
  `medication:ingest` could not reach handlers that don't
  declare a `requiredPermission`. Now declared-scope tokens are
  allowed through provided the route's declared scope (or wildcard)
  is in the token's set.
- **`createMeasurementSchema` dropped `deviceType` on single-entry
  POST.** The batch route accepted `deviceType` per row; the
  single-entry POST stripped it on the Zod boundary. Mirror parity
  restored.
- **Personal-records endpoint unpaginated.** `GET
  /api/personal-records` now clamps `?limit` (default twenty-five,
  maximum two hundred); the unbounded read is gone.
- **Withings activity sync bucketed positive-offset users into the
  wrong day.** The per-day row was anchored at 23:59:59 UTC, so a
  user in `Pacific/Auckland` saw activity rows attached to the
  following local day. Anchored at noon UTC (`T12:00:00.000Z`)
  with a regression suite covering Berlin / Los Angeles / Tokyo /
  Auckland.
- **Cadence and compliance helpers ignored per-user timezone.**
  `expandScheduleSlots`, `pairDoses`, `buildCadenceTimeline` and
  the compliance-chip helper now accept a `timeZone` argument that
  threads through `Intl.DateTimeFormat`, so cross-midnight doses
  bucket correctly regardless of user locale. The cadence route
  resolves through `resolveUserTimeZone(user)`.
- **Inventory state-machine ignored back-dated first-use.** Issuing
  a PATCH that pushed `markAsFirstUseAt` more than thirty days into
  the past left the item in IN_USE; the state machine now re-runs
  on every PATCH and the stale item flips to EXPIRED. Regression
  test pins the contract.
- **Inventory expire-stale cron looped per row.** Replaced the
  row-by-row `prisma.update` loop in `expireStaleInUseItems` with a
  single `updateMany`; bulk-update contract pinned by test.
- **Onboarding step write was read-then-update.** A concurrent
  advance could double-step the wizard. The update now conditions
  on `{ id, onboardingStep: current, onboardingCompletedAt: null }`
  and returns 409 on conflict.
- **Workout schema accepted `endedAt <= startedAt`.**
  `createWorkoutSchema` gained a `.superRefine` rejecting
  zero-duration and inverted windows; the PR detection worker's
  MIN-direction slot also guards against `durationSec === 0` so a
  malformed row cannot promote itself to a personal record.
- **Personal Record detection duplicate writes under contention.**
  Same-millisecond writes into a null workout slot now reconcile
  to a single row; regression test seeds the race.
- **Source-priority parse failures were silent.** Storage parse
  errors now route through an observer breadcrumb and the resolved
  blob is frozen at construction so downstream mutation is caught
  immediately.
- **Health-Score `asOf` derived non-deterministically.** The
  `asOf` timestamp now derives from the input dates instead of
  the wall clock so repeated computes against the same dataset
  produce stable timestamps.
- **Source-priority audit-log entries missed two write paths.**
  Doctor-report-prefs and source-priority PUTs were not landing
  audit-log rows; both write paths emit now.
- **Personal-record badge dark-mode contrast.** Lifted to WCAG-AA
  contrast on the `<PersonalRecordBadge>` surface.
- **Range-bar zone backgrounds.** `<RangeBar>` mixed Tailwind raw
  palette tokens with Dracula tokens; all zone backgrounds now
  resolve through Dracula tokens with the pinned test rewritten.
- **Research-Mode acknowledgment dialog footer scrolled below
  fold.** The footer pins outside the scrolling region on small
  viewports.
- **44-px touch-target floor across the onboarding wizard.**
  Shell back/skip/next, carousel pager, source-card grid, baseline
  and goals-chip CTAs all hit the WCAG 2.5.5 floor without
  changing visual density at typical rendering sizes.
- **Workout endpoint reconciled inserted-vs-duplicate counts
  incorrectly under contention.** Race-recovery path produced
  inconsistent envelope counts; corrected with a regression test
  seeding the contention window.
- **Legacy Withings `?secret=` webhook form had no counter.** An
  in-memory `withings.webhook.legacy_form_total` counter surfaces
  through `ops-stats`; the warning text gained the re-subscription
  URL for affected accounts.
- **Acknowledgment dialog i18n back-button.** Medication history
  page back-button hard-coded `Zurück`; routed through `t()`.
- **Sleep + audio-exposure + comparison-hint i18n keys.** Backfill
  pass picked up the keys missed by the v1.4.22 sweep across all
  six locales.
- **Build resolution for safety-contract YAML.** The loader now
  resolves the YAML matrix path from `cwd` rather than `__dirname`
  so the build does not break when the bundler reshapes the
  module-relative root.
- **GLP-1 drift guard self-skips when the EMA research file is
  absent.** Local checkouts without the reference file no longer
  red-bar the test.
- **`x-axis` chart ticks resolved in user timezone.**
  `xAxisTicks` now renders the tick formatter in
  `user.displayTimezone` instead of hard-coding Europe/Berlin.
- **Chart token references switched to `var(--token)` form.**
  Recharts strokes were still using `hsl(var(--token))`; switched
  to bare `var(--token)` so Tailwind v4's color-mix parser
  resolves them.
- **`detectGlp1Plateau` branches lacked direct coverage.** Added
  Prisma-mocked unit tests covering the previously-uncovered
  branches.

### Security

- **Withings webhook secret no longer leaks into structured
  logs.** `WITHINGS_WEBHOOK_SECRET` was landing as a URL
  path-segment in `http.path` on every Wide Event the request
  produced. The logging stack now carries a parameterised
  `PATH_SECRET_PATHS` registry seeded with the
  `/api/withings/webhook/[token]` shape, and
  `WideEventBuilder.setHttp` rewrites path + route segments to
  `[REDACTED]` before they reach stdout / the in-memory ring
  buffer / Loki. Existing query-string redaction is unaffected.
- **Coach refuses GLP-1 dose recommendations.** GROUND RULE 9
  across all six locales — the Coach surfaces a clinical-referral
  message on any dose adjustment ask, never a number.
  PROMPT_VERSION 4.25.0 carries the rule.
- **Coach refuses drug-level estimates with regulatory cites.**
  GROUND RULE 15 across all six locales — the Coach refuses any
  ask for an estimated drug level or pharmacokinetic prediction,
  cites EU MDR 2017/745 + MDCG 2021-24 in the refusal copy, and
  routes the user to the Research Mode disclosure flow.
  Adversarial refusal-probe matrix exercises 20+ paraphrasings per
  GROUND RULE across six locales in CI on every push, so
  prompt-injection regressions surface before reaching the
  dispatch surface.
- **Research Mode is gated by an MDR acknowledgment dialog.** The
  estimated drug-level chart on the GLP-1 detail page renders only
  after the user opts in through a dialog that cites
  EU MDR 2017/745 + MDCG 2021-24, EMA EPAR and the Schneck / Urva
  2024 pharmacokinetic reference. The acknowledgment version
  re-prompts the user on bump.
- **GLP-1 convenience endpoint hardened.** `POST
  /api/medications/[id]/glp1` parses through bounded Zod schemas
  (`glp1DoseChangePostSchema`, `glp1InventoryPostSchema`), enforces
  length caps on notes, finite-number guards on dose value, and
  bounded `effectiveFrom`; every write produces an audit-log row
  and the route inherits the 30-per-minute-per-user rate limit
  from the rest of the medication surface.
- **GLP-1 medication strings sanitised before LLM prompt
  interpolation.** A malicious or malformed medication name no
  longer reaches the prompt body verbatim. Sanitiser passes
  Latin-letter + digit + common punctuation only.
- **Batch-ingest rate limit (sixty per minute per user default).**
  `POST /api/measurements/batch`, `POST /api/workouts/batch` and
  `DELETE /api/measurements/by-external-ids` carry a token-bucket
  rate limit returning the standard 429 envelope.
- **Audit-log writes on source-priority and doctor-report-prefs
  PUTs.** Every change to either preference produces an
  `AuditLog` row for the user's audit-log surface and the admin
  cross-section view.
- **Withings OAuth `user.activity` scope upgrade with explicit
  user reconnect.** New scope only takes effect after the user
  re-authorises; the reconnect banner makes the requirement
  visible.
- **Source-priority storage is per-user.** No cross-user lookup
  paths; one user's priority blob never enters another user's
  resolver.

### Refactor / Hygiene

- **`pickCanonicalSource` becomes a two-axis lookup with single-
  axis fallback.** Reuses `getDeviceTypeLadder()` so the
  per-device override can be queried from the canonical-row picker
  without duplicating ladder logic.
- **Health-Score `COMPONENT_ORDER` hoisted + `Intl.DateTimeFormat`
  memoised.** Provenance accordion calls the formatter once per
  render rather than four times.
- **`SubPageSlug` type + array derived from `SUB_PAGE_METRIC`
  record.** Single source of truth for the seven sub-page slugs.
- **`source-priority` `__default__` sentinel → null bucket.**
  Settings → Sources stops carrying a fake `__default__` device-
  type entry; the null bucket reads cleaner at the storage layer.
- **`apple-health-mapping` sleep branch collapsed.** Three sleep-
  stage cases shared the same body; collapsed to one.
- **`HK_QUANTITY_TYPE_TO_MEASUREMENT` removed.** The legacy view
  was a redundant projection of `APPLE_HEALTH_TYPE_MAP`; all
  callers go through the canonical map now.
- **Dead-code cleanup pass.** Drops `<InsightsPageHero>` (zero
  callers since v1.4.20), `<IntakeTimeline>`, `<ComplianceCharts>`
  wrapper and three orphan `insightsGeneralStatus` query keys from
  the v1.4.16-era hero. Removes the orphan
  `/api/insights/general-status` route (superseded by
  `<InsightAdvisorCard>` since v1.4.16).
- **Coach `<CoachDrawer key={prefill}>` controlled-prop refactor
  is fully in place** — the v1.4.24 follow-up of `useResettableValue`
  is now the only call path; the legacy remount hack code is gone.
- **380 dead i18n keys dropped.** Runtime probe across the six
  locales identified 380 keys with zero call sites and zero runtime
  resolutions; all six locale bundles are smaller by that count.
  Top namespaces: `settings`, `admin`, `classifications`,
  `medications`. The remaining ~148 keys are queued for a second
  pass in v1.4.26.
- **Dead system-prompt constants removed.** `BASE_SYSTEM_PROMPT`
  and `INSIGHTS_SYSTEM_PROMPT` constants had no remaining
  importers after the native per-locale prompt move; both deleted.
- **`useInsightStatus` hook extracted.** The four insights
  sub-page status queries collapsed into a single hook so the
  duplicated `useQuery` + Suspense fallback shape lives in one
  place.
- **`<MedicationDetailSection>` wrapper.** Three medication-detail
  shells (titration, scheduling, side-effects) and the inventory
  disclosure top share a single wrapper; future medication detail
  sections drop in without copy-paste.
- **Shared helpers across the medication + onboarding surfaces.**
  New modules `src/lib/api/read-error.ts`,
  `src/lib/medications/route-guards.ts`,
  `src/lib/medications/research-mode-types.ts` and
  `src/lib/medications/dose-string.ts` consolidate previously
  duplicated patterns. Three near-identical dose-string parsers
  collapse to one `parseDoseMg`; four-times-duplicated
  `readError` collapses to one; nine medication routes call the
  shared `assertMedicationOwnership`.
- **Side-effect taxonomy drift-guard.** `SIDE_EFFECT_CATEGORY_VALUES`
  and `SIDE_EFFECT_ENTRY_VALUES` now derive from the Prisma enum
  via `z.nativeEnum`; a drift-guard test pins Prisma enum ↔
  taxonomy map ↔ validator triangle so the three cannot drift.
- **Side-effect category derived server-side.** The
  `createSideEffectSchema` no longer accepts a client-supplied
  `category`; the server derives it from the entry. Removes the
  defensive 422 path and the cross-tier drift surface.
- **Dashboard top-tile baseline alignment.** Inline trend arrow +
  baseline-aligned value row across all dashboard tiles, with the
  baseline contract pinned by regression test.
- **Range-bar Dracula token swap.** `<RangeBar>` zone backgrounds
  resolve through Dracula tokens with the pinned test rewritten;
  raw palette references gone.
- **44-px touch-target floor across the top-bar + section
  strips.** WCAG 2.5.5 alignment across the broader navigation
  surface, complementing the onboarding-specific pass.
- **Cat-C typo + naming polish from the W10 review pass.** Minor
  identifier renames flagged by the dead-code probe; no functional
  change.
- **`safeRequestProp` widened catch.** Narrowed catch broadened to
  tolerate `undefined` requests after the hygiene-review pass
  surfaced the regression.
- **`pickCanonicalWorkout` helper for cross-source workout
  dedup.** Source-priority logic centralised for the v1.5 iOS
  workout-ingest path.
- **Insights regenerate button relocated; tab strip lifted.**
  Tab-strip extraction + relocation of the regenerate button to
  the top-right, paving the way for the seven sub-page surfaces.

### Tests

- 2244 → 3828 passing unit tests across 344 files (+1584; one
  pre-existing skip carries through). Integration suite 140 → ~170
  across 11 files. e2e green on the W2 CI fix (coach-prefs URL
  mock + Pixel-5 selector hardening) plus the Fix-I hot-fix that
  re-anchored the dashboard insight-card and the mobile x-axis
  tick locators.
- **Coach refusal-probe matrix.** 1800+ assertions exercise 15
  GROUND RULES across six locales with 20+ adversarial
  paraphrasings each. CI runs the matrix on every push; any
  prompt-injection or jailbreak regression surfaces before
  reaching the dispatch surface. Drift-guard tests pin the
  YAML-per-locale safety-contract matrix in lockstep with the
  validator-derived enums.
- **New unit suites (selection):** GLP-1 plateau-detection text
  formatter; two-axis source-priority resolution (single-axis
  fallback, per-device override, mixed-bucket selection);
  source-priority Settings reducer (reorder, reset, validate);
  medication-card GLP-1 variant + injection-site-picker (RTL);
  doctor-report prefs PUT contract; personal-records pagination
  clamp; `berlinIsoWeekday` timezone-aware suite; sleep-stage
  chart i18n-suffix drift-guard; Health-Score provenance i18n
  drift-guard; api-handler private-field crash regression; pure
  cadence + compliance helpers with TZ assertions across UTC+0,
  UTC+9, UTC-8; side-effect taxonomy drift-guard; EMA titration
  ladder helpers; pen-inventory state-machine + 30-day clock
  helpers; PR detection worker (MAX / MIN per metric + workout
  slots + warmup gate + null-slot dup regression + zero-duration
  guard); Withings activity TZ regression across Berlin / Los
  Angeles / Tokyo / Auckland; Withings sleep v2 segment ingest;
  log-redaction path-segment rule + `setHttp` rewrite; GLP-1
  endpoint Zod + audit + rate-limit; onboarding step concurrent-
  advance regression; inventory PATCH state-machine back-dated
  first-use regression; bulk-update contract for the expire-stale
  cron; brand-name guard + sentinel-preservation + safety-contract
  parity for the YAML matrix; locale auto-discovery + fallback-
  chain runtime guard.
- **New integration suites:** two-axis canonical-source resolution
  end-to-end; `requireAuth()` narrow-scope on unscoped route;
  batch-ingest race reconciliation under contention; workout-batch
  race + size-cap + ingest end-to-end; PR-detection end-to-end;
  cross-source priority for Withings Activity + Apple Health;
  Withings sleep-stage composite ingest; per-user timezone end-to-
  end (Pacific/Auckland).
- **Migrations:** 9 new (0051–0059) + 1 hardening (0060
  `onboarding_step_not_null` backfill + NOT NULL flip). All
  additive and forward-only; migration 0057 comment rewritten to
  match PG11+ fast-path ADD COLUMN DEFAULT semantics.

### Deferred to v1.4.26

See `.planning/v1426-backlog.md` for the full backlog with effort
estimates and source citations. Headline items:

- `User.onboardingGoals` column + server-side persistence for the
  goals chip-picker selection (today the picker holds the choice
  client-side only; the dashboard-widgets seed feature reads it in
  v1.4.26).
- `advance()` hook extraction for the three onboarding step
  components — pattern surfaced in the simplifier review, deferred
  to avoid collision with v1.4.25 touch-target work.
- `glp1-pk.ts` unused-export decision (internalise vs wire
  dashboard chip).
- Seven orphan endpoint go / no-go decisions
  (`/api/admin/ai-settings`, `/api/admin/backup/test`,
  `/api/admin/status-overview`,
  `/api/monitoring/{glitchtip,umami}/test`).
- ~148 dead i18n keys remaining after the W10 runtime-probe sweep
  (the v1.4.25 pass removed 380 of the 528 candidates; the
  remaining ~148 need second-pass call-site verification).
- FR / ES / IT / PL prose hand-review by a native speaker for the
  Coach + insights surface (the structural refusal-probe matrix
  covers safety; the user-facing prose still benefits from a
  human pass).
- Coach `lastYear` baseline + row-tap-to-prefill polish.
- Sleep sub-page stacked-column visual polish (stage colours +
  legend density).
- Mood verbal-labels persistence behind a per-user toggle.
- Drug-level chart-side 90-day staleness clock wiring (the
  acknowledgment dialog already re-prompts on version bump and
  Coach refuses at GROUND RULE 15; the clock is defence-in-depth).
- iOS-18 long-tail HK identifier mappings (sleep apnea, GAD-7 /
  PHQ-9, running form, paddle / row / ski distances, pregnancy /
  cycle, FHIR clinical).
- VO2 max chart-row card on `/insights/<metric>` (dashboard tile
  shipped; chart card queued alongside the iOS body-composition
  page).
- Lazy-loaded locale JSON bundles (all six locales import
  synchronously at present, ~675 KB to every client).

### Deferred to v1.5

- **iOS Swift app — P1 through P5.** Login + dashboard + widget
  (P1); Apple Health sync (P2); Coach extended for HRV / sleep /
  resting HR / steps (P3); per-metric APNs alerts (P4); workouts
  + GeoJSON routes (P5). All server contracts locked in v1.4.25.
- **Workout ingest API matching the v1.5 iOS contract.**
  Schema shipped this release; endpoint signature finalised
  during the iOS sprint.
- **Two-Brain Coach refactor.** Statistical findings produced
  by a deterministic pipeline; LLM owns the narrative layer
  only. Reduces hallucination surface; unblocks evidence-grounded
  citations.
- **HRV anomaly detection against a rolling baseline.**
- **Mindfulness, dietary-water and symptoms-unification ingest
  types.**
- **ECG waveform ingest + FHIR / HKClinicalRecord.**
- **Pearson incomplete-beta replacement** for the rigorous
  surfacing-gate (v1.4.23 carryover).

## [1.4.24] — 2026-05-12

Security + accessibility hardening release. Closes the highest-priority
findings from a focused security audit of the v1.4.23 release: a Bearer
token that omits a scope no longer authenticates routes which never
declared one, the public Umami proxy is rate-limited, the proxy nonce
is Edge-runtime portable, a session-expiry delete race can no longer
500 a parallel request, the import-validation envelope now matches the
standard error contract, and the runtime Docker image installs Prisma
7.8 alongside pinned worker dependencies. Accessibility passes on the
notifications surface, admin shell, chart overlays and notification
settings deep-link anchors round out the user-facing work.

### Security

- **Bearer auth is fail-closed when a route declares no scope.**
  `requireAuth()` previously let any non-revoked, non-expired API token
  through whenever a handler omitted the `requiredPermission` argument.
  A narrowly-scoped token (e.g. `["medication:ingest"]`) could therefore
  reach every handler that called `requireAuth()` bare — including
  account-sensitive routes such as `/api/auth/profile`,
  `/api/auth/password`, `/api/withings/credentials`,
  `/api/settings/data`, `/api/export/full-backup` and `/api/tokens`.
  The Bearer path now throws `HttpError(403)` with audit reason
  `scope_required` unless the token carries the `["*"]` wildcard
  (the iOS app login token), preserving the existing session-cookie
  path and the explicit-scope path (`/api/ingest/medications`). The
  admin surface is unaffected — `requireAdmin()` was already
  cookie-only.
- **Public Umami analytics proxy now rate-limits by client IP.**
  `POST /api/send` forwards browser analytics events to the configured
  Umami origin. The SSRF allow-list and 64 KB body cap were already in
  place, but the endpoint itself was unbounded. Added a 120-events-per-
  minute-per-IP gate using the existing `checkRateLimit` infrastructure;
  abuse returns the standard `429` envelope without invoking the
  upstream fetch.
- **Edge-runtime portable nonce generation in the proxy.** The proxy
  previously assembled the CSP nonce via `Buffer.from(...)`, which is
  not guaranteed in the Edge runtime. Switched to
  `btoa(String.fromCharCode(...new Uint8Array(16)))`. Same 128 bits of
  entropy, Node-and-Edge compatible without a runtime declaration.
- **Session-expiry delete race no longer 500s a parallel request.**
  `getSession()` reaped expired session rows with `prisma.session
.delete()`; two requests arriving at the same expired session would
  race and the loser would surface a 500. Replaced with `deleteMany` +
  a catch-all guard, matching the discipline already used in
  `destroySession()`.

### Fixed

- **`POST /api/import` returns the standard `{ data: null, error }`
  envelope on validation failure.** The handler previously returned
  the validation message inside `apiSuccess(...)` with status 422,
  which clients could not distinguish from a successful import.
- **Runtime Docker image pins Prisma 7.8 + worker dependencies.** The
  multi-stage image was installing `prisma@7.4.0`, `@prisma/engines
@7.4.0`, unpinned `pg-boss@12`, `@prisma/adapter-pg@7` and `pg@8`
  into the worker prefix while the app code shipped Prisma 7.8 from
  the lockfile. Pinned to `prisma@7.8`, `@prisma/engines@7.8`,
  `pg-boss@12.18`, `@prisma/adapter-pg@7.8` and `pg@8.20` so
  migration engine and generated client cannot drift across a deploy.
- **Notifications page surfaces a load error instead of a silent
  "no channels" empty state.** `useQuery` failures now render an
  alert with `role="alert"` and `notifications.loadError` copy
  (EN/DE), so a transient 500 on `/api/notifications/preferences`
  stops looking like a misconfiguration.

### Accessibility

- **Notification-preference switches carry accessible names.** Each
  switch in the per-event table now exposes an `aria-label` combining
  event-type label and channel label; the mobile per-event layout pairs
  each `<Switch>` with its `<Label>` via `htmlFor`/`id` so screen
  readers announce the channel a toggle controls.
- **Mobile admin navigation surfaces an Overview link.** The mobile
  admin section pill-rail prepended an Overview chip pointing at
  `/admin`, matching the desktop sidebar root and unblocking users
  who land on a sub-section without a path back.
- **Notification settings deep-link anchors land on the right card.**
  Onboarding and admin-driven deep links into `#telegram`, `#ntfy`
  and `#web-push` now resolve to the corresponding cards in
  `NotificationsSection` instead of falling back to top-of-page.
- **Chart-overlay comparison-baseline toggles expose `aria-pressed`.**
  The new per-chart comparison-baseline selector renders three
  pill buttons (none / last month / last year) with the correct
  pressed-state semantics for assistive tech.

### Changed

- **Per-chart `comparisonBaseline` overlay preference.** The
  comparison overlay is now configurable per chart from the existing
  overlay-controls popover instead of being a single global toggle.
  `ChartOverlayPrefs` adds a `comparisonBaseline: "none" | "lastMonth"
| "lastYear"` field (defaults to `"none"`); a per-chart selection
  overrides the dashboard-level default for that chart only.
  `ChartOverlayKey` is extended with `bmi`, `bodyFat`, `sleep` and
  `steps`, mirroring the chart surfaces already on the dashboard.
- **Trend-card layout tolerates long labels and long values.**
  `TrendCard` switches to `min-w-0` + `flex-wrap` containers and
  `[overflow-wrap:anywhere]` text utilities so locale labels
  ("Letzter Wert" / "Resting Heart Rate") and large tabular numbers
  no longer push the tile off-axis on narrow viewports.
- **Lint-clean Coach drawer + message thread.** The `useCallback`
  dependency on the drawer's reset closure now includes the stable
  `setInputValue` setter, and the message thread memoises the
  derived `messages` array. Both removed the only two warning-level
  hook lints carried over from v1.4.23.

### Tests

- New unit test in `require-auth-bearer.test.ts` proves that a Bearer
  token with permissions `["medication:ingest"]` is rejected (403
  with audit reason `scope_required`) when the route did not declare
  a scope; the existing success case was updated to use the wildcard
  scope so the new fail-closed branch does not collide with it.
- New unit suite under `src/lib/auth/__tests__/session.test.ts`
  covers the expired-session delete-race path: a rejected `deleteMany`
  must still resolve `getSession()` to `null` and clear both the
  session and onboarding cookies.
- New unit suite under `src/app/api/send/__tests__/route.test.ts`
  covers the rate-limited Umami proxy: a 429 short-circuits the
  upstream fetch and a 200 still proxies under quota.
- Extended import-route test asserts the new `apiError` envelope:
  `data === null` and a populated `error` for invalid payloads.

## [1.4.23] — 2026-05-11

### Added

- **Apple Health measurement schema + batch-ingest contract.** Seven
  new `MeasurementType` values (`HEART_RATE_VARIABILITY`,
  `RESTING_HEART_RATE`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
  `WALKING_RUNNING_DISTANCE`, `VO2_MAX`, `BODY_TEMPERATURE`),
  `APPLE_HEALTH` joins `MeasurementSource`, and `Measurement` picks
  up a nullable `sleepStage` column scoped via CHECK constraint to
  `SLEEP_DURATION` rows. Sleep is now persisted in minutes instead
  of hours. Migration `0036_apple_health_measurement_types` is
  strictly additive — no row mutations, no rename, the legacy
  `(user_id, type, measured_at, source)` unique index stays. A new
  composite unique index `(user_id, type, source, external_id)`
  becomes the Apple Health dedup key. New endpoint
  `POST /api/measurements/batch` accepts ≤500 entries per call,
  wraps `withIdempotency()`, returns per-entry
  `inserted | duplicate | skipped` status with a typed reason field,
  and is idempotency-replay safe. Sleep-stage aggregation in
  `/api/analytics` rolls multi-stage nights into one Berlin-day
  datapoint with a per-stage breakdown over the trailing 30 days.
- **APNs scaffolding + dispatcher cascade rewire.** `@parse/node-apn`
  joins the senders cascade as channel-type 4 (APNs → Telegram → ntfy
  → Web Push, deterministic order). Provider is lazily-initialised
  per gateway (`sandbox` vs `production`), JWT auto-rotates inside
  the library. Permanent failures (`Unregistered`, `BadDeviceToken`,
  `DeviceTokenNotForTopic`) drop the dead Device row mirroring the
  web-push 410 cleanup. `Device` model gains nullable `apnsToken` +
  `apnsEnvironment` columns with a paired CHECK constraint (either
  both set or both null) and a partial unique index on `apns_token`.
  Migration `0037_apns_device_columns`. `POST /api/devices` accepts
  paired `apnsToken` + `apnsEnvironment` with a 422 when one comes
  without the other and a 409 + `apns_token_owned_by_other_user`
  audit reason when a token already belongs to a different account.
  Production without `APNS_KEY_ID` is a no-op rather than a boot
  failure; partially-set env triggers a single warning at first
  dispatch.
- **OpenAPI 3.1 generator + drift CI gate.** `pnpm openapi:generate`
  reads Zod v4 `.meta()` annotations on the existing validation
  schemas and emits a byte-stable `docs/api/openapi.yaml` (`zod-openapi`
  - `yaml@^2` with `sortMapEntries: true`). The eight iOS-critical
    routes are registered now: `auth/login`, passkey verify,
    `auth/refresh`, `measurements` GET + POST + batch, `devices` POST,
    and the comprehensive insights bundle. A new `pnpm openapi:check`
    CI step diffs generated vs committed; warn-only for v1.4.23 so a
    registry oversight on a non-iOS route doesn't red-bar a PR, flips
    to hard-fail in v1.4.24. The legacy hand-maintained spec is
    preserved at `docs/api/openapi-v1422-legacy.yaml` so iOS DTO
    reference doesn't disappear during the incremental migration.
- **Device-management endpoints for native + web settings.**
  `GET /api/auth/me/devices` lists active devices with label, last-
  seen timestamp, channels (`web_push` / `apns`), and an `isCurrent`
  marker keyed off the session's `deviceId` (not the forgeable
  `X-Device-Id` header). `DELETE /api/auth/me/devices/[id]` revokes
  a single device in one transaction: refresh tokens, access tokens,
  notification channels, push subscriptions, and the `Device` row.
  `DELETE /api/devices/[id]` is the native-friendly mirror the iOS
  APNs-rotation flow calls. Cross-user attempts return 404 with no
  enumeration leak.
- **Per-user Coach prefs surface (settings cog returns).** New
  `User.coachPrefsJson` column (migration `0038_coach_prefs`) +
  `GET / PUT /api/auth/me/coach-prefs`. The settings cog on the
  Coach drawer opens a right-edge `<Sheet>` letting users dial in
  `tone`, `verbosity`, focus-metrics, and exclude-metrics. The
  system prompt prepends a per-user OVERRIDE block; the snapshot
  pipeline reads prefs BEFORE measurement queries so excluded
  metrics never enter the snapshot in the first place.
- **Per-message Coach thumbs feedback + admin aggregate view.** Each
  Coach reply renders a 👍 / 👎 affordance. `RecommendationFeedback`
  gains a polymorphic `target_type` discriminator (migration
  `0040_recommendation_feedback_target_type`); legacy recommendation
  feedback rows backfill to `RECOMMENDATION`, new Coach rows persist
  with `COACH_MESSAGE` and the message's `coach_messages.id`. New
  endpoint `POST /api/insights/chat/messages/:id/feedback`. A new
  admin section `/admin/coach-feedback` renders helpful-rate buckets
  by (promptVersion, tone, verbosity) and gets a sidebar entry
  - EN/DE i18n bundle.

### Changed

- **Refresh-token reuse-detection scopes to the originating device.**
  Pre-1.4.23 a replayed refresh token revoked every refresh token
  the user owned. v1.4.23 narrows the blast radius to the device
  that issued the token (legacy null-deviceId tokens still fall back
  to user-wide revoke as a safety hatch). A two-device household no
  longer gets logged out of both phones when one replays.
- **Pearson surfacing gate raised from n≥14 to n≥20.** Conservative
  patch on the low-df p-value path — trades a small number of
  borderline correlation cards for stricter false-positive control.
  The rigorous incomplete-beta replacement is queued for v1.4.24.
- **Coach drawer prefill becomes a controlled prop.** The
  `<CoachDrawer key={prefill}>` mount-cycle hack is replaced with a
  `useResettableValue` hook + pure `nextResettableValue` helper. The
  drawer rerenders without remounting; the prefill state lives on
  the parent as a fully-controlled input.
- **`/api/analytics` BP-in-target aggregate becomes cursor-paged.**
  The unbounded `findMany` lands as `fetchBpSeriesChunked` cursoring
  in 5 000-row batches with a new `analytics.bp_in_target.row_count`
  wide-event for slow-query attribution. Replay regression test
  seeds 6 000 rows across a chunk boundary.
- **Coolify webhook contract documented end-to-end.** GHCR build →
  `force=true` Coolify deploy → `/api/version` poll → host-side
  retag fallback if the `:latest` digest hasn't moved. The CI step
  now emits a `::notice::` line with the deploy timestamp + image
  sha so future runs surface the contract without opening the
  verbose log.
- **Coach feedback foreign-key targets `coach_messages` directly.**
  The plaintext `content` column on `recommendation_feedback` is
  retired — feedback rows now reference the canonical encrypted
  message row, and the aggregator queries through the FK rather
  than reading prose into memory.
- **PROMPT_VERSION 4.22.0 → 4.23.0** with a new GROUND RULE 12
  (EN + DE): treat Apple Health categories (HRV, sleep, resting HR,
  steps, active energy, flights, distance, VO2 max, body temp) as
  silent when the snapshot doesn't carry them. No apologetic openers
  about missing data. `aiInsightResponseSchema.dailyBriefing
.keyFindings[].sourceMetric` and `trendAnnotations` enums extend
  to admit the nine additive HealthKit categories.
- **`medication_schedules.days_of_week` column deployed.** Migration
  `0039_medication_schedule_days_of_week` adds the nullable column
  (NULL = daily). Closes the v1.4.22 schema-drift watchlist item.

### Fixed

- **Admin coach-feedback sidebar entry.** The W5 H7 admin section
  shipped without a sidebar nav entry, so the page was unreachable
  from the chrome.
- **APNs `NotificationChannel` auto-upsert on device registration.**
  Registering a fresh device with an `apnsToken` now creates the
  matching `NotificationChannel` row in the same transaction
  instead of leaving the device row orphaned from the cascade.
- **Partial unique index enforces `apns_token` global uniqueness.**
  App-layer guard catches the cross-user-hijack case; the DB-layer
  partial unique index (`CREATE UNIQUE INDEX … WHERE apns_token IS
NOT NULL`) is the defence-in-depth backstop.
- **Apple Health source badge renders on mobile measurement card.**
  Desktop list rendered the chip; the mobile card variant fell back
  to source-less prose. Both surfaces now share the same renderer.
- **Coach prefs sheet skeleton + save toast.** Initial open painted
  a flash of unstyled defaults; save action ran silently. The sheet
  now shows a skeleton during the prefetch and confirms persistence
  via the standard toast.
- **Device revoke cascade wraps refresh + access + channels + Device
  row in one transaction.** Pre-fix a mid-flight failure could leave
  the device row gone while the refresh tokens stayed live.
- **`isCurrent` device marker keys off the session's `deviceId`,
  not `X-Device-Id`.** The header is forgeable; the cookie-bound
  session record is not. Regression test in the device-list route.
- **Sentinel parser annotates partial-malformed entries instead of
  collapsing the whole block.** `SentinelParseResult.malformedEntries[]`
  now carries per-line typed reasons; the chat route splits
  `coach.keyvalues.parse_partial` from the full-block
  `coach.keyvalues.parse_failed` wide-event for partial recovery.

### Security

- **APNs send-side defence-in-depth.** Hex format validated at the
  registration boundary; cross-user-hijack guard duplicated at the
  APNs-token layer (409 + dedicated audit reason). Send-side payload
  redacts the resolved user + device IDs before logging.
- **Coolify webhook URL scrubbed from the deploy runbook.** Webhook
  - token live in GH secrets; the runbook references the secret
    names rather than the raw URL.
- **Coach prose encryption-at-rest restored.** The plaintext
  `content` column on `recommendation_feedback` was dropped after
  the feedback rows migrated to a `coach_messages` FK. Cypher text
  is now the only on-disk form.

### Refactor

- **`revokeDeviceCascade(deviceId)` helper.** The four-way revoke
  (refresh + access + channels + device row) lived inline at three
  call sites. Helper now owns the transaction wrapper; call sites
  drop to one line.
- **`useCoachPrefs()` hook.** Coach drawer + settings sheet shared
  the same fetch + mutate + invalidate triplet; the hook collapses
  the three call sites into one with shared optimistic-update logic.
- **`buildCoachSnapshot` scope-record argument.** The build pipeline
  passed seven booleans across three callees; collapses to a single
  `scope` record. Per-stream toggles read off `scope.has(metric)`.
- **OpenAPI registry uses static imports instead of dynamic
  require.** The lazy require pattern broke type inference at the
  registration site; the static import keeps the generator output
  deterministic.

### Deferred to v1.4.24

- Pearson incomplete-beta p-value (W5 H6 carried as the
  conservative n≥20 patch).
- Settings-cog vs per-message-controls UX consolidation
  (waits on first-week thumbs data).
- OpenAPI drift gate flip from warn-only to hard-fail
  (requires registry catch-up first).
- `coach-prefs.test.ts` integration `NextRequest` URL mock
  regression — predates v1.4.23, surfaced during the W6 reconcile.
- Sec-MED-1 follow-ups: intra-batch dedup accounting (Sec-LOW-1),
  idempotency 422 retry hint (Sec-LOW-2), APNs key-file path
  redaction (Sec-LOW-3), refresh-failure audit userId (Sec-LOW-4).

### Deferred to v1.5

- iOS native client (P1: login + dashboard + widget) — server
  contracts all locked in v1.4.23.
- Apple Health sync (P2) — schema + batch endpoint shipped; iOS
  `HealthKitService` + `SyncCoordinator` wire still pending.
- Coach extended for HRV / Sleep / Resting HR / Steps (P3) — schema
  slot + GROUND RULE 12 landed; prompt rules + i18n bundles pending.
- Per-metric APNs alerts (P4) — sender + dispatcher shipped; per-
  event opt-out + background pushes pending.

## [1.4.22] — 2026-05-10

### Added

- **Per-target sparkline + Δ-vs-last-month caption on the Targets /
  Zielwerte page.** Each `<TargetCard>` grew a 30-day inline SVG
  sparkline beneath the range bar plus a localised "Δ −2.3 kg vs.
  last month" caption. The API ships `points30d` and
  `deltaVsLastMonth` per target; both null when either window has
  fewer than 3 readings so cold-start accounts don't paint a
  misleading flat trace. BMI piggybacks on the weight series so its
  sparkline shares the range bar's y-axis.
- **Sticky section navigation above the Insights hero.** A pinned
  strip (Allgemein / Blutdruck / Gewicht / Puls / Stimmung in DE;
  General / Blood Pressure / Weight / Pulse / Mood in EN) lifts the
  section tabs above the hero so they stay visible during scroll.
  Active section tracks the highest-intersection observed entry;
  `aria-current`, focus-visible ring, and `motion-reduce` gating
  ship from day one.
- **Comparison-overlay as a single global preference under Settings
  → Dashboard.** The on-surface `<CompareToggle />` retired from
  `/insights`; the canonical picker has lived in Settings →
  Dashboard since v1.4.16 phase B8 and every chart already consumed
  it. Two surfaces for the same concept violated the
  no-split-Settings rule.
- **Collapsible evidence disclosure under each Coach assistant
  message.** Numbers move out of the prose into a
  `---KEYVALUES---` … `---END---` sentinel block that the route
  parses out server-side and renders as a "Worauf bezieht sich
  das?" / "What I'm looking at" `<details>` disclosure under each
  assistant turn. Closed by default, hidden when no key-values came
  back. Hard caps on the sentinel (1 KB payload, 8 lines max,
  per-line Zod) so a prompt-injection attempt can't grow the
  persisted envelope.
- **User avatar parity with the Coach avatar.** The Coach drawer's
  user-side bubble used a smaller initials avatar than the Coach's
  gradient one. The user avatar now reuses the existing
  `gravatarUrl` field from `/api/auth/me` at the same dimensions
  as the Coach avatar; initials fall back when no Gravatar is
  configured.

### Changed

- **Coach prompt rewrite — warm, motivational-interviewing tone
  with prose-first responses + evidence collapsible.** PROMPT_VERSION
  ratchets 4.20.2 → 4.22.0 (first minor-digit bump in v1.4.x). The
  Coach used to open every reply with a number — clinical,
  database-cursor energy. The new persona is "warm, neugierig,
  zurückhaltend": a partner sitting alongside the user, not pushing
  data. Numbers move into the collapsible evidence block; the prose
  reads like a real conversation. Persona + sentinel land together
  because either alone is incomplete.
- **BP-in-target headline re-anchored to the last-30-day window.**
  Fourth attempt at this metric. v1.4.19 routed the headline to
  `allTime` to fix the algorithmic 50/50/50 pin; v1.4.22 re-anchors
  to `windows.last30Days?.pct` and surfaces all-time as a sub-row,
  because v1.4.19's fix was emotionally wrong — the headline became
  the slowest-moving aggregate possible, punishing a user who put
  in real recent work. The tile also gets a synthesised trend arrow
  (slope from 7d/30d delta), a 7-day-trend chip, and a
  comparison-overlay caption.
- **"Muster" renamed to "Zusammenhänge" (DE) / "Patterns" renamed
  to "Relationships" (EN).** The picked-bucket-of-correlations row
  read like an autopsy. The new label sits closer to what the row
  actually shows. Picked "Zusammenhänge" over "Trends" because the
  row directly above already uses Trends.
- **Onboarding redirect for users with `null onboardingCompletedAt`
  moves to server-side enforcement in `proxy.ts`.** The previous
  post-hydration redirect inside `<AuthShell>` `useEffect` produced
  a brief dashboard flash on incomplete onboarding. The proxy runs
  in the Edge runtime so the auth routes mirror
  `onboardingCompletedAt` into a non-httpOnly `hl_onboarding`
  cookie; the proxy short-circuits before hydration. Tampering only
  skips a UX hint and never bypasses a server check.
- **`setOnboardingPendingCookie` folded into `createSession()`.**
  Issuing a session without onboarding state used to require two
  call sites to stay in sync; the helper now takes
  `onboardingPending` as a required parameter so the contract is
  type-impossible to break.

### Fixed

- **Raw `metric:<TYPE>` token leaks in recommendation prose.**
  `<RecommendationCard>` text is now wrapped in
  `stripChartTokens()`. The leak traced to a single missing call
  on the recommendation path; chart tokens never belonged in user
  copy.
- **DE locale `componentMood`, `componentBp`, `componentCompliance`
  rendered English nouns in the German bundle.** Four Health-Score
  component labels normalised to `Stimmung`, `Blutdruck`,
  `Einnahmetreue`, `Gewicht`. The i18n-integrity test pins the
  contract.
- **Admin / API tokens horizontal scrollbar at desktop + iPad-mini
  viewports (5th attempt).** A live Playwright probe confirmed
  `whitespace-nowrap` on the date `<td>`s was the residual
  culprit. The two classes are gone; date + time wraps to two
  lines on narrow viewports. The earlier four fixes had targeted
  the wrong layout layer.
- **Sentinel-only / malformed `---KEYVALUES---` block.** When the
  model emits a sentinel-only or malformed envelope, the fallback
  now produces a polite invitation ("I'd like to look at this with
  you — could you share which window you want me to focus on?")
  instead of surfacing the raw marker. A new integration test
  covers the empty-prose-after-strip branch.
- **BD-Zielbereich tile delta math period-aligned with the
  comparison window.** The tile's compareDelta was subtracting
  `bpInTargetPctAllTime` while the caption said "vs last month",
  which produced numbers the caption couldn't justify. It now
  subtracts `bpInTargetPctPriorMonth` / `bpInTargetPctPriorYear`
  to match. Two new bp-in-target unit tests + two
  insights-polish guards.
- **Coach drawer settings cog removed.** The cog was a dead button
  in v1.4.21; per-user prompt-tuning is deferred to v1.4.23. No
  dead buttons in this release.
- **Coach disclaimer pinned at the bottom of the message thread.**
  Clinical-adjacent UI must not gate the disclaimer behind a
  chevron tray; the disclaimer now stays visible at the bottom of
  the message thread on every viewport, and the rail-footer
  duplicate kept for desktop redundancy.
- **`hl_onboarding` UX-hint cookie now `SameSite=Strict`.** A
  cross-site request couldn't usefully exfiltrate the cookie
  (no auth value, only an onboarding state flag) but `Lax` was
  still over-permissive. Strict aligns with the cookie's
  same-site-only consumer.
- **`PUBLIC_PATHS` exact-match guard against future subroute
  prefix bypasses.** `/onboarding` is now exact-match +
  explicit-subroute, not a `startsWith` check. Two new proxy
  guards pin the contract.
- **`targets/route.ts` daily buckets keyed in Europe/Berlin.**
  The targets sparkline was the last analytics surface still
  bucketing in UTC, which produced a one-day-off trace for users
  in CEST. `berlinDayKey()` lifted to a shared
  `src/lib/analytics/berlin-day.ts` helper; four new DST + UTC-
  midnight edge-case unit tests.
- **Streaming bubble vs persisted-twin race window.** The
  150ms grace window suppresses the persisted twin while the
  in-flight streaming bubble is still rendering, so the thread
  never paints two copies of the same reply for a frame.
- **Sticky section navigation a11y polish.** `aria-current` on
  the active section; focus-visible ring on keyboard navigation;
  `motion-reduce` honoured for smooth-scroll; the glow-bleed
  fixed via `bg-background/95 backdrop-blur`; the mobile cliff
  tightened from `scroll-mt-28` to `scroll-mt-16` so the strip
  no longer eats the heading at 280px viewports.
- **BP tile mobile density at <sm.** All-time + delta now
  collapse into one secondary line on small viewports; the
  full layout returns at `>=sm`.

### Refactor

- **`createSseStream` shared helper extracted from the chat
  route.** Preparation for v1.5 iOS streaming endpoints, which
  will reuse the SSE primitives. Three unit tests pin sync,
  async, and throw paths. Source: `src/lib/sse/create-stream.ts`.
- **`<TokenStatusBadge>` extracted from desktop + mobile
  api-token surfaces.** The badge logic was duplicated verbatim
  in two layouts; one component, two consumers.
- **Five simplify apply-yes items in one commit.** `canSubmit`
  collapse, weekly-report `<Button>` dedup, and three smaller
  cleanups identified in the W5 simplify pass.

### Operational / hygiene

- **Coolify image-digest auto-deploy.** Instructions for the
  one-time UI-toggle ("Watch image registry for new digests")
  live at `.planning/coolify-auto-deploy-howto.md`. Future
  releases should drop the host-side retag fallback the moment
  the toggle is on.
- **191 maintainer-name references in `src/` source comments
  swept** (FX carry-over from v1.4.20). Test fixtures kept as
  opaque test data.
- **DE+EN bilingual CHANGELOG entries (v1.4.14 + v1.4.15)
  normalised to English-only.** Per the English-only voice
  rule.
- **`CLAUDE.md` filename retired (FX carry-over)** so the
  filename is no longer AI-vendor-specific; `CONTRIBUTING.md`
  reference updated. `AGENTS.md` stays for multi-agent
  compatibility.

### Deferred to v1.4.23

See `.planning/v1422-backlog.md` for the full carry-over list.
Highlights: sentinel parser malformed-enum hardening (Sr-M5);
analytics-route unbounded `findMany` paging; targets-route
7-pass sparkline coalesce; `CoachDrawer key={prefill}`
controlled-prop refactor (Sr-HIGH-4); per-user prompt-tuning
surface; medication_schedules.days_of_week schema-drift cleanup.

### Deferred to v1.5 (iOS push)

See `.planning/phase-W5-v1422-product-lead-review.md` for the
full v1.5 plan. Headline: iOS native client + Apple Health
ingest contract (HRV, Sleep, Resting HR, Steps, BodyFat,
Glucose); per-metric APNs alerts; OpenAPI spec drift CI gate;
Coach extension for the new measurement types
(PROMPT_VERSION 4.22.0 → 5.0.0).

## [1.4.21] — 2026-05-10

### Fixed

- **Daily Briefing regenerate produced an empty card.** The
  `/api/insights/generate` route was still calling the legacy
  `getInsightsSystemPrompt`, which returns the v1.4.5 schema and
  never asks the model for a `dailyBriefing` block. Re-runs from the
  hero strip therefore stored a payload with no briefing and the
  card painted its empty state forever. The route now uses
  `getStrictInsightsSystemPrompt(locale)` so the v1.4.20 ground
  rules apply to manual regeneration too. Cached legacy blobs still
  parse — every new schema field is optional with `passthrough()`.
- **Duplicate streaming bubble after the assistant reply landed.**
  After SSE `done` the streaming hook keeps `streaming.content`
  populated to support the in-flight render path, then fires a
  TanStack invalidate that pulls the persisted assistant message
  into `conversation.messages`. The thread therefore rendered the
  reply twice until the next `send` reset cleared it. The render
  path now suppresses the in-flight bubble as soon as the persisted
  twin lands, keyed on `streaming.messageId`.
- **Settings cog overlapped by the drawer's close-X.** Radix Sheet
  paints its default close-X at `top-4 right-4`, which visually
  swallowed the cog in the right-edge button cluster. The cog moves
  to the left header zone (next to the gradient avatar) and a
  `pr-12 / sm:pr-14` padding rule keeps the New-chat button out of
  the close-X area on narrower viewports.
- **Suggested-prompt chips below the 36px touch target.** Chips
  rendered at 28px which fell short of the WCAG-AA target-size
  guideline. Padding bumped to land on a 36px hit area.

### Changed

- **Coach context now carries day-level readings instead of
  aggregates only.** `buildCoachSnapshot` folds in a
  `timeline.recent` block (one row per UTC day for the last 14 days,
  each tagged with weekday) and a `timeline.weekly` block (ISO-week
  buckets covering the rest of the analysis window). Systolic and
  diastolic pair into a single BP row per day; half-measured days
  drop so the model never fabricates a complement. Per-day
  medication-adherence rows draw from `MedicationIntakeEvent`. The
  EN and DE Coach system prompts gain a DAY-LEVEL READINGS section
  instructing the model to answer day-specific or weekday-specific
  questions out of `timeline.recent` with date + weekday citations,
  acknowledge missing days plainly, and fall back to
  `timeline.weekly` for older windows. Token cost per Coach turn
  rises from ≈190 tokens (aggregates only) to ≈3000 tokens for a
  full-scope snapshot. The new scope picker is the relief valve.

### Added

- **Per-source + per-window scope picker on the Coach sources rail.**
  The sources rail grew real per-source checkboxes (BP / Weight /
  Pulse / Mood / Compliance — 36px touch target, 60% opacity when
  excluded) and a window selector (last 7 days / 30 days / 90 days /
  all-time). The drawer owns the scope state and forwards picked
  scope through `useSendCoachMessage` to the chat request body.
  Toggles reset to the all-source last-30-days default each drawer
  open. The scope payload only ships when the user has narrowed
  away from the default — server can tell "no opinion" from
  "intentionally narrow". A single-source last-7-days narrowed turn
  lands around ≈600–700 tokens.

## [1.4.20] — 2026-05-10

### Added

- **Insights redesign — hero strip, Daily Briefing, Suggested Prompts.**
  `/insights` opens with a new hero strip that pairs a time-of-day
  greeting and primary action row with a strip of suggested-prompt
  chips. Below the hero, a Daily Briefing card surfaces an AI-generated
  paragraph plus three keyFindings drawn from the last 24-hour window.
  Suggested-prompt chips drive the Coach drawer with prefill text.
- **AI Coach drawer with streaming chat and encrypted persistence.**
  A right-side drawer over `/insights` hosts a streaming Coach
  conversation. `POST /api/insights/chat` is an SSE endpoint that
  walks the existing AI provider chain and emits `token` →
  `provenance` → `done` frames. Conversation history persists across
  sessions; `GET /api/insights/chat`, `GET /api/insights/chat/[id]`,
  and `DELETE /api/insights/chat/[id]` round-trip the history rail.
  Source-chip provenance attaches to every assistant turn (metric,
  window, n-count — labels only, never raw values). The drawer mounts
  via the hero strip's "Ask the coach" button or any suggested-prompt
  chip. Three-column layout on `lg+` (history rail · message thread ·
  sources rail), full-screen single-column on mobile with chevron-
  button trays for the rails.
- **Correlation discovery — 3 hypothesis cards.** A new
  `<CorrelationRow>` between Daily Briefing and the Advisor card
  surfaces three pre-defined hypotheses (BP × medication compliance,
  mood × pulse, weight × weekday) with Pearson r + Fisher-z
  confidence interval. Surfacing gate: n ≥ 14 paired observations
  and p < 0.05; below the gate the cards stay collapsed.
- **Trends row with AI annotations.** A new `<TrendsRow>` mounts
  alongside the correlation cards. Each annotation is a short
  AI-generated callout tied to a specific date in the analyzed
  window; the BP timeline gains storyboard markers at the same
  positions via an additive `annotations[]` prop on `<HealthChart>`.
- **Weekly Report at `/insights/report/[week]`.** A newsletter-style
  printable surface with Summary / Going-well / Worth-watching /
  Tips / Data-quality sections. `window.print()` export via
  Tailwind `print:` variants; the hero strip surfaces fresh weekly
  reports with Read · Share · Export PDF actions (Web Share API
  with clipboard fallback).
- **Personal Health Score (composite 0–100).** A deterministic
  `<HealthScoreCard>` panel renders alongside the hero strip on
  `lg+`. Score weights: 30% BP-target rate + 20% weight-trend
  alignment + 20% mood stability + 30% medication compliance.
  Three bands (green ≥75, yellow 50–74, red <50). "Ask the
  Coach" CTA opens the drawer with a score-aware prefill.

### Changed

- **`PROMPT_VERSION` 4.19.0 → 4.20.2.** Three controlled bumps
  across B1 → B3 → B4 carry GROUND RULES 8–11 covering the new
  schema fields. `aiInsightResponseSchema` extended with optional
  `dailyBriefing` / `trendAnnotations` / `weeklyReport` /
  `storyboardAnnotations` / `healthScore` blocks; legacy v1.4.19
  cached payloads still parse because every new field is nullable
  - optional.
- **Branch + release model.** `CONTRIBUTING.md` documents a
  long-lived `develop` branch as the daily target and `main` as
  release-only. End users follow `main` / latest tag; contributors
  branch from and PR into `develop`. The mirror page at
  `/contributing/branch-model/` on the docs site explains the
  same flow for would-be contributors.
- **Repository hygiene.** New `.github/CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), three issue templates, a pull-request
  template, expanded Dependabot scopes (npm + github-actions +
  docker), and complete `package.json` metadata (description,
  license, homepage, repository, bugs, keywords).

### Fixed

- **Coach SSE idempotency replay no longer returns null.** The
  idempotency wrapper double-read the body on replay; the streaming
  route now caches the original SSE response correctly. Also
  repairs the dead error-frame branch and stabilises
  `useSendCoachMessage` opts.
- **Streaming assistant text announces to screen readers.** The
  message thread now has `aria-live="polite"` on the in-flight
  bubble so token-by-token streams reach assistive tech.
- **Coach drawer width capped on `lg+`.** Drawer no longer hits
  1080 px on common laptops; sources rail moves to a tray below
  `xl`.
- **Hero glow z-isolation under sticky nav.** The hero radial
  glow used to bleed through the sticky section nav on scroll.
- **Suggested-prompt chip touch target ≥ 36 px.** Was 28 px,
  below the project's interactive-control floor.
- **"Generate weekly report" hero button enabled.** Previously
  rendered disabled; now wired to the report route.
- **`buildCoachSnapshot` bounded to 90 days.** The Coach context
  helper used to walk every measurement on every turn; capped at
  90 days to keep token cost predictable.
- **`formatRelativeTime` consolidated.** Three near-identical
  copies in the insights surfaces collapsed into one shared
  helper.

### Security

- **Coach conversation persistence is encrypted at rest.** New
  Prisma models `CoachConversation`, `CoachMessage`, and
  `CoachUsage` (migration `0035_coach_conversations_v1420`) store
  message bodies under AES-256-GCM via the existing `crypto.ts`.
  Provenance lives in `metricSourceJson` as labels only (metric,
  window, n-count) — never raw values. GDPR cascade-on-user-delete
  wired through the FK chain.
- **Prompt-injection refusal pattern.** The Coach SSE route runs
  every incoming message through an EN+DE refusal scanner that
  short-circuits prompt-injection attempts and obvious off-topic
  asks before the provider call.
- **Per-user daily token budget.** `CoachUsage` ledgers
  (user, UTC-day) → tokens; the 25 000-token cap (≈13 turns for
  a heavy user) prevents runaway spend on shared provider keys.

### Deferred to v1.4.21

- 22 MED + 16 LOW + 4 simplify-apply-maybe items from the multi-
  reviewer Phase-D pass. Highlights at `.planning/v1421-backlog.md`
  include: senior-dev call to consolidate the duplicated
  Pearson / linear-regression maths layer; refactor the
  `<CoachDrawer key={prefill}>` state-reset shortcut into a
  controlled prefill prop; transactional `recordSpend()`; refusal
  accounting + lexicon expansion.

### Deferred to v1.5

- iOS native app, Apple Health integration, and per-metric APNs
  alerts. Strategic plan at
  `.planning/phase-D-v1420-product-lead-review.md`.

## [1.4.19] — 2026-05-10

### Fixed

- **BD-Zielbereich headline now shows independent values for 7T / 30T /
  total.** The big number used to be identical to the 30T sub-value
  because `/api/analytics` aliased `bpInTargetPct` to `last30Days?.pct`.
  `computeBpInTargetWindows()` now returns a third `allTime` window and
  the route routes the headline through it, so the three numbers can
  legitimately differ across the three windows.
- **Charts mobile header no longer breaks the layout on Pixel 5.** The
  card header switches to a mobile-first stack below `sm` (title +
  chips on row 1, range tabs + cog right-aligned on row 2 with
  `flex-nowrap`) so the tabs always own a single row down to 280 px
  (Galaxy Fold compact). Bucket-aggregation chips and comparison
  captions hide on mobile to free horizontal budget.
- **Charts x-axis tick density unified across every chart wrapper.**
  New `src/lib/charts/x-axis-density.ts` helper + `useViewportWidth`
  hook caps visible ticks at 4 (Fold) / 6 (Pixel 5 / iPhone 12) / 8
  (small tablet) / 10 (desktop). Wired into HealthChart, MoodChart,
  MedicationComplianceChart, and ComplianceLineChart, so the
  medication chart no longer overloads with one tick per day.
- **`/admin/api-tokens` table no longer triggers a horizontal
  scrollbar at any viewport (4th attempt).** Truncate-with-tooltip
  pattern on token-name, username, and permission badge, plus
  `table-fixed` + colgroup widths on the desktop table. Mobile falls
  back to the existing card list, now walked end-to-end by an e2e
  regression.
- **Spurious mini-scrollbar on `/admin/feedback` tab strip.** The
  shared `tabsListVariants` primitive picked up `overflow-y-hidden`
  so the strip no longer paints a 1 px slither below the tabs.
- **`/insights` raw `metric: blood_pressure_sweet` template leak.**
  `STRIP_TOKEN_REGEX` widened to `[A-Za-z0-9_]+` so lowercase template
  remnants are scrubbed from AI prose; the uppercase render allowlist
  (`PARSE_TOKEN_REGEX`) is unchanged.
- **AdminShell hides the collapse button on single-section pages.**
  No more dead "Einklappen" affordance when the route only exposes
  one section.
- **Mobile Sys/Dia badge enum mismatch on blood-pressure rows.**
  CRITICAL from QA — the badge enum on mobile measurement rows
  decoded the wrong key. Fixed before tag with a TDD guard.
- **6 CRITICAL + 21 HIGH copy / consistency / a11y findings from the
  quality-of-life audit.** Time-window range strings now respect the
  active locale, login overview filters out non-auth events, the
  date / datetime input pair forwards `lang` so the native picker
  uses the user's locale, raw enum badges are humanised, audit-action
  labels are localised and link back to the row, achievement titles
  no longer insult the user, and a long tail of admin / settings copy
  consistency.

### Changed

- **Settings → Integrations status displays consolidated.** Withings
  and Mood Log cards now share a single canonical
  `<IntegrationStatusPill>` chip top-right ("Connected · 12 min ago"
  with locale-aware relative-time bucketing). The redundant v1.4.15
  banner trio (`connected / last successful / last attempt`) and Mood
  Log's bottom-of-card "letzter Sync" line are gone; both cards now
  carry a divider between header and body for visual symmetry.
  Actionable error text stays as a compact inline alert above the
  action row.
- **Comparison overlay control removed from the dashboard.** The
  toggle now lives only on `/insights`, folded into the hero meta
  band where there is room for it. The dashboard ditches the
  always-visible knob.
- **`/insights`: single page-level refresh button.** The hero owns
  the only refresh affordance; redundant per-section refresh links
  removed (the per-recommendation Regenerate button from v1.4.16
  stays).
- **`/insights`: small BP / Weight tile strip removed.** Duplicated
  the dashboard tiles. `-157` lines on `src/app/insights/page.tsx`
  plus dead helpers, plus the orphan "Persönlicher AI Berater"
  subtitle.
- **AI insight prompt no longer opens with a default-positivity
  sentence about data quality.** GROUND RULE 7 (EN + DE) forbids
  "Your data foundation is strong" / "Datengrundlage ist sehr stark"
  openers; data-quality caveats only allowed when n < 7 in the
  analyzed window, recencyDays > 14, or a coverage gap biases the
  comparison. `PROMPT_VERSION` bumped 4.16.1 → 4.19.0 so feedback
  aggregation can attribute responses to the new rule.
- **Settings input heights, vertical spacing, and right-side action
  buttons consistent across all sub-routes (mobile + desktop).**
  Every form input is now 36 px (`h-9`); Account → Password,
  Account → Restart onboarding tour, and Dashboard → Reset to
  defaults stack the action below the title on `<sm` (full-width)
  and right-align on `≥sm`, fixing the Pixel-5 right-edge overflow
  on the tour button. Language select gets its own row at the bottom
  of the Profile card; card-internal `space-y` standardised to
  `space-y-4`.
- **Target-range status labels translated to German** (Low / On Target
  / Stable / Moderate). 11 `targets.label.<TYPE>` + 41
  `targets.status.<key>` entries in EN + DE; page uses
  `STATUS_CATEGORY_KEY` to normalise server strings.

### Deferred to v1.4.20

- 3 HIGH from QA — `/insights` `data?.` narrowing refactor,
  `/admin/api-tokens` touch-tooltip (needs Popover swap), and
  `/insights` hero density (folded into the v1.4.20 redesign).
- 31 MED + 16 LOW from the quality-of-life audit. Short-list at
  `.planning/v1420-backlog.md`.
- `/insights` redesign with AI Coach — separate roadmap, design
  handoff at `~/Downloads/design_handoff_insights_redesign`.

## [1.4.18] — 2026-05-10

### Added

- **Per-chart overlay toggles.** Every chart on the dashboard now has a
  cog menu (44 × 44 tap target) with three independent switches: trend
  indicator, trend arrow, and target-range overlay. Defaults are off so
  the default look is a clean line. State is persisted per user per
  chart in `User.dashboardWidgetsJson.chartOverlayPrefs` (no migration)
  and round-tripped through a new `PUT /api/dashboard/chart-overlay-prefs`
  in a Serializable transaction.
- **Expanded achievements roster.** 21 new achievements bring the total
  to 59. Adds streak, milestone, consistency, improvement, and discovery
  categories on top of the existing security / engagement / vitals /
  medication groups. Locked public badges only render once the user has
  data for the underlying metric so the page isn't a wall of grey on
  day one.
- **Hidden Easter-egg achievements.** Six hidden badges that paint as
  opaque "Hidden achievement" placeholders until unlocked. The real
  strings, descriptions, and icons never reach the DOM (or the API
  response) for locked-and-hidden entries, so peeking the bundle or the
  network tab doesn't spoil them. Unlock toast adds a longer Sparkles
  celebration with a "you unlocked a hidden achievement!" headline.
- **BD-Zielbereich tile 7T / 30T sub-values.** The two sub-values on
  the blood-pressure-in-target tile now show real measurement data.
  Backed by a new `computeBpInTargetWindows()` helper that re-uses the
  v1.4.16 ceiling predicate but filters input by `measuredAt`.
  `/api/analytics` surfaces `bpInTargetPct7d` / `bpInTargetPct30d`.

### Changed

- **Charts use clean lines without gradient fills.** The v1.4.16
  Apple-Health-style gradient backgrounds are gone. Lines stay smooth-
  interpolated, tooltips stay rich, animation-on-render still respects
  `prefers-reduced-motion` — only the gradient fill area is removed.
- **Mood chart shows simple dots at data points.** The emoji glyphs
  introduced in v1.4.16 are replaced with plain coloured dots; the
  emoji still appears in the tooltip.
- **Personal-baseline / mean overlays are opt-in.** The 90-day-median
  reference line on health and mood charts is no longer always-on; it
  only renders when the per-chart Trend toggle is enabled.

### Fixed

- **`/admin/api-tokens` mobile horizontal scrollbar.** Third attempt,
  this time pinned to the actual offender via Playwright probe of the
  prod page at Pixel-5 viewport. The scrollbar was painted by the
  AdminShell mobile section strip (13 entries, scrollWidth ≈ 1700 px),
  not the api-tokens table. Added a `.no-scrollbar` utility and applied
  it to both AdminShell and SettingsShell mobile strips. Swipe and
  keyboard-arrow scrolling preserved.
- **`/insights` legacy-payload crash.** Already shipped in the v1.4.17
  hotfix; documented here for completeness. Cached pre-strict insights
  in the v1.4.14 `{changed, stable, drivers, …}` shape now render a
  "Regenerate insights" card instead of throwing
  `Cannot read properties of undefined (reading 'replace')`.
- **BD-Zielbereich 7T / 30T sub-values.** Were always rendering "—"
  because `/api/analytics` only computed a single 30-day window and
  the tile passed `avg7={null}, avg30={null}`. Wired correctly — see
  Added.

### Deferred to v1.4.19 / v1.5

- **i18n bundle leak (security HIGH).** The hidden-achievement
  redaction landed at the API layer, but `messages/en.json` and
  `messages/de.json` are still statically imported into the client
  bundle, so a determined user can `Cmd-F` for the hidden strings in
  `_next/static/chunks/*.js`. Needs a build-time strip or reversible
  obfuscation. Tracked in `.planning/v1419-backlog.md`.
- See `.planning/v1419-backlog.md` for the short-list and
  `.planning/v15-backlog.md` for the strategic v1.5 items.

## [1.4.17] — 2026-05-10

### Fixed

- `/insights` no longer crashes for users with cached insights from before
  v1.4.16. A "Regenerate insights" card is shown for legacy cached
  payloads (the pre-strict `{changed, stable, drivers, …}` shape) instead
  of throwing a `Cannot read properties of undefined (reading 'replace')`
  error. One click on the card refreshes the insight in the new format.

## [1.4.16] — 2026-05-09

### Added

- **Per-recommendation explainability.** Every insight recommendation now
  carries a rationale: which time window was analysed, what was compared,
  and the deviation that triggered the recommendation. The card expands
  inline to reveal the rationale plus a mini-chart of the data window.
- **Confidence score per recommendation.** Each recommendation gets a
  deterministic 0–100 confidence score (server-computed from sample size,
  recency, and signal strength) shown as a colour-banded ring + bar meter.
  Below-threshold recommendations are tagged "low confidence — based on
  limited data" rather than hidden.
- **"Was this helpful?" feedback.** Thumbs-up / thumbs-down on every
  recommendation, persisted per user with provider attribution. Daily
  aggregator writes per-(severity × provider) helpful-rate to admin
  settings; the aggregate is visible under `/admin/ai-quality`.
- **Medical-reference grounding.** Recommendations cite curated AHA / ESH
  / ESC / WHO / DGE guidelines via a validated `referenceId`; the
  citation links open the source guideline in a new tab.
- **Multi-provider AI fallback chain.** The insight wrapper tries each
  configured provider in turn on hard failures (401 / 403 / 429 / 5xx /
  transport). Schema 422 still bubbles. Last-working provider is cached
  per user for an hour. Order, enable / disable, and provider list are
  configurable under Settings → AI.
- **Apple-Health-style chart polish.** Blood pressure, weight, pulse,
  body fat, sleep, steps, mood, and medication-compliance charts gain
  gradient fills, smooth interpolation, a 90-day-median personal-baseline
  reference line, in-target zone shading, rich tooltips with delta
  vs. baseline, and 600 ms ease-out animation that respects
  `prefers-reduced-motion`. Sparse data (<3 points) renders an explicit
  empty state instead of a degenerate line.
- **Comparison overlay (vs. last month / vs. last year).** A new toggle
  at the top of every chart, tile, and the insights surface overlays the
  prior period as a dimmed line beneath the current one and adds a delta
  callout (Δ ±N). The AI summary narrates the comparison ("your average
  BP improved by 4 mmHg vs. last month") when the toggle is active.
- **Settings → Export.** Consolidated `/settings/export` page with one
  card per export type: doctor-report PDF (configurable date range +
  practice name), measurements CSV, medications CSV (optional intake
  history), mood CSV, full JSON backup. Each download writes a
  `user.export.<kind>` audit-log entry and shares a 10/h rate-limit
  bucket. Doctor-report entry-point relocated under this route.
- **Achievements page.** New `/achievements` page with locked + unlocked
  breakdown grouped by category (medication / vitals / security /
  engagement). Recent unlocks card on the dashboard, toggleable from
  layout settings.
- **Onboarding tour for new users.** First-run spotlight walk-through
  highlighting tile-strip, quick-add menu, insights, integrations, and
  achievements. Skippable, keyboard-navigable, replayable from
  Settings → Account.
- **Admin host-load chart.** New chart over the system-status section
  shows host CPU, memory, and disk-IO over the last 2 hours, sampled
  every minute, retained for 7 days.
- **Admin app-log preview.** Tail of the last 1 hour of structured
  wide-events from the per-process ring buffer, filterable by trace_id /
  level / action / time-window with a JSON inspector modal.
- **Admin AI quality preview.** New `/admin/ai-quality` route surfaces
  helpful-rate per (severity × provider), tinted by band so degrading
  providers stand out at a glance.

### Changed

- **Insights surface uses the new RecommendationCard everywhere.** The
  `/insights` page and the dashboard insights tile both render the
  polished card — rationale expand, confidence meter, citation footnote,
  feedback thumbs — backed by a shared TanStack Query cache.
- **Trend label normalised to "7-day trend".** Every chart, tile, and
  subtitle uses the long form. A signed numeric delta indicator (±N.N)
  with metric-aware colouring appears next to the value on every chart,
  including mood and medication-compliance.
- **`/admin` overview redesigned.** The section grid is gone; the
  overview now shows a system-status snapshot with host-load chart and
  an audit-log preview. Sidebar carries the section list.
- **Sidebar admin sub-items only expand on `/admin/*`.** Clicking the
  Admin link or opening the Gravatar dropdown no longer auto-expands
  the sub-list when you are not on an admin route.
- **Settings → AI is a single dropdown.** The provider selector at the
  top drives the configuration form below; no more top/bottom split. All
  five providers (Codex / OpenAI / Anthropic / Local / Admin OpenAI) are
  reachable from the same UI.
- **Top dashboard tiles selectable per metric.** The widget-id enum bug
  from v1.4.15 that silently 422'd every layout PUT is fixed; the
  per-metric tile toggle in layout settings now actually persists.
- **AI rate-limit raised to 10/hour.** Default bumped from 2/h to 10/h;
  configurable via `INSIGHTS_RATE_LIMIT_PER_HOUR`. Generating a new
  insight evicts every previously cached per-status insight for that
  user, so the dashboard never shows a stale cached payload.

### Fixed

- **BD-Zielbereich percentage now counts in-range readings correctly.**
  The v1.4.15 fix corrected the denominator but kept the ESH narrow-band
  predicate (`sysLow ≤ sys ≤ sysHigh AND diaLow ≤ dia ≤ diaHigh`), so
  normotensive readings (e.g. 117/79) below `sysLow=120` counted as out
  of range. Predicate switched to one-sided ceiling semantics with a
  hypotension floor (`90 ≤ sys ≤ sysHigh AND 50 ≤ dia ≤ diaHigh`),
  centralised in `isBpReadingInTarget()` shared by six call sites.
- **Trend on "all" filter shows a meaningful split-half delta.** Long
  windows where the per-week rate fell below the 1-decimal display
  precision now also surface a split-half mean delta (second-half mean
  minus first-half mean) for windows ≥ 90 days.
- **Login overview no longer strips umlauts.** The geo helper decodes
  via `arrayBuffer()` + `TextDecoder('utf-8')` instead of
  `Response.json()`, so an upstream proxy stripping the
  `Content-Type: charset` parameter cannot poison the umlaut path.
  Nürnberg, München, Düsseldorf, Köln, Würzburg, Bückeburg, Weißenfels
  all roundtrip correctly.
- **`/admin/api-tokens` table no horizontal overflow on mobile.** The
  desktop `<table>` falls back to a card list at `<md` viewports, with
  long names + permission badges wrapping cleanly inside the card.
- **Skip-link no longer blocks logo click.** The "Skip to content"
  shortcut still leads the tab order but no longer blocks pointer events
  on the logo.
- **Bug-Report nav entry follows the admin feature toggle.** When the
  admin disables bug reporting the entry vanishes from sidebar,
  bottom-nav, topbar, and the error-detail "Report bug" button.
- **Feedback link follows the admin feature toggle.** When feedback
  collection is disabled, the UI entry point disappears too.
- **Cached AI insights replaced when the user regenerates.** Generating
  a new insight invalidates the per-status `audit_logs` entries plus the
  TanStack Query cache, so the dashboard always shows the freshest
  payload.

### Performance

- **Comparison overlays computed via reusable bucket-series helper.** No
  extra round-trip per chart — the dashboard fetcher and AI snapshot
  both read from the same `avg30LastMonth` / `avg30LastYear` fields.
- **`/api/insights/feedback` persists with optimistic UI updates.**
  Thumbs-up / thumbs-down apply instantly; the localStorage refresh-
  defence keeps the verdict on rerender even before the mutation
  resolves.

### Security

- **AI provider apiKeys encrypted at rest.** Provider chain entries that
  carry a key store it AES-256-GCM via the existing `src/lib/crypto.ts`
  helper.
- **`/api/insights/feedback` gated by `requireAuth` + idempotency-key.**
  The dedicated rate-limit bucket prevents thumbs-spam.
- **Per-provider attribution server-filled.** Clients cannot tamper with
  which provider gets credit for a recommendation; the attribution is
  resolved server-side from the latest `insights.generate` audit row.
- **Admin egress redacts secrets.** Audit-log `details` and app-log
  `meta` fields run through `redactSecrets()` before leaving the admin
  API surface.

### Internal

- **`docker-publish` workflow no longer hangs on main-branch builds.**
  Root cause was a qemu-arm64 SIGILL during multi-arch emulation; arm64
  dropped from the platforms list. Native arm64 runner matrix scheduled
  for v1.5.
- **CI integration tests + e2e workflows green again.** Both had been
  pre-existing red since `d8c549e` (encryption-key YAML scalar parsed
  as integer 0 + spotlight tour overlay intercepting clicks). Both fixed
  this milestone.

### Deferred to v1.5

- Coolify image-digest auto-deploy trigger (currently fires on every
  git-push; the manual Coolify UI toggle is the realistic fix).
- Native arm64 runner matrix for full multi-arch docker publish.
- Cross-user feedback aggregation prompt-tuning ratchet (depends on
  v1.4.16 feedback collection accumulating data).
- Dedicated `/insights/compare` page (i18n keys
  `comparison.insightsCallout.{lastMonth,lastYear}` reserved).

## [1.4.15] — 2026-05-09

### Added

- Backups become a full lifecycle. The Sunday-morning snapshot is no
  longer the end of the road. `/admin/backups` lets you download any
  snapshot as `.json`, upload a new one, and — behind a triple-confirm
  gate (type “RESTORE” + dialog + confirm) — restore a snapshot straight
  into the database. Every operation (run, download, upload, restore
  including start/failure) is recorded in the audit log with actor and
  target snapshot.
- New `/achievements` page lists locked + unlocked achievements with
  progress bars (`{current} / {target}`), grouped by category (medication,
  vitals, security, engagement). The dashboard gains a toggleable “Recent
  achievements” card; visibility lives in the Layout settings.
- New onboarding tour for first-run users. A spotlight walk-through on
  first dashboard load points out the tile strip, quick-add menu,
  insights, integrations, and achievements. Skippable with Esc, fully
  keyboard-navigable, honors `prefers-reduced-motion`. Replay the tour any
  time from Settings → Account.
- Doctor-report v2. Before the PDF is generated a dialog asks for the date
  range (presets 90 days / 6 months / 12 months, manually editable, max 2
  years) and an optional practice name that appears on the PDF cover page.
  The practice name is persisted as a user preference.
- Auto-deploy on GHCR push. Once the Docker publish action ships a new
  `:latest`, it calls the Coolify deploy webhook. Coolify in turn pings an
  internal endpoint with the result; success / failure / unknown all land
  in the audit log; persistent failures send a Telegram alert to every
  admin. No more manual force-pull on the host.
- Empty states everywhere. Brand-new accounts and empty lists now always
  show a sensible empty state (icon + description + CTA) where there used
  to be just white space. Coverage: admin tables (users, backups,
  login-overview, api-tokens, feedback, audit-preview), measurement / mood
  / medication / achievement lists, the insights top-level +
  BMI-without-height view, and the dashboard for fully empty accounts.
- Notification channel status UI. Settings → Notifications now shows
  per-channel (Telegram, ntfy, Web Push) the current state (connected /
  error / disabled), last success, last failure, consecutive-failure
  counter, and disable reason if any. Buttons for “Re-enable” (only when
  auto-disabled) and “Send test”.
- Withings + moodLog integration status UI. Settings → Integrations shows
  per-provider the connection state, last sync, last error, and a reauth
  hint as soon as a refresh-token was rejected. After persistent failures
  (≥ 3 in a row) admins receive a Telegram alert if the channel is
  enabled.
- Top dashboard tiles selectable. The layout settings now expose a
  separate toggle for each metric’s upper-row tile and lower-row chart.
  Existing saved layouts keep their previous behaviour (one switch
  controls both surfaces) until you explicitly flip the new toggle.
- 7-day-trend instead of 7-day-average. Each tile gains a coloured delta
  indicator `(±N.N)` next to the value, showing the metric-aware change of
  the last 7 days vs. the prior 7. Label renamed from “7d average” to “7d
  trend”.

### Changed

- The `/admin` overview replaces the section grid with an audit-log
  preview (recent entries, actor, target resource) and a system-status
  snapshot. The section grid moved into the sidebar.
- The sidebar Admin sub-items only expand when you are actually on an
  `/admin/*` route. Everywhere else the Admin group stays collapsed.
- The mood chart now auto-aggregates: weekly past 90 days, monthly past
  730 days — same thresholds as weight and BP. A chip in the chart header
  shows the active aggregation level.
- AI insights gain hard anti-hallucination guardrails. Provider responses
  are validated against a strict Zod schema (summary, recommendations with
  mandatory `metricSource`, citations, warnings). Recommendations citing
  data points not present in the snapshot are rejected. The wrapper
  retries exactly once with a corrective system message; if the second
  attempt also fails, it returns 422 instead of unsanitised output.
  Codex-backend slug drift (e.g. `gpt-5-codex` → `gpt-5.3-codex`) is now
  cushioned by a configurable fallback chain + 1-hour positive cache; if
  every slug fails the route returns a structured 503 with the
  `attempted[]` list.
- The `/admin/api-tokens` table is responsive on mobile. Narrow viewports
  gate columns behind breakpoints (last-used, created-at, owner) and the
  owner username falls back inline next to the token name so hiding the
  column never drops data.
- Mood tile on mobile shows only the large score number + label, no more
  doubled rendering.
- Quick-add submenu disambiguated. The two entries are now called “Messung
  erfassen” / “Stimmung erfassen” (DE) and “Log measurement” / “Log mood”
  (EN) — previously both simply “Add”.

### Fixed

- Blood-pressure target-range percentage. The target-range tile miscounted
  sys/dia pairs once import drift pushed sys/dia timestamps more than 5
  minutes apart — the tile could show 0 % even though most readings were
  inside the target range. Fix: a same-Berlin-day key fallback +
  pair-count as denominator.
- Onboarding flicker. On accounts where onboarding is already complete,
  the onboarding card no longer renders for ~500 ms before vanishing. It
  mounts only after the analytics status has loaded, and refuses to
  auto-open when nothing is left to do.
- The “Skip to content” skip-link still leads the tab order but no longer
  blocks clicks on the logo.
- The “Report a bug” entry follows the admin feature flag. With bug
  reporting disabled, the entry vanishes from the sidebar, bottom-nav,
  topbar, and the error-detail “Report bug” button.
- The Feedback link follows its admin feature flag. With feedback
  disabled, the UI entry point disappears too.
- Notification channels auto-disable on persistent hard rejects. If
  Telegram / ntfy / Web Push respond repeatedly with 410 or other
  permanent reject codes, the channel disables itself and writes an
  audit-log entry. Status + re-enable button live in Settings →
  Notifications.
- reauth`und der Settings-Eintrag bittet um Neu-Verbindung — statt jeden
Sync-Tick weiter gegen den Provider zu hämmern. _Refresh-token failures
flip the integration to “needs reauth”. When the Withings or moodLog
refresh-token exchange fails (typically after 90 days without re-auth),
the integration switches to`error_reauth` and the Settings entry asks
  for re-connect — instead of hammering the upstream every sync tick.
- Mobile chart containers no longer eat vertical scroll. On touch devices
  the Recharts wrappers swallowed vertical pans; on slower devices that
  felt like a scroll lockup. Fix: `touch-action: pan-y` on the chart
  wrappers, vertical scroll passes through again.
- `/admin/users` on mobile renders as a card list instead of a
  horizontally-scrolling table.
- Accessibility round of fixes: chart range buttons, medication primary
  buttons, mood-list mobile icon buttons, login CTAs, Settings → Account
  passkey table, onboarding-tour focus trap + DE-locale overflow +
  backdrop ring — all aligned to 44 px tap targets and labelled /
  keyboard-navigable.

### Security

- AI provider responses are validated against a strict Zod schema. The
  insight wrapper only accepts responses that satisfy the strict
  `aiInsightResponseSchema`, and rejects recommendations citing data
  points absent from the supplied snapshot. Schema failures trigger a
  single retry with a corrective system message; a second failure returns
  422 instead of hallucinated output.
- Backup operations are fully audited. Run, download, upload, and restore
  — including start markers, denial reasons, and failures — each write an
  audit-log entry with actor and snapshot ID. Restore is additionally
  protected by five independent gates (cookie-only admin auth, `confirm:
"RESTORE"` body, typed UI confirmation, idempotency-key wrap,
  pre-transaction enum validation).

## [1.4.14] — 2026-05-09

### Added

- The admin area is split into per-section pages instead of one monolithic
  dashboard with anchor jumps. Each section has its own URL
  (`/admin/system-status`, `/admin/services`, `/admin/integrations`,
  `/admin/feedback`, `/admin/reminders`, `/admin/users`,
  `/admin/api-tokens`, `/admin/login-overview`, `/admin/backups`,
  `/admin/danger-zone`); the sidebar grows an expandable Admin group;
  status cards link to the relevant sub-page; legacy `/admin#section-…`
  paths are redirected server-side.
- New `/admin/backups` view with a table of all stored backups (size,
  type, timestamp) and a “Backup now” button that enqueues an ad-hoc
  pg-boss job.
- New `/admin/users` view with role filter pills (all / admins only /
  users only) and a per-row force-logout action behind a confirmation
  dialog (deletes every active session of the target and writes an
  audit-log entry). Self-target is disabled.
- New “Remove saved AI key” button in Settings → AI: a clearly labelled
  button behind a confirmation dialog clears the stored OpenAI or local
  provider key without touching anything else.
- MODEL`-Env-Var** als Operator-Override für das Codex- Modell-Slug, damit
alternative Modelle ohne Rebuild getestet werden können (z. B. wenn dein
ChatGPT-Plan ein anderes Default-Modell bevorzugt). _New `CODEX_MODEL`
  env var lets operators override the Codex model slug without a rebuild —
  useful for testing alternate slugs against different ChatGPT plan tiers.

### Changed

- Trend-arrow colors are metric-aware: BP and weight rising = orange
  (warning), mood rising = green (positive), pulse rising = neutral
  (context-dependent). Arrow direction itself is unchanged.
- “Wipe all data” now also clears notification channels and web-push
  subscriptions: encrypted Telegram bot tokens and web-push endpoints no
  longer survive a full account wipe. Feedback and audit log stay
  untouched (unchanged). The confirmation copy spells out the new scope.
- Admin-area i18n keys reorganised under `admin.section.<slug>.*` (EN + DE
  parity).

### Fixed

- Codex/ChatGPT model slug corrected: the Codex backend rejects both
  `gpt-5-codex` and `gpt-5` when authenticated via a ChatGPT account; the
  codex-optimised slug for the Plus/Pro tiers is `gpt-5.3-codex`. v1.4.14
  wires the correct default. Settings → AI “Test connection” and the
  insight generator now both succeed against your ChatGPT subscription.
- **Sommerzeit-Wechsel verschiebt keine Tageswerte mehr.** Die
  Cross-Metric-Tagespaarung in den Insight-Buckets rechnete früher in
  reinem UTC und verlor an den Berliner DST-Grenzen einen Tag. Die
  neue Helper `dayOffsetToBerlinDayKey()` arbeitet DST-immun (Anker
  über Berliner Y-M-D, dann Subtraktion in 86*400_000-ms-Schritten);
  die Tagespaarung über Blutdruck, Gewicht und Stimmung ist jetzt
  über DST-Wechsel hinweg konsistent.
  \_DST transitions no longer shift daily values. The cross-metric
  daily bucket pairing previously did naive UTC math and dropped a
  day at the Berlin DST boundary. A new `dayOffsetToBerlinDayKey()`
  helper anchors at Berlin Y-M-D and subtracts in 86_400_000-ms
  steps; bucket pairing across blood pressure, weight, and mood is
  now DST-safe.*
- AI provider errors are now correctly classified by
  `/api/insights/generate`: provider 401/403 → 422 (“AI provider rejected
  the request — check your API key in Settings → AI”), provider 5xx → 503
  (“AI provider temporarily unavailable”), 429 → 429. Previously
  everything returned 500. Full error context still lands in the
  structured logs.
- The structured-logging secret redactor no longer mangles innocent words.
  The previous regex matched any `sk-…` substring and masked fragments
  inside `task-force`, `risk-management`, `disk-io`. The new pattern
  requires a word boundary and at least 8 trailing characters, while still
  scrubbing real API keys (`sk-…`, `sk-ant-…`).

### Performance

- Bundle-size improvements on the insights page: Recharts symbols for the
  correlation scatter plots are now loaded on demand via `next/dynamic`
  instead of being shipped eagerly, saving roughly 108 KiB of initial
  JavaScript on `/insights`. Chart visuals are unchanged.
- The dashboard skips the onboarding-checklist API requests once
  onboarding is complete. With `onboardingCompletedAt` set, the
  `withings/status` and `notifications/preferences` queries no longer fire
  on dashboard load — saves about 950 ms of network time for established
  users.

### Tests & A11y

- Extended end-to-end suite. New Playwright specs cover the authenticated
  dashboard render, the “add measurement” flow, the doctor-report PDF
  download, a mocked Codex connect flow, a mocked insights-generate flow,
  and a mobile-viewport smoke test (Pixel 5).
- Axe-core accessibility audit now clean of serious/critical violations on
  `/dashboard`, `/settings/integrations`, and `/admin` (incl.
  `/admin/system-status`, `/admin/users`). Fixes: missing aria-labels on
  icon-only buttons, unnamed mobile user-menu trigger, empty `<dd>`
  placeholders, sign-up link distinguishable only by color, quick-add menu
  with two indistinguishable items.

### Docs

- Documentation site brought up to date with v1.4.14 — Codex device-code
  flow rewritten, new Admin sections (Backups, Users) documented,
  `CODEX_MODEL` env var added, dashboard performance note added, Codex
  troubleshooting block revised.

## [1.4.13] — 2026-05-09

### Fixed — KI Insights via ChatGPT

- **Modell-Slug für ChatGPT-Auth korrigiert.** Der Codex-Backend
  lehnt `gpt-5-codex` mit ChatGPT-Subscription ab
  (`The 'gpt-5-codex' model is not supported when using Codex with a
ChatGPT account.`) — dieses Slug ist nur für API-Key-Auth gültig.
  Wechsel auf `gpt-5`, das Standard-Modell der ChatGPT-Plus/Pro-Tarife.
  Operator-Override via `CODEX_MODEL`-Env-Var möglich falls dein
  Plan einen anderen Default kennt.

## [1.4.12] — 2026-05-09

### Fixed — KI Insights via ChatGPT (komplette Codex-Integration)

- **Codex-Backend-Aufruf jetzt vollständig nach Spec.** Die letzten
  Versionen haben den Connect-Schritt richtig hinbekommen, aber der
  eigentliche Insight-Call ist iterativ an immer neuen 400ern
  gestorben. Statt weitere Trial-and-Error-Iterationen zu fahren
  habe ich das vollständige Codex-Backend-Protokoll aus dem
  offiziellen `openai/codex`-Quellcode dokumentiert
  (`docs/codex-protocol-spec.md`) und einmal sauber dagegen
  implementiert. Was alles fehlte: der Header `ChatGPT-Account-ID`
  (ohne den 401, kommt aus dem `chatgpt_account_id`-Claim im JWT
  id_token); die Header `originator`, `User-Agent`, `Accept`,
  `session_id`, `thread_id`; die Body-Felder `reasoning: null` und
  `include: []`; das richtige Modell-Slug `gpt-5-codex` (statt des
  Test-Placeholders `gpt-5.3-codex`); JSON-Body beim Refresh
  (vorher form-urlencoded); Persistenz des `accountId` neben dem
  Access-Token. SSE-Streaming wird unverändert konsumiert
  (output_text.delta + output_item.done).
- **Aufräumen:** der Browser-Authorization-Code-Pfad
  (`/api/auth/codex/authorize` + `/callback`) ist gelöscht — er
  funktioniert auf hosted Domains grundsätzlich nicht (Hydra-
  Whitelist nur für localhost), war aber als Safety-Net noch da.
  Device-Code ist jetzt der einzige Pfad.
- **Re-Connect nötig:** wer in v1.4.7-v1.4.11 schon connected hat,
  muss einmal "Trennen" + "Mit ChatGPT verbinden" — die alte
  Storage-Form trug die `accountId` nicht und kann nicht
  nach-bereichert werden.

## [1.4.11] — 2026-05-09

### Fixed — KI Insights via ChatGPT

- **Codex-Backend bekommt jetzt SSE-Streaming.** Nach dem v1.4.10-
  Body-Format-Fix kam der nächste 400er: `Stream must be set to true`
  — der `chatgpt.com/backend-api/codex/responses`-Endpoint akzeptiert
  ausschließlich Server-Sent-Events-Antworten, kein synchrones JSON.
  v1.4.11 baut den CodexClient so um, dass er die Antwort als SSE
  konsumiert: `output_item.done`-Events liefern den vollständigen
  Assistant-Text, `output_text.delta`-Chunks dienen als Fallback,
  `response.completed` trägt die Token-Usage. Damit läuft das gesamte
  KI-Insights-Feature jetzt durch dein ChatGPT-Abo.

## [1.4.10] — 2026-05-09

### Fixed — KI Insights via ChatGPT

- **Codex-Backend bekommt jetzt das richtige Request-Format.** Nach
  dem v1.4.9-Connect war der OAuth durch, aber jeder echte Insight-
  Call ist mit `Codex request failed (400) — "Input must be a list"`
  gestorben. Der `chatgpt.com/backend-api/codex/responses`-Endpoint
  spricht das OpenAI-Responses-API-Schema (`input: ResponseItem[]`)
  und nicht das Chat-Completions-Schema mit String-Input. v1.4.10
  baut den Body korrekt — `input` ist eine Liste mit einem
  Message-Item, das wiederum eine Liste von `input_text`-Content-
  Blöcken trägt — exakt wie die `ResponsesApiRequest`-Struktur im
  offiziellen `codex-rs/codex-api/src/common.rs`. Settings → KI
  "Verbindung testen" und der Insight-Generator laufen damit jetzt
  beide gegen dein ChatGPT-Abo durch.

## [1.4.9] — 2026-05-09

### Fixed — Settings · KI

- **Device-Code-Flow läuft jetzt komplett durch.** v1.4.8 hat den
  Code richtig zugestellt und du konntest auf chatgpt.com
  bestätigen, aber der Connect-Schritt am Ende ist mit "missing
  organization_id" gestorben. Ursache: der id_token aus dem
  Device-Flow trägt das `organization_id`-Claim nicht (das
  bekommt nur die Browser-Authorize-Variante via
  `id_token_add_organizations=true`-Param), und unsere
  RFC-8693-API-Key-Exchange hat genau dieses Claim erwartet. v1.4.9
  übernimmt das Verhalten des offiziellen Codex CLI im Device-Pfad:
  den OAuth-Access-Token direkt verwenden und gegen den Codex-
  Backend-Endpoint (`chatgpt.com/backend-api/codex/responses`)
  schicken — kein API-Key-Tausch nötig. Refresh läuft analog: nur
  Token-Rotation, keine Exchange.

## [1.4.8] — 2026-05-09

### Fixed — Settings · KI

- **"Mit ChatGPT verbinden" funktioniert jetzt wirklich.** v1.4.7 hat
  zwar die OAuth-Endpoints korrigiert, ist aber an OpenAIs Hydra-
  Allow-List gescheitert: die Public-Codex-Client-ID hat in der
  Server-Allow-List nur `localhost:1455/1457` als Redirect-URI, jeder
  hosted-Domain-Callback wird mit "An error occurred during
  authentication (unknown_error)" abgelehnt. v1.4.8 schaltet auf den
  **Device-Code-Flow** um — den selben Mechanismus den der offizielle
  Codex CLI für Headless-/Hosted-Umgebungen nutzt: HealthLog zeigt
  einen kurzen Code (`RGRP-N5F7U`-Stil), du gehst auf
  https://auth.openai.com/codex/device, gibst den Code ein, bestätigst
  bei dir im Browser, fertig. Kein Redirect zurück nötig, also keine
  Allow-List-Konflikte. Die Settings-Seite pollt im Hintergrund und
  schließt das Modal sobald deine Approval durch ist.

## [1.4.7] — 2026-05-09

### Fixed — Settings · KI

- **"Mit ChatGPT verbinden" funktioniert wieder.** Seit der Funktion
  Anfang v1.4.x existiert war der OAuth-Pfad gegen die falsche Domain
  verdrahtet — ChatGPT hat unsere Authorize-/Token-Requests still
  geschluckt und das normale Web-Interface gerendert, kein Callback,
  kein Fehler. Der Flow läuft jetzt über `auth.openai.com/oauth/...`,
  identisch zum offiziellen `openai/codex` CLI: PKCE-Authorize, Token-
  Exchange, dann ein zweiter RFC-8693-Token-Exchange, der den
  `id_token` gegen einen OpenAI-API-Key tauscht. Dieser Key bucht
  gegen das ChatGPT-Abo, kein separates API-Plan-Quota nötig. Der
  Refresh-Token wird verschlüsselt mitgespeichert; vor jeder Anfrage
  rotiert HealthLog den API-Key transparent wenn er abläuft.

## [1.4.6] — 2026-05-09

### Fixed — Dashboard

- **Tile strip fills its row.** Each tile in the dashboard's
  measurement strip now stretches to its grid cell instead of
  shrinking to content width. On a 375 px viewport tiles in the
  same row are no longer 122-166 px wide — every tile takes the
  same share of the row.
- **Secondary text is finally distinguishable from primary.**
  `--muted-foreground` was identical to `--foreground` in both
  light and dark mode, which flattened the entire visual
  hierarchy. Tile labels, "Ø7d:" prefixes, units, and inactive
  nav items now render in `#9aa3b3` (dark) / `#5b6273` (light) —
  both ≥ 4.5:1 against the surface.
- **Trend cards land aligned with the chart strip below.**
  Padding bumped from `p-3` to `p-4 md:p-6` so the tiles match
  the surrounding chart cards. KPI typography (`text-3xl
tracking-tight tabular-nums` for the value, `text-xs uppercase
tracking-wide` for the label) gives the number proper weight
  without making the tile feel tall.
- **Always-on Ø7d / Ø30d chips** — when an average is missing
  the chip renders `—` instead of disappearing, so vertical
  rhythm stays consistent across tiles.
- **Welcome subtitle is visible on mobile** (was hidden below
  the `sm` breakpoint) and uses muted-foreground so it doesn't
  fight the headline.
- **Medications card matches the other cards** — `rounded-xl`
  and `p-4 md:p-6` instead of the smaller `rounded-lg p-4`.

### New — Charts

- **Long-range charts now bucket their data.** Hitting "All" on
  an account with several years of measurements used to render
  thousands of daily dots — unreadable, and slow on mobile. The
  chart now picks an aggregation level from the visible range:
  daily for ≤ 90 days, weekly mean for 91-730 days, monthly
  mean for everything beyond. A small chip beside the chart
  title surfaces the active bucket ("Wochendurchschnitt" /
  "Monatsdurchschnitt" in DE, "Weekly avg" / "Monthly avg" in
  EN) so the bucket is never silent. Empty buckets are dropped
  rather than zero-padded.

### Fixed — KI

- **Hero recommendation no longer prints raw `metric:WEIGHT`
  tokens.** When the model embedded a chart token in the
  primary recommendation the renderer was printing the literal
  string. The "Key Takeaway" card now strips the tokens for
  prose and renders them as inline charts under the
  recommendation, the same pattern the summary block has used
  since v1.4.5.
- **"Verbindung testen" stays readable when the model returns
  bad JSON.** `/api/insights/generate` returned 502 for parse
  errors, which Cloudflare swapped for an HTML error page;
  `await res.json()` in the browser then crashed. Same
  Cloudflare-rewrite trap the v1.4.5 ai/test fix solved — parse
  errors now map to 422 so the JSON body actually reaches the
  client.
- **Saved API keys cannot leak to a stale local URL.** A user
  who had configured the Local provider with `http://192.168.x.x`
  and later switched to OpenAI / Anthropic kept that URL in the
  shared `aiBaseUrl` column, and the OpenAI / Anthropic clients
  were forwarding their cloud keys to that LAN host on every
  request. The PATCH that switches providers now wipes the
  column, and the OpenAI / Anthropic clients hardcode the
  canonical base URL regardless of what the column carries.

### Improved — KI Insights

- **The model now sees three years of history per metric.** Each
  per-card insight payload (general, blood pressure, pulse,
  weight, BMI, mood, medication compliance) used to clip the
  series to the last 30 daily means — way too narrow to detect
  drift that plays out over a year. The new payload combines
  360 daily means (`dayOffset 0..359`) with 24 monthly means for
  the older window (`monthOffset 12..35`), with a 50 KB safety
  guard that re-buckets at 180 daily days when a particularly
  noisy account would blow past the prompt token budget.

### Fixed — Admin

- **Status-card CTAs go to the right place.** Every "Manage
  users" / "View backups" link in the admin status grid was
  bouncing back to `/admin` because the hrefs were pointing at
  sub-routes that never shipped (`/admin/users`,
  `/admin/audit-log`) or at anchors whose IDs do not exist
  (`#integrations`, `#monitoring`, `#backups`). Each href now
  points at a real `section-*` anchor on the admin page, the
  CTA copy describes the destination honestly ("Open
  integrations", "Open system status"), and the unit test
  asserts each href maps to a known section ID — so the next
  refactor cannot regress this silently.
- **Bug-report toggle finally hides the form.** The admin
  "Bug reports" switch had no effect because the gate lived on
  a legacy route the form does not call. The actual `/api/feedback`
  endpoint and the `/bugreport` page now both honor the toggle —
  the form disappears, and direct API calls return 503 with a
  readable error.
- **Audit trail survives the data wipe.** The `Wipe all data`
  admin action used to delete `AuditLog` in the same transaction
  as the rest of the user data, which silently destroyed the
  one record actually saying "an admin wiped data". The wipe
  now leaves the audit log alone and adds an explicit
  `admin.data.clear.start` entry before the transaction begins,
  so even a crash mid-wipe leaves a trail. The success copy
  also enumerates the full scope (API tokens, Withings
  connections, auth challenges) instead of pretending only
  measurements / medications / intakes are affected.
- **Cached insight reloads no longer burn a rate-limit token.**
  `POST /api/insights/generate` checked the rate limit before
  the cache return, so a noisy dashboard refresh would lock you
  out for an hour even when every request returned the same
  cached envelope. The check moved below the cache return.
- **One failing health probe no longer blanks the whole admin
  status grid.** `Promise.all` in the status-overview API
  short-circuited on the first rejection. `Promise.allSettled`
  forces failed probes to the `alert` severity and lets the
  rest render normally, with a Wide Event annotation noting
  which probe(s) failed.
- **Settings load errors surface inline instead of spinning
  forever.** When `useSystemStatus` or `useAdminSettings`
  rejects, the admin page now shows a "Failed to load…"
  banner instead of an indefinite skeleton.

### Improved — Settings · KI

- The KI section is fully internationalised — about 30 hard-coded
  German strings now flow through `t("settings.ai.…")` keys, and
  the model-preset list drops `gpt-5` (not a released model) and
  `o3-mini` (would require an o-series parameter contract that
  isn't wired up yet). The privacy "Raw data" warning uses
  Dracula tokens so the colour matches the rest of the panel.

### Improved — Polish

- Numeric spans on the dashboard tiles use `tabular-nums` so
  digits stop jiggling on every refresh.
- The bottom-nav buffer is tighter on mobile and removed on
  desktop (`pb-[calc(4rem+env(safe-area-inset-bottom,0px))]
md:pb-0`), so desktop content sits flush instead of leaving
  an unused 5 rem strip.
- Onboarding "X von Y" / "%" progress drops the monospace font
  and keeps tabular-nums.
- Feedback inbox category badges use Dracula tokens
  (`bg-dracula-red/15 text-dracula-red`) for theme cohesion.
- Codex provider mirrors the OpenAI client's structured-error
  format (httpStatus / model / bodyExcerpt) so failures from
  ChatGPT-OAuth show the same readable message as failures from
  the BYO-key paths.
- Logging redacts third-party AI keys: `redactSecrets` now scrubs
  `sk-` / `sk-ant-` patterns so a misconfigured client cannot
  leak its key into Wide Events. The idempotency body-content
  guard refuses to cache responses that contain those prefixes
  (with a regex tight enough to avoid false positives on words
  like "task-id" or "risk-management").
- Danger-zone result colour follows mutation state instead of
  string-prefix-matching localized copy.

### Repo housekeeping

- `e2e` workflow is back to green: dropped the `pnpm/action-setup`
  version override (now reads `packageManager` from
  `package.json`), switched the mobile Playwright project from
  iPhone 13 (webkit) to Pixel 5 so chromium-only CI installs are
  enough, anchored the locale-cookie test at the configured base
  URL, and made the login spec open the password form before
  asserting on its inputs.
- Repo-wide prettier sweep — long-deferred reformatting drift
  closed before the v1.4.6 tag.

## [1.4.5] — 2026-05-09

### Fixed — Settings · KI

- **"Verbindung testen" no longer crashes the page when the key is
  bad.** The endpoint mapped every upstream error to HTTP 502, which
  Cloudflare intercepts and replaces with its own HTML error page.
  `await res.json()` in the browser then crashed with `Unexpected
token '<', "<!DOCTYPE "`. 401/403 from the provider now map to 422,
  429 to 429, and only genuine 5xx upstream errors keep the 502 —
  Cloudflare passes 4xx through untouched, so the React Query
  mutation reads the JSON body and surfaces a readable message.

### Fixed — Dashboard

- **Dashboard tiles use a CSS Grid layout again** — the v1.3-era
  pattern that gave each tile an identical width with symmetric gaps
  and an edge-to-edge fit with the charts below. v1.4.4 distributed
  width via `flex-1 basis-0`; CSS Grid is more honest about the
  intent and survives viewport changes more gracefully.
  `grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr))` keeps
  every track equal-width with a 9 rem floor; the row wraps when
  the floor no longer fits instead of triggering a horizontal
  scroll.

## [1.4.4] — 2026-05-08

### Fixed — Dashboard

- **Blood pressure is now two distinct tiles again** (sys + dia next
  to each other) — the v1.4.3 attempt at a combined tile read as a
  single double-wide entry; reverting to two separate tiles preserves
  visual rhythm with the other metrics.
- **All tiles share an equal width.** The previous strip used
  `shrink-0 grow basis-[10rem]`, which gave each tile a 160 px floor
  and let wider content (like the BP tile) push past it. Switched
  to `flex-1 basis-0 min-w-[9rem]` — every tile now starts from
  zero and gets the same share of the available row width, with a
  9 rem floor so they stay readable on narrow viewports. The strip
  scrolls horizontally if the row no longer fits.

## [1.4.3] — 2026-05-08

### Fixed — Dashboard

- **Tile strip is now the same width as the charts below it.** The
  small negative-margin bleed that helped the snap-scroll feel on
  mobile was leaking onto desktop and made the tile row 16 px wider
  than the chart strip. Fixed at `md` and up.
- **Tiles all have the same height.** Blood pressure used to render
  as two stacked tiles inside one slot which made it taller than
  every neighbour. Sys/dia now share **one** tile and display as
  `117/79 mmHg` with one trend arrow. Tile count drops from 6 to 5.
- **Settings sub-section "Übersicht" renamed to "Dashboard"** —
  matches the label in the main nav.
- **"Persönliche Zielwerte" is its own settings section now** at
  `/settings/thresholds`, instead of being buried inside the
  Dashboard settings panel under the layout customizer.

### Fixed — Settings

- **API & Tokens tables fit the content column on desktop.**
- **About → "Auf Updates prüfen" works again.** Production CSP
  blocked the direct call to `api.github.com` — the check now goes
  through a server-side proxy. The page also auto-checks once on
  mount when the previous result is older than 24 h, and shows a
  "Zuletzt geprüft am …" timestamp so you can tell when the answer
  was confirmed.
- **About restructured into three titled cards** — HealthLog (version
  - license inline, no boxed badge), Quellen & Dokumentation, and
    Updates.
- **KI provider — OpenAI users can enter their own API key.** Schema
  didn't have a column for it before; added it, plumbed it through
  the resolver and test endpoint, surfaced the input in the Settings
  → KI panel.
- **Model field is now a dropdown** with provider-specific presets
  plus an "Eigenes…" option for power users.
- **"Mit ChatGPT verbinden" no longer dead-ends on chatgpt.com.** The
  OAuth URL was missing its `client_id`; with `CODEX_OAUTH_CLIENT_ID`
  set the handshake completes. When the env var isn't configured the
  button is hidden and a hint points the user at the API-key path.

### Improved — KI Insights

- **AI can illustrate findings with `metric:MOOD` charts inline.** A
  mood drift or adherence-risk finding now renders the dedicated
  Mood chart under the paragraph instead of just prose.
- **Every finding must cite a concrete number** ("138/85 mmHg",
  "+0.4 mmol/L vs 30d-avg") rather than adjectives. Findings without
  a snapshot anchor are now omitted; cardinality is variable 0–8
  sorted by salience. Generic boilerplate ("drink enough water",
  "consult your doctor", etc.) is explicitly forbidden outside the
  disclaimer.

### Improved — Admin

- **Bug-report feature has an explicit on/off toggle.** Previously
  the only way to hide the report button was to clear the encrypted
  GitHub token, which forced a re-entry on resume.

### Improved — Polish

- **"Trennen" looks the same everywhere** (Withings, moodLog,
  KI/Codex). Outlined button with red text — same affordance for
  the same action.

## [1.4.2] — 2026-05-08

### Fixed — Production deploy hotfixes

- **Dashboard and Insights pages no longer crash for users without
  weight data.** `data?.summaries.WEIGHT` only protected the outer
  object — the optional chain stopped one level too early, so
  brand-new users (where `summaries` is undefined) hit
  `TypeError: undefined is not an object (evaluating 'E?.summaries.WEIGHT')`
  on first load. Now `data?.summaries?.WEIGHT`.
- **Container healthcheck uses `127.0.0.1` instead of `localhost`.**
  busybox-`wget` in Alpine resolves `localhost` to IPv6 `::1` first,
  but Next.js standalone listens on IPv4 `0.0.0.0:3000` only — so the
  healthcheck always returned ECONNREFUSED, Docker marked the
  container unhealthy, and Traefik returned 503 from the public URL
  even though the app was actually running. The Dockerfile-level
  `HEALTHCHECK` already used 127.0.0.1; the `docker-compose.yml`
  override was the one that drifted to `localhost`. Fixed.

### Notes

- The 1.4.1 GHCR image never published cleanly (the docker-publish
  workflow reported success in GH Actions but the
  `ghcr.io/mbombeck/healthlog:1.4.1` tag returned `manifest unknown`
  when Coolify tried to pull). The 1.4.2 release supersedes 1.4.1
  and includes everything 1.4.1 was supposed to ship — the v1.4.1
  source on `main` was always healthy; only the Coolify deploy
  surface was broken.

## [1.4.1] — 2026-05-08

### Security

- **moodLog integration no longer accepts internal-network URLs.** A
  user could previously save `http://169.254.169.254/` (cloud-metadata)
  or any RFC1918 address as their moodLog instance; the daily sync
  worker would then fetch from that target with the user's API key in
  the Authorization header. The credentials write path now refuses
  non-public hosts, the sync worker re-checks the URL at the actual
  fetch site (so legacy rows stored before the guard are also
  refused), and the fetch is now `redirect: "manual"` so a public
  host cannot 302 to an internal target with the bearer on the
  redirect hop.
- **Error reports never echo bearer tokens, Telegram bot tokens, or
  query-string secrets.** `WideEventBuilder.setError()` and the
  Glitchtip incident path now run every error message and stack
  trace through a central `redactSecrets()` filter that scrubs
  `Bearer …`, Telegram `bot<digits>:<token>` URLs, and `?secret=`,
  `?code=`, `?token=`, `?api_key=` query strings. The substitution
  is generic `[REDACTED]` so partial entropy is never revealed.

### Fixed — Citation accuracy

- **Blood-pressure classification now cites ESH 2023.** The dashboard
  tile, the doctor-report PDF, and the inline analytics comments
  used to label the band as "ESC/ESH 2018". The numbers haven't
  changed (the 2023 ESH update kept the 2018 thresholds), but the
  joint authoring did — ESC withdrew from the 2023 document, so the
  correct citation is "ESH 2023" alone.
- **Steps target source label is `Saint-Maurice JAMA 2020`** instead
  of `WHO`. Every other surface in the app (AI prompts, inline
  comments, drift tests) already enforced this attribution; the
  insights/targets surface was the last "WHO" label in the tree.
  WHO publishes physical-activity _time_, not a step quota.
- **Saint-Maurice "mortality plateau 8000–12000" attribution
  softened.** The original JAMA 2020 paper reports continued
  dose-response benefit (HR 0.49 at 8k, HR 0.35 at 12k) — not a
  plateau. The plateau-shaped finding belongs to Paluch 2022
  _Lancet Public Health_ (PMID 35247352), not Saint-Maurice. The
  inline comments and AI prompts now say "continued dose-response
  benefit through ~12,000 steps/day" instead.

### Added — CI safety nets

- **Postgres-backed integration test suite is now executable.** The
  testcontainers infrastructure shipped in 1.4.0; this release wires
  the per-test boilerplate through vitest's `globalSetup` so all
  four files share one container. `pnpm test:integration` runs ten
  tests (rate-limit race, idempotency replay-attack contract, GDPR
  Article-17 cascade delete, session create / read / expire) against
  a real Postgres in under four seconds. CI runs the suite on every
  PR.
- **Playwright + axe-core E2E foundation.** A new `pnpm e2e` runs
  five public-surface specs (version endpoint, proxy auth-redirect,
  login form autofill hints, DE/EN locale switch, axe-core
  accessibility gate) against the production build in CI. Authenticated
  flow specs (quick-entry, doctor-report, settings round-trip,
  test-buttons, onboarding) ride a follow-up release because they
  need a seeded test user; the foundation makes adding them a
  one-PR step.

### Changed — Admin internals

- **Admin page is now per-section components.** The status-card grid
  shipped in 1.4.0 sat on top of a 2,700-line monolith; that monolith
  is now 14 focused files in `src/components/admin/` with a 77-line
  `src/app/admin/page.tsx` shell that mounts them. Every section
  keeps the same DOM, ids, query keys, and i18n keys — no
  user-visible change.

### Fixed

- **Final ESLint error is gone.** The medications page's "API
  endpoint" dialog ran its initial-load fetch through a `useCallback`
  paired with `useEffect` and triggered the strict
  `react-hooks/set-state-in-effect` rule. Refactored to TanStack
  Query — same network calls, no effect, lint count is now zero on
  `main`.

### Documentation

- **Repo-internal docs synced for v1.4.** README adds the
  Multi-tenant ready and Test connection buttons feature blocks, the
  API reference table includes the eleven new v1.4 endpoints, and
  the model count is corrected to 26 (RefreshToken). AGENTS.md and
  CLAUDE.md reflect the per-route `/settings/[section]` layout and
  the per-section admin layout. `docs/api/openapi.yaml` documents
  the new endpoints (version, refresh, refresh/revoke,
  status-overview, backup/test, the five test-connection probes).
  `docs/migration/v1.3-to-v1.4.md` corrects the now-wrong "no
  migrations" claim and adds full env-var sections for the
  worker/web split, encryption-key versioning, and off-host backup
  target.

### Notes

- No database migration in 1.4.1.
- No environment-variable change required to upgrade.
- No API contract change — every route added in 1.4.0 is still
  there; no shapes or status codes flipped.
- The audit pass that drove this release identified five medium
  security items and three P0 performance items that warrant
  deeper architectural work; those are tracked in
  `docs/ops/v141-followup-issues.md` and ride a future release.

## [1.4.0] — 2026-05-08

### Added — Foundation, safer ranges, and a faster dashboard

- **UI guidelines, design tokens, and shared primitives.** A new
  `docs/ui-guidelines.md` is the single source of truth for spacing,
  typography, button hierarchy, dialog-vs-sheet decisions, accessibility
  baseline (WCAG 2.1 AA), and the autofill / honeypot pattern for
  health-data forms. Two new shadcn primitives — `<Skeleton>` and
  `<EmptyState>` — replace the previous mix of spinners and "No data"
  placeholder strings. Future v1.4.x components reference the doc; the
  primitives ship with screen-reader-aware semantics and respect
  `prefers-reduced-motion`.
- **`/api/version` public endpoint** exposing the build's version,
  optional Git SHA / build timestamp, license, and canonical links.
  Wires the future Settings → About surface and a thin "Check for
  updates" UX. Static-cached so the route adds zero DB load.
- **`src/lib/medical-citations.ts`** — single source of truth for
  cited medical guidelines (id, name, year, URL, caveat). Future
  medical surfaces import these constants instead of duplicating
  strings in code, prompts, and `messages/*.json`. A new drift-test
  asserts every entry has a non-empty URL + caveat and that the
  recurring "WHO ≥ N steps" hallucination cannot reappear as a constant.

### Fixed — Patient safety and citation accuracy

- **Diastolic blood-pressure orange band no longer reaches 60 mmHg.**
  With the default age-based targets (DBP 70–79), the lower orange
  wing was computed as `diaLow − 10 = 60`. A reading of 60 mmHg landed
  in "mildly low" yellow instead of red even though that level is the
  general-adult hypotension threshold and the J-curve risk floor in
  ESH 2023 for treated hypertensives. Orange floor is now clamped at
  65 mmHg, so 60 mmHg lands in red. The user-override path stays
  intact and remains audit-logged.
- **BP guideline citations consolidated on ESH 2023.** The codebase
  had a mix of "ESC/ESH 2018" (analytics) and "ESC/ESH 2023" (AI
  prompts). The 2023 hypertension document is ESH-only — ESC withdrew
  from the joint authoring — so neither label was correct. Every site
  now cites "ESH 2023" with the published source URL. Numbers
  unchanged.
- **"WHO ≥ 8 000 steps/day" hallucination fully removed.** WHO
  publishes activity _time_ (150–300 min/wk moderate), not a step
  quota. The v1.3.3 fix only landed in `effective-range.ts`; four AI
  prompt strings and the `getStepsRange()` helper carried the old
  wording forward. Saint-Maurice et al., JAMA 2020 (mortality plateau
  8 000–12 000) is now cited everywhere and the two surfaces agree on
  the band. Sleep target moves from "ESC" (no adult sleep guideline)
  to AASM 2015.
- **Body-fat ACE bands corrected and three-way drift resolved.** The
  classifier used `essential = 6 (M) / 14 (F)` as the floor — but
  that's actually ACE's _Athletes_ lower bound. Readings below were
  mislabelled "Essential" instead of "Below essential" (a danger
  band). Six-band classifier now mirrors the ACE table, and the three
  sites that had three different green-band numbers
  (`value-bands.ts`, `targets/route.ts`, `classifications.ts`) all
  derive from `getBodyFatTargetRange` (ACE fitness + acceptable bands).
- **Bedtime-glucose citation softened.** ADA Standards 2024 §6
  publishes pre-prandial 80–130 and post-prandial <180 — no published
  adult bedtime target. The 90–150 mg/dL band stays (reasonable adult
  overnight band) but the inline citation now states the absence
  explicitly and references ISPAD 2022 (pediatric) as the closest
  comparator.

### Fixed — Localisation reaches the notification path

- **Medication reminders now follow the user's locale.** Telegram,
  ntfy, and Web Push reminders previously read "Erinnerung", "Bald
  fällig", etc. regardless of the user's stored language. Templates
  for every phase (`green`/`yellow`/`orange`/`red`) and every keyboard
  button now resolve from `messages/{de,en}.json` per
  `med.user.locale`. Telegram callback IDs stay stable English
  identifiers so the dispatcher keeps matching across locale changes.
- **Dashboard greeting and streak label** are localised server-side.
  Previously hard-coded `"Hi, ${name}"` and `"Tage in Folge"` — both
  now i18n-key-resolved.
- **Mixed-locale Zod validation messages unified to English.** Two
  measurement-form messages and four admin-validation messages
  flipped between German and English depending on which schema fired.
  All consolidated on English (the app is English-first; the German
  UI maps field labels client-side).

### Fixed — Chart math edge cases

- **`summarize` and `trendSlope` use the same time anchor.** Averages
  snapped to `Date.now()`; slopes snapped to the latest point in the
  series. A stale series reported a trend even though the dashboard
  tile correctly hid the average. Both now anchor on `Date.now()`, so
  a stale series returns `null` consistently from every windowed stat.
- **`summarize([])` returns `null` for `min`/`max`/`mean`** instead
  of zeros that leaked into chart axes and AI feature bundles as
  fake readings.
- **`weeklyAverages` is Berlin-timezone aware.** A Sunday-evening
  Berlin reading bucketed into the next week on the UTC production
  container because `Date.getDay()` was system-local. ISO-Monday key
  now resolves via `Intl.DateTimeFormat({ timeZone: "Europe/Berlin" })`.
- **`pairByTimestamp` JSDoc** documents the greedy nearest-match
  heuristic and when a Hungarian-style match would matter (sparse
  health data is well below that bar).

### Fixed — Hidden friction

- **AI provider connection-test honours the unsaved selection.**
  Changing the AI provider in `/settings`, then clicking "Verbindung
  testen" without saving first, used to silently run the test against
  the stored provider — surfacing as a confusing OK / failure unrelated
  to what the user had on screen. Plaintext keys never persist; the
  existing SSRF guard, rate limit, and V3 error-leak shielding stay in
  place.
- **Health-data inputs no longer autofill the user's account
  password.** The base `<Input>` primitive defaults to
  `autoComplete="off"` plus the LastPass / 1Password ignore attributes
  whenever the caller doesn't pass a semantic value. Auth and profile
  forms continue to autofill normally because they pass an explicit
  `autoComplete` (`"username"`, `"email"`, `"current-password"`,
  `"new-password"`).
- **Step-range target aligned across two callsites.**
  `getStepsRange()` returned `{7000, 10000}` while
  `effective-range.ts` returned `{8000, 15000}`; two surfaces showed
  different "green" bands to the same user. Both now use
  `{8000, 15000}`, anchored on Saint-Maurice 2020.

### Performance

- **Two more N+1 queries closed.** `extractFeatures` (used by every
  AI-insight route) issued one `prisma.medicationIntakeEvent.findMany`
  per active medication; replaced with a single batched query and an
  in-memory group. `/api/insights/targets` issued one `findFirst` per
  measurement type; replaced with a single `distinct: ["type"]` query.
  Same shape as the v1.3.0 fix to `/api/insights/comprehensive`.

### Changed — Dashboard

- **Tile strip is always one row.** Replaces the wrapping
  `grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5` layout
  with a `flex snap-x snap-mandatory overflow-x-auto` strip. When the
  user enables more tiles than fit the viewport, the strip
  horizontal-scrolls instead of wrapping; the user trims the set in
  Settings → Dashboard Layout.

### Added — Settings, integrations, and operations

- **Settings page now lives at `/settings/[section]`.** Eight focused
  routes (`account`, `integrations`, `notifications`, `dashboard`,
  `ai`, `api`, `advanced`, `about`) replace the single 3,000-line page.
  Existing `/settings#anchor` links 308-redirect; the side-bar, in-app
  deep links, and the AI / Withings / Codex callbacks all follow the
  new structure.
- **About page** lists the running version, build SHA, license,
  repository link, CHANGELOG link, docs link, and a "Check for
  updates" button that pings the public GitHub releases API. Backed by
  the `/api/version` endpoint shipped earlier in 1.4.0.
- **Admin console** is built around a status-first card grid (Users,
  Integrations, Monitoring, Backups, Maintenance, Audit Log) with each
  area in a focused panel beneath. Per-section extraction of the old
  inline panels is tracked for v1.4.1 — the v1.4.0 admin page already
  routes through the new aggregator endpoint and the status-card
  grid.
- **Five new "Test connection" buttons in Settings.** Withings,
  moodLog, Web Push, Glitchtip, and Umami now ship with one-click
  connection probes — same pattern as the existing AI / Telegram /
  ntfy tests, with per-button rate limit, sanitised error reporting,
  redirect-follow SSRF guard, and an `errorCode` in the response
  envelope so the UI can localise the message.
- **AI insights can reference any of your charts inline.** When a
  finding centres on a single metric (e.g. systolic blood pressure),
  the corresponding chart renders directly under the explanation.
  Server-side allow-list — only the allowed metric tokens render; any
  other model emission drops silently.
- **Off-host backup target.** Daily encrypted JSON dumps to any
  S3-compatible bucket. Worker-side IAM grant is intentionally
  PutObject + GetObject only — retention is the bucket's
  lifecycle-rule job, so a compromised worker cannot wipe the backup
  history. Restore script + step-by-step doc shipped under
  `docs/ops/backup-restore.md`, and an admin "Backup target" test
  button validates the configuration.
- **Encryption-key versioning.** Rotate the at-rest encryption key
  without downtime via `pnpm tsx scripts/rotate-encryption-key.ts <id>`.
  Existing data keeps decrypting under its original key while the new
  one is rolled out. Walk-through + rollback notes in
  `docs/ops/encryption-key-rotation.md`.
- **Worker / web split.** Optional
  `HEALTHLOG_PROCESS_TYPE=web|worker|all` (default `all` for the
  single-container setup) lets you scale background jobs and HTTP
  traffic independently. The proxy refuses HTTP traffic with a 503 +
  `X-HealthLog-Process-Type: worker` header in worker mode so a
  misrouted request fails loudly instead of a silent half-served
  response.
- **Native API clients now get short-lived 24-hour access tokens with
  refresh-token rotation.** The browser keeps the existing 90-day
  Bearer. Reuse-detection (presenting a refresh token a second time)
  revokes every refresh token for the user — the small cost of a
  forced re-login on the legitimate device buys defense-in-depth
  against an undetected stolen-token replay.
- **Critical-path coverage on Telegram / Withings / moodLog /
  Glitchtip webhook handlers + the four admin routes lifted to ≥80%
  line coverage,** plus `src/lib/auth/audit.ts`. ~+100 new tests.

### Fixed — Operational hardening from the v1.4 review pass

- **Container time zone is correct.** Alpine images ship without
  `tzdata`; the daily backup cron `30 2 * * *` Europe/Berlin was
  silently falling back to UTC. The runner stage now installs
  `tzdata` and exports `TZ=Europe/Berlin` so schedules fire at the
  documented local time.
- **Compose healthcheck uses `wget --spider /api/version`** — `/api/version`
  is now in the proxy's public-paths allowlist, so the healthcheck no
  longer 302-redirects through the auth gate (which was accepting the
  login page as a 200 success).
- **Idempotency replay-cache no longer caches refresh tokens.** The
  guard already blocked the `hlk_` access-token prefix; the new
  `hlr_` refresh tokens are blocked too.
- **Logout-on-device revokes the paired access token.** Calling
  `/api/auth/refresh` with `revoke: true` now flips both the refresh
  row and the matching `ApiToken` row to revoked, so a leaked access
  token cannot outlive its refresh-token sibling.
- **`users.locale` migration drift backfilled.** The column had been
  on `schema.prisma` since the v1.3 locale-aware reminder work but
  never landed in the migration history (it must have been applied
  via `prisma db push` to dev/prod). Any environment built strictly
  from `prisma/migrations/` (CI testcontainers, brand-new self-host
  installs) is now consistent. Migration is `ADD COLUMN IF NOT
EXISTS`, so it's a clean add on a fresh database and a safe no-op
  against any environment that was already kept in sync.

### Notes

- Largely additive release. Existing API contracts (response
  envelopes, OpenAPI 3.1 spec) are unchanged. New endpoints surface
  optional fields; no breaking changes.
- New migration `0025_refresh_tokens` adds the rotating refresh-token
  table; new migration `0025_user_locale_drift_fix` backfills the
  schema-vs-migrations drift on `users.locale`. Both are
  forward-compatible — `IF NOT EXISTS` guards make them idempotent on
  any environment already pushed-to.
- Operators of the off-host backup feature must configure a bucket
  lifecycle policy for retention. The worker has no DeleteObject
  grant by design.
- Native API clients (iOS, n8n, Health Connect) need to update their
  login flow: native logins now return both a 24-hour access token
  and a refresh token. The browser flow is unchanged.
- **Tracked for v1.4.1:** per-section admin panel extraction (the
  status-card grid + aggregator already ship in 1.4.0; the inner
  per-section file split is structural cleanup), the Postgres-backed
  integration test suite (testcontainers infrastructure ships in this
  release; the four integration tests themselves need a follow-up
  pass against the merged schema), and Playwright E2E + axe-core CI
  gates.

## [1.3.3] — 2026-05-08

### Added

- **Pulse oximetry as a first-class measurement type (`OXYGEN_SATURATION`).**
  Closes the SpO2 part of #109. Migration `0024_oxygen_saturation` extends
  the `MeasurementType` enum. Plausibility range 50–100% (below 50% is
  incompatible with sustained life and almost certainly a faulty sensor;
  upper bound 100% is physical). Default severity bands follow BTS Guideline
  2017 + ATS clinical practice: green 95–100%, orange 92–94%, red <92% —
  lower-only concern (the upper orange wing collapses onto greenMax since
  saturation cannot physically exceed 100%). COPD / chronic-respiratory
  users with a doctor-set baseline of 88–92% can personalize via the
  threshold-override UI. Wired through Withings (ScanWatch type 54),
  measurement form, list, charts, doctor PDF, OpenAPI spec, and i18n (DE +
  EN). iOS DTO already declared `OXYGEN_SATURATION` from a prior commit;
  the server enum addition closes the long-standing drift.
- **Body composition surfaces (TOTAL_BODY_WATER, BONE_MASS, BLOOD_GLUCOSE)
  in the measurements list filter, badge, mobile icon, edit dialog, and
  server-rendered doctor-report PDF** — closes the UI side of #109. Root
  cause was three local maps in `measurement-list.tsx` that drifted from
  the v1.3 server enum; extracted to `measurement-list-meta.ts` with
  fail-fast coverage tests so future enum additions are caught at build
  time. Server-side PDF used a separately-drifted type map vs. the
  browser-side renderer; both are now in sync.
- **Effective-range thresholds for `TOTAL_BODY_WATER` and `BONE_MASS`** —
  severity logic was returning `nominal` for any value because no defaults
  existed.

### Changed

- **OpenAPI `MeasurementType` enum extended + spec version bumped 1.3.0 →
  1.3.3** to match the actual app. Spec was lagging by two minor releases.
- **Withings webhook secret now reads from `X-Withings-Webhook-Secret`
  header** in preference to the legacy `?secret=…` URL query parameter.
  Closes the URL-leak-via-access-logs vector flagged in audit C-3. Legacy
  query-param path is retained for backwards compatibility and emits a
  Wide Event warning so operators can spot still-using-the-old-flow
  integrators. Plan: remove the query fallback in 1.4.x once warnings drain.
- **Idempotency `defaultUserIdResolver` now supports Bearer tokens.**
  Cookie sessions tried first, then Bearer-token via `hashToken` lookup.
  Without the Bearer fallback, every iOS / external-ingest retry was
  hitting the handler again and creating duplicate measurements (audit
  C-4 — the exact use case `withIdempotency` was built for).
- **GlitchTip URL stripping** — `reportToGlitchtip` now strips the URL
  query string before forwarding so Withings legacy `?secret=…` and OAuth
  `?code=…` callbacks cannot leak via the error tracker (audit H-B7).

### Fixed

- **Migration `0022_body_composition_metrics` unit comment lied** —
  claimed `TOTAL_BODY_WATER: percent of body weight (%)` while every other
  surface (validators, Withings client, doctor PDF) treated it as `kg`.
  Comment corrected to match reality.

### Security

- **Bearer-scope wildcard handling (CRITICAL — V3-1).** `requireAuth()`
  previously accepted any non-admin token regardless of declared
  permission scope, so a token with `permissions:["medication:ingest"]`
  could DELETE the user account. Spec now requires `permissions:["*"]`
  or the explicit required permission.
- **Account-deletion completeness (CRITICAL — V3-2 / GDPR Art. 17).**
  Cascades through `Feedback` + `AuditLog` rows so user-erasure is
  actually total. Daily retention job sweeps orphaned audit rows after
  90 days as a defence-in-depth.
- **Withings webhook secret header migration (audit C-3)**, idempotency
  Bearer-resolver (audit C-4), GlitchTip URL strip (audit H-B7).
- **Truthfulness pass on medical citations** — SpO2 normal-range source
  is now consumer-pulse-oximeter consensus + NICE NG115 + FDA labelling
  (BTS-2017 was for clinical hypoxaemia thresholds, not consumer
  monitoring); body-composition metrics are explicitly labelled
  "bioimpedance-estimated, not DEXA-comparable" in the doctor PDF;
  TBW citation now references the Watson formula / ICRP Reference Man
  (was misattributed to ESPEN 2017); steps target now references
  Saint-Maurice JAMA 2020 (WHO publishes minutes/week, not steps).
- **SpO2 user-override clamp** — overrides could emit physical
  impossibilities (e.g. `orangeMax = 100.75`); clamped to METRIC_BOUNDS
  for SpO2 + BODY_FAT.
- **moodLog webhook secret encrypted at rest with AES-256-GCM** (V3
  STILL-V2-C-2). Read path tolerates legacy plaintext rows during the
  transition window; one-shot startup migration in the worker rotates
  any leftover plaintext rows.
- **CSP tightening** — `chatgpt.com` + `api.openai.com` `connect-src`
  now gated to `/settings/ai/**` (was a global blanket on every page,
  including `/auth/login` → DOM-XSS exfil channel).
- **Web-Push subscription endpoint SSRF guard** — `endpoint` now
  requires HTTPS + passes `isPublicUrl()` (was `z.url()` only).
  Side-fix: `isPublicUrl()` no longer falsely classifies DNS labels
  starting with `fc`/`fd` (e.g. `fcm.googleapis.com`) as IPv6
  unique-local; the IPv6 check is now gated on a colon being present.
- **IP-geolocation lookup is now HTTPS-only.** Default provider is
  `ipwho.is` (free, HTTPS, no key). Existing `ip-api.com` plaintext
  HTTP path leaked auth-event IP + timestamp on every login (GDPR Art.
  32 + Art. 44). Operators can override via `IP_GEO_LOOKUP_URL` (HTTPS
  only) or disable entirely with `IP_GEO_LOOKUP_DISABLED=1`.
- **`/api/ai/test` no longer returns provider error message + body
  excerpt to the client.** Diagnostics land server-side via Wide Events
  (annotate); client gets a categorised generic message. Closes provider
  URL / partial key / internal header leak.
- **`/api/import` rate-limit added** — 5 imports/hour/user. Was
  unlimited (bulk-injection vector).
- **Trusted-proxy XFF semantics** — `getClientIp()` now reads
  `X-Forwarded-For` right-to-left with a configurable
  `TRUST_PROXY_HOPS` (default 1, matches typical single-proxy
  self-host). Closes XFF rotation bypass of per-IP rate-limits.
- **Audit-log retention job** — `audit_logs` rows older than
  `AUDIT_LOG_RETENTION_DAYS` (default 365) are purged daily. Closes
  GDPR Art. 5(1)(e) "storage limitation" gap.
- **Idempotency cachable-status filter** is now an exported, unit-tested
  function — pins the do-not-cache contract for 401/403/408/429/5xx.
- **Bearer mock tightening** in `require-auth-bearer.test.ts` +
  `idempotency.test.ts`: `apiToken.findUnique` calls are now asserted
  to use `where: { tokenHash: <hashed> }`, so a regression to raw-token
  comparison would break the suite immediately.

### Internal

- **Server-side enum drift cousins closed.** Five module-level
  hardcoded type-arrays in `/api/insights/comprehensive`,
  `/api/dashboard/summary`, `/api/analytics`, `/lib/insights/general-status`,
  `/api/import` are now derived from `measurementTypeEnum.options`.
  External-contract enums extended additively:
  `/api/measurements/series` (`oxygen`, `totalBodyWater`, `boneMass`),
  `/api/dashboard/widgets` (`oxygenSaturation`), `DashboardWidgetId` +
  `DEFAULT_DASHBOARD_LAYOUT`. New coverage test asserts the canonical
  enum stays the source of truth.
- **Doctor-PDF text-content tests** — replaced bytes-only "renders body
  composition rows" theatre with `pdf-parse`-driven assertions on the
  actual rendered DE + EN labels and values. Adds dev dep `pdf-parse`.

## [1.3.2] — 2026-04-28

### Fixed

- **Glucose tiles on the dashboard rendered the raw i18n key
  `targets.glucoseFasting` instead of the translated label** (closes
  #108). Both `messages/en.json` and `messages/de.json` had two
  top-level `targets` blocks; `JSON.parse` silently keeps the last
  occurrence, and that block was missing the four glucose labels. The
  duplicate is now collapsed into a single block. A duplicate
  `bugreport.bugTitlePlaceholder` shadowed inside `bugreport` was
  cleaned up too. Two further keys (`dashboard.sleep`,
  `dashboard.steps`) were missing from both locales and were falling
  back to hard-coded English; both are now translated.
- **New i18n locale-integrity test**
  (`src/lib/__tests__/i18n-locale-integrity.test.ts`) fails the build
  on duplicate keys at any nesting depth and on key drift between
  `en` and `de` — closes the structural gap that let the duplicate
  `targets` block ship in the first place.

### Changed

- **Screenshot upload removed from the bug-report form** (also part
  of #108). The form previously accepted an image attachment that
  was stored in the local DB but never reached the published GitHub
  issue — GitHub does not accept inline base64 data URIs in issue
  bodies and offers no public API to attach images to an issue
  programmatically. Rather than ship misleading
  "a screenshot was attached" placeholder text in the resulting
  issue, the upload UI is now gone and the placeholder note is no
  longer added when promoting feedback. The `screenshotBase64`
  column and the admin-side preview of previously-submitted
  screenshots are unchanged — existing reports keep their
  attachments locally. We plan to revisit a real screenshot pipeline
  in a future release.

## [1.3.1] — 2026-04-27

### Fixed

- **Compose env-var validation no longer breaks Coolify-style deploys.**
  `docker-compose.yml` previously used `${VAR:?required}` shell-parameter
  syntax for the four secrets and `POSTGRES_PASSWORD`. Some hosting
  platforms (Coolify in particular) parse compose files eagerly and
  store the _fallback error string_ (`"POSTGRES_PASSWORD is required"`)
  as the literal env-var value when `POSTGRES_PASSWORD` was unset,
  which then collided with `DATABASE_URL` and broke the running app
  with `P1000: Authentication failed`. Compose now uses plain `${VAR}`
  interpolation; validation moved into `docker-entrypoint.sh`, which
  fails fast with a clear stderr message listing the unset variables.

### Notes

If you upgraded an existing Compose stack from 1.2.x → 1.3.0 and hit
the `POSTGRES_PASSWORD is required` literal-as-value bug, set
`POSTGRES_PASSWORD` in your environment to whatever your existing
Postgres data volume was originally initialised with (likely
`healthlog` if you started from a pre-1.2.1 release), then redeploy.
Postgres only honours `POSTGRES_PASSWORD` on first volume init — the
existing user keeps the original password regardless of env changes.

## [1.3.0] — 2026-04-27

### Added — Body composition + targeted hardening

- **Total body water and bone mass as measurement types** (closes #89). New
  enum values `TOTAL_BODY_WATER` and `BONE_MASS`, both stored canonically
  in kilograms (matches Withings hydration/bone-mass measures and Health
  Connect's `TotalBodyWaterRecord` / `BoneMassRecord`). Migration is
  purely additive (`ALTER TYPE ... ADD VALUE`) — safe to apply against
  any 1.2.x database without downtime.
- **Withings sync picks both up automatically.** The Withings client now
  maps measure type `77` (hydration / water mass) and `88` (bone mass).
  Anyone with a Withings Body+ scale and an active connection will see
  the new metrics flowing in on the next sync without any extra config.
- **Doctor-report PDF includes both new types** in the vital-signs table
  when data exists, with locale-aware labels in English and German.
- **Dashboard widgets registered for both** (default-invisible — opt in
  via Settings → Dashboard layout).

### Security

- **SSRF guard hardened** (`isPublicUrl`). The previous implementation
  used `parseInt` with permissive prefix checks like `h.startsWith("10.")`
  which let `010.0.0.1` slip through — and worse, the WHATWG URL parser
  silently normalises `010.0.0.1` to `8.0.0.1` (octal interpretation), a
  real bypass on naive checks. The new guard adds a pre-URL leading-zero
  check on the raw input, a strict IPv4 parser, and proper IPv6
  bracket / loopback / link-local handling. Now blocks `127.0.0.0/8`,
  `0.0.0.0/8`, `10.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`,
  `192.168.0.0/16`, `100.64.0.0/10` (CGNAT), `::1`, `fe80::/10`,
  `fc00::/7`. Comprehensive regression tests included.
- **GitHub PAT redacted from logged error bodies.** When a feedback
  escalation to GitHub fails, the response body was being passed
  verbatim into `getEvent()?.addWarning(...)` — flowing to Loki. The
  body is now stripped of the configured token before logging.
- **Per-user threshold writes are rate-limited** (30 writes / 5 min) to
  make audit-log enumeration unattractive. Audit-logging itself was
  already there.

### Performance

- **N+1 in `/api/insights/comprehensive` fixed.** The medication-compliance
  loop hit Postgres once per active medication. It now batches into a
  single `medicationId IN (...)` query and groups in memory. Latency
  improvement scales linearly with the user's active medication count.

### Reliability

- **pg-boss draining on SIGTERM/SIGINT.** `docker stop`, Coolify redeploys,
  and Kubernetes pod terminations now trigger `boss.stop({ graceful: true,
timeout: 30s })` so in-flight handlers finish instead of being killed.
  Previously, pending handlers could be lost or replayed on restart.
- **CI now blocks on TypeScript strict checks.** `continue-on-error: true`
  removed for typecheck. Tests already were blocking. ESLint stays
  non-blocking for now — the existing `settings/page.tsx` monolith has
  long-standing `react-hooks/set-state-in-effect` violations whose proper
  fix lives in the 1.4.0 settings-split refactor; a blocking lint here
  would just gate every PR until that refactor lands. Required cleaning
  up two `any` types in `api-handler.ts` (justified inline — Next.js
  variadic handler signature constrained by `Promise<Response>` return).

### Polish

- **Bottom-nav touch targets** sized to WCAG 2.5.5 minimum (44×44 CSS px).
  Visual icon stays at 20 px so the design doesn't shift.
- **Phase-config dialog** marks the decorative coloured dot `aria-hidden`
  because the redundant text label already conveys the phase to screen
  readers. No more meaningless `image` node announcements.
- **Admin-status labels** for "Web Push" and "Bug Report" now go through
  `t()` (new `admin.integrationWebPush` / `admin.integrationBugReport`
  keys in en + de). They were the last hard-coded English strings on
  the admin page.

### What's _not_ in this release (tracked for later)

- **Onboarding redesign** (dashboard-first empty-state flow + persistent
  Getting Started checklist) and the **typed `apiClient` wrapper** that
  underpins it are tracked for a focused 1.4.0 cycle. The 1.2.1 patch
  already closed the acute symptoms of #87 (silent-failure toast +
  default schedule), so the redesign is now a proper UI investment
  rather than a bug-fix.
- **Withings sync is mapping both new measures**, but **a dedicated
  Bearer-auth ingest endpoint for external pipelines** (n8n + Health
  Connect, requested in #89) ships in 1.4.0 alongside the API-token
  flow.

## [1.2.1] — 2026-04-27

### Fixed

- **Onboarding**: Medications added during onboarding are now actually persisted (closes #87). The wizard previously sent an empty `schedules: []` array, the server-side validation rejected it with a 422, the client never checked `response.ok`, and the user was redirected to the dashboard as if everything had worked. Onboarding now wraps each step in `try/catch`, surfaces failures via toast, and attaches a default reminder window (`08:00–09:00 daily`) so the medication actually persists. A hint under the medication list explains the default.
- **Docker setup** (closes #88):
  - `docker-compose.yml` now uses `ports: "3000:3000"` (was `expose: "3000"`, which made the app unreachable from the host).
  - `POSTGRES_PASSWORD` is a single env var that both the Postgres service and `DATABASE_URL` interpolate, so they cannot drift apart.
  - `.env.example` now points at the in-container hostname `db:5432` (was `localhost:5432`, which never resolves inside the app container).
- **Documentation**:
  - `package.json` synced to 1.2.0 (was lagging on 1.1.0).
  - `CLAUDE.md` and `AGENTS.md` corrected to 23 models (the `Feedback` model added in v1.2 was missing from the count).
  - `README.md` Quick Start gives a realistic time estimate, generates the four secrets in one block straight into `.env`, and points reverse-proxy users at the docs.

### Added — Tooling & Supply Chain

- **Pre-built multi-arch images on GHCR**: `.github/workflows/docker-publish.yml` now builds `linux/amd64` + `linux/arm64` images on every push to `main` and on every `v*` tag, publishing to `ghcr.io/mbombeck/healthlog`. Self-hosters no longer need a build toolchain — `docker compose pull && docker compose up -d` is enough. The bundled `docker-compose.yml` references the published image with a `build:` block as fallback for contributors.
- **Supply-chain attestations**: each published image carries a SLSA build provenance statement and a Software Bill of Materials. `SECURITY.md` documents how to verify them and how to pin a specific version.
- **Documentation single source of truth**: `getting-started/installation.mdx` is now the canonical setup guide (mirrors the bundled `docker-compose.yml`); `self-hosting/docker.mdx` slimmed to image internals + ops notes only. The landing page's Quick Start terminal block now includes the secrets-generation step (was missing).

### Notes

This is a patch release that closes the install/onboarding friction reported in #87 and #88. The bigger user-facing changes (additional measurement types like total body water and bone mass per #89, full onboarding redesign, typed API client) are tracked for `1.3.0`.

## [1.2.0] — 2026-04-18

### Added — Personalization, Glucose & Multi-Provider AI

- **Per-user custom thresholds**: Override the computed default ranges (BP, BMI, glucose, pulse) with values from your clinician. Audit-logged with previous/new values and timestamps. Doctor Report PDF flags custom ranges and prints both your target and the standard guideline value.
- **Blood glucose tracking**: New metric with `fasting`, `postprandial`, `random`, and `bedtime` contexts. Display unit switch between mg/dL and mmol/L (lossless conversion). Context-aware classification per ADA 2024 / DGIM. Per-context charting on dashboard and Doctor Report PDF.
- **Dashboard customization**: Show/hide and drag-to-reorder every dashboard widget. Per-user preference, reset-to-defaults button. Layout persists across the same user on the same device.
- **Built-in feedback system**: New in-app Send Feedback flow (Bug / Feature / Question / Other) with anonymized system info attachment. Stored in HealthLog's own database — no GitHub config required. Optional `Escalate to GitHub` button for admins who configure a PAT.
- **Multi-provider AI insights**: Provider abstraction extended with **Anthropic Claude** and **local OpenAI-compatible endpoints** (Ollama, LM Studio, vLLM, LiteLLM) alongside OpenAI. Per-user provider selection. Local endpoints keep all health data on your network.
- **Locale-aware UI polish (English-first)**: Numbers, dates, glucose units, BP, weight, and BMI all formatted via `useFormatters()` from the active locale. Doctor Report PDF and AI insight prompts now respect locale end-to-end (no hand-rolled `Intl.*` with fixed locales).

### Changed

- Reference range computation extracted into a dedicated `src/lib/health/thresholds.ts` module with computed defaults and override resolution.
- AI provider routing reworked to dispatch by `provider` field on the user record; OpenAI remains the default for legacy users.
- Dashboard route renders widgets from `UserDashboardLayout` model when present, otherwise falls back to the default order.
- Doctor Report PDF: locale-aware headers, glucose section, custom-range badges.

### Security

- GitHub PAT for feedback escalation stored AES-256-GCM encrypted in the database (never as env var).
- Local AI endpoint URLs validated against SSRF (no localhost/RFC1918 unless explicitly allowed by admin).
- Custom threshold writes rate-limited and audit-logged with IP.

## [1.1.0] — 2026-04-06

### Added — AI Insights Overhaul

- **ChatGPT Proxy Integration**: Insights now run through a local openai-oauth proxy using your ChatGPT subscription — no separate API billing required
- **Admin AI Fallback**: Admins can configure a global API key (OpenAI/OpenRouter) as fallback for users without their own connection
- **Provider Abstraction**: New `src/lib/ai/` module with pluggable providers (Codex OAuth, Admin Key, None) and automatic failover
- **Medical Insight Prompts**: 7 specialized prompts based on ESC/ESH 2023, WHO, DGE, and DEGAM guidelines
  - Blood Pressure: ESC/ESH classification, morning risk ladder (J-HOP), pulse pressure, seasonal variation
  - Weight: 5%/10% milestone recognition, plateau detection, body composition divergence
  - Pulse: Fitness interpretation ladder, 80-100 bpm elevated-risk band, rate-pressure product
  - BMI: Age-adjusted DEGAM classification for 65+
  - Medication Compliance: Chronotherapy hints, mood-adherence risk prediction, 90-day tracking
  - General Status: Cross-domain synthesis with cardiovascular risk stratification
  - Mood: Bidirectional correlations with vitals and adherence
- **Enriched Feature Extraction**:
  - Sleep duration and activity steps (previously ignored)
  - Rate-Pressure Product (pulse × systolic BP, myocardial demand indicator)
  - Body composition divergence flag (weight stable + body fat rising)
  - Mood-adherence risk predictor
  - Seasonal BP variation (winter vs summer, requires >180 days data)
  - BP standard deviation (sdSys30/sdDia30) as variability risk marker
  - Pulse pressure (arterial stiffness marker)
  - 5 cross-metric Pearson correlations (weight↔BP, pulse↔BP, mood↔pulse, mood↔BP, mood↔weight)
  - 90-day averages and all-time statistics for all metrics
  - Historical comparison (current 7d vs previous 30d baseline)
- **New UI Components**:
  - `InsightStatusCard`: Compact per-metric status card with classification indicator and fade-in animation
  - `InsightAdvisorCard`: Premium structured card with findings, correlations, recommendations (ready for integration)
- **OAuth Routes**: `/api/auth/codex/authorize`, `/callback`, `/disconnect` for ChatGPT connection
- **Admin AI Settings**: `/api/admin/ai-settings` for global API key management

### Changed

- Insight prompts now use personal advisor tone ("dein Blutdruck") with positive-first pattern
- Reasoning scaffold in system prompt (What changed? → Why? → What to do?)
- Conditional correlation instructions (only mention when |r| > 0.4)
- InsightResult schema enriched with `insightType`, `primaryRecommendation`, `classificationLabel`
- BP target calculation now uses paired readings (both sys AND dia must be in range simultaneously)
- Medication streak tracking extended from 7-day to 30-day window
- CSP updated to allow `chatgpt.com` for OAuth flow

### Security

- Rate limiting on all OAuth and admin endpoints
- PKCE (S256) + state parameter for OAuth CSRF protection
- Encrypted token storage at rest (AES-256-GCM)
- Error messages truncated to prevent upstream response body leaks
- Admin key preview shows last 4 chars of decrypted key (not ciphertext prefix)
- `prefers-reduced-motion` support for insight card animations

### Removed

- `openaiKeyEncrypted` field from User model (replaced by provider abstraction)
- Direct OpenAI API calls from insight generators (now routed through provider)
- Legacy API key input in settings UI (replaced by ChatGPT connect button)

## [1.0.1] — Previous release
