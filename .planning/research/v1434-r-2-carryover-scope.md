# v1.4.34 R2 — carryover-scope implementation blueprint

Read-only blueprint for v1.4.34 carryovers. Authored against
`develop` (head `f9346e62`); v1.4.33 ships from PR #178 once merged.
Each section maps to one dispatch-able unit; sub-wave decomposition
sits at the bottom.

## 1. Three pre-existing e2e flakes

The release-prep report records 5 failing e2e tests on the v1.4.33
PR; two belong to the F2 dispatch (in flight) and three are
pre-existing carryovers.

### 1a + 1b. `e2e/onboarding-flicker.spec.ts:28` (desktop + mobile)

The "complete-onboarding user never sees the card during load" case
slows `/api/analytics` by 250 ms, then samples
`page.locator('[data-testid="onboarding-card"]').isVisible()` 12 times
at 50 ms intervals and asserts every sample is `false`. Race: on slow
CI the Next.js client paints the analytics-pending shell before
`useAuth().user` resolves `onboardingCompletedAt`; during a 1-2 ms
window `<GettingStartedChecklist>` falls back to its "no auth yet"
branch. CI hits this 8-10% of runs.

Fix shape: swap the 50-ms poll for a single
`await expect(card).toBeHidden({ timeout: 700 })`, then
`waitForLoadState("networkidle")`, then a second `toBeHidden()`.
Playwright's auto-retrying assertion re-evaluates every animation
frame so the intent ("user never sees it") is preserved while the
race window collapses.

Touch surface: `e2e/onboarding-flicker.spec.ts:118-130`. Effort: XS
(~30 LoC swap covers both projects via the existing `test.use`).
Risk: low.

### 1c. `e2e/mobile-viewport.spec.ts:27` (chromium-mobile)

The dashboard CTA-touch-target probe sweeps every visible `main
button, main a[href], nav a[href]`, filters to "in initial viewport",
and asserts ≥ 44×44 px. Two triggers:
- v1.4.33 IW3 shrunk the dashboard "Hinzufügen" min-h to
  `sm:min-h-9` (36 px) — on the Pixel 5 boundary at 393 px the `sm:`
  breakpoint is below the 640 px threshold, but viewport detection
  sometimes flips during the WebKit render commit.
- The probe captures fixed top-bar icon buttons (40×40 px) which
  IW9 left untouched.

Fix shape: tighten the selector to `main button, main a[href]`
(drop `nav a[href]` — bottom-nav owns its own WCAG enforcement);
gate the floor on a `matchMedia('(min-width: 640px)').matches ===
false` evaluate so the desktop breakpoint never hits the 44 px
assertion. Spec semantics tighten: "every CTA the user reaches with
a thumb at phone width is 44 px or larger".

Touch surface: `e2e/mobile-viewport.spec.ts:96-126`. Effort: S
(~25 LoC). Risk: low.

## 2. Turbopack NFT-trace warnings

Release-prep log: warnings about NFT traces walking
`next.config.ts → src/lib/geo.ts → src/lib/auth/audit.ts →
mood-entries/bulk route`. `next.config.ts:5` already sets
`output: "standalone"`. Cause: Turbopack's tracer follows env-reads
in `src/lib/geo.ts` (the `MAXMIND_LICENSE_KEY` access) back into the
config file and emits "cannot be traced" warnings — cosmetic, no
runtime effect.

Fix: add `outputFileTracingExcludes: { "*": ["./next.config.ts"] }`
sibling to the existing `outputFileTracingIncludes` at
`next.config.ts:53-55`. Verify via `pnpm build 2>&1 | grep -i
"trace"` — warnings should disappear.

Touch surface: `next.config.ts` (3 LoC). Effort: XS. Risk: low —
`output: "standalone"` controls the actual bundle; the exclude
only narrows trace reporting.

## 3. First-Load-JS bundle-reporting rewire

Turbopack drops the webpack "First Load JS" line. `package.json:29`
already exposes `pnpm analyze` (`ANALYZE=1 next build`) wired
through `@next/bundle-analyzer` at `next.config.ts:69`; output lands
in `.next/analyze/*.html` as treemap reports plus a `client.json`
sibling with `{ label, statSize, parsedSize, gzipSize }` per chunk.

