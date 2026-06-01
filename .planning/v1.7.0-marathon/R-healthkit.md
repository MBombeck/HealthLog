# R-healthkit — HealthKit ingest consolidation, missing charts, unit fixes

Research + design for v1.7.0. Scope: (a) daily-aggregation for high-frequency HealthKit metrics, (b) chart surfaces for orphan metric types, (c) walking-speed km/h display.

All citations are `file:line` against the working tree at the start of this session. READ-ONLY pass — no source edited.

---

## 0. Executive summary

- The full `MeasurementType` enum is **41 values** (`prisma/schema.prisma:447-503`).
- **31 of the 41 types have NO dedicated chart surface today.** Only 10 have a chart (6 dashboard tiles + the insights sub-pages). Everything else (all v1.4.25 / v1.4.30 / v1.5.5 Apple-Health + Withings additions) is *ingested and stored* but *never plotted*. This is the "orphan data" the maintainer is describing — `flights climbed`, `walking speed`, `step length`, `environmental audio exposure`, plus ~27 more.
- The chart component (`HealthChart`) is **fully generic** and **already daily-aggregates** through the rollup/`aggregate=daily` read path. New charts are *registry + mount* work, not new chart code. The Recharts-stays rule is satisfied by reusing `HealthChart` verbatim.
- **Walking speed stores AND displays m/s today. There is NO km/h conversion anywhere in the tree** (grep for `km/h` / `3.6` returns only unrelated timezone math). This is the confirmed unit bug.
- High-frequency *spot* metrics (PULSE, RESPIRATORY_RATE, WALKING_SPEED, WALKING_STEP_LENGTH, AUDIO_EXPOSURE_*) are stored per-sample and are NOT drained — only the 5 *cumulative* types are. The display path averages them per day correctly *only on windows >7 days*; the consolidation gap is about storage volume + ≤7-day windows.

---

## 1. Full type → chart → unit → aggregation table

Enum source: `prisma/schema.prisma:447-503`. Stored unit source: `unitMap` in `src/lib/validations/measurement.ts` + `dbUnit` in `src/lib/measurements/apple-health-mapping.ts:146-473`. Ingest aggregation hint: `aggregation` field in the same map. "Cumulative" = member of `CUMULATIVE_HK_TYPES` (`apple-health-mapping.ts:490-496`). Chart surface = dashboard tile in `src/app/page.tsx` OR an insights sub-page under `src/app/insights/`.

