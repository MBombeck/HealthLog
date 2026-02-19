import { prisma } from "@/lib/db";
import { profileSchema } from "@/lib/validations/auth";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

export async function PUT(request: NextRequest) {
  try {
    const sessionData = await getSession();
    if (!sessionData) {
      return apiError("Nicht angemeldet", 401);
    }

    const body = await request.json();
    const parsed = profileSchema.safeParse(body);

    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const data = parsed.data;
    const user = await prisma.user.update({
      where: { id: sessionData.user.id },
      data: {
        heightCm: data.heightCm ?? null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        ...(data.gender !== undefined ? { gender: data.gender } : {}),
      },
    });

    await auditLog("profile.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
    });

    return apiSuccess({
      id: user.id,
      username: user.username,
      role: user.role,
      heightCm: user.heightCm,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      timezone: user.timezone,
    });
  } catch (err) {
    console.error("Profile update error:", err);
    return apiError("Profil-Update fehlgeschlagen", 500);
  }
}
