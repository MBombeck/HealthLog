# v1.4.37 UX audit

Eleven UX issues Marc reported against the live app
(`https://healthlog.bombeck.io`, v1.4.36). Each item names the source
file + line, the current state, the recommended fix, and how to verify.

## Summary

1. P1 — HealthScoreCard not as tall as left column → `src/components/insights/hero-strip.tsx:170` + `src/components/insights/health-score-card.tsx:259`
2. P2 — Sidebar 3-dot menu wraps "Benachrichtigungs-Center" → `src/components/layout/sidebar-nav.tsx:120` + `src/components/ui/dropdown-menu.tsx:77`
3. P2 — Targets card has ~36 px dead gap between header + value → `src/components/targets/target-card.tsx:418` + `src/components/ui/card.tsx:23`
4. P3 — `<SelectTrigger>` chevron sits tighter to the right edge than the native date-input glyph → `src/components/ui/select.tsx:44`
5. P2 — Mood mini chart sits ~12-16 px taller than BP/weight tiles in the Trends row → `src/components/charts/mood-chart.tsx:548` vs `src/components/charts/health-chart.tsx:1119-1121`
6. P1 — `/insights/bmi` status spins up to 20 s on every cold mount → `src/lib/insights/bmi-status.ts:118-145` + `src/components/insights/insight-status-card.tsx:42-53`
7. P3 — Dashboard "Hinzufügen" button hugs the top of a 2-line title block on mobile → `src/app/page.tsx:529`
8. P2 — Timezone picker still surfaces the "Übernehmen" button → `src/components/settings/timezone-picker.tsx:122-137` + `src/components/settings/account-section.tsx:454`
9. P1 — Coach feature flag misses three render paths → `src/components/insights/hero-strip.tsx:217-228`, `src/components/targets/target-card.tsx:664-673`, `src/app/targets/page.tsx:285-290`
10. P1 — Admin sign-in overview prints `—` for Standort on every row → `src/lib/jobs/geo-backfill.ts` (never scheduled) + `src/lib/api-response.ts:126-153` (no `cf-connecting-ip` branch)
11. P2 — Mounjaro card omits the take-now / overdue status pill that Ramipril shows → `src/components/medications/glp1-medication-card.tsx:296-312` vs `src/components/medications/medication-card.tsx:429-456`

---

## Item 1 — HealthScoreCard height parity

- File: `src/components/insights/hero-strip.tsx:166-172` (parent uses
  `md:flex-row md:items-stretch`).
- File: `src/components/insights/health-score-card.tsx:235-258` (card
  declares `flex h-full flex-col`); `:581` (`mt-auto` on disclaimer).
- Current: contract reads correct, but the inner column has its own
  tight `gap-3` (line 259) and the disclaimer's `mt-auto` only pushes
  the disclaimer down — the headline number + sub-bars stay packed at
  the top so the card visibly finishes short of the left column.
- Recommended fix: on `health-score-card.tsx:259` swap `flex flex-1
  flex-col gap-3` → `grid flex-1
  grid-rows-[auto_auto_auto_auto_auto_1fr_auto] gap-3` and let the
  provenance accordion (currently row 6 in source order) take the
  `1fr` slot. The headline stays at the top, the disclaimer pinned at
  the bottom, and the slack lives in the accordion row.
- Test: `/insights` at 1280 / 1440 / 1920. Confirm
  `[data-slot="health-score-card"]`'s `.bottom` matches
  `[data-slot="insights-hero-strip-prompts"]`'s `.bottom` within 1 px.

## Item 2 — Sidebar 3-dot overflow menu wraps

- File: `src/components/layout/sidebar-nav.tsx:117-122` (sets
  `className="w-56"` on DropdownMenuContent); `:140-145` (Bell ⇒
  `nav.notifications`).
- File: `src/components/ui/dropdown-menu.tsx:77` (item primitive
  carries `gap-2 px-2 py-2 text-sm min-h-11` — no `whitespace-nowrap`).
- File: `messages/de.json:173` — `"notifications": "Benachrichtigungs-
  Center"` (23 chars).
- Current: 14-rem (224 px) container plus Bell icon + mr-2 + px-2 +
  text-sm renders right at the ceiling; sub-pixel rounding wraps the
  hyphenated string to two lines.
