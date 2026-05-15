# v1.4.26 Backlog — HealthLog

**Drafted**: 2026-05-14 (end of v1.4.25 marathon)
**Status**: explicit deferral record per Marc directive ("alles deferred ist explizit dokumentiert")
**Successor of**: v1.4.25 (134 commits, 2627 unit + 174 integration tests, PROMPT_VERSION 4.25.0)

Items grouped by priority + theme. Every item carries effort estimate + source-citation back to a v1.4.25 phase report or W10 review.

---

## P0 — Strategic / iOS-readiness

### P0-1 — OpenAPI drift-gate hard-fail flip + registry coverage completion · M
Still warn-only after v1.4.25. v1.4.23 §A.6 promised the flip for v1.4.24; slipped twice. iOS DTO codegen needs hard-fail confidence — a route signature change between tag and the first iOS spec regen lands clean today and surfaces only when the iOS build breaks. Registry coverage 880 → 5468 closes in parallel; gate flips the moment coverage exceeds legacy surface. Source: `.planning/research/w10-product-lead-assessment.md` §F + §G ("biggest pre-tag risk") + §H.2.

### P0-2 — Onboarding rebuild · M-L
v1.4.25 is the last release where new users see the v1.4.20-era onboarding (missing Insights sub-pages, GLP-1, Health Score provenance, Withings full coverage, source-priority two-axis, six locales). iOS launch multiplies onboarding traffic. Marc-promoted from v1.5. Source: `.planning/v1425-handoff.md` §4; `.planning/research/w10-product-lead-assessment.md` §H.1.

### P0-3 — Native FR / ES / IT / PL Coach + insight system-prompts · M per locale
v1.4.25 ships these locales riding the EN system prompt with a one-line REPLY LANGUAGE footer (`src/lib/ai/coach/system-prompt.ts`, `src/lib/ai/prompts/insight-generator.ts`). Native bodies let each safety contract speak in its target voice. Includes `buildPrefsPrefix` widening (currently EN/DE only). Source: `.planning/phase-W9e-v1425-translations-report.md` §"Deferred polish for v1.4.26"; `.planning/research/w10-product-lead-assessment.md` §A + §H.6.

---

## P1 — Hygiene / cleanup (close before v1.5 P1 starts)

### P1-1 — 414 dead i18n keys cleanup · S
Top namespaces: `settings:114`, `admin:75`, `classifications:69`, `medications:21`, `onboarding:21`, `dashboard:15`, `charts:14`, `common:12`. Drop from EN AND DE (locale-integrity test fails on one-side touches). Spot-check `classifications.alerts.*` (26 keys) + `targets.bloodPressure/weight/steps` (iOS shadow) before dropping. Race-blocked from W7e by concurrent W9e locale-bundle edits; W9e now landed. Source: `.planning/research/w10-dead-code-candidates.md` §"i18n dead-key aggregate"; `.planning/phase-W7e-v1425-dead-code-cleanup-report.md` §Deferred.

### P1-2 — `BASE_SYSTEM_PROMPT` + `INSIGHTS_SYSTEM_PROMPT` removal · S
`src/lib/ai/prompts/base-system.ts:196` + `src/lib/insights/prompt.ts:106` — both `@deprecated` since v1.4.20, zero callers. Includes Cat-C `@deprecated` markers themselves. W9e race risk now gone. Source: `.planning/research/w10-dead-code-candidates.md` §A6+§A7; `.planning/phase-W7e-v1425-dead-code-cleanup-report.md` §Deferred.

### P1-3 — W7d hardening: `safeRequestProp` narrow-catch + `@source` path-resilience · S
`safeRequestProp` in `src/lib/api-handler.ts` catches-all on private-field crashes; narrow to V8 `TypeError` and log on every fallback so a real bug doesn't hide. `@source not "../../.planning"` in `src/app/globals.css` is relative-path brittle — switch to absolute-from-root. Source: `.planning/phase-W7d-v1425-dev-server-repair-report.md` §"Deferred follow-up".

