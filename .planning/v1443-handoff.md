# v1.4.43 Marathon Handoff — fresh session needed

**Orchestrator hit context limit (78%) before completing the marathon.** All 9 implementation waves dispatched in worktrees and pushed to origin. Fresh session picks up at cherry-pick + QA round + reconcile + release endgame. Estimated 2-3h fresh.

## Status of dispatched waves

| Wave | Agent | Scope | Status as of handoff |
|---|---|---|---|
| W1-ANALYTICS-PERF | `a5046322` | `p-limit(4)` cap on `computeAvg30LastYearMap` (9s → 2-3s) | 🟡 running in worktree |
| W2-CHART-GATE | `a3243fc2` | C1 — fix "Erfasse 3 Einträge" gate to count raw entries | 🟡 running |
| W3-SECURITY | `a77a15c3` | H-1 auth.login.failed PII + H-2 WithingsApiError slice | 🟡 running |
| W4-QoL-COPY | `a2db58cd` | 6 QoL Highs (load error, Anbieter, persistent pill, not-found, global-error, plural forms) | 🟡 running |
| W5-MOBILE-UI | `ac8ade2c` | Switch tap, comparison pills, mood kebab, Sheet close, reduced-motion helper | 🟡 running |
| W6-ZOD-ROLLOUT | `a3a642a8` | 41 routes `returnAllZodIssues` migration | 🟡 running |
| W7-WITHINGS (B3 only) | `a33c0578` (continuation) | B3 only — B4 + B7 deferred to v1.4.44 | 🟡 running |
| W8-OPS | `abf6af16` | B2 widgets audit RL + B5 check-env CI + B11 docker BuildKit cache fix | 🟡 running |
| W9-WORKOUTS-PRIORITY | `aeddfce5` | B6 — `dedupeWorkoutBatch` user-priority resolution | 🟡 running |

## What fresh session needs to do

1. **Wait for all 9 waves to complete** — they'll show up as `worktree-agent-*` branches on origin
2. **For each wave**: read commit message, inspect for Marc-voice violations / PII, cherry-pick onto develop, push, clean up worktree + remote branch
3. **Run full quality gate**: `pnpm typecheck` + `pnpm lint` + `pnpm knip` + `pnpm test --run`
4. **W10 QA round** — dispatch 6 parallel read-only reviewers:
   - code-reviewer (superpowers:code-reviewer)
   - security review (general-purpose)
   - design review (general-purpose)
   - senior-dev (general-purpose)
   - product-lead (general-purpose)
   - simplifier-residual (code-simplifier:code-simplifier)
5. **Reconcile** Critical / High / Med findings
6. **Bump version** 1.4.42 → 1.4.43
7. **Finalize CHANGELOG.md** `[1.4.43]` entry (use the same shape as `[1.4.42]`; sections: Added / Changed / Fixed / Performance / Operator notes; cite the 5 audit reports + 9 phase reports)
8. **Squash-merge develop → main** via PR + push
9. **Tag v1.4.43** on main and push tag
10. **GitHub release** — body from CHANGELOG `[1.4.43]`
11. **Coolify deploy** — `mcp__coolify-apps01__deploy` with `force: true` (auto-deploy webhook still flaky)
12. **VERIFY `/api/version → 1.4.43`** post-deploy — per `feedback_docker_build_cache_version_stale.md` the bundle can ship stale. If 1.4.42 returns after deploy, trigger `gh workflow run docker-publish.yml --ref v1.4.43` and redeploy.
13. **`git merge origin/main --no-edit`** on develop after squash to align merge-base (PR #193 had the same pattern); take ours on conflicts.

## Marc-Voice + PII cleanup pass

Before cherry-picking each wave, sanity-check the agent's commit messages:
- No `Co-Authored-By: Claude` trailer
- No "Marc" by name in commit body
- English only
- Conventional-commit prefix

If a commit has PII / trailer, amend after cherry-pick.

## v1.4.43 backlog already seeded (defer to v1.4.44)

- W7's B4 (parkIntegrationAtPersistent > 24h) + B7 (consecutiveFailures per-kind) — explicitly deferred
- B8 — Coolify auto-deploy webhook investigation (operator-side, not code)
- All Mediums + Lows from the four audits that the implementation waves did NOT pick up in their Medium-sweep

## Audit reports (input to QA reconcile)

- `.planning/round-v1443-AUDIT-mobile-ui-findings.md` — 1 Critical / 5 High / 6 Med / 6 Low
- `.planning/round-v1443-AUDIT-qol-findings.md` — 0 / 6 / 8 / 8
- `.planning/round-v1443-AUDIT-security-findings.md` — 0 / 2 / Med / Low
- `.planning/round-v1443-AUDIT-analytics-9s-findings.md` — URGENT root cause + recipe

## Phase reports (output from waves, in `.planning/`)

Each wave produces `.planning/phase-W<N>-*-v1443-report.md`. Read them as a pack to consolidate the v1.4.43 CHANGELOG narrative.

## Production state (unchanged from handoff)

- `/api/version → 1.4.42` LIVE on apps-01
- iOS v0.5.4 hitting prod
- AP-2 .p8 installed

## Estimated time

2-3 hours fresh session for cherry-pick (9 × ~3-5 min) + QA round (~15 min) + reconcile (~30 min) + release endgame (~30 min including the docker-cache-fix Verify Loop).
