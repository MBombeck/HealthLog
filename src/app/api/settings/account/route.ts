import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { destroyAllSessions } from "@/lib/auth/session";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

/**
 * Permanently delete the user account and ALL associated data.
 * Cascading deletes in the schema handle all related records.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  let confirm = "";
  try {
    const body = await request.json();
    confirm = typeof body?.confirm === "string" ? body.confirm : "";
  } catch {
    return apiError("Invalid request", 422);
  }

  if (confirm !== "DELETE_ACCOUNT") {
    return apiError(
      "Confirmation missing. Send { confirm: 'DELETE_ACCOUNT' }",
      422,
    );
  }

  // Prevent last admin from deleting themselves
  if (user.role === "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return apiError(
        "The last admin account cannot be deleted",
        400,
      );
    }
  }

  const userId = user.id;
  const username = user.username;

  // Log BEFORE deletion. The audit row's userId is SetNull post-cascade
  // (per schema), but we then immediately purge it below for GDPR Art. 17
  // erasure completeness — see comment further down.
  await auditLog("user.account.delete", {
    userId,
    ipAddress: getClientIp(request),
    details: { username },
  });

  // Destroy all sessions first
  await destroyAllSessions(userId);

  // Audit V3 NEW-V3-2 / GDPR Art. 17 fix: Feedback and AuditLog rows have
  // `onDelete: SetNull` in the schema, which keeps PII (free-text symptom
  // descriptions, IP addresses, login city geo) attached to the record after
  // the user is deleted. We explicitly purge them inside the same logical
  // operation so account deletion is genuinely complete erasure.
  await prisma.feedback.deleteMany({ where: { userId } });
  await prisma.auditLog.deleteMany({ where: { userId } });

  // Delete user — all other related data is removed via onDelete: Cascade
  await prisma.user.delete({ where: { id: userId } });

  annotate({
    action: { name: "settings.account.delete" },
    meta: { username },
  });

  return apiSuccess({ deleted: true });
});
