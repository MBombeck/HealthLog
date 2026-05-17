# Phase W-A — Cross-tz fast-path runtime guard

**Wave**: v1.4.38 W-A
**Branch**: `develop`
**Commits**:
- `33dc00fe` — `feat(tz): isNearUtc helper for cross-tz fast-path guard`
- `feae5b52` — `fix(correlations): fall back to live SQL when user is > 3h from UTC`
- `c72b3ce8` — `fix(geo-backfill): drop batch cap from 5000 to 500 rows per pass`
  *(parallel wave W-B; absorbed my staged bp-in-target-fast-path.ts +
  analytics/route.ts edits before my own commit landed — net diff is
  still correct, just split across two commits)*
- `9eda44fa` — `fix(bp-in-target): fall back to live SQL when user is > 3h from UTC`

## Scope landed

### Item 1 — `correlations-fast-path.ts` runtime guard
- Added `isNearUtc(userTz, now)` gate to the
  `measurementsOnRollups` selector. When the user is more than ±3 h
  from UTC the helper now forces the live SQL path so the SYS /
  PULSE / WEIGHT per-day means are re-keyed via the same
  `userDayKey(measuredAt, userTz)` helper the mood / intake streams
  use, guaranteeing day-key parity.
- Meta annotate gains `correlations.tz_guard:
  "near-utc" | "non-utc-live-fallback"`.

### Item 2 — `bp-in-target-fast-path.ts` runtime guard
- New optional `userTz?: string` field on
  `computeBpInTargetFastPath`'s input. When omitted the guard
  defaults to `near-utc` (backwards-compat for any legacy caller —
  today only `src/app/api/analytics/route.ts`, which has been
  updated to thread `userTz` through).
- Guard gates the rollup branch; threaded through to both
  `computeFromRollups` and `computeFromLive` so each annotate dict
  carries `analytics.bp_in_target.tz_guard`.

### Helper — `src/lib/tz/format.ts` + `src/lib/tz/resolver.ts`
- New pure `isNearUtc(tz, now = new Date())` helper. Reuses the
  existing `tzOffsetMinutes` machinery; honours DST. Defaults to
  `true` for invalid zones (defensive — Berlin is near-UTC, so the
  rollup-path is the safer fallback for the canonical tenant).
- Re-exported from `resolver.ts` for the server-side import path
  the analytics fast-paths already use.

## Tests delta

| File | Before | After | Notes |
| --- | --- | --- | --- |
| `src/lib/tz/__tests__/resolver.test.ts` | 28 cases | 35 cases | +7 cases pin Berlin / UTC / Moscow / Honolulu / Tokyo / Auckland branches plus the invalid-zone default and the `now`-omitted smoke path. |
| `src/lib/analytics/__tests__/correlations-fast-path.test.ts` | 6 cases | 9 cases | +3 cases pin Berlin → rollup, Honolulu → live-fallback, Tokyo → live-fallback (with `tz_guard` annotate assertions on the first two). |
| `src/lib/analytics/__tests__/bp-in-target-fast-path.test.ts` | 7 cases | 11 cases | +4 cases pin Berlin → rollup, Honolulu → live, Tokyo → live, and the legacy-compat "userTz omitted → near-UTC default" path. |
| **Touched-file total** | 41 | 55 | +14 new assertions. |
| Full suite | 4490 | 4504 | +14. |

Quality gates:
- `pnpm typecheck`: clean (silent).
- `pnpm lint`: clean for touched files; one pre-existing warning in
  `layout-coach-mount.tsx` unrelated to this wave.
- `pnpm test --run src/lib/tz/__tests__/resolver.test.ts
  src/lib/analytics/__tests__/bp-in-target-fast-path.test.ts
  src/lib/analytics/__tests__/correlations-fast-path.test.ts`:
  3 files, 54 tests passed (touched files).
- Full suite: 426 files, 4504 passed | 1 skipped (1 pre-existing
  skip unrelated to this wave).

## Self code-review (`superpowers:code-reviewer` substitute)

The `superpowers:code-reviewer` skill is not registered in this
session's available-skills list (closest options:
`code-review:code-review`, `review` — both PR-scoped, not diff-
scoped). Performed a structured self-review against the same axes
the dispatcher's skill would apply.

### Critical / High
*None.* The guard is one-directional (rollup → live), the live
fallback is the pre-existing v1.4.37 path with full coverage in
`correlations.test.ts` + `tests/integration/bp-in-target.test.ts`,
and the breadcrumb is purely additive on `meta`.

