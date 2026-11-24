/**
 * `GET /api/insights/context?from=&to=` — what happened around a metric: the
 * medication starts, stops, dose changes and pauses, the illness episodes and
 * the cycle phases a metric chart draws as marks over its line. The shape is
 * `ChartContextResponse` in `src/lib/charts/context-markers-contract.ts`;
 * `loadChartContext` builds it from the timeline's own lane readers.
 *
 * Not gated on the `timeline` module: a chart is not the timeline. Each part
 * is read only when its lane is visible (its module on, its section shared),
 * so a switched-off module or an unshared section sends an empty list.
 * Admission declares the whole record, like the timeline: the answer lays
 * several sections side by side, and a grant scoped to some of them does
 * not open it. The default Bearer arm applies: a narrow token is refused.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { loadChartContext } from "@/lib/charts/context-markers";
import { chartContextQuerySchema } from "@/lib/charts/context-markers-contract";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { resolveModuleMap } from "@/lib/modules/gate";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export const GET = apiHandler(async (request: Request) => {
  const { user, grantId } = await requireRecordAuth("read", "record");

  const params = new URL(request.url).searchParams;
  const parsed = chartContextQuerySchema.safeParse({
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "insights.context.invalid",
    });
  }

  const [modules, domainVisible, tz] = await Promise.all([
    resolveModuleMap(user.id),
    actingDomainVisibility(prisma, grantId),
    resolveUserTimezone(user.id),
  ]);
  const context = await loadChartContext({
    recordId: user.id,
    tz,
    access: { modules, domainVisible, owner: grantId === null },
    from: parsed.data.from,
    to: parsed.data.to,
  });
  annotate({
    action: { name: "insights.context.read" },
    meta: {
      medications: context.medications.length,
      illnesses: context.illnesses.length,
      cyclePhases: context.cyclePhases.length,
      windowed: parsed.data.from !== undefined,
    },
  });
  return apiSuccess(context);
});
