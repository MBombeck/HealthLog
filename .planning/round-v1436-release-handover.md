# v1.4.36 release handover (fresh-session pickup)

**Status:** all code work landed on `develop`. tsc + lint clean. 4354/4355 unit + 230/231 integration (1 known `isolate:false` flake). Ready for **version bump → CHANGELOG → squash → tag → GH release → live verify → post-deploy perf-QA → closure**.

**Why this doc exists:** the originating session ran out of context-window after the QA wave + reconcile. Pick up from here in a fresh session.

---

## State at handover

- Branch: `develop`, tip `234fb723`.
- `main` is at `v1.4.35.1` (`5a3ca330`), live.
- 27 commits make up v1.4.36 (range `5a3ca330..develop`). Plus the docs handover from the start of the round (`125457e4`).
- Quality gates: `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test` = 413 files, 4354 passed, 1 skipped.
- Integration: 230 passed + 1 known `apns-dispatch`/`integration-status` parallel-DB isolation flake AND the `enqueueBootTimeRollupBackfill` mock-isolation flake that only fails when run alongside `admin-backups-audit.test.ts`. Both flakes are pre-existing, both pass in isolation, both documented in v1.4.35.1 closure. Not v1.4.36 regressions.
- `prisma/migrations/0068_v1436_insights_exclude_metrics/migration.sql` is the only schema change — additive `String[] NOT NULL DEFAULT '{}'` on `users.insights_exclude_metrics`, idempotent under re-run.

## Commits (oldest → newest, 27 total)

| Wave | Sha | Title |
|---|---|---|
| W2 | `4d111e39` | fix(insights): pin trends-row chart slot to h-[140px] |
| W2 | `b4bef03f` | feat(charts): mini ChartSkeleton variant for trends-row slot |
| W3 | `2e2ca224` | feat(insights): bucketed measurement payload for raw mode |
| W2 | `28a82969` | fix(insights): tri-state render contract for trend annotations |
| W4a | `a17e7a46` | feat(medications): restore intake-history table on the detail page |
| W4b | `83f0b5ae` | ux(nav): pin active tab-strip chip to the scroll start |
| W3 | `1e9a03be` | feat(coach): medications + anthropometrics exclusion toggles |
| W4c | `3f55b6f7` | fix(dashboard): bucket cumulative metrics per day before summarising |
| W1 | `13f8905e` | perf(insights): skip heavy live aggregate when rollups are populated |
| W3 | `73528061` | feat(insights): per-user exclude-metrics opt-out (mirrors Coach) |
| W4d-misattributed | `5b44cb6a` | fix(insights): tighten tab-strip availability gate (*contains W1 Suspense work — see below*) |
| W4d-real | `9feca9e0` | fix(insights): tighten tab-strip availability gate (actual W4d files) |
| W3 | `68849959` | feat(insights): compactSections drops zero-row blocks before serialization |
| W1 | `d2bad694` | perf(insights): route daily chart fetches through rollup buckets |
| W4e | `23cf9a4a` | ux(about): fold About card into the Admin Console |
| W1 | `e203f07c` | perf(insights): cache /api/insights/targets behind the analytics LRU |
| W4f | `0738ef50` | ux(about): drop manual update-check panel for an inline badge |
| W4g | `fa0f544e` | fix(audit): fall back to city/country when ASN lookup misses |
| W5 test-fix | `38417922` | test(analytics): seed rollup-count probe in slim-slice route test |
| W5-simp | `476ba98e` | refactor(analytics): hoist cumulative metric-key lookup out of nested ternary |
| W5-R2 H5 | `00cf8d7a` | a11y(medications): focus-visible ring + 44 px touch floor on intake-history sort headers |
| W5-R2 H6 | `7ee32a14` | a11y(medications): drop sm-size on intake-history pagination buttons |
| W5-R1 C1 | `07491df6` | fix(rollups): per-type coverage probe gates rollup vs live read |
| W5-R1 C2 | `42039372` | fix(insights): remove inert Suspense wrappers from mother page |
| W5-R2 H7 | `3e0eed82` | a11y(settings): give update badge a 44 px hit target, focus ring + real aria-label |
| W5-R2 M | `0ec7fc6f` | fix(about): use distinct builtAtLabel key for the build-time row |
| W5-R2 M | `7200fc80` | chore(i18n): drop orphaned update-card keys from settings.about |
| W5-R1 H1 | `d7ad2c0b` | fix(insights): guard against oversized payload on the aggregated retry |
| W5-R1 H3 | `234fb723` | fix(rollups): annotate when ensureUserRollupsFresh swallows an error |

