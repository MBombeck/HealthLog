# v1.4.40 — UX / response-shape QA findings

**Reviewer scope:** UX + byte-shape verification across W-RSC,
W-INSIGHTS, W-PRIVACY, W-AASA, W-APNS-NOTIFY, W-CONSENT.
**Range:** `v1.4.39.4` → develop HEAD (`8e9a7891`), 55 commits.
**Mode:** read-only.

---

## Severity legend

| Band | Meaning |
| ---- | ------- |
| **BLOCKER**  | Ships a regression iOS / clients can observe — must fix before release. |
| **HIGH**     | UX or shape concern that will surface as a paper-cut within a week. |
| **MEDIUM**   | Cosmetic / hygiene; track for v1.4.41 unless cheap to fold in. |
| **LOW**      | Note for the record; no action expected this cycle. |
| **PASS**     | Verified clean.

---

## 1. Per-tile Suspense boundaries (W-RSC)

**Band: PASS — with two MEDIUM observations.**

- `src/app/page.tsx:1455` wraps every tile cell in
  `<Suspense fallback={null}>` and `:1486` wraps every chart cell in
  `<Suspense fallback={<ChartSkeleton />}>`. Each cell sits inside its
  own `<div key={entry.id}>` wrapper so the boundary is a true
  per-cell island, not a shared row gate. Verified against
  `src/app/__tests__/dashboard-suspense-boundaries.test.ts`.
- The chart-row fallback uses `<ChartSkeleton />`, which is the same
  primitive the `next/dynamic({ loading: … })` contract on the three
  chart components already paints during JS chunk resolution — so
  the fallback layout matches the eventual real chart layout. No CLS
  expected.

- **MEDIUM — tile-strip fallback is `null`, not a tile-shaped
  skeleton.** Today the tile body is synchronous (every TrendCard
  reads from the merged `data` memo gated on the slim + thick
  analytics queries on the parent), so the `null` never paints. But
  the moment a future RSC hoist makes any TrendCard suspend, the
  user will see a 0-px hole inside the grid track until the cell
  resolves, which on a wrapped Pixel 5 layout will collapse the row
  height mid-paint (CLS risk). The wave's own report flags this as
  "structural no-op today" — keep an eye on it the moment one tile
  becomes async.
- **MEDIUM — dashboard still relies on `useMemo` over `slim + thick`
  parallel queries (page.tsx:255–285) rather than independent
  `<Suspense>`-driven streaming.** The per-tile boundary is
  defensive scaffolding; the actual progressive paint Marc wanted
  ("tile-strip first, BD-Zielbereich + glucose tiles stream after")
  is still implemented via two `useQuery` calls + an in-component
  `useMemo` merge that is **all-or-nothing on slim**: if slim's
  `summaries` resolves with content the tile strip paints
  immediately, but BD-Zielbereich + glucose remain `undefined`
  until the thick query lands. That matches the v1.4.39.2 contract
  and is fine for v1.4.40, but **the W-RSC report itself recommends
  the RSC migration for v1.4.41** — confirm that lands on the
  v1.4.41 backlog. Per-tile Suspense is the prerequisite, not the
  end state.

---

## 2. queryKey factory enforcement (W-RSC)

**Band: HIGH — one factory-bypass leak that the test guard does NOT
catch.**

- `src/components/comparison/compare-toggle.tsx:29,55,75` reads /
  invalidates **`["user", "dashboardWidgets"]` as a bare literal**.
  Same shape as `queryKeys.dashboardWidgets()` so the cache actually
  dedups today (good), but the wave's own factory-bypass guard
  in `src/lib/__tests__/query-keys.test.ts:173–177` only walks
  `src/components/charts`, `src/app/page.tsx`, `src/hooks/use-auth.ts`.
  A rename of `dashboardWidgets` to anything else would silently
  break the comparison toggle's read of the saved baseline.
- **Recommendation:** extend `guardedRoots` to include
  `src/components/comparison` (cheap, 1-line PR) **or** migrate the
  three sites to `queryKeys.dashboardWidgets()`. This sits squarely
  in scope for the wave's "no other endpoint is double-queried with
  different keys" verification.