- Recommended fix: add `whitespace-nowrap` to the primitive at
  `src/components/ui/dropdown-menu.tsx:77` (catches every dropdown
  app-wide including top-bar `w-48`) and bump the sidebar menu
  container from `w-56` → `w-60` (240 px) at
  `src/components/layout/sidebar-nav.tsx:120`.
- Test: Pixel-5 + iPhone-13-mini. Open sidebar 3-dot; the
  Benachrichtigungs-Center row stays one line.

## Item 3 — Targets page header gap

- File: `src/components/targets/target-card.tsx:411-416` (Card carries
  `flex h-full flex-col` only); `:418` (CardHeader has `gap-2 pb-3
  sm:gap-3`).
- File: `src/components/ui/card.tsx:23` (primitive `gap-4 md:gap-6
  py-4 md:py-6`).
- Current: distance between header bottom (status pill row) and the
  big-number value = `CardHeader pb-3` (12 px) + Card primitive
  `gap-6` (24 px) = **36 px on md+**. This is the "großer Space" Marc
  reports.
- Recommended fix: on `target-card.tsx:412-416` add the override
  `className="flex h-full flex-col gap-3 md:gap-4"` to the Card, then
  drop `pb-3` from the CardHeader at line 418 to `pb-0`. Yields ~16 px
  rhythm.
- Test: `/targets` at 1280 / 1920 / 393. Distance between status pill
  and headline number ≤ 16 px on md+.

## Item 4 — Pull-down arrow right-margin parity

- File: `src/components/ui/select.tsx:44` (trigger `px-3 py-2` with
  `ChevronDownIcon` at line 51 — 12 px from the right edge).
- File: `src/components/ui/native-select.tsx:41` (native chevron, OK).
- File: `src/components/ui/date-input.tsx:35-36` +
  `src/components/ui/input.tsx:69-76` (browser calendar glyph ~16-20 px
  effective gutter on Chromium).
- Current: shadcn `<SelectTrigger>` chevron reads visually tighter
  than the browser-native date-input calendar icon. NativeSelect
  matches the date input (browser-controlled).
- Recommended fix: on `src/components/ui/select.tsx:44` change `px-3
  py-2` → `pl-3 pr-2.5` and add `[&_svg:last-child]:mr-1` so the
  chevron gets 4 px of extra trailing space. Alternatively bump
  trigger to `px-3.5 py-2`.
- Test: place a `<Select>` next to a `<DateInput>` (e.g.
  `/settings/account` has both on the same form). Right edge of
  trigger icon should sit within 2 px of the calendar glyph.

## Item 5 — Trends-row card size mismatch (Mood vs BP/Weight)

- File: `src/components/insights/trends-row.tsx:129-200` (grid).
- File: `src/components/charts/health-chart.tsx:1119-1121` (mini-mode
  → bare `div` with `border p-2`, no Card chrome).
- File: `src/components/charts/mood-chart.tsx:530-553` (mini-mode →
  `<Card className="gap-1 rounded-md py-2 shadow-none">` + CardHeader
  `px-2 pb-1 [&]:gap-0.5` + CardContent `px-2`).
- Current: HealthChart mini paints 8 px outer pad with no inner
  scaffolding. MoodChart mini stacks Card `py-2` (16 px outer) + Card
  `gap-1` (4 px) + CardHeader `pb-1` (4 px) on top of its title row.
  Mood ends ~12-16 px taller than the BP/weight siblings.
- Recommended fix: on `mood-chart.tsx:548` replace the Card override
  with `"gap-0 rounded-md py-1 shadow-none border-border"` and on
  line 553 the CardHeader override with `"px-2 pb-0 [&]:gap-0"`. Longer
  term: make `<MoodChart mini>` short-circuit before the Card mount
  and emit the same bare `border p-2` div HealthChart mini paints; a
  Vitest snapshot can then pin both shells together.
- Test: `/insights` at 1280 / 768 / 393. Measure the `.top` of every
  `[data-slot="trends-row-chart-slot"]`; bp/weight/mood must match
  within 1 px.

## Item 6 — Insights BMI status stuck on "laden"

- File: `src/app/insights/bmi/page.tsx:46` (hook); `:122-130` (status
  card mount with `loading={isStatusLoading}`).
- File: `src/hooks/use-insight-status.ts:67-87` (`retry: 0`, 60 s
  staleTime).
