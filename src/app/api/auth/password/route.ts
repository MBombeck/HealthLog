import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import {
  verifyPassword,
  hashPassword,
  checkPasswordStrength,
} from "@/lib/auth/password";
import { changePasswordSchema } from "@/lib/validations/auth";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { destroyAllSessions, createSession } from "@/lib/auth/session";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `auth:password:${user.id}`,
    5,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError(
      "Too many attempts. Please wait 15 minutes.",
      429,
    );
  }

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { currentPassword, newPassword } = parsed.data;
  if (!user.passwordHash) {
    return apiError("No password set for this account", 400);
  }

  const currentValid = await verifyPassword(
    user.passwordHash,
    currentPassword,
  );
  if (!currentValid) {
    return apiError("Current password is incorrect", 401);
  }

  if (currentPassword === newPassword) {
    return apiError(
      "New password must differ from current password",
      422,
    );
  }

  const locale = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
  });
  const strength = checkPasswordStrength(
    newPassword,
    [user.username, user.email ?? ""],
    locale,
  );
  if (!strength.isAcceptable) {
    return apiError(
      strength.feedback[0] || "Password too weak (score < 3)",
      422,
    );
  }

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash },
  });

  // Invalidate all existing sessions and create a fresh one
  await destroyAllSessions(user.id);
  await createSession(
    user.id,
    getClientIp(request),
    request.headers.get("user-agent"),
  );

  await auditLog("auth.password.change", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });

  annotate({ action: { name: "auth.password.change" } });

  return apiSuccess({ changed: true });
});
