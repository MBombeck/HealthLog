import { prisma } from "@/lib/db";
import { registerSchema } from "@/lib/validations/auth";
import { hashPassword, checkPasswordStrength } from "@/lib/auth/password";
import { createRegistrationOptions } from "@/lib/auth/passkey";
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
        error: "Zu viele Registrierungsversuche. Bitte später erneut versuchen.",
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

    const { username, password } = parsed.data;

    // Check if username taken
    const existing = await prisma.user.findUnique({
      where: { username },
    });
    if (existing) {
      return apiError("Benutzername bereits vergeben", 409);
    }

    // If password provided, validate strength
    let passwordHash: string | null = null;
    if (password) {
      const strength = checkPasswordStrength(password, [username]);
      if (!strength.isAcceptable) {
        return apiError(
          strength.feedback[0] || "Passwort zu schwach (Score < 3)",
          422,
        );
      }
      passwordHash = await hashPassword(password);
    }

    // First user becomes admin
    const userCount = await prisma.user.count();
    const role = userCount === 0 ? "ADMIN" : "USER";

    // Create user
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        role,
      },
    });

    // Generate passkey registration options
    const { options, challengeId } = await createRegistrationOptions(
      user.id,
      user.username,
    );

    // Create session immediately (user is "registered" even before passkey)
    const ua = request.headers.get("user-agent");
    await createSession(user.id, ip, ua);

    await auditLog("auth.register", {
      userId: user.id,
      ipAddress: ip,
      details: { method: password ? "password+passkey" : "passkey" },
    });

    return apiSuccess(
      {
        user: { id: user.id, username: user.username },
        passkey: { options, challengeId },
      },
      201,
    );
  } catch (err) {
    console.error("Register error:", err);
    return apiError("Registrierung fehlgeschlagen", 500);
  }
}
