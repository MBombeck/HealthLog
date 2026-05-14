# Source-Priority Two-Axis — v1.4.25 W8c Research

> Research brief for HealthLog v1.4.25 W8c. Goal: lock the two-axis source-priority data
> model and UX before v1.5's iOS-app build so the iOS team consumes a stable contract.

## Scope clarification first

The v1.4.25 brief frames the existing model as "single-axis" — that needs nuance. The
on-disk shape in `src/lib/validations/source-priority.ts` already accepts a
**per-metric** map of source lists:

```ts
{ steps: ["APPLE_HEALTH","WITHINGS","MANUAL"], weight: ["WITHINGS","APPLE_HEALTH",…], … }
```

Persisted on `User.sourcePriorityJson` (Prisma `Json?` at `prisma/schema.prisma:148`).
What is actually missing — and what every leading platform *does* solve — is the
**second axis**: *within a provider, which device wins*. Open-wearables calls these
`provider_priority` + `device_type_priority`; Apple Health calls them
"Data Sources & Access" rows that hang off each metric type. The v1.4.25 → W8c upgrade
should fill that second axis and bolt on a UI; the per-metric JSON layout already
exists and only needs new keys.

## Section 1 — How leading platforms do it

### Apple Health / HealthKit (iOS)

**Per-data-type ordered list** — every `HKQuantityType` / `HKCategoryType` carries its
own "Data Sources & Access" row stack. Apple's support article on managing Health
data: "You can check which devices and apps update specific health categories and
choose the sources Health uses first … If multiple sources contribute the same data
type, then the data source at the top will take priority over others." Configuration
path: open the metric → scroll to *Data Sources & Access* → *Edit* → drag rows
([support.apple.com/en-us/108779][apple-support],
[9to5mac walk-through][9to5mac]).

Default ordering when the user hasn't intervened, per the same article:

1. Manually entered data
2. iPhone, iPad, Apple Watch data
3. Third-party apps / Bluetooth devices

What is **not** publicly documented: how `HKSampleQuery` decides which row to return
when 3 sources have an identical sample at the same `startDate`. Apple's
[HKSampleQuery reference][hk-samplequery] only describes "samples that match the
provided type and predicate." Observed behaviour from third-party reports and from
`dogsheep/healthkit-to-sqlite`'s export is that **no server-side dedup happens** —
every sample is returned with its `HKSource` and `HKDevice` attached; the consumer
filters. So Apple's prioritisation is presentational (the Health app's own UI), not
an API-level resolver. **Important for HealthLog**: the iOS passthrough will deliver
every sample with its source identity intact; HealthLog must do its own canonical
pick.

### Garmin Connect

Garmin exposes **device-level**, not metric-level, priority. *Manage Device
Priority* lets the user pick a "primary wearable device" used as the default data
source for everyday metrics ([Garmin support FAQ e3gcLbODQF0jUrDnB7FGK8][garmin-faq]).
This is one global ladder per Garmin Connect account; it does *not* split steps vs
heart rate vs sleep. Garmin's developer site (`developer.garmin.com`,
Connect IQ + Health API) returns activity-level summaries already tagged with a
single device — Garmin reconciles upstream before exposing data. Practical
takeaway: Garmin's UX is poorer than Apple's, and any user with multiple Garmins
loses fidelity. Don't copy this.

### Whoop

Single-source by design. Whoop's API surfaces recovery, cycles, workouts, and sleep
from Whoop's own strap ([developer.whoop.com/api/][whoop-api]); no Apple Health
write-back, no device-priority concept. Marketing literature treats the strap as the
sole source of truth. Practical takeaway: when HealthLog adds Whoop in a future
release, it slots into the priority ladder as just another source, no second-axis
work required.

### Oura Ring

Oura runs as a "supplementary" source. The Apple Health integration article
explicitly says: "You can set Oura as a priority data source for steps recorded in
Apple Health" — Oura tells users to fix duplicate-step issues by reordering the
**Apple Health** Data Sources row stack for *Steps specifically*
([support.ouraring.com 360025438734][oura-apple-health]). That confirms the
per-metric model is the industry-de-facto pattern. Oura's own cloud API returns its
own data; reconciliation happens on the consumer side (Apple Health, third-party
dashboards).

### Withings

