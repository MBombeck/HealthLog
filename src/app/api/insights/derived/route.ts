/**
 * v1.10.0 — generic derived-wellness-metric route.
 *
 * `GET /api/insights/derived?metric=<DERIVED_METRIC_ID>[&type=<MeasurementType>][&windowDays=N]`
 * serves the compute-once `Derived<T>` value for any metric registered
 * in `derived/registry.ts`. Mirrors the v1.8.7.1 `metric-status` route
 * precedent: `apiHandler` wrapper, Zod `safeParse` on the query, a closed
 * registry enum (unknown id → 422 via `returnAllZodIssues`), cookie OR
 * Bearer auth, `userId` narrowed from the session/Bearer (never a query
 * field).
 *
 * The `data` payload is the flat `Derived<T>` union so iOS can decode +
 * combine values across metrics: `{ metric, status, value?, coverage,
 * confidence?, provenance, reason? }`. Numbers are pure compute over the
 * rollup tier (Tier-1, no narrative) — no provider call, no cache table.
 *
 * Wave 1 implements `VITALS_BASELINE` end-to-end; other registered ids
 * return a `not_implemented` insufficient until their compute lands in a
 * later wave (never a 500, never a fabricated value).
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled, type ModuleKey } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import {
  computeDerivedMetric,
  loadBaselineProfile,
  DERIVED_METRIC_IDS,
  type DerivedMetricId,
} from "@/lib/insights/derived";
import { DERIVED_MAX_WINDOW_DAYS } from "@/lib/insights/derived/types";
import { resolveDerivedAssessment } from "@/lib/insights/derived/derived-assessment-ai";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

export const dynamic = "force-dynamic";

/**
 * Derived scores that are NATIVE to a toggleable module rather than a core
 * vital. SLEEP_SCORE is the sleep module's; the strain / recovery / stress
 * trio belongs to the WHOOP/Polar recovery module. READINESS equals the
 * computed recovery score (same number, recovery-native), so it is gated on
 * the recovery module too. The remaining composite baselines
 * (VITALS_BASELINE, HRV_BALANCE, …) read off core vitals and stay open — a
 * metric absent from this map carries no module gate. Exported so the batch
 * route gates on the SAME map and the two routes cannot drift.
 */
export const DERIVED_MODULE: Partial<Record<DerivedMetricId, ModuleKey>> = {
  SLEEP_SCORE: "sleep",
  RECOVERY_SCORE: "recovery",
  STRAIN_SCORE: "recovery",
  STRESS_SCORE: "recovery",
  READINESS: "recovery",
};

// Closed enum derived from the registry so the route + registry cannot
// drift — an id added to the registry is accepted automatically, an
// unknown id 422s rather than silently resolving to no metric.
const derivedQuerySchema = z.object({
  metric: z.enum(DERIVED_METRIC_IDS as [string, ...string[]]),
  // Optional sub-target for metrics that baseline a single chosen vital
  // (VITALS_BASELINE). Validated against the engine's supported set in
  // the dispatcher; an unsupported value yields an `insufficient`, not a
  // 422, so the contract stays forgiving for iOS combinations.
  type: z.string().optional(),
  // Trailing window override, in days. Absent means "engine default" — each
  // compute keeps its own (14 for the wellness trend, 30 for the baselines, a
  // year for vascular age), so omitting the parameter changes nothing. The
  // ceiling is the point past which the derived engines stop resolving against
  // DAY rollup buckets and degrade to an uncapped raw read; the reasoning is
  // written out at `DERIVED_MAX_WINDOW_DAYS`. Out of range is a 422 rather
  // than a silent clamp: a caller that asked for a year should learn that it
  // is not on offer, not read back a number it did not choose.
  windowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(DERIVED_MAX_WINDOW_DAYS)
    .optional(),
});

export const GET = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE-level read: a generated assessment over the whole
  // record, which is not a section a scoped grant can name. The miss behind it
  // enqueues nothing while a delegate is holding the request.
  const { user } = await requireRecordAuth("manage", "record");

  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;

  // v1.15.20 — shared analytics-read budget (generous; caps runaway loops).
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  // Pure compute over the rollup tier, so no assistant-surface gate:
  // switching the assistant off does not blank the derived tiles.

  const parsed = derivedQuerySchema.safeParse({
    metric: request.nextUrl.searchParams.get("metric"),
    type: request.nextUrl.searchParams.get("type") ?? undefined,
    windowDays: request.nextUrl.searchParams.get("windowDays") ?? undefined,
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.derived.invalid-metric" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }
  const metric = parsed.data.metric as DerivedMetricId;

  // Per-domain gate: a derived score owned by a toggleable module
  // (sleep / recovery) is refused with a 403 module.disabled envelope when
  // the account has that module turned off. Core-vital composites stay open.
  const moduleKey = DERIVED_MODULE[metric];
  if (moduleKey) {
    const gate = await requireModuleEnabled(user.id, moduleKey);
    if (!gate.enabled) return gate.response;
  }

  const profile = await loadBaselineProfile(prisma, user.id);
  const derived = await computeDerivedMetric({
    metric,
    userId: user.id,
    profile,
    type: parsed.data.type ?? null,
    windowDays: parsed.data.windowDays,
  });

  annotate({
    action: { name: "insights.derived" },
    meta: {
      metric,
      status: derived.status,
      // Both halves of the window story: what the caller asked for (null when
      // they asked for nothing) and what the engine actually read. They differ
      // for a metric that composes fixed per-pillar windows, and a dashboard
      // that sees them drift apart is looking at a real answer, not a bug.
      window_days_requested: parsed.data.windowDays ?? null,
      window_days_effective: derived.provenance.windowDays,
    },
  });

  // v1.13.2 — additive per-score assessment: a short "why is this score what
  // it is" explanation, keyed to the SAME id the caller passed (READINESS,
  // SLEEP_SCORE, RECOVERY_SCORE, STRAIN_SCORE, STRESS_SCORE). Null for any
  // other id, and null when status !== "ok". Always a non-empty deterministic
  // text when present (the demo + provider-less accounts fill); warmer AI
  // prose overrides it once cached. The warm enqueue is fire-and-forget — this
  // never blocks on an LLM round-trip.
  const localeParam = request.nextUrl.searchParams.get("locale");
  const resolvedLocale = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: localeParam,
  });
  const assessment = await resolveDerivedAssessment({
    metric,
    userId: user.id,
    derived,
    locale: resolvedLocale,
  });

  // Flatten the discriminated union for the wire: `metric` tags it,
  // `value`/`reason` are nullable so iOS decodes one stable shape.
  return apiSuccess({
    metric,
    status: derived.status,
    value: derived.status === "ok" ? derived.value : null,
    coverage: derived.coverage,
    confidence: derived.status === "ok" ? derived.confidence : null,
    provenance: derived.provenance,
    reason: derived.status === "insufficient" ? derived.reason : null,
    assessment,
  });
});