**Note on `5b44cb6a`** — title says "tab-strip availability gate" but the diff is the W1 Suspense rewrite of `src/app/insights/page.tsx`. A race during parallel execution swapped the index. `9feca9e0` re-committed the actual W4d files immediately after with "(actual W4d files)" tag. Both commits' contents are legitimate. **The CHANGELOG body MUST describe both contributions correctly — do not propagate the misleading title.**

## What v1.4.36 actually delivers (CHANGELOG source-of-truth)

Use these grouped headlines when drafting the CHANGELOG. The handover at `.planning/round-v1436-handover.md` has the full prose context.

### Performance

- **`comprehensive-aggregator` + `summaries-slice` heavy-aggregate skip on the rollup-fresh + fully-covered path.** `src/lib/measurements/rollup-coverage.ts` introduces a per-type coverage probe (joins `DISTINCT type FROM measurements` against `measurement_rollups`). Slim slice + comprehensive now skip the legacy `COUNT/MIN/MAX/AVG $queryRaw` whenever EVERY logged type has DAY coverage. Partial coverage (e.g. user with BP buckets + new WEIGHT raw) falls back to live aggregate so no type silently underreports.
- **`/api/measurements?source=rollup` opt-in.** Daily-aggregate chart fetches over windows > 7 days route through `measurement_rollups` DAY buckets instead of scanning the measurements table. Cold-fetch contribution per chart: ~3 s → estimated < 100 ms on Marc's account.
- **`/api/insights/targets` cached.** Wrapped in the analytics LRU (60 s TTL, per-user key, invalidated by measurement/mood/medication mutations).
- **Insights page: early-skeleton paint.** The page-level `isLoading` gate that blocked the entire shell on `/api/insights/comprehensive` is gone. Each section (DailyBriefing / CorrelationRow / TrendsRow) renders its own skeleton + fills in independently. (This is **NOT** streaming SSR. The QA reconcile dropped the inert `<Suspense>` wrappers because the page is `"use client"` + `next/dynamic({ssr:false})` and the boundaries never triggered. The honest description is "early skeleton paint".)

### AI

- **Insights `extractFeatures` swap from raw measurements to rollup buckets.** Power-user prompt: 25.9 MB → estimated ~50–500 KB. Hard 5 MB `FEATURES_MAX_BYTES` guard catches future regressions; the route handler downgrades on first oversize (drop raw) and again on second oversize (drop anthropometrics + medications + compliance + sleep + steps + hrv + resting_hr via the exclude filter). Third failure returns 422 + `insights_payload_too_large` annotate — never a 500.
- **Coach exclusion toggles surfaced.** Coach settings sheet gained two new switches (medications, anthropometrics). The Coach PUT mirrors `excludeMetrics` onto a new `users.insightsExcludeMetrics` column so both surfaces share a single privacy contract.
- **`compactSections` empty-block omit.** No more `Schlafdaten: [keine]` lines in either Coach or Insights prompts.

### Charts + Insights UI

- **`trends-row-chart-slot` fixed to `h-[140px]`.** Mood / BP / Weight cards now align byte-for-byte. Recharts `width=-1 height=-1` warning gone. Expect Lighthouse CLS drop from 0.46 toward zero.
- **`ChartSkeleton` mini variant** matches the loaded chart's wrapper dimensions — no more hydration shift.
- **`TrendAnnotation` tri-state contract** (`pending` / `needs_data` / `generated`). Fixes the cold-mount and regenerate flash of "mehr Daten nötig, um diesen Trend zu kommentieren". `pending` wins over `needs_data` so regenerate-in-flight never shows the empty hint.