- **PASS** — every other surface the wave touched routes through the
  factory: `app/page.tsx` (moodAnalytics, dashboardWidgets),
  `components/charts/mood-chart.tsx` (moodAnalytics),
  `components/charts/health-chart.tsx` (chartData), and
  `components/charts/medication-compliance-chart.tsx`
  (dashboardMedicationCompliance).
- **PASS** — searched `src` for `"mood-chart-data"` — only matches
  are doc/comment references in `src/components/charts/mood-chart.tsx:319`
  and `src/lib/query-keys.ts:141,146`. The actual queryKey is
  `queryKeys.moodAnalytics()`. The cold-mount dashboard + chart no
  longer fire two requests against `/api/mood/analytics`.

- **LOW** — 154-site long tail outside the guarded scope (settings,
  admin, integrations, medications pages, notifications, etc.)
  still uses bare-literal keys. Wave-deferred to v1.4.41 explicitly.

---

## 3. Six insights route swaps (W-INSIGHTS)

**Band: PASS — three landed, three explicitly deferred with rationale.**

The directive listed six routes; only three of the six are actual
mood-walk sites that the rollup tier can replace.

### 3a. `/api/insights/targets` — **PASS**, byte-shape preserved

Response envelope at `src/app/api/insights/targets/route.ts:1297–1313`:
- `{ targets, pageSummary, bpDiastolic, profile }` — **identical to
  v1.4.39.4**.
- `targets[].type === "MOOD_SCORE" | "MOOD_STABILITY"` still surfaces
  the same `current` / `average30` / `consistency7d` /
  `streakDays` / `insufficientData` keys.
- The rollup-tier branch + coverage-fallback branch + cold-start
  branch all produce the same `ConsistencyOutput` shape.
- Test file `src/app/api/insights/targets/__tests__/route.test.ts`
  (new in `f8de4b05`) pins rollup-fast-path, coverage-fallback,
  no-mood, and the 365-day `distinct` floor.

  - **DST drift note (documented):** rollup `bucketStart` is
    UTC-anchored; legacy `MoodEntry.date` is TZ-anchored. For Berlin
    tenants whose mood timestamps don't straddle UTC boundary the
    two day-keys agree; DST fall-back nights diverge by one calendar
    day. Pinned in the existing `/api/mood/analytics` route-parity
    test. v1.5 per-user-tz bucketing closes the gap. Accept.

### 3b. `/api/insights/comprehensive` — **PASS**, byte-shape preserved

Response envelope (`route.ts:415–438`): 22 top-level keys
(`summaries`, `bmi`, `bmiClassification`, `bpClassification`,
`bpPctInTarget`, `bpTargets`, `weightBpCorrelation`, `scatterData`,
`bpMedicationCorrelation`, `bpMedicationScatterData`, `moodSummary`,
`moodBpCorrelation`, `moodBpScatterData`, `moodWeightCorrelation`,
`moodWeightScatterData`, `moodPulseCorrelation`, `moodPulseScatterData`,
`medications`, `alerts`, `hasProvider`, `dataSpanDays`,
`totalMeasurements`) — **all unchanged**.
- The `moodEntries: moodEntryCount` rename lives **only inside the
  `annotate({ meta: {…} })` audit-log block** (route.ts:410), not in
  the response envelope. iOS / web consumers see no change.

### 3c. `/api/insights/generate` (via `lib/insights/features.ts`) — **PASS**

- The downstream prompt builder (`buildUserPrompt`) consumes the
  same `AggregatedFeatures.mood` block (`avg7`, `avg30`, `latest`,
  `trend30`, `totalEntries`, `coverage`). The rollup tier produces
  the same shape; the v1.4.39 `/api/mood/analytics` already shipped
  the rollup-tier semantic so this swap inherits the same parity
  envelope.

### 3d. Three routes explicitly deferred — **PASS as deferred**

- `/api/insights/cards/route.ts` — no mood query (iOS adapter that
  shares alert-rule input shape).
- `/api/insights/glp1-timeline/route.ts` — reads per-entry
  `tags: string[]`, which the rollup tier doesn't carry. Already
  90-day bounded.
- `/api/gamification/achievements/route.ts` — needs per-entry
  Berlin-anchored `date` key, which the rollup's UTC `bucketStart`
  shifts on DST fall-back nights. Bounded by a 2026-02-20 anchor so
  worst-case row count is manageable.

Deferral rationale documented in `phase-W-INSIGHTS-v1440-report.md`
§"Rolled-up scope decisions" and accepted.

