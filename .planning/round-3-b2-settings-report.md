---
file: .planning/round-3-b2-settings-report.md
bucket: B2 — Settings + admin profile form + shell layout-shift fix
target_tag: v1.4.27
findings_applied: [9, 10, 11, 12]
created: 2026-05-15
---

# Bucket B2 — Implementation report

## Commits (on `develop`, pushed)

1. `a04e119c` — `fix(settings): pair date-of-birth with language in one grid row`
2. `2e4edbf2` — `fix(settings): raise the TimezonePicker inner gap to match the form rhythm`
3. `b2802530` — `fix(settings): reserve a minimum main-column height in the settings and admin shells`
4. `9c8660a4` — `feat(settings): replace single-spinner loading with skeleton rows on Thresholds and Sources`

Other commits between mine (`d567e454`, `1e1e7e13`, `3ed78a03`, `e060ab33`) are from parallel contributors on other buckets — out of scope here.

## Per-commit scope

### 1. F9 + F11 — DOB + Language pair (`a04e119c`)
- `src/components/settings/account-section.tsx`: language `<select>` moved into the same `grid gap-4 sm:grid-cols-2` row as `dob`; standalone language wrapper + its `sm:max-w-xs` clamp dropped; in-line comment updated to reflect the new pairing intent (v1.4.19 A6 rationale that split the pair is no longer accurate).
- `e2e/settings-mobile-consistency.spec.ts`: flipped the "Sprache select is in its own row, not paired with date-of-birth" test to assert the new contract (shared grid). Same locator code — only the boolean expectation + the spec title + the rationale comment changed.

### 2. F10 — TimezonePicker inner gap (`2e4edbf2`)
- `src/components/settings/timezone-picker.tsx`: the `<div>` wrapping the select + detect button changed from `gap-2` to `gap-3`. No other touch on the picker; the `sm:max-w-sm` on the select stays so the detect button keeps its hugged-action geometry.

### 3. F12 — Shell main-column min-height (`b2802530`)
- `src/components/settings/settings-shell.tsx`: `<main className="min-w-0">` → `<main className="min-h-[calc(100dvh-12rem)] min-w-0">`; comment expanded to explain the reserve.
- `src/components/admin/admin-shell.tsx`: same change.
- 12 rem reserve = global header (5 rem) + section header (~5 rem) + 2 rem buffer. Short sections (e.g. `/settings/about`) stay short because `min-h` does not clamp tall content.

### 4. F12 — Skeleton rows replacing single-spinner (`9c8660a4`)
- `src/components/settings/thresholds-editor-section.tsx`: dropped `Loader2` import + loading-state element. Added a local `<ThresholdsSkeletonList>` helper that maps over `METRIC_ORDER` (14 entries) and renders a row with the same `border-border space-y-3 rounded-lg border p-4` container as `<MetricRow>`, with `<Skeleton>` primitives for the label / hint / toggle.
- `src/components/settings/sources-section.tsx`: kept `Loader2` (still used on the save button spinner). Replaced the loading-state element with a local `<SourcesSkeletonList>` helper that maps over `SOURCE_PRIORITY_METRIC_KEYS` (14 entries) and renders a card with the same `border-border bg-background/30 space-y-2 rounded-md border p-3` container as the live ladder + two `h-9 w-full` skeleton ladder rows.

## Translation keys

No new translation keys introduced. The skeletons render with `aria-hidden="true"` (presentation only) and the live UI's existing strings cover the loaded path.

## Playwright timing test — SKIPPED

Reason: the repo's Playwright `webServer` requires `pnpm exec next start --port 3000`, which depends on a prior `pnpm build`. HealthLog's production build is well over the 3-minute fast-runner budget specified in the dispatch. The smoke specs in `e2e/` are normally run from CI after the build step, not interactively. Documenting here rather than landing a half-instrumented spec that the runner would skip in practice.

Visual smoke without Playwright was confirmed at the unit level:
- `pnpm vitest run src/components/settings/__tests__/sections.test.tsx src/components/settings/__tests__/settings-shell.test.tsx` — 24 / 24 passing.
- Targeted lint over the six touched files — clean.
- `pnpm typecheck` — clean for my files (the unrelated `src/lib/geo.ts` errors land under B3's in-flight work).

## Coordination notes honoured

- `messages/{de,en,fr,es,it,pl}.json` — untouched.
- `prisma/schema.prisma` — untouched.
- Shell heading weights / card cadence / label-input gaps — untouched (B7 owns the symmetry sweep).

## Deviations from the fix-plan

- `src/components/settings/__tests__/account-section.test.tsx` and `timezone-picker.test.tsx` do not exist in the repo. The fix-plan instructed to "adjust assertions" and "re-baseline if any class assertion breaks"; there were no assertions to re-baseline. The closest equivalent — the SSR smoke at `src/components/settings/__tests__/sections.test.tsx` and the e2e at `e2e/settings-mobile-consistency.spec.ts` — was checked; only the e2e needed an assertion flip (documented above under commit 1).
- The B2 dispatch said "raise `gap-2` → `gap-3` between the select and the detect button". The actual line changed sits on the parent flex container `<div className="flex flex-col gap-2 sm:flex-row sm:items-center">` — same intent (gap between select and button on the sm+ row, plus the stacked gap on mobile), just one container up the tree from the literal description. Verified no other `gap-2` is present in the picker.
- The shell min-height calc landed exactly as specified (`min-h-[calc(100dvh-12rem)]`); kept the existing `min-w-0` so the grid layout still allows the main column to shrink under its content.

## Repo concurrency observations

Several parallel contributors are writing to the working tree during this round (B3 on `src/lib/geo.ts`, the charts bucket on `src/app/page.tsx`, others on `src/lib/withings/*`). Symptoms hit during this work:
- A `git stash pop` brought in another contributor's files that had been there before stashing — expected.
- A first `git commit` for the shell min-height change picked up two unrelated planning files that became tracked between staging and commit. Recovered via `git reset HEAD~1 --soft` followed by `git commit --only <paths>`. All four landed commits are scoped to the B2 fileset only — verified via `git show --stat` on each.
- The repo-wide `pnpm typecheck` and `pnpm lint` both surface errors from in-flight neighbour work. Targeted runs over the six B2 files are clean.
