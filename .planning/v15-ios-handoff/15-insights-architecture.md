---
file: 15-insights-architecture.md
purpose: Server-side Insight generation pipeline — what iOS consumes vs what it re-implements (nothing).
when_to_read: Before adding any Insight card / dashboard tile to the iOS app — to confirm the server owns generation, caching, schema validation, and provider routing.
prerequisites: 14-coach-mental-model.md, 04-data-model.md, 08-locked-contracts.md
estimated_tokens: ~4000
version_anchor: v1.4.25 / sha 49f71c92
---

# Insights Architecture

## TL;DR

Insights are server-generated, schema-validated, provider-routed, and cached on the server. iOS consumes them as JSON via four endpoints. There is no on-device Insight generation, no on-device prompt building, no client-side LLM call. The architecture's "differentiator" status (per Marc-memory) is upheld by `visual + evidence-grounded + dynamic + multi-provider` — every one of those is owned by the server.

## STOP HERE IF

- You think iOS should "regenerate" an Insight when the user pulls-to-refresh. It should not — the server owns regeneration via `/api/insights/generate` (POST) which writes to a server-side cache + invalidates downstream queries. iOS just re-reads.
- You think iOS should locally summarise multiple Insights into one. Don't — the comprehensive endpoint already does this server-side and ships a `dailyBriefing` slot for the dashboard hero.
- You're tempted to call the LLM provider from iOS. The provider is a server concern. iOS has zero LLM SDKs.

## The three Insight surfaces

| Surface             | Endpoint                                     | Cache strategy                          | Schema                                 |
| ------------------- | -------------------------------------------- | --------------------------------------- | -------------------------------------- |
| **Briefing**        | `GET /api/insights/comprehensive`            | Per-user daily; mutation invalidates    | `AIInsightResponse` + `dailyBriefing`  |
| **Sub-page Insight**| `GET /api/insights/{blood-pressure-status, weight-status, pulse-status, mood-status, bmi-status, medication-compliance-status}` | Per-user-per-page daily                 | `AIInsightResponse` (same Zod schema)  |
| **Generate (POST)** | `POST /api/insights/generate`                | Writes through; invalidates read caches | `AIInsightResponse`                    |
| **Coach (stream)**  | `POST /api/insights/chat`                    | No cache (each turn is conversational)  | Prose + `provenance.keyValues`         |

The Coach is in this table for completeness; it uses the same provider chain but its prompt + output shape are different. See `14-coach-mental-model.md`.

## Server-side flow

```
                ┌─────────────────────────────────┐
                │  GET /api/insights/{sub-page}   │
                └────────────┬────────────────────┘
                             ▼
                ┌─────────────────────────────────┐
                │  memory.ts → cached row?        │
                │   - hit: return cached JSON     │ ← Marc-memory: cache invalidate on new content
                │   - miss: generate              │
                └────────────┬────────────────────┘
                             ▼ (miss)
                ┌─────────────────────────────────┐
                │  features.ts → extractFeatures  │
                │  (analytics features pipeline)  │
                └────────────┬────────────────────┘
                             ▼
                ┌─────────────────────────────────┐
                │  prompts/{sub-page}.ts          │
                │  + base-system.ts + safety      │
                │    contract                     │
                └────────────┬────────────────────┘
                             ▼
                ┌─────────────────────────────────┐
                │  provider-runner.ts             │
                │  walks resolveProviderChain()   │
                │  fallback codex → openai →      │
                │  anthropic → local → admin      │
                └────────────┬────────────────────┘
                             ▼
                ┌─────────────────────────────────┐
                │  generate-insight.ts            │
                │   - JSON.parse                  │
                │   - aiInsightResponseSchema.parse │
                │   - citation-coverage check     │
                │   - confidence score            │
                │   - retry-once on schema fail   │
                └────────────┬────────────────────┘
                             ▼
                ┌─────────────────────────────────┐
                │  memory.ts → write cache row    │
                └────────────┬────────────────────┘
                             ▼
                            client (web or iOS)
```

## Sub-page structure

The "Insight" persona is not monolithic — it has **per-page system prompts**. Each lives in its own file under `src/lib/ai/prompts/` and is selected by the calling route:

| Page                     | Prompt file                                       | Endpoint                                       |
| ------------------------ | ------------------------------------------------- | ---------------------------------------------- |
| `/insights` (general)    | `general-status.ts`                               | `/api/insights/comprehensive`                  |
| `/insights/blood-pressure` | `blood-pressure.ts`                            | `/api/insights/blood-pressure-status`          |
| `/insights/weight`       | `weight.ts`                                       | `/api/insights/weight-status`                  |
| `/insights/pulse`        | `pulse.ts`                                        | `/api/insights/pulse-status`                   |
| `/insights/mood`         | `mood.ts`                                         | `/api/insights/mood-status`                    |
| `/insights/bmi`          | `bmi.ts`                                          | `/api/insights/bmi-status`                     |
| `/insights/medications`  | `medication-compliance.ts`                        | `/api/insights/medication-compliance-status`   |
| (GLP-1 deep-dive)        | embedded in `general-status.ts` + `weight.ts`     | included with comprehensive                    |
| (sleep)                  | snapshot-only; no dedicated prompt yet            | rendered via comprehensive `trendAnnotations.sleep` |

Each sub-page prompt:

- Imports `getBaseSystemPrompt(locale)` from `base-system.ts` — the shared root.
- Layers a **DOMAIN SECTION** that names the clinical guidelines that locale's audience reads (ESH 2023 for EN BP, ESH 2024 for DE BP, etc.) and the metric-specific aggregation hints.
- Inherits all 15 GROUND RULES from the base.

Example (BP, DE):

```ts
// from src/lib/ai/prompts/blood-pressure.ts:4
const BP_SECTION_DE = `FACHSPEZIFISCH — BLUTDRUCK:
- Klassifikation nach ESH 2023:
  * Optimal: < 120/80 mmHg
  * Normal: 120-129/80-84 mmHg
  * Hochnormal: 130-139/85-89 mmHg
  * Hypertonie Grad 1: 140-159/90-99 mmHg
  ...
- Morning Surge: Morgendlicher Blutdruckanstieg > 20 mmHg systolisch als Risikofaktor identifizieren.
- Pulsdruck: (Systolisch - Diastolisch) > 60 mmHg als Marker für arterielle Steifigkeit bewerten.
- Medikamenten-Korrelation: Einnahmetreue von Antihypertensiva mit Blutdruckverlauf korrelieren.
...`;
```

iOS Claude implication: the per-page prompts are **not parameters the iOS app passes**. The route on the server decides which prompt to layer based on the URL path. iOS just hits `/api/insights/blood-pressure-status` and gets the BP-grounded response.

## The `AIInsightResponse` Zod schema

Single shape across all sub-pages — only the `summary` text changes per page. Defined in `src/lib/ai/schema.ts`:

```ts
// abridged shape
{
  summary: string,                               // 2-3 sentences
  recommendations: Array<{
    id: string,
    text: string,
    severity: "info" | "suggestion" | "important" | "urgent",
    metricSource: { type, timeRange, summary, n? },
    rationale: { dataWindow, comparedTo, deviation }
  }>,
  citations: Array<{ type, timeRange, summary }>, // every metricSource MUST appear here
  warnings: Array<{ topic, message, severity? }>,
  dailyBriefing?: {
    paragraph: string,                            // 80-200 words
    keyFindings: Array<{
      tone: "good" | "watch" | "info",
      headline: string,                           // ≤ 60 chars
      detail: string,
      delta: string | null,                       // e.g. "↓ 4 mmHg"
      sourceWindow: "7d" | "30d" | "90d" | "1y",
      sourceMetric: "bp" | "weight" | "pulse" | "mood" | "compliance"
                  | "hrv" | "sleep" | "resting_hr" | "steps" | "active_energy"
                  | "flights" | "distance" | "vo2_max" | "body_temp"
    }>
  },
  trendAnnotations?: { bp?, weight?, mood?, hrv?, sleep?, resting_hr?, steps?, active_energy? },
  weeklyReport?: {
    weekISO: "YYYY-Www",
    summary: string,
    goingWell: string[],                          // ≤ 5
    worthWatching: string[],                      // ≤ 5
    tips: string[],                               // ≤ 5
    dataQualityNotes?: string
  },
  storyboardAnnotations?: Array<{
    date: "YYYY-MM-DD",
    label: string,                                // ≤ 80 chars
    category: "medication" | "event" | "milestone" | "warning",
    detail: string                                // ≤ 400 chars
  }>
}
```

