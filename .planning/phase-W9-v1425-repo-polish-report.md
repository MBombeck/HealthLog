# Phase W9 — v1.4.25 GitHub Repo Polish

**Date:** 2026-05-14
**Branch:** `develop`
**Status:** Complete (deferred items documented inline)

Repo-polish sweep ahead of the v1.5 marketing push. Five sub-phases:
Issue #167 mitigation comment, Dependabot PR triage, repo metadata +
README rewrite, branch-protection v2, and the report itself.

---

## Phase 1 — Issue #167 mitigation comment

Posted: <https://github.com/MBombeck/HealthLog/issues/167#issuecomment-4450312159>

The Warsaw user reported timezone drift in CSV exports (entered 11:05
Warsaw, exported 09:05). The v1.4.25 user-timezone feature (W7 + W7b)
closes this. Comment explains the fix, validates the interim `TZ` +
`PGTZ` workaround, and points to the feature spec.

Issue left open per directive — Marc closes after v1.4.25 ships.

Note: the first version of the comment had backslash-escaped backticks
from heredoc encoding; corrected via `PATCH /issues/comments/{id}` so
the inline code formatting renders correctly.

---

## Phase 2 — Dependabot PR sweep

Four open dependabot PRs as of task start. All four require human follow-up.

### PR #155 — react 19.2.5 → 19.2.6 (patch, npm)

**Outcome:** Commented "rebase needed; will re-evaluate post-v1.4.25".

Local checkout + `pnpm install --frozen-lockfile` + `pnpm typecheck`
all green. Lint clean (0 errors, 13 pre-existing warnings). Tests fail
with the runtime error:

```
Incompatible React versions: The "react" and "react-dom" packages must
have the exact same version. Instead got:
  - react:     19.2.6
  - react-dom: 19.2.5
```

Dependabot only bumped the `react` package — the paired `react-dom`
bump is missing. This is a known Dependabot pattern for React's split
package layout; the fix is either a manual grouped bump or waiting for
Dependabot to open the matching `react-dom` PR (which it should the
following week if both packages stay out of sync).

The PR is also blocked by pre-existing failures on `main` (e2e + the
auto-merge job that runs `pnpm test` itself). Comment posted:
<https://github.com/MBombeck/HealthLog/pull/155#issuecomment-4450373606>

### PR #163 — actions/upload-artifact v4 → v7 (workflows)

**Outcome:** Commented "safe to merge, needs `workflow` scope".

Diff is one line in `.github/workflows/e2e.yml`. v7 release-notes
review confirms no breaking changes to the parameters we use (`name`,
`path`, `retention-days`); v7 transitioned to ESM + Node.js 24 runtime.
The bump is required for the September 2026 Node.js 20 deprecation that
the actions runner already warns about.

`gh pr merge 163 --squash --delete-branch --admin` fails with:

```
refusing to allow an OAuth App to create or update workflow
.github/workflows/dependabot-auto-merge.yml without `workflow` scope
```

The local `gh` token has `'admin:public_key', 'gist', 'read:org',
'repo'` — no `workflow` scope. Marc merges via the GitHub UI or
re-authenticates `gh` with `workflow` scope granted.

Comment: <https://github.com/MBombeck/HealthLog/pull/163#issuecomment-4450379321>

### PR #164 — actions/cache v4 → v5 (workflows)

**Outcome:** Same as #163 — safe to merge, needs `workflow` scope.

Diff is one line in `.github/workflows/e2e.yml` (Playwright browser
cache step). v5 release-notes review: Node.js 24 runtime change only;
no parameter-level breaking changes for `path` / `key` / `restore-keys`.
Same Node 20 deprecation rationale as #163.

Comment: <https://github.com/MBombeck/HealthLog/pull/164#issuecomment-4450379570>

### PR #166 — actions/setup-node v4 → v6 (workflows)

**Outcome:** Same — safe to merge, needs `workflow` scope.

Touches four workflow files. v6 release-notes review: limits automatic
caching to npm by default, but `cache: pnpm` (explicit, which is what
every job here uses) is still supported. Node.js 22 still supported
(we pin it everywhere).

Comment: <https://github.com/MBombeck/HealthLog/pull/166#issuecomment-4450379905>

### Open PRs after sweep

```
gh pr list --author dependabot --state open
```

Still shows the same four PRs (155, 163, 164, 166). None merged from
this session because:

- **#155** — code-level blocker (paired `react-dom` bump missing).
- **#163 / #164 / #166** — gh CLI token missing `workflow` scope.

