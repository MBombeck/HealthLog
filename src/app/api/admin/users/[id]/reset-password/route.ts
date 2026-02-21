import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { hashPassword, checkPasswordStrength } from "@/lib/auth/password";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`admin-reset-pw:${ip}`, 10, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Rate limit exceeded" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  const { id } = await params;
  const body = await request.json();
  const { password } = body as { password?: string };

  if (!password || typeof password !== "string") {
    return apiError("Passwort erforderlich", 422);
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return apiError("Benutzer nicht gefunden", 404);

  const strength = checkPasswordStrength(password, [target.username]);
  if (!strength.isAcceptable) {
    return apiError(
      strength.feedback[0] || "Passwort zu schwach (Score < 3)",
      422,
    );
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.update({
    where: { id },
    data: { passwordHash },
  });

  await auditLog("admin.user.reset-password", {
    userId: admin.id,
    ipAddress: getClientIp(request),
    details: { targetUserId: id },
  });

  return apiSuccess({ success: true });
}
