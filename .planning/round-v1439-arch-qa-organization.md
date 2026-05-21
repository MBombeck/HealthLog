# Architecture QA — Codebase Organization (Outside-Eye)

Snapshot: v1.4.39.3, ~681 TS/TSX source files, 36 top-level `src/lib/` modules, 132 `__tests__/` co-located dirs, 60 integration tests, 33 e2e specs.

## First-impression verdict

The codebase is **organized, opinionated, and surprisingly disciplined for the pace it has been shipped at**. The App-Router layout is by-the-book; `src/lib/` is partitioned by domain (analytics, ai, insights, measurements, medications, mood, withings, jobs, notifications, auth, …) rather than by technical kind (no `services/`, `helpers/`, `utils/` dumping grounds — `utils.ts` is 169 bytes); every meaningful module owns its `__tests__/` directory; `AGENTS.md` is an actively-maintained architecture statement that matches what the tree actually looks like. That is uncommon at this churn level — most codebases six weeks into a marathon would already have a `lib/misc/` or a `components/old/`. There is none here.

Where it shows wear is at the **seams between adjacent domains**. `src/lib/analytics/`, `src/lib/insights/`, `src/lib/ai/`, `src/lib/measurements/` (rollups), and `src/lib/medications/` (compliance-rollups) all live as peers, but the rollup tier introduced in v1.4.34 is now scattered across at least three of them (`measurements/rollups.ts`, `measurements/rollup-read*.ts`, `measurements/rollup-coverage.ts`, `analytics/*-fast-path.ts`, `medications/compliance-rollups.ts`, `mood/rollups.ts`). It works, but it is no longer a recognizable subsystem from a single directory. Similarly, three distinct `interface AnalyticsData {…}` declarations coexist (`src/app/page.tsx`, `src/app/insights/page.tsx`, `src/components/onboarding/getting-started-checklist.tsx`) alongside the shared `src/types/SubPageAnalyticsData` — that was an intentional partial extraction and the comment header acknowledges it.

The other wear-pattern is **file size at the busiest junctions**: `reminder-worker.ts` 2 175 LOC, `src/app/page.tsx` 1 440 LOC, `health-chart.tsx` 1 722 LOC, `ai-section.tsx` 1 739 LOC, `insights/targets/route.ts` 1 223 LOC, `measurements/rollups.ts` 846 LOC, `insights/features.ts` 929 LOC. None of these is "broken," but each is a single-author cognitive load that has grown one marathon at a time.

## Module boundaries