| Type | Stored unit | Freq (HK) | Ingest agg | Cumulative? | Chart surface today | Notes |
|---|---|---|---|---|---|---|
| WEIGHT | kg | spot | latest | no | tile + `/insights/gewicht` | ✅ |
| BLOOD_PRESSURE_SYS | mmHg | spot | latest | no | tile + `/insights/blutdruck` | ✅ |
| BLOOD_PRESSURE_DIA | mmHg | spot | latest | no | tile + `/insights/blutdruck` | ✅ |
| PULSE | bpm | **high (per-sample)** | latest | no | tile + `/insights/puls` | ✅ but high-volume |
| BODY_FAT | % | spot | latest | no | tile | ✅ |
| SLEEP_DURATION | minutes | per-stage | sum | no | tile + `/insights/schlaf` | ✅ |
| ACTIVITY_STEPS | steps | **high** | sum | **yes** | tile | ✅ drained + consolidated |
| BLOOD_GLUCOSE | mg/dL | spot | latest | no | — (list only) | orphan |
| TOTAL_BODY_WATER | kg | spot | latest | no | — | orphan (Withings) |
| BONE_MASS | kg | spot | latest | no | — | orphan (Withings) |
| OXYGEN_SATURATION | % | spot | latest | no | `/insights/sauerstoff` | ✅ |
| HEART_RATE_VARIABILITY | ms | nightly | mean | no | `/insights/hrv` | ✅ |
| RESTING_HEART_RATE | bpm | daily | latest | no | `/insights/ruhepuls` | ✅ |
| ACTIVE_ENERGY_BURNED | kcal | **high** | sum | **yes** | `/insights/aktive-energie` | ✅ drained |
| **FLIGHTS_CLIMBED** | flights | **high** | sum | **yes** | **— orphan** | needs chart |
| **WALKING_RUNNING_DISTANCE** | m | **high** | sum | **yes** | **— orphan** | needs chart |
| VO2_MAX | mL/(kg·min) | sparse | latest | no | `vo2-max-chart-row` (overview) | ✅ partial |
| BODY_TEMPERATURE | celsius | spot | latest | no | `/insights/koerpertemperatur` | ✅ |
| FAT_FREE_MASS | kg | spot | latest | no | — | orphan (Withings) |
| FAT_MASS | kg | spot | latest | no | — | orphan (Withings) |
| MUSCLE_MASS | kg | spot | latest | no | — | orphan (Withings) |
| SKIN_TEMPERATURE | celsius | spot | latest | no | — | orphan (Withings) |
| PULSE_WAVE_VELOCITY | m/s | sparse | latest | no | — | orphan (Withings) |
| VASCULAR_AGE | years | sparse | latest | no | — | orphan (Withings) |
| VISCERAL_FAT | rating | sparse | latest | no | — | orphan (Withings) |
| **AUDIO_EXPOSURE_ENV** | dBA | **high (~30 s)** | mean | no | **— orphan** | needs chart |
| **AUDIO_EXPOSURE_HEADPHONE** | dBA | **high** | mean | no | **— orphan** | needs chart |
| TIME_IN_DAYLIGHT | minutes | daily | sum | **yes** | — orphan | drained, no chart |
| WALKING_STEADINESS | % | daily | latest | no | — orphan | needs chart |
| AUDIO_EXPOSURE_EVENT | count | event | sum | no | — orphan | event flag — chart optional |
| RESPIRATORY_RATE | breaths/min | **high (sleep/workout)** | mean | no | — orphan | needs chart |
| BODY_MASS_INDEX | kg/m² | spot | latest | no | `/insights/bmi` (derived) | ✅ via WEIGHT |
| LEAN_BODY_MASS | kg | spot | latest | no | — | orphan |
| WALKING_HEART_RATE_AVERAGE | bpm | daily | mean | no | — orphan | needs chart |
| WALKING_ASYMMETRY | % | daily | latest | no | — orphan | needs chart |
| WALKING_DOUBLE_SUPPORT | % | daily | latest | no | — orphan | needs chart |
| **WALKING_STEP_LENGTH** | m | **high** | mean | no | **— orphan** | needs chart |
| **WALKING_SPEED** | **m/s** | **high** | mean | no | **— orphan** | **needs chart + km/h fix** |

(BLOOD_PRESSURE counted once each; 41 enum members total.)

### Central registries (cite these when adding a type)

- **Stored unit:** `unitMap` → `getUnitForType()` — `src/lib/validations/measurement.ts:137-139`.
- **Plausibility range (ingest guard):** `VALUE_RANGES` — `src/lib/validations/measurement.ts:142-239`.
- **Label i18n key:** `MEASUREMENT_TYPE_LABEL_KEYS` — `src/components/measurements/measurement-list-meta.ts:39-84`.
- **Icon:** `MEASUREMENT_TYPE_ICONS` — `measurement-list-meta.ts:86-148`.
- **Color (Dracula chart palette):** `MEASUREMENT_TYPE_COLORS` — `measurement-list-meta.ts:150-206`.
- **UI category:** `MEASUREMENT_CATEGORIES` — `src/lib/measurements/categories.ts`.
- **HK ingest mapping (hkUnit, dbUnit, convertToDbUnit, aggregation):** `APPLE_HEALTH_TYPE_MAP` — `src/lib/measurements/apple-health-mapping.ts:146-473`.
- **Cumulative-SUM set:** `CUMULATIVE_HK_TYPES` — `apple-health-mapping.ts:490-496`.
- **AI chart-token allowlist:** `ALLOWED_CHART_TOKENS` — `src/lib/insights/chart-tokens.ts:23-82` (already lists every new type).
- **Insights metric gate enum:** `InsightMetric` — `src/lib/insights/metric-availability.ts:43-63`; gate fn `hasMetricData()` at `:93-106` (generic `summaries[metric].count > 0` fallback already covers new MeasurementType-backed metrics).

