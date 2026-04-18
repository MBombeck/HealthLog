import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { hashPassword, checkPasswordStrength } from "@/lib/auth/password";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { destroyAllSessions } from "@/lib/auth/session";
import { NextRequest, NextResponse } from "next/server";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const ip = getClientIp(request);
  const rl = await checkRateLimit(`admin-reset-pw:${ip}`, 10, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Rate limit exceeded" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const { user } = await requireAdmin();

  const { id } = await params;
  annotate({ action: { name: "admin.users.reset-password", entity_type: "user", entity_id: id } });

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const { password } = body as { password?: string };

  if (!password || typeof password !== "string") {
    return apiError("Password required", 422);
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return apiError("User not found", 404);

  const locale = await resolveServerLocale({
    request,
    userLocale: target.locale ?? null,
  });
  const strength = checkPasswordStrength(password, [target.username], locale);
  if (!strength.isAcceptable) {
    return apiError(
      strength.feedback[0] || "Password too weak (score < 3)",
      422,
    );
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.update({
    where: { id },
    data: { passwordHash },
  });

  // Invalidate all sessions of the target user
  await destroyAllSessions(id);

  await auditLog("admin.user.reset-password", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { targetUserId: id },
  });

  return apiSuccess({ success: true });
});
