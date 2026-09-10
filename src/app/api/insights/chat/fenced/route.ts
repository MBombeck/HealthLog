/**
 * v1.29.x (S7) — the FENCED multi-document coach chat endpoint.
 *
 * POST streams a grounded prose reply about the N documents attached to a coach
 * conversation, as Server-Sent Events. Conversation-keyed (the conversation owns
 * a SET of documents), sharing the whole turn pipeline with the single-doc sheet
 * route via `@/lib/documents/fenced-chat` so the two cannot drift.
 *
 * THE FENCE (see `fenced-chat.ts` for the full posture): NO tools, NO health
 * snapshot; every document fenced as untrusted DATA; per-document egress consent;
 * numeric grounding over the LIVE attachment union only. A plain tool
 * conversation 404s here (`documentScoped: true` in the fetch), so a fenced turn
 * can never be appended into a tool thread's history.
 */
import { type NextRequest } from "next/server";

import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import {
  apiError,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

import {
  createConversation,
  fetchConversationWithMessages,
} from "@/lib/ai/coach/persistence";
import {
  DOCUMENT_CHAT_BUCKET,
  DOCUMENT_CHAT_LIMIT_PER_MINUTE,
  DOCUMENT_CHAT_WINDOW_MS,
} from "@/lib/documents/ai-route-support";
import { validateAttachmentCandidate } from "@/lib/documents/attach-validate";
import {
  loadFencedDocuments,
  screenFencedInbound,
  streamFencedReply,
  streamFencedRefusal,
  type FencedTurn,
} from "@/lib/documents/fenced-chat";
import { fencedChatRequestSchema } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const userId = user.id;

  const gate = await requireModuleEnabled(userId, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;
  const parsed = fencedChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(
      "Invalid fenced chat request",
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: "coach.fenced.invalid",
      },
    );
  }
  const {
    conversationId,
    message,
    locale: bodyLocale,
    attachmentIds,
  } = parsed.data;

  // One write path per concern: attach-to-existing goes through the attach
  // endpoint, not a first-turn `attachmentIds` payload with a conversationId.
  if (conversationId && attachmentIds) {
    return apiError("attachmentIds may not accompany conversationId", 422, {
      errorCode: "coach.fenced.attachmentConflict",
    });
  }

  // Per-user request-rate ceiling — shared with the single-doc chat + the
  // attach/detach mutations, so a user cannot double their budget by alternating.
  const rl = await checkRateLimit(
    `${DOCUMENT_CHAT_BUCKET}:${userId}`,
    DOCUMENT_CHAT_LIMIT_PER_MINUTE,
    DOCUMENT_CHAT_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const locale = await resolveServerLocale({
    request,
    override: bodyLocale,
    userLocale: user.locale ?? null,
  });
  const contractLocale = locale === "de" ? "de" : "en";

  // ── Resolve the conversation (fenced-only) ──────────────────────────────
  let workingConversationId: string;
  let documentIds: string[];
  let priorTurns: FencedTurn[] = [];

  if (conversationId) {
    const existing = await fetchConversationWithMessages(
      userId,
      conversationId,
      {
        documentScoped: true,
      },
    );
    if (!existing) {
      // 404, not 403 — never reveal cross-user / cross-mode existence.
      throw new HttpError(404, "coach.conversation.notFound");
    }
    workingConversationId = existing.id;
    documentIds = (existing.attachments ?? []).map((a) => a.documentId);
    priorTurns = existing.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  } else {
    if (!attachmentIds || attachmentIds.length === 0) {
      return apiError(
        "A new fenced conversation needs at least one document",
        422,
        {
          errorCode: "coach.fenced.attachmentRequired",
        },
      );
    }
    // Validate EVERY id before creating anything — a failure creates nothing.
    for (const documentId of attachmentIds) {
      const check = await validateAttachmentCandidate({
        userId,
        documentId,
        currentLiveCount: 0,
        incoming: attachmentIds.length,
      });
      if (!check.ok) {
        return apiError("Attachment rejected", check.status, {
          errorCode: check.errorCode,
        });
      }
    }
    const created = await createConversation({
      userId,
      title: message,
      documentScoped: true,
      attachmentIds,
    });
    workingConversationId = created.id;
    documentIds = attachmentIds;
    annotate({
      action: { name: "coach.attachments.added" },
      meta: {
        conversationId: workingConversationId,
        attachmentCount: attachmentIds.length,
        firstTurn: true,
      },
    });
  }

  // ── Inbound refusal / replay-injection guard ────────────────────────────
  const screen = screenFencedInbound({ message, priorTurns, locale });
  if (screen.refuse) {
    if (screen.replayTurnIndex !== null) {
      annotate({
        action: { name: "documents.chat.replay_injection" },
        meta: { reason: screen.reason, turnIndex: screen.replayTurnIndex },
      });
      await auditLog("documents.chat.replay_injection", {
        userId,
        details: {
          conversationId: workingConversationId,
          turnIndex: screen.replayTurnIndex,
          reason: screen.reason,
        },
      });
    } else {
      annotate({
        action: { name: "documents.chat.refused" },
        meta: { reason: screen.reason },
      });
    }
    return streamFencedRefusal({
      conversationId: workingConversationId,
      message,
      refusalText: screen.refusalText,
    });
  }

  // ── Load the LIVE attachment contexts (owner-scoped, indexed-only) ──────
  const loaded = await loadFencedDocuments(userId, documentIds);
  if (!loaded.ok) {
    // Never a partial-context reply: naming the unreadable document lets the UI
    // point the user at the dead pill.
    return apiError("An attached document is unavailable", 422, {
      errorCode: "coach.fenced.attachmentUnavailable",
      unavailableDocumentId: loaded.unavailableDocId,
    });
  }

  return streamFencedReply({
    userId,
    conversationId: workingConversationId,
    docs: loaded.docs,
    priorTurns,
    message,
    contractLocale,
    locale,
    signal: request.signal,
  });
});
