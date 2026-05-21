# W14-WITHINGS-EXTENSION — v1.4.43 phase report

## Scope shipped (B4 + B7 closed inside v1.4.43)

The W7 closure report deferred B4 (parking after 24h of persistent
failures) and B7 (per-FailureKind consecutive counters) to v1.4.44 on
scope-budget grounds. This wave (W14) lands them inside v1.4.43.

### B4 — `parkIntegrationAtPersistent` after > 24h of persistent failures

The status writer now flips `IntegrationStatus.state` to a new
`"parked"` sentinel when:

1. the current failure's kind is `"persistent"` (a Withings 293 / 294
   contract-mismatch or HTTP 4xx outside 429), AND
2. the persistent-failure streak has been running for longer than
   `PARK_PERSISTENT_FAILURE_AFTER_MS` (24h).

A parked integration short-circuits the sync entry-point via the
existing `isReauthRequired(userId, integration)` probe (extended to
return `true` for `"parked"` in addition to `"error_reauth"`). The
sync entry-point therefore needs no change — the same skip path the
W7 typed-classification reauth flow uses now also covers park.

The Settings → Integrations card renders a fifth pill state
(`data-state="parked"`) with copy "Pausiert — manuell wieder
verbinden" (DE) / "Paused — reconnect manually" (EN). A reconnect
banner under the pill carries a "Wieder verbinden" / "Reconnect"
button (44 × 44 tap target on mobile per W11 guidance) that POSTs to
the new endpoint:

```
POST /api/integrations/withings/resume
→ { resumed: true, wasParked: boolean }
```

The endpoint is rate-limited 5/min per user (same envelope as
`/api/integrations/withings/test`) and writes an
`integrations.resumed` audit row only when the row was actually
parked (idempotent for non-parked inputs). On success the per-card
status invalidates so the pill flips back to `connected` without a
page refresh.

### B7 — per-FailureKind consecutive counters

Replaced the single-column `consecutiveFailures` integer with a JSON
column `consecutiveFailuresByKind: Record<FailureKind, number>`
keyed by `"transient" | "reauth_required" | "persistent"`. Each
failure increments only its own bucket; a success resets all
buckets. The persistent streak is now anchored by a separate
`persistentFailureStartedAt` timestamp so the B4 24h park check has a
wall-clock reference (`updated_at` would conflate streak age with
any other column touch).

The legacy single-column counter stays in place for one release —
the alert-ladder reads `Math.max(consecutiveFailures, buckets.*)` so
existing v1.4.43 readers keep working. v1.4.44 will drop it once
every reader has migrated.

**Back-fill semantics**: a row with `consecutiveFailuresByKind = null`
predates the W14 migration. The status writer back-fills it on the
next failure by bucketing the legacy `consecutiveFailures` integer
into the kind matching the CURRENT failure (so a row sitting at
`error_reauth` with 4 failures back-fills into `reauth_required: 4`).
Subsequent failures of a different kind increment their own bucket
without losing the legacy count.

## Migration shape

`prisma/migrations/0075_v1443_integration_park/migration.sql`

```sql
ALTER TABLE "integration_statuses"
    ADD COLUMN IF NOT EXISTS "consecutive_failures_by_kind" JSONB;

ALTER TABLE "integration_statuses"
    ADD COLUMN IF NOT EXISTS "persistent_failure_started_at" TIMESTAMP(3);
```

Additive only. Idempotent (`IF NOT EXISTS` guards mirror 0067 / 0070 /
0071). The `state` column stays free-form (per the 0029 migration
comment); adding `"parked"` is therefore a no-op at the SQL layer —
the application owns the enum widening in
`src/lib/integrations/status.ts:IntegrationState`.

Reversibility: down migration is `ALTER TABLE … DROP COLUMN IF EXISTS`
on both new columns + a single `UPDATE … SET state='error_transient'
WHERE state='parked'`. Both new columns are nullable so existing
rows keep working through the migration boundary.

## Test additions

### Unit — `src/lib/integrations/__tests__/status.test.ts`

Pre-existing 18 tests adjusted for the new fields (success / disconnect
/ reconnect now also clear the per-kind buckets + persistent-streak
anchor). 9 new tests:

- per-kind bucket increment isolation (`transient` failure does NOT
  reset `persistent` bucket and vice versa).
- `persistentFailureStartedAt` stamping on first persistent failure of
  a streak; preservation across subsequent persistent failures.
- 24h park flip: state flips to `"parked"` and an
  `integrations.parked` audit row is written.
- Back-fill from legacy single-counter row.
- `resumeIntegrationFromPark` happy path + idempotency (no audit row
  when not parked).
- `isReauthRequired` returns `true` for both `"error_reauth"` and
  `"parked"`.

Unit total: 18 → 27 tests (+9).

