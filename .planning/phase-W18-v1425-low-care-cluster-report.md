# Phase W18 — Low + Apply-with-Care Cluster (v1.4.25 Wave 5)

**Branch**: `develop`
**Started**: 2026-05-14, after Wave 4b closeout (`ab54d86b`)
**Scope source**: W18 brief — 12 items pulled from W10 review findings
(`.planning/research/w10-{code,design,security,senior-dev,simplifier,product-lead}*.md`).
**Parallel cohort**: W15 (`messages/*.json` + system-prompts + W7d hardening),
W20-rest (Pearson math, sentinel observer, sleep-stack, Coach polish).
**Touch-disjoint discipline**: never staged W15 or W20-rest files;
used explicit `git add <file>` for every commit; verified
`git diff --cached --stat` before each commit.

---

## Commits shipped (7)

| # | SHA       | Title                                                                                |
| - | --------- | ------------------------------------------------------------------------------------ |
| 1 | f16d4b3f  | fix(api): rename `coach.batch.too_large` to `measurement.batch.too_large`            |
| 2 | c2e5c860  | test(insights): cover `detectGlp1Plateau` direct branches with mocked prisma         |
| 3 | f4606fb1  | fix(charts): replace `hsl(var(--token))` with bare `var(--token)` refs               |
| 4 | 7b766bed  | fix(a11y): wire `aria-controls` + `aria-expanded` on GLP-1 dose-history details      |
| 5 | 03089675  | refactor(settings): collapse `moveSource` + `moveDeviceType` into `reorderLadder`    |
| 6 | bbc0afd5  | refactor(analytics): export `ContributingSource` so its callers stop spelling union  |
| 7 | 3b5f06d6  | refactor(insights): extract `useInsightStatus` hook for sub-page status queries      |

Plus one item where the content landed via a parallel-agent commit:

- **L2 chart-tick-tz fix** — my edit to
  `src/components/insights/sleep-stage-stacked-bar.tsx` (UTC anchor +
  `timeZone: "UTC"` formatter) was swept into W20-rest's commit
  `c80e0a08` ("exact Student's-t p-value via incomplete beta"). The
  content is in HEAD and verified by `pnpm test --run`; attribution
  is mis-credited but the fix shipped. See "Multi-agent collision"
  below.

---

## Items shipped vs deferred

### Shipped (8 / 12)

1. **L5 — `coach.batch.too_large` → `measurement.batch.too_large`** (`f16d4b3f`)
   Sibling DELETE route at `by-external-ids/route.ts` already uses
   `measurement.delete.too_large`; the rename realigns the batch
   ingest with its actual surface (`/api/measurements/batch`).
   Internal errorCode, not user-facing; integration test updated.

2. **L2 — Chart-tick tz** (in `c80e0a08` via collision)
   `formatDayTick` in `sleep-stage-stacked-bar.tsx` constructed
   `new Date(y, m-1, d)` in local server tz, then re-formatted with
   `toLocaleDateString` — a user in Asia/Tokyo viewing a
   Europe/Berlin SSR could see the weekday tick shift by one. Fix:
   `Date.UTC(y, m-1, d)` + `timeZone: "UTC"` on the formatter +
   `getUTCDate()` on the 14-day branch. Tests pass.

3. **L6 — `detectGlp1Plateau` direct test coverage** (`c2e5c860`)
   Existing coverage hit only the prompt formatter. Ten new tests
   pin the seven return paths plus the multi-medication `meds[0]`
   pick and the drug-name first-word display token. Total: 17
   (was 7).

4. **L3 (design) — `aria-controls` + `aria-expanded`** (`7b766bed`)
   GLP-1 medication-card dose-history `<details>` now references the
   inner panel by `useId()` ID, mirroring the rest of the app's
   accordions.

5. **P4-10 — `hsl(var(--token))` anti-pattern** (`f4606fb1`)
   Dracula tokens are hex; the `hsl()` wrapper produced invalid CSS.
   Four call sites in `mood-chart.tsx` + `scatter-correlation-chart.tsx`
   (CartesianGrid strokes + scatter tooltip bg/border) migrated to
   bare `var(--token)`. Closes the carryover from W10
   reconcile-A C1.