**Net:** every per-type *metadata* surface except `InsightMetric` and a per-metric insights page already has entries for the orphan types. The label/icon/colour/unit/range/category/token plumbing is DONE. The missing piece is the **chart mount** + a handful of i18n page-copy keys + the unit conversion for speed.

---

## 2. Step consolidation & the drain pattern (does it generalise?)

Two distinct mechanisms exist:

### 2a. Nightly cumulative drain — `src/lib/measurements/drain-per-sample-cumulative.ts`
- Runs over `CUMULATIVE_HK_TYPES` only (`drain-per-sample-cumulative.ts:320`, set defined `apple-health-mapping.ts:490-496`): `ACTIVITY_STEPS, ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED, WALKING_RUNNING_DISTANCE, TIME_IN_DAYLIGHT`.
- Per user × type × calendar-day (user tz): SUM all `APPLE_HEALTH` per-sample rows whose `externalId NOT LIKE 'stats:%'`, UPSERT one row keyed `stats:<HKIdentifier>:<YYYY-MM-DD>` at local-noon, then **delete** the per-sample rows in the same tx (`:374-424`).
- 36-hour grace cutoff (`DRAIN_CUMULATIVE_CUTOFF_HOURS`, `:55`) keeps today's in-flight watch syncs raw for the live "today" view.
- Idempotent: re-running collapses zero rows (`:344-356`).

### 2b. Boot-time legacy step consolidation — `src/lib/jobs/step-consolidation.ts` + `src/lib/measurements/consolidate-legacy-steps.ts`
- A pg-boss queue (`STEP_CONSOLIDATION_QUEUE`, `step-consolidation.ts:19`) registered in `allQueues` (`reminder-worker.ts`). Discovery query enqueues one job per user still holding live legacy step rows (`step-consolidation.ts:95-104`).
- Difference from 2a: it **soft-deletes** (tombstones) the legacy rows rather than hard-deleting, and it **SUMs** legacy granular rows but **does not overwrite** an existing post-v1.5.0 daily total (avoids double-counting — `consolidate-legacy-steps.ts:230-262`).
- This is ACTIVITY_STEPS-specific (hardcoded `STEP_TYPE`, `STEP_HK_IDENTIFIER` — `:50-53`).

### Does the pattern generalise?

**Drain (2a) generalises cleanly to other cumulative types by SUM — and already covers FLIGHTS_CLIMBED + WALKING_RUNNING_DISTANCE + TIME_IN_DAYLIGHT.** So those three are *already consolidated server-side*; their only gap is the missing chart.

**The drain does NOT generalise to MEAN/spot high-frequency metrics**, and must not: summing PULSE or WALKING_SPEED across a day is meaningless. The correct consolidation for `aggregation: "mean"` types is a **daily-mean**, which the read path already computes (see §3). The maintainer's "daily-mean" intuition is exactly right for these.

---

## 3. The read-path already daily-aggregates — what's actually missing

The chart NEVER plots raw per-sample rows beyond a 7-day window:

- `HealthChart` (`src/components/charts/health-chart.tsx:619-622`): for `windowDays > 7` it requests `aggregate=daily&source=rollup`. The route reduces by **SUM for `CUMULATIVE_HK_TYPES`, AVG (daily-mean) for everything else** (`src/app/api/measurements/route.ts:504-510`, `:448`).
- For ≤7-day windows the chart pulls raw rows and aggregates client-side, again SUM-vs-mean keyed on `CUMULATIVE_HK_TYPES` (`health-chart.tsx:672-682`).
- So a WALKING_SPEED or PULSE chart over 30/90/all already shows **daily mean**, plotted as one point per day. Volume only bites the ≤7-day path and raw storage.

