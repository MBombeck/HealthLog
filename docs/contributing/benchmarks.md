# Benchmarks

Two tools measure the server's read and write paths. Use them before and after any change to a hot path, and put both numbers in the PR.

- **`scripts/bench/run.ts`** measures latency (p50, p95, max) and SQL statements per request against a seeded account of about 1.26 million measurement rows, through the production build. It is a local tool, not a CI gate: latency depends on the machine.
- **`tests/integration/query-budget-hot-routes.test.ts`** holds a statement budget per hot route on a small fixture. Statement counts are exact on a fixed fixture, so this one is a gate: a change that adds a query per row, or a second read of something already loaded, fails it.

## The large-account benchmark

### 1. A throwaway Postgres with pg_stat_statements

Never point the seed or the benchmark at a database that holds real data. They write under a synthetic user, and the seed's `--reset` deletes that user with everything it owns.

```sh
docker run -d --name hl-bench-db --shm-size=256m \
  -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=healthlog_bench \
  -p 55432:5432 postgres:18.6-alpine \
  postgres -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top
```

The image and the two settings are the ones `docker-compose.yml` runs in production.

### 2. Environment, migrations, seed

```sh
export DATABASE_URL="postgresql://bench:bench@127.0.0.1:55432/healthlog_bench?schema=public"
export ENCRYPTION_KEYS='{"v1":"<64 hex>"}' ENCRYPTION_ACTIVE_KEY_ID=v1
export API_TOKEN_HMAC_KEY="<64 hex>"

pnpm db:migrate:deploy
pnpm dlx tsx scripts/bench/seed-large-account.ts --reset --anchor 2026-10-22
```

Any throwaway key values work, as long as the seed, the benchmark and the server see the same ones.

The seed writes ten years for one user: Apple Health dense rows (heart rate about every ten minutes, HRV, SpO2, respiratory rate, gait, audio), Withings blood pressure, pulse and scale, a weekly manual weight, three years of Oura resting heart rate and RMSSD, 90 days of Nightscout CGM, `stats:` and per-sample cumulative rows, nightly sleep stages, about 3,000 workouts, three years of mood and of three medications with their intake events. It then folds the rollup tier the way the boot backfill does and runs `ANALYZE`. It takes about 80 seconds on the Mac mini.

The seed is deterministic for a given `--anchor`: values and timestamps are functions of the row index and that day. Without `--anchor` it anchors on today, which is what you want when the benchmark should see recent data.

### 3. A production build

```sh
pnpm build
```

### 4. Run

```sh
pnpm dlx tsx scripts/bench/run.ts --out scripts/bench/results/<label>
```

The script boots the build once with every role, so the worker creates its queues as it does in production, drops whatever that boot scheduled, and then runs the measurement against a web-only process (`HEALTHLOG_PROCESS_TYPE=web`) under the production heap ceiling (`--max-old-space-size=792`, the value Node derives in the 1.5 GB production container). Without the worker, its polling does not land in every statement count. It prints the server's idle statement rate so the remaining background is visible.

For each route it sends three warm-up requests, then twenty measured ones in each of two modes, one request at a time:

- **cold**: before every request a one-row ingest marked as a manual sync evicts the user's caches, so the request rebuilds what it serves. This is a reader's first look after a sync.
- **warm**: back to back, what a cache hit costs.

The batch ingest posts 5,000 fresh heart-rate rows as ten requests of 500, the route's per-request limit, and removes them again at the end.

Statements are the change in `sum(calls)` of `pg_stat_statements` over the database, read before and after each request, once no statement is in flight and the counter holds still. Fire-and-forget writes a request starts are therefore counted with it.

Options: `--iterations`, `--warmup`, `--user`, `--heap-mb`, `--port`, and `--base-url` to measure a server you started yourself.

The output is `<label>.json` (every number, plus the commit, Node and Postgres versions and the row count) and `<label>.md` (the table). Commit the pair when a change is meant to move a number, so the PR shows before and after.

### Reading the numbers

Run on a quiet machine; a parallel build or test run moves latency by tens of percent and leaves the statement counts alone. Compare statement counts across machines, latency only across runs on the same machine. A local number is only valid under the production heap ceiling, which the script sets.

## Boot and idle-memory profile

`scripts/bench/boot-profile.ts` profiles a production start the way production runs it: `next start` on the build, every role (web and worker), the production heap ceiling (`--max-old-space-size=792`, the heap Node derives in the 1.5 GB container), against the seeded benchmark database.

```sh
pnpm dlx tsx scripts/bench/boot-profile.ts --idle-seconds 300 --out scripts/bench/results/<label>-boot
```

It records:

