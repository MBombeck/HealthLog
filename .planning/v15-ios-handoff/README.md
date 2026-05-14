---
file: README.md
purpose: Navigation map for the v1.5 iOS handoff doc-pack — what each file is for, which order to read in, which questions map to which file, and the master stop-here index.
when_to_read: First. Always. Before opening any other file in this directory.
prerequisites: none
estimated_tokens: ~2400
version_anchor: v1.4.25 / sha 49f71c92
---

## TL;DR

HealthLog v1.4.25 is a Next.js + Prisma + Postgres health-data app with multi-provider AI insights and a strict Zod / OpenAPI contract surface. v1.5 is the native iOS app + deeper Apple Health integration; this doc-pack is the closed-loop handoff the iOS implementer reads before touching any code.

The pack is 21 files. Read `00-philosophy.md` first if you have never touched the codebase. Skip to `03-api-contracts.md` if you only need an endpoint shape. Skip to `08-locked-contracts.md` if you only need to know what cannot change. Every file carries YAML frontmatter (`prerequisites`, `when_to_read`, `estimated_tokens`) and at least one "STOP HERE if…" marker so you can lookup-and-exit.

## Inventory

| File | Owner | Purpose | ~Tokens |
| --- | --- | --- | --- |
| `README.md` | E | This file — navigation map | ~2400 |
| `00-philosophy.md` | A | The ten load-bearing rules + every "why does HealthLog do X" answer | ~3000 |
| `01-repo-tour.md` | A | `src/` layout, migrations, locales, tests, CI, where-to-find table | ~3000 |
| `02-server-architecture.md` | A | Next.js + Prisma + pg-boss + multi-provider AI + Coach/Insights modules + source-priority + onboarding + PR detection + Withings | ~5000 |
| `03-api-contracts.md` | A | Every HTTP endpoint iOS will call, with Zod excerpts, rate limits, error codes, curl self-tests | ~8000 |
| `04-data-model.md` | B | Prisma schema reference — every table, every enum, every migration through 0060 | ~6800 |
| `05-auth-flows.md` | B | Native login, Bearer + rotating refresh, Keychain shape, passkey, Withings OAuth | ~3400 |
| `06-ios-responsibilities.md` | D | Five domains iOS owns — HealthKit, Keychain, APNs, offline cache, deep links | ~4500 |
| `07-server-responsibilities.md` | D | Twenty-two domains the server already handles — so iOS doesn't reinvent any | ~4500 |
| `08-locked-contracts.md` | B | GROUND RULES 1-15, batch shapes, source-priority two-axis, OpenAPI hard-flip, RESEARCH_MODE_DISCLAIMER_VERSION, refusal probes | ~4200 |
| `09-recommended-flow.md` | E | The iOS workflow recipe — first-time setup, contract-diff loop, Marathon-pattern, Quality Gate, mock vs live, gotchas | ~6000 |
| `10-research-pointers.md` | E | Cross-links to `.planning/research/` (Apple Health, GLP-1, wearables, W21 review notes) | ~3500 |
| `11-web-ui-tour.md` | C | Page-by-page web UI walkthrough so iOS can mirror layout + data deps screen-for-screen | ~7900 |
| `12-design-system.md` | C | Dracula tokens, mobile-first rules, chart hex literals, touch-target floor | ~5200 |
| `13-state-management.md` | C | TanStack Query keys, envelope unwrap, mutation invalidation, iOS analogues | ~4400 |
| `14-coach-mental-model.md` | D | Coach prompt builder, GROUND RULES, snapshot, refusal layers, SSE contract, evidence block | ~5200 |
| `15-insights-architecture.md` | D | Server-side Insight generation, per-page prompts, citation grounding, cache invalidation, dailyBriefing | ~4000 |
| `16-health-score-logic.md` | D | Four-pillar composite score, deterministic asOf, provenance accordion | ~2700 |
| `17-error-handling.md` | B | Envelope shape, status semantics, Idempotency-Key, rate-limit response, pg-boss DLQ, recent fixes | ~3000 |
| `18-pattern-cookbook.md` | C | Eight recipes — add route / migration / chart / Coach probe / locale key / CHANGELOG entry / helper / OpenAPI flow | ~6800 |
| `19-i18n-system.md` | C | Six-locale flat-file JSON, parity probe, maintainership banner, key naming | ~3100 |
| `20-glossary.md` | B | Alphabetical term reference with canonical-source pointers | ~2700 |

Total: ~89400 tokens / ~57000 words across 21 files.

## Question → File map

Real anchors against the final filenames.

