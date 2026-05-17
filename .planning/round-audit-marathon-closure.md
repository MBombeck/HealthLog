# v1.4.34.4 + v1.4.34.5 + v1.4.35 + v1.4.35.1 + v1.4.36 + v1.4.37 — Audit-Marathon Closure (extended)

Shipped: 2026-05-17 (six consecutive releases on the same date as v1.4.34.3).

| Tag | Highlights | Release |
| --- | --- | --- |
| v1.4.34.4 | Audit-driven hotfix bundle across security, UX, code quality, mobile-deep, docs, GitHub metadata | [v1.4.34.4](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.34.4) |
| v1.4.34.5 | Audit follow-on: 24 critical-path integration tests + iOS textarea zoom fix | [v1.4.34.5](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.34.5) |
| v1.4.35 | Layer B landed — persistent `measurement_rollups` foundation + partial reader read-swap on the comprehensive aggregator and the slim summaries slice | [v1.4.35](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.35) |
| v1.4.35.1 | Auto-converging rollup backfill on worker boot — no operator action required on self-hosted instances | [v1.4.35.1](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.35.1) |
| v1.4.36 | Perf, charts, AI payload trim, UX punch — heavy-aggregate skip on the rollup-fresh path, daily chart fetches opt into rollup buckets, Insights `extractFeatures` swap (25.9 MB → 30,096 tokens, **−99.5 %**), page-blocking call 10.88 s → 4.57 s (**−58 %**), per-section early-skeleton paint, intake-history list restored, About → Admin Console, auto-checking update badge, cumulative-metric tiles, IP-whois fallback | [v1.4.36](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.36) |
| v1.4.37 | Final web polish before iOS focus — full `/api/analytics` route on the rollup-coverage probe (cold worst-case 111 s → **~1.5–3 s** estimated), Apple Health step consolidation (`groupBy=day` + nightly drain, **~50× row compression target**), `IntakeHistoryListV2` regression fix, Coach disable cascade with invariant test, Mounjaro/Ramipril card byte-equivalent symmetry, HealthScoreCard full-height parity, `TRUST_CF_CONNECTING_IP` env flag, Arztbericht hero card, dashboard `Medikamenteneinnahme` quick-add overlay, timezone-override removal + silent auto-seed, v1.4.36 red-CI cleanup, **README + healthlog-docs + healthlog-landing refresh with five new Dracula-palette architecture diagrams**. Unit suite 4354 → 4486 passing. | [v1.4.37](https://github.com/MBombeck/HealthLog/releases/tag/v1.4.37) |

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
