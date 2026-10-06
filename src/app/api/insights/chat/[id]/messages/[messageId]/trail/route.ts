/**
 * GET /api/insights/chat/[id]/messages/[messageId]/trail — the model-written
 * text of one assistant message's trail (v1.41): the screened reasoning
 * titles and summaries and checkpoint sentences by trail entry, decrypted for
 * their owner. The structure of the trail (phases, statuses, counts) is
 * plaintext on the message's `metricSource.activity`; only the text is here,
 * read lazily so a long thread does not carry every trail.
 *
 * Narrowed exactly like `…/results`: the message must sit in a conversation
 * the caller owns, and a foreign or unknown id is 404, never 403. A session
 * or a full-access token reads it; a narrow token is refused by
 * `requireAuth()` like on every Coach read.
 *
 * A mixed read: the text is model-written, so it is served only while the
 * Coach's text may be shown for the record (`aiCapabilityToServe`). When it
 * may not, the answer is 200 with `trail: null` and the `ai` state beside it,
 * and the client keeps the trail's catalog labels.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { readMessageTrail } from "@/lib/ai/coach/persistence";

interface RouteCtx {
  params: Promise<{ id: string; messageId: string }>;
}

export const GET = apiHandler(async (_request: NextRequest, ctx: RouteCtx) => {
  const auth = await requireAuth();
  const userId = auth.user.id;
  const { id, messageId } = await ctx.params;
  if (!id || !messageId) return apiError("coach.message.notFound", 404);

  const read = await readMessageTrail(userId, id, messageId);
  if (!read) return apiError("coach.message.notFound", 404);

  const ai = await aiCapabilityToServe(userId, "coach");
  const trail = ai.available ? read.trail : null;

  annotate({
    action: { name: "insights.coach.trail.read" },
    meta: {
      conversationId: id,
      entries: trail?.entries.length ?? 0,
      served: ai.available,
    },
  });

  return apiSuccess({ trail, ai });
});

export const dynamic = "force-dynamic";
