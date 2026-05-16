---
file: .planning/research/v1428-r4-security.md
purpose: R4 security review — endpoint authn/authz, input validation, output sanitisation across the v1.4.28 diff
created: 2026-05-16
contributor: R4 security
---

# v1.4.28 — security review

Scope: every code-touching commit between the `v1.4.27` tag and HEAD on `develop` (40 commits, ~126 files, +4 355 / -8 227). Read-only audit; no patches written. The review focuses on the surfaces the kickoff prompt called out, plus an opportunistic sweep for prompt-injection, secrets, and ambient-authority regressions.

The in-flight release is heavy on deletes (retired weekly-report surface, retired advisor card, retired GLP-1 dashboard tile) plus tight scope additions (web-vitals beacon, range-aware measurement listing, dispatch-localised LRU, status-card timeout envelope, P2002 catch on measurement edit). No new auth primitives, no new session/cookie code, no migrations on the auth lane.

## Severity-grouped findings

### Critical

None. No release-blocker discovered.

### High

**H-1 — Web-vitals beacon has no rate-limit and no origin check.** `src/app/api/internal/web-vitals/route.ts:45` accepts any POST, parses JSON, and writes a wide-event line per request. The route comment explicitly says rate-limiting is "deliberately none" because a real client sends at most six beacons per page load. Attacker model: an unauthenticated peer floods `/api/internal/web-vitals` with bogus payloads (1 000 req/s from a single IP) — the route accepts everything, the wide-event pipeline emits one log line per call, the GlitchTip / log sink absorbs the cost. Same-origin policy does not stop a hostile script outside the browser (curl, headless workers). Fix shape: keep the beacon free of auth, but wrap the route with `checkRateLimit(\`web-vitals:${ip}\`, 60, 60_000)` (same shape as `deploy-webhook`) and drop the body if it does not look like a `Metric` shape (the `name` field is constrained to a six-value enum upstream). Returning 200 on the throttle hit keeps the beacon shape contract intact for legitimate clients.

### Medium

**M-1 — Measurement list `limit` ceiling 5 000 is large enough to leak through to the iOS path.** `src/lib/validations/measurement.ts:249` lifts the per-request `limit` cap to 5 000 specifically for the range-aware path. The Zod schema does not couple `limit` to the presence of `from`/`to`, so a caller can ask for `?limit=5000` without supplying a range and pull 5 000 raw rows on the legacy code path too. The cap is still bounded — it is not a SQL injection (Prisma parameterises) and ownership is enforced via `userId: user.id` on the `where` — but the size of the response (50 KB+ of JSON per request) is now a cheap DoS amplifier for any logged-in account. Fix shape: tighten the schema with `.refine((d) => d.limit <= 500 || (d.from && d.to), ...)` so the 5 000 ceiling only unlocks when a range is supplied, or split the ceiling into two named tiers (`MAX_LIMIT_DEFAULT = 500`, `MAX_LIMIT_RANGE = 5000`).

**M-2 — `dispatch-localised` LRU eviction is FIFO, not true LRU, and read-on-eviction is non-atomic.** `src/lib/notifications/dispatch-localised.ts:122` evicts the head when the map hits 1 000 entries; the read path on a fresh hit does `delete` + re-`set` to mark "fresh". Two concerns: (a) The cache is shared across every user inside the worker process — a high-volume admin alert job dispatching to 1 001 distinct users could thrash the head entry, but the worst case is a re-fetched Prisma row, not a cache poisoning vector. (b) The eviction at line 124 reads `firstKey = localeCache.keys().next().value` and deletes it; if `localeCache.size >= LOCALE_CACHE_MAX` was lucky-true and the entry was already evicted by a concurrent call, `firstKey` is `undefined` and the `delete` is a no-op — accepted, no race condition that lets a stale locale leak across users (each entry is keyed by `userId`). The 30-second TTL window is also small enough that a user-changed locale converges quickly. Treat this as a soft-Medium because the trade-off is documented. Fix shape: a comment is enough; if proven hot, swap to a real LRU library (e.g. `lru-cache`) — not a release blocker.

**M-3 — Coach SSE `enforceBudget` is the only daily cap; no per-minute rate-limit.** `src/app/api/insights/chat/route.ts:11` documents the budget-then-refusal pipeline. The 25 000 tokens-per-user-per-day cap (`src/lib/ai/coach/budget.ts:20`) is the only quantitative gate. A logged-in user can still mount a tight loop that hammers the SSE endpoint until they exhaust the budget; the provider chain absorbs the latency, the wide-event log gets a row per request, and the encrypted persistence layer writes a `MessagePair` per turn. Authentication still bounds the blast radius (cookie / Bearer required), but a compromised session could cost the operator several US dollars in tokens before the day's cap hits. Existing posture is intentional per the kickoff brief; v1.4.28 does not change it. Fix shape: add a per-user-per-minute soft cap (e.g. `checkRateLimit(\`coach:${userId}\`, 6, 60_000)` — six turns per minute is more than any human conversation) on a future iteration; not a v1.4.28 blocker.

### Low

