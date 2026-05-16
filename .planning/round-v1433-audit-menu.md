# v1.4.33 menu-structure audit

Read-only audit of every navigation surface in the web app. Goal: find the duplicates and overstuffed strips that show up when you actually count items, plus the few stale entries that should have followed retired features out the door.

## 1. Executive summary

Overall the navigation model is healthy but it is undeniably overstuffed on three surfaces and carries one true duplicate.

- **One genuine duplicate.** `Notifications` exists twice in the user-menu dropdowns — once as the `/notifications` inbox/preferences page (linked from both the sidebar user-card menu and the mobile top-bar dropdown) and once as a Settings section at `/settings/notifications` (channel cards: Telegram, ntfy, Web Push, plus the Notification status panel). The two destinations do not share content and both names read as "Notifications" in copy. This is the most visible duplicate in the product today.
- **Three overstuffed surfaces.**
  - **Settings sidebar — 11 sections.** That is one above the "seven plus or minus two" comfort limit and the strip now scrolls horizontally on a Pixel-5 width, which the maintainer wired the `no-scrollbar` shim around. Several adjacent sections (Sources next to Thresholds, Export as a one-page section, Advanced as a two-card section) could be merged or absorbed.
  - **Insights tab strip — twelve pills.** Overview plus eleven metric tabs (Blutdruck, Gewicht, Puls, Stimmung, Medikamente, BMI, Schlaf, Workouts, HRV, Ruhepuls, Sauerstoff, Körpertemperatur, Aktive Energie). The right-edge fade is hiding the fact that on a phone the user can only see two-and-a-half pills before scrolling. The wave-A HealthKit additions in v1.4.32 doubled the count without grouping.
  - **App sidebar — seven primary + Bug Report + Admin + Settings + user card.** The home label is the German `Home` translation but the icon links to `/` which we also call `Dashboard` in `nav.dashboard`. The two labels share one destination and one icon. The mobile bottom-nav is honest about it (5 primary + More); the desktop sidebar is not.
- **Retired tile leftovers.** Per v1.4.28 retirement of GLP-1 dashboard tile + `InsightAdvisorCard` + the weekly-report flow, two artefacts are still around: the `assistant-disabled-notice.tsx` component (orphan — zero render sites in source today, only a feature-flag comment references it) and the still-shipped `glp1-plateau` finding type wired into Daily Briefing icons + routing, even though the `glp1` widget id has been filtered out of `DASHBOARD_WIDGET_IDS` on read. These are not menu items but they're "menu-adjacent" surfaces (icons in the briefing, routes that survive the legacy layout filter).

The fix is mostly grouping and renaming, not deletion. The actual code-removal scope is small.

## 2. Settings nav inventory

Source of truth: `SETTINGS_SECTIONS` in `src/components/settings/settings-shell.tsx` and `SETTINGS_SECTION_SLUGS` in `src/components/settings/section-slugs.ts`. Eleven slugs, in this order:

1. **Account** (`/settings/account`) — `<AccountSection>` ships four card-style subsections:
   - Profile (username, email, gender, height, date-of-birth, language, timezone)
   - Passkeys (list + Add)
   - Password reset (button-only card opening a Dialog)
   - Onboarding tour replay (button-only card)
2. **Integrations** (`/settings/integrations`) — Withings + moodLog cards. Conditional on moodLog feature flag.
3. **Notifications** (`/settings/notifications`) — Notification status card + Telegram + ntfy + Web Push. Each conditional on the global-services availability envelope.
4. **Dashboard** (`/settings/dashboard`) — single `<DashboardLayoutSection>` card holding comparison-baseline picker + the widget toggle table.
5. **Thresholds** (`/settings/thresholds`) — single `<ThresholdsEditorSection>` card.
6. **Sources** (`/settings/sources`) — source-priority editor card + per-metric override list + device-type ordering.
7. **AI auswertungen** (`/settings/ai`) — single dropdown-driven `<AiInsightsCard>` (provider Select → matching config form → fallback chain → runtime actions row).
8. **API & Tokens** (`/settings/api`) — API endpoints catalogue card + API tokens list/create card.
9. **Export** (`/settings/export`) — five export cards in a 2-col grid (Doctor report PDF, Measurements CSV, Medications CSV, Mood CSV, Full Backup JSON).
10. **Advanced** (`/settings/advanced`) — Research-mode toggle card + Data-reset (danger zone) card.
11. **About** (`/settings/about`) — Identity card + Links card + Updates check card.

