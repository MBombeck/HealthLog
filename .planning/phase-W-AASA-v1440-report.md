# Phase W-AASA — v1.4.40 — Apple App Site Association (SB-4)

Agent: W-AASA. Single-axis scope: serve the AASA payload required by
iOS Universal Links and Web Credentials so iOS PB30 (App-Store
submission) is unblocked.

## What changed

- `src/app/.well-known/apple-app-site-association/route.ts` — already
  existed as a route handler (the preferred Next.js App-Router pattern
  for an extension-less `/.well-known/*` asset). The previous body
  carried an empty `applinks.details` array, which let passkey
  Web-Credentials work but left Universal Links unwired. The handler
  now populates `applinks.details` with the SB-4 App ID
  (`S8WDX4W5KX.dev.healthlog.app`) and the `["*"]` path matcher, so
  every HealthLog URL becomes a Universal Link candidate on devices
  that have the app installed. Both the `applinks` and
  `webcredentials.apps` entries share the same App ID prefix via a
  local `AASA_APP_ID` constant — splitting them silently breaks
  passkey login on iOS.

- `src/__tests__/api/well-known.test.ts` — new five-assertion unit test
  that pins:
    - HTTP 200 on a bare `GET`.
    - `Content-Type: application/json` exactly (no `charset` parameter
      — Apple's swcd / aasa-validator refuse to mirror anything
      annotated with `charset=…`, and the symptom is silent: Universal
      Links just stop firing).
    - A `public, max-age=N` `Cache-Control` that lets Apple's CDN
      mirror the file.
    - The exact JSON shape from the SB-4 spec.
    - `applinks.details[0].appID === webcredentials.apps[0]` — guard
      against the maintainer accidentally rotating one App ID without
      the other.

## Implementation choice — route handler over `public/`

`grep` for `.well-known` surfaced an existing route handler at
`src/app/.well-known/apple-app-site-association/route.ts` (added in
v1.4.33) plus an existing proxy guard in
`src/__tests__/proxy-well-known-public.test.ts` that admits the path
through `proxy.ts` without a session cookie. The route-handler
convention is already the house style and is the right call for an
extension-less file (Next.js does not serve extension-less files from
`public/` cleanly, and a route handler lets us set the exact
`Content-Type` and `Cache-Control` headers Apple requires). No
duplicate file was added under `public/`.

## Quality gates

- `pnpm vitest run src/__tests__/api/well-known.test.ts` — 5/5 pass.
- `pnpm vitest run src/__tests__/proxy-well-known-public.test.ts` —
  4/4 pass (existing AASA proxy guard still green).
- `pnpm tsc --noEmit` — clean.
- `pnpm exec eslint <changed files>` — clean.

## Commits on `develop`

- `feat(aasa): serve apple-app-site-association at the well-known path`
- `test(aasa): pin payload shape and content-type`

## Out of scope (deliberate)

- No change to `src/proxy.ts` — the existing
  `WELL_KNOWN_PUBLIC_PATHS` allowlist already exposes the path
  unauthenticated, and the matcher in `proxy.ts:280–284` excludes
  static-file extensions but lets extension-less paths through.
- No change to `CHANGELOG.md` or `package.json` — SB-4 is one slice of
  the v1.4.40 release and the release-master will bundle the version
  bump.
- No iOS-side entitlement edits — the iOS team's PB30 phase owns the
  `Associated Domains` entitlement (`applinks:healthlog.bombeck.io`
  and `webcredentials:healthlog.bombeck.io`).