**Conclusion on (a):** for *display*, daily-mean is already implemented for every `mean`/spot type the moment a chart is mounted with a >7-day default window. The remaining work is:
1. **Storage volume** — high-frequency spot metrics (PULSE, RESPIRATORY_RATE, AUDIO_EXPOSURE_ENV/HEADPHONE, WALKING_SPEED, WALKING_STEP_LENGTH) accumulate per-sample rows forever. There is no drain for them. The maintainer's concern (a) is primarily a storage / "don't keep every raw sample" concern.
2. **Default window** — new chart cards should default to a >7-day range so they hit the daily-mean path immediately rather than the raw ≤7-day path.

### Design — daily-mean consolidation for high-frequency non-cumulative metrics

Add a **second drain mode** rather than overloading the SUM drain. Recommended: generalise `drain-per-sample-cumulative.ts` into a reducer-aware drain.

- Introduce `HIGH_FREQUENCY_MEAN_TYPES: ReadonlySet<MeasurementType>` next to `CUMULATIVE_HK_TYPES` in `apple-health-mapping.ts`: `{ PULSE, RESPIRATORY_RATE, AUDIO_EXPOSURE_ENV, AUDIO_EXPOSURE_HEADPHONE, WALKING_SPEED, WALKING_STEP_LENGTH }`. (HRV/walking-HR-avg/steadiness are already low-frequency — daily-or-sparser — so they need no drain.)
- New nightly job `mean-consolidation` (mirror `step-consolidation.ts` queue registration). Per user × type × completed day (respect the same 36 h grace): compute the **daily mean** of `APPLE_HEALTH` per-sample rows, UPSERT one `stats:<HKIdentifier>:<day>` row at local-noon with `value = mean`, **soft-delete** the per-sample rows (tombstone, matching the legacy-step choice at `consolidate-legacy-steps.ts:304-312` — keeps an audit trail, lower risk than hard-delete).
- Critical correctness note: the daily-stats read path currently treats a single `stats:` row as the day's value as-is. For a MEAN type the stored `stats:` row already IS the mean, so the chart's per-day reduction (`stats.sum / stats.count` with count=1) returns it unchanged. ✅ No reader change needed because mean types are not in `CUMULATIVE_HK_TYPES`, so the read path uses AVG and a single row averages to itself.
- **Do NOT add mean types to `CUMULATIVE_HK_TYPES`** — that would switch them to SUM and corrupt the value. Keep the two sets disjoint; assert disjointness in a test.

Risk: PULSE is also entered manually and synced from Withings spot readings — draining `source = 'APPLE_HEALTH'` only (as the existing drain does, `drain-per-sample-cumulative.ts:327`) keeps manual/Withings pulse rows intact. Honour that scoping.

Alternative (lower effort, no drain): rely entirely on the existing rollup DAY tier for display and accept unbounded raw storage with a retention sweep. Rejected — the maintainer explicitly wants consolidation, and the drain pattern is proven + idempotent.

---

## 4. Orphan types needing a chart (priority list)

The maintainer named four. The full orphan set with a chartable continuous series:

**P1 — explicitly requested:**
- FLIGHTS_CLIMBED (already SUM-drained; just mount a chart)
- AUDIO_EXPOSURE_ENV (Geräuschbelastung/Lärmbelastung Umgebung)
- WALKING_STEP_LENGTH (Schrittweite/Schrittlänge)
- WALKING_SPEED (Schrittgeschwindigkeit) — **+ km/h fix, see §5**

**P2 — same Mobility/Hearing/Activity clusters, cheap to add alongside:**
- WALKING_RUNNING_DISTANCE (already SUM-drained)
- AUDIO_EXPOSURE_HEADPHONE
- WALKING_STEADINESS, WALKING_ASYMMETRY, WALKING_DOUBLE_SUPPORT, WALKING_HEART_RATE_AVERAGE
- RESPIRATORY_RATE
- TIME_IN_DAYLIGHT (already SUM-drained)