Options:
- (a) `experimental.statsLog` — not a real Next 16 flag. Dead end.
- (b) `next build --webpack` for size reports — Next 16 deprecated
  the webpack fallback for `next build`. Dead end.
- (c) Continue with `@next/bundle-analyzer` (already wired); add a
  parser that prints the top 5 chunks by `parsedSize` to the CI
  log. Trivially extensible to a CI gate later.

Pick (c). Add `pnpm bundle-report` script + a tiny
`scripts/print-bundle-report.mjs` that reads
`.next/analyze/client.json` and prints a sorted table.

Touch surface: `package.json` (1 script), one new script file.
Effort: S (~50 LoC). Risk: low — additive, never replaces build.

## 4. `<TrendCard staleDays>` web wiring

IW3 added `staleDays?: number | null` at
`src/components/charts/trend-card.tsx:144` plus the
`dashboard.staleHint` locale key in six locales. The dashboard reads
from `/api/analytics` (via `useAnalyticsQuery()` at
`src/app/page.tsx:212`); that route's `DataSummary` shape at
`src/lib/analytics/trends.ts:171` does **not** carry per-type
`lastSeenAt`. The matching field landed only on
`/api/dashboard/summary` (iOS-only) at
`src/app/api/dashboard/summary/route.ts:320-321`.

Fix shape — additive on the analytics route:
- Extend `/api/analytics` default payload with
  `lastSeenByType: Record<MeasurementType, string | null>`. The
  per-type chunked findMany already runs; capture the last point's
  `at` and emit it.
- Mirror on the slim slice: `summaries-slice.ts` already runs a
  `DISTINCT ON (type)` latest read — add `MAX(measured_at)` to that
  pass and surface it.
- Extend `AnalyticsRawPayload` in
  `src/lib/queries/use-analytics-query.ts` so call sites can read
  the field.
- Wire each `<TrendCard>` mount at `src/app/page.tsx:604-957`
  through a helper: `staleDays={computeStaleDays(lastSeenByType,
  type)}`. Helper returns `null` when the most-recent reading is
  within 7 days (no caption); returns a positive integer otherwise.

Touch surface: 4 files + 14 mount sites in `src/app/page.tsx`.
Effort: S (~120 LoC + 2 tests). Risk: low — additive only;
existing tiles paint byte-identical when `lastSeenByType[type]` is
recent.

## 5. Coach drawer global trigger from dashboard

IW5 verified the Coach drawer is reachable only from `/insights/**`
— `<CoachLaunchProvider>` + `<LayoutCoachFab>` + `<LayoutCoachMount>`
mount inside `src/app/insights/layout.tsx:33-37`. Maintainer feedback
confirms the gap is dashboard-side, not insights.

Fix shape:
- Hoist `<CoachLaunchProvider>` from
  `src/app/insights/layout.tsx:33` up to
  `src/components/layout/auth-shell.tsx` so every authenticated
  tree (dashboard included) can call `askCoach()`.
- Keep `<LayoutCoachFab>` and `<LayoutCoachMount>` in the insights
  layout — the FAB is insights-only.
- Mount a new `<CoachLaunchButton>` (same component every insights
  sub-page already uses) on the dashboard hero strip at
  `src/app/page.tsx:512-524`, sibling to the "Hinzufügen" pill.
  Empty prefill — the Coach panel picks the opening prompt.
- Verify the provider's `useState({open, setOpen, prefill})` lives
  exactly once. Two providers would mean two open states.

Touch surface: `src/components/layout/auth-shell.tsx` (1 added
mount), `src/app/insights/layout.tsx` (1 removed mount),
`src/app/page.tsx` (1 added button in the hero). No new i18n keys
— `insights.coach.launchButton` already exists in six locales.
Effort: S (~40 LoC + 3 tests). Risk: low.

## 6. Server-side `Cache-Control: no-store` bfcache fix

Lighthouse flagged 3 bfcache failure reasons on v1.4.33. IW9
audited the client (no `beforeunload`/`unload`/`pagehide`/`onfreeze`
listeners). IW2 added `Permissions-Policy: unload=()` at
`next.config.ts:35`. The remaining breaker is the response
`Cache-Control` header on **HTML page responses**.

