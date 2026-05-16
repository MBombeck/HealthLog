# v1.4.34 IW-A report — infrastructure carryovers

Scope: items #2 (NFT-trace exclude), #3 (bundle-report script), #6
(Cache-Control HTML rule), #11 (Coolify env duplicate audit), plus
the GHCR double-build fix called out in the v1.4.33 closure-report
iceberg notes. Five touch-disjoint atomic commits on `develop`.

## Commits

| SHA | Subject | Touch surface |
| --- | --- | --- |
| `8e05f922` | feat(http): centralise authed Cache-Control with bfcache-friendly preset | `src/lib/http/cache-headers.ts`, `src/lib/http/__tests__/cache-headers.test.ts`, `scripts/print-bundle-report.mjs` |
| `42432832` | chore(build): silence NFT-trace warnings and ship the bfcache header | `next.config.ts` |
| `24b8d52f` | ci(docker): fire the release build once per tag | `.github/workflows/docker-publish.yml` |
| `5daa78da` | docs(planning): document apps-01 env-var duplicate sections | `.planning/round-v1434-iwa-coolify-env-audit.md` |
| `(this report)` | docs(planning): v1.4.34 IW-A close-out report | `.planning/round-v1434-iwa-report.md` |

## What landed

### Item #2 — NFT-trace warnings

`next.config.ts` gained `outputFileTracingExcludes: { "*":
["./next.config.ts"] }` sibling to the existing
`outputFileTracingIncludes`. The Turbopack tracer follows the
`MAXMIND_LICENSE_KEY` env access in `src/lib/geo.ts` back into the
config file and emits "cannot be traced" warnings for the paths it
walks afterwards (mood-entries/bulk route, etc.). The exclude only
narrows trace reporting — the standalone bundle remains controlled
by `output: "standalone"`. No runtime effect.

### Item #3 — bundle-report script

`scripts/print-bundle-report.mjs` reads `.next/analyze/client.json`
(written by `@next/bundle-analyzer` when `pnpm analyze` runs with
`ANALYZE=1`) and prints a sorted table of the top client chunks by
parsed size, plus totals. `package.json` already wires the
`bundle-report` npm script (added by IW-XML in `2a3fb0e9` before
this round picked up the file). `@next/bundle-analyzer` is already
listed under `devDependencies` and the lockfile was already in sync
— no install or lockfile changes were needed.

The script exits non-zero with a clear message when the JSON file
is absent so contributors learn to run `pnpm analyze` first.

### Item #6 — Cache-Control HTML rule

Two-part fix:

1. `next.config.ts` `headers()` now ships a second rule:
   ```
   { source: "/((?!api|_next).*)", headers: [
     { key: "Cache-Control", value: "private, max-age=0, must-revalidate" },
   ]}
   ```
   This stamps the bfcache-friendly directive onto every authenticated
   HTML page response. The framework default for pages that read
   cookies is `no-store, must-revalidate` (a hard Chromium bfcache
   breaker); `private, max-age=0, must-revalidate` keeps shared caches
   out, forces revalidation on every navigation, and stays
   bfcache-eligible. `/api/*` and `/_next/*` are excluded so API
   routes keep their explicit directives and static assets keep
   immutable caching.

2. `src/lib/http/cache-headers.ts` (new) exports
   `NO_STORE_BUT_BFCACHE = "private, max-age=0, must-revalidate"`,
   `SHORT_LIVED_PUBLIC = "public, max-age=3600"`, and an
   `applyAuthedHeaders(res)` helper. The presets exist as typed
   re-usable constants for any future API route that wants the same
   bfcache-friendly posture on a non-HTML response. Unit-tested at
   `src/lib/http/__tests__/cache-headers.test.ts` (5 cases, all
   green).

**No existing route file received the header swap.** The audit of
`grep "no-store" src/app/api` returned 13 hits — 11 are file-stream
responses (PDF, ZIP, JSON exports, backup downloads) where
`no-store` is the intentional posture (personal-health byte streams
must never cache), 1 is the SSE stream on `/api/insights/chat`
(intentional `no-cache, no-transform`), and the last is
`api/health/route.ts` which is a container-liveness probe and not
"authed" in the bfcache sense. The actual fix is the framework-level
`headers()` rule above; the `cache-headers.ts` module is the typed
foundation for future opt-in usage.

### Item #11 — Coolify env duplicate audit

`mcp__coolify-apps01__env_vars list` against application UUID
`pg8wggwogo8c4gc4ks0kk4ss` returned 56 entries. The
section-1/section-2 split documented under `CHANGELOG.md` v1.3.1 is
still present; 28 keys have duplicate entries. Highest-priority
delete candidate is UUID `d3r4k1lryj6n0z7dfj4hhc8t` (placeholder
`POSTGRES_PASSWORD` value `"POSTGRES_PASSWORD is required"`); the
other duplicates carry value-identical content so they're inert at
runtime but clutter the operator UI.

