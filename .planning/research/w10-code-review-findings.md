# W10 Code Review — v1.4.25 Findings

Scope: `git log --oneline v1.4.24..develop` at `/Users/marc/Projects/HealthLog`, footprint ≈ 41.8k LOC across 269 files. Migrations 0043–0054 land in this window; the biggest deltas sit in `src/lib/analytics/source-priority.ts`, `src/app/api/analytics/route.ts`, `src/lib/tz/resolver.ts`, the GLP-1 surfaces, the Apple Health mapping, and the per-section sub-page split under `src/app/insights/`. Reviewer rubric stayed strict on (a) Zod-bypass type assertions, (b) timezone-naive helpers that survived the W7 → W7b sweep, and (c) silent fallback paths that mask a missing iOS contract field.

## Summary
- Critical: 0
- High: 2
- Medium: 5
- Low: 6

## Critical findings (MUST fix before tag)

None. The schema migrations (0051–0054) are all additive forward-only DDL, the Zod boundaries are tight, and `apiHandler` defensively probes `NextRequest` so the dev-server force-static crash from v1.4.24 stays fixed.

## High findings (MUST fix before tag)

### H1 — `berlinIsoWeekday()` still hard-codes Europe/Berlin in the analytics route
- File: `src/app/api/analytics/route.ts:596–624`
- Evidence: `BERLIN_DATE_PARTS` is a module-level `Intl.DateTimeFormat` pinned to `timeZone: "Europe/Berlin"`. `berlinIsoWeekday()` consumes that formatter to derive the weekday for the `weightWeekday` correlation hypothesis at line 468. The W7 timezone work threaded `userTz` through the BP, mood, sleep, and pulse aggregators above it (line 41, lines 84/88/321/387/433/440), but the weight-weekday path still buckets a 23:30 NZST weight reading under the Berlin weekday — the user's "Monday weight" can land in Sunday's bucket and the Pearson coefficient is computed against the wrong day-of-week column. Same problem on `dateFromBerlinKey()` line 604 — name is misleading; the function anchors any user-tz day key to UTC midnight, which is correct for sorting but the function name lies about its inputs.
- Recommended fix: thread `userTz` into `berlinIsoWeekday(d, tz)`, build the formatter per-call (or memoise via a Map keyed on `tz`), and rename `dateFromBerlinKey` → `dateFromDayKey`. Adds one parameter at the two call sites (line 468 and the helper itself); the helper already lives next to the `userDayKey` calls that pass `userTz`.

### H2 — `requireAuth()` semantics make non-wildcard Bearer tokens unable to call any unscoped route
- File: `src/lib/api-handler.ts:270–279`
- Evidence: After the wildcard check (`hasWildcardPermission = apiToken.permissions.includes("*")` line 268), the branch `if (!requiredPermission && !hasWildcardPermission) { … throw HttpError(403, "Insufficient permissions") }` fires whenever a route calls `requireAuth()` without a permission scope. Every new W8d route added in this release (`/api/measurements/by-external-ids`, `/api/personal-records`, `/api/medications/[id]/glp1`, `/api/dashboard/glp1`) calls `await requireAuth()` with no argument. Cookie sessions return at line 191 before this branch is reached, so the UI works — but a narrow-scoped iOS API token (anything other than `["*"]`) gets a 403 on every one of these endpoints. The comment block above the branch (lines 258–267) suggests this is intentional defence against scope-less tokens leaking, but the iOS app contract (v1.4.23 W2) is built around exactly these endpoints, and shipping the v1.5 iOS sprint against narrow-scoped tokens will hit a 403 wall the moment any non-cookie request crosses the boundary. Pre-iOS prep depends on this surface being callable.
- Recommended fix: either (a) seed every new W8d route with an explicit scope name and update `requireAuth("scope")` callers, or (b) flip the branch logic so unscoped routes default to "any authenticated token works" and the explicit-scope routes 403 on missing scopes. Option (a) is the safer security stance and matches the comment intent; either way the contract decision should land before v1.5 P1 starts.

## Medium findings (MUST fix before tag — Marc directive: all Medium+ applied)

### M1 — `parseSourcePriority` merge order doesn't match the documented "metricPriority wins" claim
- File: `src/lib/validations/source-priority.ts:267–304`
- Evidence: The docblock at line 264–270 states "Merge order (high → low): 1. raw.metricPriority (W8c nested shape; canonical going forward) 2. raw top-level flat keys (W5e backward-compat) 3. DEFAULT_SOURCE_PRIORITY". The implementation in `buildResolved` (line 294) spreads `{...DEFAULT_SOURCE_PRIORITY, ...flat, ...nested}` — which gives `nested` priority. That matches the doc. But the merged object is then `merged: Required<MetricPriority>` and the function returns `{ ...merged, metricPriority: merged, deviceTypePriority }`. So `metricPriority` on the resolved shape mirrors `merged`. Fine for now — but if a future caller stamps `resolved.metricPriority.weight = [...]` after `parseSourcePriority()` returns, the spread breaks the alias because the top-level `merged` keys are now copies, not references. The `metricPriority` key and the flat keys at the same level point to the same underlying object via the merge but are semantically two views. Behaviour is correct today; the alias-vs-copy invariant should be documented.
- Recommended fix: deep-freeze the resolved object (`Object.freeze(merged); Object.freeze(deviceTypePriority);`) so a caller who mutates the result trips at runtime instead of silently desyncing the two views. One line; no API change.

