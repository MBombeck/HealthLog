# Documentation Depth Audit — 2026-05-16

## Executive summary

The repo carries **11 first-party docs files** plus an `audit/` archive of 24 release-cycle summaries. The strongest material lives in three operator-ops notes (`docs/ops/backup-restore.md`, `docs/ops/encryption-key-rotation.md`, `docs/self-hosting/scaling.md`) — these are accurate, well-cited, and confident. Everything else is either missing, archived audit prose that isn't user-facing, or thin. The headline gap: **`docs/` has no getting-started, no integration guides, no source-priority spec, no cache-contract page, no observability page, no security model, and no localisation contribution guide**, yet `README.md:107` and `README.md:463` send self-hosters to `docs.healthlog.dev` — a domain whose source-of-truth folder is this same `docs/` tree. The OpenAPI spec is **deliberately the iOS-codegen subset** (~14 paths) against **181 actual route handlers**, which is correct intent but reads as a contradiction with `docs/api/README.md:55-56` ("**paths** — all routes from `src/app/api/**/route.ts`"). Apple Health import — the v1.4.34 banner feature — is mentioned in one OpenAPI batch endpoint and the App Store checklist; the user-facing upload flow (`POST /api/import/apple-health-export`) is undocumented in `docs/`. Recommended write-order: getting-started → integrations triple (Apple Health, Withings, AI) → self-hosting full guide (proxy + Coolify + Kubernetes) → source-priority spec → security model → cache contract → observability → i18n contribution guide → API reference reconciliation.

## Audit matrix

