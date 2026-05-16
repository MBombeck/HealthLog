# README + Docs + GitHub Discoverability Audit — 2026-05-16

## Executive summary

The README is well-structured and content-rich, but it underplays the two strongest discoverability hooks the project actually ships: **Apple Health import** (the headline v1.4.34 feature is invisible in the README) and **AI Insights / Coach as a visual differentiator** (mentioned once, as a feature bullet, never shown). There is no hero screenshot or animated demo above the fold, no comparison table against Withings / Apple Health / Oura / self-hosted alternatives, and the GitHub `description` field omits "self-hosted health tracker" — the exact phrase the target user types into search. `homepageUrl` points at the production tenant (`healthlog.bombeck.io`) instead of the demo (`demo.healthlog.dev`) or the docs site. Fix shape: a hero image + 8-row comparison table + 3 keyword swaps in the GitHub description + 6 new topics would 5-10× search impressions without touching the codebase.

## Findings — prioritized

### F-1: No hero screenshot or animated demo above the fold

**Severity**: high
**Scope**: README
**Citation**: `README.md:1-30` — header block is logo + badges + tagline + nav links; nothing visual until line 80 (Quick Start).
**What's wrong**: GitHub renders the first viewport on the repo landing page. Today a visitor sees a 120 px logo, four badges, and three text paragraphs — nothing that conveys "this is a dashboard product" until they scroll past the feature list. Every comparable repo (immich, mealie, paperless-ngx, dawarich) leads with a screenshot or animated GIF; this is the single highest-leverage README change.
**Fix shape**: Add a dashboard screenshot (or 2x grid: desktop + mobile PWA) right after the tagline, before badges. Ideally a `.webp` capture of the dashboard with the trends row + a Coach card visible. Add to `public/screenshots/` and reference as `<img src="public/screenshots/hero-dashboard.webp" />`. No PII — use the demo tenant or synthetic data.
**Effort**: small (screenshot + commit)

### F-2: Apple Health import — the headline v1.4.34 feature — missing from README

**Severity**: high
**Scope**: README, SEO
**Citation**: `README.md:46-77` — Key Features list. Grep `apple health` against README: zero matches. `CHANGELOG.md:94` ships it as the v1.4.34 banner feature.
**What's wrong**: "apple health export server" / "apple health xml import" / "apple health self-hosted" are exactly the queries a user looking to escape the iOS ecosystem types. The repo `topics` include `apple-health`; the README does not. GitHub search ranks README content; not surfacing the keyword in the README means the topic alone won't carry the search.
**Fix shape**: Add a dedicated Key-Features bullet: "**Apple Health import** — Drop your `export.zip` on the import page. The server streams it to disk, parses the XML (handles Zip64 / multi-GB exports), and folds every `<Record>`, `<Workout>`, `<Correlation>` into your timeline. Idempotent — re-upload to merge new data without duplicates." Mirror in the Integrations table.
**Effort**: trivial [hotfix-ready]

### F-3: AI Coach / Insights surface buried in a single bullet

**Severity**: high
**Scope**: README, SEO
**Citation**: `README.md:60` — single bullet "Multi-Provider AI Insights"; no "Coach", no "Daily Briefing", no "Health Score", no "Weekly Report".
**What's wrong**: Per maintainer-stated positioning, AI Insights are *the* differentiator. The README treats them as one feature among twelve. Coach (the conversational surface), Health Score (the daily tile), Daily Briefing, and Weekly Report — all shipped v1.4.20-onward — are not named in the README at all. A user comparing this against generic dashboards never learns the project's flagship.
**Fix shape**: Promote AI Insights to a dedicated section between "Why HealthLog?" and "Key Features", with three sub-bullets (Coach / Health Score / Briefing). One screenshot. Frame it as "evidence-grounded, multi-provider, your data stays on your network."
**Effort**: small

### F-4: No comparison table

**Severity**: high
**Scope**: README, SEO (alternatives-linking is an SEO signal)
**Citation**: `README.md` — absent.
**What's wrong**: Visitors arrive comparing this against Withings web, Apple Health, Oura, Garmin Connect, and the few self-hosted options (Wger, OpenHealth, Wakapi for activity). Without a comparison table, they bounce to evaluate alternatives independently. Linking to alternatives is also a positive SEO signal (mutual relevance).
**Fix shape**: 6-column matrix: HealthLog | Withings | Apple Health | Oura web | Garmin Connect | Generic CSV. Rows: Self-hosted, Open source, BYOK AI, Withings sync, Apple Health import, Doctor PDF, Custom thresholds, No subscription, License. Place after "Why HealthLog?".
**Effort**: small [hotfix-ready]