**P3 — Withings body-comp / cardiovascular cluster (defer unless in scope):**
- LEAN_BODY_MASS, FAT_FREE_MASS, FAT_MASS, MUSCLE_MASS, TOTAL_BODY_WATER, BONE_MASS, VISCERAL_FAT, SKIN_TEMPERATURE, PULSE_WAVE_VELOCITY, VASCULAR_AGE, BLOOD_GLUCOSE.

**Not chartable as a line:** AUDIO_EXPOSURE_EVENT (discrete event flag — render as event markers/count, not a continuous chart).

---

## 5. Walking-speed unit conversion (the confirmed bug)

**Finding:** WALKING_SPEED is stored AND surfaced as **m/s**. `dbUnit: "m/s"` (`apple-health-mapping.ts:465-472`), `unitMap.WALKING_SPEED = "m/s"` (`measurement.ts:134`). `convertToDbUnit` is identity (`:470`). No display layer converts to km/h — grep for `km/h` / `* 3.6` across `src/` returns zero hits. WALKING_STEP_LENGTH similarly stays metres (correct — keep m, possibly show cm; 0.5–0.8 m reads fine as "0.65 m").

A casual gait of 1.3 m/s reads as "1.3 m/s" — unintuitive. Users expect km/h (1.3 m/s ≈ 4.7 km/h).

**Recommendation: display-time conversion, raw storage stays m/s (canonical SI).** Justification:
1. Preserves raw-data integrity + the locked iOS wire contract (`apple-health-mapping.ts:127-145` documents raw-SI passthrough as a hard convention; PULSE_WAVE_VELOCITY also stores m/s and must NOT be touched).
2. Mirrors the existing display-vs-storage split already used for BLOOD_GLUCOSE (canonical mg/dL, display mg/dL-or-mmol/L per user pref — `schema.prisma:455`).
3. A stored canonical change would need a migration + rewrite of every row + iOS round-trip churn for zero data-quality gain.

**Implementation shape:**
- Convert only at the chart/tile/list display boundary. `HealthChart` takes raw values; introduce a per-type display transform. Cleanest: a small `displayTransform` registry keyed by MeasurementType (`WALKING_SPEED: { factor: 3.6, displayUnit: "km/h", decimals: 1 }`), applied where the value + unit are rendered (chart `unit`/`yAxisUnit` props at the mount site, plus the measurement list cell and tooltip formatter `formatTooltipValue` `health-chart.tsx:1032`).
- Mount WALKING_SPEED's chart with `unit="km/h"`, `yAxisUnit="km/h"`, and feed the chart values multiplied by 3.6 (transform the series before passing to `HealthChart`, OR add an optional `valueScale` prop to `HealthChart` — preferred, keeps the chart generic and Recharts untouched). `valueScale` defaults to 1, so every existing chart is bit-identical (Recharts-stays + charts-visually-identical satisfied).
- The personal-baseline / trend / y-domain math all operate on the scaled series uniformly, so no per-feature special-casing.

**Other unit-conversion audit (gaps found):** none are *wrong*, but two are unintuitive and worth a display transform in the same pass:
- WALKING_RUNNING_DISTANCE stored in **metres** (`apple-health-mapping.ts:245-252`). A 5 km walk reads as "5000 m". Recommend display in km (factor 0.001) for daily totals — consistent with the speed fix. iOS-coord note `schema.prisma:464` already says "UI converts per locale" — this conversion was *planned but never built*.
- WALKING_STEP_LENGTH stored in metres; "0.65 m" is acceptable, optionally show cm (×100). Low priority.
- No imperial/metric user toggle exists for distance today — out of scope; ship metric km/h + km first.

---

## 6. Registry additions (per new chartable type)