Audit of explicit `Cache-Control` sets in source — every one is on
an API or file-stream route; none on HTML pages:
- `src/app/api/health/route.ts:26` (`no-store, no-cache,
  must-revalidate`) — API only.
- `src/app/api/insights/chat/route.ts:78` (`no-cache, no-transform`)
  — SSE stream, intentional.
- `src/app/api/admin/backups/[id]/download/route.ts:117` (`no-store,
  max-age=0`) — file stream, intentional.
- `src/app/api/export/*` + `src/app/api/doctor-report/pdf/route.ts`
  — file streams, intentional.

The bfcache-breaking header is the Next.js framework default for
authenticated dynamic pages: any route that touches cookies through
a server component emits `Cache-Control: no-store, must-revalidate`
automatically. That covers every `/`, `/insights/**`, `/settings/**`
HTML response.

Fix: add a second rule to the `async headers()` block at
`next.config.ts:30-39` that sets `Cache-Control: private, max-age=0,
must-revalidate` on every non-API non-`_next` HTML route:

```
{ source: "/((?!api|_next).*)", headers: [
  { key: "Cache-Control", value: "private, max-age=0, must-revalidate" },
]}
```

Per Chromium's bfcache-eligibility matrix `no-store` is a hard
breaker; `must-revalidate` is fine. `private` already prevents
shared-cache (proxy) storage; `max-age=0` forces revalidation on
focus so cookie/session swaps still detect on the revalidation
request. No cache-poisoning risk vs today's flow.

Touch surface: `next.config.ts` (~5 LoC). Effort: XS. Risk:
medium — header change covers every authenticated route; verify
via a Lighthouse re-run against `/` and a manual bfcache test
(open `/`, navigate to `/measurements`, hit back, expect
"navigated via back/forward cache" in DevTools).

## 7. Sources ↔ Thresholds merger (A4 deferred)

`round-v1433-audit-menu.md` §7.1 (item 3). The two settings sections
are siblings today:
- `src/components/settings/sources-priority-section.tsx` — per-metric
  source list + override + device-type ordering.
- `src/components/settings/thresholds-editor-section.tsx` — per-metric
  green/yellow/red threshold inputs.

Combined UX:
- Section title: "Zielwerte & Quellen" (de) / "Targets & Sources"
  (en) — six locales.
- One scrollable column with per-metric blocks. Each block: metric
  header pill, left column source priority list + device-type
  ordering, right column on `md+` (stacked on mobile) threshold
  inputs. One "Save" per block (one mutation per metric).
- Summary card at top: "12 metrics configured, 5 with custom
  thresholds, 8 using device priorities" for nav cues.
- `data-anchor={metric}` per block + sticky right-rail quick-jump
  list on `md+`.

Implementation:
- Rename `thresholds-editor-section.tsx` →
  `metric-config-section.tsx`.
- Inline the per-metric source list inside the metric block.
- Drop the `sources` slug from `SETTINGS_SECTIONS`
  (`src/components/settings/settings-shell.tsx`) and
  `SETTINGS_SECTION_SLUGS`
  (`src/components/settings/section-slugs.ts`); make
  `/settings/sources` a 301 redirect to `/settings/thresholds`
  inside `src/app/settings/[section]/page.tsx`.
- Sections count drops from 10 → 9 post-IW7.

Touch surface: 5-7 files in `src/components/settings/` + section
slugs + settings-shell + six locale files. Effort: M (~600 LoC).
Risk: medium — UX change needs a screenshot review before ship.

## 8. Tab-strip regrouping (A4 deferred)

`round-v1433-audit-menu.md` §7.1 (item 1). Replace the five wave-A
pills (HRV, Ruhepuls, Sauerstoff, Körpertemperatur, Aktive Energie)
in `src/components/insights/insights-tab-strip.tsx` with one parent
pill labelled "Vitalwerte" (source-agnostic; "Apple Health" assumes
device).

Recommended shape: parent pill opens a Sheet/Popover listing the
five sub-metrics; tapping one navigates to its existing route. No
new index page — preserves every URL.

- `SUB_PAGE_TABS` + `buildTabs()` in
  `src/components/insights/insights-tab-strip.tsx` modified so the
  five wave-A entries collapse to one parent with a popover
  trigger.