### P1-4 — Cat-C stale-comment typo fix · trivial
`src/app/api/insights/targets/route.ts:807` carries `// general-status}.ts already enforce…` — stray brace, half-quoted reference to a deleted route's lib. Source: `.planning/research/w10-dead-code-candidates.md` §C2.

---

## P2 — Schema-already-shipped, logic-pending

### P2-1 — PersonalRecord Detection Worker · M
Migration 0054 + table + direction helper (`src/lib/personal-records/pr-direction.ts`) + `GET /api/personal-records` all landed in W8d. Sweep-on-insert + nightly cron is the smallest thing that turns the empty table into a real product feature. Source: `.planning/phase-W8d-v1425-ah-server-prep-report.md` §"Deferred items"; `.planning/research/w10-product-lead-assessment.md` §H.4.

### P2-2 — Workout ingest endpoint · S
`POST /api/measurements/batch?kind=workout`. Migration 0053 + `Workout` + `WorkoutRoute` + Zod boundary (`src/lib/validations/workout.ts`, 20-member sport-type union, GeoJSON LineString) all in code. Unblocks iOS workout sync without v1.5 schema migration. Likely ships with iOS-app v1.5. Source: `.planning/phase-W8d-v1425-ah-server-prep-report.md` §"Deferred items"; `.planning/research/w10-product-lead-assessment.md` §C.7 + §H.5.

### P2-3 — Workout cross-source dedup · S
`(user_id, source, external_id)` unique allows two rows when user logs MANUAL + HK both. v1.4.25 added a TODO on the model; the actual workout-canonical-picker (extend `pickCanonicalSourceRows`) waits until iOS dupes are observable. Source: `.planning/research/w10-senior-dev-findings.md` §M-3; `.planning/research/w10-reconcile-B-architecture-report.md` §Senior-dev M-3.

### P2-4 — iOS-18 long-tail HK identifier mappings · M per wave
`HK_QUANTITY_TYPE_DEFERRED` in `src/lib/measurements/apple-health-mapping.ts` captures sleep apnea, GAD-7/PHQ-9, running form, paddle/row/ski distances+speeds, pregnancy/cycle, FHIR clinical, with planned-release windows inline. Rolls out v1.4.26+. Source: `.planning/phase-W8d-v1425-ah-server-prep-report.md` §"Deferred items".

### P2-5 — VO2 max chart-row card · S
W8d.5 shipped the dashboard tile only (default-invisible). Matching chart card on `/insights/<metric>` queued alongside iOS body-composition sub-page. `metric:VO2_MAX` chart-token allow-list already in place. Source: `.planning/phase-W8d-v1425-ah-server-prep-report.md` §"Deferred items"; `.planning/research/w10-product-lead-assessment.md` §H "Additional carry-overs".

---

## P3 — Withings + integrations

### P3-1 — Withings Activity sync routine · S-M
OAuth scope (`user.activity`) + reconnect banner shipped in W5d. Sync wave itself is small but needs user-impact rollout plan — reconnect banner must reach every Withings user before sync writes rows. Source: `.planning/v1425-handoff.md` §4; `.planning/research/w10-product-lead-assessment.md` §H.3.

### P3-2 — Withings Sleep v2 routine · M
Sleep v2 endpoint coverage on the Withings API. Marc-deferred from v1.4.25 cheap-wins because of test surface + reconnect coordination overlap with P3-1. Source: `.planning/v1425-handoff.md` §1+§4.

### P3-3 — Withings webhook secret moved to header · S
`getWithingsWebhookCallbackUrl()` still passes secret via query string at subscribe time; lands in nginx logs + Glitchtip. Header form is supported (`notify_subscribe` accepts `headers`). Every user reconnecting for W5d's `user.activity` refreshes the subscribe URL — natural migration window. Remove query-string fallback after one release. Source: `.planning/research/w10-security-review-findings.md` §M-2.

---

## P4 — Quality items from W10 reconcile (Low + apply-with-care)

### P4-1 — Lazy-loaded locale JSON bundles · M
`src/lib/i18n/context.tsx:15-29` synchronously imports all six locales (~675 KB to every client bundle). Needs lazy `import()` per active locale + hydration-flash mitigation. Source: `.planning/research/w10-code-review-findings.md` §L1.

