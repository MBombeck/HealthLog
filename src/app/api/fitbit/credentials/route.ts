import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { isP2025 } from "@/lib/prisma-errors";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { markDisconnected } from "@/lib/integrations/status";
import { fitbitCredentialsSchema } from "@/lib/validations/fitbit";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * Check whether the user has Fitbit / Google Health BYO-key credentials stored
 * (v1.12.0).
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      fitbitClientIdEncrypted: true,
      fitbitClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.fitbitClientIdEncrypted &&
      !!dbUser?.fitbitClientSecretEncrypted,
  });
});

/**
 * Save Fitbit / Google Health API credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(fitbitCredentialsSchema, body);
  if (!result.success) {
    return apiValidationError(
      "Client ID and Client Secret are required",
      sanitiseZodIssues(result.error.issues),
      422,
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      fitbitClientIdEncrypted: encrypt(result.data.clientId),
      fitbitClientSecretEncrypted: encrypt(result.data.clientSecret),
    },
  });

  return apiSuccess({ updated: true });
});

/**
 * Delete Fitbit credentials and the active connection.
 *
 * Audits the teardown and parks the integration ledger at `disconnected` for
 * parity with the Polar / Oura credential-DELETE so a sensitive op leaves a
 * uniform audit trail and the status snapshot does not linger at a stale state.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.credentials.delete" } });

  // A missing connection row (P2025) is a benign "already disconnected"
  // no-op; any other failure must propagate rather than be swallowed —
  // otherwise the encrypted OAuth tokens can be left orphaned while the user
  // is told the integration was disconnected.
  await prisma.fitbitConnection
    .delete({ where: { userId: user.id } })
    .catch((err) => {
      if (!isP2025(err)) throw err;
    });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      fitbitClientIdEncrypted: null,
      fitbitClientSecretEncrypted: null,
    },
  });
  await auditLog("fitbit.credentials.delete", { userId: user.id });
  await markDisconnected(user.id, "fitbit");

  return apiSuccess({ deleted: true });
});
