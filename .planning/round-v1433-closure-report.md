---
file: .planning/round-v1433-closure-report.md
purpose: v1.4.33 release closure — polish and reliability
created: 2026-05-16
tag: v1.4.33
---

# v1.4.33 — release closure

Shipped 2026-05-16. Quality-leap release between two HealthKit
milestones: a P0 hotfix for the `/api/analytics` 500 (stack
overflow from `Math.min(...)` / `Math.max(...)` spread on long
metric histories), a deep polish pass across nineteen audit
issues + six runtime bug-hunt followups, and the Apple App Site
Association handler that lets the iOS bundle's passkey ceremony
share state cleanly with the web origin.

## Outcome

- GitHub Release:
  <https://github.com/MBombeck/HealthLog/releases/tag/v1.4.33>.
- Tag `v1.4.33` →
  `7bef19903913afcbcafeb037140ca32d715b0412` on `main` (PR #178
  squash, merged at 2026-05-16T17:46:43Z).
- Sister-repos:
  - `healthlog-docs@1429cc0` — image-pin bump in
    `src/content/docs/self-hosting/updates.mdx` from `:1.4.32` to
    `:1.4.33`.
  - `healthlog-landing@33e6039` — already on the expected HEAD
    from the same-day AASA-rollout round; no drift, no commit
    needed.
- GHCR build conclusion: SUCCESS — both the tag-triggered run
  (`25968751274`) and the main-branch run (`25968744765`) shipped
  multi-arch (linux/amd64 + linux/arm64) with the manifest-merge
  step green; image digest
  `sha256:7cb23b0a400e2adaec61401c9f9556a9045ecd393f97d83cf7261739c71fcf8c`.
- Coolify auto-deploy: **fallback used on both hosts.** The
  registry-digest auto-deploy toggle is still off (confirmed by
  apps-01's compose pinning `:latest` and serving a `:latest`
  digest that pointed at v1.4.30.1 — two releases stale) so the
  same host-side retag pattern from v1.4.31 / v1.4.32 was
  required. Recipe below in the iceberg notes.

## Commits on develop since v1.4.32 closure

60 commits between `f9346e62` (v1.4.32 closure) and the v1.4.33
release tag. Grouped by track:

### P0 hotfix track

- `61107e0c` fix(api): stop `/api/analytics` 500 from
  `Math.min`/`Math.max` spread overflow
- `2d630994` + `b5060f14` refactor(insights): fold
  `Math.min`/`Math.max` spreads in the six status helpers

### iOS handoff track (AASA on app domains)

- `2acb11f8` feat(auth): admit `/.well-known/*` without a
  session
- `03b0be18` feat(ios): serve apple-app-site-association on the
  app domains
- `b92f2b1e` docs(changelog): note the AASA addition

### Insights surface track

- `02410b23` fix(insights): BP chart Y-axis unit reads "mmHg"
  not "Hg"
- `743579ca` fix(insights): `/insights/puls` subtitle reads
  "Puls" not "Ruhepuls"
- `13b2c13c` fix(charts): drop duplicate y-axis ticks on narrow
  weight domains
- `b07143b0` fix(charts): defensive fallback when compliance
  classifier flushes every dose to `very_late`
- `7b78a4bf` fix(insights): gate `/api/insights/generate` POST
  on assistant feature flag
- `85d74dd9` feat(insights): regroup tab-strip pills by metric
  category
- `4f63bd5f` + `af17db5d` perf(coach): 60 s LRU on
  `buildCoachSnapshot` keyed on `(userId, scope)`
- `bfb1b43a` fix(insights): promote coach-rail labels to
  semantic `<h3>` headings
- `a5a91e40` fix(insights): auto-hide mobile Coach FAB while a
  chart tooltip is open
- `d254e9cd` perf(insights): defer below-fold mother-page
  blocks behind `next/dynamic` + bundle config hygiene
- `67d05c0d` perf(analytics): slim `/api/analytics?slice=summaries`
  slice (C1)
- `fe942991` fix(insights): consolidate route scroll-reset into
  a single hook
- `e3590e77` test(insights): align b3-wiring import guard with
  `next/dynamic` wrapping

### Settings consolidation track

- `981a3d55` feat(settings): extract `<SettingsCardHeader>`
  primitive
- `ff06b0ce` fix(settings): collapse Notifications redundancy
  onto one status surface
- `d4a1679e` i18n(settings): parity for the trimmed
  Notifications description
- `523ee0c7` fix(notifications): disambiguate inbox vs
  channel-config naming
- `0de1e2eb` fix(settings): fold the About section into the
  user-card dropdown