Every entry below ALREADY exists for the orphan types in `measurement-list-meta.ts`, `categories.ts`, `apple-health-mapping.ts`, `chart-tokens.ts`, `validations/measurement.ts`. The remaining additions are: (i) `InsightMetric` enum members + page modules, (ii) page-copy i18n keys, (iii) the `displayTransform` for speed/distance, (iv) the `HIGH_FREQUENCY_MEAN_TYPES` set.

Confirmed-existing metadata for the four P1 types (for reference / regression checks):

| Type | unit (stored) | display unit | decimals | icon | colour | ingest agg | label key (exists) |
|---|---|---|---|---|---|---|---|
| FLIGHTS_CLIMBED | flights | flights | 0 | TrendingUp | chart-2 | sum | `measurements.typeFlightsClimbed` |
| AUDIO_EXPOSURE_ENV | dBA | dBA | 0 | Volume2 | chart-5 | mean | `measurements.typeAudioExposureEnv` |
| WALKING_STEP_LENGTH | m | m (or cm) | 2 | Footprints | chart-2 | mean | `measurements.typeWalkingStepLength` |
| WALKING_SPEED | m/s | **km/h** | 1 | Gauge | chart-2 | mean | `measurements.typeWalkingSpeed` |

New `displayTransform` registry (proposed, new file `src/lib/measurements/display-transform.ts`):

```
WALKING_SPEED:            { factor: 3.6,   displayUnit: "km/h", decimals: 1 }
WALKING_RUNNING_DISTANCE: { factor: 0.001, displayUnit: "km",   decimals: 2 }   // daily totals
// all other types: identity (factor 1, displayUnit = getUnitForType, decimals from existing axis logic)
```

New `InsightMetric` members (`metric-availability.ts:43-63`) for each new sub-page: `FLIGHTS_CLIMBED`, `WALKING_RUNNING_DISTANCE`, `AUDIO_EXPOSURE_ENV`, `AUDIO_EXPOSURE_HEADPHONE`, `WALKING_SPEED`, `WALKING_STEP_LENGTH`, `WALKING_STEADINESS`, `RESPIRATORY_RATE`, `TIME_IN_DAYLIGHT`. The generic `hasMetricData` fallback (`:105`) already gates them on `summaries[metric].count > 0` — no new handler branches needed (note: it keys on the `InsightMetric` string, which must equal the `MeasurementType` string for these — it does).

Page modules: one ~10-line file per metric reusing `HealthKitMetricPage` (`src/components/insights/healthkit-metric-page.tsx:79-139`) — pass `measurementType`, `insightMetric`, `chartKey`, `i18nPrefix`, `color`, `unit`. For WALKING_SPEED also thread the new `valueScale={3.6}` (after adding the prop to `HealthChart`/`HealthChartDynamic`). German route slugs to match existing convention: `/insights/stockwerke`, `/insights/gehgeschwindigkeit`, `/insights/schrittlaenge`, `/insights/laermbelastung`, `/insights/gehstrecke`.

Each new `chartKey` must be added to `ChartOverlayKey` in `src/lib/dashboard-layout.ts` (overlay-prefs persistence).

---

## 7. i18n keys for new page copy (de/en/es/fr/it/pl)

Type **labels already exist in all six locales** (`measurements.type*` — verified present in en/de; locale-integrity test guarantees the other four). Missing keys are the per-page sub-page copy under `insights.*` and the nav pills.

Per new sub-page `<prefix>` (e.g. `insights.flightsClimbed`), add: `.title`, `.description`, `.chartTitle`, `.emptyState.title`, `.emptyState.description`, `.emptyState.cta` (the `HealthKitMetricPage` scaffold resolves exactly these — `healthkit-metric-page.tsx:98-128`). Plus a `insights.nav<Metric>` pill key (the nav currently has 15 `nav*` keys; tab strip in `insights/layout.tsx`).

Example EN/DE for the four P1 types:

