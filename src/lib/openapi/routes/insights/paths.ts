/**
 * OpenAPI path table — dashboard snapshot, comprehensive insights, analytics range, metric status, derived metrics, correlations.
 *
 * Schema declarations live in `./schemas`; this module is the path orchestrator.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";
import {
  AI_CONSENT_REQUIRED_DESCRIPTION,
  MODULE_DISABLED_DESCRIPTION,
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  moduleDisabledResponse,
  recordRefusal,
  stdResponses,
} from "../shared";
import {
  insightsCardsResponse,
  insightsComprehensiveResponse,
  metricStatusQuery,
  metricStatusResponse,
  biomarkerAssessmentQuery,
  biomarkerAssessmentResponse,
  derivedMetricQuery,
  derivedMetricResponse,
  derivedBatchQuery,
  derivedBatchResponse,
  correlationDiscoveryResponse,
  correlationPatternListResponse,
  updateCorrelationPatternRequest,
  updateCorrelationPatternResponse,
  glp1PlateauResponse,
  insightStatusQuery,
  insightStatusResponse,
  medicationComplianceStatusResponse,
  analyticsRangeQuery,
  analyticsRangeResponse,
  insightsPregenerateRequest,
  insightsPregenerateResponse,
  dashboardSnapshotResponse,
  ecgListResponse,
  ecgIngestRequest,
  ecgIngestResponse,
  ecgDetailQuery,
  ecgDetailResponse,
  rhythmEventsResponse,
  analyticsQuery,
  analyticsResponse,
  insightsSettingsResponse,
  insightsSettingsPutRequest,
  targetsResponse,
  providerChainResponse,
  providerChainPutRequest,
  insightsGenerateReadResponse,
  insightsGeneratePostRequest,
  insightsGeneratePostResponse,
  coachReadQuery,
  coachReadStripResponse,
  coachSeededQuestionResponse,
  narrativeQuery,
  narrativeResponse,
  glp1TimelineQuery,
  glp1TimelineResponse,
  intradayPulseQuery,
  intradayPulseResponse,
} from "./schemas";
import { recommendationFeedbackRequestSchema } from "@/lib/validations/recommendation-feedback";

const insightsFeedbackRequest = recommendationFeedbackRequestSchema.meta({
  id: "InsightsFeedbackRequest",
  description:
    "A thumbs-up / thumbs-down on one recommendation. The body carries the rec id AND a snapshot of the text as rendered, because deduplication is on the pair: a regeneration that rewrites the same id with new text is a genuinely different rating, which is the signal the aggregator wants. `providerType` and `promptVersion` are NOT accepted — the server fills both from the account's own attribution, so a client cannot tamper with the slice the quality dashboard reports on.",
});

export const insightsPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/dashboard/snapshot": {
    get: {
      tags: ["Dashboard"],
      summary: "Unified dashboard first-paint snapshot",
      description:
        "Assembles every above-the-fold tile field in one round-trip from the rollup / mood / widget helpers plus a read-only lift of the pre-generated daily briefing. Two-phase: `tiles` always present, `extras` nullable on a rollup-coverage miss. No LLM is reachable from this path. Cookie or Bearer auth.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Dashboard snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardSnapshotResponse,
                "DashboardSnapshotResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/comprehensive": {
    get: {
      tags: ["Insights"],
      summary: "Comprehensive AI insights bundle",
      description:
        "Full Insights surface — daily briefing, recommendations with rationale, optional weekly report + storyboard annotations. Strict-schema validated server-side. Requires an active ConsentReceipt when the resolved provider chain egresses via the operator's server-managed key (see POST /api/consent/ai).",
      responses: {
        "200": {
          description: "Insights bundle.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsComprehensiveResponse,
                "InsightsComprehensiveResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        ...recordRefusal(AI_CONSENT_REQUIRED_DESCRIPTION),
      },
    },
  },
  "/api/insights/cards": {
    get: {
      tags: ["Insights"],
      summary: "Insight cards (iOS adapter)",
      description:
        "v1.4.31 — the native-client adapter over the same alert rule engine the web comprehensive surface consumes: measurements, BP-in-target, weight trend, pulse, and cadence-aware medication compliance are fed through `generateAlerts()` and each resulting `HealthAlert` is re-shaped to the iOS Insight card model. Deterministic — no LLM call on this path. Module-gated on `insights` and the operator `insightStatus` assistant surface. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The list of insight cards (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsCardsResponse,
                "InsightsCardsEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/insights/pregenerate": {
    post: {
      tags: ["Insights"],
      summary: "Warm all AI assessments for the calling user",
      description:
        "v1.8.7.1 — enqueue a full warm of every AI assessment for the authenticated user (comprehensive insight + the seven specialised status cards + every data-bearing generic metric assessment) in the active locale, so the read-only status GETs serve cached text instantly. Returns immediately; the generation runs out of band on the worker. Empty metrics and provider-less accounts never trigger an LLM call. Short anti-spam bucket (`insights-warm:<userId>`, one warm per 3 minutes) → 429 on a tight loop. Auth via cookie or Bearer; `userId` is taken from the session, never the body.",
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: insightsPregenerateRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Warm accepted and enqueued. The work runs on the worker; poll the read-only status routes for the text.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsPregenerateResponse,
                "InsightsPregenerateResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/analytics": {
    get: {
      tags: ["Analytics"],
      summary: "The full analytics envelope (two slices behind one path)",
      description:
        "The oldest composite read in the application. `?slice=summaries` answers the slim slice — per-type summaries and the freshness map, resolved from two SQL passes over the rollup tier. Everything else answers the thick default: the same summaries plus BMI, the blood-pressure in-target windows, per-context glucose and the clinical glucose panel, the three correlation hypotheses, the full health-score report and the trailing-30-day sleep-stage breakdown. No LLM is reachable from either path. Both are served through a stale-while-revalidate cache, and the DEFAULT slice's cache key includes the reader's locale, because the correlation narration is localised prose. Two behaviours worth knowing before integrating: the thick slice RECORDS the health score it computes, so this read is not side-effect-free, and it kicks off a background rollup refresh it deliberately does not await, so a reading logged seconds ago can be missing from the very first request after it lands and present on the next. Module handling is per BLOCK, not per request: the glucose blocks go null when the glucose module is off, and the health score simply drops the pillars whose modules are off. Cookie or Bearer auth; the caller is always resolved as themselves, so this read cannot be delegated to a shared record.",
      requestParams: { query: analyticsQuery },
      responses: {
        "200": {
          description:
            "`AnalyticsDefaultSlice`, or `AnalyticsSummariesSlice` when `slice=summaries`. `Cache-Control` is the bfcache-friendly `private, max-age=0, must-revalidate` rather than `no-store`.",
          content: {
            "application/json": {
              schema: dataEnvelope(analyticsResponse, "AnalyticsEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/generate": {
    get: {
      tags: ["Insights"],
      summary: "Read the cached advisor briefing (never generates)",
      description:
        'The read-only advisor. It serves the cached payload and NEVER calls a provider — the surfaces that mount on page load used to POST here, which blocked first paint on the whole provider chain. When the cache is stale or missing AND a provider exists it enqueues an out-of-band warm and says so in `revalidating`; the next read reflects it. User-initiated regeneration is the POST. Four honesty signals ride the payload and are the whole point of it: `hasProvider: false` means no warm pass can ever refresh what is shown, so stop polling and offer to connect one; `generationFailed` means the last attempt failed and the text is HELD rather than fresh; `generationFailureClass` says which lever to point at; and `briefingOmittedReason: "ungrounded"` means a generation SUCCEEDED and the grounding gate withheld the briefing, which is a different state from a failure. Gated on the Coach assistant surface — an operator who turns Coach off empties every advisor consumer. Cookie or Bearer auth; the caller is always resolved as themselves, so this read cannot be delegated to a shared record.',
      responses: {
        "200": {
          description:
            "The cached payload, or the empty shape when nothing is cached. Always 200 — an absent briefing is a normal answer here, not an error.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsGenerateReadResponse,
                "InsightsGenerateReadEnvelope",
              ),
            },
          },
        },
        "403": {
          description:
            "The operator has switched the Coach assistant surface off (`meta.errorCode` = `assistant.disabled.coach`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
        "429": stdResponses["429"],
      },
    },
    post: {
      tags: ["Insights"],
      summary: "Generate the advisor briefing inline (costs tokens)",
      description:
        "The only path in the advisor family that calls a provider, and it does so INLINE. Two gates bound it, and they bound different things. The RATE gate is `insights:<userId>`, ten generations per hour by default and configurable by the operator through `INSIGHTS_RATE_LIMIT_PER_HOUR` (a value below 1 falls back to the default); it is checked AFTER the cache short-circuit, so a cache hit never spends a token. The BUDGET gate is the day's token ceiling, refused at reservation time before any provider is contacted — so it is not a provider failure, records no failure marker, and answers 429 with `meta.errorCode` = `insights.generate.budgetExceeded`, which is how a client tells 'you asked too often' from 'the day's spend is gone'. Two more things a caller should know before integrating: a plain 200 does NOT mean a provider ran — a fresh cache inside 24 hours answers `cached: true`, and so does an exhausted quota when the fresh cache merely lacked a briefing — and a request that TIMES OUT client-side may still complete on the server, writing the briefing to the cache or a dated failure marker, which is exactly the pair the read GET reports so a client can settle an aborted regenerate by polling rather than guessing. Gated on the Coach assistant surface, consent-gated when the resolved chain egresses through the operator's server-managed key. Cookie or Bearer auth; not delegable.",
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: insightsGeneratePostRequest },
        },
      },
      responses: {
        "200": {
          description:
            "A payload — freshly generated, served from the 24-hour cache, or served from a briefingless cache after the hourly quota refused the regeneration. `cached` tells the three apart.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsGeneratePostResponse,
                "InsightsGeneratePostEnvelope",
              ),
            },
          },
        },
        "403": {
          description:
            "The Coach assistant surface is off (`assistant.disabled.coach`), or the resolved chain egresses through the operator's key and no consent receipt is on file (`consent.ai.required`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The account's privacy mode, exclude list, locale or profile changed while the generation was running, so the finished text describes a scope that no longer applies and is discarded rather than written. `meta.errorCode` = `insights.generate.scopeChanged` or `insights.generate.profileScopeChanged`. Retry.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "No AI provider is configured anywhere for this account, or the provider answered something that was not valid JSON (`meta.errorCode` = `ai_response_truncated` when the answer was cut off mid-stream rather than malformed), or the finished prose was withheld by the outbound safety screen (`insights.generate.outboundScreened`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "Three different refusals share this status and are told apart by `meta.errorCode`. No code: more than the hourly limit of generations for this account. `insights.generate.budgetExceeded`: the DAY's token ceiling refused the reservation before any provider was contacted — retry tomorrow, not in an hour. No code, with provider wording: the upstream provider rate-limited every hop of the chain.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "Every provider in the chain failed for a reason that is not a rate limit — auth, timeout or an upstream 5xx. A dated failure marker is written, so the read GET reports the briefing as held rather than fresh.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
      },
    },
  },
  "/api/insights/provider-chain": {
    get: {
      tags: ["Insights"],
      summary: "Read the account's AI-provider chain",
      description:
        "The chain as the settings surface renders it: the resolved head, the last provider that actually worked, and the PERSISTED list with disabled entries included. That last point is the one that matters — the resolved list drops disabled entries, and returning it here once made a disabled provider vanish from the settings list along with the toggle that would have brought it back. No key, token or account id is ever on this wire; the response carries provider TYPES and boolean state only. Cookie or Bearer auth; not delegable.",
      responses: {
        "200": {
          description: "The chain summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                providerChainResponse,
                "ProviderChainEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Insights"],
      summary: "Replace the account's AI-provider chain",
      description:
        "Persists the chain wholesale in the order the array gives. Any `priority` a client sends is accepted and IGNORED — the server recomputes it from insertion order, so a stale tab cannot store a chain whose displayed order disagrees with its stored one. A repeated provider type is refused rather than deduplicated on read, because drift between the two representations is the kind of thing that costs an evening. No credential is written or read here. Body capped at 64 KiB. Cookie or Bearer auth; not delegable.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: providerChainPutRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Saved. The response confirms the write and does not echo the chain — re-read it if the resolved state is needed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ saved: z.literal(true) }),
                "ProviderChainSavedEnvelope",
              ),
            },
          },
        },
        "422": {
          description:
            "The body was not a valid chain — an empty array, more entries than there are provider types, an unknown provider type, or the same type twice. A single-message envelope with no issue list.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
        "429": stdResponses["429"],
      },
    },
  },
  "/api/insights/feedback": {
    post: {
      tags: ["Insights"],
      summary: "Rate one recommendation",
      description:
        "Records a thumbs-up or thumbs-down against one recommendation, with the rendered text snapshotted alongside the id. The server fills the provider and prompt-version attribution from the account's own state so a client cannot skew the slice the quality dashboard reports on. Idempotent: send `Idempotency-Key` and a retry replays the first response rather than writing twice. Rate-limited 60/h per account — the unique index only catches EXACT replays, so without the cap a client could distort the aggregator by varying the id or the text per request. Body capped at 64 KiB. Cookie or Bearer auth; not delegable.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: insightsFeedbackRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        "201": {
          description: "The rating was recorded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  id: z.string(),
                  createdAt: z.iso.datetime({ offset: true }),
                }),
                "InsightsFeedbackCreatedEnvelope",
              ),
            },
          },
        },
        "422": {
          description:
            "The body failed validation. A single-message envelope (`Invalid feedback payload`) with no issue list — this route does not use the multi-issue form.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 60 ratings in the trailing hour for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
      },
    },
  },
  "/api/insights/coach-read": {
    get: {
      tags: ["Insights"],
      summary: "The two-line Coach read for one metric",
      description:
        "The own-baseline placement and the single strongest lagged association whose outcome is the named metric — the two server-authoritative lines a metric sub-page renders above its chart. Pure compute over the baseline and correlation engines: no provider call and no cache table, so web and native decode the same DTO rather than each deriving one. Line two arrives as a finished sentence in the reader's language and is printed verbatim, so the resolved locale decides the row; a correlation failure degrades it to null and never sinks line one. Module-gated on `insights` and gated on the Coach assistant surface, because the strip is the ambient Coach presence on that page. Shared analytics-read budget. Delegable at MANAGE level over the whole record: it is computed across the record with no provider on the path. Cookie or Bearer auth.",
      requestParams: { query: coachReadQuery },
      responses: {
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        "200": {
          description: "The strip.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachReadStripResponse,
                "CoachReadStripEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/seeded-question": {
    get: {
      tags: ["Insights"],
      summary: "Today's suggested Coach opener",
      description:
        "Resolves today's single most notable derived wellness signal into a tappable opener for the Coach's blank-chat hero, using the same confidence-gated detector the daily briefing uses. The selection happens SERVER-side and the client renders it rather than recomputing. `signal: null` is the ordinary answer and means the hero keeps its neutral greeting — never a fabricated opener. Two different causes produce that null and are indistinguishable on the wire: nothing crossed the notability gate, or the account has turned proactive suggestions off, in which case the detector does not run at all. Module-gated on `insights` and on the Coach assistant surface. Shared analytics-read budget. Cookie or Bearer auth; not delegable.",
      responses: {
        "200": {
          description: "The opener, or the neutral null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachSeededQuestionResponse,
                "CoachSeededQuestionEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/insights/narrative": {
    get: {
      tags: ["Insights"],
      summary: "The latest week or month retrospective",
      description:
        "The last generated period summary for the record. Read-only by construction: it never blocks on a provider, serves the last good row immediately, and warms out of band when the row is stale or missing. A provider-less account is not left empty — the generator falls back to deterministic, non-causal prose, so even the no-key demo gets a retrospective on the next read. `revalidating` reports whether this read enqueued a warm, and is always FALSE on a delegated request: the route warms unconditionally rather than on a miss, so without that suppression a manager's first navigation here would be an egress of the owner's record the owner never asked for. Rows are keyed per locale, so `locale` selects a different stored row rather than translating one. Module-gated on `insights` and on the `insightStatus` assistant surface. Delegable at MANAGE level over the whole record. Cookie or Bearer auth.",
      requestParams: { query: narrativeQuery },
      responses: {
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        "200": {
          description:
            "The retrospective, or `narrative: null` when none is on file yet. Always 200 — absence is a normal answer.",
          content: {
            "application/json": {
              schema: dataEnvelope(narrativeResponse, "NarrativeEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/glp1-timeline": {
    get: {
      tags: ["Insights"],
      summary: "GLP-1 therapy timeline",
      description:
        "A chronological merge of every GLP-1-relevant event the record holds: titration steps, injections with their sites, legacy stock-ledger movements, and side-effect-tagged mood days from the trailing 90 days. `hasGlp1: false` with no entries when the record holds no medication classified GLP-1, so the surface hides cleanly. Two limits worth knowing before reading the output as complete: inventory entries come from the LEGACY running-sum ledger only, so a medication tracked with per-container inventory shows none, and the side-effect scan matches a FIXED bilingual list of English and German tag strings, so a tag written in another language contributes nothing. `limit` is forgiving — an out-of-range or non-numeric value falls back to the default rather than 422-ing. Delegable at MANAGE level over the whole record: it spans medications and mood, with no provider on the path. Cookie or Bearer auth.",
      requestParams: { query: glp1TimelineQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The timeline, newest first.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                glp1TimelineResponse,
                "Glp1TimelineEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/pulse/intraday": {
    get: {
      tags: ["Insights"],
      summary: "One day's intraday heart-rate shape",
      description:
        "The day's ten-minute mean heart-rate series plus, when every confidence gate holds, at most ONE cautious elevated-at-rest window. Computed from raw samples through the read-swap pattern rather than persisted as ten-minute rollups for all history, so a day outside the dense-retention window reads back at the coarser hourly grain instead of empty — `resolution` says which, and `tension` is always null on an hourly day because that read needs per-sample resolution. The bar for a tension window is deliberately high; under-flagging is the intended failure mode, and it is awareness, never a diagnosis. `date` is STRICT here, unlike the forgiving date filters elsewhere on the surface: anything but a `YYYY-MM-DD` literal is a 422. Module-gated on `insights`. Delegable at MANAGE level over the whole record. Cookie or Bearer auth.",
      requestParams: { query: intradayPulseQuery },
      responses: {
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        "200": {
          description:
            "The day's series. `Cache-Control` is the bfcache-friendly `private, max-age=0, must-revalidate` rather than `no-store`.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                intradayPulseResponse,
                "IntradayPulseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/settings": {
    get: {
      tags: ["Insights"],
      summary: "Read the account's AI-provider settings",
      description:
        "Returns the account's own provider connection state and privacy mode alongside PRESENCE-ONLY flags for the operator's shared key and shared ChatGPT connection. No key, token or account id is ever on this wire. Cookie or Bearer auth; the caller is always resolved as themselves, so this read cannot be delegated to a shared record.",
      responses: {
        "200": {
          description: "The settings.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsSettingsResponse,
                "InsightsSettingsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Insights"],
      summary: "Update the account's AI privacy mode",
      description:
        "Writes `privacyMode` and nothing else. Changing it clears the cached insight text and its timestamp so the next generation runs under the new mode. The body is inspected key by key rather than Zod-parsed: an unknown key is ignored rather than refused, and a body that recognises nothing is refused with 422 `No changes` rather than answered as a no-op — so a client cannot tell a typo'd field name from a rejected value except by reading the message. Body capped at 64 KiB. Cookie or Bearer auth; not delegable.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: insightsSettingsPutRequest },
        },
      },
      responses: {
        "200": {
          description: "Saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ updated: z.literal(true) }),
                "InsightsSettingsUpdatedEnvelope",
              ),
            },
          },
        },
        "422": {
          description:
            "`Invalid privacy mode` when `privacyMode` was a string outside the two accepted values, or `No changes` when the body carried nothing this endpoint writes. Single-message envelope with no issue list — this route validates by hand rather than through Zod.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
        "429": stdResponses["429"],
      },
    },
  },
  "/api/insights/targets": {
    get: {
      tags: ["Insights"],
      summary: "Per-metric target tiles + consistency strips",
      description:
        "The whole targets page in one read: a tile per metric with its band, its current and 30-day-average values, and the seven-day consistency strip behind it, plus the page summary, the diastolic companion figures and the profile facts every band was resolved from. Pure compute over the record's own data — no provider anywhere on the path. Stale-while-revalidate: past the fresh window the prior body serves immediately while one background rebuild warms the cell, and a write hard-evicts the bucket so the account's own action lands on the next read. Delegable at MANAGE level over the whole record: the walk spans vitals, sleep, medications, mood and glucose, so a section-scoped grant is refused rather than served a filtered page. Not module-gated as a whole; a tile whose data does not exist is simply absent. Cookie or Bearer auth.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The target tiles and their page summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(targetsResponse, "TargetsEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/analytics/range": {
    get: {
      tags: ["Analytics"],
      summary: "Single-metric period-over-period range delta",
      description:
        "v1.9.0 — returns the current-window aggregate, the previous comparable window, and the composed delta for ONE metric type over a `7d` / `30d` / `90d` / `1y` range. Single-type by construction (the metric page is single-metric), so the read is one rollup-tier call covering the trailing 2N days sliced into the two halves — no per-type fan-out. Additive route; the `/api/analytics` envelope is unchanged. Auth via cookie or Bearer.",
      requestParams: {
        query: analyticsRangeQuery,
      },
      responses: {
        "200": {
          description: "Current + previous window aggregates and the delta.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                analyticsRangeResponse,
                "AnalyticsRangeResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/blood-pressure-status": {
    get: {
      tags: ["Insights"],
      summary: "Blood-pressure assessment",
      description:
        "Data-driven plain-language assessment of the user's recent blood-pressure readings. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "BloodPressureStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/pulse-status": {
    get: {
      tags: ["Insights"],
      summary: "Pulse assessment",
      description:
        "Data-driven plain-language assessment of the user's recent resting-pulse readings. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "PulseStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/weight-status": {
    get: {
      tags: ["Insights"],
      summary: "Weight assessment",
      description:
        "Data-driven plain-language assessment of the user's recent weight trend. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "WeightStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/bmi-status": {
    get: {
      tags: ["Insights"],
      summary: "BMI assessment",
      description:
        "Data-driven plain-language assessment of the user's body-mass index. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "BmiStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/mood-status": {
    get: {
      tags: ["Insights"],
      summary: "Mood assessment",
      description:
        "Data-driven plain-language assessment of the user's recent mood entries. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "MoodStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/medication-compliance-status": {
    get: {
      tags: ["Insights"],
      summary: "Medication-compliance assessment",
      description:
        "Data-driven plain-language assessment of the user's medication compliance — an overall `summary` plus a per-medication note array. Read-only: a cache miss warms a generation out of band and serves the last-good envelope meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description:
            "Compliance assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationComplianceStatusResponse,
                "MedicationComplianceStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/metric-status": {
    get: {
      tags: ["Insights"],
      summary: "Generic per-HealthKit-metric assessment",
      description:
        "v1.8.7.1 — data-driven plain-language assessment for any registered HealthKit metric (resting heart rate, sleep, glucose, body composition, gait, audio exposure, …). One generic route covering ~30 metric pages via archetype prompt templates + per-metric metadata. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). An unknown `metric` 422s against the closed registry enum. Auth via cookie or Bearer.",
      requestParams: {
        query: metricStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                metricStatusResponse,
                "MetricStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/biomarker-assessment": {
    get: {
      tags: ["Insights"],
      summary: "Per-biomarker assessment",
      description:
        "Data-driven plain-language assessment for one user-scoped lab biomarker, reading its `LabResult` history. Identical envelope to the metric-status card so the `InsightStatusCard` consumes it unchanged. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate); the assessment regenerates only when a new reading lands. A marker with no numeric readings returns `insufficient` without an LLM call. Auth via cookie or Bearer.",
      requestParams: {
        query: biomarkerAssessmentQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                biomarkerAssessmentResponse,
                "BiomarkerAssessmentResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/derived": {
    get: {
      tags: ["Insights"],
      summary: "Derived wellness metric (compute-once)",
      description:
        "v1.10.0 — the compute-once `Derived<T>` value for any registered derived wellness metric (personal typical-range vitals baseline, cardio-fitness band, vascular-age delta, sleep score, readiness, coincident-deviation flag). One generic route over a closed registry enum; an unknown `metric` 422s. Pure compute over the rollup tier with a per-type live fallback on a coverage miss — no LLM call, no narrative, no cache table. Returns the flat `Derived<T>` union so the native client can decode one stable shape and combine values across metrics. `windowDays` widens or narrows the trailing window a metric summarises; `provenance.windowDays` always reports the window actually used and `coverage.historyDays` the days that actually backed it. Auth via cookie or Bearer.",
      requestParams: {
        query: derivedMetricQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The flat derived-metric value (ok or insufficient).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                derivedMetricResponse,
                "DerivedMetricResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/derived/batch": {
    get: {
      tags: ["Insights"],
      summary: "Derived wellness metrics (batched compute-once)",
      description:
        "v1.10.0 — resolve several derived wellness metrics in ONE request. The `metrics` CSV names the metrics (a `metric:type` token sub-targets a VITALS_BASELINE vital); the server fans out under a bounded limiter with the profile loaded once and returns a map keyed by the per-request token. Collapses the Insights cold-mount fan-out of 14+ independent single-metric requests — the pool-starvation class that surfaces as a hang-then-recover. The single-metric route stays for the per-score detail pages. Auth via cookie or Bearer.",
      requestParams: {
        query: derivedBatchQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The map of derived-metric values, keyed by token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                derivedBatchResponse,
                "DerivedBatchResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/glp1-plateau": {
    get: {
      tags: ["Insights"],
      summary: "GLP-1 weight-plateau detection",
      description:
        "Deterministic (non-LLM) weight-plateau read for users on an active GLP-1 medication: flags a stable dose held for at least the trailing window with no weight loss beyond the threshold. `plateau` is null whenever the condition does not hold, so clients hide the note cleanly. Association only — no verdict, no dose advice. Auth via cookie or Bearer.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Plateau context (or null) plus the window length.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                glp1PlateauResponse,
                "InsightsGlp1PlateauResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/ecg": {
    get: {
      tags: ["Insights"],
      summary: "ECG recording list (metadata only)",
      description:
        "v1.28.50 — the authenticated user's ECG recordings as a cheap, index-covered metadata list (recorded time, duration, sampling rate, sample count, average heart rate, lead, and the DEVICE's own rhythm classification). NEVER decrypts or returns the waveform — the per-recording strip is fetched on demand from GET /api/insights/ecg/{id}. Reflects only the recording device's certified on-device classification, verbatim; HealthLog never re-classifies an ECG or produces a diagnosis. Data-availability-gated: an empty account returns `hasRecordings: false`. Module-gated on `insights`; no assistant-surface gate and no LLM call. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The ECG recording list (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(ecgListResponse, "EcgListResponseEnvelope"),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
    post: {
      tags: ["Insights"],
      summary: "Ingest one ECG recording",
      description:
        "The live ECG ingest: one Apple Watch recording per request, for a client draining its HealthKit ECG observer. Before this existed, a watch ECG could only reach HealthLog inside a full `export.zip`. One recording per request because a 30 s / 512 Hz strip is ~15 360 samples. Samples are INTEGER MICRO-VOLTS (convert from HealthKit's Volts), stored AES-256-GCM encrypted; `sampleCount` and `durationSeconds` are derived server-side. The `classification` is the device's own verdict stored verbatim — HealthLog never reads the waveform to produce or revise one. `source` accepts `APPLE_HEALTH` only; `userId` comes from the session and is never a body field. Unknown body keys are rejected with a 422 naming them. No `Idempotency-Key` is needed: the recording carries its own identity, so a retry resolves to the same row by construction — see `status` for what a re-post reports. Limits: 32 768 samples, 2 MB body, 60 recordings per minute per user. Module-gated on `insights`; no assistant-surface gate and no LLM call. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: ecgIngestRequest },
        },
      },
      responses: {
        "200": {
          description:
            "The recording was already stored: `updated` (same id, overwritten in place) or `duplicate` (already present under a different id, nothing written).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                ecgIngestResponse,
                "EcgIngestResponseEnvelope",
              ),
            },
          },
        },
        "201": {
          description: "A new recording was stored (`status: inserted`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                ecgIngestResponse,
                "EcgIngestCreatedEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/insights/ecg/{id}": {
    get: {
      tags: ["Insights"],
      summary: "One ECG recording with waveform",
      description:
        "v1.28.50 — one recording's decrypted waveform plus metadata and the DEVICE's verbatim classification. Ownership is narrowed in the query where (`{ id, userId }`) so a cross-user read is structurally impossible; a foreign or unknown id 404s (existence sealed). The waveform is AES-256-GCM at rest, decrypted through the fail-closed codec. By default the ~9000-sample strip is min/max-decimated to ~2500 display points so R-wave peaks survive; `?full=1` returns the raw array. HealthLog does not interpret the trace, measure intervals, annotate beats, or emit a verdict of its own. Module-gated on `insights`; no assistant-surface gate and no LLM call. `no-store`. Auth via cookie or Bearer.",
      requestParams: {
        path: z.object({
          id: z.string().describe("The ECG recording id (cuid)."),
        }),
        query: ecgDetailQuery,
      },
      responses: {
        "200": {
          description:
            "The recording's waveform + metadata + device classification.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                ecgDetailResponse,
                "EcgDetailResponseEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No ECG recording with that id for the authenticated user (existence sealed — a foreign id is indistinguishable from a missing one).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/insights/rhythm-events": {
    get: {
      tags: ["Insights"],
      summary: "Device-flagged rhythm/HR/steadiness event timeline",
      description:
        "v1.10.0 (WX-B) — the authenticated user's timeline of device-flagged EVENT rows: irregular-rhythm / high-HR / low-HR / walking-steadiness / breathing-disturbance notifications the user's wearable (Apple Watch / Withings ScanWatch) already produced and synced. AWARENESS / SCREENING of the DEVICE's own decision — HealthLog stores and reflects ONLY the classification result the device's certified on-device algorithm emitted, verbatim; it never re-classifies and never produces a HealthLog diagnosis. `classification` carries the full six-value verdict set (the three ECG verdicts plus the two walking-steadiness severities plus the neutral FIRED verdict) — a distinct, wider enum than the three-value one on GET /api/insights/ecg. Data-availability-gated: an account with no event rows returns `hasEvents: false`. Module-gated on `insights`; no assistant-surface gate and no LLM call. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The device-flagged event timeline (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                rhythmEventsResponse,
                "RhythmEventsResponseEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/insights/correlations": {
    get: {
      tags: ["Insights"],
      summary: "Correlation discovery (FDR-controlled)",
      description:
        "v1.10.0 — scans a curated behaviour × outcome matrix (daylight / mood / glucose / BP / steps × sleep / HRV / resting HR / weight), lag-joins each behaviour day to the next day's outcome, runs Pearson with the exact Student-t p-value, and applies Benjamini-Hochberg FDR control across every tested pair. Only statistically-defensible pairs surface, each carrying n, r, p, and the BH-adjusted q. Descriptive, never causal. Gated by the operator `correlations` assistant surface. Auth via cookie or Bearer.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The discovered correlations + the tested-pair count.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                correlationDiscoveryResponse,
                "CorrelationDiscoveryResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/patterns": {
    get: {
      tags: ["Insights"],
      summary: "List current correlation patterns",
      description:
        "Returns the authenticated account's currently accepted persisted correlation identities, evidence, and dismissal timestamps.",
      responses: {
        "200": {
          description: "Current persisted correlation patterns.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                correlationPatternListResponse,
                "CorrelationPatternListResponseEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/insights/patterns/{id}": {
    patch: {
      tags: ["Insights"],
      summary: "Update correlation pattern dismissal",
      description:
        "Dismisses or restores one current account-owned pattern. A dismissal remains effective until the accepted evidence changes materially.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateCorrelationPatternRequest },
        },
      },
      responses: {
        "200": {
          description: "Updated dismissal decision.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                updateCorrelationPatternResponse,
                "UpdateCorrelationPatternResponseEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "No current pattern with that id for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
};
