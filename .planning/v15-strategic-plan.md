---
file: .planning/v15-strategic-plan.md
purpose: Unified v1.5 strategic plan — last web patches, iOS sprint shape, post-v1.5 defers
created: 2026-05-16
contributor: synthesizer
sources: 6 R-A through R-F research outputs + v1429-backlog + iOS handoff pack
---

# v1.5 Strategic Plan

## 1. Executive summary

### Product-Lead view

The maintainer asked for three things: a clean closure of the v1.4
line on the web, a focused iOS sprint that ships v1.5 as a real
release rather than a v0.4.x iOS build with a marketing label, and an
Apple-Health-depth story that says yes to workouts and breadth without
chasing reproductive-cycle or nutrition tracking. The recommendation
is to ship **v1.4.29 as a tight one-day patch** that closes the four
critical and high findings from the dashboard audit plus the mobile
tile equal-height and the settings drag-list compactness, **skip
v1.4.30**, freeze the web after v1.4.29, and run a **10 working day
iOS sprint** that pairs every HealthKit read with a visible iOS
surface so App Store review never sees an authorised-but-invisible
type. The differentiator stays the Coach drawer; workouts are the
single largest perceived-value-per-LOC add; the rest of Tier 1 is the
breadth play that lets the iOS app finally show the ten metrics it
already reads.

### Senior-Dev view

Architectural posture is conservative. After v1.4.29 the web app
freezes — only security patches, dependency updates, and the additive
iOS-server-prep changes the sprint requires (two Prisma columns, two
new bulk endpoints, one sync-state endpoint, two new MeasurementType
enum entries, one new MoodEntry column) are allowed. No new web
features, no UI rewrites, no non-additive schema changes. The
locked-contracts file at `.planning/v15-ios-handoff/08-locked-contracts.md`
holds. Nothing in the proposed scope flags as breaking. The largest
single risk is the v1.4.29 P0 `aggregate=daily` regression on
`/api/measurements` — it 500s in production today and the v1.4.28
suite mocked `prisma.$queryRaw` past the bug. Fixing C2 before wiring
C3 is the only correct sequence; both ride in v1.4.29 in that order.

### iOS-Dev view

10 working days + a 3-5 day Apple-review buffer. The iOS repo is
further along than the handoff pack assumed (28 finds in R-E, 5
critical, but the Coach drawer is the only Critical that is "no
native code at all" — the rest are gaps to close, not greenfield
work). Day 1-2 server prep blocks everything; Day 3-5 splits into
three parallel tracks (Coach SSE drawer, SyncMode + Workouts iOS
ingest, daily-stats service for cumulative types); Day 6-8 closes
breadth; Day 9-10 polish and Apple-review prep. **Key risk**: App
Store rejection if a HealthKit type is authorised but the app has no
visible surface (R-F §2.5). **Locked decision**: every HK read pairs
with a surface in the same track. Without the Coach drawer native
build, v1.5 is materially v0.4.2 iOS.

---

## 2. Last web patches

### v1.4.29 — Single-day patch (target: within one week)

Tight scope drawn from R-B, R-C, R-D, and R-A finding 2. Every item
is web-only and either iOS-additive or iOS-neutral.

