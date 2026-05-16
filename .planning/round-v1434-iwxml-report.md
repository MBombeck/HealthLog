# IW-XML — Apple Health `export.zip` import (v1.4.34)

Round close-out for the IW-XML work-item. Lands the synchronous-upload
+ asynchronous-ingest path for Apple Health `export.zip` archives
ahead of the v1.5 iOS milestone.

## Atomic commits (in order)

| SHA | Message | Layer |
|---|---|---|
| `2a3fb0e9` | `chore(deps): add sax for streaming Apple Health XML import` | deps |
| `3d309bb9` | `feat(import): add ImportJob model for Apple Health export ingest` | schema + migration |
| `3e2d2c46` | `feat(import): streaming Apple Health export.xml parser + mapper` | parser core |
| `9c227894` | `feat(jobs): apple-health-import worker queue` | worker / queue |
| `73cd44e0` | `feat(import): Apple Health export.zip endpoints + multipart streamer` | endpoints |
| `c6528b93` | `test(import): cover Apple Health export.zip parser + endpoints` | tests |
| `cc3aae97` | `docs(changelog): note the Apple Health export.zip import for v1.4.34` | changelog |

All seven commits Marc-Voice English, no Co-Authored-By trailers, no
`--no-verify`. Each layer is touch-disjoint with the parallel IWs (no
overlap with `/api/analytics/`, `/src/app/page.tsx` proper, the
compliance helpers, the settings shell, or `next.config.ts`). The
existing `apple-health-mapping.ts` reused read-only.

## File set delivered

New:

- `prisma/schema.prisma` — `ImportJob` model (additive)
- `prisma/migrations/0066_v1434_import_jobs/migration.sql`
- `src/lib/measurements/import-apple-health-export.ts` — SAX parse loop
- `src/lib/measurements/hk-workout-activity-type-map.ts` — HK → sport
- `src/lib/import/unzip-export-xml.ts` — ZIP central-directory walker
- `src/lib/multipart/stream-to-disk.ts` — streaming multipart parser
- `src/lib/jobs/apple-health-import-worker.ts` — pg-boss handler
- `src/app/api/import/apple-health-export/route.ts` — user kick-off
- `src/app/api/import/apple-health-export/[jobId]/status/route.ts`
- `src/app/api/admin/import-apple-health-export/route.ts` — admin variant
- Seven test files (parser end-to-end, HK map exhaustiveness, ZIP
  central-directory walker, multipart streamer, three route tests)

Modified:

- `package.json` — `sax ^1.6.0` + `@types/sax ^1.2.7`
- `pnpm-lock.yaml`
- `src/lib/jobs/reminder-worker.ts` — register the new queue, wire
  the worker binding, reconcile orphan import jobs on startup
- `CHANGELOG.md` — new `## [1.4.34] — unreleased` section with the
  single Added line

## Quality gates

| Gate | Result |
|---|---|
| typecheck | clean for every file IW-XML touched (`pnpm typecheck` reports only IW-D's settings drift, untouched by this IW) |
| lint | clean for every IW-XML file (`pnpm lint <new files>`) |
| Unit tests | 36 tests across 7 new files, all passing |
| Adjacent suites | `src/lib/measurements` + `src/lib/jobs` → 152 tests, all passing — no regressions |
| Push | rebase-clean, pushed `cc3aae97` to `origin/develop` |

The full `pnpm test` run reports 8 failures — every failure traces
to IW-D's settings shell rename (`Persönliche Zielwerte` →
`Zielwerte & Quellen`). None touch IW-XML's code surface.

## Parser perf numbers

| Metric | Value |
|---|---|
| Synthetic export size | 10 000 `<Record type="HKQuantityTypeIdentifierStepCount">` rows, ~2.5 MB UTF-8 |
| Parse + UPSERT duration | 312 ms wall-clock (`vitest run` on the dev workstation) |
| Heap-delta ceiling | <100 MB observed across the run |
| Re-import idempotency | 0 inserts + N updates on second pass |

