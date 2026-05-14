---
file: 20-glossary.md
purpose: HealthLog-specific terms, abbreviations, and locked vocabulary. Short definition + cross-link to canonical source.
when_to_read: Whenever an unfamiliar term appears in another file. Skim once at the start of the project to seed vocabulary.
prerequisites: None.
estimated_tokens: 2700
version_anchor: v1.4.25 / sha 49f71c92
---

# Glossary — v1.4.25

> **TL;DR.** Alphabetical. Each entry: short definition + pointer to
> the canonical source file (code or doc-pack). German terms are
> flagged "[de]" — they exist for compatibility with Marc's internal
> framing only and stay out of public copy.

---

## A

**APNs** — Apple Push Notification service. HealthLog stores a per-
device APNs token in `Device.apnsToken` (with `apnsEnvironment` =
`sandbox | production`). Partial unique index on the column
(Migration 0041). See `Device` model in `04-data-model.md` §4.4.

**Apple Health** — Spelled `APPLE_HEALTH` everywhere in the schema,
NOT `HEALTHKIT`. The iOS DTO mirrors this spelling exactly. The
ingest path is `POST /api/measurements/batch` (Measurement) + `POST
/api/workouts/batch` (HKWorkout). See `04-data-model.md` §2.2,
`08-locked-contracts.md` §2.

**ApiToken** — Hashed Bearer token row (`ApiToken.tokenHash` =
HMAC-SHA-256). Permissions are an array of scopes; `["*"]` is the
wildcard the iOS app receives at login. See `05-auth-flows.md` §5.

**auditLog** — Append-only event log (`AuditLog` model). Every auth
action and side-effect-bearing API write writes one row. Geo-enriched
for `auth.*` actions only. See `17-error-handling.md` §6.

---

## B

**BD-Zielbereich [de]** — German-internal name for Marc's per-user
blood-pressure target zone (`User.thresholdsJson.BLOOD_PRESSURE_SYS`
+ `_DIA`). Not a public concept — never appears in CHANGELOG, GitHub
releases, docs site, or user-facing copy. UI surfaces it as
"target range" in EN and "Zielbereich" in DE. See
`feedback_no_pii_in_user_facing.md` in memory.

**Briefing** — Daily summary the user reads first thing. Distinct
from **Insight** (long-form chart-anchored analysis) and **Coach**
(conversational Q&A). All three live behind the Insights surface but
serve different needs. See `14-coach-mental-model.md`.

---

## C

**Coach** — Conversational AI assistant accessible from the floating
drawer (`/coach` route + drawer surface). Reads a snapshot of the
user's data, replies in warm conservative prose. Refuses GLP-1 dose
prescriptions (GROUND RULE 9) and drug-level estimates (GROUND RULE
15). See `08-locked-contracts.md` §1, `14-coach-mental-model.md`.

**Coach-Snapshot** — The structured JSON the Coach reads as its
single source of evidence. Built fresh per turn by
`src/lib/ai/coach/snapshot.ts`. Every number in a Coach reply must
come from a snapshot field (GROUND RULE 1, 7). The snapshot carries
metric aggregates, `timeline.recent` (14-day day-level), and
`timeline.weekly` (ISO-week buckets for older days), plus optional
`weeklyContext.glp1` for GLP-1-tracked users.

**Coach prompt versioning** — `PROMPT_VERSION = "4.25.0"` in
`src/lib/ai/prompts/insight-generator.ts`. Stamped on every
`RecommendationFeedback` + `CoachMessage` row. Bumped per system-
prompt change. See `08-locked-contracts.md` §9.2.