### Drift findings

- **Section count is one over the comfort line.** Eleven scrollable items on the mobile chip strip is already pushing the no-scrollbar shim. The maintainer's directive ("die Menüs dürfen nicht überfrachtet sein") reads cleanly on this surface.
- **Sources sits weirdly alone.** "Quellen-Priorität pro Metrik" is conceptually the same shelf as Thresholds — both are per-metric configuration that the user sets once and rarely revisits. Merging Sources into Thresholds (or into Dashboard as a "Per-metric data" tab) would drop one section without losing functionality.
- **Advanced is two unrelated things.** Research-Modus (opt-in chart enhancement, BookOpenCheck icon, purple) sits in the same section as "Daten löschen" (destructive nuclear button, red, AlertTriangle). They share a section heading but nothing else. Research-Modus is a feature toggle that fits more naturally under Dashboard (it changes chart rendering) or under AI auswertungen (it is research-grade behaviour). The danger zone alone justifies the section name "Advanced"; pulling Research-Modus out would let "Advanced" rename to "Daten-Verwaltung" or "Gefahrenbereich".
- **API & Tokens reads as developer-facing**, but it shows up between AI auswertungen and Export. The two endpoint rows in the catalogue (`POST /api/ingest/medication`) plus the bearer-token list could move under Integrations as an "External access" tab, since both Withings and an API token are "how external systems talk to my data."
- **Export is one screen.** Five cards in a 2-col grid is fine, but it earns a top-level slot that the user only visits once or twice a month. Folding it into Account → Profile actions (one more card alongside the Tour replay) or into Advanced is defensible.
- **About is three small cards.** Version + Links + Update check. The whole section fits in 250 vertical px on desktop. Folding About into the sidebar bottom-strip (next to Settings, with an Info icon) avoids spending a top-level slot on a screen the user reads once. There is precedent: the `/about` route already exists as a public page (`PUBLIC_PATHS` in `auth-shell.tsx` includes it).
- **No subsection duplicates within sections.** Card headings inside each section are unique; the audit caught the lazy "Settings → AI → KI-Insights" naming where the section title is "KI-Auswertungen" but the inner card title is "KI-Insights" — those are the same concept twice in two breaths and read as a duplicate even though they are technically section + card.

### Hidden / placeholder

- `<SectionPlaceholder>` is still wired into the dynamic route as a defensive fallback for slugs added to `SETTINGS_SECTION_SLUGS` without a matching component, but every current slug has a component. Locale key `settings.sections.placeholder.coming_soon` ("Wird mit dem nächsten Release-Update hierher umziehen") is dead copy — no live surface renders it. Safe to keep as a guard, but the locale string is reachable only via a code-path that the type system blocks today.

## 3. App header / sidebar

Source of truth: `src/components/layout/sidebar-nav.tsx` (desktop sidebar, `navItems` array) and `src/components/layout/top-bar.tsx` (mobile-only auth + theme dropdown).

### Desktop sidebar inventory

Top half — `navItems` group under the "Home" section label:
1. Dashboard (`/`, Home icon, `nav.dashboard`)
2. Messungen (`/measurements`, Activity icon, `nav.measurements`)
3. Stimmung (`/mood`, Waves icon, `nav.mood`)
4. Medikamente (`/medications`, Pill icon, `nav.medications`)
5. Insights (`/insights`, Lightbulb icon, `nav.insights`)
6. Zielwerte (`/targets`, Target icon, `nav.targets`)
7. Erfolge (`/achievements`, Trophy icon, `nav.achievements`)