- File: `src/lib/insights/bmi-status.ts:118-145` (per-day cache
  lookup); `:274-300` (LLM call with `STATUS_PROVIDER_TIMEOUT_MS =
  20_000`).
- File: `src/components/insights/insight-status-card.tsx:42-53`
  (loading branch = centred spinner + "common.loading").
- Current: when today's day-key isn't in the cache (post-deploy, post-
  midnight, locale mismatch) the route falls through to a 20 s
  timeout race. The client paints the centred-spinner loading branch
  for the full duration. On `raced.timedOut` the route returns the
  no-key fallback text but does NOT persist it, so every subsequent
  mount re-fires the same 20 s race.
- Recommended fix: (a) UI — swap the spinner branch at
  `insight-status-card.tsx:42-53` for a 4-line skeleton matching the
  rendered card geometry so the user perceives progress; (b) data —
  on `bmi-status.ts:294-300` write a stub cache row keyed to today on
  `raced.timedOut` so the next mount short-circuits at line 124-145;
  (c) long-term — move per-metric status generation off the request
  path into a pg-boss pre-warm job (template:
  `rollup-full-backfill` from v1.4.35.1). Same pattern applies to
  every `/api/insights/<metric>-status` route, not just BMI.
- Test: `/insights/bmi` cold mount on a fresh boot. After the first
  day-warmup the network call should land in < 1 s. The loading state
  must paint structured skeleton, not a centred spinner.

## Item 7 — Dashboard "Hinzufügen" button placement

- File: `src/app/page.tsx:529` (`flex items-start justify-between
  gap-4`); `:551-558` (Button `size="default"
  className="min-h-11 sm:min-h-9"`).
- Current: at < sm the title `text-2xl font-bold` (line 531) plus the
  welcomeText sub-line wraps to two lines and the button hugs the top
  edge. Visually the button "floats" without a baseline anchor on
  mobile.
- Recommended fix: on `src/app/page.tsx:529` change `flex items-start
  justify-between gap-4` → `flex items-center justify-between gap-4
  sm:items-start`. Centres the button against the 2-line title block
  at < sm; on sm+ returns to the current top-aligned posture (where
  the title is one line).
- Test: dashboard at 280, 320, 393, 768, 1280, 1920. Button vertical
  centre matches the title-block centre on mobile; top-aligns on sm+.

## Item 8 — Berlin/Browser timezone "Backen" removal

- File: `src/components/settings/timezone-picker.tsx:96-141` (picker
  with `<NativeSelect>` + `<Button>` "Browser-Zeitzone übernehmen");
  `:78-91` (legacy free-text fallback branch carries the same button).
- File: `src/components/settings/account-section.tsx:71` (`useState
  Europe/Berlin`); `:131-134` (bootstrap effect); `:454` (picker
  mount).
- File: `messages/de.json:1668-1672` (keys: `settings.timezone`,
  `settings.timezoneHint`, `settings.timezoneDetect`,
  `settings.timezoneDetectAria`, `settings.timezoneInvalid`).
- File: `src/lib/tz/format.ts` (`detectBrowserTimezone`,
  `listSupportedTimezones`).
- File: `src/app/api/auth/me/timezone/route.ts` (PUT remains).
- Current: every user sees a dropdown + a button. Marc wants the
  button removed and the timezone seeded from the browser silently
  (still overridable via the dropdown).
- Recommended fix:
  - On `timezone-picker.tsx:122-137` (and `:78-91`) retire the
    `<Button>` block. Keep `<Label>` + `<NativeSelect>` + the hint
    line.
  - In `account-section.tsx:131-134`, extend the bootstrap effect:
    when `user.timezone === "Europe/Berlin"` AND
    `detectBrowserTimezone()` returns a non-Berlin zone, auto-seed
    the form. Save on the next form submit.
  - Delete `messages/de.json:1670-1671` (timezoneDetect /
    timezoneDetectAria); mirror in `messages/en.json`. Keep
    `:1668-1669` (timezone, timezoneHint) and `:1672`
    (timezoneInvalid).
  - `detectBrowserTimezone` stays — consumed by the auto-seed.
- Test: fresh user on a non-Berlin browser opens `/settings/account`.
  Picker is pre-seeded to the browser zone with no manual click. The
  "Übernehmen" button must not appear in either locale.

## Item 9 — Coach disable cascade

