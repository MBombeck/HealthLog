import { prisma } from "@/lib/db";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { hashToken } from "@/lib/auth/hmac";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { externalIntakeSchema } from "@/lib/validations/medication";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import { NextRequest, NextResponse } from "next/server";

/**
 * External medication ingest endpoint.
 * Auth: Bearer token (hashed and looked up in api_tokens table).
 * Idempotent via idempotencyKey.
 * Rate limit: 60 requests per minute per IP.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "ingest.medication" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403);
  }

  const ip = getClientIp(request);

  // Rate limiting: 60 requests per minute per IP
  const rl = await checkRateLimit(`ingest:${ip}`, 60, 60 * 1000);
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
    select: {
      id: true,
      userId: true,
      permissions: true,
      revoked: true,
      expiresAt: true,
      lastUsedAt: true,
    },
  });

  if (!apiToken || apiToken.revoked) {
    return apiError("Invalid or revoked token", 401);
  }

  if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
    return apiError("Token expired", 401);
  }

  if (
    !apiToken.permissions.includes("*") &&
    !apiToken.permissions.includes("medication:ingest")
  ) {
    return apiError("Insufficient permissions", 403);
  }

  // Annotate auth after verification
  getEvent()?.setAuth({
    user_id: apiToken.userId,
    auth_method: "api_key",
  });

  // Update lastUsedAt
  await prisma.apiToken.update({
    where: { id: apiToken.id },
    data: { lastUsedAt: new Date() },
  });

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = externalIntakeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { medicationName, takenAt, idempotencyKey } = parsed.data;

  // Idempotency check (scoped to token owner to prevent cross-user lookups)
  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: {
      idempotencyKey,
      userId: apiToken.userId,
    },
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
    return apiError("Medication not found", 404);
  }

  const medicationScope = `medication:${medication.id}:ingest`;
  if (
    !apiToken.permissions.includes("*") &&
    !apiToken.permissions.includes(medicationScope)
  ) {
    return apiError("API endpoint for this medication is disabled", 403);
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

  annotate({ meta: { medication_id: medication.id, event_id: event.id } });

  // v1.4.39 W-MED — refresh the compliance rollup for the ingested
  // event's user-day. The external ingest path runs without a User
  // record in scope; resolve the tz once for the recompute.
  const ingestUser = await prisma.user.findUnique({
    where: { id: apiToken.userId },
    select: { timezone: true },
  });
  await recomputeMedicationComplianceForEvent({
    userId: apiToken.userId,
    medicationId: medication.id,
    scheduledFor: event.scheduledFor,
    tz: ingestUser?.timezone ?? null,
  });

  return apiSuccess(event, 201);
});
