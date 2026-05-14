# Phase W11a — Multi-arch Docker build

Date: 2026-05-14
Branch: develop
Commit: 3e78da6

## Outcome

`docker-publish.yml` now produces a multi-arch GHCR manifest covering
`linux/amd64` and `linux/arm64`. Apple Silicon Macs (Marc's M-series),
arm64-hosted clouds (Graviton, Ampere), and the existing x86_64
Coolify hosts (apps-01 production, edge-01 demo) all pull from a
single tag and Docker auto-selects the right platform — `docker pull`
no longer warns about a platform mismatch and Rosetta-translated runs
on Marc's laptop disappear.

## Current-state inspection

| Surface | Pre-change state | Findings |
|--|--|--|
| `.github/workflows/docker-publish.yml` | `platforms: linux/amd64` (single arch) | v1.4.16 C5 had pulled the qemu-arm64 path out after SIGILL crashes; the inline comment promised a "native-runner matrix in v1.5" against `ubuntu-24.04-arm` |
| `Dockerfile` | `node:22-alpine` + `postgres:16-alpine` + npm/pnpm/prisma | Fully arch-agnostic: no `--platform=...` pins, no `*-x86_64` binary downloads, no native build steps that would break on arm64. Docker Hub manifests for both base images publish arm64 variants (verified via registry HEAD) |
| `docker-compose.yml` | `image: ghcr.io/mbombeck/healthlog:latest` | No `platform:` override; consumers auto-select. No change needed |
| `README.md` line 82 | Already advertises "multi-arch image (`linux/amd64` + `linux/arm64`)" | The README has been stale since v1.4.16 C5 dropped arm64; this change re-aligns reality with the published claim. No README edit required |

## Changes applied (1 commit)

**`ci(docker): build multi-arch image (linux/amd64 + linux/arm64) for Apple Silicon support`** — `3e78da6`

- `build` job becomes a 2-entry matrix:
  - `linux/amd64` on `ubuntu-latest`
  - `linux/arm64` on `ubuntu-24.04-arm` (standard GitHub-hosted runner, free for public repos, native silicon)
- Each matrix branch pushes the per-platform image **by digest only**
  (`outputs: type=image,...,push-by-digest=true,name-canonical=true`)
  and uploads its digest as a per-platform artifact.
- New `merge` job downloads both digests, re-runs
  `docker/metadata-action` to produce the full tag list (semver, latest,
  sha-, ref), and assembles the multi-arch manifest with
  `docker buildx imagetools create -t ... ghcr.io/...@sha256:<digest> ...`
  — a manifest-only operation, no layer re-upload.
- gha cache scope is now per-platform AND per-ref:
  `build-amd64-<ref>` / `build-arm64-<ref>`, falling back to
  `build-amd64-main` / `build-arm64-main` for warm starts. amd64 and
  arm64 caches stay isolated so a stale arm64 layer cannot poison an
  amd64 build, and the v1.4.15 C3 "tag + main at same SHA must not
  contend on writes" invariant still holds.
- The Coolify deploy webhook moves into the `merge` job so it fires
  exactly once, only after the multi-arch manifest is final. Skipping
  on missing `COOLIFY_WEBHOOK` / `COOLIFY_TOKEN` secrets is preserved.

No Dockerfile change. No `docker-compose.yml` change. No README or
docs change (the README already advertises multi-arch; the v1.4.16 C5
comment is replaced by the inline rationale on the new matrix).

## Why a native-runner matrix instead of `docker/setup-qemu-action`

The "obvious" single-buildx multi-platform path
(`docker/setup-qemu-action@v3` + `platforms: linux/amd64,linux/arm64`)
is exactly what v1.4.16 C5 ripped out, deterministically, because Next
15's static-page generator SIGILL-crashed under qemu-arm64 user-mode
emulation on Node 22 + Alpine 3.21
(`Next.js build worker exited with code: null and signal: SIGILL` at
roughly page 64/86). v8's optimising tier emits CPU instructions qemu
cannot reliably translate, and main-branch builds rarely got lucky
enough to finish their static-export window. Re-introducing qemu would
re-introduce the bug.

`ubuntu-24.04-arm` runs the build on real arm64 silicon — no qemu, no
SIGILL, build time comparable to the amd64 path (no 2–3× emulation
tax). It is a standard GitHub-hosted runner image, free of charge for
public repositories. The image-merge step on `ubuntu-latest` is a
pure-registry operation that touches no per-platform binaries.

## Verification approach

Workflow YAML validated with both `actionlint 1.7.12` (zero findings)
and `yamllint` (relaxed profile, zero findings) — see commit context.

End-to-end validation is intentionally deferred to the W11 release-prep
Draft-PR: that PR will trigger `docker-publish.yml` via the
`pull_request: branches: [main]` clause and produce a non-push build
(per-platform `push=false`) on both runners, exercising the matrix
without consuming a registry tag. A real publish only happens on a
tag push or a merge to `main`.

I also dry-ran the trickiest shell step (the `docker buildx
imagetools create` invocation) against mock metadata and mock digests
locally; the assembled command came out as the canonical
`docker buildx imagetools create -t <tag1> -t <tag2> ...
ghcr.io/...@sha256:<digest1> ghcr.io/...@sha256:<digest2>` form
the docker docs prescribe.

## How Marc can verify post-tag

Once the v1.4.25 tag publishes to GHCR:

```bash
# Native arm64 pull on Apple Silicon — should NOT print a
# "no matching manifest for linux/arm64/v8" warning anymore.
docker pull --platform linux/arm64 ghcr.io/mbombeck/healthlog:v1.4.25

# Inspect the manifest list:
docker buildx imagetools inspect ghcr.io/mbombeck/healthlog:v1.4.25
# Expected: a top-level "Manifest list" with two children,
#   linux/amd64 and linux/arm64, each with its own digest.

# Confirm Marc's Mac is pulling native:
docker image inspect ghcr.io/mbombeck/healthlog:v1.4.25 \
  --format '{{.Architecture}}/{{.Os}}'
# Expected on M-series: arm64/linux  (was: amd64/linux under Rosetta)

# On apps-01 / edge-01 (x86_64) nothing changes — the manifest list
# auto-selects amd64 just like the single-platform image did.
```

## Apple-Silicon-specific notes

- Marc's M-series running an `amd64` image goes through Rosetta 2's
  x86-64 → arm64 binary translation. For a Node.js workload the
  per-CPU-bound delta is roughly 15–30 % slower than native, and
  certain JIT paths (V8 Sparkplug/Maglev) take measurable hits;
  cold-start times suffer the most. Switching to a native arm64 image
  removes Rosetta from the loop entirely — same code, no translation,
  no warning at pull time.
- `docker compose up` on the M-series will silently start picking
  arm64 from `latest` once v1.4.25 ships. No env-var flip needed; no
  `--platform` flag needed; no `~/.docker/config.json` edit.
- The compose's healthcheck (`wget --spider …`) is arch-agnostic — it
  shells out to busybox `wget` which ships in both `node:22-alpine`
  variants identically.

## Flags / things to know

- **First arm64 build will be uncached.** The new
  `build-arm64-<ref>` cache scope has no prior layers; the first
  `linux/arm64` build of `v1.4.25` (or develop → main merge) will
  cold-start. Subsequent builds warm-start off the `build-arm64-main`
  scope. Wall-clock impact: roughly the same as the cold amd64 build
  on `ubuntu-latest`, which was ~12 min at v1.4.24.
- **arm64 runner billing is the same as amd64 for public repos** —
  zero, per the GitHub Actions reference. If the repo ever flips to
  private, arm64 minutes are still 1× (not 2×) the standard rate.
- **No documentation drift introduced.** The README's pre-existing
  multi-arch claim becomes accurate again on the first publish; the
  v1.4.16 C5 audit doc (`docs/audit/v1416-summary.md` ll. 161–162,
  253) explicitly named this work as the planned follow-up, and
  `docs/audit/v1418-summary.md` ll. 248 carried the same note. Both
  audit docs read correctly without edits because they described this
  exact landing.
- **Manifest-merge job is a single point of failure for tags.** If
  `merge` fails after both `build` matrix jobs succeed, the
  per-platform digests are already in GHCR (consumers will not find
  them under a tag, but they exist under the bare digest). Re-running
  the `merge` job in isolation from the Actions UI will stitch them
  without rebuilding — `imagetools create` is idempotent.

## Atomic commits

| Commit | Subject |
|--|--|
| `3e78da6` | `ci(docker): build multi-arch image (linux/amd64 + linux/arm64) for Apple Silicon support` |

No optional follow-up commits were needed (Dockerfile was already
arch-agnostic; README already advertised the capability).