**L-1 — `insights/generate` rate-limit envelope shares wording with the user-visible error path.** `src/app/api/insights/generate/route.ts:238` returns `\`Maximum ${limit} insight generations per hour.\`` on the 429. The string is English-only — the iOS client (the only consumer of `/api/insights/generate` after the advisor card retired) cannot route it through the i18n surface, so it surfaces verbatim. No information leak, but the message exposes the operator's configured `INSIGHTS_RATE_LIMIT_PER_HOUR` value to the client. Trade-off accepted in v1.4.16; flagging for completeness.

**L-2 — Measurement PUT 409 returns a fixed string; PUT body validation rejects negative values via `min(0)`, but legacy values may already exist in DB.** `src/app/api/measurements/[id]/route.ts:88` returns `"A measurement with this timestamp already exists"` — clean, no leak. The `updateMeasurementSchema` (`src/lib/validations/measurement.ts:222`) caps `value` at `[0, 500000]`. Range validation is the create-path job; the update path intentionally relaxes the per-type range check to support legacy edits. Acceptable.

**L-3 — `glp1` POST audit-log details echo the request fields including the raw `note` text.** `src/app/api/medications/[id]/glp1/route.ts:170` writes `details: { doseValue, doseUnit }` (good) but the `inventory` branch at line 200 logs `delta` and `reason` (where `reason` is user-supplied free text). Free-text logging is bounded by the Zod cap on `reason` (verify in `glp1PostBodySchema`); confirmed bounded. No leak, but if any reviewer later changes the cap upward, the audit-log retention window will store user input verbatim. Note for future hardening: redact or hash free-text fields the same way the auth lane already redacts.

**L-4 — Web-vitals route returns 200 on every shape, including malformed bodies.** `src/app/api/internal/web-vitals/route.ts:50-55` silently accepts non-JSON. This is the documented design (beacons must never retry), but it also means the route is a confirmed null-result endpoint for an attacker probing for "live" routes. Combined with H-1, the route is the easiest "I exist" oracle on the API surface. Trade-off acceptable; folded into H-1's fix shape (rate-limit the IP).

## Endpoint-by-endpoint review table

| Endpoint | Auth | Authz / ownership | Input validation | Output sanitisation | Rate-limit | Verdict |
|---|---|---|---|---|---|---|
| `PUT /api/measurements/[id]` | `requireAuth()` | `existing.userId !== user.id` → 404 | `updateMeasurementSchema` Zod | P2002 → fixed-string 409 with `errorCode`; no stack | none (per-record edit, low-burst) | clean |
| `GET /api/measurements` | `requireAuth()` | `where: { userId }` | `listMeasurementsSchema` Zod (from/to ISO with offset, limit ≤5000) | typed JSON, no leak | none on read | **M-1** on `limit` |
| `POST /api/measurements` | `requireAuth()` | userId pinned on create | `createMeasurementSchema` Zod, range refines | P2002 → 409 fixed string | `withIdempotency` dedupe | clean |
| `POST /api/insights/generate` | `requireAuth()` | userId pinned | body `{ force }` parsed lenient | error categorised (401/403/429/5xx); body excerpts truncated to 500 chars in wide-event meta (operator-side only) | `checkRateLimit(insights:${userId}, 10/h)` | clean |
| `POST /api/medications/[id]/intake` | `requireAuth()` | `assertMedicationOwnership(id, user.id)` | `intakeSchema` Zod | event JSON only; no internal stack | `withIdempotency` + 60 s server-side dedup | clean |
| `GET /api/medications/[id]/intake` | `requireAuth()` | `where: { medicationId, userId }` | `listIntakeEventsSchema` Zod | event JSON only | none on read | clean |
| `GET /api/medications/[id]/glp1` | `requireAuth()` | `medication.userId !== user.id` → 404 | n/a (read) | iOS-shaped DTO | none on read | clean |
| `POST /api/medications/[id]/glp1` | `requireAuth()` | `assertMedicationOwnership` | `glp1PostBodySchema` (XOR refinement) | created-row echo, no stack | `checkRateLimit(medication-glp1:post:${user.id}, 30/min)` | clean |
| `POST /api/internal/web-vitals` | none (intentional) | n/a | typed-shape probe, all fields optional | always 200, no body except `{ ok: true }` | none | **H-1** |
| `POST /api/insights/chat` (Coach SSE) | `requireAuth()` (cookie or Bearer) | userId pinned; `coachChatRequestSchema` | refusal pattern + Zod | SSE frames; refusal handled before any provider | `enforceBudget` daily 25 k tokens, no per-minute | **M-3** |
| `POST /api/internal/deploy-webhook` | `hasValidSecret(request)` | n/a | `safeJson` + payload normaliser | normaliser-output JSON, no echo | `checkRateLimit(deploy-webhook:${ip}, 60/min)` | clean (existing) |

## Cross-cutting checks

