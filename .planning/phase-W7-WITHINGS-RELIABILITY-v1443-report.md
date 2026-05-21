# W7-WITHINGS-RELIABILITY — v1.4.43 phase report

## Scope shipped (B3 only)

- **B3 — typed-classification catch-block migration** for the two
  sibling Withings sync paths (activity + sleep).
- Exported `recordWithingsSyncFailure(userId, err)` from
  `src/lib/withings/sync.ts` so the sibling paths can share the helper.
- Migrated `src/lib/withings/sync-activity.ts` to consume the shared
  helper. Dropped the local `extractWithingsStatus` +
  `isWithingsRefreshReauthFailure` imports; the helper internally
  routes through `classifyError` (typed `WithingsApiError` first, regex
  fallback for un-prototyped errors via pg-boss JSON round-trip).
- Migrated `src/lib/withings/sync-sleep.ts` the same way.
- BL-P3-2 defence-in-depth — a Withings body-status 403 on either
  scope-gated endpoint still forces `kind: "reauth_required"`. The
  response-classifier's body-status taxonomy doesn't include 403 (it
  isn't a documented Withings response code; only the HTTP layer emits
  403 for scope-gated resources), so the override stays at the call
  site rather than being added to the shared `REAUTH_CODES` set — that
  would have meant a `response-classifier.ts` edit, outside this
  wave's allow-list.
- New regression suite
  `src/lib/withings/__tests__/sync-typed-classification.test.ts` pins
  the typed-classification verdict for body-status 100
  (reauth_required), 102 (reauth_required), 293 (persistent), 601
  (transient) across both sync paths. The 293 + 601 cases were
  silently `transient` under the legacy regex chain — the new tests
  guard against a future refactor reverting to the regex.

### Quality bar

- `pnpm lint` — clean.
- `pnpm typecheck` — clean.
- `pnpm test --run src/lib/withings` — **6 test files, 118 tests,
  all green** (112 pre-existing + 6 new).

### File diff surface (strict)

- `src/lib/withings/sync.ts` — single-keyword `export` added; no
  behavioural change.
- `src/lib/withings/sync-activity.ts` — import set trimmed + catch
  block refactored.
- `src/lib/withings/sync-sleep.ts` — same pattern.
- `src/lib/withings/__tests__/sync-typed-classification.test.ts` —
  new file.
- **NO touch** to `src/lib/integrations/status.ts`,
  `src/lib/withings/response-classifier.ts`, or any other file
  outside the four listed above.

## Deferred to v1.4.44

### B4 — IntegrationStatus surface unification

**Status:** DEFERRED — scope discipline / context budget.

**Architecturally-correct path the v1.4.44 wave should pick up:**

1. The five callers that today hand-roll
   `recordSyncFailure({ ..., kind, errorCode })` payloads inline
   (`getValidToken` reauth-park, `syncUserMeasurements` fetch catch,
   `syncUserActivity` 403 short-circuit, `syncUserSleep` 403
   short-circuit, plus the route-layer caller in
   `src/app/api/withings/status/route.ts`) duplicate the
   classification-to-FailureKind mapping.
2. Lift the mapping into a single `withingsFailureKindFor(err)` helper
   in `src/lib/withings/sync.ts` (or in `response-classifier.ts` if
   the helper stays pure — preferred). The helper returns
   `{ kind: FailureKind, errorCode?: string }` directly so each call
   site collapses to `recordSyncFailure({ userId, integration:
   "withings", message, ...withingsFailureKindFor(err) })`.
3. Migrate `src/app/api/withings/status/route.ts:85` off
   `isWithingsRefreshReauthFailure(message)` onto the typed helper
   (the route currently re-parses the message string a second time
   after the sync layer already classified it).
4. Once every call site uses the helper, delete the legacy regex
   exports `isWithingsRefreshReauthFailure` + `extractWithingsStatus`
   from `sync.ts`. The route-layer migration in step 3 is the last
   blocker; once it's gone the regex helpers are unreferenced and can
   be removed in the same commit.

### B7 — IntegrationStatus row freshness audit

**Status:** DEFERRED — scope discipline / context budget.

**Architecturally-correct path the v1.4.44 wave should pick up:**

1. Inventory every code path that writes `IntegrationStatus` and
   compare against the integrations the user can reach from the
   Settings page. Today the `withings` row is the only one fully
   wired through the failure ladder; the `apple_health` and `manual`
   surfaces lean on the same row but never refresh `lastSyncedAt`
   when ingest succeeds.
2. Add a `recordIntegrationSuccess(userId, integration)` helper
   alongside `recordSyncSuccess` in
   `src/lib/integrations/status.ts` that ALWAYS bumps
   `lastSyncedAt` even when the integration doesn't run on a sync
   cadence (Apple Health is push-only — no `syncUser*` wrapper to
   hook).
3. Wire the helper into the Apple Health batch-ingest endpoint
   (`src/app/api/healthkit/batch/route.ts` and the per-route
   counterparts) so the Settings page surfaces a meaningful
   "last synced" timestamp for the iOS path.
4. Add a freshness-staleness probe to the `/api/integrations/status`
   reader that flags rows where `lastSyncedAt` is older than the
   integration's expected cadence (Withings: 1h; Apple Health: 24h
   since iOS only batches on a daily wake). The probe drives an
   amber-state badge on the Settings card without changing the
   underlying success / failure / reauth taxonomy.

### Reason for the split

The B4 + B7 work touches `src/lib/integrations/status.ts` (B4: helper
addition + removal of the regex helpers) and the API surface (B7:
freshness probe). Either change is one bucket on its own — bundling
all three into v1.4.43 would have meant the wave touched the
classifier, the integration-status writer, AND the API reader, well
past the "scope discipline" budget the v1.4.43 marathon was
calibrated for. B3 was the standalone unit that delivered a
measurable de-duplication of the classification logic without
expanding the surface, so it shipped on its own and the dependent B4
+ B7 work moves to v1.4.44 where it gets the focus it needs.
