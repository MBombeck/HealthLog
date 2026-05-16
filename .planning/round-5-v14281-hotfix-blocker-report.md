---
file: .planning/round-5-v14281-hotfix-blocker-report.md
purpose: v1.4.28.1 hotfix release — blocker report (GHCR build gated on MaxMind 429)
created: 2026-05-16
target_tag: v1.4.28.1 (pending)
---

# v1.4.28.1 — blocker report

## What landed on develop

- `e9b2cb19` fix(dashboard): drop retired widget ids from the saved layout on read
- `4053c8f1` chore(release): v1.4.28.1 — CHANGELOG entry, `package.json` bump
- `f4ff2969` chore(merge): reconcile main into develop for v1.4.28.1 hotfix
- `90a62cc9` test(version): accept the four-segment hotfix version shape (the `/api/version` route test had a `^\d+\.\d+\.\d+(-...)?$` regex that did not accept `1.4.28.1`; widened to `^\d+\.\d+\.\d+(\.\d+)?(-...)?$`)

PR: https://github.com/MBombeck/HealthLog/pull/171
Head: `90a62cc9`
Merge state: `CLEAN` / `MERGEABLE`

## CI state at stop

| Check | Result |
|---|---|
| Lint, Typecheck & Test | pass |
| integration | pass |
| e2e | pass |
| Dependency Audit | pass |
| Secret Scanning | pass |
| Build linux/amd64 | **fail (429 from MaxMind)** |
| Build linux/arm64 | **fail (429 from MaxMind)** |
| Merge multi-arch manifest | skipped (upstream legs failed) |
| Container Security | skipped |
| auto-merge | skipped |

## Root cause

The parallel CI-fix contributor's commits `ed71f334` and `9c265024`
hardened `scripts/fetch-geolite2.sh` to **fail loud** when the
license key is set but the MMDB download does not produce a usable
database. That guard is correct.

`curl` against
`https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&suffix=tar.gz`
is returning **HTTP 429** for the build runner's source IP across two
consecutive reruns (initial attempt `25955681335`, first rerun
`25955767158/76302271164`, second rerun
`25955767158/76303...`). The throttle persists on both
`linux/amd64` and `linux/arm64` legs.

This is an upstream MaxMind throttle, not a code defect — the previous
release (v1.4.28) shipped past the same call by silently dropping a
`.empty` marker, which is exactly the fallback the parallel
contributor's hardening now refuses to swallow.

## Why I stopped

Per the v1.4.28.1 contributor brief:

> If CI fails because the parallel CI-fix contributor's workflow
> change introduced an error, stop and report. Do NOT fight the other
> contributor's diff.

The change is intentional and the failure mode is the designed one.
The fix is operational, not code-level: either wait for the MaxMind
throttle window to clear and rerun the build, or have the operator
suspend `MAXMIND_LICENSE_KEY` in the workflow run so the
"no-key, ship `.empty`" branch fires and the image builds (the
runtime falls back to `ipwho.is` exactly as v1.4.28 does today).

## What is ready for an operator to finish

Step 6 — squash merge once the build leg goes green (or once the
operator decides to override). Branch protection on `main` does **not**
require status checks; the merge is technically possible right now.

Step 7 — tag `v1.4.28.1` on the squash SHA.

Step 8 — GHCR multi-arch build will fire on the tag push; same
throttle risk applies. The host-side retag fallback from Steps 9/10
needs a `:1.4.28.1` image to exist on GHCR first, so the throttle
must clear at least once.

Step 11 — verification once both hosts redeploy.

Step 12 — `gh release create v1.4.28.1` with the CHANGELOG section.

Step 13 — sister-repo bumps:
- `/Users/marc/Projects/healthlog-docs`:
  `src/content/docs/self-hosting/scaling.mdx` (2 pins) and
  `src/content/docs/self-hosting/updates.mdx` (1 pin) — bump from
  `1.4.28` to `1.4.28.1`.
- `/Users/marc/Projects/healthlog-landing`:
  `src/app/layout.tsx` — bump `softwareVersion` to `1.4.28.1`.

## Version sentinels updated in this attempt

Two live sentinels: `package.json` `version` and the implicit
`/api/version` route test regex (test-side only). No other live
sentinels in `src/` or `public/` track `1.4.28` outside doc comments
(every other match was a `v1.4.28 …` history-trail comment).

## Files modified on develop

- `CHANGELOG.md` — prepended `[1.4.28.1]` section
- `package.json` — version `1.4.28` → `1.4.28.1`
- `src/app/api/version/__tests__/route.test.ts` — accept four-segment
  hotfix shape in the version-format assertion

## Recommended next operator action

1. Wait 30–60 minutes for the MaxMind throttle to clear (the same key
   has likely tripped a per-IP cap on the GitHub runners' egress
   range).
2. `gh run rerun 25955767158 --failed` against the same PR head.
3. If still throttled, ship through the no-key path: temporarily
   unset `MAXMIND_LICENSE_KEY` for the tag-triggered build, accept the
   `.empty` marker, let the runtime resilience layer carry the
   request. The post-deploy `/api/version` will show
   `offlineGeoEnabled: false` exactly as v1.4.28 does today, which is
   the documented behaviour.
4. Squash-merge PR #171 and continue from Step 7.
