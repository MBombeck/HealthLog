/**
 * `GET /api/import/apple-health-export/[jobId]/status` — polling
 * endpoint for an in-flight Apple Health import.
 *
 * Returns the canonical `ImportJobStatusResponse` envelope. The polling cadence
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
import { FHIR_LAB_IMPORT_REASONS } from "@/lib/labs/fhir-import/types";
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

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function privacySafeResult(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) return null;
  const block = (key: "ecg" | "labs"): Record<string, unknown> =>
    typeof value[key] === "object" && value[key] !== null
      ? (value[key] as Record<string, unknown>)
      : {};
  const ecg = block("ecg");
  const labs = block("labs");
  return {
    ...value,
    ecg: {
      discovered: boundedCount(ecg.discovered),
      imported: boundedCount(ecg.imported),
      updated: boundedCount(ecg.updated),
      skipped: boundedCount(ecg.skipped),
      failed: boundedCount(ecg.failed),
    },
    labs: {
      discovered: boundedCount(labs.discovered),
      imported: boundedCount(labs.imported),
      duplicate: boundedCount(labs.duplicate),
      skipped: boundedCount(labs.skipped),
      failed: boundedCount(labs.failed),
      markersCreated: boundedCount(labs.markersCreated),
      reasons: labReasons(labs.reasons),
    },
  };
}

/**
 * The skipped and failed lab results by reason: only the closed reasons, each
 * a bounded positive count, so nothing else a stored result might hold is
 * served.
 */
function labReasons(value: unknown): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const reason of FHIR_LAB_IMPORT_REASONS) {
    const count = boundedCount((value as Record<string, unknown>)[reason]);
    if (count > 0) out[reason] = count;
  }
  return out;
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
      result: privacySafeResult(
        (row.result as Record<string, unknown> | null) ?? null,
      ),
      failureReason: row.failureReason,
    };

    return apiSuccess(body, 200);
  },
);
