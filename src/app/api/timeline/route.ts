/**
 * `GET /api/timeline?zoom=&from=&to=&values=` — the record laid out over the
 * years (v1.42, #613): lanes of conditions, medications, visits, documents and
 * life events, the standing items without a start, and value series by zoom.
 * The shape is `TimelineResponse` in `src/lib/day/contract.ts`; `loadTimeline`
 * builds it.
 *
 * Gated on the opt-in `timeline` module. Admission declares the whole record:
 * the timeline lays every section side by side, so a grant scoped to some of
 * them does not open it. The lanes are narrowed to the grant's domains all
 * the same (`actingDomainVisibility`), so the day this admission is reviewed
 * and narrowed the loader already reads no lane it should not.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { timelineQuerySchema } from "@/lib/day/wire-schemas";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { loadTimeline, parseSeriesKeys } from "@/lib/timeline/load-timeline";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export const GET = apiHandler(async (request: Request) => {
  const { user, grantId } = await requireRecordAuth("read", "record");
  const gate = await requireModuleEnabled(user.id, "timeline");
  if (!gate.enabled) return gate.response;

  const params = new URL(request.url).searchParams;
  const parsed = timelineQuerySchema.safeParse({
    zoom: params.get("zoom") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    values: params.get("values") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "timeline.invalid",
    });
  }
  if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
    return apiError("`from` must not be after `to`", 422, {
      errorCode: "timeline.invalid",
    });
  }
  const seriesKeys = parseSeriesKeys(parsed.data.values);
  if (seriesKeys === null) {
    return apiError("Unknown value series, or more than six", 422, {
      errorCode: "timeline.invalid",
    });
  }

  const [modules, domainVisible, tz] = await Promise.all([
    resolveModuleMap(user.id),
    actingDomainVisibility(prisma, grantId),
    resolveUserTimezone(user.id),
  ]);
  const timeline = await loadTimeline({
    recordId: user.id,
    query: parsed.data,
    seriesKeys,
    access: { modules, domainVisible, owner: grantId === null },
    tz,
  });
  annotate({
    action: { name: "timeline.read" },
    meta: {
      zoom: timeline.zoom,
      lanes: timeline.lanes.length,
      items: timeline.lanes.reduce((n, l) => n + l.items.length, 0),
      series: timeline.series.length,
      notable: timeline.notable.length,
    },
  });
  return apiSuccess(timeline);
});
