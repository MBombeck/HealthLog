# R-coach — Clustered, selectable Coach data sources (v1.7.0 research+design)

Status: design only. READ-ONLY survey of the current tree + a proposed model. No code changed.

## 0. Problem (maintainer's words, paraphrased)

The Coach only receives a fixed subset — BP, weight, pulse, mood, medication compliance.
Much more data exists (HealthKit-sourced: steps, sleep, body composition, glucose, workouts,
flights, walking metrics, environmental audio, …) that the Coach never sees. Cluster all
available data and make it **selectable** — the user chooses which clusters the Coach gets.

The headline finding: **the plumbing for ~9 of the missing metrics already exists in the
snapshot builder** but is gated behind a scope default that ships only the legacy 5, and the
settings UI is framed as opt-OUT ("exclude metrics") rather than opt-IN clusters. The redesign
is mostly a re-framing + a handful of new clusters (glucose, workouts, body-composition,
mobility/gait, environmental) rather than a from-scratch build.

---

## 1. Current state: what the snapshot builder packs today

### 1.1 Entry points

- Chat route: `src/app/api/insights/chat/route.ts:287` calls `buildCoachSnapshot(userId, effectiveScope)`.
- `effectiveScope` is derived at `route.ts:283-286`: if the client did not send `scope.window`,
  the user's saved `coachPrefs.defaultWindow` is folded in. `scope.sources` is **not** defaulted
  here — it stays `undefined` unless the client sends it.
- Snapshot builder: `src/lib/ai/coach/snapshot.ts`. Public `buildCoachSnapshot` (line 364) is a
  60 s in-memory LRU wrapper (`SNAPSHOT_TTL_MS = 60_000`, `SNAPSHOT_LRU_MAX = 64`, cache key
  `userId|window|sources` at `snapshot.ts:300-304`) around `buildCoachSnapshotImpl` (line 376).

### 1.2 Scope resolution — the load-bearing default

- `DEFAULT_SOURCES` = `["bp","weight","pulse","mood","compliance"]` — `snapshot.ts:55-61`.
- `resolveScope` (`snapshot.ts:264-276`): if `scope.sources` is absent/empty → `DEFAULT_SOURCES`;
  window defaults to `last30days` (`DEFAULT_WINDOW`, line 54).
- **This is the gate.** Every Apple-Health metric is wired below but never enabled unless the
  client explicitly passes the extended `sources` array. The PWA does not; only the iOS app does
  (per the `coachScopeSchema.sources.max(14)` comment at `types.ts:77-82`).
- Per-user `excludeMetrics` (opt-out) then *narrows* the resolved scope further
  (`snapshot.ts:398-422`). Excludes can only remove; they cannot add a non-default source.

### 1.3 What actually lands in the prompt today (per active source)

Each metric block carries two sections (doc comment `snapshot.ts:339-362`):
- `aggregate` — the analytics features shape (mean, slope, SD, range, count) from
  `extractFeatures(userId, false, { sinceDays })` (`snapshot.ts:425-427`).
- `timeline.recent` — last `DAILY_TIMELINE_DAYS = 14` (`snapshot.ts:51`) days as daily means
  with weekday labels (tz-anchored via `User.timezone`, fallback `Europe/Berlin`).
- `timeline.weekly` — ISO-week buckets for the rest of the window.

Blocks emitted today:
- **bp** — `snapshot.ts:515-538` (`aggregate` + `timeline.recent` paired sys/dia + `weeklySys`/`weeklyDia`).
- **weight** — `snapshot.ts:539-555`.
- **pulse** — `snapshot.ts:556-573`.
- **mood** — `snapshot.ts:574-600` (separate `MoodEntry` table read).
- **compliance** — `snapshot.ts:602-664` (per-day adherence from `MedicationIntakeEvent`).
- **Apple Health additive blocks** — `snapshot.ts:691-762`: hrv, sleep, resting_hr, steps,
  active_energy, flights, distance, vo2_max, body_temp. Timeline-only (no `aggregate`). Each
  emitted only when `sources.has(metric)` AND rows exist (`snapshot.ts:747-750`). **Already built,
  default-off.**
- **weeklyContext.glp1** — `snapshot.ts:778-784` via `buildGlp1SnapshotBlock` (gated on the
  `medications` exclude + presence of a GLP-1 medication).
- **anthropometrics** (height/age/gender) — `snapshot.ts:793-807` from `features.context`,
  gated on the `anthropometrics` exclude.
