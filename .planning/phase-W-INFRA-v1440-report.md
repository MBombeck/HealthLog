# Phase W-INFRA — v1.4.40 marathon

Owner: W-INFRA. Phase D, sequential after W-GHOSTS. Four threads
shipped on `develop`. `pnpm typecheck` clean after every commit.
`pnpm lint` clean after the page.tsx fix. All 93 rollup tests green
post-restructure.

## Thread 1 — analytics route deletedAt gap (commit `fa368170`)

`src/app/api/analytics/route.ts` had three soft-delete leaks W-DELETED
skipped (assumption: W-POOL would catch them; W-POOL only touched
concurrency, not predicates):

| Call site | Body |
| --- | --- |
| `:507` | per-context glucose summaries (`FASTING` / `POSTPRANDIAL` / `RANDOM` / `BEDTIME`) |
| `:615` | sleep-stage breakdown (last 30 d, `sleepStage` non-null) |
| `:725` | `fetchMeasurementSeriesChunked` — the paged read backing the per-type `summarize()` loop **and** the BP-Zielbereich windowing **and** the deprecated correlation hypothesis path |

Added `deletedAt: null` to all three. The chunked helper is the
load-bearing one: every analytics tile derived from `summarize()`
(slope7/30/90, anomaly z-scores) was still pulling tombstoned rows
into trend math.

## Thread 2 — page.tsx lint regression (commit `8974e773`)

`src/app/page.tsx:577` — W-RSC commit `3cacfcf9` introduced a
`useMemo(() => …, [user?.timezone])`. React Compiler's
`preserve-manual-memoization` rule refused to optimise the surrounding
1 400-line component body because the inferred dep is the wider `user`
object — broader than the literal `user?.timezone` declared in the
dep array. Compiler "inferred less specific property than source"
error fires whenever an optional-chain expression spans the inference
boundary.

Fix: lift `const userTimezone = user?.timezone` to a local **before**
the memo, then key the memo on the local. Inferred + declared deps
agree and the compiler resumes optimising. No runtime change.

## Thread 3 — src/lib/rollups/ umbrella (5 commits)

Five atomic moves with typecheck between each:

| Commit | Files moved |
| --- | --- |
| `29bfcc67` | `measurements/rollups.ts` → `rollups/measurement-rollups.ts` + co-located test |
| `b7da526c` | `measurements/rollup-read.ts` → `rollups/measurement-read.ts`; `measurements/rollup-coverage.ts` → `rollups/measurement-coverage.ts` + tests |
| `8cfb1715` | `measurements/rollup-read-wmy.ts` → `rollups/measurement-read-wmy.ts`; `measurements/rollup-read-cumulative.ts` → `rollups/measurement-read-cumulative.ts` + tests |
| `63e56f7a` | `mood/rollups.ts` → `rollups/mood-rollups.ts` + co-located test |
| `cc08a43e` | `medications/compliance-rollups.ts` → `rollups/medication-compliance-rollups.ts` + co-located test |

### Before / after map

```
src/lib/measurements/                    src/lib/rollups/
├── rollups.ts                           ├── measurement-rollups.ts
├── rollup-read.ts                       ├── measurement-read.ts
├── rollup-read-wmy.ts                   ├── measurement-read-wmy.ts
├── rollup-read-cumulative.ts            ├── measurement-read-cumulative.ts
├── rollup-coverage.ts            -->    ├── measurement-coverage.ts
├── …other measurement helpers           ├── mood-rollups.ts
                                         ├── medication-compliance-rollups.ts
src/lib/mood/                            └── __tests__/
├── rollups.ts                               ├── measurement-rollups.test.ts
├── …other mood helpers                      ├── measurement-read.test.ts
                                             ├── measurement-read-wmy.test.ts
src/lib/medications/                         ├── measurement-read-cumulative.test.ts
├── compliance-rollups.ts                    ├── mood-rollups.test.ts
├── …other med helpers                       └── medication-compliance-rollups.test.ts
```

### Importer count rewritten

- `@/lib/measurements/rollups` → `@/lib/rollups/measurement-rollups`: 27 sites
- `@/lib/measurements/rollup-read` → `@/lib/rollups/measurement-read`: 2 sites
- `@/lib/measurements/rollup-coverage` → `@/lib/rollups/measurement-coverage`: 10 sites
- `@/lib/measurements/rollup-read-wmy` → `@/lib/rollups/measurement-read-wmy`: 2 sites
- `@/lib/measurements/rollup-read-cumulative` → `@/lib/rollups/measurement-read-cumulative`: 0 external (co-located test only)
- `@/lib/mood/rollups` → `@/lib/rollups/mood-rollups`: 17 sites
- `@/lib/medications/compliance-rollups` → `@/lib/rollups/medication-compliance-rollups`: 10 sites

