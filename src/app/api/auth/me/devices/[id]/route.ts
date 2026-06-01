/**
 * DELETE /api/auth/me/devices/[id]
 *
 * v1.4.23 W4 F7b — revoke a single device.
 *
 * Behaviour:
 *   1. Confirms the device row belongs to the current user (ownership
 *      boundary — 404 on cross-user attempts so callers can't probe
 *      another tenant's device ids).
 *   2. Revokes every active refresh token bound to this `deviceId` and
 *      the access tokens those refresh rows pair with.
 *   3. Deletes the `Device` row outright. Future re-pairing will create
 *      a fresh row.
 *
 * Note: this route does NOT touch the user's browser session cookie —
 * the session lives on `Session.id`, not `Device.id`. Browser logouts
 * keep using /api/auth/logout. The two surfaces address different
 * blast radii.
 *
 * v1.4.23 W6 — the four-write cascade now runs through the shared
 * `revokeDeviceCascade` helper so the writes commit atomically inside
 * a single `prisma.$transaction`. Previously a partial failure could
 * leave the device row alive with all its tokens revoked.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { deviceDeliverySchema } from "@/lib/validations/notification-prefs";
import { revokeDeviceCascade } from "@/lib/devices/revoke";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * v1.7.0 — per-device medication-delivery override. NULL clears the
 * override (the device inherits the user-level roaming default).
 */
const devicePatchSchema = z.object({
  medicationDelivery: deviceDeliverySchema,
});

export const PATCH = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { user } = await requireAuth();
    const { id } = await context.params;

    const { data: body, error: jsonError } = await safeJson(request);
    if (jsonError) return jsonError;
    const parsed = devicePatchSchema.safeParse(body);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422);
    }

    // Ownership boundary — scope the update by userId so a cross-user id
    // can't be patched, and 404 rather than leak existence.
    const result = await prisma.device.updateMany({
      where: { id, userId: user.id },
      data: { medicationDelivery: parsed.data.medicationDelivery },
    });
    if (result.count === 0) {
      return apiError("Device not found", 404);
    }

    const device = await prisma.device.findUnique({
      where: { id },
      select: { id: true, medicationDelivery: true },
    });

    annotate({
      action: {
        name: "auth.me.devices.update",
        entity_type: "device",
        entity_id: id,
      },
      meta: { medication_delivery: parsed.data.medicationDelivery ?? "inherit" },
    });

    return apiSuccess({
      id,
      medicationDelivery: device?.medicationDelivery ?? null,
    });
  },
);

export const DELETE = apiHandler(
  async (_request: NextRequest, context: RouteContext) => {
    const { user } = await requireAuth();
    const { id } = await context.params;

    const result = await revokeDeviceCascade(user.id, id);
    if (!result) {
      // 404 on cross-user attempts — leaking "this id exists but isn't
      // yours" would let an attacker enumerate device ids.
      return apiError("Device not found", 404);
    }

    await auditLog("devices.revoke", {
      userId: user.id,
      details: {
        deviceId: result.id,
        label: result.label,
        refreshTokensRevoked: result.refreshTokensRevoked,
        accessTokensRevoked: result.accessTokensRevoked,
      },
    });
    annotate({
      action: {
        name: "auth.me.devices.revoke",
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
