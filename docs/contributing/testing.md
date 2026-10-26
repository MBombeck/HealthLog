# Testing

How the suites are organised, which one a new test belongs in, and the tools
that keep them fast and honest. Commands are in `CONTRIBUTING.md`; this page
is about choosing and writing tests.

## Which suite

| What you are testing                                                                                                                    | Where                                       | Runs with               |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------- |
| Pure logic: statistics, time zones, cadence, parsers, unit conversion, formatting                                                       | `src/**/__tests__/*.test.ts` (unit)         | `pnpm test`             |
| Laws of that logic over random inputs                                                                                                   | `*.property.test.ts` next to the unit tests | `pnpm test`             |
| What a component renders for a given state                                                                                              | `src/**/__tests__/*.test.tsx` (unit)        | `pnpm test`             |
| How a component behaves when someone types, clicks or presses keys, and what it sends                                                   | `src/**/__tests__/*.browser.test.tsx`       | `pnpm test`             |
| A structural rule about the tree (a guard)                                                                                              | `src/__tests__/` with a stated floor        | `pnpm test`             |
| A route: auth, scope, validation, what it stores and what it answers                                                                    | `tests/integration/routes/` with the kit    | `pnpm test:integration` |
| Anything whose truth lives in Postgres: constraints, `where` semantics, transactions, locks, cascades, time zones in SQL, backups, jobs | `tests/integration/`                        | `pnpm test:integration` |
| A journey through the real UI                                                                                                           | `e2e/`                                      | `pnpm e2e`              |

The rule behind the table: put a behavioural test at the level where the
risky collaborator is real. For a route that collaborator is Postgres and the
API kit (`apiHandler`, `requireAuth`, the envelope), so a route test runs
against both. A unit test that replaces Prisma with a mock and then asserts on
the calls it received checks the query text, not the behaviour; it passes when
the query is wrong and fails when it is rewritten correctly. Do not write new
ones: `src/__tests__/test-realism-ratchet.test.ts` counts route tests that mock
`@/lib/db` wholesale or stub `apiHandler`, and `as never` casts in tests, and
those numbers may only fall. Mock at the process boundary you do not own instead: provider HTTP
(`safeFetch`), APNs, SMTP, the model.

## Critical journeys

A few e2e journeys carry `@critical` in their test titles: signing in with a
password and a passkey and signing out, a reading reaching the dashboard, a
dose moving compliance, a mood entry, a lab CSV import, a questionnaire in
German and Brazilian Portuguese, a setting that persists, a backup coming
back, sharing a record, and the offline page. `pnpm e2e:critical` runs them.

They run against the real server and a seeded Postgres. A spec file that
carries the tag may not intercept anything under `/api`, directly or through
a helper it imports; `src/__tests__/e2e-critical-no-api-stub-guard.test.ts`
refuses it and keeps a floor on the number of tagged tests. Stubbing an
unreachable third-party host that is not the journey's subject is allowed,
with the reason next to the call.

A journey that writes gets an account nobody else writes. The accounts in
`e2e/setup/critical-fixture.ts` are seeded by global setup, one per journey
and per Chromium project, so a journey runs at both widths without the two
projects meeting. Reset what a previous run left with `resetCriticalAccount`
in a `beforeEach`, and read results through the app's own routes rather than
through the database.

## The route test kit

`tests/kit/` holds two modules for tests under `tests/integration/`.

`factories.ts` writes typed fixtures through the application's Prisma client
and returns the stored rows: `makeUser`, `makeAdmin`, `makeSession`,
`makeToken`, `makeMeasurement`, `makeMedication`, `makeWorkout`, `makeGrant`.
Overrides are the Prisma create input of that model, so the compiler checks
every fixture field; there is no reason for `as never` in a kit test.
Sessions and tokens are minted by the server's own `createSession` and
`issueApiToken`, so a fixture cannot drift into a shape authentication no
longer accepts.

`call-route.ts` exports `callRoute(handler, options)`, which builds a real
`NextRequest`, fills the `next/headers` stand-in from `auth`, calls the
exported handler of a `route.ts` (and with it the real `apiHandler`), and
returns `{ status, data, error, meta, body, headers }`.

