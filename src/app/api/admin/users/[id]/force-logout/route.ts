/**
 * POST /api/admin/users/[id]/force-logout — admin-only kill-switch.
 *
 * Ends every way into the target account through `destroyAllSessions`, the
 * same function a password change and an admin password reset run: web
 * sessions, every native sign-in (refresh token family and its paired access
 * token), API tokens, trusted devices, step-up elevations, connected
 * assistants and the URL credentials, then the push credentials of the
 * devices left without a sign-in. The next request from any of their
 * browser or native clients is refused and has to sign in again.
 *
 * `sessionsRevoked` counts the sign-ins that ended: web sessions plus live
 * native sign-ins (one per device).
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { destroyAllSessions } from "@/lib/auth/session";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { NextRequest } from "next/server";

export const POST = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user: admin } = await requireAdmin();
    const { id } = await params;

    annotate({
      action: {
        name: "admin.users.force-logout",
        entity_type: "user",
        entity_id: id,
      },
    });

    // Mirror the UI gate at user-management-section.tsx:295 — admins
    // mid-action shouldn't bounce themselves to /auth/login. A
    // determined admin can revoke another admin (intentional today),
    // but the self-target case is always a footgun.
    if (admin.id === id) {
      await auditLog("admin.user.force-logout.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { targetUserId: id, reason: "self_target" },
      });
      return apiError("Cannot force-logout your own session", 422);
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true },
    });
    if (!target) return apiError("User not found", 404);

    const ended = await destroyAllSessions(id);
    const sessionsRevoked = ended.webSessions + ended.deviceSignIns;

    await auditLog("admin.user.force-logout", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        targetUserId: id,
        sessionsRevoked,
        webSessionsRevoked: ended.webSessions,
        deviceSignInsRevoked: ended.deviceSignIns,
      },
    });

    annotate({
      meta: {
        sessions_revoked: sessionsRevoked,
        web_sessions_revoked: ended.webSessions,
        device_sign_ins_revoked: ended.deviceSignIns,
      },
    });

    return apiSuccess({ sessionsRevoked });
  },
);