6. **S3 — `reorderLadder<T>()` helper** (`03089675`)
   `moveSource` + `moveDeviceType` in `sources-section.tsx` collapsed
   onto one generic helper; the two near-duplicates had drifted apart
   twice during W8c before being realigned.

7. **S9 — `ContributingSource` type alias** (`bbc0afd5`)
   `"manual" | "withings" | "appleHealth"` was spelled inline at six
   places across `health-score.ts` + `analytics/route.ts`. The
   `<HealthScoreCard>` component keeps its local duplicate
   deliberately (the in-file comment justifies it — client bundle
   stays free of analytics imports). Lib + route scope only.

8. **S12 — `useInsightStatus(metric)` hook** (`3b5f06d6`)
   Five sub-pages (`blutdruck` / `bmi` / `gewicht` / `puls` /
   `stimmung`) each carried the same 13-line `useQuery` block plus
   an identical `XxxStatusData` interface. The hook routes through
   the existing `queryKeys.*` factory so cache keys stop drifting on
   the next typo. Medikamente intentionally kept its bespoke query
   because the compliance-status payload carries a different shape
   (per-medication breakdown).

### Deferred (4 / 12 — see v1.4.26 backlog)

1. **Lazy locale bundles (L1)** — touches `messages/*.json` import
   graph in `src/lib/i18n/context.tsx` + `server-translator.ts`,
   which is W15's territory this wave. Already tracked as P4-1 in
   `v1426-backlog.md`. Not safe to ship without coordinating with
   the locale-key cleanup running concurrently.

2. **Dead testables (Item 5)** — only two `it.skip`/`describe.skipIf`
   instances exist in the codebase, and both carry explicit
   rationales:
   - `src/lib/i18n/__tests__/fallback-chain.test.tsx:30` —
     intentional `.skip` for "level-2 EN fallback (unreachable —
     parity test guards this)", with inline comment pointing at the
     locale-integrity test.
   - `src/lib/medications/__tests__/glp1-knowledge-drift.test.ts:166,206`
     — `describe.skipIf(!RESEARCH_AVAILABLE)` self-skips on CI where
     the research markdown is absent.
   Neither is a stale `>30-day` skip. No action.

3. **`/api/audit-log` decision (Item 6)** — Marc-decision item per
   `v1426-backlog.md` P4-6: "Either wire `/settings/audit-log` page
   OR delete the endpoint. Marc decision per endpoint." Cannot be
   resolved unilaterally from the finding text. Stays in v1.4.26.

4. **`Measurement.deviceType` enum (Item 7)** — the senior-dev
   finding explicitly notes "Worth a note for the v1.5 cleanup
   pass." Already tracked as P4-7. Not v1.4.25 scope.

### Verified-no-action (2 / 12)

5. **OpenAPI drift-guard (Item 8)** — `pnpm openapi:check` runs
   clean ("OpenAPI spec in sync with source schemas."). Gate is
   GREEN as of HEAD. The hard-flip is still warn-only per
   `v1426-backlog.md` P0-1 but that's the v1.4.26 strategic task,
   not a v1.4.25 drift fix.

6. **S11 / S14 / S15 (Item 12, discuss-first)** — finding text
   explicitly marks each as "discuss-first" with rationale that
   can't be resolved from the file alone (S11 SSR-mismatch guard;
   S14 documents-intent fast-path; S15 test-setup smell). Stays in
   v1.4.26 P4-12.

### Partially deferred (1 item)

7. **Design L1 — `motion-reduce:animate-none` consistency** — 30+
   files use `animate-spin` on Loader2 without
   `motion-reduce:animate-none`. The W10 finding labels it Low
   ("Settle on always-on for spinners that linger") and the
   surface area + concurrent-agent collision risk made a sweep-pass
   inappropriate for this wave. Adding to v1.4.26 backlog as
   P4-9-bis (sibling of the existing P4-9 design polish item).

### Apply-with-care held back (1 item)

