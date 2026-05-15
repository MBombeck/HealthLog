---
file: .planning/v1427-fix-plan.md
purpose: v1.4.27 R2 triage — consolidated find-list, fix-surface buckets, file-touch collision matrix, dispatch sequence
created: 2026-05-15
predecessor: .planning/v1427-plan.md + 6 R1 audit reports (R1.1 dashboard, R1.2 settings/admin, R1.3 coach/insights, R1.4 notifications, R1.5 iOS offline, R1.6 backlog sweep)
target_tag: v1.4.27
mode: read-only (planning artifact)
---

# v1.4.27 Fix Plan — Consolidated R1 Triage

## Headline

Six R1 audits + the 17 pulled-in backlog items collapse cleanly into **7 touch-disjoint fix-surface buckets** with **zero same-line collisions** and four documented sequenced edits where two buckets share a file but not the same lines. Round 3 dispatch lands as **5 parallel buckets in Round 3a** plus **2 sequenced buckets in Round 3b** (i18n cleanup runs after every component-side bucket; symmetry sweep runs after every component-side bucket). One uncertainty resolved here: `/api/audit-log` is deleted (no UI consumer; if maintainer wants the surface, fresh implementation is cleaner). One decision pinned: no iOS-server preps in v1.4.27 (all `syncVersion` / `deletedAt` / `GET /api/sync/state` work parks to v1.4.28). One additive iOS-handoff doc written: `.planning/v15-ios-handoff/22-offline-first-architecture.md` carries R1.5's research forward for the iOS-side reader.

## Convention

Marc-Voice English. Forbidden vocabulary: AI, Claude, agent, marathon, wave, phase, session, subagent. No personal data. No co-authored-by trailers. Single commit at the end of this plan, pushed to `develop`.

---

## Section 1 — Consolidated find-list (de-duplicated)

Every finding from R1.1–R1.6 + the 17 pulled-in backlog items, with reviewer-IDs preserved. Sorted by severity tier.

### Tier — Critical (zero; bugs that would block release)

None. v1.4.27 is a QoS-pass release; no Critical findings surfaced.

### Tier — High (apply now)

| ID | Finding | Source | Severity rationale |
|---|---|---|---|
| F16 | `metric:PULSE` raw tokens leak at end of insight sub-page prose | R1.3 | User-visible regression, every six insight sub-pages affected |
| F20 | False Withings "sync failing" Telegram alert fires after deliberate scope-skip park | R1.4 | Admin notification spam, root cause clear, two-line fix |
| F21 | Telegram message copy is English regardless of `User.locale` | R1.4 | Locale-honouring copy is a project ground rule |
| F1 + simp-M10/dead-M6 | GLP-1 dashboard tile shows only weight; wire the drug-level chart as a second pane (consumes `glp1-pk.ts` exports `shotPhaseAt` et al. that are unused today) | R1.1 + R1.6 | Maintainer-flagged headline item; pairs the dead-export wiring decision |
| F5 | "KI-Gesundheitsanalyse" dashboard preview card is dead leftover | R1.1 | Visible duplicate of `/insights` surface |
| F6 | Daily Briefing duplicates the hero greeting paragraph | R1.1 | Visible text repeated twice within 200 px |
| F8 | Health Score card is a small inset inside the hero column instead of a co-equal pane | R1.1 | Hero column reads as unbalanced |
| F12 | Page-height shifts on click for `/settings/thresholds`, `/settings/sources`, similar admin sub-pages | R1.2 | Layout jump on every navigation click |

### Tier — Medium (apply now)

| ID | Finding | Source |
|---|---|---|
| F2 | Green band on GLP-1 card optically arbitrary; promote schedule pills instead | R1.1 |
| F3 | GLP-1 tile missing range selector (7d / 30d / 90d / All) that other charts have | R1.1 |
| F4 | MoodChart renders 280 px tall while every sibling chart is 240 px — vertical rhythm broken | R1.1 |
| F7 | Weekly-report click target is dead OR the dashboard lacks an entry point — investigate | R1.1 |
| F9 + F11 | Profile field arrangement is asymmetric; Language sits alone at the form bottom — pair Date-of-birth + Language in one grid row | R1.2 |
| F10 | TimezonePicker inner `gap-2` is tighter than the form's outer `space-y-4` rhythm | R1.2 |
| F14 | Coach evidence disclosure mounts default-open when `coachPrefs.showEvidenceByDefault` is set — close by default, retire the pref | R1.3 |
| F15 | Coach textarea hint footer is verbose; collapse to an info icon + tooltip | R1.3 |
| F17 + F18 + F19 | Insights metrics with zero observations still render sub-pages, dashboard tiles, and tab strip pills. Auto-light-up when iOS HealthKit imports flip the count. Single `hasMetricData` helper drives all three render gates | R1.3 |
| F22 | Admin login overview Standort cell shows "—" because `ipwho.is` provider misses; bundle offline GeoLite2-City MMDB | R1.2 |
| F23 | Admin login overview Provider column needs an ASN-to-carrier chip ("Telekom", "Vodafone", "1&1", "O2"); bundle GeoLite2-ASN MMDB | R1.2 |
| F13 | Cross-page symmetry audit — heading font weight (`font-semibold` vs `font-bold`), card-internal vertical rhythm (`space-y-3` vs `space-y-4`), label-input gap (`space-y-1.5` vs `space-y-2`) | R1.2 |
| BL-P1-1 | 414 dead i18n keys cleanup (×6 locales) | R1.6 |
| BL-P1-2 | `BASE_SYSTEM_PROMPT` / `INSIGHTS_SYSTEM_PROMPT` bare-symbol removal (zero consumers) | R1.6 |
| BL-P4-9 | Design M7 + L1-L4 polish (medication-form Dialog sweep, `motion-reduce:animate-none`, Health Score disclaimer, `<details>` aria-controls, therapy-timeline `<h4 class="sr-only">`) | R1.6 |
| BL-P6-11 | Mood verbal labels chart-label consistency follow-up | R1.6 |
| BL-P4-8 | i18n drift-guard test for PR + Workout strings (depends on BL-P1-1 landing first) | R1.6 |

