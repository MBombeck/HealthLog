import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { readComprehensiveOverview } from "@/lib/insights/comprehensive-overview/overview";

export const dynamic = "force-dynamic";

/**
 * GET /api/insights/comprehensive — the Insights overview's computed read.
 * The body is built in `src/lib/insights/comprehensive-overview/`.
 */
export const GET = apiHandler(async () => {
  // MANAGE-level read: computed over the whole record, with no provider
  // anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");
  // Shared analytics-read budget (generous; caps runaway loops).
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  // No AI gate, and no `insights` module gate (that module is the AI
  // analysis opt-out). Every field is computed from the record (the provider
  // chain is only probed for presence, for `hasProvider`), and this is the
  // main read of the Insights overview: switching AI off, or never setting a
  // provider up, still gets the overview. The `ai` block beside the body says
  // whether the briefing and status notes that decorate the overview can be
  // shown, resolved per request and never cached with the body.
  const { body, revalidating } = await readComprehensiveOverview(user);

  const [briefing, statusText] = await Promise.all([
    aiCapabilityToServe(user.id, "briefing"),
    aiCapabilityToServe(user.id, "statusText"),
  ]);

  return apiSuccess({
    ...body,
    revalidating,
    ai: { briefing, statusText },
  });
});
