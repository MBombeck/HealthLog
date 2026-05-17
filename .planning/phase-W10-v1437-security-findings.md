# Phase W10 — v1.4.37 Security Findings

**Scope:** `v1.4.36..HEAD` on `develop` (98 files, +8954 / −1306). Read-only audit; this file is the only write.

**Outcome:** No Critical / High issues. Two Medium observations (operator-doc + cache-fanout). Three Low / cosmetic. Eight items explicitly re-confirmed safe. The v1.4.36 security posture is unchanged — no regression.

Ranking: Critical → High → Medium → Low → Confirmed safe.

---

## Critical

_None._

---

## High

_None._

---

## Medium

### M-1 — `.env.example` for `TRUST_CF_CONNECTING_IP` does not list the audit-log forgery vector explicitly

- **Path:** `/Users/marc/Projects/HealthLog/.env.example:113-124`
- **Threat model:** The current comment block warns "an attacker can set the header directly on the public internet and the geo resolver would happily report a forged location". That correctly covers the geo backfill, but it understates that `getClientIp` is the bucket key for the IP-rate-limiter in `src/lib/api-response.ts` and the `ipAddress` column on `audit_logs`. An operator who deploys behind nginx (or anything other than Cloudflare) and copy-pastes `TRUST_CF_CONNECTING_IP=1` from a forum thread would let any caller:
  - rotate `cf-connecting-ip` per request and defeat the IP-keyed rate-limit on login / chat / coach;
  - poison the admin sign-in overview's "Standort" column with a chosen IP per request;
  - forge the IP recorded against every `medication.intake` / `measurement.create` audit row.
- **Recommendation:** Extend the comment to (a) name rate-limit + audit-log as additional consumers, and (b) say *"set ONLY behind Cloudflare; if you also use Caddy / nginx / direct, leave unset"*. The code-level gate is already correct (strict `=== "1"`, length-bounded, ipv4/ipv6 regex via `looksLikeIp`); the gap is purely documentation discoverability.

### M-2 — `geo-backfill` cron has no per-process concurrency guard

- **Path:** `/Users/marc/Projects/HealthLog/src/lib/jobs/geo-backfill.ts:60-132`, `/Users/marc/Projects/HealthLog/src/lib/jobs/reminder-worker.ts:1192-1208`
- **Threat model:** Not a leak — a budget concern. The hourly `40 * * * *` cron caps each pass at 5000 rows, but on a multi-container reminder-worker deployment two workers can pick the same scheduled run and the cap becomes 5000 × N. If the offline MMDB is missing (the warned-once branch) every row falls through to the `ipwho.is` HTTPS path with a 3 s `AbortSignal.timeout`. Worst case = 5000 × N × outbound HTTPS lookups per hour against a free third-party endpoint — risks getting the IP blocked by ipwho.is rate-limiting, which would degrade the admin "Standort" column for every host on that IP.
- **Recommendation:** Either (a) document that the worker is single-instance (already true today per the deploy topology, but not asserted in code), or (b) add a `singletonKey`/advisory-lock guard around `handleGeoBackfill` similar to the other workers. Optional follow-up — not a release blocker for v1.4.37.

---

## Low

### L-1 — `MedicationIntakeQuickAdd` re-fetches `/api/medications` instead of reusing the parent dashboard's cached set

- **Path:** `/Users/marc/Projects/HealthLog/src/components/dashboard/medication-intake-quick-add.tsx:161-169`
- **Threat model:** None — the route is fully `requireAuth()` + `userId`-scoped (`/Users/marc/Projects/HealthLog/src/app/api/medications/route.ts:82-93`). Worth a Low note only because every Sheet open issues a fresh `/api/medications` GET even when the parent dashboard already holds the data via `queryKeys.medications()`. Behavioural, not a security regression.
- **Recommendation:** None for the security gate. Hand to the code-quality reviewer if dedup is desired.

### L-2 — Arztbericht hero card uses `credentials: "include"` on a same-origin fetch

- **Path:** `/Users/marc/Projects/HealthLog/src/components/settings/arztbericht-hero-card.tsx:72,94`
- **Threat model:** No-op for same-origin. The default `same-origin` would have shipped cookies identically; `include` only matters cross-origin. Cosmetic — does not weaken the auth gate on `/api/doctor-report` (which still runs `requireAuth()`).
- **Recommendation:** Drop the redundant `credentials: "include"` for consistency with the rest of the codebase, or leave as defence-in-depth.

