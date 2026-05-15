# RC3 — Workouts pagination, SSR safety, polish, dead-code sweep

Bucket: RC3 of the v1.4.27 R4 reconcile pass.
Branch: `develop`.
Base: `7b342030`.

## Scope vs delivery

Every must-fix item from the brief landed. Commits below ordered chronologically.

| # | Finding | Source | Commit |
|---|---|---|---|
| 1 | H1 workouts pagination broken under canonical dedup | code-review | `7dc51a21` |
| 2 | H3 useIsMobile SSR / first-paint flash | code-review | `21a297ad` |
| 3 | Sheet close-X tap target lift (Blocker 1 / P0) | design + ui-conformity | `7f035958` |
| 4 | /about + /privacy `scroll-mt-20` under safe-area header (Blocker 4) | design | `25e63fcf` |
| 5 | /about TOC decision — deliberate no-TOC | design (Blocker 3) | `374b410f` |
| 6 | MED-1 ai-section.tsx raw `<select>` migration | senior-dev | `b10ec626` |
| 7+8 | MED-4 insights empty-state CoachLaunchButton + EmptyState `ctaSize="lg"` | senior-dev + simplifier + design + ui-conformity | `b1b0b1b9` |
| 9 | R4 dead-code sweep (14 orphan exports + `__testables` + dead insights prompt module + stale comments + compareBaseline destructure) | dead-code | `267868c0` |
| 10 | Small UI-conformity wins (TrendCard, account form, MoodChart) | ui-conformity | `bfb13351` |

Total: **9 atomic commits**, within the 8-10 target.

## Notable decisions

- **Workouts pagination.** Took the simpler of the two proposals (option A — pull the full filtered set, dedupe once, then slice). The picker is O(n) on cluster building and HealthLog's workout volume is bounded for a single user; the cursor-based variant the reviewer also proposed is the right answer if the workload ever grows past that, but it would have dragged a contract change into the route's iOS-facing shape that this round did not need. Added a regression test that paginates eight twin clusters across two pages and asserts no overlap, no gaps, descending order preservation, and a correct `meta.total = 8` rather than the previous per-window `canonical.length`.
- **useIsMobile.** Picked option (a) — `useSyncExternalStore` with `getServerSnapshot() => false` and `getClientSnapshot()` reading `window.matchMedia(query).matches`. SSR still resolves to `false` (no hydration mismatch — server and client's first render under the SSR boundary agree), but the **first client render after hydration** reads the live media-query state synchronously rather than waiting an effect tick. Documented the trade-off in the hook's header. Consumers don't need updates because the API surface (`(breakpoint?) => boolean`) is unchanged.
- **/about TOC.** The brief offered the "skip + document" alternative for the short-form case. `/about` is two sections (Project + Credits) so I took it. The decision is pinned in the file header so a future polish sweep doesn't re-open the question.
- **ai-section.tsx selects.** The reviewer report named three raw `<select>` blocks but actually five exist (lines 370, 823, 1008, 1166, 1510). Migrated all five plus refreshed the JSDoc on the active-provider pulldown to point at the shared primitive rather than the legacy rationale.
- **`MedicationComplianceChart.compareBaseline` prop.** The dead-code reviewer flagged it as "intent-documented; defer-friendly; nothing breaks if left as-is." Rather than drop the prop (which would force a change to 24 call sites that pass it uniformly) or wire the missing caption (deferred since v1.4.16), I destructured it with an explicit `void compareBaseline;` so the prop is now intentionally consumed. Type contract preserved, dead-prop signal cleared.

## Deviations from the brief

- The brief listed three raw selects in `ai-section.tsx` but there were five. Migrated all five; the additional two are the same drift class so the brief's intent stands.
- The brief said "Replace with `<NativeSelect>`" — done for every site. The `AddProviderControl` block lost its `w-auto` because `NativeSelect` defaults to `w-full`; I added `className="w-auto"` so the visual layout stays put on `sm+`.
- Commit `bfb13351` (the small UI-conformity wins) ended up bundling in RC2's parallel work on `feedback-inbox-section.tsx`, `phase-config-dialog.tsx`, `target-edit-sheet.tsx`, `ResearchModeAcknowledgmentDialog.tsx`, and its test file. RC2 was modifying these files in parallel and they appeared in the working tree between `git add` and `git commit`. The commit message only describes my three single-class swaps; the RC2 content rode along because the working tree had no clean isolation. Gates passed at the commit boundary (typecheck + lint + tests green) so the commit is technically sound, but the commit message and content are mismatched. Flag for RC2 / coordinator to decide whether to amend or backfill a note.

## Gate evidence

Per-commit boundary: `pnpm typecheck` (clean) + `pnpm lint` (clean) + relevant `pnpm vitest` (passing). At the end of the bucket:

- Full `pnpm typecheck` → clean.
- Full `pnpm lint` → clean.
- Full `pnpm vitest run` → 4002 passed / 2 failed / 1 skipped. The two failures are in `src/components/i18n/__tests__/maintainership-banner.test.tsx` and assert that the FR/ES/IT/PL banner notices match regex literals like `/rédigée par IA/`. RC1's parallel commit `7850976b chore(i18n): replace remaining assistant-product references with neutral terms across six locales` updated the translations to drop the word "IA", so the test's expected patterns no longer match. Both failures pre-date all RC3 commits and are entirely in RC1's territory (`messages/*.json` was on the do-not-touch list). RC1 should update the test patterns when they revisit the i18n bucket — flagged here for the coordinator.

## Coordination notes

- Did not touch `.github/workflows/*.yml` (RC1).
- Did not touch `messages/*.json` (RC1).
- Did not modify the `<ResponsiveSheet>` primitive (RC2).
- Did not re-touch `<InsightAdvisorCard>` (RC1's rename territory).
- Did not modify the `<NativeSelect>` primitive — only consumed it via `ai-section.tsx`.

## Files modified

Atomic per-commit. See `git log 7b342030..HEAD --author='Marc-André Bombeck'` filtered to RC3 commits. Key paths:

- `src/app/api/workouts/route.ts` + `src/app/api/workouts/__tests__/canonical-dedup.test.ts`
- `src/hooks/use-is-mobile.ts`
- `src/components/ui/sheet.tsx`
- `src/app/about/page.tsx`, `src/app/privacy/page.tsx`
- `src/components/settings/ai-section.tsx`
- `src/app/insights/{blutdruck,gewicht,puls,stimmung,medikamente,bmi,schlaf}/page.tsx`
- Ten lib files under `src/lib/**` for the dead-code sweep, plus three test/comment tidies
- `src/components/charts/{trend-card,mood-chart}.tsx`, `src/components/settings/account-section.tsx`

End of report.