**Codex** — ChatGPT OAuth provider (Marc's ChatGPT subscription).
Stored on `User.codexAccessTokenEncrypted` etc. Web-only path; iOS
does not participate. See `14-coach-mental-model.md`.

**Coolify** — Self-host deployment platform HealthLog runs on. Multi-
arch Docker image builds at GHCR. iOS team interacts with Coolify only
through staging URLs — no direct deploy access.

---

## D

**Drift-guard test** — Test that asserts a hand-curated artefact has
not silently changed (OpenAPI spec, safety-contract YAML parity,
system-prompt headings). Hard-fails CI. See `08-locked-contracts.md`
§10.

**DLQ** — "Dead-letter queue". HealthLog's pg-boss does not use a
separate DLQ table; failed jobs flip to `state = 'failed'` in
`pgboss.job`. Operators surface via Admin → System Status.

---

## E

**Evidence block** — The `---KEYVALUES---` / `---END---` sentinel
section the Coach appends to its reply (GROUND RULE 2). iOS parser
extracts it and renders as the "What I'm looking at" collapsible
disclosure. Sentinels are LITERAL — never translated. See
`08-locked-contracts.md` §1.

---

## G

**GlitchTip** — Self-hosted Sentry-compatible error tracker.
HealthLog reports unhandled `apiHandler` errors fire-and-forget. Path
in URL is scrubbed before forwarding (no `?code=` / `?secret=`
leakage). See `src/lib/api-handler.ts:406`.

**GLP-1** — Glucagon-like peptide-1 receptor agonist drug class
(Mounjaro/Zepbound/Trulicity = tirzepatide and dulaglutide;
Ozempic/Wegovy/Rybelsus = semaglutide; Saxenda = liraglutide).
Specialist surfaces gated on `Medication.treatmentClass = GLP1`.
See `04-data-model.md` §2.8, `glp1-knowledge.ts`.

**GROUND RULE** — Numbered clause in the Coach + Insights system
prompts. v1.4.25 ships 15 of them; rules 9 (GLP-1 dose refusal) and
15 (drug-level refusal) are the safety-critical pair. See
`08-locked-contracts.md` §1.

---

## H

**Health Score** — Composite 0-100 wellness number on the dashboard.
Provenance is surface-side (web) — iOS displays it via the same API
endpoint. Distinct from the Withings "Vascular Age" measure
(`MeasurementType.VASCULAR_AGE`, type 155).

**hl_onboarding** — Non-httpOnly cookie carrying `"pending"` while
`User.onboardingCompletedAt IS NULL`. Proxy reads it to short-circuit
the post-hydration redirect. iOS does not set this cookie.

**healthlog_session** — httpOnly session cookie (web). 30-day sliding
expiry. SameSite=Lax so Withings OAuth callback works. iOS uses
Bearer tokens instead; does not set this cookie.

---

## I

**Idempotency-Key** — Header on every state-changing iOS request.
UUIDv4 string, persisted by the client until a terminal response
arrives. 24h TTL, dedup tuple `(userId, key, method, path)`. See
`17-error-handling.md` §3.

**Insight** — Long-form chart-anchored analysis on the Insights
surface (e.g. /insights/blutdruck). Generated server-side by the
provider chain; cached on `User.insightsCachedText` until a fresh
generation evicts. Distinct from **Briefing** + **Coach**.

---

## M

**Maintainership Banner** — UI badge on `/coach` (FR/ES/IT/PL only)
flagging that the locale's Coach prompt body is AI-drafted with
ongoing human review. Links to a GitHub issue template for reporting
refusal regressions. EN + DE prompts are hand-curated; no banner.

**MDR** — EU Medical Device Regulation (EU) 2017/745. HealthLog is
engineered to stay below the Class I "predict / advise" threshold —
no plasma concentration values, no clinical claims, no dose
recommendations. Cited verbatim in GROUND RULE 15 (drug-level
refusal). See `glp1-pk.ts:1-65` for the regulatory rationale.

**MDCG 2021-24** — Medical Device Coordination Group guidance
document on Class I borderline products. Co-cited with MDR by GROUND
RULE 15. The HealthLog Coach explicitly references both when
refusing drug-level questions.

**Measurement** — Single time-stamped reading row. The most-written
table in the schema. Five-axis unique key
`(userId, type, measuredAt, source, sleepStage)` plus a separate
batch dedup key `(userId, type, source, externalId)`. See
`04-data-model.md` §4.1.

---

## O

**OneCompartment PK** — One-compartment pharmacokinetic model
implemented in `src/lib/medications/glp1-pk.ts`. First-order
absorption + first-order elimination. Sufficient for the qualitative
phase chip ("rising / peak / fading") and the unit-less research-mode
AreaChart. **Two-compartment is explicitly out of scope** — it
crosses the MDR predict/advise threshold. See `glp1-pk.ts:1-65`.

**OpenAPI hard-flip** — As of v1.4.25, `pnpm openapi:check` HARD-FAILS
CI on drift between the Zod registry (`src/lib/openapi/registry.ts`)
and `docs/api/openapi.yaml`. Was `continue-on-error: true` through
v1.4.23. iOS Swift codegen reads the committed YAML. See
`08-locked-contracts.md` §3.

---

## P

**Personal Record (PR)** — Best-ever value for a metric (`MAX`
direction: steps, VO2 max, HRV, distance, daylight; `MIN` direction:
resting HR, body fat, audio exposure). Stored on `PersonalRecord`
rows with `direction` denormalised so the read query is one indexed
pass. Detection enqueued automatically on every batch ingest. See
`04-data-model.md` §4.1, Migration 0054.

**pg-boss** — Postgres-backed background-job queue. HealthLog runs
reminder dispatch, withings sync, host-metric sampling, PR detection,
inventory expire, audit-log cleanup, idempotency-key cleanup, and
the daily feedback aggregator on it. Failed jobs land in
`pgboss.job` with `state = 'failed'`. See `17-error-handling.md` §5.

**PROMPT_VERSION** — `"4.25.0"`. Constant in
`src/lib/ai/prompts/insight-generator.ts`. Stamped on AI replies for
quality slicing. See `08-locked-contracts.md` §9.2.

**Push subscription** — Web-push subscription (`PushSubscription`
model, encrypted `p256dh` + `auth`). Distinct from `Device` (APNs).
iOS does not use this — that's web-browser push.

---

## R

**Range-bar** — Dashboard tile compact chart showing a single
metric's last-N-days as a horizontal bar with the target zone shaded.
Replaces the legacy multi-line spark for v1.4.25. iOS reproduces
this from raw measurement data.

**Refusal-probe matrix** — `src/lib/ai/prompts/safety-contracts.{en,de,fr,es,it,pl}.yaml`
plus the test driver
`src/lib/ai/prompts/__tests__/refusal-probe.test.ts`. Drives 14
contracts × 6 locales × 20+ adversarial paraphrasings = >1680
assertions. iOS must not break the refusals (CI-enforced server-
side). See `08-locked-contracts.md` §7.

**Research Mode** — Per-user opt-in flag (`User.researchModeEnabled`)
gating the GLP-1 PK research-view chart. Unlocked only after the user
acknowledges the MDR disclaimer at the current version (see below).
The Coach refuses every drug-level question regardless of Research
Mode state (GROUND RULE 15 is universal). See Migration 0058.

**RESEARCH_MODE_DISCLAIMER_VERSION** — Constant `"2026-05-14.1"` in
`src/lib/medications/glp1-pk.ts`. Format `YYYY-MM-DD.N`. Compared
byte-wise against `User.researchModeAcknowledgedVersion`. Drift forces
re-acknowledgment. See `08-locked-contracts.md` §6.

---

## S

**Sentinel observation** — Pattern of consecutive measurements that
crosses a user's threshold for the first time in the trailing
window. Insights surface flags it as `severity: "important"`. iOS
displays the flag verbatim.

**Source-priority two-axis** — Per-user `User.sourcePriorityJson`
controlling cross-source dedup. Axis 1 = metric × source ladder;
axis 2 = metric × device-type ladder. iOS Settings → Sources surface
edits both. See Migration 0051 + W8c, `08-locked-contracts.md` §4.

---

## T

**treatmentClass** — `Medication.treatmentClass`. Enum
`MedicationCategory` (`GENERIC | GLP1`). Gates the GLP-1 surfaces
(injection picker, titration, pen inventory, side-effects, GLP-1-
aware Coach). Distinct from the clinical-taxonomy side-table
(BLOOD_PRESSURE, VITAMIN, …). See `04-data-model.md` §2.8.

---

## U

**useInsightStatus** — React hook (`src/hooks/use-insight-status.ts`)
the web surface uses to poll an Insights category's generation
status. Not used on iOS — iOS hits the insights endpoint directly
and renders the response.

---

## W

**Wide Event** — HealthLog's primary log line shape (one event per
request, structured). Built by `WideEventBuilder`
(`src/lib/logging/event-builder.ts`). Carries `http.method`,
`http.path`, `http.status`, `auth.user_id`, `auth.auth_method`,
optional `error`, optional `action.name`, optional `meta`. iOS does
not produce these directly — the server logs each incoming request.

