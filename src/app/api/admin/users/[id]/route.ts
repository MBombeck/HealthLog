import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const updateUserSchema = z.object({
  username: z.string().min(3).max(30).optional(),
  email: z.string().email().nullable().optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
});

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

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
    }

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return apiError("User not found", 404);

    // Prevent removing the last admin
    if (parsed.data.role === "USER" && target.role === "ADMIN") {
      const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
      if (adminCount <= 1) {
        return apiError("The last admin cannot be demoted", 400);
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        ...(parsed.data.username !== undefined && {
          username: parsed.data.username,
        }),
        ...(parsed.data.email !== undefined && { email: parsed.data.email }),
        ...(parsed.data.role !== undefined && { role: parsed.data.role }),
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    await auditLog("admin.user.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { targetUserId: id, changes: parsed.data },
    });

    return apiSuccess(updatedUser);
  },
);