- **scope** echo — `snapshot.ts:816-820` (`window`, `sources`, `timelineRecentDays`).
- Final pass: `compactSections(snapshot)` drops zero-row blocks (`snapshot.ts:828`), then
  `JSON.stringify(…, null, 2)`.

The `METRIC_TYPES` map (`snapshot.ts:469-484`) is the single source mapping
`CoachScopeSource → MeasurementType[]`. One Prisma `findMany` with `type IN (…)`
(`snapshot.ts:493-505`) covers every measurement-backed source; mood + compliance read
separate tables.

### 1.4 Budgeting today

- **Daily token ledger**, not a per-prompt size cap: `src/lib/ai/coach/budget.ts` —
  `MAX_TOKENS_PER_USER_PER_DAY = 25_000` (`budget.ts:20`), enforced at `route.ts:174` via
  `enforceBudget`. Per-reply `maxTokens: 600` (`route.ts:328`).
- **Prompt-size control is structural, not measured.** The snapshot stays small because:
  `DAILY_TIMELINE_DAYS = 14` + weekly buckets for the tail; the 5-source default; `compactSections`
  drops empties; history capped at `TURN_CAP = 20` / `RECENT_HISTORY = 18` (`route.ts:75-76`).
  Comment at `snapshot.ts:48-49`: 90-day window ≈ 25 rows/metric "well under the 3 000-token Coach
  turn budget on a 5-metric snapshot."
- There is **no explicit byte/token cap on the assembled snapshot JSON**. Enabling everything at a
  long window today would silently grow the prompt — the historical 25.9 MB→30k-token trim
  (insights `/generate`, not Coach) shows the risk class. This is the central budgeting gap the
  redesign must close (§5).

---

## 2. Inventory: every stored domain vs. what the Coach sees

`MeasurementType` enum (`prisma/schema.prisma:447-545`) + medication/workout/mood/sleep models.

| Domain | Stored type(s) / model | In Coach today? | Notes |
|---|---|---|---|
| Blood pressure | `BLOOD_PRESSURE_SYS/DIA` | YES (default) | aggregate+timeline |
| Weight | `WEIGHT` | YES (default) | aggregate+timeline |
| Pulse (spot) | `PULSE` | YES (default) | aggregate+timeline |
| Mood | `MoodEntry` | YES (default) | separate table |
| Med compliance | `MedicationIntakeEvent` | YES (default) | per-day adherence |
| GLP-1 context | `Medication` (treatmentClass=GLP1) | YES (auto) | weeklyContext block |
| Anthropometrics | `User.heightCm/dateOfBirth/gender` | YES (auto) | context block |
| HRV | `HEART_RATE_VARIABILITY` | wired, default-OFF | timeline-only |
| Sleep duration | `SLEEP_DURATION` (+`SleepStage`) | wired, default-OFF | per-stage rows summed; **stages not surfaced** |
| Resting HR | `RESTING_HEART_RATE` | wired, default-OFF | timeline-only |
| Steps | `ACTIVITY_STEPS` | wired, default-OFF | timeline-only |
| Active energy | `ACTIVE_ENERGY_BURNED` | wired, default-OFF | timeline-only |
| Flights climbed | `FLIGHTS_CLIMBED` | wired, default-OFF | timeline-only |
| Distance | `WALKING_RUNNING_DISTANCE` | wired, default-OFF | timeline-only |
| VO2 max | `VO2_MAX` | wired, default-OFF | timeline-only |
| Body temp | `BODY_TEMPERATURE` | wired, default-OFF | timeline-only |
| **Glucose** | `BLOOD_GLUCOSE` (+`GlucoseContext`) | **NO** | not in `METRIC_TYPES` |
| **Body fat %** | `BODY_FAT` | **NO** (features has it; Coach drops it) | `features.bodyFat` exists |
| **Body water** | `TOTAL_BODY_WATER` | **NO** | |
| **Bone mass** | `BONE_MASS` | **NO** | |
| **SpO2** | `OXYGEN_SATURATION` | **NO** | |
| **Fat-free / fat / muscle / lean mass** | `FAT_FREE_MASS`,`FAT_MASS`,`MUSCLE_MASS`,`LEAN_BODY_MASS` | **NO** | Withings + HK body comp |
| **BMI** | `BODY_MASS_INDEX` | **NO** | |
| **Skin temp** | `SKIN_TEMPERATURE` | **NO** | |
| **Pulse-wave velocity / vascular age / visceral fat** | `PULSE_WAVE_VELOCITY`,`VASCULAR_AGE`,`VISCERAL_FAT` | **NO** | cardio-vascular composition |
| **Respiratory rate** | `RESPIRATORY_RATE` | **NO** | |
| **Walking HR avg** | `WALKING_HEART_RATE_AVERAGE` | **NO** | |
| **Mobility/gait** | `WALKING_STEADINESS`,`WALKING_ASYMMETRY`,`WALKING_DOUBLE_SUPPORT`,`WALKING_STEP_LENGTH`,`WALKING_SPEED` | **NO** | Apple Mobility section |
| **Environmental audio** | `AUDIO_EXPOSURE_ENV`,`AUDIO_EXPOSURE_HEADPHONE`,`AUDIO_EXPOSURE_EVENT` | **NO** | |
| **Daylight** | `TIME_IN_DAYLIGHT` | **NO** | mood/sleep correlate |
| **Workouts** | `Workout` model | **NO** | sport, duration, energy, distance, HR — never surfaced |

