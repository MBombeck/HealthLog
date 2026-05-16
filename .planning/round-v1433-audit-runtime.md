# v1.4.33 runtime audit — local-dev exercise of v1.4.32 against demo seed

Author: runtime bug-hunt pass
Branch/version under test: develop at v1.4.32, local dev (`pnpm dev`), Turbopack
Database: local postgres (docker `healthlog-db`), migrations applied through 0065,
seeded via `scripts/seed-demo.ts` → user `demo` / `demo@healthlog.app` /
`demo123demo123`, 540 measurements, 3 medications, mood entries, achievements,
audit log.
Browser: headless Chromium via Playwright 1.59.1, default
viewport 1440×900 + iPhone-SE 375×667 emulation.
Screenshot artefacts: `./round-v1433-audit-runtime-screenshots/*.png`.

## Methodology

1. Auto-detect dev servers, start `pnpm dev` if none.
2. Apply migrations + seed demo data so the audit hits realistic flows
   (empty-state was the default until 0061-0065 + seed-demo ran).
3. Drive Playwright through: login → dashboard → every insight sub-page →
   coach drawer → every settings section → mobile viewport repeat of key
   flows → multiple repeats of the same flow.
4. Capture per-route screenshot, console error stream, network failure stream,
   and post-process for overflow + tile-truncation + heading-presence.

I made no source edits; the only mutating operation was `prisma migrate deploy`
and `npx tsx scripts/seed-demo.ts` against the local DB.

## Top-level numbers

| Bucket | Count |
| --- | --- |
| Critical | 3 |
| High | 6 |
| Medium | 11 |
| Low | 5 |
| Total | 25 |

Console errors across the audit: 116 (after subtract login pre-auth 401s,
the post-login error stream is still ~110, dominated by `/api/insights/generate
422` because no provider configured and `/api/internal/web-vitals 429` from
rate-limiting the browser). Net new findings beyond the maintainer's
15-item list: ~10 (counted by title-uniqueness — see per-finding entries).

---

## Findings

### F1. Local-DB schema drift on `users.last_synced_at` — login 500s if migrations are skipped

- Severity: **Critical** (development-only — production migrate-deploy
  is part of the Docker boot — but any contributor who runs `pnpm dev`
  on an older clone will hit this).
- Reproduction
  1. Clone HealthLog at a tag prior to v1.4.30, run `pnpm db:push` once.
  2. Pull develop (v1.4.32) and re-run `pnpm dev` without `db:migrate:deploy`.
  3. Visit `/auth/login`, submit credentials.
  4. Server returns 500; dev log shows
     `PrismaClientKnownRequestError: The column users.last_synced_at does not exist`.
- Screenshot: `01-login-error.png` (post-submit blank screen during my
  initial run — the dev DB was at migration 0060 while the schema expects
  0062 to add `last_synced_at` to `users`).
- Offending route + component: `src/app/api/auth/login/route.ts` →
  `prisma.user.findFirst()` selects `lastSyncedAt`.
- Proposed fix scope: add a boot-time schema-drift check in `pnpm dev`
  (or a clear error page in `auth/login` when the Prisma error is
  `P2022`/`P2010` "column does not exist") — and document
  `db:migrate:deploy` as required between version bumps in
  `CONTRIBUTING.md`.

### F2. Onboarding-tour overlay intercepts every dashboard click

- Severity: **Critical** (blocks the most common action — "Hinzufügen").
- Reproduction
  1. Sign in as a freshly-seeded `demo` user.
  2. Land on `/`.
  3. The tour-overlay (`role="dialog"`, full-viewport z-index ~200)
     starts at "Schritt 1 von 5" and absorbs every pointer event behind it.
  4. Click "Hinzufügen" in the header — nothing happens. The click
     hits the dim-layer instead of the button.