- **`src/app/`** is clean App-Router idiom: every route file is `page.tsx` / `route.ts` / `[id]/`, the `api/` tree mirrors the URL space, and `proxy.ts` (the renamed-from-middleware file documented in AGENTS.md) lives at the right level.
- **`src/lib/`** is partitioned by **domain**, not by kind — exactly the right call for a health app. 36 top-level subdirs, but each one has a coherent name (`measurements`, `mood`, `medications`, `withings`, `insights`, `ai`, `analytics`, `notifications`, `jobs`, `auth`, `cache`, `charts`, `i18n`, `logging`, `tz`, `openapi`, `validations` …). The few loose `.ts` files at the lib root (`crypto.ts`, `db.ts`, `api-response.ts`, `api-handler.ts`, `format.ts`, `geo.ts`, `telegram.ts`, `glucose.ts`, `gravatar.ts`, `query-keys.ts`, `timezone.ts`, `idempotency.ts`, `rate-limit.ts`) are genuinely cross-cutting primitives — not a dumping ground.
- **`src/components/`** mirrors the page tree (`measurements/`, `medications/`, `mood/`, `insights/`, `dashboard/`, `settings/`, `admin/`, `onboarding/`, `targets/`, `charts/`, `layout/`, `ui/`). The contract holds.
- **`src/generated/prisma/`** is honored — only **3 components** (`personal-record-badge.tsx`, `SideEffectsSection.tsx`, `health-chart.tsx`) import directly from `@/generated/prisma`. That is impressively low for an app this size.
- **Cross-layer violations**: I found **one** — `src/components/admin/backups-section.tsx` imports `BackupRow, BackupsList` from `@/app/api/admin/backups/route`. That is a component depending on a route handler's exported types, the textbook anti-pattern. It is the only one in the tree. Otherwise the direction is strict: `components → lib`, `app → lib`, `app → components`, never `lib → components` (except in one feature-flag test file, which is fine).
- **Analytics / Insights / AI separation** has **leaked**. `src/lib/analytics/` holds the SQL-aggregation primitives + the new `*-fast-path.ts` rollup readers. `src/lib/insights/` holds the metric-specific status modules (`blood-pressure-status.ts`, `bmi-status.ts`, `pulse-status.ts`, `weight-status.ts`, `mood-status.ts`, `medication-compliance-status.ts`, `general-status.ts`) **plus** `correlations.ts` (24 KB) **plus** `features.ts` (929 LOC) **plus** `comprehensive-aggregator.ts` (775 LOC) **plus** `prompt.ts` + `prompt-compact.ts`. `src/lib/ai/` is the provider/prompt layer (`prompts/`, `coach/`, `provider-runner.ts`, `provider-chain.ts`, `schema.ts`). The boundary "insights = domain-aware feature extraction; ai = LLM mechanics" is **roughly** there but `insights/prompt*.ts` and `ai/prompts/` are two prompt directories that a new reader would not be able to distinguish from filenames alone.
- **Rollup tier** is the youngest subsystem and the most scattered. It lives in `measurements/rollups.ts` + `measurements/rollup-read*.ts` + `measurements/rollup-coverage.ts` + `analytics/*-fast-path.ts` + `medications/compliance-rollups.ts` + `mood/rollups.ts` + boot-backfill in `jobs/`. Each piece is well-named in isolation; together they are not a directory.

## Type / DTO single-source

- **Zod-first validation is honored**: `src/lib/validations/` holds 17 schemas (`measurement.ts`, `medication.ts`, `moodlog.ts`, `coach-prefs.ts`, `workout.ts`, `source-priority.ts`, …) and they are consumed both by API routes (runtime) and by clients (inferred types). This is the strongest single source-of-truth signal in the codebase.
- **API response envelope** is single-sourced in `src/lib/api-response.ts` (`apiSuccess` / `apiError` / `safeJson`) and the `{ data, error, meta }` shape is universal.
- **DTO single-source-of-truth is partially leaked**:
  - `interface AnalyticsData` is declared 3× (`src/app/page.tsx`, `src/app/insights/page.tsx`, `src/components/onboarding/getting-started-checklist.tsx`) — `src/types/analytics.ts` extracted *only* the slim sub-page variant, intentionally per its header comment.
  - One component imports a route handler's exported type directly (`components/admin/backups-section.tsx ← app/api/admin/backups/route.ts`). Once that pattern starts, it grows.
- **Prisma types are not wrapped** in a domain layer. Direct `@/generated/prisma/client` imports across analytics + ai + insights + measurements — that is the right call for an internal app of this size (a domain layer would be ceremony). The fact that only 3 components reach for Prisma directly means the wrapping happens *organically* at the lib boundary.

## AI / Insights structure (Marc's domain priority)

