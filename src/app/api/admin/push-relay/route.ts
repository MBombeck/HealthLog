/**
 * `GET /api/admin/push-relay`: the relay's state for the admin card and the
 * one-time admin notice.
 *
 * `PUT /api/admin/push-relay` `{ enabled, acceptTerms, householdOnly }`:
 * the operator's switch "Offer the HealthLog push relay to this server's
 * users". Turning it on requires both confirmations (the relay terms, and
 * that this server is run privately for its operator and their household),
 * creates the instance key and registers at the relay. Turning it off
 * deletes the instance at the relay (every device binding with it) and the
 * key here. Both are audit-logged.
 *
 * Cookie-only (`requireAdmin()`): a Bearer token never reaches it.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { relayConfig, RELAY_TERMS_VERSION } from "@/lib/push-relay/config";
import { disableRelay, enableRelay } from "@/lib/push-relay/registration";
import { adminRelayStatus } from "@/lib/push-relay/admin-status";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.push_relay.get" } });
  return apiSuccess(await adminRelayStatus(user.id));
});

const switchSchema = z
  .object({
    enabled: z.boolean(),
    acceptTerms: z.boolean().optional(),
    householdOnly: z.boolean().optional(),
  })
  .strict();

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  const parsed = await parseJsonBody(request, switchSchema, {
    maxBytes: 4 * 1024,
    action: "admin.push_relay.validation-failed",
  });
  if (!parsed.ok) return parsed.error;
  const config = relayConfig();

  if (parsed.data.enabled) {
    if (!config.available) {
      return apiError("The push relay is not available on this server", 409, {
        errorCode: "admin.pushRelay.unavailable",
      });
    }
    if (
      parsed.data.acceptTerms !== true ||
      parsed.data.householdOnly !== true
    ) {
      return apiError("Both confirmations are required", 422, {
        errorCode: "admin.pushRelay.confirmationsRequired",
      });
    }
    const row = await enableRelay({ userId: user.id, config });
    await auditLog("admin.push_relay.enabled", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        relayHost: config.host,
        termsVersion: RELAY_TERMS_VERSION,
        householdOnly: true,
        registered: row.instanceId !== null,
      },
    });
    annotate({
      action: { name: "admin.push_relay.enabled" },
      meta: { registered: row.instanceId !== null },
    });
  } else {
    const { unregistered } = await disableRelay(config);
    await auditLog("admin.push_relay.disabled", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { relayHost: config.host, unregistered },
    });
    annotate({
      action: { name: "admin.push_relay.disabled" },
      meta: { unregistered },
    });
  }
  return apiSuccess(await adminRelayStatus(user.id));
});