```ts
import { GET } from "@/app/api/tokens/route";
import { DELETE } from "@/app/api/tokens/[id]/route";

import { callRoute } from "../../kit/call-route";
import { makeSession, makeToken, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

beforeEach(() => truncateAllTables(getPrismaClient()));

it("revokes the caller's token and the token stops authenticating", async () => {
  const owner = await makeUser();
  const phone = await makeToken(owner);

  const res = await callRoute<{ revoked: boolean }>(DELETE, {
    method: "DELETE",
    route: "/api/tokens/{id}",
    params: { id: phone.tokenId },
    auth: await makeSession(owner),
  });

  expect(res.status).toBe(200);
  const row = await getPrismaClient().apiToken.findUniqueOrThrow({
    where: { id: phone.tokenId },
  });
  expect(row.revoked).toBe(true);

  const after = await callRoute(GET, {
    method: "GET",
    route: "/api/tokens",
    auth: phone,
  });
  expect(after.status).toBe(401);
});
```

`auth` is a `SessionFixture`, a `BearerFixture`, or `anonymous`. `route` is
the path as the OpenAPI registry names it, with `{…}` segments filled from
`params`.

Every call is also a contract check. The status must be one the registry
(`src/lib/openapi/routes/`) declares for that path and method, a JSON body
must parse with the registered schema, and a key the schema does not declare
fails the call: a client generated from the contract cannot see that field, so
nobody promised to keep it. There is no generic answer the kit accepts on an
operation's behalf: the scope gate's 403 `auth.scope.insufficient` is declared
on every operation that passes the gate (`withScopeRefusal` in
`src/lib/openapi/routes/shared.ts`), so it is checked like any other status. A
test that calls an unregistered route on purpose passes
`contract: { skip: "<reason>" }`.
`tests/integration/routes/kit-contract.test.ts` proves the check can fail.

Assert what a person or a client would notice: the stored row, the response,
the next request's answer. Not the calls a mock received.

The kit runs the handler, not the edge. Security headers, the public-path
allowlist and demo mode live in `src/proxy.ts` and are tested there.

### The settings round trip

`tests/integration/settings-round-trip.test.ts` holds one table with an entry
for every `User` column the backup classifies as `SETTING`
(`USER_COLUMN_BACKUP_CLASS` in `src/lib/export/backup-plan.ts`). For each one
it sets a non-default value through the API, reads it back through the API and
through `/api/auth/me` where that publishes it, exports a backup, restores it
into a fresh account and reads it back there. A new setting column without a
table entry fails the file. A column with no write route says why in its
entry.

## Browser tests

Interaction belongs in the `browser` project: `*.browser.test.tsx` files run
in headless Chromium through Vitest's Playwright provider, as part of
`pnpm test`. Run them alone with `pnpm test --project browser`, or one file
with `pnpm exec vitest run --project browser <path>`. The Node projects never
collect these files and this project collects nothing else. CI installs the
browser it needs (`playwright install --only-shell chromium`); locally, run
that once.

Reach for it when the claim is about behaviour a markup test cannot see:
focus, keys, an open menu, a pending state, the body a form posts, the URL a
filter writes. A `renderToStaticMarkup` grep stays the tool for what a given
state renders, and bottom-sheet gestures stay in `e2e/`.

The helper is `tests/browser/`:

- `renderWithApp(ui, { locale, user })` mounts the app's own providers: a real
  TanStack `QueryClient` (no retries) and `I18nProvider` with the real
  catalog. The signed-in account is seeded where `useAuth` reads it, with
  `authUser()` defaults under `user`. The app stylesheet and the default
  theme class are loaded, so layout, visibility and colour tokens resolve.
- `stubFetch()` replaces `fetch` and nothing above it. Answer a route with
  `.on(method, path, { status, data, error, meta })`, hold one with
  `.deferred(...)` to assert a pending state, and read the parsed bodies from
  `.calls(method, path)`. An unmatched request gets a 404 envelope and is
  recorded. Do not mock `@tanstack/react-query` or `@/lib/api/api-fetch`.
- `next/navigation` is aliased to a shim over the page's real `location` and
  `history`; `url.ts` sets the starting query, records pushes and replaces,
  and simulates Back or an edited address.
- `pinDate(iso)` fakes `Date` only, so timers and animation frames still run.

Every test gets the real `fetch`, clock, address and an empty `localStorage`
back afterwards. Locate by role and accessible name, the way a person finds a
control; a `Label` adds a colon to its name, so match a labelled combobox with
`/^Type/` rather than `"Type"`.

## The integration database

Global setup boots one Postgres container and migrates one template database.
Each Vitest worker clones it on its first file (`CREATE DATABASE … TEMPLATE`,
see `tests/integration/worker-database.ts`), so files run in parallel without
seeing each other's rows, advisory locks or queue schema. The worker count
follows the host (half the cores, at most eight) unless
`HEALTHLOG_INTEGRATION_WORKERS` pins it; CI uses three. To reproduce a CI runner's
contention on a larger machine, cap the database container with
`HEALTHLOG_INTEGRATION_PG_CPUS=2`.