Every iOS Insight card consumes a slice of this shape. The recommendations array is sorted by severity. The `metricSource.type` field uses snapshot keys (`bloodPressure`, `weight`, `pulse`, `mood`, `medications.compliance30`) — those are stable contract identifiers, not localised text. Same for `dailyBriefing.tone` / `sourceWindow` / `sourceMetric`.

## Citation-grounding — the parser-level safety net

The schema parse alone is not enough. After `JSON.parse(content)`, the wrapper asserts:

```ts
// from src/lib/ai/generate-insight.ts
const uncited = findUncitedRecommendations(parsed);
if (uncited.length > 0) {
  // → retry once with a corrective system message
}
```

Citation-coverage rule: **every `recommendation.metricSource.type + timeRange` MUST appear in `citations[]`**. A recommendation without a backing citation is rejected, which forces the retry path. After two failed attempts the route 422s and the UI shows "Couldn't ground a recommendation in your data."

This is the parser-level enforcement of GROUND RULE 7 ("Ground every number in SNAPSHOT"). It is also the reason iOS does NOT validate the JSON further — the schema is already guaranteed by the time iOS receives it.

## Cache invalidation — Marc-memory directive

> "Cache invalidate on new content — fresh insight generation evicts stale; mutation invalidates every read query that touches the resource."

The implementation lives in two places:

1. **Server-side cache** (`src/lib/insights/memory.ts`): per-user-per-scope-per-locale rows in `AiInsightHistory`. When `POST /api/insights/generate` succeeds, it writes a new row AND deletes prior rows scoped to the same `(userId, scope, locale)`. The next read returns the fresh JSON.
2. **TanStack Query** on the web client: the mutation that runs `/api/insights/generate` calls `queryClient.invalidateQueries({ queryKey: ["insights", scope] })` so every component subscribed to that key re-fetches. iOS implements the equivalent — see below.

iOS Claude implication for the iOS Coach:

- After **any measurement add / edit / delete**, invalidate the Insight cache(s) for the metric class that changed. The minimum invalidation set is documented in `08-locked-contracts.md`.
- After a **medication intake event** is logged, invalidate the comprehensive briefing.
- After a **Withings sync** completes (the iOS app might be subscribed via APNs / polling), invalidate the comprehensive briefing.
- After **`POST /api/insights/generate`** completes, invalidate every cached `/api/insights/*` read.

The Marc-memory directive about queryKey collisions applies here too: the iOS client must use distinct request paths per Insight surface (not a single shared key). The unwrap shape is uniform — `(await res.json()).data` — per HealthLog convention. Mismatched unwrap silently poisons the cache.

### Reference invalidation map

| Mutation                                  | Invalidate (iOS query keys equivalent)                                |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Measurement create / update / delete      | `insights.comprehensive`, `insights.{matching-sub-page}`, `analytics.health-score` |
| Mood entry create / update / delete       | `insights.comprehensive`, `insights.mood-status`, `analytics.health-score` |
| Medication intake / skip                  | `insights.comprehensive`, `insights.medication-compliance-status`     |
| Apple Health batch ingest                 | `insights.comprehensive`, every sub-page whose metric class arrived   |
| Withings webhook sync completion          | `insights.comprehensive`, every sub-page whose metric class arrived   |
| `POST /api/insights/generate` success     | every `/api/insights/*` read                                          |

## Briefing vs Insight vs Coach — three distinct personas

Building on `14-coach-mental-model.md`. The defining differences:

