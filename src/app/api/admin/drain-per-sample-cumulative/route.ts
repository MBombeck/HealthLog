/**
 * `POST /api/admin/drain-per-sample-cumulative` — operator-triggered
 * variant of `scripts/drain-per-sample-cumulative.ts`. Collapses
 * pre-Option-A per-sample APPLE_HEALTH cumulative rows into one row
 * per day per cumulative type. See `06-ios-responsibilities.md`
 * §"Cumulative metrics: daily aggregation on iOS".
 *
 * Body:
 *   { userId?: string, dryRun?: boolean }
 *
 *   - `userId` — single user mode. Omit to drain every user.
 *   - `dryRun` — preview-only; no DB writes. Default: `true`. Set to
 *     `false` to commit.
 *
 * Response shape (always 200 on success):
 *   { processed, inserted (always 0), totals: { ... }, buckets: [...] }
 *
 * Admin gate via `requireAdmin()` (cookie-only — Bearer never elevates
 * to admin per the v1.4.25 security boundary).
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
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
  drainPerSampleCumulative,
  DRAIN_CUMULATIVE_CUTOFF_HOURS,
} from "@/lib/measurements/drain-per-sample-cumulative";

interface DrainBody {
  userId?: string;
  dryRun?: boolean;
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.drain.cumulative" } });

  const { data: rawBody, error: jsonError } = await safeJson<DrainBody>(request);
  if (jsonError) return jsonError;

  const body: DrainBody = (rawBody && typeof rawBody === "object") ? rawBody : {};
  const userId =
    typeof body.userId === "string" && body.userId.length > 0
      ? body.userId
      : undefined;
  // Default to dryRun = true so a malformed body never silently writes.
  // Operator must explicitly send `dryRun: false` to commit.
  const dryRun = body.dryRun === false ? false : true;

  await auditLog("admin.drain.cumulative.start", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { targetUserId: userId ?? "ALL", dryRun },
  });

  const lines: string[] = [];
  // v1.4.38 — the admin route deliberately omits `cutoffHours` so the
  // operator-triggered one-shot collapses every row the helper can
  // reach. `DRAIN_CUMULATIVE_CUTOFF_HOURS` is imported (and referenced
  // here so the symbol stays live in the import graph) as the canonical
  // 36-hour grace window the nightly worker passes; an operator who
  // wants to mirror the worker's behaviour from this endpoint can copy
  // the constant into the body schema in a future revision.
  void DRAIN_CUMULATIVE_CUTOFF_HOURS;
  const summary = await drainPerSampleCumulative(prisma, {
    userId,
    dryRun,
    log: (line) => lines.push(line),
  });

  if (!dryRun) {
    await auditLog("admin.drain.cumulative.commit", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        targetUserId: userId ?? "ALL",
        ...summary.totals,
      },
    });
  }

  if (summary.totals.bucketsCollapsed === 0 && summary.totals.usersScanned === 0 && userId) {
    return apiError("User not found", 404);
  }

  return apiSuccess({
    dryRun,
    totals: summary.totals,
    bucketCount: summary.buckets.length,
    // Truncate to the first 50 buckets so the response stays
    // bounded — operators inspect the CLI for the full output.
    bucketsPreview: summary.buckets.slice(0, 50),
    logTail: lines.slice(-20),
  });
});
