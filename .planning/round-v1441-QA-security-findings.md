# v1.4.41 Security-review findings

Scope: `git diff main..develop` (23 commits, v1.4.41 vs live v1.4.40).
Reviewer: W10 security-reviewer (read-only).

## Verdict
APPROVE_WITH_FIXES

One High that should land before tag (rate-limit on `/api/auth/check-user`). All
other focus-area items pass. No Critical / data-leak / auth-bypass findings.

## Critical (must fix before tag — vuln / data leak / auth bypass)

None.

## High (should fix before tag — defence-in-depth gap, log leak, error swallow)

### H-1 `/api/auth/check-user` has zero rate-limiting; the JSDoc rationale is factually wrong
- **File**: `src/app/api/auth/check-user/route.ts:28-32, 53-95`
- **Attack vector**: The route discloses account-existence (`branch != "not_found"`)
  plus credential-shape (`hasPasskey`, `hasPassword`) for any submitted identifier.
  This is by design for iOS onboarding, but the source comment claims:
  > *"No rate-limit middleware added here; the higher-level edge limit on
  > `/api/auth/*` covers brute-force enumeration concerns, and the route is
  > functionally equivalent in information leak to the existing
  > `/api/auth/passkey/login-options` request that already accepts an identifier."*

  Both claims are wrong:
  1. There is no `middleware.ts` anywhere in the repo (`find . -name "middleware.ts"`
     returns empty); rate-limiting is per-route via `checkRateLimit()`. Sibling
     routes implement it explicitly — `auth/login`: `5/15min`,
     `auth/register`, `auth/passkey/login-options`: `10/15min`,
     `auth/refresh`, `auth/me/research-mode`: `5/min`. **`check-user` is the only
     unauth POST under `/api/auth/*` without per-IP rate-limit.**
  2. `auth/passkey/login-options/route.ts` does NOT accept an identifier — it
     reads no request body and returns a WebAuthn challenge that does not
     disclose user existence. So check-user is not "functionally equivalent" in
     leak; it is strictly more powerful.

  The contract itself (intentional enumeration) is acceptable for the iOS
  onboarding UX. The omission of a brute-force throttle is not — an attacker
  can probe the entire user base at HTTP line rate.
- **Recommended fix**: add a per-IP throttle mirroring `login-options`:
  ```ts
  const ip = getClientIp(request) ?? "unknown";
  const rl = await checkRateLimit(`auth:check-user:${ip}`, 10, 15 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Too many requests. Please try again later." },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }
  ```
  Also delete or correct the misleading "edge limit on `/api/auth/*` covers …"
  paragraph in the file header so the next reader doesn't repeat the assumption.

## Medium (recommended for tag)

None.

## Low (defer to v1.4.42)

### L-1 `/api/auth/check-user` timing side-channel on the `not_found` branch
- **File**: `src/app/api/auth/check-user/route.ts:65-83`
- **Attack vector**: The `not_found` branch returns immediately after `findFirst`
  with `select { id, passwordHash, _count: { passkeys } }`; the relational
  `_count` on the passkey relation costs a roundtrip vs. a flat user row, so
  a found user with N>0 passkeys is marginally slower than a `not_found`.
  Acceptable now (Postgres ms-range, swamped by network jitter), but if the
  contract is "enumeration is the explicit feature", the timing channel should
  not be the *backup* enumeration affordance.
- **Recommended fix** (defer): align timing by issuing the same shape query
  on the `not_found` path, or add a small randomised jitter (5–25 ms). Not
  required for tag — the explicit `branch` field already discloses the same
  information.

### L-2 `auth.check-user` is not audit-logged
- **File**: `src/app/api/auth/check-user/route.ts:77, 93`
- **Attack vector**: The route calls `annotate({ action: { name: "auth.check-user" } })`
  for the wide-event log but never calls `auditLog(...)`. Sibling routes
  (`login`, `register`, `password`, `passkey/login-verify`) emit `auth.login.failed`
  / `auth.register.success` / etc. into `auditLog` so they show up in the
  admin status timeline. If H-1 lands and the throttle ever fires, there'll
  be no `auditLog` row showing "the throttle clipped a burst". Wide events
  are sampled and not retained as long as `auditLog`.
- **Recommended fix** (defer): emit `auth.check-user` to `auditLog` with
  `{ ipAddress, identifier_hash }` (hash, not raw email) so the admin
  timeline carries the enumeration probe trail without storing PII. Defer
  to v1.4.42 — the wide-event annotation is enough for short-term
  diagnostics.