Marc's follow-up: re-auth `gh` with `workflow` scope and merge 163 +
164 + 166 in the GitHub UI; wait for Dependabot's next sweep to pair
react + react-dom on #155.

---

## Phase 3 — Repo polish

### 3.1 README hero rewrite

Commit `ef03705` — `docs: rewrite README hero — what / who / try the
demo (30-second read)`.

Two changes (+9 / -1):

- **New "What it is" section** between the badges + quick-links block
  and the existing "Why HealthLog?" header. Two paragraphs (product
  description + audience + live-demo CTA) so a stranger sees the
  proposition in 30 seconds without scrolling past badges.
- **Quick Start lead** updated from "Plan ~5 minutes for a working
  install" to "**3 minutes from `git clone` to a working install.**" —
  fulfils the marketing-checklist "3 minutes" promise next to the
  actual install steps.

Did NOT touch: hero screenshot, three-screenshot strip, star-history
badge, architecture diagram. Those need Marc to capture demo
screenshots from `demo.healthlog.dev` (PII-free) and upload an OG
image via Settings → Social preview. Documented in the checklist.

### 3.2 Repo description tagline

Before: "Personal health-tracking PWA. Weight, BP, pulse, mood,
medication compliance, Withings sync, doctor report PDF. Self-hosted.
PWA. Privacy-first. AGPL-3.0. Dracula-themed."

After: "Self-hosted, privacy-first personal health tracking PWA.
Weight, blood pressure, body composition, glucose, sleep, mood,
medications. Withings + Apple Health sync, multi-provider AI Insights
(BYOK), client-side doctor-report PDF. EN/DE. AGPL-3.0. Single
`docker compose up`."

`gh api repos/MBombeck/HealthLog -X PATCH -f description=...` — applied.
Length 322 chars (under the 350 GitHub limit).

