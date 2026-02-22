import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import {
  verifyPassword,
  hashPassword,
  checkPasswordStrength,
} from "@/lib/auth/password";
import { changePasswordSchema } from "@/lib/validations/auth";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  try {
    const sessionData = await getSession();
    if (!sessionData) {
      return apiError("Nicht angemeldet", 401);
    }

    const rl = checkRateLimit(
      `auth:password:${sessionData.user.id}`,
      5,
      15 * 60 * 1000,
    );
    if (!rl.allowed) {
      return apiError(
        "Zu viele Versuche. Bitte 15 Minuten warten.",
        429,
      );
    }

    const body = await request.json();
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { currentPassword, newPassword } = parsed.data;
    if (!sessionData.user.passwordHash) {
      return apiError("Für dieses Konto ist kein Passwort gesetzt", 400);
    }

    const currentValid = await verifyPassword(
      sessionData.user.passwordHash,
      currentPassword,
    );
    if (!currentValid) {
      return apiError("Aktuelles Passwort ist falsch", 401);
    }

    if (currentPassword === newPassword) {
      return apiError(
        "Neues Passwort muss sich vom aktuellen unterscheiden",
        422,
      );
    }

    const strength = checkPasswordStrength(newPassword, [
      sessionData.user.username,
      sessionData.user.email ?? "",
    ]);
    if (!strength.isAcceptable) {
      return apiError(
        strength.feedback[0] || "Passwort zu schwach (Score < 3)",
        422,
      );
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: sessionData.user.id },
      data: { passwordHash: newHash },
    });

    await auditLog("auth.password.change", {
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
    });

    return apiSuccess({ changed: true });
  } catch (err) {
    console.error("Password change error:", err);
    return apiError("Passwort konnte nicht geändert werden", 500);
  }
}