### Tier — Low (apply now if cheap)

| ID | Finding | Source |
|---|---|---|
| BL-P1-3 | W7d hardening — narrow `safeRequestProp` catch-all + `globals.css` `@source` path fix | R1.6 |
| BL-P1-4 | Cat-C stale-comment typo at `src/app/api/insights/targets/route.ts:807` | R1.6 |
| BL-P2-3 | Workout cross-source dedup — wire `pickCanonicalWorkout()` into the read path | R1.6 |
| BL-P3-2 | Withings Sleep v2 scope-guard parity verification + reauth-banner i18n suffix | R1.6 |
| BL-P4-2 | Chart x-axis-tick timezone audit (cosmetic axis-label shift) | R1.6 |
| BL-P4-5 | `__testables.WEEKDAY_KEYS` cleanup (zero consumers) | R1.6 |
| BL-P4-11-S1 | `metricPriorityObjectSchema` derive from `SOURCE_PRIORITY_METRIC_KEYS` | R1.6 |
| BL-P4-11-S10 | Shared `allMessages` + `resolveKey` between `lib/i18n/context.tsx` and `server-translator.ts` | R1.6 |
| BL-P6-4 | Coach `lastYear` window option (enum extension + snapshot mapping) | R1.6 |
| BL-P6-7 | Locale-native date format ordering for FR/ES/IT/PL | R1.6 |
| BL-code-M3 | Workout-attach route serial `findFirst` → single `findMany` | R1.6 |

### Tier — Documentation-only (additive)

| ID | Finding | Source |
|---|---|---|
| F24 + F25 + F26 | iOS offline-first architecture pattern + feature parity + sync conflict resolution policy. Output: new `.planning/v15-ios-handoff/22-offline-first-architecture.md` | R1.5 |

### Decisions documented here

- **P4-6 `/api/audit-log` direction** — default-decide: **DELETE the route**. Orphan endpoint, zero UI consumer. If the maintainer wants the surface back, fresh implementation against the v1.4.28 design pass is cleaner than reviving a dead one. The route, its DTO, and its test fixture all drop in the dead-code-cleanup bucket below.
- **F7 weekly-report dead click** — pulled out of the dashboard bucket and given a 30-minute scan window: if the dead affordance can be located via grep on "Wochenreport" / "weekly report" strings, it's removed; if not, defer to v1.4.28 with a maintainer-screenshot ask. Document the scan outcome inline in the dashboard-bucket commit message.
- **iOS server-side preps for v1.4.27** — **none**. The R1.5 recommendations (`syncVersion`, `deletedAt`, `GET /api/sync/state`, ETag/`If-Modified-Since`) all park to v1.4.28. Rationale: v1.4.27 is the QoS-pass release per the maintainer directive; the iOS client owns the offline-first inversion in its own repo and does not require server changes to ship. Server-side preps land in v1.4.28 as the iOS client adds the features that consume them.
- **iOS surfaces in v1.4.27** — write `.planning/v15-ios-handoff/22-offline-first-architecture.md` (new file in the existing doc-pack). Otherwise nothing iOS-specific lands.
- **F16 cache hygiene** — rely on the daily-key cache rolling forward to expire contaminated `auditLog.details.text` rows. No Prisma migration, no manual cache wipe.
- **F22 + F23 Docker image growth** — bundle two MMDBs (~80 MB combined). Verify image-size budget (1.9 GB compressed) before merge. License attribution lands in `/about` + `docs/audit/v1427-summary.md`.

---

## Section 2 — Fix-surface buckets

Seven buckets. Each is touch-disjoint by file (no same-line collisions). Four sequenced edits documented in Section 3.

### Bucket B1 — Dashboard rebuild (GLP-1 tile + chart-row symmetry + dead leftovers)

**Items applied (reviewer-IDs).** F1, F2, F3, F4, F5, F6, F7 (scan-only), F8, simp-M10/dead-M6 wiring (BL-W21-line-256/261), BL-P4-9 (Health-Score disclaimer polish lands here).

**Files touched.**
- `src/components/dashboard/glp1-tile.tsx` (+~150 LOC; tab strip, schedule pill row, range strip, drug-level pane)
- `src/components/medications/DrugLevelChart.tsx` (+~50 LOC; `compact` prop, `windowHoursBefore` prop, sample-step scaling)
- `src/components/dashboard/__tests__/glp1-tile.tsx` (assertions for tab strip, range buttons, default-to-level behaviour)
- `src/lib/charts/constants.ts` (NEW, ~10 LOC; `CHART_HEIGHT_PX`, `CHART_MINI_HEIGHT_PX`, range-preset list)
- `src/components/charts/mood-chart.tsx` (1-3 LOC; height token swap)
- `src/components/charts/health-chart.tsx` (~2 LOC; consume constant)
- `src/components/charts/medication-compliance-chart.tsx` (~2 LOC; consume constant)
- `src/app/page.tsx` (-12 LOC for F5 InsightsCardPreview removal; +30 LOC if F7 takes the dashboard-banner path)
- `src/lib/dashboard-layout.ts` (-3 LOC; drop `insightsPreview` widget entry)
- `src/components/settings/dashboard-layout-section.tsx` (-3 LOC; drop the layout row)
- `src/components/insights/insights-card.tsx` (DELETE, -119 LOC)
- `src/components/insights/__tests__/insights-card.test.tsx` (DELETE)
- `src/components/insights/daily-briefing.tsx` (-10 LOC; strip duplicate paragraph)
- `src/components/insights/__tests__/daily-briefing.test.tsx` (regression test: paragraph slot absent)
- `src/components/insights/health-score-card.tsx` (~25 LOC; width bump, size enlargement, Ask-Coach button removal, disclaimer borderline)
- `src/components/insights/hero-strip.tsx` (~5 LOC; keep `onAskCoach` prop wiring)
- `src/components/insights/__tests__/health-score-card.test.tsx` (update pinned classes)
- `src/lib/medications/glp1-pk.ts` (no edit — exports already exist; bucket consumes `shotPhaseAt` in `DrugLevelChart` consumer)

