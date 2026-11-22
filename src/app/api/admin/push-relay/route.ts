/**
 * `GET /api/admin/push-relay`: the relay's state for the admin card and the
 * relay question (`operatorDecision`).
 *
 * `PUT /api/admin/push-relay` `{ enabled, acceptTerms, householdOnly, invite? }`:
 * the operator's switch "Offer the HealthLog push relay to this server's
 * users". Turning it on requires both confirmations (the relay terms, and
 * that this server is run privately for its operator and their household),
 * creates the instance key and registers at the relay. Turning it off
 * deletes the instance at the relay (every device binding with it) and the
 * key here. Both are audit-logged, and both set the operator's decision: `on`
 * once the registration succeeded, `off` when switched off. `invite` is the
 * relay's one-time code for a relay that accepts new servers by invitation
 * only; it rides this one registration attempt and is neither stored nor
 * logged. The answer is the state after the attempt, so a refusal (`reason`)
 * shows at once.
 *
 * On a relay that is on and registered already, the same call with both
 * confirmations records the operator's acceptance of the current terms text
 * (`termsConfirmationNeeded` in the status), audit-logged as
 * `admin.push_relay.terms_confirmed`. The relay keeps running through it: a
 * newer text never switches it off or holds a push back.
 *
 * Cookie-only (`requireAdmin()`): a Bearer token never reaches it. Rate
 * limited with the relay question's answer (`operator-switch.ts`).
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { adminRelayStatus } from "@/lib/push-relay/admin-status";
import {
  RELAY_SWITCH_MAX_BYTES,
  relaySwitchRateLimit,
  relaySwitchSchema,
  switchRelayOff,
  switchRelayOn,
} from "@/lib/push-relay/operator-switch";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.push_relay.get" } });
  return apiSuccess(await adminRelayStatus());
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  const limited = await relaySwitchRateLimit(user.id);
  if (limited) return limited;
  const parsed = await parseJsonBody(request, relaySwitchSchema, {
    maxBytes: RELAY_SWITCH_MAX_BYTES,
    action: "admin.push_relay.validation-failed",
  });
  if (!parsed.ok) return parsed.error;

  if (parsed.data.enabled) {
    const refused = await switchRelayOn(request, user.id, parsed.data);
    if (refused) return refused;
  } else {
    await switchRelayOff(request, user.id);
  }
  return apiSuccess(await adminRelayStatus());
});
