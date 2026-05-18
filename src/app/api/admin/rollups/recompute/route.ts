/**
 * `POST /api/admin/rollups/recompute` — operator-triggered ad-hoc
 * rollup recompute.
 *
 * Surface added in v1.4.38.7 after the boot-time backfill could not
 * be re-triggered without a deploy. A power-user account whose
 * `isFullyCovered(coverage)` probe returned `false` (typically
 * because a brand-new measurement type landed between the last fold
 * and the next analytics read) gets stranded on the live SQL
 * aggregator until the next worker boot. This endpoint lets the
 * operator force a fold for one user or kick the boot-discovery loop
 * across every user without bouncing the worker container.
 *
 * Body:
 *   { userId?: string }
 *
 *   - `userId` — single user mode. Synchronously calls
 *     `recomputeUserRollups(userId)` and returns the row count when
 *     the fold completes. The call is awaited inside the request, so
 *     the operator sees the duration in the response.
 *   - `userId` omitted — calls `enqueueBootTimeRollupBackfill()` to
 *     re-run the worker-boot discovery (`{ enqueued, skipped }` shape).
 *
 * Admin gate via `requireAdmin()` (cookie-only — Bearer never elevates
 * to admin per the v1.4.25 security boundary).
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  enqueueBootTimeRollupBackfill,
  recomputeUserRollups,
} from "@/lib/measurements/rollups";

interface RecomputeBody {
  userId?: string;
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.rollups.recompute" } });

  const { data: rawBody, error: jsonError } =
    await safeJson<RecomputeBody>(request);
  if (jsonError) return jsonError;

  const body: RecomputeBody =
    rawBody && typeof rawBody === "object" ? rawBody : {};
  const userId =
    typeof body.userId === "string" && body.userId.length > 0
      ? body.userId
      : undefined;

  if (userId) {
    await auditLog("admin.rollups.recompute.start", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { targetUserId: userId, mode: "single" },
    });

    let result: Awaited<ReturnType<typeof recomputeUserRollups>>;
    try {
      result = await recomputeUserRollups(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return apiError(message, 500);
    }

    await auditLog("admin.rollups.recompute.complete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { targetUserId: userId, ...result },
    });

    return apiSuccess({
      mode: "single",
      targetUserId: userId,
      rowsUpserted: result.rowsUpserted,
      durationMs: result.durationMs,
    });
  }

  await auditLog("admin.rollups.recompute.start", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { mode: "boot-discovery" },
  });

  const discovery = await enqueueBootTimeRollupBackfill();

  await auditLog("admin.rollups.recompute.complete", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { mode: "boot-discovery", ...discovery },
  });

  return apiSuccess({
    mode: "boot-discovery",
    enqueued: discovery.enqueued,
    skipped: discovery.skipped,
    error: discovery.error,
  });
});
