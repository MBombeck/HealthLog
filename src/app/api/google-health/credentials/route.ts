import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { isP2025 } from "@/lib/prisma-errors";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { markDisconnected } from "@/lib/integrations/status";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * Per-user Google Health BYO-key credentials. Each self-hoster registers their
 * own Google Cloud OAuth client (the Restricted-scope brand verification + CASA
 * assessment is per-OAuth-client, so a single shared app is unworkable for a
 * multi-operator product) and pastes the client id/secret into Settings. Stored
 * encrypted on `User`.
 */
const googleHealthCredentialsSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(200),
});

/**
 * Check whether the user has Google Health BYO-key credentials stored
 * (v1.26.0).
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "google_health.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      googleHealthClientIdEncrypted: true,
      googleHealthClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.googleHealthClientIdEncrypted &&
      !!dbUser?.googleHealthClientSecretEncrypted,
  });
});

/**
 * Save Google Health API credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "google_health.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(googleHealthCredentialsSchema, body);
  if (!result.success) {
    return apiError("Client ID and Client Secret are required", 422);
  }

  // Field-by-field assignment — never spread the parsed object, so no future
  // schema addition can silently mass-assign an unexpected column.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      googleHealthClientIdEncrypted: encrypt(result.data.clientId),
      googleHealthClientSecretEncrypted: encrypt(result.data.clientSecret),
    },
  });

  return apiSuccess({ updated: true });
});

/**
 * Delete Google Health credentials and the active connection.
 *
 * Audits the teardown and parks the integration ledger at `disconnected` for
 * parity with the Fitbit / Polar / Oura credential-DELETE so a sensitive op
 * leaves a uniform audit trail and the status snapshot does not linger at a
 * stale state.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "google_health.credentials.delete" } });

  await prisma.googleHealthConnection
    .delete({ where: { userId: user.id } })
    .catch((err) => {
      if (!isP2025(err)) throw err;
    });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      googleHealthClientIdEncrypted: null,
      googleHealthClientSecretEncrypted: null,
    },
  });
  await auditLog("google_health.credentials.delete", { userId: user.id });
  await markDisconnected(user.id, "google-health");

  return apiSuccess({ deleted: true });
});