| Question | File |
| --- | --- |
| Why a self-hosted Postgres instead of SQLite-on-device? | `00-philosophy.md` § Rule 9 |
| Why conservative semver (patch over minor)? | `00-philosophy.md` § Rule 1 |
| Why Marc-Voice in every artefact? | `00-philosophy.md` § Rule 2 + `09-recommended-flow.md` § 3.4 |
| Why Recharts and not Apple Charts? | `00-philosophy.md` § Rule 8 |
| Why six locales? | `00-philosophy.md` § Rule 4 + `19-i18n-system.md` |
| What's the develop → main branch model? | `00-philosophy.md` § Rule 5 + `09-recommended-flow.md` § 3.5 |
| Where does measurement source-priority live? | `08-locked-contracts.md` § 4 + `02-server-architecture.md` § Source priority |
| Where does the MeasurementType enum live? | `04-data-model.md` § 2.1 |
| How does the Coach refuse drug-level questions? | `08-locked-contracts.md` § 1.2 (GROUND RULE 15) + `14-coach-mental-model.md` § Refusal |
| How does the Coach refuse GLP-1 dose questions? | `08-locked-contracts.md` § 1.1 (GROUND RULE 9) + `14-coach-mental-model.md` |
| What is the MDR 2017/745 boundary? | `00-philosophy.md` § Rule 10 + `14-coach-mental-model.md` § MDR boundary |
| What is `treatmentClass = GLP1`? | `04-data-model.md` § 2.8 + `20-glossary.md` § GLP-1 |
| What's the APNs registration flow? | `06-ios-responsibilities.md` § Domain 3 + `02-server-architecture.md` § Notifications |
| What's the Withings OAuth flow? | `05-auth-flows.md` § Withings + `02-server-architecture.md` § Withings integration |
| What's the Withings webhook secret format? | `08-locked-contracts.md` § 8 |
| What's the deploy story (GHCR, Coolify, env vars)? | `01-repo-tour.md` § Coolify deploy config + `02-server-architecture.md` § Stack |
| Which auth method should iOS use? | `05-auth-flows.md` § 2 (native flow) |
| How do I post a HealthKit batch? | `03-api-contracts.md` § Measurements + `08-locked-contracts.md` § 2.1 |
| How do I post a workout batch? | `03-api-contracts.md` § Workouts + `08-locked-contracts.md` § 2.2 |
| What does a Coach SSE stream look like? | `14-coach-mental-model.md` § Evidence block + `03-api-contracts.md` § Coach |
| Why is the Coach chat SSE instead of one-shot JSON? | `14-coach-mental-model.md` § TL;DR + `09-recommended-flow.md` § 8.4 |
| How do I render the Health Score? | `16-health-score-logic.md` + `15-insights-architecture.md` |
| How does PR detection actually work? | `07-server-responsibilities.md` § Domain 4 + `.planning/research/w16c-pr-detection.md` |
| Which migrations affect iOS? | `04-data-model.md` § 6 (migrations 0051-0060) |
| What's the OpenAPI hard-flip gate? | `08-locked-contracts.md` § 3 + `09-recommended-flow.md` § 2 |
| What error codes can iOS expect? | `17-error-handling.md` § 2 + `03-api-contracts.md` § matching route |
| How does Idempotency-Key work? | `17-error-handling.md` § 3 + `09-recommended-flow.md` § 8.5 |
| How does rate-limiting work? | `17-error-handling.md` § 4 + `02-server-architecture.md` § Rate limits |
| What's the Coach prompt version? | `02-server-architecture.md` § PROMPT_VERSION + `08-locked-contracts.md` § 9.2 |
| What's `RESEARCH_MODE_DISCLAIMER_VERSION`? | `08-locked-contracts.md` § 6 + `09-recommended-flow.md` § 8.3 |
| How does TanStack Query keying work? | `13-state-management.md` § 1-2 |
| Why are charts colour-locked at specific hex values? | `12-design-system.md` § 1.4 |
| How do I add a new locale key? | `18-pattern-cookbook.md` § Recipe 5 + `19-i18n-system.md` |
| How do I add a new API route on the server? | `18-pattern-cookbook.md` § Recipe 1 |
| How do I run the dev server? | `01-repo-tour.md` § package.json scripts + `09-recommended-flow.md` § 1 |
| How do I issue an API token for the iOS Simulator? | `09-recommended-flow.md` § 1.3 |
| What's the v1.4.25 release inventory still pending in v1.4.26? | `10-research-pointers.md` § 4 + `.planning/phase-W21-reconcile-plan.md` |

## Reading-orders-by-goal

