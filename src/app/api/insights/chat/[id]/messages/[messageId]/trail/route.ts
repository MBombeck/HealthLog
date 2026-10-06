/**
 * GET /api/insights/chat/[id]/messages/[messageId]/trail — the text of one
 * assistant message's trail (v1.41), decrypted for its owner: the screened
 * reasoning titles and summaries and checkpoint sentences by trail entry,
 * the facts the turn recalled, and a fact proposal it offered. The structure
 * of the trail (phases, statuses, counts) is plaintext on the message's
 * `metricSource.activity`; only the text is here, read lazily so a long
 * thread does not carry every trail.
 *
 * Narrowed exactly like `…/results`: the message must sit in a conversation
 * the caller owns, and a foreign or unknown id is 404, never 403. A session
 * or a full-access token reads it; a narrow token is refused by
 * `requireAuth()` like on every Coach read.
 *
 * A mixed read, split by who wrote what. The entries' text is model-written,
 * so it is served only while the Coach's text may be shown for the record
 * (`aiCapabilityToServe`); when it may not, `entries` is empty, the `ai`
 * state rides beside it, and the client keeps the trail's catalog labels.
 * The recalled facts and the proposal's fact are the person's own data and
 * are served to the owner whatever the capability, like the memory list:
 * only the medications module gates them, at read time, the way `…/results`
 * withholds a table whose module is off. `trail` is null when nothing is
 * left to serve.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { readMessageTrail } from "@/lib/ai/coach/persistence";
import { withholdMedicationFacts } from "@/lib/ai/coach/memory/trail-read";
import { isModuleEnabled } from "@/lib/modules/gate";
import type { CoachTrail } from "@/lib/ai/coach/types";

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
  const stored = read.trail;
  let trail: CoachTrail | null = null;
  let withheld = 0;
  if (stored) {
    const medicationsOn = await isModuleEnabled(userId, "medications");
    const facts = medicationsOn
      ? { recalled: stored.recalled, proposal: stored.proposal, withheld: 0 }
      : await withholdMedicationFacts(userId, stored);
    withheld = facts.withheld;
    const entries = ai.available ? stored.entries : [];
    const recalled =
      facts.recalled && facts.recalled.length > 0 ? facts.recalled : undefined;
    if (entries.length > 0 || recalled || facts.proposal) {
      trail = {
        entries,
        ...(recalled ? { recalled } : {}),
        ...(facts.proposal ? { proposal: facts.proposal } : {}),
      };
    }
  }

  annotate({
    action: { name: "insights.coach.trail.read" },
    meta: {
      conversationId: id,
      entries: trail?.entries.length ?? 0,
      recalled: trail?.recalled?.length ?? 0,
      withheld,
      served: ai.available,
    },
  });

  return apiSuccess({ trail, ai });
});

export const dynamic = "force-dynamic";
