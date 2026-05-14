# W21 — Security review (v1.4.25-rc, audited @ `51f23ef3` on `develop`)

One reviewer, one pass. Read-only audit of the security-relevant surfaces
added since `v1.4.24`. Findings are sorted by severity, each pinned to a
file path so the next reviewer can pick up where I stopped.

---

## Summary

- **Critical**: 1 — `WITHINGS_WEBHOOK_SECRET` lands in structured logs as
  the request path on every legitimate Withings delivery to the new
  W17a path-segment route. This is the same leak class W17a was meant
  to fix; the fix solved the proxy-access-log surface but introduced an
  application-log leak.
- **High**: 1 — `POST /api/medications/[id]/glp1` (legacy convenience
  endpoint that still ships in v1.4.25) skips Zod, `auditLog`, and
  rate-limiting; the W19a research wave introduced new write surfaces
  next to it that ARE clean, so the gap is now visible from one
  directory listing.
- **Medium**: 2 — `redactSecrets` carries no rule for path-segment
  secrets (rolls up under Critical 1 but the redact module is the
  durable fix point); the legacy `?secret=` Withings webhook route stays
  alive without an end-of-life enforcement (warning is fired but the
  route still 200s).
- **Low**: 3 — `Workout.metadata` accepts unbounded JSON via
  `z.record(z.string(), z.unknown())`; PR-detection enqueue ignores
  errors (defensive, but no DLQ); cadence + titration read endpoints
  ship without rate-limiting (read-only, cheap queries, so this is a
  best-practice nit).

Total: **1 Critical**, **1 High**, **2 Medium**, **3 Low** = 7 findings.

The Coach pipeline is **clean**:
- `researchModeEnabled`, `researchModeAcknowledgedAt`, and
  `researchModeAcknowledgedVersion` never reach
  `src/lib/ai/coach/snapshot.ts`, `glp1-snapshot.ts`, nor the chat
  route. Confirmed by `grep -r researchMode` over `src/lib/ai/coach/`
  and `src/app/api/insights/chat/`.
- Safety-contract `trigger_phrases` (W19c-Safety + W14c) are test-only
  surface. `buildNativeCoachPrompt` (`native-prompts.ts`) walks
  `getGroundRuleBody`; nothing pulls `drug_level_refusal.trigger_phrases`
  into the assembled prompt.
- GROUND RULE 9 (W4d dose refusal) and GROUND RULE 15 (W19c drug-level
  refusal) both ship in the EN + DE hand-curated bodies and in the FR /
  ES / IT / PL native rebuilds via `COACH_GROUND_RULE_ORDER`.

Authentication boundary changes from v1.4.25 W10 (any-authenticated-token
passes when a route declares no scope) are documented in-code at
`src/lib/api-handler.ts:295-315`; not in this review's scope to second-
guess, but flagged for the next senior-dev cycle if the iOS app's
narrow-scope plan slips.

---

## Critical

### C-1 — `WITHINGS_WEBHOOK_SECRET` lands in `http.path` of every Wide Event

**Severity**: Critical. Secret-in-logs on a production write path.

**File**: `src/app/api/withings/webhook/[token]/route.ts` (route)
plus `src/lib/api-handler.ts:104,128-129` (instrumentation)
plus `src/lib/logging/event-builder.ts:40-43` (storage)
plus `src/lib/logging/redact.ts:25-49` (missing rule).

**What happens**: `apiHandler` reads `request.url`, parses the pathname,
and calls `evt.setHttp({ path: url.pathname, route: url.pathname })`.
`WideEventBuilder.setHttp` stores the pathname verbatim — no redaction.
The event then goes to:

1. stdout via `emitToStdout` (`transports.ts:93-114`),
2. the in-memory ring buffer that `/admin/app-logs` reads
   (`appendLogEvent` at `transports.ts:101`),
3. Loki when `lokiEndpoint` is set (`transports.ts:107-113`).

For the new W17a route the pathname is
`/api/withings/webhook/<WITHINGS_WEBHOOK_SECRET>`. The secret therefore
lands in three places per legitimate delivery. The W17a design note in
`webhook/[token]/route.ts:10-24` calls out that "moving the secret out
of the query string keeps it out of the `query_string` column most
reverse proxies log by default" — that part holds, but the application
layer is now the leak surface instead. The same line is also captured
into GlitchTip via `reportToGlitchtip` if the handler throws (the route
uses NextResponse rather than throw, so this path is cold today, but it
warms the moment a downstream handler raises).

**Why this is Critical and not High**:
- A standard Withings subscription delivers hundreds of webhooks per
  user per day, so the leak rate is high.
- The secret is the **only** authenticity surface. Recovering it grants
  full webhook forgery for every user on the host until rotation.
