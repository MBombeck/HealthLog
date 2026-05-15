---
file: .planning/round-5-blocker-maxmind-license-key.md
purpose: Round 5 release blocker — MAXMIND_LICENSE_KEY repo secret missing on the CI runner
created: 2026-05-15
target_tag: v1.4.27
status: needs-maintainer-action
---

# Round 5 blocker — `MAXMIND_LICENSE_KEY` repo secret missing

## TL;DR

The v1.4.27 release-PR (`#169`, `develop → main`) cannot merge until the
maintainer adds a `MAXMIND_LICENSE_KEY` secret under repo
*Settings → Secrets and variables → Actions → Secrets*. The GHCR
multi-arch build workflow now hard-fails when the secret is missing —
this is the deliberate fail-fast gate landed in RC1 commit `47d20719`,
and matches the fix-plan + RC1 report contract.

## What I tried before stopping

1. Drafted the v1.4.27 CHANGELOG section + bumped `package.json`
   `1.4.26 → 1.4.27`. Commit `004a8491` on `develop`, pushed to
   origin.
2. Opened PR `#169` `develop → main`
   (https://github.com/MBombeck/HealthLog/pull/169).
3. Watched CI. Two checks failed:
   - **`Build linux/amd64` + `Build linux/arm64`** — fast-fail (15-18 s)
     on the new GeoLite2 step the RC1 reconcile wired up. The step
     surfaces `::error::MAXMIND_LICENSE_KEY secret is missing. Set it
     under repo Settings → Secrets and variables → Actions → Secrets …`.
     Both arches die at the same point.
   - **`e2e`** — two stale spec files (`insights-card-preview.spec.ts`
     asserting a retired component, `settings-mobile-consistency.spec.ts`
     asserting the pre-v1.4.27 `h-9` 36 px floor on form inputs).
4. Re-baselined the e2e specs to the new 40 px floor and deleted the
   retired-component spec. Commit `e1befb45` on `develop`, pushed.
5. Three other checks were already green:
   - `Lint, Typecheck & Test` (2m29s)
   - `integration` (1m13s)
   - `Dependency Audit` (27s)
   - `Secret Scanning` (8s)
6. Confirmed via `gh run view 25937285126 --log-failed` that the build
   failure is **only** the missing secret — no Docker-image build
   regression, no Dockerfile error, no Prisma-engine drift. The
   workflow YAML diff is the fix-plan deliverable as-shipped.

## What the maintainer needs to do

Add the `MAXMIND_LICENSE_KEY` secret to the `MBombeck/HealthLog`
repository:

1. https://github.com/MBombeck/HealthLog/settings/secrets/actions
2. Click *New repository secret*
3. Name: `MAXMIND_LICENSE_KEY`
4. Value: the MaxMind license key from the GeoLite2 account at
   https://www.maxmind.com/en/accounts/current/license-key (or
   regenerate one).
5. Save.

After the secret is configured, re-run the failed build workflow:

```
gh run rerun 25937285126 --failed
```

Or push any trivial commit to `develop` to re-trigger the full
pipeline.

## What does NOT need changing

- The workflow YAML is correct and matches the RC1 commit
  `47d20719 fix(ci): wire MAXMIND_LICENSE_KEY into the build workflow
  and fail fast on missing secret`.
- `scripts/fetch-geolite2.sh` correctly exits 0 when the secret is
  absent (so local-dev still works), but the workflow's own guard
  fires before the script and `::error::`s the run.
- The runtime resolver in `src/lib/geo.ts` correctly falls back to
  `ipwho.is` when the offline tier is empty.

## Soft-fail option (not recommended)

If the secret cannot be obtained today, the workflow can be downgraded
to warn-only by editing `.github/workflows/docker-publish.yml`:

```diff
-          if [ -z "$MAXMIND_LICENSE_KEY" ]; then
-            echo "::error::MAXMIND_LICENSE_KEY secret is missing. …"
-            exit 1
-          fi
+          if [ -z "$MAXMIND_LICENSE_KEY" ]; then
+            echo "::warning::MAXMIND_LICENSE_KEY secret is missing — the offline geo feature will ship dead on this image."
+          fi
           ./scripts/fetch-geolite2.sh
```

This contradicts the fix-plan + RC1 report intent ("fails the workflow
with a clear `::error::` message when the secret is unset"). I am not
landing this change without an explicit maintainer instruction; the
fail-fast gate is a deliberate part of the v1.4.27 deliverable.

## Pipeline state at pause

- `develop` HEAD: `e1befb45`
  (`fix(e2e): re-baseline mobile-consistency height assertions …`)
- `main` HEAD: unchanged from the v1.4.26 tag.
- PR `#169` open, not merged.
- Tag `v1.4.27`: not yet created.
- GHCR `1.4.27` image: not yet built.
- Apps01 + edge-01: still on `1.4.26`.

## What happens next once the secret lands

I will resume from Step 5 of the pipeline:

1. Re-run failed CI checks; confirm all checks green.
2. Squash-merge `#169` with subject `chore(release): v1.4.27`.
3. Tag `v1.4.27` on `origin/main` and push.
4. Wait for the GHCR multi-arch builds (5-7 min).
5. Deploy apps01 (Coolify MCP + SSH force-pull).
6. Deploy edge-01 (SSH, version-pin bump).
7. Verify `/api/version` reports `1.4.27` on both hosts and
   `/privacy` still returns 200.
8. Create the GitHub Release.
9. Bump the two sister repos.
10. Write `.planning/round-5-release-closure-report.md`.
