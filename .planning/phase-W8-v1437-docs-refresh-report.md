# Phase W8 — v1.4.37 docs refresh — wave report

**Date:** 2026-05-17
**Branches:** `HealthLog/develop`, `healthlog-docs/main`, `healthlog-landing/main`
**Status:** Shipped. All three repos pushed.

---

## Summary by repo

### HealthLog (develop)

- `04aa2fc8` — `docs(diagrams): add five Dracula-styled architecture diagrams`
  - `docs/diagrams/01-data-flow.svg`
  - `docs/diagrams/02-coach-pipeline.svg`
  - `docs/diagrams/03-self-hosting-topology.svg`
  - `docs/diagrams/04-source-priority.svg`
  - `docs/diagrams/05-security-model.svg`
  - `docs/diagrams/README.md`

Net: **1 commit** authored by this agent. README rewrite proposed (How-it-works block, iOS tech-stack row, Roadmap section, deployment-diagram embed) landed transiently then was reverted by the user/linter; the diagrams themselves remain available under `docs/diagrams/` for any later README iteration. No tests touched; no `src/` or `prisma/` files touched.

### healthlog-docs (main)

- `f77cab0` — `docs(diagrams): add five architecture SVGs for embedding across pages`
- `9c5c258` — `docs(integrations): mirror Apple Health, Withings and AI-providers pages`
- `eae737d` — `docs: add source-priority concept, Coolify runbook, and embed diagrams`

Net: **3 commits**.

New pages:
- `src/content/docs/integrations/apple-health.mdx`
- `src/content/docs/integrations/withings.mdx`
- `src/content/docs/integrations/ai-providers.mdx`
- `src/content/docs/concepts/source-priority.mdx`
- `src/content/docs/self-hosting/coolify.mdx`

Page upgrades (each gains a diagram + a paragraph naming the mental model):
- `architecture/overview.mdx`
- `insights/how-it-works.mdx`
- `security/overview.mdx`

Sidebar wired in `astro.config.mjs` with two new sections (Integrations, Concepts) and the Coolify entry under Self-Hosting.

Diagrams: `src/assets/diagrams/01..05.svg`.

### healthlog-landing (main)

- `5d8bd20` — `feat(landing): add five architecture SVGs to public/diagrams`
- `1b5c291` — `feat(landing): add How-it-works and AI-Coach sections, fix Quick Start env`

Net: **2 commits**.

Two new full-bleed sections on `/`:
- **How it works** — embeds `01-data-flow.svg` with a 60-word caption plus three click-through cards (Apple Health, Withings, source-priority) that deep-link into the doc site.
- **AI Coach** — embeds `02-coach-pipeline.svg` with a four-provider card row (ChatGPT subscription, OpenAI BYOK, Anthropic, Local).

In-place upgrades:
- Privacy section now embeds `05-security-model.svg` with a caption + deep link to the doc-site security page.
- Quick Start section now embeds `03-self-hosting-topology.svg` beneath the terminal block.
- Primary feature cards refreshed to v1.4.36 reality: AI Coach is promoted to first-class, the rollup tier is named on the vitals card, Apple Health import moves into the secondary cards row alongside mood and doctor PDF.
- `terminalCommands` drops the obsolete `SESSION_SECRET` line so it matches the README's three required secrets exactly.
- Capability badges add **Persistent rollup tier for sub-second reads**.

Diagrams: `public/diagrams/01..05.svg`.

---

## Diagram summary

| File | What it shows |
| ---- | ------------- |
| `01-data-flow.svg` | Five-stage pipeline: sources (Withings, Apple Health export.zip, iPhone HealthKit, manual, moodLog) → ingest endpoints → Postgres `Measurement` + `MeasurementRollup` → rollup-probe / live SQL / cache reads → dashboard / Insights / Coach / doctor PDF surfaces. |
| `02-coach-pipeline.svg` | User question → snapshot builder → prompt assembler → provider chain (ChatGPT OAuth · OpenAI · Anthropic · Local · admin-shared) → Zod-validated response parser → cited reply with mini-charts. |
| `03-self-hosting-topology.svg` | Internet → reverse proxy (TLS) → Next.js app (port 3000) ↔ pg-boss worker ↔ PostgreSQL 16, plus GHCR pull, optional Coolify autodeploy with `pull_policy: always` callout, optional S3 off-host backup. |
| `04-source-priority.svg` | Three sources (Apple Watch HK, Withings, manual) all writing the same metric on the same day → resolver picks one canonical row per the cumulative-vs-point ladder. Losing rows stay in the audit-trail lane. |
| `05-security-model.svg` | Three concentric perimeters — auth (passkey + Argon2id fallback), session (HttpOnly cookie + Postgres sessions), encrypted core (AES-256-GCM versioned keys + HMAC token storage). Side rails for rate limiter, audit log, CSP/HSTS, SSRF guard, refresh-token rotation, off-host backup, per-user scope. |

All five are hand-authored Dracula-styled SVG (`viewBox="0 0 1200 620"`, ≤ 11 KB each), repo-versionable, no external dependencies. The Excalidraw MCP was inspected but its hosted-state output isn't a good fit for repo-committed assets; the SVGs match the same hand-drawn aesthetic.

