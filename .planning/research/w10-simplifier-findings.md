# W10 Simplifier Findings — v1.4.25 (`v1.4.24..develop`)

Scan target: ~41.8 k inserted / ~4.5 k deleted across 269 files. Scope
limited to new code added in v1.4.25. Findings sorted by area; severity
key:

- **Apply-now** = clear win, < 10 LOC, no behaviour risk.
- **Apply-with-care** = clear win, larger or cross-file change.
- **Discuss-first** = judgement call (style / abstraction trade-off).

---

## Source-priority (W8c)

### S1 — Duplicated 14-key metric list (3 places)
`src/lib/validations/source-priority.ts:75-95 / 132-148 / 164-179`

`metricPriorityObjectSchema` enumerates the 14 metric keys
(`steps`/`activeEnergy`/.../`vo2Max`); `sourcePrioritySchema`
re-enumerates the same 14 verbatim alongside `metricPriority` +
`deviceTypePriority`; the `SOURCE_PRIORITY_METRIC_KEYS` array spells them
a third time. A new metric class (workouts in v1.5) means editing the
same list 3 ways.

Proposed: derive both schemas from `SOURCE_PRIORITY_METRIC_KEYS`:

```ts
const metricShape = Object.fromEntries(
  SOURCE_PRIORITY_METRIC_KEYS.map((k) => [k, metricSourceLadder]),
);
const metricPriorityObjectSchema = z.object(metricShape).partial();
const sourcePrioritySchema = z
  .object({ ...metricShape, metricPriority: metricPriorityObjectSchema, deviceTypePriority: deviceTypePrioritySchema })
  .partial();
```

Removes ~28 LOC and ensures `SOURCE_PRIORITY_METRIC_KEYS` stays the
single source of truth. **Apply-with-care** (Zod inference shape must
hold — `z.infer<typeof metricPriorityObjectSchema>` should still type
to the keyed object; verify before commit).

### S2 — Device-type ladder resolution duplicated
`src/lib/validations/source-priority.ts:343-352` defines
`getDeviceTypeLadder(resolved, metricType)` with the exact lookup
order (override > default > constant). `src/lib/analytics/source-priority.ts:133-150` re-implements that same lookup
inline as `resolveLadder()` (with an extra `Map` cache).

Proposed: call `getDeviceTypeLadder` from inside `resolveLadder`; the
cache wrapper stays where it is, the resolution itself is one import.
Removes 8 LOC and prevents drift the next time the fallback rules
change. **Apply-now.**

### S3 — `moveDeviceType` re-implements `moveSource` over a different bucket
`src/components/settings/sources-section.tsx:174-216`

`moveSource` (metric) and `moveDeviceType` (device-type) are two
21-line near-duplicates: extract list, swap two indices, write back.
The only difference is the slice of `priority` they update.

Proposed: one helper `function reorderLadder<T>(list: T[], index: number, delta: -1 | 1): T[] | null`
returning the new list (or `null` if out-of-range); both callers reduce
to "read the ladder, call helper, write back". Removes ~15 LOC and
removes one of the two `[list[a], list[b]] = ...` swap patterns.
**Apply-with-care** (test-coverage in `sources-section` integration
test needs to keep both bucket types covered).

### S4 — `__default__` sentinel string for device-type bucket
`sources-section.tsx:194-216` uses the literal `"__default__"` as the
bucket key for the global ladder. Two equal-shape `if`s in
`moveDeviceType` differ only in `default` vs `[bucket]`.

Proposed: pass `bucket: string | null` (null = default), branch once on
that. Replaces a magic string + two near-identical assignment branches
with one branch. ~6 LOC. **Apply-now.**

---

## AH-server-prep (W8d)

### S5 — `HK_QUANTITY_TYPE_TO_MEASUREMENT` is derived but redundant
`src/lib/measurements/apple-health-mapping.ts:299-304`