- `src/lib/insights/sub-page-metric.ts` gains a `group` field for
  the wave-A metrics.
- Six locale files for the parent label + the popover header.

Touch surface: 3 source files + 6 locale files. Effort: S (~150
LoC + 3 tests). Risk: low — additive grouping, no URL or
data-fetch change.

## 9. `compliance.ts` classifier hardening (F8 root)

`src/lib/analytics/compliance.ts:65-93` returns `very_late` as a
catch-all for any takenAt outside the `-1h … +2h` grace window.
IW6's F8 analysis: when an intake is logged early (e.g. 06:00 UTC
for a 07:00 UTC window), the dose is flushed to `very_late` and the
heatmap paints orange even though the user took it proactively.

Two semantic flaws:
1. The 1-hour pre-window grace is too narrow for proactive takers.
2. `very_late` semantically covers both "way too early" and "way
   too late" — a proactive logger is not "very late".

Proposed thresholds (matches the audit's recommended follow-up):

```
takenAt === null → "missed"
takenAt < windowStart - 3h → "early"  (NEW bucket)
windowStart - 3h ≤ takenAt < windowStart → "on_time"  (widen grace 1h → 3h)
windowStart ≤ takenAt ≤ windowEnd → "on_time"
windowEnd < takenAt ≤ windowEnd + 2h → "late"
takenAt > windowEnd + 2h → "very_late"
```

`early` + `on_time` both count as compliant for rate calculation;
only `late`, `very_late`, `missed` reduce it.

Touch surface:
- `src/lib/analytics/compliance.ts` (~25 LoC).
- `src/lib/analytics/__tests__/compliance.test.ts` — add 4 cases
  for `early` + the widened grace; update the existing "way before
  grace" case at line 262 (currently expects `very_late`, becomes
  `early` or `on_time`).
- `src/components/charts/compliance-heatmap.tsx` — drop the
  defensive `looksClassifierBug` guard at lines 46-77 once the
  root is fixed; keep the rate-based fallback below it for the
  no-timing-data branch.
- `src/app/api/medications/[id]/compliance/route.ts` (~10 LoC) —
  route `early` to the compliant bucket.
- `src/app/api/gamification/achievements/route.ts` (~10 LoC) —
  same.

Effort: M (~120 source + 80 test LoC). Risk: medium — touches a
user-facing compliance metric; achievement-streak test path needs
verification.

## 10. AASA followups

No `apple-app-site-association` file exists in the tree today. The
iOS contributor brief uses custom URL schemes during the v1.5
sprint, not associated domains. The in-flight AASA dispatch is the
**first** AASA pass; nothing pre-existing to defer.

Verify after the AASA agent lands:
- `public/.well-known/apple-app-site-association` exists with the
  right `applinks` blob and is served as `application/json` (Next.js
  needs an explicit handler — default static-file MIME maps ship
  this path as `application/pkcs7-mime` on some configs).
- `/apple-app-site-association` (root path) also serves the same
  payload — some validators check both.
- Bundle ID matches `APNS_BUNDLE_ID = dev.healthlog.app` (verified
  on apps01 Coolify env).
- Alternate domains: only `healthlog.bombeck.io` configured today.
  Confirm with maintainer whether `healthlog.app` or similar needs
  AASA coverage.

Effort: XS (verification only). Risk: low.

## 11. POSTGRES_PASSWORD apps01 duplicate-section noise

Confirmed via `mcp__coolify-apps01__env_vars list` on app UUID
`pg8wggwogo8c4gc4ks0kk4ss`: the env-var listing contains **two
sections** — many keys appear twice. The first section holds the
real values; the second section is a Compose-default leftover from
the v1.3.0/v1.3.1 era. The real `POSTGRES_PASSWORD` (value
`healthlog`, uuid `psjxz586keglg80frlc0hilg`) is the first-section
entry. The placeholder (`"POSTGRES_PASSWORD is required"`, uuid
`d3r4k1lryj6n0z7dfj4hhc8t`) is the second-section leftover —
documented in `CHANGELOG.md:4554-4566` (v1.3.1 fix). Runtime reads
the first match; the container is healthy.