### L-3 — Onboarding checklist + e2e fixtures mention `MBombeck/HealthLog` GitHub URL in production code path

- **Path:** `/Users/marc/Projects/HealthLog/src/lib/geo.ts:204-206`
- **Threat model:** Not a v1.4.37 change (predates the release), but the W10 audit re-confirms it. The admin-only notification body for the "offline geo unavailable" branch carries the repo URL — only sent to ADMIN users, only over the in-app notification channel, never user-facing. The grep raised no PII alongside it.
- **Recommendation:** No action.

---

## Confirmed safe (explicit checklist re-walked)

### S-1 — `TRUST_CF_CONNECTING_IP` flag-check is strict

- `src/lib/api-response.ts:106` reads `process.env.TRUST_CF_CONNECTING_IP !== "1"`. Empty string, `undefined`, `"true"`, `"0"`, `"yes"` all evaluate as off. Test pin: `/Users/marc/Projects/HealthLog/src/lib/__tests__/get-client-ip.test.ts:181-189` (`"true"` rejected).
- Fallback chain (XFF → x-real-ip → null) preserved when the flag is off — `getClientIp` line 161 short-circuits only on a positive `cfIp`, otherwise drops straight into the legacy XFF block.
- Header value is validated through `looksLikeIp` (length 3–45, charset `[0-9a-fA-F.:]`) before return. Malformed values rejected — test pin at `get-client-ip.test.ts:200-208`.

### S-2 — `getClientIpOrTrustWarning` retains the trust-violation warning behaviour

- `src/lib/api-response.ts:202-239` mirrors the same CF-preference branch as `getClientIp`, and the warning fires through `warnTrustViolationOnce` when the XFF chain length disagrees with `TRUST_PROXY_HOPS`. Posture from F-6 (v1.4.34.5) intact.

### S-3 — `geo-backfill` does not log raw IPs anywhere user-visible

- `src/lib/jobs/geo-backfill.ts` only emits counts (`scanned/located/carrierResolved/stillUnresolved`) into the `WideEventBuilder` (`reminder-worker.ts:1198-1201`). No IP leaves the worker log line. The third-party call path is exclusively `lookupIpLocation` → `lookupIpLocationOffline` (MMDB) → `lookupIpLocationOnline` (ipwho.is HTTPS, env-gated via `IP_GEO_LOOKUP_DISABLED`). Private-IP short-circuit at `src/lib/geo.ts:323`. No additional third-party endpoint introduced.

### S-4 — `MedicationIntakeQuickAdd` POSTs to the existing auth-gated intake endpoint

- Submit body matches `intakeSchema` (`{ takenAt, skipped: false }`); medication-id comes from the path. Route enforces `requireAuth()` (line 28), `assertMedicationOwnership(id, user.id)` (line 32), Zod `intakeSchema.safeParse` (line 38), and writes with `userId: user.id` (line 79). No new authz bypass introduced.
- The picker's `useQuery` against `/api/medications` returns only the authenticated user's rows (`src/app/api/medications/route.ts:35,82-93`).
- Dose field is editable client-side for confirmation only; the wire body never carries `dose` — the route's schema rejects extra fields silently because it does not enumerate them. No risk of dose-override forgery.

### S-5 — `GET /api/measurements` groupBy=day / dayKey paths are user + timezone safe

- Both branches enter the `where` block with `userId: user.id` first (`src/app/api/measurements/route.ts:64,100,133`). No query-param can shadow it.
- `dayKey` is parsed against `^\d{4}-\d{2}-\d{2}$` (`src/lib/validations/measurement.ts:289`) and resolved through the user's stored `User.timezone` (line 84), never a client-supplied tz string. Cross-user data leakage from a UTC-day boundary is impossible — every user resolves their own day in their own zone.
- `groupBy=day` path scans up to `limit` (Zod-capped at 5000 via `listMeasurementsSchema`). `dayKey` drill-down further caps to `Math.min(limit, 1000)` (line 107). Pagination disabled on the grouped path per `c7480e90` is sound — the response is already a single bounded slice, not a windowable cursor.