- the time to the first answer from `/api/health` and to the worker's `startup` line;
- every `event_loop_stall` the process logs, with the uptime, startup phase, boot step and work in flight it names;
- every `runtime.heap.sampled` line, and every full collection from `--trace-gc` (used heap before, live heap after);
- a CPU profile of the start: the main thread's busy stretches over 50 ms without an idle sample, each with its self time per source module, resolved through the chunk source maps (`profile-analyze.ts`);
- one heap snapshot after the idle wait, taken with `--heapsnapshot-signal` (after a full collection, so it is the live heap), summarised by node type, constructor, largest strings and the largest retained subtrees with a retaining path, and the number of parsed locale catalogs.

The worker runs for the whole idle wait, and its boot passes fold and consolidate the seeded account (old dense readings into their `stats:` rows), roughly halving its row count. Reseed before the next request benchmark, or its numbers describe a different account.

The raw `.cpuprofile` and `.heapsnapshot` go to a temporary directory and are deleted after the summary unless `--keep` is given. Only run it against the benchmark database: a snapshot holds whatever the process decrypted. `--no-snapshot` and `--no-cpu-prof` skip either part. The profiler itself costs memory, so read RSS from this run as an upper bound.

### What the profile found (v1.44 runtime, October 2026)

On the seeded account, idle, with the worker running and no requests (`results/v1.45.0-before-boot.md`):

- **The boot stall is module evaluation.** The longest busy stretch of the main thread was 753 ms, 0.7 s into the start: the instrumentation hook importing the worker, whose five registrars pulled practically all of `src/lib` into one synchronous evaluation (`register-maintenance.ts` alone 280 ms inclusive), followed by the first `/api/health` request compiling its route. The event-loop monitor started after the key and time-zone checks, and a 250 ms tick measures a block by how late the next tick fires, so it reported less than the block or nothing. The beta's 718 ms and 671 ms stalls are this block on a slower machine.
- **The live heap is about 165 MB, not 400.** Full collections brought the heap back to 162 to 172 MB every 15 to 20 s while idle; the used heap between them reached 190 MB. What a heap line shows above the live heap is garbage awaiting the next full collection, plus, on a server with users, the server caches (13 caches of up to 2,000 entries with stale windows of up to an hour). The beta's 400 MB plateau is therefore not a baseline the process cannot shed; it is what the heap grows to under a large limit before a collection, plus caches.
- **What the live heap holds.** Of 172 MB: the query compiler about 50 MB (the engine object 34 MB, its WebAssembly base64 source twice at 4.4 MB, its chunk source twice at 5.6 MB); the locale catalogs about 33 MB (32 parsed catalog objects, eight locales in each of four server bundles, 14 MB, plus the eight-locale chunk source twice at 9.7 MB); module source strings over 50 KB about 44 MB in total (the catalog chunks included); compiled code 19 MB.

### What changed (v1.45.0)

- The event-loop monitor starts first in `register()`, and a stall line names the boot step, startup phase and work in flight (`src/lib/boot/boot-steps.ts`, one `boot.steps` line per boot with each step's duration).
- The worker's registrars are imported one at a time after `boss.start()`, with a turn of the event loop between them.
- The server reads a locale catalog from `messages/<locale>.json` on first use and keeps one parsed copy per process (`src/lib/i18n/server-catalogs.ts`); the seven matchers that index every locale build their index on first use.

Result on the same machine (`results/v1.45.0-boot.md`): the worker graph loads in stretches of at most 246 ms instead of one of 753 ms (the longest application stretch left is the query compiler's start, 336 ms, unchanged); the live heap after five idle minutes went from 162 to 172 MB to 142 to 153 MB; two parsed catalogs (1.6 MB) instead of 32 (14.1 MB), and no catalog chunk sources.

## Statement budgets in the integration suite

`tests/integration/query-budget-hot-routes.test.ts` seeds a small account (four months of the main types with overlapping sources, sleep, glucose, a medication, workouts and mood), and counts the statements of one request per hot route on a cache miss: `/api/auth/me`, the dashboard summary and snapshot, the pulse series over 30, 365 and 3650 days, the day view, insights health status, correlations, and a 500-row batch ingest.

The counter (`tests/integration/query-counter.ts`) wraps `pg`'s `Client.prototype.query` on the copy of `pg` the Prisma adapter loads, and settles background tasks before it closes the window.

Each budget is the measured count. When a change lowers one, lower the budget in the same change. When a change has to raise one, raise it with the reason in the PR. A failure prints every statement the request sent, grouped by text, so an added loop shows up as one statement with a count next to it.

Run it like any integration file:

```sh
pnpm test:integration tests/integration/query-budget-hot-routes.test.ts
```
