# Documentation Landscape — v1.4.37 research

**Date:** 2026-05-17
**Audience:** v1.4.37 marathon W8 (docs refresh) executor agents
**Scope:** the surface readers see — `README.md`, the `docs/` tree inside the
app repo, the `healthlog-landing` sister repo, and the `healthlog-docs`
sister repo (Starlight). Benchmark against six top-tier OSS projects.
Recommend the v1.4.37 docs refresh.

---

## Current state (HealthLog)

### The app repo (`MBombeck/HealthLog`)

**`README.md` (484 lines)** is content-rich and well-structured. It already
carries a hero block (logo + 6 badges + tagline + nav links), a "What it
is" paragraph, a 9-row **comparison table** vs Withings / Apple Health /
Oura / generic CSV, ~13 Key-Feature bullets (Apple Health import is in
there now, AI Coach is in there now), a 3-minute Quick Start with a four-
line `openssl rand` secret bootstrap, a Tech-Stack table, a Security &
Privacy bullet list, an Env-Var table, an ASCII source-tree, eight
collapsed `<details>` API-reference sections, an Integrations table, a
Local-Dev section, a Deployment paragraph, and a Contributing pointer. It
looks like a thought-through README. **What it's missing** vs the next
tier: a dashboard hero screenshot above the fold, an AI Coach screenshot,
an Apple Health import GIF / screenshot, no "How it works" architecture
diagram, no roadmap/status section, no sponsor / community links beyond
GitHub.

**`docs/` (13 entries):**
- `api/` — `openapi.yaml` (the iOS-codegen-locked subset, 14 paths,
  v1.4.23 sentinel) + `openapi-v1422-legacy.yaml` (broader 122-path
  pre-iOS snapshot, no README pointer) + a short `README.md`.
- `integrations/` — three new files landed this week:
  `ai-providers.md`, `apple-health.md`, `withings.md` (each 8–11 KB).
- `self-hosting/` — `getting-started.md`, `reverse-proxy.md`, `scaling.md`
  (the last is the strongest single file in the tree).
- `ops/` — `backup-restore.md`, `encryption-key-rotation.md` (the best
  file in the tree), `v141-followup-issues.md` (stale v1.4.1 backlog),
  `migrations/` subfolder.
- `migration/v1.3-to-v1.4.md` — operator upgrade notes.
- `audit/` — 24 per-release `v14XX-summary.md` audit summaries. Forensic
  archive, not user-facing.
- One-offs: `apple-store-connect-checklist.md`, `codex-protocol-spec.md`
  (1300-line reverse-engineered ChatGPT-codex protocol), `doctor-report.md`,
  `ui-guidelines.md`.
- `README.md` — points readers at `docs.healthlog.dev` and lists the
  subtrees.

**`.github/`:**
- `ISSUE_TEMPLATE/` — bug, feature-request, translation, plus a
  `config.yml`. Healthy.
- `PULL_REQUEST_TEMPLATE.md` — present, 1.4 KB.
- `dependabot.yml` — present.
- `workflows/` — 7 active (docker-publish, e2e, integration,
  no-todo-markers, post-publish-verify, security, dependabot-auto-merge).
- **Missing:** no `FUNDING.yml`, no `CODEOWNERS`, no
  `DISCUSSION_TEMPLATE/`, no `.github/SECURITY.md` (the root `SECURITY.md`
  serves this role, which is fine).

