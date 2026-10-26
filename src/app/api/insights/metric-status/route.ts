/**
 * v1.8.7.1 — generic per-HealthKit-metric assessment route.
 *
 * `GET /api/insights/metric-status?metric=<METRIC_ID>` serves the
 * data-driven assessment for any metric registered in
 * `metric-status-registry.ts` (RESTING_HEART_RATE, SLEEP_DURATION, …).
 * The seven specialised metrics keep their own `*-status` routes; this
 * single generic route covers the ~30 HealthKit pages without one route
 * per metric.
 *
 * Read-only by construction (v1.8.3 freeze fix): a cache miss enqueues an
 * out-of-band generation and serves the last-good (stale-while-revalidate)
 * text, never blocking on the provider. An unknown `metric` 422s via the
 * closed registry enum.
 *
 * A mixed read: the note is model text, served (and warmed on a miss) only
 * while the `statusText` AI capability is available. Otherwise the route
 * answers 200 with no note, `insufficient` still computed from the data, and
 * an `ai` state saying why; the cache is not read and nothing is queued. The
 * `insights` module (the AI analysis opt-out) folds into the capability.
 *
 * Unlike the seven legacy `*-status` routes, this one carries OpenAPI
 * coverage (the route schema lives in `src/lib/openapi/routes.ts`),
 * establishing the pattern the legacy routes can be backfilled onto later.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { requireModuleEnabled, type ModuleKey } from "@/lib/modules/gate";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { unavailableStatusBody } from "@/lib/insights/status-unavailable";
import { prisma } from "@/lib/db";
import { generateMetricStatus } from "@/lib/insights/metric-status";
import { normalizeLocale } from "@/lib/insights/status-shared";
import {
  METRIC_STATUS_IDS,
  getMetricStatusMeta,
  type MetricStatusMetricId,
} from "@/lib/insights/metric-status-registry";

export const dynamic = "force-dynamic";

/**
 * The handful of generic metrics whose assessment belongs to a toggleable
 * module rather than a core vital. Everything else this route serves
 * (resting heart rate, body composition, gait, environmental exposure, …)
 * is a core/always-on signal and stays ungated. A metric absent from this
 * map is core by construction.
 */
const METRIC_MODULE: Partial<Record<MetricStatusMetricId, ModuleKey>> = {
  SLEEP_DURATION: "sleep",
  BREATHING_DISTURBANCES: "sleep",
  SLEEP_SCORE: "sleep",
  BLOOD_GLUCOSE: "glucose",
  CARDIO_RECOVERY: "recovery",
  // v1.18.1 — device-native recovery / strain signals gate on the
  // recovery module like CARDIO_RECOVERY.
  ANS_CHARGE: "recovery",
  DAY_STRAIN: "recovery",
  WORKOUT_STRAIN: "recovery",
  CARDIO_LOAD: "recovery",
  AVERAGE_HEART_RATE: "recovery",
  MAX_HEART_RATE: "recovery",
  ENERGY_EXPENDITURE_KJ: "recovery",
};

// Closed enum derived from the registry so the route + registry cannot
// drift — an id added to the registry is accepted automatically, and an
// unknown id 422s rather than silently resolving to no card.
const metricQuerySchema = z.object({
  metric: z.enum(METRIC_STATUS_IDS as [string, ...string[]]),
});

export const GET = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE-level read: a generated assessment over the whole
  // record, which is not a section a scoped grant can name. The miss behind it
  // enqueues nothing while a delegate is holding the request.
  const { user } = await requireRecordAuth("manage", "record");
  const parsed = metricQuerySchema.safeParse({
    metric: request.nextUrl.searchParams.get("metric"),
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.metric-status.invalid-metric" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }
  const metric = parsed.data.metric as MetricStatusMetricId;

  // Per-domain gate: a metric that belongs to a toggleable module
  // (sleep / glucose / recovery) is refused with a 403 module.disabled
  // envelope when the account has that module turned off. Core vitals,
  // body composition, gait and environmental signals carry no module and
  // stay open.
  const moduleKey = METRIC_MODULE[metric];
  if (moduleKey) {
    const gate = await requireModuleEnabled(user.id, moduleKey);
    if (!gate.enabled) return gate.response;
  }

  const ai = await aiCapabilityToServe(user.id, "statusText");
  if (!ai.available) {
    // The note is not served, but whether there is anything to assess is
    // data: the card keeps its insufficient-data state.
    const meta = getMetricStatusMeta(metric);
    const readings = meta
      ? await prisma.measurement.count({
          where: {
            userId: user.id,
            type: meta.measurementType,
            deletedAt: null,
          },
        })
      : 0;
    annotate({
      action: { name: "insights.metric-status.unavailable" },
      meta: { metric, reason: ai.reason },
    });
    return apiSuccess({
      ...(await unavailableStatusBody(user.id, ai)),
      insufficient: readings === 0,
    });
  }

  const localeParam = request.nextUrl.searchParams.get("locale");
  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: localeParam,
  });
  const locale = normalizeLocale(resolved);

  const result = await generateMetricStatus({
    metric,
    userId: user.id,
    locale,
    force: false,
    readOnly: true,
  });

  annotate({
    action: { name: "insights.metric-status" },
    meta: { metric },
  });

  return apiSuccess({ ...result, ai });
});
