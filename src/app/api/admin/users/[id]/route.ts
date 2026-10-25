import { prisma } from "@/lib/db";
import {
  assertAnotherAdminStays,
  LastAdminError,
} from "@/lib/auth/admin-roster";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const updateUserSchema = z
  .object({
    username: z.string().min(3).max(30).optional(),
    email: z.string().email().nullable().optional(),
    role: z.enum(["ADMIN", "USER"]).optional(),
    // v1.23 — per-user "require a second factor" override. Effective requirement
    // is the OR of this and the instance-wide AppSettings.mfaRequired policy.
    mfaEnforced: z.boolean().optional(),
    // Document vault — per-user storage-quota override in bytes. Null clears
    // the override (the instance default applies again). Same bounds as the
    // instance-wide setting.
    documentQuotaBytes: z
      .number()
      .int()
      .min(10_485_760)
      .max(1_099_511_627_776)
      .nullable()
      .optional(),
  })
  .strict();

export const PUT = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user } = await requireAdmin();

    const { id } = await params;
    annotate({
      action: {
        name: "admin.users.update",
        entity_type: "user",
        entity_id: id,
      },
    });

    const parsed = await parseJsonBody(request, updateUserSchema, {
      maxBytes: 64 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    const target = await prisma.user.findUnique({
      where: { id },
      select: { role: true },
    });
    if (!target) return apiError("User not found", 404);

    const demoting = parsed.data.role === "USER" && target.role === "ADMIN";

    let updatedUser;
    try {
      updatedUser = await prisma.$transaction(async (tx) => {
        // Another admin who can sign in must stay: one pending deletion does
        // not count, and the count holds the roster lock an admin's own
        // deletion takes too.
        if (demoting) await assertAnotherAdminStays(tx, id);
        return tx.user.update({
          where: { id },
          data: {
            ...(parsed.data.username !== undefined && {
              username: parsed.data.username,
            }),
            ...(parsed.data.email !== undefined && {
              email: parsed.data.email,
            }),
            ...(parsed.data.role !== undefined && { role: parsed.data.role }),
            ...(parsed.data.mfaEnforced !== undefined && {
              mfaEnforced: parsed.data.mfaEnforced,
            }),
            ...(parsed.data.documentQuotaBytes !== undefined && {
              documentQuotaBytes:
                parsed.data.documentQuotaBytes === null
                  ? null
                  : BigInt(parsed.data.documentQuotaBytes),
            }),
          },
          select: {
            id: true,
            username: true,
            email: true,
            role: true,
            createdAt: true,
            mfaEnforced: true,
            documentQuotaBytes: true,
          },
        });
      });
    } catch (error) {
      if (error instanceof LastAdminError) {
        return apiError("The last admin cannot be demoted", 400);
      }
      throw error;
    }

    await auditLog("admin.user.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { targetUserId: id, changes: parsed.data },
    });

    return apiSuccess({
      ...updatedUser,
      // BigInt → Number for the JSON envelope; null = no override.
      documentQuotaBytes:
        updatedUser.documentQuotaBytes === null
          ? null
          : Number(updatedUser.documentQuotaBytes),
    });
  },
);