- **`src/lib/ai/`** is well-shaped: one file per provider (`anthropic-client.ts`, `openai-client.ts`, `codex-client.ts`, `local-client.ts`, `mock-client.ts`), a `provider.ts` orchestrator (16 KB), `provider-chain.ts`, `provider-runner.ts`, `schema.ts` (21 KB Zod schemas for AI responses — single source of truth), `prompts/` directory with one file per metric (`blood-pressure.ts`, `bmi.ts`, `mood.ts`, `pulse.ts`, `weight.ts`, `medication-compliance.ts`, `general-status.ts`, `native-prompts.ts`) plus `base-system.ts`, `insight-generator.ts` (carries `PROMPT_VERSION`), and `safety-contracts.{de,en,es,fr,it,pl}.yaml` localized policy files. `coach/` is the conversational adjunct with its own `system-prompt.ts`, `snapshot.ts`, `budget.ts`, `refusal.ts`, `keyvalues.ts`, `persistence.ts`. This is **adapter-pattern done right**.
- **`PROMPT_VERSION`** is single-sourced in `src/lib/ai/prompts/insight-generator.ts` and consumed by `feedback-attribution.ts`, `schema.ts`, `validations/recommendation-feedback.ts`. No duplication.
- **`src/lib/insights/`** is the bridge between domain data and AI input. The seven `*-status.ts` files (blood-pressure, bmi, pulse, weight, mood, medication-compliance, general) form a consistent pattern — each owns its metric's status derivation. `features.ts` (929 LOC) + `comprehensive-aggregator.ts` (775 LOC) are the two large files here; both are pure aggregation logic and look like they grew organically from the marathon adds (W7b, IW-G, etc.).
- **The weak seam**: `src/lib/insights/prompt.ts` + `prompt-compact.ts` overlap conceptually with `src/lib/ai/prompts/`. A new reader cannot tell from the filenames which one to extend.
- **`src/components/insights/`** has 37 files — large but every name reads cleanly (`coach-panel/`, `daily-briefing.tsx`, `health-score-card.tsx`, `recommendation-card.tsx`, `correlation-card.tsx`, `trends-row.tsx`, …). The `coach-panel/` sub-directory is a clean module of its own (drawer, body, input, history-rail, message-thread, sources-rail, settings-sheet, mobile-rail-tray, source-chips, use-coach hook).

## Naming + conventions

- **App Router idiom**: 100% consistent — `route.ts`, `page.tsx`, `[id]/`, `[section]/`, `__tests__/` colocated.
- **Files**: 95% kebab-case. The **outliers** are all in `src/components/medications/`: `DrugLevelChart.tsx`, `MedicationCardHeader.tsx`, `ResearchModeAcknowledgmentDialog.tsx`, `SchedulingSection.tsx`, `SideEffectsSection.tsx`, `TitrationSection.tsx`. Six PascalCase files in one directory among 681. Looks like a single sub-marathon's author preference that never got normalized.
- **Hooks**: two homes, two conventions —
  - `src/hooks/` holds **12** generic-cross-cutting hooks (`use-auth`, `use-feature-flags`, `use-is-mobile`, `use-viewport-width`, `use-coach-prefs`, `use-coach-handoff`, `use-insights-analytics`, `use-insights-layout-prefs`, `use-chart-overlay-prefs`, `use-insight-status`, `use-scroll-reset-on-route`, `use-workouts`).
  - `src/lib/queries/` holds **2** TanStack-Query wrappers (`use-achievements-query`, `use-analytics-query`).
  - Plus component-local hooks (`use-coach.ts` inside `coach-panel/`, `use-chart-tooltip-active.ts`, `use-insights-advisor.ts` inside `components/insights/`).
  - The `*-query` suffix is used in 2 files in `lib/queries/`, but **not** in `hooks/use-workouts.ts` (also a TanStack-Query hook). That is a soft inconsistency — not broken, but it would bite a refactor.
- **`src/types/`** holds **a single file** (`analytics.ts`). Either commit to it as the shared DTO home or fold it back in. Right now it looks half-built.
- **API route directories** mirror the URL space cleanly. `__tests__/` directories sit next to every non-trivial route.

## Marathon scar tissue

