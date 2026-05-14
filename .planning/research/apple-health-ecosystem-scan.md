# Apple Health Ecosystem Scan — v1.4.25 Research

**Scope:** GitHub topic `apple-health` (https://github.com/topics/apple-health), top 30 by stars + recently-updated long tail. Sister scan of `the-momentum/open-wearables` runs in parallel — this report deliberately covers the broader ecosystem instead.
**Date:** 2026-05-14
**Author:** Research agent for Marc Bombeck / HealthLog v1.5 pre-iOS planning

---

## Section 1 — Ecosystem inventory

Enumerated via `gh api search/repositories q='topic:apple-health' sort=stars`. Top 30 sorted desc; tail truncated as "templates / one-off scripts / abandoned forks" — see end of section.

| # | Repo | Stars | Last push | License | Tech | One-line summary |
|---|------|-------|-----------|---------|------|------------------|
| 1 | [StanfordBDHG/HealthGPT](https://github.com/StanfordBDHG/HealthGPT) | 1944 | 2026-03 | MIT | Swift / Spezi | Chat-with-your-Apple-Health iOS app; OpenAI + local Llama3 + fog-node options |
| 2 | [the-momentum/open-wearables](https://github.com/the-momentum/open-wearables) | 1665 | 2026-05 | MIT | Python / FastMCP | Self-hosted unified wearable platform with MCP server (covered by sister agent) |
| 3 | [agencyenterprise/react-native-health](https://github.com/agencyenterprise/react-native-health) | 1139 | RN bridge | MIT | Obj-C / RN | Mature React Native HealthKit bindings |
| 4 | [markwk/qs_ledger](https://github.com/markwk/qs_ledger) | 1058 | 2022-08 | MIT | Jupyter | Quantified-Self downloader hub (Fitbit, Oura, Strava, AH, …) — last commit 2022 |
| 5 | [k0rventen/apple-health-grafana](https://github.com/k0rventen/apple-health-grafana) | 570 | 2026-04 | none | Python / Grafana | Import `export.zip` → InfluxDB → Grafana dashboards (fitness + sleep + GPS routes) |
| 6 | [kingstinct/react-native-healthkit](https://github.com/kingstinct/react-native-healthkit) | 663 | active | MIT | TS / Swift | Modern Nitro-based RN HealthKit (incl. CDA + FHIR clinical records) |
| 7 | [lucaspbordignon/rn-apple-healthkit](https://github.com/lucaspbordignon/rn-apple-healthkit) | 526 | older | MIT | Obj-C | Earlier RN bridge — superseded by kingstinct |
| 8 | [OvalMoney/react-native-fitness](https://github.com/OvalMoney/react-native-fitness) | 361 | 2022-01 | MIT | Java/Obj-C | AH + Google Fit RN module — abandoned |
| 9 | [wangyanchang21/Watch-App-Sampler](https://github.com/wangyanchang21/Watch-App-Sampler) | 286 | older | MIT | Swift | watchOS sample-app tutorials |
| 10 | [dogsheep/healthkit-to-sqlite](https://github.com/dogsheep/healthkit-to-sqlite) | 244 | older | Apache-2.0 | Python | Simon Willison's `export.zip → sqlite` CLI (Datasette explorer) |
| 11 | [DanielJamesTronca/SleepChartKit](https://github.com/DanielJamesTronca/SleepChartKit) | 232 | 2025-10 | MIT | SwiftUI | Pixel-perfect SwiftUI Apple-style sleep stage chart (timeline + circular) |
| 12 | [Lybron/health-auto-export](https://github.com/Lybron/health-auto-export) | 227 | 2026-01 | none | docs only | Premium iOS app docs — JSON / CSV / GPX export to REST / MQTT / Dropbox / iCloud |
| 13 | [the-momentum/apple-health-mcp-server](https://github.com/the-momentum/apple-health-mcp-server) | 188 | 2026-02 | MIT | Python | MCP server with DuckDB / Elasticsearch / ClickHouse backends (predecessor of open-wearables) |
| 14 | [AnthonyH93/GoCycling](https://github.com/AnthonyH93/GoCycling) | 188 | older | MIT | SwiftUI | SwiftUI cycling tracker with Core Location + CloudKit |
| 15 | [CardinalKit/CardinalKit](https://github.com/CardinalKit/CardinalKit) | 178 | planning 2.0 | MIT | Swift | Stanford research-grade framework (ResearchKit + CareKit + Firebase) |
| 16 | [apoorvdarshan/fud-ai](https://github.com/apoorvdarshan/fud-ai) | 173 | active | MIT | Kotlin | AI calorie tracker — explicitly out of scope for HL |
| 17 | [James-2879/OuraAppleHealth](https://github.com/James-2879/OuraAppleHealth) | 147 | 2025-04 | none | Shortcuts | Oura → AH via Apple Shortcuts (no app) |
| 18 | [HealthyApps/health-auto-export-server](https://github.com/HealthyApps/health-auto-export-server) | 134 | active | none | TS / Mongo / Grafana | The Health Auto Export companion Node server + Grafana board |
| 19 | [kilohealth/rn-fitness-tracker](https://github.com/kilohealth/rn-fitness-tracker) | 125 | older | MIT | TS / RN | RN AH + Google Fit minimal |
| 20 | [atlaslib/atlas](https://github.com/atlaslib/atlas) | 117 | 2024-05 | Apache-2.0 | Python / DuckDB | `export.xml → parquet` + ClickHouse exploration |
| 21 | [brittanyarima/Steps](https://github.com/brittanyarima/Steps) | 106 | older | MIT | SwiftUI | Single-purpose pedometer demo |
| 22 | [irvinlim/apple-health-ingester](https://github.com/irvinlim/apple-health-ingester) | 105 | 2025-08 | MIT | Go | HTTP receiver for Health-Auto-Export → InfluxDB / file |
| 23 | [kvs-coder/HealthKitReporter](https://github.com/kvs-coder/HealthKitReporter) | 89 | 2024-12 | MIT | Swift | Pure-Swift HealthKit wrapper for read/write |
| 24 | [shubhamsinghshubham777/KHealth](https://github.com/shubhamsinghshubham777/KHealth) | 87 | active | Apache-2.0 | Kotlin MP | Kotlin Multiplatform AH + Health-Connect |
| 25 | [vitoksmile/HealthKMP](https://github.com/vitoksmile/HealthKMP) | 86 | active | Apache-2.0 | Kotlin MP | Same idea, watchOS support added |
| 26 | [alxdrcirilo/apple-health-parser](https://github.com/alxdrcirilo/apple-health-parser) | 84 | 2026-05 | MIT | Python / Pydantic | Modern Python XML parser with Pydantic validation + Plotly |
| 27 | [roznet/connectstats](https://github.com/roznet/connectstats) | 81 | active | MIT | Obj-C | Strava/Garmin analysis app for iOS |
| 28 | [aminbenarieb/healthkit-data-generator](https://github.com/aminbenarieb/healthkit-data-generator) | 73 | 2026-04 | MIT | Swift / SPM | Realistic HK sample generator incl. LLM "marathon training" prompts |
| 29 | [BRO3886/healthsync](https://github.com/BRO3886/healthsync) | 56 | 2026-04 | MIT | Go / SQLite | `export.zip → SQLite` CLI + HTTP server + Claude-Code skill installer |
| 30 | [leecdiang/Apple-Health-Pro](https://github.com/leecdiang/Apple-Health-Pro) | 54 | 2026-05 | MIT | Python | XML/ZIP → organised CSV for AI analysis |

**Long tail truncated:** Below 50 stars the topic skews to: one-off Shortcuts collections (`phautamaki/TheQuantifyingStack`, `WesleySmits/project-manager-bot`), abandoned 2020-era notebooks (`artxgj/apple_health`, `DavidMetcalfe/Google-Fit-consolidate-data-export`), per-device shims (`skoal/mi-scale-shelly-ha`), and personal "I parsed my export" Streamlit demos (`Thijsn04/AppleHealthDashboard`, `coleyrockin/POWO`, `tangka/apple-watch`). Two are recent and worth noting as direct competitors: **`umutkeltek/health-data-hub`** (TimescaleDB + Grafana + local Ollama briefing — covered in §3) and **`vanities/docvault`** (kitchen-sink finance+health workspace — out of scope).

Notable absences/searches that returned nothing useful: `mwaterfall/apple-health-data-parser` (called out by name but not in the topic — likely renamed/archived), `andreaazzini/apple-health-parser` (does not exist in the topic), `cetbal/apple-health` (does not exist).

---

## Section 2 — Patterns we hadn't named

Recurring across multiple high-star projects but not yet on HealthLog's roadmap:

1. **Apple Health XML one-shot import.** *Every* serious project in the topic accepts an `export.zip` as the primary onboarding path: `dogsheep/healthkit-to-sqlite` (https://github.com/dogsheep/healthkit-to-sqlite), `k0rventen/apple-health-grafana` (https://github.com/k0rventen/apple-health-grafana), `alxdrcirilo/apple-health-parser` (https://github.com/alxdrcirilo/apple-health-parser), `BRO3886/healthsync` (https://github.com/BRO3886/healthsync), `atlaslib/atlas`, `the-momentum/apple-health-mcp-server`. Even users without a native iOS app expect to seed years of data day-one. The `export.zip` is the universal AH currency.

2. **Workout Routes (GPX with HR overlay).** `k0rventen/apple-health-grafana` ships a dedicated dashboard plotting GPS routes against heart-rate; `connectstats` does the same. The XML export includes `<WorkoutRoute>` with GPX. HealthLog has no GPS/route concept yet — this is a free feature once the importer parses workouts.

3. **Time-in-zone heart-rate analytics.** Strong runner audience: HR zones (Z1–Z5) with weekly time accumulation per zone, recovery-HR-1-minute (`HeartRateRecoveryOneMinute` is a real type — visible in atlas's column dump), VO2-Max trajectory + Apple's "fitness age". Atlas shows `VO2Max` and `RunningPower`/`RunningGroundContactTime`/`RunningStrideLength`/`RunningVerticalOscillation` are first-class HK types we don't model.

4. **HRV trend + anomaly detection against rolling baseline.** `umutkeltek/health-data-hub` (https://github.com/umutkeltek/health-data-hub) has the cleanest take: deterministic statistical engine flags 3-day HRV declines, then a small LLM rewrites findings as narrative. This is structurally identical to HealthLog's Coach but more disciplined ("two-brain system" — math stays auditable, LLM only handles prose). Worth mirroring.

5. **AutoSleep-style sleep-debt scoring.** `markwk/qs_ledger`'s `autosleep` notebook shows rolling 7-day deficits against an 8-hour target. HealthLog ships sleep stages (v1.4.x) but no sleep-debt / consistency score.

6. **Audio-exposure + hearing health.** `EnvironmentalAudioExposure` and `HeadphoneAudioExposure` appear in every export dump (atlas, healthsync, parser). Apple itself surfaces this prominently; multiple projects chart it. HealthLog ignores it.

7. **Time-in-daylight.** `TimeInDaylight` (recently added HK type) shows up in every modern export. Health benefit literature has it strongly correlated to mood/sleep — fits the "differentiator AI Insights" angle.

8. **Mindfulness sessions (`MindfulSession`).** Category type. `qs_ledger` and `kingstinct` both surface it. HealthLog has mood + side-effects but no meditation log.

9. **Menstrual / cycle tracking.** Health Auto Export lists it as a top-level category. We explicitly don't track this; the ecosystem assumes it ships. **Recommendation: stay opted-out** (Marc explicit; do not chase scope creep).

10. **Hydration logging.** `DietaryWater` is in HK. Every full-fledged importer maps it. We don't.

11. **State of Mind.** Apple's new iOS 17+ category. Health Auto Export ships it; `kingstinct/react-native-healthkit` exposes 63 category types including this. Our `mood` model is roughly compatible — read AH State-of-Mind on import.

12. **ECG export.** AH exports actual ECG waveforms (`electrocardiograms/` folder of CSVs inside `export.zip`). Health Auto Export, atlas, and healthsync all surface this. HealthLog has no ECG model.

13. **Apple Watch independence.** Modern Watch apps run without iPhone. Worth noting because v1.5 plan is iOS only — if Marc wants Apple Watch glance widgets, that's a separate target.

14. **Multi-source priority dedup.** Several projects mention "AH may contain the same step count from iPhone + Watch + 3rd-party app" — we already solved this in v1.4.25 with source-priority architecture, but the rest of the ecosystem mostly punts (Health Auto Export documents it; nobody automates it).

15. **HKAnchoredObjectQuery + HKObserverQuery background-task pattern.** `kingstinct/react-native-healthkit`, `HealthKitReporter`, and Spezi all expose anchored queries. This is the *only* correct way to do bidirectional sync without resending data. Marc's v1.5 iOS plan should mandate this pattern from day 1.

16. **FHIR / Clinical Records.** `kingstinct/react-native-healthkit` (https://github.com/kingstinct/react-native-healthkit) exposes `HKClinicalRecord` as FHIR JSON, and CardinalKit (https://github.com/CardinalKit/CardinalKit) is built around it. This is power-user territory — lab results from Epic/Cerner imported as FHIR. HealthLog could become genuinely interesting to US patients if it accepts `HKClinicalRecord` as a one-way ingest. Defer to v1.6.

17. **Symptoms tracking.** AH has `HKCategoryTypeIdentifier` for 30+ symptoms (fever, cough, fatigue, headache, ...). Atlas's column dump shows `Fatigue` as a real category. We have mood + side-effect tags — could unify under HK symptoms vocabulary for free.

18. **Daily-aggregate vs raw-sample mode.** Health Auto Export and irvinlim's ingester both default to aggregated daily JSON (smaller payloads, simpler dashboards). The high-star projects don't try to mirror every 30-second heart-rate sample. Sensible default for v1.5: aggregated daily, raw on demand.

---

## Section 3 — Direct competitors (self-hosted personal-health platforms)

| Project | Stars | What they have we don't | What we have they don't |
|---------|-------|-------------------------|-------------------------|
| **[umutkeltek/health-data-hub](https://github.com/umutkeltek/health-data-hub)** | 8 (very new, growing fast) | TimescaleDB hypertable for time-series; Ollama auto-detect by RAM+GPU; "two-brain" briefing architecture; matching iOS app `HealthSave` on App Store; pre-built Grafana dashboards; Garmin Connect importer | Multi-provider AI BYOK (not just Ollama); Withings + manual; doctor-report PDF; multi-user devices; AGPL; mood/symptoms vocabulary |
| **[the-momentum/open-wearables](https://github.com/the-momentum/open-wearables)** | 1665 | MCP server for Claude/Cursor; multi-wearable unification; companion iOS app for continuous sync; FastMCP; FHIR posture (Momentum is a HealthTech consultancy) | (Covered in sister scan) |
| **[k0rventen/apple-health-grafana](https://github.com/k0rventen/apple-health-grafana)** | 570 | Best-of-breed XML→Influx ingester (cited in 5+ other projects); workout-routes GPS dashboard; sleep-stages dashboard | This is a one-shot importer, not a platform — but their **XML parsing code is the field reference** |
| **[Lybron/health-auto-export](https://github.com/Lybron/health-auto-export) + [HealthyApps/health-auto-export-server](https://github.com/HealthyApps/health-auto-export-server)** | 227 + 134 | Mature iOS app (paid, ~7 yrs old); MQTT/HA/REST/Calendar/Shortcuts integrations; on-device TCP server; widgets; 150+ supported metrics; documented JSON schema (https://github.com/Lybron/health-auto-export/wiki/API-Export---JSON-Format) | Open source vs closed iOS app; AI Coach; doctor PDF |
| **[StanfordBDHG/HealthGPT](https://github.com/StanfordBDHG/HealthGPT)** | 1944 | Stanford BDHG academic credibility; on-device Llama3 inference; "fog-node" architecture (private LLM on local LAN box); TestFlight pipeline | Web PWA (not iOS only); BP/glucose/weight first-class; multi-provider AI; doctor-report; multi-language EN/DE |
| **[CardinalKit/CardinalKit](https://github.com/CardinalKit/CardinalKit)** | 178 | Full ResearchKit + CareKit; informed-consent flows; clinical-trial pedigree | (Different audience — they target IRB-approved studies) |
| **[BRO3886/healthsync](https://github.com/BRO3886/healthsync)** | 56 | "AI agent skill installer" pattern — single command teaches Claude Code/Codex CLI how to query your local SQLite; multipart HTTP upload endpoint | We are the cloud / app version of what they're a CLI for |

**Honest scoring.** None of these competes head-on with HealthLog as it ships today. HealthLog's unique combination is: web-first PWA + Withings + multi-provider AI BYOK + doctor PDF + AGPL + Docker single-command + EN/DE + medication side-effect tracking. The closest is `umutkeltek/health-data-hub` (Apple-Health-only, paired iOS app, Grafana-driven UX). Their advantage is the matching iOS app already shipping on the App Store — which is exactly what v1.5 will close.

---

## Section 4 — Tools we could integrate as one-shot importers

This is the highest-leverage finding. **Almost every iPhone user has years of Apple Health data sitting in `export.zip` that they'll never re-collect.** If HealthLog accepts that file at signup, every new user starts day-1 with a populated database.

**Format reminder:** the `export.zip` unzips to:
- `apple_health_export/export.xml` — ~95% of the payload, all quantitative samples
- `apple_health_export/export_cda.xml` — Clinical Document Architecture (clinical records)
- `apple_health_export/workout-routes/*.gpx` — GPS tracks
- `apple_health_export/electrocardiograms/*.csv` — ECG waveforms

**Parser candidates evaluated:**

| Lib | Lang | Pros | Cons |
|-----|------|------|------|
| **[alxdrcirilo/apple-health-parser](https://github.com/alxdrcirilo/apple-health-parser)** | Python | Active (May 2026); Pydantic models; matches HK identifiers; published to PyPI; MIT | Python (we're Node); README warns "not tested with iOS < 17" |
| **[dogsheep/healthkit-to-sqlite](https://github.com/dogsheep/healthkit-to-sqlite)** | Python | Simon Willison; battle-tested; Datasette ecosystem | Python; older codebase; SQLite-specific |
| **[fedecalendino/apple-health](https://github.com/fedecalendino/apple-health)** | Python | Clean object model (`HealthData.read(file, include_workouts=True, ...)`); selective flags speed reads | Python; less active |
| **[BRO3886/healthsync](https://github.com/BRO3886/healthsync)** | Go | Native binary; deduplicated daily aggregates; identifies XML inside ZIP by content (works for non-EN exports) | Go (extra runtime); SQLite-only |
| **[atlaslib/atlas](https://github.com/atlaslib/atlas)** | Python | `export.xml → parquet` (5-column normalized form); very fast on millions of rows | Python; column model so simple we'd need to enrich |
| **[k0rventen/apple-health-grafana ingester](https://github.com/k0rventen/apple-health-grafana/tree/main/ingester)** | Python | Reference XML parser — handles broken exports gracefully; sleep-stage handling | Python |
| **[AlekSi/applehealth](https://github.com/AlekSi/applehealth)** | Go | Pure Go module | Last commit 2023; lower coverage |
| **[leecdiang/Apple-Health-Pro](https://github.com/leecdiang/Apple-Health-Pro)** | Python | "Studio-grade" XML/ZIP extraction; organised CSVs by type | Python; CLI-only |

**Recommendation for v1.5 P2:**

HealthLog is a Node/TypeScript stack — adding a Python runtime for parsing is a packaging nightmare. **Two viable paths:**

1. **Run the importer in the iOS Swift client.** When the user signs in, the Swift app reads HealthKit directly via anchored queries (no XML needed). Backfill happens natively. This bypasses XML entirely and is the cleanest long-term architecture. → This is already implicit in the v1.5 plan.
2. **Add a TypeScript XML parser server-side for non-iOS-app users.** Use a stream parser like `sax` or `htmlparser2` over `export.xml`. Reference implementation: port the loop from `k0rventen/apple-health-grafana/ingester/ingester.py` to Node — ~200 lines. Run it as a worker job (the file is 100–500 MB uncompressed; can't block the request thread). Persist mapping `HKQuantityTypeIdentifier* → MeasurementType` in a single lookup table. Reuse the existing `POST /api/measurements/batch` for idempotent insert.

The second path is what unlocks **non-iPhone users importing their Android friend's converted history, the web-first user, the user who shares an iPhone**, etc. It's also the simpler v1.4.26 deliverable.

**Suggested mapping table (subset):** `HKQuantityTypeIdentifierStepCount → STEPS`; `BodyMass → WEIGHT`; `BloodPressureSystolic + BloodPressureDiastolic` (correlated, both inside a `<Correlation>` element) → `BLOOD_PRESSURE`; `BloodGlucose → GLUCOSE`; `HeartRate → HEART_RATE`; `HeartRateVariabilitySDNN → HRV`; `OxygenSaturation → SPO2`; `RestingHeartRate → RESTING_HR`; `VO2Max → VO2_MAX`; `SleepAnalysis → SLEEP` (with the AsleepDeep/Core/REM/Awake category mapping HealthLog already shipped); `MindfulSession`/`DietaryWater`/`AudioExposure*`/`TimeInDaylight` — file as v1.6.

---

## Section 5 — Visualization / UX patterns worth copying

1. **SleepChartKit's circular sleep ring** (https://github.com/DanielJamesTronca/SleepChartKit) — pixel-faithful clone of Apple Health's deep/core/REM/awake timeline + circular variant that fills clockwise to a configurable threshold (default 9h). **Status:** SPM package, MIT, iOS 15+. **For HealthLog:** the iOS Swift agent should adopt this verbatim for the Sleep detail screen — saves weeks of fiddling with Apple's exact gradient stops and corner radii. The library is small enough (single Swift file per chart) that we audit it once and embed.

2. **Apple-Health-Grafana panel taxonomy** (https://github.com/k0rventen/apple-health-grafana). Their four dashboards establish the right granularity: (a) "Everything" overview, (b) refined "Most-watched" subset, (c) workout routes (GPS), (d) sleep tracking. HealthLog Insights already roughly mirrors this; their **sleep panel** uses stacked-area per stage which is what Apple Health uses post-iOS 16 and what we should match.

3. **Atlas's parquet 5-column schema** (`type, start, end, created, value`) — radically simple and the right shape for time-series queries with DuckDB/Clickhouse. Our Prisma schema is richer (per-type tables), but for the new analytics worker we could materialise a flat `measurement_facts` view in this shape to feed fast aggregations.

4. **Two-brain Coach pattern from health-data-hub** (https://github.com/umutkeltek/health-data-hub#how-the-ai-analysis-works). Quoted directly from their README: *"Brain 1 - the statistical engine ... produces structured findings, not prose. Brain 2 - the narrative LLM ... sees flagged findings and turns them into prose."* HealthLog Coach already does most of this (Insights events → prompt → narrative), but their split is cleaner: rename and document the "findings" intermediate so it's clear the LLM never sees raw numbers without flags.

5. **Health Auto Export aggregation granularity selector** (seconds → yearly). Their UI lets the user pick the aggregation window. We should expose this in the iOS app + on the web Insights tab — currently HealthLog defaults to daily-or-weekly; explicit user control over the grain is a small change.

6. **HRV against rolling-30-day baseline.** `health-data-hub`'s anomaly detection uses a rolling-30-day mean+sd and flags z>2. We currently show absolute HRV; switching the headline number to **delta vs personal baseline** matches Whoop/Oura UX and is more actionable.

7. **Healthsync's --total flag** (https://github.com/BRO3886/healthsync) — deduplicated daily totals across sources. We already solved source-priority in v1.4.25; surfacing the deduped daily total as the headline figure (with raw sub-source breakdown one tap away) matches user expectation.

---

## Section 6 — Tooling for the v1.5 iOS work

| Need | Recommended dependency | Why |
|------|------------------------|-----|
| HealthKit read/write wrapper | **[kvs-coder/HealthKitReporter](https://github.com/kvs-coder/HealthKitReporter)** OR **Spezi's [SpeziHealthKit](https://github.com/StanfordSpezi/SpeziHealthKit)** | HealthKitReporter is leaner (89⭐, MIT, last update Dec 2024). SpeziHealthKit is heavier but maintained by Stanford and used by HealthGPT (1944⭐). If the iOS app stays small, prefer HealthKitReporter. If we ever add ResearchKit/CareKit, switch to Spezi. |
| Test fixtures (mock HK data) | **[aminbenarieb/healthkit-data-generator](https://github.com/aminbenarieb/healthkit-data-generator)** | SPM package, profile presets (sporty/balanced/stressed), date-range presets, LLM-prompted generation (`"Create 2 weeks of marathon training"`). Inspired by older `mseemann/healthkit-sample-generator`. Adopt for UI tests + screenshot CI. |
| Sleep visualization | **[DanielJamesTronca/SleepChartKit](https://github.com/DanielJamesTronca/SleepChartKit)** | See §5. |
| MCP-server-style local query (post-launch power-user feature) | **[the-momentum/apple-health-mcp-server](https://github.com/the-momentum/apple-health-mcp-server)** | Architecture reference, not a dependency. If we ever expose HealthLog data to user's Claude desktop, this is the model. |
| Anchored queries / observer queries / HKBackgroundDelivery | Apple's stock `HKAnchoredObjectQuery` + `HKObserverQuery` + `enableBackgroundDelivery` | Don't third-party this. Pattern: store the `anchor` per `HKSampleType` in Keychain; on background wake, fetch since-anchor → batch POST `/api/measurements/batch` → save new anchor. Same pattern is used by Health Auto Export, HealthGPT, and health-data-hub. |
| Multiplatform (if Android ever) | **[shubhamsinghshubham777/KHealth](https://github.com/shubhamsinghshubham777/KHealth)** or **[vitoksmile/HealthKMP](https://github.com/vitoksmile/HealthKMP)** | Both Kotlin Multiplatform wrappers covering AH + Health Connect. v1.6+ optionality. |

**HK Type catalogue we should authorise in the iOS app's `NSHealthShareUsageDescription` + first-run requestAuthorization:**

From `kingstinct/react-native-healthkit` README: 100+ quantity types, 63 category types, 75+ workout types. For HealthLog v1.5 first-run, request only what we already model + the v1.4.23 additions (HRV, VO2Max, RestingHR, SpO2, SleepAnalysis, BodyMass, BodyFatPercentage, BloodPressure, BloodGlucose, StepCount, ActiveEnergyBurned, HeartRate). Re-prompt later for new types — Apple supports incremental auth.

---

## Section 7 — Recommendations (three buckets)

### 🔴 Pull into v1.4.26 backlog NOW

1. **Apple Health XML import (web, server-side).** Highest user-value-per-LOC of anything in this scan. ~200 LOC streaming SAX parser in Node, reuse existing `POST /api/measurements/batch`. Day-1 onboarding for every iPhone user, even before iOS app ships. Reference parser: port `k0rventen/apple-health-grafana/ingester/ingester.py`.
2. **Add `Source = HEALTH_AUTO_EXPORT` to enum and a `POST /api/measurements/batch?source=hae` ingestion path.** Health Auto Export is the dominant 3rd-party export tool (~250k+ active users per their marketing) and emits a well-documented JSON schema (https://github.com/Lybron/health-auto-export/wiki/API-Export---JSON-Format). Cost: ~50 LOC + schema map. Reward: users without our iOS app (or while waiting for it) get sync via Health Auto Export → HealthLog REST. Marketing angle: "works with Health Auto Export today".
3. **Workout-routes ingestion (GPX).** GPX is in the `export.zip` already; if we're parsing XML, parse GPX too. Even without route maps in v1.4.26, persist routes so the iOS app shows them later.
4. **Audio-exposure + TimeInDaylight measurement types.** Low-cost additions; both appear in every real export; both have known mood/sleep correlations the Coach can use.
5. **State-of-Mind ingestion mapping.** AH iOS 17+ produces this; map to our `mood` model. Trivial.

### 🟡 Evaluate during v1.5 iOS work

1. **SleepChartKit** as the Sleep-detail-screen renderer (do not roll our own; this gets pixel-faithful Apple parity for free).
2. **healthkit-data-generator** for UI tests + screenshot CI.
3. **HealthKitReporter** for HK access in the iOS app.
4. **Anchored-query + observer-query pattern** — codify in Swift package internal to the iOS app; mirror Health Auto Export's TCP server pattern only if we want a local-network read API later.
5. **HRV anomaly detection against rolling baseline** (the `health-data-hub` two-brain split). Refactor the Coach pipeline so "findings" are an explicit JSON intermediate.
6. **AI-skill installer pattern** à la `BRO3886/healthsync skills install` — `healthlog skills install` could write a Claude-Code skill that knows our schema. Nerdy but resonates with the dev-power-user audience we already attract.
7. **ECG ingestion** — read CSVs from `export.zip/electrocardiograms/`; show waveform on doctor PDF.

### 🟢 v1.6+ or never

1. **FHIR / HKClinicalRecord ingestion** (lab results from Epic/Cerner via `kingstinct/react-native-healthkit` exposes; CardinalKit is the reference). Big user value for US patients; significant compliance scope.
2. **Apple Watch independent app** (glance widget for headline metric). Separate Xcode target.
3. **Kotlin Multiplatform / Health-Connect Android client.** Off-roadmap; mention only because two viable libs exist.
4. **MCP server for HealthLog.** Once data is in, exposing it to user's Claude/Cursor is a small project (FastMCP reference: `the-momentum/apple-health-mcp-server`).
5. **Workout-type-aware calorie estimation, VO2Max-derived fitness age, time-in-zone analytics, six-minute walk test, running-form metrics (vertical oscillation, ground contact time).** All available in HK; all niche. File as backlog ideas.
6. **Mindfulness / meditation session logging.** Small but unowned in our model.
7. **Hydration logging.** Skip until requested.
8. **Menstrual / cycle tracking.** Explicit hold per Marc.

---

## Section 8 — Anti-patterns observed

Things multiple projects do that HealthLog should explicitly NOT copy.

1. **Hardcoded English / US date formats.** `dogsheep/healthkit-to-sqlite`, `markwk/qs_ledger`, several Streamlit demos all assume `MM/DD/YYYY` and pounds/Fahrenheit. HealthLog's umlaut + EN/DE + metric-first stance is a moat — preserve it. (`BRO3886/healthsync` handles non-EN exports by identifying XML inside ZIP **by content** rather than filename — adopt that trick.)

2. **Telemetry baked into OSS code.** Several wrappers (e.g. some RN bridges) phone home with anonymized analytics. HealthLog AGPL + zero telemetry must remain a guarantee.

3. **"Self-hosted" framed but mandatory cloud dependencies.** `StanfordBDHG/HealthGPT` is upfront — *"Aggregated HealthKit data for the past 14 days will be uploaded to OpenAI"* — but several smaller projects bury cloud LLM dependencies in code. HealthLog's BYOK + local-Ollama support stays the headline.

4. **Closed-source premium features bolted onto an OSS shell.** `Lybron/health-auto-export` is the model — repo is "documentation only", actual app is App Store paid with subscription. Pricing tiers: Free / Basic (one-time) / Premium (subscription or lifetime). Effective business model, but not the AGPL pitch HealthLog leads with. Stay open.

5. **Single-vendor AI lock-in.** `aminbenarieb/healthkit-data-generator`'s LLM integration is Apple-Foundation-Model only; many others are OpenAI-only. HealthLog's multi-provider BYOK + Ollama is differentiating — don't regress.

6. **Calorie / macros nutrition tracking creep.** `apoorvdarshan/fud-ai` is full nutrition; Health Auto Export emits 30+ dietary types. Stay disciplined per Marc — *not chasing*. We can ingest `DietaryWater` and `DietaryCaffeine` for completeness without owning meal logging.

7. **Mandatory account / cloud sign-up framed as "free".** Several Streamlit demos require a Firebase or Supabase account. HealthLog's "single `docker compose up`, no account" stance is the right reaction.

8. **Abandoned forks listed as "supported".** `OvalMoney/react-native-fitness` (361⭐, last commit Jan 2022) is still cited in tutorials. Pin to the actively-maintained `kingstinct/react-native-healthkit` for any RN reference we publish.

9. **Hand-rolled chart components when Apple/Material/Recharts already nails it.** Several apps reinvent a sleep-stage chart badly. SleepChartKit (§5) is *the* reference; do not roll our own.

10. **PII / health figures in OSS marketing materials.** Many of these READMEs ship screenshots with real names, real HRV ms, real BP readings. HealthLog's no-PII policy (per memory `feedback_no_pii_in_user_facing.md`) is the right discipline.

11. **Premature multi-tenancy.** `umutkeltek/health-data-hub` notes multi-person households as a roadmap-not-yet item; HealthLog has multi-user devices but the single-user product is the right MVP shape.

---

## Closing summary

The Apple-Health OSS topic is broader than expected — 600+ repos — but the top 30 cleanly cluster into **(a) iOS HealthKit wrappers**, **(b) `export.zip` parsers + analytics dashboards**, **(c) one self-hosted competitor stack (`health-data-hub`)**, and **(d) closed-iOS-app companions (`Health Auto Export`)**. The single highest-leverage idea is **Apple Health XML one-shot import** — every other competitor takes it for granted and HealthLog doesn't have it; a ~200-LOC Node SAX parser unlocks day-1 onboarding for every iPhone user before the iOS app even ships. The second is **adopting `SleepChartKit` + `healthkit-data-generator` + an anchored-query pattern in the v1.5 Swift target** — saves weeks of work and gets Apple-faithful sleep UX for free. The third is **rebrand the Coach pipeline along the explicit "two-brain" findings → narrative split** that `health-data-hub` documents. None of the players in the topic is positioned to compete on HealthLog's exact combo (web PWA + Withings + multi-provider AI BYOK + AGPL + doctor PDF + EN/DE), but `umutkeltek/health-data-hub` is the one to watch — same audience, different starting point.

**Word count:** ~3850.
