/**
 * OpenAPI route table — dashboard widget layout (`/api/dashboard/widgets`)
 * and the native-client aggregator (`/api/dashboard/summary`).
 *
 * v1.32.21 (R5a) — this endpoint was ENTIRELY absent from the registry
 * even though it is the reference implementation for the optimistic-
 * concurrency token contract the native client is being asked to adopt
 * (issue #581, shipped v1.32.16). Documenting it here closes that gap: the
 * contract iOS validates against now carries the `baseUpdatedAt` request
 * field, the `updatedAt` response token, and the 409 conflict envelope.
 *
 * The schema mirrors the inline Zod shape in
 * `src/app/api/dashboard/widgets/route.ts`; the id sets are imported from
 * the single-source `@/lib/dashboard-layout` module so the contract cannot
 * drift. Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  COMPARISON_BASELINES,
  CHART_OVERLAY_KEYS,
  SCORE_RING_IDS,
  HERO_RING_IDS,
  HERO_PRIMARY_CONTENTS,
} from "@/lib/dashboard-layout";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { sleepRhythmResponse } from "./measurements";
import {
  baseUpdatedAtField,
  conflictResponse409,
  dataEnvelope,
  invalidBaseTokenResponse,
  recordRefusal,
  stdResponses,
} from "./shared";

const dashboardWidgetConfig = z.object({
  id: z.enum(DASHBOARD_WIDGET_CATALOGUE_IDS),
  visible: z.boolean(),
  tileVisible: z.boolean().optional(),
  order: z.number().int().min(0).max(99),
});

const dashboardChartOverlayPrefs = z.object({
  showTrendIndicator: z.boolean(),
  showTrendArrow: z.boolean(),
  showTargetRange: z.boolean(),
  comparisonBaseline: z.enum(COMPARISON_BASELINES).optional(),
  rangePoints: z
    .union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)])
    .optional(),
});

// The layout shape shared by GET/PUT/DELETE. Every field except `version` is
// optional so a partial client can preserve fields it does not own.
const dashboardLayoutSchema = z
  .object({
    version: z.literal(1),
    widgets: z.array(dashboardWidgetConfig).min(1).max(50).optional(),
    comparisonBaseline: z.enum(COMPARISON_BASELINES).optional(),
    chartOverlayPrefs: z
      .partialRecord(z.enum(CHART_OVERLAY_KEYS), dashboardChartOverlayPrefs)
      .optional(),
    selectedScoreRings: z.array(z.enum(SCORE_RING_IDS)).max(3).optional(),
    heroRingOrder: z.array(z.enum(HERO_RING_IDS)).max(4).optional(),
    enabledHeroItemKinds: z
      .array(z.enum(PRIORITY_ITEM_KINDS))
      .max(PRIORITY_ITEM_KINDS.length)
      .optional()
      .describe(
        "Today-highlight item kinds in catalogue order. Missing means every current kind is enabled; an empty array disables all kinds.",
      ),
    hero: z
      .enum(HERO_PRIMARY_CONTENTS)
      .optional()
      .describe(
        'Primary hero-card content on the dashboard: "score" (the health-score read, default) or "reminders" (the Today-highlight rail promoted into the hero slot). Missing resolves to "score"; the stored default is omitted from responses.',
      ),
    todayCardVisible: z
      .boolean()
      .optional()
      .describe(
        "v1.42 — whether the dashboard shows its top card (the Today card above the tiles). Missing resolves to `true`; only an explicit `false` hides it. The stored default is omitted. A layout reset (DELETE) shows it again. Additive.",
      ),
  })
  .meta({
    id: "DashboardLayoutBody",
    description:
      "Per-user dashboard widget layout. `widgets` is the ordered tile and chart list. `comparisonBaseline`, `chartOverlayPrefs`, `selectedScoreRings`, `heroRingOrder`, `enabledHeroItemKinds`, `hero`, and `todayCardVisible` are additive dashboard preferences. Every field except `version` is optional on input and preserved when absent from PUT. Missing `enabledHeroItemKinds` resolves to every current kind, while an empty array hides every Today highlight. Widget ids use the closed dashboard catalogue; unknown ids are dropped before validation.",
  });

const dashboardLayoutPutBody = dashboardLayoutSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "DashboardLayoutPutBody",
    description:
      "PUT body for the dashboard layout — the layout fields plus the optional optimistic-concurrency base token (`baseUpdatedAt`). Omit the token for the legacy unconditional write.",
  });

const dashboardLayoutResult = dashboardLayoutSchema
  .extend({
    updatedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Optimistic-concurrency token: the stored row's `updatedAt` at read/write time. Echo it back as `baseUpdatedAt` on the next write. Opaque.",
      ),
  })
  .meta({
    id: "DashboardLayoutResult",
    description:
      "Resolved dashboard layout plus the optimistic-concurrency `updatedAt` token.",
  });

/**
 * The GET-only shape. `unavailableWidgetIds` is resolved per request from
 * the caller's module state and their data, so it belongs to the read and
 * never to the PUT echo — hence a separate schema rather than widening
 * `dashboardLayoutResult`, which both verbs share.
 */
