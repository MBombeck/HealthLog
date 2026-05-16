---
file: .planning/round-5-v14281-hotfix-report.md
purpose: v1.4.28.1 hotfix closure — Dashboard save + the two CI patches that landed alongside
created: 2026-05-16
contributor: R5 hotfix
---

# v1.4.28.1 — hotfix closure

Shipped 2026-05-16 a few hours after v1.4.28. Single user-facing fix; two CI patches landed alongside because the pipeline surfaced gaps the v1.4.28 tag-build had quietly stepped on.

## Outcome

- `healthlog.bombeck.io/api/version` → `1.4.28.1`, `/privacy` → 200.
- `demo.healthlog.dev/api/version` → `1.4.28.1`, `/privacy` → 200.
- GitHub Release: <https://github.com/MBombeck/HealthLog/releases/tag/v1.4.28.1>.
- Sister repos pinned: `healthlog-docs@9c7cd7b`, `healthlog-landing@e76be04`.

## What landed

| Commit | Subject |
|---|---|
| `e9b2cb19` | fix(dashboard): drop retired widget ids from the saved layout on read |
| `ed71f334` | fix(ci): fail loud when the GeoLite2 fetch is asked for but produces no MMDBs |
| `9c265024` | ci(image): assert the GeoLite2 MMDBs land in the image when the key is set |
| `b84b8070` | docs(planning): GeoLite2 build-key CI fix report |
| `90a62cc9` | chore(release): v1.4.28.1 |
| `3a920661` | ci(image): tag four-segment versions on the multi-arch manifest |

`232ea43d` on `main` is the squash; tag `v1.4.28.1` points at it.

## The actual user-facing bug

The v1.4.28 retire of the `glp1` widget id (FB-A1) removed the tile from `DASHBOARD_WIDGET_IDS` but left every existing user's `dashboardWidgetsJson` carrying the orphan entry. The PUT route's Zod enum rejects the entire blob on the next "Speichern" round-trip, surfacing the "Layout konnte nicht gespeichert werden" toast. Every legacy account hit it on first save after the upgrade.

`resolveDashboardLayout` now filters widget ids the current build does not know about before returning the layout, so the GET shape is current-build-safe and the next save round-trips cleanly. Same migration shape the resolver already applied to comparison baselines and per-chart overlay prefs. The pattern catches every future tile retire too.

## CI gaps surfaced during the hotfix

Two pre-existing weaknesses bit during this release:

1. **GeoLite2 fetch silent fallback** — `scripts/fetch-geolite2.sh` and `docker-publish.yml` swallowed every fetch failure into a `.empty` marker plus `exit 0`. v1.4.28's tag-build shipped an image with `offlineGeoEnabled: false` and no red CI signal; the runtime fallback to `ipwho.is` masked the regression. The patch makes the fetch fail loud when the key is set but the download is throttled or unauthorised. The no-key path is preserved as the documented "operator-disabled" mode. Report: `.planning/round-5-geolite2-ci-fix-report.md`.

2. **Four-segment version tags** — `metadata-action`'s semver patterns only match `vMAJOR.MINOR.PATCH`. The v1.4.28.1 tag-build emitted only `sha-232ea43`, no `1.4.28.1` named manifest. Both hosts deployed via the SHA tag for this hotfix; `type=match,pattern=v(.+),group=1` plus a belt-and-braces `type=ref,event=tag` close the gap for future hotfixes.

## MaxMind throttle as a side effect

The MaxMind license key returned HTTP 429 during the first attempt — the very hardening that closes gap (1) caught it cleanly. The maintainer removed the secret to take the documented no-key path so the hotfix could ship without the offline databases. `offlineGeoEnabled` stays `false` on both hosts until the throttle clears, the secret is re-set, and the next release ships the MMDBs. The runtime fallback to `ipwho.is` carries the carrier-chip resolution in the meantime.

## Deploy mechanics

Coolify auto-deploy did not fire because `COOLIFY_AUTO_DEPLOY` is intentionally `off` and the deploys land via the host-side SSH recipe. The recipe was retargeted at `ghcr.io/mbombeck/healthlog:sha-232ea43` for this release because the manifest never carried a `1.4.28.1` tag (see gap 2). The next release will land on the named tag again.

## Follow-ups

- Maintainer-side: re-set `MAXMIND_LICENSE_KEY` once the MaxMind 429 clears, then trigger a no-op rebuild (`gh workflow run docker-publish.yml --ref v1.4.28.1` or wait for v1.4.29) so the image picks up the MMDBs.
- v1.4.29 backlog (already seeded): SD-H1 "All time" client wire-up, design Mediums, UI-conformity Mediums, simplifier Mediums + Lows.
