# Phase W3e v1.4.25 — Zielwerte page redesign report

Author: implementation agent
Status: shipped, develop only (no push, no tag, no version bump)
Date: 2026-05-14

## Summary

Implemented the Zielwerte (Targets) page redesign per
`.planning/research/zielwerte-redesign.md`. Removed the v1.4.22 C1
inline sparkline + delta-vs-last-month caption (the "ungeliebt"
problem Marc flagged), and replaced them with a calmer page:

- Page-level summary header ("4 of 6 targets met this week")
- Editorial status pill + headline + range bar per card
- 7-day consistency strip (replaces the sparkline) — hidden when
  insufficient data
- Recency caption + streak chip (both conditional on real data)
- Per-card Coach CTA gated on `aiEnabled` (no broken-button state)
- Mobile-first responsive grid: 1 → 2 → 3 cols across 640 / 1024 px
- MOOD_STABILITY headline: verbal label ("stable" / "variable" /
  "highly variable") instead of raw σ; σ moves to a tooltip
- Fixed card order (BP → BP-in-target → WEIGHT → PULSE → BMI → MOOD →
  COMPLIANCE → SLEEP → BODY_FAT → STEPS) per Marc directive
- API: drops `points30d` + `deltaVsLastMonth`; adds `daysInRange7d`,
  `daysLogged7d`, `daysInRange30d`, `daysLogged30d`, `lastMetGoalAt`,
  `streakDays`, `insufficientData`, `consistency7d` per target, plus
  page-level `pageSummary`
- Coach drawer mounted on `/targets`; per-card CTA pre-fills a
  metric-specific question and narrows `CoachScope.sources`

## Per-phase commit SHAs

| Phase | SHA       | Subject                                                                                 |
| ----: | --------- | --------------------------------------------------------------------------------------- |
|     1 | `86a52da` | refactor(targets): remove v1.4.22 per-card sparkline + delta caption                    |
|     2 | `f3c9e2d` | feat(targets-api): add daysInRange7d + lastMetGoalAt + streakDays + pageSummary         |
|     3 | `97583cf` | refactor(targets): extract TargetCard + RangeBar + ConsistencyStrip + TargetCoachButton |
|     4 | `96c5e79` | feat(targets): page-level summary header                                                |
|     5 | `f2b9f84` | feat(targets): card layout with status pill + consistency + coach handoff               |
|     6 | `9acee2b` | feat(targets): MOOD_STABILITY headline switches from σ to verbal label                  |
|     7 | `f223b4f` | feat(targets): mobile-first responsive grid + card reflow                               |
|     8 | `ec4fb98` | feat(targets): mount CoachDrawer on /targets with per-card scope prefill                |
|     9 | `8e4a808` | i18n(targets): add EN + DE strings for redesigned card primitives                       |

All commits include neither `Co-Authored-By: Claude` nor any other
co-author trailer (per Marc directive 2026-05-14).

## Files changed

### Added (+1832 LOC)

- `src/components/targets/target-card.tsx` (~570 LOC) — redesigned
  card composition with status pill + headline + range bar +
  consistency strip + recency + streak + footer
- `src/components/targets/range-bar.tsx` (~160 LOC) — extracted from
  the inline page
- `src/components/targets/consistency-strip.tsx` (~125 LOC) — NEW
  7-day strip primitive
- `src/components/targets/target-coach-button.tsx` (~75 LOC) — NEW
  per-card Coach CTA with aiEnabled gate
- `src/components/targets/targets-summary-header.tsx` (~80 LOC) —
  page-level "X of N targets met this week" line
- `src/lib/targets/mood-stability-label.ts` (~25 LOC) — pure σ →
  verbal label helper
- `src/lib/ai/coach/target-prompts.ts` (~110 LOC) — 8 metric × 2
  locale prompt templates + general fallback
- `src/lib/ai/coach/target-scope.ts` (~45 LOC) — per-target
  CoachScope.sources mapping
- `src/hooks/use-coach-handoff.ts` (~55 LOC) — controlled state
  for the Coach drawer when mounted outside `/insights`
- 7 test files (~620 LOC)

### Changed

- `src/app/api/insights/targets/route.ts`: +606 / -77 LOC.
  Removed sparkline + delta helpers, removed 60-day window
  (single 30-day query now), added `rollupConsistency` +
  `rollupFromDayMap` helpers shared across every target type,
  added per-target consistency fields + page-level summary
- `src/app/targets/page.tsx`: -520 LOC (790 → ~270). Replaced
  inline composition with extracted primitives, added
  provider-chain query for `aiEnabled`, fixed card order,
  Coach drawer mount, responsive grid
