# W2-ZOD-MULTI-ISSUE — phase report (v1.4.42)

Branch: `worktree-agent-afedd7bebb01d0abd` (off `develop` @ `d3d60104`).

## What landed

### 1. Shared helper `returnAllZodIssues` — `src/lib/api-response.ts`

```ts
returnAllZodIssues(error: ZodError, status = 422, meta?): NextResponse
```

Envelope:

```jsonc
{
  "data": null,
  "error": "Validation failed",
  "details": { "issues": [{ "path", "code", "message" }, …] },
  "meta": { /* optional, e.g. errorCode */ }
}
```

- Companion `sanitiseZodIssues(issues)` is also exported for callers that
  need the same `{ path, code, message }` projection without building
  a response (the widgets route uses it for the audit-ledger breadcrumb).
- `issue.params` is **never** echoed — it can carry the raw rejected user
  input for some Zod issue codes (e.g. `invalid_format`'s `pattern`,
  `too_big`'s `maximum`).
- Additive: clients that only read top-level `error` keep working; new
  callers branch on `details.issues`.
- Same `meta` passthrough as `apiError` (so `errorCode` + `headers`
  round-trip identically).

### 2. `/api/dashboard/widgets` PUT 422 — multi-issue + audit breadcrumb

- Old: `apiError(parsed.error.issues[0].message, 422)`.
- New: `returnAllZodIssues(parsed.error, 422)` + `annotate(...)` + a
  best-effort `prisma.auditLog.create({ action:
  "dashboard.widgets.validation-failed", details: { issues } })`.
- Audit row is fire-and-forget — the 422 response is the contract, the
  audit row is a debugging breadcrumb.

### 3. Tests

- `src/lib/__tests__/api-response-zod.test.ts` — 7 cases (default 422,
  2-issue, 3-issue, nested-path flatten, params-leak guard, custom
  status, meta + headers passthrough).
- `src/app/api/dashboard/widgets/__tests__/route.test.ts` — 4 cases
  (2-issue, 3-issue, audit-row write, audit-write-rejection survival).
- `tests/integration/dashboard-widgets-save.test.ts` — appended 3
  scenarios mirroring the unit cases against the real Prisma client
  (2-issue + DB row, 3-issue, params-leak guard).

### Quality gates (all green)

- `pnpm typecheck` ✓
- `pnpm lint` ✓
- `pnpm test --run src/app/api/dashboard/widgets src/lib/__tests__/api-response-zod.test.ts` ✓ — 11/11
- Integration tier not executed locally (needs live Postgres); CI will
  run it.

### Commits

1. `3e4406df` — `feat(api): add returnAllZodIssues helper for multi-issue 422 envelopes`
2. `e3d0e070` — `feat(api/dashboard): return every Zod issue on widgets PUT 422`

## v1.4.43 backlog — broader rollout

41 sites in `src/app/api/**` still use `parsed.error.issues[0].message`
(or the templated `Invalid format: ${...}` variant). Rolling them in
this wave was out-of-scope per the brief; the queue below is sorted
by debug-frequency / iOS-contract proximity.

### iOS-contract / high-traffic (rollout first)

| File | Line | Notes |
|---|---|---|
| `src/app/api/measurements/route.ts` | 48 | POST single measurement — iOS batch ingestion fallback. |
| `src/app/api/measurements/route.ts` | 556 | DELETE measurements bulk. |
| `src/app/api/measurements/route.ts` | 625 | POST measurements batch — iOS hot path. |
| `src/app/api/measurements/series/route.ts` | 73 | GET series — iOS chart loader. |
| `src/app/api/measurements/[id]/route.ts` | 64 | PUT measurement edit. |
| `src/app/api/medications/intake/route.ts` | 76 | POST intake — iOS log button. |
| `src/app/api/medications/intake/route.ts` | 264 | PATCH intake. |
| `src/app/api/medications/intake/bulk/route.ts` | 112 | POST bulk intake — keeps `errorCode: "medication.bulk.invalid"`. |
| `src/app/api/medications/[id]/intake/route.ts` | 44 | POST per-med intake. |
| `src/app/api/medications/[id]/intake/route.ts` | 188 | PATCH per-med intake. |
| `src/app/api/medications/[id]/intake/[eventId]/route.ts` | 37 | PATCH single intake event. |
| `src/app/api/medications/[id]/intake/import/route.ts` | 51 | Import CSV — keeps `"Invalid format: …"` template; rewrite preserving the prefix. |
| `src/app/api/mood-entries/route.ts` | 38 | POST mood. |
| `src/app/api/mood-entries/route.ts` | 92 | PATCH mood. |
| `src/app/api/mood-entries/bulk/route.ts` | 114 | Bulk mood — keeps `errorCode: "mood.bulk.invalid"`. |
| `src/app/api/mood-entries/[id]/route.ts` | 69 | PATCH mood by id. |
| `src/app/api/dashboard/chart-overlay-prefs/route.ts` | 52 | Sibling of widgets — same iOS popover loop. |
| `src/app/api/integrations/healthkit/route.ts` | 142 | iOS HealthKit ingest. |
| `src/app/api/ingest/medication/route.ts` | 95 | Native ingest. |
| `src/app/api/devices/route.ts` | 74 | Device registration. |
| `src/app/api/tokens/route.ts` | 54 | API token mint. |

### Medication CRUD (rollout next)

| File | Line |
|---|---|
| `src/app/api/medications/route.ts` | 113 |
| `src/app/api/medications/[id]/route.ts` | 72 |
| `src/app/api/medications/[id]/glp1/route.ts` | 148 |
| `src/app/api/medications/[id]/inventory/route.ts` | 86 |
| `src/app/api/medications/[id]/inventory/[itemId]/route.ts` | 63 |
| `src/app/api/medications/[id]/cadence/route.ts` | 60 |
| `src/app/api/medications/[id]/side-effects/route.ts` | 59 |
| `src/app/api/medications/[id]/side-effects/route.ts` | 117 |

### Auth / settings / admin / feedback / consent (rollout last)

| File | Line |
|---|---|
| `src/app/api/auth/password/route.ts` | 39 |
| `src/app/api/auth/register/route.ts` | 63 |
| `src/app/api/admin/settings/route.ts` | 74 |
| `src/app/api/admin/settings/assistant-flags/route.ts` | 127 |
| `src/app/api/admin/feedback/[id]/route.ts` | 28 |
| `src/app/api/admin/users/[id]/route.ts` | 41 |
| `src/app/api/user/thresholds/route.ts` | 83 |
| `src/app/api/feedback/route.ts` | 48 |
| `src/app/api/bugreport/route.ts` | 86 |
| `src/app/api/consent/ai/route.ts` | 26 (status 400) |
| `src/app/api/consent/ai/latest/route.ts` | 41 (status 400) |
| `src/app/api/consent/ai/latest/route.ts` | 89 (status 400) |

### Rollout recipe for v1.4.43

For each route:

1. Swap import: drop `apiError` if unused after rewrite; add
   `returnAllZodIssues` (+ `sanitiseZodIssues` if the route also
   needs an audit-ledger breadcrumb).
2. Replace
   ```ts
   return apiError(parsed.error.issues[0].message, <status>, <meta?>);
   ```
   with
   ```ts
   return returnAllZodIssues(parsed.error, <status>, <meta?>);
   ```
3. Decide whether the route warrants its own
   `<route>.validation-failed` audit-ledger row. Default = **no** for
   low-traffic admin routes, **yes** for iOS-contract hot paths and
   anything in the bulk-ingest cluster.
4. Add 2 + 3 simultaneous-issue tests at the unit tier (use the
   widgets route test as the template).
5. The lone outlier — `medications/[id]/intake/import/route.ts:51`
   prefixes `Invalid format: ` to the message. Switch to
   `returnAllZodIssues` and set
   `meta: { errorCode: "medication.intake.import.invalid_format" }`
   so the CSV-import client UI can still branch on the prefix.

### Why not in this wave

Touching 41 routes in one commit would have collided with W3 / W4
worktrees (some routes import shared response helpers + tz helpers) and
risked an overlap with the in-flight iOS contract debugging. The
focused v1.4.42 wave proves the helper and the audit-ledger pattern; a
follow-up wave rolls them out behind a single PR review.

## Risk + cut-list

- No risk to existing clients — the envelope is strictly additive
  (`details.issues` is new, `error` still carries a human-readable
  string).
- iOS callers that hard-coded `body.error` keep working; new iOS
  builds can branch on `body.details?.issues`.
- The audit-ledger row is best-effort — a DB outage during a PUT 422
  loses the breadcrumb but never the response (test pins this).

## Out of scope (explicit)

- `.github/workflows/knip.yml`, `knip.json` (W1).
- `src/components/**` (W3).
- `src/lib/tz/**` (W4).
- Broader 41-route rollout (v1.4.43 backlog above).
