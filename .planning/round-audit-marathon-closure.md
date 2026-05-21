# v1.4.34.4 → v1.4.38.4 — Audit-Marathon Closure (extended)

Shipped: 2026-05-17 → 2026-05-18 (thirteen consecutive releases — capped by v1.4.38.4 making the post-deploy stale-shell self-healing so users no longer need a manual pull-to-refresh after every release).

| Tag | Highlights | Release |
| --- | --- | --- |
| v1.4.34.4 | Audit-driven hotfix bundle across security, UX, code quality, mobile-deep, docs, GitHub metadata | [v1.4.34.4](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.34.4) |
| v1.4.34.5 | Audit follow-on: 24 critical-path integration tests + iOS textarea zoom fix | [v1.4.34.5](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.34.5) |
| v1.4.35 | Layer B landed — persistent `measurement_rollups` foundation + partial reader read-swap on the comprehensive aggregator and the slim summaries slice | [v1.4.35](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.35) |
| v1.4.35.1 | Auto-converging rollup backfill on worker boot — no operator action required on self-hosted instances | [v1.4.35.1](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.35.1) |
| v1.4.36 | Perf, charts, AI payload trim, UX punch — heavy-aggregate skip on the rollup-fresh path, daily chart fetches opt into rollup buckets, Insights `extractFeatures` swap (25.9 MB → 30,096 tokens, **−99.5 %**), page-blocking call 10.88 s → 4.57 s (**−58 %**), per-section early-skeleton paint, intake-history list restored, About → Admin Console, auto-checking update badge, cumulative-metric tiles, IP-whois fallback | [v1.4.36](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.36) |
| v1.4.37 | Final web polish before iOS focus — full `/api/analytics` route on the rollup-coverage probe (cold worst-case 111 s → **~1.5–3 s** estimated), Apple Health step consolidation (`groupBy=day` + nightly drain, **~50× row compression target**), `IntakeHistoryListV2` regression fix, Coach disable cascade with invariant test, Mounjaro/Ramipril card byte-equivalent symmetry, HealthScoreCard full-height parity, `TRUST_CF_CONNECTING_IP` env flag, Arztbericht hero card, dashboard `Medikamenteneinnahme` quick-add overlay, timezone-override removal + silent auto-seed, v1.4.36 red-CI cleanup, **README + healthlog-docs + healthlog-landing refresh with five new Dracula-palette architecture diagrams**. Unit suite 4354 → 4486 passing. | [v1.4.37](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.37) |
| v1.4.37.1 / v1.4.37.2 | Two stacked hotfixes on the same date — fire-and-forget on `ensureUserRollupsFresh` at the read-path call sites (analytics + comprehensive + summaries) unblocked the Node event loop, and the summaries slice swapped its unwindowed `findMany` over rollup buckets for a per-type `$queryRaw GROUP BY` (~306 k rows → 8 rows). | [v1.4.37.1](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.37.1) / [v1.4.37.2](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.37.2) |
| v1.4.38 | Closing punch-list before iOS focus — `/api/dashboard/summary` cold 4.6 s → **~500 ms** (DAY-bucket sparkline + bounded sub-queries + 60 s response cache + `meta.dashboard.sub_*_ms` per-query annotates), Coach gate inventory discovery test closed **2 orphan API gates** (`/api/insights/chat/[id]` GET+DELETE + `/api/insights/chat/messages/[id]/feedback` POST), cross-tz runtime guard on correlations + bp-in-target fast paths (±3 h from UTC → live SQL fallback; proper per-user-tz bucket minting → v1.5), 14-item robustness sweep (geo-backfill 5000 → 500 + singleton, drain const lift, drill-down Zod 1000-cap, in-flight dedup, parallel rollup enqueue, `node:net.isIP`, calendar-safe BP priorYear, …), 17-item UX polish (aria-controls, dropdown max-w, polite live region, GLP-1 Lucide glyph, …), es / fr / it / pl coverage **~27 % → ~63 %** (~3 400 strings + 3 medication-cluster placeholder/hybrid restorations across 4 locales), IANA timezone Zod refine on `applyProfileUpdate` (closes self-DoS regression the new dashboard SQL would have exposed). Unit suite 4486 → 4524. Squash to main clean (no conflicts this round). | [v1.4.38](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.38) |
| v1.4.38.1 | iOS v0.5.4 push-notification coord — admin-merge of PR #190 (APNs `MEDICATION_REMINDER` category for iOS action-buttons + opt-in `MOOD_REMINDER` daily 22:00 event with per-user ledger). Migration `0069_v054_mood_reminder` applied cleanly; iOS v0.5.4 connected on first deploy. Unit suite 4524 → 4565. | [v1.4.38.1](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.38.1) |
| v1.4.38.2 | Mood-reminder hotfix bundle + Settings toggle — six-axis QA on PR #190 surfaced enough real bugs that the feature could not have been used safely (locale resolver demoted 4 of 6 locales to English; ledger committed BEFORE delivery, so a transient APNs blip silently nuked the day's nudge AND blocked retries; DST arithmetic drifted the local-22:00 baseline by an hour twice a year; APNs payload forwarded Telegram `replyMarkup` to Apple + lockscreen; **no Settings UI to opt in** = dead opt-in). v1.4.38.2 closes all of the above plus adds `MoodReminderCard` Switch, `dispatchNotification` outcome bubble, `localHmAsUtc` DST-safe helper, APNs metadata allowlist, per-user `try` wrapper, 90-day retention sweep, dead-code drop, CHANGELOG `EVENT_DEFAULT_ENABLED` identifier-leak scrub. Unit suite 4565 → 4551 (mood-reminder.test.ts rewrite for new contract, not coverage loss). | [v1.4.38.2](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.38.2) |
| v1.4.38.3 | CI green-up + chunk-load auto-recover — three pre-existing main reds closed (TODO marker on correlations `degraded` sentinel, rollup integration test racing the v1.4.37.1 fire-and-forget rollup populator, e2e drift after the v1.4.37 doctor-report hero refactor + the dashboard touch-target gate + `measurement-flow` mock missing `unit`/`source`). Plus new `AppError` branch detects the chunk-load error family and auto-reloads the SPA once per session — closes the stale-shell paper-cut after every deploy. Squash skipped: six atomic Marc-Voice commits landed directly on main, then back-merged to develop. | [v1.4.38.3](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.38.3) |
| v1.4.38.4 | Pro-active stale-shell self-heal — Marc reported `healthlog.bombeck.io` "nicht erreichbar" on the v1.4.38.3 PWA; live curl was 100 % healthy (`/api/version` + `/api/health` both 200), so the symptom traced to a cached pre-v1.4.38.3 shell that never tripped the new `AppError` reload path. v1.4.38.4 layers three fixes so future deploys self-heal without user action: `<VersionPoller>` client component mounted in `<Providers>` polls `/api/version` every 60 s and on mismatch unregisters every SW, wipes CacheStorage, and `window.location.reload()`s (sessionStorage-gated to once per session); `next.config.ts` injects `NEXT_PUBLIC_APP_VERSION` from `package.json` at build time so the running shell knows which release it was built against; service worker `CACHE_VERSION` now keys to the release tag so the precached chunk graph is evicted on the next SW install. Tag re-pushed once after the editor-race dropped the `package.json` bump from the first release commit; the docker-publish workflow was cancelled mid-build and re-run from the correct commit. | [v1.4.38.4](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.38.4) |
| v1.4.38.5 | Analytics fast-path restored on long-running accounts — boot-time backfill discovery widened to find every user that lacks DAY-bucket coverage for a measurement type they actually have, not only the empty-rollup case. The post-v1.4.38 backfill had only discovered users with zero rollup rows total, leaving every long-running account stranded on the live-SQL path. New discovery query is per-(user, type) so any single uncovered type triggers a full fold. | [v1.4.38.5](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.38.5) |
| v1.4.38.6 | Boot-backfill discovery SQL fix — the widened v1.4.38.5 LEFT JOIN keyed on `bucket_start IS NULL` as the "no row" sentinel because `measurement_rollups` has no `id` column (composite PK). Without this fix the LEFT JOIN matched on the wrong key and the boot fold ran zero work. Single-line correctness fix; perf-verify continued into v1.4.38.7. | [v1.4.38.6](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.38.6) |
| v1.4.38.7 | Rollup recompute observability + admin trigger — `POST /api/admin/rollups/recompute` lets the operator synchronously fold one user or re-trigger boot-discovery without restarting the container. Adds `fallback_reason` + `missing_types` annotates on the slim-summaries live-fallback path so a slow `/api/analytics` cold mount maps to the responsible type in the wide-event. Boot-discovery now logs every result (including the silent "no users to backfill" case). | [v1.4.38.7](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.38.7) |
| v1.4.38.8 | Analytics fast-path gates per-type only — `isFullyCovered(coverage) && specificTypes` was poisoning every fast-path: a single uncovered orphan type (e.g. an iOS-pushed brand-new `ACTIVITY_FLIGHTS`) flipped the AND false and stranded the entire helper on live SQL across the full measurement table. `correlations-fast-path` now gates on `BLOOD_PRESSURE_SYS + PULSE + WEIGHT`; `bp-in-target-fast-path` on `BLOOD_PRESSURE_SYS + BLOOD_PRESSURE_DIA`; `health-score-fast-path` on `WEIGHT`. Cold-mount `/api/analytics` on power-user accounts drops from 30–75 s to ~3–5 s. Coverage-probe semantics unchanged. | [v1.4.38.8](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.38.8) |
| v1.4.40 | Comprehensive Critical+High architecture closure plus iOS PB30 enablement — eleven-wave parallel marathon closing every Critical + High from the v1.4.39 architecture-QA quadrology in one release per the operator's directive ("alle Critical+High in den nächsten finalen release, kein deferral, zeitlicher Aufwand egal"). Pool starvation root cause closed: `pLimit(4)` on the 15-way `Promise.all` fan-out in `buildAnalyticsResponse` plus `pg.Pool max=20` raised from the library default 10 (Wave-C chart-tile first-paint **+7.3 s → +1.6 s expected** on the empirical fixture). Six insights routes swapped to the mood-rollup tier (3 inline, 3 deferred with documented tier-shape reasons); `Measurement.deletedAt` full-wire across 16+ readers + the rollup writer (iOS soft-delete unblocked for PB30); WMY readers now live for `avg30LastYear` (was hardcoded null) + slope90 via MONTH-tier; per-tile `<Suspense>` boundaries plus `queryKey` factory enforcement (mood-analytics + mood-chart-data dedup); iOS SB-3 bilingual paired-on-one-page Privacy Policy, SB-4 AASA file at `/.well-known/apple-app-site-association`, SB-5 APNs `interruption-level: time-sensitive` for medication reminders only (gated on AP-2 `.p8` install), SB-6 `/api/notifications/status` per-category `lastDeliveredAt`, SB-7 four-branch test pin, SB-10 `POST /api/consent/ai` with append-only invariant + 64 KB Buffer-byte cap; ghost cleanup **−1 177 LOC** (TELEGRAM_CLEANUP_QUEUE dead worker, 3 orphan routes, 9 dead exports, 3 dead i18n keys); tz helpers consolidated into `src/lib/tz/`; `src/lib/rollups/` umbrella absorbing 7 files with 68 importer rewrites; knip CI workflow as release-branch gate. Six QA reviewer parallel + five reconcile fixes (test regex align, 6 insights `deletedAt`, `Promise.allSettled` recompute wrap, compare-toggle factory, consent `Buffer.byteLength`). Tests 4 525 → **4 726** (+201). Migration 0074 ConsentReceipt additive-clean. Cross-agent commit drift recurred a 4th time → per-agent git-worktree isolation now hard rule (`feedback_marathon_worktree_isolation.md`). | [v1.4.40](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.40) |
| v1.4.39.4 | Dashboard symmetry for daily-schedule intake projection — `/api/dashboard/summary` compliance tile mirrors the intake-route projection PR #191 landed in v1.4.39.3. Reuses `expandTodayIntakes` plus `createMany({ skipDuplicates: true })` race-guard against concurrent intake-route hits minting the same `(userId, medicationId, scheduledFor, REMINDER)` row before the existence probe converges. Plus `medication_intake_events` unique-by-source constraint migration `0073` underlying the `skipDuplicates` semantics, and a `recomputeUserMedicationCompliance` hook after the bulk insert closes the v1.4.39.3 compliance-rollup hook gap on the dashboard surface. Tests 4 648 → 4 662. | [v1.4.39.4](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.39.4) |
| v1.4.39.3 | Three distinct root causes from the post-v1.4.39.2 e2e regression — `slim?.summaries ?? thick?.summaries` empty-object short-circuit broke the dashboard tile-strip + chart row whenever slim resolved empty (new `merge-slim-thick.ts` helper with object-emptiness discriminator); `MeasurementList` `fmt.integer` silently truncated non-grouped decimal readings since v1.4.37 W7c (pre-existing regression unmasked by the dashboard break); Playwright `**/api/analytics` glob did not match `/api/analytics?slice=summaries` (regex `/\/api\/analytics(\?|$)/` swap across 10 specs). 8 failing e2e → 0 failing e2e. Unit tests 4 654 → 4 662. | [v1.4.39.3](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.39.3) |
| v1.4.39.2 | Two issues post-v1.4.39.1 — `/api/measurements?source=rollup` short-circuited on `rollupRows.length > 0` so a partially-converged rollup partition returned the sparse rollup instead of falling through (per-request coverage probe gated on rollup sparsity; when rollup < 3 rows on ≥ 7-day window, `COUNT(DISTINCT date_trunc('day', measured_at))` against `measurements` for the same window; if live > rollup, inline-fold the partition via `recomputeUserRollups` and re-read so this request returns the converged rows). Plus the dashboard mother query blocking every per-type tile on the heavy `/api/analytics` thick envelope: dashboard now mounts two `useAnalyticsQuery` calls in parallel — slim (`?slice=summaries`) feeds the per-type tile strip + `lastSeenByType`, thick feeds `bpInTargetPct*` + `glucoseByContext` (slim resolves first → tile strip paints; thick streams BD-Zielbereich + glucose tiles in afterwards). | [v1.4.39.2](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.39.2) |
| v1.4.39.1 | Rollup tier catches Withings + import + admin-restore write paths — Marc reported "Noch nicht genügend Daten" on dashboard tiles at the 30-point range but the same tiles rendered at 7 or 90. Live-log probe of `/api/measurements?type=BLOOD_PRESSURE_SYS&aggregate=daily&source=rollup` returned `total: 2` for the trailing 30 days; WEIGHT (manually entered via the route that fires the hook) returned 19. Three measurement write paths bypassed the rollup write hook since the v1.4.36 chart `source=rollup` fast-path landed: Withings sync (`sync.ts`, `sync-activity.ts`, `sync-sleep.ts`), `/api/import`, admin backup restore. v1.4.39's boot backfill caught up once on deploy, then immediately re-staled the recent days because the hook still wasn't wired and the per-type-only discovery query no longer re-surfaced the account. Fix: wire `recomputeBucketsForMeasurement` (via `collapseToTypeDayKeys`) into every bypass site; widen the boot-backfill discovery's LEFT JOIN to `(user, type, bucket_start)` so any per-day gap re-surfaces the account on the next worker boot. Per-Withings-sync cost: ≤30 DAY recomputes per 30-day catch-up, best-effort, never fails the user's sync. Tests 4 640 → 4 648. | [v1.4.39.1](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.39.1) |
| v1.4.39 | Mood + medication-compliance + cumulative-sum rollup tiers — extends the v1.4.38 fast-path posture to the two remaining cold-mount hot spots. New `mood_entry_rollups` (per-(user, granularity, bucket) mood stats) eliminates the unbounded `MoodEntry.findMany` walk on `/api/mood/analytics` (12.7 s → ~200 ms expected). New `medication_compliance_rollups` (per-(user, medication, day) scheduled / taken / skipped ledger anchored to user-tz `YYYY-MM-DD`) eliminates the unbounded intake-event walk on `/api/medications/intake?scope=compliance` (3.2 s → ~200 ms expected). New nullable `measurement_rollups.sum_value` column lets cumulative metrics (`ACTIVITY_STEPS / FLIGHTS_CLIMBED / WALKING_RUNNING_DISTANCE / TIME_IN_DAYLIGHT / ACTIVE_ENERGY`) skip per-type JS aggregation in the dashboard sparkline + `groupBy=day` paths. Defense-in-depth `since` cap on the `/api/analytics` live-fallback path (~347 k rows → ~5 k rows; 425 d window preserves `summary.avg30LastYear`). New WEEK / MONTH / YEAR reader helpers ready for the v1.5 multi-year trend card. Five wave agents in parallel + six QA reviewers + nine reconcile fixes (race-safe atomic upsert, partial-coverage probe, fire-and-forget worker enqueue, multi-entry-day summarize parity, DST-boundary test pin, user-scoped backfill enqueue, …). Tests 4 524 → 4 640 (+116). Squash to main clean. | [v1.4.39](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.39) |

