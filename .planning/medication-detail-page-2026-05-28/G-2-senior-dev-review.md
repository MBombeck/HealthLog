# G-2 — Senior-dev pre-release review, v1.5.6

Scope: `git diff d54addd6..release/v1.5.6`. Three workstreams: (1) medication
detail-page rewrite + `advanced-settings-sheet` + two-option edit dropdown +
IntakeEdit seed fix; (2) `step-consolidation` pg-boss job + migration 0087;
(3) security hardening (safeFetch migrations, requirePublicHost, avatar
bounded stream, `healthlog/safe-fetch-required` rule, OpenAPI add). All gates
green (typecheck, lint, openapi:check, 5637 unit). Findings are what tests
don't catch.

## Block release on
- Nothing. No Critical or High found. The three workstreams are correct,
  robust, and on-convention. Items below are Medium/Low — ship-then-patch.

## Ship-then-patch
- M-1 (migration 0087 lock window on huge `measurements`)
- M-2 (second-unique-index P2002 abort risk in consolidation tx)
- L-1 (safe-fetch rule blind to aliased/variable fetch callees)
- L-2 (avatar bounded-drain clones whole body even under the CL pre-flight)
- L-3 (consolidation `findFirst` existing-total is source-agnostic — benign now, fragile later)

---

## Critical
None.

## High
None.

## Medium

### M-1 — Migration 0087 takes ACCESS EXCLUSIVE on `measurements` for the full index build
`prisma/migrations/0087_v156_step_consolidation/migration.sql:21-24`

A plain (non-`CONCURRENTLY`) `CREATE INDEX IF NOT EXISTS` runs inside Prisma's
migration transaction and holds an ACCESS EXCLUSIVE lock on `measurements` for
the entire build. The migration's own header notes the predicate matches
"hundreds-of-thousands of rows" on a multi-year HealthKit account — exactly the
table this index is built against. On those tenants the deploy migration blocks
every read/write to `measurements` (dashboard, batch ingest, Withings sync)
until the build completes. This is the standard Prisma migration trade-off and
acceptable for most self-hosts, but the largest tenants are the ones who both
need this index and will feel the lock.

Fix: either accept and document the lock in `docs/ops/migrations.md` (note the
index is small because of the `deleted_at IS NULL` partial predicate and most
tenants have no legacy step rows at all), or split into a `CONCURRENTLY` build
applied out-of-transaction via a follow-up ops step. Given the partial
predicate keeps the index tiny on tenants without legacy data, documenting is
the pragmatic call — but it should be a conscious decision, not silent.

### M-2 — Consolidation upsert can throw P2002 on the second unique index and abort the soft-delete
`src/lib/measurements/consolidate-legacy-steps.ts:253-276`

The minted daily-total row is `{ source: "MANUAL", measuredAt: canonical noon,
sleepStage: null }`. `Measurement` carries a second unique index
`@@unique([userId, type, measuredAt, source, sleepStage])`
(`prisma/schema.prisma:607`). The upsert keys on
`userId_type_source_externalId`, so a pre-existing MANUAL `ACTIVITY_STEPS` row
at exactly the canonical-noon instant with null `externalId` would NOT match
the upsert `where` (different externalId), the `create` branch would fire, and
it would violate the `measuredAt+source+sleepStage` index — raising P2002
inside `$transaction`, which also rolls back the legacy soft-delete for that
day. The day then re-appears on every boot discovery (legacy rows still live),
so the pass never converges for that user and re-throws every reboot.

Likelihood is low (requires a manual steps entry landing at the exact UTC
instant of local-noon for that day), but it is a non-converging poison-pill,
not a transient. Fix: wrap the per-day transaction body in a try/catch that, on
P2002, logs + annotates and continues to the next day (skip, don't abort the
whole user); or soft-delete legacy rows in their own statement outside the
upsert's failure path so a mint collision can't strand the tombstone.

## Low

### L-1 — `safe-fetch-required` rule is blind to aliased / variable-callee fetch
`eslint-plugins/healthlog/safe-fetch-required.js:91-107`

`isFetchCallee` matches only `Identifier "fetch"` and member forms on
`globalThis`/`window`/`self`. A `const f = fetch; f(url)`, a destructured
`const { fetch: g } = globalThis`, or `nodeFetch(url)` import-alias all slip
through. This is within the rule's stated syntactic scope and the real call
sites in this diff are clean, so it is a defence-in-depth gap, not a present
bug. Worth a comment in the rule documenting the known evasions so a future
reviewer doesn't assume total coverage.