```
insights.flightsClimbed.title            EN "Flights Climbed"      DE "Treppen"
insights.flightsClimbed.chartTitle        EN "Flights climbed per day" DE "Treppen pro Tag"
insights.walkingSpeed.title               EN "Walking Speed"        DE "Gehgeschwindigkeit"
insights.walkingSpeed.chartTitle          EN "Walking speed (km/h)" DE "Gehgeschwindigkeit (km/h)"
insights.walkingStepLength.title          EN "Step Length"          DE "Schrittlänge"
insights.audioExposureEnv.title           EN "Environmental Audio"  DE "Lärmbelastung (Umgebung)"
```

Provide es/fr/it/pl in the same shape. The two guard tests below FAIL the build if any locale is short a key — fix the bundle, never suppress (`i18n-locale-integrity.test.ts`, `i18n-call-site-coverage.test.ts`, per CLAUDE.md).

---

## 8. Test list

Unit:
- `apple-health-mapping.test.ts` — assert `HIGH_FREQUENCY_MEAN_TYPES` and `CUMULATIVE_HK_TYPES` are **disjoint** (a type in both would corrupt SUM-vs-mean).
- New `mean-consolidation` reducer test: per-day mean over N per-sample rows, idempotent re-run = 0 work, soft-delete tombstones the source rows, `source != APPLE_HEALTH` rows untouched, single existing `stats:` row not double-folded.
- `display-transform` test: WALKING_SPEED 1.3 m/s → 4.68 km/h (1 dp); WALKING_RUNNING_DISTANCE 5000 m → 5.00 km; identity for untransformed types.
- `getUnitForType` / `VALUE_RANGES` coverage — already gated by `measurement-type-enum-coverage.test.ts`; extend to assert every new `InsightMetric` maps to a real MeasurementType.
- `HealthChart` `valueScale` prop: scaled series leaves y-domain/baseline/trend math consistent; `valueScale=1` (default) renders byte-identical to pre-change (charts-visually-identical guard).

Integration (testcontainers Postgres):
- Batch-ingest a burst of WALKING_SPEED / AUDIO_EXPOSURE_ENV per-sample rows → run `mean-consolidation` → assert one `stats:` row/day with the correct mean and source rows tombstoned.
- `GET /api/measurements?type=WALKING_SPEED&aggregate=daily&source=rollup` returns daily-mean (not sum).
- Drain grace window: rows newer than 36 h stay raw.

i18n:
- `i18n-locale-integrity.test.ts` + `i18n-call-site-coverage.test.ts` green across de/en/es/fr/it/pl for every new `insights.*` and `nav*` key.

E2E (Playwright, only the new surfaces):
- Each new `/insights/<slug>` page renders a chart when data exists, an empty-state CTA when not; axe-clean.
- WALKING_SPEED page Y-axis shows km/h.

OpenAPI: no request/response schema change expected (consolidation is internal + display-only); if a new query param is added, re-run `pnpm openapi:generate` and commit (CI `openapi:check` gate).

---

## 9. Open questions / risks

- **Biggest risk:** the mean-consolidation drain is *destructive* (soft-delete of per-sample rows). If WALKING_SPEED/PULSE per-sample detail is ever wanted at sub-day resolution (e.g. a workout drill-down), tombstoning loses it. The legacy-step pass accepted this; confirm the maintainer accepts it for spot metrics, or gate the drain behind a longer grace window (e.g. 7 days) so recent detail survives.
- Should WALKING_RUNNING_DISTANCE display in km (recommended) ship in the same release as the speed km/h fix, or wait for a global metric/imperial user toggle? (No toggle exists today.)
- PULSE is high-frequency but already has a chart + heavy existing analytics dependence. Draining its per-sample rows to daily-mean could change correlation/scatter inputs that read raw PULSE. Verify `src/lib/insights/correlations.ts` + scatter chart tolerate a daily-grain PULSE before adding PULSE to the mean-drain set — safest to EXCLUDE PULSE from the first drain pass and only consolidate the genuinely-orphan high-frequency types (audio exposure, walking speed/step-length, respiratory rate).
- AUDIO_EXPOSURE_EVENT has no continuous chart — decide whether it surfaces as event markers on the audio-exposure chart or as a separate count tile.
