# HealthLog v1.4.25 — release summary

## Release brief

v1.4.25 is the largest feature delta in the v1.4.x line and the first time the
loud / polish / foundation three-beat ran through a multi-cluster
expansion on top of the v1.4.20-introduced develop-to-main release-merge model.
Insights expands from a single mother page into seven dedicated metric
sub-pages with a shared tab strip; GLP-1 medication tracking lands
end-to-end across the dashboard tile, the weight-chart marker overlay,
the therapy timeline, the plateau-detection rule in the daily briefing,
the dedicated doctor-report section, a Research-Mode drug-level chart
behind an MDR acknowledgment dialog, an EMA-sourced drug knowledge layer,
the EMA titration ladder, cadence visualisation, compliance chips, a
21-entry by 5-category side-effect taxonomy, and a pen-and-vial
inventory with a 30-day in-use clock; the cross-source priority resolver
becomes a two-axis metric × deviceType lookup with a per-user Settings
surface; per-user timezone threads through ten analytics and presentation
surfaces; Withings coverage roughly doubles with twelve new measurement
types, webhook-driven BP / temperature ingestion, plus the new Activity
sync (steps + distance + active-energy) and Sleep v2 sync (stage-level
segments); the onboarding flow rebuilds as a nested-route wizard with a
welcome carousel, goals chip-picker, source selection grid, baseline
form, and a welcome-back resume banner; Personal Records ship end-to-end
with a pg-boss detection worker, push opt-in, and a metric-trend badge;
Health Score gains a per-component provenance accordion; the Coach runs
on native first-party prompts across all six locales bound by a
1800-assertion refusal-probe matrix on every push; the OpenAPI drift gate
flips to hard-fail so the v1.5 iOS DTO codegen can rely on
`docs/api/openapi.yaml` being authoritative; and the GHCR image is now
multi-arch so Apple Silicon Macs and arm64 clouds pull native.
Migrations 0043–0060 are additive and forward-only. `PROMPT_VERSION`
4.24.0 → 4.25.0 carries GROUND RULE 9 (Coach refuses GLP-1 dose
recommendations) and GROUND RULE 15 (Coach refuses drug-level estimates
with explicit EU MDR 2017/745 + MDCG 2021-24 cites in the refusal copy).

## Live state

| Field              | Value                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| URL                | `https://healthlog.bombeck.io`                                                  |
| `/api/version`     | `1.4.25`                                                                        |
| GH release         | https://github.com/MBombeck/HealthLog/releases/tag/v1.4.25                      |
| Branch model       | `develop` → `main` release-merge model, sixth tag through it (v1.4.20 onwards)  |
| Tag commit         | `17b8d8d2 chore(release): v1.4.25`                                              |
| Predecessor        | `v1.4.24` at `ca03c609`                                                          |

## What shipped

### Insights expansion — seven dedicated metric sub-pages

`/insights` becomes a navigation hub. `/insights/blutdruck`,
`/insights/gewicht`, `/insights/puls`, `/insights/stimmung`,
`/insights/medikamente`, `/insights/bmi` and `/insights/schlaf` each
render the metric's full chart, range bands, trend annotations and
correlation rows beneath the mother-page hero. Tab strip lifts above
each chart for cross-metric scanning. Targets (`/insights/zielwerte`)
redesigns around a new `<TargetCard>` primitive with a conditional
Coach-handoff card that hides cleanly in rule-based mode. Sleep
sub-page renders awake / REM / core / deep as a stacked column over
the last 7 / 14 / 30 nights, sourced from `Measurement.sleepStage`.

### GLP-1 medication tracking — end-to-end across ten surfaces

