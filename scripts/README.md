# `scripts/`

One-shot operator and build scripts. They are not part of the running application: they are run by hand during a deploy, a backfill, or a release, or wired into CI. Recurring work belongs on pg-boss (`src/lib/jobs/`), not here.

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

- **`generate-openapi.ts`**: emits `docs/api/openapi.yaml` from the registered Zod schemas (`pnpm openapi:generate`).
- **`check-openapi.ts`**: compares a freshly generated spec against the committed YAML; CI fails on drift (`pnpm openapi:check`).
- **`check-env.ts`**: pre-deploy env-var sanity check against `env-manifest.json` (`pnpm check-env`); wired into CI.
- **`assert-deploy.ts`**: post-deploy `/api/version` assertion.
- **`release-policy.mjs`**: the release calendar and patch-content rules; `pnpm release:next` prints the next release, CI runs `check` on every tag and `pr` on pull requests to `main`. See `docs/contributing/release-policy.md`.
- **`rotate-encryption-key.ts`**: AES-256-GCM key rotation; see `docs/ops/encryption-key-rotation.md`.
- **`restore-backup.ts`**: restore an off-host AES-GCM backup from an S3-compatible bucket.
- **`repair-apple-health-distance.ts`**: repair walking-distance rows the `export.zip` import stored 1000x too small; dry-run by default, see `docs/ops/apple-health-distance-repair.md`.
- **`repair-intake-anomalies.ts`**: repair historic medication-ledger defects (duplicate dose-slot rows, implausible `taken_at`); dry-run by default, see `docs/ops/intake-repair.md`.
- **`backfill-rollups.ts`**, **`drain-per-sample-cumulative.ts`**, **`backfill-mood-note-column.ts`**: historical data backfills (the boot-time `rollup-full-backfill` queue handles new accounts automatically; the CLI is the manual fallback).
- **`seed-demo.ts`** + **`seed-demo-v15.sql`**: populate a demo tenant. It deletes every account in the target database first. A demo deploy (`DEMO_MODE=true`) re-runs `seed-demo.ts` itself every day (`src/lib/jobs/demo-refresh.ts`); run it by hand only to set up a new demo database.
- **`bench/`**: `seed-large-account.ts` (a synthetic ten-year account of about 1.26 million measurement rows) and `run.ts` (latency and SQL statements per request against it); see `docs/contributing/benchmarks.md`. Results land in `bench/results/`.
- **`test-notifications.ts`**: exercise the notification dispatcher + reminder check.
- **`fetch-geolite2.sh`**: download the MaxMind GeoLite2 MMDBs (needs a licence key) before `docker build`.
- **`build-pdf-fonts.py`**: rebuild the fonts the doctor-report PDF embeds (`src/lib/doctor-report-pdf/fonts/`) from the upstream Noto sources; needs `fonttools`. The source URLs are in its header.
- **`install-hooks.sh`**: install the local git hooks.
- **`generate-sw-version.mjs`**, **`check-bundle-budget.mjs`**: service-worker version stamp and bundle-size report (`pnpm bundle-report`).
- **`repair-google-health-sleep.ts`**: re-syncs every Google Health connection so nights stored twice before v1.28.18 collapse to one set; dry-run by default, `--run` to execute.
- **`i18n-key-tool.mjs`**, **`split-description.mjs`**: edit one key across every `messages/*.json` (show, set, drop) and move an over-long card description's tail into its own key; **`measure-description-lengths.mjs`** measures the Settings and Admin description strings against the 120-character guideline.
- **`test-shifted-clock.mjs`**: runs the unit suite under moved wall clocks (the hour before local midnight, both changes of clocks, the new year) and lists what fails there but not at the real time; `node scripts/test-shifted-clock.mjs --list` prints the instants, `--at <ISO>` picks your own. The clock shim is `shifted-clock-shim.mjs`. A probe for date-handling work, not wired into CI.
- **`audit-column-readers.ts`**: lists write-only schema columns and open `@pending-consumer` markers; a review tool, not a gate.
- **`migrate-demo-account.sh`**: copies the demo account from one instance to a separate demo instance; see its README.
- **`__tests__/`**: tests for the scripts above.

## Conventions

Operator runbooks that drive these scripts live in [`../docs/ops/`](../docs/ops/).