### M2 — Plateau detector picks `meds[0]` silently when the user has multiple active GLP-1 prescriptions
- File: `src/lib/insights/glp1-plateau.ts:56–66`
- Evidence: `meds[0]` after `findMany` with no explicit `orderBy`. Prisma's implicit order is undefined; a user with two active GLP-1 entries (e.g. Mounjaro + Saxenda for combination therapy, rare but the Coach prompt already considers it at `glp1-snapshot.ts:286`) gets a non-deterministic plateau report whose drug name flips between LLM calls. The plateau prompt then names the drug verbatim (line 130, line 144) — so the daily briefing can say "Mounjaro 7.5 mg plateau" one morning and "Saxenda 3.0 mg plateau" the next without the underlying data changing.
- Recommended fix: add `orderBy: { createdAt: "desc" }` (or `name: "asc"`) so the pick is stable, and return one block per active GLP-1 in the future. The `Glp1SnapshotBlock` shape already carries `medications: Glp1MedicationBlock[]`; reusing that for the plateau detector keeps the contract symmetric.

### M3 — `predictNextInjection` uses UTC midnight as the day anchor — can drift one day for users east of UTC
- File: `src/lib/ai/coach/glp1-snapshot.ts:215–243`
- Evidence: Line 218 constructs `new Date(lastInjection.date + "T00:00:00Z")` — interpreting the stored ISO date in UTC. For a user in `Pacific/Auckland` (+12) whose `isoDate(d)` at line 196 also resolves to UTC (`.toISOString().slice(0, 10)`), the anchor floors to UTC midnight but the user's local day is the day after. The weekday projection (line 223 loop) then lands one day early. The whole helper bypasses the W7 `userDayKey` resolver.
- Recommended fix: thread `tz` from the caller (the snapshot builder already reads `user.timezone` upstream — pass it through to `buildGlp1SnapshotBlock` and `predictNextInjection`). Replace `isoDate(d)` with `userDayKey(d, tz)` and the manual `T00:00:00Z` anchor with a per-tz parse. The same fix retires the `isoDate` helper (lines 196–198) for this file.

### M4 — `createMeasurementSchema` lacks `deviceType` even though the column exists and the W8c picker reads it
- File: `src/lib/validations/measurement.ts:198–221`
- Evidence: `Measurement.deviceType` (schema line 355) is read by `pickCanonicalSourceRows` (`source-priority.ts:189–204`). The batch ingest endpoint accepts `deviceType` via its own ad-hoc `batchEntrySchema` (`/api/measurements/batch/route.ts:58`). But the manual measurement POST (`createMeasurementSchema` consumed by `/api/measurements` POST) silently drops the field. The single-entry manual path is the route the existing iOS app used pre-v1.4.23 and the route any external integration would still hit — they cannot tag rows with device-type today. The mismatch surfaces as one source of `deviceType: NULL` rows even when the client tried to set it.
- Recommended fix: add `deviceType: deviceTypeEnum.nullable().optional()` to `createMeasurementSchema`, thread it through `POST /api/measurements`, and document the field in `routes.ts` OpenAPI registration. The change is forward-additive and unblocks the single-entry path for the iOS app + any future ingest source.

### M5 — `apiHandler`'s `as NextResponse` cast can produce a wrong type when handlers return a plain `Response`
- File: `src/lib/api-handler.ts:145–147`
- Evidence: Line 145 `const nr = response as NextResponse;` followed by `nr.headers.set("x-request-id", evt.getRequestId());`. The handler's return type is `Promise<Response>` (the generic `T extends (...args: any[]) => Promise<Response>`), so a handler legitimately returning a plain `new Response(...)` (e.g. the CSV export routes that bypass `apiSuccess` envelope) would be cast to `NextResponse` and the `headers.set` call would succeed at runtime (plain `Response.headers` is a `Headers` instance and exposes `.set`) but TypeScript loses the safety contract. `response` may also be `undefined` in the `finally` block on line 137 — the cast forces past that, which is exactly the kind of `as` Marc has flagged in past reviews.
- Recommended fix: replace the cast with `if (response) response.headers.set("x-request-id", evt.getRequestId());` (`Response.headers` is a `Headers` instance, so the call works on the base type — no `NextResponse`-specific API is needed here). Pruning the cast removes the only `as NextResponse` in the file.

## Low findings (deferred to v1.4.26 backlog)

