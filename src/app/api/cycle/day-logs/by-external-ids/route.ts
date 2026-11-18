/**
 * `DELETE /api/cycle/day-logs/by-external-ids` — the iPhone app's deletion
 * reconciliation for cycle days it imported from Apple Health.
 *
 * Body `{ externalIds }` (at most 500), answer `{ deletedCount }`. Gated like
 * every cycle route (`cycle.disabled` 403). Only the caller's own
 * `APPLE_HEALTH` day-logs are matched; anything else is a no-op. Each is
 * soft-deleted with the cycle it opened, as the single delete does
 * (`deleteAppleHealthCycleDayLogs`). The envelope is shared with the other
 * by-external-ids routes (`src/lib/sync/external-id-delete.ts`).
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { deleteAppleHealthCycleDayLogs } from "@/lib/cycle/delete-by-external-ids";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import {
  answerExternalIdDelete,
  parseExternalIdDelete,
} from "@/lib/sync/external-id-delete";

export const DELETE = apiHandler(async (request: NextRequest) => {
  // The owner's own device reconciling its own imports, as on the bulk
  // ingest: a cookie session or the native client's wildcard token.
  const { user } = await requireAuth();

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const body = await parseExternalIdDelete(request, "cycle.day-log");
  if (!body.ok) return body.error;

  const { deleted } = await deleteAppleHealthCycleDayLogs(
    user.id,
    body.externalIds,
  );
  return answerExternalIdDelete({
    request,
    userId: user.id,
    domain: "cycle.day-log",
    processed: body.externalIds.length,
    deleted,
  });
});
