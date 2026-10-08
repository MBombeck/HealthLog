/**
 * `GET /api/timeline/readiness` — what the timeline can already show, lane by
 * lane, with one link per gap (v1.42, #613). Counts and keys, never a score.
 * The shape is `TimelineReadinessResponse` in `src/lib/day/contract.ts`;
 * `loadTimelineReadiness` builds it.
 *
 * Gated on the opt-in `timeline` module, admitted like the timeline, and
 * narrowed the same way: a lane the grant does not cover is not listed.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { loadTimelineReadiness } from "@/lib/timeline/readiness";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export const GET = apiHandler(async () => {
  const { user, grantId } = await requireRecordAuth("read", "record");
  const gate = await requireModuleEnabled(user.id, "timeline");
  if (!gate.enabled) return gate.response;
  const [modules, domainVisible, tz] = await Promise.all([
    resolveModuleMap(user.id),
    actingDomainVisibility(prisma, grantId),
    resolveUserTimezone(user.id),
  ]);
  const readiness = await loadTimelineReadiness({
    recordId: user.id,
    tz,
    access: { modules, domainVisible, owner: grantId === null },
  });
  annotate({
    action: { name: "timeline.readiness.read" },
    meta: {
      verdict: readiness.verdict,
      lanes: readiness.lanes.length,
      carrying: readiness.lanes.filter((l) => l.status === "carries").length,
    },
  });
  return apiSuccess(readiness);
});
