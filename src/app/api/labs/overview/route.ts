import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { categoriseOverview } from "@/lib/labs/marker-category";
import { loadLabOverview } from "@/lib/labs/overview";
import { annotate } from "@/lib/logging/context";
import { labOverviewQuerySchema } from "@/lib/validations/labs";

/**
 * `GET /api/labs/overview` — one entry per biomarker over the caller's whole
 * live lab history: the newest reading, the reading count and a short trend.
 * The Labs list renders from this instead of grouping a capped page of raw
 * rows, so a marker measured only long ago still has its row. Same read gate
 * as `GET /api/labs` (`requireRecordAuth("read", "labs")`).
 *
 * `categories` and `grouped` are the list's categories, resolved here once
 * (`src/lib/labs/marker-category.ts`): order, label, members, counts and a
 * combined status. Labels follow the viewer's locale, so on a managed record
 * the caller's own language wins, not the record owner's.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user, actor } = await requireRecordAuth("read", "labs");

  const parsed = labOverviewQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    annotate({
      action: { name: "labs.overview.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const markers = await loadLabOverview(user.id);
  const locale = await resolveServerLocale({
    request,
    userLocale: actor.locale ?? null,
  });
  const { categories, grouped } = categoriseOverview(markers, locale);
  annotate({
    action: { name: "labs.overview" },
    meta: { markers: markers.length, categories: categories.length, grouped },
  });
  return apiSuccess({ markers, categories, grouped });
});