### L1 — Eager-bundled locale JSON adds ~675 KB to every client bundle
- File: `src/lib/i18n/context.tsx:15–29` — all six locale JSON files imported synchronously and held in `allMessages`. Tree-shaking can't trim them because every entry in the `allMessages` map is reachable through `t()`. Deferred to v1.4.26 as a code-split task; would require lazy `import()` per active locale and a hydration-flash mitigation.

### L2 — `formatDayTick` constructs `new Date(y, m - 1, d)` using local-server time
- File: `src/components/insights/sleep-stage-stacked-bar.tsx:117` — the constructed Date uses the SSR server's timezone, then `toLocaleDateString(locale)` reformats it. For a user in `Asia/Tokyo` viewing a server rendered in `Europe/Berlin`, the weekday tick can shift by one. Cosmetic — affects only the x-axis label, never the analytics input. Defer to v1.4.26 when the chart-x-axis-tick helper gets a full audit pass.

### L3 — `COMPONENT_ORDER` is recreated every render in `<HealthScoreCard>`
- File: `src/components/insights/health-score-card.tsx:182–187` — declared inside the component body. Trivially fixed by hoisting to module scope. Defer because the array is constant and the linter doesn't flag it.

### L4 — `__testables.WEEKDAY_KEYS` exported but unused
- File: `src/lib/ai/coach/glp1-snapshot.ts:72, 406` — `WEEKDAY_KEYS` is declared as a `const` and re-exported on `__testables` but no caller (production or test) reads it. Dead code per the existing `eslint:no-unused-vars` rule — likely a leftover from W4d. Delete in v1.4.26.

### L5 — `coach.batch.too_large` errorCode reused on a non-coach route
- File: `src/app/api/measurements/batch/route.ts:102` — the iOS batch ingest emits `errorCode: "coach.batch.too_large"`, but the route is the Apple Health measurement batch path, not the Coach. The errorCode namespacing should be `measurement.batch.too_large` (the symmetric DELETE route at `by-external-ids/route.ts:64` already uses the right namespace). Cosmetic; defer to v1.4.26.

### L6 — `detectGlp1Plateau` has zero direct test coverage
- File: `src/lib/insights/__tests__/glp1-plateau.test.ts` — covers `buildGlp1PlateauPrompt` (the deterministic string formatter) but not `detectGlp1Plateau` (the Prisma-driven window arithmetic, the `meds[0]` pick, the threshold comparison). All three of the M2 / M3-class regressions would slip through. A vitest spec with a mocked `prisma.medication` + `prisma.measurement` would close this; defer because the surface ships behind a feature flag (no production user has a `MedicationCategory.GLP1` row in v1.4.25 yet).

## Things done well (carrot — boosts confidence in the reviewer rubric)

1. **Source-priority two-axis picker (`src/lib/analytics/source-priority.ts`)** — exemplary code: the algorithm is documented with the W8c rationale inline, the fast-paths (`pickedRows.length === 1`, `hasAnyKnownDeviceType`) are short-circuited explicitly with comments naming the data shape they handle, and the per-bucket ladder cache (`ladderCache`) saves repeated `resolveLadder` calls without sacrificing readability. Integration tests at `tests/integration/source-priority-two-axis.test.ts` plus the 413-line `__tests__/source-priority.test.ts` cover every documented edge case (empty input, malformed JSON, no priority-listed source, custom ladder missing the present types, etc.).
2. **Zod validation discipline** — every new persisted shape (`source-priority.ts`, `doctor-report-prefs.ts`, `coach-prefs.ts`, `workout.ts`, `admin.ts`) ships a `parseXxx()` helper that `safeParse`s the raw and falls back to a documented default on `success === false`. No silent `JSON.parse(...) as T` calls anywhere in the new persistence code.
3. **Migration hygiene (0051–0054)** — every new migration is forward-only additive (new column, new table, new enum value via `ADD VALUE IF NOT EXISTS`). No rename / drop / type-change. Schema docblocks inline-cite the research outline for every non-trivial choice (`GeoJSON LineString as JSONB` rationale at `0053:24–28`, `device_type as TEXT` rationale at `0051:10–13`).
4. **Health-score provenance design (`src/lib/analytics/health-score.ts:285–411`)** — the attribution layer is purely additive: the original `HealthScoreInput` callers still work without supplying `attribution`, and the redistribution helper renders the "as of" anchor falling back to `windowEndAt`. The "manual" implicit default for present-but-unattributed values is documented (line 343) and matches the v1.0 pre-Withings reality.
5. **Apple-health mapping table + deferred set (`src/lib/measurements/apple-health-mapping.ts:319–401`)** — every deferred HK identifier is paired with the planned-shipment release in the inline comment, the test (`__tests__/apple-health-mapping.test.ts`) flags double-bookings, and the upstream-attribution block at lines 15–24 cites both MIT and Apache-2.0 origins correctly. Compliance hygiene the iOS team will thank Marc for.