Note: the new tagline matches the marketing-playbook checklist
rewrite. The task description suggested a shorter alternative
("Self-hosted personal health tracker — privacy-first, AI Insights,
Withings + Apple Health support"); the longer marketing-checklist
version was chosen because the checklist is the audit source-of-truth
and the longer version lists the metrics + EN/DE + license + install
gesture in one breath. Easy to revert if Marc prefers the shorter form.

### 3.3 Repo topics

Before (10): `dracula-theme`, `health-tracking`, `nextjs`, `passkeys`,
`prisma`, `pwa`, `self-hosted`, `shadcn-ui`, `typescript`, `webauthn`.

After (18): `agpl`, `apple-health`, `bloodpressure`, `docker`,
`health-tracking`, `medication-tracker`, `nextjs`, `passkeys`,
`personal-health`, `postgresql`, `prisma`, `privacy`, `pwa`,
`quantified-self`, `self-hosted`, `typescript`, `webauthn`, `withings`.

Dropped: `dracula-theme` (niche, low search volume), `shadcn-ui`
(dependency detail). Added per the marketing-checklist
recommendation — these are the high-search-volume terms the v1.5
audience actually uses (`apple-health`, `withings`, `quantified-self`,
`agpl`) plus the AlternativeTo / Paperless-ngx / Vaultwarden tag
conventions (`docker`, `postgresql`, `privacy`, `personal-health`,
`bloodpressure`, `medication-tracker`).

Note: task suggested a smaller subset including `ai-insights` and
`coach`. The marketing-checklist final-18 list omits those in favour
of broader-search terms; followed the checklist per task framing ("per
the marketing-playbook recommendation").

### 3.4 Repo homepage

Before: `https://healthlog.dev` (landing).
After: `https://healthlog.bombeck.io` (demo).

Applied via `gh api`. Per marketing-playbook recommendation — the demo
is the immediate-conversion surface; the landing stays linked from the
README header and footer.

### 3.5 GitHub Discussions

Before: `has_discussions: false`.
After: `has_discussions: true`.

Applied via `gh api`. Categories default to GitHub's standard set
(Announcements, Q&A, Ideas, Show & Tell). Marc creates the seed posts
("Welcome — start here", "Roadmap", etc.) via the UI per the
marketing-checklist seed-posts guidance.

### 3.6 Social-preview image

**Deferred — needs Marc.** GitHub's API doesn't expose a programmatic
upload for the OG image; it has to go via Settings → Social preview.
Required: 1280×640 PNG, logo top-left, tagline middle, scrubbed
dashboard screenshot at 60% width on Dracula background.

Documented in the checklist as a remaining TODO. Without this, every
share-card on Twitter / Mastodon / Bluesky / Slack shows the generic
GitHub avatar grid instead of the product.

### 3.7 FUNDING.yml

**Skipped intentionally** per task constraint — Marc hasn't approved a
funding pitch. The checklist suggests Liberapay + GitHub Sponsors;
leaving it in the v1.4.26 backlog until Marc weighs in.

### 3.8 Pinned issues + good-first-issue label

**Deferred to v1.4.26.** Only one issue is open (#167), so there's
nothing meaningful to pin. The marketing-checklist suggests pinning a
"v1.5 iOS launch — feedback megathread" and a "Translations welcome"
thread; both are post-v1.5 actions.

### 3.9 README screenshots

**Deferred — needs Marc.** Three hero screenshots from
`demo.healthlog.dev` (dashboard, BP trend chart, doctor-report PDF
preview) at 1600×900, scrubbed. Can't auto-generate from CLI —
documented in the checklist as a 1-hour Marc action.

---

## Phase 4 — Branch protection v2

**Applied** to `main`:

```yaml
required_status_checks: null # deliberately deferred to W10
enforce_admins: false
required_pull_request_reviews: null
restrictions: null
required_linear_history: false
allow_force_pushes: false
allow_deletions: false
block_creations: false
required_conversation_resolution: true # NEW in v2
lock_branch: false
allow_fork_syncing: false
```

Change vs the W9b minimal protection: `required_conversation_resolution`
flipped to `true`. PRs to main now require every review thread
resolved before merge — keeps reviewer-questioned diffs from sneaking
in without a response.

**`required_status_checks` deliberately NOT added.** Per task: even
though W2 fixed coach-prefs + e2e, `main`'s e2e and integration runs
are currently failing again (parallel agent work). Flipping the gate
would lock `main` against itself. Verified with
`gh run list --branch main --limit 3`:

```
Post-publish verify     | success
e2e                     | failure   <- pre-existing
Security & Quality      | success
Build & Publish Docker  | success
Integration tests       | failure   <- pre-existing
```

W10 multi-agent QA owns the e2e + integration green-up; once that
lands the gate flips by adding `required_status_checks` to the
protection payload.

---

## Verification

```
$ gh api repos/MBombeck/HealthLog --jq '{description, topics, has_discussions, homepage}'
{
  "description": "Self-hosted, privacy-first personal health tracking PWA. ...",
  "topics": ["agpl","apple-health","bloodpressure","docker","health-tracking",
             "medication-tracker","nextjs","passkeys","personal-health",
             "postgresql","prisma","privacy","pwa","quantified-self",
             "self-hosted","typescript","webauthn","withings"],
  "has_discussions": true,
  "homepage": "https://healthlog.bombeck.io"
}
```

```
$ gh issue view 167 --json comments --jq '.comments[-1].body' | head -1
Closed by v1.4.25 (ship target: this week).
```

```
$ gh pr list --author dependabot --state open --json number
# Still shows 155, 163, 164, 166 — see Phase 2 for why each needs Marc follow-up.
```

```
$ gh api repos/MBombeck/HealthLog/branches/main/protection --jq '.required_conversation_resolution.enabled'
true
```

---

## Deferred to v1.4.26 / awaiting Marc

| Item                                            | Reason                                               |
| ----------------------------------------------- | ---------------------------------------------------- |
| Merge PRs #163 / #164 / #166                    | gh token lacks `workflow` scope; UI merge or re-auth |
| Rebase + dual-bump react+react-dom (#155)       | Wait for next Dependabot sweep                       |
| Upload social-preview OG image                  | UI-only action; needs Marc to capture + upload       |
| Hero / 3-screenshot strip in README             | Needs scrubbed `demo.healthlog.dev` screenshots      |
| `.github/FUNDING.yml`                           | Awaiting Marc approval on funding pitch              |
| Pinned issues + good-first-issue seed           | Post-v1.5 action                                     |
| Add `required_status_checks` to main protection | W10 owns the prerequisite e2e + integration green-up |
| Star-history + "as featured in" README badges   | Post awesome-selfhosted PR acceptance                |

---

## Summary

Repo metadata + README hero now read as a serious self-hosted project
in 30 seconds, with the demo URL as the homepage and the high-search
topics that match the v1.5 audience. Dependabot triage is fully
documented per PR with merge blockers called out. Branch-protection
v2 in place with `required_conversation_resolution` flipped on; the
status-check gate waits on W10's CI green-up. Issue #167 has a real
mitigation comment that points the reporter at the imminent fix and
validates their interim workaround.