### UX punch list

- **Medication history page restored** via `<IntakeHistoryListV2>` — lite table, server-side paginated, sortable by takenAt, no inline CRUD (consistent with the v1.4.28 retirement rationale; edits/deletes happen via the normal medication-intake routes). Mounted for ALL medication kinds, not just GLP-1.
- **Tab-strip scroll** `inline: "center"` → `inline: "start"` on both Settings and Admin Console. Selected chip lands flush-left instead of jumping to centre.
- **Steps tile + 4 other cumulative metrics** (ACTIVE_ENERGY_BURNED, WALKING_RUNNING_DISTANCE, FLIGHTS_CLIMBED, TIME_IN_DAYLIGHT) now read the day's cumulative sum (00:00 user-timezone) via the new `pickCumulativeDaySum` helper, source-priority-aware like SLEEP_DURATION already was.
- **Insights nav strict-gate** — `if (!availability) return true` flipped so types without measurements no longer appear in the strip.
- **About → Admin Console.** "Über HealthLog" moved from the personal-dropdown surface into a new `/admin/about` slug. Public `/about` landing untouched. Legacy `/settings/about` route kept as a bookmarkable permalink for any auth-user (Security reviewer M1: content scope = version + license + source links + update-tooltip, no PHI, accept as deliberate).
- **Update-badge auto-check.** The "Update prüfen" button is gone. A 44 px-square, focus-ringed, aria-labelled badge appears next to the version line when the existing 24 h auto-check returns `newer_available`; the latest tag is interpolated into the aria-label and an sr-only `<span>` inside the anchor.
- **IP-whois fallback** now surfaces city + country with "Carrier nicht verfügbar" / "Carrier unavailable" when the ASN lookup misses. ipwho.is free-tier limitation is now a visible-but-graceful UX, not a blank chip.

### a11y

- IntakeHistoryList v2 sort headers + pagination buttons clear the 44 px touch floor + carry `focus-visible:ring`.
- UpdateBadge ditto + real `aria-label` + sr-only tag exposure.

### Misc

- `compactSections`, `applyInsightsExcludeFilter`, `pickCumulativeDaySum`, `probeRollupCoverage`, `isFullyCovered` are new shared helpers under `src/lib/insights/` and `src/lib/measurements/`. Tested standalone.
- `ensureUserRollupsFresh` now annotates `{ rollup_refresh_failed: true, rollup_refresh_error: ... }` instead of swallowing silently. Read path still returns `{ recomputed: false }` so the response never fails because of a populator hiccup.
- One auto-applied simplifier commit (`476ba98e`) hoists the cumulative-metric key lookup out of a 4-level nested ternary into a `switch`.
- 7 orphan i18n keys × 6 locales removed (42 strings) — the `settings.about.updates*` / `checkUpdates` cluster that came with the manual update-check card.

## What was deferred to v1.4.37

From QA reviewers, these were noted but NOT fixed:

