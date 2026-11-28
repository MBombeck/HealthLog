/**
 * `GET /api/import/fit/status` — the caller's most recent activity file
 * import, or `null` when there never was one, and whether an import of any
 * kind holds the account now (`importRunning`). The import card polls it
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
import { activeImportWhere } from "@/lib/import/apple-health-staging";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.fit.status" } });

  const [row, running] = await Promise.all([
    prisma.importJob.findFirst({
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
    }),
    // Any kind, by the rule the upload is refused on: the card waits on
    // this read while another import holds the account.
    prisma.importJob.findFirst({
      where: activeImportWhere(user.id, new Date()),
      select: { id: true },
    }),
  ]);

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
    importRunning: running !== null,
  });
});
