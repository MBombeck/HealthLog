/**
 * The operator's relay switch, shared by the two admin routes that move it:
 * the switch under Admin > Push and channels (`PUT /api/admin/push-relay`)
 * and the answer to the relay question (`POST /api/admin/push-relay/decision`).
 * One body, one rate limit bucket, one audit vocabulary, so the question is
 * not a second switch beside the first.
 */
import { z } from "zod/v4";

import { apiError, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  relayConfig,
  RELAY_TERMS_VERSION,
  type RelayConfig,
} from "@/lib/push-relay/config";
import { relayInviteSchema } from "@/lib/push-relay/invite";
import {
  disableRelay,
  enableRelay,
  loadRegistration,
} from "@/lib/push-relay/registration";

export const relaySwitchSchema = z
  .object({
    enabled: z.boolean(),
    acceptTerms: z.boolean().optional(),
    householdOnly: z.boolean().optional(),
    invite: relayInviteSchema.optional(),
  })
  .strict();

export type RelaySwitchBody = z.infer<typeof relaySwitchSchema>;

/** The body cap both routes read with. */
export const RELAY_SWITCH_MAX_BYTES = 4 * 1024;

/**
 * 10 changes per 15 minutes per admin across both routes, since each turn
 * registers at or deletes from the relay. Null when the call may go ahead.
 */
export async function relaySwitchRateLimit(
  userId: string,
): Promise<Response | null> {
  const rl = await checkRateLimit(
    `admin-push-relay:${userId}`,
    10,
    15 * 60 * 1000,
  );
  if (rl.allowed) return null;
  return apiError("Too many relay changes, try again later", 429, {
    errorCode: "admin.pushRelay.rateLimited",
  });
}

/**
 * Turn the relay on: both confirmations, the registration, the audit row.
 * On a relay that is on already the same call records the acceptance of the
 * current terms text. Returns a refusal, or null once the attempt ran (its
 * outcome, a relay refusal included, is in the status the caller answers
 * with).
 */
export async function switchRelayOn(
  request: Request,
  userId: string,
  body: RelaySwitchBody,
  config: RelayConfig = relayConfig(),
): Promise<Response | null> {
  if (!config.available) {
    return apiError("The push relay is not available on this server", 409, {
      errorCode: "admin.pushRelay.unavailable",
    });
  }
  if (body.acceptTerms !== true || body.householdOnly !== true) {
    return apiError("Both confirmations are required", 422, {
      errorCode: "admin.pushRelay.confirmationsRequired",
    });
  }
  const before = await loadRegistration(config);
  const row = await enableRelay({ userId, config, invite: body.invite });
  if (before?.instanceId) {
    await auditLog("admin.push_relay.terms_confirmed", {
      userId,
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
    return null;
  }
  await auditLog("admin.push_relay.enabled", {
    userId,
    ipAddress: getClientIp(request),
    details: {
      relayHost: config.host,
      termsVersion: RELAY_TERMS_VERSION,
      householdOnly: true,
      registered: row.instanceId !== null,
      inviteEntered: body.invite !== undefined,
      refusal: row.instanceId === null ? row.stateReason : null,
    },
  });
  annotate({
    action: { name: "admin.push_relay.enabled" },
    meta: {
      registered: row.instanceId !== null,
      invite_entered: body.invite !== undefined,
      refusal: row.instanceId === null ? row.stateReason : null,
    },
  });
  return null;
}

/**
 * Turn the relay off, or answer no while it is not on: the instance and every
 * device binding go, and the operator's decision becomes `off`. `declined`
 * names the answer to the relay question in the audit row.
 */
export async function switchRelayOff(
  request: Request,
  userId: string,
  options: { declined?: boolean } = {},
  config: RelayConfig = relayConfig(),
): Promise<void> {
  const { unregistered } = await disableRelay(config);
  const event = options.declined
    ? "admin.push_relay.declined"
    : "admin.push_relay.disabled";
  await auditLog(event, {
    userId,
    ipAddress: getClientIp(request),
    details: { relayHost: config.host, unregistered },
  });
  annotate({ action: { name: event }, meta: { unregistered } });
}