| Property                  | Briefing                              | Insight (sub-page)                    | Coach                                  |
| ------------------------- | ------------------------------------- | ------------------------------------- | -------------------------------------- |
| **Conversational?**       | No                                    | No                                    | Yes (streaming, multi-turn)            |
| **Output format**         | JSON                                  | JSON                                  | Prose + sentinel evidence block        |
| **Schema-validated?**     | Yes (Zod)                             | Yes (Zod)                             | Opportunistic (keyvalues parser)       |
| **Cached?**               | Server cache + iOS query cache        | Server cache + iOS query cache        | Never cached                           |
| **Refusal layer?**        | Yes (in-scope-only refusal in JSON)   | Yes (in-scope-only refusal in JSON)   | Yes (pattern bank + GROUND RULE 9/10/15) |
| **Per-page prompt?**      | No (single comprehensive prompt)      | Yes (one per page)                    | Single Coach prompt per locale         |
| **Sources block surface** | Dashboard hero                        | Sub-page hero                         | Inline "What I'm looking at" disclosure |

## Multi-provider routing

Same chain the Coach uses. See `14-coach-mental-model.md` for the full table. For Insights specifically:

- **Codex** is the default for users with ChatGPT OAuth connected.
- **Anthropic** is the explicit choice for users with a saved Claude key — the iOS team's local default for development, since Marc has an Anthropic key configured.
- **Admin-OpenAI** is the floor — covers users with no own provider, paid by the operator.

The provider-runner walks the chain on every Insight call and falls back on any non-2xx / parse failure. The Wide-Event annotation records which provider produced the served JSON.

iOS Claude implication: the Insight that lands on the iOS dashboard may come from any of the 5 providers. The UI doesn't display the provider name — that's a debugging concern surfaced in admin panels.

## `comprehensive` vs `generate` — the W4-W6 redesign

Two endpoints exist for historical reasons that matter:

- **`GET /api/insights/comprehensive`** — read-mostly, returns the cached "everything in one shot" JSON for the dashboard. Reads fresh + writes to cache if stale (TTL ~24h). Never the user's explicit "regenerate" action — that's `generate`.
- **`POST /api/insights/generate`** — explicit regeneration, accepts `{ scope, locale }`, fans out to the right provider, writes through the cache. Triggered by the user pressing "Regenerate" in the UI or by the server when an upstream mutation invalidated the cache.

The redesign (W4-W6 of v1.4.20) split these so the dashboard render never burns a provider call. iOS must respect that split:

- iOS **reads** via `comprehensive` (and the sub-page endpoints).
- iOS **writes** via `generate` only when the user explicitly asks ("Tap to regenerate" UX or after a manual data import).

A pulled-to-refresh gesture on iOS should call `comprehensive` (cheap, idempotent), not `generate` (expensive, provider call).

## Evidence-grounding rule

Marc-memory directive: AI Insights are HealthLog's differentiator. Generic chat is NOT acceptable. Every Insight must be:

1. **Visual** — accompanied by mini-charts the snapshot informs (the `dailyBriefing.keyFindings[].sourceWindow` + `sourceMetric` pair drives the inline chart token).
2. **Evidence-grounded** — every claim cites a snapshot field via `metricSource`.
3. **Dynamic** — fresh against the user's most recent data (cache invalidates on mutation).
4. **Multi-provider** — runs through the fallback chain so one provider's outage doesn't degrade the surface.

iOS Claude implication: a stripped-down "just the summary, no citations" surface IS NOT acceptable in the iOS Insights UI. The citations and inline-chart tokens are load-bearing trust signals.

## Inline-chart tokens

Insight prose can carry inline-chart tokens — strings like `metric:BLOOD_PRESSURE_SYS` that the UI replaces with a small chart of that metric pinned to the same window. The contract:

- The token is `metric:<MeasurementType>` exactly (the canonical enum value).
- The UI replaces it with the corresponding chart at render time.
- The prompt explicitly forbids writing this token anywhere in user-facing prose **except** inline-chart positions; the parser strips it for the Coach (which never owns inline charts).
- Tokens are valid only in Insight `summary` and `recommendations[].text`. Not in `dailyBriefing.paragraph`, not in `weeklyReport.summary`.

For iOS:

- Render `metric:<TYPE>` tokens as a sparkline chart pinned to `last30days` (default).
- If the surrounding paragraph cites a window other than 30d, pin the chart to that.
- If the iOS app doesn't support inline charts in v1.5, **strip the tokens** before rendering — never display the raw `metric:WEIGHT` string to the user.

## How an iOS Insight card consumes the same endpoint

Reference flow for "Blood Pressure" sub-page card on iOS:

1. `GET /api/insights/blood-pressure-status?locale=en` with the user's bearer token.
2. Server returns the `AIInsightResponse` JSON (possibly from cache).
3. iOS unwraps via `(await response).data` per HealthLog convention.
4. Card renders:
   - **Headline:** the `summary` string.
   - **Findings:** the `recommendations[]` sorted by severity, each with a small chart token replaced inline.
   - **Citations:** the `citations[]` rendered as a collapsible "What I'm looking at" disclosure (mirrors the Coach pattern).
   - **Warnings:** `warnings[]` rendered as small banners above the findings.
5. When the user taps "Regenerate" → `POST /api/insights/generate` with `scope: "blood-pressure"`.
6. Server returns the new JSON; iOS invalidates the matching read query and the parent comprehensive query.

## Sanitisation rule

`src/lib/insights/sanitize.ts` strips known-PII patterns (names from `User.name`, emails, OAuth account ids) from the snapshot **before** the prompt is built. This is belt-and-braces over the Coach's "names never reach the prompt" rule. iOS does NOT need to re-sanitise — the server guarantees it.

## "Since v1.4.24" diff markers

- **NEW v1.4.25** — PROMPT_VERSION 4.24.0 → 4.25.0.
- **NEW v1.4.25** — GROUND RULE 8 + 15 added to every Insight system prompt (no internal identifiers; universal drug-level refusal).
- **NEW v1.4.25 W14a** — OpenAPI hard-flip: every Insight endpoint now exposes a published OpenAPI 3.1 spec. iOS can codegen Swift models from `/api/openapi.json`.
- **NEW v1.4.25 W4d** — `weeklyContext.glp1` block on the snapshot reaches the comprehensive prompt; the GLP-1 deep-dive Insight on `/insights` consumes it.
- **NEW v1.4.25** — Apple Health metric categories (HRV / sleep / resting HR / steps / active energy / flights / distance / VO2 max / body temp) are first-class in Insight prompts. Their absence is silent (no apology), per GROUND RULE 14.

## iOS implementation checklist

1. **Codegen Swift models** from `/api/openapi.json` (or hand-write to match the `AIInsightResponse` shape).
2. **One endpoint per Insight surface** — don't merge them client-side.
3. **Use SwiftUI's `@Observable` (or Combine) for cache invalidation** — keep the invalidation map mirrored to the table above.
4. **Render citations** — they are not optional polish.
5. **Replace inline-chart tokens** with charts (or strip them, but never display raw).
6. **Pull-to-refresh = read**, not regenerate. Add an explicit "Regenerate" button if the user wants to spend a provider call.
7. **Network error UX** — fall back to the last cached JSON the iOS app has stored locally, with a "Showing previous version (couldn't reach server)" banner.

## Self-test snippets

```bash
# Probe the Insights surface against a local dev server:
curl -s "http://localhost:3000/api/insights/blood-pressure-status?locale=en" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.summary, .data.recommendations[0]'
```

```swift
// Decode in Swift
struct AIInsightResponse: Decodable {
    let summary: String
    let recommendations: [Recommendation]
    let citations: [Citation]
    let warnings: [Warning]
    let dailyBriefing: DailyBriefing?
    let trendAnnotations: TrendAnnotations?
    // ... add fields as needed
}
// (Use snake_case keyDecodingStrategy or @CodingKeys as appropriate)
```

## Cross-references

- **14-coach-mental-model.md** — Coach is a sibling surface, not a parent.
- **16-health-score-logic.md** — Health Score is a separate analytics surface; sometimes referenced by Insight prose but never embedded in it.
- **04-data-model.md** — `AiInsightHistory` table schema.
- **08-locked-contracts.md** — exact request/response shape per Insight endpoint.
- **07-server-responsibilities.md** — full ladder of server-owned features iOS inherits.
