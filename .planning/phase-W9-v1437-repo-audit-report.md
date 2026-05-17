# v1.4.37 — W9 GitHub repo audit

**Date:** 2026-05-17
**Auditor:** Repo-audit agent (parallel marathon wave)
**Scope:** `MBombeck/HealthLog`, `MBombeck/healthlog-docs`, `MBombeck/healthlog-landing` — metadata, hygiene, CI health, security posture. README content + docs/landing prose are owned by the parallel docs-refresh agent and were not touched here.
**Out of scope:** `MBombeck/healthlog-iOS` (PRIVATE — confirmed), branch-protection rule changes, code-scanning / Dependabot enablement (Marc's call), workflow YAML edits.

---

## Summary

| Repo | Light | Headline |
|------|-------|----------|
| HealthLog | YELLOW | Repo metadata excellent. Three CI workflows failed on the v1.4.36 tag (unit/integration/e2e — see Finding HL-1). Secret-scanning + push-protection disabled despite being public + free. Vulnerability-alerts disabled. |
| healthlog-docs | YELLOW | No description with keywords, no topics, no homepage URL, no LICENSE, no SECURITY.md, no CI (no Pages workflow visible — deployment story unclear from this repo alone). |
| healthlog-landing | YELLOW | No description with keywords, no topics, no homepage URL, no LICENSE, no SECURITY.md. Deploy workflow on `main` has been red 6× in a row before recovering on 2026-05-16 — current state green but the failure history is in the audit-trail. |

---

## Per-repo findings

### HealthLog (https://github.com/MBombeck/HealthLog)

**Metadata — STRONG**
- [X] Description (`"Self-hosted health tracker. Weight, blood pressure, glucose, mood, medications. Withings + Apple Health sync. AI Insights you own. AGPL."` — 159 chars, value-first, keyword-front).
- [X] Topics — 19 active, every high-intent target from v1.4.34.4 present: `apple-health-import`, `withings-alternative`, `glucose-tracker`, `mood-tracker`, `ai-insights`, `personal-dashboard` all confirmed. Plus the foundational set (`health-tracking`, `nextjs`, `prisma`, `pwa`, `self-hosted`, `agpl`, `apple-health`, `docker`, `medication-tracker`, `personal-health`, `privacy`, `quantified-self`, `withings`).
- [X] Homepage URL → `https://healthlog.dev` (matches landing).
- [X] License → AGPL-3.0 (matches `LICENSE` file in repo root).
- [X] Default branch → `main`.
- [X] Issues + Discussions enabled.
- [X] `SECURITY.md` present, current, points at `security@bombeck.io`, documents SLSA + SBOM supply chain.

**`.github/` templates — STRONG**
- [X] `ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, `translation.yml`, `config.yml` (blank_issues_enabled: false, three contact links to docs/security/discussions).
- [X] `PULL_REQUEST_TEMPLATE.md` is current and matches the develop→main flow.
- [X] `dependabot.yml` covers npm (weekly, grouped security-patches), github-actions (weekly), docker (weekly).
- [ ] No `FUNDING.yml`. Not necessarily a problem — Marc may have intentionally skipped sponsorship buttons — flagging for awareness.

**Workflows — MOSTLY HEALTHY, ONE FAILING SLATE**
- 8 active workflows: Auto-merge Dependabot, Build & Publish Docker Image, e2e, Integration tests, No TODO markers, Post-publish verify, Security & Quality, Dependabot Updates.
- Docker-publish: confirmed tag-driven (`push.tags: ["v*"]` + PR validation + workflow_dispatch), multi-arch via two native runners (`ubuntu-24.04` + `ubuntu-24.04-arm`) per the v1.4.16 C5 lesson, concurrency-gated. Build for v1.4.36 succeeded.
- **HL-1 FINDING (SEVERITY: HIGH) — three workflows red on the v1.4.36 tag push (run on `main`):**
  - `Security & Quality` → 1 unit test timed out in 5000 ms: `src/lib/insights/__tests__/features.test.ts` → `extractFeatures — v1.4.36 W3 bucketed payload > throws FeaturesPayloadTooLargeError when the serialised payload exceeds the 5 MB cap` (4353/4355 tests passed, 1 timeout, 1 skip). Looks like the new payload-too-large test from v1.4.36 fabricates ~5.6 MB of data and runs past the default 5 s timeout on CI hardware.
  - `Integration tests` → 4 failures: `tests/integration/integration-status.test.ts:171` (admin alert dispatched 0× instead of 1×), plus 3 cascade failures in `tests/integration/apns-dispatch.test.ts:162/205/256` (mock notification dispatch / TLS configuration / dispatch contract).
  - `e2e` → 6 failures, all of them mobile-layout 40 px vs 44 px regressions: `settings-mobile-consistency.spec.ts` (account / dashboard / ai pages — select trigger renders at 44 px not 40 px), `mobile-viewport.spec.ts`, `onboarding-flicker.spec.ts` (× 2). The 40 px ↔ 44 px split lines up with iOS-textarea-zoom touch-target tweaks landed in v1.4.34.5; the e2e spec was not updated.
- **HL-2 FINDING (SEVERITY: MEDIUM) — open dependabot PR #155 ("Bump react from 19.2.5 to 19.2.6") has been sitting since 2026-05-10**, last updated 2026-05-16. Either auto-merge isn't passing (suggests the failing tests above gate it) or no human triaged. Worth a sweep.
- **HL-3 FINDING (SEVERITY: LOW) — draft PR #180 ("v1.4.34.1 — Recharts container dimensions hotfix") still open from 2026-05-16**, last touched today by the planning push. Title pre-dates the actual landed work (we are at v1.4.36 / heading to v1.4.37). Either repurpose as the v1.4.37 PR or close.

**Releases**
- [X] 10 most recent releases (v1.4.33 → v1.4.36) all `isDraft:false`, `isPrerelease:false`, ISO timestamps consistent.
- [X] Release body for v1.4.36 reads as Marc-voice English, no AI/marathon/personal data leakage in the section header inspected.

**Repo hygiene — local working tree**
- [X] `.gitignore` covers `.planning/`, `.claude/`, `.cursor/`, `.codex/`, `.aider*`, `/docs/superpowers/`, `.next/`, `test-results/`, `coverage/`, `node_modules/`, `.env`, `*.tsbuildinfo`, the MaxMind `.mmdb` payloads — verified all sample artifacts are ignored.
- [X] No `.env`-style secrets, no credential files committed (passwords reference matches expected source code paths only).
- [X] `LICENSE` (AGPL), `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `CONTRIBUTING-AI.md`, `SECURITY.md` all present.
- [X] `.gitleaks.toml` config in root — secret-scan tooling pinned.

**Security posture — NEEDS MARC'S CALL**
- [ ] `secret_scanning` → DISABLED (free for public repos).
- [ ] `secret_scanning_push_protection` → DISABLED (free for public repos).
- [ ] `dependabot_security_updates` → DISABLED (separate from the `dependabot.yml` version-update config, which IS enabled).
- [ ] `vulnerability-alerts` → DISABLED on the repo.
- [ ] Code-scanning / CodeQL → no analyses configured.
- [ ] Branch protection on `main`: `required_conversation_resolution: true` is the only active rule; no required PRs, no required status checks, no required linear history, no required signed commits, admins can bypass. Linear history is fine to leave off (Marc's develop→main flow uses squash-merge), but adding required status checks (the very ones currently failing!) would block accidental red-tag-cuts.

**Open issues** — 1 open (`#167 [Feature] Time synchronization between the application and the database`) — already addressed by v1.4.25 user-timezone work; Marc planned to close after rollout but it's still open. Issue references a problem solved in v1.4.25; safe to close with a follow-up comment.

---

### healthlog-docs (https://github.com/MBombeck/healthlog-docs)

- [✗] Description = `"HealthLog Documentation — built with Starlight (Astro)"` — implementer-voice, no keywords for discovery. Should be value-first like the main repo.
- [✗] Topics = none. Should mirror at least: `documentation`, `health-tracking`, `starlight`, `astro`, `self-hosted`.
- [✗] Homepage URL = empty. Should point to `https://docs.healthlog.dev`.
- [✗] License = none. AGPL? Or docs-only CC-BY-SA? Marc's call.
- [✗] `SECURITY.md` = not present (`isSecurityPolicyEnabled: false`).
- [✗] No `CODE_OF_CONDUCT.md`, no `CONTRIBUTING.md`, no `.github/` directory at all (no issue templates, no PR template, no dependabot).
- [✗] No CI workflows on the remote — deployment must run elsewhere (likely Coolify pulling on push). No verification gate on a doc-build break before the deploy SSH job fires.
- [X] No draft/prerelease confusion — no releases at all (docs site is rolling).
- [X] Local `.gitignore` adequately small: `dist/`, `.astro/`, `node_modules/`, log files, `.env*`, `.DS_Store`. No `.planning/` or `.notes/` to ignore — they don't exist here.
- [X] No PRs, no issues.
- [X] `secret_scanning` + `secret_scanning_push_protection` → ENABLED (better than HealthLog!).
- [ ] `dependabot_security_updates`, `vulnerability-alerts` → DISABLED.

---

### healthlog-landing (https://github.com/MBombeck/healthlog-landing)

- [✗] Description = `"HealthLog — Professional landing page"` — implementer-voice, no keywords. Should sell the product.
- [✗] Topics = none.
- [✗] Homepage URL = empty. Should point to `https://healthlog.dev`.
- [✗] License = none.
- [✗] `SECURITY.md` = not present.
- [✗] No `CODE_OF_CONDUCT.md`, no `CONTRIBUTING.md`. `.github/` only contains the deploy workflow (no issue/PR templates, no dependabot).
- [△] **LR-1 FINDING (SEVERITY: MEDIUM)** — `Deploy to edge-01` workflow had 6 consecutive failures on `main` between 2026-05-16 11:03 and 16:47 before recovering. Failure trail visible in commit messages (`chore: bump softwareVersion`, `fix(deploy): allow sharp + unrs-resolver build scripts`, etc.). The cause was fixed at 2026-05-16 16:58 ("fix(deploy): pass `--ignore-scripts` to pnpm install in Docker") — current state green, but documents that the landing's main branch is the publish target with no review gate.
- [✗] No PR template, no issue templates → casual contributors have no scaffold.
- [△] Local untracked `.notes/` directory (`applesub-public-urls.md`, 7 KB of working-notes prose); not in `.gitignore`. Risk of accidental commit. Easy win to add `.notes/` to `.gitignore`.
- [X] No `.env` / secrets in tracked files. The only credential-shaped match is `src/components/DemoCredentials.tsx`, which is the on-page demo-account banner (intended public).
- [X] No releases (continuous deploy from `main`).
- [X] No open issues, no open PRs.
- [ ] `secret_scanning` + `secret_scanning_push_protection` → DISABLED.
- [ ] `dependabot_security_updates`, `vulnerability-alerts` → DISABLED.

---

## Cross-cutting recommendations

1. **Secret-scanning + push-protection** are free for public repos. Enable on HealthLog + healthlog-landing to match healthlog-docs. Push-protection alone catches accidental key leaks before they hit the remote — high-leverage one-checkbox change.
2. **Vulnerability-alerts + dependabot_security_updates** are also free + zero-config for public repos. Currently disabled on all three. The version-update side already runs on HealthLog; the security side complements it.
3. **Sibling repos (docs + landing) lack the basic metadata HealthLog has** — description (keyword-front), topics, homepage URL, LICENSE, SECURITY.md. This hurts discovery and trust signals. Five-minute fixes once Marc confirms the wording + license choice.
4. **Required status checks on `main`** for HealthLog. The v1.4.36 tag landed with three red workflows; a `required_status_checks` rule on `main` referencing the three failing workflows would have blocked the tag push. Marc's call — listed under "fixes recommended" per the no-branch-protection-change rule.
5. **Failing test trio on HealthLog v1.4.36** (HL-1) is real product-quality data, not just CI noise. The mobile-layout 40 px ↔ 44 px split is a spec-vs-implementation mismatch from v1.4.34.5; the integration test mock setup looks like a refactor caught the wrong mock signature; the unit test timeout needs `{ timeout: 30_000 }`. Worth triaging into the v1.4.37 fix queue.

---

## Fixes applied

None. After reviewing the four "may change" categories I decided against landing any of them autonomously:

- **Repo descriptions on docs + landing** — needed Marc's wording approval (value-first sales copy in his voice). The docs-refresh agent owns landing/docs prose this marathon and may have its own wording — staying out of its lane.
- **Topics on docs + landing** — same reasoning; Marc may want different sets than the obvious ones.
- **Homepage URLs on docs + landing** — straightforward to set to `https://docs.healthlog.dev` and `https://healthlog.dev` respectively, but the docs-refresh agent is touching landing content this wave — leaving the metadata sync for after their commit lands so we don't race.
- **`SECURITY.md` for docs + landing** — these would either point at the existing `security@bombeck.io` (safe) or stub a forwarder. Need Marc's preference; not safe to invent.
- **`.notes/` add to landing `.gitignore`** — safe and self-contained, but landing is being actively touched by the docs-refresh agent right now. Flagging for the post-marathon followup so we don't conflict.

The intent of the "may change" allowance is preserved by writing this report so Marc can approve all of them in one sweep — see next section.

---

## Fixes recommended for Marc to approve

| # | Repo | Change | Why | Risk |
|---|------|--------|-----|------|
| 1 | HealthLog | Enable secret-scanning + push-protection (Settings → Code security) | Free for public, blocks accidental key leaks at push time | Zero |
| 2 | HealthLog | Enable Dependabot security updates + vulnerability alerts | Free, complements existing version-update config | Zero |
| 3 | HealthLog | Add required-status-checks rule on `main` (Build & Publish Docker Image, Security & Quality, Integration tests, e2e) | Prevents red-tag releases like v1.4.36 | Low (might delay future releases until tests green) |
| 4 | HealthLog | Triage the v1.4.36 failing trio into the v1.4.37 fix list (HL-1) | Real product/test debt | None |
| 5 | HealthLog | Close issue #167 with reference to v1.4.25 user-timezone fix | Stale | Zero |
| 6 | HealthLog | Triage dependabot PR #155 (react 19.2.5 → 19.2.6) — auto-merge stalled because of HL-1 failing checks | Backlog hygiene | Zero (patch bump) |
| 7 | HealthLog | Close or repurpose draft PR #180 (mis-named for current state) | Confusion | Zero |
| 8 | healthlog-docs | Set description (value-first, keyword-front, ≤ 160 chars), topics, homepage URL, license, SECURITY.md, basic PR + issue templates, dependabot.yml | Discovery + trust | Zero |
| 9 | healthlog-landing | Same as #8 | Discovery + trust | Zero |
| 10 | healthlog-landing | Add `.notes/` to `.gitignore` | Prevent accidental commit of working-notes | Zero |
| 11 | healthlog-landing | Enable secret-scanning + push-protection | Free | Zero |
| 12 | healthlog-docs + healthlog-landing | Decide whether `main` here also needs PR-required + status-check protection | Either repo can break the website with one bad push to `main` | Marc's flow call |

If Marc green-lights items 1, 2, 8, 9, 10, 11 in one sweep, the audit agent (or a follow-up phase) can land them in three small commits (one per repo). Items 3–7 are HealthLog-only triage that fits naturally into the v1.4.37 marathon's normal fix-list.