```ts
export const HK_QUANTITY_TYPE_TO_MEASUREMENT: Record<string, MeasurementType> =
  Object.fromEntries(
    Object.entries(APPLE_HEALTH_TYPE_MAP).map(([k, v]) => [k, v.measurementType]),
  );
```

The doc-comment says "useful when all the caller wants is the canonical
enum value for routing / filtering" but the entire `AppleHealthMapping`
record is the same key → `{measurementType, ...}` shape. A caller can
write `APPLE_HEALTH_TYPE_MAP[id]?.measurementType` and skip the second
table. Grep confirms only one external import.

Proposed: delete the constant + the type-only import on line 301
(`import("@/generated/prisma/client").MeasurementType` — already
imported up top, the re-resolution is a leftover of writing it later).
~8 LOC. **Apply-now** if there is in fact only one caller (verify with
`grep -rn HK_QUANTITY_TYPE_TO_MEASUREMENT src`).

### S6 — `mapAppleHealthEntry` rebranching on sleep when the discriminator is the map
`apple-health-mapping.ts:446-476`

The function branches on `mapping.sleepStageMap !== undefined`, then
re-builds an output object with the same 4 fields plus `sleepStage`.
Simpler shape: build the base object once, append `sleepStage` when
applicable.

```ts
const out: AppleHealthEntryOutput = { type: mapping.measurementType, value, unit: mapping.dbUnit, takenAt };
if (mapping.sleepStageMap) {
  if (input.sleepStage === undefined) return null;
  const stage = mapping.sleepStageMap[input.sleepStage];
  if (!stage) return null;
  out.sleepStage = stage;
}
return out;
```

Removes 8 LOC and one return path. **Apply-now.**

---

## Health-Score-Provenance (W8e)

### S7 — `COMPONENT_ORDER` inside the component body, recreated each render
`src/components/insights/health-score-card.tsx:182-187`

```ts
const COMPONENT_ORDER: readonly ComponentKey[] = ["bp", "weight", "mood", "compliance"];
const provenanceRows = [...COMPONENT_ORDER].map(...).sort(...);
```

The array is a constant; defining it inside the function body recreates
it on every render. Move it next to `COMPONENT_LABEL_KEY` at module
scope. The spread `[...COMPONENT_ORDER]` is then unnecessary because
the chained `.map()` already produces a new array — the spread protects
the original but `.map()` is non-mutating. ~3 LOC. **Apply-now.**

### S8 — `formatAsOf` rebuilds `Intl.DateTimeFormat` per row
`health-score-card.tsx:150-163`

`formatAsOf` is a closure declared inline, but in the
`provenanceRows.map()` below it is called once per row (up to 4 times).
Each call constructs a fresh `Intl.DateTimeFormat` instance. Two
adjustments:

1. Move the date formatter creation outside the map using
   `useMemo(() => new Intl.DateTimeFormat(locale, …), [locale])`, so
   it's built once per render.
2. Drop the `try/catch` — `new Date(asOf)` doesn't throw on a bad ISO
   string (it returns an invalid Date that `Number.isNaN(getTime())`
   already catches above).

~6 LOC + a defensive-style cleanup. **Apply-now.**

### S9 — Health-score attribution token unions duplicated 4 times
`src/lib/analytics/health-score.ts:372` and again on line 304-309 +
`src/app/api/analytics/route.ts:639-664`

The literal union `"manual" | "withings" | "appleHealth"` is spelled
inline at four call sites (two in the analytics route, one in the
health-score helper, one in `<HealthScoreCard>`). The
`HealthScoreComponentSource` type already exists in the component file
and the same shape is `(typeof HEALTH_SCORE_SOURCES)[number]` material.

Proposed: export `type ContributingSource = "manual" | "withings" |
"appleHealth"` from `lib/analytics/health-score.ts`; import everywhere.
~6 LOC of repeated literals. **Apply-with-care** (touches the React
component too — verify the `HealthScoreComponentSource` re-export
posture).