### P4-2 — Chart-x-axis-tick timezone audit · S
`src/components/insights/sleep-stage-stacked-bar.tsx:117` builds `new Date(y, m-1, d)` in SSR-server tz, then re-formats. Cosmetic axis-label shift; full audit-pass across chart tick helpers. Source: `.planning/research/w10-code-review-findings.md` §L2.

### P4-3 — `coach.batch.too_large` errorCode renamespace · trivial
`src/app/api/measurements/batch/route.ts:102` should emit `measurement.batch.too_large` (DELETE sibling already correct). Source: `.planning/research/w10-code-review-findings.md` §L5.

### P4-4 — `detectGlp1Plateau` direct test coverage · S
Existing test covers the string formatter only; Prisma-driven window arithmetic, `meds[0]` pick, threshold comparison untested. Both H-1 (security sanitise) + M-3 (timezone) regressions would have slipped. Vitest with mocked Prisma. Source: `.planning/research/w10-code-review-findings.md` §L6.

### P4-5 — `__testables.WEEKDAY_KEYS` cleanup · trivial
`src/lib/ai/coach/glp1-snapshot.ts:72,406` — exported, no consumer. Source: `.planning/research/w10-code-review-findings.md` §L4.

### P4-6 — `/api/audit-log` surface decision · S
User-facing GET exists; no UI consumer. Either wire `/settings/audit-log` page OR delete the endpoint. Marc decision per endpoint. Source: `.planning/research/w10-security-review-findings.md` §L-1; `.planning/research/w10-dead-code-candidates.md` §B3.

### P4-7 — `Measurement.deviceType` enum vs TEXT · S
Column TEXT but Zod enforces a closed seven-slot set. Postgres enum (`ALTER TYPE … ADD VALUE` non-locking) more economical. v1.5 cleanup-pass note. Source: `.planning/research/w10-senior-dev-findings.md` §L-2.

### P4-8 — i18n drift-guard for PR + Workout strings · trivial
When P2-1 detection worker + UI lands, drift-guard must cover new PR/Workout strings across six locales. Source: `.planning/research/w10-senior-dev-findings.md` §L-3.

### P4-9 — Design Medium + Low polish (M7, L1-L4) · S total
M7 — medication-form Dialog inline-control follow-up sweep. L1 — `motion-reduce:animate-none` inconsistency across spinners. L2 — Health Score disclaimer 10 px borderline. L3 — `<details>` accordion `aria-controls`. L4 — therapy-timeline `<h4 class="sr-only">` for SR scanning. Source: `.planning/research/w10-design-review-findings.md` §M7 + §L1-L4.

### P4-10 — Pre-existing `hsl(var(--border))` anti-pattern · trivial
`mood-chart.tsx:649` + `scatter-correlation-chart.tsx:89,128,129` carry the invalid `hsl(<hex>)` form C1 fixed in `sleep-stage-stacked-bar.tsx`. Source: `.planning/research/w10-reconcile-A-design-report.md` §Flags.

### P4-11 — Simplifier apply-with-care · M total
- **S1** — derive `metricPriorityObjectSchema` + `sourcePrioritySchema` from `SOURCE_PRIORITY_METRIC_KEYS` (needed when v1.5 adds workouts to 14-key metric list).
- **S3** — extract `reorderLadder<T>()` helper for `moveSource` + `moveDeviceType` duplication (`src/components/settings/sources-section.tsx:174-216`).
- **S9** — shared `ContributingSource` union (duplicated 4 times across health-score + component).
- **S10** — extract `allMessages` + `resolveKey` shared file between `lib/i18n/context.tsx` + `lib/i18n/server-translator.ts` (~25 LOC duplication).
- **S12** — `useInsightStatus(metricSlug)` hook to collapse 13-LOC repeated block across 5 sub-pages.
Source: `.planning/research/w10-simplifier-findings.md` §"Apply-with-care"; `.planning/research/w10-reconcile-D-simplifier-report.md` §"Items deferred".