| Topic | Status | File(s) | Notes |
|--|--|--|--|
| Self-hosting | △ | `docs/self-hosting/scaling.md`, `docs/migration/v1.3-to-v1.4.md`, `README.md:80-107` | Only the web/worker split is documented. Reverse-proxy + Coolify + bare-metal + Kubernetes paths are **missing** from `docs/`; `README.md:107` links to a `docs.healthlog.dev/self-hosting/reverse-proxy/` page that has no source in-repo. v1.4.34.2 `pull_policy: always` only documented inline in `docker-compose.yml`. |
| Env-var reference | △ | `README.md:146-169`, `.env.example` | `.env.example` is exhaustive and excellent. README has a short table that **omits** `ENCRYPTION_KEYS`, `BACKUP_*`, `APNS_*`, `LOKI_*`, `HEALTHLOG_PROCESS_TYPE`, `INSIGHTS_RATE_LIMIT_PER_HOUR`, `DEPLOY_WEBHOOK_SECRET`. No consolidated `docs/self-hosting/configuration.md`. |
| API reference | △ | `docs/api/openapi.yaml`, `docs/api/README.md`, `README.md:240-386` | OpenAPI is the **iOS codegen subset** (14 paths, locked contract). README has a manual table that covers more surface but is stale (omits `/api/measurements/batch`, `/api/workouts/batch`, `/api/sync/state`, `/api/measurement-categories`, `/api/devices`, `/api/import/apple-health-export`, `/api/integrations/healthkit`, the side-effects / inventory / titration medication sub-routes, `/api/insights/chat`, `/api/auth/me/source-priority`). `docs/api/README.md:55-56` claims OpenAPI covers all routes — false. |
| OpenAPI accuracy | △ | `docs/api/openapi.yaml` | Spec version is `1.4.23`; package is `1.4.34.3`. Spec is internally consistent but the version drift contradicts `package.json` mirror claim at `docs/api/README.md:38`. `openapi-v1422-legacy.yaml` is still in the tree with no README pointer explaining whether it's archive or fallback. |
| Apple Health import | ✗ | nowhere user-facing | OpenAPI documents `/api/measurements/batch` (HK batch ingest from iOS app). The **`export.zip` upload flow** — `POST /api/import/apple-health-export`, status polling, idempotency on file SHA-256, 1.5 GB cap, admin variant, supported HK types map, error recovery — is **undocumented in `docs/`**. v1.4.34 banner feature; only the App Store checklist mentions "Apple Health". |
| Withings integration | ✗ | nowhere | OAuth setup (developer.withings.com app registration, redirect URI, webhook secret), the `/api/withings/webhook/[token]` v1.4.25 W17a migration, source-priority interaction — none captured. `.env.example` has the env-var stubs; `docs/` has no how-to. |
| AI provider BYOK | ✗ | nowhere user-facing | The provider chain (`src/lib/ai/provider-chain.ts`), the four providers (OPENAI / ANTHROPIC / LOCAL / CHATGPT_OAUTH via `src/lib/ai/codex-client.ts` / admin-shared key), fallback order, BYOK key acquisition steps, cost expectations, the privacy stance for LOCAL vs cloud providers — none captured. `codex-protocol-spec.md` exists but is a 1300-line reverse-engineered protocol reference for `chatgpt.com/backend-api/codex/responses`, not a user-facing BYOK guide. |
| Doctor-report PDF | ✓ | `docs/doctor-report.md` | Both endpoints documented, locale resolution explicit, rate limit captured, audit-log action named, jsPDF-in-Node rationale included. Light on customisation guidance (per-locale translation overrides) but the API surface is accurate. |
| Source-priority ladder | ✗ | nowhere | The canonical APPLE_HEALTH ≻ WITHINGS ≻ MANUAL ≻ IMPORT ordering, the two-axis source + device-type ladder (v1.4.25 W8c at `src/lib/validations/source-priority.ts:18-32`), the `User.sourcePriorityJson` override, the "drop from aggregation, keep as audit" contract, `pick-canonical-workout.ts` — none surfaced to users or self-hosters. This is core conceptual material. |
| Cache + invalidation contract | ✗ | nowhere | `src/lib/cache/server-cache.ts:269-286` ships `cache.<name>.outcome` wide-event annotations and `src/lib/cache/invalidate.ts` owns the per-user invalidation matrix. v1.4.34.1 closure called this out specifically. Zero docs coverage. |
| Deploy + release pipeline | △ | `docs/audit/v1414-summary.md:224-265`, `docs/audit/v1423-summary.md:36-66`, `docker-compose.yml` inline comment | GHCR build + Coolify auto-deploy + `pull_policy: always` (v1.4.34.2) + the host-side retag fallback recipe (cited five times across audits) exists only as scattered audit-trail prose. No `docs/self-hosting/coolify.md` runbook. |
| Security model | ✗ | nowhere | `SECURITY.md` is the disclosure policy. Passkey vs password vs API token (`hlk_*` Bearer), encryption-at-rest scheme (AES-256-GCM with versioned key prefix — only the rotation procedure is documented, not the model), audit-log scope, rate-limit policy (`src/lib/rate-limit.ts`), session-cookie shape — none captured as a "how this app is hardened" page. |
| iOS native client | △ | `docs/apple-store-connect-checklist.md`, `docs/api/openapi.yaml` | Submission checklist is comprehensive. The handoff brief (server contracts, AASA at `src/app/.well-known/apple-app-site-association/route.ts`, APNs config at `.env.example` `APNS_*`, X-Device-Id header, refresh-token rotation) is split across `docs/migration/v1.3-to-v1.4.md:86-93,118-122` + OpenAPI + `.env.example`. No single `docs/ios-handoff.md`. |
| i18n / localisation | △ | `docs/ui-guidelines.md:421-430` | One paragraph in UI guidelines. No contributing-a-new-locale guide, no key-naming conventions doc (the `admin.section.<slug>.*` namespace landed in v1.4.14 per `docs/audit/v1414-summary.md:84`), no plural-rules reference. `messages/{de,en}.json` carry 1500+ keys per `README.md:72`. |
| Backup + restore | ✓ | `docs/ops/backup-restore.md` | Wire format + env-var table + restore script invocation + lifecycle-rule recommendation all explicit. Restore "import the JSON back" step is hand-waved ("use `prisma db seed` or a custom script") — minor gap, otherwise excellent. |
| Encryption-key rotation | ✓ | `docs/ops/encryption-key-rotation.md` | Format spec, three rotation walkthroughs, rollback caveat, troubleshooting matrix. Best file in the tree. |
| Observability | ✗ | `.env.example:100-115` only | Wide-event logging (`src/lib/logging/`), `cache.*.outcome` annotations, Loki transport, `LOG_SAMPLE_RATE` + `LOG_SLOW_THRESHOLD_MS` + `LOG_INCLUDE_STACK` semantics, the Glitchtip + Umami test endpoints — only the env vars get a comment-block; no operator-facing observability guide. |
| Docs landing page | ✗ | no `docs/README.md` | The `docs/` root has no index. A visitor cloning the repo and running `ls docs/` sees a folder soup with no orientation. |

