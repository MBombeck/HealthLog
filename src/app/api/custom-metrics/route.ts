import { NextRequest } from "next/server";

import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserCorrelationPatterns } from "@/lib/cache/invalidate";
import {
  CUSTOM_METRIC_LATEST_INCLUDE,
  serialiseCustomMetricWithLatest,
} from "@/lib/custom-metrics/custom-metric-store";
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import { createCustomMetricSchema } from "@/lib/validations/custom-metrics";

/**
 * v1.25.5 — user-defined custom-metric catalog (`/api/custom-metrics`).
 *
 * A SEPARATE generic store from the closed `MeasurementType` system: not synced,
 * not in FHIR, not in AI insights — log + chart only. GET lists the caller's
 * metrics with their latest logged value; POST defines a new one. `userId` is
 * always narrowed from the session — never a body field — and the write `data`
 * object is built field-by-field (no mass assignment). The `@@unique([userId,
 * name])` index means there is never a second definition of the same name.
 */

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "measurements");

  const rows = await prisma.customMetric.findMany({
    where: { userId: user.id, deletedAt: null },
    orderBy: { name: "asc" },
    include: CUSTOM_METRIC_LATEST_INCLUDE,
  });

  annotate({
    action: { name: "custom-metric.metric.list" },
    meta: { total: rows.length },
  });

  return apiSuccess({
    customMetrics: rows.map((row) =>
      serialiseCustomMetricWithLatest({
        ...row,
        latest: row.entries[0] ?? null,
        entryCount: row._count.entries,
      }),
    ),
  });
});

export const POST = apiHandler(
  withIdempotency<[NextRequest]>(postCustomMetric),
);

async function postCustomMetric(request: NextRequest) {
  const { user } = await requireAuth();

  const parsed = await parseJsonBody(request, createCustomMetricSchema, {
    maxBytes: 16 * 1024,
    action: "custom-metric.metric.create.validation-failed",
    countIssues: true,
    onInvalid: (error) => {
      const auditIssues = sanitiseZodIssues(error.issues, {
        stripValuesFromMessage: true,
      });
      auditLog("custom-metric.metric.create.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues },
      }).catch(() => {
        /* swallow — the 422 response is the contract */
      });
    },
  });
  if (!parsed.ok) return parsed.error;

  const {
    name,
    unit,
    targetLow,
    targetHigh,
    decimals,
    description,
    correlationEnabled,
  } = parsed.data;

  // The `@@unique([userId, name])` index is the structural backstop and spans
  // soft-deleted rows too. Resolve the name up front: a LIVE collision is a
  // clean 409; a row that was previously soft-deleted under this name is
  // REVIVED (un-deleted + redefined) rather than blocked by the index, so the
  // user can re-create a metric they once removed.
  const existing = await prisma.customMetric.findFirst({
    where: { userId: user.id, name },
    select: { id: true, deletedAt: true },
  });
  if (existing && existing.deletedAt === null) {
    return apiError("A custom metric with this name already exists", 409);
  }

  // Field-by-field assignment — never spread `parsed.data`.
  const created = existing
    ? await prisma.customMetric.update({
        where: { id: existing.id },
        data: {
          unit,
          targetLow: targetLow ?? null,
          targetHigh: targetHigh ?? null,
          decimals: decimals ?? null,
          description: description ?? null,
          correlationEnabled,
          deletedAt: null,
        },
      })
    : await prisma.customMetric.create({
        data: {
          userId: user.id,
          name,
          unit,
          targetLow: targetLow ?? null,
          targetHigh: targetHigh ?? null,
          decimals: decimals ?? null,
          description: description ?? null,
          correlationEnabled,
        },
      });

  await auditLog("customMetric.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { customMetricId: created.id },
  });

  annotate({
    action: { name: "custom-metric.metric.create" },
    meta: { customMetricId: created.id, revived: existing !== null },
  });
  invalidateUserCorrelationPatterns(user.id);

  // A freshly created metric has no values; a revived one may retain entries
  // logged before it was soft-deleted, so resolve the latest + count for it.
  let latest: { value: number; unit: string; measuredAt: Date } | null = null;
  let entryCount = 0;
  if (existing) {
    const [latestEntry, count] = await Promise.all([
      prisma.customMetricEntry.findFirst({
        where: { userId: user.id, customMetricId: created.id, deletedAt: null },
        orderBy: { measuredAt: "desc" },
        select: { value: true, unit: true, measuredAt: true },
      }),
      prisma.customMetricEntry.count({
        where: { userId: user.id, customMetricId: created.id, deletedAt: null },
      }),
    ]);
    latest = latestEntry ?? null;
    entryCount = count;
  }

  return apiSuccess(
    serialiseCustomMetricWithLatest({ ...created, latest, entryCount }),
    201,
  );
}
