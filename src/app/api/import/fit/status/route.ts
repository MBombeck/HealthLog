/**
 * `GET /api/import/fit/status` — the caller's most recent activity file
 * import, or `null` when there never was one. The import card polls it
 * while a job runs and shows the last outcome after a reload.
 *
 * The result is counts only; nothing from inside the file is stored on the
 * job row.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { FIT_IMPORT_KIND } from "@/lib/jobs/fit-import-queue";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.fit.status" } });

  const row = await prisma.importJob.findFirst({
    where: { userId: user.id, kind: FIT_IMPORT_KIND },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      startedAt: true,
      completedAt: true,
      uploadBytes: true,
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
          result: (row.result as Record<string, unknown> | null) ?? null,
          failureReason: row.failureReason,
        }
      : null,
  });
});