Bottom strip — utility links:
8. Bug Report (`/bugreport`, Bug icon, gated on `bugReportEnabled` feature flag)
9. Admin (`/admin`, Shield icon, role-gated `ADMIN`)
10. Einstellungen (`/settings/account`, Settings icon)

User card — Avatar + username + ChevronMore opens dropdown:
- Benachrichtigungen (`/notifications`, Bell icon)
- Darstellung submenu (System / Dark / Light)
- Abmelden

### Findings

- **"Home" label vs Dashboard.** The section title above `navItems` reads "Home" (`nav.home`), the first entry then reads "Dashboard" (`nav.dashboard`). Both point to `/`. Most apps either drop the group label entirely (the sidebar has only one group anyway) or rename the group to "Main" and let the first item own "Dashboard". The current phrasing reads as if there are two destinations for the homepage.
- **Theme submenu is the weakest "user" entry.** Three radio-style theme options sit inside a submenu inside a dropdown inside a user card. A Settings → Account "Display" toggle (single row) would surface the theme one fewer click away and let the user-card dropdown shrink to Notifications + Logout.
- **Bug Report is a primary destination.** It sits next to Admin as a sidebar bottom-strip link, which is unusual — most apps surface bug reporting through a help menu or a corner action. It is feature-flag-gated (`bugReportEnabled`) so on most deployments it disappears, but on dev/internal deploys it occupies a sidebar slot. Worth considering moving into the user-card dropdown alongside Logout.
- **No duplicate routes inside the sidebar itself.** `/notifications` (in dropdown) vs `/settings/notifications` (Settings section) is the cross-surface duplicate called out in the executive summary.

### Mobile top-bar findings

The mobile top-bar dropdown duplicates four items from the sidebar user-card dropdown (Settings / Benachrichtigungen / Theme submenu / Logout). That's the intended parity per the auth-shell split (desktop puts the user controls in the sidebar, mobile in the top-bar) — not a bug, just a maintenance note: any rename has to land in both files.

## 4. Insights tab strip

Source of truth: `SUB_PAGE_TABS` in `src/components/insights/insights-tab-strip.tsx`, `SUB_PAGE_METRIC` in `src/lib/insights/sub-page-metric.ts`, and `buildTabs()` for the gating logic.

### Inventory (in order)

1. Overview (`/insights`)
2. Blutdruck (`/insights/blutdruck`)
3. Gewicht (`/insights/gewicht`)
4. Puls (`/insights/puls`)
5. Stimmung (`/insights/stimmung`)
6. Medikamente (`/insights/medikamente`)
7. BMI (`/insights/bmi`)
8. Schlaf (`/insights/schlaf`)
9. Workouts (`/insights/workouts`)
10. HRV (`/insights/hrv`)
11. Ruhepuls (`/insights/ruhepuls`)
12. Sauerstoff (`/insights/sauerstoff`)
13. Körpertemperatur (`/insights/koerpertemperatur`)
14. Aktive Energie (`/insights/aktive-energie`)

Plus the right-edge Regenerate icon button on the mother page only.

### Findings

- **Fourteen pills is a lot.** The data-driven gating (`hasMetricData(metric, availability)`) hides empty pills, so a fresh account sees fewer. A power user with Withings + Apple Health connected will see every pill. The maintainer's own setup ships every pill. On `<sm` viewports the user sees roughly Overview + Blutdruck + half of Gewicht before the fade kicks in.
- **The five wave-A HealthKit pills sit at the end.** HRV, Ruhepuls, Sauerstoff, Körpertemperatur, Aktive Energie were added in v1.4.32 and stacked behind every existing pill. They are a coherent group ("vital signs from a wearable") and would naturally collapse into a single Vital-Signs sub-page with its own internal switcher, or into a single "Apple Health" pill that fans out the five metrics inside.
- **Body-composition group.** Gewicht + BMI are the same domain (weight-derived). The BMI sub-page already references the WEIGHT measurement series and adds a profile-height computation. Folding BMI into the Gewicht sub-page as a chart toggle drops a pill without losing functionality.
- **Pulse-domain redundancy.** Puls is the live heart-rate pill, Ruhepuls is resting HR, HRV is heart-rate variability. These three pills are three views on cardiovascular data. Grouping them under a "Herz" pill with internal tabs is the cleanest path and matches how Apple Health groups them.
- **Workouts is the right kind of new.** v1.4.32 added the pill alongside the dashboard tile + sub-page; the tab strip placement (after Schlaf, before the wave-A HealthKit cluster) reads correctly because it sits next to Sleep, which is also event-driven.
- **No literal duplicates** — each pill links to its own route and renders different content.

