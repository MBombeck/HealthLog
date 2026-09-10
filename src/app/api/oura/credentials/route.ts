import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { markDisconnected } from "@/lib/integrations/status";
import {
  storeOuraClientCredentials,
  clearOuraClientCredentials,
} from "@/lib/oura/credentials";
import { ouraCredentialsSchema } from "@/lib/validations/oura";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * v1.17.1 — per-user Oura BYO-key credentials.
 *
 * Whether the user has their own Oura client id/secret stored. The
 * connect/callback/status routes resolve credentials DB-first then env, so an
 * unset pair simply falls back to the shared env app.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      ouraClientIdEncrypted: true,
      ouraClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.ouraClientIdEncrypted && !!dbUser?.ouraClientSecretEncrypted,
  });
});

/**
 * Save Oura OAuth client credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(ouraCredentialsSchema, body);
  if (!result.success) {
    return apiValidationError(
      "Client ID and Client Secret are required",
      sanitiseZodIssues(result.error.issues),
      422,
    );
  }

  await storeOuraClientCredentials(
    user.id,
    result.data.clientId,
    result.data.clientSecret,
  );

  return apiSuccess({ updated: true });
});

/**
 * Delete Oura credentials and the active connection.
 *
 * Deleting the BYO credentials drops a live connection (a token minted against
 * the deleted app is now orphaned), so this mirrors `/api/oura/disconnect`:
 * audit the event and park the integration ledger at `disconnected` rather than
 * leaving it stale at its last state.
 *
 * Both are unconditional, matching the Polar twin. They used to run only when
 * an access token happened to be present, so tearing down a stored credential
 * pair that had never been connected left no audit row at all — and a
 * credential teardown is exactly the event an operator reads the trail for. The
 * ledger park is idempotent, so running it for an already-disconnected provider
 * costs one write and changes nothing.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.credentials.delete" } });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      ouraAccessTokenEncrypted: null,
      ouraRefreshTokenEncrypted: null,
    },
  });
  await clearOuraClientCredentials(user.id);

  await auditLog("oura.credentials.delete", { userId: user.id });
  await markDisconnected(user.id, "oura");

  return apiSuccess({ deleted: true });
});