`Medication.treatmentClass` enum (`GLP1`, `STANDARD`),
`MedicationDoseChange` history table, an `InjectionSite` enum with
eight site values, and a body-map picker that proposes the next
rotation site from the last fourteen days. Dashboard tile carries
next-injection schedule plus week-over-week weight delta. Weight chart
gains vertical injection markers. Therapy timeline plots titration
alongside the weight trace. Plateau-detection in `/api/insights/briefing`
flags four-week stalls with referral framing. Doctor-report PDF gains
a dedicated GLP-1 section. Drug-level chart on the medication detail
page renders behind a Research-Mode gate; the acknowledgment dialog
cites EU MDR 2017/745 + MDCG 2021-24, EMA EPAR and Schneck / Urva 2024
before the user can opt in. EMA titration ladder helpers walk the
sourced schedule and frame as reference-not-advice. Cadence + compliance
helpers expand the schedule into expected slots, pair each with the
closest actual intake, and render a timeline + chip strip; honour
per-user timezone so cross-midnight doses bucket correctly regardless
of locale. Side-effect taxonomy (Migration 0059) covers 21 entries × 5
categories, severity Likert 1-5, with `category` derived server-side so
the taxonomy cannot drift between client and server. Pen-and-vial
inventory (Migration 0056) carries a SEALED → IN_USE → EXPIRED state
machine with a 30-day in-use clock from `markAsFirstUseAt`; a daily
03:00 cron flips expired in-use items in one `updateMany`. State
machine re-runs on every PATCH so a back-dated first-use immediately
moves a stale pen to EXPIRED.

### Cross-source priority — two-axis architecture

