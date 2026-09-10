import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { markDisconnected } from "@/lib/integrations/status";
import {
  storePolarClientCredentials,
  clearPolarClientCredentials,
} from "@/lib/polar/credentials";
import { polarCredentialsSchema } from "@/lib/validations/polar";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * v1.17.1 — per-user Polar BYO-key credentials.
 *
 * Whether the user has their own Polar AccessLink client id/secret stored. The
 * connect/callback/status routes resolve credentials DB-first then env, so an
 * unset pair simply falls back to the shared env app.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      polarClientIdEncrypted: true,
      polarClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.polarClientIdEncrypted && !!dbUser?.polarClientSecretEncrypted,
  });
});

/**
 * Save Polar OAuth client credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(polarCredentialsSchema, body);
  if (!result.success) {
    return apiValidationError(
      "Client ID and Client Secret are required",
      sanitiseZodIssues(result.error.issues),
      422,
    );
  }

  await storePolarClientCredentials(
    user.id,
    result.data.clientId,
    result.data.clientSecret,
  );
  await auditLog("polar.credentials.update", { userId: user.id });

  return apiSuccess({ updated: true });
});

/**
 * Delete Polar credentials and the active connection.
 *
 * Removing the BYO client id/secret also drops the live grant: a token minted
 * under the user's own AccessLink app would be orphaned once the keys are gone.
 * Parks the integration ledger at `disconnected` for parity with the dedicated
 * disconnect route so the status snapshot does not linger at a stale state.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.credentials.delete" } });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      polarAccessTokenEncrypted: null,
      polarUserIdEncrypted: null,
    },
  });
  await clearPolarClientCredentials(user.id);
  await auditLog("polar.credentials.delete", { userId: user.id });
  await markDisconnected(user.id, "polar");

  return apiSuccess({ deleted: true });
});
