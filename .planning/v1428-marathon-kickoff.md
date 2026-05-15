---
file: .planning/v1428-marathon-kickoff.md
purpose: Single prompt to paste into a fresh session that kicks off the v1.4.28 autonomous release pass
created: 2026-05-15
target_tag: v1.4.28
---

# v1.4.28 — autonomous release kickoff per maintainer directive 2026-05-15

You are running v1.4.28 in /Users/marc/Projects/HealthLog on branch `develop` (origin `743a2e46`). v1.4.27 shipped successfully at 21:08 UTC tonight — `healthlog.bombeck.io` and `demo.healthlog.dev` both report `version: "1.4.27"` with `offlineGeoEnabled: true`. The maintainer walked through the live build and produced detailed feedback for the next release. Your job is to absorb every item, plan it holistically, and ship v1.4.28 fully autonomously.

## Read these FIRST, in this order

1. **`.planning/v1428-feedback-2026-05-15.md`** — 26 maintainer items grouped into 14 themes. EVERY item applies. This is the source of truth for the release scope.
2. **`.planning/v1428-backlog.md`** — deferrals from v1.4.27 R4 reviewers (mobile CF-77-90, simplifier F-H1, design Mediums, dead-code orphans, etc.). Roll relevant items in where they intersect the feedback.
3. **`.planning/v15-ios-handoff/`** — every doc in the 22-file pack. Especially `22-standalone-and-server-pairing.md`. The iOS native client consumes locked contracts; do NOT break them.
4. **`.planning/v1427-handoff-session-2.md`** + **`.planning/v1427-fix-plan.md`** + **`.planning/v1427-mobile-fix-plan.md`** — calibrate against how v1.4.27 was structured.
5. **`CHANGELOG.md`** — match the v1.4.27 voice + cadence exactly.

## Convention overrides (strict — applies to ALL artifacts)

Forbidden vocabulary in commits, code, comments, planning docs, CHANGELOG, release notes, in-app copy: **AI, Claude, agent, marathon, wave, phase, session, subagent, Anthropic**. Use neutral alternatives: round, pass, contributor, slot, automation, release work, assistant, coach. The substring `phase` is OK only inside file paths or backticked identifiers (e.g. `phase-config-dialog.tsx`).

NO PII (maintainer name, health figures, target ranges, measurement counts) in any user-facing artifact.

Marc-Voice English. Terse, professional. No emojis. No marketing fluff. Reads as the maintainer's authorship.

Branch model: commit to `develop`. Never `main` directly. Release via PR `develop → main`, tag on main, GHCR multi-arch from main only.

NO `Co-Authored-By: Claude` trailer. NO `--no-verify`. NO `--no-gpg-sign`.

Per-commit gate clean before every commit: `pnpm typecheck` + `pnpm lint` + relevant `pnpm test`. Hook failure → fix the root cause + new commit, never `--amend`.

Atomic commits per logical sub-task. No "WIP", "various improvements", "end-of-day commit".

## Scope discipline

v1.4.28 is **less scope, more depth** than v1.4.27. v1.4.27 delivered an architectural mobile sweep (ResponsiveSheet, NativeSelect, CoachLaunchProvider). v1.4.28 collects the broken-edges-revealed-by-the-shift plus the maintainer's consistency directives. Don't pile on new architectural changes.

Bug-fix is the lead theme. The eight Critical items from the feedback doc block release.

Scope-reduction directives are non-negotiable: six "remove from code entirely" instructions land as clean delete-commits, no half-measures.

**iOS native client safety is the underlying premise.** Every change must be safe for the native client. When unsure, defer to v1.4.29 instead of breaking the contract.

No premature optimisation. Measure before acting on performance.

## Round structure

### R1 — Research + audit (parallel, 5+ contributors)

The maintainer asked for ganzheitlich. Land these in parallel:

- **R1.1 — Competitive benchmarking** — one contributor researches how Apple Health, Withings, Oura, Garmin Connect, and one or two newer health apps handle the surfaces v1.4.28 touches. Specifically: HealthScore card height + delta tooltip, trend equal-height contract, medications detail page chrome (one med = one row shape), advisor-surface retirement (do they have a "tile" that explains, or just chat?), opt-in dashboard widget patterns. Output: `.planning/research/v1428-r1-competitive.md`.

- **R1.2 — Performance baseline + audit** — one contributor establishes baselines (Lighthouse mobile + desktop, React DevTools profiler on `/`, `/insights`, `/medications`, `/insights/puls`, route-segment TTFB via `curl -w`) on the live build. Identifies hotspots. Likely suspects: `useIsMobile` running on every interactive surface (might want migration to CSS-only branches), visual-viewport listener thrashing, GeoIP backfill on the hot path, dynamic chart imports under-suspending, dispatch-localised's `prisma.user.findUnique` on every audit-log write. Output: `.planning/research/v1428-r1-performance.md`.