**Estimated commits.** 6 atomic:
1. `feat(charts): extract shared chart-height + range-preset constants`
2. `fix(charts): align MoodChart height with the rest of the trend strip`
3. `chore(dashboard): retire the standalone InsightsCardPreview surface`
4. `feat(dashboard): wire the GLP-1 drug-level pane behind a tab strip and range picker`
5. `refactor(dashboard): promote GLP-1 schedule dates to a header pill row and drop the green seam`
6. `fix(insights): strip the duplicate briefing paragraph and rebalance the Health Score column`

**Dispatcher-prompt skeleton (for the orchestrator).**

> You own the v1.4.27 dashboard rebuild bucket B1. Apply findings F1 through F8 from `.planning/v1427-fix-plan.md` plus the simp-M10/dead-M6 GLP-1-PK wiring decision. The GLP-1 tile gets a two-tab pane (Weight / Drug-Level, default Drug-Level) with a 7d/30d/90d/All range strip above; the green band leaves; injection dates promote to a pill row; the drug-level pane consumes `compact + windowHoursBefore` props in `DrugLevelChart`. MoodChart drops to 240 px via a shared `src/lib/charts/constants.ts` module that the other two chart files also import. `InsightsCardPreview` deletes entirely including its test, layout entry, and i18n keys. Daily Briefing drops its leading paragraph and opens directly on the key-findings list. Health Score card grows to `lg:w-[360px] xl:w-[400px]`, the score number scales to `text-5xl sm:text-6xl`, and the inline "Ask the Coach" button retires in favour of the hero's existing action. For F7, run a 30-minute grep scan on "Wochenreport" / "weekly report" strings; if a dead affordance turns up, remove it; if not, document the scan outcome in the commit message and defer F7 to v1.4.28 with a maintainer-screenshot ask. Atomic commits per the six titles in the plan. Tests stay green at every commit.

---

### Bucket B2 — Settings + admin profile form + shell layout-shift fix

**Items applied.** F9, F10, F11, F12 (shell layout-shift only — symmetry sweep stays in B7).

**Files touched.**
- `src/components/settings/account-section.tsx` (~30 LOC; move language `<select>` into DOB grid row, drop `sm:max-w-xs`, drop standalone language wrapper)
- `src/components/settings/timezone-picker.tsx` (1 line; `gap-2` → `gap-3`)
- `src/components/settings/settings-shell.tsx` (1 line; add `min-h-[calc(100dvh-12rem)]` to `<main>`)
- `src/components/admin/admin-shell.tsx` (1 line; same as above)
- `src/components/settings/thresholds-editor-section.tsx` (~30 LOC; skeleton list, 14-row placeholder)
- `src/components/settings/sources-section.tsx` (~30 LOC; skeleton list, 14-metric placeholder)
- `src/components/settings/__tests__/account-section.test.tsx` (assertions for the new grid layout)
- `src/components/settings/__tests__/timezone-picker.test.tsx` (re-baseline)
- Playwright timing test (NEW or extension): scroll-delta < 50 px when clicking through the four settings sub-pages

**Estimated commits.** 4 atomic:
1. `fix(settings): pair date-of-birth with language in one grid row`
2. `fix(settings): raise the TimezonePicker inner gap to match the form rhythm`
3. `fix(settings): reserve a minimum main-column height in the settings and admin shells`
4. `feat(settings): replace single-spinner loading with skeleton rows on Thresholds and Sources`

**Dispatcher-prompt skeleton.**

> You own bucket B2 — the settings profile form rhythm + the shell layout-shift fix. In `account-section.tsx`, move the language `<select>` into the same `grid gap-4 sm:grid-cols-2` row as Date of birth, drop the standalone language wrapper and its `sm:max-w-xs`. In `timezone-picker.tsx`, raise the inner `gap-2` between the select and the detect button to `gap-3`. In both `settings-shell.tsx` and `admin-shell.tsx`, add `min-h-[calc(100dvh-12rem)]` to the `<main>` element. In `thresholds-editor-section.tsx` and `sources-section.tsx`, replace the single-spinner loading state with a skeleton-list placeholder whose row count matches the expected content (14 each). Add a Playwright timing test that asserts the scroll delta stays under 50 px during the first 500 ms of navigation through `/settings/account → /settings/thresholds → /settings/sources → /admin/login-overview`.

---

### Bucket B3 — Offline geo-IP + ASN-to-carrier lookups

**Items applied.** F22, F23.

**Files touched.**
- `src/lib/geo.ts` (~60 LOC; offline-first resolver path, `lookupIpLocation` + `lookupIpAsn`)
- `src/lib/__tests__/geo.test.ts` (extend existing)
- `src/lib/__tests__/geo-asn.test.ts` (NEW)
- `src/lib/auth/audit.ts` (~10 LOC; resolve carrier in parallel with location, single `update()` carries both)
- `prisma/schema.prisma` (+2 nullable columns `asn Int?` + `carrier String?` on `AuditLog`)
- `prisma/migrations/<timestamp>_audit_log_carrier/migration.sql` (NEW; additive, `IF NOT EXISTS` guarded)
- `src/lib/jobs/geo-backfill.ts` (NEW, ~60 LOC; backfill helper, capped at 5k rows/pass)
- `src/lib/jobs/__tests__/geo-backfill.test.ts` (NEW)
- `src/components/admin/login-overview-section.tsx` (~20 LOC; carrier chip below provider chip)
- `src/components/admin/_shared.tsx` (~10 LOC; carrier → short-label map, CSV column)
- `src/components/admin/__tests__/login-overview-csv.test.ts` (extend)
- `messages/{de,en,fr,es,it,pl}.json` (+2 keys: `admin.carrier`, `admin.carrierUnknown`)
- `package.json` (add `mmdb-lib`)
- `Dockerfile` (COPY GeoLite2-City.mmdb + GeoLite2-ASN.mmdb into `/opt/geolite2/`)
- `docs/audit/v1427-summary.md` (NEW; GeoLite2 attribution paragraph)
- `src/app/about/page.tsx` (~5 LOC; license attribution under credits)

