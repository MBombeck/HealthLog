# W4-QoL-COPY — v1.4.43 phase report

Branch: `worktree-agent-a2db58cdde5fee530` (pushed).
Base: `develop` @ `7daff01a`.
Commits: 6 atomic.

## Six Highs — outcome

### H1 — DayDrillDown error toast wrong key
`src/components/measurements/measurement-list.tsx:1058` now reads
`measurements.loadError` in the GET-failure branch. A new key
`measurements.loadError` was added inside the existing `measurements.*`
namespace of every locale (de/en/es/fr/it/pl). German reads "Fehler beim
Laden", English "Could not load measurements".

Commit `a2bd6fdb`.

### H2 — German "Provider" / "rate-limited" leak
`messages/de.json` only — three locations:
- `providerRateLimitTitle` / `providerRateLimitBody` → "Anbieter
  gedrosselt" / "Anbieter ist temporär überlastet; wieder verfügbar in
  ~5 min."
- `:1620 description` → "Anbieter, Modell, API-Schlüssel."
- `rawDataOnDescription` / `OffDescription` / `Warning` → "Provider"
  replaced with "Anbieter" throughout.

Commit `d8258fc2`.

### H3 — Persistent failure-kind has no surface
Brief allowed only `integration-status-pill.tsx` + locale files. Added a
fourth pill state `"warning"` with locale key
`settings.integrationPill.warningServerError` ("Verbunden, aber
Serverfehler" / "Connected, server error") and an amber
`border-dracula-yellow/30 bg-dracula-yellow/15 text-dracula-yellow`
chip. Variant defaults match `connected` (custom-class instead of
shadcn destructive) so the warning visual is distinguishable from the
red reconnect chip.

**Deferred (out of scope per file allow-list):** wiring at
`integrations-section.tsx:123-136` — `pillStateFor` still collapses
`error_transient` → `"error"`. To enable the warning chip end-to-end,
the next phase must:
1. Add `lastFailureKind` to `IntegrationStatus` (Prisma migration) and
   plumb it through `recordSyncFailure` + `getIntegrationStatus`.
2. Surface it in the `/api/integrations/status` payload.
3. Update `pillStateFor` to return `"warning"` when
   `failureKind === "persistent"`.

Commit `d1428650`.

### H4 — not-found.tsx English-only
Switched `src/app/not-found.tsx` to an `async` server component that
calls `resolveServerLocale()` + `getServerTranslator()` (already
existed under `src/lib/i18n/`). Three new keys per locale under a new
top-level `errors.notFound.{title,body,backToDashboard}` namespace.

Commit `430f5374`.

### H5 — global-error.tsx bilingual
Cannot reach an i18n resolver before root-layout boots, so doubled the
four user-facing strings as `Deutsch · English`. Updated heading, body
paragraph, both button labels, copy-fallback `window.prompt`, and the
unknown-error fallback. No new dependency on the i18n stack — the file
remains provider-less by contract.

Commit `ee0c4e8c`.

### H6 — relativeMinutes/Hours/DaysAgo singular form
Helper `src/lib/i18n/relative-time.ts` now branches on `count === 1`
and reads `*AgoOne` vs `*AgoOther`. Each locale's three plural-only
keys were split into the two-form pair (matching the existing
`dashboard.staleHintWeeksOne` / `Other` pattern). Polish kept a
pragmatic singular/plural pair; the helper's two-form contract matches
the brief's recipe.

No other call-site references the old keys (grep confirmed), so the
removal is safe.

Commit `886957a0`.

## Quality gate

- `pnpm typecheck` — clean. Required a one-off `pnpm prisma generate`
  on the worktree because `src/generated/prisma` is git-ignored.
- `pnpm lint` — clean.
- `pnpm vitest run src/components/settings/__tests__/integration-status-pill.test.tsx src/lib/i18n src/components/measurements` — 28 passed / 1 skipped.
- All six `messages/*.json` files parse.

## File-allow-list discipline

Touched only: `src/components/measurements/measurement-list.tsx`,
`src/components/settings/integration-status-pill.tsx`,
`src/app/not-found.tsx`, `src/app/global-error.tsx`,
`src/lib/i18n/relative-time.ts`, `messages/{de,en,es,fr,it,pl}.json`.

Nothing else.

## Commit-message hygiene

No `Co-Authored-By: Claude`. No `--no-verify`. No first-name in commit
bodies. Marc-voice, English, no AI references.
