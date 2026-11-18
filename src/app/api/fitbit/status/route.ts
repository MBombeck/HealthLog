/**
 * GET /api/fitbit/status: the removed Fitbit integration, as "not connected".
 *
 * Google turned the Fitbit Web API off on 2026-10-30 and the integration is
 * gone (v1.48.0), but iPhone app builds already in people's hands read this
 * status every time their Integrations screen opens, and a 404 painted the
 * Fitbit card as an error. It keeps answering in the old shape, with
 * `retired` beside it. The integration's other routes are tombstones in
 * `src/lib/http/retired-routes.ts`.
 *
 * Remove once the iPhone release that drops the Fitbit card is the minimum
 * supported version, and add the path to the tombstones then.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAuth();
  annotate({ action: { name: "fitbit.status" }, meta: { retired: true } });
  return apiSuccess({ connected: false, configured: false, retired: true });
});
