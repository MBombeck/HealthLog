import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { hashToken } from "@/lib/auth/hmac";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const tokens = await prisma.apiToken.findMany({
    where: { userId: sessionData.user.id },
    select: {
      id: true,
      name: true,
      permissions: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
      revoked: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return apiSuccess(tokens);
}

export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) {
      return apiError("Name ist erforderlich (max 100 Zeichen)", 422);
    }

    // Generate a random token
    const rawToken = `hlk_${randomBytes(32).toString("hex")}`;
    const tokenHashValue = hashToken(rawToken);

    await prisma.apiToken.create({
      data: {
        userId: sessionData.user.id,
        name,
        tokenHash: tokenHashValue,
        permissions: ["medication:ingest"],
        expiresAt: body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 86400000)
          : null,
      },
    });

    // Return the raw token ONCE — it can never be retrieved again
    return apiSuccess({ token: rawToken, name }, 201);
  } catch (err) {
    console.error("Create token error:", err);
    return apiError("Token konnte nicht erstellt werden", 500);
  }
}
