/**
 * The answer a route gives while its contract exists and its body does not.
 *
 * A release built in parallel packages lands every new route as a stub first,
 * registered in the OpenAPI table with its final shape, so the route-coverage
 * and contract checks hold in every package's worktree from the start. The
 * stub authenticates exactly as the finished route will and then answers 501.
 *
 * Nothing may ship with a stub in it: the error-code catalogue check fails on
 * a listed code no route emits, so the code leaves the catalogue, and this
 * file with it, once the last stub is implemented.
 */
import { apiError } from "@/lib/api-response";

export const NOT_IMPLEMENTED_ERROR_CODE = "not_implemented";

export function notImplemented() {
  return apiError("Not implemented", 501, {
    errorCode: NOT_IMPLEMENTED_ERROR_CODE,
  });
}