### Component — `src/components/settings/__tests__/integration-status-pill.test.tsx`

6 pre-existing tests + 2 new for the parked state (EN + DE copy
parity). Pill total: 6 → 8 tests (+2).

### Component — `src/components/settings/__tests__/integrations-section.test.tsx`

5 pre-existing tests + 1 new for the integrations-section parked
state: pill flips to `data-state="parked"`, the resume banner and
button render, and the `lastError` is surfaced under the pill.
Section total: 5 → 6 tests (+1).

### API route — `src/app/api/integrations/withings/resume/__tests__/route.test.ts`

3 new tests:
- happy path returns `wasParked: true`.
- idempotent: connected row returns `wasParked: false`.
- rate-limit: 429 + `rate_limited_self` error code.

### Integration — `tests/integration/integration-status.test.ts`

8 pre-existing tests + 2 new for the W14 contract against real
Postgres:
- end-to-end resume flow (insert a parked row → call
  `resumeIntegrationFromPark` → assert state = connected, all
  buckets at 0, anchor cleared, `isReauthRequired` returns false).
- per-kind bucket isolation against the real driver (a transient
  hiccup does not reset the persistent bucket after a persistent
  failure stamps it).

Integration total: 8 → 10 tests (+2).

## Files touched

- `prisma/schema.prisma` — IntegrationStatus model gains
  `consecutiveFailuresByKind` Json + `persistentFailureStartedAt`
  DateTime + `parked` in the state-comment enum.
- `prisma/migrations/0075_v1443_integration_park/migration.sql` — new.
- `src/lib/integrations/status.ts` — `FailureKind` lifted above
  state-enum, `IntegrationState` widened with `"parked"`, new helpers
  (`isFailureBucketObject`, `readBucketColumn`, `zeroBuckets`,
  `backfillBuckets`), per-kind bucket logic in `recordSyncFailure`,
  new `resumeIntegrationFromPark` export, `isReauthRequired` extended
  to cover `"parked"`, all writers consistently reset / preserve the
  new columns.
- `src/lib/integrations/__tests__/status.test.ts` — pre-existing tests
  updated + 9 new W14 tests.
- `src/app/api/integrations/withings/resume/route.ts` — new endpoint.
- `src/app/api/integrations/withings/resume/__tests__/route.test.ts` —
  new test file.
- `src/components/settings/integration-status-pill.tsx` — pill gains
  `"parked"` state with PauseCircle icon + dracula-orange tokens.
- `src/components/settings/integrations-section.tsx` — `IntegrationState`
  widened, `pillStateFor` maps `"parked"` to the new pill state,
  WithingsCard renders the resume banner + mutation hook + success /
  error inline lines.
- `src/components/settings/__tests__/integration-status-pill.test.tsx`
  — 2 new parked tests.
- `src/components/settings/__tests__/integrations-section.test.tsx` —
  1 new parked-section test.
- `tests/integration/integration-status.test.ts` — 2 new W14 tests.
- `messages/{de,en,es,fr,it,pl}.json` — `integrationPill.parkedReconnect`,
  `integrationPill.resumeCta`, `integrationPill.resumeSuccess`,
  `integrationPill.resumeError` added (locale parity).

## Commit SHAs

In chronological order:

1. **`88941bc9` — feat(integrations): add parked state + per-kind
   failure counters schema** — schema migration + Prisma model
   change. Files: `prisma/schema.prisma`, new migration directory.

2. **`f80007de` — feat(integrations): park persistent failures after
   24h + per-kind counters** — status writer logic. Files:
   `src/lib/integrations/status.ts`,
   `src/lib/integrations/__tests__/status.test.ts`.

3. **`c2d7a2d9` — feat(withings): surface parked state + manual
   resume CTA** — pill + API surface + i18n parity + integration
   test. Files: all 6 locale JSONs, both pill files, both
   integrations-section files, tests/integration/integration-status,
   new resume route + tests.

## Quality bar

- `pnpm typecheck` — clean.
- `pnpm lint` (`npx eslint` on touched files) — clean.
- `pnpm test` — 4842 passed | 1 skipped (Δ +27 vs v1.4.42's 4815).
- Integration suite — 10/10 green; migration 0075 applies cleanly.

## Out-of-scope confirmations

- Mobile-UI sweeps (W11) — not touched.
- Settings advanced-section delete cascade (W12) — not touched.
- Auth / security endpoints (W13) — not touched.
- `/api/integrations/**` Zod helper coordinates (W6-ZOD) — the new
  `/resume` endpoint doesn't take a request body (POST with no
  payload), so the `returnAllZodIssues` helper has nothing to bind
  to; the route stays on the existing `apiHandler` + `apiSuccess` /
  `apiError` envelope.

## Branch

`w14-withings-extension` — pushed to origin in the final step below.
