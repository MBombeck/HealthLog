/**
 * The refusal a request surface answers while the boot key check has found
 * that the configured encryption key does not open this database.
 *
 * `apiHandler` applies it to every API route. A route outside `apiHandler`
 * (the remote MCP endpoint, its OAuth bridge) calls one of the two helpers
 * below as the first thing it does, before auth and before any read or
 * write: a process holding the wrong key must never seal new rows, because
 * those rows would open under that key at the next boot and read as evidence
 * that it is the right one. `key-mismatch-refusal-guard.test.ts` fails when a
 * route outside `apiHandler` does neither.
 */
import { annotate } from "@/lib/logging/context";
import {
  isKeyMismatch,
  KEY_MISMATCH_ERROR_CODE,
  KEY_MISMATCH_EXEMPT_PATHS,
} from "./key-mismatch-state";

export const KEY_MISMATCH_MESSAGE =
  "The server's encryption key does not match its database. The operator has to restore the original key or point the server at the matching database.";

const RETRY_AFTER = { "Retry-After": "300" };

/** The 503 in the standard `{ data, error, meta }` envelope. */
export function keyMismatchResponse(): Response {
  annotate({ action: { name: "encryption.key_mismatch.refused" } });
  return Response.json(
    {
      data: null,
      error: KEY_MISMATCH_MESSAGE,
      meta: { errorCode: KEY_MISMATCH_ERROR_CODE },
    },
    { status: 503, headers: RETRY_AFTER },
  );
}

/**
 * The envelope refusal when the process refuses and `pathname` is not one of
 * the exempt paths; otherwise null and the caller carries on.
 */
export function refuseOnKeyMismatch(pathname?: string): Response | null {
  if (!isKeyMismatch()) return null;
  if (pathname !== undefined && KEY_MISMATCH_EXEMPT_PATHS.has(pathname)) {
    return null;
  }
  return keyMismatchResponse();
}

/**
 * The same refusal in the RFC 6749 error shape the OAuth endpoints speak:
 * `temporarily_unavailable` with a description, plus the HealthLog error
 * code as an extension member a client may ignore.
 */
export function refuseOAuthOnKeyMismatch(): Response | null {
  if (!isKeyMismatch()) return null;
  annotate({ action: { name: "encryption.key_mismatch.refused" } });
  return Response.json(
    {
      error: "temporarily_unavailable",
      error_description:
        "The server's encryption key does not match its database.",
      error_code: KEY_MISMATCH_ERROR_CODE,
    },
    { status: 503, headers: { ...RETRY_AFTER, "Cache-Control": "no-store" } },
  );
}
