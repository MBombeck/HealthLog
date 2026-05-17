# v1.4.36 marathon handover

**Branch:** develop. **Trigger:** Marc directive 2026-05-17 after v1.4.35.1 deploy. Freeze aufgehoben.

Two root issues drive this round:

1. **v1.4.35 perf regression.** The read-swap landed but ran live SQL + rollup in parallel and only used the rollup when the count matched. Net round-trip count unchanged — so the "Insights cold-mount sub-second" promise never materialized. Live still takes ~11 s on `/insights` SSR + 3 s on the slim slice + 3 s × 3 on daily-aggregate measurements.
2. **The recurring Mood-card-larger-than-BP/Weight complaint.** Chart wrapper has no fixed height; Recharts mounts with `width=-1 height=-1` and re-layout causes the visible drift + the CLS 0.46 hit in Lighthouse.

Plus a punch list of UX bugs (medication history empty, AI Insights "more data needed" when triggered, scroll-feels-jumpy, Steps tile shows last-measurement-not-day-sum, etc.).

## Waves

### W1 — perf (the headline win)

- **Read-swap rollup-only-when-fresh.** Drop the always-run-both pattern in `src/lib/insights/comprehensive-aggregator.ts` and `src/lib/analytics/summaries-slice.ts`. Decision: if `ensureUserRollupsFresh` confirms the rollup is current AND the rollup row count for the type passes a cheap completeness check, skip the live `$queryRaw` aggregate entirely. Fall back to live only on first cold-mount before the populator has caught up. Pin the contract with a unit test that the live `$queryRaw` is NOT called when rollups are fresh + complete.
- **`/insights` page Suspense boundaries.** The page SSR is 10.88 s because chained `await`s block. Wrap the per-trend-section data fetches in Suspense so the page streams. Don't change the visible markup contract.
- **Drop the 3× daily-aggregate measurement calls on Insights.** Insights fires `GET /api/measurements?type=…&aggregate=daily&limit=5000` per chart (BP_SYS / BP_DIA / WEIGHT), each ~3 s. Route them through the existing DAY rollup table. Either reuse `dailyByType` from `buildComprehensiveAggregate` or expose a slim rollup-read helper.
- **Cache `/api/mood/analytics` + `/api/insights/targets`** via the existing analytics 60-s LRU. Both run > 1 s cold + are read on every Insights mount.

### W2 — charts + insights UI

- **`trends-row-chart-slot` `h-[140px]`** in `src/components/insights/trends-row.tsx` lines 120, 142, 163. Aligns Mood / BP / Weight card heights AND eliminates the `width=-1 height=-1` Recharts warning (root cause confirmed in agent recon).
- **ChartSkeleton dimensions** in `src/components/charts/chart-skeleton.tsx` need a `mini` prop that applies `rounded-md p-2` to match the loaded chart wrapper. Without this the skeleton is taller than the chart and the layout still shifts on hydration.
- **AI Insights / Briefing not displaying.** Marc reports the trigger fires but the UI shows "mehr Daten nötig, um diesen Trend zu kommentieren". Inspect the briefing render-state — likely a stale `status === 'pending'` flag or a mismatched cache key after generation. Health-Score render-state has the same lag pattern; fix in the same touch.

### W3 — AI prompt trim