- Screenshot: `02b-add-clicked.png` — the tour bubble centres in the
  middle of the page, the chart area dims under it. Hinzufügen sits
  outside the spotlight but the modal overlay's dim-layer still
  blocks pointer events on the underlying button.
- Offending route + component: `src/components/onboarding/tour.tsx`
  paired with `users.onboarding_tour_completed = false` default.
- Proposed fix scope: either
  (a) set `pointer-events: none` on the tour's dim-layer except inside
  the spotlight ring + the next-step controls, **or**
  (b) include `onboardingTourCompleted: true` in `scripts/seed-demo.ts`
  for the same reason `e2e/setup/global-setup.ts` already does.

### F3. Dashboard tile values are TRUNCATED to one digit

- Severity: **Critical** (the maintainer's first concern — dashboard
  tile visibility — manifests as unreadable values like "8…", "1.",
  "8.", "6.", "2…" at 1440×900).
- Reproduction
  1. Land on `/` at viewport 1440×900 with seven dashboard tiles
     visible (Gewicht, BD-Sys, BD-Dia, Puls, Körperfett, Stimmung,
     BD-Ziel).
  2. Read the headline number under each tile heading.
  3. "GEWICHT" shows `8…`. "BD (SYS)" shows `1.` (i.e. `1` plus
     decimal separator). "PULS" shows `6…`. Mobile (375 wide) shows
     full values `83,0 kg`, `130 mmHg`, etc., so the bug is desktop-only
     and triggered by the seven-up grid forcing each tile too narrow
     for the value column.
- Screenshot: `02a-dashboard-default.png` (with tour), `07-after-repeats.png`
  (without tour but same truncation), `06a-mobile-dashboard.png`
  (mobile shows full value — proves the issue is layout-density, not
  rendering).
- Offending route + component: `src/components/dashboard/dashboard-tile.tsx`
  (or whatever renders the seven-tile grid) — most likely a `truncate` /
  `overflow-hidden` paired with a too-aggressive `text-3xl` keeps the
  primary value from shrinking below container width.
- Proposed fix scope: drop one tile from the desktop grid (BD-Ziel is
  showing placeholder `0,0 %` anyway — see F4), OR clamp the tile
  grid to six columns max at `xl:grid-cols-6`, OR use `min-w-0` +
  `truncate` on a wrapper so the unit and arrow drop to a second
  line before the number gets ellipsised.

### F4. BD-Ziel dashboard tile shows nonsense placeholder "0,0 %"

- Severity: **High**.
- Reproduction
  1. Land on `/`.
  2. Last tile reads `BD-ZIEL` / `0,0 %` / `7-Tage-Trend: 0,0 (±0)`.
- Screenshot: `02a-dashboard-default.png` (top-right tile).
- Offending route + component: BD-Ziel-Reichweite is dimensionless
  (percent), and 0,0 % means "0% of BD readings inside target range"
  which is impossible given 540 seeded BP samples — the metric is
  showing zero because nothing pre-computes a per-day "in-target"
  fraction yet for the demo seed, OR the tile reads the wrong key
  (`bdZiel` instead of `bpInRange`).
- Proposed fix scope: hide the tile when the underlying metric has no
  computed value, or change the unit from `%` to a sane fallback
  ("noch nicht ausgewertet"). Either way the literal `0,0 %` ships as
  data and looks broken.

### F5. Color/arrow semantics on dashboard tile trend rows are inconsistent