- **R1.3 — Bug-reproduction audit** — one contributor (or two if surfaces split cleanly) reproduces every Critical bug:
  - FB-B1: workout edit + save → error (Sport surface, likely measurement-form or workout-form save handler)
  - FB-C1: BD-Zielbereich tile renders "1.1." instead of numbers (likely a malformed Intl.NumberFormat call or a `summary.value` that's actually a Date)
  - FB-D2: `/insights/puls` chart hangs (likely a React-Query stuck state, an infinite re-render, or a network call that never resolves)
  - FB-D3: scroll stuck on `/insights` (likely the sticky tab strip's intersection-observer fighting the scroll-snap or focus-on-mount logic from MB7-CF-35)
  Each gets a root-cause diagnosis with the failing code lines + the recommended fix shape. Output: `.planning/research/v1428-r1-bug-reproduction.md`.

- **R1.4 — iOS contract audit** — one contributor enumerates every endpoint + DTO + Prisma schema field the iOS client (in the `healthlog-iOS` repo at `/Users/marc/Projects/healthlog-iOS/`) consumes. Cross-references against the v1.4.28 scope-reduction directives (Theme A, E, J). Flags anything that risks breaking the iOS client. Output: `.planning/research/v1428-r1-ios-contracts.md` with a "do-not-touch" list.

- **R1.5 — UI consistency inventory** — one contributor walks every medication-list row, every section-header chrome on the medications detail page, every trend tile, every advisor/coach launch surface. Documents the variants. Builds the data needed for Theme M. Output: `.planning/research/v1428-r1-ui-inventory.md`.

### R2 — Consolidated fix plan (single contributor, after R1 closes)

Reads all five R1 outputs. Writes `.planning/v1428-fix-plan.md` with:
- Consolidated find-list (de-duplicated across feedback + backlog + R1 outputs)
- Fix-surface buckets (touch-disjoint by file, severity-tiered)
- File-touch collision matrix (zero same-line collisions)
- Dispatch sequence (parallel groups, sequenced groups)
- Decisions on open questions:
  - **FB-N weekly-report**: retire entirely or keep a hidden route? Default-decide RETIRE unless R1 surfaces an active consumer.
  - **FB-E3 GLP-1 widget**: opt-in via the existing dashboard layout settings, or a new "medication-specific widgets" settings group?
  - **Performance**: measure-first or measure-and-fix in one pass?
- Items deferred to v1.4.29 with reason

### R3 — Parallel fix-pass

Per the R2 dispatch sequence. Typical shape: 5-7 parallel contributors, touch-disjoint by file, atomic commits per logical sub-task. Bug-fix sub-bucket (R3a) runs first; consistency + polish + scope-reduction (R3b) after.

Mandatory: each contributor writes a short report at `.planning/round-3-<bucket>-report.md`.

### R4 — Multi-contributor QA pass

Dispatch 10 parallel reviewers (the v1.4.27 nine plus a new iOS-contract reviewer):

| Reviewer | Focus |
|---|---|
| code-review | full diff since v1.4.27 |
| security | endpoints, auth gates, secrets, injection |
| design | 7-axis rubric (visual hierarchy, contrast, spacing, typography, responsive, a11y, motion) |
| senior-dev | architecture, migrations, primitives, edge cases |
| code-simplifier | dead code + duplications |
| product-lead | strategic alignment, headline accuracy, PII, Marc-Voice |
| i18n runtime | locale × route raw-key fallbacks |
| dead-code-scan | orphan endpoints, unused exports, dead i18n keys |
| UI-conformity (carried from v1.4.27) | same-class surface alignment |
| **iOS-contract reviewer (NEW)** | every /api/* response shape vs the locked iOS DTOs; every Prisma column the iOS client reads; every deleted endpoint or column that the iOS client expects |

Each writes to `.planning/research/v1428-r4-<topic>.md`. Reconcile pass applies every Medium+/High/Critical finding before tag.

### R5 — Release v1.4.28

Standard pipeline:
1. CHANGELOG editorial (Marc-Voice, no forbidden words, no PII)
2. Version bump 1.4.27 → 1.4.28 in `package.json` (+ any sentinels)
3. Commit + push develop
4. Open PR `develop → main` (Ready, not Draft)
5. Wait for CI all green
6. Squash merge: `gh pr merge <id> --squash --subject "chore(release): v1.4.28" --body "<CHANGELOG excerpt>"`
7. Tag: `git tag -a v1.4.28 <squash-sha> -m "Release v1.4.28"` then `git push origin v1.4.28`
8. Wait for GHCR multi-arch builds (5-7 min, MAXMIND_LICENSE_KEY is already set as a repo secret + the GeoLite2 EULA has propagated)
9. Deploy apps01:
   - `mcp__coolify-apps01__deploy` with uuid `pg8wggwogo8c4gc4ks0kk4ss` force=true
   - Then `ssh apps-01 'docker pull ghcr.io/mbombeck/healthlog:latest && cd /data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss && docker compose --project-name pg8wggwogo8c4gc4ks0kk4ss up -d --force-recreate'`
10. Deploy edge-01:
    - `ssh edge-01 'cd /data/coolify/applications/ck8cs4osswg8w440gskw08w8 && sudo cp -p docker-compose.yaml docker-compose.yaml.pre-v1428.bak && sudo sed -i "s|ghcr.io/mbombeck/healthlog:1.4.27|ghcr.io/mbombeck/healthlog:1.4.28|g" docker-compose.yaml && sudo docker pull ghcr.io/mbombeck/healthlog:1.4.28 && sudo docker compose --project-name ck8cs4osswg8w440gskw08w8 up -d --force-recreate'`
11. Verify both `/api/version` report 1.4.28; `/privacy` returns 200 on both
12. GitHub Release: extract CHANGELOG section, `gh release create v1.4.28 --title "v1.4.28 — <topic>" --notes-file /tmp/v1428-release-notes.md --latest`
13. Sister-repo bumps:
    - `/Users/marc/Projects/healthlog-docs` — image pins 1.4.27 → 1.4.28
    - `/Users/marc/Projects/healthlog-landing` — softwareVersion mention 1.4.27 → 1.4.28
14. Closure report at `.planning/round-5-release-closure-report.md`

## Skills to use

- **release-marathon** — orchestrator working pattern (load this immediately)
- **brainstorming** — before any architecturally-new feature (FB-E3 opt-in GLP-1 widget, FB-I1 delta tooltip shape, FB-H card-height contract)
- **frontend-design** — for visual rewrites (HealthScore card height, trend equal-height contract, medications detail page chrome, GLP-1 medication list row alignment)
- **mobile-first-design** — for every responsive surface touched
- **design-review** — for the R4 design reviewer slot
- **playwright-skill** — for live-environment bug reproduction (workout save, pulse chart hang, scroll stuck)
- **test-driven-development** — for the bug-fix sub-bucket (write failing test first, then fix)
- **systematic-debugging** — for the performance audit + bug reproduction
- **writing-plans** — for the R2 consolidated fix plan
- **executing-plans** — for R3
- **dispatching-parallel-agents** — for parallel R1 / R3 / R4
- **verification-before-completion** — every "done" claim gets a real check
- **using-git-worktrees** — if isolation needed for risky surfaces (e.g. BD-Zielbereich tile rewrite)
- **context7** — for current framework/library lookups (React 19, Next 15, Tailwind v4, shadcn upstream, Recharts)
- **tailwind-v4-shadcn** — for current Tailwind v4 patterns where relevant

## iOS native client safety net (the underlying premise)

The maintainer explicitly said: "Wir haben eine iOS-App. Die sollten wir nicht bricken."

Mandatory rules:
- Read every file in `.planning/v15-ios-handoff/` before touching any `/api/*` route or any Prisma model field.
- Additive changes only on the iOS-facing API surface: new columns + new endpoints OK; rename, drop, type-change NOT OK without a maintainer-signed-off migration path.
- The R1.4 iOS-contract audit produces a "do-not-touch" list. R3 contributors check every `/api/*` edit against the list before pushing.
- The R4 iOS-contract reviewer catches anything that slipped through.
- The healthlog-iOS repo lives at `/Users/marc/Projects/healthlog-iOS/`. If the audit needs to read the iOS Swift code to understand what fields it reads, do so.

## Done when

- Every Critical bug from `.planning/v1428-feedback-2026-05-15.md` is fixed (the 8 items).
- Every "remove from code entirely" directive landed (FB-A1, FB-A2, FB-E1, FB-E2, FB-J1, FB-J2).
- Every consistency directive landed (FB-C2, FB-F3, FB-F4, FB-G1, FB-H, FB-K, FB-L1).
- Performance baselines + improvements documented in the CHANGELOG.
- iOS contracts intact (R1.4 + R4 iOS reviewer both clean).
- `healthlog.bombeck.io/api/version` returns `"1.4.28"`.
- `demo.healthlog.dev/api/version` returns `"1.4.28"`.
- GitHub release `v1.4.28` at top of `/releases`.
- `/privacy` returns 200 on both servers (regression guard).
- Sister repos `healthlog-docs` + `healthlog-landing` bumped + pushed.
- `.planning/v1429-backlog.md` exists with any items deferred to next cycle (with reason per item).
- `.planning/round-5-release-closure-report.md` written.

## If you hit a blocker

Stop at a clean commit boundary. Write `.planning/v1428-blocker-<topic>.md` with the exact failure, what you tried, what's needed from the maintainer. No destructive shortcuts.

Go.