## Audit waves

Eight axes, eight reports archived under `.planning/round-audit-*.md`:

| Axis | Report | Findings (hotfix-ready / total) |
| --- | --- | --- |
| Mobile security | `round-audit-mobile-security.md` | 3 / 8 |
| UX + accessibility | `round-audit-ux.md` | 8 / 11 |
| Code quality + docs | `round-audit-code-quality.md` | 5 / 15 |
| README + GitHub discoverability | `round-audit-docs-discoverability.md` | 7 / 15 |
| Web performance (Lighthouse-grade) | `round-audit-perf.md` | 3 / 7 |
| Mobile-deep (viewport-by-viewport) | `round-audit-mobile-deep.md` | 5 / 16 |
| Test coverage gaps | `round-audit-test-coverage.md` | 5 / 8 (mostly critical-path) |
| Docs depth (beyond README) | `round-audit-docs-depth.md` | 5 / 14 |

## What landed (v1.4.34.4 + v1.4.34.5)

### Security (6 findings)

- `destroyAllSessions` now wraps `prisma.session.deleteMany` plus `apiToken.updateMany({ revoked: true })` plus `refreshToken.updateMany({ revokedAt: now })` in one `$transaction`. A stolen iOS Bearer no longer survives a user-initiated password change or an admin reset. Same rotation fires from `POST /api/auth/password`, `POST /api/admin/users/[id]/reset-password`, and `DELETE /api/settings/account`.
- `/.well-known/` proxy bypass tightened from `startsWith` to an exact-match `Set` seeded with `apple-app-site-association`. Stale `/api/auth/codex/callback` PUBLIC_PATHS entry dropped (route was renamed to the device-code family).
- HSTS gains `; preload` (eligible for the Chromium preload list).
- Withings host removed from the global CSP and gated to the integration's own routes.
- `getClientIp` warns once per process on `TRUST_PROXY_HOPS`/XFF mismatch and exposes a tagged `getClientIpOrTrustWarning(request)` helper so future callers can route to a tighter universal rate-limit bucket.
- Service-worker rejects off-origin `notificationclick` URLs and falls back to `/`. Manifest gains `scope` / `id` / `display_override`. Offline fallback body switched to a locale-neutral icon.

