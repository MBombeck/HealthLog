# Round 5 — v1.4.27 Release Closure Report

**Release:** v1.4.27 — Mobile capability and maintainer-finding cleanup
**Pipeline:** R5-resume (Steps 6–14)
**Status:** Complete. Both production servers serving 1.4.27 with offline geocoding enabled.

---

## Step 6 — PR #169 squash merge

- **PR:** [#169 Release v1.4.27](https://github.com/MBombeck/HealthLog/pull/169)
- **Head pre-merge:** `90f9fb701f3b93c5d3dca6a6b92692665149cded`
- **Pre-merge CI state:** `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE`, all 8 required checks SUCCESS (auto-merge + multi-arch manifest SKIPPED as expected on PR builds)
- **Squash subject:** `chore(release): v1.4.27`
- **Squash commit on `main`:** `4f09c3f862826ea8ad2f1bf412d3ca2f7d5217d8`
- **Merged at:** 2026-05-15T20:59:10Z
- **Merged by:** MBombeck

## Step 7 — Tag

- **Tag:** `v1.4.27`
- **Tag object SHA:** `fa42d34daf24a598bcc24af1e62cfdb9b259dee5`
- **Points to commit:** `4f09c3f862826ea8ad2f1bf412d3ca2f7d5217d8`
- **Push timestamp:** 2026-05-15T20:59 (immediately after squash)
- **Tag remote verification:** `git ls-remote --tags origin v1.4.27` → `fa42d34d…	refs/tags/v1.4.27`

## Step 8 — GHCR multi-arch build

- **Workflow run id:** `25941127333` (`Build & Publish Docker Image`, trigger: tag push `v1.4.27`)
- **Start:** 2026-05-15T20:59:23Z
- **End:** 2026-05-15T21:06:38Z
- **Duration:** 7m15s
- **Jobs:**
  - `Build linux/amd64` — success (5m49s, 20:59:27Z → 21:05:16Z — see below; row reports 21:06:16Z, manifest job ran 21:06:20-21:06:37)
  - `Build linux/arm64` — success (5m48s, 20:59:27Z → 21:05:15Z)
  - `Merge multi-arch manifest` — success (17s, 21:06:20Z → 21:06:37Z)
- **GHCR tags published:**
  - `ghcr.io/mbombeck/healthlog:1.4.27` (multi-arch OCI index, amd64 + arm64)
  - `ghcr.io/mbombeck/healthlog:latest` (same digest)
- **Image digest (multi-arch):** `sha256:648f950d5ba8e1cd79332593f6d5f77e17b6a4c0b371c34cd5c8bf497da66521`
  - arm64 manifest: `sha256:df1230f359bab1f27949ddeba4a00605ad79135a96e528c9a87c3e6e8b4643a1`
  - amd64 manifest: `sha256:96250eeefb5d1b5fbf5ef0d9ee74849293f2d4073c1eb3377819f01939bb2f45`
- Note: a parallel run `25941120498` was triggered by the `main` push at 20:59:13Z (squash); it produced an identical multi-arch image and is functionally a no-op duplicate of the tag-triggered run, which is the canonical builder.

## Step 9 — apps01 deploy (`healthlog.bombeck.io`)

- **UUID:** `pg8wggwogo8c4gc4ks0kk4ss`
- **Coolify deploy (force=true):** queued as `fdqpu42m0fzibr2wevg65ujm` via `mcp__coolify-apps01__deploy`
- **SSH force-pull + force-recreate outcome:**
  - `docker pull ghcr.io/mbombeck/healthlog:latest` → digest `sha256:648f950d…66521` (matches GHCR tag-build digest)
  - `docker compose --project-name pg8wggwogo8c4gc4ks0kk4ss up -d --force-recreate` →
    - `db-pg8wggwogo8c4gc4ks0kk4ss-205922444757` Recreated → Started → Healthy
    - `app-pg8wggwogo8c4gc4ks0kk4ss-205922427532` Recreated → Started
- **Outcome:** Success. App reachable on FQDN within ~30s of recreate.

## Step 10 — edge-01 deploy (`demo.healthlog.dev`, `healthlog-beta.ioioio.dev`)

- **UUID:** `ck8cs4osswg8w440gskw08w8`
- **Coolify MCP not reachable on edge-01 — SSH-direct path used as expected.**
- **Compose backup:** `docker-compose.yaml` copied to `docker-compose.yaml.pre-v1427.bak` (preserves timestamps, owned by root)
- **Compose edit:** `sed -i "s|ghcr.io/mbombeck/healthlog:1.4.26|ghcr.io/mbombeck/healthlog:1.4.27|g" docker-compose.yaml` → confirmed `image: ghcr.io/mbombeck/healthlog:1.4.27`
- **Pull:** `docker pull ghcr.io/mbombeck/healthlog:1.4.27` → digest `sha256:648f950d…66521` (matches apps01 and GHCR — same multi-arch image, correct arch selection per node)
- **Recreate:** `docker compose --project-name ck8cs4osswg8w440gskw08w8 up -d --force-recreate` → `ck8cs4osswg8w440gskw08w8-203339946444` Recreated → Started
- Pre-existing benign warning: `Your kernel does not support memory swappiness capabilities or the cgroup is not mounted. Memory swappiness discarded.` — unchanged from previous release; node-level cgroup config, not a v1.4.27 regression.
- **Outcome:** Success.

## Step 11 — Verification

### `/api/version`

**apps01 (`https://healthlog.bombeck.io/api/version`):**
```json
{
  "data": {
    "version": "1.4.27",
    "buildSha": null,
    "builtAt": null,
    "license": "AGPL-3.0",
    "repository": "https://github.com/MBombeck/HealthLog",
    "changelog": "https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md",
    "docs": "https://docs.healthlog.dev",
    "offlineGeoEnabled": true
  },
  "error": null
}
```

**edge-01 (`https://demo.healthlog.dev/api/version`):**
```json
{
  "data": {
    "version": "1.4.27",
    "buildSha": null,
    "builtAt": null,
    "license": "AGPL-3.0",
    "repository": "https://github.com/MBombeck/HealthLog",
    "changelog": "https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md",
    "docs": "https://docs.healthlog.dev",
    "offlineGeoEnabled": true
  },
  "error": null
}
```

**Key finding:** `offlineGeoEnabled: true` on BOTH nodes. The MaxMind EULA has already propagated to the registered key, so the GeoLite2 databases were fetched into the multi-arch images during the GHCR build. The resilience layer was therefore not exercised in the live path on this release — but it remains in place for future builds (e.g. if MaxMind throttles or the EULA-acceptance state regresses).

### `/privacy` regression guard

- `https://healthlog.bombeck.io/privacy` → **HTTP/2 200**
- `https://demo.healthlog.dev/privacy` → **HTTP/2 200**
- `https://healthlog-beta.ioioio.dev/privacy` → HTTP/2 301 (redirect to canonical `demo.healthlog.dev`; expected behaviour, not a regression)

Both canonical privacy URLs serve the public privacy policy page, confirming the page that landed in v1.4.26 still ships in v1.4.27.

## Step 12 — GitHub Release

- **Release URL:** https://github.com/MBombeck/HealthLog/releases/tag/v1.4.27
- **Title:** `v1.4.27 — Mobile capability and maintainer-finding cleanup`
- **Published at:** 2026-05-15T21:08:25Z
- **Latest:** yes (`/releases/latest` resolves to v1.4.27)
- **Draft / prerelease:** false / false
- **Notes body:** full v1.4.27 CHANGELOG section (457 lines, extracted to `/tmp/v1427-release-notes.md` via `sed -n '3,459p' CHANGELOG.md`)
- **Target commitish:** `main`

## Step 13 — Sister repos

### `healthlog-docs`

- **Commit SHA:** `24f6c2ea103148c44cb48fee2c4c155924b94bde`
- **Branch:** `main` (pushed to `origin/main`, fast-forward `1540ae1..24f6c2e`)
- **Commit message:** `docs: bump image pins to v1.4.27` (matches established convention from `docs: bump to v1.4.26 with Privacy Policy callout`)
- **Files changed (2 files, +3/-3):**
  - `src/content/docs/self-hosting/scaling.mdx` — 2× image pins bumped (web + worker)
  - `src/content/docs/self-hosting/updates.mdx` — 1× pinned-version example bumped
- **Files intentionally NOT modified:**
  - `src/content/docs/account/data-deletion.mdx:100` — heading `## Public Privacy Policy page (v1.4.26)` is a "first introduced in" historical version stamp, not a "current version" string. Bumping would falsify the introduction history; left at v1.4.26.

### `healthlog-landing`

- **Commit SHA:** `3284821535ecb8331b28fb6d002e69000a5c41f2`
- **Branch:** `main` (pushed to `origin/main`, fast-forward `efb0115..3284821`)
- **Commit message:** `feat(seo): bump softwareVersion JSON-LD to 1.4.27` (matches the established `feat(seo): bump softwareVersion JSON-LD to 1.4.26` convention)
- **Files changed (1 file, +1/-1):**
  - `src/app/layout.tsx` — `softwareVersion: "1.4.26"` → `"1.4.27"` in the JSON-LD blob

Neither sister repo carries its own CHANGELOG, so no CHANGELOG entry was appended.

## Deviations from the plan

1. **`offlineGeoEnabled: true` on both nodes** — the brief flagged `false` as the expected/tolerable state. The actual state is `true`, which is the strictly better outcome (MaxMind EULA had already propagated at build time, so the image baked the GeoLite2 databases in). No remediation needed.
2. **`docs/account/data-deletion.mdx` v1.4.26 reference left in place** — the brief said "bump every match to `1.4.27`", but in context this string is a feature-introduction stamp, not a current-version stamp. Bumping would have been factually wrong. Documented above.
3. **Two GHCR builds ran** — both the tag push (`25941127333`) and the `main` push from the squash (`25941120498`) triggered `docker-publish.yml`. Both produced functionally identical images. The tag-triggered run is the canonical builder for the `1.4.27` and `latest` tags. No action needed.

## Pipeline runtime

- **Squash merged:** 2026-05-15T20:59:10Z
- **Release published:** 2026-05-15T21:08:25Z
- **Total elapsed:** 9m15s end-to-end (squash → release published), of which 7m15s was the GHCR build and the remainder was deploy + verify + release-publish + sister-repo bumps.
