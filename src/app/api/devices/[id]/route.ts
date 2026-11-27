/**
 * DELETE /api/devices/[id]
 *
 * v1.4.23 W4 F7b alternate iOS endpoint — mirror of
 * `DELETE /api/auth/me/devices/[id]` for the v1.5 iOS app's
 * token-rotation cleanup path. Same ownership boundary, same audit
 * trail, same cascade.
 *
 * The duplication is deliberate: the W3 open question called out
 * needing a native-friendly URL for the iOS client's APNs rotation
 * loop, and the `/api/auth/me/...` path is built for the settings-
 * surface listing. Two URLs share one transactional helper
 * (`revokeDeviceCascade`) so the cascade stays atomic — the W6 audit
 * collapsed the previous duplicated four-write sequence into a single
 * `prisma.$transaction` call.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { revokeDeviceCascade } from "@/lib/devices/revoke";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const DELETE = apiHandler(
  async (_request: NextRequest, context: RouteContext) => {
    const { user } = await requireSelfAuth();
    const { id } = await context.params;

    const result = await revokeDeviceCascade(user.id, id);
    if (!result) {
      return apiError("Device not found", 404);
    }

    await auditLog("devices.revoke", {
      userId: user.id,
      details: {
        deviceId: result.id,
        label: result.label,
        refreshTokensRevoked: result.refreshTokensRevoked,
        accessTokensRevoked: result.accessTokensRevoked,
        via: "ios.rotation",
      },
    });
    annotate({
      action: {
        name: "devices.revoke",
        entity_type: "device",
        entity_id: result.id,
      },
      meta: {
        refresh_tokens_revoked: result.refreshTokensRevoked,
        access_tokens_revoked: result.accessTokensRevoked,
      },
    });

    return apiSuccess({
      id: result.id,
      revoked: true,
      refreshTokensRevoked: result.refreshTokensRevoked,
      accessTokensRevoked: result.accessTokensRevoked,
    });
  },
);