- **H2 (senior-dev)**: `applyInsightsExcludeFilter` shallow `next.context` mutation — fragile contract, no test pin. Low blast radius today (context isn't BP-derived), but worth a test guard.
- **H4 (code-reviewer)**: narrow-aggregate query still scans 90 days of `measurements`. The column-pruning won is real but NOT the headline "sub-second" claim. The CHANGELOG below is calibrated honestly.
- **M (security)**: `/settings/about` legacy route serves AboutSection to any auth-user. Content scope is benign. Add `permanentRedirect("/admin/about")` for admins + 404 for non-admins OR leave as documented permalink.
- **M (senior-dev)**: `/api/measurements?source=rollup` response omits `id`/`unit`/`source`. iOS unaffected (doesn't pass `source=rollup`). Either dedicated `MeasurementBucketResource` schema or echo `unit` + sentinel `id` for OpenAPI conformance.
- **M (code-reviewer)**: `BUCKETED_TYPES` in `features.ts` duplicates the rollup-populator's enum (drift risk).
- **M (code-reviewer)**: COUNT-probe call sites in `summaries-slice.ts` and `comprehensive-aggregator.ts` could collapse into one helper (R1's `rollup-coverage.ts` already extracted the probe — verify and remove any remaining duplication).
- **M (senior-dev)**: cumulative SUM `mean × count` over-counts on multi-source same-day (Apple Health + Withings both contributing steps on the same day). Pre-existing chart behaviour, not v1.4.36 regression.
- **L (simplifier)**: `<a>` vs `<span>` update-badge near-duplicates (~20 LOC), `BucketedSeries` name collision between `features.ts` and `bucket-series.ts` (no actual import collision today), assorted comment debt.
- **L (i18n)**: minor `motion-reduce:animate-none` doesn't cascade to children; sticky-first-column on IntakeHistoryList for narrow viewports.
- **Health Score paint lag** — parent-level analytics query gating, not the card itself. Deferred from W2.

## Release flow (steps to execute in the new session)

### 1. Verify quality gates one more time

```bash
git checkout develop && git pull
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration tests/integration/measurement-rollups.test.ts   # isolation pass — should be 9/9 green
```

### 2. Version bump

`package.json`: `"version": "1.4.35.1"` → `"version": "1.4.36"`.

### 3. CHANGELOG

Add a `## [1.4.36] — 2026-05-17 — Perf, charts, AI payload trim, UX punch` block at the top of `CHANGELOG.md`, ABOVE the existing `## [1.4.35.1]` entry. Source-of-truth = the "What v1.4.36 actually delivers" section above. Honest framing on the perf wave — "early-skeleton paint" NOT "Suspense streaming"; the heavy-aggregate skip + per-type coverage probe + `source=rollup` opt-in are the real perf wins.

### 4. Commit version + CHANGELOG on develop

```bash
git add CHANGELOG.md package.json
git commit -m "chore(release): v1.4.36 — perf, charts, AI payload trim, UX punch

(body: terse 4-5 line summary)"
git push origin develop
```

### 5. Squash to main

```bash
git checkout main
git merge --squash develop
# Conflicts expected on CHANGELOG.md, package.json, prisma/schema.prisma, plus the touched route + lib files.
# Take develop's tree for every conflicted file (it's the truth):
git checkout --theirs <all conflicted files>
git add <all conflicted files>
git diff develop --stat  # should be empty — main now matches develop exactly
git commit -m "v1.4.36 — perf, charts, AI payload trim, UX punch

(body)"
```

### 6. Tag + push + GH release

```bash
git tag -a v1.4.36 -m "v1.4.36 — perf, charts, AI payload trim, UX punch"
git push origin main && git push origin v1.4.36
# Release notes: same source-of-truth as the CHANGELOG body, plus operator notes
gh release create v1.4.36 --title "v1.4.36 — Perf, charts, AI payload trim, UX punch" --notes-file /tmp/v1436-release-notes.md
```

### 7. Live deploy verify

```bash
# Background poll the version endpoint
until v=$(curl -fs https://healthlog.bombeck.io/api/version | jq -r .data.version) && [ "$v" = "1.4.36" ]; do sleep 20; done
# First webhook will pull stale :latest; trigger redeploy after docker-publish workflow completes:
gh run watch  # docker-publish workflow
# Then via Coolify MCP:
# mcp__coolify-apps01__deploy { tag_or_uuid: "pg8wggwogo8c4gc4ks0kk4ss", force: true }
```

### 8. **Post-deploy perf-QA (Marc directive — do not skip)**

Marc was explicit: "muss jetzt deutlich schneller sein, sowohl Coach als auch Dashboards — wir dürfen nicht mehr mit Millionen von Daten umgehen." Measure, don't estimate.

**Required tests (capture numbers, paste into a `.planning/round-v1436-perf-verify.md` doc):**

```bash
# (a) AI Insights payload size — should be DRAMATICALLY lower than v1.4.35.1's 25.9 MB
# Trigger a generation from the UI, then check the most recent insights.generate log:
ssh apps-01 'docker logs $(docker ps --format "{{.Names}}" | grep "^app-pg8wggwogo8c4gc4ks0kk4ss") 2>&1 | grep insights.generate | tail -5'
# Look for: features_payload_size_bytes annotate field. Should be < 1 MB.

# (b) /api/insights/comprehensive cold-mount
curl -sw "TOTAL: %{time_total}s\n" -o /dev/null -b "session=..." https://healthlog.bombeck.io/api/insights/comprehensive
# Expected: ~1.5–2 s (was 10.88 s in v1.4.35.1 HAR).

# (c) /api/analytics?slice=summaries cold-mount
curl -sw "TOTAL: %{time_total}s\n" -o /dev/null -b "session=..." "https://healthlog.bombeck.io/api/analytics?slice=summaries"
# Expected: ~0.5 s (was 3.5 s).

# (d) /api/measurements?aggregate=daily&source=rollup
curl -sw "TOTAL: %{time_total}s\n" -o /dev/null -b "session=..." "https://healthlog.bombeck.io/api/measurements?type=BLOOD_PRESSURE_SYS&aggregate=daily&source=rollup&from=...&to=...&limit=5000"
# Expected: < 100 ms (was 3 s).

# (e) Coach prompt size — fire a Coach query, check the snapshot log
ssh apps-01 'docker logs $(docker ps --format "{{.Names}}" | grep "^app-pg8wggwogo8c4gc4ks0kk4ss") 2>&1 | grep -i "coach\|snapshot" | tail -10'

# (f) Capture a fresh HAR on /insights cold-mount with DevTools and compare to .planning/round-v1436-handover.md baseline (Insights HAR showed 10.88 s page render + 3 × 3 s daily-aggregate calls).
```

**If any number is materially worse than estimate** — STOP, file a v1.4.36.1 hotfix issue, don't claim the win.

### 9. Closure + memory

- `.planning/round-audit-marathon-closure.md` → add v1.4.36 addendum line.
- Memory: update `~/.claude/projects/-Users-marc-Projects-HealthLog/memory/MEMORY.md` index line for the marathon to include v1.4.36 + headline numbers from step 8.
- Save a new memory `feedback_v1435_partial_readswap_regression.md` if not yet captured — the v1.4.35 "always run both" pattern was a real failure mode caught by reviewers; future-me should default to "make the swap actually replace, not parallel".

### 10. Tag closure commit on develop + push

```bash
git checkout develop
git add .planning/round-audit-marathon-closure.md
git commit -m "docs(planning): v1.4.36 closure"
git push origin develop
```

## Non-negotiables (carry from prior rounds)

- Marc-Voice commits. No `Co-Authored-By: Claude`. No `--no-verify`. No `--no-gpg-sign`.
- English commits + CHANGELOG + release notes. No "AI/Claude/agent/marathon/wave/phase" in user-facing artifacts.
- No PII anywhere (Marc's name, his BP values, his measurement counts) in CHANGELOG / GH release notes / docs.
- Branch model: develop is feature target, main is release-only. Never commit directly to main except the release squash.
- No PROD destructive operations without confirmation.

## Operator notes

- Coolify auto-deploys main on tag push (working since v1.4.34.2).
- First webhook pulls stale `:latest`; second deploy after docker-publish completes pulls the new image. Trigger via Coolify MCP `deploy` action.
- GHCR workflow takes ~8 min.
- Marc's account already has fully populated rollups (boot-fold from v1.4.35.1 ran), so the per-type coverage probe will take the rollup-fast path immediately.
- The known integration-test flakes (`apns-dispatch`, `integration-status`, `enqueueBootTimeRollupBackfill`) are pre-existing `isolate:false` mock-state collisions, NOT v1.4.36 regressions. Pass in isolation. Document in any QA report.