## Findings — prioritized

### F-1: No getting-started guide in `docs/` — README is the only path

**Severity**: critical
**Topic**: Self-hosting
**File(s) / Gap**: MISSING — no `docs/getting-started.md`
**What's wrong / missing**: A self-hoster reading `README.md:80-107` gets a 3-minute quick start that assumes a working Docker + working DNS + an understanding of where to put the reverse-proxy block. The README explicitly punts on TLS ("See [Self-Hosting → Reverse Proxy](https://docs.healthlog.dev/self-hosting/reverse-proxy/)" — `README.md:107`) and on Coolify ("Works out of the box with Coolify" — `README.md:439`), but neither destination exists in this repo. The discoverability audit's F-10 already noted that `docs/` looks "operator-/audit-heavy"; the depth gap is that **the user-facing surface has no in-repo source-of-truth at all**, so the docs site cannot be regenerated from the repo.
**Fix shape**: `docs/getting-started.md` — 800–1200 words. Sections: prerequisites (Docker 26+, 2 GB RAM, 10 GB disk), the four-secret `.env` bootstrap, first boot (admin promotion of first user), where things go wrong (Postgres healthcheck race, hostname mismatch when `APP_URL` doesn't match the actual host header), and the next-step matrix (TLS reverse proxy / Coolify / Kubernetes / observability).
**Effort**: medium

### F-2: No reverse-proxy / Coolify / Kubernetes / bare-metal guides

**Severity**: critical
**Topic**: Self-hosting
**File(s) / Gap**: MISSING — `docs/self-hosting/` has only `scaling.md`
**What's wrong / missing**: The README sends users to four implicit deploy paths (Docker Compose, reverse proxy, Coolify, Kubernetes — the README claims "works out of the box with Coolify" at `README.md:439`) but only Docker Compose has a real walkthrough. The `pull_policy: always` line (`docker-compose.yml:13`) that landed in v1.4.34.2 to fix Coolify's stale-digest cache is documented **only** inline in the compose file. The host-side retag fallback recipe (`docker pull → docker tag → docker compose up -d --force-recreate`) is cited across `docs/audit/v1423-summary.md:66`, `docs/audit/v1419-summary.md:115-123`, `docs/audit/v1421-summary.md:14`, `docs/audit/v1414-summary.md:224-231` — but never promoted out of audit prose into a self-hosting runbook.
**Fix shape**: Four files. `docs/self-hosting/reverse-proxy.md` (Caddy / Traefik / Nginx blocks, the exact `NEXT_PUBLIC_APP_URL` + `APP_URL` pairing, headers to forward, healthcheck path). `docs/self-hosting/coolify.md` (project bootstrap, the "Watch image registry for new digests" toggle that's the load-bearing piece per `docs/audit/v1423-summary.md:95`, webhook secrets, the auto-deploy gate at `/api/internal/deploy-webhook`, the host-side retag fallback). `docs/self-hosting/kubernetes.md` (a minimal Deployment + Service + Secret manifest, init-container for `prisma migrate deploy`, the `HEALTHLOG_PROCESS_TYPE=web|worker` split as separate Deployments). `docs/self-hosting/bare-metal.md` (Node 20+, pnpm, systemd unit, Postgres via host package). Each 600–900 words.
**Effort**: large

### F-3: Apple Health import end-to-end is undocumented

**Severity**: critical
**Topic**: Apple Health import (v1.4.34 banner)
**File(s) / Gap**: MISSING — no `docs/integrations/apple-health.md`
**What's wrong / missing**: The banner feature of v1.4.34 has zero user-facing documentation in `docs/`. The endpoint set is `POST /api/import/apple-health-export` (user kick-off, multipart upload, 1.5 GB cap, 3-uploads/min rate limit, content-hash idempotency per `src/app/api/import/apple-health-export/route.ts:42-46`), `GET /api/import/apple-health-export/[jobId]/status` (polling), and `POST /api/admin/import-apple-health-export` (admin variant). The supported HK type set (`src/lib/measurements/apple-health-mapping.ts`), the streaming-to-disk approach (`src/lib/multipart/stream-to-disk.ts`), the `apple-health-import-worker.ts` job behaviour (queue depth, retries, what fails idempotently vs hard), and error recovery (re-upload merges on file SHA-256 short-circuit) all need an operator-facing page. The OpenAPI documents the **iOS HK batch ingest** at `/api/measurements/batch` (line 67) but not the `export.zip` flow.
**Fix shape**: `docs/integrations/apple-health.md` — 1200–1500 words. Sections: what gets imported (HK quantity types map → HealthLog measurement types, workouts, correlations), how to export from iOS (Health app → profile → Export All Health Data), the upload UI flow + endpoint contract, idempotency (SHA-256 of bytes), what happens on duplicate types when Withings was sync'ing the same metric (source-priority ladder cross-link), failure modes (corrupt zip, partial XML, job retry), the admin variant for migrating other users' data, observability (`apple-health-import` queue name in the worker, `cache.apple-health-import.outcome`).
**Effort**: medium

### F-4: Withings integration setup is undocumented

**Severity**: critical
**Topic**: Withings integration
**File(s) / Gap**: MISSING — no `docs/integrations/withings.md`
**What's wrong / missing**: `.env.example:62-70` carries the env-var stubs with a one-line "Register an app at https://developer.withings.com/" pointer. The actual setup — Withings developer-portal app creation, OAuth client ID/secret pasting, the redirect URI (`/api/withings/callback`), the **webhook secret path-segment migration** in v1.4.25 W17a (`/api/withings/webhook/[token]` per `src/app/api/withings/webhook/route.ts:18-25`, with the legacy `?secret=` form deprecated and tracked via `withings.webhook.legacy_form_total` until v1.4.27 cutover), the `user.activity` OAuth scope shipped in v1.4.25 W5d, the source-priority ladder interaction, sync-frequency expectations — is documented nowhere user-facing.
**Fix shape**: `docs/integrations/withings.md` — 1000–1300 words. Sections: provisioning the Withings developer app (with screenshots-or-text walkthrough), env-var paste, the OAuth dance + callback URL, the webhook URL pattern (path-segment form), the v1.4.25 W17a migration notice for existing installs, what gets synced (scales, BP, activity), source-priority interaction (Withings = mid-priority by default; APPLE_HEALTH overrides), troubleshooting (token expiry, re-auth, the admin probe at `POST /api/integrations/withings/test`).
**Effort**: medium

### F-5: AI provider BYOK setup is undocumented (Marc-stated differentiator)

**Severity**: critical
**Topic**: AI provider BYOK
**File(s) / Gap**: MISSING — no `docs/integrations/ai-providers.md`
**What's wrong / missing**: Auto-memory captures "AI Insights are the main differentiator." The provider chain owns four implementations (`src/lib/ai/openai-client.ts`, `anthropic-client.ts`, `local-client.ts`, `codex-client.ts` with the `CHATGPT_OAUTH` flow at `src/app/api/auth/codex/authorize`), a provider-chain fallback orchestrator (`src/lib/ai/provider-chain.ts`), and `codex-protocol-spec.md` — a 1300-line reverse-engineered protocol spec for the ChatGPT-backed codex endpoint. There is no user-facing "how do I plug in my Anthropic key" page, no cost-expectation table, no privacy table comparing OPENAI/ANTHROPIC (data leaves your network) vs LOCAL (Ollama / LM Studio / vLLM at your endpoint — data stays), no fallback-chain semantics (what happens when BYOK fails — does it fall to admin-shared? what's the user-visible error?), no rate-limit budget guidance (`INSIGHTS_RATE_LIMIT_PER_HOUR` exists at `.env.example:88-92` but is only meaningful with cost context).
**Fix shape**: `docs/integrations/ai-providers.md` — 1500–2000 words. Sections: provider matrix (OPENAI / ANTHROPIC / LOCAL / CHATGPT_OAUTH — endpoint, key acquisition URL, supported models, monthly cost estimate per active user, privacy stance, fallback rank), BYOK setup per provider (settings UI walkthrough), admin-shared-key vs per-user-key trade-off, the fallback chain (what triggers fallback, what's the user-visible failure), local-endpoint guides (Ollama / LM Studio / vLLM URL formats, model selection), the `/api/ai/test` probe contract, troubleshooting (codex slug-drift defence per `docs/codex-protocol-spec.md:638`), the rate-limit budget knob.
**Effort**: large

### F-6: Source-priority ladder spec is not user-facing

**Severity**: high
**Topic**: Source-priority ladder
**File(s) / Gap**: MISSING — no `docs/concepts/source-priority.md`
**What's wrong / missing**: The canonical APPLE_HEALTH ≻ WITHINGS ≻ MANUAL ≻ IMPORT ordering is implemented in `src/lib/validations/source-priority.ts:9-32` with the v1.4.25 W8c two-axis device-type extension, applied per-day in `src/lib/analytics/source-priority.ts:1-30` for cumulative metrics (steps, active energy, distance, flights, sleep), and overridable per-user via `User.sourcePriorityJson` + `PUT /api/auth/me/source-priority`. The "drop from aggregation, keep as audit trail" contract is load-bearing for the dedup semantics. Self-hosters who run Apple Watch + iPhone + Withings scale will be triple-counting steps until they understand it. Nothing in `docs/` explains this.
**Fix shape**: `docs/concepts/source-priority.md` — 700–1000 words. Sections: the problem (multi-source dedup), the default ladder, per-metric vs per-device priority axes, the "drop from aggregation, keep in DB as audit trail" contract, how to override per user, the settings UI surface (`/settings/sources` per `src/components/settings/sources-section.tsx`), examples (steps triple-source, weight twin-source), cross-link to Apple Health + Withings integration docs.
**Effort**: medium

### F-7: API reference is split across two stale surfaces

**Severity**: high
**Topic**: API reference
**File(s) / Gap**: `docs/api/openapi.yaml`, `docs/api/README.md`, `README.md:240-386`
**What's wrong / missing**: `docs/api/README.md:55-56` claims the OpenAPI **paths** section covers "all routes from `src/app/api/**/route.ts`." Reality: 14 paths documented, 181 route handlers in the tree. The README's manual API table is broader but stale — missing `/api/measurements/batch`, `/api/workouts/batch`, `/api/sync/state`, `/api/measurement-categories`, `/api/devices`, `/api/import/apple-health-export`, `/api/integrations/healthkit`, the medication sub-routes (`side-effects`, `inventory`, `titration`, `cadence`, `phase-config`, `glp1`, `api-endpoint`, `intake/import`, `intake/purge`), `/api/insights/chat`, `/api/auth/me/source-priority`, `/api/personal-records`. OpenAPI `info.version` is `1.4.23` (line 1786) while `package.json:3` is `1.4.34.3` — drift contradicts the "mirrored from `package.json`" claim. The intent is reasonable (iOS-codegen-locked subset), but the documentation never says that — `docs/api/README.md` reads as if the spec is the full public-API contract.
**Fix shape**: Two changes. (a) Reword `docs/api/README.md:55-56` to "**paths** — the locked subset consumed by the iOS native client codegen and external Bearer ingest. For the full self-hosting API surface see `docs/api/full-reference.md`." (b) Add `docs/api/full-reference.md` — a generated-from-source endpoint table that walks `src/app/api/**/route.ts` and renders method + path + auth + rate-limit + audit action. A small `scripts/generate-api-reference.ts` plus a CI gate keeps it from drifting. Bump OpenAPI `info.version` to track `package.json` on every release (the CHANGELOG entry is the trigger).
**Effort**: large

### F-8: Cache + invalidation contract is undocumented

**Severity**: high
**Topic**: Cache + invalidation
**File(s) / Gap**: MISSING — no `docs/concepts/caching.md`
**What's wrong / missing**: v1.4.34.1 closure flagged this. `src/lib/cache/server-cache.ts:269-286` emits `cache.<name>.outcome` wide-event annotations on every hit / miss / stampede, and `src/lib/cache/invalidate.ts` owns the per-user mutation → invalidate-keys matrix. Self-hosters investigating "why is my dashboard stale after a manual measurement?" or "why is my Loki cache-outcome stream blank?" have nothing to read.
**Fix shape**: `docs/concepts/caching.md` — 600–900 words. Sections: which routes are cached (with the cache names that match the `cache.<name>.outcome` annotations), TTLs per cache, the per-user invalidation matrix (mutation → cleared keys), the stampede-prevention contract, observability hook (the `cache.*.outcome` annotation in wide events), troubleshooting (stale dashboard, missed invalidation).
**Effort**: medium

### F-9: Security model has no consolidated page

**Severity**: high
**Topic**: Security model
**File(s) / Gap**: `SECURITY.md` (disclosure policy only), `docs/ops/encryption-key-rotation.md` (rotation procedure only)
**What's wrong / missing**: `SECURITY.md` is the responsible-disclosure policy. `README.md:131-143` has a marketing bullet list. The actual security architecture — passkey vs password vs API token (`hlk_*` Bearer tokens HMAC'd before storage per `src/lib/auth/`), the AES-256-GCM at-rest scheme (rotation has a doc; the **model** doesn't), session cookies (`healthlog_session`, HttpOnly, SameSite=Strict, 30-day sliding, server-side store), the `apiHandler` audit-log scope, the sliding-window rate-limiter (`src/lib/rate-limit.ts`), CSP nonces + HSTS, SSRF guards on the test-connection endpoints — is not a coherent doc for a self-hoster auditing the threat model.
**Fix shape**: `docs/security-model.md` — 1200–1500 words. Sections: auth mechanisms (passkey primary, password fallback with Argon2id + zxcvbn, API tokens for native + Bearer ingest), session model, encryption-at-rest scheme (cross-link to rotation doc), audit-log scope (what's logged, retention), rate-limit policy table (per endpoint family), proxy headers + CSP + HSTS, secrets that must never rotate without coordinated invalidation (`API_TOKEN_HMAC_KEY` per `docs/migration/v1.3-to-v1.4.md:93`), open follow-ups (the six S-FOLLOW items in `docs/ops/v141-followup-issues.md` should be either resolved-and-removed or surfaced into the model doc).
**Effort**: large

### F-10: Observability has no operator-facing guide

**Severity**: high
**Topic**: Observability
**File(s) / Gap**: `.env.example:100-115` (env-var stubs only)
**What's wrong / missing**: Wide events live in `src/lib/logging/`. The Loki transport is gated by `LOKI_ENDPOINT` + `LOKI_USERNAME` + `LOKI_PASSWORD`. Sample rate (`LOG_SAMPLE_RATE`) and the always-keep-slow contract (`LOG_SLOW_THRESHOLD_MS`) interact in non-obvious ways. The Glitchtip + Umami test endpoints (`/api/monitoring/glitchtip/test`, `/api/monitoring/umami/test`) are documented in `docs/migration/v1.3-to-v1.4.md:108-112` as one-liners but their setup is nowhere. The `cache.*.outcome` annotation contract is invisible.
**Fix shape**: `docs/self-hosting/observability.md` — 800–1100 words. Sections: log levels + sampling + slow-keep rule, Loki transport (label set, retention recommendations), Glitchtip integration (DSN, the test endpoint), Umami integration (script URL, website ID, the test endpoint), the wide-event schema (`action.name`, `cache.<name>.outcome`, request-id propagation), worker telemetry (`LOKI_*` must be set on worker too per `docs/self-hosting/scaling.md:44-46`).
**Effort**: medium

### F-11: iOS handoff is split across three files

**Severity**: medium
**Topic**: iOS native client
**File(s) / Gap**: `docs/apple-store-connect-checklist.md`, `docs/api/openapi.yaml`, `docs/migration/v1.3-to-v1.4.md`, `.env.example`
**What's wrong / missing**: The iOS engineer reading the repo finds the ASC submission checklist, the iOS-codegen OpenAPI subset, the APNs env-var block in `.env.example:155-175`, the AASA route at `src/app/.well-known/apple-app-site-association/route.ts`, and the refresh-token rotation paragraph at `docs/migration/v1.3-to-v1.4.md:118-122`. None of them constitute a "iOS engineer onboards in one read" handoff. The X-Device-Id header contract, the X-Client-Type behaviour (`docs/api/openapi.yaml:1791-1792`), the source-priority interaction with HK ingest — scattered.
**Fix shape**: `docs/ios-handoff.md` — 1000–1300 words. Sections: the API contract surface the iOS client is allowed to call (cross-link to OpenAPI), auth flow (login → access + refresh, refresh rotation), AASA setup, APNs registration (the `.p8` provisioning + the `POST /api/devices` registration contract), source priority + dedup expectations on the iOS side, the X-Device-Id Keychain-stored UUID contract, the X-Client-Type sniff (`native` UA prefix unlocks refresh-token bundle). Cross-link to the ASC checklist for shipping.
**Effort**: medium

### F-12: Localisation has no contribution guide

**Severity**: medium
**Topic**: i18n / localisation
**File(s) / Gap**: `docs/ui-guidelines.md:421-430` (one paragraph)
**What's wrong / missing**: Contributing a new locale (FR / ES / IT) is a real on-ramp request for an open-source PWA. The `admin.section.<slug>.*` namespace convention (v1.4.14 per `docs/audit/v1414-summary.md:84`), the per-user vs per-job translator pattern (`useTranslations()` vs `getServerTranslator()` per `docs/ui-guidelines.md:421-424`), the CI key-parity guard (`README.md:72` mentions it), the plural-rules approach, where AI prompts pick up locale — none documented as a "how to add a locale" page.
**Fix shape**: `docs/contributing/i18n.md` — 600–900 words. Sections: file layout (`messages/<locale>.json`), the namespace convention, the parity CI gate, plural-rules + interpolation, server-side vs client-side translators, AI prompt locale resolution, the per-user-locale-for-job contract (a Telegram reminder uses the user's locale, not the job runner's). Cross-link to `docs/ui-guidelines.md` for the writing-tone rules.
**Effort**: medium

### F-13: `docs/` has no root README

**Severity**: medium
**Topic**: Docs landing
**File(s) / Gap**: MISSING — no `docs/README.md`
**What's wrong / missing**: A visitor running `ls docs/` after `git clone` sees `api/`, `apple-store-connect-checklist.md`, `audit/`, `codex-protocol-spec.md`, `doctor-report.md`, `migration/`, `ops/`, `self-hosting/`, `ui-guidelines.md` — no orientation. The discoverability audit's F-10 noted the same gap from outside.
**Fix shape**: `docs/README.md` — 200–300 words. A tabular index of what each subtree covers (user / operator / contributor / archive), the relationship to `docs.healthlog.dev` (if the docs site is published from this folder, say so; if it's a separate repo, link it), and the "see also" pointers.
**Effort**: trivial [hotfix-ready]

### F-14: `docs/api/openapi-v1422-legacy.yaml` is in the tree with no explanation

**Severity**: low
**Topic**: API reference
**File(s) / Gap**: `docs/api/openapi-v1422-legacy.yaml` (177 KB, 122 paths)
**What's wrong / missing**: The file is committed alongside the active `openapi.yaml` but `docs/api/README.md` doesn't mention it. A contributor stumbling on it has to guess whether it's authoritative archive, fallback, or stale. The naming hints at "v1.4.22 freeze" — but the active spec is `1.4.23` and the package is `1.4.34.3`, so it's apparently a deprecated broader-surface spec that was superseded by the iOS-codegen-locked subset. Decision needed: delete it, move it to `docs/api/archive/`, or document its role.
**Fix shape**: Either remove (if it serves no purpose) or annotate `docs/api/README.md` with "**`openapi-v1422-legacy.yaml`** — v1.4.22 snapshot of the broader pre-iOS-codegen surface, kept for archive reference; not regenerated." Trivial.
**Effort**: trivial [hotfix-ready]

### F-15: `docs/ops/v141-followup-issues.md` is a deferred-work backlog, not ops docs

**Severity**: low
**Topic**: Documentation hygiene
**File(s) / Gap**: `docs/ops/v141-followup-issues.md`
**What's wrong / missing**: The file (260 lines, 11 deferred follow-ups across security / performance / test-quality / i18n) is dated v1.4.1. We are at v1.4.34.3. Some items are likely resolved; others moved to `.planning/`. It currently lives next to two **published, operator-facing** ops docs (`backup-restore.md`, `encryption-key-rotation.md`) — the genre mismatch is jarring. Either reconcile against current state (mark resolved / still-open) and move open ones into `.planning/`, or delete entirely.
**Fix shape**: Cross-reference each S-FOLLOW / P-FOLLOW item against current source (e.g. P-FOLLOW-1 Recharts top-level import — already fixed in the dynamic-import wave; P-FOLLOW-3 MoodEntry index — check `prisma/schema.prisma` for the v1.4.x added index). Move surviving open items to `.planning/v143x-backlog.md`. Delete the file.
**Effort**: small

### F-16: `docs/audit/2026-04-26-PLAN.md` is dated and in German

**Severity**: low
**Topic**: Documentation hygiene
**File(s) / Gap**: `docs/audit/2026-04-26-PLAN.md`
**What's wrong / missing**: 13 KB German-language plan for a v1.4.x cycle. Auto-memory directive "Marc-voice English, every user-facing artifact" applies. The file is in the audit archive so the rules are weaker, but the language mismatch with every other audit file (`v141X-summary.md` are all English) is an anomaly.
**Fix shape**: Translate to English, or move to `.planning/archive/` since it's a milestone-planning document not a release-cycle summary.
**Effort**: small

### F-17: Doctor-report customisation guidance is thin

**Severity**: low
**Topic**: Doctor-report PDF
**File(s) / Gap**: `docs/doctor-report.md`
**What's wrong / missing**: The doc covers the API surface accurately but does not cover **what's redacted** (the audit-scope question 6 above — PII handling on the printable PDF, the differentiation between user-entered notes vs reference ranges, the user-override badge contract) or **how to customise per locale** (the `getServerTranslator()` resolution path is named, but how a self-hoster adds an `it` locale's PDF strings or overrides a clinical-band label per locale is not). The header / footer / clinician-handoff conventions are entirely absent.
**Fix shape**: Append two sections to `docs/doctor-report.md` — "What's in the PDF (and what's not)" (a layout map plus a redaction table — e.g. mood-entry notes flagged sensitive are omitted by default) and "Customising per locale" (the `messages/<locale>.json` keys that drive PDF strings, override patterns for clinical-band labels). 300–500 words.
**Effort**: small

### F-18: README API table drift

**Severity**: low
**Topic**: API reference
**File(s) / Gap**: `README.md:240-386`
**What's wrong / missing**: The hand-maintained README table is a discoverability surface, not a reference. Once `docs/api/full-reference.md` exists per F-7, the README table should shrink to the 8–10 most-asked-about endpoints with a "see full reference" pointer. Reducing the table reduces drift risk.
**Fix shape**: After F-7 lands, trim `README.md:240-386` to a short table plus a cross-link.
**Effort**: trivial

---

**Length check**: ~2780 words.
