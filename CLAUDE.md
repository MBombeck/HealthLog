# Contributor notes

Working notes for anyone (human or otherwise) editing this repository. Skim before the first PR; refer back when a convention question comes up. Pair with `README.md` (the public face) and `CHANGELOG.md` (the release history); this file is the maintainer's operating manual.

## What HealthLog is

Self-hosted personal-health-tracking PWA: weight, blood pressure, pulse, body composition, glucose, sleep, mood, medication compliance. Withings + Apple Health sync, multi-provider AI Insights (BYOK or local), doctor-report PDF, native iOS client in public beta. Single `docker compose up`, Postgres-backed, AES-256-GCM at rest. AGPL-3.0. Current line: v1.5.x.

## Voice and privacy

Hard rules for every committed artefact — commit messages, CHANGELOG entries, PR bodies, code comments, GitHub release notes, docs site copy. Treat these as the project's public face.

- **Voice.** English. Maintainer prose: present-tense, imperative for commits, factual for prose. No marketing tone, no apology tone, no "wow what a cool feature" framing. The voice is one human writing notes for the next.
- **No assistant / tooling references.** Do not surface AI, agent, assistant, copilot, marathon, phase, wave, round, or session vocabulary into anything that lands on GitHub. The `Co-Authored-By` trailer on commits is fine — it is git metadata and the project accepts that convention; anywhere else, no.
- **No personal data.** No real names (the maintainer's, a reporter's, or anyone else's). No live health figures, no live tenant identifiers, no real-account anchors. Generalise to "a self-hoster", "a user", "an operator", "an authenticated session", etc. The internal `.planning/*` files are gitignored and exempt; everywhere else in the repo, no.

If a draft commit message or release note would violate one of the three, rewrite it before committing. The `git log` is more durable than today's task.

## Branch and release model

- `main` is release-only. Every commit on `main` is either a release commit (`chore(release): vX.Y.Z`), the matching tag push, or a maintenance commit (docs, gitignore, audit findings) that the maintainer chose to apply directly.
- Feature work targets the `develop` branch via topic branches (`fix/X`, `feat/X`), merged into `develop` through PRs with green CI.
- Releases merge `develop` → `main` (squash or merge-commit, document each), then a tag push (`v1.X.Y`) triggers the `docker-publish.yml` workflow.
- Hotfixes branch from `main`, merge back into both `main` and `develop`.
- Never force-push `main`. Never skip hooks (`--no-verify`). Never `--no-gpg-sign` unless explicitly asked.

## Semver

Prefer patch bumps. A release dominated by bug fixes plus additive features without breaking changes ships as `vX.Y.Z+1`, not `vX.Y+1.0`. Bumping minor is reserved for breaking changes, removed flags, deprecated routes, or multi-feature milestones framed as such (e.g. v1.5 = native iOS client + Apple Health integration). Pre-existing example: a `v1.5.0` cut was rerouted to `v1.4.14` mid-flight when the diff turned out to be bugfix-dominated.

## Tech stack at a glance

| Layer | Tech | Notes |
|---|---|---|
| Runtime | Node 22 (Alpine) + pnpm 10.31 | Node version fixed only by the Dockerfile base image; no `.nvmrc` or `engines`. |
| Framework | Next.js 16.2.6 — App Router, `output: "standalone"` | SWC strips `console.*` in prod except `error/warn`. |
| Language | TypeScript 6, `strict: true`, `moduleResolution: "bundler"` | Path alias `@/*` → `./src/*`. `scripts/` excluded from typecheck. |
| UI | React 19.2.5 (exact), Tailwind 4, shadcn/ui (new-york style, zinc base), Radix, Lucide | Recharts 3 for charts — stays; replacement requires explicit approval. |
| Persistence | PostgreSQL 16 + Prisma 7.8 — 47 models | Generated client at `src/generated/prisma`. Production image ships a separate `/opt/prisma-cli` install + `/opt/pg-boss` runtime install (see `Dockerfile:74-83`). |
| Queue | pg-boss 12.18 | Cron + retry semantics live in Postgres tables; workers under `src/lib/jobs/`. |
| Auth | `@simplewebauthn/server` 13, `@node-rs/argon2` 2 | Passkey + Argon2id password, server-side sessions in Postgres. |
| Notifications | `@parse/node-apn` 8 (APNs), `web-push` 3 (VAPID), raw fetch for Telegram + ntfy | Per-channel `recordPushAttempt` row, hard-reject classification. |
| Forms / validation | `react-hook-form` 7 + `zod` 4 + `@hookform/resolvers` + `zod-openapi` 5 | The Zod registry is the source of truth for `docs/api/openapi.yaml`. |
| Testing | Vitest 4 (unit + integration), Playwright 1.60 (e2e), `@axe-core/playwright` | Integration runs against a `testcontainers/postgresql` Postgres 16. |
| Container | Multi-stage Alpine Dockerfile, GHCR multi-arch (`amd64` + `arm64`) | `pull_policy: always` in `docker-compose.yml` is load-bearing — without it Docker re-uses the stale `:latest` digest. |

More detail in `.planning/codebase/tech.md`, generated as part of the v1.5.2 codebase audit.

## How a request flows

```
client
  │ HTTP
  ▼
src/proxy.ts                         renamed from middleware.ts. Public-path allowlist,
  │                                  demo-mode mutation block, server-side onboarding
  │                                  redirect, worker-only refusal, request-id + nonce
  │                                  generation, every security header.
  ▼
src/app/<route>/route.ts             every API route wraps in `apiHandler(...)`
  │
  ▼
src/lib/api-handler.ts               WideEventBuilder + AsyncLocalStorage, auth resolver
  │                                  (cookie OR Bearer), idempotency, error envelope,
  │                                  GlitchTip forwarder. Cookie path can elevate to
  │                                  admin via requireAdmin(); Bearer never can.
  ▼
handler body                         Zod parse (`safeParse` + `returnAllZodIssues`),
  │                                  business logic, `annotate({ action, meta })`,
  │                                  `auditLog()` for sensitive ops.
  ▼
src/lib/api-response.ts              `apiSuccess(data, meta?)` / `apiError(msg, status,
  │                                  meta?)` — every response is `{ data, error, meta? }`.
  ▼
src/proxy.ts                         security headers attach, request-id echoes.
  ▼
client
```

The architecture map in `.planning/codebase/arch.md` walks each layer with file:line citations.

## Code conventions

- **RSC by default.** Server components are the default; add `"use client"` only when a hook, state, or browser API actually needs it.
- **Every API route wraps in `apiHandler`.** Verified — zero exceptions in the current tree. Every body-accepting route runs Zod `safeParse` and returns 422 via `returnAllZodIssues` (multi-issue envelope sanitised against echoed input through `sanitiseZodIssues`).
- **`userId` is always narrowed from session or Bearer.** No route accepts `userId` as a body field — it comes from `requireAuth()` and feeds the Prisma `where`. The batch endpoints (`/api/measurements/batch`, `/api/mood-entries/bulk`, `/api/medications/intake/bulk`, `/api/workouts/batch`) don't even declare a `userId` field in their Zod schemas.
- **No mass assignment.** Every `prisma.X.{create,update}({ data: ... })` builds its `data` object field-by-field from `parsed.data`, never by spreading the parsed object whole. `tokens.create` hardcodes the narrow scope so the user-facing endpoint can never mint a wildcard token.
- **`requireAdmin()` is cookie-only.** Bearer tokens — even with `["*"]` scope — cannot reach admin endpoints. This is a structural boundary at `src/lib/api-handler.ts:414-431`, not a runtime check that future code can soften.
- **Raw SQL is parameter-bound or whitelist-spliced.** Every `$queryRaw` uses tagged-template parameters. Every `$queryRawUnsafe` / `$executeRawUnsafe` either passes positional `$N` placeholders with an argument array OR splices a value already asserted against a closed enum + regex (see `src/lib/rollups/measurement-rollups.ts:330-343`). Inline comments document the whitelist at the splice point.
- **TanStack Query keys live in the centralised factory.** `src/lib/query-keys.ts` is the only legal source of `queryKey` / `mutationKey` arrays. The in-repo ESLint rule `healthlog/queryKey-factory` (set to `error`) flags any bare array. Same-key + different `queryFn` shape silently poisons the cache; the factory prevents it. Every read unwraps `(await res.json()).data` from the envelope.
- **`annotate()` on every interesting code path.** Wide-event observability. Action names follow `<surface>.<noun>.<verb>` (`coach.budget.exceeded`, `measurement.batch.ingest`). Don't free-text in `meta` — pin the shape so dashboards stay stable.
- **i18n keys exist for every `t()` call.** `i18n-call-site-coverage.test.ts` walks every `.ts(x)` under `src/`, extracts every `t("ns.key")` literal, and asserts each key resolves in `messages/en.json`. `i18n-locale-integrity.test.ts` propagates the EN guarantee across `de / en / es / fr / it / pl`. If a guard fails, fix the bundle, don't suppress the test.
- **OpenAPI registry stays in sync.** Zod schemas carry `.meta()` annotations under `src/lib/openapi/`; `pnpm openapi:generate` emits `docs/api/openapi.yaml`. CI fails on drift. Re-run the generator after touching a request / response schema and commit the YAML alongside the Zod change.
- **File naming.** Components and lib files: kebab-case (`daily-briefing.tsx`, `secure-cookie.ts`). Hooks: `use-` prefix kebab-case (`use-coach-prefs.ts`). React component exports stay PascalCase regardless of filename. The 18 PascalCase outliers under `src/components/medications/` + `src/components/onboarding/` are pre-existing drift and worth cleaning up when the surrounding files come up for edit.

## Tests and commands

- `pnpm typecheck` — `tsc --noEmit`. Required before every commit.
- `pnpm lint` — ESLint flat config with `eslint-config-next` + the project's `healthlog/queryKey-factory` rule. One harmless warning in `withings/resume/__tests__/route.test.ts` is allowed; everything else should be clean.
- `pnpm test` — Vitest 4 unit + component suite. Required before pushing a fix; full suite is fast (~30 s).
- `pnpm test:integration` — Vitest against a `testcontainers/postgresql` Postgres 16. Needs Docker / OrbStack running. Slower but pins the contracts the unit-mocks can't.
- `pnpm e2e` — Playwright against `pnpm exec next build` + Postgres. Heavy; CI runs it, locally only when touching UI flows.
- `pnpm openapi:generate` — regenerates `docs/api/openapi.yaml` from the Zod registry. Run after any request / response schema change. CI's `openapi:check` fails the build on drift.
- `pnpm check-env` — validates that `.env.production.example` covers every required variable. Wired into CI as `env-check.yml`.
- `pnpm bundle-report` / `ANALYZE=1 pnpm build` — bundle inspection. Use when a feature adds material weight.
- One-shot scripts live in `scripts/`. Run them via `pnpm dlx tsx scripts/<file>.ts` — the production standalone image strips `tsx` and the bare `pnpm tsx ...` invocation fails inside the container. Recurring tasks belong on pg-boss, not on a CLI script.

## Critical-files map

| Concern | File | What it owns |
|---|---|---|
| HTTP edge | `src/proxy.ts` | Public-path allowlist, demo-mode block, onboarding redirect, request-id + CSP nonce, every security header, worker-only refusal. |
| API kit | `src/lib/api-handler.ts` (490 LOC) | `apiHandler` wrapper, `requireAuth` / `requireAdmin`, idempotency plumbing, GlitchTip forwarder. |
| Response envelope | `src/lib/api-response.ts` | `apiSuccess` / `apiError`, `safeJson` (now with opt-in `maxBytes`), trusted-proxy IP resolver, `returnAllZodIssues` + `sanitiseZodIssues`. |
| Crypto at rest | `src/lib/crypto.ts` | AES-256-GCM with versioned key ids, `extractKeyId`, fail-closed loader, rotation primitives. Rotation CLI: `scripts/rotate-encryption-key.ts`. |
| Session | `src/lib/auth/session.ts` + `src/lib/auth/secure-cookie.ts` | Postgres-backed sessions, sliding 30-day expiry, `shouldEmitSecureCookie()` the one source of truth for the `Secure` flag (every cookie setter routes through it). |
| Refresh tokens | `src/lib/auth/refresh-token.ts` | Per-device one-time-use rotation with reuse-detection that revokes the device's token family. |
| Bearer tokens | `src/lib/auth/hmac.ts` + `src/lib/auth/issue-token.ts` | HMAC-SHA256 hashing under `API_TOKEN_HMAC_KEY`; no plaintext path; `lastUsedAt` updated fire-and-forget. |
| Rollup tier | `src/lib/rollups/` | DAY / WEEK / MONTH / YEAR pre-aggregations. Read-swap pattern: try the rollup, fall back to live SQL only on coverage miss. Boot-time `rollup-full-backfill` queue handles new accounts. |
| Compliance | `src/lib/analytics/compliance.ts` | Cadence-aware medication compliance — daysOfWeek + intervalWeeks honoured across the eight call sites that surface a rate (Coach prompt, BP-status gate, dashboard pillar, …). |
| AI providers | `src/lib/ai/provider-chain.ts` + `src/lib/ai/{openai,anthropic,local,codex,mock}-client.ts` | Five providers, hand-rolled fetch over the documented wire (no vendor SDKs). Mock is not registered in `resolveProvider()` — production cannot reach it. |
| Notification dispatcher | `src/lib/notifications/dispatcher.ts` + `src/lib/notifications/senders/` | APNs → Telegram → ntfy → Web Push cascade, hard-reject classification, `push_attempts` ledger with 90-day retention. |
| Coach | `src/app/api/insights/chat/route.ts` + `src/lib/ai/coach/` | SSE stream, budget gate + per-user rate gate, refusal detector, snapshot builder, message persistence with `encryptedContent` Bytes column. |
| OpenAPI | `src/lib/openapi/registry.ts` + `src/lib/openapi/routes.ts` | Source of truth for `docs/api/openapi.yaml`. |
| Schema | `prisma/schema.prisma` (47 models) | `cuid()` PKs, `snake_case` columns via `@map`, encrypted columns mostly under `*Encrypted` (search the file). |
| Compose | `docker-compose.yml` | `app` + `db`. Env-var whitelist under `environment:` — vars not listed never reach the container. `pull_policy: always` is load-bearing. |

`.planning/codebase/arch.md` carries the full annotated walk for every section.

## Security-relevant patterns

The v1.5.2 audit produced `.planning/security-audit-v1.5.2.md` and a stack of per-domain findings under `.planning/security-audit-findings/`. The patterns worth preserving on future churn:

- **Encryption: fail closed everywhere.** Missing keys, malformed JSON, unknown key ids — every path throws rather than silently writing plaintext. Operators rotating keys must keep the legacy entry in `ENCRYPTION_KEYS` until the rotation script reports zero remaining legacy rows. The script covers every `*Encrypted` column + `CoachMessage.encryptedContent` (Bytes) + `IntegrationStatus.lastError`.
- **SSRF: input-time `isPublicUrl` is the floor.** The helper in `src/lib/validations/notifications.ts:64` catches every IPv4 / IPv6 alt-notation class (octal / hex / decimal IPv4, IPv4-mapped IPv6, IPv6 ULA, CGNAT, link-local, loopback, metadata). Use it for every outbound URL that comes from a user / admin input. DNS rebinding and the redirect-follow gap remain as architectural follow-ups (issues #217 + #218). Until those land, every NEW outbound `fetch()` that touches a user-controlled host must pin `redirect: "manual"` and an `AbortSignal.timeout`.
- **Outbound egress goes through `safeFetch`.** `src/lib/safe-fetch.ts` is the one documented egress entry (`redirect: "manual"` + `AbortSignal.timeout(15_000)` defaults; opt into the connect-time DNS-rebinding pin with `requirePublicHost: true` for any operator- or user-supplied host). The in-repo ESLint rule `healthlog/safe-fetch-required` (set to `error`) bans raw `fetch(` under `src/lib/` + `src/app/` outside the wrapper internals and test files; same-origin relative-path (`/api/…`) client fetches are exempt by construction.
- **Rate limits live in Postgres.** `src/lib/rate-limit.ts` uses a single atomic SQL upsert returning `{count, reset_at}`. Multi-instance correctness is structural. Bucket-key convention: `<surface>:${identifier}` where identifier is `userId` for authenticated routes and the trusted-proxy IP for anonymous. Anonymous auth surfaces use `checkAuthSurfaceRateLimit(...)` so a trust-violation collapses every anonymous caller into a single tight bucket rather than a free-for-all under the unknown-IP bucket.
- **Webhooks: shared-secret + `timingSafeEqual` + per-source rate limit BEFORE secret verification.** Withings, Telegram, moodLog, the Coolify deploy webhook, and the CSP report endpoint all follow this exact pattern. The Withings path-segment secret is scrubbed from `http.path` / `http.route` by `redactSecrets()` via the `PATH_SECRET_PATHS` registry in `src/lib/logging/redact.ts:40`.
- **Idempotency keys are user-scoped, length-bounded, and refuse to cache secret-shaped responses.** `src/lib/idempotency.ts`. A client cannot replay another user's idempotency key (composite unique index by `userId_key_method_path`). The cache helper refuses to persist a response body containing `hlk_` / `hlr_` / `sk-` patterns even if a future caller wraps an auth endpoint by mistake.
- **CSP: strict, per-request nonce, surgical `connect-src`.** Production CSP gates third-party hosts to the routes that need them — AI hosts only on `/settings/ai/*`, `wbsapi.withings.net` only on `/settings/integrations/withings/*` + `/api/withings/*`. Exactly one `dangerouslySetInnerHTML` in the tree (the theme bootstrap in `src/app/layout.tsx`, nonce-bound, file-literal content). No markdown library installed anywhere; Coach / briefing / insights render as plain React text children. Don't add one without a security review of the renderer's HTML-allow defaults.
- **No CORS headers anywhere.** Same-origin-only by construction. Adding `Access-Control-Allow-Origin: *` anywhere would silently open every authenticated endpoint to cross-origin POST; webhook routes accept cross-origin POSTs but they authenticate by header secret, not cookie.
- **Redaction at the egress boundary, not at the call site.** `redactSecrets()` + `redactSensitiveFields()` + `redactOptional()` are applied centrally in `WideEventBuilder` and `reportToGlitchtip`. Don't add new redactor calls in handler bodies — extend the central denylists in `src/lib/observability/redact-payload.ts` and `src/lib/logging/redact.ts`.

## Self-hosting gotchas

These keep tripping operators; they're worth knowing before you push something that breaks them.

- **`SESSION_COOKIE_SECURE`** controls the `Secure` flag on every cookie the app issues. Unset → flag tracks `NODE_ENV === "production"`. Set to `false` for LAN / Tailscale / VPN-only HTTP self-hosts where the operator deliberately serves plain HTTP. Set to `true` to force the flag even in dev. The compose `environment:` block must list it explicitly — vars not on the whitelist don't reach the container even when `.env` has them. v1.5.2 closed the missing-whitelist regression.
- **`pull_policy: always`** in `docker-compose.yml` is load-bearing. Without it Docker keeps a stale `:latest` digest cached and silently skips the registry round-trip on `compose up`.
- **`ENCRYPTION_KEYS` map vs legacy `ENCRYPTION_KEY`.** The map (`{"v1":"<hex>","v2":"<hex>"}` + `ENCRYPTION_ACTIVE_KEY_ID=v2`) is the modern path. The legacy single-key env var stays accepted as `v1`. Rotation playbook lives at `docs/ops/encryption-key-rotation.md`; do NOT drop a key from the map before the rotation script reports zero remaining rows on that key.
- **GeoLite2 databases.** Operators run `scripts/fetch-geolite2.sh` with a MaxMind licence key before `docker build`; the image bakes the MMDBs into `/opt/geolite2/`. Without them the resolver falls back to online `ipwho.is` and the admin login overview surfaces "unknown" for offline lookups.
- **APNs `.p8` key.** v1.4.47.x established `APNS_KEY_B64` as the env-var contract — pasting the PEM body verbatim through Coolify's `env_file` mangled the literal newlines. The key must be scoped "Sandbox & Production" in the Apple Developer Portal; a Sandbox-only key fails with `BadEnvironmentKeyInToken` on production builds.

## iOS handoff

The native SwiftUI client lives in a separate repository and rides public beta via TestFlight. Backend contract the iOS app speaks against is locked in `docs/api/openapi.yaml` and has been continuously validated since v1.4.23. Coordination notes worth knowing on the backend side:

- `POST /api/measurements/batch` recognises `externalId` values starting with `stats:` (e.g. `stats:HKQuantityTypeIdentifierStepCount:YYYY-MM-DD`) as **overwrites** — a re-post replaces the row's value / unit / measuredAt / externalSourceVersion / deviceType / sleepStage. Every other externalId prefix (`uuid-*`, opaque HK identifiers) keeps the first-write-wins immutable contract because each sample is a canonical reading. Per-entry status field carries `"updated"` for an overwrite vs `"inserted"` for a fresh row.
- Refresh-token rotation is per-device; reuse-detection revokes the family scoped to that device.
- `requireAdmin()` is cookie-only by construction — a Bearer token, even with `["*"]` scope, cannot reach `/api/admin/*`. The iOS app is not an admin client.
- The `clientManaged` opt-in on `PATCH /api/auth/me/notification-prefs` suppresses server-side `MEDICATION_REMINDER` APNs for clients that manage their own local reminders. The cron skips dose-due APNs when the flag is `true` and emits a `medication_reminder.suppressed_client_managed` wide-event annotation per skip.
- `push_attempts` table holds the last 90 days of APNS / Web-Push / Telegram / NTFY delivery attempts (channel + eventType + result + reason + createdAt). The admin diagnostic endpoint at `/api/admin/notifications/diagnostic` surfaces masked device tokens + channel state + last 20 attempts for the calling user.
- Any request / response schema change must regen `docs/api/openapi.yaml` and commit the result. CI fails on drift.

## DO-NOTs

- **No `--no-verify` on commits.** If a pre-commit hook fails, fix the cause; never bypass.
- **No `--no-gpg-sign` unless explicitly asked.**
- **No force-push to `main`** (or to release branches, by extension).
- **No destructive git operations as shortcuts.** `git reset --hard`, `git clean -fd`, `git checkout .` etc. only when the maintainer asked or the state is unambiguously local-only.
- **No assistant / planning vocabulary in any committed artefact** — see Voice and privacy above.
- **No personal names** — the maintainer's, a reporter's, or anyone else's — in any committed artefact, including code comments referring to "the user who reported issue #X".
- **No secret-shaped strings in `.env.example` or git history.** Pre-existing scan shows clean.
- **No markdown library in dependencies.** Coach + briefing + insights render as React text children for XSS reasons; adding one is a security decision, not a UX one.
- **No `Access-Control-Allow-Origin` headers** anywhere except the documented webhook surfaces — and those authenticate via header secret, not cookie.
- **No `pnpm tsx scripts/foo.ts` in production.** The standalone image strips `tsx`. One-shot scripts run via `pnpm dlx tsx`; recurring tasks belong on pg-boss.
- **No backwards-compatibility shims for hypothetical callers.** When a change is clean, make it cleanly; do not leave dead branches "in case" something we don't ship needs them.

## Pointers

| What | Where |
|---|---|
| Public face | `README.md` |
| Release history | `CHANGELOG.md` |
| Codebase audit (v1.5.2) | `.planning/codebase/{tech,arch,quality,concerns}.md` |
| Security audit (v1.5.2) | `.planning/security-audit-v1.5.2.md` + `.planning/security-audit-findings/*` |
| Operator runbooks | `docs/ops/` (deploy, encryption-key-rotation, env-check, backup-restore, migrations) |
| Self-hosting guide | `docs/self-hosting/` |
| Public API contract | `docs/api/openapi.yaml` |
| Architecture diagrams | `docs/diagrams/` (rendered through `docs.healthlog.dev`) |
| iOS coordination notes | `.planning/ios-coord/` |
| Maintainer working notes | `.planning/PROJECT.md`, `.planning/ROADMAP.md`, `.planning/STATE.md` (gitignored release scratch lives alongside; the patterns are in `.gitignore`) |
| Personal preferences + collaboration memory | `~/.claude/projects/-Users-marc-Projects-HealthLog/memory/MEMORY.md` (local to the maintainer's working copy; not in the repo) |
