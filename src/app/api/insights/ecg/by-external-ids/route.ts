/**
 * `DELETE /api/insights/ecg/by-external-ids` — the iPhone app's deletion
 * reconciliation for ECG recordings it sent from Apple Health.
 *
 * Body `{ externalIds }` (at most 500, the `externalRecordingId` the live
 * ingest stored), answer `{ deletedCount }`. Only the caller's own
 * `APPLE_HEALTH` recordings are matched; anything else is a no-op. The
 * recording table has no tombstone, so the rows are removed outright
 * (`deleteAppleHealthEcgRecordings`). The envelope is shared with the other
 * by-external-ids routes (`src/lib/sync/external-id-delete.ts`).
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { deleteAppleHealthEcgRecordings } from "@/lib/ecg/delete-by-external-ids";
import {
  answerExternalIdDelete,
  parseExternalIdDelete,
} from "@/lib/sync/external-id-delete";

export const DELETE = apiHandler(async (request: NextRequest) => {
  // The device that ingested the recordings, as on the ingest POST: a cookie
  // session or the native client's wildcard token, on the owner's record.
  const { user } = await requireAuth();

  const body = await parseExternalIdDelete(request, "ecg");
  if (!body.ok) return body.error;

  const deleted = await deleteAppleHealthEcgRecordings(
    user.id,
    body.externalIds,
  );
  return answerExternalIdDelete({
    request,
    userId: user.id,
    domain: "ecg",
    processed: body.externalIds.length,
    deleted,
  });
});
