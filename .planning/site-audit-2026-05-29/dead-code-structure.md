# Dead-code & structure audit — 2026-05-29

Read-only. No edits made. Scope: `src/` (generated client excluded). Tooling: `pnpm knip --reporter compact` (enforcing), `wc -l` ranking, targeted caller-tracing.

## Tooling baseline

`knip` is very clean — exactly two findings, both already known:

- `src/components/medications/todays-dose-card.tsx` — unused file.
- `src/lib/ai/coach/medication-extract-prompt.ts` — unused exported type `DoseUnit`.

Both verified below. The rest of this report is what knip misses.

---

## 1. DEAD CODE

### 1a. `todays-dose-card.tsx` — orphaned (confirmed)
- File: `src/components/medications/todays-dose-card.tsx`
- Only referent is a test: `src/app/medications/__tests__/detail-page-history-surface.test.ts`. No production importer.
- `medications/**` is under active rework per the brief — **list only, do not prescribe deletion**. Flagging so it is not lost when the rework lands.

### 1b. `DoseUnit` exported type — dead (confirmed)
- `src/lib/ai/coach/medication-extract-prompt.ts` exports `DoseUnit`; zero importers anywhere in `src/` (non-generated). Safe to drop, but same medications-rework caveat applies — list only.

### 1c. No commented-out code blocks
Searched for `// const|let|return|if (|await|function|import|export` line prefixes. Every hit is prose ("…returns…", "…function arity…") inside legitimate explanatory comments. The tree carries **no** stale commented-out code. Good signal.

### 1d. No stale feature flags
The only flag system is the assistant matrix in `src/hooks/use-feature-flags.ts` (backed by `GET /api/feature-flags`), which is live and gates Coach/briefing/insight surfaces on web + iOS. `NEXT_PUBLIC_*` env reads are all load-bearing (version poller, Withings callback URL, web-vitals origin). No dead flags found.

---

## 2. OLD / QUESTION-FOR-REMOVAL

### 2a. The v1.5.1 read-flip did NOT happen — legacy walker still on the live path  (HIGH value, MEDIUM risk)
The schema promises it (`prisma/schema.prisma:910-914`): *"the migration backfills `rrule` for every existing row and v1.5.1 flips the readers to consult the new fields first. v1.6.0 drops this column."* The canonical engine `src/lib/medications/scheduling/recurrence.ts` exists and its own header (`recurrence.ts:8-11`) says the today-projector, cadence chart, medication card, and form helpers *"migrate in v1.5.1 per the read-flip plan."*

**That migration is incomplete.** The canonical engine has exactly ONE production caller: `worker-helpers.ts` → `reminder-worker.ts`. Every other path still runs the legacy walker `expandTodayIntakes` in `src/lib/medication-schedule.ts`, which reads ONLY `daysOfWeek` + `windowStart` and *ignores* `rrule`/`timesOfDay`/`rollingIntervalDays`:

- `src/lib/medications/scheduling/project-today-intakes.ts:31` imports `expandTodayIntakes`; it is the shared projector for **both** `/api/medications/intake?scope=today` AND `/api/dashboard/summary` (`src/app/api/dashboard/summary/route.ts:350`).
- The legacy walker even documents its own correctness gap: `medication-schedule.ts:132-138` *conservatively skips* `intervalWeeks > 1`, while the canonical engine (`recurrence.ts:27-34`) explicitly fixes that bi-weekly bug.

**Consequence:** GLP-1 / bi-weekly and any rolling/RRULE-only schedule are projected differently by the reminder worker (canonical) vs the dashboard/intake today-tile (legacy). This is a live divergence, not just tech debt.

**Recommendation:** Before `daysOfWeek` can be dropped in v1.6.0, the read-flip must actually land — route `project-today-intakes.ts` (and the card/chart/form readers) through `recurrence.ts`. Risk is MEDIUM (touches the iOS today tile + intake backfill); pin with the existing `recurrence.test.ts` parity cases. Do NOT drop the column until this is done — the schema comment's v1.6.0 plan is currently unsafe to execute.

### 2b. `legacy-bridge.ts` dual-write — correctly scoped, keep until 2a + column drop  (LOW value now)
- File: `src/components/medications/scheduling/legacy-bridge.ts` (204 LOC, pure, well-tested).
- Purpose: dual-write the legacy `(daysOfWeek, intervalWeeks)` pair alongside the new `rrule` during the v1.5.x window so legacy readers still see the row. Imported by `wizard/wizard-payload.ts`.
- This shim is **load-bearing precisely because 2a is incomplete** — the legacy readers it feeds are still live. It cannot be removed before the read-flip and the v1.6.0 column drop. Listed for the v1.6.0 cleanup checklist, not for now.