### L-3 `editMessageReplyMarkup` deletion — leaked-via-error log warning gone
- **File**: `src/lib/telegram.ts` (deleted lines 115-134 of pre-diff)
- **Attack vector**: None now — there is no remaining caller (`grep -rn
  editMessageReplyMarkup` is clean). Noting only because the deleted helper
  was the one Telegram-API surface that swallowed `json.ok=false` into a
  warning instead of a hard throw. If a future contributor restores it,
  they should restore the throw, not the warn.
- **Recommended fix**: nothing required.

## Strengths

1. **Soft-delete fix-ups are comprehensive, not headline-only.**
   - `/api/export/full-backup/route.ts`, `/api/export/measurements/route.ts`,
     `/api/export/route.ts` — every `measurement.findMany` in the changed
     files gets `deletedAt: null` (verified by full grep — single read per
     file, all filtered).
   - `/api/gamification/achievements/route.ts:531-549` — the measurement
     branch of the `Promise.all` is filtered; the sibling reads
     (`medicationIntakeEvent`, `moodEntry`, `passkey`, `auditLog`) correctly
     stay unfiltered because those tables don't have `deletedAt` columns
     (verified against `prisma/schema.prisma`).
   - `/api/doctor-report/availability/route.ts:58-98` — all four
     `measurement.count` reads filter; the `moodEntry` and
     `medicationIntakeEvent` counts correctly do not (no `deletedAt` col).
   - `src/lib/doctor-report-data.ts:275-281` — the headline aggregator
     is the single measurement read in the file.
   - `/api/admin/status/route.ts:38-44` — count corrected too.

2. **Timeout-stub persist (`27f3bec1`) is safe.**
   No user-controlled input lands in the persisted `auditLog.details`:
   - `userId`: server-resolved from the auth context, route-side.
   - `cacheAction`: `` `insights.blood-pressure-status.${locale}` `` /
     `` `…weight-status.${locale}` ``, where `locale` is clamped by
     `normalizeLocale(...)` to `"en" | "de"` (literal switch — no other
     value can escape).
   - `text`: `getNoKey{BP,Weight}StatusText(locale)` — deterministic
     localized constant string, no PII.
   - `providerType`: internal enum.
   - `model: "timeout-stub"`: literal.
   The write is also wrapped in `try { … } catch {}` so a stub-persist
   failure cannot turn the parent request into a 5xx. Mirrors the v1.4.37
   `bmi-status` precedent.

3. **`projectTodayIntakesAndRecompute` (`54ad5cdb`) cannot mint rows for
   arbitrary users.** Both callers — `src/app/api/medications/intake/route.ts:69-70`
   and `src/app/api/dashboard/summary/route.ts:232` — gate on
   `requireAuth()` before passing `user.id`. The helper itself reads
   `medication { where: { userId, active: true } }` so even a forged
   `userId` would yield zero schedules and a no-op `createMany`. The
   `(userId, medicationId, scheduledFor, source)` unique constraint plus
   `skipDuplicates: true` is correct defence-in-depth — a stale projection
   from a concurrent caller cannot duplicate-mint a row.

4. **`editMessageReplyMarkup` deletion (`70ff3eef`) is complete.** No
   remaining caller in `src/` (verified). The helper was an internal
   wrapper around `editMessageReplyMarkup` — no public route reachable,
   no fail-open path possible from its removal.

5. **AI prompts unification (`8a56f482`) is a pure rename.** `git log
   --diff-filter=R -M` confirms 100% similarity on both moved files
   (`prompt.ts` → `insight-system-prompt.ts`, `prompt-compact.ts` →
   `compact-sections.ts`). No new user-text concatenation; the
   pre-existing `sanitizeForPrompt(..., maxLength)` envelope around
   user-text fields (`medication.name`, `medication.dose`,
   `doseChange.note`, `ctx.drug`, `ctx.doseUnit`) is untouched and still
   the sole entry-point for user-supplied prose into LLM prompts.

6. **Pure relocation / type-extraction commits are inert.** `8cfb1715`
   (WMY + cumulative readers → `src/lib/rollups/`), the `BackupRow` /
   `BackupsList` move to `src/types/backups.ts`, and the `AnalyticsData`
   consolidation are all import-renames with no behaviour change —
   verified against the diff stats and the rename detection output.

---

50-word summary follows the report.
