/**
 * `GET /api/day/{date}` — one local day across the record (v1.42, #613): what
 * ran through it, the readings in its window, what happened on it, and the
 * few deterministic observations worth a second look. The shape is
 * `DayResponse` in `src/lib/day/contract.ts`; `loadDay` builds it.
 *
 * Core, not a module: the day opens for every account. Sections of a
 * switched-off module are left out.
 *
 * Admission: a read of the record's readings (`measurements`), narrowed
 * section by section after that. The day is built around the readings, so a
 * grant has to open them before it opens the day; every other section is then
 * read only when the grant also covers that section's own domain
 * (`actingDomainVisibility`, the same predicate the body-site and visit routes
 * narrow with), and a section it does not cover is named in `sections` with
 * `not_shared` and never read. No section can show a delegate more than the
 * section's own route would: the domain each one maps to is the one those
 * routes declare (`src/lib/day/sections.ts`).
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { loadDay } from "@/lib/day/load-day";
import { resolveDayAccess } from "@/lib/day/sections";
import { dayPathSchema } from "@/lib/day/wire-schemas";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";

type RouteParams = { params: Promise<{ date: string }> };

export const GET = apiHandler(async (_request: Request, ctx: RouteParams) => {
  const { user, grantId } = await requireRecordAuth("read", "measurements");
  const parsed = dayPathSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, { errorCode: "day.invalid" });
  }
  const access = await resolveDayAccess({
    recordId: user.id,
    domainVisible: await actingDomainVisibility(prisma, grantId),
    owner: grantId === null,
  });
  const day = await loadDay({
    recordId: user.id,
    day: parsed.data.date,
    access,
  });
  annotate({
    action: { name: "day.read" },
    meta: {
      values: day.counts.values,
      entries: day.counts.entries,
      running: day.running.length,
      notable: day.notable.length,
      not_shared: Object.keys(day.sections).length,
      delegated: grantId !== null,
    },
  });
  return apiSuccess(day);
});