**Estimated commits.** 3 atomic:
1. `feat(geo): bundle GeoLite2-City and add an offline-first lookup path`
2. `feat(audit): persist ASN and carrier on login audit rows`
3. `feat(admin): surface the carrier chip under the auth provider on the login overview`

**Dispatcher-prompt skeleton.**

> You own bucket B3 — the offline geo-IP + ASN-to-carrier surface. Bundle the MaxMind GeoLite2-City and GeoLite2-ASN MMDBs into the Docker image at `/opt/geolite2/`. Add `mmdb-lib` to dependencies. In `src/lib/geo.ts`, rewrite `lookupIpLocation` to try the offline DB first and fall back to the existing `ipwho.is` path; add a new `lookupIpAsn` that returns `{ asn, carrier } | null`. Add two nullable columns to `AuditLog` (`asn Int?` + `carrier String?`) via an additive `IF NOT EXISTS`-guarded migration. Update `src/lib/auth/audit.ts` to resolve carrier in parallel with location. Add a backfill job in `src/lib/jobs/geo-backfill.ts` that walks rows where `location IS NULL AND createdAt > now() - 30 days`, capped at 5k rows per pass. In the admin login-overview, render the carrier chip below the auth-provider chip; fold the GeoLite2 organization string down to short DACH carrier labels ("Telekom", "Vodafone", "1&1", "O2") via a small lookup table. Add the GeoLite2 CC BY-SA 4.0 attribution to `/about` and `docs/audit/v1427-summary.md`. Verify image growth stays below 90 MB before merging. Atomic commits per the three titles.

---

### Bucket B4 — Coach polish + Insights data-driven hiding + token-leak hardening

**Items applied.** F14, F15, F16, F17, F18, F19.

**Files touched.**
- `src/components/insights/insight-status-card.tsx` (~3 LOC; wrap text with `stripChartTokens`)
- `src/lib/insights/pulse-status.ts` (~3 LOC; extend `normalizeSummaryText`)
- `src/lib/insights/weight-status.ts` (~3 LOC)
- `src/lib/insights/bmi-status.ts` (~3 LOC)
- `src/lib/insights/mood-status.ts` (~3 LOC)
- `src/lib/insights/blood-pressure-status.ts` (~3 LOC)
- `src/lib/insights/medication-compliance-status.ts` (~3 LOC)
- `src/lib/insights/general-status.ts` (~3 LOC; parity)
- `src/components/insights/__tests__/insight-status-card.test.tsx` (NEW)
- `src/lib/insights/__tests__/{pulse,weight,bmi,mood,blood-pressure,medication-compliance,general}-status.test.ts` (extend existing; assert no `metric:` substring in cached `text`)
- `src/components/insights/coach-panel/message-thread.tsx` (~5 LOC; drop `evidenceDefaultOpen` prop wiring)
- `src/components/insights/coach-panel/coach-settings-sheet.tsx` (~10 LOC; retire `showEvidenceByDefault` toggle)
- `src/components/insights/coach-panel/__tests__/message-thread.test.tsx` (adjust default-open assertion)
- `src/components/insights/coach-panel/coach-input.tsx` (~15 LOC; replace hint `<span>` with `Info` icon + Radix Tooltip)
- `src/components/insights/coach-panel/__tests__/coach-input.test.tsx` (look for tooltip trigger `aria-label`)
- `src/lib/insights/metric-availability.ts` (NEW, ~80 LOC)
- `src/lib/insights/__tests__/metric-availability.test.ts` (NEW; 12-15 cases)
- `src/components/insights/insights-tab-strip.tsx` (~10 LOC; filter pills by availability)
- `src/components/insights/__tests__/insights-tab-strip.test.tsx` (NEW assertions)
- `src/app/insights/layout.tsx` (~10 LOC; surface availability inputs)
- `src/app/insights/{blutdruck,gewicht,puls,stimmung,medikamente,bmi,schlaf}/page.tsx` (×7; early-return empty-state when `hasMetricData` is false)
- `src/app/page.tsx` (~10 LOC; per-tile availability gate — coordinates with B1 file edit)

**Estimated commits.** 5 atomic:
1. `fix(insights): strip metric tokens at both producer and consumer of the status card`
2. `fix(coach): collapse the evidence disclosure to closed-by-default`
3. `feat(coach): replace the textarea hint footer with an info-icon tooltip`
4. `feat(insights): gate sub-pages and tab pills on metric data availability`
5. `feat(dashboard): apply the metric-availability gate per tile`

**Dispatcher-prompt skeleton.**

> You own bucket B4 — Coach polish + Insights data-driven hiding + the `metric:PULSE` token leak fix. For F16, wrap `text` with `stripChartTokens` at the `InsightStatusCard` render site, and extend `normalizeSummaryText` in all eight `*-status.ts` helpers to call `stripChartTokens` before whitespace collapse. Add `src/components/insights/__tests__/insight-status-card.test.tsx` plus one helper-level test per status generator. For F14, drop the `evidenceDefaultOpen` prop wiring in `message-thread.tsx` and retire the `showEvidenceByDefault` toggle in `coach-settings-sheet.tsx`. For F15, replace the hint `<span>` under the coach textarea with an `Info` icon wrapping a Radix `<Tooltip>` carrying the existing `composerHint` translation. For F17/F18/F19, build `src/lib/insights/metric-availability.ts` with a `hasMetricData(metric, inputs)` helper that reads `summaries[METRIC].count` for sensor metrics and `hasMood` / `hasMedication` for event-driven metrics. Wire it into `insights-tab-strip.tsx` (filter pills), each `src/app/insights/{slug}/page.tsx` (early-return empty-state with CTA to `/measurements/new` or `/settings/data-sources`), and `src/app/page.tsx` (per-tile gate; coordinate with bucket B1 on the same file via the file-touch matrix). Empty-state copy lands as new i18n keys that bucket B6 picks up.

