/**
 * PATCH  /api/auth/me/mfa/webauthn/[id]  — rename a registered security key.
 * DELETE /api/auth/me/mfa/webauthn/[id]  — remove one (step-up gated).
 *
 * Both go through `requireMfaManagementAuth`: a cookie session, or a Bearer
 * token presenting a single-use step-up elevation. Removal additionally demands
 * the fresh-factor arm (`freshFactor: true`) — on the cookie path a session that
 * completed a second factor inside the step-up window, on the Bearer path an
 * elevation minted against a re-proved factor.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireMfaManagementAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { mfaWebauthnRenameSchema } from "@/lib/validations/mfa";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const auth = await requireMfaManagementAuth();
    const { user } = auth;
    const { id } = await params;

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 4 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = mfaWebauthnRenameSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid request", 422);
    }

    const existing = await prisma.webauthnMfaCredential.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Security key not found", 404);
    }

    await auth.commitElevation();

    const updated = await prisma.webauthnMfaCredential.update({
      where: { id },
      data: { name: parsed.data.name },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true },
    });

    annotate({ action: { name: "auth.mfa.webauthn.rename" } });
    return apiSuccess(updated);
  },
);

export const DELETE = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    // Step-up gate first — throws StepUpRequiredError (401 + errorCode) if the
    // session is not freshly second-factor-verified.
    const auth = await requireMfaManagementAuth({ freshFactor: true });
    const { user } = auth;
    const { id } = await params;

    const existing = await prisma.webauthnMfaCredential.findUnique({
      where: { id },
      select: { userId: true, name: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Security key not found", 404);
    }

    // Ownership resolved and the row is about to go — spend the elevation now,
    // so a 404 for someone else's key id does not burn it.
    await auth.commitElevation();

    await prisma.webauthnMfaCredential.delete({ where: { id } });

    await auditLog("auth.mfa.webauthn.remove", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { credentialId: id, name: existing.name },
    });
    annotate({ action: { name: "auth.mfa.webauthn.remove" } });

    return apiSuccess({ success: true });
  },
);