const dashboardLayoutReadResult = dashboardLayoutResult
  .extend({
    unavailableWidgetIds: z
      .array(z.string())
      .optional()
      .describe(
        "Widget ids whose toggle cannot do anything for this account, and which a settings UI should therefore not offer — a switch over a tile that can never paint. Resolved per request from the caller's enabled modules and the data they actually have: `hrv` appears here when the Recovery module is off and the account has no SDNN series, because its only remaining HRV source (nightly RMSSD) is recovery-owned and withheld. Absent when nothing is unavailable. Additive: a client that ignores it behaves exactly as before.",
      ),
  })
  .meta({
    id: "DashboardLayoutReadResult",
    description:
      "Resolved dashboard layout, its `updatedAt` token, and any widget toggles that are unavailable for this account.",
  });

// ── The native-client dashboard aggregator ───────────────────────────
//
// `GET /api/dashboard/summary` predates the registry and is the shape the iOS
// DashboardSummary view decodes. It is a sibling of `/api/dashboard/snapshot`
// and NOT the same payload: the snapshot serves the web first paint from the
// shared builder, this one assembles its own bounded SQL aggregates and
// normalises every metric to an iOS-friendly `kind`.

const dashboardMetricKind = z
  .enum([
    "weight",
    "bloodPressure",
    "pulse",
    "bodyFat",
    "glucose",
    "sleep",
    "steps",
    "totalBodyWater",
    "boneMass",
    "oxygenSaturation",
    "mood",
    "bmi",
  ])
  .meta({ id: "DashboardMetricKind" });

const dashboardMetricCard = z
  .object({
    id: z
      .string()
      .describe(
        "Stable card id. Equal to `kind` for every card except blood pressure, whose id is `bp`.",
      ),
    kind: dashboardMetricKind,
    titleKey: z
      .string()
      .describe(
        "i18n key for the metric's title (e.g. `dashboard.metric.title.weight`). The wire is language-neutral — resolve the key against your own bundle.",
      ),
    latestValue: z
      .number()
      .nullable()
      .describe(
        "Most recent reading regardless of age, systolic for `bloodPressure`, last night's time asleep in HOURS for `sleep`, the latest daily mean for `mood`, and the derived figure for `bmi`. Null when the card is alive on history alone.",
      ),
    secondaryValue: z
      .number()
      .nullable()
      .describe(
        "Diastolic value on the `bloodPressure` card; null on every other kind.",
      ),
    unitKey: z
      .string()
      .describe("i18n key for the display unit, resolved the same way."),
    unit: z
      .string()
      .nullable()
      .describe(
        "Explicit unit token, set only on the `sleep` card (`h`, because its value is a per-night total in hours rather than the canonical SLEEP_DURATION minutes). Null on every other kind.",
      ),
    sleepStages: z
      .record(z.string(), z.number())
      .nullable()
      .describe(
        "Per-stage HOURS for the headline night, sleep card only. Null for every other kind and for a legacy bare-duration night with no stage rows.",
      ),
    sleepSourceDiscrepancy: z
      .object({
        deltaMinutes: z.number().int().nonnegative(),
        sources: z.array(
          z.object({
            source: z.string(),
            deviceType: z.string().nullable(),
            asleepMinutes: z.number().int().nonnegative(),
          }),
        ),
      })
      .nullable()
      .describe(
        "Non-null on the sleep card when two writer buckets reported clearly different asleep totals for the headline night's main session. Observational only — `latestValue` stays the winning writer's total; render a discreet 'sources disagree' hint. Null on every other kind and when the writers agree.",
      ),
    trend: z
      .enum(["up", "down", "flat", "unknown"])
      .describe(
        "First-to-last direction across `sparkline`, with a 1 % (min 1 unit) dead band. `unknown` under two points.",
      ),
    sparkline: z
      .array(z.number())
      .describe(
        "Up to seven points: the last seven DAY rollup buckets for a measured metric regardless of age (daily sum for cumulative metrics such as steps, daily mean otherwise), the trailing nights' asleep hours for `sleep`, the last seven daily means for `mood`, and the trailing derived series for `bmi`. May be empty.",
      ),
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Instant behind `latestValue`, falling back to the metric's newest reading. For `mood` this is the first instant of the latest daily bucket's day in the account's time zone, not a reading time (the series pins a local day, not an instant); formatted in that zone it always lands on the day the entry was logged. For `bmi` it is the WEIGHT metadata, since BMI moves exactly when weight does.",
      ),
    allTimeCount: z
      .number()
      .int()
      .describe(
        "Total readings ever logged for this metric — the gate that keeps a tile visible through a logging gap. Summed across both sides for `bloodPressure`; the mood entry count for `mood`; the WEIGHT count for `bmi`.",
      ),
    lastSeenAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "The metric's newest reading, for the 'last reading N days ago' caption when it is older than the sparkline window.",
      ),
  })
  .meta({
    id: "DashboardMetricCard",
    description:
      "One dashboard metric tile, normalised to the iOS-friendly `kind` rather than the canonical measurement-type enum. A card appears only when the metric has a reading or any history at all, so the array's LENGTH and MEMBERSHIP both vary per account — do not index it positionally.",
  });