- **`extractFeatures` bucketed.** `src/lib/insights/features.ts:768-779` currently appends every raw `prisma.measurement.findMany` row to the prompt under `rawMeasurements` (25.9 MB on Marc's account, hit the Codex 10 MB ceiling). Swap to reading from the `measurement_rollups` DAY/WEEK/MONTH buckets via `aggregateBuckets`. Default to bucketed; keep the `raw` privacy mode as an explicit opt-in that warns above e.g. 1 MB.
- **Coach toggles surfaced to UI.** `src/lib/validations/coach-prefs.ts` already has `excludeMetrics` + `defaultWindow`. Surface a UI toggle row in the Coach settings panel for: sleep, medications, anthropometrics (height/age/gender). Default = include when data exists, otherwise omit. Empty blocks must not be sent at all.
- **AI Insights gets the same exclusion contract** as Coach — extend the User schema with `insightsExcludeMetrics` aligned to Coach's enum, parse in `/api/insights/generate`, filter before JSON.stringify.

### W4 — UX punch list (one agent, sequential sub-waves)

- **W4a — IntakeHistoryList v2 (lite).** v1.4.28 retired the 886-LoC component intentionally. Re-implement as a slim table at `src/components/medications/intake-history-list-v2.tsx`: paginated (25/page), sortable by `takenAt`, no inline CRUD (edit/delete happens via the normal medication-intake routes). Mount on `src/app/medications/[id]/history/page.tsx` below the existing GLP-1 blocks for all medication kinds.
- **W4b — Tab-strip scroll inline:start.** `src/components/settings/settings-shell.tsx:167` and `src/components/admin/admin-shell.tsx:174`: `inline: "center"` → `inline: "start"`. One-line change × 2 files.
- **W4c — Steps tile daily cumulative.** Dashboard tile in `src/app/page.tsx:867-888` reads `summary.latest`. Apply the same source-priority + day-bucketing pattern that lines 205-225 use for SLEEP_DURATION, broaden to ACTIVITY_STEPS, ACTIVE_ENERGY_BURNED, WALKING_RUNNING_DISTANCE, FLIGHTS_CLIMBED, TIME_IN_DAYLIGHT. Extract the bucketing into a shared helper.
- **W4d — Insights nav verify.** `insights-tab-strip.tsx` already gates on `summaries[type].count > 0`. Verify the upstream payload actually populates `count` for all types (not just the ones rendered by the comprehensive aggregator). If `summaries` from the slim slice omits empty types, add a `lastSeenByType` check or fold the gating logic into the parent.
- **W4e — Über → Admin Console.** Remove the link from `src/components/layout/top-bar.tsx:102` and `src/components/layout/sidebar-nav.tsx:153`. Add a new admin section in `src/components/admin/admin-shell.tsx` ADMIN_SECTIONS array. Either render the existing `/about/page.tsx` content inside the admin slug or extract the body into a shared component.
- **W4f — Update badge (drop button).** In `src/components/settings/about-section.tsx` (or wherever the About section now lives after W4e), drop the "Update prüfen" button. Keep the 24h auto-check. Add a small upward-arrow icon next to the version line when `updateResult.status === 'newer_available'`; hover shows latest tag via tooltip.
- **W4g — IP Whois city/country surface.** `src/lib/geo.ts:284-318` returns null on ASN failure (ipwho.is free tier has no ASN). When ASN is null but city/country are present, surface those in the admin audit-log carrier chip with a "(carrier unavailable)" note instead of blank.

### W5 — QA + release

- Full unit + integration suites green.
- Multi-reviewer QA wave (code-review, security, design, senior-dev, simplifier).
- Version bump `1.4.35.1 → 1.4.36`. CHANGELOG.
- Squash develop → main. Tag. GH release. Live verify.

## Defaults applied (no Marc clarification needed)

- Steps tile = day cumulative from 00:00.
- IntakeHistoryList v2 = lite (table + pagination, no inline CRUD).
- Update behavior = badge auto-check only, "Update prüfen" button removed.

## Non-negotiables

- Marc-Voice commits (no `Co-Authored-By: Claude`, no `--no-verify`, English, terse professional).
- `pnpm typecheck` + `pnpm lint` + relevant tests green before every commit.
- Atomic commits per sub-wave.
- All wave commits land on develop. Main only sees the v1.4.36 squash.
- Charts visual identity: Recharts stays, no token reshuffle, only the height fix.
- No PII in user-facing artifacts.

## Operator notes

- Coolify auto-deploys main on tag push (confirmed working since v1.4.34.2).
- GHCR build takes ~8 min; first webhook deploy will pull stale `:latest`, redeploy fires once GHCR publishes.
- Marc's account: 311 775 measurements across 8 types, 5 318 rollup buckets folded by the v1.4.35.1 boot-time backfill.
