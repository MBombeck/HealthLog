/**
 * `POST /api/admin/push-relay/rotate-key`: rotate the instance signing key
 * at the relay now, outside the 30-day schedule (`push-relay/instance-key.ts`).
 * The relay allows one rotation per UTC day.
 *
 * Cookie-only (`requireAdmin()`), audit-logged.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { relayConfig } from "@/lib/push-relay/config";
import { loadRegistration } from "@/lib/push-relay/registration";
import { rotateInstanceKey } from "@/lib/push-relay/instance-key";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  const config = relayConfig();
  const row = config.available ? await loadRegistration(config) : null;
  if (!row?.instanceId) {
    return apiError("The relay is not registered on this server", 409, {
      errorCode: "admin.pushRelay.notRegistered",
    });
  }
  const outcome = await rotateInstanceKey(row, config);
  await auditLog("admin.push_relay.key_rotated", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { outcome },
  });
  annotate({
    action: { name: "admin.push_relay.rotate_key" },
    meta: { outcome },
  });
  return apiSuccess({ outcome });
});
