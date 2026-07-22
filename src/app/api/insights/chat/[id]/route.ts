/**
 * GET    /api/insights/chat/[id] — fetch one conversation with all
 *                                  messages decrypted on the fly.
 * PATCH  /api/insights/chat/[id] — rename one conversation.
 * DELETE /api/insights/chat/[id] — hard-delete the conversation +
 *                                  every message under it.
 *
 * Ownership: every verb verifies the conversation belongs to the
 * authenticated user. A foreign id maps to 404 (NOT 403) so the
 * existence channel never leaks across accounts.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { auditLog } from "@/lib/auth/audit";
import { COACH_CONVERSATION_TITLE_MAX } from "@/lib/ai/coach/types";

import {
  deleteConversation,
  fetchConversationWithMessages,
  renameConversation,
} from "@/lib/ai/coach/persistence";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const renameConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(COACH_CONVERSATION_TITLE_MAX),
  })
  .strict();

export const GET = apiHandler(async (_request: NextRequest, ctx: RouteCtx) => {
  const auth = await requireAuth();
  // v1.4.38 W-C M6 — operator can hide the Coach surface app-wide;
  // the conversation reader is part of the Coach stack (encrypted
  // assistant prose), so a disabled surface must 403 here too.
  await requireAssistantSurface("coach");
  const { id } = await ctx.params;
  if (!id) return apiError("coach.conversation.notFound", 404);

  // v1.28.51 (Documents R3, Design A) — the Coach detail READER now returns
  // both health and doc-scoped threads so `/coach?c=<id>` can display a document
  // conversation inside the real coach chrome. Dropping the `documentId: null`
  // opt removes the scope filter while `auth.user.id` stays narrowed, so a
  // caller can only ever read their OWN thread (a foreign id is still 404).
  // This reader only decrypts + returns persisted messages — no tool loop, no
  // snapshot — so surfacing a doc thread here does not reopen the injection
  // surface the fenced SEND path (documents route) guards. The DTO carries
  // `documentId` + `documentTitle` so the client picks the fenced send path.
  const detail = await fetchConversationWithMessages(auth.user.id, id);
  if (!detail) {
    return apiError("coach.conversation.notFound", 404);
  }

  annotate({
    action: { name: "insights.coach.fetch" },
    meta: { conversationId: id, messageCount: detail.messageCount },
  });

  return apiSuccess(detail);
});

export const PATCH = apiHandler(async (request: NextRequest, ctx: RouteCtx) => {
  const auth = await requireAuth();
  await requireAssistantSurface("coach");
  const { id } = await ctx.params;
  if (!id) return apiError("coach.conversation.notFound", 404);

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = renameConversationSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "coach.conversation.invalidTitle",
    });
  }

  const renamed = await renameConversation(auth.user.id, id, parsed.data.title);
  if (!renamed) {
    return apiError("coach.conversation.notFound", 404);
  }

  await auditLog("coach.conversation.rename", {
    userId: auth.user.id,
    ipAddress: getClientIp(request),
    details: { conversationId: id },
  });
  annotate({
    action: {
      name: "insights.coach.rename",
      entity_type: "coach_conversation",
      entity_id: id,
    },
  });

  return apiSuccess(renamed);
});

export const DELETE = apiHandler(
  async (_request: NextRequest, ctx: RouteCtx) => {
    const auth = await requireAuth();
    // v1.4.38 W-C M6 — same gate as GET; a disabled Coach surface
    // means the user can't reach the conversation list anyway, so the
    // delete affordance must stay behind the same kill-switch.
    await requireAssistantSurface("coach");
    const { id } = await ctx.params;
    if (!id) return apiError("coach.conversation.notFound", 404);

    const ok = await deleteConversation(auth.user.id, id);
    if (!ok) {
      return apiError("coach.conversation.notFound", 404);
    }

    annotate({
      action: { name: "insights.coach.delete" },
      meta: { conversationId: id },
    });

    return apiSuccess({ deleted: true });
  },
);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
