/**
 * `GET /api/life-events` lists the record's life events, oldest first;
 * `POST` adds one (v1.42, #613). Title and note are encrypted at rest and
 * never reach a model. Shapes and request schemas in `src/lib/day/`.
 *
 * Part of the `profile` sharing domain, beside allergies, visits and the
 * immunization history. The row store answers whether or not the `timeline`
 * module is on, the data-layer posture of the other record tables, so a
 * restore keeps working and re-enabling finds the events intact.
 *
 * Contract stub: answers 501. The read declares its final admission; the
 * create stays owner-only until it files its rows through the audit trail
 * and joins the delegable write list.
 */
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const GET = apiHandler(async () => {
  await requireRecordAuth("read", "profile");
  return notImplemented();
});

export const POST = apiHandler(async () => {
  await requireAuth();
  return notImplemented();
});
