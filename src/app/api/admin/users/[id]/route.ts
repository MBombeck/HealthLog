import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const updateUserSchema = z.object({
  username: z.string().min(3).max(30).optional(),
  email: z.string().email().nullable().optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  const { id } = await params;

  const body = await request.json();
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return apiError("Benutzer nicht gefunden", 404);

  // Prevent removing the last admin
  if (parsed.data.role === "USER" && target.role === "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return apiError("Der letzte Admin kann nicht degradiert werden", 400);
    }
  }

  const user = await prisma.user.update({
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
    userId: admin.id,
    ipAddress: getClientIp(request),
    details: { targetUserId: id, changes: parsed.data },
  });

  return apiSuccess(user);
}