---

### Bucket B5 — Notifications hardening + locale-aware Telegram

**Items applied.** F20, F21, BL-P3-2 (Withings Sleep parity verification — light touch).

**Files touched.**
- `src/lib/integrations/status.ts` (+30 LOC; new `parkIntegrationAtReauth` helper, `formatAdminAlertPayload` accepts `t: ServerTranslator["t"]`)
- `src/lib/withings/sync-activity.ts` (~5 LOC; scope-skip call-site swap)
- `src/lib/withings/sync-sleep.ts` (~5 LOC; scope-skip call-site swap + BL-P3-2 parity)
- `src/lib/integrations/__tests__/admin-alert.test.ts` (extend; scope-skip path asserts no alert + no counter increment)
- `src/lib/withings/__tests__/sync-activity.test.ts` (extend; existing 403 catch still pages)
- `src/lib/withings/__tests__/sync-sleep.test.ts` (extend; parity)
- `src/lib/notifications/dispatch-localised.ts` (NEW, ~30 LOC; translator-aware dispatch helper)
- `src/lib/notifications/__tests__/admin-locale.test.ts` (NEW)
- `src/app/api/internal/deploy-webhook/route.ts` (~10 LOC; use `dispatchLocalisedNotification`)
- `src/app/api/admin/notifications/test/route.ts` (~5 LOC; resolve admin locale)
- `src/app/api/settings/telegram/test/route.ts` (~5 LOC; resolve user locale)
- `src/app/api/admin/notifications/reminder-check/route.ts` (~15 LOC; resolve recipient locale)
- `src/app/api/settings/__tests__/telegram-test-locale.test.ts` (NEW)
- `messages/{de,en,fr,es,it,pl}.json` (add `notifications.admin.*` and `notifications.user.*` keys — picked up by bucket B6 sequenced edit)

**Estimated commits.** 3 atomic:
1. `fix(integrations): silence the Withings scope-skip path from the 3-strike alert ladder`
2. `feat(notifications): add a translator-aware dispatch helper`
3. `feat(notifications): localise admin and user Telegram messages to the recipient's locale`

**Dispatcher-prompt skeleton.**

> You own bucket B5 — notifications hardening. For F20, extract a new `parkIntegrationAtReauth(userId, integration, message, errorCode)` helper in `src/lib/integrations/status.ts` that sets the connection state to `error_reauth` without incrementing `consecutiveFailures`, without writing an audit row through `recordSyncFailure`, and without entering the threshold ladder. Swap the two scope-skip call-sites in `sync-activity.ts:229-236` and `sync-sleep.ts:175-184` to the new helper. The defence-in-depth 403 catch-block stays on `recordSyncFailure`. For F21, add `src/lib/notifications/dispatch-localised.ts` exposing `dispatchLocalisedNotification` that resolves `User.locale`, calls `getServerTranslator(locale).t(titleKey, messageKey, params)`, and delegates to `dispatchNotification`. Add `notifications.admin.*` and `notifications.user.*` translation keys across all six locales (the actual JSON edits land in bucket B6 — your bucket adds the call-sites that read them). Swap the five offending call-sites listed in R1.4 to the new helper. Atomic commits per the three titles.

---

### Bucket B6 — i18n cleanup + dead-key sweep + locale-native date formats + dispatcher key inserts

**Items applied.** BL-P1-1 (414 dead keys), BL-P4-8 (drift-guard), BL-P6-7 (locale-native dates for FR/ES/IT/PL), BL-P6-11 (mood verbal labels follow-up), all new key inserts from B1/B2/B4/B5.

**Files touched.**
- `messages/{de,en,fr,es,it,pl}.json` (six bundles; net deletion of ~414 dead keys; insertions for: `dashboard.glp1.tabWeight`, `dashboard.glp1.tabLevel`, `notifications.admin.*` (~10 keys), `notifications.user.*` (~2 keys), `insights.emptyState.*` per metric (~7 keys), `admin.carrier`, `admin.carrierUnknown`; net result ≈ -390 keys)
- `src/__tests__/i18n-drift-guard.test.ts` (NEW or extend existing)
- `src/__tests__/locale-integrity.test.ts` (re-baseline key counts)
- `src/components/charts/mood-chart.tsx` (~5 LOC for BL-P6-11)
- `src/components/mood/mood-list.tsx` (~5 LOC for BL-P6-11)

**Estimated commits.** 3 atomic:
1. `chore(i18n): retire 414 dead translation keys across six locale bundles`
2. `feat(i18n): land locale-native date format ordering for FR/ES/IT/PL`
3. `feat(i18n): add notification and insights-empty-state keys + drift-guard test`

**Dispatcher-prompt skeleton.**

> You own bucket B6 — the i18n sweep. SEQUENCED: this bucket runs after B1, B2, B4, and B5 land so every component-side key insert is in place. First commit deletes ~414 dead keys per BL-P1-1; the locale-integrity test fails on one-sided touches, so re-baseline the key-count thresholds in the same commit. Second commit swaps `format.dateShort` / `timeShort` / `dateTime` in FR/ES/IT/PL bundles to native ordering (FR/ES/IT `{day}/{month}/{year}`, PL `{day}.{month}.{year}`). Third commit adds every new key that B1, B2, B4, B5 reference (`dashboard.glp1.tabWeight`, `notifications.admin.*`, `notifications.user.*`, `insights.emptyState.*`, `admin.carrier`, etc.) plus the BL-P4-8 drift-guard test that asserts PR + Workout strings stay in lockstep across six locales. Apply BL-P6-11 mood verbal labels follow-up in the same commit since it co-locates with the chart-label key set.

---