---

## 4. Privacy page (W-PRIVACY)

**Band: PASS — readable on Pixel 5 viewport, operator email
appropriate.**

- `src/app/privacy/page.tsx` — bilingual paired-section layout
  inside a `<main className="mx-auto max-w-3xl space-y-10 px-4 py-8
  md:px-6 md:py-12">` shell. **`max-w-3xl` (768 px) is intentional
  per `IW9` comment** (line 198) — legal/long-form columns read
  better at 70-80 chars per line. On a 393 px Pixel 5 viewport that
  caps line length at the container width (≈ 393 − 32 = 361 px) so
  text wraps to a comfortable ~50-60 chars per line.
- Typography: H2 sits at `text-xl md:text-2xl`, body at `text-sm
  md:text-base leading-relaxed` — matches the rest of the app's
  prose tokens. The Deutsch heading sits as an `uppercase tracking-
  wider` eyebrow above each block, English collapsed under a
  `<details>` with a rotating disclosure indicator. Skim-readable.
- **PASS — Operator email** `mailto:mbombeck@gmail.com` at section 11
  is appropriate for a single-operator self-hosted install per
  feedback memo `feedback_no_pii_in_user_facing.md`: the email **is**
  the contact channel, not a functional alias. The DPA-recommended
  postal-address-on-request pattern is explicit in the body. A
  function alias (`privacy@…`) would imply a team that doesn't
  exist.
- Test file `src/app/privacy/__tests__/page.test.tsx` (17 tests)
  pins the bilingual title, 11 paired sections, HK data-flow path,
  AI-off-by-default + named providers, consent endpoint + 5-year
  retention literal, TLS + HSTS, deletion route + cascade. PII rule
  still enforced.

