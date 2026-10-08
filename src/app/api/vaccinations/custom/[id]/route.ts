/**
 * `PATCH /api/vaccinations/custom/[id]` edits one of the record's own vaccine
 * definitions; `DELETE` soft-deletes it, leaving every dose logged against it
 * on its `vaccineName` (v1.42, #1005). Record-scoped like the dose log.
 *
 * Contract stub: owner-only until implemented, then answers 501. The
 * finished routes resolve the record through `requireRecordAuth` like the
 * dose log and join the sharing guard's delegable lists with their audit
 * rows; a stub cannot carry those, so it does not claim the admission.
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