- `messages/en.json` + `messages/de.json`: added the
  `targets.consistency.*`, `targets.card.*`, `targets.relativeDay.*`,
  `targets.summary.*`, `targets.coach.cta`, `targets.mood.stability.*`
  blocks; removed the duplicate flat `targets.mood` + `targets.moodStability`
  strings that collided with the new object; removed dead
  `targets.deltaVsLastMonth*` + `targets.deltaUnavailable` keys
- `src/app/__tests__/targets-i18n.test.tsx` +
  `src/app/__tests__/targets-spacing.test.tsx`: updated mocks
  to include `useQueryClient` + `useMutation` for the Coach
  drawer mount

### Removed

- `src/app/__tests__/targets-sparkline.test.tsx` — replaced by the
  W3e consistency-strip + target-card suites

## Skills invoked + impact

1. **`Skill: frontend-design`** — drove the calmer aesthetic
   ("editorial / clinical"). Concrete impacts:
   - Status pill: 12-14% opacity background + full-saturation
     foreground + ring (rather than v1.4.22's loud Badge variant
     swap). Reads as a quiet anchor, not a chip.
   - Headline label demoted to small-caps muted-foreground
     (`text-[0.6875rem] uppercase tracking-[0.08em]`); the
     big-value number is the focal point.
   - Streak chip uses the green token at 12% bg + 30% ring +
     1.5px solid dot. Same visual rhythm as the consistency-strip
     dots so the eye recognises it as part of the same family.
   - No animation, no gradients on the card (matches Marc's
     "muss nicht so sein wie die KI Sache" directive). The
     `<TargetsSummaryHeader>` check mark when all-met is static.

2. **`Skill: mobile-first-design`** — drove the breakpoint
   architecture:
   - Default (<640px): single column, full-width cards,
     gap-4; Coach CTA stretches full-width inside the footer
     so the touch target is ≥ 44px; source link sits beneath
     right-aligned via `self-end`.
   - sm (640-1023px): two columns; card footer reverts to
     horizontal row.
   - lg (1024px+): three columns, gap-6 (slightly wider
     gutters to match the dashboard rhythm).
   - Card headline row reflows: icon + label stacked above
     status pill on mobile (`flex-col`), inline on sm+
     (`sm:flex-row sm:justify-between`).

3. **`mcp__shadcn`** — verified the Badge + Card primitives
   are correctly composed. The redesigned status pill uses a
   raw `<span>` rather than `<Badge variant=…>` because the
   v1.4.22 inline-style colour hack (`backgroundColor:
'#xxxxxx20'`) is the wrong tool for the new ring + bg
   composition; the design-token approach (`bg-[var(...)]/12
ring-1 ring-[var(...)]/30`) reads as native shadcn
   styling. Card composition unchanged (CardHeader +
   CardContent + flex-col h-full pattern).

4. **`Skill: design-review`** — deferred. Manual inspection
   covers the contracts pinned by the test suite; a
   Playwright sweep is queued for the W3e verification phase
   alongside the visual diff.

## aiEnabled feature-flag implementation

Reviewer verification path:

1. **Server source of truth** —
   `src/app/api/insights/provider-chain/route.ts` `GET` returns
   `activeProvider: ProviderType | null`. The value is null when
   the user has no configured + enabled provider in their
   `aiProviderChain` AND no admin fallback applies.

2. **Client query** — `src/app/targets/page.tsx`:

   ```ts
   const { data: chainStatus } = useQuery({
     queryKey: ["insights", "provider-chain"],
     queryFn: async () => {
       const res = await fetch("/api/insights/provider-chain");
       if (!res.ok) return null;
       return (await res.json()).data as ProviderChainStatus;
     },
     enabled: isAuthenticated,
   });
   const aiEnabled = chainStatus?.activeProvider != null;
   ```

   The query key is shared with Settings → AI section so the
   cache is warm.

3. **Threading** — `aiEnabled` flows down into every
   `<TargetCard>` as a prop, and into `<TargetCoachButton>`
   inside the card.

4. **Gate** — `<TargetCoachButton>` returns `null` when
   `aiEnabled` is false (`src/components/targets/target-coach-button.tsx:47`).
   The page also short-circuits the mount entirely
   (`aiEnabled && <TargetCoachButton …/>`) so the component
   tree is clean when the user has no provider.

5. **Tests pinning the gate** —
   - `src/components/targets/__tests__/target-coach-button.test.tsx`
     — both branches (aiEnabled true + false)
   - `src/components/targets/__tests__/target-card.test.tsx`
     — `aiEnabled: false` case asserts no `data-slot="target-coach-cta"`
   - `src/app/__tests__/targets-coach-mount.test.tsx` — three
     branches (configured / unconfigured / loading)

