/**
 * `GET /api/sync/state` — iOS SyncMode handshake.
 *
 * The iOS SyncMode store reads this endpoint on pair / unpair, on
 * background-to-foreground, and before opening a fresh anchored
 * HealthKit query window. The response is a compact JSON shape iOS
 * compares against its local SwiftData state to decide whether to
 * (a) drain a pending outbox, (b) request a full refresh, or (c) sit
 * quiet.
 *
 * Response shape:
 *   {
 *     userId,
 *     timezone,
 *     lastSyncedAt,             — User.lastSyncedAt (ISO string or null)
 *     serverNow,                — `new Date().toISOString()` for clock skew
 *     measurements: {
 *       lastUpdatedAt,          — MAX(updated_at) for live rows
 *       liveCount,              — COUNT(*) WHERE deleted_at IS NULL
 *       tombstonedCount,        — COUNT(*) WHERE deleted_at IS NOT NULL
 *     }
 *   }
 *
 * No body. requireAuth() — cookie + Bearer both accepted (iOS uses
 * Bearer per `05-auth-flows.md`).
 *
 * Locked contract: see `.planning/v15-ios-handoff/08-locked-contracts.md`
 * §13 cross-reference. The shape is additive going forward.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();

  // Two aggregate reads + one user-side bump. The aggregate reads run
  // against indexed columns (userId, deleted_at) so they stay
  // O(rows-for-user) and not O(rows-across-tenants).
  const [latest, liveCount, tombstonedCount, currentUser] = await Promise.all([
    prisma.measurement.findFirst({
      where: { userId: user.id, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    prisma.measurement.count({
      where: { userId: user.id, deletedAt: null },
    }),
    prisma.measurement.count({
      where: { userId: user.id, deletedAt: { not: null } },
    }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { lastSyncedAt: true, timezone: true },
    }),
  ]);

  // The handshake also bumps the user's lastSyncedAt — the call IS
  // the handshake. iOS reads the OLD lastSyncedAt from the response
  // and then trusts that subsequent server writes after the new
  // checkpoint will round-trip via the standard read paths.
  const previous = currentUser?.lastSyncedAt ?? null;
  const nextCheckpoint = new Date();
  await prisma.user.update({
    where: { id: user.id },
    data: { lastSyncedAt: nextCheckpoint },
  });

  annotate({
    action: { name: "sync.state" },
    meta: {
      liveCount,
      tombstonedCount,
      lastSyncedAtBefore: previous?.toISOString() ?? null,
    },
  });

  return apiSuccess({
    userId: user.id,
    timezone: currentUser?.timezone ?? "Europe/Berlin",
    lastSyncedAt: previous?.toISOString() ?? null,
    serverNow: nextCheckpoint.toISOString(),
    measurements: {
      lastUpdatedAt: latest?.updatedAt?.toISOString() ?? null,
      liveCount,
      tombstonedCount,
    },
  });
});
