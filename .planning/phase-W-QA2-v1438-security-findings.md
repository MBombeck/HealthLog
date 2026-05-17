# W-QA-2 — v1.4.38 Security Audit

**Scope**: `v1.4.37.2..HEAD` on `develop`
**Mode**: READ-ONLY, security lane
**Date**: 2026-05-17

## Severity counts

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 2 |
| Informational | 1 |
| Confirmed-safe | 7 |

---

## Medium

### M-1 — `User.timezone` accepted unvalidated; new SQL aggregate fails-open to PG error
**Where**: `src/lib/auth/profile-update.ts:14` (`timezone: z.string().min(1).max(64).optional()`) → reaches `src/app/api/dashboard/summary/route.ts:374` (`to_char(m."measured_at" AT TIME ZONE ${userTz}, 'YYYY-MM-DD')`) and the cross-tz fast-path callers via `resolveUserTimezone`.

**Finding**: The profile-update schema validates the timezone string only as a 1–64 char string. The `isValidTimezone()` helper exists in `src/lib/tz/format.ts:22` and is invoked at **read** time (`resolveUserTimezone`, `resolveServerDefaultTimezone`), but **not** at the write path. A user can PUT `{ timezone: "garbage" }` to `/api/auth/profile` or PATCH `/api/user/profile` and the column will be persisted.

**Blast radius (v1.4.38-new)**:
1. `GET /api/dashboard/summary` runs `prisma.$queryRaw` with `AT TIME ZONE ${userTz}` where `${userTz}` is bound as a parameter (so no classic SQL-injection), but Postgres will raise `invalid_parameter_value` for an unknown IANA zone → 500 response. Per-user self-DoS only (read-path own-user-only).
2. The cross-tz fast-paths (`bp-in-target`, `correlations`) and every other consumer of `userDayKey()` fall through to `DEFAULT_TIMEZONE = "Europe/Berlin"` so they are resilient. The W-A `isNearUtc(userTz, now)` guard accepts invalid TZ → returns `true` → would force the rollup path for a Berlin-equivalent user — defensible per the helper's docstring but inconsistent with the SQL aggregate's hard-fail.

**Authorization-scope finding for W-A fallback**: the live-SQL fallback in `bp-in-target-fast-path.ts:425`, `correlations-fast-path.ts:338`, and `health-score-fast-path.ts:202` consistently scopes every `findMany` on `{ userId }`. No cross-tenant leakage path. The rollup path also scopes on `userId` in `readRollupBuckets`. The tz_guard is purely a performance/correctness toggle; it does not affect authorization. CONFIRMED-SAFE on the scope-leak question.

**Recommendation**: Add `.refine(isValidTimezone, "Invalid IANA timezone")` to the schema in `src/lib/auth/profile-update.ts:14`. Pre-tag fix is one line; the failing read becomes a 422 on the write instead of a self-DoS on the read.

---

## Low

### L-1 — `correlations-fast-path.ts` rollup path emits `degraded: false` unconditionally
**Where**: `src/lib/analytics/correlations-fast-path.ts:319`

**Finding**: The `degraded` field is hard-coded `false` on both branches with a `TODO(v1.5)` annotation. Surface stability concern: a future load-shedding branch may flip the flag but the helper's `path` annotate is the only operator signal today. Not a security finding; called out as the only behavioral pin worth a doc-comment review pre-tag.

**Recommendation**: None pre-tag; the TODO is explicit (commit `41506c7a`).

### L-2 — Drill-down 422 cap can be bypassed by omitting `dayKey`
**Where**: `src/lib/validations/measurement.ts:336`

**Finding**: Verified the Zod `.refine` triggers when `dayKey != null && limit > 1000` returns 422. Confirmed the route at `src/app/api/measurements/route.ts:107` reads `limit` straight through with no second clamp — relies entirely on the validator. The path is **un-bypassable** for `dayKey` requests. Caller asking `limit=999&dayKey=…` is allowed (within validator cap); `limit=1001&dayKey=…` fails-validation; `limit=5000` without `dayKey` takes the legacy 5000-row cap (intentional, FB-D2 windowed path). No bypass.

**Verified**: Test suite at `src/lib/validations/__tests__/measurement.test.ts:243-272` covers the boundary (1000 accepted, 1001 rejected).

---

## Informational

### I-1 — Cross-tz live-path fallback has the same `userId` scoping as rollup path (verified)
The live fallbacks introduced in W-A are byte-for-byte equivalent on the auth surface — every `prisma.measurement.findMany` carries `{ userId, type, measuredAt: { gte: since } }`. The `userTz` parameter is consumed only for `userDayKey(measuredAt, userTz)` re-keying inside the in-process aggregation; it never reaches a WHERE clause or a Prisma-raw substitution at this layer. No scope-leak risk.

---

## Confirmed-safe

### CS-1 — W-C Coach API gate inventory (route-discovery test)
- `GET/DELETE /api/insights/chat/[id]` (lines 32, 55) and `POST /api/insights/chat/messages/[id]/feedback` (line 63) now call `requireAssistantSurface("coach")` after `requireAuth` and **before** any data access or rate-limit work.
- The discovery test at `src/app/api/insights/__tests__/coach-route-gate-inventory.test.ts` (commit `1eb00389` + comment-skip refinement `5ecc3152`) walks every `route.ts` under `/api/insights/**` and groups handlers into Coach-gated / sibling-gated / non-Coach-owned. Orphans fail by name. The non-Coach allowlist (provider-chain, settings, feedback, glp1-timeline, targets) is documented inline with rationale.
- The `apiHandler` catch at `src/lib/api-handler.ts:166` maps `AssistantDisabledError` → 403 + `{ data: null, error, meta: { errorCode: "assistant.disabled.coach" } }` — locked iOS contract. Verified the catch fires before `reportToGlitchtip`, so a disabled-surface 403 does **not** noisy-alert ops.
- Manual sweep of all 18 routes under `/api/insights/` confirms every Coach-owned handler (`chat/route.ts`, `chat/[id]/route.ts`, `chat/messages/[id]/feedback/route.ts`, `comprehensive/route.ts`, `generate/route.ts`) carries the gate; no orphans.