### Bucket B7 — Symmetry sweep + dead-code cleanup + low-tier polish

**Items applied.** F13 symmetry sweep, BL-P4-9 design polish (M7, L1, L2, L3, L4 — minus the Health Score disclaimer which lives in B1), BL-P1-2 (`BASE_SYSTEM_PROMPT` removal), BL-P1-3 (W7d hardening), BL-P1-4 (stale-comment typo), BL-P2-3 (workout dedup wiring), BL-P4-2 (chart-tick timezone audit), BL-P4-5 (`__testables.WEEKDAY_KEYS`), BL-P4-11-S1 (`metricPriorityObjectSchema` derive), BL-P4-11-S10 (shared `allMessages` extract), BL-P6-4 (Coach `lastYear` window), BL-code-M3 (workout-attach `findMany`), P4-6 decision (DELETE `/api/audit-log`).

**Files touched.**
- All settings + admin section components (~10 files; heading weight → `font-semibold`, card-internal cadence → `space-y-4`, password-dialog `space-y-1.5` → `space-y-2`)
- `src/components/medications/medication-form.tsx` (BL-P4-9 M7 Dialog inline-control sweep)
- Multiple component files (BL-P4-9 L1 `motion-reduce:animate-none` consistency)
- `src/components/insights/health-score-card.tsx` — NOTE: B1 owns this file; the L2 disclaimer borderline is folded into B1 commit 6 (see Section 3 sequenced edits)
- `<details>` elements across `src/components/` (BL-P4-9 L3 aria-controls)
- `src/components/insights/therapy-timeline.tsx` (BL-P4-9 L4 `<h4 class="sr-only">`)
- `src/lib/ai/prompts/base-system.ts` (-10 LOC; drop `BASE_SYSTEM_PROMPT`)
- `src/lib/insights/prompt.ts` (-10 LOC; drop `INSIGHTS_SYSTEM_PROMPT`)
- `src/lib/api-handler.ts` (+10 LOC; narrow `safeRequestProp`)
- `src/app/globals.css` (~2 LOC; `@source` path fix)
- `src/app/api/insights/targets/route.ts` (1 line; stray brace at line 807)
- `src/lib/sources/pick-canonical-workout.ts` (existing; verify exports)
- `src/app/api/workouts/route.ts` (~30 LOC; wire canonical picker into read path)
- `src/app/api/workouts/__tests__/canonical-dedup.test.ts` (NEW)
- `src/components/insights/sleep-stage-stacked-bar.tsx` + 4-6 sibling chart files (~25 LOC; tick-timezone audit replacements)
- `src/lib/ai/coach/glp1-snapshot.ts` (-5 LOC; `WEEKDAY_KEYS` cleanup)
- `src/lib/validations/source-priority.ts` (~10 LOC; derive `metricPriorityObjectSchema` from `SOURCE_PRIORITY_METRIC_KEYS`)
- `src/lib/i18n/context.tsx` + `src/lib/i18n/server-translator.ts` + `src/lib/i18n/shared-resolve.ts` (NEW) (~60 LOC; extract shared `allMessages` + `resolveKey`)
- `src/lib/ai/coach/types.ts` + `src/lib/ai/coach/snapshot.ts` (~60 LOC; `lastYear` window enum extension)
- `src/lib/ai/coach/__tests__/snapshot.test.ts` (extend)
- `src/app/api/workouts/[id]/route.ts` (or wherever workout-attach lives; ~25 LOC; serial `findFirst` → single `findMany`)
- `src/app/api/audit-log/route.ts` (DELETE)
- `src/app/api/audit-log/__tests__/route.test.ts` (DELETE)
- DTO + zod schema for `/api/audit-log` (DELETE)

**Estimated commits.** 7 atomic:
1. `chore(ui): unify heading weight, card cadence, and label-input gap across settings and admin`
2. `chore(ui): apply M7 + L1 + L3 + L4 polish across medication form, motion-reduce, details aria, therapy timeline`
3. `chore(prompts): drop the unreferenced BASE_SYSTEM_PROMPT and INSIGHTS_SYSTEM_PROMPT exports`
4. `chore(api): tighten safeRequestProp, fix the globals.css @source path, and the targets-route stale comment`
5. `feat(workouts): wire pickCanonicalWorkout into the list read path and collapse the attach route N+1`
6. `feat(coach): extend the snapshot window enum with lastYear`
7. `chore(api): delete the orphan /api/audit-log surface`

**Dispatcher-prompt skeleton.**

> You own bucket B7 — the symmetry sweep + dead-code cleanup. SEQUENCED: runs after B1, B2, B3, B4, B5. Standardise heading weight to `font-semibold` across every settings and admin section. Standardise card-internal vertical rhythm to `space-y-4` and label-input gap to `space-y-2` (the password-change dialog at `account-section.tsx` is the divergent case). Apply BL-P4-9 polish items M7, L1, L3, L4 — note that L2 (Health Score disclaimer) was folded into bucket B1 commit 6, do not re-touch. Delete the `BASE_SYSTEM_PROMPT` and `INSIGHTS_SYSTEM_PROMPT` bare-symbol exports. Narrow `safeRequestProp`'s catch-all and fix the `@source` path in `globals.css`. Fix the stray-brace typo at `src/app/api/insights/targets/route.ts:807`. Wire `pickCanonicalWorkout()` into the workouts read path; collapse the workout-attach route's serial `findFirst` calls into a single `findMany`. Extend the Coach snapshot window enum with `lastYear`. Extract the shared `allMessages` + `resolveKey` between `lib/i18n/context.tsx` and `lib/i18n/server-translator.ts` into a new `lib/i18n/shared-resolve.ts`. Derive `metricPriorityObjectSchema` from `SOURCE_PRIORITY_METRIC_KEYS`. Drop `__testables.WEEKDAY_KEYS`. Run the chart-tick timezone audit across `sleep-stage-stacked-bar.tsx` and siblings. Delete the orphan `/api/audit-log` route, its DTO, its test fixture (default-decide from R2). Atomic commits per the seven titles; re-baseline visual snapshots in the same commit that touches the underlying classes.

