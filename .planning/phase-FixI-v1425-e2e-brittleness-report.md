# Phase Fix-I — v1.4.25 E2E Brittleness Hot-fix Report

PR #168 (`develop → main`, "Release v1.4.25") arrived at this phase with
`lint`, `typecheck`, `test`, and `integration` green but `e2e` red on
CI run 25874585653. Three specs failed across two root causes — one a
silent third-party DOM-shift (Recharts 3.x), one a fragile literal-string
assertion that contradicted HealthLog's evidence-grounded AI Insights
contract. Both fixes are scoped strictly to `e2e/*.spec.ts`; no
production code was touched, which kept this phase clear of the
concurrent W14b-Foundation slot working `src/app/onboarding/**`.

## Commits

| sha       | summary                                                              |
| --------- | -------------------------------------------------------------------- |
| `d22fc21` | `fix(e2e): make charts-mobile xAxis-tick wait class-independent`     |
| `03bf21e` | `fix(e2e): assert dashboard insight card container, not literal AI text` |

## Root causes + fixes

### 1. `charts-mobile.spec.ts:225` — Recharts 3.x relocated x-axis tick labels

The spec waited on
`.recharts-xAxis .recharts-cartesian-axis-tick text` to mount before
counting visible ticks. Locally on a fresh prod build the locator
timed out after 10 s.

A DOM probe under the same Pixel-5 + Recharts 3.8.1 conditions revealed
the cause: in Recharts 3.x the tick labels are no longer nested inside
the `.recharts-xAxis` axis layer. They render in a separate
`ZIndexLayer` container with class `.recharts-xAxis-tick-labels` that
sits as a *sibling* of the axis-line layer. The empty stubs that *do*
nest under `.recharts-xAxis` carry no `<text>` child, so the old
selector matched zero elements no matter how long the wait was. Each
label is now a `.recharts-cartesian-axis-tick-label` `<g>` wrapping a
`<text class="recharts-text recharts-cartesian-axis-tick-value">`.

Fix: switch both the readiness wait and the per-chart count to the new
container.

- Wait selector → `.recharts-xAxis-tick-labels text`
- Per-chart count scopes to each `.recharts-wrapper`, reads
  `.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label`,
  filters empties, and drops zero-axis wrappers (the sparkline tiles
  expose a `.recharts-xAxis` stub but no labels — counting them would
  silently dilute the legibility cap).

The header-row regression (`charts-mobile.spec.ts:144`) was unaffected
and continues to pass.

### 2. `dashboard.spec.ts:169` — literal AI prose vs. structural contract

The spec asserted on the literal text
`"Your blood-pressure trend is stable"` rendered on `/insights`. The
assertion failed because the `/insights` mother page no longer mounts a
`general-status` per-section card at all — the W4 redesign carved that
surface into routed sub-pages, and the mother page renders
`InsightAdvisorCard` reading from `/api/insights/generate` (gated on
`/api/insights/comprehensive`). The test's mock of
`/api/insights/general-status*` is a no-op against a dead endpoint, so
the page rendered the EmptyState CTA instead, and the literal substring
never appeared in the DOM.

Two failures in one shape:

- The mock was wired to a route the page does not call.
- Even with the right mock, asserting on a verbatim AI prose substring
  contradicts the "AI Insights are evidence-grounded and dynamic"
  contract Marc has emphasised in memory. Prose varies per provider +
  cache state by design.

Fix: re-mock the routes the page actually calls
(`/api/insights/comprehensive` with a minimal payload past the data-
floor gate; `/api/insights/generate` with a minimal-but-valid
`InsightResult`), then assert on the populated card's stable structural
hook `[data-slot="insight-summary"]`. The slot is set by
`InsightAdvisorCard` on the populated-body branch only, so the
assertion proves "the card mounted its summary when the payload
arrived" — the true contract under test — without coupling to AI text
that will never render verbatim across deploys.

## Local verification

```
$ pnpm exec playwright test e2e/charts-mobile.spec.ts e2e/dashboard.spec.ts \
    --reporter=line --workers=1

  2 skipped
  4 passed (7.0s)
```

The 2 skipped tests are `charts-mobile.spec.ts` on `chromium-desktop`
(the spec self-skips via `test.skip(testInfo.project.name !==
"chromium-mobile")` — by design). The 4 passes cover:

- `chromium-mobile` × `charts-mobile.spec.ts:144` (header row)
- `chromium-mobile` × `charts-mobile.spec.ts:195` (≤ 7 ticks)
- `chromium-desktop` × `dashboard.spec.ts:134`
- `chromium-mobile` × `dashboard.spec.ts:134`

`pnpm typecheck` and `pnpm lint` were clean before each commit.

## Subtle findings

- Recharts 3.x' DOM restructure is a silent contract break for any
  spec or DOM probe that walks the axis tree assuming a nested layout.
  The `.recharts-xAxis` class still exists but is now an empty
  structural marker — useful only for "an axis was registered" checks,
  not for tick counting. Any other spec or unit test still using the
  pre-3.x selector chain should expect the same timeout.
- The dashboard spec's reliance on a literal AI string was a v1.4.20-era
  artefact written before the W4 redesign carved out the
  general-status card. The structural-assertion pattern this phase
  introduces (`[data-slot="insight-summary"]`) is the correct shape
  for future insight-surface specs; the same hook is already in use by
  `insights-advisor-card.spec.ts` for the per-card structural probes.
- One non-blocking environment finding: rate-limited login on
  `/api/auth/login` is anchored in the Postgres `rate_limits` table
  rather than in-memory, so a flurry of `globalSetup` runs during
  local triage triggers a HTTP 429 that survives server restart. CI
  does not hit this because each run gets a clean DB. Worth a
  follow-up to either reset the bucket in `globalSetup` or scope the
  bucket to a process-id when `NODE_ENV !== "production"`.
