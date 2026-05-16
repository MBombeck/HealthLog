---
file: .planning/round-coolify-auto-deploy-fix-2026-05-16.md
purpose: Root cause + remediation note for the recurring Coolify auto-deploy gap
created: 2026-05-16
release: v1.4.31
---

# Coolify auto-deploy — five-release no-op investigation

## Symptom

Five releases in a row — v1.4.27, v1.4.28, v1.4.29 (+ v1.4.29.1),
v1.4.30, v1.4.30.1 — the `Trigger Coolify deploy` step of the
publish workflow reported a 2xx from the webhook, the step turned
green, and the manifest was demonstrably present on GHCR seconds
earlier. Yet the running container on apps01 still carried the
prior `:latest` digest. Host-side SSH fallback
(`docker pull ghcr.io/mbombeck/healthlog:latest` +
`docker compose up -d --force-recreate --no-deps app`) was the
patch every time, costing ~5 minutes per release.

## Pipeline shape (.github/workflows/docker-publish.yml lines 240-365)

1. Build multi-arch digests, push them as digest blobs.
2. `docker/metadata-action` computes the tag set (`latest`, the
   exact `vX.Y.Z` tag, the major/minor pair, the SHA-prefixed
   shortform).
3. `docker buildx imagetools create` glues the digests into a
   manifest list and pushes the new `:latest` (+ named tags) to
   GHCR.
4. `docker buildx imagetools inspect` confirms the manifest list
   resolves on GHCR's registry endpoint (`ghcr.io/v2/...`).
5. **Immediately** afterwards, `curl $COOLIFY_WEBHOOK?force=true`
   fires.

Step 4 confirms the manifest exists at the registry-write side.
But GHCR sits behind a CDN edge layer that propagates writes
asynchronously to consumer reads. Empirical evidence from this
repo's logs across the five affected releases: the `inspect` step
resolves in ~5 s, but a `docker pull` from the apps01 host
issued <30 s later kept returning the prior digest. A
`docker pull` issued ~90 s later returned the new digest cleanly.

## Hypotheses tested

| H | Verdict | Evidence |
|---|---|---|
| **H1 — Coolify webhook URL stale** | Ruled out | Step returns HTTP 200 with a Coolify "deployment finished" body across all 5 releases. The webhook itself is live. |
| **H2 — `COOLIFY_TOKEN` expired** | Ruled out | 2xx response excludes an auth failure; expired token would 401. |
| **H3 — `force=true` query stripped** | Ruled out | The workflow appends the query unconditionally and the audit log on apps01 confirms a pull attempt fires; the attempt resolves to "no new digest". |
| **H4 — GHCR CDN propagation race** | **Confirmed** | Pull-rate behaviour above. The webhook fires inside the 30-90 s edge-propagation window; Coolify's pull sees the prior digest, declares no-op, returns success. |
| **H5 — Coolify image-cache stale** | Contributing | Coolify caches resolved digests for `:latest` references. When the pull returns the prior digest, the cache stays valid and no container is recreated. The cache is not the trigger — the registry read is — but it amplifies the gap by 5-10 minutes after a fresh edge read finally lands. |
| **H6 — apps01 deploy-webhook subscriber missing** | Ruled out | The deploy-webhook subscriber at `/api/internal/deploy-webhook` is live (v1.4.26 work) and would surface a notification if Coolify reported any failure state. It reports success in lock-step with the webhook's 2xx. |

The H4 + H5 combo explains every observation: the webhook works,
Coolify works, GHCR works — but the read-after-write window
between the registry push and the edge propagation is wider than
the workflow's spacing assumption.

## Fix

Two options were considered:

- **A. Add `sleep 90` before the Coolify trigger step.** Zero
  Coolify-side risk; widens every release by 90 s on the publish
  pipeline. Operator-visible cost: ~1.5 minutes per release.
- **B. Pass the explicit tag to Coolify via a query parameter
  (`?image=ghcr.io/mbombeck/healthlog:1.4.31`) so the pull
  references the exact digest instead of `:latest`.** Lower
  per-release cost but requires the operator's Coolify webhook URL
  to support an `?image=` override, which is not documented for
  the current Coolify version on apps01.

Chose **Option A** — `sleep 90` lands inside the existing step,
no Coolify-side configuration changes needed, no operator
intervention required. The cost is bounded: the publish pipeline
already runs ~4-5 minutes (build matrix + manifest creation), so
the 90 s sleep adds ~30% to the publish job duration but lands
entirely after the image is fully published. The release-flow
walk-through clock is unaffected.

If Option A still proves insufficient on v1.4.31, the next
escalation is Option B — and we should at that point also confirm
whether GHCR's edge-propagation budget has changed (CDN provider
swaps would surface here first).

## Patch landed

`.github/workflows/docker-publish.yml` — `Trigger Coolify deploy`
step now runs `sleep 90` immediately after the auth + skip-mode
guards, before the deploy URL is computed. The sleep sits inside
`continue-on-error: true` so it cannot turn a green build red.

A new diagnostic log line prints the resolved image version (from
`steps.meta.outputs.version`) before the sleep so the workflow
log surfaces the exact tag the operator can sanity-check at the
apps01 side.

## Verification plan for v1.4.31

The v1.4.31 release itself is the proof point. The release
sequence becomes:

1. PR squash on `main` → tag `v1.4.31` → push.
2. GHCR tag-build runs the modified workflow.
3. After the 90 s sleep, Coolify webhook fires.
4. Within ~60 s of the webhook, apps01's `/api/version` should
   read `1.4.31` without operator SSH.

If `/api/version` still reports `1.4.30.1` after the 60 s
follow-up window, the host-side SSH fallback is still available
as a backstop — but the closure report records the failure and
escalates to Option B for v1.4.32.

## What this fix does NOT solve

- edge-01 still pins the explicit `1.4.X.Y` tag in its
  docker-compose; that host always required a sed bump on the
  compose file regardless of webhook timing. The host-side recipe
  documented in `.planning/coolify-auto-deploy-howto.md` covers
  it.
- The Coolify image-cache itself is not flushed by this patch.
  `?force=true` on the webhook still tells Coolify to bypass its
  cache; the 90 s sleep ensures GHCR has the new digest available
  when Coolify pulls. The two fixes compose.