---

## Section 3 — File-touch collision matrix

Columns are buckets B1–B7. Rows are files touched by two or more buckets. A cell value of `X` means the bucket edits the file; `seq` means a sequenced edit (documented below). Cells left blank = no touch.

| File | B1 | B2 | B3 | B4 | B5 | B6 | B7 |
|---|---|---|---|---|---|---|---|
| `src/app/page.tsx` | X (lines around F5, F7) | | | X (lines around per-tile gate) | | | |
| `src/components/insights/health-score-card.tsx` | X (F8 width/size) | | | | | | seq (BL-P4-9 L2 disclaimer — folded into B1 commit 6) |
| `messages/{de,en,fr,es,it,pl}.json` | seq (key inserts via B6) | | seq (key inserts via B6) | seq (key inserts via B6) | seq (key inserts via B6) | X (sweep + inserts) | |
| `src/components/insights/coach-panel/coach-settings-sheet.tsx` | | | | X (F14 retire pref) | | | seq (B7 symmetry — `space-y-4` cadence; no same-line) |
| `src/components/settings/account-section.tsx` | | X (F9, F11 grid layout) | | | | | seq (B7 symmetry — password-dialog `space-y-2`; different lines) |
| `src/components/admin/login-overview-section.tsx` | | | X (F23 carrier chip) | | | | seq (B7 symmetry — heading weight; different lines) |
| `src/components/insights/insights-tab-strip.tsx` | | | | X (F19 filter pills) | | | seq (B7 symmetry — no same-line if symmetry is below 5 LOC) |
| `src/lib/integrations/status.ts` | | | | | X (F20, F21 helper + payload) | | |

### Same-line collisions

**Zero.** The collision matrix has no row with two `X` marks in non-`seq` columns on the same lines. Every shared file either:
1. The two buckets edit different line ranges (e.g. `account-section.tsx` — B2 touches DOB+Language grid, B7 touches password dialog).
2. One bucket folds the other's touch into a single commit so only one bucket actually edits the file (e.g. B1 owns `health-score-card.tsx`; B7's BL-P4-9 L2 disclaimer polish lands in B1 commit 6 instead of a separate B7 commit).
3. The bucket dependency is sequenced via the dispatch plan (e.g. all i18n keys land in B6 after B1/B2/B4/B5 — the inserting buckets only reference key names in code, never edit JSON).

### Sequenced edits documented

1. **`src/components/insights/health-score-card.tsx`** — B1 owns this file (F8 width/size rebalance + disclaimer polish folded in). B7 explicitly excludes the L2 disclaimer touch — B7 dispatcher prompt names this exclusion.

2. **`messages/{de,en,fr,es,it,pl}.json`** — Only B6 touches these files. B1, B2, B4, B5 reference new keys in their components but never edit the JSON. B6 runs last and adds every key in one sweep, alongside the BL-P1-1 dead-key cleanup and BL-P6-7 date-format swaps.

3. **`src/app/page.tsx`** — B1 owns the F5 InsightsCardPreview removal + F7 banner. B4 owns the per-tile availability gate. Both edits land in B4's "per-tile availability gate" commit, which runs after B1 lands; no merge conflict because B1 already removed the InsightsCardPreview by the time B4 touches the file.

4. **Settings + admin shells** — B2 owns the `min-h-[calc(100dvh-12rem)]` add to `<main>`. B7's symmetry sweep does not re-touch these files; the heading-weight standardisation lives in the section components (`/settings/[section]/page.tsx`), not the shells.

---

## Section 4 — Decision on uncertainties

### Decision A — `/api/audit-log` direction

**Default-decided: DELETE.**

Rationale:
- Endpoint exists at `src/app/api/audit-log/route.ts:13` with zero UI consumer.
- v1.4.27 is the polishing release before the iOS client ships against locked OpenAPI contracts.
- An orphan endpoint silently lands in the contract surface and signals "supported" when it is not.
- If the maintainer wants the surface back, a fresh implementation against a v1.4.28 design pass is cleaner than reviving a dead one — the new design can be scoped against actual UI needs (Settings → audit history? Admin → user audit log?) and against the locked iOS contracts.

Implementation: B7 commit 7 deletes the route, its DTO, its test fixture.

### Decision B — iOS server-side preps for v1.4.27

**Decided: NONE in v1.4.27.**

R1.5 enumerated four additive server contracts:
- `syncVersion Int @default(1)` column on `Measurement`
- `deletedAt DateTime?` soft-delete column on `Measurement`
- `GET /api/sync/state` endpoint
- ETag / `If-Modified-Since` on read endpoints

All park to v1.4.28. Rationale:
- v1.4.27 is a QoS-pass release per the maintainer directive. The 27 findings + 17 backlog items already fill the budget.
- The iOS-side inversion (SwiftData canonical, pairing toggle, standalone gating) can ship purely on the iOS client without server changes. Standalone mode persists locally; pairing replays the existing `/api/measurements/batch` contract that already exists.
- Adding two columns + an endpoint + ETag in v1.4.27 would burn a Prisma migration window for a client surface that does not yet consume them.
- v1.4.28 is the natural home: the iOS client will have shipped its first beta and the columns + endpoint can land alongside the corresponding iOS feature commits.

### Decision C — iOS surfaces in v1.4.27

**Decided: write `.planning/v15-ios-handoff/22-offline-first-architecture.md`, otherwise nothing iOS-specific lands.**

The new doc carries R1.5's research forward for the iOS-side reader who already has the 21-file handoff pack. It documents:
- The three viable architecture patterns (on-device-first + optional pairing, HealthKit-canonical, status quo + offline banner) and the Option A recommendation.
- Pairing flow, sync trigger list, conflict-resolution policy (last-writer-wins via `syncIdentifier + syncVersion`).
- Feature parity matrix (which surfaces work standalone, which require pairing).
- Server-side preps that will land in v1.4.28.

