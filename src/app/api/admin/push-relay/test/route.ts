/**
 * `POST /api/admin/push-relay/test`: the admin's manual canary. Sends one
 * harmless sealed test push to each of the calling admin's own relay-bound
 * devices and answers with the relay's signed answer and the delivery state
 * per device (`push-relay/test-push.ts`).
 *
 * Cookie-only (`requireAdmin()`), rate limited to 5 per 15 minutes.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendRelayTestPush } from "@/lib/push-relay/test-push";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user } = await requireAdmin();
  const rl = await checkRateLimit(
    `push-relay:test:${user.id}`,
    5,
    15 * 60 * 1000,
  );
  if (!rl.allowed) return apiError("Too many test pushes", 429);
  const result = await sendRelayTestPush(user.id);
  annotate({
    action: { name: "admin.push_relay.test" },
    meta: { outcome: result.outcome, devices: result.results.length },
  });
  return apiSuccess(result);
});