### F-5: GitHub `description` is technically dense but misses primary search keywords

**Severity**: high
**Scope**: repo metadata, SEO
**Citation**: GitHub UI → About → description: "Self-hosted, privacy-first personal health tracking PWA. Weight, blood pressure, body composition, glucose, sleep, mood, medications. Withings + Apple Health sync, multi-provider AI Insights (BYOK), client-side doctor-report PDF."
**What's wrong**: 290 characters — over the GitHub UI ~200 char cutoff for the About sidebar. The high-value phrase "self-hosted health tracker" (without "ing") isn't in there, which is what 80% of search queries phrase. "Apple Health" appears but "withings alternative" / "self-hosted apple health" do not.
**Fix shape**: ≤ 160 chars, keyword-front-loaded: "Self-hosted health tracker. Weight, blood pressure, glucose, mood, medications. Withings + Apple Health sync. AI Insights you own. AGPL." Edit via `gh repo edit MBombeck/HealthLog --description "..."`.
**Effort**: trivial [hotfix-ready]

### F-6: `homepageUrl` points at the maintainer's production tenant, not the demo

**Severity**: medium
**Scope**: repo metadata, SEO, privacy
**Citation**: GitHub repo → homepageUrl = `https://healthlog.bombeck.io`.
**What's wrong**: The maintainer's personal subdomain is exposed as the project homepage. It is not the public demo. New visitors clicking the sidebar link land on a login wall, not a working preview. Demo lives at `demo.healthlog.dev`; the project site at `healthlog.dev`.
**Fix shape**: `gh repo edit MBombeck/HealthLog --homepage https://demo.healthlog.dev` (or `https://healthlog.dev` once that landing exists). Demo is higher-impact for conversion.
**Effort**: trivial [hotfix-ready]

### F-7: No custom social preview image (uses generic GitHub auto-OG)

**Severity**: medium
**Scope**: repo metadata, SEO
**Citation**: `usesCustomOpenGraphImage: false` in `gh repo view` output.
**What's wrong**: When the repo URL is pasted into Slack / Discord / Mastodon / X, the unfurl shows a generated tile with the repo name. Comparable projects (immich, dawarich) ship a branded 1280×640 PNG showing the dashboard. This is the visual that gets shared.
**Fix shape**: Upload a 1280×640 PNG via GitHub UI → Settings → Social preview. Suggested content: dashboard screenshot + "HealthLog — your health data, your server" tagline + logo. The same asset can live in `public/og-image.png` and be referenced from `src/app/layout.tsx:49` (currently no `images` field in `openGraph`).
**Effort**: small

### F-8: GitHub topics — high-relevance gaps + one low-value entry

**Severity**: medium
**Scope**: repo metadata, SEO
**Citation**: GitHub repo → topics array (19 entries).
**What's wrong**: Missing `withings-alternative`, `apple-health-import`, `personal-dashboard`, `ai-insights`, `glucose-tracker`, `mood-tracker`, `doctor-report`. Present `glp-1` and `mounjaro` are PII-adjacent (specific medications the maintainer likely tracks) and dilute the search graph. `tracking` and `health` are too generic to win against millions of repos.
**Fix shape**: Replace `glp-1`, `mounjaro`, `tracking`, `health` with `withings-alternative`, `apple-health-import`, `personal-dashboard`, `ai-insights`, `glucose-tracker`, `mood-tracker`. See "Suggested topics" below for the ranked list.
**Effort**: trivial [hotfix-ready]

### F-9: No `.github/FUNDING.yml`

**Severity**: low
**Scope**: repo metadata
**Citation**: `find .github -iname "FUNDING*"` returns empty; `fundingLinks: []` in `gh repo view`.
**What's wrong**: No sidebar "Sponsor" button. AGPL self-hosted projects without funding visibility plateau on stars but not on sustained contribution. If the maintainer has any GitHub Sponsors / Ko-fi / Liberapay link, adding it surfaces a sponsor button on the repo page and on every PR.
**Fix shape**: `.github/FUNDING.yml` with `github: [MBombeck]` or similar. Skip if no funding intent.
**Effort**: trivial

