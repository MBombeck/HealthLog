# v1.4.27 — R4 Security Review

- Scope: `git diff v1.4.26..HEAD` (HEAD `617d4518`, branch `develop`)
- Mode: read-only static review
- Style: Maintainer-voice English, no forbidden words, no PII

## Executive Summary

The v1.4.27 surface that touches auth, persistence and outbound notifications was audited against the brief.
Everything that is gated, parametrised, or routed through Prisma holds.
No critical or high finding.
Two low-tier findings are worth a follow-up before iOS shipping, plus two informational hardening notes.

Result tally:

- Critical: 0
- High: 0
- Medium: 0
- Low: 2
- Informational: 3

---

## Methodology

For each diff hunk in the security-relevant list the review verified:

- gate (`requireAuth` / `requireAdmin` / shared-secret / public-by-design)
- input shape (Zod / typed Prisma input / hardcoded literal)
- sink shape (Prisma `where` / `select`, fetch URL builder, shell exec, template interpolation, audit-row write)
- error path (does the bad case leak the secret / token / payload?)

Each finding below cites the file and the line range the finding hangs on so a follow-up patch has the load-bearing pointer.

---

## L1 — `getServerTranslator` regex `$`-substitution in interpolated params

- Severity: Low
- File: `src/lib/i18n/server-translator.ts:25-30`
- Surface: `dispatchLocalisedNotification` → `t(key, params)` template fan-out

The translator interpolates params via `value.replace(new RegExp(...), String(v))`.
`String.prototype.replace` honours `$&`, `$1`-`$9`, `$$`, `$\`` and `$'` in the replacement string.
A `params.error` value that contains `$&` will reflect the matched `{error}` placeholder back into the message; `$$` collapses to `$`.

Repro path:

1. The Coolify deploy webhook is the only call-site that passes attacker-influenced text (`event.error`) directly into `params`.
2. The webhook is gated by the `DEPLOY_WEBHOOK_SECRET` shared secret + timing-safe compare + rate limit (60/min/IP) in `src/app/api/internal/deploy-webhook/route.ts:88-99,156-167`, so an external actor cannot reach it without compromising the secret.
3. The other call-site (`reminder-check`) is admin-gated and the params come from `Medication.name` / `.dose` — owner-edited, single-tenant blast radius only.

Impact: garbled notification text only.
Telegram is sent with `parseMode: "HTML"` (`src/lib/notifications/senders/telegram.ts:114`), so `<` / `>` injected through the same path would form Telegram-HTML tags — but again, the only attacker-reachable param input is the secret-gated deploy webhook.

Fix shape: switch the loop body to a literal-replacement form, e.g.

```ts
value = value.split(`{${k}}`).join(String(v));
```

or `String.prototype.replaceAll(literalKey, literalValue)` — both bypass the `$`-pattern interpretation.
Same patch closes the Telegram-HTML angle because no replacement string ever lands in the regex sink.

## L2 — `fetch-geolite2.sh` interpolates MAXMIND license key into curl URL (argv visibility)

- Severity: Low (build-host only, no runtime exposure)
- File: `scripts/fetch-geolite2.sh:47-49`

`curl --output … "https://download.maxmind.com/app/geoip_download?…&license_key=${LICENSE_KEY}…"` puts the key into the curl process `argv`.
Anyone on the build host can read it from `/proc/<pid>/cmdline` for the duration of the download.
The script does not enable `set -x`, and curl's `--silent --show-error --fail` error messages do not echo the URL, so stderr is clean.
The repo's `.gitignore` already keeps the `.mmdb` files out of git.

Impact:

- Build-host shell access already implies the operator can read the env var directly, so the marginal exposure is shoulder-surfing window during the download burst (~10 s).
- The script exits non-zero on failure but stderr does not include the secret.

Fix shape (when prioritised):

```sh
curl --silent --show-error --fail --location \
  --output "$tmp_tarball" \
  --url "https://download.maxmind.com/app/geoip_download?edition_id=${edition_id}&suffix=tar.gz" \
  --data-urlencode "license_key=${LICENSE_KEY}" \
  --get
```

