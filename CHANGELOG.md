# Changelog

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