### P4-12 — Simplifier discuss-first · trivial
- **S11** — `useSyncExternalStore` → `useState + useEffect` in `<MaintainershipBanner>` (current form deliberate SSR-mismatch guard; Marc decision).
- **S14** — drop single-row fast-path in `pickCanonicalSourceRows` (4 LOC vs documented intent).
- **S15** — drop `typeof prisma?.medication?.findMany !== "function"` guard in `detectGlp1Plateau` (production masking test-setup smell).
Source: `.planning/research/w10-simplifier-findings.md` §"Discuss-first".

---

## P5 — GLP-1 feature inspirations

`.planning/research/glp1-feature-inspiration.md` does NOT exist at draft time. Once Marc commissions it, append its v1.4.26-bucket recommendations here.

Carry-overs already known:
- **GLP-1 component-test polish** — W4d-tests landed RTL coverage for medication-card-glp1 + injection-site-picker; broader integration tests for plateau-detection + therapy timeline pending. Source: `.planning/phase-W4d-v1425-glp1-full-report.md` §"Tests deferred".
- **`medication_schedules` snake_case consumer scrub** — W4e renamed columns (Migration 0047); consumer audit pending. Source: `.planning/v1425-handoff.md` §2 W11 "Deferred to v1.4.26".

---

## P6 — Polish + nice-to-have

### P6-1 — Pearson incomplete-beta replacement · S
Pearson correlation uses an approximation; rigorous incomplete-beta needed for auto-discovery surfaces planned in v1.5/v1.6. v1.4.23 carryover. Source: `.planning/research/w10-product-lead-assessment.md` §A + §H "Additional carry-overs".

### P6-2 — Sentinel parser observability for HealthKit envelopes · S
Extend W5 H1 `SentinelParseResult.malformedEntries[]` pattern to HealthKit envelopes before P3 PROMPT_VERSION 5.0.0. Source: `.planning/research/w10-product-lead-assessment.md` §H "Additional carry-overs".

### P6-3 — Coolify auto-deploy maintainer toggle · S
Third release in a row shipped via host-side SSH-retag fallback. Coolify auto-deploy still gated on missing secrets. Source: `.planning/research/w10-product-lead-assessment.md` §A.

### P6-4 — Coach `lastYear` window option · S
W5 added four window options to `CoachScopeWindow`; `lastYear` deferred to respect the snapshot.ts boundary. Needs enum extension + snapshot mapping. W7b timezone work now settled. Source: `.planning/phase-W5-v1425-coach-polish-report.md` §"Deferred items".

### P6-5 — Coach prefill on health-score row tap · S
Per-row callback (tap row → "tell me more about my mood component") deferred for clean-callback plumbing through the hero strip. Source: `.planning/phase-W8e-v1425-health-score-provenance-report.md` §"Deferred".

### P6-6 — Per-night sleep-stage stacked column chart · M
W4c shipped the stacked-bar overview; true per-day×stage time-series chart needs a new server endpoint. Source: `.planning/phase-W4-v1425-insights-sub-pages-report.md` §"Deferred / not in scope".

### P6-7 — Locale-native date format ordering · trivial
`format.dateShort` / `timeShort` / `dateTime` in `messages/{fr,es,it,pl}.json` inherit EN form. FR/ES/IT want `{day}/{month}/{year}`; PL wants `{day}.{month}.{year}`. Source: `.planning/phase-W9e-v1425-translations-report.md` §"Deferred polish".

### P6-8 — GitHub translation-feedback issue template · trivial
`<MaintainershipBanner>` links to `issues/new?template=translation.md` but the template file isn't in the repo. Source: `.planning/phase-W9e-v1425-translations-report.md` §"Deferred polish".

### P6-9 — Hand-review FR/ES/IT/PL prose on high-traffic surfaces · L per locale
Build script covered ~30-40% with real translations; remainder falls through to EN. Priority: `settings.sections.*.description`, `insights.*` (368 keys), `targets.label.*` + `targets.status.*`. Source: `.planning/phase-W9e-v1425-translations-report.md` §"Deferred polish"; `.planning/research/w10-design-review-findings.md` §"Cross-cutting".