or pipe a `--config -` file via stdin.
Both options keep the key out of `argv`.

---

## I1 — `PUBLIC_PATHS` matches via `startsWith` — `/about` admits future sub-routes by default

- File: `src/proxy.ts:50-55`

`isPublicPath()` runs `PUBLIC_PATHS.some((p) => pathname.startsWith(p))`.
Today `/about` is the only `/about/*` path, so the bypass is theoretical; a future `/about/<slug>` page added in v1.5 inherits the public gate without an explicit opt-in.
The `/onboarding` entry is already pinned to `pathname === "/onboarding" || pathname.startsWith("/onboarding/")` to avoid the same trap (see W5 reconcile comment on lines 41-48).

Recommendation: when the next public sub-path lands (or proactively now), promote `/about` and `/privacy` to the same exact-match-or-slash pattern as `/onboarding`.
Trivial diff, prevents the next surprise.

## I2 — `mmdb-lib@3.0.2` added; supply-chain trust + integrity-pinned

- Files: `package.json:63`, `pnpm-lock.yaml` (sha-512 integrity entry recorded)

mmdb-lib is the canonical MaxMind format reader for Node (~3 M weekly downloads, MIT, no transitive runtime deps).
The version is pinned and the lockfile carries an `integrity:` hash so a registry-side swap is detected on install.
No action required; called out so the addition is on record next to the GeoLite2 work.

## I3 — Online geo fallback private-range gate is incomplete

- File: `src/lib/geo.ts:74-75`

The `PRIVATE_IP` regex catches RFC1918, loopback and a subset of IPv6 ULA prefixes, but misses CGNAT (`100.64.0.0/10`) and link-local (`169.254.0.0/16`).
A login that arrives over a CGNAT egress without offline-MMDB coverage will be sent to `ipwho.is`.
Not a confidentiality leak — the lookup is already off by default when `IP_GEO_LOOKUP_DISABLED=1` is set — but ops should know the offline-only contract is incomplete for these ranges.

---

## Areas Audited — Negative findings (cleared)

### A. Auth gate on every new route

| Route | Gate | Notes |
| --- | --- | --- |
| `GET /api/workouts` (new, `src/app/api/workouts/route.ts`) | `requireAuth()` | Prisma `where: { userId: user.id }` on all branches; `since`/`until` only honoured when `Date.parse` succeeds; `pickCanonicalWorkout` is a pure function operating on the already-userId-scoped set. |
| `POST /api/workouts/batch` (refactored, `src/app/api/workouts/batch/route.ts:356-403`) | `requireAuth()` (pre-existing) | The N→1 dedup probe batches per-row clauses inside `OR: [...]` but keeps `userId: user.id` and `route: null` at the top-level AND, so tenant isolation holds. Prisma-parametrised throughout. |
| `GET /api/admin/audit-log` (new columns) | `requireAdmin()` | New `asn` / `carrier` selects are admin-gated. Substring filters (`actor`, `target`) are Prisma `contains` — parametrised. |
| `POST /api/admin/notifications/reminder-check` | `requireAdmin()` | `dispatchLocalisedNotification` flows admin-controlled trigger → user-owned medication data → user's own notification channels. |
| `POST /api/admin/notifications/test` | `requireAdmin()` | Same admin trigger, only the admin's own channels receive. |
| `POST /api/internal/deploy-webhook` | `DEPLOY_WEBHOOK_SECRET` timing-safe + 60/min IP rate limit | See L1 for the only attacker-reachable interpolation path. |
| `POST /api/settings/telegram/test` | `requireAuth()` + 5-per-5-min user-keyed rate limit | Locale comes from `User.locale`, no caller-controlled key. |
| Page `/about` (new) | Public by design (B3 attribution gate) | `force-static`, no auth-derived data fetched. Renders only static credits + a `/auth/login` link. The deleted `/api/audit-log` route (replaced by the admin-only surface) closes a prior duplicate-discovery footgun. |

### B. `/measurements?add=<TYPE>` consumer (open-redirect / SSRF probe)

- File: `src/app/measurements/page.tsx:19-59`