### Medium
- **M1 — `userTz?` optionality asymmetry**.
  `bp-in-target-fast-path` accepts `userTz?: string` and defaults
  to `"near-utc"` on omission; `correlations-fast-path` keeps
  `userTz: string` required. Justified — bp-in-target has had a
  single caller for the entire v1.4.37 cycle so the "legacy compat
  default" is forward-looking insurance; correlations was added in
  v1.4.37 W2 with `userTz` already required and no caller has ever
  omitted it. The asymmetry is documented in both JSDoc blocks.
  *No action.*
- **M2 — Positional-arg growth on the two private helpers**.
  `computeFromRollups` and `computeFromLive` now take 4 positional
  args (`userId, targets, now, tzGuard`). Both signatures remain
  reasonable for a private helper; the helpers are file-local so
  call sites are easy to grep. *No action — fold into an options
  bag only if a future arg lands.*

### Low
- **L1 — `isNearUtc` boundary inclusivity**. `Math.abs(offset) <=
  180` includes the ±3 h boundary; Moscow (+3) and the Atlantic
  islands round to near-UTC. Test `"returns true for the ±3h
  boundary zones"` pins this as deliberate. The docstring says
  "within ±3 hours of UTC" — phrasing already covers the inclusive
  read. *No action.*
- **L2 — Invalid-zone default returns true**. A junk tz string
  falls back to `DEFAULT_TIMEZONE` ("Europe/Berlin", near-UTC).
  Documented in the helper JSDoc; matches the broader resolver
  fallback semantics. *No action.*
- **L3 — `tz_guard` annotate field lacks an OpenAPI surface**.
  The v1.4.38 backlog already tracks "CORRELATION_WINDOW_DAYS = 28
  not in OpenAPI" as a Low item; `tz_guard` should join that batch
  if Marc opts to surface the meta envelope in the spec. *Defer to
  the OpenAPI cleanup batch.*

## Brief-back (≤200 words)

**(a) Which file landed which guard.**
- `src/lib/tz/format.ts` (+`resolver.ts` re-export) — new pure
  `isNearUtc(tz, now)` helper, ±3 h threshold, DST-aware via the
  existing `tzOffsetMinutes` machinery.
- `src/lib/analytics/correlations-fast-path.ts` — gate folded
  into the `measurementsOnRollups` selector; meta annotate gains
  `correlations.tz_guard`.
- `src/lib/analytics/bp-in-target-fast-path.ts` — new
  `userTz?: string` input field (defaults near-UTC for legacy
  compat); gate folded into the rollup-path conditional; both
  annotate sites carry `analytics.bp_in_target.tz_guard`.
- `src/app/api/analytics/route.ts` — threads its existing
  `userTz` into `computeBpInTargetFastPath`.

**(b) Tests delta.** +7 resolver cases pinning Berlin / UTC /
Moscow / Honolulu / Tokyo / Auckland / invalid-zone branches. +3
correlations cases (Berlin rollup, Honolulu / Tokyo live-
fallback). +4 bp-in-target cases (Berlin rollup, Honolulu / Tokyo
live, legacy-compat omitted-userTz default). Full suite 4490 →
4504, all green. Typecheck + lint clean for touched files.

**(c) Code-review finding worth surfacing.** None Critical/High.
Two Medium items are intentional asymmetries already documented
in JSDoc. The `superpowers:code-reviewer` skill itself is not
registered in this session — the closest available skill is
`code-review:code-review` which is PR-scoped; performed a
structured self-review against the same axes instead.

## Constraint compliance

- File set: `src/lib/analytics/correlations-fast-path.ts`,
  `src/lib/analytics/bp-in-target-fast-path.ts`,
  `src/lib/tz/resolver.ts`, `src/lib/tz/format.ts` (the helper had
  to land in `format.ts` because `resolver.ts` only re-exports
  pure helpers — keeps the client/server split intact), the three
  matching `__tests__/` files, and `src/app/api/analytics/route.ts`
  (one-line `userTz` thread-through to consume the new field).
  Did not touch other fast-path files, the rollup populator, or
  any other analytics route surface.
- Atomic Marc-Voice English commits; no `Co-Authored-By: Claude`,
  `--no-verify`, or `--no-gpg-sign`.
- Other agents' commits interleaved on `develop` during the wave
  (W-B geo-backfill `c72b3ce8` between my staging and my commit
  of bp-in-target). Final tree state is correct; the interleave
  meant my bp-in-target source edits landed in `c72b3ce8` while
  the matching tests landed in `9eda44fa`. Net diff
  `dcd0b0a5..HEAD` against my file set is exactly the scope of
  this wave.
