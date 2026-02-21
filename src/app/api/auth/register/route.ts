import { prisma } from "@/lib/db";
import { registerSchema } from "@/lib/validations/auth";
import { hashPassword, checkPasswordStrength } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const rl = checkRateLimit(`auth:register:${ip}`, 5, 15 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        data: null,
        error:
          "Zu viele Registrierungsversuche. Bitte später erneut versuchen.",
      },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  try {
    // Check if registration is enabled
    let registrationEnabled = true;
    try {
      const settings = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
      });
      if (settings && !settings.registrationEnabled) {
        registrationEnabled = false;
      }
    } catch {
      // Table may not exist yet; allow registration
    }
    if (!registrationEnabled) {
      return apiError("Registrierung ist deaktiviert", 403);
    }

    const body = await request.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { email, username, password } = parsed.data;

    // Check if email taken
    const existingEmail = await prisma.user.findUnique({
      where: { email },
    });
    if (existingEmail) {
      return apiError("E-Mail-Adresse bereits vergeben", 409);
    }

    // Check if username taken
    const existingUsername = await prisma.user.findUnique({
      where: { username },
    });
    if (existingUsername) {
      return apiError("Benutzername bereits vergeben", 409);
    }

    // Validate password strength
    const strength = checkPasswordStrength(password, [username, email]);
    if (!strength.isAcceptable) {
      return apiError(
        strength.feedback[0] || "Passwort zu schwach (Score < 3)",
        422,
      );
    }
    const passwordHash = await hashPassword(password);

    // First user becomes admin
    const userCount = await prisma.user.count();
    const role = userCount === 0 ? "ADMIN" : "USER";

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        role,
      },
    });

    // Create session immediately
    const ua = request.headers.get("user-agent");
    await createSession(user.id, ip, ua);

    await auditLog("auth.register", {
      userId: user.id,
      ipAddress: ip,
      details: { method: "password" },
    });

    return apiSuccess(
      {
        user: { id: user.id, username: user.username, email: user.email },
      },
      201,
    );
  } catch (err) {
    console.error("Register error:", err);
    return apiError("Registrierung fehlgeschlagen", 500);
  }
}
