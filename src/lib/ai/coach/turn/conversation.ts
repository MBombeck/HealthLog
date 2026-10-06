/**
 * Resolve the conversation a Coach turn belongs to: load (and fence-check) an
 * existing one, re-screen its stored user turns for a replayed injection, or
 * create a new one. Then record the user's turn.
 */
import { HttpError } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  appendMessage,
  createConversation,
  fetchConversationWithMessages,
} from "@/lib/ai/coach/persistence";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import type { CoachTurn } from "@/lib/ai/coach/chat-request-builder";
import { collectPriorResults } from "@/lib/ai/coach/results/refs";
import { latestMessagesOnce } from "@/lib/ai/coach/latest-messages";

import { streamRefusal } from "./sse";
import type { TurnConversation } from "./types";

export async function resolveTurnConversation(args: {
  userId: string;
  conversationId: string | undefined;
  message: string;
  locale: Locale;
}): Promise<{ conversation: TurnConversation } | { refusal: Response }> {
  const { userId, conversationId, message, locale } = args;

  if (!conversationId) {
    const created = await createConversation({ userId, title: message });
    return {
      conversation: {
        conversationId: created.id,
        priorTurns: [],
        priorUserMessages: [],
        priorToolFigures: [],
        priorSummary: null,
      },
    };
  }

  // v1.29.x (S7) — the load-bearing prompt-injection fence, now a DUAL
  // predicate. Untrusted document text may only enter an LLM prompt on the
  // fenced pipeline (no tools, no snapshot). This tool route must never load a
  // fenced conversation:
  //   PRIMARY  — `documentScoped: false` in the WHERE. The sticky flag is set
  //              at fenced-creation / first-attach and NEVER cleared, so a
  //              conversation that has EVER held a document 404s here forever.
  //   BACKSTOP — even so, assert zero live attachments. `documentScoped: false`
  //              with an attachment row present is flag/join drift (an
  //              invariant broke somewhere): fail closed, loudly.
  // A doc turn is routed by the client to `/api/insights/chat/fenced` (or the
  // single-doc sheet endpoint). Should a fenced id ever reach THIS route the
  // fetch returns nothing and the turn 404s rather than running an injected
  // instruction against the coach's write tools. Do not relax.
  const existing = await fetchConversationWithMessages(userId, conversationId, {
    documentScoped: false,
    countEarlierAssistant: true,
  });
  if (!existing) {
    // 404, not 403 — never reveal cross-user / cross-mode existence
    throw new HttpError(404, "coach.conversation.notFound");
  }
  if (existing.attachmentCount > 0) {
    // Drift alarm — telemetry AND an audit row (not routine telemetry).
    annotate({
      action: { name: "insights.coach.fence_drift" },
      meta: { conversationId: existing.id },
    });
    await auditLog("insights.coach.fence_drift", {
      userId,
      details: { conversationId: existing.id },
    });
    throw new HttpError(404, "coach.conversation.notFound");
  }
  // #781 — cancelled-turn markers (`providerType: "cancelled"`, empty body)
  // are UI rows, not conversation content: keep them out of the provider
  // transcript so an interrupted turn adds no empty assistant line to the
  // prompt. They stay in the DTO the client renders.
  const priorTurns: CoachTurn[] = existing.messages
    .filter((m) => m.providerType !== "cancelled")
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));
  // Ledger cross-turn sources (D3-safe): user-authored numbers + the
  // persisted tool figures of prior turns. Assistant PROSE is never read.
  const priorUserMessages = existing.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  const priorToolFigures = existing.messages.flatMap((m) =>
    m.metricSource?.groundedFigures ? [...m.metricSource.groundedFigures] : [],
  );

  // v1.4.43 W13 M-3 — replay-injection guard. `detectRefusal` runs
  // only on the inbound `message` per turn, so an injection that
  // slipped past the regex bank on a previous turn would re-enter
  // the prompt every reply. Re-run the detector against every
  // user-turn re-loaded from DB; on a hit, short-circuit the SSE
  // with a refusal AND drop an `insights.coach.replay_injection`
  // row so the failure case is observable. The audit row carries
  // the conversation id (server-owned), the turn index (no PII)
  // and the matched reason — never the message content. v1.4.43
  // W10 simplifier-L-2 — action name follows the `<surface>.<verb>`
  // convention (no `audit.` prefix; no `.replay-injection` dash).
  for (let i = 0; i < priorTurns.length; i++) {
    const turn = priorTurns[i];
    if (turn.role !== "user") continue;
    const replayed = detectRefusal({ message: turn.content, locale });
    if (!replayed.refuse) continue;
    annotate({
      action: { name: "insights.coach.replay_injection" },
      meta: { reason: replayed.reason, turnIndex: i },
    });
    await auditLog("insights.coach.replay_injection", {
      userId,
      details: {
        conversationId: existing.id,
        turnIndex: i,
        reason: replayed.reason,
      },
    });
    return {
      refusal: await streamRefusal({
        userId,
        conversationId: existing.id,
        message,
        refusalText:
          replayed.message ??
          getServerTranslator(locale).t("coach.refusal.conversationPoisoned"),
      }),
    };
  }

  return {
    conversation: {
      conversationId: existing.id,
      priorTurns,
      priorUserMessages,
      priorToolFigures,
      priorSummary: existing.summary ?? null,
      // v1.39.4 — the tables earlier replies hold, named for the context.
      // Named by their place in the whole conversation: counting from the
      // first loaded message gave an older table a new `m<k>` name every turn
      // once the conversation outgrew the window, so a name the model had
      // read earlier pointed somewhere else.
      priorResults: collectPriorResults(
        existing.messages,
        existing.earlierAssistantMessages ?? 0,
      ),
      latestMessages: latestMessagesOnce(userId, existing.id),
    },
  };
}

/**
 * Persist the user's turn first so it's safely on disk regardless of
 * whether the provider call succeeds.
 */
export async function persistUserTurn(
  conversationId: string,
  message: string,
): Promise<{ messageId: string }> {
  const stored = await appendMessage({
    conversationId,
    role: "user",
    content: message,
  });
  // v1.41 — the id a remembered fact points back to.
  return { messageId: stored.id };
}
