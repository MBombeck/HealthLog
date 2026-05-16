---
file: .planning/round-3c-insights-report.md
purpose: R3c-Insights closure report — Hero + HealthScore + trends consistency for v1.4.28
created: 2026-05-15
contributor: R3c-Insights
---

# v1.4.28 R3c-Insights — closure report

Hero + trends + HealthScore consistency sub-pass. Three atomic
commits planned; two land cleanly on develop under my authorship,
one lands under a parallel R3c-Med agent's commit (`0e7c97c5`) due
to a concurrent commit-script picking up my uncommitted working
tree. The work itself is shipped and the file deltas are byte-for-
byte the same as what I authored. Tests are present and passing.

## Commits

| Subject | Files | New tests | Commit |
|---|---|---|---|
| `fix(insights): match HealthScore card height to the hero column` | `hero-strip.tsx`, `health-score-card.tsx`, + 2 test files | 4 | `155b529d` |
| `feat(insights): explain the HealthScore delta on tap` | `health-score-delta-explainer.tsx` (NEW), `health-score-card.tsx`, all 6 locales, + 1 test file | 6 | `9a020f21` |
| `fix(insights): pin trend tiles to one equal-height contract` (intended subject) — landed under `fix(insights): align briefing empty-state CTA variant` | `trends-row.tsx`, `trend-annotation.tsx`, `mood-chart.tsx`, + 2 test files | 4 | `0e7c97c5` (R3c-Med commit absorbed the K-bucket diff) |

Total new tests: **14**. iOS contract touches: **zero**.

## FB-bucket coverage

### FB-H1 + FB-H2 + FB-H3 — HealthScore column-height contract (Commit 1, `155b529d`)

- FB-H3 was discharged by R3b's earlier weekly-report retire — the
  hero action row already reads as a single "Coach fragen" button,
  no `<WeeklyReportBanner>` mount, no "Wochenbericht erstellen"
  button. Verified by reading `src/components/insights/hero-strip.tsx`
  before any edit; the file already shipped the Coach-only shape.