## Verification

| Command             | Result                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`    | clean (exit 0)                                                                                                                       |
| `pnpm lint`         | clean (exit 0)                                                                                                                       |
| `pnpm test`         | 270 files, 2325 tests, 0 failures                                                                                                    |
| `pnpm format:check` | clean for all W3e-touched files; pre-existing warnings in `.planning/*.md` and `docs/audit/v1423-summary.md` are NOT from this phase |

Manual viewport audit (verified by Tailwind class inspection +
the `targets-responsive.test.tsx` suite):

| Width | Cards/row | Card footer reflow | Coach CTA width |
| ----: | --------: | ------------------ | --------------- |
|   375 |         1 | stacked            | full-width      |
|   640 |         2 | horizontal         | auto            |
|  1024 |         3 | horizontal         | auto            |
|  1440 |         3 | horizontal         | auto            |

Playwright sweep deferred to a follow-up commit (the playwright-skill
needs a running dev server which this agent does not have
permission to start; queued in the v1.4.25 backlog).

## Open questions for Marc

1. **PROMPT_VERSION ratchet?** — left at `4.23.0`. The
   per-card prefill is editable user-side text, not part of the
   model's system prompt. If you want every prefill change to
   ratchet PROMPT_VERSION (so the v1.4.23 conversation cache is
   invalidated and the next first turn uses the new prefill
   templates verbatim), the W3e reconcile can flip it to
   `4.25.0`. The implementation plan said "Probably no — verify
   in `src/lib/ai/prompts/coach-prompt.ts`"; the prompt itself
   did not change so I left it.

2. **Streak threshold** — chose ≥ 3 days for both the per-card
   chip and the page-level highlight. Marc plan said "≥ 3" for
   the streak chip; defaulted page-level to the same. If you
   want the page summary to highlight only longer streaks
   (≥ 5? ≥ 7?), the threshold is at
   `src/app/api/insights/targets/route.ts` in the `pageSummary`
   reduction.

3. **"Met this week" threshold** — chose `daysInRange7d >= 4`
   (half a logged week). The plan said "the target having
   `daysInRange7d >= 4` AND not flagged as `insufficientData`"
   — sticking with that. If a stricter "every day this week"
   reading better matches your mental model, the threshold is
   one line in the route handler.

4. **MOOD_STABILITY pill colour** — the verbal label sits in
   the headline (with σ tooltip); the status pill on the right
   still shows the server's classification ("Very stable" /
   "Stable" / "Fluctuating") and uses the same green/orange/red
   semantic. Reading the headline + pill together feels
   redundant ("Stable" + "Stable"). Acceptable, or want to
   suppress the pill on this single card?

5. **Coach prefill in i18n vs. JS** — the plan listed 12
   `targets.coach.prefill.{...}` i18n keys; I built them as
   JS templates in `src/lib/ai/coach/target-prompts.ts`
   instead. The templates interpolate live state
   (`current`, `range`, `streakDays`, `daysInRange7d`) and
   include conditional fragments — i18n's `{var}` placeholder
   syntax doesn't support those without 4-6 keys per metric.
   Acceptable, or do you want a string-table approach?

6. **Edit affordance (cog icon)** — the plan mentioned a
   "cog icon top-right of each card (same pattern as Dashboard
   chart cards)" wiring to a per-card threshold-override
   dialog. Punted to a follow-up because:
   (a) the v1.4.16 `getEffectiveRange()` + `thresholdsJson`
   plumbing is server-side only; surfacing per-card override
   UI requires a small additional API surface
   (`PATCH /api/auth/me/thresholds`) and a new dialog
   component;
   (b) it's a meaningful chunk of additional work that
   wasn't in the v1.4.25 W3e scope per the research report's
   §3.5 ("Out of scope for v1.4.25 but worth noting").
   Filed as a v1.4.26 backlog item.

## Anything not fully wired

- Per-card cog edit affordance — see open question 6.
- Playwright visual sweep across breakpoints — queued.
- Integration test for `GET /api/insights/targets` with the
  new consistency fields — the project has no existing
  integration test for this endpoint; adding one means
  scaffolding a fresh Prisma fixture for a Berlin-tz day
  fixture set. Punted to the v1.4.25 backlog so this phase
  can land on its W3e scope.
- The drawer's `key={…coachScope}` remount mechanic forces
  a fresh scope-aware mount when the user clicks a different
  card. This is the deliberate workaround for the drawer
  internally seeding its sources state from
  `DEFAULT_COACH_SCOPE` rather than from a `scope` prop. A
  cleaner future refactor would lift the scope to a prop on
  `<CoachDrawer>`; deferred to keep this phase contained.
