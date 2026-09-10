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
import { whoopCredentialsSchema } from "@/lib/validations/whoop";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * Check whether the user has WHOOP BYO-key credentials stored (v1.11.0).
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      whoopClientIdEncrypted: true,
      whoopClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.whoopClientIdEncrypted && !!dbUser?.whoopClientSecretEncrypted,
  });
});

/**
 * Save WHOOP API credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(whoopCredentialsSchema, body);
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
      whoopClientIdEncrypted: encrypt(result.data.clientId),
      whoopClientSecretEncrypted: encrypt(result.data.clientSecret),
    },
  });

  return apiSuccess({ updated: true });
});

/**
 * Delete WHOOP credentials and the active connection.
 *
 * Audits the teardown and parks the integration ledger at `disconnected` for
 * parity with the Polar / Oura credential-DELETE so a sensitive op leaves a
 * uniform audit trail and the status snapshot does not linger at a stale state.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.credentials.delete" } });

  // A missing connection row (P2025) is a benign "already disconnected"
  // no-op; any other failure must propagate rather than be swallowed —
  // otherwise the encrypted OAuth tokens can be left orphaned while the user
  // is told the integration was disconnected.
  await prisma.whoopConnection
    .delete({ where: { userId: user.id } })
    .catch((err) => {
      if (!isP2025(err)) throw err;
    });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      whoopClientIdEncrypted: null,
      whoopClientSecretEncrypted: null,
    },
  });
  await auditLog("whoop.credentials.delete", { userId: user.id });
  await markDisconnected(user.id, "whoop");

  return apiSuccess({ deleted: true });
});
