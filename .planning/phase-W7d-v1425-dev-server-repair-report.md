# Phase W7d — v1.4.25 Dev Server Repair

Branch: `develop` · Started: 2026-05-14 13:23 · Finished: 2026-05-14 13:42

## Scope

Two reported regressions blocking every `next dev` HTTP request, surfaced
by the W10-i18n-runtime probe (`.planning/research/w10-i18n-runtime-gaps.md`).
Without a working dev server, UAT in W11 and the demo deploy in W11b are
impossible, so this wave was treated as a release blocker.

1. Turbopack 500 on every page that imports `globals.css` —
   `Parsing CSS source code failed: Unexpected token Delim('.')` inside
   a `color-mix(in oklab, var(...) N%, transparent)` rule generated
   from a bracket-form CSS-variable arbitrary-value class.
2. Route 500 on the only `force-static` API route — `Cannot read
   private member #state from an object whose class did not declare
   it` raised when `apiHandler` reads `request.method` on the synthetic
   placeholder Next 16 passes to force-static handlers in dev.

## Root cause — regression 1

Tailwind v4.3.0's content scanner walks the project root and emits a
CSS utility for any class-shaped token it finds in any text file —
**including planning markdown and design docs**. Two distinct ingestion
paths both fed the offending pattern into the generated CSS:

- `.planning/phase-W3e-v1425-zielwerte-redesign-report.md` lines 137–138
  quote `bg-[var(...)]/12` and `ring-[var(...)]/30` as design-decision
  examples. The Tailwind scanner does not parse markdown — it sees the
  raw substrings and produces real CSS rules for them.
- `src/components/targets/target-card.tsx` (status pills) and
  `src/components/targets/consistency-strip.tsx` (band shadow) used
  the legacy bracketed form `bg-[var(--dracula-green)]/12` /
  `ring-[var(--dracula-green)]/30` /
  `shadow-[0_0_0_1px_var(--dracula-green)]/20` for real styling.

The output for either path is an escaped selector
`.bg-\[var\(--dracula-green\)\]\/12 { ... }` whose `\[var\(...\)\]\/12`
token sequence trips Turbopack's CSS parser
(LightningCSS-via-`@tailwindcss/postcss`) with
`Unexpected token Delim('.')` — the parser sees `\.` and bails. Per
the Tailwind v4 upgrade guide, the bracketed form is deprecated for
CSS variables in favour of the parenthesised shorthand
`bg-(--name)/N`, which emits a clean selector that parses cleanly.

## Fix — regression 1

Commit `782731a` — `fix(css): repair Tailwind v4 color-mix parser
crash on dev server`. Three coordinated changes:

- `src/app/globals.css` — add `@source not "../../.planning"` and
  `@source not "../../docs"` so the scanner skips the two trees that
  legitimately need to quote class fragments as examples.
- `src/components/targets/target-card.tsx` — migrate 6 status-pill
  utilities and 3 streak-chip utilities from
  `bg-[var(--name)]/N` / `ring-[var(--name)]/N` to the v4 paren
  shorthand `bg-(--name)/N` / `ring-(--name)/N`. Visuals unchanged.
- `src/components/targets/consistency-strip.tsx` — replace
  `shadow-[0_0_0_1px_var(--dracula-green)]/20` with
  `shadow-[0_0_0_1px_color-mix(in_oklab,var(--dracula-green)_20%,transparent)]`
  so the alpha is encoded inside the value, removing the trailing
  `/20` modifier that produced the broken escaped selector. Visuals
  remain pixel-identical.

A code-comment in `target-card.tsx` originally repeated the broken
pattern as an explanation; the Tailwind scanner picked **that** up
too, so the comment was rewritten to describe the migration without
re-quoting the offending fragment.

## Root cause — regression 2

