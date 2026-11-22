/**
 * `POST /api/admin/import-apple-health-export` — admin-only Apple
 * Health import on behalf of a target user.
 *
 * The shared staged upload (`src/lib/import/staged-upload.ts`) with the
 * admin as the acting account: `requireAdmin()` (cookie-only — Bearer tokens
 * never elevate) and a `userId` text field naming the target user. The
 * `ImportJob` row carries `triggeredByAdminId = admin.id`, so the status
 * endpoint admits both the target user and the triggering admin.
 *
 * Every refusal is an audit row here, not the signal the owner's upload
 * emits: this is an administrator acting on another person's account, and
 * every attempt at that, refused ones included, belongs in the trail an
 * operator reviews.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import {
  APPLE_HEALTH_CAP_LABEL,
  APPLE_HEALTH_MAX_UPLOAD_BYTES,
  APPLE_HEALTH_STAGED_IMPORT,
} from "@/lib/import/apple-health-upload";
import {
  handleStagedUpload,
  type UploadActor,
} from "@/lib/import/staged-upload";

export const dynamic = "force-dynamic";

const ACTION = "admin.import-apple-health.kickoff";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user: admin } = await requireAdmin();
  const denied = (reason: string, details: Record<string, unknown>) =>
    auditLog(`${ACTION}.denied`, {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason, ...details },
    });

  const actor: UploadActor = {
    id: admin.id,
    denied,
    async target(uploaded) {
      // Mandatory: the admin variant is explicitly cross-user.
      const targetUserId = uploaded.textFields.userId;
      if (!targetUserId) {
        await denied("missing_user_id", {});
        return apiError("Multipart field 'userId' is required", 422);
      }
      const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, username: true },
      });
      if (!targetUser) {
        await denied("target_user_missing", { targetUserId });
        return apiError(`Target user '${targetUserId}' does not exist`, 422);
      }
      return {
        userId: targetUser.id,
        triggeredByAdminId: admin.id,
        auditDetails: {
          targetUserId: targetUser.id,
          targetUsername: targetUser.username,
        },
        responseFields: { targetUserId: targetUser.id },
      };
    },
  };

  return handleStagedUpload(
    request,
    {
      action: ACTION,
      maxBytes: APPLE_HEALTH_MAX_UPLOAD_BYTES,
      capLabel: APPLE_HEALTH_CAP_LABEL,
      tmpPrefix: "healthlog-admin-apple-health-import",
      import: APPLE_HEALTH_STAGED_IMPORT,
    },
    actor,
  );
});
