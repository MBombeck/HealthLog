# `src/lib/`

The server and runtime toolkit. Everything that is not a page, component, or route handler lives here: the API kit, auth, crypto, the rollup tier, AI providers, notifications, background jobs, and the integration clients. Route handlers and RSC pages compose these modules; the modules never reach back into `app/`.

## Core request kit

- **`api-handler.ts`** — the `apiHandler` wrapper every route uses (Wide-Event builder, error envelope, GlitchTip forwarder) and the one public entry for the request guards in `auth/guards/`: the auth resolver (cookie OR Bearer), `requireAuth` / `requireRecordAuth` / `requireAdmin` (admin is cookie-only by construction), the step-up gates.
- **`api-response.ts`** — the `{ data, error, meta? }` envelope: `apiSuccess` / `apiError`, `safeJson`, trusted-proxy IP resolver, `returnAllZodIssues` + `sanitiseZodIssues`.
- **`rate-limit.ts`** — Postgres-backed sliding-window limiter (single atomic upsert); multi-instance correct.
- **`idempotency.ts`** — user-scoped idempotency keys that refuse to cache secret-shaped responses.
- **`query-keys/`** — the only legal source of TanStack Query `queryKey` / `mutationKey` arrays (enforced by an ESLint rule); per-feature files behind the `index.ts` barrel.
- **`safe-fetch.ts`** — the one documented outbound-egress entry (`redirect: "manual"` + timeout; optional connect-time DNS-rebinding pin). Raw `fetch(` under `lib/` + `app/` is banned by ESLint.
- **`db.ts`** — the Prisma client singleton.
- **`crypto.ts`** — AES-256-GCM at rest with versioned key ids, fail-closed loader, rotation primitives.

## Subsystems

- **`auth/`** — Postgres sessions, secure-cookie flag policy, passkey (WebAuthn) + Argon2id password, per-device refresh-token rotation, HMAC Bearer tokens.
- **`ai/`** — multi-provider insight + Coach engine: `provider-chain.ts`, hand-rolled `{openai,anthropic,local,codex,mock}-client.ts`, `coach/`, `prompts/`, citation + confidence helpers.
- **`rollups/`** — DAY/WEEK/MONTH/YEAR pre-aggregations for measurements, mood, and medication compliance. Read-swap pattern: probe the rollup, fall back to live SQL on a coverage miss.
- **`notifications/`** — the dispatcher cascade (APNs → Telegram → ntfy → Web Push), per-channel `senders/`, retry policy, VAPID config.
- **`jobs/`** — pg-boss workers: reminders, insight pre-generation, backups, retention sweeps, integration backfills. Recurring work belongs here, not in `scripts/`.
- **`integrations/`**, **`withings/`**, **`whoop/`**, **`fitbit/`** — OAuth clients and sync services for the device providers; `sync/` holds the shared delta-feed plumbing.
- **`analytics/`** — trend calculations, cadence-aware medication `compliance.ts`, correlations.
- **`insights/`**, **`fhir/`**, **`doctor-report-*.ts`** — insight pipeline, FHIR R4 export, client-side doctor-report PDF.
- **`openapi/`** — Zod registry that is the source of truth for `docs/api/openapi.yaml`.
- **`logging/`**, **`observability/`**, **`monitoring/`** — Wide-Event transports and the central redaction denylists (redact at the egress boundary, not the call site).
- **`validations/`** — shared Zod schemas, including the SSRF `isPublicUrl` floor.
- **`i18n/`**, **`tz/`** + **`timezone.ts`**, **`format*.ts`** — translations, timezone helpers (Berlin for display, UTC in DB), locale formatting.

## Conventions

Kebab-case filenames. See [`../../CLAUDE.md`](../../CLAUDE.md) "Code conventions" and "Security-relevant patterns"; the critical-files map there cites the exact entry points. Most modules carry tests in a sibling `__tests__/`.
