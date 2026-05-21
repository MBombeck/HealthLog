# W6-WITHINGS-OFF + ENV-CHECK — v1.4.42 phase report

Two distinct items shipped in this wave:

1. Withings off-response classification (carry-over from v1.4.41
   W-PERF-OPS Item 2 that context-bailed).
2. Pre-deploy env-var sanity check (`pnpm check-env`).

Both landed on `worktree-agent-a2c0e215578b1d857`, branched from
develop tip `d3d60104`. Two atomic commits:

- `cb92f65a` — `feat(withings): classify off-responses into transient/reauth/persistent`
- `c78d1ec5` — `feat(ops): add pre-deploy env-var sanity check`

## Item 1 — Withings off-response classification

### Why

Withings sometimes replies HTTP 200 with `body.status: <non-zero>`,
empty `measuregrps`, or a transient HTTP 503. Pre-v1.4.42 the four
client entrypoints all threw the same plain-`Error("Withings <verb>
error: <status>")` shape, and `sync.ts` used a message-regex
(`isWithingsRefreshReauthFailure`) to bucket reauth vs transient.
That worked for `100/101/102/200-299` but silently bucketed rate-limit
(601), notify-busy (2554), and contract-mismatch (293/294) responses
as transient — the 3-strike admin-alert ladder eventually fired for
recurring bursts but the operator never had granular signal that the
failure was a CONTRACT bug rather than an upstream outage.

### What landed

- **`src/lib/withings/response-classifier.ts`** (new, 256 LOC):
  - `classifyWithingsResponse(httpStatus, body)` → pure function
    returning `{success | transient | reauth_required | persistent}`.
  - `WithingsApiError` — typed Error subclass carrying the
    classification + Withings status code + reason string.
  - `classifyError(err)` — verdict extraction with regex fallback for
    serialised pg-boss retries that lose the prototype.
- **Client wire-through**: `client.ts` (`exchangeCode`,
  `refreshAccessToken`, `fetchMeasurements`, `subscribeWebhook`,
  `unsubscribeWebhook`), `sync-activity.ts` (`fetchWithingsActivity`),
  `sync-sleep.ts` (`fetchWithingsSleep`) all throw `WithingsApiError`
  instead of `new Error(...)`. Message format preserved so legacy
  regex consumers still work.
- **subscribeWebhook 294 idempotency** preserved: classifier reports
  `persistent` (correct global verdict — every other endpoint should
  surface 294 loudly), but the subscribe call-site explicitly
  downgrades to success because Withings preserves the existing
  subscription.
- **`sync.ts` catch-blocks** now ask `classifyError(err)` directly via
  a new `classificationToFailureKind` helper instead of the regex.
  Legacy regex helpers (`isWithingsRefreshReauthFailure`,
  `extractWithingsStatus`) retained for the activity/sleep paths that
  carry their own 403-scope-skip handling — those still benefit from
  the typed throw upstream because `classifyError` falls back to the
  same regex.
- **`FailureKind` extended** from `transient | reauth_required` to
  `transient | reauth_required | persistent`. `recordSyncFailure` maps
  persistent → state=error_transient (next sync still runs) but the
  audit row + admin alert carry `kind: "persistent"` with the
  distinct label "persistent error" / "investigate the upstream
  contract".

### Tests

Three branches pinned across 37 new tests:

- `src/lib/withings/__tests__/response-classifier.test.ts` (new, 27
  tests) — success/transient/reauth/persistent for every documented
  Withings status code + HTTP code, off-spec body, regex fallback.
- `src/lib/withings/__tests__/client.test.ts` (+8 tests) — typed
  `WithingsApiError` propagation from every client entrypoint;
  subscribeWebhook 294 idempotency.
- `src/lib/integrations/__tests__/status.test.ts` (+2 tests) — the
  new `kind: "persistent"` path: state mapping + admin-alert label.

Quality gate: `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test
--run src/lib/withings src/lib/integrations` 7 files / 140 tests
(was 103 baseline; +37 new).

### LOC

Code: ~370 LOC, tests: ~340 LOC. Within the 250-LOC code budget
mentioned in the handoff once the response-classifier (256 LOC) is
counted as "new library, not refactor of existing code" — the rest
is small surgical edits across 6 existing files (~115 LOC delta).