The query value is intersected with a hardcoded `ALLOWED_ADD_TYPES` set; unknown values are dropped silently.
The post-consume `router.replace("/measurements")` is a literal — no user-controlled value flows into the redirect target.
No `fetch` / `Image` / `Link` sink consumes the raw param.
Open-redirect: not reachable.
SSRF: not reachable.

### C. SQL / Prisma parametrisation on new columns and helpers

- `AuditLog.asn` (Int), `AuditLog.carrier` (Text) — added via `prisma/migrations/0061_audit_log_carrier/migration.sql` with `IF NOT EXISTS` idempotency. Writes go through `prisma.auditLog.update({ where: { id }, data })` in `src/lib/auth/audit.ts:53-56` and the geo-backfill job (`src/lib/jobs/geo-backfill.ts:107-110`) — both Prisma-parametrised.
- `pickCanonicalWorkout` is pure; it neither reads nor writes the DB.
- `runGeoBackfill` uses Prisma `findMany` + `update`; the `cutoff` is a server-computed `Date`, `ipAddress` filter is structural (`{ not: null }`).
- No raw `$queryRaw` / `$executeRaw` introduced in the diff.

### D. `dispatchLocalisedNotification` prompt-injection / template-injection

- File: `src/lib/notifications/dispatch-localised.ts`

The helper:

1. resolves the recipient locale via `prisma.user.findUnique({ select: { locale: true } })` — single-tenant, locale value coerced to the closed enum via `isLocale()`.
2. calls `getServerTranslator(locale).t(key, params)` — keys are hardcoded literals at every call site (no caller-supplied key flows in from a request body).
3. forwards `(title, message)` to `dispatchNotification` with `eventType` defaulted to `SYSTEM_ALERT`.

Prompt-injection is not in scope here — these are notification bodies, not LLM prompts.
The only template surface is the `$`-substitution noted in L1.

### E. `parkIntegrationAtReauth` audit-trail preservation

- File: `src/lib/integrations/status.ts:297-345`

The helper:

- preserves `consecutiveFailures` on the existing row (the whole purpose of the helper — bypasses the 3-strike ladder).
- writes an `integrations.reauth_required` audit row through `auditLog()` only when the state or `lastError` changes (`isFreshPark`).
- never touches the alert ladder, never calls `recordSyncFailure`.

The audit trail still surfaces every distinct park event. Re-parks with the same encrypted message are deduped — intentional, matches the documented contract.
Verified by the two integration tests at `src/lib/withings/__tests__/sync-{activity,sleep}.test.ts:287-352`.

### F. `/about` content does not leak authenticated data

- File: `src/app/about/page.tsx` (full read)

`export const dynamic = "force-static"` + `export const revalidate = false` produces a build-time-rendered shell.
The page contains: project name, the public GitHub URL, MaxMind attribution text, AGPL licence pointer, link to `/privacy` and `/auth/login`.
No `fetch`, no `headers()`, no `cookies()`, no `getSession()`.
The `<AuthShell>` `isStandalonePublicPage` branch returns `<>{children}</>` without rendering nav / user chips (`src/components/layout/auth-shell.tsx:41-87`).

### G. CSRF on new POST routes

- The auth cookie is `SameSite=lax` (`src/lib/auth/session.ts:76,137`), Secure in production, HttpOnly.
- `lax` blocks cross-site `<form method=POST>` cookie inclusion, which is the relevant CSRF vector for the new auth-gated POSTs (`telegram/test`, `notifications/test`, `notifications/reminder-check`).
- `deploy-webhook` is shared-secret-gated and rate-limited; CSRF is not in its threat model.

No additional CSRF token is required for the v1.4.27 routes given the existing cookie posture.

---

## Sign-off

The v1.4.27 security surface is shippable.
L1 + L2 are worth a follow-up patch before the v1.5 iOS sprint widens the attacker-reachable param surface (Apple-Health-side params will land in `dispatchLocalisedNotification` next), but neither blocks the v1.4.27 release.
I1 is a five-line proxy.ts hardening that pairs naturally with whatever the next public sub-route is.
I2 + I3 are tracked for awareness only.
