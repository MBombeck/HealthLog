/**
 * `GET /api/vaccinations/custom` lists the record's own vaccine definitions;
 * `POST` adds one (v1.42, #1005). Record-scoped like the dose log.
 *
 * Contract stub: owner-only until implemented, then answers 501. The
 * finished routes resolve the record through `requireRecordAuth` like the
 * dose log and join the sharing guard's delegable lists with their audit
 * rows; a stub cannot carry those, so it does not claim the admission.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const GET = apiHandler(async () => {
  await requireAuth();
  return notImplemented();
});

export const POST = apiHandler(async () => {
  await requireAuth();
  return notImplemented();
});
