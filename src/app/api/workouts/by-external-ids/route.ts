/**
 * `DELETE /api/workouts/by-external-ids` — the iPhone app's deletion
 * reconciliation for workouts it imported from Apple Health.
 *
 * Body `{ externalIds }` (at most 500), answer `{ deletedCount }`. Only the
 * caller's own `APPLE_HEALTH` workouts are matched; anything else is a no-op.
 * The rows are removed outright with the personal records they set, as the
 * single delete removes a hand-entered one (`deleteAppleHealthWorkouts`).
 * The envelope is shared with the other by-external-ids routes
 * (`src/lib/sync/external-id-delete.ts`).
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  answerExternalIdDelete,
  parseExternalIdDelete,
} from "@/lib/sync/external-id-delete";
import { deleteAppleHealthWorkouts } from "@/lib/workouts/delete-by-external-ids";

export const DELETE = apiHandler(async (request: NextRequest) => {
  // The owner's own device reconciling its own imports: cookie session or
  // the native client's wildcard token, metered by the shared write bucket.
  const { user } = await requireAuth();

  const body = await parseExternalIdDelete(request, "workout");
  if (!body.ok) return body.error;

  const { deleted } = await deleteAppleHealthWorkouts(
    user.id,
    body.externalIds,
  );
  return answerExternalIdDelete({
    request,
    userId: user.id,
    domain: "workout",
    processed: body.externalIds.length,
    deleted,
  });
});