Net: **5 default + ~9 wired-but-off + ~25 stored-but-never-mapped types + the entire Workout model.**

---

## 3. Where preferences live (persistence survey)

- **Model**: no dedicated `CoachPrefs` table. Persisted as `User.coachPrefsJson` (Json column).
- **Schema/validation**: `src/lib/validations/coach-prefs.ts`. `coachPrefsSchema` (line 91):
  `tone`, `verbosity`, `excludeMetrics` (array, `max(11)`, default `[]`), `showEvidenceByDefault`
  (dead in UI, kept for back-compat), `defaultWindow` (default `allTime`).
  `coachExcludeMetricEnum` (line 48) currently lists: bp, weight, pulse, mood, compliance, hrv,
  sleep, resting_hr, steps, medications, anthropometrics.
- **API**: `src/app/api/auth/me/coach-prefs/route.ts` — GET returns `parseCoachPrefs(row)`,
  PUT validates with `coachPrefsSchema` and writes `coachPrefsJson` field-by-field (line 69).
- **Hook**: `src/hooks/use-coach-prefs.ts` (queryKey `queryKeys.coachPrefs()`), fetch-failure→defaults.
- **UI**: `src/components/insights/coach-panel/coach-settings-sheet.tsx`. Right-edge `<Sheet>` off
  the drawer header cog. `EXCLUDE_OPTIONS` (line 66) lists 9 metrics as **opt-out switches**;
  `CONTEXT_OPTIONS` (line 84) lists sleep/medications/anthropometrics; plus tone, verbosity,
  defaultWindow selects.

**The scaffold the maintainer remembered exists** — it is the exclude-metrics list. The gap: it is
opt-out and lists only 9 of ~35 available types, and it does not change the snapshot's *source
default* (excluding cannot enable a non-default source). The redesign inverts the model to
opt-in clusters (§4-§5) while keeping `excludeMetrics` working for back-compat.

---

## 4. Proposed cluster taxonomy

Eight clusters. Each cluster = one toggle. Each maps to a set of `CoachScopeSource` /
`MeasurementType` / model reads.

| Cluster | Toggle key | Default ON | Members (MeasurementType / model) |
|---|---|---|---|
| **Cardiovascular** | `cardio` | ✅ | BLOOD_PRESSURE_SYS/DIA, PULSE, RESTING_HEART_RATE, HEART_RATE_VARIABILITY, WALKING_HEART_RATE_AVERAGE, RESPIRATORY_RATE, OXYGEN_SATURATION, PULSE_WAVE_VELOCITY, VASCULAR_AGE |
| **Body composition** | `body` | ✅ | WEIGHT, BODY_FAT, FAT_MASS, FAT_FREE_MASS, MUSCLE_MASS, LEAN_BODY_MASS, BONE_MASS, TOTAL_BODY_WATER, BODY_MASS_INDEX, VISCERAL_FAT |
| **Activity** | `activity` | ❌ | ACTIVITY_STEPS, ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED, WALKING_RUNNING_DISTANCE, VO2_MAX |
| **Workouts** | `workouts` | ❌ | `Workout` model (sport, duration, energy, distance, avg/max HR) |
| **Sleep** | `sleep` | ❌ | SLEEP_DURATION (+ optional `SleepStage` breakdown) |
| **Mood** | `mood` | ✅ | `MoodEntry` |
| **Glucose** | `glucose` | ❌ | BLOOD_GLUCOSE (+ `GlucoseContext` tagging) |
| **Medication** | `medication` | ✅ | `MedicationIntakeEvent` adherence + GLP-1 weeklyContext |
| **Mobility & gait** | `mobility` | ❌ | WALKING_STEADINESS, WALKING_ASYMMETRY, WALKING_DOUBLE_SUPPORT, WALKING_STEP_LENGTH, WALKING_SPEED |
| **Environment** | `environment` | ❌ | AUDIO_EXPOSURE_ENV/HEADPHONE/EVENT, TIME_IN_DAYLIGHT, SKIN_TEMPERATURE, BODY_TEMPERATURE |

