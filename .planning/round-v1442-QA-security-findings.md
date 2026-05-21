# v1.4.42 Security-review findings

Scope: `git diff main..develop` (commits after `67207d72` — v1.4.42 vs the
live v1.4.41 tag).
Reviewer: W10 security-reviewer (read-only).

## Verdict
APPROVE

Every focus area (returnAllZodIssues, Withings off-response classifier,
write-time workout dedup, check-env CLI, knip ignore-block, re-export
cleanup) passes. No Critical / High findings. Two Lows are noted as
follow-ups for v1.4.43 — neither blocks the tag.

## Critical (must fix before tag — vuln / data leak / auth bypass)

None.

## High (should fix before tag — defence-in-depth gap, log leak, error swallow)

None.

## Medium (recommended for tag)

None.

## Low (defer to v1.4.43)

### L-1 `dispatchNotification` / `formatAdminAlertPayload` carry the raw Withings `json.error` string up to a 280-char Telegram body
- **File**: `src/lib/integrations/status.ts:505-547` (untouched in v1.4.42)
  consumed by the new `WithingsApiError` path in `src/lib/withings/client.ts:127-135, 170-178, 290-298, 374-382`.
- **Attack vector**: The new `upstreamError: typeof json?.error === "string" ? json.error : undefined`
  branch in every client entrypoint pipes Withings' own response-body
  `error` field into the thrown `WithingsApiError.message`. That message
  flows unchanged into:
  1. `AuditLog.details` via `auditLog("integrations.sync.failed", { details: { message, … } })` — **NOT** encrypted, **NOT** length-capped. Only the encrypted IntegrationStatus column is sliced to 1024 chars via `safeEncryptError`.
  2. `formatAdminAlertPayload`, which trims to 280 chars before pushing to Telegram.
  Withings is the trusted upstream, so this is not a network-attacker
  surface. A compromised or buggy Withings response *could* land an
  arbitrarily large `error` string into the audit table for any
  connected user — bounded only by Postgres TEXT column limits. Not
  exploitable today; recorded so the next reader doesn't assume the
  upstream string is trusted-and-bounded everywhere.
- **Recommended fix** (defer): apply the same `slice(0, 1024)` cap inside the `WithingsApiError` constructor (or at the `auditLog` call-site) so the audit-row payload size matches the encrypted-error column behaviour. Belt-and-braces; the practical impact today is zero.

### L-2 `pickCanonicalWorkoutRows` collapses two genuine back-to-back same-source same-activity rows at ≤ 90 s `startedAt` delta
- **File**: `src/lib/workouts/canonical-rows.ts:128-130, 192-259`, batch path `src/app/api/workouts/batch/route.ts:273-298`.
- **Attack vector**: This is not a security vuln — it's a behavioural
  edge-case noted because the focus-area brief asked. Two intentional
  HIIT intervals stamped 30–90 s apart with the same `activityType`
  + same `source` collapse to one. The 90 s window is documented as
  "covers HK's ±60 s smoothing + buffer" and is enforced via inclusive
  `<=` (test: `treats a row exactly at the ±90 s boundary as in-window`).
  No malicious-injection risk: the batch route forces `userId: user.id`
  from the authenticated session (`src/app/api/workouts/batch/route.ts:228`),
  so a forged-source row in one batch can only suppress *another row
  in the same caller's batch* — never a victim user's row (`(userId, source, externalId)` composite unique + the picker grouping key both include `userId`).
- **Recommended fix** (defer): the iOS contract guarantees each
  HKWorkout carries a distinct `endedAt` / `durationSec`; the picker
  could optionally tighten its grouping key to `(activityType, startedAt ± 90 s, endedAt ± 90 s)` so two back-to-back intervals survive even when their starts are 60 s apart. Not required — the legacy read-time picker has the same window for the same reason, and the workout-card UX merges intervals into one row by design.

## Strengths

1. **`returnAllZodIssues` is correctly sanitised + correctly scoped.**
   - `sanitiseZodIssues` returns *only* `{ path: issue.path.join("."), code, message }`. The privacy comment in `src/lib/api-response.ts:9-19, 33-36` explicitly calls out `issue.params` as the data-leak surface, and the test `does NOT echo issue.params (privacy: may contain user input)` (`src/lib/__tests__/api-response-zod.test.ts:84-100`) asserts `Object.keys(issue).sort() === ["code", "message", "path"]`.
   - The `path.join(".")` step produces a plain string — no prototype access happens client-side because the consumer reads `body.details.issues[*].path` as a flat field. Verified via `node -e 'const o = {}; o["__proto__"] = "evil"; console.log(o["__proto__"]);'` → bracket assignment to `__proto__` is silently dropped, so a forged path `["__proto__"]` cannot pollute Object.prototype anywhere downstream.
   - Audit-ledger write in `src/app/api/dashboard/widgets/route.ts:141-157` is scoped to `userId: user.id` (server-resolved from `requireAuth()`); persisted shape is `JSON.stringify({ issues })` where `issues` is the sanitised projection. The integration test `writes one audit-ledger row keyed dashboard.widgets.validation-failed` (`src/app/api/dashboard/widgets/__tests__/route.test.ts:123-145`) asserts `Object.keys(issue).sort() === ["code", "message", "path"]` for every persisted entry.
   - Fire-and-forget audit write is `.catch(() => {})` — a DB hiccup cannot 5xx the 422 contract response (test `does not block the 422 response when the audit-row write rejects`).

