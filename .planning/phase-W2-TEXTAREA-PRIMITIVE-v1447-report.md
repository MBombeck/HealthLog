# Phase W2 — Textarea primitive extraction (v1.4.47)

## Goal
Close the v1.4.43 mobile-UI audit L3 finding: six call-sites were each maintaining their own copy-pasted className with the `text-base sm:text-sm` iOS-zoom defence, drift risk on every edit. Extract a shadcn-style `<Textarea>` primitive parallel to `<Input>`, migrate the affected call-sites, lock the contract behind unit tests.

## What landed

### New primitive: `src/components/ui/textarea.tsx`
Mirror of `<Input>` for multi-line input. Baked-in defaults:

- **iOS zoom defence** — `text-base sm:text-sm` (16 px on mobile, 14 px on `sm+`). Safari zooms the viewport on focus when the rendered font is below 16 px and yanks the keyboard up; this defends every consumer without each site having to repeat the dance.
- **WCAG 2.5.5 tap-target floor** — `min-h-11 sm:min-h-9` (44 px on touch, 36 px on pointer). Lets `rows={1}` consumers stay above the tap-target floor without manually overriding.
- **`autoCapitalize="sentences"`** — free-text fields read as prose on iOS / Android by default. Caller overrides with `"none"` for code / JSON / IDs.
- **`spellCheck={true}`** — same reasoning; caller opts out for structured input.
- **`autoComplete="off"` + `data-lpignore` / `data-1p-ignore`** — same posture as `<Input>`: HealthLog is a health-data app, so password managers don't get to paste the user's saved password into a free-text note that we then persist server-side.
- **`forwardRef`** so consumers can attach refs (auto-grow, focus management, …).
- **`data-slot="textarea"`** for the shadcn convention.
- **`cn(…)` composition** — caller className wins via tailwind-merge, defaults still apply.

Plus the standard focus / aria-invalid / disabled treatment that mirrors `<Input>`.

### New tests: `src/components/ui/__tests__/textarea.test.tsx`
11 tests, all green. Locks the contract:

- iOS zoom defence class present (`text-base` + `sm:text-sm`).
- WCAG tap-target floor present (`min-h-11` + `sm:min-h-9`).
- `autoComplete` defaults to `"off"` with the password-manager ignore attrs.
- `autoCapitalize` defaults to `"sentences"`.
- `spellCheck` defaults to `true`.
- `data-slot="textarea"` attribute.
- Caller overrides for `autoCapitalize` / `spellCheck` are honoured (JSON-paste case).
- Caller overrides for `autoComplete` drop the ignore attrs.
- Caller className merges via `cn()` without losing defaults.
- `React.forwardRef` sentinel verified (sentinel-symbol check, dependency-free — no testing-library needed).
- `rows` / `placeholder` / `maxLength` forwarded to the underlying element.

## Call-sites migrated

| File | Lines saved | Notes |
| --- | --- | --- |
| `src/app/bugreport/page.tsx:202` | -3 (comment + comment + 211-char className) | Plain free-text bug description; primitive defaults are a 1:1 fit. |
| `src/app/medications/page.tsx:468` | -3 inline className + 2 comment | JSON paste — explicitly disables `autoCapitalize` + `spellCheck`, keeps the `font-mono` override via `className`. |
| `src/components/medications/SideEffectsSection.tsx:467` | -3 inline className + 2 comment + 2 redundant attrs | Compact notes-row inside side-effect modal; `px-2 py-1.5` padding override preserved via `className`. Dropped the redundant explicit `autoCapitalize="sentences"` / `autoComplete="off"` (now the default). |
| `src/components/admin/feedback-inbox-section.tsx:498` | -3 (comment + comment + 211-char className) | Admin internal-note textarea; primitive defaults are a 1:1 fit. |

**Total**: ~16 lines of copy-paste removed; **852 chars** of repeated className strings eliminated.

## Out of scope (intentional)

- **`src/components/insights/coach-panel/coach-input.tsx:188`** — included in the audit's "6+" count, but it's a fundamentally different design (auto-grow composer card wrapped in an outer "fake input" div with its own border + focus-within ring + Dracula-purple ring on focus, transparent textarea bg, custom `max-h-[9.5rem]` cap with internal overflow). Migrating it would require nullifying nearly every primitive default (border, bg, focus-ring, min-h, padding, shadow) — net worse than the inline pattern. Left as-is.
- `<Input>` modifications — separate concern per scope.

## Quality gates

- `pnpm typecheck` — green.
- `pnpm lint` on the touched files — green (one unrelated pre-existing warning in a withings test file remains).
- `pnpm test src/components/ui/__tests__/textarea.test.tsx` — 11/11 green.
- `pnpm test src/components/ui/__tests__/ src/components/medications/__tests__/SideEffectsSection.test.tsx` — 43/43 green; no regression in the suites that touch the migrated files.
- `npx prettier --check` on the touched files — clean after a `--write` pass.
- `npx knip` — clean (no unused exports / files).
- Full `pnpm test` — 5101 / 5104 pass; the 2 failing tests (`/api/dashboard/summary` idempotency + `/api/medications/intake` double-mint) are confirmed pre-existing (fail on origin/develop unchanged, verified via `git stash`). Not in this scope.

## Branch

`worktree-agent-a135dd75a71c47561` — branched from `origin/develop` (HEAD `690cfaf0`).

## Files touched

- **NEW** `src/components/ui/textarea.tsx` (+82 LOC)
- **NEW** `src/components/ui/__tests__/textarea.test.tsx` (+93 LOC)
- **EDIT** `src/app/bugreport/page.tsx` (-3 textarea LOC, +1 import)
- **EDIT** `src/app/medications/page.tsx` (-3 textarea LOC, +1 import, +3 explicit JSON overrides)
- **EDIT** `src/components/medications/SideEffectsSection.tsx` (-5 textarea LOC, +1 import)
- **EDIT** `src/components/admin/feedback-inbox-section.tsx` (-3 textarea LOC, +1 import)

Net: +169 LOC primitive + tests, -14 LOC inline copy-paste, with the audit's drift-risk surface area now closed behind a single contract + test file.
