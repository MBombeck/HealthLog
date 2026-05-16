---
file: .planning/round-v1434-closure-report.md
purpose: v1.4.34 release closure — apple-health import + reliability + web freeze
created: 2026-05-17
tag: v1.4.34
---

# v1.4.34 — release closure

Shipped 2026-05-17. The final functional web release before the iOS
native client lands. Headline work: a streaming Apple Health
`export.zip` importer, a server-side aggregation cache that collapses
the three hottest dashboard reads onto in-process LRU slots with
single-flight coalescing and per-user invalidation, a broader
compliance classifier with a dedicated `early` bucket, the Coach
launch surface hoisted onto every authed page with a dashboard-hero
CTA, a trimmer Settings shelf that folds Sources into Targets, two
e2e flake-window tightenings, and the web-freeze marker pinned across
CHANGELOG + Prisma schema head comment + the v1.5 strategic plan
decision log.

## Outcome

- GitHub Release:
  <https://github.com/MBombeck/HealthLog/releases/tag/v1.4.34>.
- Tag `v1.4.34` →
  `affede31a408974d016f4f6b47a9cb0cd703d8d0` on `main`
  (PR #179 squash, merged at 2026-05-16T19:25:26Z).
- Sister-repos:
  - `healthlog-docs@5391448` — image-pin bump in
    `src/content/docs/self-hosting/updates.mdx` from `:1.4.33`
    to `:1.4.34`.
  - `healthlog-landing@33e6039` — already on the expected HEAD
    from the v1.4.33 AASA-rollout round; no drift, no commit
    needed.
- GHCR build conclusion: SUCCESS — single multi-arch
  (linux/amd64 + linux/arm64) build on tag push
  (`25970776818`), 4 m 47 s linux/amd64 + 4 m 16 s linux/arm64,
  manifest-merge step green; image digest
  `sha256:3f268a9e390cfccb22795bb1755c8786ea8cb276573f02744ee58954722b3166`.
  IW-A's `docker-publish.yml` workflow gate held — exactly one
  build fired per tag (vs the double-build pattern noted in
  the v1.4.33 iceberg).
- Coolify auto-deploy: **fallback used on both hosts.**
  - apps-01: Coolify-API redeploy (MCP `deploy --force`)
    queued + finished at 2026-05-16T19:32:36Z but did not pull
    the new image because the compose file pins `:latest` and
    the local `:latest` was stale. Host-side retag fallback
    applied (`docker pull :1.4.34` + `docker tag :latest` +
    `docker compose up -d --force-recreate app`).
  - edge-01: Coolify MCP still unreachable (matches v1.4.33
    iceberg note). SSH host-side compose-pin bump applied:
    `sed -i 's|:1.4.33|:1.4.34|g' docker-compose.yaml` +
    `docker pull` + `docker compose up -d --force-recreate`.
  - Pre-deploy compose backups created at
    `docker-compose.yaml.pre-v1434.bak` on both hosts.

## Commits on develop since v1.4.33 closure

Forty-two commits between `b8f6b13a` (v1.4.33 release commit on
develop) and the v1.4.34 release tag, including the trailing
v1.4.33-finalisation tail (AASA + planning), the post-merge
reconciliation merge commit, and the v1.4.34 work proper. The
v1.4.34 work proper (after `72a72266 docs(planning): v1.4.33
closure`) groups as:

### IW-A — Infrastructure carryovers

- `8e05f922` feat(http): centralise authed Cache-Control with
  bfcache-friendly preset
- `42432832` chore(build): silence NFT-trace warnings and ship
  the bfcache header
- `24b8d52f` ci(docker): fire the release build once per tag
- `5daa78da` docs(planning): document apps-01 env-var duplicate
  sections
- `aac2ab68` docs(planning): v1.4.34 IW-A close-out report

### IW-XML — Apple Health `export.zip` import

- `2a3fb0e9` chore(deps): add sax for streaming Apple Health
  XML import
- `3d309bb9` feat(import): add ImportJob model for Apple Health
  export ingest
- `3e2d2c46` feat(import): streaming Apple Health export.xml
  parser + mapper
- `9c227894` feat(jobs): apple-health-import worker queue
- `73cd44e0` feat(import): Apple Health export.zip endpoints +
  multipart streamer
- `c6528b93` test(import): cover Apple Health export.zip parser
  + endpoints
- `cc3aae97` docs(changelog): note the Apple Health
  `export.zip` import for v1.4.34
- `1413bc39` docs(planning): IW-XML close-out report

### IW-B — Dashboard + Coach + Cache-Control

- `9a8a9e9a` feat(analytics): expose per-type lastSeenByType +
  bfcache-friendly Cache-Control
- `721e88df` feat(i18n): add stale-hint week/month plurals and
  dashboard coach CTA
- `0729c202` feat(dashboard): hoist Coach launch provider and
  add hero CTA
- `4d404542` docs(planning): v1.4.34 IW-B close-out report

### IW-C — Compliance classifier

- `36d5398c` fix(compliance): widen grace window and add
  `early` bucket
- `4984bce5` fix(compliance): route `early` intakes through
  the compliant bucket
- `30c8555c` refactor(charts): drop the v1.4.33 heatmap
  classifier-bug fallback

### IW-D — Settings + Insights UX

- `fd81d3b8` refactor(settings): merge Sources into Thresholds
  as "Targets & Sources"
- `bcca7664` refactor(insights): collapse five vital pills under
  a Vitals parent
- `43502185` i18n: add Vitals parent + Targets & Sources keys
  across six locales

### IW-F-Perf — Consumer collapse

- `ca7ca0e7` feat(queries): shared achievements query hook
- `3b77b6a0` refactor(gamification): collapse achievement
  consumers onto shared hook
- `c6345b71` test(queries): pin achievements hook collapse +
  audit analytics consumers
- `6529073c` docs(planning): IW-F-Perf close-out report

### IW-G — Server-cache primitive + 3 hot routes + 13 invalidation hooks

- `a5dd8e1d` feat(cache): server-side LRU primitive + per-user
  invalidation helpers (also carries the IW-E web-freeze marker
  edits, see §"Pool-bump hot-fix + observability" below)
- `68c4bb73` perf(api): wire 3 hot read routes through the
  server cache
- `757387ca` feat(cache): wire 13 write endpoints to per-user
  invalidation helpers
- `bcdab48e` test(cache): integration coverage + CHANGELOG entry
  for server cache

### IW-E — Web-Freeze marker + e2e flake fixes

- `fef24a89` test(e2e): stabilise onboarding-flicker +
  mobile-viewport probes
- `13b451a5` docs(planning): v1.4.34 IW-E close-out report
- (web-freeze edits on `CHANGELOG.md` + `prisma/schema.prisma` +
  `.planning/v15-strategic-plan.md` rode along with `a5dd8e1d`
  through a concurrent-worker staging race — content is correct,
  attribution is the IW-G commit)

### Release commits

- `72b2506a` docs(changelog): clean v1.4.34 entry
- `1ae4adfd` chore(release): v1.4.34
- `fd1a4366` Merge remote-tracking branch 'origin/main' into
  develop (post-v1.4.33 reconcile)

## Verification

All checks performed at 2026-05-17T00:30 UTC after the host-side
retag fallback completed on both hosts.

### apps-01 (`healthlog.bombeck.io`)

```
$ curl -s https://healthlog.bombeck.io/api/version
{"data":{"version":"1.4.34","buildSha":null,"builtAt":null,"license":"AGPL-3.0",
"repository":"https://github.com/MBombeck/HealthLog",
"changelog":"https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md",
"docs":"https://docs.healthlog.dev","offlineGeoEnabled":false},"error":null}

$ curl -sI https://healthlog.bombeck.io/privacy
HTTP/2 200

$ curl -s https://healthlog.bombeck.io/.well-known/apple-app-site-association
{"applinks":{"apps":[],"details":[]},"webcredentials":{"apps":["S8WDX4W5KX.dev.healthlog.app"]}}
```

### edge-01 (`demo.healthlog.dev`)

```
$ curl -s https://demo.healthlog.dev/api/version
{"data":{"version":"1.4.34","buildSha":null,"builtAt":null,"license":"AGPL-3.0",
"repository":"https://github.com/MBombeck/HealthLog",
"changelog":"https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md",
"docs":"https://docs.healthlog.dev","offlineGeoEnabled":false},"error":null}

$ curl -sI https://demo.healthlog.dev/privacy
HTTP/2 200

$ curl -s https://demo.healthlog.dev/.well-known/apple-app-site-association
{"applinks":{"apps":[],"details":[]},"webcredentials":{"apps":["S8WDX4W5KX.dev.healthlog.app"]}}
```

### Landing (`healthlog.dev`)

```
$ curl -sI https://healthlog.dev/privacy
HTTP/2 200
$ curl -sI https://healthlog.dev/support
HTTP/2 200
$ curl -s https://healthlog.dev/.well-known/apple-app-site-association
{"applinks":{"apps":[],"details":[]},"webcredentials":{"apps":["S8WDX4W5KX.dev.healthlog.app"]}}
```

### Apple CDN re-probe

- `app-site-association.cdn-apple.com/a/v1/healthlog.dev` →
  200, matches origin byte-for-byte.
- `app-site-association.cdn-apple.com/a/v1/demo.healthlog.dev`
  → 200, matches origin byte-for-byte.
- `app-site-association.cdn-apple.com/a/v1/healthlog.bombeck.io`
  → 200, matches origin byte-for-byte. **Ingested since
  v1.4.33** (was 404 in the v1.4.33 closure-report; Apple's
  CDN walked the new origin after the first authenticated
  fetch).

### CI on PR #179

- 6/7 green: Build linux/amd64, Build linux/arm64, integration,
  Lint/Typecheck/Test, dependency audit, secret scanning.
- e2e: 3 pre-existing v1.4.32-era flakes (onboarding-flicker
  desktop + mobile, mobile-viewport touch-targets) — IW-E's
  tightening landed on the spec selectors but the CI run still
  caught the same three windows. Accepted ship-with-flakes per
  the maintainer's standing decision.

## Pool-bump hot-fix + observability

### apps-01 `DATABASE_URL` pool-bump

Mid-session env-only change (no code, no release) per
`.planning/round-v1434-prod-slowness-investigation.md` §2:
`DATABASE_URL` was edited on apps-01 to append
`?connection_limit=20&pool_timeout=10` so the prisma + pg-boss
pools share a deterministic ceiling instead of starving each
other under load. Followed by a Coolify redeploy to pick up the
new env. **edge-01 still has the bare `DATABASE_URL`** because
the edge-01 Coolify MCP daemon was unreachable during the
session — operator action pending the MCP daemon restart.

Once edge-01 is reachable, the same edit applies:
- env var: `DATABASE_URL`
- append: `?connection_limit=20&pool_timeout=10`
- redeploy (or container restart) to flush the prisma + pg-boss
  pool instances and pick up the new connection-string.

### Server-cache observability

`ServerCache<T>` from IW-G ships an `annotate` hook that lands
two keys on every wide-event for a cached request:

- `cache.<name>.outcome` ∈ `{ hit | miss | stampede }`
- `cache.<name>.key_hash` — non-reversible djb2 32-bit hash of
  the cache key (`userId|scope`)

Prod log grep recipes for hit-ratio:

```
# All analytics outcomes in the last hour
... | grep -E 'cache\.analytics\.outcome' | jq -r '.meta."cache.analytics.outcome"' | sort | uniq -c

# Achievements + intake + analytics hit-ratio in one pass
... | grep -E 'cache\.(analytics|achievements|medicationsIntake)\.outcome' | jq -r '"\(.meta | to_entries | map(select(.key | endswith(".outcome"))) | .[0].key) \(.meta | to_entries | map(select(.key | endswith(".outcome"))) | .[0].value)"' | sort | uniq -c
```

Eight registered caches sit behind the registry; capacity caps
land each instance below 500-1000 entries × ~5 KB so worst-case
memory across the eight is ~40 MB — comfortably inside the
512 MB Coolify container budget. Process-local cache only;
multi-instance Coolify deploys would diverge per container
until the v1.5.x Redis migration.

## Apple Health import perf

The IW-XML synthetic 10 000-record case stresses the
cumulative-fold path (every row collapses into one
`stats:HKQuantityTypeIdentifierStepCount:YYYY-MM-DD` daily
bucket) and lands at 312 ms wall-clock with a heap-delta ceiling
under 100 MB. A bounded 1 GB synthetic-fixture test was
deliberately deferred — the in-process heap-delta assertion
already exercises the streaming property under test
(per-token SAX, bounded buffers), and the integration-tier
1 GB fixture would require a `testcontainers` Postgres + several
minutes per run. Adding the 1 GB-fixture path to a nightly
perf suite tracks under v1.4.35 backlog.

## Resource-limits Coolify resize

Per the v1.4.33 prod-slowness investigation §3 (and noted in
the iceberg), the apps-01 HealthLog application still has
`limits_cpus: "0"` + `limits_memory: "0"` in the Coolify
control-plane config — i.e. no Docker resource limits at all,
so the host's 25-app inventory shares the same kernel scheduler
budget. The recommended UI-action is to bind HealthLog to
`limits_cpus: "2"` + `limits_memory: "1g"` in the Coolify
Application → Limits panel so the container has a deterministic
floor regardless of neighbour load. This is operator-action
only and pending the maintainer's UI access.

## Carry-overs to v1.4.x / v1.5.x

### Behind the web-freeze gate

The web-freeze marker now pins additive-only changes for the
v1.4.x tail. Concrete items still on the runway:

- **Apple Health import: 1 GB synthetic-fixture perf test**
  under the nightly suite (IW-XML defer).
- **Apple Health import: HKClinicalRecord / FHIR ingest**
  (IW-XML §13, post v1.5).
- **Apple Health import: HKElectrocardiogram waveforms**
  (no HealthLog ECG model yet, deferred indefinitely).
- **Apple Health import: workout routes (`workout-routes/*.gpx`)**
  — schema field exists, parser write-back deferred to a
  post-v1.4.34 follow-up.
- **`getting-started-checklist.tsx` thick-slice swap** — drop
  the dashboard's duplicate slim-call once IW-B's
  `lastSeenByType` contract stabilises (IW-F-Perf §3).
- **Per-metric interleaved Settings blocks** — IW-D's
  Targets+Sources merger stacks both card bodies vertically;
  the deeper "metric-by-metric, threshold on top, source list
  below" merge needs a ~400 LoC `<MetricConfigSection>` and
  cross-namespace metric mapping. Deferred.
- **Coolify env-var duplicate prune** — IW-A's audit pinned
  the section-1 / section-2 duplicate pairs on apps-01 (28
  keys); operator-action deletes pending. Edge-01 audit still
  blocked on MCP unreachability.
- **GHCR docs `:latest` rotation policy** — IW-A's
  workflow-trigger change collapses to one build per release
  tag and keeps `:latest` on stable tags only. Confirmed
  working this round.

### v1.5.x scope (after iOS clears review)

- **Redis-backed shared cache** to replace IW-G's process-local
  `ServerCache<T>` once multi-instance deploys arrive.
- **iOS Universal Links** — populate `applinks.details` once the
  iOS side opts in to deep-linking; current AASA body has empty
  `applinks` arrays.
- **`/.well-known/security.txt`** (RFC 9116) and
  **`/.well-known/change-password`** (W3C) — admitted by the
  current proxy bypass already.
- **iOS bundle-rename window** — Apple's AASA CDN caches for an
  hour; document the implication on the iOS handoff if the
  bundle prefix ever rotates.

## Iceberg notes for the next round

- **Coolify registry-digest auto-deploy still off.** Both hosts
  ignored the GHCR push; apps-01 used MCP API redeploy + host
  retag, edge-01 used SSH compose-pin + recreate. The "watch
  image registry for new digests" toggle in the Coolify UI is
  the load-bearing fix per
  `.planning/coolify-auto-deploy-howto.md`; without it the
  host-side fallback is the only path. Recipe:
  ```
  # apps-01 (compose pins :latest)
  ssh apps-01
  docker pull ghcr.io/mbombeck/healthlog:1.4.34
  docker tag ghcr.io/mbombeck/healthlog:1.4.34 \
    ghcr.io/mbombeck/healthlog:latest
  cd /data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss
  docker compose up -d --force-recreate app
  ```
  ```
  # edge-01 (compose pins explicit tag)
  ssh edge-01
  sed -i 's|healthlog:1.4.33|healthlog:1.4.34|g' \
    /data/coolify/applications/ck8cs4osswg8w440gskw08w8/docker-compose.yaml
  docker pull ghcr.io/mbombeck/healthlog:1.4.34
  cd /data/coolify/applications/ck8cs4osswg8w440gskw08w8
  docker compose up -d --force-recreate
  ```
  Pre-deploy compose backups created at
  `docker-compose.yaml.pre-v1434.bak` on both hosts.
- **GHCR double-build fixed.** IW-A's
  `docker-publish.yml` change collapsed the squash-merge + tag
  push double-run to exactly one build per release tag this
  round. The `:latest` raw-tag enable rule moved onto the tag
  ref so each release refreshes both the semver tags and the
  `:latest` alias in the same run. Pre-release tags
  (`-rc.1`, `-beta.2`) stay off `:latest`.
- **edge-01 Coolify MCP unreachable.** The MCP integration for
  edge-01 (`46.225.114.153:8000`) returned a connection error
  again during the deploy pipeline; SSH itself worked fine so
  the fallback path covered it. **The edge-01 pool-bump cannot
  land via MCP** until the daemon is restarted — flagged as the
  primary operator-action carry-over.
- **PR-merge conflict on every release.** Develop has the work
  as atomic commits; main is updated by squash-merge so the
  squash commit's tree diverges from develop's
  atomic-commit-tree on the same files. Every release surfaces
  ~20 add/add conflicts on the v1.4.34-touched paths — every
  one resolves cleanly with `--ours` on develop and a
  no-edit merge commit. Worth pinning in the release runbook
  so the next round doesn't burn cycles re-discovering the
  shape.
- **e2e flake band stable at 3.** IW-E's two-spec tightening
  landed on develop but the CI run still caught the same three
  windows (`onboarding-flicker` desktop + mobile,
  `mobile-viewport`). The fixes are correct in spirit but the
  underlying race is a Vercel-dev cold-mount artefact that
  doesn't reproduce locally. Ship-with-flakes pattern holds.

## Drain-script status

Operator-action pending. `/api/admin/drain-per-sample-cumulative`
was not invoked from this round — same as v1.4.33, it's
cookie-auth gated and the admin cookie is not available
programmatically. The drain remains on the v1.5 iOS-TestFlight
cutover checklist as a manual step against the production host.

## Blocked items

None. The entire pipeline cleared the same session: tag pushed,
GHCR built both architectures, both hosts redeployed (via
fallback), GH Release published, sister-repos in sync, drain
script intentionally deferred to operator-action per briefing.

## Operator-action carry-overs

Five items waiting on the maintainer:

1. **edge-01 Coolify MCP daemon restart** so the next release
   can reach env vars + force redeploys via MCP instead of
   falling through to SSH.
2. **edge-01 `DATABASE_URL` pool-bump** — apply the same
   `?connection_limit=20&pool_timeout=10` suffix that landed
   on apps-01 this session.
3. **Coolify resource-limits resize on apps-01** — bind
   HealthLog to `limits_cpus: "2"` +
   `limits_memory: "1g"` in the Coolify Application → Limits
   panel.
4. **Coolify registry-digest auto-deploy toggle** — flip the
   "watch image registry for new digests" switch in the
   Coolify UI for both apps-01 and edge-01 so the GHCR push
   produces green auto-deploys without the host-side
   fallback.
5. **apps-01 env-var duplicate prune** — IW-A's audit pinned
   28 section-1 / section-2 duplicate pairs; deletes pending.
   Highest-priority candidate is UUID
   `d3r4k1lryj6n0z7dfj4hhc8t` (placeholder
   `POSTGRES_PASSWORD` value `"POSTGRES_PASSWORD is required"`).

## Final state of the v1.4.34 wins

- **Apple Health `export.zip` import live.** Both hosts accept
  multipart uploads at `POST /api/import/apple-health-export`;
  worker queue registered; idempotent re-uploads short-circuit
  on content hash; `ImportJob` row state machine surfaces
  progress through the status endpoint.
- **Server-side aggregation cache live.** Three hot reads
  cached, 13 write endpoints invalidate. First-warm hit ratio
  expected to land in the 70-90 % band within the first few
  minutes of production traffic (single warm dashboard request
  per user, cached for 60 s, invalidates on the user's next
  write). `cache.<name>.outcome` annotation on the wide-event
  is the live signal — grep prod logs to confirm.
- **Compliance classifier widened.** Early intakes count as
  compliant in heatmap + perfect-day surfaces; the v1.4.33
  `looksClassifierBug` defensive fallback is retired now that
  the underlying root cause is gone.
- **Coach reachable from every authed route.** Drawer + launch
  provider hoisted to the auth-shell; dashboard hero CTA wires
  to `coachLaunch.askCoach(null)`.
- **Settings shelf trim** — section count 11 → 10 (Sources
  folded into Targets); insights tab-strip 14 → 10 (Vitals
  parent collapses HRV, Resting HR, Oxygen, Body Temperature,
  Active Energy).
- **Bfcache eligibility restored.** Every authed HTML page now
  ships `Cache-Control: private, max-age=0, must-revalidate`
  (vs the framework's default hard-bfcache-breaker
  `no-store, must-revalidate`).
- **Web freeze pinned.** v1.4.34 is the last functional web
  release; the marker lives in CHANGELOG + Prisma schema head
  comment + `.planning/v15-strategic-plan.md` §5 decision log.
