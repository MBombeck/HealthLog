/**
 * `POST /api/admin/maintenance/measurements` — queue the operator-triggered
 * `VACUUM (ANALYZE)` / `REINDEX INDEX CONCURRENTLY` pass over `measurements`
 * (v1.42). Cookie-only admin: `requireAdmin()` refuses every Bearer.
 *
 * Nothing runs in the request: the pass runs in the background worker
 * (`measurement-maintenance.ts`), one statement at a time, and refuses to
 * start while the compaction-tombstone purge is still working. At most one
 * run is queued or running; a second press answers `enqueued: false`.
 * Runbook: `docs/ops/measurement-maintenance.md`.
 *
 * `GET` reads where the newest run stands, for the admin card that starts it
 * and follows it.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  MEASUREMENT_MAINTENANCE_QUEUE,
  MEASUREMENT_MAINTENANCE_SEND_OPTIONS,
  type MeasurementMaintenancePayload,
} from "@/lib/jobs/measurement-maintenance";
import { readMeasurementMaintenanceStatus } from "@/lib/jobs/measurement-maintenance-status";
import { annotate } from "@/lib/logging/context";

/** Two booleans; anything longer is not a request for this route. */
const MAX_BODY_BYTES = 1024;

const maintenanceRequestSchema = z
  .object({
    vacuum: z.boolean().default(true),
    reindex: z.boolean().default(true),
  })
  .strict();

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  // The body is optional: an empty one runs both steps.
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return apiError("Request body too large", 413);
  }
  let body: unknown = {};
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return apiError("Invalid JSON", 400);
    }
  }
  const parsed = maintenanceRequestSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error);
  const payload: MeasurementMaintenancePayload = {
    vacuum: parsed.data.vacuum,
    reindex: parsed.data.reindex,
  };
  if (!payload.vacuum && !payload.reindex) {
    return apiError("Choose at least one step", 422);
  }

  annotate({
    action: { name: "admin.maintenance.measurements.requested" },
    meta: { vacuum: payload.vacuum, reindex: payload.reindex },
  });

  const boss = getGlobalBoss();
  if (!boss) {
    return apiError("Background worker is not available", 503);
  }

  const jobId = await boss.send(
    MEASUREMENT_MAINTENANCE_QUEUE,
    payload,
    MEASUREMENT_MAINTENANCE_SEND_OPTIONS,
  );
  const enqueued = jobId !== null;

  await auditLog("admin.maintenance.measurements.requested", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { ...payload, enqueued },
  });
  annotate({ meta: { maintenance_enqueued: enqueued } });

  return apiSuccess({ enqueued }, 202);
});

export const GET = apiHandler(async () => {
  await requireAdmin();
  const status = await readMeasurementMaintenanceStatus();
  annotate({
    action: { name: "admin.maintenance.measurements.status" },
    meta: {
      available: status.available,
      run_state: status.run?.state ?? null,
      purge_pending: status.purgePending,
    },
  });
  return apiSuccess(status);
});
