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
  storeStravaClientCredentials,
  clearStravaClientCredentials,
} from "@/lib/strava/credentials";
import { stravaCredentialsSchema } from "@/lib/validations/strava";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * v1.28.x — per-user Strava BYO-key credentials.
 *
 * Whether the user has their own Strava client id/secret stored. The
 * connect/callback/status routes resolve credentials DB-first then env, so an
 * unset pair simply falls back to the shared env app.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "strava.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      stravaClientIdEncrypted: true,
      stravaClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.stravaClientIdEncrypted &&
      !!dbUser?.stravaClientSecretEncrypted,
  });
});

/**
 * Save Strava OAuth client credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "strava.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(stravaCredentialsSchema, body);
  if (!result.success) {
    return apiValidationError(
      "Client ID and Client Secret are required",
      sanitiseZodIssues(result.error.issues),
      422,
    );
  }

  await storeStravaClientCredentials(
    user.id,
    result.data.clientId,
    result.data.clientSecret,
  );

  return apiSuccess({ updated: true });
});

/**
 * Delete Strava credentials and the active connection.
 *
 * Deleting the BYO credentials drops a live connection (a token minted against
 * the deleted app is now orphaned), so this mirrors `/api/strava/disconnect`:
 * audit the event and park the integration ledger at `disconnected` rather than
 * leaving it stale at its last state.
 *
 * Both are unconditional, matching the Polar twin. They used to run only when
 * an access token happened to be present, so tearing down a stored credential
 * pair that had never been connected left no audit row at all — and a
 * credential teardown is exactly the event an operator reads the trail for. The
 * ledger park is idempotent, so running it for an already-disconnected provider
 * costs one write and changes nothing.
 *
 * Note that this route still does NOT deauthorize at Strava; only
 * `POST /api/strava/disconnect` does. Removing the keys here therefore leaves
 * the app authorised on the user's Strava account.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "strava.credentials.delete" } });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      stravaAccessTokenEncrypted: null,
      stravaRefreshTokenEncrypted: null,
      stravaAthleteId: null,
    },
  });
  await clearStravaClientCredentials(user.id);

  await auditLog("strava.credentials.delete", { userId: user.id });
  await markDisconnected(user.id, "strava");

  return apiSuccess({ deleted: true });
});
