/**
 * DELETE /api/auth/me/sessions/[id] — revoke a single active web session.
 *
 * v1.23 — the deletion is scoped to the authenticated user (the Prisma `where`
 * narrows on both id AND userId), so a caller can never revoke another user's
 * session by guessing an id. A 404 is returned for a non-existent or
 * not-owned id so the surface cannot probe foreign session ids.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { destroySessionById, sessionHandle } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { user, session } = await requireSelfAuth();
    const { id } = await ctx.params;

    const removed = await destroySessionById(user.id, id);
    if (!removed) {
      return apiError("Session not found", 404);
    }

    // The path carries the public handle, never the row id, so "is this the
    // caller's own session" compares handles. A Bearer caller's `session.id`
    // is a token id, whose handle matches no session, which is the right
    // answer for it too.
    const self = id === sessionHandle(session.id);

    await auditLog("auth.session.revoke", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { self },
    });

    annotate({
      action: { name: "auth.session.revoke" },
      meta: { self },
    });

    return apiSuccess({ revoked: true });
  },
);
