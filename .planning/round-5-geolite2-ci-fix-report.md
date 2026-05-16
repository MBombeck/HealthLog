---
file: .planning/round-5-geolite2-ci-fix-report.md
purpose: GeoLite2 build-key CI fix — root cause + workflow/script hardening
created: 2026-05-16
target_tag: v1.4.28.1
---

# GeoLite2 build-key CI fix

## TL;DR

v1.4.28 shipped with `offlineGeoEnabled: false` on both production
hosts. The MMDB fetch step in the tag-triggered GHCR build did *not*
hard-fail — it silently dropped the `.empty` marker and the runtime
resolver fell back to `ipwho.is`. The fail-loud assertion the v1.4.27
plan called for was removed in commit `674c6b5b` ("soften the GeoLite2
fetch guard so the build never blocks on a missing license key"). This
patch restores fail-loud behaviour *only when the key is set* — the
intentional "no key → skip and continue" path stays in place.

## Root cause

Two layered silent-fallback bugs hid the v1.4.28 regression:

1. **`scripts/fetch-geolite2.sh`** turned every curl / tarball /
   extract error into a `.empty` marker + `return 0` (commit
   `76783431`). That made the script's exit code stop signalling real
   problems — a 401 from MaxMind (wrong key or unsigned EULA), a
   transient 5xx, or a missing file inside the tarball all read as
   "build succeeded, runtime will fall back". The runtime *does* fall
   back, but that defeats the operator-side guarantee on a tag build.

2. **`.github/workflows/docker-publish.yml`** trusted the script's
   exit code. There was no build-time assertion that, with the secret
   present, the MMDBs actually landed in `assets/geolite2/` before the
   Dockerfile COPY at Dockerfile:79.

Net effect: with `MAXMIND_LICENSE_KEY` set as a GitHub repo secret,
the Fetch step could still emit the `.empty` marker and continue
cleanly, producing an image with no offline geo tier. That is the
shape v1.4.28 shipped in. (Whether the v1.4.28 tag build's secret was
actually populated is operator-visible — see "Operator action" below.
The fix makes the failure mode loud either way.)

## Fix applied

### Commit 1 — script: fail loud when the key is set

`scripts/fetch-geolite2.sh`

- `fetch_edition` no longer swallows curl / tarball / extract errors
  on the "key present" path. Each branch returns a non-zero exit
  instead of writing `.empty` + `return 0`. The diagnostic messages
  now explicitly name the most common causes (401 wrong-key,
  403 throttle, 5xx upstream) so the maintainer can act without
  needing to re-read the script.
- Added a final assertion at end-of-script: with the key set, both
  `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` must be non-empty in
  `$OUT_DIR`; otherwise exit 1.
- The intentional no-key branch at top-of-script is unchanged: still
  drops the `.empty` marker and exits 0. Local-dev without a key
  still works; the runtime resilience layer still fires.

### Commit 2 — workflow: build-time MMDB assertion

`.github/workflows/docker-publish.yml`

- New "Verify GeoLite2 databases" step, runs immediately after
  "Fetch GeoLite2 databases" on each platform leg of the matrix
  (linux/amd64 and linux/arm64) before `docker/build-push-action`.
- When `MAXMIND_LICENSE_KEY` is set, the step asserts that both MMDB
  files exist with non-zero size in `assets/geolite2/` and that no
  stale `.empty` marker survives. Either condition fails the build
  with a clear `::error::` line.
- When the secret is unset, the verification step short-circuits to a
  notice and exits 0 — the intentional "ship without offline tier"
  path stays usable.
- `secrets.*` is not available in step-level `if:` expressions on
  GitHub Actions, so the gate is implemented via env-surfaced
  presence check inside the step (validated with `actionlint`).

The workflow header comment block now explicitly references the
v1.4.28 silent-fallback shape and points at the new verification step.

## Verification

### Local smoke-test (executed)

```
# No-key path stays clean:
$ MAXMIND_LICENSE_KEY="" bash scripts/fetch-geolite2.sh
fetch-geolite2: MAXMIND_LICENSE_KEY is not set — skipping download.
fetch-geolite2: the runtime resolver will fall back to ipwho.is.
exit=0
# .empty marker written; runtime fallback intact.

# Bad-key path now fails loud:
$ MAXMIND_LICENSE_KEY="invalid_key" bash scripts/fetch-geolite2.sh
fetch-geolite2: downloading GeoLite2-City ...
curl: (22) The requested URL returned error: 401
fetch-geolite2: GeoLite2-City download failed (curl exit 22) with
                MAXMIND_LICENSE_KEY set — aborting.
fetch-geolite2: 401 means the key is wrong or the EULA is unsigned;
                403 means a throttle; 5xx means MaxMind-side.
                Investigate before retrying.
exit=22
```

### Static checks (executed)

- `shellcheck scripts/fetch-geolite2.sh` — clean.
- `actionlint .github/workflows/docker-publish.yml` — clean.

### Next CI build (predicted)

On the next push to develop / tag build:

1. With the secret correctly set in the repo: the Fetch step
   downloads both MMDBs; the Verify step prints
   `::notice::GeoLite2 MMDBs verified — GeoLite2-City.mmdb N bytes;
   GeoLite2-ASN.mmdb M bytes.`; the rest of the build runs as before;
   the image carries the MMDBs and `offlineGeoEnabled` reads `true`
   on `/api/version`.
2. With the secret unset: the Fetch step warns + writes `.empty`;
   the Verify step prints a skip notice; the build still produces an
   image; `offlineGeoEnabled` stays `false` — same shape as v1.4.27
   shipped.
3. With the secret set but MaxMind returns 401 / 403 / 5xx, or the
   network drops mid-fetch: the Fetch step exits non-zero, the build
   fails on that leg, the maintainer sees the diagnostic in the
   GitHub Actions log. No more silent fallback on a tag build.

## Operator action needed

Confirm `MAXMIND_LICENSE_KEY` is still set under repo Settings →
Secrets and variables → Actions → Secrets. The v1.4.28 closure report
notes `offlineGeoEnabled: false` on both nodes; under the new
workflow that state on the next tag build means *either* the secret
is missing (re-add it) *or* MaxMind is returning a real error (the
build will now fail with a diagnostic and the maintainer will see
what to do).

If the secret is present and the v1.4.28.1 hotfix build fails on the
Fetch step, the most likely causes are:

- The key was regenerated since v1.4.27 and the GitHub secret still
  carries the old value.
- The MaxMind GeoLite2 EULA was re-issued and the account needs to
  re-accept it before the download endpoint returns 200.

Both are operator-side; the workflow now surfaces them clearly
instead of hiding them.

## Files touched

- `scripts/fetch-geolite2.sh` — fail-loud on the key-present path,
  end-of-script MMDB assertion.
- `.github/workflows/docker-publish.yml` — new "Verify GeoLite2
  databases" step + updated header comment.

No `src/` changes. No `package.json` / `CHANGELOG.md` / planning-doc
edits outside this report. iOS contract unchanged.