- `73043d42` fix(settings): tile-padding parity, passkey
  breakpoint, scroll-into-view, F17 threshold toggle
- `81225a76` fix(settings): scroll-snap on the mobile section
  strip
- `c98d07ef` fix(settings): F13 username readability, F14
  mobile bottom-nav padding, Mood Log overflow

### Accessibility track

- `b763424b` fix(a11y): give every Progress bar an accessible
  name
- `0cac3d35` fix(a11y): give icon-only buttons accessible names
  on the medications page
- `2620064e` fix(a11y): repair non-sequential heading order on
  three surfaces

### Layout / nav polish

- `87e4cdcb` fix(layout): normalise auth-shell container width
  on `max-w-screen-xl`
- `3a5f7deb` fix(ui): normalise Card defaults to `p-4 md:p-6`
- `e65cdc97` fix(ui): reserve Button loader space to eliminate
  CLS during in-flight requests
- `972c8a56` fix(nav): drop the redundant "Home" group label
  from the desktop sidebar
- `585637d5` fix(layout): harden bottom-nav so it cannot
  overlap the last viewport line

### Onboarding

- `f9b8f3bd` fix(onboarding): stop spotlight tour from
  intercepting dashboard clicks
- `ab1700a8` fix(onboarding): really stop spotlight tour from
  blocking the quick-add button

### Monitoring

- `9c738b60` fix(monitoring): sample web-vitals at 10% so the
  beacon stops self-throttling
- `1a101505` fix(monitoring): defer web-vitals sample draw to
  `useEffect` to satisfy `react-hooks/purity`

### Dashboard

- `8131fcb3` fix(dashboard): tile sentiment, mobile grid,
  BD-Ziel gate, summary metadata

### Cleanup / i18n

- `99af5304` chore(cleanup): retire `AssistantDisabledNotice` +
  dead `settings.placeholder` copy
- `432ebccd` fix(i18n): drop the "KI"/"AI" prefix from
  user-facing copy
- `bafac84f` chore(i18n): retire the now-orphan
  `settings.kiInsights` key
- `2438dce6` docs(layout): pin the legal-page narrow-column
  convention in code comments

### Planning artefacts

- `6135c325` v1.4.33 quality-and-reliability audit pass
- `86aa27e6` / `bececda6` / `b543988c` / `f3894081` /
  `2c0d0d29` / `adedf05f` / `da022991` / `a8a58877` / `ac78b422`
  IW1–IW9 implementation reports
- `6ccb7b3c` release-prep closure report

### Release commits

- `0f3ae822` docs(changelog): v1.4.33 polish and reliability
- `b8f6b13a` chore(release): v1.4.33
- `de6bc673` Merge main into develop (post-v1.4.32 reconcile)

## Verification

All checks performed at 2026-05-16T17:59 UTC.

### apps-01 (`healthlog.bombeck.io`)

```
$ curl -s https://healthlog.bombeck.io/api/version
{"data":{"version":"1.4.33","buildSha":null,"builtAt":null,"license":"AGPL-3.0",
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
{"data":{"version":"1.4.33","buildSha":null,"builtAt":null,"license":"AGPL-3.0",
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
$ curl -s https://healthlog.dev/.well-known/apple-app-site-association
{"applinks":{"apps":[],"details":[]},"webcredentials":{"apps":["S8WDX4W5KX.dev.healthlog.app"]}}
```

### Apple CDN re-probe

- `app-site-association.cdn-apple.com/a/v1/healthlog.dev` → 200,
  matches origin byte-for-byte.
- `app-site-association.cdn-apple.com/a/v1/demo.healthlog.dev`
  → 200, matches origin byte-for-byte.
- `app-site-association.cdn-apple.com/a/v1/healthlog.bombeck.io`
  → 404 (CDN has not ingested yet; expected for first-time
  origin response on a fresh host).

### CI on PR #178

- 6/7 green: Build linux/amd64 + linux/arm64, integration,
  security & quality, dependency audit, secret scanning.
- e2e: 3 pre-existing v1.4.32 flakes (onboarding-flicker × 2,
  mobile-viewport × 1) — accepted ship-with-flakes per the
  maintainer's briefing.

## Iceberg notes for the next round