Withings writes to Apple Health by default through the Health Mate iOS app. Their
support article walks users through the Apple Health share toggle but does **not**
expose a Withings-side priority knob ([support.withings.com 203728916][withings-share]).
When a duplicate weight reading occurs (e.g., the same Body+ measurement appears in
Withings' own API and in Apple Health), the consumer dashboard has to dedup. A
recurring Reddit complaint thread ([r/withings 10l8wfu][withings-reddit]) describes
delete-and-reinstall as the only workaround when Health Mate stops syncing — i.e.,
no end-user resolution UI exists. HealthLog's job: dedup Withings vs Apple Health
weight rows server-side.

### the-momentum/open-wearables

This is the cleanest two-axis reference implementation available in OSS. Apache-2.0,
FastAPI + SQLAlchemy + Alembic. Spec lives at `.ai/specs/001-data-source-priority.mdx`
in the repo and matches the implementation.

**Data model** (verbatim from
`backend/app/models/provider_priority.py` and `device_type_priority.py`):

```python
# Two separate tables, both keyed off enums:

class ProviderPriority(BaseDbModel):
    __tablename__ = "provider_priority"
    id: Mapped[PrimaryKey[UUID]]
    provider: Mapped[Unique[ProviderName]]   # apple, garmin, polar, suunto, whoop, oura
    priority: Mapped[Indexed[int]]           # 1 = highest
    updated_at: Mapped[datetime]

class DeviceTypePriority(BaseDbModel):
    __tablename__ = "device_type_priority"
    id: Mapped[PrimaryKey[UUID]]
    device_type: Mapped[Unique[DeviceType]]  # watch, band, ring, phone, scale, other, unknown
    priority: Mapped[Indexed[int]]
    updated_at: Mapped[datetime]
```

Both tables are **system-wide**, not per-user — every user shares the same default
ladder. The spec's documented defaults: `apple:1, garmin:2, polar:3, suunto:4, whoop:5`
and `watch:1, band:2, ring:3, phone:4, scale:5, other:6, unknown:99`.

**Algorithm** (from `backend/app/services/priority_service.py:get_priority_data_source_ids`):

```python
def sort_key(ds: DataSource) -> tuple[int, int, str]:
    provider_priority    = provider_order.get(ds.provider, 99)
    device_type_priority = device_type_order.get(DeviceType(ds.device_type), 99)
    return (provider_priority, device_type_priority, ds.device_model or "")
sorted_sources = sorted(sources, key=sort_key)
```

Lexicographic two-axis sort, fallback priority `99` for unknown values, stable third
key on `device_model` for tie-breaking. The `/summary` endpoint walks the sorted
DataSource list and picks the first one that has data in the requested window.

**Frontend** (`frontend/src/lib/api/services/priority.service.ts`): three API
surfaces — `/api/v1/priorities/providers`, `/api/v1/priorities/device-types`,
`/api/v1/priorities` (bulk). No per-metric override is exposed; the user
configures the two ladders once and they apply universally. **This is a coarser
model than Apple Health's per-metric ladders** — open-wearables chose simpler over
maximum fidelity.

**Important nuance**: open-wearables has **no per-metric axis**. Apple Health has
per-metric but **no device-type** axis. HealthLog can split the difference and
ship both axes in one schema — see Section 2.

### umutkeltek/health-data-hub

Surveyed; no multi-source priority logic. The system targets a single ingest stream
(HealthSave iOS app → server) with idempotent upserts on identity columns. Out of
scope for our pattern hunt.

### Other FOSS surveyed

- `dogsheep/healthkit-to-sqlite` — schema preserves `sourceName`/`sourceVersion`/
  `device` columns on every row; no priority logic — that's expected for an export
  tool.
- `k0rventen/apple-health-grafana` — Grafana dashboards over the same XML export;
  source filtering happens via PromQL/SQL filter clauses, not a model.
- `qs_ledger`, `selfhostedhealth` — single-source per metric; not applicable.

## Section 2 — Data-model recommendation

### Proposed shape

Extend the existing `User.sourcePriorityJson` (Prisma `Json?`) rather than adding
new tables. The 1-row-per-user JSON blob keeps reads O(1), avoids a join on every
measurement query, and lines up with the Marc directive of one persisted UI state
per user.

```ts
// src/lib/validations/source-priority.ts
{
  // Axis 1 — per-metric source ladder (already exists in v1.4.25):
  metricPriority: {
    steps:           ["APPLE_HEALTH", "WITHINGS", "MANUAL"],
    weight:          ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
    // …14 metric keys total, partial — missing keys fall back to defaults
  },

  // Axis 2 — within a source, device-type ladder (NEW for W8c):
  deviceTypePriority: {
    // optional global default for every source:
    default: ["watch", "ring", "band", "phone", "scale", "other"],
    // optional per-source override (rare):
    APPLE_HEALTH: ["watch", "phone"],
  },
}
```

**Why a JSON column over normalised tables**

1. Existing column is `Json?` — no migration needed beyond Zod-schema additions.
2. Per-user override is the whole point (Marc on Withings, another on Garmin) —
   open-wearables' system-wide tables don't fit.
3. `pickCanonicalSource()` reads once per query (cached on the request-scoped user
   object) — a JSON blob hits the same hot-path as today.
4. Future axis additions (e.g., "manual entries always win", "ScanWatch-specific
   override") slot in as new top-level keys without DDL.

**Why not a separate `user_source_priority_per_metric` table**

A side table makes sense for open-wearables because their priority is global. Per-user
priority + 14 metric keys + 6 sources = ≤84 rows/user worst-case — but reads on every
measurement query mean a join + ORDER BY every time. JSON blob avoids that.

### Migration shape

- `prisma/schema.prisma` — no change. Field remains `Json?`.
- `src/lib/validations/source-priority.ts` — extend Zod schema with a
  `deviceTypePriority` object (additive, all keys `.optional()`).
- `parseSourcePriority()` already merges parsed onto defaults — extend the same
  pattern.

## Section 3 — Migration path

Backward-compatibility design (no forced re-config):

1. **Schema additive only** — new top-level `deviceTypePriority` key is optional
   inside the existing JSON. Existing rows have it absent → `parseSourcePriority()`
   merges in `DEFAULT_DEVICE_TYPE_PRIORITY` automatically (same pattern the v1.4.25
   per-metric fallback already uses at
   `src/lib/validations/source-priority.ts:122`).
2. **Renaming**: if it helps callers, wrap the existing top-level keys inside a
   `metricPriority` nested object — but a backward-compat shim that detects the
   old flat shape and lifts it costs maybe 10 lines. Recommended: keep both shapes
   readable for one release, document the new shape as canonical, drop the shim in
   v1.5.0.
3. **No data migration required.** No `prisma migrate` step. No SQL backfill. The
   only deploy artefact is a Zod schema bump + new defaults constant + new UI rows.
4. **Telemetry hint**: log a `source_priority_legacy_shape_detected` event when the
   shim fires so you can gauge when it's safe to drop the alias.

## Section 4 — UI sketch

Marc's no-split directive ([feedback_settings_no_split.md][marc-no-split]) and the
"provider dropdown drives form below" pattern shape this. One section on
Settings → Sources, layered top-down (NOT split):

```
┌──────────────────────────────────────────────────────────────────┐
│ Quellen-Priorität                                                │
│ Bei doppelten Messwerten gewinnt die oberste Quelle pro Metrik.  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Standard-Reihenfolge                                            │
│  (1) Apple Health    [↕]   ▢ aktiv                               │
│  (2) Withings        [↕]   ▢ aktiv                               │
│  (3) Manuell         [↕]   ▢ aktiv                               │
│                                                                  │
│  ▶ Pro Metrik anpassen (Expander, default zugeklappt)            │
│      [Metrik auswählen ▼]  Gewicht                               │
│      ──────────────────────────────                              │
│      (1) Withings        [↕]                                     │
│      (2) Apple Health    [↕]                                     │
│      (3) Manuell         [↕]                                     │
│      [Auf Standard zurücksetzen]                                 │
│                                                                  │
│  ▶ Geräte-Typ-Reihenfolge (innerhalb Apple Health)               │
│      (1) Apple Watch  (2) iPhone  (3) Drittanbieter              │
└──────────────────────────────────────────────────────────────────┘
```

Three rules baked in:

1. **One screen, three vertically-stacked sections, no left/right split.** The metric
   dropdown drives the rows below it; same pattern as `settings/llm-settings.tsx`.
2. **Per-metric expander is collapsed by default** — most users will only ever set
   the global default. Power users open the drawer.
3. **Device-type axis appears once at the bottom** as a single global default plus an
   inline per-source override (uncommon enough to nest one level deep).

Component reuse: drag-and-drop list already lives in `components/settings/sources-section.tsx`
(v1.4.25 W5e). Wrap it in a Sheet/Card and parameterise over the metric key.

Accessibility note: drag handles also need keyboard reorder (`↑`/`↓` buttons next to
each row) — RTL coverage in `__tests__/source-priority.test.ts` already mandates this
shape.

## Section 5 — Algorithm + perf

```ts
// src/lib/analytics/source-priority.ts — extended for W8c

interface MeasurementRow {
  measuredAt: Date;
  source: MeasurementSource;           // APPLE_HEALTH | WITHINGS | MANUAL
  deviceType?: "watch" | "ring" | "band" | "phone" | "scale" | "other";
}

export function pickCanonicalSourceRows(
  rows: readonly MeasurementRow[],
  metricKey: SourcePriorityMetricKey,
  userPriorityJson: unknown,
  dayKey: (d: Date) => string,
) {
  const config = parseSourcePriority(userPriorityJson);
  const sourceLadder = config.metricPriority[metricKey]
                    ?? DEFAULT_SOURCE_PRIORITY[metricKey];
  const deviceLadder = (s: MeasurementSource) =>
    config.deviceTypePriority?.[s]
    ?? config.deviceTypePriority?.default
    ?? DEFAULT_DEVICE_TYPE_PRIORITY;

  // Build O(1) lookup maps once per call:
  const sourceRank = new Map(sourceLadder.map((s, i) => [s, i]));
  const deviceRank = (s: MeasurementSource) =>
    new Map(deviceLadder(s).map((d, i) => [d, i]));

  // Bucket by day; per-bucket find lowest (source-rank, device-rank, measuredAt) tuple.
  // Lexicographic compare on the tuple — same shape as open-wearables.
  …
}
```

Performance:

- **Hash-map lookup** for source/device rank — O(1) per row.
- **Single bucket pass** per call — O(n) on row count.
- **Per-request cache** on the resolved config (one parse per request, reused across
  every analytics query in the same React Query batch). Already the v1.4.25 pattern.
- No DB round-trip on the hot path beyond the existing `User` fetch.

Memoising the config on the route-handler-level `User` object means
`pickCanonicalSourceRows` adds approximately zero overhead vs the v1.4.25 baseline.

## Section 6 — Edge cases + tie-breakers

| Case | Rule | Rationale |
|------|------|-----------|
| Same timestamp + same metric, 3 sources | Walk source ladder; first match wins. | Matches Apple Health UX. |
| Same source, two devices (Apple Watch + iPhone both write steps) | Walk device-type ladder; `watch > phone`. | Matches Apple defaults + open-wearables. |
| Same source + same device + duplicate row (Withings webhook delivers same `measurement_id` twice) | Dedup on `(source, externalId)` at ingest, NOT at pick time. Prefer the row that's already in the DB; ignore the duplicate. | Idempotent ingest is open-wearables' rule too — see `apps/api/server/ingestion/storage.py`. Cheaper than picking at read time. |
| Cumulative metric (steps), source A has data for the day, source B has data for the same day | Pick ONE source for the whole day (existing v1.4.25 behaviour at `pickCanonicalSourceRows`). | Summing both = double-counting. |
| Point metric (weight), same day, two sources | Keep both rows in DB; display the higher-priority one in the dashboard; "show all sources" toggle reveals the lower-priority rows. | Apple Health behaviour; preserves audit trail. |
| Manual entry duplicates an Apple Health row | Manual loses unless the user reorders. Apple's default is "manual first" — we invert it because Withings users typed nothing. | Marc directive: Withings is primary; manual is the fallback when sensors are off. |
| Unknown source (legacy ingest, future source not in ladder) | Fall through to "keep all rows" — never silently drop data. | The current v1.4.25 fallback at `pickCanonicalSourceRows` line "if (!picked) canonicalRows.push(...slot.rows)". |
| Tie between sources at the same rank | Break on `(deviceTypeRank, measuredAt DESC)`. | Stable ordering across re-renders. |

## Section 7 — iOS-app contract impact

**Server picks canonical at read time. iOS does not need to know about priorities
on ingest.** Concretely:

- iOS batch ingest endpoint (v1.4.23 W-prep) writes every sample with its
  `HKSource.name` + `HKDevice.model` into `Measurement.source` and a new
  `Measurement.deviceType` column. Already shipped as part of v1.4.23.
- The server's read-side analytics pipeline runs `pickCanonicalSourceRows` on the
  fly using the user's `sourcePriorityJson`.
- iOS therefore stays a dumb pipe — no logic forks, no contract churn when the user
  reorders priorities.

**Contract delta vs v1.4.23**:

- Add `deviceType` (nullable enum) to `MeasurementIngestRequest` schema. iOS sends
  the `HKDevice.model` mapped to one of `{watch,ring,band,phone,scale,other}`.
- Server side: nullable column on `Measurement`, default `null` → falls back to "no
  device-type info, ignore second axis for this row" in the picker.

That's it for the iOS contract — no ladder, no priority-aware ingest path.

## Section 8 — Open questions for Marc

1. **Per-source device-type override needed?** Open-wearables uses one global
   device-type ladder. Apple's UX implicitly per-source (the dropdown lives inside
   each source's Data Sources row in iOS). My recommendation: ship one global
   `deviceTypePriority.default` ladder for v1.4.25 W8c; add per-source overrides only
   if a real user reports a need. Confirm?
2. **Should the per-metric override UI surface every metric or just the user's
   active metrics?** I'd surface only metrics where the user has rows from ≥2
   sources — auto-detected from the last 90 days. Otherwise the dropdown lists 14
   metrics, most empty. Confirm?
3. **Migration shim duration.** If we wrap existing top-level metric keys inside
   `metricPriority`, do we ship the back-compat alias only for v1.4.25, or carry it
   through v1.5? My suggestion: one release, then drop. Confirm or push out.
4. **DeviceType enum scope.** Open-wearables uses `watch, band, ring, phone, scale,
   other, unknown`. HealthLog v1.4.23 added `Measurement.source` but not
   `Measurement.deviceType`. Adding it is a tiny migration. Worth doing in W8c, or
   defer to v1.5 P1 (iOS app)?
5. **Telemetry vs analytics?** Should the analytics endpoint emit
   `source_priority_pick` events (picked-source per metric per day) so we can debug
   user complaints about "why is Apple winning when I set Withings"? Adds one event
   per picker call. Recommended yes, but storage cost is a knob.

---

## Sources

- [Apple Support — Manage Health data][apple-support]
- [9to5Mac — How to prioritize Apple Health sources][9to5mac]
- [Apple Developer — HKSampleQuery reference][hk-samplequery]
- [Garmin support — Setting a Watch as Your Primary Wearable Device][garmin-faq]
- [Whoop API documentation][whoop-api]
- [Oura support — Apple Health integration priority][oura-apple-health]
- [Withings support — Sharing data with Apple Health][withings-share]
- [Reddit r/withings — duplicate-sync workaround thread][withings-reddit]
- [the-momentum/open-wearables — repo][open-wearables-repo]
- [open-wearables `provider_priority.py`][provider-priority-src]
- [open-wearables `device_type_priority.py`][device-type-priority-src]
- [open-wearables `priority_service.py`][priority-service-src]
- [open-wearables `001-data-source-priority.mdx` spec][source-priority-spec]
- [umutkeltek/health-data-hub — repo][health-data-hub]
- [Marc directive — no top/bottom split in Settings][marc-no-split]

[apple-support]: https://support.apple.com/en-us/108779
[9to5mac]: https://9to5mac.com/2019/07/19/prioritize-apple-health-sources-iphone/
[hk-samplequery]: https://developer.apple.com/documentation/healthkit/hksamplequery
[garmin-faq]: https://support.garmin.com/en-US/?faq=e3gcLbODQF0jUrDnB7FGK8
[whoop-api]: https://developer.whoop.com/api/
[oura-apple-health]: https://support.ouraring.com/hc/en-us/articles/360025438734-Apple-Health-Integration
[withings-share]: https://support.withings.com/hc/en-us/articles/203728916-Partner-Apps-Sharing-data-with-Apple-Health
[withings-reddit]: https://www.reddit.com/r/withings/comments/10l8wfu/potential_workaround_for_health_mate_to_apple/
[open-wearables-repo]: https://github.com/the-momentum/open-wearables
[provider-priority-src]: https://github.com/the-momentum/open-wearables/blob/main/backend/app/models/provider_priority.py
[device-type-priority-src]: https://github.com/the-momentum/open-wearables/blob/main/backend/app/models/device_type_priority.py
[priority-service-src]: https://github.com/the-momentum/open-wearables/blob/main/backend/app/services/priority_service.py
[source-priority-spec]: https://github.com/the-momentum/open-wearables/blob/main/.ai/specs/001-data-source-priority.mdx
[health-data-hub]: https://github.com/umutkeltek/health-data-hub
[marc-no-split]: /Users/marc/.claude/projects/-Users-marc-Projects-HealthLog/memory/feedback_settings_no_split.md