### P6-10 — Cat-B endpoint triage · M total
17 endpoints look orphan but need human go/no-go: `/api/audit-log` (also P4-6), `/api/admin/ai-settings`, `/api/admin/backup/test` (singular), `/api/admin/status-overview`, `/api/import`, `/api/settings/account` (DELETE account UI?), `/api/monitoring/{glitchtip,umami}/test` pair. Each either wires an admin UI or gets deleted. Source: `.planning/research/w10-dead-code-candidates.md` §B.

### P6-11 — Mood verbal labels follow-up · S
Carry-over from v1.4.25 polishing pass. Source attribution: v1.4.25 handoff §2 W11 "Refactor" CHANGELOG bullet; no dedicated W*-report covers it standalone (see attribution-flag below).

---

## Pre-existing risks (carried over from v1.4.25)

From `.planning/v1425-handoff.md` §5:
1. **Pre-existing coach-snapshot enum-drift failures** — 16 failing tests at handoff; resolved cleanly at tag (W10 confirmed). Archival only.
2. **`measurements-batch-delete` duplicate-seed constraint** — resolved in W10 Reconcile-C alongside H-1 batch-ingest race fix.
3. **W8b conflict-resolution verification** — `commit 98f7d11` took `--ours` for 7 files; all four W8b admin bug fixes verified intact at tag time per `.planning/research/w10-product-lead-assessment.md` §B.

All v1.4.25 carry-overs closed. No active risks deferred.

---

## Resolved by v1.4.26 (post-tag hotfixes shipped on develop)

### Withings 403 scope-skip — `syncUserActivity` + `syncUserSleep` (2026-05-14)
W17b/c shipped without a scope guard on the new Activity + Sleep v2
calls. Legacy v1.4.24- connections hold `user.metrics` only, so every
cron tick produced a guaranteed 403 that the catch-block classified as
`transient` — pg-boss retried, the 3-strike persistent-failure alert
paged Telegram for every affected user. Fixed in `src/lib/withings/
sync-activity.ts` + `sync-sleep.ts`: read `WithingsConnection.scope` on
entry, call `hasActivityScope`, park at `error_reauth` on miss with
`errorCode: "scope_missing"` and return 0. Defence-in-depth: a 403
reaching the catch-block now classifies as `reauth_required` instead of
`transient`. +8 unit tests across the two test files. Source: Marc
production alarm 2026-05-14.

---

## Items the v1.4.25 marathon EXPLICITLY rejected (do not re-litigate)

- **MCP-Server** — Marc-vetoed: HealthLog ist consumer-PWA, nicht dev-platform.
- **XML-Import** — Marc-vetoed: iOS-app ist primary funnel, Web-PWA langfristig raus.
- **`WORKOUT_ROUTE` MeasurementType sentinel** — W8d orchestrator decision: workouts own a table; reserving a dead enum slot loses forward-compat with zero gain. Source: `.planning/phase-W8d-v1425-ah-server-prep-report.md` §"Orchestrator decisions restated".
- **Preemptive workout canonical-picker** — W10 Reconcile-B Sr-M-3 picked TODO route over extending `pickCanonicalSourceRows` to workouts. No iOS client, no detection worker. Re-surfaces only when observable dupes drive it (captured as P2-3).
- **Coach prompt rewrite into native FR/ES/IT/PL bodies during v1.4.25** — W9e scope-cut. Rewriting four ~500-line system prompts requires re-validating safety contracts against four prose bodies. Captured as P0-3.
- **`Co-Authored-By: Claude` trailer on commits** — Marc-Voice directive ab v1.4.25. Permanent.

---

## Source-attribution flags

- **P6-11 (Mood verbal labels)** — surfaced in v1.4.25 handoff §2 W11 "Refactor" CHANGELOG bullet ("mood verbal labels, ...") but no dedicated W*-report covers it standalone. Likely a polish item rolled into a larger commit.
- **`.planning/research/glp1-feature-inspiration.md`** — does NOT exist at draft time. P5 is placeholder pending Marc commissioning.