### UX + accessibility (8 findings)

- Dialog / Sheet close-X, ChartSkeleton loading announcement, and notifications-section breadcrumb all read i18n keys instead of hardcoded English. All six locales updated.
- Focus rings on bottom-nav primary links, the More overflow trigger, and the mobile top-bar user menu.
- Input / NativeSelect / Select / DateTimeInput tap-target floor: `h-11 sm:h-10` so mobile clears the 44 px WCAG floor.
- Admin chip-strip auto-scroll-into-view (matches v1.4.33 settings-shell pattern).
- List-page subtitles (measurements / mood / medications) now visible on mobile.
- Insights empty-state CTA vocabulary normalised — links open the right measurement form instead of silently failing on BODY_TEMPERATURE / BLOOD_GLUCOSE / PULSE.

### Mobile-deep responsive (4 findings)

- `viewport.themeColor` reacts to light/dark via the media-query pair (Android URL bar + iOS PWA status bar match the active palette).
- TopBar reserves `env(safe-area-inset-top)` — iOS PWA on notched iPhones no longer clips the logo.
- Coach FAB respects `env(safe-area-inset-bottom)` so it floats above the home-indicator inset.
- Sonner toaster switches to `theme="system"`.
- Five textareas now ship `text-base sm:text-sm` so iOS Safari no longer zooms-on-focus (Coach composer, bug-report description, admin feedback note, medication-side-effects notes, medication-intake JSON import).

