# v1.4.33 AASA rollout — closure report

Date: 2026-05-16
Scope: ship `/.well-known/apple-app-site-association` on every host that
fronts HealthLog so the iOS bundle's passkey ceremony shares cleanly
with the web origins, and so Apple's CDN can ingest the file ahead of
the iOS Tier-1 work that lands later in the v1.4.x cycle.

## Bundle / Team identifiers

- Team ID: `S8WDX4W5KX`
- Bundle ID: `dev.healthlog.app`
- App ID prefix: `S8WDX4W5KX.dev.healthlog.app`

## Commits

### Landing (`healthlog-landing`, `main`)

| SHA | Subject |
| --- | --- |
| `33e6039` | feat(ios): serve apple-app-site-association on healthlog.dev |

Touched paths:

- `src/app/.well-known/apple-app-site-association/route.ts` (new) —
  Next.js Route Handler with `dynamic = "force-static"` so the static
  export emits a literal JSON file at
  `out/.well-known/apple-app-site-association`.
- `Dockerfile` — nginx config gained an exact-match
  `location = /.well-known/apple-app-site-association` block that runs
  ahead of the SPA catch-all and pins `Content-Type: application/json`
  + `Cache-Control: public, max-age=3600`.

### Main app (`HealthLog`, `develop`, rides v1.4.33 PR #178)

| SHA | Subject |
| --- | --- |
| `2acb11f8` | feat(auth): admit /.well-known/* without a session |
| `03b0be18` | feat(ios): serve apple-app-site-association on the app domains |
| `b92f2b1e` | docs(changelog): note the AASA addition for v1.4.33 |

Touched paths:

- `src/proxy.ts` — added `/.well-known/` (trailing-slash prefix) to
  `PUBLIC_PATHS` so Apple's CDN fetch lands on the asset instead of
  the auth gate. Trailing-slash future-proofs the namespace for
  `/security.txt`, `/openid-configuration`, etc.
- `src/__tests__/proxy-well-known-public.test.ts` (new) — four
  regression scenarios: unauthenticated AASA fetch, pending-onboarding
  session, generic `/.well-known/security.txt` peer, and a negative
  check that `/insights` still 307s.
- `src/app/.well-known/apple-app-site-association/route.ts` (new) —
  same JSON body, same headers as the landing handler.
- `CHANGELOG.md` — one-line entry under the v1.4.33 Added section
  recording both the handler and the proxy allowlist edit.

## Quality gates

- Main app `pnpm typecheck` — clean.
- Main app `pnpm lint` — zero new errors on the touched files (the
  3018 baseline problems all live on pre-existing files).
- Main app `pnpm test` on the three proxy specs — 17/17 pass.
- Landing `npx tsc --noEmit` — clean.
- Landing `pnpm lint` — zero new warnings on the touched files (one
  pre-existing warning in `DemoCredentials.tsx`).
- Landing `pnpm build` — succeeded, AASA route reported as `○ (Static)`
  in the build manifest, output file inspected as 96-byte JSON.

## Deploy verification

### healthlog.dev (landing — already live, deployed via GitHub Actions)

```
HTTP/2 200
content-type: application/json
content-length: 96
cache-control: public, max-age=3600

{"applinks":{"apps":[],"details":[]},"webcredentials":{"apps":["S8WDX4W5KX.dev.healthlog.app"]}}
```

Auto-deploy ran via the `Deploy to edge-01` workflow (run
`25967688097`), completed in 60s, no errors. Coolify-auto-deploy fix
from earlier today held.

### healthlog.bombeck.io (main app — pending v1.4.33 tag)

```
HTTP/2 307
location: /auth/login
```

Expected — the commits sit on `develop` and ride PR #178 → `main` →
v1.4.33 tag. Will go live once the maintainer cuts the release.

### demo.healthlog.dev (main app — pending v1.4.33 tag)

```
HTTP/2 307
location: /auth/login
```

Same pending state as `healthlog.bombeck.io`; both hosts ride the same
standalone runtime.

### Apple CDN validator

```
$ curl -s https://app-site-association.cdn-apple.com/a/v1/healthlog.dev
{"applinks":{"apps":[],"details":[]},"webcredentials":{"apps":["S8WDX4W5KX.dev.healthlog.app"]}}
```

Apple's CDN ingested the file immediately — no propagation lag observed.
The CDN response matches the origin response byte-for-byte.

## Follow-ups for v1.4.34

- **Universal Links.** Populate `applinks.details` with the bundle ID +
  `paths` array once the iOS side opts in to deep-linking specific
  routes. Likely candidates from the maintainer's earlier brief:
  `/insights/*` (per-metric detail pages), `/measurements/*` (deep
  link from an Apple Health share-sheet), `/auth/login` (passkey
  re-auth). Coordination needed with the iOS app so the bundle
  declares `applinks` entitlement + matching `associatedDomains` in
  the Info.plist.
- **AASA mirror on `demo.healthlog.dev`.** Currently shares the
  handler with `healthlog.bombeck.io` via the same standalone runtime,
  which is correct. If a future split moves demo to its own deployment
  with a different App ID prefix (e.g. a separate `dev.healthlog.demo`
  bundle for sandbox passkeys), the handler will need a host-aware
  branch.
- **Cache invalidation on Bundle ID rotation.** Apple's CDN caches for
  an hour; if the App ID prefix ever rotates (Team ID rename, bundle
  rename), the iOS app's passkey ceremony will fail for up to 60
  minutes after the AASA change. Worth documenting in the iOS-handoff
  brief.
- **Discovery namespace bookkeeping.** `/.well-known/security.txt`
  (RFC 9116) and `/.well-known/change-password` (W3C) are both useful
  follow-on entries the trailing-slash allowlist now admits without a
  second proxy edit. Low priority but easy wins for the next polish
  round.