8. **S1 — Derive `metricPriorityObjectSchema` from
   `SOURCE_PRIORITY_METRIC_KEYS`** — the simplifier finding marked
   this "Apply-with-care" with explicit warning: "Zod inference
   shape must hold — `z.infer<typeof metricPriorityObjectSchema>`
   should still type to the keyed object; verify before commit."
   `Required<MetricPriority>` is consumed at 11 downstream sites
   including `DEFAULT_SOURCE_PRIORITY` and `ResolvedSourcePriority`.
   The `z.object(Object.fromEntries(...))` form loses the key-level
   literal typing and falls back to `Record<string, T>`, which would
   break every `Required<MetricPriority>` consumer. The risk-reward
   doesn't justify shipping inside Wave 5. Already tracked as P4-11
   in `v1426-backlog.md`.

### S10 held back

9. **S10 — `allMessages` + `resolveKey` shared file** —
   `src/lib/i18n/context.tsx` and `server-translator.ts` both
   import the six `messages/*.json` bundles and declare an
   identical `allMessages` map. Extracting the shared file would
   mean editing context.tsx + server-translator.ts — both files
   that W15 also touches as part of their fallback-chain hardening
   work. Defer to v1.4.26 (already implicit in P4-1 lazy-bundle
   work).

---

## Multi-agent collision (one event)

At commit attempt 2 (chart-tick-tz fix) my `git commit -m "..."` ran
in a worktree where W20-rest had concurrently introduced changes to
`src/lib/insights/correlations.ts` + its test. The intended file
(`sleep-stage-stacked-bar.tsx`) was silently reverted in the working
tree between my Edit call and the commit. The commit (`fbb3c2c4`)
captured only W20-rest's correlations work under my commit message
— exactly the cross-attribution accident the touch-disjoint
discipline is meant to prevent.

Recovery:

- `git reset HEAD~1` (mixed) — non-destructive; W20-rest's changes
  returned to "modified, unstaged" where their owner could pick
  them up. They did, in `c80e0a08`. The same commit also carried
  my chart-tick-tz fix that was reapplied to the file before reset.
- All subsequent commits in this phase used `git add <specific
  files>` and verified `git diff --cached --stat` before
  committing.

Lessons captured in this report so future parallel-cohort waves can
codify the discipline.

---

## Quality gates

Every commit passed:

- `pnpm typecheck` — clean (W15's safeRequestProp regression was
  flagged once mid-phase and fixed by W15 within minutes;
  unrelated to my commits).
- `pnpm lint` — clean.
- Targeted `pnpm test --run <touched-surface>` — clean.

Final-state verification:

- `pnpm test --run` — **3751 passed, 1 skipped (337 files)**. +10
  net tests from W18 (`detectGlp1Plateau` coverage).
- `pnpm test:integration` — **164 passed (40 files)**.
- `pnpm openapi:check` — "OpenAPI spec in sync with source
  schemas."

---

## v1.4.26 backlog additions

Already present (verified, no edits needed):

- P4-1 (lazy locale bundles)
- P4-6 (`/api/audit-log` decision)
- P4-7 (`Measurement.deviceType` enum)
- P4-9 (Design Low/Medium polish — covers L1)
- P4-11 (Simplifier apply-with-care — covers S1, S10)
- P4-12 (Simplifier discuss-first — covers S11, S14, S15)

No new entries required — every deferred item maps to an existing
P4-* slot.

---

## File touch list

Production code:

- `src/app/api/measurements/batch/route.ts`
- `src/components/charts/mood-chart.tsx`
- `src/components/charts/scatter-correlation-chart.tsx`
- `src/components/medications/glp1-medication-card.tsx`
- `src/components/settings/sources-section.tsx`
- `src/lib/analytics/health-score.ts`
- `src/app/api/analytics/route.ts`
- `src/app/insights/{blutdruck,bmi,gewicht,puls,stimmung}/page.tsx`
- `src/hooks/use-insight-status.ts` (NEW)

(L2 sleep-stage-stacked-bar.tsx landed via W20-rest's commit.)

Tests:

- `tests/integration/measurements-batch.test.ts`
- `src/lib/insights/__tests__/glp1-plateau.test.ts`

Planning:

- `.planning/phase-W18-v1425-low-care-cluster-report.md` (this file).