- Flag shape: `src/hooks/use-feature-flags.ts:21-22` and
  `src/lib/feature-flags/index.ts:90` (server resolve from
  `assistantCoachEnabled`).
- Already gated correctly:
  `src/components/insights/coach-launch-button.tsx:52`,
  `src/components/insights/layout-coach-mount.tsx:42`,
  `src/components/insights/layout-coach-fab.tsx:44`.
- Missing gates:
  - `src/components/insights/hero-strip.tsx:217-228` — "Ask the
    coach" button renders whenever `onAskCoach` is supplied; the
    parent `src/app/insights/page.tsx:240-249` always supplies it
    regardless of `flags.coach`. Needs `flags.coach` short-circuit.
  - `src/components/insights/suggested-prompts.tsx` (mounted from
    hero-strip line 247) — chips render unconditionally; they
    should hide when `!flags.coach`.
  - `src/components/targets/target-card.tsx:664-673` — per-card
    Coach CTA gated on `aiEnabled` only; needs `flags.coach`.
  - `src/app/targets/page.tsx:285-290` — `<CoachDrawer>` mounts
    regardless of the flag. Wrap the JSX in a `flags.coach` guard.
  - `src/components/insights/health-score-card.tsx:147-157` — the
    `onAskCoach` prop is still threaded for tests even though the
    inline button retired in v1.4.27. Not a render bug today but
    the prop drilling should also short-circuit so a future
    re-addition can't leak.
- Recommended fix: add `const flags = useFeatureFlags(); if
  (!flags.coach) return null;` (or the relevant guard) at every site
  above. Add a Vitest unit that walks
  `src/components/insights/**.tsx` + `src/components/targets/**.tsx`
  and asserts every `useCoachLaunch` import is paired with a
  `flags.coach`-gate; negative test would have caught this.
- Test: admin → Feature flags, Coach = off. Walk dashboard,
  `/insights`, every `/insights/*` sub-page, `/targets`,
  `/medications`, `/admin`. Assert `[data-slot^="coach-"]` element
  count = 0 in the DOM.

## Item 10 — IP-whois resolution under Admin → Sign-in overview

- File: `src/components/admin/login-overview-section.tsx:489-490`
  (renders `entry.location ?? "—"`).
- File: `src/app/api/admin/audit-log/route.ts:134-148` (route emits
  `location`).
- File: `src/lib/auth/audit.ts:21-61` (fire-and-forget update on
  write).
- File: `src/lib/geo.ts:320-373` (resolvers: offline MMDB → ipwho.is
  → null).
- File: `src/lib/jobs/geo-backfill.ts:48-120` (helper exists, **never
  scheduled** — grep across `src/queues/`, `src/lib/scheduler/`, and
  the codebase returns only the test file).
- File: `src/lib/api-response.ts:126-153` (`getClientIp` reads XFF +
  x-real-ip; **does not consult `cf-connecting-ip`**).
- Root causes:
  1. Historical rows that landed before v1.4.27 (and rows where the
     fire-and-forget update missed) sit at `location IS NULL`
     forever — there is no scheduled backfill.
  2. Behind Cloudflare, the visitor IP arrives via
     `CF-Connecting-IP`. `getClientIp` reads XFF (chain length 1
     after Caddy) and x-real-ip; neither carries the visitor IP, so
     `ipAddress` is null and the geo lookup never even attempts.
- Recommended fix:
  - Schedule `runGeoBackfill` as a pg-boss job on a 1-hour cadence
    (same lib pattern as the v1.4.35.1 `rollup-full-backfill`
    queue). The helper is idempotent and capped at 5 000 rows per
    pass per its own docs at lines 22-29.
  - Add a `cf-connecting-ip` branch to `getClientIp` in
    `src/lib/api-response.ts` before the XFF block. Gate behind a
    `TRUST_CF_CONNECTING_IP=1` env so self-hosters behind non-CF
    proxies don't trust a forged header by default.
  - Add an admin-triggered "Re-resolve locations now" button on
    `/admin/login-overview` that fires `POST /api/admin/geo-backfill`
    (new route) so the operator can backfill on demand.
- Test: hit `/admin/login-overview` and confirm > 90 % of historical
  rows currently read `—`. After the fix, every row with an IP
  resolves within 5 s of the next login + the backfill cron's first
  pass populates the historical tail.

## Item 11 — Medication detail card symmetry (Ramipril vs Mounjaro)

