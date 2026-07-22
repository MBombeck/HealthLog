import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteContext) => {
    const { user } = await requireAuth();
    const { id: medicationId, jobId } = await params;
    annotate({
      action: { name: "medication.intake.import.status" },
      meta: { job_id: jobId, medication_id: medicationId },
    });

    const row = await prisma.medicationIntakeImportJob.findFirst({
      where: { id: jobId, medicationId, userId: user.id },
    });
    if (!row) return apiError("Import job not found", 404);

    return apiSuccess({
      jobId: row.id,
      status: row.status,
      progress: row.progress,
      result: row.result,
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    });
  },
);