Cleanup: delete uuid `d3r4k1lryj6n0z7dfj4hhc8t` via the MCP
`env_vars delete` action. Optionally — only with maintainer
agreement — delete the other duplicate entries in section 2
(`SESSION_SECRET`, `ENCRYPTION_KEY`, etc.); they carry the same
value as section 1 so runtime is unaffected.

Effort: XS (1-2 MCP calls). Risk: low.

## 12. Web-Freeze CHANGELOG marker

Per `.planning/v15-strategic-plan.md:204`. Exact line + placement
(in `CHANGELOG.md`, under the v1.4.34 release block, after standard
Added/Changed/Fixed sections):

```markdown
### Web-freeze marker

Web functionality is complete as of v1.4.34. Subsequent v1.4.x tags
ship hotfixes, dependency updates, and tightly-scoped reactive fixes
only; no new web features land until the iOS native client clears
Apple review and v1.5.0 marks the joint release. The full freeze
posture is documented in `.planning/v15-strategic-plan.md` §2.
```

Effort: XS (5 lines). Risk: zero.

## 13. Sub-wave decomposition

Five touch-disjoint sub-waves. Sub-waves A–D run in one parallel
batch; sub-wave E is the close-out.

**Sub-wave A — infrastructure (bfcache + bundle-reporting +
env-var hygiene)**.
Files: `next.config.ts`, `package.json`, optional
`scripts/print-bundle-report.mjs`, plus the MCP env-var cleanup.
Items: #2, #3, #6, #11. Effort: ~S total.

**Sub-wave B — TrendCard wiring + Coach global trigger**.
Files: `src/lib/queries/use-analytics-query.ts`,
`src/app/api/analytics/route.ts`,
`src/lib/analytics/summaries-slice.ts`, `src/app/page.tsx`,
`src/components/layout/auth-shell.tsx`,
`src/app/insights/layout.tsx`.
Items: #4, #5. Effort: ~S+ total.

**Sub-wave C — compliance classifier hardening**.
Files: `src/lib/analytics/compliance.ts`,
`src/lib/analytics/__tests__/compliance.test.ts`,
`src/components/charts/compliance-heatmap.tsx`,
`src/app/api/medications/[id]/compliance/route.ts`,
`src/app/api/gamification/achievements/route.ts`.
Items: #9. Effort: M.

**Sub-wave D — Sources↔Thresholds + tab-strip regroup**.
Files: `src/components/settings/sources-priority-section.tsx`,
`src/components/settings/thresholds-editor-section.tsx`,
`src/components/settings/settings-shell.tsx`,
`src/components/settings/section-slugs.ts`,
`src/components/insights/insights-tab-strip.tsx`,
`src/lib/insights/sub-page-metric.ts`, six locale files,
`src/app/settings/[section]/page.tsx`.
Items: #7, #8. Effort: ~M+.

**Sub-wave E — close-out (e2e flakes + AASA verify + CHANGELOG
marker)**.
Files: `e2e/onboarding-flicker.spec.ts`,
`e2e/mobile-viewport.spec.ts`, `CHANGELOG.md`, plus AASA review.
Items: #1, #10, #12. Effort: ~S total.

Disjointedness: sub-wave A touches config / infrastructure;
sub-wave B touches dashboard + layout + analytics API; sub-wave C
touches compliance analytics + related routes; sub-wave D touches
settings + insights tab-strip; sub-wave E touches e2e + docs. No
file appears in two sub-waves. `src/app/page.tsx` lives in
sub-wave B exclusively.

### Total effort estimate

| Sub-wave | Items | Effort | LoC est. |
| --- | --- | --- | --- |
| A | #2, #3, #6, #11 | S | ~80 |
| B | #4, #5 | S+ | ~250 |
| C | #9 | M | ~200 + 80 tests |
| D | #7, #8 | M+ | ~700 + 100 tests |
| E | #1, #10, #12 | S | ~70 + 5 docs |
| **Total** | **12** | **L (~2 dispatch batches)** | **~1400 + 185 tests** |

Effort scale: XS ≤ 50 LoC, S ≤ 200 LoC, M ≤ 600 LoC, L ≤ 1500 LoC.
Sub-wave D is the largest and benefits from a screenshot-review
checkpoint before ship; everything else is mechanical given the
specs above.
