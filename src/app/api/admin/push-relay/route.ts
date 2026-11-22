/**
 * `GET /api/admin/push-relay`: the relay's state for the admin card and the
 * one-time admin notice.
 *
 * `PUT /api/admin/push-relay` `{ enabled, acceptTerms, householdOnly, invite? }`:
 * the operator's switch "Offer the HealthLog push relay to this server's
 * users". Turning it on requires both confirmations (the relay terms, and
 * that this server is run privately for its operator and their household),
 * creates the instance key and registers at the relay. Turning it off
 * deletes the instance at the relay (every device binding with it) and the
 * key here. Both are audit-logged. `invite` is the relay's one-time code for
 * a relay that accepts new servers by invitation only; it rides this one
 * registration attempt and is neither stored nor logged. The answer is the
 * state after the attempt, so a refusal (`reason`) shows at once.
 *
 * On a relay that is on and registered already, the same call with both
 * confirmations records the operator's acceptance of the current terms text
 * (`termsConfirmationNeeded` in the status), audit-logged as
 * `admin.push_relay.terms_confirmed`. The relay keeps running through it: a
 * newer text never switches it off or holds a push back.
 *
 * Cookie-only (`requireAdmin()`): a Bearer token never reaches it. The
 * switch is rate limited to 10 per 15 minutes per admin, since each turn
 * registers at or deletes from the relay.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { relayConfig, RELAY_TERMS_VERSION } from "@/lib/push-relay/config";
import {
  disableRelay,
  enableRelay,
  loadRegistration,
} from "@/lib/push-relay/registration";
import { adminRelayStatus } from "@/lib/push-relay/admin-status";
import { relayInviteSchema } from "@/lib/push-relay/invite";

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
    invite: relayInviteSchema.optional(),
  })
  .strict();

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  const rl = await checkRateLimit(
    `admin-push-relay:${user.id}`,
    10,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Too many relay changes, try again later", 429, {
      errorCode: "admin.pushRelay.rateLimited",
    });
  }
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
    const before = await loadRegistration(config);
    const row = await enableRelay({
      userId: user.id,
      config,
      invite: parsed.data.invite,
    });
    if (before?.instanceId) {
      await auditLog("admin.push_relay.terms_confirmed", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: {
          relayHost: config.host,
          termsVersion: RELAY_TERMS_VERSION,
          previousTermsVersion: before.termsVersion,
          householdOnly: true,
        },
      });
      annotate({
        action: { name: "admin.push_relay.terms_confirmed" },
        meta: { changed: before.termsVersion !== RELAY_TERMS_VERSION },
      });
      return apiSuccess(await adminRelayStatus(user.id));
    }
    await auditLog("admin.push_relay.enabled", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        relayHost: config.host,
        termsVersion: RELAY_TERMS_VERSION,
        householdOnly: true,
        registered: row.instanceId !== null,
        inviteEntered: parsed.data.invite !== undefined,
        refusal: row.instanceId === null ? row.stateReason : null,
      },
    });
    annotate({
      action: { name: "admin.push_relay.enabled" },
      meta: {
        registered: row.instanceId !== null,
        invite_entered: parsed.data.invite !== undefined,
        refusal: row.instanceId === null ? row.stateReason : null,
      },
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