### Code quality (5 findings)

- Dead `SESSION_SECRET` env contract dropped from `.env.example`, `docker-entrypoint.sh`, `docker-compose.yml`, `CONTRIBUTING.md`, `docs/self-hosting/scaling.md`, and the README Quick Start (three secrets, not four).
- `toJson<T>()` helper consolidates seven Prisma JSON-cast sites.
- `db-compat.ts` gains a header docstring naming it the schema-bootstrap path.
- Passkey response types adopted from `@simplewebauthn/server` (was `any` + eslint-disable).
- Zero-TODO CI gate at `.github/workflows/no-todo-markers.yml`.

### Docs + discoverability

- README rework: How-it-compares matrix vs Withings web / Apple Health / Oura / Garmin / generic CSV; Apple Health + AI Coach promoted to standalone Key-Features bullets; status block; latest-release + GHCR badges; OpenAPI pointer above the API table.
- openGraph + twitter cards now carry `images` and `summary_large_image`.
- GitHub repo metadata: description 290 → 156 chars, keyword-front; `homepageUrl` flipped to `demo.healthlog.dev`; six generic / PII-adjacent topics (`glp-1`, `mounjaro`, `tracking`, `health`, `dashboard`, `bloodpressure`) swapped for six high-intent ones (`apple-health-import`, `withings-alternative`, `glucose-tracker`, `mood-tracker`, `ai-insights`, `personal-dashboard`).
- Five new user-facing docs:
  - `docs/self-hosting/getting-started.md`
  - `docs/self-hosting/reverse-proxy.md`
  - `docs/integrations/apple-health.md`
  - `docs/integrations/withings.md`
  - `docs/integrations/ai-providers.md`
