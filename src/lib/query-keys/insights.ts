/**
 * Query keys — insights tree: comprehensive payloads, status assessments,
 * derived metrics, correlations, layout, and AI settings.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const insightsKeys = {
  insightsRoot: () => ["insights"] as const,
  insightsComprehensive: () => ["insights", "comprehensive"] as const,
  insightsTargets: () => ["insights", "targets"] as const,
  /**
   * Shared cache key for the rich `/api/insights/generate` advisor
   * payload. Every surface that subscribes under this key shares the
   * same cache so a regenerate on one surface refreshes the others
   * without a second LLM round-trip.
   */
  insightsAdvisor: () => ["insights", "advisor"] as const,
  /**
   * v1.11.0 — period-narrative summary (`/api/insights/narrative?period=…`).
   * Keyed by period + locale so the week and month summaries cache
   * independently and a locale switch fetches the matching prose.
   */
  insightsNarrative: (period: string, locale: string) =>
    ["insights", "narrative", period, locale] as const,
  insightsBpStatus: (locale: string) =>
    ["insights", "blood-pressure-status", locale] as const,
  insightsWeightStatus: (locale: string) =>
    ["insights", "weight-status", locale] as const,
  insightsPulseStatus: (locale: string) =>
    ["insights", "pulse-status", locale] as const,
  insightsBmiStatus: (locale: string) =>
    ["insights", "bmi-status", locale] as const,
  insightsMoodStatus: (locale: string) =>
    ["insights", "mood-status", locale] as const,
  insightsMedicationComplianceStatus: (locale: string) =>
    ["insights", "medication-compliance-status", locale] as const,
  /**
   * v1.8.7.1 — per-metric insight assessment for the HealthKit metric
   * sub-pages. One generic route (`/api/insights/metric-status?metric=…`)
   * backs every HealthKit metric, so the key is parameterised by the
   * metric id alongside the locale rather than minting a bespoke factory
   * entry per metric. The seven bespoke `*-status` routes above keep
   * their own keys; this one covers the ~29 generic HealthKit pages.
   */
  insightsMetricStatus: (metric: string, locale: string) =>
    ["insights", "metric-status", metric, locale] as const,
  /**
   * Per-biomarker assessment for the lab-marker detail page. One generic
   * route (`/api/insights/biomarker-assessment?biomarkerId=…`) backs every
   * marker, so the key is parameterised by the marker id alongside the
   * locale. Same read-only + stale-while-revalidate contract as
   * `insightsMetricStatus`; the `["insights"]` prefix keeps it in the
   * standard invalidation fan-out.
   */
  insightsBiomarkerAssessment: (biomarkerId: string, locale: string) =>
    ["insights", "biomarker-assessment", biomarkerId, locale] as const,
  /**
   * v1.8.7.1 — mutationKey for the on-demand full-warm POST
   * (`/api/insights/pregenerate`). Lives in the factory so the bare-array
   * ESLint rule stays satisfied; the warm enqueues every assessment
   * generation on the worker, so there is no read cache to invalidate
   * here — the existing status queries pick up the warmed text via their
   * own stale-while-revalidate.
   */
  insightsPregenerate: () => ["insights", "pregenerate"] as const,
  /**
   * v1.10.0 — categorical events (WX-B). The device-flagged event
   * awareness timeline (`/api/insights/rhythm-events`). No locale segment
   * — the payload is verdicts + timestamps; the surface localises its own
   * prose. The `["insights"]` prefix keeps it in the standard insights
   * invalidation fan-out (an Apple Health batch write that lands an event
   * row busts it via the prefix).
   */
  insightsRhythmEvents: () => ["insights", "rhythm-events"] as const,
  /**
   * v1.28.50 — ECG recording surface. The metadata list
   * (`/api/insights/ecg`) and the per-recording waveform detail
   * (`/api/insights/ecg/[id]`). The detail key carries the recording id
   * plus a `full` discriminant so the fit-to-width overview waveform and
   * the raw `?full=1` true-calibration array cache independently and never
   * poison each other (same key + different sample density would). Both
   * sit under the `["insights"]` prefix so a sync that lands a new
   * recording busts them via the standard insights invalidation fan-out.
   */
  insightsEcgList: () => ["insights", "ecg"] as const,
  insightsEcgDetail: (id: string, full: boolean) =>
    ["insights", "ecg", id, full ? "full" : "overview"] as const,
  /**
   * S11 — the intraday pulse / tension layer (`/api/insights/pulse/intraday`).
   * Keyed by the viewed local day so each day's 10-minute-mean shape caches
   * independently and yesterday's curve never poisons today's. Under the
   * `["insights"]` prefix so a fresh PULSE write busts it via the standard
   * insights invalidation fan-out.
   */
  insightsPulseIntraday: (dateKey: string) =>
    ["insights", "pulse-intraday", dateKey] as const,
  /**
   * v1.10.0 — derived-wellness metrics. One generic route
   * (`/api/insights/derived?metric=…[&type=…]`) backs the vitals
   * dashboard tiles, the composite score-anatomy view, and the home
   * wellness strip — all through the one `useDerivedMetric` hook.
   *
   * One generic route backs every derived metric (sleep score, readiness,
   * coincident-deviation, vitals baseline, …); the optional sub-type is the
   * chosen vital for `VITALS_BASELINE`. The fourth tuple slot is always
   * present (`null` when no sub-type) so the cache never poisons between a
   * 3-element and a 4-element shape for the same metric prefix. Pure compute
   * over the rollup tier — a measurement write keeps it fresh by construction
   * (next read sees new buckets), so the `["insights"]` prefix carries the
   * invalidation fan-out.
   */
  insightsDerived: (metric: string, type?: string | null) =>
    ["insights", "derived", metric, type ?? null] as const,
  /**
   * v1.10.0 — batched derived-metric read (`/api/insights/derived/batch`).
   * One request resolves the whole dashboard grid server-side instead of N
   * concurrent single-metric reads sharing the Prisma pool. Keyed by the
   * sorted token list so the same grid always hits one cache entry; sits
   * under the `["insights", "derived"]` prefix so a measurement-write
   * invalidation fan-out reaches it exactly like the single-metric reads.
   */
  insightsDerivedBatch: (tokens: readonly string[]) =>
    ["insights", "derived", "batch", [...tokens].sort().join(",")] as const,
  /**
   * v1.42 — one score's daily history (`/api/insights/score-history`), per
   * score and window. Under the `["insights"]` prefix so the measurement-write
   * invalidation fan-out reaches it with the derived reads.
   */
  insightsScoreHistory: (score: string, days: number) =>
    ["insights", "score-history", score, days] as const,
  /**
   * v1.10.0 — FDR-controlled correlation discovery
   * (`/api/insights/correlations`). Read-only descriptive surface; the
   * `["insights"]` prefix keeps it in the existing invalidation fan-out.
   */
  insightsCorrelations: () => ["insights", "correlations"] as const,

  /**
   * v1.4.41 W-FRONTEND-FACTORY — Settings → AI surfaces (provider chain,
   * insights settings, user provider preference) and the targets editor
   * all read these endpoints; centralising the keys keeps invalidation
   * symmetrical with the user-thresholds + auth surfaces.
   */
  insightsSettings: () => ["insights", "settings"] as const,
  insightsProviderChain: () => ["insights", "provider-chain"] as const,
  insightsGlp1Timeline: (limit: number | string) =>
    ["insights", "glp1-timeline", limit] as const,
  /**
   * v1.28.21 — GLP-1 weight-plateau read (`/api/insights/glp1-plateau`).
   * Per-user, no params; the `["insights"]` prefix keeps it inside the
   * existing invalidation fan-out.
   */
  insightsGlp1Plateau: () => ["insights", "glp1-plateau"] as const,

  /**
   * v1.5.5 — per-user insights tile layout (mirrors
   * `dashboardWidgets`). The Settings UI + the iOS client + the
   * `/insights` shell all read this key; the PUT mutation invalidates
   * it on save so every consumer paints the new layout in lockstep.
   */
  insightsLayout: () => ["user", "insightsLayout"] as const,

  /**
   * v1.11.4 item J — bounded 30-day daily-aggregate read backing the
   * Insights Trends-row deterministic caption (`trend-descriptor.ts`).
   * Keyed by the comma-joined measurement type set so each card's slot
   * caches its own small window (≤ 30 rollup rows). Distinct from
   * `chartData(...)` so the caption never re-keys when the chart's
   * internal value-mode / scale / range state changes; it only needs the
   * raw 30-day series to derive direction + magnitude. Shares the
   * `["trend-series"]` invalidation prefix so a measurement write
   * refreshes the caption in lockstep with the chart.
   */
  insightsTrendSeries: (types: string) => ["trend-series", types] as const,

  /**
   * v1.21.2 (A1) — per-metric "Coach read" strip
   * (`/api/insights/coach-read?metric=<MeasurementType>`). One generic route
   * backs every metric sub-page, so the key is parameterised by the
   * MeasurementType. Pure compute over the baseline + correlation engines —
   * the `["insights"]` prefix keeps it in the standard invalidation fan-out
   * (a measurement write busts it so the placement refreshes).
   *
   * Keyed by locale as well: the strip's second line is prose the server
   * writes in the reader's language, so a cache entry belongs to one language
   * only. Without the segment, switching language re-used the German page's
   * cached English sentence — the fix on the server would have been invisible
   * to anyone who switched rather than reloaded. Same reason
   * `insightsMetricStatus` carries it.
   */
  insightsCoachRead: (metric: string, locale: string) =>
    ["insights", "coach-read", metric, locale] as const,

  /**
   * v1.25 — baseline-drift read (`/api/insights/health-status`). Combines the
   * personal-band deviations + the dated changepoint shifts into one awareness
   * card. Pure compute over the rollup tier; the `["insights"]` prefix keeps it
   * in the standard invalidation fan-out (a measurement write busts it).
   */
  insightsHealthStatus: () => ["insights", "health-status"] as const,

  /**
   * v1.25 — breathing-disturbance screening read
   * (`/api/insights/breathing-screening`). Last ~30 nights of the per-night
   * index + device-flagged events. The `["insights"]` prefix carries the
   * invalidation fan-out from an Apple Health sleep batch write.
   */
  insightsBreathingScreening: () =>
    ["insights", "breathing-screening"] as const,

  /**
   * v1.25 — "what changed since your last panel" read
   * (`/api/insights/labs-changes`). The two most-recent numeric lab panels'
   * shared-analyte deltas. The `["insights"]` prefix keeps it in the standard
   * invalidation fan-out.
   */
  insightsLabsChanges: () => ["insights", "labs-changes"] as const,
};