### F-10: `docs/` tree is operator-/audit-heavy, user-facing guides live elsewhere

**Severity**: medium
**Scope**: docs/
**Citation**: `find docs -name "*.md"` — 27 of 31 files are `docs/audit/v14XX-summary.md` or ops/migration notes. No user-facing setup guide tree.
**What's wrong**: A visitor following "see Self-Hosting → Reverse Proxy" (`README.md:107`) is bounced to `docs.healthlog.dev`, but the in-repo `docs/` tree appears to be the operator's working notes. There's no `docs/getting-started.md`, no `docs/integrations/apple-health.md`, no `docs/integrations/withings.md`, no `docs/ai-providers.md` in the repo. This is fine if `docs.healthlog.dev` is the canonical surface — but the canonical surface needs verifying, and `docs/` should signal "see docs.healthlog.dev" with a README, not look like a half-built docs tree.
**Fix shape**: Add `docs/README.md` (top-level) saying "User docs live at docs.healthlog.dev. The files here are internal operator audits and migration notes." Or move `audit/` into `docs/audit/` ring-fenced. Verify the topics the README links to (`/self-hosting/reverse-proxy/`) exist on the public docs site.
**Effort**: small

### F-11: No `docs/api/openapi.yaml` link in README

**Severity**: low
**Scope**: README, docs/
**Citation**: `docs/api/openapi.yaml` exists (`docs/api/README.md:1`) but the README's API Reference section (`README.md:240-386`) doesn't reference it.
**What's wrong**: A developer evaluating integration potential doesn't see an OpenAPI spec is available. The README's API table is good for scanning; the OpenAPI spec is the codegen target. Both should be discoverable.
**Fix shape**: Add one line above the API Reference collapsibles: "Machine-readable OpenAPI 3.1 spec: [`docs/api/openapi.yaml`](docs/api/openapi.yaml). Generates iOS DTO + any client codegen."
**Effort**: trivial [hotfix-ready]

### F-12: README Tech Stack omits the iOS native client

**Severity**: low
**Scope**: README
**Citation**: `README.md:111-128` — Tech Stack table; no iOS / Swift / SwiftUI row.
**What's wrong**: The repo carries `docs/apple-store-connect-checklist.md` and v1.4.23-onward CHANGELOG entries describing the native iOS app foundation. The README hides this; a visitor sees "web PWA only."
**Fix shape**: Add row "iOS client | SwiftUI (separate repo, in development)" or call it out in a Roadmap section.
**Effort**: trivial

### F-13: No Roadmap / Status section

**Severity**: low
**Scope**: README
**Citation**: `README.md` — absent.
**What's wrong**: Visitors can't tell what's next, what's stable, or whether the project is alive. The CHANGELOG shows ~daily releases; that signal doesn't reach the landing.
**Fix shape**: A small "Status" section: "Active development. ~weekly releases. Current focus: native iOS client (v1.5)." Plus one-line Roadmap link to a GitHub Project board or to the discussion forum.
**Effort**: trivial

### F-14: `src/app/layout.tsx` openGraph has no `images` field

**Severity**: low
**Scope**: SEO
**Citation**: `src/app/layout.tsx:49-57` — `openGraph` block lacks `images:`.
**What's wrong**: When `demo.healthlog.dev` is shared in chat, the unfurl has no image. Same problem as F-7 but for the live app, not the repo.
**Fix shape**: Add `images: [{ url: "/og-image.png", width: 1200, height: 630 }]` and ship `public/og-image.png`. Same asset as F-7.
**Effort**: trivial

### F-15: README has no badge for latest release or Docker pulls