**Top-level docs:** `README.md`, `CHANGELOG.md` (299 KB),
`CONTRIBUTING.md` (8 KB), `CONTRIBUTING-AI.md` (13 KB — Marc's "no AI in
public artefacts" policy lives here), `CODE_OF_CONDUCT.md` (5 KB),
`SECURITY.md` (3 KB), `LICENSE` (AGPL-3.0), `AGENTS.md` (17 KB —
internal).

---

## Sister-repo landscape

Two public sister repos under `MBombeck`, both wired to the
`healthlog.dev` apex domain.

### `MBombeck/healthlog-docs` — the doc site

- Stack: **Starlight (Astro)**, deployed via Docker + nginx. Live at
  **<https://docs.healthlog.dev>**. The Astro config redirects `/` to
  `/getting-started/introduction`.
- Last commit: **2026-05-16** — `chore: bump image pin to v1.4.34`. The
  release-cadence chore commits prove this repo is on Marc's release
  loop already.
- Sidebar (from `astro.config.mjs`) — 10 sections:
  - **Getting Started** (4 pages: introduction, installation, quick-start,
    troubleshooting)
  - **Features** (12 pages: health-metrics, medications, notifications,
    ai-insights, integrations, mood-tracking, pwa-offline, doctor-report,
    gamification, achievements-hidden, export-import,
    dashboard-customization)
  - **Insights** (1 page: how-it-works)
  - **Dashboard** (1 page: comparison)
  - **Settings** (1 page: ai-providers)
  - **Configuration** (3 pages: environment-variables, admin-settings,
    monitoring)
  - **Architecture** (3 pages: overview, database, background-jobs)
  - **API Reference** (11 pages: overview, authentication, measurements,
    medications, mood, insights, notifications, integrations, admin,
    external-ingest, native-clients)
  - **Security** (2 pages: overview, self-hosting)
  - **Self-Hosting** (4 pages: docker, reverse-proxy, updates, scaling)
  - **Admin** (continued — truncated in fetch).
- Strongest file: `features/ai-insights.mdx` (22 KB — depth on the multi-
  provider chain is there).
- Weakest: `insights/how-it-works.mdx`, `dashboard/comparison.mdx`,
  `settings/ai-providers.mdx` — these one-page sections look like
  placeholders.

### `MBombeck/healthlog-landing` — the marketing landing

- Stack: **Next.js 16** + Tailwind + custom React components. Live at
  **<https://healthlog.dev>**. Components: `EcgMonitor`, `AppShowcase`,
  `DemoCredentials`, `TerminalBlock`, `HeroClient`. Dracula-palette
  (the same `#bd93f9` purple as the app).
- Last commit: **2026-05-16** — feat(ios) AASA, plus a flurry of
  Coolify deploy fixes (`--ignore-scripts`, `sharp`/`unrs-resolver`
  approval). Build pipeline currently churning.
- Pages: `/` (the hero), `/privacy`, `/support`,
  `.well-known/apple-app-site-association` (iOS Universal Links).
- Hero content (from `page.tsx`): 6 primary features (vitals, never miss
  a dose, AI insights, mood, doctor PDF, Withings sync) plus the
  `terminalCommands` self-host snippet. **Already aligned** with the AI-
  Insights-as-differentiator messaging — "every recommendation explains
  itself: data window, comparison, deviation, mini-chart, server-computed
  0–100 confidence score, ESH / ESC / WHO / DGE citation."

### Net of sister repos

The publishing surface is **three repos**: app (`HealthLog`), landing
(`healthlog-landing` → `healthlog.dev`), doc site (`healthlog-docs` →
`docs.healthlog.dev`). All three are Marc's, all three are public, all
three deploy via Coolify, all three are already at v1.4.34 sentinel.
**Cross-repo work for v1.4.37 is therefore tractable** — three repos, one
maintainer, one deploy story.

---

## Benchmark — what top OSS projects do

### Plausible Analytics (`plausible/analytics`)

- Hero: 140 px centered logo, then 4-link nav, then one tight tagline
  paragraph, then a **dashboard hero screenshot** (`.webp`, 1× width).
- 5 emoji-bulleted "Why Plausible" lines under the hero — each is a
  benefit phrase + a deep-link to a marketing page.
- Long-form "Why Plausible?" section (10 bullets, **bold-lead + body**).
- A "Why is X not free like Y?" head-on FAQ — directly addresses the
  buyer's objection.
- "Plausible Cloud vs Plausible CE" **comparison matrix** — 6 rows
  (infrastructure / release / premium / location / data portability /
  cost), each cell a paragraph, not just a checkmark.
- "Getting started" routes the reader to **the managed cloud first**, the
  CE install link second.
- Technology section: three lines (backend / databases / frontend).
- Contributors, Feedback & Roadmap (links to public board), License &
  Trademarks (explicit trademark notice).
- **Voice:** confident, mission-led, not afraid to say "we charge". Every
  bullet ends with a link out. **No screenshots beyond the one hero.**

### PostHog (`PostHog/posthog`)

- Hero: logo + 5 badges (contributors, PRs welcome, Docker pulls, commit
  activity, closed issues) + 6-link nav.
- **YouTube video thumbnail** as the hero visual (click-through to a 1-
  min product walkthrough).
- One-sentence positioning statement, then a **10-bullet feature list**
  where every bullet is a deep link.
- Table of Contents — typical for a long README. Sections: Getting
  Started / Setting Up / Learning More / Contributing / Open-source vs
  paid / Hiring.
- One-line **`curl | bash`** self-host (PostHog's signature).
- **SDK matrix** — 3-column table (Frontend / Mobile / Backend) with 12
  language deep-links.
- Recruiting pitch at the end ("If you read this far…").
- **Voice:** product-led, every link is a sale.

### Supabase (`supabase/supabase`)

- Hero: dual-mode logo image, then a **task-list** of features ("Hosted
  Postgres ✓", "Auth ✓", "Auto-generated APIs ✓" with sub-bullets), with
  each capability deep-linking to its docs.
- Dashboard hero screenshot below the task list.
- "Watch this repo" mini-howto with a GIF.
- **Architecture diagram (SVG)** under "How it works" — actually rendered
  in the README. This is the differentiator: Supabase visually proves it
  composes OSS primitives rather than building from scratch.
- Each component (Postgres, Realtime, PostgREST, GoTrue, Storage,
  pg_graphql, Kong) gets a one-line description + repo link.
- **Client-libraries matrix** — 6-column × 13-row table (lang × feature-
  clients), Official vs Community split.
- **Voice:** "we picked the right tool for each job" — humility + breadth.

### Cal.com / Cal.diy (`calcom/cal.com`)

- Hero: 2 callout admonitions (Warning + Tip — "use Cal.com for prod,
  Cal.diy for self-host"), then logo + 6-line tagline + nav.
- 6 badges, then About / Built-With / Getting Started.
- Long Quick-Start with explicit `nvm`, `yarn dx` (containerised dev
  bootstrap with seed credentials printed), email/password/role table.
- **Voice:** practical, defensive about commercial use, lots of "if you
  run into X" hand-holding.

### Excalidraw (`excalidraw/excalidraw`)

- Hero: dark/light **GitHub-cover-image-as-banner** (full-bleed
  illustrated cover, custom artwork, hosted on DigitalOcean Spaces).
- 4-link nav, 1-sentence pitch ("hand-drawn style whiteboard,
  collaborative, end-to-end encrypted").
- 6 badges (license / npm / PRs / Discord / DeepWiki / Twitter).
- **Big product-showcase image** centered with `<figure>` + `<figcaption>`.
- 14-emoji feature bullet list — emoji-led, short body each.
- Quick-Start is npm-package-install only (it's a component library).
- **"Who's integrating Excalidraw"** name-drop section (Google Cloud,
  Meta, CodeSandbox, Replit, Notion, Slite, HackerRank) — proof at
  scale.
- Open Collective sponsor wall.
- **Voice:** playful, visual-first, the README itself is a demo of the
  product's aesthetic.

### Outline (`outline/outline`)

- Hero: dual-mode logo (29 px), one-italic-line pitch, **screenshot
  (1640 px wide)**, 4 small badges.
- Hard "this is the source code; you don't need to run it" framing —
  routes most readers to the SaaS, doc-routes the self-hosters.
- Explicit **"do not submit AI-generated pull requests"** policy in
  Contributing — uncommon, increasingly relevant.
- Sections: Installation / Contributing / Development / Architecture /
  Debugging / Tests / Migrations / Activity / License.
- **Activity widget** (Axiom repobeats SVG embed) — visual social proof
  of commit cadence.
- **Voice:** maintainer-protective, terse, doc-routes aggressively.

### Immich (`immich-app/immich`) — closest peer to HealthLog

- Hero: license badge + Discord badge for-the-badge style + centered
  logo + one-line H3 tagline + **full-width screenshot**.
- **19 language flags as inline translation links** to the same README in
  19 locales. (HealthLog is EN/DE today — 4–6 locales planned per
  v1.4.27 W9e translations work.)
- 3-2-1 backup admonition before anything else (genre-appropriate
  warning).
- 6-link nav.
- **Demo block** with hosted demo URL + working credentials in a table.
- **Feature matrix: 28 rows × 2 columns (Mobile / Web)** — at-a-glance
  parity grid. This is the format that says "we ship".
- Translation status badge from Weblate.
- Repobeats activity widget.

### Cross-cutting patterns the winners share

1. **Above-the-fold visual.** Every winner shows a screenshot, video,
   or rendered diagram in the first viewport. HealthLog README has none.
2. **Capability matrix.** Either a competitor comparison (Plausible,
   HealthLog already has one) or a platform-parity grid (Immich) or a
   client-library grid (Supabase, PostHog). The matrix is the readable
   shortcut to "what does this thing do".
3. **Concrete deep-links.** Every feature bullet should link to either a
   docs page, a feature page on the marketing site, or a relevant code
   path. Plausible / PostHog / Supabase do this religiously.
4. **One-line self-host.** PostHog's `curl | bash` is the most copied
   pattern. HealthLog's three-line `openssl rand` + `docker compose up`
   is already very competitive; promoting it earlier wins.
5. **"How it works" architecture.** Supabase renders an SVG; PostHog
   uses a video; Cal.com hand-holds. HealthLog has an ASCII tree —
   useful for contributors, opaque for evaluators.
6. **Voice & licensing clarity.** Open-source-with-cloud-add-on (PostHog,
   Plausible, Supabase, Outline) is the dominant business model and the
   READMEs are honest about it. HealthLog has no commercial add-on; the
   "self-hosted, AGPL, AI-Insights-you-own" framing should be the
   counter-positioning.

---

## Gaps in HealthLog docs today

Distilled from `.planning/round-audit-docs-depth.md` and
`.planning/round-audit-docs-discoverability.md` (the two audits already
in this marathon's prerequisite reads), plus the benchmark above.

**README:**
1. **No hero screenshot.** Logo + badges + paragraphs only until line 80.
   Plausible / Immich / Outline / Excalidraw / Supabase / PostHog all
   lead with a visual.
2. **No AI-Coach screenshot.** Marc-stated differentiator buried in one
   bullet at line 81. Needs the front-page hero treatment that the
   landing page already gives it.
3. **No "How it works" diagram** for the data flow that distinguishes
   the product (Withings + Apple Health export → rollups → Insights +
   Coach).
4. **No iOS row** in the Tech Stack table — repo carries the iOS
   handoff brief and the AASA route; visitors don't learn there's a
   native client coming.
5. **No Roadmap / Status section** linking to v1.5 (iOS) commitment.
6. **No screenshots gallery** — six screenshots (dashboard, insights,
   Coach, doctor PDF, mobile PWA, admin status grid) would round out
   "this product is real".
7. **No `FUNDING.yml`.** Sidebar Sponsor button absent.
8. **GitHub repo metadata gaps** flagged in the discoverability audit
   (description length, homepage URL, social preview image, topics) —
   all hotfix-ready.

**Doc site (`docs.healthlog.dev`):**
9. **Placeholder one-pagers.** `insights/how-it-works.mdx`,
   `dashboard/comparison.mdx`, `settings/ai-providers.mdx` each sit
   alone in their section — they need either depth or merge into
   neighbours.
10. **No source-priority page.** APPLE_HEALTH ≻ WITHINGS ≻ MANUAL ≻
    IMPORT ordering, the two-axis device-type extension (v1.4.25 W8c),
    `User.sourcePriorityJson` override — none surfaced. Critical for
    Apple Watch + iPhone + Withings users who'll see triple-counted
    steps.
11. **No cache/invalidation page.** v1.4.34.1 closure flagged this.
    `cache.<name>.outcome` wide-event annotations are observable but not
    documented.
12. **No Coolify runbook.** Self-hosters using Coolify (Marc's own
    deploy stack) hit the `pull_policy: always` stale-digest gotcha,
    the host-side retag fallback, the deploy-webhook secret. All only
    in audit prose.
13. **Apple Health export-zip flow** is only documented in
    `docs/integrations/apple-health.md` in the app repo (new this
    week); the doc site has no parallel page yet.
14. **No diagrams.** Starlight supports `@astrojs/markdoc` and inline
    SVG; doc site is text-only today.
15. **No Excalidraw/Mermaid renders.** Architecture section is three
    short pages without a single diagram.

**Landing page (`healthlog.dev`):**
16. **No "How it works"** flow diagram. Hero features list is strong;
    the architecture story is missing.
17. **No live numbers** — supported metrics count, integration count,
    doc-tree size — the kind of "we ship" stats Immich / Supabase put on
    their landing.
18. **No comparison-table** parity with the README. The 9-row table is
    the highest-converting block; landing should mirror it.

---

## Recommendation for v1.4.37 documentation refresh

**Branding:** keep the Dracula palette, the existing logo, the hand-drawn
ECG monitor, the existing English-first / German-secondary tone. No
rebrand; this is a depth-and-coherence pass.

### W8a — README rewrite (single agent, in `MBombeck/HealthLog`)

Order of operations:

1. **Above-the-fold hero image** — add `public/screenshots/hero-dashboard.webp`
   (2× retina) referenced as a centered `<img width="900">` right after the
   tagline, before the badge block. Use demo-tenant screenshot, no PII.
2. **AI Insights mini-hero** — promote AI Coach / Health Score / Briefing
   into a dedicated section between "Why HealthLog?" and "How it
   compares". One 800-wide screenshot of a real Coach reply with cited
   measurements.
3. **Apple Health import bullet** — already in the Key Features list as
   "**Apple Health import**" (line 79). Tighten to a 3-line block with a
   GIF (`public/screenshots/apple-health-import.gif`) showing the upload
   → progress → done flow.
4. **"How it works" diagram** — Excalidraw SVG embedded inline, placed
   between "Tech Stack" and "Security and Privacy". See the diagram
   proposals below.
5. **Add iOS row** to Tech Stack: "iOS client | SwiftUI · separate repo
   in active development (v1.5)".
6. **Add Roadmap section** — three lines linking to `.planning/v15-strategic-plan.md`
   or the future roadmap page on the docs site. Frame as "v1.4.x = web
   maturity, v1.5 = iOS sole-focus".
7. **Trim the README API table** (`README.md:240-386`) — keep the 8
   most-asked endpoints inline, link to `docs/api/openapi.yaml` and the
   `docs.healthlog.dev/api/*` pages for the full reference.
8. **Footer:** add a Sponsor link and the Discussions link once enabled
   (W9 will set them up).

Target length: ~600 lines (currently 484). No PII. Marc-Voice English.

### W8b — Landing page update (single agent, in `MBombeck/healthlog-landing`)

1. **Mirror the README comparison table** as a styled `<table>` on the
   landing page — same 9 rows, the same column set. This is the highest-
   converting block on the README and should be on the landing too.
2. **"How it works" section** — same Excalidraw SVG as the README, with
   a 60-word caption. Place between "AI insights" and "Privacy checklist".
3. **iOS preview teaser** — once iOS hits TestFlight, swap in a phone
   mockup. For v1.4.37 ship: a "Native iOS app — coming v1.5" callout
   under the App Showcase, with a TestFlight signup mailto link.
4. **Live demo CTA hardening** — `DemoCredentials` already exists; make
   sure it works (demo tenant healthcheck), and surface the credentials
   inline rather than on hover.
5. **Privacy / data-policy page** — Plausible's `/data-policy` is the
   reference. The landing already has `/privacy`; expand it to spell out
   exactly what leaves the device when each integration is enabled
   (Withings ↔ Withings cloud, AI BYOK ↔ OpenAI/Anthropic/local, etc.).

### W8c — Doc site refresh (single agent, in `MBombeck/healthlog-docs`)

1. **Promote the new integration docs** from the app repo. The three
   pages that landed in `docs/integrations/` this week (apple-health.md,
   withings.md, ai-providers.md) should be mirrored into
   `src/content/docs/features/` (or moved into a new
   `src/content/docs/integrations/` section). They are the strongest
   user-facing material the project has — they belong on the public doc
   site.
2. **Fill the placeholder pages** — `insights/how-it-works`,
   `dashboard/comparison`, `settings/ai-providers`. Each needs 800–1200
   words of depth. The `ai-insights.mdx` page (22 KB) is already the
   strongest in the tree; mine it for content to expand the placeholders.
3. **Add the missing concept pages** — source-priority, cache & invalidation,
   security-model. Cross-link from the integration pages.
4. **Add Coolify self-hosting page.** `pull_policy: always`, host-side
   retag fallback, deploy-webhook secret, "watch image registry for new
   digests" toggle. Audit-trail material lifted from
   `docs/audit/v1423-summary.md`, `docs/audit/v1421-summary.md`,
   `docs/audit/v1414-summary.md`.
5. **Add Excalidraw diagrams** to the Architecture section (3 pages
   currently text-only). See proposals below.
6. **Set up `lastUpdated: true`** is already on. Add a small "Edit on
   GitHub" footer link (Starlight has `editLink` enabled already at
   `https://github.com/MBombeck/healthlog-docs/edit/main/`). Make sure
   every page has it.
7. **Bump OpenAPI sentinel** to v1.4.37 in `docs/api/openapi.yaml` so
   the version drift flagged in the depth audit closes.

---

## Concrete diagram proposals

Five Excalidraw diagrams, ranked by "I-get-this" leverage. Each should
ship as an SVG export checked into the relevant repo. Use the Dracula
palette (`#bd93f9`, `#8be9fd`, `#50fa7b`, `#ff79c6`, `#ffb86c`) for
nodes, the same hand-drawn style as the landing's `EcgMonitor`.

### Diagram 1 — Data flow: device → rollup → insight

**Where:** README "How it works" section + doc site
`architecture/overview.mdx` + landing "How it works" section. Highest-
leverage diagram in the project.

**Content:** five lanes left to right:
- **Sources** (top-down): Withings devices, Apple Health export.zip,
  iPhone HealthKit batch (iOS app), manual entry, moodLog.app webhook.
- **Ingest**: `/api/measurements/batch`, `/api/import/apple-health-export`,
  `/api/withings/webhook`, dedup + source-priority resolver.
- **Storage**: Postgres `Measurement` + `MeasurementRollup` (DAY/WEEK/
  MONTH buckets).
- **Reads**: rollup probe → live SQL fallback → cache.
- **Surfaces**: Dashboard tiles, Insights cards, Coach answers, Doctor
  PDF.

**Why it lands:** answers "what does this thing do with my data" in one
glance. Replaces three paragraphs of text.

### Diagram 2 — Coach prompt pipeline

**Where:** doc site `features/ai-insights.mdx` + `insights/how-it-works.mdx`
+ landing AI section.

**Content:** user question → snapshot builder (last-N days metrics +
medication + mood) → prompt assembler (system prompt + locale + citation
schema) → provider chain (BYOK OpenAI / Anthropic / Codex / Local with
fallback arrows) → response parser (extract claims + citations) → cited
reply rendered with mini-charts.

**Why it lands:** Marc-stated differentiator is "AI Insights are
visually grounded and cite their evidence." The diagram is the proof
that the project actually does this rather than just calling an LLM.

### Diagram 3 — Self-hosting topology

**Where:** doc site `self-hosting/docker.mdx` and a new
`self-hosting/coolify.mdx`, plus README's deployment section.

**Content:** internet → reverse proxy (Caddy / Traefik / Nginx) →
Next.js app (port 3000) → Postgres + pg-boss workers. Side: GHCR pulls
image, Coolify watches digest, optional S3-compatible backup target.
Two pull-policy notes (`always` for autodeploy, `if-not-present` for
locked deployments).

**Why it lands:** new self-hosters are reading the README to evaluate
"can I run this on my Synology / homelab / VPS?" The diagram answers
"yes, here's what the box plan looks like."

### Diagram 4 — Source-priority ladder

**Where:** new doc-site page `concepts/source-priority.mdx`.

**Content:** a metric (steps) flowing in from three sources
simultaneously: Apple Watch (HK), iPhone (HK), Withings BPM 8 (Wifi
gateway). Per-day picker selects highest-priority source per day with a
swimlane showing the "kept in audit, dropped from aggregation" split.
Side box: per-user override JSON.

**Why it lands:** the single most-likely "why is my data wrong" support
question. The diagram disarms it before it's asked.

### Diagram 5 — Security model

**Where:** doc site `security/overview.mdx`, landing privacy page.

**Content:** three concentric boxes — passkey/password auth → server-
side session (HttpOnly cookie / Postgres-backed sessions) → encrypted
secrets at rest (AES-256-GCM with versioned key prefix). Side arrows
for: rate limiter, audit log, HMAC API tokens (`hlk_*` Bearer), CSP +
HSTS, the SSRF-guarded test endpoints.

**Why it lands:** "your data stays yours" is the brand promise.
Visualising the layers turns the marketing claim into a verifiable
architecture statement.

---

**Length check**: ~2350 words.