`truncateAllTables` empties every table the migrations created and puts back
the rows they seed (the mood-tag and symptom catalogues), so a test starts
from what a fresh install holds. The list is the catalogue, read from the
template, not something to maintain. `START_EMPTY_TABLES` names the one
seeded table a test starts without, and why. Schemas created at runtime
(pg-boss) are dropped when the next file starts in the worker.

`next/headers` and the boot compatibility probe are mocked for every file in
`environment-setup.ts`. A file needs its own `vi.mock("next/headers")` only
when it wants different behaviour.

## Speed and sharding

CI splits both suites by measured duration, not by file count: the sequencer
in `tests/durations/sequencer.ts` reads `tests/durations/unit.json` and
`tests/durations/integration.json` and deals files out longest first to the
shard with the least work. A file without a measurement counts as the median.
Regenerate a timing file from Vitest JSON reports when the shards drift apart:

```sh
pnpm exec vitest run --reporter=default --reporter=json --outputFile.json=unit.json
node scripts/test-durations.mjs unit unit.json
```

The nightly workflow (`.github/workflows/test-nightly.yml`) uploads a file
regenerated from CI timings, which is the better source.

The unit suite is three Node projects and the `browser` project above. The
Node ones are decided per file from its source
(`tests/unit-projects.ts`): `guards` and `unit` share a module graph within a
worker, `isolated` gives each file a fresh one. A file lands in `isolated` when
it mocks, spies, stubs env or globals, fakes timers or resets modules. If a
file needs isolation for a reason the classifier cannot see, put a
`// vitest-isolate` comment in it.

## Property tests

`fast-check` properties live in `*.property.test.ts` files and take their
parameters from `tests/property/fast-check.ts`. Pull requests run every
property with a fixed seed, so a run is reproducible on any machine. The
nightly run uses a fresh `FC_SEED` and multiplies every property's own case
count by `FC_RUNS_FACTOR`; a failure prints the seed and the shrunk
counterexample, and `FC_SEED=<seed> pnpm test <file>` replays it. A property
whose cases are expensive states a small count and passes
`propertyTimeout(baseMs)` as its test timeout, which grows by the same factor.

Write a property when the code has a law: an inverse (encrypt and decrypt, a
unit and its inverse, a wall clock and its instant), an invariant (a rate
between 0 and 100, a day that contains its own instants), or an oracle small
enough to be obviously right (a day-by-day walk of a weekly schedule). Do not
reimplement the function under test in the property.

## Mutation testing

Stryker runs on the core libraries (`stryker.config.mjs`) nightly and on
demand (`.github/workflows/mutation.yml`), not on pull requests. Each module's
score is checked against a floor in `stryker.floors.json` by
`node scripts/mutation-floors.mjs`. A floor sits just below the last measured
score; raise it when a change raises the score, never lower it to make a run
pass. The Vitest runner is patched for Vitest 5's test names
(`patches/@stryker-mutator__vitest-runner@10.0.0.patch`); without it every
test inside a `describe` block is filtered out of the mutant runs and almost
every mutant survives. Locally:

```sh
pnpm exec stryker run
node scripts/mutation-floors.mjs
```

## Flaky tests

Vitest runs without retries, and stays that way: a retry that turns red into
green hides the flake it was meant to report. e2e keeps two retries with
`failOnFlakyTests`, so a test that needed one still fails the run.

A flaky unit or integration test may be taken out of the run only through
`tests/quarantine/quarantine.json`:

```json
{
  "file": "tests/integration/example.test.ts",
  "test": "outer describe > the test name",
  "issue": "#1234",
  "reason": "fails about one run in twenty when the queue worker is slow",
  "added": "2026-10-22",
  "expires": "2026-11-05"
}
```

The test is reported as skipped with its issue while the entry is live. An
entry expires at most 14 days after it was added; after its expiry date the
test runs again, and `tests/quarantine/quarantine-guard.test.ts` fails until
the entry is removed. The guard also fails on an entry that names a file or a
test that does not exist. Fix the flake, or delete the test if it no longer
earns its place; do not extend the date.

Order dependence is looked for on purpose: the nightly workflow runs both
suites with `--sequence.shuffle` and prints the seed. Replay a failure with
`--sequence.shuffle --sequence.seed=<seed>`.
