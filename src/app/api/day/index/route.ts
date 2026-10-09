/**
 * `GET /api/day/index?from=&to=` — which days in a window hold anything, and
 * which of them carry a notable observation (v1.42, #613). Feeds the row of
 * day dots under a chart and the day links in lists; at most
 * `DAY_INDEX_MAX_SPAN_DAYS` days per call. The shape is `DayIndexResponse` in
 * `src/lib/day/contract.ts`.
 *
 * Same admission and the same section narrowing as the day itself: a grant
 * that does not cover a section never sees that section's days.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { loadDayIndex } from "@/lib/day/day-index";
import { resolveDayAccess } from "@/lib/day/sections";
import { dayIndexQuerySchema } from "@/lib/day/wire-schemas";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export const GET = apiHandler(async (request: Request) => {
  const { user, grantId } = await requireRecordAuth("read", "measurements");
  const params = new URL(request.url).searchParams;
  const parsed = dayIndexQuerySchema.safeParse({
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, { errorCode: "day.invalid" });
  }
  const [access, tz] = await Promise.all([
    actingDomainVisibility(prisma, grantId).then((domainVisible) =>
      resolveDayAccess({
        recordId: user.id,
        domainVisible,
        owner: grantId === null,
      }),
    ),
    resolveUserTimezone(user.id),
  ]);
  const index = await loadDayIndex({
    recordId: user.id,
    from: parsed.data.from,
    to: parsed.data.to,
    access,
    tz,
  });
  annotate({
    action: { name: "day.index.read" },
    meta: {
      days: Object.keys(index.days).length,
      notable: index.notable.length,
      delegated: grantId !== null,
    },
  });
  return apiSuccess(index);
});