### CS-2 — W-B `looksLikeIp` strictness (node:net.isIP)
- `src/lib/api-response.ts:100` uses `isIP(s) !== 0` (returns 4/6 for valid v4/v6, 0 for invalid). Test coverage at `src/lib/__tests__/get-client-ip.test.ts:109-136` pins:
  - rejects `1.2`, `:::`, `gg:hh::1` (previously accepted by the hex/dot regex);
  - **accepts** `2001:db8::1` (well-formed IPv6);
  - accepts every well-formed IPv4 chain entry.
- The `cf-connecting-ip` branch (`readCfConnectingIp`, line 116) is correctly gated on `TRUST_CF_CONNECTING_IP === "1"` (exact string match — `"true"` and `"yes"` correctly rejected, per test line 215). Behind the flag, the trimmed header is fed through the same `looksLikeIp` validator before being returned. No regression for valid IPv4/IPv6 visitors.

### CS-3 — W-B drill-down cap via Zod refine
See L-2 above. Cannot be bypassed via `limit=999&dayKey=…` (within cap); cannot be bypassed via wider `limit` without `dayKey` (legacy 5000 cap applies to the windowed chart-data path, not the drill-down).

### CS-4 — W-A cross-tz fallback authorization parity
See I-1. Live and rollup paths use identical `{ userId }` scoping. The `tz_guard` annotate exposes only the branch decision, not user data.

### CS-5 — W-F medication-intake cache invalidation completeness
- `invalidateUserMedications` (`src/lib/cache/invalidate.ts:63`) now evicts `caches.analytics.deleteByPrefix(\`${userId}|\`)` in addition to the medication-specific caches (commit `f2f1e5f0` + the v1.4.38 W-F line 74 addition).
- Verified call-sites in every medication write path: `/api/medications/route.ts`, `/api/medications/intake/route.ts`, `/api/medications/intake/bulk/route.ts`, `/api/medications/[id]/route.ts`, `/api/medications/[id]/intake/route.ts`, `/api/medications/[id]/intake/[eventId]/route.ts`.
- Mood (`invalidateUserMood`) and measurements (`invalidateUserMeasurements`) **already** evict `caches.analytics` (lines 31, 51). Verified write paths: `/api/mood-entries/route.ts:130`, `/api/mood-entries/bulk/route.ts:218`, `/api/mood-entries/[id]/route.ts:113,145`, `/api/measurements/route.ts:472,549`, `/api/measurements/batch/route.ts:379`, `/api/measurements/by-external-ids/route.ts:124`, `/api/measurements/[id]/route.ts:114,176`, `/api/workouts/batch/route.ts:532`.
- The dashboard/summary cache (under `caches.analytics`) is therefore consistently invalidated by every measurement, mood, AND medication write path. No missing hook.

### CS-6 — W-E i18n no AI/Claude/marathon/phase leak in es/fr/it/pl
- The German source uses `phase*` keys exclusively for the reminder-phase domain term (`phaseGreen/Yellow/Orange/Red`, `phaseBeforeEnd`, `phaseAfterEnd`); all four new-locale translations follow the same domain pattern. No release-jargon leak.
- The only `Claude` strings in es/fr/it/pl appear inside the operator-facing `"anthropic": "Anthropic (Claude)"` settings dropdown label — intentional (operator picks the brand), matches the German source one-for-one.
- The Italian `ai` matches are the Italian preposition "a" + "i" ("ai farmaci" = "to the medications"), not the English "AI" acronym.
- Settings-page `"ai"` key (line 1622, 1769, 2326) is a path key, not display copy.
- No `Claude/claude/AI assistant/marathon/phase X` user-facing leaks introduced by the W-E commits.

### CS-7 — v1.4.37 security posture regression check
- `src/proxy.ts` (HSTS + CSP + TRUST_CF_CONNECTING_IP plumbing) and `src/lib/auth/session.ts` (session destruction): **unchanged** in `v1.4.37.2..HEAD` (`git diff` returns empty). v1.4.37 hardening preserved.
- `ensureUserRollupsFresh` fire-and-forget pattern unchanged on the read path (in-flight dedup added at `src/lib/measurements/rollups.ts:582-622`, commit `4e284235` — purely a perf de-duplication, no security surface change). The `getEvent()?.addWarning` annotation introduced in commit `234fb723` for the swallowed error keeps the silent-failure invariant Marc documented.
- `/.well-known/` and 404 fall-through behavior: untouched in scope.

---

## Most-important pre-tag finding

**M-1: timezone-write validation gap.** One-line fix in `src/lib/auth/profile-update.ts:14`: add `.refine(isValidTimezone, "Invalid IANA timezone")` (or chain to the existing schema). Without it, a user can self-DoS the dashboard/summary route post-v1.4.38 because the new `to_char(... AT TIME ZONE ${userTz}, ...)` aggregate hard-fails on an invalid zone where the legacy JS path silently fell back. Single-user blast radius (own request only — no cross-tenant), but it's a regression introduced by the W-F SQL rewrite and worth catching before tag.

## v1.4.37 posture regression: none

All seven items confirmed unchanged: session destruction, `/.well-known/`, HSTS, CSP, TRUST_CF_CONNECTING_IP, `ensureUserRollupsFresh` fire-and-forget, and the Coach 403 envelope contract.