- "v1.4.X — …" comments are pervasive (53 in `api/analytics/route.ts`, 46 hand-written `//` comments in `reminder-worker.ts`, 17 in `comprehensive-aggregator.ts`, 15 in `rollups.ts`, 8 in `insights/features.ts`). They explain *why* a fast-path was added, *which* release a refactor landed in, *what* the prior shape looked like. For the *author* during a marathon they are gold. For a *future reader six months removed from the marathon vocabulary* they are noise — "v1.4.34 IW-G", "v1.4.37 W2", "QA F-H-01", "BK-F-M1" decode to nothing without `.planning/` context.
- The `.planning/` directory holds **328** files. Pruning it isn't the answer (it's the audit trail), but the **in-source comment density that references it** has crossed into "the comments are the changelog now."
- The header style is consistent enough that a one-pass regex strip would be cheap. The `// v1.4.X — explanation` pattern is the single most prevalent comment style in the modified files.
- The good news: the marathon scars **never bled into filenames or directory names**. Nothing is called `bp-in-target-v2-fast-path-2026-05-17.ts`. The version-tagging stayed in comments, where it can be stripped without churning git blame.

## What's solidly built

- Domain-partitioned `src/lib/` with no `utils/`, `helpers/`, `services/` dumping grounds.
- Multi-provider AI adapter (`src/lib/ai/`) — clean per-provider file, single `provider.ts` orchestrator, single `schema.ts` Zod source.
- Zod-as-single-source for runtime validation + inferred types (`src/lib/validations/`).
- `{ data, error, meta }` envelope universal via `src/lib/api-response.ts`.
- Co-located `__tests__/` in 132 directories — consistent convention.
- `getSession()` + `proxy.ts` + `requireAuth()` auth seam intact.
- `AGENTS.md` is an **actively-maintained** architecture statement that matches the tree (Gotchas section is invaluable: Prisma 7 / Next.js 16 / Zod v4 / pg-boss / SimpleWebAuthn).
- App-Router idiom 100% consistent.
- Only 3 components reach for `@/generated/prisma` — the wrapping happens at lib boundary organically.
- Coach + Insights pages have their own coherent component sub-trees (`coach-panel/`).
- i18n discipline: messages are still partitioned across 6 locale files; no duplicated translation tables.

## What's accreted / debt'd

- **Rollup tier is scattered across 5 directories** (`measurements/`, `analytics/`, `medications/`, `mood/`, `jobs/`) with no `src/lib/rollups/` umbrella. Each file is well-named; the *system* is not a directory.
- **Two prompt homes**: `src/lib/ai/prompts/` and `src/lib/insights/prompt*.ts`. The split makes sense to whoever built it but is undiscoverable from filenames.
- **Three `interface AnalyticsData` declarations** coexist alongside the shared slim type in `src/types/analytics.ts`. The header comment in `types/analytics.ts` acknowledges this is intentional; that doesn't change the fact that a new contract change has to be applied in three places.
- **One component → route-handler type import** (`admin/backups-section.tsx`). Anti-pattern. Once it normalizes, it spreads.
- **`src/types/` has one file**. Decide: extract more DTOs here, or fold this one back.
- **PascalCase filename island** in `src/components/medications/` (6 files). Looks like a single-author sub-marathon.
- **Five files over 1 000 LOC**: `reminder-worker.ts` (2 175), `health-chart.tsx` (1 722), `ai-section.tsx` (1 739), `page.tsx` dashboard (1 440), `insights/targets/route.ts` (1 223), `medication-form.tsx` (1 162), `measurement-list.tsx` (1 187). Each is a single-author cognitive load.
- **Hook home is forked**: `src/hooks/` vs `src/lib/queries/` vs component-local `use-*.ts`. Naming convention drift (`-query` suffix in 2 files, absent elsewhere).
- **In-source release-version comments**: dense, valuable to the author, opaque to a six-months-later reader without `.planning/` cross-reference.

## Strategic recommendations