The doc is read-only research; no engineering effort beyond writing the file.

### Decision D — F7 weekly-report dead click investigation budget

**Decided: 30-minute scan window in B1.**

If a dead affordance turns up via grep on "Wochenreport" / "weekly report" strings → remove it (Option B from R1.1).
If nothing turns up → defer F7 to v1.4.28 with a maintainer-screenshot ask, documented inline in the B1 commit message.

No dashboard banner (R1.1 Option A) — that's a v1.4.28 feature ask, not a QoS-pass fix.

### Decision E — F16 cache hygiene

**Decided: no migration, no manual cache wipe.**

Old contaminated `auditLog.details.text` rows expire naturally via the daily-key cache rolling forward. The Layer-1 consumer-side `stripChartTokens` wrap means existing rows render clean immediately. Net: zero migration cost, zero deploy-time wipe.

---

## Section 5 — iOS server-side preps (v1.4.27)

**None.** See Decision B above.

The full server-side iOS-prep menu (`syncVersion`, `deletedAt`, `GET /api/sync/state`, ETag) goes into the v1.4.28 backlog as a single coordinated mini-release.

---

## Section 6 — iOS surfaces in v1.4.27

**One additive doc:** `.planning/v15-ios-handoff/22-offline-first-architecture.md`.

The doc summarises R1.5's six-app competitive landscape, the three architecture patterns + Option A recommendation, the proposed pairing flow, the sync conflict-resolution policy, the feature-parity matrix, and the server-side preps that will land in v1.4.28. Marc-Voice English. No prescriptive iOS code; the doc is a handoff to the iOS-side reader who already has the 21-file pack at `.planning/v15-ios-handoff/`.

This doc lands in the same commit as this fix plan.

---

## Section 7 — Round 3 dispatch sequence

### Round 3a — Parallel buckets (5 contributors)

Dispatch B1, B2, B3, B4, B5 in parallel. Each is touch-disjoint from the others; the only cross-bucket reference is to translation keys, which all land in B6.

| Bucket | Estimated commits | Files touched | Risk |
|---|---|---|---|
| B1 — Dashboard rebuild | 6 | ~17 | Medium (GLP-1 tile is the most complex single surface) |
| B2 — Settings form + shell shift | 4 | ~10 | Low |
| B3 — Geo offline + ASN carrier | 3 | ~14 | Medium (Prisma migration + Docker image growth) |
| B4 — Coach + Insights data-driven | 5 | ~24 | Medium (touches every insight sub-page) |
| B5 — Notifications hardening + locale | 3 | ~15 | Low-Medium (touches the alert ladder) |

Estimated wall-clock for Round 3a: bounded by B1 (the heaviest bucket).

### Round 3b — Sequenced buckets (2 contributors, run after 3a closes)

| Bucket | Why sequenced | Dependencies |
|---|---|---|
| B6 — i18n sweep | Picks up every key insertion from B1, B2, B4, B5 | After B1, B2, B4, B5 |
| B7 — Symmetry sweep + dead-code | Touches files B1/B2/B3 already edited; must not re-shuffle their work | After B1, B2, B3 (B4, B5 do not collide with B7) |

B6 and B7 can run in parallel with each other — they touch disjoint files.

### Total round structure

```
Round 3a (parallel 5):  B1  B2  B3  B4  B5
                         |   |   |   |   |
Round 3b (parallel 2):     B6      B7
                            |       |
Round 4 (QA pass):     8 parallel reviewers (per existing v1427-plan.md)
Round 5 (Release):     editorial + version bump + PR develop→main + tag
```

### Dispatch instructions for the orchestrator

1. **Open Round 3a** by dispatching B1, B2, B3, B4, B5 simultaneously. Each contributor reads this fix plan, jumps to their bucket section, and follows the dispatcher-prompt skeleton.
2. **Gate before Round 3b**: confirm all five Round 3a buckets landed clean. Re-check the collision matrix on `develop` HEAD before opening B6 + B7.
3. **Dispatch B6 + B7** in parallel after the Round 3a gate. B6's first commit (dead-key cleanup) must land before B6's third commit (key inserts) so the locale-integrity baseline updates in the right order.
4. **No dispatch into Round 4** until both B6 and B7 close. Round 4 (8 parallel QA reviewers) runs against the post-B7 HEAD.

---

## Section 8 — Headline metrics for the R2 report

| Metric | Value |
|---|---|
| Fix-surface count | 7 |
| Apply-now count (Critical + High + Medium) | 27 unique items (10 High + 17 Medium) + 11 Low-tier polish = 38 total items applied in v1.4.27 |
| Defer-v1.4.28 count | 20 (per R1.6 sweep) + 4 iOS server-side preps = 24 |
| Reject-as-resolved count | 11 (per R1.6 sweep) |
| File-touch same-line collisions | 0 |
| Sequenced edits documented | 4 (health-score-card, messages JSONs, `src/app/page.tsx`, settings/admin shells) |

---

## Anti-goals (re-affirmed from `v1427-plan.md`)

- No iOS-side code in this release (the iOS client is a separate repository).
- No MDR / regulatory scope expansion. GROUND RULES 1-15 stay verbatim.
- No new Prisma migrations beyond the single additive `IF NOT EXISTS`-guarded `AuditLog.asn + .carrier` migration in B3.
- No `BASE_SYSTEM_PROMPT` revival — bucket B7 deletes it.
- No new release model — develop → main, tag on main, GHCR multi-arch from main only.

---

## Done when

This fix plan is complete when:
1. `.planning/v1427-fix-plan.md` exists with seven labelled buckets and a clean collision matrix.
2. `.planning/v15-ios-handoff/22-offline-first-architecture.md` exists with R1.5's research in the iOS-handoff voice.
3. The single fix-plan commit is on `develop` and pushed.
4. Round 3a has its dispatch order documented and ready for the orchestrator to relay.

The implementation work itself starts in Round 3a, not in this commit.
