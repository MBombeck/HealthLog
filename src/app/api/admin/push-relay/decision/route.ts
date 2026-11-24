/**
 * `POST /api/admin/push-relay/decision` `{ enabled, acceptTerms?, householdOnly?, invite? }`:
 * the admin's answer to "Use the HealthLog push relay?", asked once for the
 * whole server.
 *
 * - `enabled: false` is no: the decision becomes `off` and nobody is asked
 *   again. A registration the switch left unfinished (an invite code that was
 *   refused) goes with it.
 * - `enabled: true` is yes, with the same confirmations and invite code the
 *   switch takes: it turns the relay on through the switch's own path
 *   (`operator-switch.ts`). The decision becomes `on` only once the
 *   registration at the relay succeeded; a refusal leaves it `undecided`, so
 *   the question stays open and the answer can be given again with a code.
 *
 * Only while the question is open (`operatorDecision: undecided`): otherwise
 * 409 `admin.pushRelay.decisionNotOpen`, and the switch under Admin > Push and
 * channels is where the relay is changed later. A stale card in a second tab
 * cannot overturn an answer that was given.
 *
 * Cookie-only (`requireAdmin()`): a Bearer token, the app's included, never
 * reaches it, by the same structural rule as every admin route. The app opens
 * the web admin page instead. Audit-logged (`admin.push_relay.declined`,
 * `admin.push_relay.enabled`), rate limited with the switch, Zod-validated.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
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

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  const limited = await relaySwitchRateLimit(user.id);
  if (limited) return limited;
  const parsed = await parseJsonBody(request, relaySwitchSchema, {
    maxBytes: RELAY_SWITCH_MAX_BYTES,
    action: "admin.push_relay.decision.validation-failed",
  });
  if (!parsed.ok) return parsed.error;

  const before = await adminRelayStatus();
  if (before.operatorDecision !== "undecided") {
    annotate({
      action: { name: "admin.push_relay.decision.refused" },
      meta: { decision: before.operatorDecision },
    });
    return apiError("The relay question is not open on this server", 409, {
      errorCode: "admin.pushRelay.decisionNotOpen",
    });
  }
  if (parsed.data.enabled) {
    const refused = await switchRelayOn(request, user.id, parsed.data);
    if (refused) return refused;
  } else {
    await switchRelayOff(request, user.id, { declined: true });
  }
  return apiSuccess(await adminRelayStatus());
});