- **LOW** — collapsed-English `<details>` means an Apple US reviewer
  has to click 11 disclosure triangles to read the English policy
  end-to-end. The W-PRIVACY rationale was explicit ("German body
  first, English under a labelled `<details>`"); flagging as a
  reviewability cost without recommending a change.

---

## 5. AASA file (W-AASA)

**Band: PASS.**

- `src/app/.well-known/apple-app-site-association/route.ts:43–49`
  responds with **`Content-Type: application/json`** (no `charset=`
  parameter — Apple's `swcd` / `aasa-validator` silently refuse
  anything annotated with charset). Verified against the test
  `src/__tests__/api/well-known.test.ts` which pins the exact
  string.
- **`Cache-Control: public, max-age=3600`** — one-hour TTL pairs
  cleanly with Apple's CDN mirror at
  `app-site-association.cdn-apple.com/a/v1/<host>`. Reasonable.
- Payload shape matches SB-4: `applinks.details[0].appID` and
  `webcredentials.apps[0]` share the same `S8WDX4W5KX.dev.healthlog.app`
  prefix via local constant. Test pins that the two App IDs cannot
  drift.

---

## 6. Notifications status endpoint (W-APNS-NOTIFY SB-6)

**Band: PASS, with one HIGH iOS-coordination flag.**

- `src/app/api/notifications/status/route.ts:73–91` initialises the
  `events` map with `Object.fromEntries(EVENT_TYPES.map(...))` — so
  **every known category is always present** in the response (with
  `{ lastDeliveredAt: null }` when no ledger source has data). iOS
  can iterate the keyspace without conditional plumbing. ✓
- `MOOD_REMINDER.lastDeliveredAt` reads from `MoodReminderDispatch`
  ledger; every other category currently returns `null`.
- Test file `src/app/api/notifications/status/__tests__/route.test.ts`
  pins the four required behaviours: 401 unauth, every-known-event-
  type-present, MOOD_REMINDER populates from latest dispatch row +
  scoped to caller, `channels` shape preserved.

- **HIGH (informational only) — only `MOOD_REMINDER` has a per-event
  ledger.** Per the W-APNS-NOTIFY report: `MEDICATION_REMINDER`,
  `MEASUREMENT_ANOMALY`, `COMPLIANCE_LOW`, `WITHINGS_SYNC_FAILED`,
  `SYSTEM_ALERT`, `PERSONAL_RECORD` return `null` until a future
  `NotificationDispatch` table lands. **iOS v0.5.4 will render
  "Never" rows for every category except MOOD_REMINDER even on
  active accounts**. Coordinate with iOS so the empty-state copy
  reflects this — or accept that "Never" is the right UI for the
  v1.4.40 window. Not a blocker; iOS contract is shape-stable.

---

## 7. Consent endpoint (W-CONSENT)

**Band: PASS.**

- Response envelope **`{ data, error, meta }`** is enforced
  uniformly: `POST /api/consent/ai` returns
  `apiSuccess({ id, receipt })` (route.ts:46), `GET .../latest`
  returns `apiSuccess({ kind, receipt })` or
  `apiSuccess({ ai_full, ai_insights_only, ai_coach })` for the
  full keyspace, `DELETE .../latest` returns `apiSuccess({ kind,
  receipt })` or `apiSuccess({ revoked })` for the master sweep.
  All shapes consistent with the project's `apiSuccess`/`apiError`
  envelope convention.
- **POST response strips `artefact`** — `serialiseReceipt`
  (route.ts:68–84) explicitly omits the up-to-64-KB opaque token
  from the wire response. Test pins `expect(body.data.receipt).not
  .toHaveProperty("artefact")` (route.test.ts:159). ✓
- 64 KB artefact cap enforced in `consentPostBody` Zod schema; test
  pins the 400 response when exceeded.
- **Append-only invariant** test in the latest-route spec asserts
  `prisma.consentReceipt.delete` is never called — revoke flips
  `revokedAt` only. Audit trail intact.

- **LOW** — `serialiseReceipt` is imported across files via
  `import { serialiseReceipt } from "../route"` (latest/route.ts:32)
  — fine for now, but if the project moves to a stricter
  per-route-handler boundary the helper should move to
  `src/lib/consent/serialise.ts`. Cosmetic.

---

## 8. iOS contract impact

**Band: PASS — every new / swapped endpoint is shape-additive for
iOS v0.5.4.**

| Endpoint | Change | iOS v0.5.4 impact |
| -------- | ------ | ----------------- |
| `/.well-known/apple-app-site-association` | Populated `applinks.details[0]` (was empty array) | **None** until iOS sets the `applinks:` entitlement (their PB30 phase). |
| `/api/notifications/status` | Added `events: Record<EventType, {lastDeliveredAt}>` alongside existing `channels: ChannelStatus[]` | **Additive.** Existing destructure of `data.channels` works untouched. Spec-compliant per SB-6. |
| `/api/consent/ai` (POST), `/api/consent/ai/latest` (GET/DELETE) | New routes | **Net new** — iOS v0.5.4 doesn't call them yet. Hook-up tracked in iOS PB30. |
| `/api/insights/targets`, `/comprehensive`, `/generate` | Internal swap to mood-rollup tier | **Byte-identical envelope.** iOS Cards adapter unaffected. |
| `/api/notifications/status` adds `interruption-level=time-sensitive` for MEDICATION_REMINDER on the send path (apns.ts), not on this endpoint | Server-side payload field | **Gated on `.p8` APNs key install on Coolify env.** Until that env-secret lands, every dispatch returns `apns_not_configured`. Release notes call this out. |
| Dashboard query-key factory changes (`queryKeys.chartData`, `queryKeys.dashboardMedicationCompliance`) | Internal | **Web-only.** iOS doesn't touch TanStack Query cache. |

**No breaking change for iOS v0.5.4.** Universal Links light up
once iOS ships the `Associated Domains` entitlement.

---

## Summary verdict

| Surface | Band | Action |
| ------- | ---- | ------ |
| Per-tile Suspense | PASS (2 MED) | Track tile-fallback skeleton + RSC migration for v1.4.41. |
| queryKey factory | **HIGH** | Extend `guardedRoots` to `src/components/comparison` OR migrate compare-toggle.tsx — 1 commit. |
| Insights swaps (3 landed, 3 deferred) | PASS | Accepted. |
| Privacy page | PASS (1 LOW) | Ship. |
| AASA | PASS | Ship. |
| Notifications status | PASS (1 HIGH info) | Coordinate iOS empty-state copy. |
| Consent endpoints | PASS (1 LOW) | Ship. |
| iOS contract impact | PASS | No breakage for v0.5.4. |

**Releasable.** The one HIGH is a 5-minute factory-bypass cleanup
on `compare-toggle.tsx`; everything else is either passing or
explicitly deferred with rationale.
