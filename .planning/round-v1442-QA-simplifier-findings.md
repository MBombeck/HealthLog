# v1.4.42 Simplifier-residual findings

## Verdict

APPROVE_WITH_FIXES — the v1.4.42 waves landed clean wins: BERLIN_DAY_FORMATTER 7-way dedup (W4), Suspense double-comment consolidate (W4), 35→0 / 52→0 knip drop with enforcing CI gate (W1), `returnAllZodIssues` shared helper (W2), `pickCanonicalWorkoutRows` write-time helper (W5), Withings response classifier (W6), and ~70 long-tail queryKey bare-literals routed through the factory (W3). The residual scan turned up **one High** (W6 introduced two nested ternaries — explicitly against the simplifier style guide), **three Medium** (one missed BERLIN_DAY_FORMATTER dedup site, one duplicate function-name collision with the v1.4.30 read-time picker, one shared boilerplate between `returnAllZodIssues` and `apiError`), and **a handful of Low** items that are pure cleanup. None block ship; all are mechanical.

## High (clarity regression introduced this release)

### H1 — `src/lib/integrations/status.ts:513-518` + `:530-535`: two nested ternaries introduced by the W6 third-state extension

The W6 wave widened `FailureKind` from `transient | reauth_required` to a three-state union (`+ persistent`). The two formatter branches in `formatAdminAlertPayload` got the new arm wedged in as a nested ternary:

```ts
// lines 513-518
const reasonLabel =
  input.kind === "reauth_required"
    ? "re-auth required"
    : input.kind === "persistent"
      ? "persistent error"
      : "transient error";

// lines 530-535 — same nested-ternary shape inside a template-literal interpolation
`Action: ${
  input.kind === "reauth_required"
    ? "ask the user to reconnect the integration."
    : input.kind === "persistent"
      ? "investigate the upstream contract — params/scope/action likely mismatched."
      : "investigate the upstream service."
}`
```

The simplifier style guide explicitly forbids this pattern ("Avoid nested ternary operators — prefer switch statements or if/else chains for multiple conditions"). Pre-v1.4.42 both spots were single ternaries (two arms) and read cleanly; the third arm pushed them into the antipattern.

**Proposed shape** — a single `kindCopy` lookup driven off `FailureKind`:

```ts
const COPY_BY_KIND: Record<FailureKind, { reason: string; action: string }> = {
  reauth_required: {
    reason: "re-auth required",
    action: "ask the user to reconnect the integration.",
  },
  persistent: {
    reason: "persistent error",
    action: "investigate the upstream contract — params/scope/action likely mismatched.",
  },
  transient: {
    reason: "transient error",
    action: "investigate the upstream service.",
  },
};

const { reason: reasonLabel, action: actionLabel } = COPY_BY_KIND[input.kind];
…
`Action: ${actionLabel}`;
```

Net: both nested ternaries collapse, the table reads as the contract, and adding a future fourth `FailureKind` is a one-row table edit instead of two more arms in two different ternary stacks. Mechanical, no behaviour change.

## Medium (clean wins the waves missed)

### M1 — `src/lib/insights/bucket-series.ts:19` + `src/lib/analytics/bp-in-target.ts:63`: two BERLIN_DAY_FORMATTER sites the W4 dedup missed

The W4 wave's seven-way BERLIN_DAY_FORMATTER dedup hoisted the formatter + `toBerlinDayKey()` from the seven `src/lib/insights/*-status.ts` files into `src/lib/tz/resolver.ts`. Two more declarations of the same constant survive:

- `src/lib/insights/bucket-series.ts:19-24` — same `Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" })` constant. Its consumer (`toBerlinYmd` at line 67) needs the *parts* (numeric year/month/day) not the string, but it could still reuse `BERLIN_DAY_FORMATTER` from `@/lib/tz/resolver` by exporting the formatter (or by parsing back from the existing `toBerlinDayKey(date)` output).
- `src/lib/analytics/bp-in-target.ts:63-72` — declares the same formatter (with `en-CA` locale to skip the part-reassembly) and its own local `toBerlinDayKey(date)`. Pre-existing duplication, not v1.4.42-introduced, but it surfaced as the obvious next dedup site once W4's hoist landed.

Neither was touched by v1.4.42, so this is M (not H). Net: one shared `BERLIN_DAY_FORMATTER` export (already in `@/lib/tz/resolver`) + a tiny `BerlinYmd` helper alongside it; two more files drop ~12 LOC each.

### M2 — Same function name `pickCanonicalWorkoutRows<T>` now lives in two modules with different signatures