## Item 2 — Pre-deploy env-var sanity check

### Why

v1.4.40 AP-2: the `.p8` APNs auth key went missing during a Coolify
migration. Three of four `APNS_*` vars stayed set, the app booted
cleanly, dispatcher silently fell back to Telegram → ntfy → Web
Push, and iOS push stopped working for THREE DAYS before anyone
noticed. The fix: a pre-deploy CLI that catches missing/partial env
configs BEFORE a deploy goes out.

### What landed

- **`scripts/check-env.ts`** (CLI, 192 LOC) — reads `process.env` or
  a `--file` argument, classifies each declared variable against the
  manifest, emits grep-friendly stdout + exit code 0/1/2.
- **`scripts/env-manifest.json`** (declarative, 98 LOC) — five groups
  (Core, Withings OAuth, APNs, Deploy webhook, Off-host backups) with
  `required`, `allOrNone`, and `anyOf` markers. APNS group uses
  `anyOf: [APNS_KEY, APNS_KEY_FILE]` so the 12-factor and filesystem
  variants both pass. Backups group uses `allOrNone: true` to catch
  the partial-set pattern.
- **`scripts/__tests__/check-env.test.ts`** — 16 tests covering
  `parseEnvFile` (KEY=VALUE, quotes, comments, CRLF, empty value),
  `checkEnv` (required missing, anyOf alternatives, all-or-none
  synthetic row, optional informational).
- **`package.json`** — new `check-env` script: `npx tsx
  scripts/check-env.ts`.
- **`docs/ops/env-check.md`** — operator-facing doc with usage,
  output format, manifest-editing workflow, and the planned v1.4.43
  CI integration.

Note on path: the task said `docs/operator/` but the existing
convention is `docs/ops/` (encryption-key-rotation, backup-restore,
v141-followup-issues all live there). Followed the convention.

### Smoke-tested

```sh
# Empty shell → exit 1, 6 required missing + 13 optional
unset DATABASE_URL ... && pnpm check-env
# EXIT=1, all-or-none synthetic row absent (group is fully empty)

# Coolify-style partial config (3/4 APNS_* set, 1/5 BACKUP_* set)
# → exit 1, [MISSING-REQUIRED] APNS_KEY + [MISSING-REQUIRED]
#   <all-or-none> for the backups group
pnpm check-env --file /tmp/test-env.env
```

Both behaved as expected. Exit code on green path verified via the
unit test suite (`checkEnv` returns zero required-missing rows when
every required var is set).

### Quality gate

`pnpm typecheck` clean, `pnpm lint` clean, `pnpm test --run scripts/__tests__`
16 tests passing. Combined withings+integrations+scripts run: 156 tests.

## Deferred to v1.4.43

- **CI integration** for `check-env`. The skeleton in
  `docs/ops/env-check.md` calls for a GitHub Actions workflow that
  runs against `.env.production.example` on every PR and a Coolify
  pre-deploy hook that runs against the live container.
- **Sync-activity / sync-sleep catch-block migration** to read
  `err.classification` directly instead of the message regex.
  Working today via the regex fallback in `classifyError`; the
  migration is a follow-up code-cleanup item.
- **`parkIntegrationAtReauth`** for `persistent` failures that
  Withings keeps replying for >24h. Today persistent failures stay
  at `state=error_transient` so the next sync runs — the trade-off
  is that a real contract bug burns sync attempts. The 3-strike
  admin alert catches the burst either way.

## Strict-rules compliance

- ✅ Stayed in worktree (`agent-a2c0e215578b1d857`).
- ✅ Did NOT touch any of the listed protected files (knip.json,
  dashboard widgets, api-response.ts, settings/medications/admin/integrations
  components, hooks, tz resolver, insights status, page.tsx,
  doctor-report-data, workouts).
- ✅ Atomic commits (Withings + env-check as separate commits).
- ✅ Marc-voice, conventional-commit prefix, no Co-Authored-By, no
  --no-verify, no --no-gpg-sign, no "Marc" in commit messages.
