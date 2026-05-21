# v1.4.40 Security Review

**Reviewer**: security (read-only)
**Range**: `v1.4.39.4..develop` (HEAD `a35e9b30`), 55 commits, 11 waves
**Scope**: new SQL surface (migration 0074 / `ConsentReceipt`), 4 new API routes (consent POST/GET/DELETE, notifications/status), AASA well-known, privacy page, APNs interruption-level, deletedAt full-wire, mood-rollup insights swap, knip CI

## Critical

_None._

## High

_None._

## Medium

### M-1 — Consent artefact cap is by character count, not bytes

`src/lib/validations/consent.ts:40` enforces `.max(64 * 1024)` on the artefact string. Zod `.max()` on a string counts UTF-16 code units, not bytes. The doc-comment claims "64 KB" but the practical worst-case is up to ~256 KB on the wire if a client deliberately stuffs 4-byte UTF-8 code points (or surrogate pairs). The published contract is "base64 PDF or signed JWT" — both pure ASCII — so a well-behaved client never gets close, and Next.js' default ~1 MB request limit bounds the upstream parser regardless. Severity is Medium rather than High because the audit-table abuse vector is small and Next still caps body buffering, but the cap should use a byte-count helper (`Buffer.byteLength(artefact, "utf8") <= 64 * 1024`) before insert to honour the comment.

- File: `src/lib/validations/consent.ts:33-40`

## Low

### L-1 — `safeJson` has no explicit body-size cap

`src/lib/api-response.ts:48-61` calls `request.json()` without bounding the body. Next.js' default request limit (~1 MB on a Node runtime) is the only ceiling. Consent POST is documented as a few-KB-to-32-KB payload; an attacker can still buffer up to ~1 MB before the artefact's own `.max()` check fires. Combined with M-1, this is the layer that defines the real worst-case in-memory footprint. Acceptable for now; consider a `route.config` body-size override on consent + future write endpoints.

### L-2 — APNs `category` echoed to the device equals the event-type

`src/lib/notifications/senders/apns.ts:456` sets `category: payload.eventType`. The same string is already passed via `data.eventType`, so the category field does not add new disclosure — but the iOS app receives the full canonical category name (`MOOD_REMINDER`, `WITHINGS_SYNC_FAILED`, etc.) on every push. That's authenticated user → their own device, so it is not a tenant leak. Flagged Low only because the brief asked the field be reviewed; the gating itself is correct.

## Item-by-item verdict (brief)

1. **AASA payload** (`src/app/.well-known/apple-app-site-association/route.ts`): clean. Static constant containing the published Team ID + Bundle ID (`S8WDX4W5KX.dev.healthlog.app`), `applinks` matcher `["*"]`, `webcredentials` for passkey ceremony. No route enumeration, no host-specific data. **PASS**.

2. **Privacy page** (`src/app/privacy/page.tsx`, 2356 lines added): no Marc-last-name + health-figure pair, no BD-Zielbereich values, no measurement counts. Public references to `mbombeck@gmail.com` + GitHub handle `MBombeck` + Hetzner are GDPR-disclosure norms ("controller contact"), not internal/PII per `feedback_no_pii_in_user_facing.md`. No Coolify/IPs/secrets. **PASS**.

3. **Consent endpoints**:
   - POST `src/app/api/consent/ai/route.ts`: `requireAuth()` first, Zod-validates body, `createReceipt(user.id, …)`. Audit-log fired on grant.
   - GET/DELETE `src/app/api/consent/ai/latest/route.ts`: `requireAuth()` first, every `latestActiveReceipt` / `revokeLatest` / `latestActiveReceiptsByKind` call passes `user.id` from the session — no caller-supplied user-id parameter. Idempotent delete returns 200 (correct).
   - `serialiseReceipt` strips `artefact` from the API response — only the opaque audit blob lives in the DB; never echoed back over the wire. **PASS** (modulo M-1).

4. **Notifications status** (`src/app/api/notifications/status/route.ts`): `requireAuth()` first, both `prisma.notificationChannel.findMany({ where: { userId: user.id } })` and `loadEventStatuses(user.id)` (which scopes `moodReminderDispatch` by the same userId). The events map shape is per-user; no cross-tenant delivery counts. **PASS**.

5. **APNs interruption-level** (`src/lib/notifications/senders/apns.ts:439`): `const isTimeSensitive = payload.eventType === "MEDICATION_REMINDER";` — strict equality on a single event-type. Only that branch sets `interruptionLevel: "time-sensitive"` + `priority: 10`. All other event-types stay on the iOS default `active` level. Focus modes (including Sleep) silence them as expected. Telegram `replyMarkup` leak protected by `IOS_METADATA_ALLOWLIST` (lines 528-535). **PASS**.