(10 clusters listed; collapse Mobility into Activity if a tighter UI is wanted — keep separate so
the Apple "Mobility" mental model survives.)

**Default-ON set = the current 5 domains' clusters** (cardio, body, mood, medication). This is the
back-compat contract: an existing user who never opens settings gets exactly today's behaviour
(BP/pulse via cardio, weight via body, mood, compliance via medication). HRV/RHR ride in `cardio`
and body-fat in `body`, so default-on quietly *adds* a little — acceptable since they are
low-volume daily samples; if strict parity is required, seed cluster membership so only the legacy
5 types are active until the user opts the rest in (see §5 "strict-parity" note).

---

## 5. Persistence design

**Pick: extend `coachPrefsJson` with a `dataClusters` field. No new table, no migration.**
(`coachPrefsJson` is a Json column; adding a key is schema-compatible and `parseCoachPrefs`
already falls back to defaults on shape drift.)

```ts
// coach-prefs.ts
export const coachDataClusterEnum = z.enum([
  "cardio","body","activity","workouts","sleep",
  "mood","glucose","medication","mobility","environment",
]);
// Default-on clusters preserve the legacy 5 domains.
export const DEFAULT_COACH_CLUSTERS = ["cardio","body","mood","medication"] as const;

coachPrefsSchema = z.object({
  …existing…,
  // undefined => DEFAULT_COACH_CLUSTERS (legacy users unchanged).
  dataClusters: z.array(coachDataClusterEnum).optional(),
});
```

Why a field, not a table:
- Single read already happens (`route.ts:278-281`, `snapshot.ts:392-395`). Zero extra I/O.
- `coachPrefsJson` is already the per-user Coach config home; clustering belongs with tone/window.
- `undefined` is the back-compat sentinel — never write defaults eagerly; resolve at read time.

Relationship to existing fields:
- `dataClusters` is the **opt-in source of truth** going forward. `excludeMetrics` stays valid and
  is applied as a *post-filter* (a cluster can be on but a single metric inside it excluded) — so
  the existing exclude UI and any saved prefs keep working. Resolution order:
  `clusters → expand to sources → subtract excludeMetrics`.
- `scope.sources` from the request body still wins as the *maximum* set (iOS can pass an explicit
  list); when absent, the snapshot expands `dataClusters` instead of `DEFAULT_SOURCES`.

**Strict-parity option**: if the maintainer wants byte-identical legacy output until opt-in, set
`DEFAULT_COACH_CLUSTERS` to expand to exactly `["bp","weight","pulse","mood","compliance"]`
(i.e. cardio→bp+pulse only, body→weight only at default) and gate the extra members behind an
explicit toggle. Recommended instead: ship the small additive default and bump PROMPT_VERSION.

---

## 6. Snapshot-builder changes

Keep `buildCoachSnapshotImpl` structure; change only the source-resolution and add the new blocks.

1. **New cluster→source expansion** (new helper in `snapshot.ts`, near `resolveScope:264`):
   `expandClusters(clusters): Set<CoachScopeSource-extended>`. Replace `DEFAULT_SOURCES` fallback
   at `resolveScope` so when the request omits `scope.sources`, the builder expands the user's
   `dataClusters` (read from the prefs row already fetched at `snapshot.ts:392-396`) instead of
   the hardcoded 5.
2. **Extend `CoachScopeSource`** (`types.ts:52-71`) + `METRIC_TYPES` (`snapshot.ts:469-484`) with the
   new metric keys (glucose, body-comp set, mobility set, environment set, respiratory, etc.).
   `coachScopeSchema.sources.max(14)` → raise to cover the new count.
3. **New aggregate/timeline blocks** following the existing `appleHealthBlocks` loop
   (`snapshot.ts:691-762`) — add entries for each new single-type metric (timeline-only is fine;
   they reuse `buildDailyValueRows`/`bucketWeekly`).
