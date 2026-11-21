/**
 * `POST /api/admin/push-relay/rotate-sender-key`: the emergency rotation of
 * the envelope sender key, for a key known to be exposed. It skips the 7-day
 * announcement and drops the previous key at once, so devices that have not
 * fetched the new key show the neutral placeholder until the app is opened
 * (`push-relay/sender-keys.ts`). The regular rotation is yearly and staged.
 *
 * Cookie-only (`requireAdmin()`) with a fresh second factor; audit-logged.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireAdmin,
  requireFreshMfa,
} from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { rotateSenderKey } from "@/lib/push-relay/sender-keys";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAdmin();
  const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
  const rotated = await rotateSenderKey();
  if (!rotated) {
    return apiError("This server seals no push envelopes yet", 409, {
      errorCode: "admin.pushRelay.noSenderKey",
    });
  }
  await auditLog("admin.push_relay.sender_key_emergency_rotation", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { emergency: true },
  });
  annotate({ action: { name: "admin.push_relay.rotate_sender_key" } });
  return apiSuccess({ rotated: true });
});