| Goal | Order | ~Tokens |
| --- | --- | --- |
| Cold-start (never seen this codebase) | 00 → 01 → 02 → 03 → 04 | ~25800 |
| Tag a v1.5.x release | 09 → 08 → 10 → `.planning/phase-W21-reconcile-plan.md` | ~14700 |
| Adding a new API client method | 03 → 04 → 17 → 18 | ~17800 |
| Adding a Coach feature | 14 → 15 → 08 → 18 | ~17200 |
| Adding an Insight tile | 15 → 14 → 13 → 12 → 11 § matching page | ~21500 |
| Apple Health sync work | 06 → 04 → 03 → `.planning/research/apple-health-ecosystem-scan.md` + `apple-health-sync-deep-dive.md` | ~22700 |
| Workout ingest work | 06 → 03 § Workouts → 08 § 2.2 → `.planning/research/w16b-workout-ingest.md` | ~14500 |
| GLP-1 work (CRITICAL — read `glp1-feature-inspiration.md` first) | 14 → 15 → 08 (GROUND RULE 9 + 15) → `.planning/research/glp1-feature-inspiration.md` | ~24400 |
| Pre-PR for any iOS work | 08 (locked contracts) + 17 (error contracts) | ~7200 |
| Designing any iOS screen | 11 § matching page → 12 → 13 → 19 (i18n) | ~20600 |
| Building the iOS Coach screen | 14 → 08 § 1 (GROUND RULES) → 18 § Recipe 4 (Coach probe) | ~16200 |
| Building Settings → Sources | 08 § 4 + `.planning/research/source-priority-two-axis.md` | ~7000 |
| Building Health Score tile | 16 → 15 → 04 § HealthScore | ~9700 |
| Wiring Withings reconnect | 05 § Withings → 02 § Withings + 08 § 8 | ~6200 |
| Wiring onboarding wizard | 02 § Onboarding wizard + 03 § Onboarding + `.planning/research/w14b-onboarding-rebuild.md` | ~12200 |
| Setting up CI / Coolify | 01 § Coolify + 02 § Stack + 09 § 7 (CI surfaces) | ~10000 |

## Stop-here-markers index

Every file carries at least one "STOP HERE if…" marker so a narrowly-scoped reader can exit early.

| File | What lives in the STOP HERE block |
| --- | --- |
| `00-philosophy.md` | When to skip philosophy and jump to API / data / Coach / chart |
| `01-repo-tour.md` | When to skip to API / data / dev server / deploy |
| `02-server-architecture.md` | When to skip to API / Coach / providers / Withings |
| `03-api-contracts.md` | When to skip to auth / data / medical / personal-records |
| `04-data-model.md` | "Legacy v1.4.24 columns" + "blind JSON.parse" inline warnings |
| `05-auth-flows.md` | When to skip to error envelopes / Codex OAuth |
| `06-ios-responsibilities.md` | "iOS should run its own AI / encrypt beyond token / write own validation" — don't |
| `07-server-responsibilities.md` | "iOS should recompute Health Score / poll Withings / fork i18n" — don't |
| `08-locked-contracts.md` | (Inline warnings throughout — every contract is a STOP HERE in itself) |
| `09-recommended-flow.md` | When to skip to endpoint / auth / 422 debug |
| `10-research-pointers.md` | When to skip to contract / Coach / W21 reconcile |
| `11-web-ui-tour.md` | "iOS wants to merge sub-pages / combine medication detail / skip onboarding / expose Research Mode without dialog" — don't |
| `12-design-system.md` | "Introduce a new colour outside the named tokens" — don't |
| `13-state-management.md` | "Use Apple's Localizable.strings" — don't (forks source of truth) |
| `14-coach-mental-model.md` | "iOS calls Anthropic / OpenAI directly / writes own system prompt / patches replies" — don't |
| `15-insights-architecture.md` | "iOS regenerates Insights on pull-to-refresh / locally summarises / calls LLM directly" — don't |
| `16-health-score-logic.md` | "iOS computes the score for performance / displays without provenance accordion" — don't |
| `17-error-handling.md` | "iOS polls for SSE chunks instead of native streaming" — don't |
| `18-pattern-cookbook.md` | Multiple inline STOP HERE markers per recipe |
| `19-i18n-system.md` | Inline warnings about `Localizable.strings` and per-locale subdirectory rebuild |
| `20-glossary.md` | (Glossary is itself a reference — no inline blocks) |

## Conventions in this pack

- **YAML frontmatter on every file** — read it before the body. `prerequisites` tells you what to pre-load.
- **TL;DR at the top of every body** — 2-3 sentences, before any H2.
- **Tables and decision trees outrank prose.**
- **Code excerpts use `// from path:line` headers** — copy-paste-ready, pinned to v1.4.25 sha.
- **"Since v1.4.24" diff markers** flag the additions vs the previous baseline so iOS-Claude familiar with v1.4.24 can fast-skim.
- **English, terse, professional. No emojis.**

## Version anchor

Every file in this pack is locked to **v1.4.25 / sha 49f71c92**. If you read a file and your local code differs from the cited excerpt, you are on a different version — check `git log` for the sha first, do not assume the doc is wrong.

## Marathon-pattern handoff

The iOS workspace inherits Marc's release-marathon conventions (parallel sub-agent dispatch on touch-disjoint surfaces, atomic commits, Marc-Voice, no `Co-Authored-By: Claude`, no `--no-verify`, develop→main via PR with Marc tagging). Detail in `09-recommended-flow.md` § 4.

## Cross-link audit

Every `<file>.md` reference in every sibling file resolves to a real file in this directory. Cross-link audit run in E-Closeout: 16 broken references found, all patched (mostly skeleton-era filenames that never landed; see commit log for the full list).
