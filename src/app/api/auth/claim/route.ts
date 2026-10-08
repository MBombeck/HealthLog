/**
 * `POST /api/auth/claim` — claim a managed profile through its handover link
 * (v1.42, #959). Anonymous by design: the person claiming has no credentials
 * yet. The one-time `hlp_` token travels in the body, never in the URL of
 * this request, and every failure answers the same 404.
 *
 * Contract stub: answers 501.
 */
import { apiHandler } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const POST = apiHandler(async () => notImplemented());
