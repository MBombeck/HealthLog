/**
 * `POST /api/admin/push-relay/rotate-sender-key`: the emergency rotation of
 * the envelope sender key, for a key known to be exposed. It skips the 7-day
 * announcement and drops the previous key at once, so devices that have not
 * fetched the new key show the neutral placeholder until the app is opened
 * (`push-relay/sender-keys.ts`). The regular rotation is yearly and staged.
 *
 * Cookie-only (`requireAdmin()`) behind a fresh proof
 * (`assertRecentCookieProof`): an admin with a second factor confirms it
 * within the last five minutes, an admin without one re-enters the password
 * (or signs in again, or uses a passkey). An emergency rotation must stay
 * reachable for an admin who never enrolled a second factor, and must never
 * run on a bare live session. Audit-logged, rate limited to 5 per hour.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  assertRecentCookieProof,
  requireAdmin,
} from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { rotateSenderKey } from "@/lib/push-relay/sender-keys";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user, session } = await requireAdmin();
  await assertRecentCookieProof(user, session.id);
  const rl = await checkRateLimit(
    `admin-push-relay-sender-rotate:${user.id}`,
    5,
    60 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Too many key rotations, try again later", 429, {
      errorCode: "admin.pushRelay.rateLimited",
    });
  }
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