4. **Glucose block**: like a value metric but carry `GlucoseContext` so the Coach can distinguish
   fasting vs postprandial; summarise as per-context daily means, not raw samples.
5. **Workouts block** (new read): `prisma.workout.findMany` for the window, collapse to one row per
   workout (sport, durationMin, energyKcal, distanceM, avgHR) and **cap to the last N** (e.g. 15)
   plus a per-sport weekly count/volume rollup for the tail. Never dump every workout.
6. **Sleep stages** (optional enrichment): when `sleep` cluster on, optionally roll
   `SleepStage` minutes into a per-night `{rem,core,deep,awake}` summary instead of duration alone.
7. **Provenance** (`types.ts:146-213`): extend `metrics`/`counts` unions with the new keys so the
   source chips + evidence disclosure mirror what the model saw.

### Reuse rollup tiers (CLAUDE.md "read-swap" rule)
For high-frequency / cumulative metrics (steps, active energy, distance, flights, glucose,
workouts), **read from the existing rollup tier** (`src/lib/rollups/measurement-rollups.ts`,
DAY buckets; `sum_value` column added in v1.4.39 for cumulative metrics) rather than raw
`Measurement` rows. The features pipeline already prefers rollups with live fallback — route the
new clusters through `extractFeatures`/rollup readers wherever a reader exists, and only fall back
to raw `findMany` on coverage miss. This keeps the snapshot read budget flat even when everything
is enabled.

---

## 7. Budgeting strategy (the central risk)

Goal: enabling all 10 clusters at `lastYear`/`allTime` must not blow the provider context.

1. **Per-block row caps already exist** (`DAILY_TIMELINE_DAYS=14` recent + weekly tail). Keep them.
2. **Add an assembled-snapshot soft cap.** After building `snapshot`, measure
   `JSON.stringify(snapshot).length` (proxy for tokens at ~4 chars/token). Define
   `MAX_SNAPSHOT_CHARS` (e.g. 24_000 ≈ ~6k tokens). If exceeded, **degrade progressively**:
   - First, drop `timeline.recent`→keep `aggregate`+`timeline.weekly` for the lowest-priority
     clusters (environment, mobility, workouts detail).
   - Then collapse weekly→single aggregate per metric.
   - Emit `annotate({ action: "coach.snapshot.truncated", meta: { dropped, finalChars }})`.
3. **Cluster priority order** for degradation (high→low): medication, cardio, glucose, body,
   sleep, mood, activity, workouts, mobility, environment. Highest-signal clinical clusters
   survive truncation.
4. **High-frequency metrics never ship raw.** Steps/energy/distance/audio = daily means/sums from
   rollups only; workouts = capped list + per-sport rollup; glucose = per-context daily means.
5. **Window interacts with cluster count.** When >6 clusters active, cap the timeline window to
   `last90days` regardless of `defaultWindow` for the *additive* clusters (keep the core clusters
   at the chosen window). Document in the scope echo.
6. Keep the daily token ledger (`budget.ts`) untouched — it is the cost backstop; the snapshot cap
   is the per-prompt-shape backstop.

---

## 8. Settings UI sketch

Replace the flat opt-out `EXCLUDE_OPTIONS` list with a clustered opt-in section in
`coach-settings-sheet.tsx`. Clusters as primary toggles; existing per-metric exclude becomes an
optional "advanced / fine-tune" expander under each cluster (keeps `excludeMetrics` working).

```
┌─ Coach settings ──────────────────────────── [×] ┐
│ Tone        [ Warm        ▾ ]                     │
│ Verbosity   [ Default     ▾ ]                     │
│ Default window [ Last 30 days ▾ ]                 │
│                                                   │
│ DATA THE COACH SEES                               │
│ Pick which clusters of your data the Coach can    │
│ read. More data = richer answers, larger prompts. │
│ ┌───────────────────────────────────────────────┐│
│ │ ♥  Cardiovascular        BP · pulse · HRV  [ON]││  ← default on
│ │ ⚖  Body composition      weight · fat · …  [ON]││  ← default on
│ │ 😊 Mood                                    [ON]││  ← default on
│ │ 💊 Medication            adherence · GLP-1 [ON]││  ← default on
│ │ 👟 Activity              steps · energy   [OFF]││
│ │ 🏃 Workouts              runs · rides      [OFF]││
│ │ 🌙 Sleep                 duration · stages [OFF]││
│ │ 🩸 Glucose                                 [OFF]││
│ │ 🚶 Mobility & gait                         [OFF]││
│ │ 🔊 Environment           noise · daylight  [OFF]││
│ └───────────────────────────────────────────────┘│
│  ▸ Advanced: exclude individual metrics            │  ← collapsible, wraps existing exclude list
│                                                   │
│            [ Cancel ]   [ Save ]                  │
└───────────────────────────────────────────────────┘
```