const dashboardSummaryResponse = z
  .object({
    greeting: z
      .object({
        salutation: z
          .string()
          .describe(
            "Already-localised greeting including the display name (or username). One of the few strings this payload still translates server-side, in the account's own locale.",
          ),
        date: z.iso.datetime({ offset: true }).describe("Build instant."),
      })
      .describe("Header block."),
    streak: z
      .object({
        currentDays: z
          .number()
          .int()
          .describe(
            "Consecutive logging days up to today in the account's display timezone. Yesterday still counts while today is unlogged, so the streak does not visibly break before the day is over.",
          ),
        longest: z
          .number()
          .int()
          .describe("Longest run inside the trailing 365 days — NOT all time."),
        label: z.string().describe("Already-localised caption."),
      })
      .describe(
        "Logging streak over measurements plus resolved medication intakes (taken or skipped).",
      ),
    compliance: z
      .object({
        scheduledToday: z.number().int(),
        takenToday: z.number().int(),
      })
      .describe(
        "Today's dose tally from the shared projector — every today-window slot, and the ones with a `takenAt` that were not skipped.",
      ),
    highlightInsight: z
      .null()
      .describe(
        "Reserved. The handler pins this to null unconditionally; no code path has ever populated it. Treat it as absent rather than as 'no insight today'.",
      ),
    metrics: z
      .array(dashboardMetricCard)
      .describe(
        "The metric tiles. Filtered against the account's module map AFTER the cache read, so a card whose measurement type belongs to a disabled module is OMITTED rather than refused — the same choice the snapshot sibling and the sync feed make, because refusing the whole aggregate would blank the dashboard over one disabled module.",
      ),
    sleepRhythm: sleepRhythmResponse.describe(
      "The same server-authoritative sleep-debt + chronotype + average-per-night DTO `GET /api/sleep/rhythm` returns, off the same canonical night reconstruction. Always present, with its own calm `partial` / `learning` states — it is NOT gated by the sleep module here, so it can carry figures while the sleep metric CARD is filtered out.",
    ),
    lastUpdated: z.iso
      .datetime({ offset: true })
      .describe("Build instant of the cached body."),
  })
  .meta({
    id: "DashboardSummaryResponse",
    description:
      "The native client's dashboard aggregator: greeting, logging streak, today's dose tally, the per-metric tiles, and the sleep-rhythm DTO. Served through a 60 s fresh / 1 h stale read-through cache, so `greeting.date` and `lastUpdated` can be up to an hour old on a stale-window serve; writes mark the bucket so the account's own action lands on the very next read. No LLM is reachable from this path.",
  });

const chartOverlayPrefsPutBody = z
  .object({
    chartKey: z
      .enum(CHART_OVERLAY_KEYS)
      .describe("Which chart's overlays are being written. Closed enum."),
    prefs: z
      .object({
        showTrendIndicator: z.boolean(),
        showTrendArrow: z.boolean(),
        showTargetRange: z.boolean(),
        comparisonBaseline: z
          .enum(["none", "lastMonth", "lastYear"])
          .optional()
          .describe("Defaults to `none` when omitted."),
        rangePoints: z
          .union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)])
          .optional()
          .describe(
            "Persisted range-tab selection. Optional so a client on an older bundle that never sends it does not 422; omitting it stores the slot WITHOUT the field rather than storing a default.",
          ),
      })
      .describe(
        "The complete overlay state for that chart. The three booleans are REQUIRED — this replaces the chart's slot wholesale rather than merging into it, so a body that names only the toggle being flipped silently clears the other two.",
      ),
  })
  .meta({
    id: "ChartOverlayPrefsPutBody",
    description:
      "One chart's overlay preferences. Partial across CHARTS (only the named `chartKey` is touched, every other chart's slot is preserved) and total WITHIN a chart (the named slot is replaced).",
  });