---

## Translations (W9e)

### S10 — `allMessages` + `resolveKey` duplicated client vs server
`src/lib/i18n/context.tsx:15-48` and
`src/lib/i18n/server-translator.ts:1-32`

Both files import the 6 message JSON bundles, build an identical
`allMessages` record, and declare an identical `resolveKey` helper. The
server translator's `t()` body is the same fallback chain as the
client's, minus the React state.

Proposed: extract `allMessages` + `resolveKey` into a small shared file
(`lib/i18n/messages.ts`); both consumers import it. The two files keep
their distinct public surfaces (`I18nProvider` vs `getServerTranslator`)
but stop carrying parallel infrastructure. Removes ~25 LOC of pure
duplication and prevents the next "add a locale" PR from missing one
file. **Apply-with-care** (verify SSR bundle splitting still keeps the
client bundle from importing server-only code — the shared file should
have no server-only imports, which is already true).

### S11 — `MaintainershipBanner` uses `useSyncExternalStore` for a one-shot read
`src/components/i18n/maintainership-banner.tsx:55-74`

`useSyncExternalStore` with a noop `subscribe` is a documented but
unusual pattern — the comment says "Subscribe is a no-op: we only need
React to re-read storage on the initial client render". A
`useState` + `useEffect` for the initial hydration check is more
idiomatic in HealthLog's codebase (every other client-mounted-only
component uses `useEffect`).

Proposed: replace the `useSyncExternalStore` block with
`useState(false)` + `useEffect(() => setDismissed(readDismissed(locale)))`
on mount. Eliminates ~14 LOC and one esoteric API. **Discuss-first**
(the SSR-mismatch guard in the comment is real; the `useEffect` route
trades it for one extra render, which is fine for a top-bar notice but
the maintainer may have chosen the current form deliberately).

---

## Other

### S12 — Insights sub-pages repeat the same status query in 5 files
`src/app/insights/{blutdruck,bmi,gewicht,puls,stimmung}/page.tsx`

Each sub-page declares the same 13-line block:

```ts
const { data: status, isLoading: isStatusLoading } = useQuery({
  queryKey: ["insights", "<metric>-status", locale],
  queryFn: async () => { const res = await fetch(`/api/insights/<metric>-status?locale=${locale}`); ... },
  enabled: isAuthenticated, staleTime: 60 * 1000,
});
```

Plus the same `interface XxxStatusData` declaration with identical
shape (`hasProvider`, `text`, `cached`, `updatedAt`). The `queryKeys`
factory already has `insightsBpStatus(locale)`,
`insightsWeightStatus(locale)`, etc., but the new sub-pages bypassed
them.

Proposed: extract `useInsightStatus(metricSlug: SubPageSlug)` to
`hooks/use-insight-status.ts`. Routes to the matching `queryKeys.*`
factory, returns `{ data, isLoading }`. Each sub-page collapses 13 LOC
to one call. ~55 LOC total saved and the `queryKeys` factories actually
get used. **Apply-with-care** (touches 5 files + test fixtures; do as
its own commit).

### S13 — `SubPageSlug` type + `SUB_PAGE_SLUGS` array + `SUB_PAGE_METRIC` keys are three statements of the same set
`src/lib/insights/sub-page-metric.ts:22-51`

```ts
export type SubPageSlug = "blutdruck" | "gewicht" | "puls" | "stimmung" | "medikamente" | "bmi" | "schlaf";
export const SUB_PAGE_SLUGS = ["blutdruck", "gewicht", "puls", "stimmung", "medikamente", "bmi", "schlaf"] as const satisfies readonly SubPageSlug[];
export const SUB_PAGE_METRIC: Record<SubPageSlug, string[]> = { blutdruck: [...], ... };
```

Three independent listings of the same 7 slugs.

Proposed: keep `SUB_PAGE_METRIC` as the source of truth; derive both
the array and the type from it:

```ts
export const SUB_PAGE_METRIC = { blutdruck: [...], ... } as const;
export type SubPageSlug = keyof typeof SUB_PAGE_METRIC;
export const SUB_PAGE_SLUGS = Object.keys(SUB_PAGE_METRIC) as SubPageSlug[];
```

Removes ~12 LOC. **Apply-now.**

### S14 — `pickCanonicalSourceRows` carries a same-source "fast path" already covered by the loop
`src/lib/analytics/source-priority.ts:178-181`

```ts
if (pickedRows.length === 1) {
  canonicalRows.push(pickedRows[0]);
  continue;
}
```

The next branch already handles the multi-row case correctly, including
1-row buckets (the `presentDeviceTypes` set has size 1, the ladder walk
picks it, the final filter keeps the row). The fast-path saves one
`Set.add` + one ladder iteration — perf is unmeasurable for the bucket
sizes here (rows-per-day, single-digit).

Proposed: delete the fast path. ~4 LOC, removes one branch from a
already-branchy function. **Discuss-first** (this is judgement: the
fast path documents the intent "single row needs no axis"; removing it
trades 4 LOC for slightly less self-documenting flow).

### S15 — `detectGlp1Plateau` defensively guards against `prisma.medication` being undefined
`src/lib/insights/glp1-plateau.ts:46-49`

```ts
if (typeof prisma?.medication?.findMany !== "function") return null;
```

This guards against test environments mocking only `prisma.measurement`.
The codebase has many other server modules that call `prisma.medication.findMany`
directly without this guard (search confirms). The convention in
HealthLog is to fix the test mock, not to add runtime guards in
production code. The check is harmless but reads as "defensive code
hiding a test-setup smell".

Proposed: drop the guard; update the relevant test's prisma mock to
include `medication.findMany: jest.fn()` so the production path stays
clean. ~3 LOC. **Discuss-first** (test-author may have wanted the
detector to soft-fail rather than crash an analytics route in
edge cases — confirm posture before removing).

---

## Counts per category

| Area | Count | Apply-now | Apply-with-care | Discuss-first |
| --- | --- | --- | --- | --- |
| Source-priority (W8c) | 4 | 2 (S2, S4) | 2 (S1, S3) | 0 |
| AH-server-prep (W8d) | 2 | 2 (S5, S6) | 0 | 0 |
| Health-Score-Provenance (W8e) | 3 | 2 (S7, S8) | 1 (S9) | 0 |
| Translations (W9e) | 2 | 0 | 1 (S10) | 1 (S11) |
| Other | 4 | 1 (S13) | 1 (S12) | 2 (S14, S15) |
| **Total** | **15** | **7** | **5** | **3** |

## Top 5 highest-confidence simplifications

1. **S2** — call `getDeviceTypeLadder` from `pickCanonicalSourceRows`
   instead of inlining the same lookup; removes 8 LOC, prevents drift.
2. **S13** — derive `SubPageSlug` + `SUB_PAGE_SLUGS` from the
   `SUB_PAGE_METRIC` record's keys; removes 12 LOC, single source of
   truth.
3. **S7 + S8** — module-scope `COMPONENT_ORDER`, memoised
   `Intl.DateTimeFormat`, drop dead `try/catch` in the health-score
   card; ~9 LOC, one fewer per-render allocation.
4. **S5** — delete `HK_QUANTITY_TYPE_TO_MEASUREMENT` (verify via grep);
   the same data is one property lookup away from
   `APPLE_HEALTH_TYPE_MAP`. ~8 LOC.
5. **S6** — collapse the sleep-vs-quantity branch in
   `mapAppleHealthEntry` to one base object + optional `sleepStage`
   append. ~8 LOC, one fewer return path.

S10 (i18n duplication) and S12 (insights sub-page status hook) are the
biggest cross-file wins (~25 + ~55 LOC) but each touches multiple
files and should land as standalone commits with their own tests
green-board.