6. **deletedAt full-wire**: every changed read path threads `deletedAt: null`:
   - `src/app/api/measurements/route.ts` — GET list, GET aggregated, raw-SQL aggregator (added `AND m."deleted_at" IS NULL`).
   - `src/app/api/measurements/series/route.ts` — BP-pair and single-kind branches.
   - `src/app/api/dashboard/summary/route.ts` — raw 7-day sparkline SQL, groupBy(type), 365-day raw streak SQL.
   - `src/app/api/analytics/route.ts` — `fetchMeasurementSeriesChunked`, glucose context, sleep-stage breakdown.
   - `src/lib/insights/features.ts` (latest-by-type) — `deletedAt: null` added.
   The dedicated `sync/state` route is documented as the sole consumer that intentionally surfaces tombstones (for iOS reconcile). **PASS**.

7. **Insights mood-rollup swap** (`src/app/api/insights/comprehensive/route.ts`, `src/app/api/insights/targets/route.ts`): `ensureUserMoodRollupsFresh(userId)` + `readMoodDayRollups(userId, since)` both scope by userId. The internal raw-SQL writer (`src/lib/rollups/mood-rollups.ts:188-235`) uses parameterised `${userId}` throughout the `WITH aggregate … WHERE m."user_id" = ${userId}` upsert + delete pair. Cold-start fallback in `comprehensive/route.ts:128-152` retains `where: { userId, moodLoggedAt: { gte: ninetyDaysAgo } }`. **PASS**.

8. **Migration 0074** (`prisma/migrations/0074_v1440_consent_receipts/migration.sql`): table `consent_receipts` with `user_id` FK → `users(id)` `ON DELETE CASCADE ON UPDATE CASCADE`. Wrapped in `IF NOT EXISTS` + `DO $$ BEGIN … EXCEPTION WHEN duplicate_object` guards (idempotent, mirrors 0067/0070/0071). Compound index `(user_id, created_at DESC)`. Cascade is correct — a user erasure under GDPR Art. 17 drops the corresponding consent receipts, completing the deletion. **PASS**.

9. **knip CI** (`.github/workflows/knip.yml`): `permissions: contents: read` (least-privilege). No `secrets` references, no env exposure, no third-party uploader steps. `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm knip` — no remote artefact write. **PASS**.

## Surface delta summary

| Path | Risk | Verdict |
| --- | --- | --- |
| `prisma/migrations/0074_v1440_consent_receipts/migration.sql` | Schema (FK cascade) | PASS |
| `src/app/.well-known/apple-app-site-association/route.ts` | Public unauthenticated | PASS |
| `src/app/privacy/page.tsx` | Public unauthenticated | PASS (no PII) |
| `src/app/api/consent/ai/route.ts` | Authenticated write | PASS (M-1 below cap shape) |
| `src/app/api/consent/ai/latest/route.ts` | Authenticated read/delete | PASS |
| `src/app/api/notifications/status/route.ts` | Authenticated read | PASS |
| `src/lib/notifications/senders/apns.ts` | Outbound channel | PASS |
| `src/lib/rollups/mood-rollups.ts` | Internal SQL | PASS (param `${userId}` throughout) |
| `src/lib/insights/features.ts` + `comprehensive-aggregator.ts` | Internal read | PASS |
| `.github/workflows/knip.yml` | CI | PASS |

## Brief-back (≤200 words)

v1.4.40 ships a clean security surface. The new `ConsentReceipt` write path (`POST /api/consent/ai`) authenticates first, Zod-validates, stores opaque artefacts, and strips them from the response. The latest-receipt reader and revoke endpoints scope every query by the authenticated `user.id` — no caller-supplied user-id, no cross-tenant leak. Migration 0074 cascades on user delete, satisfying GDPR Art. 17. The AASA file ships only the published Team ID + Bundle ID. The privacy page contains no Marc-PII / no operator-internal info (Hetzner is the actual public hosting fact, GitHub handle + email are deliberate controller-contact disclosure). APNs interruption-level is correctly gated to `MEDICATION_REMINDER` via strict-equality on the event-type; the existing `IOS_METADATA_ALLOWLIST` keeps Telegram's `replyMarkup` from leaking into APNs userInfo. Every changed read path threads `deletedAt: null` (raw SQL and Prisma alike). Mood-rollup swap's raw SQL uses parameterised `${userId}`. knip CI runs with `contents: read` only, no secret access.

One Medium (M-1): consent artefact cap is character-count, not byte-count — practical impact is small (artefacts are ASCII-only) but the comment promises bytes; ship-blocker NO, follow-up YES. Two Low items noted for future hardening.
