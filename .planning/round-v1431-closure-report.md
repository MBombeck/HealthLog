---
file: .planning/round-v1431-closure-report.md
purpose: v1.4.31 release closure — operator toggles + insights tab-strip + Coolify auto-deploy fix
created: 2026-05-16
tag: v1.4.31
---

# v1.4.31 — release closure

Shipped 2026-05-16 mid-day. Three orthogonal patches in one
release: the operator-side assistant feature-flag matrix that
lets the maintainer carve which model-driven surfaces stay
visible, the root-cause fix for the /insights tab-strip blocking
on mobile, and the GHCR-propagation-race fix for the Coolify
auto-deploy path.

## Outcome

- GitHub Release:
  <https://github.com/MBombeck/HealthLog/releases/tag/v1.4.31>.
- Tag `v1.4.31` → `5ea813e20c1f0deb4763e5b1c8c5ecd9c4d9027b` on
  `main` (PR #176 squash).
- Sister-repos:
  - `healthlog-docs@092dd31`
  - `healthlog-landing@a1f2dde`
- GHCR build conclusion: SUCCESS — `1.4.31` + `1.4` + `1` +
  `latest` + the `sha-<short>` tags all pushed cleanly, the
  v1.4.30 enum extensions stayed consistent across the manifest
  list.

## Commits on develop since v1.4.30.1

| SHA | Subject |
|---|---|
| `b68206ec` | feat(settings): add 6 assistant-surface feature flags to AppSettings |
| `61c9a1e7` | feat(api): expose the assistant feature-flag matrix |
| `aeff47af` | feat(api): gate assistant endpoints on the feature-flag matrix |
| `03d0b64b` | feat(insights): gate assistant surfaces on operator feature flags |
| `3b56bac5` | feat(admin): assistant feature-flag toggle panel |
| `e778835c` | i18n: localise the operator-disabled assistant notices |
| `88bd9ddd` | fix(insights): unblock the tab strip during initial mobile load |
| `477e57f1` | ci(image): close the Coolify auto-deploy race against GHCR cache propagation |
| `8e432b31` | chore(ci): catch OpenAPI drift via a pre-commit hook |
| `8f0da1b4` | docs(handoff): lock the assistant feature-flag scope across server-routed and on-device surfaces |
| `00a6b676` | chore(release): v1.4.31 |
| `4876182a` | chore(merge): reconcile main into develop for v1.4.31 release |

Squashed on `main` at `5ea813e2`; tag `v1.4.31` points there.

## Full unit suite — green

- typecheck: pass
- lint: pass
- `pnpm test --run`: 377 files / 4083 passed / 1 skipped (the
  legacy skipped spec carries through from v1.4.30.x).
- `pnpm openapi:check`: in sync.

## Findings closed

- **Assistant-optional operator toggles.** Migration 0065 adds
  six boolean columns to `app_settings`. `getAssistantFlags()`
  in `src/lib/feature-flags/index.ts` resolves the master vs
  sub-flag rule (master kills every sub-flag) and exposes
  `AssistantDisabledError` + the `requireAssistantSurface()`
  guard. Server-side every assistant endpoint gates on the
  relevant flag and returns 403 +
  `meta.errorCode: "assistant.disabled.<surface>"`. Client-side
  the new `useFeatureFlags()` hook (fails open) gates the seven
  consumers. Admin panel at `/admin/assistant` with the
  dedicated `PUT /api/admin/settings/assistant-flags` endpoint.
- **Insights tab-strip blocking fix.** Three commits in one:
  the 8 s `AbortController` on the advisor fetch, the
  `React.memo` + `useMemo` pair on the strip + availability
  prop, and the `next/dynamic` lazy-load on `<CoachDrawer>`.
- **Coolify auto-deploy race fix.** 90 s sleep before the
  webhook trigger in `.github/workflows/docker-publish.yml`.
  Root cause + remediation note at
  `.planning/round-coolify-auto-deploy-fix-2026-05-16.md`.
- **OpenAPI pre-commit hook.** `.githooks/pre-commit` +
  `scripts/install-hooks.sh` + `AGENTS.md` workflow entry.
- **R5 contract lock.**
  `.planning/v15-ios-handoff/08-locked-contracts.md` gains §14
  carrying the flag matrix scope rule verbatim from
  `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R5.

## Coolify auto-deploy proof — INCONCLUSIVE / NOT PROVEN

The Coolify auto-deploy fix landed in the workflow, but the v1.4.31
release itself did NOT exercise the fix. Two issues compound:

1. **`COOLIFY_WEBHOOK` + `COOLIFY_TOKEN` secrets remain unset on
   the repo** — same blocker as v1.4.27 / v1.4.28 / v1.4.29 /
   v1.4.29.1 / v1.4.30 / v1.4.30.1. The workflow's `Trigger
   Coolify deploy` step warned and skipped (the
   `COOLIFY_AUTO_DEPLOY` variable is not set to `on`, so the warn-
   and-skip legacy path fires). The 90 s sleep code did not
   execute because the step short-circuits before reaching it.

2. **Manual Coolify deploy via the MCP** triggered twice
   (`qryjfzh91pqavvwnromn8nyl` and `m10pf35xy0w1xznz6nmtjnx5`)
   both reported `status: finished` within 18 s but
   `/api/version` on apps01 continued to report `1.4.30.1`.
   Coolify's deploy log reads "Pulling & building required
   images" then immediately "Removing old containers / Starting
   new application" — the 6 s window between the two suggests
   no actual `docker pull` fired against GHCR; Coolify's
   internal image-cache treated `:latest` as already-known
   (Hypothesis H5 from the root-cause note).

The fix landed in the workflow IS correct (the 90 s sleep
addresses the GHCR-CDN propagation race documented as H4), but
proving it on v1.4.31 requires the operator to:

- Set `COOLIFY_WEBHOOK` + `COOLIFY_TOKEN` repo secrets, AND
- Set `COOLIFY_AUTO_DEPLOY=on` repo variable.

The next tag-build will then exercise the full path. v1.4.31's
own deploy needs the host-side SSH fallback documented at
`.planning/coolify-auto-deploy-howto.md` (this run did not have
SSH access to apps-01 from the implementation environment).

## Deploy state — BLOCKED on operator action

- `healthlog.bombeck.io/api/version` → `1.4.30.1` (not yet
  v1.4.31). `/privacy` → 200.
- `demo.healthlog.dev/api/version` → `1.4.30.1`. `/privacy` →
  200.

The release artifacts are all in place: image is on GHCR,
`v1.4.31` tag is on `main`, GitHub Release is published, sister-
repos bumped. The only step left is the operator-side host pull:

```bash
# apps-01
ssh apps-01
docker pull ghcr.io/mbombeck/healthlog:latest
cd /path/to/coolify/healthlog/compose
docker compose up -d --force-recreate --no-deps app
exit

# edge-01 (pinned to explicit tag)
ssh edge-01
sed -i.pre-v1431.bak 's|healthlog:1.4.30.1|healthlog:1.4.31|g' \
  /path/to/edge01/healthlog/docker-compose.yml
docker compose pull
docker compose up -d --force-recreate --no-deps app
exit
```

After the host-side pull lands, both hosts will report
`1.4.31` via `/api/version` and `/privacy` will stay 200.

## iOS-contract notes — additive across every change

- `AppSettings` gains six new boolean columns. All default
  `true`; existing rows keep behaving identically.
- `GET /api/feature-flags` is net-new. Pre-v1.4.31 iOS never
  calls it and implicitly behaves as if every flag is true.
- `PUT /api/admin/settings/assistant-flags` is net-new admin-only.
- The 403 + `meta.errorCode: "assistant.disabled.<surface>"`
  envelope is additive. Older iOS sees a generic 403; v1.4.31+
  iOS reads the errorCode to render the empty-state copy.
- No Prisma column shape changed for existing iOS-visible
  surfaces (Measurement, MoodEntry, MedicationIntakeLog).

## What's NOT done

- Coolify auto-deploy proof of fix — blocked on operator-side
  secrets configuration. The fix itself is in the workflow.
- apps01 + edge-01 1.4.31 deploy — blocked on operator-side
  SSH fallback execution.

## v1.4.32 scope seed

Carried forward per
`.planning/v15-strategic-plan.md` §2:

- HealthKit Tier 1 web surfaces, wave A: workouts end-to-end on
  the web + chart cards for 5 of the 10 invisible-but-stored
  metrics (HRV, RestingHR, SpO2, BodyTemperature,
  ActiveEnergyBurned).

Plus from v1.4.31 fallout:

- Operator secrets paste reminder: `COOLIFY_WEBHOOK` /
  `COOLIFY_TOKEN` repo secrets + `COOLIFY_AUTO_DEPLOY=on` repo
  variable. Until these land, the auto-deploy fix cannot be
  proven on a tag-build.

## Closure complete

v1.4.31 ships as an additive operator-side patch plus the long-
overdue insights-blocking root-cause fix. The Coolify auto-deploy
fix lands in CI; demonstration awaits operator secrets. The web
side remains under freeze planning (v1.4.34 marker per the
strategic plan), with the iOS-coordinated patch series continuing
into v1.4.32-34.