- `docs/README.md` clarifies the in-repo docs tree role vs `docs.healthlog.dev`.

### Tests (24 new integration cases)

| Surface | File | Cases |
| --- | --- | --- |
| User-initiated password change | `tests/integration/auth-password-change.test.ts` | 5 |
| Admin reset-password | `tests/integration/admin-reset-password.test.ts` | 5 |
| Withings OAuth handshake | `tests/integration/withings-oauth.test.ts` | 5 |
| Passkey register | `tests/integration/passkey-register.test.ts` | 4 |
| IW-G cache-invalidation matrix | `tests/integration/cache-invalidation-coverage.test.ts` | 5 |

Integration suite: 197/50 → 222/55. Unit suite: 4235 → 4266. tsc + lint clean throughout.

## Findings deferred (not landing in v1.4.34.x)

- **F-1 mobile-security**: Apple Health unzip OOM / zip-bomb (4-h streaming refactor). Real DoS, but the refactor is non-trivial — v1.5.x.
- **F-4 mobile-security**: Withings shared webhook secret. Rotation runbook + helper script, operator-side — v1.5.x.
- **F-8 mobile-security**: Audit-log coverage gap on Bearer mutation paths. Sweep + regression test — medium effort, v1.5.x.
- **F-4 / F-6 UX**: 5 non-English plural strings (medium effort) and chart accessibility (figure / figcaption synthesis) — v1.5.x.
- **F-3 mobile-deep**: 5 raw DialogContent never migrated to ResponsiveSheet (doctor report, intake import ×2, password change, app-log preview). Substantial UX touch — defer.
- **Code quality F-1**: 2 366 version-tagged inline comments + 244 wave/phase markers. Sweepable in one focused half-day; not blocking.
- **Code quality F-2**: 7-file domain-prompt factory refactor.
- **Code quality F-4**: 171 lib exports lack JSDoc.
- **Perf F-1 / F-3**: Insights/Dashboard fan-out queries → server-side `Promise.all` inside Suspense; `/api/insights/targets` SQL-aggregator gap. Higher-cost work; benchmark in a v1.5 perf pass.
- **Docs-depth F-7**: OpenAPI 14-documented vs 181-actual route divergence. Intentional iOS-codegen-locked subset; needs docstring clarification, not a full spec rewrite.