### 2c. Boot-time backfills — converging, self-terminating, keep  (INFO)
`step-consolidation.ts` (v1.5.6, `0087`), `rollup-full-backfill`, `geo-backfill`, `medication-compliance-rollups` backfills all follow the documented converging-discovery pattern (discovery query enqueues one job per still-unconverged user; idempotent across reboots; matches zero rows once converged). These are designed to stay in the tree and cost nothing after convergence — **not** dead code. No action.

---

## 3. STRUCTURE / MAINTAINABILITY

Largest non-generated files (`wc -l`):

| LOC | File | Assessment |
|----|------|-----------|
| 2454 | `src/lib/jobs/reminder-worker.ts` | **God-file — split (see below).** |
| 1896 | `src/components/settings/ai-section.tsx` | Large but single-concern (AI provider config form). Split candidate, lower priority. |
| 1870 | `src/app/privacy/page.tsx` | Static bilingual legal doc — size is inherent. Leave. |
| 1811 | `src/components/charts/health-chart.tsx` | Core chart; Recharts is frozen. Candidate to extract sub-series renderers, but visual-identity rule makes this delicate — low priority. |
| 1785 | `src/lib/openapi/routes.ts` | Generated-adjacent registry; size is structural. Leave. |
| 1514 | `src/app/page.tsx` | Dashboard composition root. Review for extractable tiles, medium priority. |
| 1318 | `src/app/api/insights/targets/route.ts` | Single route at 1.3k LOC — review for handler extraction. |
| 1213 | `src/components/measurements/measurement-list.tsx` | Large list component, medium priority. |

### Top structural finding: `reminder-worker.ts` is a 2454-LOC pg-boss god-dispatcher
It hosts ~30 unrelated handlers in one file: `handleReminderCheck`, `handleWithingsFallbackSync` / `…ActivitySync` / `…SleepSync`, five `handle*StatusGenerate` variants, `handleMoodLogSync`, `handleMoodReminderCheck`/`…Cleanup`, `handlePushAttemptCleanup`, `handleRateLimitCleanup`, `handleIdempotencyCleanup`, `handleAuditLogCleanup`, `handleWithingsOAuthStateCleanup`, `handleHostMetricSample`, `handleFeedbackAggregator`, `handleGeoBackfill`, `handlePrDetection`, `handleMedicationInventoryExpire`, `handleIntakeAutoSkip`, `handleOffhostBackup`, `handleDataBackup`, plus `cleanupScheduledTelegramDeletions` and `startReminderWorker` wiring.

These share almost nothing beyond the pg-boss `Job<>` envelope. The codebase already extracts SOME handlers into siblings (`src/lib/jobs/intake-auto-skip.ts`, `step-consolidation.ts`, `geo-backfill.ts`, `pr-detection.ts`) — the pattern exists; the file just stopped following it. **Recommendation:** continue the established extraction — move each handler family into `src/lib/jobs/<family>.ts` and keep `reminder-worker.ts` as a thin registration/wiring shell (`startReminderWorker` + queue→handler map). Mechanical, test-covered, high maintainability payoff. No behaviour change.

### Codemap health: GOOD
- Naming conventions are consistent (kebab-case files, `use-` hooks); the known PascalCase outliers under `medications/`+`onboarding/` are the documented pre-existing drift.
- Comment discipline is strong — the WHY is documented at the non-obvious points (tz two-pass solver, read-swap fallbacks, fail-closed crypto). No comment-rot found.
- The job layer is the one place the structure has drifted (one mega-file vs the per-family pattern it already uses elsewhere).
- The medication-scheduling layer has an **incomplete migration** (2a) that is the single highest-value item: it is both a structural smell (two parallel engines) AND a live correctness divergence, and it blocks the planned v1.6.0 column drop.

## Priority order
1. **2a** — finish the v1.5.1 read-flip (live divergence + blocks v1.6.0). HIGH.
2. **§3** — split `reminder-worker.ts` along the existing per-family pattern. MEDIUM, mechanical.
3. **1b / 1a** — drop `DoseUnit` + `todays-dose-card.tsx` *as part of the medications rework* (list-only per brief). LOW.
4. **2b** — retire `legacy-bridge.ts` dual-write at v1.6.0, after 2a. LOW, gated.