W5 added `src/lib/workouts/canonical-rows.ts::pickCanonicalWorkoutRows()` for the write-time path. The read-time picker from v1.4.30 lives at `src/lib/measurements/pick-canonical-workout-rows.ts::pickCanonicalWorkoutRows()`. Both are exported under the SAME identifier:

```ts
// v1.4.30 read-time
export function pickCanonicalWorkoutRows<T extends WorkoutPickerRow>(
  rows: readonly T[], userPriorityJson: unknown = null,
): T[]

// v1.4.42 write-time
export function pickCanonicalWorkoutRows<T extends WorkoutRow>(
  rows: readonly T[],
): T[]
```

`src/app/api/workouts/batch/route.ts:71` imports from `@/lib/workouts/canonical-rows`; `src/app/api/workouts/route.ts:56` + `src/app/api/workouts/[id]/route.ts:31` import from `@/lib/measurements/pick-canonical-workout-rows`. Today's call sites get the right one by import path, but the same-name collision is the kind of footgun that bites the next person who auto-completes `pickCanonicalWorkoutRows` in a new route and silently invokes the wrong picker (no user-priority resolution on a read; missing the 90 s window on a write).

The W5 helper header already calls out the layered intent — write-time payload-internal dedup vs. read-time cross-batch dedup — so the design is right. Only the naming creates the trap.

**Proposed shape**: rename one. The write-time helper is the newer one and the one whose call site does *not* take `userPriorityJson`, so a name like `pickCanonicalWorkoutRowsForIngest()` (or `dedupeWorkoutBatch()`) makes the write-time contract self-describing and leaves the established `pickCanonicalWorkoutRows()` name for the read-time picker. One file rename + one import update; both pickers' test suites stay byte-identical.

### M3 — `src/lib/api-response.ts:47-71` (`returnAllZodIssues`) and `:86-107` (`apiError`) share the meta/headers extraction boilerplate

The new W2 helper duplicates the meta/headers handling from `apiError`:

```ts
// returnAllZodIssues lines 55-69
const { headers, ...rest } = meta ?? {};
const metaKeys = Object.keys(rest);
return NextResponse.json(
  { data: null, error: "Validation failed", details: { issues: … },
    ...(metaKeys.length > 0 ? { meta: rest } : {}) },
  { status, ...(headers ? { headers } : {}) },
);

// apiError lines 94-106 — same `headers`/`metaKeys`/`...(headers ? …)` shape
```

The boilerplate is small (≈ 6 LOC duplicated) but it's the kind of drift that bit the apiError envelope before — if a future change extends the meta passthrough (e.g. an `errorId` autoinject for Sentry), it lands in one helper and not the other.

**Proposed shape** — a private builder:

```ts
function buildJsonErrorResponse(
  body: Record<string, unknown>,
  status: number,
  meta: { headers?: Record<string, string> } & Record<string, unknown> | undefined,
): NextResponse {
  const { headers, ...rest } = meta ?? {};
  const metaKeys = Object.keys(rest);
  return NextResponse.json(
    { ...body, ...(metaKeys.length > 0 ? { meta: rest } : {}) },
    { status, ...(headers ? { headers } : {}) },
  );
}

export function apiError(message, status = 400, meta?) {
  return buildJsonErrorResponse({ data: null, error: message }, status, meta);
}

export function returnAllZodIssues(error, status = 422, meta?) {
  return buildJsonErrorResponse(
    { data: null, error: "Validation failed",
      details: { issues: sanitiseZodIssues(error.issues) } },
    status, meta,
  );
}
```

Net: −12 LOC, single boilerplate update path, identical wire shape — both helpers' contract tests (the new `api-response-zod.test.ts` + existing rate-limit / errorCode tests) stay green.

### M4 — `src/lib/withings/sync.ts:118-135` + `:195-209`: identical 14-line failure-record catch-block now lives in two places

W6 swapped both call sites from `isWithingsRefreshReauthFailure(message)` to the typed `classifyError(err)` + `classificationToFailureKind()` chain. The two blocks ended up byte-identical:

```ts
const message = err instanceof Error ? err.message : String(err);
const classification = classifyError(err);
await recordSyncFailure({
  userId,
  integration: "withings",
  kind: classificationToFailureKind(classification),
  message,
  errorCode:
    err instanceof WithingsApiError
      ? err.withingsStatus?.toString()
      : extractWithingsStatus(message),
});
```

**Proposed shape** — a `recordWithingsSyncFailure(userId, err)` helper next to `classificationToFailureKind`:

```ts
async function recordWithingsSyncFailure(userId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: "withings",
    kind: classificationToFailureKind(classifyError(err)),
    message,
    errorCode:
      err instanceof WithingsApiError
        ? err.withingsStatus?.toString()
        : extractWithingsStatus(message),
  });
}
```

Both call sites collapse to `await recordWithingsSyncFailure(userId, err);`. Sync-activity / sync-sleep migration to typed errors (W6 deferred to v1.4.43) gets a single line per catch-block as a bonus.

## Low (defer to v1.4.43)

### L1 — `src/app/medications/page.tsx:553`: bare-literal `queryKey` outside the W3 guarded surface

```ts
const apiEndpointKey = ["medication-api-endpoint", medication?.id];
```

W3 added `src/app/medications/page.tsx` to the ESLint plugin's `GUARDED_FILES`, but the literal lives in a `const` assignment (not a `queryKey: [ … ]` property), so the rule's `Property` visitor doesn't fire. The two `useQuery` / `setQueryData` / `removeQueries` calls below all reference the same `apiEndpointKey` constant. Centralising as a factory entry (`queryKeys.medicationApiEndpoint(medicationId)`) would keep the cache layout discoverable.

The current shape works — the constant indirection means the ESLint rule's "bare-array" check is technically satisfied — but it's the same drift class W3 was scoped to fix. One factory entry + one import + one usage swap.

### L2 — `eslint-plugins/healthlog/queryKey-factory.js:70` + `src/lib/__tests__/query-keys.test.ts:269`: `src/components/settings/about-section.tsx` listed redundantly

`about-section.tsx` is now covered by the `src/components/settings` directory entry W3 added. Both the ESLint plugin's `GUARDED_FILES` and the test-guard's `guardedRoots` still list `about-section.tsx` individually — pre-existing from v1.4.41 W-FRONTEND-FACTORY, but the W3 wave should have collapsed it. Drop the line in both places. Cosmetic, no behaviour change.

### L3 — `src/lib/withings/sync.ts:310-326`: `classificationToFailureKind` switch is mostly identity

Three of the four `case` arms map a value to itself: `case "reauth_required": return "reauth_required";`, `case "persistent": return "persistent";`, `case "transient": return "transient";`. Only `case "success":` collapses to a default. An identity-passthrough with a defensive default would read identically:

```ts
export function classificationToFailureKind(c: WithingsClassification): FailureKind {
  return c === "success" ? "transient" : c;
}
```

The current switch is explicit and exhaustive, which the W6 author chose deliberately ("Defensive: a caller asking for the FailureKind of a success is a contract bug"). Pure preference — flagging as Low because the switch reads as ceremony for what's structurally a one-liner.

### L4 — `src/lib/workouts/canonical-rows.ts:226-255`: triple-pass picker reads as more clever than the algorithm needs

The survivor selection in `pickCanonicalWorkoutRows` annotates every group member, sorts, picks the winner, then reverse-looks-up the original by `origIndex`:

```ts
const annotated = group.map((entry) => ({
  ...entry,
  row: { ...entry.row, index: entry.row.index ?? entry.origIndex } as T,
}));
annotated.sort((a, b) => compareCandidates(a.row, b.row));
const winner = annotated[0]!;
const original = group.find((g) => g.origIndex === winner.origIndex)!;
survivors.push(original);
```

A `reduce`-style single-walk would skip the annotation pass + sort + reverse-lookup:

```ts
let winner = group[0]!;
for (let i = 1; i < group.length; i++) {
  // compareCandidates wants the row's `index` set; supply the fallback inline.
  const a = group[i].row.index !== undefined
    ? group[i].row
    : { ...group[i].row, index: group[i].origIndex } as T;
  const w = winner.row.index !== undefined
    ? winner.row
    : { ...winner.row, index: winner.origIndex } as T;
  if (compareCandidates(a, w) < 0) winner = group[i];
}
survivors.push(winner);
```

The current shape is well-commented and the 12-test suite pins the contract, so the algorithm is correct. Style-only refactor. Skipping for v1.4.42 because the simpler form re-introduces the `... as T` cast at every comparison site — the simpler-looking code is not strictly cleaner.

### L5 — `pnpm knip` configuration hints: 28 cleanups outside the exports/types tier

