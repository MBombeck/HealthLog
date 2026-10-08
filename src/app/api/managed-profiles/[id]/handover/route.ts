/**
 * `POST /api/managed-profiles/[id]/handover` — mint the one-time link that
 * hands a managed profile over to the person it describes, with a proposal
 * per guardian; `DELETE` withdraws the open link (v1.42, #959). Cookie-only
 * like every act on a managed profile; minting is step-up gated, withdrawing
 * is not.
 *
 * Contract stub: authenticates as the finished route will, then answers 501.
 */
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const POST = apiHandler(async () => {
  await requireCookieAuth();
  return notImplemented();
});

export const DELETE = apiHandler(async () => {
  await requireCookieAuth();
  return notImplemented();
});
