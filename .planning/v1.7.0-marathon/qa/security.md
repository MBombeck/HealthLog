# v1.7.0 Security Review — new attack surface

Reviewer: security (READ-ONLY). Scope: `git diff main..release/v1.7.0`.
Verdict: **No Critical or High findings.** New surface is well-scoped; auth,
own-data narrowing, encryption-at-rest, and redaction patterns hold.

## Severity counts
- Critical: 0
- High: 0
- Medium: 0
- Low: 2
- Informational: 3

---

## 1. Health-record export (`POST /api/export/health-record`)
PASS on every checked control.
- `requireAuth()` (cookie OR Bearer); `userId` taken from session only.
  `exportSelectionSchema` is `.strict()` with NO `userId` field — a smuggled
  `userId` (or any unknown key) 422s via `returnAllZodIssues`.
  (`src/app/api/export/health-record/route.ts:53,64-67`,
  `src/lib/validations/health-record-export.ts:84-101`)
- Rate-limited: `export:<userId>` 10/h shared bucket (`route.ts:56-59`).
- Audit-logged `health-record.export` with format/days/section-booleans only —
  never values (`route.ts:111-124`).
- Data collected via `collectDoctorReportData(user.id, …)` — userId-scoped; no
  cross-user path in FHIR/PDF/zip. `range.days` capped 1..365, `practiceName`
  max 120 + `sanitisePracticeName`.

## 2. KVNR / insurance number
PASS.
- Encrypted at rest via `crypto.ts` `encrypt()` on write
  (`src/lib/auth/profile-update.ts:119-123`), stored as
  `insuranceNumberEncrypted`. Validated + normalised (mod-10 check digit)
  before encrypt (`src/lib/validations/auth.ts:46-60`, `kvnr.ts`).
- Decrypt is **fail-soft** in all three readers (export, `/api/user/profile`,
  `/api/auth/me`): `try { decrypt } catch { insuranceNumber = null }`. Fail-soft
  is safe here — on a key-rotation gap the value is omitted, no plaintext leak,
  no 500. (`route.ts:92-99`, `user/profile/route.ts:48-55`, `me/route.ts:26-32`)
- Plaintext KVNR reaches ONLY own-data GET responses and the own-data
  PDF/FHIR export body. Never in `annotate`/wide-event meta, never in
  `auditLog` details, never in an error envelope. The profile PATCH routes do
  not call `buildPayloadDiagnostic`, so the request body (plaintext KVNR) is not
  captured into any wide-event excerpt. Zod refine message is a static string
  (no value echo).