- **Coolify registry-digest auto-deploy is still off.** Tag push
  + GHCR build succeeded, but apps-01 was serving v1.4.30.1
  through the `:latest` cache (two releases stale) and edge-01
  was on v1.4.32 even after the build landed. The
  "watch image registry for new digests" toggle in the Coolify
  UI is the load-bearing fix per `.planning/coolify-auto-deploy-howto.md`;
  the GHA-side webhook with `?force=true` is in place but cannot
  bypass the local image cache without that toggle. Until then,
  the host-side retag fallback is the working path:

  ```
  # apps-01 (compose pins :latest)
  ssh apps-01
  docker pull ghcr.io/mbombeck/healthlog:1.4.33
  docker tag ghcr.io/mbombeck/healthlog:1.4.33 \
    ghcr.io/mbombeck/healthlog:latest
  cd /data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss
  docker compose up -d --force-recreate app
  ```

  ```
  # edge-01 (compose pins explicit tag)
  ssh edge-01
  sed -i 's|healthlog:1.4.32|healthlog:1.4.33|g' \
    /data/coolify/applications/ck8cs4osswg8w440gskw08w8/docker-compose.yaml
  docker pull ghcr.io/mbombeck/healthlog:1.4.33
  cd /data/coolify/applications/ck8cs4osswg8w440gskw08w8
  docker compose up -d --force-recreate
  ```

  Pre-deploy compose backups created at
  `docker-compose.yaml.pre-v1433.bak` on both hosts.
- **GHCR build fires twice on a release.** The tag push and the
  squash-merge to main both land within a second of each other,
  each kicking off its own
  `Build & Publish Docker Image` run. Both finished green at
  ~17:51 UTC, but it's worth noting that the workflow design
  doubles the GHCR push for every release. Not blocking, just
  wasted CI minutes — a `paths-ignore` or workflow-concurrency
  gate could halve it.
- **`edge-01` Coolify MCP unreachable.** The MCP integration
  for edge-01 (`46.225.114.153:8000`) returned a connection
  error during the deploy pipeline; SSH itself worked fine, so
  the fallback path covered it. Worth checking the MCP server
  health on edge-01 before the next release so the deploy step
  can use the same MCP path on both hosts.

## Drain-script status

Operator-action pending. `/api/admin/drain-per-sample-cumulative`
was not invoked from this round — it is cookie-auth gated and
the maintainer's direction was to skip if the admin cookie was
not available programmatically. The drain remains on the
v1.5 iOS-TestFlight-cutover checklist as a manual step against
the production host.

## Backlog seeded for v1.4.34

### From the AASA-rollout report (today)

- **Universal Links.** Populate `applinks.details` with bundle ID
  + `paths` array once the iOS side opts in to deep-linking.
  Candidate routes: `/insights/*`, `/measurements/*`, `/auth/login`.
  Needs coordination with the iOS app's `associatedDomains`
  entitlement.
- **`/.well-known/security.txt`** (RFC 9116) and
  **`/.well-known/change-password`** (W3C) — the new
  trailing-slash allowlist admits both without further proxy
  edits; low priority but easy wins.
- **Bundle-ID rotation cache invalidation.** Apple's AASA CDN
  caches for an hour; document the implication in the iOS
  handoff so the team plans bundle-rename windows around it.
- **Host-aware AASA branch.** If `demo.healthlog.dev` ever
  splits to a separate App ID prefix (sandbox passkeys), the
  AASA handler will need a host-aware response.

### From the v1.4.33 research outputs

- **R1 — Apple Health XML import.** Research dropped at
  `.planning/research/v1434-r-1-xml-import.md`; matches the
  v1.4.34 freeze-marker reshuffle decided in v1.4.30.1.
- **R2 — Carryover scope.** Research dropped at
  `.planning/research/v1434-r-2-carryover-scope.md`;
  consolidates the leftover sub-waves the v1.4.33 polish round
  could not absorb into a single v1.4.34 backlog.

### Infrastructure carryovers

- **Pin both Coolify hosts to the explicit tag convention** so
  the auto-deploy fallback path collapses to a single sed +
  `up -d`. apps-01 stays on `:latest` today, which is what
  trips the cache-staleness above.
- **Coolify registry-digest toggle.** Maintainer-action only:
  flip the "watch image registry for new digests" toggle in the
  Coolify UI for both apps-01 and edge-01. Once flipped, the
  GHA webhook + GHCR push pipeline should produce green
  auto-deploys with no SSH fallback needed.
- **Edge-01 Coolify MCP recovery.** Restart the MCP server on
  edge-01 so future release rounds can list deployments + force
  redeploys via the MCP path instead of falling through to SSH.

## Blocked items

None. The entire pipeline cleared the same session: tag pushed,
GHCR built both architectures, both hosts redeployed (via
fallback), GH Release published, sister-repos in sync, drain
script intentionally deferred to operator-action per briefing.
