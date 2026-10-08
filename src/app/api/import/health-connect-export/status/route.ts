/**
 * `GET /api/import/health-connect-export/status` — the caller's most recent
 * Health Connect import job (v1.42, #972), or `null` when there never was
 * one. The settings card polls it while a job runs and shows the last
 * outcome after a reload.
 *
 * The result is counts only (per type, per app); the import never stores a
 * value or a timestamp from the file on the job row.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { HEALTH_CONNECT_IMPORT_KIND } from "@/lib/jobs/health-connect-import-worker";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.health-connect.status" } });

  const row = await prisma.importJob.findFirst({
    where: { userId: user.id, kind: HEALTH_CONNECT_IMPORT_KIND },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      startedAt: true,
      completedAt: true,
      uploadBytes: true,
      progress: true,
      result: true,
      failureReason: true,
    },
  });

  return apiSuccess({
    job: row
      ? {
          jobId: row.id,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
          uploadBytes: row.uploadBytes,
          progress: (row.progress as Record<string, unknown>) ?? {},
          result: (row.result as Record<string, unknown> | null) ?? null,
          failureReason: row.failureReason,
        }
      : null,
  });
});
