/**
 * `DELETE /api/mood-entries/by-external-ids` — the iPhone app's deletion
 * reconciliation for State of Mind entries it imported from Apple Health.
 *
 * Body `{ externalIds }` (at most 500), answer `{ deletedCount }`. Only the
 * caller's own entries posted with `source = APPLE_HEALTH` are matched; a
 * mood logged in HealthLog is never touched. Each is soft-deleted as the
 * single delete does (`deleteAppleHealthMoodEntries`). The envelope is shared
 * with the other by-external-ids routes (`src/lib/sync/external-id-delete.ts`).
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { deleteAppleHealthMoodEntries } from "@/lib/mood/delete-by-external-ids";
import {
  answerExternalIdDelete,
  parseExternalIdDelete,
} from "@/lib/sync/external-id-delete";

export const DELETE = apiHandler(async (request: NextRequest) => {
  // The owner's own device reconciling its own imports, as on the bulk
  // ingest: a cookie session or the native client's wildcard token.
  const { user } = await requireAuth();

  const body = await parseExternalIdDelete(request, "mood");
  if (!body.ok) return body.error;

  const deleted = await deleteAppleHealthMoodEntries(user.id, body.externalIds);
  return answerExternalIdDelete({
    request,
    userId: user.id,
    domain: "mood",
    processed: body.externalIds.length,
    deleted,
  });
});