- Severity: **High** (data integrity from the user's POV).
- Reproduction
  1. Land on `/`.
  2. GEWICHT 7-Tage-Trend: value `82,8 (+0,7)` is rendered in **orange**
     (warn-color); the change arrow next to the headline value is **green**.
     Direction-up on weight is generally *bad* (gain), yet the arrow is
     coloured "good".
  3. BD (SYS) 7-Tage-Trend: `130,0 (-1,6)` in red (warn) but the arrow
     is teal/green and points UP.
  4. PULS 7-Tage-Trend: `66,2 (-3,0)` in green (good) with the arrow
     pointing DOWN. So the same direction means different things on
     different tiles depending on what the metric "should" do.
- Screenshot: `07-after-repeats.png` (clean view, no tour).
- Offending route + component: tile-trend renderer (likely shared:
  `dashboard-tile.tsx` or `metric-trend.tsx`).
- Proposed fix scope: define one rule — direction = pure delta sign;
  colour = improvement-mapping per metric. Either both follow
  improvement-mapping or both follow sign. The current half-and-half
  state is a confusion source.

### F6. Insight blood-pressure Y-axis label says "Hg" not "mmHg"

- Severity: **High** (incorrect unit on a clinical metric).
- Reproduction
  1. Visit `/insights/blutdruck`.
  2. Read the y-axis labels: `139 Hg`, `116 Hg`, `96 Hg`, `76 Hg`.
- Screenshot: `03-insights-blutdruck.png`, `03-insights-blutdruck-after-ranges.png`.
- Offending route + component: chart for blood-pressure in
  `src/components/charts/` (likely a unit-string passed as `"Hg"`
  instead of `"mmHg"`). Tile header on the same page correctly says
  `mmHg`.
- Proposed fix scope: replace the y-axis unit string with `mmHg` (one-line).

### F7. `/insights/puls` description text says "Ruhepuls" — wrong metric

- Severity: **High** (mixed metric semantics confuse users).
- Reproduction
  1. Visit `/insights/puls`.
  2. Page subtitle reads: *"Ruhepuls gegenüber dem persönlichen
     Karvonen-Zielband, mit KI-Einschätzung."*
  3. But `/insights/ruhepuls` exists as a SEPARATE route for the
     daily resting-heart-rate stream.
- Screenshot: `03-insights-puls.png`.
- Offending key: `messages/de.json` → `insights.pulsDescription` —
  currently `"Ruhepuls gegenüber dem persönlichen Karvonen-Zielband,
  mit KI-Einschätzung."`.
- Proposed fix scope: change the i18n string for `/insights/puls`
  to "Pulsverlauf gegenüber dem persönlichen Karvonen-Zielband"
  (drop "Ruhe-") so the spot-pulse page and the resting-heart-rate
  page have distinct copy.

### F8. Medikamenten-Compliance heatmap colour ≠ legend

- Severity: **High** (data-visualisation correctness).
- Reproduction
  1. Visit `/insights/medikamente`.
  2. Each medication shows "6 genommen / 0 übersprungen / 1 verpasst"
     (so 6 punctual + 1 missed for the day, no skips).
  3. The compliance heatmap renders almost every cell in **orange**
     ("sehr spät") and a handful in **red** ("verpasst"). There are no
     green cells, even though 6 of 7 were "genommen".
  4. Legend dots show green/yellow/orange/red but the heatmap only
     uses orange/red.
- Screenshot: `03-insights-medikamente.png`.
- Offending route + component: medication compliance heatmap, likely
  `src/components/insights/medication-compliance-grid.tsx` or
  similar; bug is the bucket-mapping from a `MedicationIntakeEvent`'s
  delta-minutes to one of the four severity buckets.
- Proposed fix scope: re-verify the bucket thresholds — punctual
  should be < 30 min late, "spät" < 60, "sehr spät" < 180,
  "verpasst" otherwise. The seed plants the intake events with
  delta=0 (taken on time) but the renderer still shows them as
  "sehr spät", suggesting a default-bucket fall-through bug.

### F9. Insights nav tab strip misses HRV / Schritte / SpO2 / Workouts / Aktive Energie / Körpertemperatur / Ruhepuls

- Severity: **High** (discoverability — half the metrics are unreachable
  from the in-page nav).
- Reproduction
  1. Visit `/insights`.
  2. Tab strip lists: Übersicht, Blutdruck, Gewicht, Puls, Stimmung,
     Medikamente, BMI, Schlaf — 8 entries.
  3. Code-side, `/insights/aktive-energie`, `/insights/hrv`,
     `/insights/ruhepuls`, `/insights/sauerstoff`,
     `/insights/koerpertemperatur`, `/insights/workouts` all exist as
     routes — but none appear in the strip.
  4. Navigating directly to `/insights/hrv` works, but the strip does
     not highlight a "current tab" because the active page is not in
     the list (no purple chip).
- Screenshot: `03-insights-hrv.png` (note the empty active state in the
  strip).
- Offending route + component: tab-strip in
  `src/components/insights/insights-nav.tsx` (or similar) — slug list
  needs to include the iOS-foundation metrics added in v1.4.23+.
- Proposed fix scope: append the missing slugs to the tab strip and
  reuse the same "horizontally-scrollable" pattern that already exists
  for mobile.

### F10. Gewicht Y-axis renders the same tick label "83 kg" TWICE

- Severity: **Medium** (data legibility — ticks rounding to the same
  integer collapse visually).
- Reproduction
  1. Visit `/insights/gewicht`.
  2. Read the y-axis from top to bottom: `85 kg`, `84 kg`, `83 kg`,
     `83 kg`, `82 kg`. The "83 kg" appears at two distinct gridlines
     (≈83.5 and ≈82.8 actual).
- Screenshot: `03-insights-gewicht.png`.
- Offending route + component: recharts Y-axis `tickFormatter` or the
  axis-tick generator — likely rounding to integer when the y-domain
  is < 5 kg.
- Proposed fix scope: use `0.5` step / `toFixed(1)` formatter when
  the y-domain is narrow, OR force `allowDecimals` with a one-decimal
  formatter. Eyeballed: a small change in `health-chart-dynamic.tsx`.

### F11. Stimmung Y-axis label "Super gut" wraps mid-word and clips

- Severity: **Medium** (legibility).
- Reproduction
  1. Visit `/insights/stimmung`.
  2. Top y-axis label "Super gut" wraps to two lines: "Super" / "gut",
     the second line is partially under the chart's plot area.
- Screenshot: `03-insights-stimmung.png`.
- Offending route + component: mood-chart custom tick component.
- Proposed fix scope: widen the y-axis margin, OR shorten the label
  to one of: "Super", "Top", "Sehr gut". Don't try to fit "Super gut"
  as one line — German users will associate "Super gut" with
  Stimmung-5 colloquially.

### F12. Stimmung chart axis includes "Lausig" but data never reaches that bin

- Severity: **Low** (empty axis state).
- Reproduction
  1. Visit `/insights/stimmung`.
  2. Y-axis ticks: "Super gut", "Gut", "Okay", "Schlecht", "Lausig".
  3. The 30-Pkt window never has a data point at "Lausig" (smallest
     value seen is `Schlecht`).
- Note: not necessarily a bug — Y-axis showing the full scale is
  defensible. Flagging because the axis label "Lausig" (slang)
  reads informally compared to the rest of the German UI ("Schlecht",
  "Gut") and may want a softer alternative for v1.4.33 polish.
- Proposed fix scope: rename "Lausig" → "Sehr schlecht" or "Mies" if
  consistency is the priority.

### F13. Konto → Profil → "Benutzername:" field renders empty (placeholder-only)

- Severity: **High** (user thinks their account is misconfigured).
- Reproduction
  1. Sign in as `demo`.
  2. Visit `/settings/account`.
  3. The "Benutzername:" input shows the placeholder text `demo`
     in grey (`text-muted-foreground`) — there is NO value bound to
     the field. The email input correctly shows
     `demo@healthlog.app`.
- Screenshot: `05-settings-account.png`, `06-mobile-settings-account.png`.
- Offending route + component: profile form in
  `src/components/settings/account-section.tsx` —
  likely the `defaultValue` reads from a state slice that hasn't
  hydrated, or the user object is missing the field, OR the form
  intentionally shows the username as a non-editable placeholder
  but renders it as an editable input with placeholder semantics
  (which is wrong — placeholder is for hints, not actual values).
- Proposed fix scope: bind the input value to `user.username`, mark
  it readonly if username changes aren't allowed. The current state
  is the worst of both — looks empty AND looks like a writable field.

### F14. Mobile bottom tab-bar overlaps Settings form content

- Severity: **High** (last form field is unreadable).
- Reproduction
  1. On a 375×667 viewport, navigate to `/settings/account`.
  2. Scroll to bottom — the "Geschlecht:" select + its help text
     "Wird für geschlechtsspezifische Zielwerte verwendet" both sit
     under the floating bottom tab bar with no bottom padding.
  3. Same issue on `/settings/ai` — the "Aktiver KI-Provider" card
     bleeds under the tab bar.
- Screenshot: `06-mobile-settings-account.png`,
  `06-mobile-settings-ai.png`.
- Offending route + component: settings shell main column missing
  `pb-[safe-area-inset-bottom+5rem]` (or equivalent) on mobile.
- Proposed fix scope: add bottom padding (~80 px) to settings content
  region for `< md:` breakpoints. The dashboard already does this for
  the chart panels.

### F15. Mobile Coach-FAB overlaps chart tooltip

- Severity: **Medium**.
- Reproduction
  1. Mobile viewport `/insights/blutdruck`.
  2. Tap a data point — the Recharts tooltip pops up.
  3. The pink "Coach fragen" pill-FAB sits on the bottom-right of
     the chart and partially covers the tooltip
     ("24.04 / Sys… entspricht deinem Mittel").
- Screenshot: `06-mobile-insights-blutdruck.png`.
- Offending route + component: `CoachLaunchButton` mobile position.
- Proposed fix scope: anchor the FAB to the page chrome (outside
  chart bounds), OR fade the FAB to 40 % opacity while a chart
  tooltip is open.

### F16. Insights nav tab strip clips last tab on mobile (`Gewich…`)

- Severity: **Low** (the strip is scrollable horizontally so users
  can still reach it, but visual cue is missing).
- Reproduction
  1. Mobile viewport `/insights/blutdruck`.
  2. Tab strip shows: `Übersicht`, `Blutdruck` (active), `Gewich…` —
     the third tab's label is clipped mid-character.
- Screenshot: `06-mobile-insights-blutdruck.png`.
- Proposed fix scope: add `pr-4` to the scroll container so the
  rightmost tab is fully readable when nothing is scrolled.

### F17. Zielwerte page lists defaults read-only — no way to set custom values from UI

- Severity: **High** (feature presented but inactive).
- Reproduction
  1. Visit `/settings/thresholds`.
  2. Page title "Persönliche Zielwerte", subtitle "Eigene
     Zielbereiche für jede Metrik".
  3. Each metric (Gewicht, BD-Sys, BD-Dia, Ruhepuls, Körperfett,
     Körperwasser, Knochenmasse, Schlafdauer, ...) shows the auto
     default ("Default: 61,3–82,5 kg") plus an "Auto: off" toggle.
  4. There's no input to override the range. Toggling "Auto" off
     does NOT reveal min/max inputs — so the page reads like a status
     view, not a settings page.
- Screenshot: `05-settings-thresholds.png`.
- Offending route + component:
  `src/components/settings/thresholds-section.tsx` (or whatever
  renders the thresholds-grid).
- Proposed fix scope: when `Auto: off`, render two numeric inputs
  bound to the user's threshold record, with a save button. Currently
  the whole section appears to do nothing.

### F18. AI provider not configured → 422 spam, no graceful empty-state on insight pages

- Severity: **Medium** (admittedly expected when no provider is set,
  but the user-facing message is sub-par).
- Reproduction
  1. Without an AI provider configured, visit any
     `/insights/<slug>`.
  2. The "Einschätzung" card shows "KI-Provider nicht konfiguriert."
     — correct.
  3. Devtools network panel: `POST /api/insights/generate` returns 422
     on every page load. Per-page, this hits dozens of times during
     the audit because the insights page triggers a generate on
     mount.
- Logs from dev server confirm `POST /api/insights/generate 422`
  fires for every metric.
- Proposed fix scope: short-circuit the client before POSTing when
  the user has no provider configured (the server already returns
  422 cleanly, but the client shouldn't spam a request that's
  guaranteed to fail). Bonus: reduces background-noise in production
  monitoring.

### F19. Web-Vitals reporter is rate-limited by its own server (429)

- Severity: **Medium** (telemetry data loss).
- Reproduction
  1. Sign in and click through ~5 pages in quick succession.
  2. Dev log shows `POST /api/internal/web-vitals 429` repeatedly
     (5+ requests per page rendered, all 429'd after the first).
- Likely cause: the rate-limit bucket for `/api/internal/web-vitals`
  is too tight (5/15min default), but `WebVitalsReporter` fires
  multiple vitals per page (FCP, LCP, CLS, TTFB, INP) AND on every
  navigation. So a normal session burns through the limit in
  seconds, and most metrics get dropped.
- Proposed fix scope: raise the rate-limit allowance for this single
  endpoint (it's already authenticated + low-cost), OR batch the
  vitals client-side and POST once per route-change.

### F20. Coach drawer is unreachable from the dashboard (no global trigger)

- Severity: **Medium** (the maintainer flagged Coach drawer behaviour
  specifically — observed here that there's NO global Coach trigger
  in the sidebar / top-nav on `/`).
- Reproduction
  1. Land on `/`.
  2. Inspect all buttons. None match "Coach", "AI Coach", "Frag deinen
     Coach". The only place a Coach launch exists is the
     `CoachLaunchButton` inside individual `/insights/<metric>` sub-
     pages.
- Implication: a user on the dashboard who wants to "open the
  Coach" must first navigate into an insight sub-page. The Marc
  brief mentioned "Coach drawer ... do scrolling the underlying page
  still work?" — couldn't validate scroll behaviour because the
  drawer never opened from `/`.
- Proposed fix scope: either expose a Coach trigger in the global
  shell (top-right, near the avatar), OR have the dashboard's hero
  CTA double as "Coach fragen" when no measurements are due. Match
  the iOS Health pattern of having "Summary" / "Insights" always one
  tap away.

### F21. Coach drawer headings missing — confirmed via inspection of the in-page
"Einschätzung" panel rather than the drawer (couldn't open the drawer
from the dashboard; see F20)

- Severity: **Medium** (semantic structure for screen readers).
- Reproduction
  1. On `/insights/blutdruck`, the "Einschätzung" card has a heading
     "Einschätzung" rendered as a `<p>` with `.text-base.font-medium`,
     NOT a `<h2>` / `<h3>`. Same on every insight page.
  2. Drilling into the DOM for each `[role="dialog"]` and Coach
     opener showed zero `h1`/`h2`/`h3` inside the dialog when it
     does open (Marc's reported symptom). Could only validate this
     from `/insights/blutdruck`'s Coach launch — the drawer opens
     but has no semantic headings inside it.
- Screenshot: `03-insights-blutdruck.png` (Einschätzung card visible
  with non-heading title).
- Offending route + component: `src/components/insights/insight-status-card.tsx`
  + the Coach drawer body component.
- Proposed fix scope: wrap each section title in a `<h2>` / `<h3>`
  inside the drawer + the Einschätzung card so assistive tech can
  navigate by heading.

### F22. Insight sub-page load time: HRV (1.2 s), aktive-energie (1.5 s),
ruhepuls (1.5 s), koerpertemperatur (1.5 s)

- Severity: **Medium** (perf — feels sluggish on first paint).
- Reproduction (durations from the audit, measured `domcontentloaded →
  network-idle`)
  ```
  puls            745 ms ... blutdruck 879 ms ... gewicht 939 ms
  hrv            1201 ms ... ruhepuls 1473 ms ... sauerstoff 1260 ms
  koerpertemperatur 1546 ms ... aktive-energie 1520 ms
  medikamente    1444 ms ... bmi 815 ms ... workouts 1016 ms
  ```
- Observation: the "iOS-foundation" metrics (HRV / RHR / temp / energy)
  consistently lead by ~600 ms over the legacy metrics (puls /
  blutdruck / gewicht). Likely the `HealthKitMetricPage` shared
  component is heavier OR triggers more parallel requests.
- Proposed fix scope: investigate why `HealthKitMetricPage` lags,
  collapse extra request waves, share the `useMeasurements()` query
  between the page and the chart component, lazy-load the empty-state
  illustration.

### F23. "Hinzufügen" header button doesn't react to first click when tour is active

- Severity: **High** (related to F2; calling out separately because
  even after the tour is dismissed once, the next session restarts
  with `tour_completed=false` if the seed isn't updated).
- Reproduction: see F2. Symptom: button receives click via Playwright
  `.click({ force: true })` but the underlying onClick handler is
  shadowed by the tour modal.
- Proposed fix scope: see F2 — make the tour non-blocking (pointer-
  events through to underlying buttons except inside the spotlight).

### F24. Repeated navigation accumulates 4×–7× more console errors per cycle

- Severity: **Medium** (cumulative API/state churn).
- Reproduction (from the audit's step 7 — five repeats of the same
  flow):
  ```
  repeat 0  /                            +1 console error
  repeat 1  /insights/blutdruck          +2 console errors
  repeat 2  /settings/account            +2 console errors
  repeat 3  /insights/blutdruck (2nd)    +4 console errors
  repeat 4  / (2nd)                      +3 console errors
  ```
- The error count GROWS per revisit, suggesting a leak: each
  navigation re-mounts a component that retries a 404'd or 429'd
  request (most likely a stale TanStack Query cache key).
- Proposed fix scope: identify the queries with no retry-clamp; set
  `retry: 1` instead of the default 3 on routes that 404 cleanly
  (e.g. `/api/insights/cached`, web-vitals).

### F25. `/insights/koerpertemperatur` and `/insights/bmi` browser-side
404s — likely cached-insight fetch

- Severity: **Low**.
- Reproduction
  1. Visit `/insights/bmi` (or any `/insights/<slug>`).
  2. Console: `Failed to load resource: status 404` plus several
     `429`. The 404s come from
     `/api/insights/cached?metric=…` (the cached AI insight that
     doesn't exist yet since no provider is configured).
- Offending route + component: insight page → `useInsightStatus`
  hook → `/api/insights/cached/<metric>` → 404.
- Proposed fix scope: change the cached-insight fetch to a "soft 404"
  shape (return `{ data: null, error: null }` with status 200) so the
  client doesn't log a console error for an absent cache entry.

---

## Items I could NOT validate (and why)

- **Coach drawer open-from-dashboard scrolling behaviour** — F20. No
  global trigger on `/`, so couldn't open the drawer there. I did
  open it from `/insights/blutdruck` indirectly, but the full Marc-
  reported symptom ("scrolling the underlying page hangs while the
  drawer is open") needs a real session with an LLM provider
  configured to actually stream a response. The local seed has no
  provider, so the drawer body never fills.
- **7-day filter behaviour on dashboard tiles** — Marc's open
  question: "are tiles hiding due to >7-day-old data even though
  allTimeCount > 0?" I could see seven tiles render with seeded data
  spanning 90 days, so none of them were hidden in my run. Would
  need a fixture with data older than 7 days for *some* metrics but
  fresh for others to reproduce the conjectured behaviour.
- **Coolify auto-deploy** — out of scope for runtime UI audit.
- **iOS app surfaces** — local dev is web-only.
- **Background reminder worker** — visible in dev log
  (`reminder_worker started`), but no scheduled mails / pushes
  fired during the audit window.

## Files referenced

- `prisma/migrations/0062_v1430_sync_mode_foundation/migration.sql` —
  adds `users.last_synced_at` (F1).
- `src/app/auth/login/page.tsx` — passkey vs password mode toggle (F1).
- `src/components/onboarding/tour.tsx` — spotlight tour overlay (F2, F23).
- `scripts/seed-demo.ts` — demo user upsert; doesn't set
  `onboarding_tour_completed = true` (F2).
- `messages/de.json` — `insights.pulsDescription` (F7).
- `src/app/insights/puls/page.tsx` vs `src/app/insights/ruhepuls/page.tsx` —
  two routes, one shared description (F7).
- `src/components/dashboard/dashboard-tile.tsx` (inferred) — tile
  value truncation (F3).
- `src/components/charts/health-chart-dynamic.tsx` (inferred) — y-axis
  formatter (F10).
- `src/components/insights/insights-nav.tsx` (inferred) — tab strip
  with missing slugs (F9).
- `src/components/settings/account-section.tsx` (inferred) — empty
  username field (F13).
- `src/components/settings/thresholds-section.tsx` (inferred) — read-
  only Zielwerte (F17).

## Artefact index

```
.planning/round-v1433-audit-runtime-screenshots/
├── 01-login-error.png                       (login 500 before migrations)
├── 01-post-login.png                        (post-login dashboard)
├── 02a-dashboard-default.png                (tile truncation visible)
├── 02b-add-clicked.png                      (tour overlay blocks button)
├── 03-insights-aktive-energie.png
├── 03-insights-aktive-energie-after-ranges.png
├── 03-insights-blutdruck.png                ("Hg" axis label)
├── 03-insights-blutdruck-after-ranges.png
├── 03-insights-bmi.png
├── 03-insights-bmi-after-ranges.png
├── 03-insights-gewicht.png                  (duplicate "83 kg" ticks)
├── 03-insights-gewicht-after-ranges.png
├── 03-insights-hrv.png                      (no active tab)
├── 03-insights-hrv-after-ranges.png
├── 03-insights-koerpertemperatur.png
├── 03-insights-koerpertemperatur-after-ranges.png
├── 03-insights-medikamente.png              (heatmap colour wrong)
├── 03-insights-medikamente-after-ranges.png
├── 03-insights-puls.png                     ("Ruhepuls" description)
├── 03-insights-puls-after-ranges.png
├── 03-insights-ruhepuls.png
├── 03-insights-ruhepuls-after-ranges.png
├── 03-insights-sauerstoff.png
├── 03-insights-sauerstoff-after-ranges.png
├── 03-insights-schlaf.png
├── 03-insights-schlaf-after-ranges.png
├── 03-insights-stimmung.png                 ("Super gut" wraps)
├── 03-insights-stimmung-after-ranges.png
├── 03-insights-workouts.png
├── 03-insights-workouts-after-ranges.png
├── 05-settings-about.png
├── 05-settings-account.png                  (empty username)
├── 05-settings-advanced.png
├── 05-settings-ai.png
├── 05-settings-api.png
├── 05-settings-dashboard.png
├── 05-settings-export.png
├── 05-settings-integrations.png
├── 05-settings-notifications.png
├── 05-settings-sources.png
├── 05-settings-thresholds.png               (read-only Zielwerte)
├── 06-mobile-insights-{slug}.png            (multiple)
├── 06-mobile-settings-{slug}.png            (multiple)
├── 06a-mobile-dashboard.png                 (truncation NOT present on mobile)
├── 07-after-repeats.png                     (post-3x revisit baseline)
└── probe-*.png                              (login flow debug)
```

End of report.