- Reuse existing `<Switch>` + `<Label>` row pattern (`coach-settings-sheet.tsx:341-361`).
- Each cluster row: title + sublabel (member preview) + switch. i18n keys
  `insights.coach.cluster.<key>` + `.cluster.<key>.hint` (must exist in `messages/en.json` and all
  6 locales per the i18n guards).
- "Advanced" expander renders the current per-metric exclude list filtered to enabled clusters'
  members → writes `excludeMetrics`.
- The empty-state when a user has no rows for a cluster (web-only account, no glucose): show the
  toggle but disabled with a "no data yet" hint (mirrors snapshot's omit-empty contract).

No new dependency. No markdown. Same Sheet surface.

---

## 9. PROMPT_VERSION + annotate

- **Bump `PROMPT_VERSION`** (`src/lib/ai/prompts/insight-generator.ts`). The SNAPSHOT shape gains
  new top-level keys (glucose, workouts, body-comp, mobility, environment) and the system prompt
  must mention them. Per the in-tree convention the version travels onto every persisted
  `CoachMessage.promptVersion` (`route.ts:427/443`) + feedback attribution — bump so old cached
  rows attribute correctly. Minor-class bump (new prompt capability), e.g. `4.20.0`→`4.7.0`-style
  per their scheme; pick the next Coach prompt version the repo uses.
- **System prompt** (`src/lib/ai/coach/system-prompt.ts`, GROUND RULE 12 region ~line 153 EN /
  ~398 DE): extend the "each metric carries a timeline" note to name the new blocks and reiterate
  they are *additive* (absent for users without that data) — the model must not invent a cluster.
- **New annotate events** (`<surface>.<noun>.<verb>` per CLAUDE.md):
  - `coach.clusters.resolved` — meta `{ active: string[], window }` (once per snapshot build).
  - `coach.snapshot.truncated` — meta `{ droppedClusters, finalChars }` when the soft cap fires.
  - `coach.cluster.empty_skipped` — meta `{ cluster }` when a toggled-on cluster has no rows.
  - extend existing `insights.coach.replied` meta with `clusterCount`.

---

## 10. Test list

Unit (Vitest):
- `coach-prefs.test.ts`: `dataClusters` parse/default/back-compat; undefined→DEFAULT_COACH_CLUSTERS;
  unknown cluster string → defaults (shape-drift fallback).
- `snapshot.test.ts` / `snapshot-new-metrics.test.ts`: cluster→source expansion; each new block
  emitted only when toggled AND rows exist; glucose per-context summary; workouts capped+rolled;
  sleep-stage rollup; excludeMetrics still subtracts inside an enabled cluster.
- New `snapshot-budget.test.ts`: all clusters on + `allTime` stays under `MAX_SNAPSHOT_CHARS`;
  progressive degradation order; `coach.snapshot.truncated` annotation fires.
- `snapshot` parity: DEFAULT_COACH_CLUSTERS reproduces the legacy 5-domain output byte-for-byte
  (or documents the small additive delta if not using strict-parity).
- Provenance: new metric keys surface in `metrics`/`counts`.
- Rollup read-swap: new clusters read rollup tier with live fallback on coverage miss.

Integration (testcontainers):
- coach-prefs PUT/GET round-trips `dataClusters`.
- End-to-end snapshot for a tenant with glucose+workout rows → blocks present; web-only tenant →
  absent.

Component (Vitest + RTL):
- `coach-settings-sheet.test.tsx`: cluster toggles render, save writes `dataClusters`, advanced
  expander writes `excludeMetrics`, empty-data cluster disabled.

i18n guards: `insights.coach.cluster.*` keys resolve in `messages/en.json` + propagate to de/es/fr/it/pl.

OpenAPI: `coach-prefs` request/response schema gains `dataClusters` → regen `docs/api/openapi.yaml`,
commit alongside. CI `openapi:check` fails on drift.

E2E (Playwright, optional): open Coach settings, toggle a cluster, save, assert persisted.