Sibling-relative imports promoted to the `@/lib` alias where the move
crossed a directory boundary:

- `measurements/rollup-read.ts`'s `./rollups` →
  `@/lib/rollups/measurement-rollups` (fixed pre-move so the chain
  stays type-clean through the in-flight restructure)
- `rollups/measurement-read-cumulative.ts`'s `./apple-health-mapping`
  → `@/lib/measurements/apple-health-mapping` (apple-health-mapping
  stays in measurements/ — it isn't a rollup, just the canonical type
  mapping the cumulative reader consults)

Pure relocation: zero behaviour, zero exported-surface change. The
umbrella exists for discoverability + contract clarity before the iOS
sprint locks the rollup boundary as the read-path contract.

## Thread 4 — knip CI gate (commit `cbf55461`)

`pnpm add -D knip` (6.14.1). New `knip.json` + new
`.github/workflows/knip.yml` triggered on `push` to `main` and on PRs
targeting `main`. Gate runs
`pnpm knip --reporter compact --include files,dependencies,binaries,unlisted`
— `--include` restricted to the four categories where a new violation
genuinely means dead code is about to ship.

`exports` + `types` are deliberately omitted from the failure set this
release. The W-GHOSTS sweep cleared 1 177 lines of dead code but the
historic surface still shows 487 unused exports + 52 unused types,
which would have made the gate red on day one. Those categories should
become enforcing in a future wave, one module slice at a time.

### Baseline whitelist (knip.json)

`ignore` — three files W-GHOSTS' nine-commit sweep missed. Kept as
known-zero callers until a follow-up wave can verify they're safe to
delete together with their dedicated tests:

- `e2e/setup/test-helpers.ts` — 9-line barrel re-export; comment notes
  it's reserved for future multi-user spec helpers.
- `src/components/charts/compliance-line-chart.tsx` — only referenced
  from `__tests__/touch-action-guard.test.ts` (a contract test that
  expects the file to exist) and comment-only mentions in
  `chart-tokens.ts` + its test.
- `src/lib/logging/index.ts` — 21-line barrel re-export; never imported.

`ignoreDependencies`:

| Package | Why knip cannot see the consumer |
| --- | --- |
| `@hookform/resolvers`, `react-hook-form` | Dynamic import via `next/dynamic` + form-builder pattern |
| `@prisma/client` | Re-exported through `src/generated/` which is in `ignore` |
| `next-themes` | `ThemeProvider` is mounted via `next/dynamic` in `layout.tsx` |
| `@vitejs/plugin-react` | `vitest.config.ts` only |
| `shadcn` | CLI consumed by `pnpm dlx shadcn` invocations |
| `tailwindcss`, `tw-animate-css` | PostCSS pipeline + `@theme inline` directive in `globals.css` |
| `testcontainers` | Bootstrapped by `tests/integration/setup.ts` |
| `@types/node`, `@types/react`, `@types/react-dom` | Ambient typings |

`ignoreBinaries`:

| Binary | Why |
| --- | --- |
| `docker`, `docker-compose`, `pg_isready` | Invoked via shell from integration helpers (not from `package.json` scripts) |
| `tsx` | Reached via `npx tsx` in `openapi:generate` + `openapi:check` |

## Items deferred to v1.4.41 (per directive)

- `src/types/` DTO promotion (Org-audit rec #2) — out of scope to
  avoid clashing with in-flight imports.
- Prompt directory unification (Org-audit rec #3) — touches AI lib
  organisation; needs its own wave.
- ESLint custom rule for queryKey factory — W-RSC report deferred this.
- Delete-rather-than-whitelist for the three `ignore`d files above
  once a future wave can also remove their dedicated tests.
- Enforce knip on `exports` + `types` once the 487 / 52 historic
  backlog is cleared incrementally.

## Verification

- `pnpm typecheck` — clean after every commit (9 commits, 9 runs).
- `pnpm lint` — clean after the page.tsx fix.
- `pnpm vitest run src/lib/rollups/__tests__` — 6 files / 93 tests passed.
- `pnpm knip --reporter compact --include files,dependencies,binaries,unlisted` — zero output, exit 0.