| ID | Source | Description | Effort | Sequence |
|---|---|---|---|---|
| C2 | R-B Critical | P0 regression: `aggregate=daily` on `/api/measurements` returns 500 in production. `${truncUnit}` passed as a bound parameter to `date_trunc` — Postgres rejects. Tests passed only because `prisma.$queryRaw` was mocked. Fix with `Prisma.sql` interpolation for the grain literal; add a real-Postgres integration test using the existing `src/lib/db/__tests__` container fixture. | S | First |
| AVG/SUM | R-A finding 2 | `aggregate=daily` averages step counts instead of summing for cumulative types. Wrong today on `ACTIVITY_STEPS`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`, `WALKING_RUNNING_DISTANCE`, `TIME_IN_DAYLIGHT`. Switch the SQL from `AVG(value)` to `SUM(value)` when the type is in a new `CUMULATIVE_HK_TYPES` set. | XS | Rides with C2 |
| C3 | R-B Critical (blocked on C2) | Pulse chart aggregate-daily wiring. Have `<HealthChart>` pass `aggregate=daily` for every window longer than 7 days. Caps client payload at ~365 daily rows for pulse instead of the current ~5000-row ceiling. Drops Recharts paint cost ~50× on high-density accounts. | S | After C2 lands |
| C4 | R-B Critical | `useChartOverlayPrefs` cache-key collision. Hook reads `/api/dashboard/widgets` under `["dashboard-layout"]` while the rest of the codebase uses `queryKeys.dashboardWidgets()` → `["user", "dashboardWidgets"]`. Two cache slots, one endpoint, one duplicate request per dashboard mount. 4 LOC. | XS | Parallel |
| Mobile tile equal-height | R-C | `--tile-h:140px` CSS custom property on the dashboard strip wrapper at `<sm`, `auto` from `sm:` upwards. Add `line-clamp-1 min-h-[18px]` on the comparison-delta callout. Switch sub-row pair to `flex-nowrap overflow-hidden` at `<sm`, releasing back to `flex-wrap` from `sm:` upwards. Files touched: `src/app/page.tsx`, `src/components/charts/trend-card.tsx`, one new snapshot test. | S | Parallel |
| Settings drag-list compactness | R-D | Replace the vertical 44+44 px arrow stack with a horizontal pair of 32 px buttons on desktop / 44 px buttons on mobile (`size-11 sm:size-9`). Row drops 116 px → 48 px. Add `truncate` on the label. One file (`src/components/settings/dashboard-layout-section.tsx`), ~30 LOC net. | S | Parallel |
| H2 | R-B High | Bound the `glucoseRows.findMany` to the last 30 days for the dashboard tile path. 1 LOC. | XS | Parallel |
| M1 | R-B High (cheap) | Bound the BP-in-target chunked walk to the last 365 days. 1 LOC. | XS | Parallel |
| M5 | R-B Medium (cheap) | Add `staleTime: 60_000` to the three inline dashboard `useQuery` blocks plus `refetchOnWindowFocus: false`. 3 × 5 LOC. | XS | Parallel |

**Total effort**: 1-2 days. All web-only. The C2 → AVG/SUM → C3
sequence is the only ordering constraint; everything else is
independently mergeable.

**iOS impact**: zero breaking, additive in spirit. The AVG/SUM fix
changes how aggregated cumulative rows present on the web reading
path; the iOS app calls a separate native path
(`HKStatisticsCollectionQuery` per R-A Option A) and does not depend
on the server's `aggregate=daily` SQL. The Prisma schema is
unchanged.

**Explicitly out of v1.4.29**: R-B's C1 (the `/api/analytics`
architectural rewrite — split into dashboard + insights surfaces,
move aggregation to SQL, rewrite `summarize()` for single-pass). 2-3
days plus integration tests. Lands during the v1.5 server-prep
window if calendar permits, otherwise rides to v1.5.x.

### v1.4.30 — Final web polish (skip recommendation)

Recommend **skip**. The R-A Option A web-side preparation folds into
v1.5's Day 1-2 server prep. The v1.4.29 deferrals in
`v1429-backlog.md` are design Mediums, UI-conformity Mediums, i18n
drift, and `<ResponsiveSheet>` migration carry-forwards — none are
blockers for v1.5 and none are visible to the iOS app. Carry them to
v1.5.x. Ship v1.4.30 only if the iOS sprint slips past Day 5 and a
quiet web release helps confidence; default is to tag v1.5 directly
after the sprint.

### Web-freeze posture

After v1.4.29 tags on `main`, the web app enters **freeze**.

Allowed during the v1.5 sprint:

- Security patches (CVE feeds, dependency vulnerabilities)
- Dependency updates that ride existing test infrastructure
- iOS-server-prep changes the sprint requires (additive endpoints +
  Prisma columns documented in §3 Day 1-2)
- Hotfix-only emergencies (the v1.4.28.1 dashboard-save pattern)

Not allowed during the v1.5 sprint:

- New web features
- UI rewrites or design refactors
- Schema changes that aren't additive
- The C1 architectural lift on `/api/analytics` unless it folds
  cleanly into the iOS-server prep

Document this posture in the v1.5 closure record. When the sprint
ends and v1.5 ships, the freeze ends — v1.5.x patches resume normal
web cadence.

---

## 3. v1.5 iOS sprint shape

10 working days. The day-by-day shape pulls from R-E §recommended
sprint length and R-F Tier 1 track structure, with R-F's "wave"
vocabulary kept in the table headers because the substring is
load-bearing on the source documents; substituting "track" or
"stream" in the prose preserves the maintainer's discipline.

### Day-by-day schedule

| Day | Track | Work | Output |
|---|---|---|---|
| 1 | Server | APNs `.p8` paste into Coolify (1-hour Marc-action per R-E C-3). Tag the v1.4.29 release on `main`. Verify Coolify auto-deploy. | APNs delivery confirmed live; v1.4.29 in production. |
| 1-2 | Server | SyncMode server-side per R-E C-2: `syncVersion Int @default(1)` on `Measurement`, `deletedAt DateTime?` soft-delete column, `/api/sync/state` endpoint, `/api/mood-entries/bulk` + `/api/medications/intake/bulk` bulk-backfill endpoints. | Prisma migration applied; endpoints live; OpenAPI regenerated. |
| 1-2 | Server | `MoodEntry.note TEXT NULL` per R-E H-5. Replaces the `tags: ["note:<text>"]` workaround that contaminates the Coach evidence shelf. | Server column live; iOS reads + writes can migrate in the iOS-side PR. |
| 1-2 | Server | `HKWorkoutType.workoutType()` API route per R-F T1.1. `/api/workouts/batch` exists in v1.4.25 W8d; verify caps and middleware match the pattern. `pickCanonicalWorkoutRows()` helper for cross-source dedup (Apple Watch + Withings ScanWatch overlap). | Workout ingest endpoint signed off; cross-source picker covers the v1.5.1 follow-up properly. |
| 1-2 | Server | Categorisation overlay per R-F §4.2: `src/lib/measurements/categories.ts` TypeScript map driving both the iOS permission picker and the web Insights nav. | Shared map landed; iOS Swift mirror builds from the same canonical list. |
| 1-2 | Server | Two new MeasurementType enum entries per R-F T1.4 + T1.5: `WALKING_STEADINESS`, `AUDIO_EXPOSURE_EVENT`. One-line migration each. | Enum extended; Zod validation regenerated. |
| 1-2 | Server | R-A Option A server-side: `dailyStatsExternalId()` helper + `CUMULATIVE_HK_TYPES` set in `src/lib/measurements/apple-health-mapping.ts`. Handoff doc updates: `.planning/v15-ios-handoff/06-ios-responsibilities.md` + `08-locked-contracts.md` lock the `externalId` shape `"stats:<typeIdentifier>:<YYYY-MM-DD>"`. | Server stops paying for per-sample step rows once iOS cuts over. |
| 3-5 | iOS Track A | Coach SSE drawer native build per R-E C-1. `CoachService` actor over `URLSession.bytes`, `CoachStreamEvent` AsyncThrowingStream, SwiftData-backed `CoachConversation` cache, streaming bubble view, provenance disclosure, GROUND-RULE-9/15 refusal-acceptance UI, `coach.budget.exceeded` 429 surface. Reuse the existing `MDRAcknowledgmentDialog`. Adds `coach.*` locale keys to `Localizable.xcstrings`. Wires `AppRouter` to a real `.coach` TabIdentifier. | TestFlight build runs Coach against staging end-to-end. |
| 3-5 | iOS Track B | SyncMode + Workouts ingest. Per R-E C-2: extend `@Model` types with `syncVersion + deletedAt`, gate every repository call behind `SyncModeStore.isPaired`, build the pair/unpair sheet. Per R-F T1.1 + R-E H-2: `HKWorkoutType.workoutType()` reader, `HKWorkoutRouteQuery` route streamer, `WorkoutBatchEntryDTO` mirror, `WorkoutsRepository`, dashboard "Recent workouts" tile. | Workouts flow from HK to dashboard; SyncMode honours pairing state across every repo path. |
| 3-5 | iOS Track C | R-A Option A iOS implementation per `HealthKitStatisticsService.swift` sketch. `HKStatisticsCollectionQuery` wrapper per cumulative type, per-day last-posted-value cache, PATCH-on-divergence path for late watch syncs, `ENABLE_DAILY_STATS` build flag (default OFF for first TestFlight, ON for cut-over build). | Steps + active energy + flights + distance + daylight ingest as one row per day per type; per-sample row pressure on `Measurement` drops 50-200× for those types. |
| 6 | iOS | R-E C-4 RefreshScheduler (proactive bearer refresh 5 min before expiry) + R-E C-5 source-priority editor (Settings → Sources & Geräte sheet, drag-reorder per metric, nested device-type picker, full-object PUT) + R-E H-7 Withings `hasActivityScope` reconnect banner. | Midnight-refresh 401 closed for real; iOS users can edit the two-axis source priority natively. |
| 6-7 | iOS | R-F T1.3 breadth wave: 10 chart cards for invisible-but-stored metrics — `restingHr`, `hrv`, `spo2`, `bodyTemperature`, `activeEnergy`, `flights`, `distance`, `audioExposureEnv`, `audioExposureHeadphone`, `daylight`. Each is a one-line `CHART_OVERLAY_KEYS` add server-side + a SwiftUI card mount on iOS. Pair every HK read with a visible surface per the Apple-review pairing rule. | iOS dashboard finally shows what it has been reading; App Store reviewer sees one visible surface per authorised type. |
| 7 | iOS | R-F T1.2 HKStateOfMind read path (iOS 18+) + R-F T1.4 hearing-event chips on `/insights/puls` + R-F T1.5 walking-steadiness gauge. | Mood bidirectional with Apple Health; loud-listening events surfaced; mobility signal visible. |
| 7-8 | iOS | R-E H-3 medication sub-routes (inventory, side-effects, phase-config) + R-E H-4 Coach prefs + Doctor Report prefs sheets + R-E H-6 cache-invalidation matrix + R-E H-8 OpenAPI codegen wiring (swift-openapi-generator in XcodeGen + CI). | Medication detail screen reaches feature parity with the server; LLM consent + tone settings native; OpenAPI drift caught at CI time. |
| 8 | iOS | Medium-severity sweep per R-E §Medium: M-1 enum extension (10 → 29 ServerMeasurementType + `.unknown(String)` fallthrough — solved cleanly by H-8 codegen), M-3 unit-test sentinel for the `OxygenSaturation` × 100 rule, M-7 timezone PUT on system tz change, M-8 `/api/insights/targets` Zielwerte screen, M-9 `glucoseContext` enum fix (`FASTING | POSTPRANDIAL | RANDOM | BEDTIME`). | iOS reads every server-emitted MeasurementType without 422; timezone follows the user across travel; Zielwerte page native. |
| 9 | iOS | Polish + a11y pass. Accessibility audit of the Coach drawer (VoiceOver reads streaming bubbles cleanly, provenance disclosure has the right rotor), every new chart card meets the 4.5:1 contrast minimum, every drag-handle has the 44-px tap target. App Store privacy disclosure form draft. App Store Connect submission form draft. Marketing copy + screenshots. | Submission package ready for review. |
| 10 | iOS + web | TestFlight upload. Light QA pass on web (only the iOS-coupled changes — Workouts API route, sync-state endpoint, bulk endpoints, MoodEntry.note migration, categorisation overlay parity, two new MeasurementType enum entries). Final iOS QA pass: the existing 3× iOS QA loop (`rshankras-testing` + `swiftui-pro` + manual) from the iOS repo README. | Build tagged `v1.5.0-rc.1` on iOS; server tagged `v1.5.0` on main. |
| +3 to +5 | — | Apple review buffer. 5.1.2(i) Third-Party-AI consent surface wired per `AIConsentStore.swift`. Privacy Policy URL + AppStore Connect "Regulated medical device" form. | TestFlight → App Store. |

### Track touch-disjointness

Day 3-5 runs three iOS tracks in parallel:

- Track A (Coach) — `Services/CoachService.swift`, `Stores/CoachStore.swift`, `Screens/Coach/*` (all new), plus an `AppRouter.swift` rewire.
- Track B (SyncMode + Workouts) — `@Model` additive columns, `Stores/SyncModeStore.swift`, every `Repositories/*Repository.swift` (gate behind `isPaired`), `Services/HealthKitService.swift` (add workout type), `Repositories/WorkoutsRepository.swift` (new).
- Track C (daily stats) — `Services/HealthKitStatisticsService.swift` (new), `Services/HealthKitService.swift` (skip cumulative types in `quantityEntry`), `Repositories/MeasurementBatchUploader.swift` (PATCH-on-divergence).

`HealthKitService.swift` is the one shared file. Merge order: Track C
carve-out first, Track B workout reader second, Track A skips it.

### Apple-review pairing rule

Locked per R-F §2.5 and R-F open question #3: **every HK read pairs
with an iOS surface in the same track**. No authorised-but-invisible
reads. Concretely:

- 18 quantity types in `defaultReadTypes` today: 8 already have a
  surface (BP × 2, Pulse, Weight, BodyFat, Sleep, Steps, BG). The 10
  remaining (RestingHR, HRV, SpO2, BodyTemp, ActiveEnergy,
  FlightsClimbed, Distance, AudioEnv, AudioHeadphone, Daylight) get
  cards in the R-F T1.3 breadth wave on Day 6-7.
- The 2 new types this sprint (`WALKING_STEADINESS`,
  `AUDIO_EXPOSURE_EVENT`) get their surfaces in the same Day 7 work
  that adds the reads.
- HKStateOfMind read surfaces via the existing `/insights/stimmung`
  page picking up the new APPLE_HEALTH-sourced mood entries.
- Workouts get the new dashboard tile on Day 3-5 in Track B.

Fallback if Day 9 finds an authorised type with no surface: drop the
type from `defaultReadTypes` and re-request on-demand when the user
navigates to a feature that needs it (R-F §2.5 option 2).

### Risks documented

- **R-F top open question locked**: every HK read pairs with an iOS
  surface. No authorised-but-invisible.
- **APNs `.p8` paste-in** (R-E C-3): 1-hour Marc-action on Day 1.
  Only external blocker.
- **Web freeze starts** at v1.4.29 tag. Emergency-fix procedure:
  hotfix branches off `main`, ride v1.4.29.x patch tags; no feature
  work touches develop during the iOS sprint.
- **Day 3-5 parallel-track friction**: `HealthKitService.swift` is
  the shared file; merge order is Track C → Track B → Track A on
  that file specifically.
- **Apple-review surprise** budget: 3-5 days. The 5.1.2(i)
  Third-Party-AI Consent surface, the Privacy Policy URL, the
  Regulated-medical-device form — all need user-side completion.

### Volume estimates

- iOS-engineer-days: ~21 (3 tracks × Day 3-5 = 9 parallel days; Day
  6-10 sequential single-track = 5 days; Apple-review-buffer polish
  carries 2 iOS QA days inside the +3 to +5 buffer; total ~21).
- Server-engineer-days: ~4-5 across Day 1-2 (prep menu), Day 6
  (server-side help for the source-priority editor's full-object
  PUT), Day 7-8 (codegen wiring + OpenAPI regeneration cycle).

---

## 4. Defers (post-v1.5)

### v1.5.x follow-up patches

| Source | Item | Why deferred |
|---|---|---|
| R-F T2.1 | Running + cycling power metrics (iOS 16+) — per-workout HR-zone breakdown via `Workout.metadata` JSONB | Tier 2; athletes-only audience for v1.5.x |
| R-F T2.2 | Workout-effort score (iOS 18) — `HKQuantityTypeIdentifierEstimatedWorkoutEffortScore` | Tier 2; rides Workout.metadata blob |
| R-F T2.3 | Sleep apnea breathing disturbances (iOS 18 / watchOS 11) | Tier 2; one new MeasurementType (`BREATHING_DISTURBANCES`) |
| R-F T2.4 | Mindful sessions (`HKCategoryTypeIdentifierMindfulSession`) | Tier 2; one new MeasurementType (`MINDFUL_MINUTES`) |
| R-F T2.5 | Six-minute walk distance | Tier 2; narrow clinical audience |
| R-F T2.6 | Heart-rate recovery one-minute (per-workout metric) | Tier 2; rides Workout.metadata |
| R-E M-2 | The seven new v1.4.25 MeasurementTypes in the HK wire-converter unit-map (covered by codegen H-8) | Solved cleanly by OpenAPI codegen landing on Day 7-8 |
| R-E M-4, M-5 | iPad → phone deviceType doc note + `kindDisplayName` extension | Doc-only / low maintenance |
| R-E L-1 through L-6 | Foot-guns and defensive guards | Low |
| R-B C1 | `/api/analytics` architectural split into dashboard + insights surfaces, SQL-side aggregation, single-pass `summarize()` | Lands in v1.5.x if not folded into Day 1-2 server prep |
| R-B H3 | Server-rendered auth seed (one-round-trip first-paint waterfall) | M-effort root-layout change, touches the auth flow |
| R-B M3 | Covering index `(userId, measuredAt) INCLUDE (type, value, source)` | Needs `EXPLAIN ANALYZE` against production-scale data first |
| R-B L2 | Viewport-gated below-the-fold chart mounts | UX call on the fold boundary per breakpoint |
| v1429-backlog | Design Mediums (D-M1 through D-M9), UI-conformity Mediums (UI-M1 through UI-M4), Simplifier Mediums (S-M1 through S-M5), i18n Mediums | Carried forward from v1.4.28; not iOS-blockers |

### v1.6 (post-iOS-launch)

| Source | Item | Why v1.6 |
|---|---|---|
| R-F T3 | HKClinicalRecord (FHIR) — Epic / Cerner lab results | US-market value, large compliance scope |
| R-F T3 | HKElectrocardiogramType (ECG waveforms) | Multi-channel time series; not a Measurement row |
| R-F T3 | Atrial-fibrillation burden, peripheral perfusion index | Clinical-decision-support architecture review needed |
| R-F T3 | Scored assessments (PHQ-9, GAD-7) | Clinical territory; deliberate hold |
| R-F T3 | Reproductive / cycle / pregnancy | Marc directive: do not chase |
| R-F T3 | Nutrition (`DietaryWater`, `DietaryEnergyConsumed`) | Marc directive: indefinite hold |
| R-F T3 | UV exposure, electrodermal activity, blood-alcohol | Niche |
| R-F T3 | Audiogram clinical waveform | Defers with ECG bucket |
| R-F T3 | Apple Watch independent app | Separate Xcode target; iOS app first |
| R-F open Q #7 | Apple Health XML import (`export.zip` ingest) | Highest-leverage non-iOS-app deliverable but outside v1.5 brief |
| R-A generalisation | Per-hour drill-in for cumulative types (read-only HK query, no persistence) | Apple's Health app does not show this beyond per-hour ring either |
| R-A compaction | One-time script to collapse pre-Option-A per-sample APPLE_HEALTH cumulative rows into daily rows | Optional; idempotent re-run is a no-op |

---

## 5. Decision log

| Decision | Choice | Source |
|---|---|---|
| Step aggregation shape | Option A — iOS pre-aggregates daily via `HKStatisticsCollectionQuery` | R-A §5 |
| `externalId` shape for cumulative types | `"stats:<typeIdentifier>:<YYYY-MM-DD>"`, locked in `08-locked-contracts.md` | R-A §6 |
| Late-watch-sync divergence handling | iOS keeps per-day last-posted-value cache + PATCH on divergence | R-A §5 |
| Tile equal-height contract | `--tile-h:140px` CSS custom property at `<sm`, `auto` from `sm:` upwards | R-C §6 |
| Comparison-delta callout policy at `<sm` | `line-clamp-1 min-h-[18px]` | R-C §6.2 |
| Sub-row wrap policy at `<sm` | `flex-nowrap overflow-hidden` (clip, not wrap), releases to `flex-wrap` from `sm:` upwards | R-C §6.3 |
| Settings drag-list row height target | 48 px (`min-h-12`), down from 116 px | R-D §4 |
| Settings drag-list button shape | Horizontal pair, `size-11` on mobile (preserves 44-px tap target) + `sm:size-9` on desktop | R-D §5 |
| HealthKit coverage scope for v1.5 | Tier 1 (18 existing + Workouts E2E + HKStateOfMind read + hearing chips + walking-steadiness) | R-F §3 |
| HealthKit coverage scope for v1.5.x | Tier 2 (running/cycling power, effort score, sleep apnea, mindful sessions, 6-min walk, HR recovery) | R-F §3 |
| HealthKit coverage scope deferred to v1.6 | Tier 3 (FHIR, ECG, AFib, PHQ-9/GAD-7, reproductive, nutrition, Watch app) | R-F §3 |
| iOS HK reads pairing rule | Every read paired with a visible surface in the same track — no authorised-but-invisible | R-F §2.5 + open Q #3 |
| Categorisation shape | UI-side TypeScript overlay `src/lib/measurements/categories.ts`, NOT a DB column | R-F §4 |
| Sleep storage shape | Per-stage rows (5-axis unique key) — no split into `SLEEP_DEEP` / `SLEEP_REM` / etc. enum entries | R-F open Q #6 |
| Web freeze trigger | v1.4.29 tag on `main` | This plan §2 |
| v1.4.30 ship-or-skip | Skip; tag v1.5 directly after the sprint | This plan §2 |
| AVG/SUM cumulative-type fix | Rides v1.4.29 | R-A §6 + R-B C2 sequence |
| C2 P0 sequencing | Lands before any client wires `aggregate=daily` | R-B Critical |
| iOS workout dedup ladder | Ship `pickCanonicalWorkoutRows()` with the existing measurement ladder (Apple ≻ Withings ≻ Manual); tune metric-aware (route → Apple wins; HR zones → Withings wins) in a v1.5.x follow-up | R-F open Q #4 |
| HKStateOfMind round-trip filter | Bake the `HKMetadataKeyExternalUUID` write-back filter into the read path from day one — same pattern as the existing quantity-sample filter | R-F open Q #5 |
| iOS workout reader scope | Read-only ingest for v1.5; the iOS Workout UI defers to v1.6 (R-E H-2 close-out) | R-E H-2 |
| iOS write-back to HealthKit | Read-only on every type except weight, BP, glucose, mood/state-of-mind (existing `defaultWriteTypes`) | R-F §2.3 |

All schema additions in §3 are flagged **additive**. No breaking
changes. Nothing in this plan flags as breaking.

---

## 6. Open questions for the maintainer

1. **One pass through this plan for sharpening.** Anywhere the
   sequencing reads wrong, anywhere the deferral feels too generous,
   anywhere the iOS-day estimate looks aspirational. The plan is
   built to fit a 10-day sprint and the calendar assumes clean
   parallel dispatch on Day 3-5; if either assumption needs softening
   the calendar shifts by 1-3 days.

2. **Whether to ship v1.4.30 at all.** Default recommendation is
   skip — fold the R-A Option A server prep into v1.5's Day 1-2.
   Counterargument: a quiet v1.4.30 with the R-A web-side helpers +
   the C1 `/api/analytics` rewrite would let the iOS sprint start
   with a clean web baseline. The tradeoff is one week of additional
   calendar before the iOS sprint clock starts versus a smaller
   v1.5 server-prep day.

3. **Whether to drop unused HK reads instead of adding cards.** R-F
   §2.5 calls out the App Store reviewer risk for authorised-but-
   invisible types. The proposed plan (R-F T1.3 chart-card breadth)
   is the higher-perceived-value path; the alternative (trim
   `defaultReadTypes` to the visibly-used subset) is the lower-risk
   path. If the calendar tightens, the trim is the fallback.

4. **Whether to defer C-4 RefreshScheduler to v1.5.1.** R-E flags
   this as Critical (midnight-401 bug). The mitigation (the existing
   401-bridge in `APIClient.swift:135-158`) is reactive but works.
   If the Day 6 schedule slips, deferring the proactive scheduler
   to v1.5.1 is survivable.

5. **Whether the Apple-Health-XML import (`export.zip`) belongs in
   v1.5.** R-F §2.6 and open Q #7. Out of the original brief, but the
   highest-leverage non-iOS-app deliverable in the broader research.
   A web-only user can upload years of HK history before the iOS app
   ships on their device. ~200 LOC server-side, reuses the existing
   batch endpoint. Lift into v1.5 if the calendar permits; defer to
   v1.6 if not.

---

## Word count

~3 050 words (target was 2 500-4 000).
