# Phase Fix-H — v1.4.25 Integration Hot-fix Report

PR #168 (`develop → main`) carried three integration test failures that
Fix-G flagged out-of-scope, plus a GHCR-publish regression from the
W11a multi-arch workflow refactor. This phase landed four atomic fixes
to clear `integration`, `Build linux/amd64`, and `Build linux/arm64`.

The personal-record-badge `useRef` claim from the Fix-G report turned
out to be already resolved by commit `223b8a9` (the W19b parallel agent
landed the final import set before this phase began). `pnpm typecheck`
was clean on entry and the badge's vitest suite passed without
modification.

## Commits

| sha       | summary                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `82c138f` | `fix(test): anchor coach-snapshot tz test to a sliding now-2d window`   |
| `afe8634` | `fix(test): align coach-prefs round-trip with W5 defaultWindow default` |
| `d75d47b` | `fix(test): spread batch-delete fixture rows across distinct measuredAt`|
| `a6f94cf` | `fix(ci): lowercase GHCR image ref for the multi-arch publish workflow` |

## Root causes + fixes

### 1. `timezone-per-user > coach snapshot anchors timeline.recent`

The W7b test seeded a measurement at the hard-coded instant
`2026-05-14T13:00:00.000Z` and asserted the Auckland day-key `2026-05-15`
landed in `snapshot.weight.timeline.recent`. The snapshot's
`recentCutoff` is `now − 14 days`, so the assertion was due to flip
deterministically two weeks after the test merged. The CI run on
2026-05-14 reproduced the assertion failure (`recent.length` went to 0
on the runner). Locally the test happened to still pass because the
host clock was a few hours earlier in the day.

Fix: derive the instant as `Date.now() − 2 days at 13:00 UTC` and
compute the expected Auckland / Berlin day-keys from that instant via
`Intl.DateTimeFormat`. The test now asserts the same tz-divergence
invariant without baking a calendar date into the fixture.

### 2. `coach-prefs > persists the supplied shape and round-trips`

W5 (v1.4.25) extended the coach-prefs schema with `defaultWindow`
defaulting to `"allTime"`. The PUT handler returns the canonical
defaulted shape, so the response envelope and the persisted row both
carry the extra field even when the caller omits it. The test was
written against the pre-W5 4-field shape and asserted strict
`toEqual(body)`.

Fix: compute the expected shape as `{ ...body, defaultWindow: "allTime" }`
and assert against it on both the PUT response and the GET round-trip.

### 3. `measurements-batch-delete > removes matching rows`

W17b/c migration `0055_measurement_sleepstage_composite` widened the
measurements unique index to
`(user_id, type, measured_at, source, sleep_stage)` with
`NULLS NOT DISTINCT`. The test fixture seeded three same-instant
APPLE_HEALTH weight rows (`sleep_stage` defaults to NULL), which now
collide on insert.

Fix: derive a stable per-externalId minute offset (`0..1023`) and
stagger the seeded `measuredAt` accordingly so each row lands on a
distinct (`user_id`, `type`, `measured_at`, `source`, `sleep_stage`)
tuple. The deletion-by-externalId contract is exercised unchanged —
the test no longer leans on dedup behaviour the route doesn't care
about.

### 4. `Build linux/amd64` / `Build linux/arm64` (GHCR lowercase)

The W11a multi-arch refactor (`3e78da6`) moved the workflow off
`docker/metadata-action` as the single source of the image-ref string
and started passing `${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}`
directly into the `outputs:` of `docker/build-push-action`.
`IMAGE_NAME` resolves to `github.repository` (`MBombeck/HealthLog`),
which GHCR rejects with `invalid reference format: repository name
(MBombeck/HealthLog) must be lowercase`. Both per-platform builds
exported the image layers successfully and then failed on push.

Fix: resolve the lowercase form once at the top of each job via
`${VAR,,}` bash expansion (`echo "IMAGE_REF=${REGISTRY}/${IMAGE_NAME,,}"
>> "$GITHUB_ENV"`) and reuse it across `metadata-action`,
`build-push-action`, and the `buildx imagetools` calls in the merge
stage.

## Quality gates (local)

- `pnpm typecheck` — clean
- `pnpm lint` — clean on every touched file
- `pnpm test` — 3460 / 3461 passed, 1 skipped (the GLP-1 research-file
  self-skip from Fix-G)
- `pnpm test:integration` — 40 / 40 files green, 164 / 164 tests green

## CI state on develop after pushes

After `d75d47b` (commits 1–3):
- `Lint, Typecheck & Test` — pass
- `Dependency Audit` — pass
- `Secret Scanning` — pass
- `integration` — pass (was failing on 3 tests)
- `Build linux/amd64` / `Build linux/arm64` — still failing on the
  lowercase ref issue (root cause now isolated)
- `e2e` — pre-existing failures on develop, unchanged

After `a6f94cf` (commit 4): builds expected to push successfully and
the `Merge multi-arch manifest` stage to fire. Awaiting CI confirmation.

## Out of scope / deferred

- **e2e** — three failures predate Fix-H and run on every commit since
  `a7cc5de` (the original PR #168 push):
  - `dashboard.spec.ts:134` — locator `getByText("Your blood-pressure
    trend is stable")` times out in both chromium-desktop and
    chromium-mobile.
  - `charts-mobile.spec.ts:195` — `.recharts-xAxis .recharts-cartesian-
    axis-tick text` locator times out at the Pixel 5 viewport.

  These appear to be insights-copy / chart-render regressions from the
  v1.4.25 wave (W3 insights-polish or W19b PR-badge interaction with
  the dashboard tile strip). The Fix-G report did not flag e2e in
  scope; addressing them needs a focused look at the affected
  components and is best handled in a follow-up Fix-I rather than
  bundled into the integration / GHCR hot-fix.