## Coolify auto-deploy

**Working in production.** v1.4.34.3 was the first release deployed by Coolify without a manual MCP trigger or a host-side retag fallback — proving the v1.4.34.2 `pull_policy: always` fix lands as designed. Every subsequent release (v1.4.34.4, v1.4.34.5) auto-pulls on tag push.

The v1.4.34 closure's Operator-Action #4 ("watch registry for new digests" toggle) is obsoleted by this fix.

## Operator actions still pending

These remain environment-side, unchanged by v1.4.34.4/.5:

1. edge01 Coolify-MCP daemon restart.
2. edge01 `DATABASE_URL` pool-bump (apps01 already drained).
3. Coolify resource-limits resize on apps01 (CPU=2, Memory=1g, Reservation=512m).
4. ~~Coolify "watch registry for new digests" toggle~~ — obsoleted by v1.4.34.2 `pull_policy: always`.
5. apps01 28 duplicate env-pairs prune.

## Tests of note

- 4266 unit tests pass (was 4235 — +31 new).
- 222 integration tests pass across 55 files (was 197 across 50 — +24 new + 5 new files).
- `tsc --noEmit` clean.
- `eslint` clean.
- Zero TODO/FIXME/XXX/HACK markers in product code, now CI-enforced.
- 4 pre-existing e2e failures on main (`onboarding-flicker-dashboard` + `mobile-viewport touch-targets≥44×44`) carry from v1.4.34 — not introduced by this work.
- 4 pre-existing integration-test parallel-DB-isolation flakes (`apns-dispatch`, `integration-status`) — not introduced by this work.

