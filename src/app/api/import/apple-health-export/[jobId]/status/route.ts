/**
 * `GET /api/import/apple-health-export/[jobId]/status` — polling
 * endpoint for an in-flight Apple Health import.
 *
 * Returns the canonical `ImportJobStatusResponse` envelope (§8 of
 * `.planning/research/v1434-r-1-xml-import.md`). The polling cadence
 * the iOS client uses:
 *   - every 2 s while `queued | unpacking | parsing | upserting`
 *   - every 30 s once `done | failed` (last-known state is fine)
 *
 * Authorisation: the row's `userId` must match the requester or the
 * requester is the admin who kicked it off via the admin variant.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

interface ImportJobStatusResponse {
  jobId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  uploadBytes: number;
  exportedAt: string | null;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  failureReason: string | null;
}

export const GET = apiHandler(
  async (_request: NextRequest, ctx: RouteContext) => {
    const { user } = await requireAuth();
    const { jobId } = await ctx.params;
    annotate({
      action: { name: "import.apple-health.status" },
      meta: { job_id: jobId },
    });

    const row = await prisma.importJob.findUnique({ where: { id: jobId } });
    if (!row) {
      return apiError("Import job not found", 404);
    }

    // Authorisation: the owner can see their own job; the admin who
    // triggered it can see it from the admin route. Any other caller
    // gets a 404 (not 403 — we don't leak existence to outsiders).
    const isOwner = row.userId === user.id;
    const isTriggeringAdmin =
      row.triggeredByAdminId !== null && row.triggeredByAdminId === user.id;
    if (!isOwner && !isTriggeringAdmin) {
      return apiError("Import job not found", 404);
    }

    const body: ImportJobStatusResponse = {
      jobId: row.id,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      uploadBytes: row.uploadBytes,
      exportedAt: row.exportedAt?.toISOString() ?? null,
      progress: (row.progress as Record<string, unknown>) ?? {},
      result: (row.result as Record<string, unknown> | null) ?? null,
      failureReason: row.failureReason,
    };

    return apiSuccess(body, 200);
  },
);