**Input validation across the diff.** Every changed handler still routes user input through a Zod schema before the Prisma call. The new range-aware `listMeasurementsSchema` parses `from` / `to` via `z.iso.datetime({ offset: true }).transform((s) => new Date(s))` — invalid strings fail the schema with a 422 before the DB sees them. The `aggregate` enum is locked to `["raw", "daily", "weekly"]`. Both `from` and `to` are `Date` instances by the time they reach Prisma, so SQL injection is structurally impossible (Prisma parameterises every `gte` / `lte`). No string concatenation into a query, no raw SQL, no dynamic table names anywhere in the diff.

**Take-cap enforcement at the query.** Spot-checked seven `*-status.ts` files (`pulse`, `bmi`, `general`, `blood-pressure`, `mood`, `weight`, `medication-compliance`). Every changed read site applies a `take:` directly on the Prisma `findMany` call. The largest cap (`general-status.ts:156` — `take: 5000`) is on a multi-type union; the others are `1095` (3 years of daily weight / BP), `365` (1 year of pulse / BMI input), or `90` (mood enrichment). Downstream `applyPayloadBudget` trims further. The kickoff brief asked for "cap enforced at the query, not after-the-fact" — confirmed.

**Provider timeouts.** `src/lib/insights/with-timeout.ts` lands a clean envelope with `STATUS_PROVIDER_TIMEOUT_MS = 20_000`. Both `timedOut` and the upstream catch branch resolve with the fallback — the fallback is intentionally not persisted to the cache (commented at `pulse-status.ts:307`), which prevents cache poisoning from a single stalled upstream call. No leak of the upstream provider's error body to the client.

**Prompt injection on Coach SSE.** Untouched by v1.4.28 — `detectRefusal()` still runs before the provider chain (`src/app/api/insights/chat/route.ts:14`). The new range-aware aggregator passes through ISO `Date` instances and integer counts to the prompt builder, so it cannot smuggle injection material via the `from`/`to` fields. The `notes` field on a measurement is capped at 25 characters by the create schema and the update schema; the value column is numeric. The insights snapshot summary text strips chart tokens via `stripChartTokens` before being shown to the model. No new attack surface.

**SSRF / open redirect.** No new outbound HTTP from any changed handler. The web-vitals route is in-process; the dispatch-localised LRU resolves through Prisma. The insights generate route only fetches via the configured provider chain, which is operator-controlled through Settings. No URL parameters parsed into `fetch()` anywhere in the diff.

**Session / cookie handling.** Unchanged. `getSession()` in `requireAuth` flow is identical to v1.4.27. No new cookies set, no new SameSite changes, no new CSRF token surface (HealthLog is bearer + cookie session, no CSRF by design — documented at `api-handler.ts:32`).

**Secrets in commits or `.env`.** Quick scan over the diff returned one occurrence of `secret = "test-secret-key"` in `src/lib/auth/__tests__/hmac.test.ts` (existing, test-only). No `.env` content committed; the working tree `.env` is untracked and the `.env.example` does not carry live values. No new env variables documented in the v1.4.28 diff.

**iOS contract additive-only check.** The R1.4 audit was not yet on disk at the time of this review, so the iOS contract review was done against the v1.5 iOS handoff pack and the `glp1` / `intake` route shapes. The `GET /api/measurements/[id]`, `PUT`, and `DELETE` shapes are unchanged from v1.4.27 — the new P2002 catch is additive (it converts a former 500 into a clean 409 + `errorCode`). The `GET /api/medications/[id]/glp1` response shape is unchanged. The `POST /api/medications/[id]/intake` body and response shape are unchanged. The new `aggregate` query parameter on `GET /api/measurements` is opt-in — iOS clients that do not pass `from` / `to` / `aggregate` see the historical wire shape (the `if (from && to)` branch at `route.ts:62` is the only one that returns the new `{ type, value, measuredAt, count }` shape). No iOS contract regression on the security lane.

**Audit-log writes.** Every changed write path retains its `auditLog(...)` call (`measurement.update` / `medication.intake` / `medication.glp1.update` / `insights.generate`). The `evictPerStatusInsightCache` keeps the `insights.generate` row and only deletes the `insights.<scope>-status.<locale>` cache entries — no audit-log loss.

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 (H-1, web-vitals rate-limit) |
| Medium | 3 (M-1 limit ceiling, M-2 LRU FIFO, M-3 Coach per-minute) |
| Low | 4 |

**Top risk:** the new `/api/internal/web-vitals` route is unauthenticated, un-rate-limited, and emits one wide-event line per request. A trivial flood from a single peer amplifies into log-pipeline cost. Recommend folding a per-IP `checkRateLimit(...)` into the handler before tag — same shape as `deploy-webhook`. Fix is contained, additive, and does not change the beacon's public contract.

**Go / no-go:** **go**, with H-1 landed as a follow-up commit on `develop` before the release-PR opens. The four Mediums + four Lows are documented; they do not block the v1.4.28 tag. M-3 (Coach per-minute) is the longest-standing posture decision and stays as-is per the kickoff brief.

Hand-off to R4 reconcile: stage H-1 as a `fix(api): rate-limit the web-vitals beacon` commit. Schema-side tightening for M-1 can ride in the same commit if time permits — otherwise carry to v1.4.29 backlog with `M-1: gate the 5 000 limit ceiling behind from/to presence`.