export const dashboardWidgetPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/dashboard/chart-overlay-prefs": {
    put: {
      tags: ["Dashboard"],
      summary: "Save one chart's overlay preferences",
      description:
        "Writes the overlay toggles for a single chart into the same `dashboardWidgetsJson` blob `GET /api/dashboard/widgets` reads, without the client having to round-trip the whole layout — which is what it exists for: a chart wrapper knows the chart it is flipping and nothing else, and making it re-send the entire widget array would be both wasteful and racy across several charts at once. The read-modify-write runs inside a SERIALIZABLE transaction, so two tabs toggling different charts cannot clobber one another. Note the granularity: partial across charts, TOTAL within one — the named slot is replaced, so a body carrying only the toggle being changed clears the other two. This route accepts NO optimistic-concurrency token, unlike its `/api/dashboard/widgets` sibling; the transaction is what protects it instead. A malformed body is refused with the multi-issue 422 and an audit breadcrumb (`dashboard.chart-overlay.validation-failed`, deduplicated to one row per account per minute so a looping client cannot flood the ledger). Body capped at 64 KiB. Cookie or Bearer auth; the caller is always resolved as themselves, so these are never another record's preferences — the same choice the sibling PUT and DELETE make.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: chartOverlayPrefsPutBody },
        },
      },
      responses: {
        "200": {
          description:
            "Saved. The response confirms the write and does NOT echo the resolved layout — re-read the widget layout if the new state is needed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ saved: z.literal(true) }),
                "ChartOverlayPrefsSavedEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/dashboard/summary": {
    get: {
      tags: ["Dashboard"],
      summary: "Native-client dashboard aggregator",
      description:
        "Assembles the greeting, the logging streak, today's medication tally, the per-metric tiles and the sleep-rhythm DTO in one round-trip from bounded SQL aggregates. Distinct from `GET /api/dashboard/snapshot`, which serves the web first paint from the shared builder: this route normalises every metric to an iOS-friendly `kind` and carries no briefing, no health score and no target bands. Module handling is OMIT, not refuse — a disabled module drops its metric card and leaves the rest of the payload intact. Delegable at MANAGE level over the whole record: the payload is computed across every domain, and there is no provider anywhere on the path. Cookie or Bearer auth.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The dashboard summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardSummaryResponse,
                "DashboardSummaryEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/dashboard/widgets": {
    get: {
      tags: ["Dashboard"],
      summary: "Read the calling user's dashboard widget layout",
      description:
        "Returns the resolved effective layout (defaults merged in if the user has not customised it), the optimistic-concurrency `updatedAt` token, and `unavailableWidgetIds` — any widget whose toggle cannot do anything for this account, which a settings UI should not offer.",
      responses: {
        ...recordRefusal(),
        "200": {
          description:
            "The resolved layout (custom or default) plus its token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardLayoutReadResult,
                "DashboardLayout",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Dashboard"],
      summary: "Replace the calling user's dashboard widget layout",
      description:
        "Persists the layout with preserve-when-absent semantics and returns the normalised layout plus the advanced `updatedAt` token. Optimistic concurrency (v1.32.16): send `baseUpdatedAt` (the token from a prior read) and the write 409s if the stored row changed since — so a committed Save can never be silently reverted by a later request that started from an older snapshot; omit it for the legacy unconditional write. Invalid bodies return the multi-issue 422 envelope.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: dashboardLayoutPutBody },
        },
      },
      responses: {
        "200": {
          description:
            "Layout saved; the normalised layout plus the advanced token is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardLayoutResult,
                "DashboardLayoutSaved",
              ),
            },
          },
        },
        ...conflictResponse409("Dashboard layout", "dashboard_layout_conflict"),
        ...stdResponses,
        ...invalidBaseTokenResponse,
      },
    },
    delete: {
      tags: ["Dashboard"],
      summary: "Reset the calling user's dashboard widget layout",
      description:
        "Resets the tile layout and Today-highlight visibility. It preserves the stored comparison baseline, chart overlays, selected score rings, hero ring order, and hero primary content. Idempotent.",
      responses: {
        "200": {
          description:
            "Web-controlled layout settings reset; preserved dashboard preferences are returned with the defaults.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardLayoutResult,
                "DashboardLayoutReset",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