## 5. Mobile sheet menus

### Bottom-nav

Source of truth: `src/components/layout/bottom-nav.tsx` (`PRIMARY` + `OVERFLOW`).

- **Primary (5):** Dashboard, Messungen, Stimmung, Medikamente, Insights.
- **More sheet (2):** Zielwerte, Erfolge.

That decision (4-out-of-5 most-used + Insights, with Targets/Achievements moved into the More sheet) was made in v1.4.16 wave-C MED. It tracks the desktop sidebar's `navItems` ordering, so mobile and desktop are not diverging.

### Mobile Settings strip

Source of truth: the `<md:` branch inside `<SettingsShell>`. Renders all 11 settings sections as a horizontally scrollable chip strip with the `no-scrollbar` shim. Same items as desktop sidebar. Not diverging.

### Findings

- **Bottom-nav is correct.** Five primary + More is the WCAG 2.5.5-compliant split the maintainer landed in v1.4.16 and re-confirmed through v1.4.22; no overstuffing here.
- **More sheet is anaemic.** Two entries (Zielwerte + Erfolge) is enough to justify a sheet but feels light next to a five-tab primary. If the desktop sidebar gets pruned (Bug Report → user card, About → user card) the mobile More sheet will not gain those items because they live in `top-bar.tsx`'s mobile dropdown, not in bottom-nav. The two surfaces should keep parity on which items live where.
- **No mobile-only nav items.** Every mobile destination is reachable from desktop. No orphan routes.

## 6. Orphan / retired items still in code

The v1.4.28 retirement list (GLP-1 dashboard tile, `InsightAdvisorCard`, weekly-report) left a few menu-adjacent artefacts:

- **`AssistantDisabledNotice` (`src/components/insights/assistant-disabled-notice.tsx`).** Component still exported. Zero JSX render sites in source code (only a doc-comment in `src/lib/api-handler.ts` and a doc-comment in `src/lib/feature-flags/index.ts` reference it). It was introduced in v1.4.31 for the operator-disabled assistant surface, but no caller mounts it today. Either wire it where the Coach / Briefing / Insight Status surfaces handle the disabled state (a one-line render) or drop the file. Not strictly a menu item but a navigation-adjacent empty state.
- **`glp1` dashboard widget id.** `resolveDashboardLayout()` filters this id out of `DASHBOARD_WIDGET_IDS` on read, so a legacy layout that still carries it gets cleaned silently. Good defence; no menu surface exposes it. The Settings → Dashboard widget toggle table is built from `DASHBOARD_WIDGET_IDS` directly, so the retired tile is invisible there.
- **`glp1_plateau` finding type.** Still wired in `daily-briefing.tsx` (`FINDING_TYPE_HREF` + `FINDING_TYPE_ICON`) and routes the user to `/insights/medikamente`. The medication sub-page itself still mounts `<TherapyTimeline>` and the `/api/insights/glp1-timeline` route. None of this is a menu entry, but the v1.4.28 retirement was about the dashboard tile + advisor + weekly-report; the GLP-1 medication-tracking surfaces in Insights → Medikamente are intentionally still alive. Worth a one-line confirmation in the release brief so a future audit doesn't accidentally pull them.
- **`/settings/[section]/SectionPlaceholder` empty-state.** Unreachable today because every slug in `SETTINGS_SECTION_SLUGS` has a wired component. The defensive code stays; the locale key is dead.
- **`InsightStatusCard` is alive.** It mounts on five sub-pages (`bmi`, `blutdruck`, `gewicht`, `puls`, `stimmung`) and on `medikamente`. Not retired.
- **`InsightAdvisorCard` is gone.** No source-tree references outside doc comments. The mother page now renders `<HeroStrip>` + `<DailyBriefing>` + `<CorrelationRow>` + `<TrendsRow>` and the advisor data flows into the hero rather than a dedicated card.

