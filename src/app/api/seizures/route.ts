/**
 * The seizure diary in one read (#1368).
 *
 *   GET /api/seizures?from=&to= — the record's seizure types, its cluster
 *       rule, the period's events with their rescue doses, and the summary
 *       derived from them (counts, seizure days, the seizure-free streak,
 *       cluster episodes under the record's rule and the NICE count beside
 *       it, the type × month table). Defaults to the last 90 days; at most
 *       three years per read.
 *
 * Everything is derived server-side so every client shows the same figures.
 * Module-gated on the record (`seizures.disabled`); READ on a shared record.
 */
import { NextRequest } from "next/server";

import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  requireSeizuresEnabled,
  seizureMedicationsReachable,
} from "@/lib/seizures/gate";
import {
  readSeizureDiary,
  seizureDiaryQuerySchema,
} from "@/lib/seizures/server";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user, actor, grantId } = await requireRecordAuth("read", "illness");

  const gate = await requireSeizuresEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const sp = request.nextUrl.searchParams;
  const parsed = seizureDiaryQuerySchema.safeParse({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "seizures.invalid",
    });
  }

  const diary = await readSeizureDiary({
    userId: user.id,
    viewerId: actor.id,
    tz: await resolveUserTimezone(user.id),
    from: parsed.data.from ? new Date(parsed.data.from) : undefined,
    to: parsed.data.to ? new Date(parsed.data.to) : undefined,
    medicationsVisible: await seizureMedicationsReachable(grantId),
  });

  annotate({
    action: { name: "seizures.diary.read" },
    meta: {
      events: diary.events.length,
      types: diary.types.length,
      truncated: diary.truncated,
    },
  });

  return apiSuccess(diary);
});