**Severity**: low
**Scope**: README, SEO
**Citation**: `README.md:11-17` — 5 badges, none of which surface version or activity.
**What's wrong**: A current-version badge tells visitors the project is alive without them scrolling. Docker pulls signal traction.
**Fix shape**: Add `![Latest release](https://img.shields.io/github/v/release/MBombeck/HealthLog?sort=semver)` and `![Docker pulls](https://img.shields.io/github/v/tag/MBombeck/HealthLog?label=docker&sort=semver)` (GHCR doesn't have a pulls counter but the latest-tag badge serves the same role).
**Effort**: trivial [hotfix-ready]

## Suggested topics

Ranked by search-volume × relevance. Aim for 15-18 active topics; drop `glp-1`, `mounjaro`, `tracking`, `health`, `dashboard` (too generic).

1. `self-hosted`
2. `health-tracking`
3. `pwa`
4. `nextjs`
5. `apple-health`
6. `withings`
7. `apple-health-import`
8. `withings-alternative`
9. `personal-health`
10. `quantified-self`
11. `privacy`
12. `prisma`
13. `medication-tracker`
14. `glucose-tracker`
15. `mood-tracker`
16. `ai-insights`
17. `docker`
18. `agpl`

## Draft README revision

Not warranted as a full rewrite. The existing structure is sound; the top three changes (hero image + Apple Health bullet + comparison table) are additive edits to the current document. Suggested insertions to the existing README:

**Insert after line 22 (before the "Website / Live Demo / Documentation" link row):**

```markdown
<p align="center">
  <img src="public/screenshots/hero-dashboard.webp" alt="HealthLog dashboard — trends, Coach card, Health Score" width="900" />
</p>
```

**Insert as a new section after "Why HealthLog?" (after line 44):**

```markdown
## How it compares

|                          | HealthLog          | Withings web   | Apple Health | Oura web   | Generic CSV |
| ------------------------ | ------------------ | -------------- | ------------ | ---------- | ----------- |
| Self-hosted              | Yes                | No             | No           | No         | Yes         |
| Open source              | AGPL-3.0           | No             | No           | No         | n/a         |
| Withings device sync     | Yes (OAuth2)       | Yes (native)   | Via shortcut | No         | No          |
| Apple Health import      | Yes (`export.zip`) | No             | Native       | No         | Manual      |
| Custom clinician targets | Yes (audit-logged) | Limited        | No           | No         | n/a         |
| Doctor-report PDF        | Yes (client-side)  | No             | No           | No         | n/a         |
| AI Insights              | Multi-provider BYOK| No             | Limited      | Subscription| n/a        |
| Subscription required    | No                 | For some metrics| No          | Yes        | No          |
| Your data leaves device  | Never              | Withings cloud | Apple cloud  | Oura cloud | Depends     |
```

**Insert as a new bullet inside Key Features (between line 58 and line 60):**

```markdown
**Apple Health import** — Drop your iOS `export.zip` on the import page. Streaming parser handles multi-gigabyte archives (Zip64), folds every record / workout / correlation into your timeline, and stays idempotent on re-upload. Per-type ingestion stats and live progress on a status endpoint.
```

**Insert as a new bullet inside Key Features, promoted to first position (replace current line 60 "Multi-Provider AI Insights"):**

```markdown
**AI Coach + Insights** — A conversational Coach trained on your own data, a daily briefing, a weekly report, and a Health Score tile on the dashboard. Pick OpenAI, Anthropic Claude, or any OpenAI-compatible local endpoint (Ollama, LM Studio, vLLM). BYOK or admin-shared. Evidence-grounded — every claim links back to the measurements that produced it. Local endpoints keep all data on your network.
```

**Add a one-line Status block after the "What it is" paragraph (after line 36):**

```markdown
> **Status**: active. New releases roughly weekly — see [CHANGELOG](CHANGELOG.md). Current focus: native iOS client (v1.5).
```

**Replace badges block (lines 11-17) with:**

```markdown
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
  <a href="https://github.com/MBombeck/HealthLog/releases"><img src="https://img.shields.io/github/v/release/MBombeck/HealthLog?sort=semver&color=success" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Self--Hosted-yes-success" alt="Self-Hosted" />
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/MBombeck/HealthLog/pkgs/container/healthlog"><img src="https://img.shields.io/badge/GHCR-multi--arch-2496ED?logo=docker&logoColor=white" alt="GHCR" /></a>
</p>
```

## Out of scope

- Rewriting `docs.healthlog.dev` content (separate audit; outside repo).
- Producing the actual hero screenshot / OG image binary (asset creation, not code).
- Editing the live GitHub repo metadata (`description`, `topics`, `homepageUrl`) — flagged as `[hotfix-ready]`, awaiting maintainer command.
- CONTRIBUTING.md / SECURITY.md / CODE_OF_CONDUCT.md content review beyond presence check (all three present and structurally sound; no critical issues found).
- Release-note quality audit per release (CHANGELOG is comprehensive; the v1.4.34 entry reads well).
- E2E / integration test coverage of the docs links themselves.
