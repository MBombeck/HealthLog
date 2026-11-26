# HealthLog threat model

What a HealthLog instance protects, who can reach it and how, what stands in the way, and what does not. It describes the code as it is; file paths point at the control. The push relay has its own model in its repository ([healthlog-push `docs/threat-model.md`](https://github.com/MBombeck/healthlog-push/blob/main/docs/threat-model.md)); reproductive-health data has a focused one in [`cycle-data-threat-model.md`](cycle-data-threat-model.md). Reporting a vulnerability: [`SECURITY.md`](../../SECURITY.md).

## Assets

- **Health records**: measurements, medications and intakes, labs, sleep, mood, cycle data, documents and their OCR text, visits, conditions. Sensitive columns are AES-256-GCM encrypted at rest with versioned keys (`src/lib/crypto.ts`); the rest is plain in PostgreSQL.
- **Credentials**: session tokens, Bearer access and refresh tokens, passkeys, password hashes (Argon2id, `src/lib/auth/argon2-params.mjs`), MFA secrets, integration OAuth tokens, user-supplied AI keys. Tokens are stored only as HMACs (`src/lib/auth/hmac.ts`); third-party tokens and keys are encrypted columns.
- **Instance secrets**: `ENCRYPTION_KEYS`, `API_TOKEN_HMAC_KEY`, `BACKUP_ENCRYPTION_KEY`, webhook secrets, the push-relay instance key. They live in the operator's environment, never in the database in clear.
- **Backups and exports**: nightly database dumps, per-account backups, export archives.
- **Availability** of a single-process server that shares its heap between the web server and the import workers.

## Actors

- **Account holder**: owns a record, signs in through the browser or the iOS app.
- **Grantee**: another account the owner invited to read or manage a record (family, guardian of a managed profile).
- **Clinician**: holds a share link and, optionally, its passphrase; has no account.
- **Anyone who has seen an emergency card**: holds its public link.
- **Operator / admin**: runs the instance and holds its environment; an admin account in the app.
- **External services**: AI providers, integrations (Withings, Garmin, Oura, Google Health, Strava, Polar, Dawarich), notification channels (APNs via the relay, Telegram, ntfy, Web Push), MCP clients.
- **Attacker**: unauthenticated on the network, an authenticated user going beyond their record, a malicious file, a compromised dependency, a compromised external service.

## Trust boundaries and controls

### Browser

- Server-side sessions: `hls_` token, only its HMAC stored, 30-day sliding expiry (`src/lib/auth/session.ts`). Cookie `__Host-` prefixed, HttpOnly, SameSite=Lax, Secure in production (`src/lib/auth/session-cookie.ts`, `src/lib/auth/secure-cookie.ts`).
- CSRF: SameSite=Lax on the session cookie and no CORS headers anywhere; OAuth callbacks compare `state` in constant time. `/mcp` and the MCP authorize route also check `Origin` / `Sec-Fetch-Site`.
- CSP with a per-request nonce, `object-src 'none'`, `frame-ancestors 'self'`, `form-action 'self'`, third-party hosts in `connect-src` only on the routes that call them; COOP, CORP, COEP and HSTS (`src/proxy.ts`). One `dangerouslySetInnerHTML` in the tree, no markdown renderer.
- Login: Argon2id passwords or passkeys (`@simplewebauthn/server`), per-account backoff (`src/lib/auth/login-throttle.ts`), per-address limits in Postgres (`src/lib/rate-limit.ts`), step-up MFA within five minutes for sensitive actions (`src/lib/auth/guards/fresh-mfa.ts`).
- Guards: `session-surface-guard`, `step-up-elevation-guard`, `no-server-actions-guard`, `proxy-csp-*`.

### iOS app and API tokens

- Bearer access tokens `hlk_`, HMAC-stored, one day for the native app (`src/lib/auth/issue-token.ts`, `src/lib/auth/native-client.ts`). Refresh tokens are one-time-use per device; reuse revokes the device's token family (`src/lib/auth/refresh-token.ts`).
- Scope is fail-closed: a route that names no scope admits only a cookie session or a `*` token (`src/lib/auth/guards/caller.ts`); `requireAdmin()` never admits a Bearer token (`src/lib/auth/guards/cookie.ts`).
- Native SSO: a 90-second, single-use handoff code bound by PKCE S256 to a compiled-in `healthlog://` callback; tokens never ride a URL (`src/lib/auth/native-handoff.ts`, `src/lib/auth/oidc-native-handoff.ts`).
- Guards: `bearer-scope-enforcement-guard`, `auth-guards-entry-guard`.

### Push relay

- Requests to the relay are signed with an Ed25519 instance key; replies count only when signed by a pinned relay key (`src/lib/push-relay/client.ts`, `src/lib/push-relay/config.ts`). Each notification is HPKE-sealed to one device and padded to a fixed size (`src/lib/push-relay/hpke.ts`, `envelope.ts`). `PUSH_RELAY_MODE=off` turns it off.
- The relay sees delivery metadata (push token, instance id, class, timing); see `docs/integrations/push-relay.md`.

### AI providers

- Every AI action resolves one capability server-side and re-checks it right before anything leaves (`src/lib/ai/capabilities/`, `egress.ts`). Data routes import no AI gate.
- Operator-held credentials require a recorded consent; the check fails closed (`src/lib/ai/consent-guard.ts`). Provider keys are encrypted columns (`src/lib/ai/stored-key.ts`). Private model hosts must be exact origins in `AI_PRIVATE_ORIGINS`, dialled through a pinned connection (`src/lib/ai/local-host-allowlist.ts`).
- Model output is screened (`src/lib/ai/safety/outbound-screen.ts`) and rendered as plain React text.
- Guards: `ai-egress-capability-guard`, `ai-consent-enforcement-guard`, `ai-capability-route-inventory`.

### Integrations and outbound requests

- OAuth tokens, per-user client secrets and API keys are encrypted columns (`prisma/schema.prisma`).
- Webhooks: per-source rate limit first, then a shared secret compared with `timingSafeEqual` (`src/app/api/telegram/webhook/route.ts`, `src/lib/withings/webhook-handler.ts`). The Withings path secret is scrubbed from logs (`src/lib/logging/redact.ts`).
- Egress goes through `safeFetch`: no redirects by default, a timeout, `isPublicUrl` on user-supplied hosts, and a connection pinned to the vetted address with `requirePublicHost` (`src/lib/safe-fetch.ts`, `src/lib/safe-fetch-dispatcher.ts`). An ESLint rule bans raw `fetch(` in server code.

### Operators and admins

- The operator holds the keys and the database; HealthLog does not defend against its own operator. Encryption at rest protects against a leaked dump or disk, not against someone holding `ENCRYPTION_KEYS`.
- Missing or malformed keys stop startup; rotation keeps old keys readable until `scripts/rotate-encryption-key.ts` reports none left (`src/lib/crypto.ts`).
- Admin endpoints are cookie-only; admin actions and every sensitive operation write an audit row (`src/lib/auth/audit.ts`), kept 365 days by default. Restoring a backup needs an admin session with a fresh proof.
- Only variables listed under `environment:` in `docker-compose.yml` reach the container (`compose-env-whitelist-guard`).

### Guardians and shared access

- Acting on another record goes through `requireRecordAuth(need, domain)`, which checks the grant's level and section for each request; the acting state is re-read from the database every time (`src/lib/auth/guards/record.ts`, `acting.ts`). Plain `requireAuth()` refuses while acting as someone else.
- Inviting needs a recent proof, offering MANAGE needs fresh MFA; grants cannot be re-delegated and are audited (`src/app/api/account/grants/route.ts`).
- Guards: `acting-account-boundary-guard`, `sharing-surface-guard`, `consent-grant-explicit-guard`.

### Clinician share links

- A 192-bit token in the URL path, stored as an HMAC, scope frozen at creation, expiry required (at most 90 days); any miss is a flat 404 (`src/app/api/share-links/route.ts`, `src/lib/clinician-share/resolve-share-token.ts`).
- Optional 80-bit passphrase, HMAC-stored, constant-time compare, ten attempts per ten minutes per link before any comparison; the unlock cookie is signed and lasts 30 minutes (`src/app/api/c/[token]/unlock/route.ts`, `src/lib/clinician-share/passphrase.ts`).

### Emergency card public link

- `hlm_` token, HMAC-stored, revocable, optional expiry; each read is rate-limited per address and audited on the owner's trail (`src/lib/emergency-card/token.ts`, `src/lib/emergency-card/serve.ts`).
- The page shows only the fields the owner ticked, runs no script and is served `no-store`.

### MCP

- OAuth 2.1 with PKCE S256 only, exact redirect URIs (https or loopback), short-lived access tokens (`src/lib/mcp/oauth/`). The three OAuth routes use `withBackgroundEvent` instead of `apiHandler` and carry the same protections by hand.
- `health:read` by default, `health:write` opt-in; the `mcp` module is off by default. User text in tool output is wrapped in `<<<USER_TEXT_START>>>` markers so a model can tell data from instructions (`src/lib/mcp/server.ts`).

### Backups and exports

- Off-host dump copies are sealed with `BACKUP_ENCRYPTION_KEY`; the local backup directory is mode 700 (`src/lib/database-backup/run.ts`, `Dockerfile`). Per-account backups are encrypted in chunks (`src/lib/export/backup-chunks.ts`).
- A whole-record export needs a recent proof and is rate-limited; the passphrase archive uses Argon2id and AES-GCM (`src/lib/export/passphrase-archive.ts`). Backup completeness is held by `measurement-backup-completeness` and `mood-backup-completeness`.

### Uploaded files

- Every import has a byte cap before parsing and a structured refusal: Apple Health archives (zip reader with entry and ratio limits, `sax` in strict mode with no entity expansion), FHIR bundles, CSV, FIT (decoded in a child process with a heap ceiling it takes on its own command line, whatever the server's `NODE_OPTIONS`, and a timeout, `src/lib/fit/parse.ts`), Gadgetbridge SQLite (opened read-only off the main thread), documents. Multipart bodies stream to disk under a cap (`src/lib/multipart/stream-to-disk.ts`).
- Whole-text CSV is bounded in rows and columns, uploaded JSON in nesting depth (`src/lib/import/csv-measurements.ts`, `src/lib/import/json-depth.ts`), and a damaged SQLite page is refused as the uploader's file (`src/lib/import/sqlite-off-thread.ts`).
- Property tests feed generated and mutated input to each parser and require a result or a structured refusal, within a time bound where input can be large (`*.fuzz.test.ts` beside each parser).

### Supply chain

- Actions pinned by commit SHA, workflow tokens read-only by default, checkout credentials dropped (`src/__tests__/workflow-hardening-guard.test.ts`). Images are signed with cosign (keyless), carry SLSA provenance and an SBOM; the base images are pinned by digest. Licences of shipped dependencies are checked against a policy (`THIRD_PARTY_NOTICES.md`), and every file states its copyright and licence (`REUSE.toml`, `reuse lint` in CI). Maintainer commits are signed (`docs/contributing/commit-signing.md`).

## Residual risks

- **The operator is trusted.** Whoever holds the environment can read everything. Self-hosting moves trust to the operator; it does not remove it.
- **CSRF rests on SameSite=Lax.** There is no app-wide `Origin` check. A browser that ignores SameSite, or a same-site sibling host under attacker control, weakens it.
- **`SESSION_COOKIE_SECURE=false`** exists for plain-HTTP LAN installs and drops the `Secure` flag; on an open network it exposes the session cookie.
- **CSP allows inline styles** (`style-src 'unsafe-inline'`).
- **Fixed-host egress is not IP-pinned.** `safeFetch` pins only user- or operator-supplied hosts; a hijacked DNS record for a fixed provider host is out of scope.
- **The relay and Apple see metadata.** Push timing reveals when reminders fire; Live Activity content is visible to Apple when the user turns it on.
- **AI with a user's own key** sends the selected data to that provider under the user's own agreement; HealthLog records no consent receipt for it.
- **MCP write confirmation is client-asserted.** Nothing proves a human saw the value before `confirm: true`.
- **Share links and emergency cards are bearer links.** Anyone who sees the URL (and the passphrase, where set) can read until it expires or is revoked; the emergency card has no lockout by design.
- **Invitations reveal whether an address has an account** (rate-limited).
- **Plaintext columns.** Not every column is encrypted; a database dump without the keys still shows record structure, timestamps and unencrypted values.
- **Login geolocation** may ask an online provider about a sign-in address when no GeoLite2 database is mounted; `IP_GEO_LOOKUP_DISABLED=1` turns it off.