- FB-H1/H2 land as a CSS-only contract:
  - `hero-strip.tsx`'s row flex switches from `md:items-start` /
    `lg:items-start` to `md:items-stretch` / `lg:items-stretch`
    when `healthScore` is supplied. The no-score branch keeps the
    older alignment to avoid blanket-applying stretch to layouts
    that have nothing to stretch toward.
  - `health-score-card.tsx`'s outer wrapper gets `flex h-full
    flex-col`; the inner `flex flex-col gap-3` block becomes
    `flex-1 flex flex-col gap-3`; the disclaimer footer gets
    `mt-auto` so it pins to the bottom while the score number and
    sub-bars stay at the top. The recovered vertical space sits
    quietly between the provenance accordion and the disclaimer.

- Tests pin the `md:items-stretch` / `lg:items-stretch` classes on
  the score-supplied branch, the no-score negative case, the card's
  `h-full flex flex-col` opt-in, and the disclaimer's `mt-auto`
  anchor. DOM-class assertions only — no pixel-height brittleness.

### FB-I1 — "vs last week" delta `?` explainer (Commit 2, `9a020f21`)

- New file `src/components/insights/health-score-delta-explainer.tsx`.
  Single icon-only `HelpCircle` button next to the existing delta
  line; tap opens a popover on `md+` and a bottom-sheet (via the
  existing `<ResponsiveSheet>` primitive) on phone-class viewports.

- Three-sentence Marc-Voice body per R1.1 §1: components → window →
  next step. EN reads: "The score combines BP, weight, mood and
  meds. We compare today's score with the same time last week. Log
  a fresh reading or a mood check to nudge it up." ≤165 chars (well
  under the 280-char ceiling).

- Native translations for DE, FR, ES, IT, PL (no English fallback
  strings — the new keys live in every locale).

- New i18n keys: `insights.healthScore.deltaExplainer.{trigger,
  title, description, body}`.

- The explainer only mounts when the parent surfaces a numeric
  delta. The "no history yet" caption stays untouched.

- Tests pin the trigger's accessible-label, the closed-by-default
  SSR snapshot, the EN/DE body copy, and the across-locale
  every-key-present invariant.

### FB-K1 + FB-K2 — trend row equal-height contract (Commit 3 content, landed under `0e7c97c5`)

- Per Inv-3 the mood tile painted ~52 px taller than the BP/weight
  tiles because the `<MoodChart>` used a default `<Card>` envelope
  (`py-6 gap-6`) while `<HealthChart mini>` paints with a slim
  `p-2` shell. Plus annotation captions were unbounded, so a long
  mood caption pulled every neighbour cell taller via `auto-rows-fr`.

- Three-slot fix:
  1. `mood-chart.tsx` mini-mode `<Card>` envelope collapses to
     `gap-1 py-2 shadow-none`; `<CardHeader>` to `px-2 pb-1
     [&]:gap-0.5`; `<CardContent>` to `px-2`. The mini chart band
     now sits at the same vertical position the BP/weight tiles
     paint. Mini-mode never showed the range-tab strip anyway (the
     `!mini` gate is already in place), so the "drop the mini-mode
     tab strip" recommendation from R1.1 §2 was effectively a
     no-op against the actual code; the envelope collapse is what
     fixed the misalignment.
  2. `trend-annotation.tsx` filled-state `<p>` picks up
     `line-clamp-3`; the empty-state `<p>` clamps too for visual
     symmetry. The longest mood annotation now ends with an
     ellipsis at three lines.
  3. `trends-row.tsx` lifts `auto-rows-fr` from `md:` to every
     breakpoint and wraps each chart in a `trends-row-chart-slot`
     div with `shrink-0` so the chart envelope is the load-bearing
     height slot, not the chart component's own padding.

- Tests pin `auto-rows-fr` on the row container, the three
  `trends-row-chart-slot` landmarks, and `line-clamp-3` on both
  annotation states (filled + empty).

## Collision notes

- `hero-strip.tsx` was in the R3b ownership table for the weekly-
  report retire. R3b's earlier commit (`cad53a68`) had already
  retired the banner mount and the "Wochenbericht erstellen"
  button; my edit only touches the row's `items-*` class, so no
  collision.

- `health-score-card.tsx` is solely owned by R3c-Insights.

- `mood-chart.tsx` is in the kickoff's owned-file list (the path
  typo `src/components/insights/mood-chart.tsx` reads through to
  the actual `src/components/charts/mood-chart.tsx`). The
  recommendation-card consumer of `<MoodChart mini>` is unaffected
  — it inherits the same slim envelope, which lines up with the
  recommendation-card's BP/weight chart minis that already use the
  `<HealthChart mini>` slim shape.

- The Commit 3 work landed under R3c-Med's commit `0e7c97c5`. The
  commit subject line in develop reads `fix(insights): align
  briefing empty-state CTA variant` (R3c-Med's BK-M2 task), but
  the diff contains 5 of my files (trends-row + trend-annotation +
  mood-chart + 2 test files) plus their daily-briefing.tsx change.
  The work is shipped; the attribution is mixed. Marked here for
  the R4 reviewer + the v1.4.28 closure report.

## Quality gates

- `pnpm typecheck` — clean on each commit (verified after stashing
  parallel agents' uncommitted work).
- `pnpm lint` — clean on each commit.
- `pnpm test --run` on the affected suites — clean. Full
  `src/components/insights/__tests__/` suite: 216 tests pass.

## iOS contract

Zero touches. No API route changed, no schema changed, no wire
contract reshaped. All work is web surface chrome + a new client-
only component (the delta explainer). R4 iOS reviewer verifies in
QA pass.

## Forbidden vocabulary check

Commit bodies, code comments, and i18n strings all scrubbed —
no "AI", "agent", "phase", "marathon", "Claude", or PII. The
v1.4.28 R3c-Insights identifier appears in code comments as the
version marker per Marc-voice convention.
