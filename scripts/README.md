# `scripts/`

One-shot operator and build scripts. These are not part of the running application — they are run by hand during a deploy, a backfill, or a release, or wired into CI. Recurring work belongs on pg-boss (`src/lib/jobs/`), not here.

## How to run them

From a source checkout:

```bash
pnpm dlx tsx scripts/<file>.ts
```

The production image intentionally removes npm, pnpm, and Corepack. Only
container-safe scripts named by an operator runbook use its pinned
`healthlog-tsx` launcher; scripts that import the full application dependency
graph must run from a source checkout. `scripts/` is excluded from the project
typecheck.

## What lives here

- **`generate-openapi.ts`** — emits `docs/api/openapi.yaml` from the registered Zod schemas (`pnpm openapi:generate`).
- **`check-openapi.ts`** — compares a freshly generated spec against the committed YAML; CI fails on drift (`pnpm openapi:check`).
- **`check-env.ts`** — pre-deploy env-var sanity check against `env-manifest.json` (`pnpm check-env`); wired into CI.
- **`assert-deploy.ts`** — post-deploy `/api/version` assertion.
- **`rotate-encryption-key.ts`** — AES-256-GCM key rotation; see `docs/ops/encryption-key-rotation.md`.
- **`restore-backup.ts`** — restore an off-host AES-GCM backup from an S3-compatible bucket.
- **`repair-intake-anomalies.ts`** — repair historic medication-ledger defects (duplicate dose-slot rows, implausible `taken_at`); dry-run by default, see `docs/ops/intake-repair.md`.
- **`backfill-rollups.ts`**, **`drain-per-sample-cumulative.ts`**, **`backfill-mood-note-column.ts`** — historical data backfills (note: the boot-time `rollup-full-backfill` queue handles new accounts automatically; the CLI is the manual fallback).
- **`seed-demo.ts`** + **`seed-demo-v15.sql`** — populate a demo tenant.
- **`test-notifications.ts`** — exercise the notification dispatcher + reminder check.
- **`fetch-geolite2.sh`** — download the MaxMind GeoLite2 MMDBs (needs a licence key) before `docker build`.
- **`install-hooks.sh`** — install the local git hooks.
- **`generate-sw-version.mjs`**, **`print-bundle-report.mjs`** — service-worker version stamp and bundle-size report.
- **`i18n/`** — locale tooling; **`__tests__/`** — tests for the scripts above.

## Conventions

See [`../CLAUDE.md`](../CLAUDE.md) "Tests and commands" + "Self-hosting gotchas". Operator runbooks that drive these scripts live in [`../docs/ops/`](../docs/ops/).