1. **Create `src/lib/rollups/`** as the umbrella for the v1.4.34+ rollup tier. Move (or re-export from) `measurements/rollups.ts`, `measurements/rollup-read*.ts`, `measurements/rollup-coverage.ts`, `analytics/*-fast-path.ts`, `medications/compliance-rollups.ts`, `mood/rollups.ts`. Highest-impact structural move: it makes the youngest, most-scattered subsystem **a recognizable directory**. Do this **before iOS** so the contract surface (what reads from rollups vs what reads live) is visible from one place.
2. **Promote `src/types/` to the actual DTO home** — or delete it. Extract the three `interface AnalyticsData` declarations, the `BackupRow`/`BackupsList` from `admin/backups/route.ts`, and a handful of other shapes that drift between server and client. The cost is one afternoon; the payoff is that "where do shared shapes live?" has one answer.
3. **Unify prompt directories**: collapse `src/lib/insights/prompt*.ts` into `src/lib/ai/prompts/insight-*.ts` (or rename `ai/prompts/` to `ai/prompt-templates/` and move `insights/prompt*.ts` there). One prompt home, one mental model — important because *prompts are the product*.
4. **Soft cap files at ~800 LOC** with a lint warning (not error). The 7 files >1 000 LOC are not "bad code" — they are the busiest junctions and likely candidates for natural extraction. `reminder-worker.ts` at 2 175 LOC is the standout — it already has phase modules in `reminder-phases.ts`; finish the extraction.
5. **Marathon-comment policy**: keep `// v1.4.X — why` for **non-obvious decisions** (cache invalidation rules, race-condition workarounds, contract-locked APIs). Strip them on `// trivial rename`, `// extracted body to`, `// moved from`. The rule is: if the comment would not make sense to someone who has never read `.planning/`, either inline the rationale or drop it. Cheap one-pass cleanup.
6. **Normalize the 6 PascalCase files** in `src/components/medications/` to kebab-case. Trivial, removes the only naming-convention island.
7. **Hook home decision**: pick one — `src/hooks/` for all React hooks (including TanStack-Query wrappers) **or** `src/lib/queries/` for query hooks + `src/hooks/` for everything else. Apply the `-query` suffix uniformly (or drop it). Avoid component-local `use-*.ts` outside of single-use cases.

## What NOT to refactor (warning bells)

- **`src/lib/ai/` provider files** — multi-provider adapter looks repetitive (5 client files), but each one carries provider-specific authentication, retry, and tokenization quirks. Don't DRY them.
- **The three `AnalyticsData` interfaces** — the header comment in `src/types/analytics.ts` explicitly explains why the dashboard's variant stays separate (it carries `bpInTargetPct*` aggregates). Recommendation 2 above means *extracting them where they are duplicated*, not forcing them to merge.
- **`prisma.config.ts` not `schema.prisma`** — the DB URL lives in the config file per Prisma 7's contract. AGENTS.md flags this as a hard-won gotcha. Don't "fix" it.
- **`proxy.ts` not `middleware.ts`** — Next.js 16 rename. Same gotcha class.
- **`zod/v4` imports** — `import from "zod/v4"` looks weird but is required by Zod v4's transitional namespace. Don't refactor to plain `zod`.
- **`src/generated/prisma/`** — generated, never hand-edit.
- **The 132 co-located `__tests__/` dirs** — this is **the** test convention. Don't move tests to a central tree.
- **`PROMPT_VERSION` exported from `insight-generator.ts`** — single source. The fact that `feedback-attribution.ts` imports it is the contract, not a smell.
- **The `safety-contracts.{locale}.yaml` files in `ai/prompts/`** — YAML alongside TS in the same dir looks odd; it is the localized AI policy and the runtime expects it there.
- **`src/lib/jobs/reminder-worker.ts` size** — 2 175 LOC is large, but the phase logic was already extracted to `reminder-phases.ts`; what remains is a single pg-boss entry point. Don't shrink for shrink's sake; shrink only when a coherent sub-module can be lifted (e.g. APNs vs Telegram vs ntfy vs Web Push dispatcher branches).
- **`.planning/` 328 files** — this is the audit trail. Don't prune.
