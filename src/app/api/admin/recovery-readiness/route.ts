/**
 * GET /api/admin/recovery-readiness
 *
 * Every backup signal with its verdict, its time and where to fix it: the
 * database dump, the weekly copy, the off-host copies, the last restore drill
 * (no time window: a failed drill stays failed until a later one passes), the
 * off-host setup, whether the bucket ever removes the database dumps, and the
 * recovery kit. The same judgement the hourly
 * evaluation pushes to the admins (`src/lib/recovery/readiness-model.ts`).
 * Cookie-only admin.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readRecoveryReadiness } from "@/lib/recovery/readiness";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.recoveryReadiness.status" } });
  const readiness = await readRecoveryReadiness();
  annotate({ meta: { recovery_readiness_state: readiness.state } });
  return apiSuccess(readiness);
});
