import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

function medicationScope(medicationId: string): string {
  return `medication:${medicationId}:ingest`;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({ where: { id } });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  const scope = medicationScope(id);
  const now = new Date();

  const activeTokenCount = await prisma.apiToken.count({
    where: {
      userId: sessionData.user.id,
      revoked: false,
      permissions: { has: scope },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  return apiSuccess({
    enabled: activeTokenCount > 0,
    activeTokenCount,
  });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({ where: { id } });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  let enabled = false;
  try {
    const body = await request.json();
    enabled = body?.enabled === true;
  } catch {
    return apiError("Ungültige Anfrage", 422);
  }

  const scope = medicationScope(id);

  if (enabled) {
    const existing = await prisma.apiToken.count({
      where: {
        userId: sessionData.user.id,
        revoked: false,
        permissions: { has: scope },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });

    if (existing > 0) {
      return apiSuccess({
        enabled: true,
        activeTokenCount: existing,
        token: null,
        created: false,
      });
    }

    const rawToken = `hlk_${randomBytes(32).toString("hex")}`;
    const tokenHashValue = hashToken(rawToken);

    await prisma.apiToken.create({
      data: {
        userId: sessionData.user.id,
        name: `API Endpoint: ${medication.name}`,
        tokenHash: tokenHashValue,
        permissions: ["medication:ingest", scope],
        expiresAt: null,
      },
    });

    await auditLog("medication.api_endpoint.enable", {
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, medicationName: medication.name },
    });

    return apiSuccess(
      {
        enabled: true,
        activeTokenCount: 1,
        token: rawToken,
        created: true,
      },
      201,
    );
  }

  const revoked = await prisma.apiToken.updateMany({
    where: {
      userId: sessionData.user.id,
      revoked: false,
      permissions: { has: scope },
    },
    data: { revoked: true },
  });

  await auditLog("medication.api_endpoint.disable", {
    userId: sessionData.user.id,
    ipAddress: getClientIp(request),
    details: {
      medicationId: id,
      medicationName: medication.name,
      revokedTokens: revoked.count,
    },
  });

  return apiSuccess({
    enabled: false,
    revokedTokenCount: revoked.count,
  });
}