- The admin ring buffer (`/admin/app-logs`) is readable from a less-
  privileged tier than the Withings dashboard rotation; a logged-in
  admin sees `http.path` on every event row.

**Fix shape** (do **not** apply during this audit — for the next phase):
1. Extend `redactSecrets` in `src/lib/logging/redact.ts` to match the
   path-segment shape:
   ```
   .replace(
     /\/api\/withings\/webhook\/[^/?\s]+/g,
     "/api/withings/webhook/[REDACTED]",
   )
   ```
2. Apply `redactSecrets` to `http.path` and `http.route` inside
   `WideEventBuilder.setHttp` (or at egress time in `emitEvent`),
   alongside the existing error-message redaction.
3. Confirm the audit-log table does **not** receive the path (only the
   `action.name` annotation — currently true; `withings.webhook` is the
   annotation literal, not the path).

**Reproduction**: tail stdout while POSTing
`/api/withings/webhook/test-secret` — the JSON log line includes
`"path":"/api/withings/webhook/test-secret"`.

---

## High

### H-1 — `/api/medications/[id]/glp1` POST has no Zod / audit / rate-limit

**Severity**: High. Authenticated mutation surface without the
project-wide guard set.

**File**: `src/app/api/medications/[id]/glp1/route.ts:130-177`.

The W19b inventory route, the W19d side-effect route, the W19e cadence
endpoint, and the W19f titration endpoint all ship with the full guard
set (Zod schema, `auditLog`, per-user `checkRateLimit`). The W4d
convenience endpoint that lives in the same directory does not:

```ts
const body = (await request.json().catch(() => null)) as Glp1PostBody | null;
if (!body) return apiError("Invalid body", 400);
if (body.doseChange) {
  const { effectiveFrom, doseValue, doseUnit, note } = body.doseChange;
  if (!effectiveFrom || typeof doseValue !== "number" || !doseUnit) { ... }
  const created = await prisma.medicationDoseChange.create({
    data: {
      medicationId: id,
      effectiveFrom: new Date(effectiveFrom),
      doseValue,
      doseUnit,
      note: note ?? null,
    },
  });
}
```

Concrete issues:
- `doseValue` is `typeof === "number"` but never bounded (negative
  doses, `Infinity`, `NaN` only loosely filtered by Prisma's column
  type). A `NaN` write would poison the dose-change stream.
- `effectiveFrom` goes straight into `new Date(...)`; a string like
  `"banana"` yields `Invalid Date` which Prisma rejects, but a far-
  future ISO string lands without complaint and feeds the titration
  ladder's `weeksOnCurrentStep` resolver with nonsense.
- `note` has no length cap — every other text field on this surface is
  capped (`createInventoryItemSchema.notes` at 200,
  `createSideEffectSchema` notes likewise).
- The Prisma write does **not** carry a `userId` filter (it relies on
  the ownership-pre-check at line 134). Correct in this code path, but
  the absence of an `audit` row means a hostile actor with a stolen
  session can append titration noise across an entire history and the
  audit-log table has no record of who did what — every other write on
  the route surface around it leaves a trace.
- No `checkRateLimit`. The W19e/W19f neighbours all use a 30/min/user
  ceiling on POST; this route is the loose neighbour.

The endpoint is documented as a "convenience" path the medication-card
disclosure uses. v1.4.25 W4d brief said the v1.5 iOS app would call
this directly. Tightening the contract before the iOS app generates
its DTO is cheaper than tightening after.

**Fix shape**: define `glp1DoseChangePostSchema` and
`glp1InventoryPostSchema` next to the other inventory schemas, parse
the body with `safeParse`, attach `auditLog("medication.glp1.update", …)`
on success, and copy the 30/min/user rate-limit from
`/api/medications/[id]/inventory/route.ts:34-38`.

---

## Medium

### M-1 — `redactSecrets` has no rule for path-segment secrets

**Severity**: Medium (rolled up into Critical C-1; called out separately
so the redact module is the durable fix point).

**File**: `src/lib/logging/redact.ts`.

The redact pipeline today knows about `Bearer …`, `bot<digits>:…`,
`sk-…` / `sk-ant-…`, `hlk_…` / `hlr_…`, and the
`?(secret|code|token|api_key)=…` query-string form. It does **not**
know about path-segment secrets, of which Withings W17a is the first
example in this codebase. A future SSE/WebSocket route that adopts the
same pattern would land in logs with the same leak.

**Recommendation**: parameterise the redact rules by a small
`PATH_SECRET_PATHS: readonly RegExp[]` registry. Each entry matches a
specific route prefix and rewrites the tail. Today the registry has
one entry; tomorrow it has the next one.

### M-2 — Legacy `?secret=` Withings webhook route stays alive with no EOL gate

**Severity**: Medium. Defence-in-depth.

**File**: `src/app/api/withings/webhook/route.ts:21-32`.