**Withings** — Smart-scale + watch + BP-cuff vendor. HealthLog
syncs via OAuth-3-leg + push webhook. iOS reads Withings data
through the same protected measurement endpoints (no separate
Withings flow on iOS). See `05-auth-flows.md` §4.

**Workout** — `HKWorkout`-aligned typed entity. v1.4.25 ships the
ingest endpoint + 1:1 nested `WorkoutRoute` (GeoJSON LineString).
See `04-data-model.md` §4.2, Migration 0053.

---

## Cross-reference table — where each concept is canonical

| Term | Canonical doc-pack file | Canonical code file |
| --- | --- | --- |
| GROUND RULES 1-15 | `08-locked-contracts.md` §1 | `src/lib/ai/prompts/safety-contracts.ts` |
| Refusal-probe matrix | `08-locked-contracts.md` §7 | `src/lib/ai/prompts/safety-contracts.*.yaml` |
| Coach-Snapshot | `14-coach-mental-model.md` | `src/lib/ai/coach/snapshot.ts` |
| Measurement model | `04-data-model.md` §4.1 | `prisma/schema.prisma:363` |
| Source-priority two-axis | `08-locked-contracts.md` §4 | `src/lib/validations/source-priority.ts` |
| Bearer + refresh flow | `05-auth-flows.md` §3 | `src/lib/auth/refresh-token.ts` |
| Idempotency-Key contract | `17-error-handling.md` §3 | `src/lib/idempotency.ts` |
| Rate-limit (Postgres-anchored) | `17-error-handling.md` §4 | `src/lib/rate-limit.ts` |
| RESEARCH_MODE_DISCLAIMER_VERSION | `08-locked-contracts.md` §6 | `src/lib/medications/glp1-pk.ts:92` |
| PROMPT_VERSION (4.25.0) | `08-locked-contracts.md` §9.2 | `src/lib/ai/prompts/insight-generator.ts:34` |
| Withings webhook path-segment | `08-locked-contracts.md` §8 | `src/app/api/withings/webhook/[token]/route.ts` |
| OneCompartment PK scope-limit | `20-glossary.md` (this file) | `src/lib/medications/glp1-pk.ts:1-65` |

---

## What is NOT in this file

- **Architecture overview** → `02-server-architecture.md`
- **UI primitives, design tokens** → `12-design-system.md` + `11-web-ui-tour.md`
- **AI provider chain, model selection** → `14-coach-mental-model.md` § Provider routing
