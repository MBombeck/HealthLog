# Phase W-PROCESS-DOCS — v1.4.41 report

Wave **W-PROCESS-DOCS** delivers three process / DX hardening items
identified in the v1.4.40 audit + W-INFRA closure report.

## Item 1 — knip exports + types enforcement (STAGED, not yet flipped)

**Goal**: promote `exports` + `types` from informational-only to
enforcing in `.github/workflows/knip.yml`.

**Status**: gate **staged** — comment block + flip instructions in
place, but the `--include` filter still excludes `exports,types`
because the cleanup waves they depend on (W-SIMPLIFIER,
W-INSIGHTS-HOT) had not yet landed on `develop` at the time
W-PROCESS-DOCS ran.

**Baseline at hand-off** (from `pnpm knip --reporter compact` on
HEAD `4cca62dc…`):

- Unused exports: 48
- Unused exported types: 52

Most of the remaining surface is public-API zod schemas and type
aliases re-exported for downstream consumers — many will legitimately
stay after cleanup. The promotion criterion is **zero offenders on a
clean `pnpm knip --reporter compact`**, NOT "drive both counts to
zero unconditionally". Where a public schema must remain exported,
the next wave should:

1. Verify the export has an external consumer (test file, API route,
   downstream package).
2. Add a `// knip-ignore` marker tag on the export, OR add the file
   to `knip.json`'s `ignore` block with a one-line rationale.

**Flip recipe** for the wave that lands after W-SIMPLIFIER +
W-INSIGHTS-HOT:

```yaml
# .github/workflows/knip.yml — drop the --include filter
- run: pnpm knip --reporter compact
```

A revert is a one-line restoration of the `--include` filter — risk
is low and reversible.

## Item 2 — ESLint custom rule `healthlog/queryKey-factory` (SHIPPED)

**Goal**: promote the test-guard substitute (v1.4.40 W-RSC,
`src/lib/__tests__/query-keys.test.ts` factory-bypass guard) to a
real ESLint rule so editor + CI both fail fast on a literal-array
`queryKey: [ … ]` declaration inside guarded files.

**Files**:

- `eslint-plugins/healthlog/queryKey-factory.js` — new flat-config
  plugin. AST rule scans every `Property` node and flags
  `queryKey: ArrayExpression` / `mutationKey: ArrayExpression` only
  when the surrounding file is on the guarded list. Identifiers,
  `queryKeys.foo()` call expressions, and conditional expressions
  all pass — only the bypass shape from audit-H1 fails.
- `eslint.config.mjs` — registers the plugin and wires the rule at
  `"error"` severity.

**Guarded surface** (mirrors `guardedRoots` in the test-guard
substitute):

- `src/components/charts/**`
- `src/components/comparison/**`
- `src/app/page.tsx`
- `src/hooks/use-auth.ts`

Files outside the guarded surface are intentionally exempt — extend
the list in lockstep with the test-guard substitute as future waves
migrate `src/components/admin/**`, `src/components/settings/**`,
`src/components/medications/**`, and `src/components/integrations/**`
to the factory.

**Whitelist** for the factory home itself:

- `src/lib/query-keys.ts` (the factory definition)
- `src/lib/__tests__/query-keys.test.ts` (asserts factory output
  shape against literal keys — intentional)

**Verification**: `pnpm lint` reports 0 errors / 5 pre-existing
warnings on HEAD. The new rule loads cleanly and matches zero
offenders, confirming W-RSC + W-FRONTEND-FACTORY already routed
every guarded file through the factory.

## Item 3 — pg.Pool max × N container deploy doc (SHIPPED)

**Goal**: document the v1.4.40 W-POOL change (`pg.Pool max = 20` per
container, env-overridable via `DATABASE_POOL_MAX`) in deploy notes
so operators can compute the per-deployment pool envelope without
reading source.

**File**: `docs/self-hosting/scaling.md` — appended a
`## Postgres connection-pool sizing (v1.4.40 W-POOL)` section
covering:

- The 20-slot default rationale (cold-mount trace, `p-limit(4)`
  pairing).
- A `container_count × DATABASE_POOL_MAX` ready-reckoner table from
  1 to 5 containers against the stock `max_connections = 100`
  ceiling, including the headroom column and the "do not exceed"
  callout for 5 containers.
- An override example (`docker-compose.yml`) and three rules of
  thumb for picking the right per-container ceiling.
- A pointer to PgBouncer transaction pooling for deployments that
  outgrow the per-process pool model.
- A cross-reference to `src/lib/db.ts → getPoolMax()` and the
  empirical trace that motivated the bump.

The page already covered the web/worker split from v1.4 G3, so the
new section sits naturally at the end as the next "what to know
when you scale horizontally" topic.

## Touch-disjoint guards honoured

- Did NOT touch `src/lib/query-keys.ts` (W-FRONTEND-FACTORY territory).
- Did NOT touch `src/lib/__tests__/query-keys.test.ts` (W-FRONTEND-FACTORY
  may extend its allowlist; the ESLint rule's allowlist mirrors the
  test-guard substitute and can be updated in lockstep without merge
  conflicts).
- Coordinated via `git pull --ff-only` mid-flight; the eslint plugin
  + config + knip workflow edits landed on top of W-FRONTEND-FACTORY's
  `0bf07afb refactor(query-keys): expand factory and migrate auth,
  notifications, about` commit without conflicts.

## Quality gates

- `pnpm lint` — 0 errors, 5 pre-existing warnings (unchanged).
- `pnpm tsc --noEmit` — clean.
- `pnpm knip --reporter compact --include files,dependencies,binaries,unlisted`
  — clean (matches current CI gate).

## Hand-off to the next wave

When W-SIMPLIFIER + W-INSIGHTS-HOT close and `pnpm knip --reporter
compact` reports zero unused exports + zero unused types, flip the
`--include` filter off in `.github/workflows/knip.yml` to enforce
both tiers. Everything else here is ready to ship as-is.
