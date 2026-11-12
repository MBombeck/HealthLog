# `src/app/`

The Next.js App Router tree: the page surfaces a logged-in user sees and the REST API under `api/`. Server components are the default; `"use client"` is added only where a hook, state, or browser API needs it. Routing is file-based — a `page.tsx` is a page, a `route.ts` is an API endpoint.

## API routes (`api/`)

Every endpoint wraps its handler in `apiHandler` (`@/lib/api-handler`), parses any body with Zod `safeParse`, narrows `userId` from the session or Bearer token (never from the body), and returns the `{ data, error, meta? }` envelope. `requireAdmin()` is cookie-only, so `api/admin/` is unreachable by Bearer token. Notable groups:

- **`auth/`** — login, register, password, passkey (WebAuthn), refresh, Codex device-OAuth.
- **`measurements/`, `mood-entries/`, `medications/`, `sleep/`** — the core health-data CRUD + batch/bulk ingest.
- **`ingest/`** — external Bearer-token ingest surfaces.
- **`insights/`, `analytics/`, `dashboard/`** — AI insights, the Coach SSE stream, trend summaries, the first-paint dashboard snapshot.
- **`withings/`, `whoop/`, `fitbit/`, `integrations/`, `sync/`** — OAuth connect/sync/webhook surfaces and the offline delta feed.
- **`fhir/`, `share-links/`, `doctor-report/`, `export/`, `import/`** — clinician-facing FHIR R4 read API, shareable records, report + data export.
- **`notifications/`, `devices/`, `send/`, `telegram/`** — channel registration, device tokens, dispatch, webhook intake.
- **`admin/`** — operator panel APIs (cookie-only).
- **`health/`, `version/`, `meta/`, `internal/`** — health check, build-version probe, runtime metadata, worker-internal routes.

## Page surfaces

`measurements/`, `medications/`, `mood/`, `insights/`, `achievements/`, `notifications/`, `settings/`, `onboarding/`, `admin/`, plus the public `about/`, `privacy/`, `bugreport/`, the share-record route `c/`, and the root dashboard (`page.tsx`). Shared shell + chrome lives in `layout.tsx`; `error.tsx` / `global-error.tsx` / `not-found.tsx` / `loading.tsx` cover the framework boundaries. `layout.tsx` holds the one nonce-bound `dangerouslySetInnerHTML` (theme bootstrap).

## Conventions

Related dirs: handlers compose [`../lib/`](../lib/README.md); pages render [`../components/`](../components/README.md).