- File: `src/components/medications/medication-card.tsx:417-606`
  (Ramipril/generic).
- File: `src/components/medications/glp1-medication-card.tsx:286-427`
  (Mounjaro/GLP-1).
- File: `src/components/medications/MedicationCardHeader.tsx:37-78`
  (shared header — already symmetric).
- File: `src/app/medications/page.tsx:209-225` (parent grid renders
  either card based on `treatmentClass === "GLP1"`).
- Asymmetries the user perceives:
  1. **Status pill** — Ramipril paints a coloured take-now /
     overdue / very-late line at
     `medication-card.tsx:429-456`. Mounjaro renders nothing
     equivalent (lines 297-312 only show last/next injection).
  2. **Dose accent** — Ramipril's "next intake" line uses
     `font-medium text-purple-400` on the schedule dose
     (`medication-card.tsx:510-512`). Mounjaro's next-injection
     label has no dose accent (line 311 is plain
     `text-foreground/85`).
  3. **Category label** — Ramipril maps category → translated
     label (`medication-card.tsx:258-272`). Mounjaro hard-codes
     `t("medications.treatmentClassGlp1")` at line 291 instead of
     its actual category.
  4. **Action row** — Mounjaro adds a third Stethoscope
     "Nebenwirkung" button at lines 412-421, breaking the
     Eingenommen / Übersprungen symmetry.
  5. **Rotation hint** + **lastSite-augmented last-injection
     line** are GLP-1-only (lines 297-332); these are by design but
     contribute to "feels different".
- Recommended fix: align on the Ramipril shape per Marc.
  - Lift `currentWindowStatus` (medication-card.tsx:296-344) + the
    coloured status row (lines 429-456) into
    `src/lib/medications/window-status.ts` and mount it from both
    cards. GLP-1 schedules share the same `windowStart`/`windowEnd`
    shape so the helper works untouched. Insert above
    `glp1-medication-card.tsx:296`.
  - Add `font-medium text-purple-400` to the dose part of the
    next-injection label at `glp1-medication-card.tsx:311`.
  - Replace `categoryLabel={t("medications.treatmentClassGlp1")}`
    at line 291 with the same category-map lookup Ramipril uses
    (lines 258-272 of `medication-card.tsx`); the GLP-1 nature is
    already implied by the rotation hint + injection metadata
    rows.
  - Move the Stethoscope side-effect button into the header
    `actions` slot (next to History + Pencil) so the primary
    action row stays the two-button shape.
- Test: place Ramipril + Mounjaro side-by-side on `/medications`.
  Header height, status pill row, compliance bars, action row
  buttons-count, and footer baseline must match. Tap "Eingenommen"
  on each and verify the state badges + last-intake line update
  identically.

---

## Cross-cutting recommendations

- **Card primitive spacing** (items 1, 3, 5): every metric tile is
  fighting `src/components/ui/card.tsx:23`'s `gap-4 md:gap-6 py-4
  md:py-6` default. Two paths: (a) introduce
  `<Card density="compact">` with `gap-2 py-2`, or (b) document
  the per-tile override convention in a `docs/audit/` note. The
  metric tiles already override case-by-case; recommend (b) so we
  don't grow the primitive API.
- **Feature-flag enforcement** (item 9): add a Vitest unit that
  asserts every `useCoachLaunch` import is paired with a
  `flags.coach`-gate. Would have caught the three holes
  preemptively.
- **Geo backfill scheduling** (item 10): same anti-pattern as
  `scripts/backfill-rollups.ts` from v1.4.35 — helper without a
  scheduler. Rule: recurring tasks belong on pg-boss, not a CLI.
  Schedule in the same wave as the `cf-connecting-ip` fix so the
  fix delivers both fresh + historical rows.
- **Insights-status latency budget** (item 6): every per-metric
  status route (BP, weight, pulse, mood, medication-compliance) has
  the same 20 s race-then-fall-back shape. The mid-term
  pg-boss-pre-warm fix and the loading-skeleton fix should land
  once across all five.
- **Mobile audit coverage**: items 2, 3, 5, 7 manifest differently
  on mobile. Re-run the responsive audit on Pixel-5 (393),
  iPhone-13-mini (375), and Galaxy-Fold (280) after v1.4.37 lands;
  the existing `tests/e2e/responsive/` Playwright suite already
  covers these viewports.