`knip` reports 28 configuration hints (redundant entry patterns, ignored deps that match the project, etc.) that the W1 wave deliberately did not touch — W1 was scoped to the `exports` + `types` tiers. The cleanup is mechanical (remove redundant `next.config.ts` / `playwright.config.ts` entries; drop `@types/node` from `ignoreDependencies`; remove `src/generated/**` from `ignore` since `project` already excludes generated files). Defer to v1.4.43 — none of these surface false negatives in the new enforcing gate.

## Already-deferred items (acknowledge, do not re-flag)

Per W1 § "Reconcile callouts", W2 § "v1.4.43 backlog", W4 § "Items 4-5 (NO-OP)", W5 § "Strict rules honoured", and W6 § "Deferred to v1.4.43" — these are explicit follow-ups I am NOT re-flagging:

- The 41-route rollout of `returnAllZodIssues` across `src/app/api/**` (W2 backlog tables for iOS-contract / medication-CRUD / auth-settings-admin tiers).
- The `medications/[id]/intake/import/route.ts` `Invalid format: ` prefix preservation (W2).
- Sync-activity / sync-sleep catch-block migration to `err.classification` direct read instead of regex fallback (W6).
- `parkIntegrationAtReauth` for persistent failures lasting > 24 h (W6).
- CI integration of `pnpm check-env` against `.env.production.example` (W6).
- Shadcn surface-area exports muted under `ignoreIssues["src/components/ui/**"]` (W1) — pending Marc's call.
- `src/lib/validations/**` z.infer types muted (W1) — iOS-contract + OpenAPI gen.
- The W4 NO-OP findings (`computeLongWindowSummary`, `ensureUserMedicationComplianceFresh` — both already removed pre-v1.4.42).
- The W1 "fold contracts ignore-block" choice (matched the pre-existing convention).

The v1.4.41 simplifier-residual report's deferred items are also out of scope here — re-flag only if v1.4.42 made them worse.

## Strengths

- **W1 enforcing gate**: 35 → 0 unused exports + 52 → 0 unused types with the CI workflow now red on regression. The `ignoreExportsUsedInFile: true` choice (instead of muting individual zod schemas) correctly preserves the source-of-truth pattern where a schema is exported AND consumed via `z.infer<>` in the same file. The two-file ignore block is documented inline with rationale per directory.
- **W3 lockstep discipline**: the ESLint plugin, the test-guard walker, AND the factory tests all extended in the same commit (`e2018b2d`). Past waves shipped one without the other and the next session paid for the drift — this one didn't.
- **W4 BERLIN_DAY_FORMATTER hoist**: −101 / +32 net LOC and seven importers now share a single `toBerlinDayKey()` export. The header on `src/lib/tz/resolver.ts:64-75` documents both this helper and the per-user `userDayKey(date, tz)` siblings so the next "which day-key should I use?" lookup lands the right answer.
- **W5 helper purity**: `pickCanonicalWorkoutRows` in `src/lib/workouts/canonical-rows.ts` is genuinely pure (zero Prisma imports, zero IO) and the 12-test suite + 3 batch-route tests pin every algorithm corner. The 90 s window choice + the `DEFAULT_WORKOUT_SOURCE_PRIORITY` reuse with the v1.4.25 W16a constant is documented in the header. The naming collision (M2) is the only blemish.
- **W6 classifier purity**: `classifyWithingsResponse(httpStatus, body)` is a pure function with 27 tests pinning every documented Withings status code. The `WithingsApiError` subclass preserves the legacy `Withings <verb> error: <status>` message format so the v1.4.41 regex consumers in `sync-activity.ts`/`sync-sleep.ts` keep working. The migration path (typed throw + regex fallback in `classifyError`) is the exact "replace-with-fallback" pattern Marc's `feedback_read_swap_replace_not_parallel.md` memo prescribes.
- **W6 env-check**: the manifest-driven shape with `required` / `allOrNone` / `anyOf` markers covers the v1.4.40 AP-2 silent-disable case (3/4 APNS_* set) without forcing every operator to read prose docs. The unit test surface (16 tests covering `parseEnvFile` quoting/CRLF/comments + `checkEnv` group semantics) keeps the helper trustworthy.
- **Marc-voice authorship**: every commit message reads as Marc's, no `Co-Authored-By`, no `--no-verify`, no `--no-gpg-sign`, no "Marc"/"agent"/"marathon"/"phase" leakage. Six wave reports, six clean commit ranges.

40-word summary: Six waves landed clean. One nested-ternary regression in W6's three-state extension, one same-name picker collision with v1.4.30, one missed BERLIN_DAY_FORMATTER dedup, plus light boilerplate sharing wins. No blockers; mechanical follow-ups for v1.4.43.
