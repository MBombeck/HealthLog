import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { hashToken } from "@/lib/auth/hmac";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { externalIntakeSchema } from "@/lib/validations/medication";
import { NextRequest, NextResponse } from "next/server";

/**
 * External medication ingest endpoint.
 * Auth: Bearer token (hashed and looked up in api_tokens table).
 * Idempotent via idempotencyKey.
 * Rate limit: 60 requests per minute per IP.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);

  // Rate limiting: 60 requests per minute per IP
  const rl = checkRateLimit(`ingest:${ip}`, 60, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Rate limit exceeded" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  // Extract bearer token
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return apiError("Authorization header required", 401);
  }

  const token = authHeader.slice(7);
  const tokenHashValue = hashToken(token);

  const apiToken = await prisma.apiToken.findUnique({
    where: { tokenHash: tokenHashValue },
    include: { user: true },
  });

  if (!apiToken || apiToken.revoked) {
    return apiError("Invalid or revoked token", 401);
  }

  if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
    return apiError("Token expired", 401);
  }

  if (!apiToken.permissions.includes("medication:ingest")) {
    return apiError("Insufficient permissions", 403);
  }

  // Update lastUsedAt
  await prisma.apiToken.update({
    where: { id: apiToken.id },
    data: { lastUsedAt: new Date() },
  });

  try {
    const body = await request.json();
    const parsed = externalIntakeSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { medicationName, takenAt, idempotencyKey } = parsed.data;

    // Idempotency check
    const existing = await prisma.medicationIntakeEvent.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      return apiSuccess(existing);
    }

    // Find medication by name for this user
    const medication = await prisma.medication.findFirst({
      where: {
        userId: apiToken.userId,
        name: { equals: medicationName, mode: "insensitive" },
        active: true,
      },
    });

    if (!medication) {
      return apiError(`Medikament "${medicationName}" nicht gefunden`, 404);
    }

    const event = await prisma.medicationIntakeEvent.create({
      data: {
        userId: apiToken.userId,
        medicationId: medication.id,
        scheduledFor: takenAt ?? new Date(),
        takenAt: takenAt ?? new Date(),
        skipped: false,
        source: "API",
        idempotencyKey,
      },
    });

    await auditLog("medication.ingest.external", {
      userId: apiToken.userId,
      ipAddress: ip,
      details: {
        medicationId: medication.id,
        eventId: event.id,
        tokenId: apiToken.id,
      },
    });

    return apiSuccess(event, 201);
  } catch (err) {
    console.error("External ingest error:", err);
    return apiError("Ingest fehlgeschlagen", 500);
  }
}
