/**
 * v1.29.x (S7) — attach a stored document to an EXISTING coach conversation.
 *
 * POST validates the document (owned + live + indexed + within cap), creates the
 * join row (idempotent on the composite PK), and sets the sticky `documentScoped`
 * flag TRUE. This is the ONE legal, privilege-REDUCING tool→fenced flip: a tool
 * conversation may become fenced (a fenced turn can DO nothing an injection could
 * exploit), never the reverse. The flip is audit-logged.
 */
import { type NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
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

import {
  attachDocument,
  fetchConversationAttachmentState,
  loadConversationAttachmentDTOs,
} from "@/lib/ai/coach/persistence";
import {
  DOCUMENT_CHAT_BUCKET,
  DOCUMENT_CHAT_LIMIT_PER_MINUTE,
  DOCUMENT_CHAT_WINDOW_MS,
} from "@/lib/documents/ai-route-support";
import { validateAttachmentCandidate } from "@/lib/documents/attach-validate";
import { coachAttachmentCreateSchema } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const userId = user.id;

    const gate = await requireModuleEnabled(userId, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id: conversationId } = await params;

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

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 4 * 1024,
    });
    if (jsonError) return jsonError;
    const parsed = coachAttachmentCreateSchema.safeParse(body);
    if (!parsed.success) {
      return apiValidationError(
        "Invalid attachment request",
        sanitiseZodIssues(parsed.error.issues),
        422,
        {
          errorCode: "coach.fenced.invalid",
        },
      );
    }
    const { documentId } = parsed.data;

    // Ownership of the conversation — NOT filtered on `documentScoped` (this is
    // the one legal mode transition). 404 on miss (no cross-user leak).
    const state = await fetchConversationAttachmentState(
      userId,
      conversationId,
    );
    if (!state) {
      return apiError("Conversation not found", 404, {
        errorCode: "coach.conversation.notFound",
      });
    }

    // Idempotent: an already-attached document is a success (UI retries are safe).
    if (state.attachmentIds.includes(documentId)) {
      const attachments = await loadConversationAttachmentDTOs(conversationId);
      return apiSuccess({ attachments, fenced: true });
    }

    const check = await validateAttachmentCandidate({
      userId,
      documentId,
      currentLiveCount: state.attachmentIds.length,
      incoming: 1,
    });
    if (!check.ok) {
      return apiError("Attachment rejected", check.status, {
        errorCode: check.errorCode,
      });
    }

    const flip = !state.documentScoped;
    await attachDocument({ conversationId, documentId });

    annotate({
      action: { name: "coach.attachments.added" },
      meta: { conversationId, documentId, converted: flip },
    });
    if (flip) {
      // Mode transition (tool → fenced) is audit-worthy. Privilege-reducing, so
      // an unconfirmed API call is safe — the client shows the confirm dialog.
      annotate({
        action: { name: "coach.attachments.converted" },
        meta: { conversationId, priorMessages: state.messageCount },
      });
      await auditLog("coach.attachments.converted", {
        userId,
        details: { conversationId, priorMessages: state.messageCount },
      });
    }

    const attachments = await loadConversationAttachmentDTOs(conversationId);
    return apiSuccess({ attachments, fenced: true });
  },
);
