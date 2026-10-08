/**
 * `POST /api/auth/claim/preview` — what a handover link would hand over: the
 * profile's display name and each guardian's proposal (v1.42, #959).
 * Anonymous, token in the body, the same uniform 404 as the claim itself.
 *
 * Contract stub: answers 501.
 */
import { apiHandler } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const POST = apiHandler(async () => notImplemented());