### L-2 — Avatar bounded-drain clones the full body even after the Content-Length pre-flight passes
`src/app/api/user/avatar/route.ts:125-152`

When a `Content-Length` header is present and under the cap, the code still
clones the body and drives a second full read through `readBoundedBody` in
parallel with `formData()`. For the common well-behaved upload this doubles the
read work (tee buffering of up to 2 MiB). The bounded drain is only load-bearing
for the chunked / header-absent case. The `pipeTo` + `Promise.all` shape does
abort correctly past the cap (the thrown `BodyTooLargeError` rejects the pipe,
cancels the source, and `Promise.all` short-circuits — no undici tee deadlock,
verified against the parallel-drain reasoning in the inline comment). So this is
purely a minor efficiency note: gate the clone+drain on
`!request.headers.has("content-length")` to skip the redundant read when the
pre-flight already bounded the request.

### L-3 — Consolidation existing-total probe is source-agnostic
`src/lib/measurements/consolidate-legacy-steps.ts:217-225`

`existingTotal` matches on `{ userId, type, externalId, deletedAt: null }`
without `source`. This is correct today and intentionally so — it catches an
iOS-written `APPLE_HEALTH` daily total under the same `externalId` and prevents
double-counting (the upsert's own `where` pins `source: "MANUAL"`, so without
the source-agnostic probe a parallel-source total would be missed and a second
MANUAL total minted). The risk is only latent: if a future change makes the
probe and the upsert key diverge further, the `hadExistingTotal` guard and the
upsert target could disagree. Add a one-line comment at the `findFirst` pinning
*why* source is deliberately omitted, so the asymmetry with the upsert `where`
reads as intentional rather than a bug.

---

## Verified-correct (notable, since the prompt asked)
- Queue registration: `STEP_CONSOLIDATION_QUEUE` is in `allQueues`
  (`reminder-worker.ts:1885`), has a `boss.work` handler
  (`:2196-2210`, serial concurrency), and boot discovery is wired
  (`:2369`, best-effort try/catch, never fails boot).
- Idempotency / no double-count: legacy scan excludes `deletedAt IS NOT NULL`
  and the `stats:` prefix; `hadExistingTotal` skips the mint and `dailyRowsUpserted`
  increment while still tombstoning legacy rows; integration test
  `tests/integration/consolidate-legacy-steps.test.ts:102-147` pins the
  no-double-count path (`daysFoldedIntoExisting === 1`). Discovery `$queryRaw`
  is tagged-template, constant literal prefix, no splice.
- Soft-delete is in the same `$transaction` as the mint
  (`consolidate-legacy-steps.ts:244-289`); tombstone via `updateMany` guarded
  on `deletedAt: null`.
- TZ day-keying reuses the locked `dayKeyForUserTz` (sv-SE) +
  `canonicalDailyTimestamp` (local-noon) helpers — byte-identical to the iOS /
  mood-entry round-trip convention.
- No mass assignment: the upsert builds `create`/`update` field-by-field. The
  GET `/api/medications/[id]` does spread `{ ...medication, category }`, but
  that is a READ response serialization, not a Prisma write — convention is
  about write `data` objects, so this is fine.
- Detail-page rewrite: every import is used (no dead imports); the GET returns
  full Prisma `schedules` so `reminderGraceMinutes` / `rrule` /
  `rollingIntervalDays` / `timesOfDay` consumed by `snapshotToWizardPayload`
  and `primaryGrace` are all real columns and present in the payload — no
  phantom fields. Sibling-swap (advanced sheet → phase sheet) closes the parent
  before opening the child (`page.tsx:241-244`); `settings-section` correctly
  defers to `onRequestPhaseSheet` and suppresses its own `<PhaseConfigSheet>`
  when the prop is present (`settings-section.tsx:213`).
- IntakeEdit seed bug fix is complete: `onEditIntake` now threads the whole
  `IntakeEvent`; `intake-history-preview` seeds the dialog from real
  `takenAt`/`skipped` instead of the empty stub. `IntakeEvent` exported cleanly.
- safeFetch migrations: operator-supplied Umami host (send route, umami-script,
  umami-test) correctly carries `requirePublicHost: true`; Withings
  constant-host calls use plain `safeFetch` (no user input → pin not needed).
  No phantom branches.