The synthetic 10 000-record case stresses the cumulative-fold path
(every row collapses into one `stats:HKQuantityTypeIdentifierStepCount:YYYY-MM-DD`
daily bucket) end-to-end. A full 1 GB synthetic was deliberately
deferred — the in-process heap-delta assertion already exercises
the streaming property under test (per-token SAX, bounded buffers),
and the integration-tier 1 GB fixture would require a `testcontainers`
Postgres + several minutes per run. Adding it post-merge to the
nightly perf suite is tracked under v1.4.35 backlog.

## Carry-overs (deliberate v1.4.34 defers)

- **HKClinicalRecord / FHIR ingest** — `<ClinicalRecord>` elements
  are read + counted under `stats.clinical.skipped` but not
  persisted. R-1 §13 defers to v1.6+ behind a stricter user-opt-in.
- **HKElectrocardiogram waveforms** — `electrocardiograms/ecg_*.csv`
  archive members ignored. No HealthLog ECG model exists yet.
- **Workout routes (`workout-routes/*.gpx`)** — the ZIP extractor
  surfaces these under `otherMembers` but the parser does not
  resolve `<WorkoutRoute>` GPX-link references in v1.4.34. The
  schema's `WorkoutRoute.geometry` column stays untouched. R-1 §6.3
  describes the GeoJSON-LineString shape for the post-v1.4.34
  follow-up.
- **`<ActivitySummary>`** — Apple's daily ring rollup ignored;
  HealthLog computes its own daily aggregates from `<Record>` rows
  via the existing `dailyStatsExternalId` path.
- **`<Me>` characteristics** — DOB / biological sex / etc. ignored;
  HealthLog has its own profile fields and overwriting them
  mid-import would surprise the user.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/import/apple-health-export` | `requireAuth()` (cookie or Bearer) | Kick off a user-driven import; returns `202 { jobId }` |
| `GET` | `/api/import/apple-health-export/{jobId}/status` | `requireAuth()` (owner or triggering admin) | Live progress + terminal result envelope |
| `POST` | `/api/admin/import-apple-health-export` | `requireAdmin()` (cookie-only) | Admin imports on behalf of a target user; cookie session never elevates via Bearer |

Multipart contract for both POST routes: `multipart/form-data` with a
`file` field carrying the `export.zip`. The admin variant additionally
requires a `userId` text field naming the target user. The 1.5 GB
`Content-Length` ceiling is enforced both pre-flight (header check)
and inline (streaming sink throws on cap-exceeded).

## Idempotency

* **HTTP-level** — content-hash idempotency: the kick-off computes a
  SHA-256 of the uploaded bytes inline. A re-upload of the same
  file returns the previous `ImportJob` id without re-queueing.
* **Row-level** — every `Measurement` row UPSERTs against
  `(userId, type, source, externalId)`. Cumulative HK rows use the
  v1.4.30 `stats:<HKType>:<YYYY-MM-DD>` external id so re-imports
  collide on the same key.
* **Worker restart** — `reconcileOrphanImportJobs()` flips any row
  stuck in `unpacking | parsing | upserting` to `failed` with
  `interrupted_by_restart` on worker boot.

## Operational notes

- `/tmp` disk usage: the worker writes the upload (up to 1.5 GB) +
  the unzipped `export.xml` (up to ~4 GB) under `/tmp`. Coolify
  ops doc recommends `/tmp` ≥ 8 GB on self-hosters running the
  import (already true for the Marc-hosted prod instance).
- pg-boss queue: `apple-health-import` registered at
  `localConcurrency: 1` per worker host. Concurrent imports would
  race for RSS — `pg-boss` queues subsequent jobs until the first
  drains.
- No new process, no new container, no new env vars. The
  `HEALTHLOG_PROCESS_TYPE=worker` (or `=all`) container already
  carries the new queue handler automatically.

## Forbidden vocab + PII grep

* No "Claude", "AI", "agent", "marathon", "phase", "wave", "subagent"
  in any user-facing artifact (commit messages, CHANGELOG, doc strings
  in route handlers).
* No personal-data leaks — no Marc's name, health figures, or
  measurement counts in the CHANGELOG entry or commit messages.
