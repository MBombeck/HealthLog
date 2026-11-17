import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { loadOneConnectionHealth } from "@/lib/integrations/connection-health-load";
import { googleHealthBackfillEndedList } from "@/lib/google-health/backfill-progress";

/**
 * Get Google Health connection status for the current user (v1.26.0).
 *
 * `configured` checks the per-user BYO-key
 * credentials; the connection row reports last-sync + token expiry + backfill
 * progress. `tokenExpired` is reported straight off the row; the sync path
 * refreshes lazily via `getValidToken`. `needsReauth` surfaces the soft
 * disconnect (a refresh that failed with `invalid_grant` — the Testing-mode
 * 7-day refresh expiry) so the card can render a reconnect CTA.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "google_health.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      googleHealthClientIdEncrypted: true,
      googleHealthClientSecretEncrypted: true,
    },
  });

  const configured =
    !!dbUser?.googleHealthClientIdEncrypted &&
    !!dbUser?.googleHealthClientSecretEncrypted;

  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId: user.id },
    select: {
      googleUserId: true,
      lastSyncedAt: true,
      tokenExpiresAt: true,
      backfillCompletedAt: true,
      backfillProgress: true,
      needsReauth: true,
      createdAt: true,
      scope: true,
    },
  });

  if (!connection) {
    return apiSuccess({ connected: false, configured });
  }

  const tokenExpired = connection.tokenExpiresAt.getTime() <= Date.now();

  return apiSuccess({
    connected: true,
    configured,
    lastSyncedAt: connection.lastSyncedAt,
    connectedAt: connection.createdAt,
    tokenExpired,
    tokenExpiresAt: connection.tokenExpiresAt,
    backfillCompleted: !!connection.backfillCompletedAt,
    backfillEnded: googleHealthBackfillEndedList(connection.backfillProgress),
    needsReauth: connection.needsReauth,
    scope: connection.scope,
    // The one server-resolved state (ok / limited / degraded /
    // action_required) every client renders. The fields above stay for
    // clients that still read them; see `ConnectionHealth` in the API docs.
    health: await loadOneConnectionHealth(user.id, "google-health"),
  });
});