## 7. Consolidated recommendation

Three buckets: things to merge, things to rename, things to verify.

### Merge / regroup

1. **Insights tab strip — group the five wave-A HealthKit pills under "Apple Health".** Single pill that opens an indexed sub-page with internal tabs (HRV / Ruhepuls / Sauerstoff / Körpertemperatur / Aktive Energie). Drops four pills from the strip. Keeps each metric reachable.
2. **Insights tab strip — fold BMI into Gewicht.** The BMI sub-page is essentially the Gewicht sub-page with a different chart projection. Add a chart-cog toggle on the Gewicht page; drop the BMI pill.
3. **Settings → Sources merges into Thresholds.** Both are per-metric configuration screens. "Zielwerte & Quellen" reads cleanly as a combined section. Drops one settings slot.
4. **Settings → About folds into the sidebar user-card dropdown.** Single entry "Über HealthLog" opens the existing `/settings/about` route or a Sheet variant. Drops one settings slot.
5. **Settings → Advanced renamed to "Daten-Verwaltung"** with Research-Modus moved up into AI auswertungen or Dashboard (it changes chart rendering). Drops the conceptual mismatch of two unrelated cards sharing a section.
6. **User-card dropdown — promote `/notifications` to its own primary destination.** Either keep it in the user-card dropdown OR rename the Settings → Notifications section to "Benachrichtigungs-Kanäle" so the inbox vs configuration split reads cleanly.

### Rename

1. **`nav.home` group label.** Either drop it (the sidebar has one group) or rename to "Main". The current phrasing makes "Home" and "Dashboard" read as two destinations for the same route.
2. **AI section card heading.** Settings → AI uses section title "KI-Auswertungen" and card title "KI-Insights" inside it. Pick one. Recommendation: drop the card title (the section already has a heading + description; an inner H2 of the same concept is dead weight).
3. **Notifications double naming.** If both pages stay, rename `/notifications` to "Benachrichtigungs-Einstellungen" or fold it into Settings → Notifications. The `/notifications` page is a preferences-by-event-type matrix; Settings → Notifications is a per-channel configuration. The split exists but the names should reflect it.

### Verify (small dead-code sweep)

1. **Drop or wire `AssistantDisabledNotice`.** If the Coach / Briefing / Insight Status surfaces should show the operator-disabled empty state, the component needs render sites. If not, the file goes.
2. **Confirm GLP-1 finding-type routing.** The `glp1_plateau` finding in Daily Briefing routes the user to `/insights/medikamente`. v1.4.28 retired the dashboard tile + advisor + weekly-report but kept GLP-1 medication tracking; the briefing routing is intentional. Mention this in the release brief so a future menu audit doesn't pull it as orphan.
3. **Remove `settings.sections.placeholder.coming_soon` locale key.** Unreachable. The `<SectionPlaceholder>` guard can keep its EmptyState by inlining a generic "coming soon" string or by inheriting the section title only.

### Scope estimate for v1.4.33

The merge / regroup items are user-facing UX decisions that need a single design pass; the rename items are one-line text changes; the verify items are five-minute deletions. Suggested split:

- **In v1.4.33 (polish-and-reliability):** rename items (one-line strings) + verify items (delete dead code) + the user-card / `/notifications` clarification. Low risk, high readability gain.
- **Defer to v1.4.34 or v1.5:** the Insights tab-strip regrouping and the Sources / Thresholds merger. These are real UX changes that need a screenshot review with the maintainer before shipping.

The overstuffing the maintainer felt is real. The duplicate-Notifications loop is the one item every user with a sidebar open right now is double-clicking on. That fix alone earns the patch its name.
