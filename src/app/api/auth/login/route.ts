import { prisma } from "@/lib/db";
import { loginPasswordSchema } from "@/lib/validations/auth";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const rl = checkRateLimit(`auth:login:${ip}`, 5, 15 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Zu viele Anmeldeversuche. Bitte später erneut versuchen." },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  try {
    const body = await request.json();
    const parsed = loginPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return apiError("Ungültige Anmeldedaten", 422);
    }

    const { username, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !user.passwordHash) {
      await auditLog("auth.login.failed", {
        ipAddress: ip,
        details: { username, reason: "user_not_found_or_no_password" },
      });
      return apiError("Ungültige Anmeldedaten", 401);
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      await auditLog("auth.login.failed", {
        userId: user.id,
        ipAddress: ip,
        details: { reason: "invalid_password" },
      });
      return apiError("Ungültige Anmeldedaten", 401);
    }

    const ua = request.headers.get("user-agent");
    await createSession(user.id, ip, ua);

    await auditLog("auth.login.password", {
      userId: user.id,
      ipAddress: ip,
    });

    return apiSuccess({
      user: { id: user.id, username: user.username },
    });
  } catch (err) {
    console.error("Login error:", err);
    return apiError("Anmeldung fehlgeschlagen", 500);
  }
}
