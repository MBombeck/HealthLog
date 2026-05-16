# Mobile Security Audit — 2026-05-16

## Executive summary

The mobile surface is in better shape than expected. Passkey, refresh-token rotation with reuse-detection, AES-GCM-at-rest with versioned keys, HMAC-hashed API tokens, and per-IP rate-limit envelopes on every auth path are already in place. The three sharp gaps I'd close before App Store goes live: (1) **the Apple Health import pipeline reads a 1.5 GB upload into memory with `readFileSync` and inflates the central XML with no max-output cap** — a malicious or accidental zip-bomb crashes the worker; (2) **password change does not revoke `ApiToken` rows nor `RefreshToken` family** — a stolen long-lived iOS token survives the user's most obvious self-remediation; (3) **the `/.well-known/` namespace is wide-open via `startsWith` in proxy.ts** — fine today, but the pattern admits any future `/.well-known/foo` route without auth, which is exactly how AASA siblings (Universal Links, OIDC discovery) tend to creep in. Order: F-1 before App Store ship (worker can be killed remotely), then F-2 hotfix, then everything else.

## Findings — prioritized

### F-1: Apple Health unzip loads entire upload to RAM + inflates with no output cap

**Severity**: high
**Blast radius**: any authenticated user can crash the worker container (DoS the whole queue, including reminders + Withings activity sync + sleep sync) by uploading a crafted ZIP. With 1.5 GB upload allowed, even a benign large export OOMs a typical Coolify worker.
**File(s)**: `src/lib/import/unzip-export-xml.ts:65` (`readFileSync(archivePath)` — whole archive in RAM), `:240` (`inflateRawSync(compressed)` — no `maxOutputLength` option), `src/app/api/import/apple-health-export/route.ts:41` (`MAX_UPLOAD_BYTES = 1.5 GB`)
**What's wrong**: The streamed-to-disk multipart parser does its job (`stream-to-disk.ts` keeps memory bounded), but then `extractExportXml` undoes that by `readFileSync`ing the entire upload — peak RSS jumps to ~1.5 GB on the worker per concurrent import. Worse, `inflateRawSync` has no upper bound on output: a 1 MB ZIP with a 10:1 deflate ratio can inflate to many GB. Apple's real exports compress well, so an attacker only needs one crafted entry to OOM the worker. `sax.parser` itself is fine — defaults `maxEntityCount=512`, `maxEntityDepth=4` (sax.js source, lib/sax.js:70–71) so billion-laughs is covered.
**Fix shape**: switch to a streaming ZIP reader (`yauzl` or a `createReadStream + node:zlib.createInflateRaw` pipe) that walks the central directory by seek and streams the chosen entry through `createInflateRaw({ maxOutputLength: 8 * 1024 * 1024 * 1024 })` (8 GB cap — Apple's largest realistic export is ~6 GB uncompressed). Or keep the current shape but pass an explicit `maxOutputLength` to the existing `inflateRawSync` call and `fs.statSync` + reject if `archive.size > 2 GB` before the `readFileSync`.
**Effort**: medium (4 h) — needs a streaming path; tests already exercise the central-directory walker so refactoring is bounded.

### F-2: Password change does not revoke `ApiToken` or `RefreshToken` rows

**Severity**: high  `[hotfix-ready]`
**Blast radius**: a user who suspects compromise and changes their password (the obvious self-remediation) is told all sessions are killed, but their 90-day iOS Bearer token + 60-day refresh-token family keep working. iOS app continues operating; an attacker holding the leaked token also continues operating.
**File(s)**: `src/app/api/auth/password/route.ts:81` (`destroyAllSessions(user.id)` is the only revocation call), `src/lib/auth/session.ts:159–161` (`destroyAllSessions` deletes Session rows only)
**What's wrong**: `destroyAllSessions` only touches `prisma.session.deleteMany`. Native callers authenticate via `ApiToken` (Bearer) and rotate via `RefreshToken` — both tables are independent and survive the password change.
**Fix shape**: in `password/route.ts` after `destroyAllSessions`, add `await prisma.apiToken.updateMany({ where: { userId: user.id, revoked: false }, data: { revoked: true } })` and `await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } })`. Same fix belongs in the admin reset-password path (`src/app/api/admin/users/[id]/reset-password/route.ts`).
**Effort**: trivial (< 15 min)

### F-3: AASA + `/.well-known/` proxy bypass admits any future namespace member without auth

**Severity**: medium  `[hotfix-ready]`
**Blast radius**: today, none — only `apple-app-site-association` lives under `/.well-known/` (`src/app/.well-known/apple-app-site-association/route.ts:36`). The risk is that the `startsWith("/.well-known/")` rule (`src/proxy.ts:43`) will silently make every future sibling route (OIDC discovery, security.txt, openid-federation, change-password) publicly readable, including ones a future developer wires to internal helpers. AASA itself is fine: it returns a static object with no user data.
**File(s)**: `src/proxy.ts:43`, `src/app/.well-known/apple-app-site-association/route.ts:32` (`webcredentials.apps: ["S8WDX4W5KX.dev.healthlog.app"]` is correct shape)
**What's wrong**: The proxy bypass is a `startsWith` over a tree, not an explicit allowlist. The maintainer comment at proxy.ts:38–42 even hints at intentionally pre-admitting `/security.txt`, `/openid-configuration`, etc. — but security.txt should live at `/.well-known/security.txt` (which would correctly bypass), and an OIDC discovery doc, if ever added, must not be public if it leaks internal endpoint shape.
**Fix shape**: tighten to an explicit allowlist of `/.well-known/apple-app-site-association` and `/.well-known/security.txt`. Future namespace additions must be opted in explicitly. Drop the `/api/auth/codex/callback` line at proxy.ts:26 too — that route doesn't exist (verified, only `device-poll`, `device-start`, `disconnect`); it's just stale PUBLIC_PATHS clutter that erodes the reviewer's trust signal.
**Effort**: trivial (< 15 min)

### F-4: Withings webhook uses one global shared secret across all users

**Severity**: medium
**Blast radius**: a single leaked `WITHINGS_WEBHOOK_SECRET` allows an attacker to spoof Withings notifications for **any** connected user — they just need to know the target's `withingsUserId` (a 6–10 digit number, enumerable). The handler ignores unknown users (`webhook-handler.ts:140`) but happily fires `syncUserMeasurements` for any recognised id without any per-user authenticity check.
**File(s)**: `src/app/api/withings/webhook/[token]/route.ts:32` (`process.env.WITHINGS_WEBHOOK_SECRET`), `src/lib/withings/webhook-handler.ts:127–148`
**What's wrong**: Withings does not sign webhook bodies, so per-user authenticity is unachievable end-to-end. The mitigation today is that the secret moved from query (`?secret=`) to path segment (good — keeps it out of reverse-proxy access-log `query_string` columns). Still: one secret protects everyone, and the spoofed notification just retriggers `syncUserMeasurements`, so the practical blast radius is "attacker forces a sync against your real Withings account" — not data exfiltration, just rate-limit / pull-side abuse. Worth flagging because the iOS roll-out increases the user count under the same secret.
**Fix shape**: rotate `WITHINGS_WEBHOOK_SECRET` quarterly via a `scripts/rotate-withings-webhook-secret.ts` that re-subscribes every active connection through `withings/connect` against the new secret. Operator change, no code change required to ship today, but it should be documented as a runbook rotation gate before the iOS launch grows the user base.
**Effort**: medium (4 h) — operator runbook + a re-subscription helper script.

### F-5: HSTS missing `preload`; CSP allows `wbsapi.withings.net` on every page

**Severity**: low  `[hotfix-ready]`
**Blast radius**: HSTS without `preload` requires a fresh visitor to hit HTTPS once before the policy locks in; the first-visit window is exploitable on hostile networks (cafe Wi-Fi). The `wbsapi.withings.net` `connect-src` entry is broader than needed — that host should only be reachable from `/settings/integrations/withings/*`, similar to the AI-route gating already done at proxy.ts:235–238.
**File(s)**: `src/proxy.ts:250–253` (HSTS), `src/proxy.ts:241` (CSP)
**What's wrong**: `Strict-Transport-Security: max-age=31536000; includeSubDomains` — needs `; preload` for `healthlog.bombeck.io` to be eligible for the Chromium preload list. The CSP `wbsapi.withings.net` host is global; mirror the AI-only gating pattern instead.
**Fix shape**: append `; preload` to the HSTS header. Gate Withings in `connect-src` to `pathname.startsWith("/settings/integrations/withings") || pathname.startsWith("/api/withings/")`. Submit the domain to `hstspreload.org` only after `; preload` ships on production.
**Effort**: trivial (< 15 min)

### F-6: `getClientIp` returns `null` when `TRUST_PROXY_HOPS` is set but XFF chain is shorter than expected — IP-keyed rate limits fall open

**Severity**: medium  `[hotfix-ready]`
**Blast radius**: every IP-keyed rate-limit silently collapses to a single bucket. `auth:login:unknown`, `auth:register:unknown`, `withings-webhook:null`, `moodlog-webhook:unknown` — one shared bucket means 5 login attempts per fifteen minutes globally instead of per-IP. An attacker spraying weak passwords burns the same bucket as legitimate users.
**File(s)**: `src/lib/api-response.ts:98–120`, callers e.g. `src/app/api/auth/login/route.ts:25–26` (`const ip = getClientIp(request) ?? "unknown"`)
**What's wrong**: The current contract (refuse to read XFF when shorter than configured hops) is correct *security* behaviour — it stops the leftmost-IP rotation attack — but it does so by returning `null`, which every caller then collapses to a literal `"unknown"` string and rate-limits *all anonymous traffic together*. The downstream rate-limit therefore fails open from a noisy-neighbour perspective even though it fails closed from a credential-stuffing-from-one-IP perspective.
**Fix shape**: when `getClientIp` returns `null` because the chain was too short, log a warning once per process (it's an operator misconfig signal) and apply a much tighter universal rate-limit on the affected route (e.g. 20/min globally for `auth:login:unknown`) so the collapsed bucket is itself a useful gate. Better: surface a sentinel like `"unknown-trust-violation"` so the operator alert fires on the dashboards. Best: add an admin-status indicator that flips red when `TRUST_PROXY_HOPS` and the XFF chain don't match.
**Effort**: small (< 1 h)

### F-7: Service worker offline page reflects untranslated German; manifest scope is implicit; no `scope` set

**Severity**: low
**Blast radius**: low. The PWA offline fallback at `public/sw.js:104` is a hard-coded German HTML blob — users on `en` locale see German strings on offline boot. The manifest has no `scope`, so the install scope defaults to `/`, which is fine for a single-route app but exposes the app to PWA-hijack if a future subpath ever ships a separate manifest. Push notification handler does not validate the `data.url` is same-origin before `client.navigate(url)` at sw.js:166 — a server-side injection into push payload could redirect the focused PWA window to an attacker URL.
**File(s)**: `public/sw.js:104` (German-only offline fallback), `public/sw.js:155–172` (notification click), `public/manifest.json` (missing `scope`, `id`, `display_override`)
**What's wrong**: `client.navigate(url)` trusts the push payload verbatim. Push payloads are server-authenticated by VAPID, but the push-server is our own — a server-side bug (or compromised admin issuing pushes) could ship an off-origin URL into `data.url`.
**Fix shape**: validate `new URL(url, self.location.origin).origin === self.location.origin` before `client.navigate`. Localise the offline HTML via the same i18n message bundle the rest of the app uses (or strip the German and just render a generic icon). Add `"scope": "/"`, `"id": "/?source=pwa"`, `"display_override": ["standalone"]` to the manifest.
**Effort**: small (< 1 h)

### F-8: Audit-log coverage gap on Bearer mutation paths + IdP-style ops

**Severity**: medium
**Blast radius**: an attacker with a stolen native token can mutate measurements (`/api/measurements/[id]` PATCH), delete medications, change targets, etc. without any audit-log entry beyond the create paths. The audit table is the only forensic trail; missing-entries means "we knew it happened but not when by whom" in an incident.
**File(s)**: `src/app/api/measurements/[id]/route.ts` (PATCH/DELETE — has `auditLog` in places, not uniformly), `src/app/api/medications/[id]/route.ts` (no audit calls — verified via the grep at the top of the audit), `src/app/api/auth/me/devices/[id]/route.ts` (DELETE — token-revoke flow, needs audit), `src/lib/auth/audit.ts:26` (geo enrichment is gated on `action.startsWith("auth.")` — non-auth events miss the carrier/location enrichment that is genuinely useful for incident response)
**What's wrong**: The audit module exists and works, but coverage is patchy. Every mutation path that a stolen Bearer token can reach should log. Geo-enrichment is restricted to auth events; extending to any mutation costs nothing (the timeout race already caps the await window at 3 s) and gives the incident-response narrative.
**Fix shape**: walk every `route.ts` under `/api/measurements`, `/api/medications`, `/api/auth/me`, `/api/integrations` and confirm `auditLog(...)` on every non-GET handler. Drop the `action.startsWith("auth.")` gate in `audit.ts:26` so geo enrichment runs for any event that carries an `ipAddress`. Add a regression test that walks the api tree and asserts every non-GET handler imports `auditLog`.
**Effort**: medium (4 h) — sweep, add missing calls, regression test.

## Out of scope / accepted risks

- **`unsafe-inline` in style-src** (`src/proxy.ts:241`): Tailwind injects style attributes and Recharts renders inline `style="..."` for tooltips. Removing it breaks both. Risk is bounded — CSS injection is not a meaningful exfil path absent CSS-keylogger primitives, which our threat model does not include.
- **Session cookie `SameSite: Lax`** (`src/lib/auth/session.ts:76`): required for the Withings OAuth top-level cross-site redirect to land with the cookie attached. The comment is accurate; CSRF for unsafe methods stays protected by `Lax`'s same-rule.
- **`X-Frame-Options: DENY`** (`src/proxy.ts:222`) plus CSP `frame-ancestors 'none'` (proxy.ts:241): correctly double-belted. Good.
- **No CSRF tokens** (`src/lib/api-handler.ts:33`): acceptable under `SameSite: Lax` + same-origin-only API design. Verified no public-internet POST mutations exist that read session cookies (Withings OAuth callback is GET).
- **Argon2id password hashing**: not re-verified line-by-line, but the wiring in `src/lib/auth/password.ts` follows the well-known node-argon2 default settings; no findings during the sweep.
- **No virus scan on uploads**: acceptable for a self-hosted personal-health-tracking app. Threat model is the maintainer's own iOS device, not a multi-tenant SaaS.
- **`@simplewebauthn/server` passkey flow**: structurally correct (origin allowlist, RP ID derived from APP_URL, 5-min challenge TTL, counter advance, challenge invalidation in `finally`). No findings.

## What you didn't get to

- **Admin surface end-to-end audit** (`/api/admin/*` — 30+ routes). I sampled `admin/users/[id]/reset-password` for the F-2 follow-up. Worth a dedicated sweep before the iOS rollout doubles the admin attack surface for the maintainer's own account.
- **APNs ingest path**. The roadmap mentions APNs scaffolding (v1.4.23) but I didn't find a `/api/notifications/apns/*` route in this audit. Once it exists, signature verification of the iOS provider response and idempotency on device-token rotation will need a finding pass.
- **Withings OAuth state-token entropy and replay window**. The callback at `/api/withings/callback` accepts the state token and exchanges the code; I didn't verify the state is single-use or that the redirect_uri pin matches.
- **`scripts/rotate-encryption-key.ts`** wiring + the contract for re-encrypting moodlog/Withings/Telegram/AI-provider secrets. Documented at `src/lib/crypto.ts:244–247` but I didn't read the rotation script itself.
- **Telegram webhook bot-impersonation risk**: the secret-token verification at `src/app/api/telegram/webhook/route.ts:35–47` is sound, but the chat-ID-to-user mapping that the handler uses to route inbound messages was not re-verified.
- **Rate-limit on `/api/measurements` POST + PATCH** (no `checkRateLimit` call confirmed via grep). A stolen native token can write at unbounded rate to those routes — the batch endpoint is capped (60/min) but the single-entry POST is not. Worth a follow-up.
