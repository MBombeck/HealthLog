/**
 * The shared shape of the native client's deletion reconciliation:
 * `DELETE /api/<domain>/by-external-ids` with `{ externalIds }`.
 *
 * HealthKit does not hand an app a stream of deleted samples, so the iPhone
 * app compares what Apple Health still holds with what it sent and posts the
 * ids that are gone. An edit in Apple Health is a delete plus a new sample,
 * and without this the server keeps the old one beside the new.
 *
 * Every route has the contract `DELETE /api/measurements/by-external-ids`
 * set:
 *   - at most 500 ids; more is refused 422 `<domain>.delete.too_large` so
 *     the client can tell it from a malformed body (`<domain>.delete.invalid`);
 *   - only rows the app minted from Apple Health (`source = APPLE_HEALTH`) of
 *     the caller's own record are touched. An id that names another source's
 *     row, another account's row or nothing at all is a no-op, never an error;
 *   - idempotent: an id already deleted is not counted again, an empty list
 *     answers `{ deletedCount: 0 }`;
 *   - each domain deletes the way its own single delete does (a tombstone
 *     where the model has one, the row otherwise) and runs the same follow-up
 *     work; that part lives with the domain, the envelope lives here.
 */
import { z } from "zod/v4";

import { parseJsonBody } from "@/lib/api/body";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";

export const MAX_EXTERNAL_ID_DELETES = 500;

/** The source every by-external-ids delete is confined to. */
export const APP_MINTED_SOURCE = "APPLE_HEALTH" as const;

// No `.max()` on the array: the cap is answered below with its own code.
// The 256 KB body cap bounds the list long before it matters.
const externalIdDeleteSchema = z
  .object({ externalIds: z.array(z.string().min(1).max(120)) })
  .strict();

export type ExternalIdDeleteBody =
  { ok: true; externalIds: string[] } | { ok: false; error: Response };

/** Read and validate the body. The ids come back de-duplicated. */
export async function parseExternalIdDelete(
  request: Request,
  domain: string,
): Promise<ExternalIdDeleteBody> {
  const parsed = await parseJsonBody(request, externalIdDeleteSchema, {
    maxBytes: 256 * 1024,
    action: `${domain}.delete.by_external_ids.validation-failed`,
    countIssues: true,
    errorCode: `${domain}.delete.invalid`,
  });
  if (!parsed.ok) return parsed;
  const { externalIds } = parsed.data;
  if (externalIds.length > MAX_EXTERNAL_ID_DELETES) {
    return {
      ok: false,
      error: apiError(
        `Batch exceeds the ${MAX_EXTERNAL_ID_DELETES}-entry limit`,
        422,
        { errorCode: `${domain}.delete.too_large` },
      ),
    };
  }
  return { ok: true, externalIds: [...new Set(externalIds)] };
}

/** The audit row, the wide event and the `{ deletedCount }` answer. */
export async function answerExternalIdDelete(args: {
  request: Request;
  userId: string;
  domain: string;
  processed: number;
  deleted: number;
}): Promise<Response> {
  const { domain, processed, deleted } = args;
  await auditLog(`${domain}.delete.by_external_ids`, {
    userId: args.userId,
    ipAddress: getClientIp(args.request),
    details: { processed, deleted },
  });
  annotate({
    action: { name: `${domain}.delete.by_external_ids` },
    meta: { processed, deleted },
  });
  return apiSuccess({ deletedCount: deleted });
}
