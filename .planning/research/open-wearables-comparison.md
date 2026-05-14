# Competitive Analysis — the-momentum/open-wearables vs HealthLog

**Date:** 2026-05-14
**Subject of analysis:** [the-momentum/open-wearables](https://github.com/the-momentum/open-wearables) @ tag `0.5.1` (release published 2026-05-08, repo `pushedAt` 2026-05-14)
**HealthLog baseline:** v1.4.25 develop, source-priority architecture + Withings full coverage + GLP-1 tracking landing in current wave
**Author:** research-agent for Marc, directive 2026-05-14
**License posture compared:** open-wearables MIT vs HealthLog AGPL-3.0

---

## Section 1 — What open-wearables is (in plain terms)

open-wearables is a **self-hosted developer platform** that aggregates wearable health data from multiple providers behind one unified REST API. It is explicitly framed as **infrastructure for other apps to build on**, not as a finished consumer experience. The GitHub description reads "Self-hosted platform to unify wearable health data through one AI-ready API" (source: `gh repo view the-momentum/open-wearables`).

**Maturity signals** (all from `gh repo view` 2026-05-14):
- Created 2025-10-30 — roughly 6.5 months old at the time of writing
- 1,665 stars, 268 forks, 134 open issues — strong early traction
- Latest release `0.5.1 - Oura & Strava Webhooks` on 2026-05-08, 13 releases total, still pre-1.0
- Primary language Python (FastAPI) with a sizeable TypeScript frontend (React + TanStack Router + Vite)
- License **MIT** (permissive — anyone can fork commercially, re-license, integrate into closed-source SaaS)
- Built by **Momentum** (themomentum.ai), an agency-style company — open-source as a top-of-funnel for paid engagement

**What it is, structurally:**
- A FastAPI backend with PostgreSQL + Redis + Celery for ingest workers
- A React dashboard frontend that shows the data it ingests
- A growing set of provider integrations: Garmin, Whoop, Polar, Suunto, Strava, Fitbit, Oura, Ultrahuman, Apple Health (HealthKit XML import + SDK push), Google Health Connect, Samsung Health (source: `openwearables.io/docs/llms.txt` summary + `repositoryTopics`)
- Native mobile SDKs for iOS (Swift), Android (Kotlin), Flutter, React Native — push-only, not full apps
- An **MCP server subdirectory** (`mcp/`) exposing the data via Model Context Protocol for Claude Desktop / Cursor — this is novel and worth attention
- Webhooks both **incoming** (provider → OW) and **outgoing** (OW → integrator's app)

**What it is not:**
- Not a finished consumer app — the dashboard is a developer portal, not Apple-Health-style polish
- Not bilingual (English only, no signal of localisation in the docs)
- Not opinionated about UX — it ships normalised JSON, callers render it
- Not AGPL — share-alike does not apply, downstream forks can stay closed

**Target user:** developer or vertical-SaaS founder who wants to ship a coaching app, clinical app, or workplace-wellness app and does not want to negotiate 9 provider OAuth contracts. Quantified-self self-hosters are a *secondary* audience that the README warmly waves at but the dashboard does not really court.

**Comparable position to HealthLog:** complementary problem, partially overlapping audience. HealthLog is the finished PWA the end-user logs into; open-wearables is the plumbing a developer would put behind a different finished PWA.

---

## Section 2 — Feature-by-feature comparison

Sources for HealthLog status: `.planning/v1425-handoff.md` (per directive), commit log on `develop`, `src/lib/sources/` priority architecture, `prisma/schema.prisma`.

| Capability | open-wearables status | HealthLog status | Verdict |
|---|---|---|---|
| Garmin Connect (OAuth) | Shipped, webhook-enabled (`0.5.1` release notes) | Not implemented | **Could borrow** |
| Whoop API | Shipped (issue #1009, #621, #930 reference Whoop endpoints) | Not implemented | **Could borrow** |
| Oura Ring | Shipped, webhook-enabled in `0.5.1` | Not implemented | **Could borrow** |
| Polar AccessLink | Shipped, OAuth + historical backfill (issues #610–#612, #790) | Not implemented | **Could borrow** |
| Suunto | Shipped (repo topic `suunto`) | Not implemented | **Should evaluate** |
| Strava | Shipped, webhook-enabled in `0.5.1` (issue #770 about date range) | Not implemented | **Could borrow** |
| Fitbit Web API | Shipped (issue #791 about webhook handler migration) | Not implemented | **Could borrow** |
| Ultrahuman | Shipped (multiple `ultrahuman`-labeled issues #663–#665) | Not implemented | **Should evaluate** |
| Apple HealthKit SDK push | Shipped via iOS Swift SDK (`mobile SDKs` section in docs) | **Planned for v1.5** (Apple Health passthrough) | HealthLog catching up |
| Apple Health XML import | Shipped, S3 presigned URL or direct upload (`llms.txt`) | Not implemented; Marc's v1.5 plan is SDK push not XML import | **Could borrow as fallback** |
| Samsung Health | Shipped via Android SDK | Not implemented | **v1.6+ candidate** |
| Google Health Connect | Shipped via Android SDK | Not implemented | **v1.6+ candidate** |
| Withings (BP, body comp, temp, SpO2, VO2 max, HRV, sleep) | **NOT supported** — no Withings in providers list or issues | **Shipping full coverage in v1.4.25** | **HealthLog stronger** |
| GLP-1 / medication / injection tracking | Not supported, no issue mentions | **Shipping in v1.4.25** with dose history, sites, plateau detection | **HealthLog stronger** |
| Blood pressure as first-class metric | Issue #576 "Body Metrics view only shows a fraction of stored body/vitals data" implies thin BP support | First-class with BD-Zielbereich UX | **HealthLog stronger** |
| CGM / glucose | Provider request only — issue #980 (Keto-Mojo) open and unactioned | Not supported either | **N/A — both gaps** |
| Source-priority architecture | Has it: `provider_priority.py` + `device_type_priority.py` models exist in `backend/app/models/` | Shipping in v1.4.25 (`src/lib/sources/`) | **Parity** |
| Webhook ingest (provider → us) | Shipped for Strava + Oura + Polar + Fitbit; issue #1011 expands `/list` `/renew` | Not shipped (HealthLog pulls Withings on a schedule + manual sync) | **Should evaluate** |
| Outbound webhooks (us → integrator) | Shipped — issue #985 about commit listener safety | Not applicable — HealthLog is the end-user app | **N/A — different domain** |
| AI Insights | Marketed as "natural language automations" — but labeled "coming soon" in landing copy | **Shipped, multi-provider (OpenAI / Anthropic / OpenAI-compatible local), evidence-grounded** | **HealthLog significantly stronger** |
| AI Health Assistant (chat) | "Coming soon" per docs landing | Shipped: Coach with research-driven prose, provenance | **HealthLog stronger** |
| MCP server | **Shipped** — top-level `mcp/` dir with FastMCP 2.14.2→3.2.3 (issue #1036), docs section dedicated | Not shipped | **Could borrow — high value** |
| Health Score | Shipped model `health_score.py` + issue #801 "Recovery Score by Open Wearables" | Shipped (live Health Score in v1.4.20) | **Parity** |
| Sleep stages timeseries | Shipped (issue #621 Whoop parity) | Shipped via Withings + Apple Health planned | **Parity** |
| Workout / activity ingest | Shipped (`workout_details.py` model, FIT file support draft in issue #953) | Limited (movement tracking exists; FIT not parsed) | **Could borrow** |
| GPS routes | Open issue #847 "missing GPS routes" — gap | Not implemented | **N/A — both gaps** |
| Women's health metrics | Feature request only — issue #991 open and unactioned | Not implemented | **N/A — both gaps** |
| Nutrition / calories intake | Feature request #1020 open, unactioned | Not implemented | **N/A — both gaps** |
| Bilingual EN/DE | Not supported | **Shipped** | **HealthLog stronger** |
| Doctor report / clinical export | Not advertised | **Shipped** | **HealthLog stronger** |
| Self-hosted Docker | Shipped, also "Railway in one click" | Shipped via Coolify | **Parity** |
| Multi-tenancy | Single-org by design (per home page copy) | Single-user (HealthLog target audience) | **Parity** |
| Native mobile SDKs (Swift/Kotlin/Flutter/RN) | Shipped, but push-only | iOS native app being built for v1.5 (full app, not SDK) | **Different strategy** |
| Apple Health passthrough as end-user PWA experience | Not the target shape | **v1.5 milestone** | **HealthLog uniquely positioned** |
| FIT-file parsing for granular workouts | Issue #953 in draft | Not implemented | **Could borrow** |
| Personal Records model | Shipped (`personal_record.py`) | Not first-class | **Could borrow** |
| Data archival / aggregation strategy | Shipped (`data_point_series_archive.py`, `archival_setting.py`, multiple open architecture issues #519 #542 #548) | Not implemented — HealthLog stores at native granularity | **Should evaluate at scale** |

---

## Section 3 — Patterns worth borrowing

### 3.1 MCP server as a first-class artifact
**Evidence:** top-level `mcp/` directory in the repo, dependency bump issue #1036 (`fastmcp 2.14.2 → 3.2.3`), dedicated docs section, "MCP for Claude Desktop and Cursor" sales pitch on the landing page.

What this gives users: ask Claude Desktop "how did I sleep last week?" and have it hit the local MCP server, query the user's own database, and answer with real data — no cloud LLM ever sees the timeseries.

- **User value:** very high for the quantified-self subset of HealthLog users. Matches Marc's "AI Insights are the differentiator" memory.
- **Implementability:** ~3 days. FastMCP-equivalent in TypeScript exists (`@modelcontextprotocol/sdk`). HealthLog already has authenticated read endpoints — wrapping them as MCP tools is mechanical.
- **Marc-Voice fit:** strong. Privacy-first (the LLM runs on the user's laptop or their own Claude account), self-hosted, multi-provider AI (any MCP-capable client works). Reinforces the "Marc's authorship" framing — feels like power.
- **Priority:** 🔴 **must — v1.5 or v1.4.26**

### 3.2 Inbound webhook handlers per provider
**Evidence:** `WebhookHandler` pattern surfacing in issues #790 (Polar), #791 (Fitbit), #985 (after_commit listener safety), #1011 (`/list` `/renew` endpoints).

Withings already supports notification callbacks. HealthLog currently relies on scheduled pull. Switching to inbound webhooks for Withings (and any future provider) reduces latency from "next sync interval" to "seconds after the measurement."

- **User value:** medium — a BP reading appearing on the dashboard 5s after measurement vs 30 min later. Real but not headline-grade.
- **Implementability:** 2–3 days for Withings. Re-usable pattern.
- **Marc-Voice fit:** good. Reduces "did my sync fail?" anxiety. No new vendor.
- **Priority:** 🟡 **should evaluate — v1.4.27 or v1.5**

### 3.3 Source/Provider priority as a model, not a constant
**Evidence:** `backend/app/models/provider_priority.py` AND `device_type_priority.py` — *two* dimensions of priority.

HealthLog's v1.4.25 source-priority architecture is a `src/lib/sources/` module (per `.planning/v1425-handoff.md`). open-wearables makes priority a **database row per user per provider per device type**, which means the user can say "trust Garmin watch for HR but trust Withings for body comp." Two-dimensional priority is more expressive than one.

- **User value:** medium-high once a user has 3+ sources. Today only power users have this many.
- **Implementability:** 1 week — schema migration + settings UI.
- **Marc-Voice fit:** strong — gives users control without surfacing complexity until they have enough sources.
- **Priority:** 🟡 **should evaluate — v1.5+ once Apple Health is in**

### 3.4 Apple Health XML one-shot import as a fallback
**Evidence:** `openwearables.io/docs/llms.txt` summary references "Apple Health XML import with direct upload or S3 presigned URL support."

HealthLog's v1.5 plan is live SDK push. But the XML export route lets users **try HealthLog before installing the iOS app** — they tap "Export Health Data" on iPhone, drop the zip into HealthLog's web upload, and see all their history in 60 seconds.

- **User value:** high — removes the chicken-and-egg of "install the iOS app to see data." Excellent acquisition tool.
- **Implementability:** 4–5 days. XML parsing well-trodden (multiple OSS libs).
- **Marc-Voice fit:** strong — privacy-first (file never leaves the box), self-hosted, no Apple account required.
- **Priority:** 🟡 **should evaluate — v1.5 launch as on-ramp**

### 3.5 Data archival/aggregation policy
**Evidence:** open issues #519 (Archive daily aggregation methods), #542 (multiple aggregation methods per series type), #548 (custom aggregation ranges), models `data_point_series_archive.py`.

HealthLog currently stores every Withings sample at native resolution. At 5-min HR cadence × 5 years that becomes a query-perf problem. open-wearables is wrestling with the same issue — worth tracking how they land before HealthLog has the same pain.

- **User value:** invisible until storage hurts. Then critical.
- **Implementability:** 1–2 weeks once needed.
- **Marc-Voice fit:** acceptable — invisible to user. Self-hosters with small boxes will notice.
- **Priority:** 🟢 **nice — v1.6+ watch their decisions**

### 3.6 Personal Records as a model
**Evidence:** `backend/app/models/personal_record.py`.

Tracking "longest run, lowest resting HR, max VO2" as first-class records (with timestamps + which-source + which-device) is a low-cost UX win. HealthLog currently shows trends but does not surface "you hit a PR today."

- **User value:** medium — a small dopamine hit, fits "Insights are the differentiator."
- **Implementability:** 3–4 days.
- **Marc-Voice fit:** good — fits Insights as a product.
- **Priority:** 🟢 **nice — v1.4.27 if time, otherwise v1.5+**

### 3.7 What I checked and did NOT find worth borrowing
- **Bluetooth / BLE / WebUSB direct device pairing:** open-wearables does not do this. All providers are via cloud APIs or platform SDKs. The "open-wearables" name implies more device-level openness than the code delivers.
- **Decentralized / Solid / PDS storage:** not in the repo. They store in Postgres like everyone else.
- **Hardware-driver plugin architecture:** integrations are Python modules under `backend/app/integrations/` (per default-Python module layout) — not a hot-loadable plugin system. Same model HealthLog uses for Withings.
- **Confidence intervals / data quality scoring:** not surfaced anywhere I could find.

---

## Section 4 — Where HealthLog already does it better

1. **AI Insights are real, theirs are vapor.** open-wearables marketing copy promises "natural language automations" and "AI Health Assistant" but the landing page and `llms.txt` both flag these as **coming soon**. HealthLog shipped multi-provider Insights (OpenAI + Anthropic + OpenAI-compatible local endpoints) in v1.4.20+ and has iterated through three hallucination-resistance generations.

2. **Withings depth.** open-wearables has zero Withings support — searched provider list in `repositoryTopics`, latest release notes, and issue label set. HealthLog's v1.4.25 ships **~19 Withings meastypes** including body composition, BP cuff, temperature, SpO2, VO2 max, HRV, sleep stages. For a user whose primary device is a Withings BPM Core + Body Scan, HealthLog is the only choice.

3. **GLP-1 / medication tracking.** Not in open-wearables' issue list under any spelling (`semaglutide`, `tirzepatide`, `glp`, `mounjaro`, `ozempic`, `wegovy`, `injection` — zero hits). HealthLog ships this in v1.4.25 with dose history, injection sites, plateau detection.

4. **Bilingual EN/DE.** open-wearables docs and UI are English-only. HealthLog ships German strings end-to-end with the umlaut-correctness directive enforced. For a Germany-anchored quantified-self user, this is decisive.

5. **Doctor report.** Not advertised on open-wearables. HealthLog ships a clinical export.

6. **AGPL stance.** HealthLog being AGPL-3.0 vs open-wearables MIT is a deliberate choice. The MIT licence is friendlier for Momentum's commercial-services flywheel (they can build paid forks). HealthLog's AGPL says "if you host this, your modifications come back." That matches Marc's branch-model and self-hosted ethos.

7. **The whole product is the app.** open-wearables is plumbing. The dashboard exists but is explicitly a developer portal (issue #840 "surface API errors with retry option across all user detail tabs" is the kind of thing that would have been caught by a designer at HealthLog months earlier). HealthLog ships UX-finished tiles, Insights cards, Coach prose, charts with Recharts visual identity.

8. **Privacy-first AI provider story.** HealthLog's local-endpoint support (OpenAI-compatible) lets users point Insights at an Ollama or vLLM box. open-wearables's "AI" is undisclosed cloud (or `coming soon`).

9. **PII-clean public artifacts.** Marc's directive to scrub user data from CHANGELOGs / release notes (memory: `feedback_no_pii_in_user_facing`) is a level of operational discipline open-wearables has not yet had to develop.

---

## Section 5 — Anything we hadn't considered

This is the highest-leverage section. Items here are *new concepts*, not just feature gaps.

### 5.1 Wearable providers we never named
HealthLog's roadmap is Withings → Apple Health → ???. open-wearables has actively engaged with at least these providers + community-requested ones (sources: `repositoryTopics`, latest release, open issues):

- **Shipped:** Garmin Connect, Whoop, Oura, Polar AccessLink, Suunto, Strava, Fitbit Web API, Ultrahuman
- **Community-requested in issues:** Eight Sleep (#999), Zepp/Amazfit (#684, #997), Hevy gym tracker (#697), Komoot (#733), RunKeeper/ASICS (#653), MyMojoHealth/Keto-Mojo glucose+ketones (#980), MapMyFitness/Under Armour (#1001), Google Health API (#1000), Sensr/Sensor Bio (#568)

The interesting ones for HealthLog: **Eight Sleep** (sleep + temperature), **Hevy** (strength training, complements Withings), **Strava** (the runner's social layer). Garmin/Whoop/Oura/Polar are the obvious tier-1 wearable expansion list HealthLog will be asked about within weeks of v1.5 launch.

### 5.2 Health-related data types we don't yet track
- **VO2 max trend** — open-wearables surfaces it from multiple providers. HealthLog ingests it via Withings in v1.4.25 but does not yet have a dedicated tile/trend.
- **Cycle (training-cycle) data** — issue #1008 "Cycle endpoint support for Whoop." HealthLog has no concept of "training cycle." Worth thinking about as overlay on the trends view.
- **Nap detection** — issue #780 (Garmin) and #530 (Garmin) — naps as a first-class object separate from main sleep. HealthLog treats sleep as one nightly block. Naps matter for shift workers and biphasic sleepers.
- **Respiration rate as timeseries** — issue #1030 "respiratory_rate timeseries returns 0 rows" implies they have the model, just buggy. HealthLog ingests it via Withings but does not present it.
- **Cadence (running, cycling)** — issue #541 "Add average cadence to workout details." Niche but quantified-self standard.
- **Derived TDEE** — issue #959 "derived daily TDEE metric, robust to missing basal energy." HealthLog has no calorie tracking and no derived energy model.

### 5.3 Architectural patterns we hadn't named
- **Per-user, per-provider, per-device-type priority** (vs HealthLog's single-axis priority).
- **Archive table separate from live `data_point_series`** — explicit hot/cold storage rather than waiting until the live table hurts.
- **`EventRecord` + `EventRecordDetail` model** — open-wearables represents workouts and sleep as `EventRecord` rows with detail rows. HealthLog has typed tables. The OW pattern is more flexible for ingesting "anything with a start, end, and bag of metadata" but less type-safe. Worth considering for FIT/GPX workout import without schema bloat.
- **Sentry integration in `backend/app/integrations/sentry.py`** — they ship error monitoring as a first-class concern. HealthLog has logging but not user-anonymous error telemetry.

### 5.4 UX patterns
- **`is_nap` flag on sleep records** (issue #938) — explicit nap modelling.
- **"Show source provider for OW (internal) scores"** (issue #983) — for derived metrics (Health Score, Recovery), surface *which inputs drove the calculation* so the user can debug a low score. HealthLog's Insights have provenance — but the Health Score itself is opaque. Worth opening it up.
- **Historical-sync status follow** (issue #788) — when a user connects Garmin, the historical backfill is long-running. The UI surfaces progress. HealthLog's Withings backfill currently has minimal feedback.

### 5.5 Community / governance patterns
- **Multiple `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `.cursor/` / `.windsurfrules` / `.aider.md` / `.coderabbit.yaml` files** at the repo root. They have invested heavily in AI-agent contribution support. HealthLog has `CLAUDE.md` in `.planning/` but not the broader multi-agent surface.
- **`good first issue` label cultivated for community contribution** — at least 8 currently open. HealthLog is a single-developer project so this is not yet applicable but signals "they want to be a community project."
- **Issue #998 "Prompt Inject attempt detected in Agents.md"** — they have been targeted by prompt-injection contributors. Marc should anticipate this as HealthLog's AI surface grows.

### 5.6 Privacy / storage patterns
- **S3 presigned URL upload** for large Apple Health XML zips — bypasses backend memory pressure. Useful pattern if HealthLog ever supports XML import.
- **Default docker-compose security gap** (issue #570 "Default docker compose exposes all internal ports") — useful precedent: HealthLog's Coolify default likely has similar quirks. Worth a security review pass before v1.5.

### 5.7 Things in their backlog they have NOT solved that we also have not
- GPS routes (#847)
- Women's health metrics (#991)
- Nutrition + macronutrients (#1020)
- CGM (#980)
- Hardware-level pairing (Bluetooth / WebUSB) — neither project tries

This is reassuring: both projects target cloud-API providers, not direct hardware. The "we should add BLE pairing" temptation is correctly resisted by both.

---

## Section 6 — Marketing / positioning learnings

**Their position:** "Open infrastructure for wearable-powered health products. One API. Self-hosted. AI-ready." (per `raw.githubusercontent.com` README fetch)

**Who they target:** developers and vertical-SaaS founders. The "self-hosted" framing courts quantified-self too, but the dashboard's developer-portal aesthetic and the SDK-heavy README copy reveal the real customer.

**Are they competitors?** **Mostly complementary, partially competitive.** They are competitors only on the narrow axis of "Marc the self-hoster who wants to see his Garmin data." They are complementary in that a HealthLog user with a Garmin watch could (in principle) run open-wearables alongside as a Garmin-pipe and ingest into HealthLog via webhook — though that is a Rube Goldberg setup.

**Audience HealthLog has not tapped (from their messaging):**
- **"Vertical-SaaS founders":** people building clinical / workplace-wellness / coaching apps. HealthLog's AGPL stance plus "finished product" stance means HealthLog cannot easily play this role — and that is fine.
- **"Connect once, ship everywhere":** the MCP angle, the SDKs, the "Claude Desktop integration." HealthLog has not even tried to position the MCP server it does not yet have. Once HealthLog ships MCP, the positioning angle "talk to your own health data without giving it to a cloud LLM" is a strong differentiator open-wearables is not occupying as visibly.

**Tone differences:** open-wearables is corporate-developer copy ("AI-ready API," "no manual infrastructure setup," "one API"). HealthLog's voice (per `feedback_marc_voice_english`) is closer to "this is mine, I built it, here is what it does for me." Marc's voice should not chase theirs.

**What their README does well that HealthLog's could learn from:**
- Above-the-fold "Get started in 60 seconds" with a single `docker compose up` block.
- Explicit provider matrix as a visual table.
- A clean Quickstart that names every default credential (which they then warn about changing).

---

## Section 7 — Concrete recommendations

### Pull into v1.4.26 (next polish wave)
- **🟢 Personal Records as a first-class concept.** New `personal_record` table, hook into Withings + (eventually) Apple Health ingest, surface a small "PR" badge on relevant trend tiles. 3–4 days. Adds dopamine to Insights without new infra.
- **🟢 Provenance on the Health Score.** Borrow open-wearables's "show source provider on internal scores" idea (issue #983). When a Health Score tile is tapped, show "Driven by: HRV (Withings) 40%, sleep (Withings) 35%, activity (manual) 25%." Aligns with HealthLog's existing Coach-provenance pattern.
- **🟢 Sentry-equivalent or self-hosted error capture** for self-hosters. GlitchTip or self-hosted Sentry, opt-in. Two-day spike to evaluate.

### Pull into v1.5 (iOS-launch-adjacent)
- **🔴 MCP server.** Single biggest positioning win. Ship `mcp/` package exposing read-only Insights + summary tools. Position as "ask Claude Desktop about your health data — without uploading it." 3–5 days. Aligns with AI-as-differentiator memory.
- **🟡 Apple Health XML import as on-ramp.** Even if the iOS SDK push is the long-term answer, the XML drop-zone removes the iOS-install gate for v1.5 day-one users. 4–5 days. Strong acquisition tool.
- **🟡 Inbound webhook for Withings.** Replace scheduled-pull with notification callback. ~3 days. Reduces "did it sync?" anxiety.
- **🟡 Two-dimensional source priority.** Once Apple Health lands, users will have ≥3 sources. Borrow `provider_priority` + `device_type_priority` split. 1 week.

### v1.6+ or never
- **🟢 Garmin / Oura / Whoop / Polar / Strava / Fitbit.** Each is 3–6 days of OAuth + sync + normalisation work. Pick *one* (probably Garmin or Oura based on the quantified-self market) for v1.6. Do not commit to a matrix — open-wearables already burns that maintenance cost.
- **🟢 Naps as first-class.** Schema and UI work. Wait for user demand.
- **🟢 Archival / aggregation tables.** Defer until query perf demands it. Watch how open-wearables solves issues #519 / #542 / #548 and learn from it.
- **🟢 FIT-file parser** for granular workouts. Niche until HealthLog has a Garmin-using audience.
- **❌ Multi-tenancy.** Both projects correctly avoid this. Stay single-user.
- **❌ Bluetooth / WebUSB direct pairing.** Neither project does this. Don't start.
- **❌ Becoming a developer platform.** open-wearables owns this niche. HealthLog should remain the finished product.

---

## Honest closing assessment

open-wearables is a **well-engineered young project with strong velocity and a clear (different) target customer**. It has more provider breadth than HealthLog and a few architectural patterns worth lifting (MCP server, two-dim source priority, inbound webhooks, personal records, XML import on-ramp). It does **not** yet have AI Insights that work, Withings, GLP-1, bilingual UX, doctor report, or the finished-product polish that defines HealthLog. It is not a HealthLog killer; in many ways it is a complement that validates HealthLog's category.

The biggest *new idea* worth borrowing is the **MCP server** — it is a uniquely strong fit with HealthLog's "AI Insights are the differentiator" identity and Marc's privacy-first stance, and open-wearables's lead on it is small enough to close within a single wave.

The biggest *positioning insight* is that the self-hosted-quantified-self market is converging on AGPL-or-MIT, Postgres-backed, Docker-deployed, multi-provider tools — and HealthLog's defensible moat is not provider count but **the finished-product UX + Marc's voice + AI Insights that ship rather than promise**.
