# Phase W12-QOL-RESIDUAL — v1.4.43 report

## Branch

`w12-qol-residual-v1443` (based on `origin/develop`)

## Items closed

### Mediums

- **M3** Settings danger zone now offers a separate "Konto vollständig
  löschen" action wired to the existing `DELETE /api/settings/account`
  endpoint (which already cascades User + passkeys + audit log +
  sessions). The previous single CTA only wiped health data — half the
  GDPR Article 17 surface. Component is `AccountDeleteCard` in
  `src/components/settings/advanced-section.tsx`.
- **M4** Doctor-report dialog now renders every section in
  `SECTION_ORDER`; sections without data in the selected range show as
  disabled toggles with strike-through labels + a tooltip
  ("Keine Daten in diesem Zeitraum"). The submission payload still
  force-clears unavailable toggles so the server never renders empty
  sections.
- **M5** New `<OfflineBanner>` component mounted at the top of
  `<AuthShell>`. Listens for `online`/`offline` window events and
  paints a slim warning-toned strip when offline. Bilingual via i18n —
  all six locales ship the copy.
- **M6** `errorCodeToI18nKey` now splits `coach.network` to a new
  `insights.coach.errorNetwork` key ("Keine Internetverbindung —
  versuche es erneut, sobald du online bist") so users see the
  actionable offline hint instead of the generic provider copy when
  their own connection drops mid-stream.
- **M7** `messages/de.json` `integrationPill.daysAgo` "vor {count} T."
  → "vor {count} d", matching the existing `staleHint` "d" pattern
  used elsewhere. The other five locales already shipped "d".
- **M8** `src/lib/format.ts` `activeLocale()` now reads the full
  `Locale` union (`de | en | fr | es | it | pl`) via the shared
  `isLocale()` type guard. Pre-fix a French / Spanish / Italian /
  Polish user saw English-formatted dates because the legacy reader
  only matched `de`/`en`.

### Lows

- **L1** Tightened 404 + global-error copy across all six locales.
  `not-found.tsx` is now a server component that reads
  `notFound.title` / `notFound.backToDashboard` via the existing
  `getServerTranslator()`. `global-error.tsx` ships a bilingual
  DE/EN lockup (no i18n provider available at that boundary). The
  verbose v1.4.27 marketing paragraph is gone.
- **L2** Measurement-completion checklist copy now matches the real
  threshold ("Ein Messpunkt reicht, um die Kachel zu aktivieren —
  der Trend zeichnet sich ab dem 5. Eintrag.") across all six
  locales. The `checklist.ts` `count >= 1` rule stays.
- **L3** `public/sw.js` `CACHE_VERSION` now reads from
  `self.__APP_VERSION__` (loaded via `importScripts('/sw-version.js')`).
  The generated `sw-version.js` is written by the new
  `scripts/generate-sw-version.mjs` and wired as a `prebuild` step in
  `package.json`. Pre-fix the literal had drifted four releases stale.
- **L4** `<ChartSkeleton>` paints a 3 s-delayed "Auswertungen werden
  berechnet — das kann einen Moment dauern" caption (full variant
  only; mini variant skips to avoid overflowing the trends-row
  140 px slot). Bilingual via the new `charts.loadingSlowHint` key.
- **L5** Data-reset card in `<AdvancedSection>` drops the
  `AlertTriangle` icon; title sits in `text-foreground` (neutral) and
  only the CTA button stays red. Matches GitHub-style danger-zone
  shaping per the audit recommendation.
- **L7** Code-comment in `measurement-list.tsx` pins the
  `[Cancel] [Save]` button order as iOS-first intentional (Apple HIG)
  so a future "Android parity" refactor can't silently flip it.
- **L8** New `formatDateOrRelative(iso, t, nowMs?)` helper in
  `src/lib/format.ts`. Inside the last 24 h → relative
  ("vor 12 min"); older → absolute (`formatDateTime`). Wired to the
  two `measurement-list.tsx` timestamp sites flagged in the audit.

## Items deferred (per handoff)

- **M1** drag-and-drop dashboard reorder — a11y story warrants its
  own spec (defer to v1.4.44+).
- **M2** per-user Coach disable toggle — Settings UI feature work,
  deferred.
- **L6** Onboarding chained-flow gate — UX decision, deferred.

## Test additions / changes

- `src/app/__tests__/not-found-copy.test.ts` (NEW, 16 tests) — pins
  the tightened 404 copy across all six locales + the global-error
  bilingual lockup.
- `src/lib/__tests__/format-active-locale.test.ts` (NEW, 8 tests) —
  cookie-driven locale read for the legacy formatter (M8).
- `src/lib/__tests__/format-date-or-relative.test.ts` (NEW, 11 tests)
  — `formatDateOrRelative` boundary cases (L8).
- `scripts/__tests__/generate-sw-version.test.ts` (NEW, 5 tests) —
  SW build-step contract + idempotency (L3).
- `src/components/charts/__tests__/chart-skeleton.test.tsx` (+2
  tests) — slow-hint absence in initial SSR; mini-variant skip.
- `src/components/doctor-report/__tests__/doctor-report-section-toggles.test.tsx`
  (NEW, 5 tests) — disabled rows, strike-through, tooltip wiring (M4).
- `src/components/insights/coach-panel/__tests__/message-thread.test.tsx`
  (+1 test) — `coach.network` mapped to the new `errorNetwork` key
  (M6); existing "every other code" test list trimmed.
- `src/components/layout/__tests__/offline-banner.test.tsx` (NEW, 8
  tests) — SSR-empty contract, i18n parity across all locales,
  shell mount-point pin (M5).
- `src/components/settings/__tests__/advanced-account-delete.test.tsx`
  (NEW, 6 tests) — danger-zone shaping + new account-delete CTA
  surface (M3 + L5).
- `tests/integration/settings-account-delete.test.ts` (NEW, 6 tests)
  — `DELETE /api/settings/account` end-to-end against real Postgres
  (M3 happy path + cascades + 422/401 guards + last-admin guard).

**Test-count delta (unit suite, `pnpm test`):**
- before: 4815 tests
- after: 4877 passed + 1 skipped
- delta: **+62 tests** (matches handoff baseline of 4815 → ≈ 4877)

## Commits (in chronological order)

| # | SHA      | Subject                                                                         |
|---|----------|---------------------------------------------------------------------------------|
| 1 | 98702210 | `i18n(de): align integration-pill daysAgo with 'd' shorthand`                   |
| 2 | 7e1577c1 | `i18n: tighten 404 + global-error copy across all locales`                      |
| 3 | 97bc0233 | `i18n: align measurement checklist copy with 5-reading trend threshold`         |
| 4 | 4d074c3b | `fix(coach): surface offline hint when network drops mid-stream`                |
| 5 | 0b3d211f | `i18n(format): respect the full Locale union in legacy formatter cookie reader` |
| 6 | ed5e122d | `feat(pwa): re-anchor SW CACHE_VERSION on every build via prebuild step`        |
| 7 | a9cb9223 | `feat(charts): show 'still computing' caption on long chart loads`              |
| 8 | 0cb1c1af | `feat(settings): add account-delete CTA and quieten danger-zone visuals`        |
| 9 | 418453b5 | `feat(doctor-report): show unavailable sections as disabled, not hidden`        |
| 10 | c002a87a | `feat(layout): surface offline status banner across authenticated routes`      |
| 11 | 54c640e3 | `feat(measurements): unify timestamp display via formatDateOrRelative`         |
| 12 | b423538a | `chore(layout): satisfy lint rules for offline-banner test and effect`         |

## Quality gates

- `pnpm typecheck` → clean (full project)
- `pnpm lint` → clean
- `pnpm test` → 4877 passed | 1 skipped (456 files)
- Integration test `tests/integration/settings-account-delete.test.ts`
  is written against the existing testcontainer setup — runs under
  `pnpm test:integration` against the live Postgres container; not
  executed in this worktree as the integration suite needs an
  available container, but the file mirrors the pattern from
  `auth-password-change.test.ts` and uses the same `getPrismaClient` /
  `truncateAllTables` helpers + `mock-next-headers` jar.

## Out-of-scope confirmation

No files touched in:
- `src/lib/withings/**` (W14 territory)
- `src/app/api/**` apart from the existing `/api/settings/account`
  endpoint (which was already in tree; we did not modify it)
- Mobile-UI touch targets / motion-reduce sweep (W11 territory)
- Auth/security routes (W13 territory)