2. **Withings off-response classifier is a strict whitelist + conservative default.**
   - Explicit `REAUTH_CODES = {100, 101, 102}` and `PERSISTENT_CODES = {293, 294}` checks run BEFORE the 200..299 range fallback, so a contract-mismatch code that happens to sit inside the OAuth range stays `persistent` instead of incorrectly bucketing as `reauth_required` (`src/lib/withings/response-classifier.ts:173-208`).
   - `persistent` state cannot be triggered by a forged webhook to suppress a victim user's data: the classifier reads Withings' own HTTP response, not the webhook body. The webhook handler `src/lib/withings/webhook-handler.ts:89-160` is authorised via path-segment shared secret + per-IP rate-limit; even with the secret, all it can do is enqueue a real Withings API call for an already-mapped `withingsUserId`. The classification verdict is then driven by Withings' authentic response, not by the attacker.
   - Refresh-token never lands in the error path: `WithingsApiError` carries only `{ verb, classification, withingsStatus, reason, upstreamError }` where `upstreamError` is restricted to `typeof json?.error === "string"`. The refresh token is only POSTed to Withings' token URL; it never appears in any `getEvent()` annotation, `addWarning`, `addExternalCall`, audit row or alert payload (verified by grep on `refreshToken`/`refresh_token` against the diff and against the sync paths).
   - `WithingsApiError.message` format stays compatible with the legacy `extractWithingsStatus` regex — `classifyError` falls back to regex parsing for pg-boss job-retry survivors whose prototype was lost in JSON round-trip (covered by `src/lib/withings/__tests__/response-classifier.test.ts:166-211`).

3. **Write-time workout dedup is user-scoped and tamper-proof.**
   - Group key includes `userId` (`src/lib/workouts/canonical-rows.ts:210-219`), pinned by the test `returns rows from different users untouched even on identical timestamps` (`canonical-rows.test.ts:113-130`).
   - The batch route always overrides client-supplied `userId` with the authenticated `user.id` (`src/app/api/workouts/batch/route.ts:228`), so a malicious client cannot mint a payload row that addresses another user's account.
   - A user who submits a forged `APPLE_HEALTH` row to outrank a `MANUAL` row can only suppress *their own* `MANUAL` row inside the same batch — there is no cross-user trust boundary the source-ladder is defending. (And: the legacy read-time picker on `GET /api/workouts` collapses cross-batch duplicates afterwards via the same ladder, so a future poisoning of the source field would surface across reads anyway.)

4. **`pnpm check-env` does not log or print secret values.**
   - `renderResults` emits only `[OK] <NAME>` / `[MISSING-REQUIRED] <NAME>` / `[missing-optional] <NAME>` — no value substitution path (`scripts/check-env.ts:177-207`).
   - `parseEnvFile` writes the file contents into a plain object and `isPresent` only checks `typeof value === "string" && value.trim().length > 0`; nothing reads back the value to stdout.
   - The `--file` flag controls only the env-source, never the manifest path (`MANIFEST_PATH = resolve(__dirname, "env-manifest.json")` is module-frozen). A malicious env-file with a `__proto__=evil` line is also a non-issue: bracket assignment to `__proto__` is silently dropped by V8 (verified via repro), and even if it landed, `env[n]` reads through bracket access with `n` sourced from the manifest only.
   - Operator-only CLI; no network-attacker surface.

5. **Knip ignore-block scope is correct.**
   - `src/components/ui/**` ignores `exports` + `types` only. Verified by `ls` — every file in the directory is a pure shadcn UI primitive (`alert-dialog`, `dialog`, `dropdown-menu`, `input`, `password-input`, `password-strength`, `select`, `sheet`, `switch`, `table`, `tabs`, `tooltip`, …). No auth, no crypto, no input-validation helper hides under the shadcn prefix.
   - `src/lib/validations/**` ignores `types` only (NOT `exports`). So any genuinely-unused export *would* still trip CI; the ignore-block only spares the Zod-derived `z.infer<typeof …>` aliases that the API contract publishes for the iOS client. Every file in the directory is a Zod schema module by design.
   - The companion knip flip (`20df7b9d`) drops the `--include files,dependencies,binaries,unlisted` scope on the workflow; the gate now runs against every issue knip reports by default. Two ignore-blocks are now the single point of truth for "what knip is muted on."

6. **Re-export cleanup (`dce14fb4`) is complete.**
   - `grep -rn "listSupportedTimezones\|describeInjectionSite"` confirms every real caller already imports from the source path (`@/lib/tz/format` / `@/lib/medications/injection-sites`). No dynamic-import string contains either name.

---

50-word summary follows the report.
