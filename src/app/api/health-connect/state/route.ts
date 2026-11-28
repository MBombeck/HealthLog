/**
 * `GET /api/health-connect/state` — what a paired Android device reads
 * before a sync: the types the server takes, the apps to leave out, where
 * heart rate turns hourly, the newest reading held per type, and the limits
 * a batch is held to. Bearer with `health-connect:write`, the paired
 * device's own token only (`requirePairedDevice`).
 */
import { apiHandler } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { requirePairedDevice } from "@/lib/health-connect/device-auth";
import { buildHealthConnectState } from "@/lib/health-connect/state";

export const GET = apiHandler(async () => {
  const auth = await requirePairedDevice();
  if (!auth.ok) return auth.response;
  annotate({ action: { name: "health_connect.state" } });
  const state = await buildHealthConnectState(prisma, {
    userId: auth.user.id,
    tokenExpiresAt: auth.tokenExpiresAt,
  });
  return apiSuccess(state);
});