---

## Build status

| Repo | Command | Outcome |
| ---- | ------- | ------- |
| HealthLog | n/a (no `src/` touched; tests not in scope) | clean — diagrams + commit landed before parallel-agent work piled up |
| healthlog-docs | `npm run build` | **green** — 51 pages built in 2.96 s; all five diagrams verified to render via Astro's asset pipeline (`/_astro/0X-…hash.svg` in the dist) |
| healthlog-landing | `pnpm build` + `pnpm lint` | **green** — Next 16 static build succeeds; one pre-existing `DemoCredentials` warning unchanged |

---

## Applied vs deferred

### Applied

- 5 diagrams in all three repos.
- 3 new Integrations pages on docs site (apple-health, withings, ai-providers).
- 1 new Concepts page (source-priority).
- 1 new Self-Hosting page (coolify).
- 3 page upgrades to embed diagrams (architecture/overview, insights/how-it-works, security/overview).
- Landing: 2 new sections (How-it-works, AI Coach) + diagram embeds in Privacy and Quick Start + primary-feature refresh + env-var cleanup.

### Deferred (deliberate)

- **README hero screenshot / Apple Health import GIF.** Not produced — would require taking new in-app captures of the live dashboard, and no demo-tenant browser environment was available within this session. The README's logo + badge block + AI-Coach-bullet-with-citation-language remains the above-the-fold visual.
- **README "How it works" / iOS row / Roadmap rewrite.** Authored, committed via parallel agent (f33c70b3), then reverted by user/linter back to the pre-W8 hero. Not re-attempted out of respect for the explicit revert.
- **OpenAPI sentinel bump.** Out of scope (`docs/api/` is the iOS-codegen-locked subset and gated by the OpenAPI pre-commit hook; bumps belong to release-prep, not docs refresh).
- **Doc site `editLink` confirmation per page.** Already enabled globally in `astro.config.mjs` at the repo-level; no per-page change needed.
- **`FUNDING.yml`, repo metadata, social preview image.** Marked in the research brief as W9 hotfix items; out of W8 scope.

### Open questions for Marc

1. **Landing copy positioning.** The new How-it-works and AI-Coach sections lean technical (citation schema, snapshot builder, provider chain). Compared to the existing primary-feature cards' "All vitals at a glance" tone, the diagrams + captions are a depth shift. If the bar is "developer-evaluator first, casual visitor second", the current balance is right; if the bar tilts more casual, the AI-Coach section's four-provider card row could be collapsed to a one-line "Multi-provider — see the docs" link.
2. **Diagram authorship signature.** Hand-authored SVG (not Excalidraw export). They share the Dracula palette of the existing `EcgMonitor` but are markedly more diagrammatic. If you prefer them moved into Excalidraw for future editability in the Excalidraw app, the diagram array in `docs/diagrams/README.md` is the canonical source — converting to Excalidraw JSON is a mechanical pass.
3. **README revert.** The diagrams landed in the HealthLog repo but the README "How it works" reference, iOS tech-stack row, and Roadmap section were reverted post-commit. The diagrams under `docs/diagrams/` are still discoverable; if you want any of them surfaced in the README later, the `<img src="docs/diagrams/01-data-flow.svg" width="900">` snippet is ready to drop in.

---

## Files this agent owns (touched in this wave)

```
HealthLog/
  docs/diagrams/01-data-flow.svg                 [new]
  docs/diagrams/02-coach-pipeline.svg            [new]
  docs/diagrams/03-self-hosting-topology.svg     [new]
  docs/diagrams/04-source-priority.svg           [new]
  docs/diagrams/05-security-model.svg            [new]
  docs/diagrams/README.md                        [new]
  .planning/phase-W8-v1437-docs-refresh-report.md [new — this file]

healthlog-docs/
  astro.config.mjs                               [modified]
  src/assets/diagrams/01-data-flow.svg           [new]
  src/assets/diagrams/02-coach-pipeline.svg      [new]
  src/assets/diagrams/03-self-hosting-topology.svg [new]
  src/assets/diagrams/04-source-priority.svg     [new]
  src/assets/diagrams/05-security-model.svg      [new]
  src/content/docs/architecture/overview.mdx     [modified]
  src/content/docs/insights/how-it-works.mdx     [modified]
  src/content/docs/security/overview.mdx         [modified]
  src/content/docs/integrations/apple-health.mdx [new]
  src/content/docs/integrations/withings.mdx     [new]
  src/content/docs/integrations/ai-providers.mdx [new]
  src/content/docs/concepts/source-priority.mdx  [new]
  src/content/docs/self-hosting/coolify.mdx      [new]

healthlog-landing/
  src/app/page.tsx                               [modified]
  public/diagrams/01-data-flow.svg               [new]
  public/diagrams/02-coach-pipeline.svg          [new]
  public/diagrams/03-self-hosting-topology.svg   [new]
  public/diagrams/04-source-priority.svg         [new]
  public/diagrams/05-security-model.svg          [new]
```

Zero touches under `src/app/api/analytics/`, `src/lib/analytics/`, `src/components/medications/intake-history-list-v2.tsx`, or `src/app/api/medications/[id]/intake/route.ts` (the four files reserved for other agents).
