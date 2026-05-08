/**
 * POST /api/admin/backup/test — admin-only smoke test for the off-host
 * backup target. Issues a 1-byte PUT + GET roundtrip and returns the
 * endpoint, bucket, region, and per-call latency. Credentials are NEVER
 * returned; only the endpoint host + bucket name are surfaced.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  runOffhostRoundtripTest,
  OffhostBackupNotConfiguredError,
} from "@/lib/jobs/offhost-backup";

export const POST = apiHandler(async (request: NextRequest) => {
  void request;
  await requireAdmin();
  try {
    const report = await runOffhostRoundtripTest();
    annotate({
      action: { name: "admin.backup.test" },
      meta: {
        ok: report.ok,
        put_latency_ms: report.putLatencyMs,
        get_latency_ms: report.getLatencyMs,
      },
    });
    return apiSuccess(report);
  } catch (err) {
    if (err instanceof OffhostBackupNotConfiguredError) {
      return apiError(err.message, 400);
    }
    throw err;
  }
});