The header note says "Removal target: v1.4.27 (after all live
subscriptions have rotated)." The route accepts the legacy `?secret=`
form today and emits a Wide Event warning
("withings webhook secret received via legacy URL query") but the
request still 200s. Two issues:

1. There is no metric / counter that surfaces "legacy form usage is
   trending toward zero". The warning is fire-and-forget; the v1.4.27
   removal call will be a guess unless the team adds a counter the
   release-gate can read.
2. The legacy form's secret **does** still travel as a query string. On
   the reverse proxy side that lands in the access log. The W17a brief
   addressed the new route; the legacy route stays as-is for one
   cycle, but the warning text doesn't say "rotate your subscription"
   — Marc may want the message to include the migration URL so users
   who can read logs understand what to do.

**Recommendation**: add a `withings.webhook.legacy_form_total` counter
(simple in-memory counter in the route module, surfaced via the existing
ops-stats endpoint), and update the warning text to include the
re-subscription URL.

---

## Low

### L-1 — `Workout.metadata` accepts unbounded JSON

**Severity**: Low. Bounded by the 5 MB request body cap.

**File**: `src/lib/validations/workout.ts:121`.

```ts
metadata: z.record(z.string(), z.unknown()).optional(),
```

No depth limit, no key-count cap. The 5 MB body cap and the
100-workout-per-batch cap together keep this bounded enough that a
single batch can't tip the worker — at worst an attacker can fill
~50 KB of `metadata` per workout. Postgres JSONB stores it cheaply.
The Coach pipeline does **not** read this field (verified — the
W16b doc comment in the batch route says "the Coach pipeline reads
typed columns only").

If a future Coach surface ever does read `metadata`, treat it as
untrusted input — see the route's own prompt-injection note at
line 47-49 ("must add deliberate escaping; the ingest path stores
it raw").

**Recommendation**: add a `z.record(z.string(), z.unknown()).refine(o =>
JSON.stringify(o).length < 16_384, "metadata exceeds 16KB")` cap when
the Coach pipeline starts reading the field, not before.

### L-2 — PR-detection enqueue failures are swallowed by both batch routes

**Severity**: Low. No DLQ today, but no PII / auth surface either.

**Files**:
- `src/app/api/workouts/batch/route.ts:466-484`
- `src/app/api/measurements/batch/route.ts` (symmetric block)

```ts
try {
  await enqueuePrDetection(user.id, { silent });
  await auditLog("personal_records.detection_enqueued", …);
} catch (err) {
  annotate({
    action: { name: "personal_records.detection_enqueue_failed" },
    meta: { error: err instanceof Error ? err.message : String(err) },
  });
}
```

The pg-boss queue failing to accept the job means the user's PRs
silently won't be detected for that batch. The W16c cron fallback
covers this in a 30-minute window, so the user does eventually get
the PR badge — but the failure has no audit trail and no metric.

**Recommendation**: emit a Wide Event with `level: "warn"` (which the
ops-stats endpoint can count) on enqueue failure, in addition to the
annotation. Today the annotation is the only signal.

### L-3 — Cadence / titration read endpoints have no rate-limit

**Severity**: Low. Read-only, indexed query, user-scoped.

**Files**:
- `src/app/api/medications/[id]/cadence/route.ts`
- `src/app/api/medications/[id]/titration/route.ts`

GET surfaces with no `checkRateLimit`. Each call hits 3–4 indexed
queries (medication + schedules + intakeEvents bounded by `gte: from` +
doseChanges). A user spamming GET takes O(milliseconds) per call but
the database connection pool can saturate under coordinated abuse.

For comparison, every POST surface in the W19 cluster ships a 30/min
ceiling. The reads do not.

**Recommendation**: add a 120/min/user ceiling on these reads (matches
the existing `/api/dashboard/glp1` and `/api/insights/glp1-timeline`
class). Cheap enough that the happy path never trips it.

---

## Files audited (32 source files; 1 redact module; 4 instrumentation files)

Routes (new since v1.4.24):
- `src/app/api/auth/me/doctor-report-prefs/route.ts` — Zod ✓, audit ✓, rate-limit (no — read-mostly endpoint, PUT is rare)
- `src/app/api/auth/me/research-mode/route.ts` — Zod (hand-rolled) ✓, audit ✓, rate-limit ✓ (5/min/user)
- `src/app/api/auth/me/source-priority/route.ts` — Zod ✓, audit ✓, rate-limit (no — PUT is rare)
- `src/app/api/auth/me/timezone/route.ts` — manual validate ✓, audit ✓, rate-limit (no — PUT is rare)
- `src/app/api/dashboard/glp1/route.ts` — read-only, requireAuth ✓
- `src/app/api/doctor-report/availability/route.ts` — read-only, requireAuth ✓, schema ✓ via `normaliseDateRange`
- `src/app/api/insights/glp1-timeline/route.ts` — read-only, requireAuth ✓, query-param defensive parse ✓
- `src/app/api/measurements/by-external-ids/route.ts` — Zod ✓, audit ✓, batch cap ✓ (500); idempotent
- `src/app/api/medications/[id]/cadence/route.ts` — read-only, requireAuth ✓, ownership pre-check ✓; **L-3** flagged
- `src/app/api/medications/[id]/glp1/route.ts` — **H-1** flagged
- `src/app/api/medications/[id]/inventory/route.ts` — Zod ✓, audit ✓, rate-limit ✓ (30/min/user), ownership pre-check ✓
- `src/app/api/medications/[id]/inventory/[itemId]/route.ts` — Zod ✓, audit ✓, ownership pre-check ✓; PATCH composes optional fields explicitly (no mass-assignment)
- `src/app/api/medications/[id]/side-effects/route.ts` — Zod ✓, audit ✓, rate-limit ✓ (30/min/user), ownership pre-check ✓, category authoritatively re-derived (no client trust)
- `src/app/api/medications/[id]/side-effects/[logId]/route.ts` — audit ✓, ownership pre-check ✓
- `src/app/api/medications/[id]/titration/route.ts` — read-only, requireAuth ✓, ownership pre-check ✓; **L-3** flagged
- `src/app/api/onboarding/step/route.ts` — Zod ✓, audit ✓, rate-limit ✓ (30/10min/user), step-sequence guard ✓ (no skip-ahead)
- `src/app/api/personal-records/route.ts` — read-only, requireAuth ✓, pagination bounded
- `src/app/api/withings/webhook/[token]/route.ts` — **C-1** flagged (also: timing-safe secret compare ✓, rate-limit ✓, HEAD/GET verify ✓)
- `src/app/api/withings/webhook/route.ts` (legacy) — **M-2** flagged
- `src/app/api/workouts/batch/route.ts` — Zod ✓, audit ✓, rate-limit ✓ (60/min/user), batch cap ✓ (100), idempotency ✓, body cap ✓ (5 MB); **L-1** flagged for `metadata`

Support modules:
- `src/lib/api-handler.ts` — auth precedence (cookie → Bearer → 401), W10 reconcile widens narrow-scope tokens past unscoped routes (documented at :295-315); **C-1** root cause at :104-128
- `src/lib/auth/audit.ts` — used uniformly across new routes
- `src/lib/withings/webhook-handler.ts` — `timingSafeStringEqual` uses `node:crypto.timingSafeEqual` with length pre-check ✓
- `src/lib/ai/coach/snapshot.ts`, `glp1-snapshot.ts`, `system-prompt.ts` — no `researchMode*` leak; GROUND RULES 9, 10 (numbered 9 + 15 in matrix) present
- `src/lib/ai/prompts/safety-contracts.ts` — YAML loader, Zod-schema-gated; trigger phrases never reach assembled prompt
- `src/lib/ai/prompts/native-prompts.ts` — `COACH_GROUND_RULE_ORDER` includes `ground_rule_15_drug_level_refusal`
- `src/lib/logging/redact.ts` — **M-1** missing rule for path-segment secrets
- `src/lib/logging/event-builder.ts:40-43` — `setHttp` stores `path` verbatim; redaction not applied here
- `src/lib/logging/transports.ts:93-114` — emits to stdout + ring buffer + Loki without per-field redaction

Validation modules (sampled):
- `src/lib/validations/workout.ts` — typed, bounded; **L-1** noted
- `src/lib/validations/medication.ts` — every new schema explicitly enumerates fields (no `.passthrough()`)
- `src/lib/validations/source-priority.ts` — typed
- `src/lib/validations/doctor-report-prefs.ts` — typed

Migrations 0051–0059 reviewed for column-level constraints (NOT NULL on
userId everywhere, unique indexes where dedup is required); nothing
flagged.

---

## Closing

**Single critical**, **single high**. Both are old-shape problems
(secret-in-logs, legacy-endpoint hygiene) rather than new-shape (the
W14b / W19 / W17 ground-up routes are clean — Zod-strict, audit-logged,
rate-limited, ownership-pre-checked).

The Coach pipeline survives the prompt-injection probe: research-mode
state stays server-side; the safety-contract matrix keeps its trigger
phrases in test surface; native-locale rebuilds carry GROUND RULE 15
verbatim per the W19c-Safety contract.

**Release-blocker decision**: C-1 should land a fix before
v1.4.25 ships to production. A redact-rule addition is a one-line
change in `src/lib/logging/redact.ts` plus a one-line application in
`WideEventBuilder.setHttp`. H-1 can ship as a v1.4.25.1 follow-up if
the iOS app's DTO is not yet generated against the loose contract; if
it IS already generated, fold both into the same hotfix so the
contract stays stable for the iOS session.
