/**
 * `POST /api/import/health-connect-remote/fetch` — read the folder now,
 * whatever its schedule. The source is marked due and one job goes to the
 * scheduled fetch's queue, so the download never runs in the request; the
 * card follows the outcome through `GET /api/import/health-connect-remote`
 * and the import through the Health Connect status route.
 */
import type { NextRequest } from "next/server";

import { apiHandler, HttpError, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { HEALTH_CONNECT_REMOTE_FETCH_QUEUE } from "@/lib/jobs/health-connect-remote-queue";
import { annotate } from "@/lib/logging/context";
import { markReconnected } from "@/lib/integrations/status";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.health-connect.remote.fetch" } });
  const rl = await checkRateLimit(
    `import:health-connect-remote-fetch:${user.id}`,
    6,
    60 * 60 * 1000,
  );
  if (!rl.allowed) return apiError("Too many fetches, try again later", 429);

  const source = await prisma.healthConnectRemoteSource.findUnique({
    where: { userId: user.id },
    select: { enabled: true },
  });
  if (!source) {
    return apiError("No folder is set up", 404, {
      errorCode: "import.health_connect.remote.not_configured",
    });
  }
  // Checked before anything is written: a refusal leaves a paused folder
  // paused.
  const boss = getGlobalBoss();
  if (!boss) throw new HttpError(503, "Background worker is not running");
  // Reading a paused folder now resumes it, on the source and on the shared
  // ledger alike, the way switching it back on does. Only the source used to
  // change, so the connection read "disconnected" while it fetched again.
  const { count } = await prisma.healthConnectRemoteSource.updateMany({
    where: { userId: user.id },
    data: { nextAttemptAt: new Date(), enabled: true },
  });
  if (count === 0) {
    return apiError("No folder is set up", 404, {
      errorCode: "import.health_connect.remote.not_configured",
    });
  }
  if (!source.enabled) {
    await markReconnected(user.id, "health-connect-remote");
  }
  await boss.send(HEALTH_CONNECT_REMOTE_FETCH_QUEUE, {});
  await auditLog("import.health-connect.remote.fetch", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });
  return apiSuccess({ queued: true }, 202);
});