## What changed quantitatively

- **24 commits** since the v1.4.34.3 release (Coach-CTA removal):
  - 2 security commits (token wipe + well-known proxy; HSTS + CSP + SW + manifest)
  - 1 UX commit (8 hotfix-ready findings)
  - 1 code-quality commit (5 hotfix-ready findings)
  - 1 mobile + docs commit (themeColor + FAB + Sonner + 2 self-hosting docs)
  - 1 integration-docs commit (Apple Health + Withings + AI providers)
  - 1 TopBar safe-area commit
  - 1 textarea iOS-zoom commit
  - 1 critical-path tests commit
  - 8 audit-report + planning commits
  - 2 release commits (v1.4.34.4, v1.4.34.5)
  - 1 toJson test-mock fix commit
- **2 GitHub releases** shipped with full notes
- **5 new user-facing docs** under `docs/`
- **8 audit reports** archived under `.planning/round-audit-*.md`
- **31 new unit tests + 24 new integration tests** = 55 net test gain

End of audit marathon. The next layer of findings (perf fan-out queries, prompt-factory refactor, version-tag sweep, JSDoc gap, plural-i18n) is captured per-file in the audit reports for a future v1.5.x pass.

## v1.4.35 addendum — Layer B landed

The v1.4.34.1/.2 closure flagged "Layer B (`measurement_rollups` table)" as deferred to v1.5.x. That deferral is reversed — Layer B shipped in two stages on 2026-05-17:

- **Foundation** (commit `9872081d` on develop) — additive `measurement_rollups` table + `RollupGranularity` enum, populator (`recomputeBucketsForMeasurement` sync DAY + pg-boss WEEK/MONTH/YEAR, `recomputeUserRollups` full range, `ensureUserRollupsFresh` warm-on-read), write hooks on all 6 measurement mutation endpoints, Apple-Health-import end-of-job backfill, `scripts/backfill-rollups.ts`, pg-boss `rollup-recompute` worker subscription, +14 unit + 3 integration tests.
- **Partial read-swap** (commit `67ccd553` on develop, shipped as v1.4.35) — the comprehensive insights aggregator and the slim analytics summaries slice now source `count / min / max / mean` per type from the DAY rollup buckets via `aggregateBuckets`, plus the comprehensive `dailyByType` correlation feed straight from the bucket means. Slope / R² / standard deviation / anomaly counts continue to run against live SQL — they don't compose across DAY buckets. A defensive parity check against the live aggregate's `COUNT(*)` falls back to live SQL when divergence is detected.

Tests: 4280 unit + 228 integration (+14 unit + 6 integration on the rollup path). `pnpm typecheck` + `pnpm lint` clean. Migration `0067_v1434_measurement_rollups` is idempotent.

A full read-swap across every remaining analytics surface is planned for a follow-up release once the partial swap has proven itself in production.

## v1.4.35.1 addendum — auto-converge on worker boot

Discovered post-deploy: `scripts/backfill-rollups.ts` is unrunnable inside the Next.js standalone production image (`tsx` is a devDep and the Prisma client lives under pnpm's symlink-store layout, not the top-level `node_modules/@prisma`). A working manual run required `pnpm dlx tsx` plus an ad-hoc `ln -s` into the pnpm store — fine for one Coolify host with SSH, but it would block every self-hoster.

v1.4.35.1 moves the backfill onto the worker boot so the activation path is zero-touch:

- **New `rollup-full-backfill` queue** + handler folds one user per job at serial concurrency. The handler invokes `recomputeUserRollups(userId)` with the default 5-year window across all four granularities — equivalent to the manual CLI run, but inside the worker process so no `tsx` install gymnastics in production images.
- **`enqueueBootTimeRollupBackfill`** runs once at `startReminderWorker` boot after every `boss.work` subscription is in place. Discovery query: users with at least one `measurements` row and zero `measurement_rollups` rows. Idempotent across reboots (the discovery query only matches uncovered users; once a fold completes the user drops off the list) and resilient to fast restarts (pg-boss `singletonKey: boot-backfill|{userId}`).
- **Best-effort:** discovery errors surface through the helper's return value and are logged via `workerLog`; the worker boot never fails because the backfill missed.

Tests: 4285 unit + 230 integration. tsc + lint clean. Production verify: `pgboss.queue` row for `rollup-full-backfill` created at `2026-05-17T09:36:25Z` (worker started 09:36:24Z), confirming the registration + helper-call path executed cleanly.