### LOW-1 — `insuranceNumber` not in the central redaction denylist
`SENSITIVE_KEY_PATTERNS` (`src/lib/observability/redact-payload.ts:27-46`) has
no `insurance` / `kvnr` pattern. Today nothing routes a body containing
plaintext `insuranceNumber` through `redactSensitiveFields` (the profile routes
don't build a payload diagnostic), so there is no live leak. This is
defence-in-depth: if a future change adds `buildPayloadDiagnostic` /
`redactSensitiveFields` to a profile route or a generic body-excerpt is added to
`apiHandler`, the KVNR (and `fullName`/`insurerName`) would land verbatim in the
wide-event/GlitchTip excerpt.
Fix: append `/insurance/i` and `/kvnr/i` to `SENSITIVE_KEY_PATTERNS` now, while
the surface is small.

## 3. Sync endpoints (`/api/sync/changes`, `/api/sync/state`)
PASS.
- Both `requireAuth()` (cookie + Bearer).
- `/api/sync/changes` feed is scoped `where: { userId: user.id, ...cursorFilter }`
  (`src/app/api/sync/changes/route.ts:143-147`). The cursor only carries
  `(updatedAtMs, id)` and is ANDed with `userId`, so a forged/foreign cursor can
  only reposition within the caller's OWN rows — no cross-user leak. Tombstones
  are own-data (same scoped scan). Cursor decode is total / null-on-garbage
  (`src/lib/sync/cursor.ts:35-54`). Rate-limited `sync:changes:<userId>` 120/min.
- `/api/sync/state` aggregates are all `userId`-scoped counts (`state/route.ts:48-64`).
- No token internals in any auth/sync error.

### INFO-1 — `/api/sync/state` GET performs a write
GET bumps `User.lastSyncedAt` (`state/route.ts:72-75`). The call is documented
as "the handshake IS the call." Self-scoped, idempotent, authenticated — not a
vuln, but a GET-with-side-effect is unusual (no CSRF exposure: cookie GET writes
are harmless here and Bearer is the iOS path). Noted only.

## 4. Profile fields (fullName / insurer)
PASS.
- Mass-assignment safe: `applyProfileUpdate` builds `updates` field-by-field,
  never spreads `parsed.data` (`src/lib/auth/profile-update.ts:88-124`). Both
  `/api/auth/profile` and `/api/user/profile` funnel through it. `fullName` /
  `insurerName` bounded `max(120)`.
- XSS in FHIR narrative: `escapeXml()` applied to the only XHTML sink (the
  Composition narrative `div`, `src/lib/fhir/build-bundle.ts:380`), and
  `displayName` is escaped again inside `narrativeText` (line 352) — double-safe.
  Patient `name[].text` (line 121) is a JSON value, not XHTML — serialiser-safe.
  PDF renderer draws KVNR/name as plain pdf-lib text (not an injection sink).

## 5. Coach data clustering
PASS.
- `dataClusters` is a bounded enum array (`.max(10)`,
  `src/lib/validations/coach-prefs.ts:98-146`). Clusters expand the snapshot
  only over the calling user's OWN userId-scoped reads
  (`src/lib/ai/coach/snapshot.ts:434-490,748,780,956,1078`). Enabling a cluster
  cannot pull another user's data and cannot pull anything the user couldn't
  already read. No free-text → no new prompt-injection vector beyond the user's
  own values. No markdown rendering added (chat route still plain text;
  `insights/chat/route.ts` change is an annotate counter only).

## 6. Widget accept-and-ignore (`PUT /api/dashboard/widgets`)
Mostly PASS — `.min(1).max(20)` on the widgets array survives the pre-Zod
unknown-id filter, so the persisted layout stays bounded.

### LOW-2 — unbounded `dropped_ids` in wide-event on large unknown-id arrays
The unknown-id filter (`route.ts:150-174`) runs `.map().filter()` over the FULL
incoming `widgets` array BEFORE Zod's `.max(20)` applies, and writes every
dropped id verbatim into `annotate({ meta: { dropped_ids } })` with no count
cap. `safeJson` is called WITHOUT `maxBytes`, so the array length is bounded only
by the Next.js default body limit — a single large request can push thousands of
strings into one wide-event line (log amplification / wasted heap on the parse).
Not a data-leak (own session) and memory is body-limit-bounded.
Fix: cap before logging — e.g. `dropped_ids: droppedIds.slice(0, 20)` (keep the
`dropped_count`), and/or pass a tight `maxBytes` to `safeJson` on this route.

## 7. Unit-preference endpoint (`/api/auth/me/unit-preference`)
PASS. `requireAuth`, Zod `z.enum(["metric","imperial"])`, rate-limited 60/min,
field-by-field write, self-scoped, audit-logged
(`src/app/api/auth/me/unit-preference/route.ts:34-124`).

## 8. New outbound fetch / safeFetch
PASS. No new outbound (egress) `fetch` under `src/lib` or `src/app`. FHIR/PDF
export build in-process (no network). The one added `fetch(` is
`src/lib/queries/use-dashboard-snapshot.ts:36` → `fetch("/api/dashboard/snapshot")`,
a same-origin relative-path client read explicitly exempt from the
`safe-fetch-required` rule by construction.

## Cross-cutting
- INFO-2: Measurement soft-delete (single + by-external-ids) does the ownership
  404 check before the `update`/`updateMany`; single-`[id]` uses `where:{id}`
  AFTER `existing.userId !== user.id` guard, by-external-ids scopes
  `where:{ userId, deletedAt:null }`. Tombstones in the sync feed are own-data.
  All list/series/rollup reads filter `deletedAt: null`. No cross-user delete or
  tombstone leak. (`measurements/[id]/route.ts` DELETE, `by-external-ids/route.ts`)
- INFO-3: `/api/auth/me/devices/[id]` PATCH scopes the write
  `updateMany({ where:{ id, userId } })` and only reads back after count>0 —
  no cross-user device patch or existence leak.
