/**
 * `GET /api/day/notable?from=&to=` — what changed and what stood out in a
 * window, for the preparation of the next visit (v1.42, #613). Without
 * `from` the window starts at the last completed visit the caller may see;
 * without `to` it ends today. The shape is `DayNotableWindowResponse` in
 * `src/lib/day/contract.ts`.
 *
 * Observations and changes only, as keys and the record's own names: no
 * value judgement, no cause. Same admission and section narrowing as the day.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { resolveDayAccess } from "@/lib/day/sections";
import { loadSinceLastVisit } from "@/lib/day/visit-preparation";
import { dayNotableQuerySchema } from "@/lib/day/wire-schemas";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export const GET = apiHandler(async (request: Request) => {
  const { user, grantId } = await requireRecordAuth("read", "measurements");
  const params = new URL(request.url).searchParams;
  const parsed = dayNotableQuerySchema.safeParse({
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
  const window = await loadSinceLastVisit({
    recordId: user.id,
    access,
    tz,
    today: userDayKey(new Date(), tz),
    from: parsed.data.from,
    to: parsed.data.to,
  });
  annotate({
    action: { name: "day.notable.read" },
    meta: {
      anchor: window.anchor,
      observations: window.observations.length,
      changes: window.changes.length,
      delegated: grantId !== null,
    },
  });
  return apiSuccess(window);
});
