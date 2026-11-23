/**
 * The manual-sync trigger body, read once for every provider.
 *
 * Four sync routes each carried their own copy of this:
 *
 *     let fullSync = false;
 *     try {
 *       const raw = await request.text();
 *       if (raw.length > 64 * 1024) return apiError(…, 413);
 *       const body = JSON.parse(raw);
 *       fullSync = body?.fullSync === true;
 *     } catch {
 *       // no body provided -> default incremental sync
 *     }
 *
 * The comment is only true for one of the three cases that reach the catch. An
 * absent body means an incremental run, and that is the documented and used
 * shape. But a body that is present and unparseable, and a body that is present
 * and carries `"fullSync": "true"` as a string, both landed in the same place:
 * `fullSync = false`, a 200, and a response that reads to the client as a
 * successful incremental sync. A caller could ask for full history, get a typo
 * wrong, and be told it worked.
 *
 * This separates the three. Absent still means incremental. Present and
 * unparseable is a 400, present and failing the schema is a 422 with the
 * multi-issue envelope the rest of the surface uses. No caller that sends
 * nothing, `{}`, or a well-formed `{ "fullSync": <bool> }` sees any change; the
 * only requests that now fail are the ones that were already being misread.
 */
import { apiError, returnAllZodIssues } from "@/lib/api-response";
import { syncTriggerSchema } from "@/lib/validations/sync-trigger";

/** Matches the per-route cap the four copies each applied by hand. */
export const SYNC_TRIGGER_MAX_BYTES = 64 * 1024;

export type SyncTriggerBody =
  { fullSync: boolean; error?: never } | { fullSync?: never; error: Response };

/**
 * Resolve `fullSync` from the request body, refusing a body that is present
 * and wrong instead of silently reading it as `false`.
 */
export async function readSyncTriggerBody(
  request: Request,
): Promise<SyncTriggerBody> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { error: apiError("Invalid request body", 400) };
  }

  if (raw.length > SYNC_TRIGGER_MAX_BYTES) {
    return {
      error: apiError(
        `Request body exceeds ${SYNC_TRIGGER_MAX_BYTES} bytes`,
        413,
      ),
    };
  }

  // An absent body is the documented way to ask for an incremental run, and
  // stays one. Whitespace-only counts as absent: some HTTP clients send a
  // newline for a bodyless POST, and refusing that would be a refusal of the
  // shape this branch exists to keep working.
  if (raw.trim() === "") return { fullSync: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: apiError("Invalid JSON body", 400) };
  }

  const result = syncTriggerSchema.safeParse(parsed);
  if (!result.success) {
    return {
      error: returnAllZodIssues(
        result.error,
        422,
        undefined,
        syncTriggerSchema,
      ),
    };
  }

  return { fullSync: result.data.fullSync === true };
}
