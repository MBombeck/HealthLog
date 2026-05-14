---
file: README.md
purpose: Navigation map for the v1.5 iOS handoff doc-pack — what each file is for, which order to read in, and which questions map to which file
when_to_read: First. Always. Before opening any other file in this directory.
prerequisites: none
estimated_tokens: ~1800
version_anchor: v1.4.25 / sha 49f71c92
---

## TL;DR

This doc-pack is the v1.4.25 contract handoff for the v1.5 iOS native app. Start with `00-philosophy.md` if you have never touched the codebase before. Skip to `03-api-contracts.md` if you only need an endpoint shape.

The pack is twenty-one files split across four authors (A through D) plus a final cross-link pass (E). Files prefixed with the same digit form a thematic cluster (00–03 foundation, 04–05 data and auth, 06–08 UI and state, 09–11 AI). Each file is self-contained: read one in isolation and the YAML frontmatter tells you what context to pre-load.

## Inventory

| File | Owner | Purpose | ~Tokens |
| --- | --- | --- | --- |
| `README.md` | A | This file. Navigation map. | 1800 |
| `00-philosophy.md` | A | Why-questions — every load-bearing project decision and the reasoning behind it | 3000 |
| `01-repo-tour.md` | A | `src/` layout, where to find migrations / messages / e2e / planning artifacts | 3000 |
| `02-server-architecture.md` | A | Backend services — Next.js, Prisma, pg-boss queues, cron jobs, Coach + Insights module structure | 5000 |
| `03-api-contracts.md` | A | Every HTTP endpoint iOS will call, with Zod schema excerpts, rate limits, error codes, and curl self-tests | 8000 |
| `04-data-model.md` | B | Prisma schema reference — every table iOS touches, every enum, every composite index | 5000 |
| `05-auth-flows.md` | B | Session cookie vs Bearer vs refresh token, passkey + password + native-client paths, scope rules | 4000 |
| `06-ui-conventions.md` | C | Component primitives, shadcn/ui style, Dracula tokens, Recharts decisions, full-width grid rule | 3000 |
| `07-state-management.md` | C | TanStack Query keys, mutation invalidation, idempotency-key wiring, optimistic-update playbook | 3000 |
| `08-locales-i18n.md` | C | Six-locale matrix, message-key hygiene, Coach native-prompt locale routing, maintainership banner | 2500 |
| `09-recommended-flow.md` | C | How to build a feature end-to-end — the proven order across this codebase | 2500 |
| `10-coach-pipeline.md` | D | Coach snapshot + prompt + provider chain + refusal + budget + KEYVALUES sentinel | 5000 |
| `11-insights-pipeline.md` | D | Insights generation, strict schema, per-status caching, comparison snapshot | 4000 |
| `12-ai-providers.md` | D | Provider routing — Anthropic, OpenAI, Codex (ChatGPT), local — and failover rules | 3000 |
| `13-medical-content.md` | D | MDR boundary, GROUND RULES, refusal probes, citation surfacing | 3000 |
| `14-glp1-surfaces.md` | D | GLP-1 specialist endpoints, treatment-class flag, pen inventory, side-effect taxonomy, drug-level Research Mode | 4000 |
| `15-withings-bridge.md` | B | Withings OAuth, webhook subscription, activity + sleep v2 sync, scope upgrade banner | 3500 |
| `16-health-score.md` | D | Health Score component derivation, provenance accordion, four-component scoring | 2000 |
| `17-personal-records.md` | D | PR detection worker, push opt-in, warmup gate, trend-badge contract | 1500 |
| `18-onboarding.md` | C | Nested-route wizard, step state machine, race-safe step advance | 1500 |
| `19-deploy-runtime.md` | A | Coolify config location, GHCR multi-arch image, environment variables, secret rotation | 2500 |
| `20-cross-link-index.md` | E | Master question-to-file map, stop-here markers, and Wave-4-5 diff summary against v1.4.24 | 3500 |

## Question → File (seed; Agent E finalises)

| Question | File |
| --- | --- |
| "Which auth method should iOS use?" | `05-auth-flows.md` |
| "How do I post a HealthKit batch?" | `03-api-contracts.md` § Measurements |
| "What does a workout DTO look like?" | `03-api-contracts.md` § Workouts |
| "Why is the Coach chat SSE instead of one-shot JSON?" | `10-coach-pipeline.md` |
| "Why six locales?" | `08-locales-i18n.md` and `00-philosophy.md` |
| "What is the MDR boundary?" | `13-medical-content.md` |
| "What is `treatmentClass = GLP1`?" | `14-glp1-surfaces.md` |
| "Why Postgres and not SQLite?" | `00-philosophy.md` |
| "Where do feature flags live?" | `02-server-architecture.md` |
| "What is the develop → main branch model?" | `00-philosophy.md` |

(Agent E expands this to a 50+ row decision tree.)

## Reading orders by goal (seed; Agent E finalises)

| Goal | Order |
| --- | --- |
| First-time read, build mental model | 00 → 01 → 02 → 04 → 05 → 03 |
| Wire HealthKit batch ingest | 05 → 04 → 03 § Measurements → 03 § Workouts |
| Build the Coach drawer | 10 → 12 → 13 → 03 § Coach |
| Build the dashboard | 02 → 03 § Dashboard → 06 → 07 → 16 |
| Build GLP-1 surfaces | 14 → 04 → 13 → 03 § Medications |
| Set up Withings reconnect | 15 → 03 § Withings → 04 |
| Onboarding flow | 18 → 03 § Onboarding |
| Set up CI / Coolify | 19 → 01 |

## Stop-here markers index (Agent E finalises)

Every file carries `STOP HERE if …` markers so a narrowly-scoped reader can exit early. Agent E will publish the master index here once A–D files land.

## Marathon-pattern handoff section

Detail in `09-recommended-flow.md`. The pattern this server-side codebase uses for feature delivery (parallel sub-agent waves, decision-relay communication, quality gates) maps cleanly onto a Swift app — Agent E cross-links there.

## Conventions in this pack

- YAML frontmatter on every file — read it.
- TL;DR at the top of every body — 2-3 sentences, before any H2.
- Tables and decision trees outrank prose.
- Code excerpts use `// from path:line` headers — copy-paste-ready.
- `Since v1.4.24` diff markers flag Wave-4-5 additions iOS-Claude familiar with the previous baseline can fast-skim.
- English, terse, professional. No emojis.

## Version anchor

Every file in this pack is locked to **v1.4.25 / sha 49f71c92**. If you read a file and your local code differs from the cited excerpt, you are on a different version — check `git log` for the sha first, do not assume the doc is wrong.

## Cross-link tables (Agent E finalises)

After Agents B / C / D land their files, Agent E will populate:

- Master question → file decision tree (50+ rows)
- Stop-here-marker master index
- Wave-4-5 diff table against v1.4.24
- Reading orders by goal (expanded to 15+ scenarios)

Until E lands, treat the seed tables above as the working draft.
