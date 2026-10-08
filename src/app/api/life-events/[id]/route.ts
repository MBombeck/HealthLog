/**
 * `PATCH /api/life-events/{id}` edits one life event; `DELETE` soft-deletes
 * it (v1.42, #613). Record-scoped like the list beside it.
 *
 * Contract stub: owner-only until implemented, then answers 501. The
 * finished routes resolve the record through `requireRecordAuth` and join
 * the sharing guard's delegable lists with their audit rows; a stub cannot
 * carry those, so it does not claim the admission.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const PATCH = apiHandler(async () => {
  await requireAuth();
  return notImplemented();
});

export const DELETE = apiHandler(async () => {
  await requireAuth();
  return notImplemented();
});