`mcp__coolify-edge01__list_applications` returned a connection
error (matches the closure-report iceberg note); edge-01 audit must
run over SSH until the MCP daemon is restarted.

**No env-var deletes were performed** — the brief restricts IW-A to
read-only inspection. Operator follow-ups seeded in
`.planning/round-v1434-iwa-coolify-env-audit.md`.

### GHCR double-build fix

`.github/workflows/docker-publish.yml` no longer ships
`push.branches: [main]`. The closure-report iceberg note recorded
that the squash-merge to `main` and the corresponding `v*` tag push
landed within a second of each other on every release, each
producing its own build against the same SHA with overlapping tag
sets — the main run added `latest`, the tag run added the semver
tags. Dropping the main-branch trigger collapses the pipeline to a
single run per release tag. The `latest` raw-tag enable condition
also moves from `is_default_branch` (false on tag refs) to
`startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name,
'-')` so each stable release tag refreshes the `latest` alias in
the same run. Pre-release tags (`-rc.1`, `-beta.2`) stay off
`latest`. PR + workflow_dispatch triggers are preserved.

## Verification

- `pnpm typecheck` — pre-existing errors on `insights-tab-strip.tsx`
  from an in-flight worker (sub-wave D scope, not IW-A). No errors
  on my touch surface: `pnpm typecheck 2>&1 | grep -E
  "cache-headers|next\.config|print-bundle|http/"` is empty.
- `pnpm lint next.config.ts src/lib/http/cache-headers.ts
  src/lib/http/__tests__/cache-headers.test.ts` — clean.
- `pnpm test src/lib/http/__tests__/cache-headers.test.ts` — 5
  passed.
- `node --check scripts/print-bundle-report.mjs` — OK; the script's
  no-input path exits 1 with a clear error and the message points
  at `pnpm analyze`.
- Coolify MCP listing captured during the audit and pasted directly
  into `.planning/round-v1434-iwa-coolify-env-audit.md`.

## Out-of-scope notes (do not touch)

Per the brief, IW-A did not touch:
- `src/app/api/analytics/route.ts` (IW-B)
- `src/middleware.ts` matcher
- `src/lib/analytics/compliance.ts` (IW-C)
- `src/app/page.tsx` (IW-B)
- `src/app/settings/**` (IW-D)
- `src/app/api/import/**` + `prisma/schema.prisma` (IW-XML)

`git status` during IW-A showed many of these as modified or
staged by concurrent worktrees sharing the working directory; each
of those files was confirmed unstaged before every `git commit`
and never appears in the IW-A commit footprints above.

## Operator follow-ups seeded

1. Delete env-var UUID `d3r4k1lryj6n0z7dfj4hhc8t` on apps-01 (the
   leftover `POSTGRES_PASSWORD` placeholder).
2. Restart the Coolify MCP daemon on edge-01 so the next round can
   reach env vars without falling back to SSH.
3. Optional: bulk-prune the remaining section-2 duplicates listed
   in the audit doc.
4. Confirm intent for `CODEX_OAUTH_CLIENT_ID` (section-2-only entry
   on apps-01).
5. Verify the next release tag-push produces exactly one GHCR build
   run, carries both the `:latest` alias and the semver tags, and
   pushes a multi-arch image identical to today's.

## Brief-back (≤200 words)

IW-A landed four atomic commits on develop addressing the four
carryover infrastructure items from research blueprint v1434-r-2
plus the GHCR double-build called out in the v1.4.33 closure report.
`next.config.ts` gained the `outputFileTracingExcludes` block for
the Turbopack NFT-trace warnings and a second `headers()` rule that
stamps `private, max-age=0, must-revalidate` on every authed HTML
page (excluding `/api/*` and `/_next/*`) to restore bfcache
eligibility. `src/lib/http/cache-headers.ts` (new, 5 unit tests
green) exports the typed `NO_STORE_BUT_BFCACHE` /
`SHORT_LIVED_PUBLIC` presets plus `applyAuthedHeaders()` for future
opt-in usage; existing route files keep their explicit `no-store`
because they're file streams or the liveness probe.
`scripts/print-bundle-report.mjs` restores the at-a-glance "top
chunks by parsed size" signal Turbopack dropped from `next build`.
The Docker workflow now fires once per release tag instead of
twice (drops `push.branches: [main]`, moves the `latest` enable
rule onto the tag ref). Coolify env audit on apps-01 captured the
section-2 duplicates; edge-01 MCP unreachable. No env deletes
performed — operator action only. Five operator follow-ups seeded.
