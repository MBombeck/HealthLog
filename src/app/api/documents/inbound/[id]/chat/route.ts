/**
 * v1.27.33 (Document vault P4) / v1.29.x (S7) — chat about a document from the
 * document SHEET (path-keyed, single document).
 *
 * POST streams a grounded prose reply as Server-Sent Events; GET reads the
 * document's chat history. This route keeps its PUBLIC OpenAPI wire contract (the
 * iOS client may hold it) but is reimplemented over the S7 data model: a
 * sheet-started chat IS a one-attachment FENCED conversation
 * (`CoachConversation.documentScoped = true` + a `CoachConversationDocument` join
 * row for this document). The whole turn pipeline is shared with
 * `POST /api/insights/chat/fenced` via `@/lib/documents/fenced-chat`, so the two
 * cannot drift and the fence posture is identical.
 *
 * If the user later opens the thread in the coach and attaches a SECOND document,
 * this path-keyed POST still resolves the conversation (it still holds a join row
 * for the path id) and the reply grounds on ALL of its live attachments — one
 * conversation object, consistent everywhere.
 *
 * SECURITY MODEL: see `fenced-chat.ts` — NO tools, NO health snapshot, every
 * document fenced as untrusted DATA, per-document egress consent, numeric
 * grounding over the live attachment union. Available only for a content-indexed
 * document (422 otherwise).
 */
import { type NextRequest } from "next/server";

import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
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
  listConversations,
} from "@/lib/ai/coach/persistence";
import {
  DOCUMENT_CHAT_BUCKET,
  DOCUMENT_CHAT_LIMIT_PER_MINUTE,
  DOCUMENT_CHAT_WINDOW_MS,
  loadOwnedDocument,
} from "@/lib/documents/ai-route-support";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import {
  loadFencedDocuments,
  screenFencedInbound,
  streamFencedReply,
  streamFencedRefusal,
  type FencedTurn,
} from "@/lib/documents/fenced-chat";
import {
  documentChatHistoryQuerySchema,
  documentChatRequestSchema,
} from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string }> };

// ─── POST — send a turn, stream the reply ───────────────────────────────────

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const userId = user.id;

    const gate = await requireModuleEnabled(userId, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await loadOwnedDocument(userId, id);
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    // The chat is available ONLY for a content-indexed document — its text is
    // the grounding. Keep the public 422 wire code for this path.
    const context = await loadDocumentChatText(userId, id);
    if (!context) {
      return apiError("This document has not been indexed for chat yet.", 422, {
        errorCode: "documents.inbound.notIndexed",
      });
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });
    if (jsonError) return jsonError;
    const parsed = documentChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiValidationError(
        "Invalid document chat request",
        sanitiseZodIssues(parsed.error.issues),
        422,
        {
          errorCode: "documents.chat.invalid",
        },
      );
    }
    const { conversationId, message, locale: bodyLocale } = parsed.data;

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

    // ── Conversation resolution (fenced, this-document-scoped) ─────────────
    let workingConversationId: string;
    let documentIds: string[];
    let priorTurns: FencedTurn[] = [];
    if (conversationId) {
      // Must be a FENCED conversation that actually holds THIS document (a join
      // row for the path id). A thread for a DIFFERENT document 404s.
      const existing = await fetchConversationWithMessages(
        userId,
        conversationId,
        { attachedDocumentId: id },
      );
      if (!existing) {
        throw new HttpError(404, "documents.chat.conversationNotFound");
      }
      workingConversationId = existing.id;
      // Ground on ALL of the thread's live attachments, not only the path doc.
      documentIds = (existing.attachments ?? []).map((a) => a.documentId);
      priorTurns = existing.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    } else {
      const created = await createConversation({
        userId,
        title: message,
        documentScoped: true,
        attachmentIds: [id],
      });
      workingConversationId = created.id;
      documentIds = [id];
    }

    // ── Inbound refusal / replay-injection guard ───────────────────────────
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
            documentId: id,
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

    // ── Load the live attachment contexts (owner-scoped, indexed-only) ─────
    const loaded = await loadFencedDocuments(userId, documentIds);
    if (!loaded.ok) {
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
  },
);

// ─── GET — the document's chat history ──────────────────────────────────────

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const userId = user.id;

    const gate = await requireModuleEnabled(userId, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await loadOwnedDocument(userId, id);
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    const url = new URL(request.url);
    const parsed = documentChatHistoryQuerySchema.safeParse({
      conversationId: url.searchParams.get("conversationId") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return apiValidationError(
        "Invalid chat history query",
        sanitiseZodIssues(parsed.error.issues),
        422,
        {
          errorCode: "documents.chat.invalid",
        },
      );
    }

    // With a conversationId → that one thread's messages (must hold this document).
    if (parsed.data.conversationId) {
      const detail = await fetchConversationWithMessages(
        userId,
        parsed.data.conversationId,
        { attachedDocumentId: id },
      );
      if (!detail) {
        return apiError("Conversation not found", 404, {
          errorCode: "documents.chat.conversationNotFound",
        });
      }
      annotate({
        action: { name: "documents.chat.fetch" },
        meta: { documentId: id, messageCount: detail.messageCount },
      });
      return apiSuccess(detail);
    }

    // Otherwise → the paginated list of this document's chat threads.
    const page = await listConversations({
      userId,
      attachedDocumentId: id,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    annotate({
      action: { name: "documents.chat.list" },
      meta: { documentId: id, count: page.conversations.length },
    });
    return apiSuccess(page);
  },
);