`src/app/api/version/route.ts` declares `export const dynamic =
"force-static"`. Next 16 evaluates force-static handlers in dev with a
synthetic request placeholder (not a real `NextRequest` instance) so
the route's pre-render path can be exercised. Every `NextRequest`
property in v16 is implemented as a class getter that reads a private
`#state` field; invoking those getters with a non-NextRequest `this`
binding raises a V8 native
`TypeError: Cannot read private member #state from an object whose
class did not declare it` at `Reflect.get`. `apiHandler` reads
`request.method`, `request.url`, and `request.headers.get(...)`
synchronously while building the Wide Event for logging, so the very
first instrumented access (line 56, `method: request.method`) crashes
the wrapper before the handler body runs. The route's body itself
never touches the request, so the crash is purely an instrumentation
artefact.

This is the same `#state` symptom the W10 probe reported under the
webpack fallback path — same root cause, different trigger (webpack
proxy vs. force-static placeholder).

## Fix — regression 2

Commit `15d9183` — `fix(api-handler): guard against private-field
crash on force-static routes`. Introduce a small `safeRequestProp`
helper that catches the private-field error and returns a sensible
fallback (empty string for `url`, `"GET"` for `method`, `null` for
header lookups). Every direct property access on `request` inside
`apiHandler` and `reportToGlitchtip` was migrated through the helper.

The fallbacks let logging instrumentation continue to attach
`path` / `method` / `user_agent` when the request is real, and
silently degrade when the request is a synthetic placeholder.
Instrumentation must never crash the handler — the helper makes that
contract enforceable in code rather than convention.

## Verification

| step | result |
| --- | --- |
| `pnpm typecheck` | ✓ clean |
| `pnpm lint` | ✓ clean |
| `pnpm test` (W7d-affected modules) | ✓ 324/324 pass |
| `curl -sI http://localhost:3030/` | ✓ `307 -> /auth/login` |
| `curl -sI http://localhost:3030/auth/login` | ✓ `200 OK` (was 500) |
| `curl -sI http://localhost:3030/api/version` | ✓ `200 OK` (was 500) |
| `curl -sI http://localhost:3030/api/health` | ✓ `200 OK` |
| Dev-server log error count after probe | ✓ 0 |

Dev server killed cleanly before exit.

## Tests delta

No new tests added. Both regressions are dev-tooling / runtime-wiring
bugs whose existing test coverage was already exercising the affected
modules; the bugs reproduced only against the Turbopack dev pipeline.
The existing api-handler and api/version vitest suites continued to
pass with no behaviour change. Vitest mocks `apiHandler` to identity
in the api/version test, so the `safeRequestProp` helper is a
runtime-only addition — no test surface to add.

## Deferred follow-up

- Webpack fallback path (`next dev --webpack`) still has pre-existing
  unrelated module-resolution issues (`Module not found: Can't resolve
  'fs'` inside `pg-connection-string`, `pg-native` missing). These
  are independent of the two regressions in scope and only affect the
  rarely-used opt-in webpack mode. Turbopack — the default and the
  CI/production path — is fully repaired.
- The Tailwind paren shorthand migration was applied surgically to
  the two files that caused the crash. The codebase still has plain
  `text-[var(--dracula-green)]` (no opacity modifier) in
  `src/components/targets/targets-summary-header.tsx:70` and
  `src/components/ui/select.tsx:79` (`h-[var(...)]` for layout). These
  forms work fine in Tailwind v4 because they don't combine the
  bracket form with an opacity modifier. They can be migrated to
  paren shorthand for consistency in a future cleanup pass but are
  not blockers.
- `src/lib/__tests__/format-locale.test.ts:29` fails because the W9e
  wave expanded `parseLocaleFromAcceptLanguage` to recognise four new
  locales (fr/es/it/pl) without updating the test fixture. Out of
  scope for W7d — owned by W9e/W10.

## Commits

```
782731a fix(css): repair Tailwind v4 color-mix parser crash on dev server
15d9183 fix(api-handler): guard against private-field crash on force-static routes
```