### S-6 — W5 Coach disable cascade — actual network silence + server gate

- Client gate at `useFeatureFlags().coach` (`src/hooks/use-feature-flags.ts:79-99`) — when off, every Coach-bearing surface short-circuits before mount: `<CoachDrawer>` (`src/app/targets/page.tsx:296-305`), `<HeroStrip>` action row + suggested prompts strip (`src/components/insights/hero-strip.tsx:219-275`), `<TargetCard>` CTA (test pin `src/app/__tests__/targets-coach-mount.test.tsx`).
- SSR invariant test `src/lib/feature-flags/__tests__/coach-cascade.test.tsx` walks every Coach surface and asserts no DOM trace when `coach: false`.
- Server gate `requireAssistantSurface("coach")` still mounted on `/api/insights/chat`, `/api/insights/generate`, `/api/insights/comprehensive`. Flag source is `AppSettings.singleton` — operator-controlled, not per-user. A client that bypasses the UI gets a 403 `assistant.disabled.coach`.

### S-7 — `IntakeHistoryListV2` status filter cannot leak cross-user data

- `?status=` validated by Zod enum `["all","taken","skipped","completed"]` with safe default `"all"` (`src/lib/validations/medication.ts:106-110`).
- Route appends the status filter on top of the always-present `{ medicationId, userId: user.id }` where-clause (`src/app/api/medications/[id]/intake/route.ts:204`). `assertMedicationOwnership` runs first (line 171). No way to enumerate other users' intakes regardless of `status` value.

### S-8 — W7a Arztbericht hero card reuses the auth-gated PDF flow

- POST goes to `/api/doctor-report` unchanged; the existing `requireAuth()` gate remains the only path to the PDF generator.
- Value-statement copy (de/en checked, six locales total in the diff) describes capabilities only — "vitals, BMI, blood-pressure classification, medication compliance and (optionally) mood". No personal name, no BD-Zielbereich numbers, no measurement counts. Conforms to the no-PII-in-user-facing rule.

### S-9 — Existing posture re-confirmed not regressed

- `next.config.ts` has no diff in `v1.4.36..HEAD` — bfcache `Permissions-Policy: unload=()`, `Cache-Control` cookie-page rule, `outputFileTracingIncludes` for the safety-contracts YAML are intact.
- No diff under `src/lib/auth/*`, `src/middleware*`, `src/app/api/auth*`. Session-destruction transaction, `/.well-known/` proxy bypass (lives outside the Next.js layer), HSTS preload + CSP (delivered at the Coolify edge) all untouched.
- New `*-fast-path.ts` analytics modules under `src/lib/analytics/` all flow `userId: string` through every Prisma query (`bp-in-target-fast-path.ts:154,161,315,362`; `correlations-fast-path.ts:152-154,179`; `health-score-fast-path.ts:146,169,183,212,221,228,248`). No raw SQL string interpolation, no cross-user reads.

---

## Brief-back (≤200 words)

**Severity count.** 0 Critical · 0 High · 2 Medium · 3 Low · 9 Confirmed-safe.

**Single most-important finding before tag.** M-1: tighten the `.env.example` block for `TRUST_CF_CONNECTING_IP` to name *both* downstream consumers — IP-rate-limit bucket key + `audit_logs.ipAddress` column — and explicitly say "only set behind Cloudflare; nginx / Caddy / direct = leave off". The code gate is correct (strict `=== "1"`, regex-validated value, tests pin the fallback), but a self-host operator who misreads the docs and toggles the flag on a non-CF deployment would let any caller forge their IP across rate-limiter, audit log, and admin sign-in overview. Doc-only fix; safe to apply pre-tag.

**Regression check.** None. The eight axes called out by the W10 charter (`TRUST_CF_CONNECTING_IP` semantics, `geo-backfill` budget, medication-quick-add authz, measurements `groupBy=day`/`dayKey` user+tz scoping, Coach disable cascade UI+server, intake-history `?status` Zod gate, Arztbericht hero auth+PII, baseline session/CSP/HSTS/well-known) all re-verified against `v1.4.36..HEAD`. The v1.4.36 posture is intact across every checked axis.
