import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { isP2025 } from "@/lib/prisma-errors";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { markDisconnected } from "@/lib/integrations/status";
import { encrypt } from "@/lib/crypto";
import { withingsCredentialsSchema } from "@/lib/validations/withings";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * Check if user has Withings credentials stored.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      withingsClientIdEncrypted: true,
      withingsClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.withingsClientIdEncrypted &&
      !!dbUser?.withingsClientSecretEncrypted,
  });
});

/**
 * Save Withings API credentials (encrypted).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const result = z.safeParse(withingsCredentialsSchema, body);
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
      withingsClientIdEncrypted: encrypt(result.data.clientId),
      withingsClientSecretEncrypted: encrypt(result.data.clientSecret),
    },
  });

  return apiSuccess({ updated: true });
});

/**
 * Delete Withings credentials and disconnect.
 *
 * Audits the teardown and parks the integration ledger at `disconnected`, for
 * parity with the Fitbit / Google Health / WHOOP credential-DELETE. Withings
 * was the one provider that did neither: the connection row went, the
 * credential columns went, and the ledger kept whatever state it last held —
 * so a client reading `state` afterwards was told `connected` about a
 * connection that no longer existed, and a sensitive teardown left no trail.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.credentials.delete" } });

  // Remove connection first. A missing connection row (P2025) is a benign
  // "already disconnected" no-op; any other failure must propagate rather
  // than be swallowed — otherwise the encrypted OAuth tokens can be left
  // orphaned while the user is told the integration was disconnected.
  await prisma.withingsConnection
    .delete({ where: { userId: user.id } })
    .catch((err) => {
      if (!isP2025(err)) throw err;
    });

  // Remove credentials
  await prisma.user.update({
    where: { id: user.id },
    data: {
      withingsClientIdEncrypted: null,
      withingsClientSecretEncrypted: null,
    },
  });

  await auditLog("withings.credentials.delete", { userId: user.id });
  await markDisconnected(user.id, "withings");

  return apiSuccess({ deleted: true });
});
