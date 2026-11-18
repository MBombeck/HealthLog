/**
 * `DELETE /api/medications/intake/by-external-ids` — the iPhone app's
 * deletion reconciliation for dose records it imported from Apple Health.
 *
 * Body `{ externalIds }` (at most 500, the HealthKit dose-event UUIDs the
 * bulk intake route stored), answer `{ deletedCount }`. Only the caller's own
 * `APPLE_HEALTH` intakes are matched; anything else is a no-op. Each is
 * soft-deleted with its stock refunded, as the single delete does
 * (`deleteAppleHealthIntakes`). The envelope is shared with the other
 * by-external-ids routes (`src/lib/sync/external-id-delete.ts`).
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { deleteAppleHealthIntakes } from "@/lib/medications/delete-intakes-by-external-ids";
import {
  answerExternalIdDelete,
  parseExternalIdDelete,
} from "@/lib/sync/external-id-delete";

export const DELETE = apiHandler(async (request: NextRequest) => {
  // The owner's own device reconciling its own imports, as on the bulk
  // ingest: a cookie session or the native client's wildcard token.
  const { user } = await requireAuth();

  const body = await parseExternalIdDelete(request, "medication.intake");
  if (!body.ok) return body.error;

  const deleted = await deleteAppleHealthIntakes(
    { id: user.id, timezone: user.timezone },
    body.externalIds,
    request.headers.get("x-device-id"),
  );
  return answerExternalIdDelete({
    request,
    userId: user.id,
    domain: "medication.intake",
    processed: body.externalIds.length,
    deleted,
  });
});
