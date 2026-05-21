# Phase W-CONSENT — v1.4.40 marathon report

## Scope

SB-10 from `SERVER-BACKLOG.md`. App-Store Guideline 5.1.2(i) + GDPR
Art. 7 audit trail for AI consent. Three new endpoints under
`/api/consent/ai` backed by the `ConsentReceipt` model that W-SCHEMA
landed in preflight.

## Deliverables

### New files

- `src/lib/validations/consent.ts` — Zod schemas. `consentKindEnum`
  covers `ai_full` / `ai_insights_only` / `ai_coach`. `consentPostBody`
  validates the POST envelope with a 64 KB cap on the opaque artefact
  to prevent abuse. `consentLatestQuery` covers GET + DELETE.
- `src/lib/consent/receipts.ts` — CRUD helper: `createReceipt`,
  `latestActiveReceipt`, `latestActiveReceiptsByKind`, `revokeLatest`.
  Append-only; revoke flips `revokedAt` only. No `delete` path.
- `src/app/api/consent/ai/route.ts` — `POST` handler. Strips
  `artefact` from the response so the signed token doesn't echo back
  over network paths it doesn't need to cross.
- `src/app/api/consent/ai/latest/route.ts` — `GET` + `DELETE`.
  - GET with `?kind` returns the latest active row or null.
  - GET without `?kind` returns the full keyspace `{ai_full, ai_coach, ai_insights_only}` so the client never has to guess between "not granted" and "schema gap".
  - DELETE with `?kind` flips `revokedAt`. Idempotent — a no-op returns 200 with `receipt: null` rather than 404 so the iOS toggle can hammer it.
  - DELETE without `?kind` is the master "AI deaktivieren" sweep across every kind.
- `src/app/api/consent/ai/__tests__/route.test.ts` — POST coverage.
- `src/app/api/consent/ai/latest/__tests__/route.test.ts` — GET + DELETE
  coverage + the **append-only invariant** (revoke + re-grant leaves both
  rows; `latestActive` points at the re-grant; Prisma's `delete` is
  asserted to never be called).
- `src/lib/consent/__tests__/receipts.test.ts` — helper-level tests for
  every CRUD function.

## Quality gates

- `pnpm typecheck` — clean.
- `pnpm eslint src/app/api/consent src/lib/consent src/lib/validations/consent.ts` — clean on my files.
- Consent test suite: **21/21 passing** in 248 ms.
- Pre-commit OpenAPI gate fired and passed on all three commits.

## Commits (Marc-voice English, on `develop`)

1. `8692a97e` — `feat(consent): CRUD helper for AI consent receipts`
2. `d6809e3d` — `feat(consent): POST + GET + DELETE endpoints at /api/consent/ai`
3. `a3b0dc92` — `test(consent): pin endpoint behaviour and append-only invariant`

## Notes for downstream waves

- **iOS Settings hook-up**: the "AI deaktivieren" toggle should call
  `DELETE /api/consent/ai/latest?kind=ai_full` (per-surface) or
  `DELETE /api/consent/ai/latest` (master). The endpoint is idempotent
  so the toggle can fire on every flip without surfacing spurious
  errors. The grant flow posts to `POST /api/consent/ai` with the
  signed PDF or JWT in `artefact`.
- **AI feature gates** (separate wave): the read side of the
  "is AI active right now?" check should call
  `latestActiveReceipt(userId, kind)` → non-null. Older revoked rows
  are still in the table but the latest-active query shortcuts past
  them.
- **Audit log**: both grant + revoke write `consent.ai.grant` /
  `consent.ai.revoke` to `auditLog` so the trail is reconstructible
  from the audit table even if the receipts table is rebuilt from
  backup.

## Caveats observed during the wave

- `vi.resetAllMocks()` clears the implementation on top-level
  `vi.mock(...).mockResolvedValue(undefined)` setups. The route's
  fire-and-forget `auditLog(...).catch(() => {})` chain NPEs when the
  mock returns `undefined`. The fix is to re-arm `auditLog` inside
  `beforeEach`. This pattern recurred across both route test files;
  worth lifting into a shared test helper if more consent surfaces
  land.
- Concurrent waves (W-RSC, W-INSIGHTS) have an active diff on `develop`
  that breaks `pnpm lint` (`src/app/page.tsx:577`) and `pnpm test`
  (9 failures in `src/lib/insights/__tests__/features.test.ts` plus
  some `targets`/`comprehensive` route tests). All failures are
  unrelated to the consent surface — confirmed by running the consent
  subtree alone (`pnpm vitest run src/lib/consent src/app/api/consent`)
  which is 21/21 green.