`User.sourcePriorityJson` (Migration 0048) stores the per-user resolver:
a single-axis ladder by metric type plus an optional per-device-type
override. `pickCanonicalSource()` walks the metric axis first; a
per-device override (e.g. "BP from Withings BPM Connect, weight from
Withings Body+") wins within that ladder. Defaults: cumulative + sleep +
HRV + RHR favour Apple Health → Withings → manual; point measurements
favour Withings → Apple Health → manual. The `__default__` sentinel is
retired in favour of a null bucket. Settings → Sources screen exposes
the ladder for drag-reorder per metric and per-device override picker.

### Per-user timezone — Option B threaded through ten surfaces

New `User.timezone` column defaults to `Europe/Berlin`. CSV exporter
emits ISO-8601 with offset; formatters honour the user's tz; Profile
picker covers all IANA zones; admin sets the default for new accounts;
signup detects the browser tz; doctor-report PDF dates use the user's
tz; chart x-axes take a `timezone` prop; Coach snapshot timestamps
land in the user's tz; `MoodEntry.tz` records local-day grouping for
weekday correlation (Migration 0044); the weight-weekday correlator
buckets in the user's tz. Cadence + compliance helpers honour the
same argument.

### Withings — expanded coverage + Activity + Sleep v2

Twelve new `MeasurementType` values (HRV, body temperature, SpO2 v2,
VO2 max, fat-free mass, fat mass, muscle mass, skin temperature,
pulse-wave velocity, vascular age, visceral fat — Migration 0049).
Webhook coverage extended to BP and temperature so the latency
collapses from ~1 h polling to seconds. OAuth scope upgraded to include
`user.activity` with an in-app reconnect banner. Activity sync calls
`getactivity`, ingests one row per day, anchors at noon UTC so
positive-offset users bucket cleanly into their local day. Sleep v2
sync calls `sleepv2_get` and writes per-night stage segments through
the new `sleepStage` composite (Migration 0055 widens the Measurement
unique index to include `sleep_stage` with `NULLS NOT DISTINCT`).
Backed by pg-boss `activity-sync` and `sleep-v2-sync` queues plus
webhook enqueue hooks on the new subscription channels.

### Onboarding rebuild — six-step nested-route wizard

`/onboarding/[step]` powered by a new `<OnboardingShell>` primitive:
value-prop carousel, goals chip-picker, source 4-card selection grid
(Apple Health marked coming-soon), baseline form, source-connect step,
done step. `User.onboardingStep` (Migration 0057, with Migration 0060
backfilling and flipping the column to `NOT NULL DEFAULT 0`) drives
resume-state. A welcome-back banner surfaces on the entry page when
an in-progress wizard is detected. `POST /api/onboarding/step`
conditions the update on `{ id, onboardingStep: current,
onboardingCompletedAt: null }` and returns 409 on concurrent advance
to close the read-then-write race.

### Personal Records — schema, worker, badge, push opt-in

Migration 0054 introduces the `PersonalRecord` table +
`PersonalRecordDirection` helper. `GET /api/personal-records` clamps
`?limit` (default twenty-five, max two hundred). A pg-boss worker
sweeps MAX / MIN per metric and the workout slots on every batch-ingest
plus a thirty-minute fallback cron (concurrency five; warmup gate so
the very first datapoint per metric does not promote itself).
Metric-trend tiles render a PR badge when the record landed in the
last thirty days, with WCAG-AA contrast in dark mode. A per-user push
opt-in toggle (default off) wires into the existing dispatcher cascade.

### Workouts — schema + typed batch-ingest endpoint

Migration 0053 introduces `Workout` + `WorkoutRoute` tables; the Zod
boundary in `src/lib/validations/workout.ts` covers a twenty-member
sport-type union and a `GeoJSON LineString` route column in JSONB.
`POST /api/workouts/batch` accepts up to five hundred rows per call,
wraps `withIdempotency()`, returns the same `inserted | duplicate |
skipped` envelope as the measurements batch, and reconciles inserted
vs duplicate counts correctly under contention. Rate-limited,
size-capped.

### Coach — native first-party prompts across six locales

Coach + insights system prompts move from EN body + `REPLY LANGUAGE`
footer to native per-locale bodies. The safety contract matrix lives
as YAML per locale (single source of truth across drafting + tests).
GROUND RULE 9 forbids GLP-1 dose recommendations; GROUND RULE 15
forbids drug-level estimates and cites EU MDR 2017/745 + MDCG 2021-24
in the refusal copy. The refusal-probe matrix in CI exercises 15
GROUND RULES across six locales with 20+ adversarial paraphrasings
each — 1800+ assertions on every push. Drift-guard tests pin the
YAML matrix in lockstep with the validator-derived enums.

### OpenAPI drift gate — hard-fail flip

`pnpm openapi:check` CI step now red-bars a PR on any drift between
the Zod registry and `docs/api/openapi.yaml`. The v1.4.23 warn-only
window closes; iOS DTO codegen can rely on the spec being
authoritative.

### Multi-arch GHCR image + Coolify auto-deploy toggle

GHCR publish workflow builds `linux/amd64` on `ubuntu-latest` plus
`linux/arm64` on `ubuntu-24.04-arm` and merges the manifest. Apple
Silicon Macs and arm64 clouds pull native. The Coolify auto-deploy
gate is now an explicit `vars.COOLIFY_AUTO_DEPLOY=true|false`
maintainer toggle in the deploy workflow instead of the implicit
secret-presence gate that silently no-op'd in v1.4.21-23.

### Security cluster

`WITHINGS_WEBHOOK_SECRET` no longer lands as a URL path-segment in
`http.path` on every Wide Event. The logging stack now carries a
parameterised `PATH_SECRET_PATHS` registry seeded with the
`/api/withings/webhook/[token]` shape; `WideEventBuilder.setHttp`
rewrites path + route segments to `[REDACTED]` before they reach
stdout / the in-memory ring buffer / Loki. Existing query-string
redaction is unaffected. `POST /api/medications/[id]/glp1` now parses
through bounded Zod schemas, enforces length caps on notes,
finite-number guards on dose value, bounded `effectiveFrom`, writes
an `auditLog` row on every change and inherits the 30-per-minute-per-
user rate limit from the rest of the medication surface.
Batch-ingest endpoints (`POST /api/measurements/batch`,
`POST /api/workouts/batch`, `DELETE /api/measurements/by-external-ids`)
carry a sixty-per-minute-per-user token-bucket rate limit. Source-
priority and doctor-report-prefs PUTs emit `AuditLog` rows.

## Migrations

| Migration | Purpose |
|---|---|
| 0051 `measurement_device_type` | Adds `deviceType` enum + column to `Measurement` for the two-axis source-priority resolver. |
| 0052 `apple_health_enum_extensions` | Adds `ENVIRONMENT_AUDIO_EXPOSURE`, `HEADPHONE_AUDIO_EXPOSURE` and `TIME_IN_DAYLIGHT` to `MeasurementType`. |
| 0053 `workout_and_route` | Introduces `Workout` and `WorkoutRoute` tables for the typed workout-batch ingest endpoint and the v1.5 iOS workout sync. |
| 0054 `personal_record` | `PersonalRecord` table + `PersonalRecordDirection` helper. Unique index is `NULLS DISTINCT` by convention; the detection worker carries the application-level idempotency guard. |
| 0055 `measurement_sleepstage_composite` | Widens the `Measurement` unique index to include `sleep_stage` with `NULLS NOT DISTINCT` (Postgres 16 native) so Withings sleep v2 segments dedup correctly. |
| 0056 `medication_inventory_item` | `MedicationInventoryItem` table for the GLP-1 pen/vial inventory with the SEALED → IN_USE → EXPIRED state machine. |
| 0057 `user_onboarding_step` | Adds `onboardingStep` nullable to `User` for the wizard resume-state. Originally nullable; superseded by Migration 0060. |
| 0058 `user_research_mode` | Adds `researchModeAck*` columns to `User` for the GLP-1 Research-Mode MDR acknowledgment. |
| 0059 `medication_side_effect` | `MedicationSideEffect` table for the 21-entry × 5-category taxonomy. |
| 0060 `onboarding_step_not_null` | Backfills existing `User.onboardingStep` rows to 0 and flips the column to `NOT NULL DEFAULT 0`. Closes the tri-state ambiguity left by 0057. |

All ten are additive and forward-only. Migration 0057's comment was
rewritten to match PG11+ fast-path `ADD COLUMN DEFAULT` semantics
during the reconcile pass.

## Test coverage delta

| Suite | v1.4.24 | v1.4.25 | Delta |
|---|---|---|---|
| Unit | 2 244 | 3 828 (across 344 files) | +1 584 |
| Integration | 140 | ~170 (across 11 files) | +30 |

The unit-test growth is dominated by the Coach refusal-probe matrix
(1800+ assertions across 15 GROUND RULES × 6 locales × 20+ paraphrasings)
plus the feature-cluster helper suites: GLP-1 plateau-detection text formatter;
two-axis source-priority resolution; source-priority Settings reducer;
medication-card GLP-1 variant + injection-site-picker; doctor-report
prefs PUT contract; personal-records pagination clamp; `berlinIsoWeekday`
timezone-aware suite; sleep-stage chart i18n drift-guard; Health-Score
provenance i18n drift-guard; api-handler private-field crash regression;
pure cadence + compliance helpers with TZ assertions across UTC+0,
UTC+9, UTC-8; side-effect taxonomy drift-guard; EMA titration ladder
helpers; pen-inventory state-machine + 30-day clock helpers; PR
detection worker (MAX / MIN per metric + workout slots + warmup gate
+ null-slot dup regression + zero-duration guard); Withings activity
TZ regression across Berlin / Los Angeles / Tokyo / Auckland; Withings
sleep v2 segment ingest; log-redaction path-segment rule + `setHttp`
rewrite; GLP-1 endpoint Zod + audit + rate-limit; onboarding step
concurrent-advance regression; inventory PATCH state-machine back-dated
first-use regression; bulk-update contract for the expire-stale cron;
brand-name guard + sentinel-preservation + safety-contract parity for
the YAML matrix; locale auto-discovery + fallback-chain runtime guard.

Integration: two-axis canonical-source resolution end-to-end;
`requireAuth()` narrow-scope on unscoped route; batch-ingest race
reconciliation under contention; workout-batch race + size-cap + ingest
end-to-end; PR-detection end-to-end; cross-source priority for
Withings Activity + Apple Health; Withings sleep-stage composite ingest;
per-user timezone end-to-end (Pacific/Auckland).

e2e green on the W2 CI fix (coach-prefs URL mock + Pixel-5 selector
hardening) plus the Fix-I hot-fix that re-anchored the dashboard
insight-card and the mobile x-axis tick locators class-independently.
Typecheck clean. Lint baseline carried (no new warnings). OpenAPI
drift-check clean against the regenerated spec.

## Code quality gates

The W21 review ran eight read-only reviewers in parallel: code,
security, design, senior-dev, simplifier, product-lead, dead-code,
i18n-runtime. Combined output was 103 findings (2 Critical, 20 High,
41 Medium, 40 Low) plus a strategic product-lead assessment.

**Critical (2 / 2 applied)**: sec-C1 (Withings webhook secret leaking
into `http.path` on every Wide Event) and product-lead-C1 (CHANGELOG
frozen at the initial release-prep surface, omitting the bulk of the
later feature work). Both closed before tag — sec-C1 via Fix-J
(`PATH_SECRET_PATHS` registry + `setHttp` redaction);
product-lead-C1 via the W22 release-redo editorial pass.

**High (20 / 20 applied)**: sec-H1 (GLP-1 endpoint missing Zod + audit
+ rate-limit) closed in Fix-K. Six design-Highs (onboarding tap targets,
range-bar palette, PR-badge contrast) closed in Fix-L. Two code-Highs
(inventory state machine bypass on PATCH, per-row expire loop) closed
in Fix-M. Seven simplifier-Highs (`readError` dup, `templateFill`,
`statusLabel` nested ternary, `ResearchModeStatus` shared type,
`findDrugIdByBrand`, `assertMedicationOwnership` across 11 routes,
`MedicationInventoryState` import) closed in Fix-N. Code-H2 (cadence +
compliance ignore per-user timezone) closed in Fix-O. Dead-H4
(research-mode-staleness module never wired) resolved by deletion in
Fix-O. One product-lead-H1 (test count footer stale) and
product-lead-H2 (Deferred-to-v1.4.26 section lists already-shipped
items) closed in W22.

**Medium (17 of 41 applied, 24 deferred to v1.4.26)**: 17 ship-now
Mediums landed across Fix-J through Fix-O; the deferred 24 split
between schema-shape decisions (`User.onboardingGoals` column;
`/api/audit-log` consumer decision), module-surface narrowing
(`glp1-pk.ts`, `glp1-knowledge.ts`, `scheduling/*` unused exports),
148 remaining dead i18n keys after the W15 380-key sweep, and seven
orphan endpoint go / no-go decisions that need maintainer call. Full
deferrals matrix lives in `.planning/phase-W21-reconcile-plan.md` lines
220-265.

**Low (40 / 40 deferred to v1.4.27)**: appendix in the reconcile plan
covers them — none are user-facing; one (i18n-Low-1, e2e
`healthlog_locale` vs `healthlog-locale` cookie typo) was
opportunistically picked up in Fix-P because the touch was a single
character.

Seven touch-disjoint Fix-J through Fix-P surfaces totalling 22 atomic
commits ran across `develop` between the W21 audit and the W22
release-prep. Three sequenced merge windows preserved touch-disjoint
diffs without conflict (Fix-O before Fix-N on the cadence route;
Fix-L before Fix-N on the onboarding components; Fix-M before Fix-O
on the PR worker test). No file had two agents editing the same lines.

## Strategic posture

### v1.5 iOS readiness

The iOS sprint has the contracts it needs to start Day 1. Locked
server contracts after v1.4.25:

- `POST /api/measurements/batch` — Apple Health bulk ingest with
  `inserted | duplicate | skipped` per-entry envelope, idempotency
  wrapper, rate-limited (v1.4.23, unchanged here).
- `DELETE /api/measurements/by-external-ids` — HealthKit deletion-sync
  (new in v1.4.25).
- `POST /api/workouts/batch` — HKWorkout-aligned typed ingest with
  20-sport-type union + GeoJSON LineString routes (new in v1.4.25).
- `POST /api/devices` — APNs token registration with paired
  `apnsEnvironment` (v1.4.23, unchanged).
- `POST /api/onboarding/step` — wizard progression with rate limit +
  audit + 409-on-concurrent (new in v1.4.25).
- `GET /api/personal-records?metricType=X` — paginated PR reads.
- `User.sourcePriorityJson` two-axis resolver with
  `pickCanonicalSource()` — iOS sets Apple Health as the cumulative +
  sleep + HRV + RHR favourite; Withings stays the point-measurement
  default.
- `Measurement.deviceType` enum with iOS-17/18 HK long-tail mappings
  ready to extend.
- `MedicationInventoryItem` — pen/vial 30-day clock available for an
  iOS pen-scanner integration.
- `Workout` + `WorkoutRoute` tables (the table-side; endpoint signature
  finalised during the iOS sprint).
- `docs/api/openapi.yaml` regenerates byte-identically from the Zod
  registry; the drift gate is now hard-fail.

### MDR boundary preservation

The GLP-1 Research-Mode surface ships with three concentric defences:
chart gating (`User.researchModeAck*` columns require an active
acknowledgment before render), dialog acknowledgment (cites EU MDR
2017/745, MDCG 2021-24, EMA EPAR and Schneck / Urva 2024 before the
user can opt in; version-bump re-prompts), and Coach refusal at the
prompt layer (GROUND RULE 15 across all six locales, refusal-probe
matrix in CI). The titration ladder display is framed as
reference-not-advice and bound by the same GROUND RULE 15. Drug-level
chart-side 90-day staleness wiring stayed deferred for v1.4.26 (the
helper module shipped tested in W19c-Safety but the chart conditional
isn't wired — the unused helper was deleted during Fix-O after the
reconcile pass; the 90-day gate becomes a clean v1.4.26 surface when
the maintainer decides to wire it).

### Branch model

`develop` is the daily target; `main` is release-only and follows tags.
v1.4.25 is the sixth tag through the develop-to-main release-merge model
introduced in v1.4.20 F1. GHCR auto-deploy fires only on `main`; the
explicit `vars.COOLIFY_AUTO_DEPLOY=true|false` toggle closes the
silent-miss pattern that hit v1.4.21 / v1.4.22 / v1.4.23.

## 0-10 score per area

| Area | Score | Note |
|---|---|---|
| Insights | 9 | Seven-sub-page split lands cleanly; Targets redesign with conditional Coach-handoff is the tightest the layout has been; mother page slims to general status + Coach hero. Half-point off for the duplicate `StatusCard` regression that needed a Fix-I hotfix mid-release. |
| Dashboard | 9 | Top-tile polish (single-line headings, inline trend arrow, baseline alignment across tiles) closes the v1.4.24 reviewer note; comparison-overlay default removed in favour of per-chart preference; VO2 max secondary-metric tile lands as opt-in. |
| Coach | 9 | Native per-locale prompts replace the REPLY LANGUAGE footer across six locales; GROUND RULE 9 + GROUND RULE 15 close the MDR boundary at the prompt layer; 1800+ refusal-probe assertions in CI on every push. Half-point off for FR/ES/IT/PL prose still being LLM-drafted (structural matrix covers safety; the prose itself benefits from a native human pass — queued for v1.4.26). |
| Settings | 8 | Source-priority screen ships with drag-reorder + per-device override + audit-log; doctor-report per-section toggles + mood-default-off lands; Research-Mode toggle with version re-prompt banner lands. Single point off for the settings-cog vs per-message-controls debate (v1.4.23 carryover) still unresolved. |
| Admin | 8 | Login overview gains location + provider columns + CSV polish; coach-feedback header layout shift closed; notification-status-card icon parity restored; mobile admin nav gains Overview link. Two points off for the seven orphan endpoint go / no-go decisions still pending a maintainer call. |
| Mobile (web) | 8 | 44-px touch-target floor across onboarding wizard, top-bar, section strips and injection-site picker hits WCAG 2.5.5; dashboard tile baseline alignment regression-pinned. Two points off because the e2e workflow needed the Fix-I hot-fix re-anchor on dashboard insight-text + chart-tick locators (now class-independent). |
| Tests | 9 | 2 244 → 3 828 unit (+1 584); 140 → ~170 integration; new drift-guards across Apple Health mapping, side-effect taxonomy triangle, sleep-stage chart i18n, Health-Score provenance, safety-contract YAML matrix, plus per-user TZ regressions and the 1800-assertion refusal-probe matrix. Half-point off for the two pre-existing `coach-prefs.test.ts` `NextRequest` URL mock failures still carried from v1.4.23. |
| CI | 9 | OpenAPI drift gate flips to hard-fail; refusal-probe matrix runs on every push; multi-arch GHCR builds clean after the Fix-G/H lowercase fix-up; explicit `vars.COOLIFY_AUTO_DEPLOY` toggle closes the silent-miss pattern. Half-point off for the Fix-H lowercase regression that needed catching post-PR-open. |
| Docs | 9 | CHANGELOG expand in W22 brings the public artifact in lockstep with what shipped; per-section delta is complete; deferred-to-v1.4.26 / v1.5 sections are accurate. Half-point off because the W22 reconcile was the C-1 Critical of the release and only ran after the W21 product-lead caught it. |
| Repo hygiene | 9 | 380 dead i18n keys dropped; dead prompt constants removed; `<InsightsPageHero>` + `<IntakeTimeline>` + `<ComplianceCharts>` + orphan query keys + `/api/insights/general-status` orphan all gone; `MedicationDetailSection` wrapper + shared route-guards / read-error / dose-string / research-mode-types modules collapse 11+ duplications. Half-point off for the 148 remaining dead i18n keys queued for a v1.4.26 second-pass. |
| Demo readiness | 8 | Multi-arch image is live so the demo VPS pulls native arm64; W11b demo-deploy report covers the runbook; OpenAPI spec is authoritative for iOS DTO codegen. Two points off because the demo seeding still depends on the manual host-side fallback when Coolify auto-deploy is toggled off, and because the iOS Swift app itself is queued for v1.5 (the demo is web-only until then). |

## v1.4.26 backlog

24 deferred Mediums + 40 Lows + maintainer-decision items split across
the following themes:

- `User.onboardingGoals` schema column + server-side persistence
  (today the goals chip-picker holds the choice client-side only;
  the dashboard-widgets seed feature reads from it in v1.4.26).
- `advance()` hook extraction across the three onboarding step
  components (simplifier surfaced; deferred to avoid collision with
  the v1.4.25 touch-target pass).
- 148 dead i18n keys remaining after the W15 380-key sweep (need a
  second-pass call-site verification).
- Drug-level chart-side 90-day staleness clock wiring (acknowledgment
  dialog already re-prompts on version bump and Coach refuses at
  GROUND RULE 15; the clock is defence-in-depth).
- FR / ES / IT / PL Coach + insights prose hand-review by native
  speakers (structural refusal-probe matrix covers safety; the user-
  facing prose benefits from a human pass).
- Sleep sub-page stacked-column visual polish (stage colours + legend
  density).
- VO2 max chart-row card on `/insights/<metric>` (dashboard tile
  shipped; chart card queued alongside the iOS body-composition page).
- Mood verbal-labels persistence behind a per-user toggle.
- Coach `lastYear` baseline + row-tap-to-prefill polish.
- Lazy-loaded locale JSON bundles (all six locales import
  synchronously today, ~675 KB to every client).
- iOS-18 long-tail HK identifier mappings (sleep apnea, GAD-7 /
  PHQ-9, running form, paddle / row / ski distances, pregnancy /
  cycle, FHIR clinical).
- Seven orphan endpoint go / no-go decisions
  (`/api/admin/ai-settings`, `/api/admin/backup/test`,
  `/api/admin/status-overview`,
  `/api/monitoring/{glitchtip,umami}/test`).
- `glp1-pk.ts` and `glp1-knowledge.ts` unused-export decisions
  (internalise vs wire dashboard chip).
- Pearson incomplete-beta replacement (v1.4.23 carryover already
  partially closed with the conservative MIN_PAIRED_N raise — the
  rigorous replacement is the v1.4.26 candidate before correlation
  auto-discovery widens in v1.5/v1.6).

## Carry-overs

- The two pre-existing `coach-prefs.test.ts` `NextRequest` URL mock
  failures still carry through from v1.4.23. Tracked in
  `.planning/v1426-backlog.md`; non-blocking for the release.
- Manual-workout route `findFirst` serial pattern stays in place
  (no manual workout UI today; contract correctness only matters
  once v1.5 UI lands).
- The Coolify auto-deploy MCP API path still fires
  `force=true` and reports "finished" in ~18 seconds without a real
  `docker pull`, but the new `vars.COOLIFY_AUTO_DEPLOY` toggle plus
  the "Watch image registry for new digests" UI checkbox capture the
  durable fix; the host-side retag fallback recipe lives in
  `.planning/coolify-auto-deploy-howto.md` for the cases where the
  toggle is off.

## Strategic next

The v1.5 sprint starts with iOS first launch (login + dashboard +
widget) against locked server contracts — pure Swift work, zero
server-side touches. P2 (Apple Health sync) calls the v1.4.23
`POST /api/measurements/batch` against the v1.4.25 device-type +
two-axis resolver. P3 (Coach extended for HRV / sleep / resting HR /
steps) ratchets `PROMPT_VERSION` 4.25.0 → 5.0.0 and copies the web
`<CoachDrawer>` UX to iOS. P4 (per-metric APNs alerts) leans on the
v1.4.23 APNs scaffolding for the send-side. P5 (workouts + GeoJSON
routes) calls the v1.4.25 `POST /api/workouts/batch` against the
shipped Workout + WorkoutRoute tables.
